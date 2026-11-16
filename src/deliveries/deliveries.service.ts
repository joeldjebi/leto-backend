import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { SavedAddress } from '../addresses/saved-address.entity';
import { AuthUser } from '../common/decorators';
import { haversineKm, nearestCommune } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Offer, OfferStatus } from '../offers/offer.entity';
import { computePrice, DeliverySpeed, VehicleType } from '../pricing/pricing';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { SettingsService } from '../settings/settings.service';
import { FAIL_RADIUS_M, LOCATION_MAX_AGE_MS } from './absence';
import { CreateDeliveryDto, FailStopDto } from './deliveries.dto';
import { DeliveryStop, DisputeDecision, FailureReason, StopStatus } from './delivery-stop.entity';
import { Delivery, DeliveryStatus } from './delivery.entity';

@Injectable()
export class DeliveriesService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Delivery) private repo: Repository<Delivery>,
    @InjectRepository(DeliveryStop) private stops: Repository<DeliveryStop>,
    @InjectRepository(Offer) private offers: Repository<Offer>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(SavedAddress) private addresses: Repository<SavedAddress>,
    private tracking: TrackingGateway,
    private geo: GeoService,
    private settings: SettingsService,
  ) {}

  /** Notifie en temps réel puis renvoie la course */
  private notify<T extends Delivery>(d: T): T {
    this.tracking.deliveryChanged(d);
    return d;
  }

  /** Requête de base : client, livreur, entreprise et arrêts (dans l'ordre) */
  private query(withCodes = false) {
    const qb = this.repo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.client', 'client')
      .leftJoinAndSelect('d.driver', 'driver')
      .leftJoinAndSelect('d.company', 'company')
      .leftJoinAndSelect('d.stops', 'stop')
      .orderBy('d.createdAt', 'DESC')
      .addOrderBy('stop.position', 'ASC');
    return withCodes ? qb.addSelect('stop.confirmationCode') : qb;
  }

  // ---------- Client ----------

  async create(clientId: string, dto: CreateDeliveryDto) {
    const grid = this.settings.pricing;
    const vehicleType = dto.vehicleType ?? VehicleType.MOTO;
    const speed = dto.speed ?? DeliverySpeed.STANDARD;
    if (!grid.vehicles[vehicleType].enabled) throw new BadRequestException('Cette offre n’est pas disponible');
    if (dto.stops.length > grid.maxStops) throw new BadRequestException(`${grid.maxStops} adresses maximum par tournée`);
    const pickup = { lat: dto.pickupLat, lng: dto.pickupLng };

    // Ordre de passage optimisé, puis itinéraire complet (le prix est toujours calculé ici)
    const order = await this.geo.optimizeOrder(pickup, dto.stops);
    const ordered = order.map((i) => dto.stops[i]);
    const route = await this.geo.routeVia([pickup, ...ordered]);
    const codStops = ordered.filter((s) => (s.codAmount ?? 0) > 0).length;

    const delivery = await this.repo.save(
      this.repo.create({
        ...dto,
        clientId,
        vehicleType,
        speed,
        pickupCommune: nearestCommune(dto.pickupLat, dto.pickupLng),
        distanceKm: Math.round(route.distanceKm * 10) / 10,
        durationMin: route.durationMin,
        price: computePrice(grid, route.distanceKm, vehicleType, speed, ordered.length, codStops),
        stops: ordered.map((s, position) =>
          this.stops.create({
            ...s,
            position,
            codAmount: s.codAmount ?? 0,
            commune: nearestCommune(s.lat, s.lng),
            confirmationCode: randomInt(0, 10000).toString().padStart(4, '0'),
          }),
        ),
      }),
    );
    await this.saveToAddressBook(clientId, ordered);
    return this.notify(await this.findOne(delivery.id, true));
  }

  /** Carnet d'adresses : chaque destinataire est mémorisé (mis à jour par numéro de téléphone) */
  private async saveToAddressBook(clientId: string, stops: CreateDeliveryDto['stops']) {
    for (const s of stops) {
      const existing = await this.addresses.findOneBy({ clientId, recipientPhone: s.recipientPhone });
      await this.addresses.save({
        ...(existing ?? {}),
        clientId,
        recipientName: s.recipientName,
        recipientPhone: s.recipientPhone,
        address: s.address,
        details: s.details ?? existing?.details ?? null,
        lat: s.lat,
        lng: s.lng,
        usedCount: (existing?.usedCount ?? 0) + 1,
        lastUsedAt: new Date(),
      });
    }
  }

  /** Le client voit ses courses AVEC les codes (à partager à ses destinataires) */
  forClient(clientId: string) {
    return this.query(true).where('d.clientId = :clientId', { clientId }).getMany();
  }

  async oneForClient(clientId: string, id: string) {
    const d = await this.findOne(id, true);
    if (d.clientId !== clientId) throw new NotFoundException('Course introuvable');
    return d;
  }

  async cancel(clientId: string, id: string) {
    const res = await this.repo.update(
      { id, clientId, status: DeliveryStatus.PENDING },
      { status: DeliveryStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: 'Client' },
    );
    if (!res.affected) throw new BadRequestException('Seule une course en attente peut être annulée');
    await this.closeOffers(id);
    return this.notify(await this.findOne(id, true));
  }

  /** L'expéditeur conteste un échec de livraison (litige) */
  async disputeStop(clientId: string, id: string, stopId: string, note?: string) {
    const d = await this.oneForClient(clientId, id);
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop || stop.status !== StopStatus.FAILED) throw new BadRequestException('Seul un échec peut être contesté');
    if (stop.disputedAt) throw new BadRequestException('Déjà contesté');
    await this.stops.update(stopId, { disputedAt: new Date(), disputeNote: note ?? null });
    if (d.companyId) this.tracking.emitToCompany(d.companyId, 'dispute:new', { deliveryId: id, stopId });
    return this.notify(await this.findOne(id, true));
  }

  // ---------- Livreur ----------

  /** Courses en attente (sans les numéros des destinataires tant que la course n'est pas acceptée) */
  async available() {
    const list = await this.query()
      .where('d.status = :s', { s: DeliveryStatus.PENDING })
      .orderBy('d.createdAt', 'ASC')
      .addOrderBy('stop.position', 'ASC')
      .getMany();
    for (const d of list) {
      if (d.client) d.client.phone = undefined;
      for (const s of d.stops) s.recipientPhone = undefined;
    }
    return list;
  }

  forDriver(driverId: string) {
    return this.query().where('d.driverId = :driverId', { driverId }).getMany();
  }

  /** Acceptation atomique : si deux livreurs acceptent en même temps, un seul gagne */
  async accept(user: AuthUser, id: string) {
    const res = await this.repo
      .createQueryBuilder()
      .update(Delivery)
      .set({ status: DeliveryStatus.ACCEPTED, driverId: user.sub, companyId: user.companyId, acceptedAt: () => 'NOW()' })
      .where('id = :id AND status = :s', { id, s: DeliveryStatus.PENDING })
      .execute();
    if (!res.affected) throw new ConflictException('Course déjà prise ou indisponible');
    await this.closeOffers(id);
    return this.notify(await this.findOne(id));
  }

  async pickup(driverId: string, id: string) {
    const res = await this.repo.update(
      { id, driverId, status: DeliveryStatus.ACCEPTED },
      { status: DeliveryStatus.PICKED_UP, pickedUpAt: new Date() },
    );
    if (!res.affected) throw new BadRequestException('Action impossible pour cette course');
    return this.notify(await this.findOne(id));
  }

  /** Livraison d'un arrêt : le destinataire donne son code au livreur */
  async deliverStop(driverId: string, id: string, stopId: string, code: string) {
    const d = await this.findOne(id, true);
    const stop = this.driverStop(d, driverId, stopId);
    if (stop.confirmationCode !== code) throw new BadRequestException('Code incorrect');
    await this.stops.update(stopId, { status: StopStatus.DELIVERED, deliveredAt: new Date() });
    return this.afterStop(id);
  }

  /**
   * Échec d'un arrêt, avec preuves : le livreur doit être sur place (GPS récent < 250 m),
   * avoir attendu (absence) et joindre une photo. L'expéditeur est prévenu et peut contester.
   */
  async failStop(driverId: string, id: string, stopId: string, dto: FailStopDto) {
    const d = await this.findOne(id, true);
    const stop = this.driverStop(d, driverId, stopId);
    const driver = await this.users.findOneBy({ id: driverId });

    const fresh = driver.lastLocationAt && Date.now() - driver.lastLocationAt.getTime() < LOCATION_MAX_AGE_MS;
    if (!fresh || driver.lastLat == null) throw new BadRequestException('Position GPS indisponible : activez la localisation');
    const distM = haversineKm(driver.lastLat, driver.lastLng, stop.lat, stop.lng) * 1000;
    if (distM > FAIL_RADIUS_M) {
      throw new BadRequestException(`Vous devez être à l’adresse du destinataire (vous êtes à ${Math.round(distM)} m)`);
    }
    if (dto.reason === FailureReason.ABSENT) {
      if (!stop.arrivedAt) throw new BadRequestException('Arrivée non détectée : approchez-vous de l’adresse');
      const waitedMs = Date.now() - stop.arrivedAt.getTime();
      const waitMs = this.settings.pricing.absenceWaitMin * 60_000;
      if (waitedMs < waitMs) {
        const left = Math.ceil((waitMs - waitedMs) / 60000);
        throw new BadRequestException(`Patientez encore ${left} min et essayez d’appeler le destinataire`);
      }
    }

    await this.stops.update(stopId, {
      status: StopStatus.FAILED,
      failedAt: new Date(),
      failureReason: dto.reason,
      failurePhotoUrl: dto.photoUrl,
      failureNote: dto.note ?? null,
      failureLat: driver.lastLat,
      failureLng: driver.lastLng,
    });
    this.tracking.emitToUser(d.clientId, 'stop:failed', { deliveryId: id, stopId, recipientName: stop.recipientName });
    return this.afterStop(id);
  }

  private driverStop(d: Delivery, driverId: string, stopId: string) {
    if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
    if (d.status !== DeliveryStatus.PICKED_UP) throw new BadRequestException('Récupérez d’abord les colis');
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop) throw new NotFoundException('Arrêt introuvable');
    if (stop.status !== StopStatus.PENDING) throw new BadRequestException('Arrêt déjà traité');
    return stop;
  }

  /** Après chaque arrêt : la course est terminée quand il ne reste plus d'arrêt en attente */
  private async afterStop(id: string) {
    const pending = await this.stops.countBy({ deliveryId: id, status: StopStatus.PENDING });
    if (pending === 0) await this.repo.update(id, { status: DeliveryStatus.DELIVERED, deliveredAt: new Date() });
    return this.notify(await this.findOne(id));
  }

  // ---------- Entreprise / Admin ----------

  forCompany(companyId: string) {
    return this.query().where('d.companyId = :companyId', { companyId }).getMany();
  }

  all() {
    return this.query().getMany();
  }

  /** L'entreprise confirme avoir reversé au client le montant encaissé à un arrêt */
  async markCodRemitted(companyId: string, id: string, stopId: string) {
    const d = await this.findOne(id);
    if (d.companyId !== companyId) throw new NotFoundException('Course introuvable');
    const res = await this.stops
      .createQueryBuilder()
      .update(DeliveryStop)
      .set({ codRemittedAt: () => 'NOW()' })
      .where('id = :stopId AND "deliveryId" = :id AND status = :s AND "codAmount" > 0 AND "codRemittedAt" IS NULL', {
        stopId,
        id,
        s: StopStatus.DELIVERED,
      })
      .execute();
    if (!res.affected) throw new BadRequestException('Rien à reverser pour cet arrêt');
    return this.notify(await this.findOne(id));
  }

  /** Le SA annule une course non terminée (motif obligatoire) ; le livreur et le client sont prévenus */
  async adminCancel(id: string, reason: string, by: string) {
    const d = await this.findOne(id);
    if ([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED].includes(d.status)) {
      throw new BadRequestException('Course déjà terminée ou annulée');
    }
    await this.repo.update(id, { status: DeliveryStatus.CANCELLED, cancelledAt: new Date(), cancelReason: reason, cancelledBy: by });
    await this.closeOffers(id);
    this.tracking.emitToUser(d.clientId, 'delivery:cancelled', { deliveryId: id, reason });
    if (d.driverId) this.tracking.emitToUser(d.driverId, 'delivery:cancelled', { deliveryId: id, reason });
    return this.notify(await this.findOne(id));
  }

  /** Arbitrage d'une contestation (SA, ou gérant de l'entreprise du livreur) */
  async resolveDispute(user: AuthUser, by: string, id: string, stopId: string, decision: DisputeDecision, note?: string) {
    const d = await this.findOne(id);
    if (user.role === Role.COMPANY && d.companyId !== user.companyId) throw new NotFoundException('Course introuvable');
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop?.disputedAt) throw new BadRequestException('Aucune contestation sur cet arrêt');
    if (stop.disputeResolvedAt) throw new BadRequestException('Litige déjà tranché');
    await this.stops.update(stopId, {
      disputeDecision: decision,
      disputeResolutionNote: note ?? null,
      disputeResolvedBy: by,
      disputeResolvedAt: new Date(),
    });
    this.tracking.emitToUser(d.clientId, 'dispute:resolved', { deliveryId: id, stopId, decision });
    return this.notify(await this.findOne(id));
  }

  /** Refuse les propositions de prix encore en attente sur une course */
  private closeOffers(deliveryId: string) {
    return this.offers.update({ deliveryId, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
  }

  private async findOne(id: string, withCodes = false) {
    const d = await this.query(withCodes).where('d.id = :id', { id }).getOne();
    if (!d) throw new NotFoundException('Course introuvable');
    return d;
  }
}
