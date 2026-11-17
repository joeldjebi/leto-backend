import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'crypto';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { SavedAddress } from '../addresses/saved-address.entity';
import { BillingService } from '../billing/billing.service';
import { AuthUser } from '../common/decorators';
import { Company } from '../companies/company.entity';
import { allInGrandAbidjan, haversineKm, nearestCommune } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Offer, OfferStatus } from '../offers/offer.entity';
import { computePrice, DeliverySpeed, stopDiscountPct, VehicleType } from '../pricing/pricing';
import { SurchargeService } from '../pricing/surcharge.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { SettingsService } from '../settings/settings.service';
import { FAIL_RADIUS_M, LOCATION_MAX_AGE_MS } from './absence';
import { CompanyOrderDto, CreateDeliveryDto, FailStopDto } from './deliveries.dto';
import { DeliveryStop, DisputeDecision, FailureReason, StopStatus } from './delivery-stop.entity';
import { Delivery, DeliveryStatus } from './delivery.entity';

@Injectable()
export class DeliveriesService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(DeliveriesService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private dataSource: DataSource,
    @InjectRepository(Delivery) private repo: Repository<Delivery>,
    @InjectRepository(DeliveryStop) private stops: Repository<DeliveryStop>,
    @InjectRepository(Offer) private offers: Repository<Offer>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(SavedAddress) private addresses: Repository<SavedAddress>,
    @InjectRepository(Company) private companies: Repository<Company>,
    private tracking: TrackingGateway,
    private geo: GeoService,
    private settings: SettingsService,
    private billing: BillingService,
    private surcharge: SurchargeService,
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
    return withCodes ? qb.addSelect('stop.confirmationCode').addSelect('d.returnCode') : qb;
  }

  // ---------- Client ----------

  /**
   * Nouvelle course. [opts.companyId] : adressée à une entreprise (sa grille tarifaire, ses livreurs seulement).
   * [opts.source] COMPANY : créée par l'entreprise, éventuellement affectée à un de ses livreurs.
   */
  async create(
    clientId: string,
    dto: CreateDeliveryDto,
    opts: { companyId?: string | null; source?: 'CLIENT' | 'COMPANY'; assignedDriverId?: string | null; priceOverride?: number } = {},
  ) {
    let company: Company | null = null;
    if (opts.companyId) {
      company = await this.companies.findOneBy({ id: opts.companyId });
      const subscribed = !!company?.subscriptionEndsAt && company.subscriptionEndsAt.getTime() > Date.now();
      if (!company?.active || !subscribed) throw new BadRequestException('Cette entreprise ne prend pas de commandes pour le moment');
    }
    const grid = this.settings.gridFor(company);
    const vehicleType = dto.vehicleType ?? VehicleType.MOTO;
    const speed = dto.speed ?? DeliverySpeed.STANDARD;
    if (!grid.vehicles[vehicleType].enabled) throw new BadRequestException('Cette offre n’est pas disponible');
    if (dto.stops.length > grid.maxStops) throw new BadRequestException(`${grid.maxStops} adresses maximum par tournée`);
    if (!grid.codEnabled && dto.stops.some((s) => (s.codAmount ?? 0) > 0)) {
      throw new BadRequestException('Le paiement à la livraison n’est pas disponible pour le moment');
    }
    const pickup = { lat: dto.pickupLat, lng: dto.pickupLng };

    // Ordre de passage optimisé, puis itinéraire complet (le prix est toujours calculé ici)
    const order = dto.keepOrder ? dto.stops.map((_, i) => i) : await this.geo.optimizeOrder(pickup, dto.stops);
    const ordered = order.map((i) => dto.stops[i]);
    const route = await this.geo.routeVia([pickup, ...ordered]);
    const codStops = ordered.filter((s) => (s.codAmount ?? 0) > 0).length;
    const inAbidjan = allInGrandAbidjan([pickup, ...ordered]);
    const sur = this.surcharge.context([pickup, ...ordered]);

    // companyId du formulaire = entreprise choisie (cible), à ne pas confondre avec l'entreprise du livreur
    const { companyId: _target, keepOrder: _keep, ...fields } = dto;
    void _target; void _keep;
    const delivery = await this.repo.save(
      this.repo.create({
        ...fields,
        clientId,
        vehicleType,
        speed,
        pickupCommune: nearestCommune(dto.pickupLat, dto.pickupLng),
        distanceKm: Math.round(route.distanceKm * 10) / 10,
        durationMin: route.durationMin,
        price: opts.priceOverride ?? computePrice(grid, route.distanceKm, vehicleType, speed, ordered.length, codStops, { inAbidjan, surchargePct: sur.pct }),
        pricingDetails: { inAbidjan, surchargePct: sur.pct, surcharges: sur.items, stopDiscountPct: stopDiscountPct(grid, ordered.length) },
        returnCode: randomInt(0, 10000).toString().padStart(4, '0'),
        trackingToken: randomBytes(16).toString('hex'),
        targetCompanyId: company?.id ?? null,
        source: opts.source ?? 'CLIENT',
        assignedDriverId: opts.assignedDriverId ?? null,
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
    if (opts.assignedDriverId) {
      this.tracking.emitToUser(opts.assignedDriverId, 'delivery:assigned', { deliveryId: delivery.id });
    }
    if (company) this.tracking.emitToCompany(company.id, 'delivery:new', { deliveryId: delivery.id });
    return this.notify(await this.findOne(delivery.id, true));
  }

  /** L'entreprise crée une course (commande reçue par téléphone…) et peut l'affecter à un de ses livreurs */
  async createForCompany(companyId: string, dto: CompanyOrderDto) {
    if (dto.driverId) await this.companyDriver(companyId, dto.driverId);
    const client = await this.findOrInviteClient(dto.clientName, dto.clientPhone);
    const { clientName, clientPhone, driverId, price, ...order } = dto;
    void clientName; void clientPhone;
    return this.create(client.id, { ...order, pickupPhone: order.pickupPhone || dto.clientPhone, pickupContactName: order.pickupContactName || dto.clientName }, {
      companyId,
      source: 'COMPANY',
      assignedDriverId: driverId ?? null,
      priceOverride: price,
    });
  }

  /** Client existant (même numéro) ou compte « invité » qu'il activera en s'inscrivant dans l'app */
  private async findOrInviteClient(name: string, phone: string) {
    const existing = await this.users.findOneBy({ phone });
    if (existing) {
      if (existing.role !== Role.CLIENT) throw new BadRequestException('Ce numéro appartient à un compte livreur ou entreprise');
      return existing;
    }
    return this.users.save(
      this.users.create({ name, phone, role: Role.CLIENT, invited: true, passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), 10) }),
    );
  }

  private async companyDriver(companyId: string, driverId: string) {
    const driver = await this.users.findOneBy({ id: driverId, companyId, role: Role.DRIVER });
    if (!driver) throw new BadRequestException('Livreur introuvable dans votre entreprise');
    if (!driver.active) throw new BadRequestException('Ce livreur est bloqué');
    return driver;
  }

  /** Affecter (ou retirer l'affectation, driverId null) une course en attente de l'entreprise */
  async assign(companyId: string, id: string, driverId: string | null) {
    const d = await this.findOne(id);
    if (d.targetCompanyId !== companyId) throw new NotFoundException('Course introuvable');
    if (d.status !== DeliveryStatus.PENDING) throw new BadRequestException('Seule une course en attente peut être affectée');
    if (driverId) await this.companyDriver(companyId, driverId);
    const previous = d.assignedDriverId;
    await this.repo.update(id, { assignedDriverId: driverId, assignmentNote: null });
    if (previous && previous !== driverId) this.tracking.emitToUser(previous, 'delivery:unassigned', { deliveryId: id });
    if (driverId) this.tracking.emitToUser(driverId, 'delivery:assigned', { deliveryId: id });
    return this.notify(await this.findOne(id, true));
  }

  /**
   * L'entreprise fixe l'ordre de passage : les arrêts déjà traités gardent leur place en tête,
   * les arrêts à livrer suivent dans l'ordre donné. Le prix ne change pas.
   */
  async reorderStops(companyId: string, id: string, stopIds: string[]) {
    const d = await this.findOne(id);
    if (d.companyId !== companyId && d.targetCompanyId !== companyId) throw new NotFoundException('Course introuvable');
    if (d.status === DeliveryStatus.DELIVERED || d.status === DeliveryStatus.CANCELLED) {
      throw new BadRequestException('Cette course est terminée');
    }
    const pending = d.stops.filter((s) => s.status === StopStatus.PENDING);
    const ids = new Set(pending.map((s) => s.id));
    if (stopIds.length !== pending.length || new Set(stopIds).size !== stopIds.length || stopIds.some((x) => !ids.has(x))) {
      throw new BadRequestException('Donnez tous les arrêts à livrer, chacun une fois');
    }
    const done = d.stops.filter((s) => s.status !== StopStatus.PENDING).sort((a, b) => a.position - b.position);
    const next = [...done, ...stopIds.map((x) => pending.find((s) => s.id === x)!)];
    await this.dataSource.transaction(async (m) => {
      for (const [position, s] of next.entries()) await m.update(DeliveryStop, s.id, { position });
      const route = await this.geo.routeVia([{ lat: d.pickupLat, lng: d.pickupLng }, ...next]).catch(() => null);
      if (route) await m.update(Delivery, id, { distanceKm: Math.round(route.distanceKm * 10) / 10, durationMin: route.durationMin });
    });
    if (d.driverId) this.tracking.emitToUser(d.driverId, 'delivery:reordered', { deliveryId: id });
    return this.notify(await this.findOne(id, true));
  }

  /** Le livreur refuse la course que son entreprise lui a affectée */
  async declineAssignment(driverId: string, id: string, reason?: string) {
    const d = await this.findOne(id);
    if (d.assignedDriverId !== driverId || d.status !== DeliveryStatus.PENDING) throw new BadRequestException('Aucune affectation à refuser');
    await this.repo.update(id, { assignedDriverId: null, assignmentNote: reason ?? 'Refusée par le livreur' });
    if (d.targetCompanyId) {
      const driver = await this.users.findOneBy({ id: driverId });
      this.tracking.emitToCompany(d.targetCompanyId, 'delivery:assignment-declined', { deliveryId: id, driver: driver?.name, reason });
    }
    return this.notify(await this.findOne(id));
  }

  /** Course adressée à une entreprise restée sans réponse : le client l'ouvre à toutes les entreprises */
  async openToAll(clientId: string, id: string) {
    const d = await this.oneForClient(clientId, id);
    if (d.status !== DeliveryStatus.PENDING || !d.targetCompanyId || d.source !== 'CLIENT') {
      throw new BadRequestException('Cette course est déjà ouverte à tous les livreurs');
    }
    await this.repo.update(id, { targetCompanyId: null, assignedDriverId: null });
    return this.notify(await this.findOne(id, true));
  }

  /** Lien de suivi public : informations sans données personnelles sensibles (ni codes, ni numéros des destinataires) */
  async publicTracking(token: string) {
    if (!/^[0-9a-f]{32}$/.test(token)) throw new NotFoundException('Lien de suivi invalide');
    const d = await this.query().where('d.trackingToken = :token', { token }).getOne();
    if (!d) throw new NotFoundException('Lien de suivi invalide');
    const live = d.driver?.lastLocationAt && Date.now() - d.driver.lastLocationAt.getTime() < 2 * 60_000;
    const active = d.status === DeliveryStatus.ACCEPTED || d.status === DeliveryStatus.PICKED_UP;
    const next = d.status === DeliveryStatus.PICKED_UP ? d.stops.find((s) => s.status === StopStatus.PENDING) : null;
    const target = d.status === DeliveryStatus.ACCEPTED ? { lat: d.pickupLat, lng: d.pickupLng } : next ? { lat: next.lat, lng: next.lng } : null;
    const etaMin =
      active && live && target && d.driver.lastLat != null
        ? Math.max(1, Math.ceil(((haversineKm(d.driver.lastLat, d.driver.lastLng, target.lat, target.lng) * 1.35) / 20) * 60))
        : null;
    return {
      status: d.status,
      createdAt: d.createdAt,
      acceptedAt: d.acceptedAt,
      pickedUpAt: d.pickedUpAt,
      deliveredAt: d.deliveredAt,
      cancelledAt: d.cancelledAt,
      vehicleType: d.vehicleType,
      sender: d.pickupContactName ?? d.client?.name ?? null,
      pickup: { address: d.pickupAddress, commune: d.pickupCommune, lat: d.pickupLat, lng: d.pickupLng },
      stops: d.stops.map((s) => ({
        position: s.position,
        recipient: s.recipientName.split(' ')[0],
        address: s.address,
        commune: s.commune,
        lat: s.lat,
        lng: s.lng,
        status: s.status,
        deliveredAt: s.deliveredAt,
      })),
      company: d.company ? { name: d.company.name, phone: d.company.phone } : null,
      driver: d.driver
        ? {
            name: d.driver.name,
            phone: active ? d.driver.phone : null,
            position: active && live && d.driver.lastLat != null ? { lat: d.driver.lastLat, lng: d.driver.lastLng, at: d.driver.lastLocationAt } : null,
          }
        : null,
      etaMin,
      nextStop: next ? next.position : null,
    };
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

  /** Frais de déplacement si la course est annulée maintenant (livreur en route), sinon 0 */
  private cancellationFee(d: Delivery) {
    const g = this.settings.pricing;
    if (!g.cancelFeeEnabled || d.status !== DeliveryStatus.ACCEPTED || !d.acceptedAt) return 0;
    if (Date.now() - d.acceptedAt.getTime() < g.cancelFreeMinutes * 60_000) return 0;
    const fee = g.cancelFeeType === 'PERCENT' ? (d.price * g.cancelFeeValue) / 100 : g.cancelFeeValue;
    return Math.ceil(fee / 50) * 50;
  }

  /** Ce que coûterait l'annulation (affiché à l'expéditeur avant de confirmer) */
  async cancelPreview(clientId: string, id: string) {
    const d = await this.oneForClient(clientId, id);
    const allowed = d.status === DeliveryStatus.PENDING || d.status === DeliveryStatus.ACCEPTED;
    return {
      allowed,
      fee: allowed ? this.cancellationFee(d) : 0,
      reason: allowed ? null : 'Les colis sont déjà récupérés : annulez les arrêts un par un',
      freeMinutes: this.settings.pricing.cancelFreeMinutes,
    };
  }

  /** Annulation de toute la course : gratuite en attente, frais de déplacement possibles si le livreur est en route */
  async cancel(clientId: string, id: string, by = 'Client') {
    const d = await this.oneForClient(clientId, id);
    if (d.status === DeliveryStatus.PICKED_UP) {
      throw new BadRequestException('Les colis sont déjà récupérés : annulez les arrêts un par un');
    }
    if (d.status !== DeliveryStatus.PENDING && d.status !== DeliveryStatus.ACCEPTED) {
      throw new BadRequestException('Course déjà terminée ou annulée');
    }
    const fee = this.cancellationFee(d);
    const res = await this.repo.update(
      { id, clientId, status: d.status },
      { status: DeliveryStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: by, cancellationFee: fee || null },
    );
    if (!res.affected) throw new ConflictException('La course vient de changer d’état : réessayez');
    await this.closeOffers(id);
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'delivery:cancelled', { deliveryId: id, reason: 'Annulée par l’expéditeur', fee });
    }
    if (d.companyId && fee) this.tracking.emitToCompany(d.companyId, 'delivery:cancel-fee', { deliveryId: id, fee });
    return this.notify(await this.findOne(id, true));
  }

  // ---------- Annulation d'un arrêt ----------

  /** L'expéditeur retire un arrêt (avant la récupération : prix recalculé ; après : prix inchangé, colis à retourner) */
  async cancelStop(clientId: string, id: string, stopId: string, reason?: string) {
    const d = await this.oneForClient(clientId, id);
    return this.applyStopCancel(d, stopId, 'Client', reason ?? null);
  }

  private async applyStopCancel(d: Delivery, stopId: string, by: string, reason: string | null) {
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop) throw new NotFoundException('Arrêt introuvable');
    if (stop.status !== StopStatus.PENDING) throw new BadRequestException('Cet arrêt est déjà traité');
    if (![DeliveryStatus.PENDING, DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP].includes(d.status)) {
      throw new BadRequestException('Course déjà terminée ou annulée');
    }
    const remaining = d.stops.filter((s) => s.status === StopStatus.PENDING && s.id !== stopId);
    const beforePickup = d.status !== DeliveryStatus.PICKED_UP;
    // Dernier arrêt avant la récupération : c'est toute la course qui est annulée
    if (beforePickup && remaining.length === 0) return this.cancel(d.clientId, d.id, by);

    await this.stops.update(stopId, {
      status: StopStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledBy: by,
      cancelReason: reason,
      cancelRequestedAt: null,
    });
    if (beforePickup) await this.reprice(d, remaining);
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'stop:cancelled', { deliveryId: d.id, stopId, recipientName: stop.recipientName });
    }
    this.tracking.emitToUser(d.clientId, 'stop:cancelled', { deliveryId: d.id, stopId, recipientName: stop.recipientName });
    return beforePickup ? this.notify(await this.findOne(d.id, true)) : this.afterStop(d.id);
  }

  /** Nouveau prix et nouvel itinéraire avec les arrêts restants (avant la récupération des colis) */
  private async reprice(d: Delivery, remaining: DeliveryStop[]) {
    const company = d.targetCompanyId ? await this.companies.findOneBy({ id: d.targetCompanyId }) : null;
    const grid = this.settings.gridFor(company);
    const pickup = { lat: d.pickupLat, lng: d.pickupLng };
    const route = await this.geo.routeVia([pickup, ...remaining.map((s) => ({ lat: s.lat, lng: s.lng }))]);
    const codStops = grid.codEnabled ? remaining.filter((s) => s.codAmount > 0).length : 0;
    // Mêmes majorations qu'à la commande
    const zone = (pts: { lat: number; lng: number }[]) => ({ inAbidjan: allInGrandAbidjan([pickup, ...pts]), surchargePct: d.pricingDetails?.surchargePct ?? 0 });
    const computed = computePrice(grid, route.distanceKm, d.vehicleType, d.speed, remaining.length, codStops, zone(remaining));
    // Prix négocié (proposition acceptée) : on garde la même proportion
    const listed = d.stops.filter((s) => s.status !== StopStatus.CANCELLED);
    const listPrice = computePrice(grid, d.distanceKm ?? route.distanceKm, d.vehicleType, d.speed, listed.length, codStops, zone(listed));
    const price = Math.min(d.price, d.price > listPrice ? Math.ceil((computed * d.price) / listPrice / 50) * 50 : computed);
    await this.repo.update(d.id, { price, distanceKm: Math.round(route.distanceKm * 10) / 10, durationMin: route.durationMin });
    await this.billing.recompute(d.id);
  }

  /** Le livreur signale que le destinataire annule ; l'expéditeur confirme (ou sans réponse : accepté automatiquement) */
  async requestStopCancel(driverId: string, id: string, stopId: string, note?: string) {
    const d = await this.findOne(id);
    if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
    if (d.status !== DeliveryStatus.ACCEPTED && d.status !== DeliveryStatus.PICKED_UP) throw new BadRequestException('Course non active');
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop || stop.status !== StopStatus.PENDING) throw new BadRequestException('Cet arrêt est déjà traité');
    if (stop.cancelRequestedAt) throw new BadRequestException('Demande déjà envoyée à l’expéditeur');
    await this.stops.update(stopId, { cancelRequestedAt: new Date(), cancelRequestNote: note ?? null });
    this.tracking.emitToUser(d.clientId, 'stop:cancel-request', {
      deliveryId: id,
      stopId,
      recipientName: stop.recipientName,
      autoMin: this.settings.pricing.cancelRequestAutoMin,
    });
    return this.notify(await this.findOne(id));
  }

  /** Réponse de l'expéditeur à une annulation signalée par le livreur */
  async answerCancelRequest(clientId: string, id: string, stopId: string, accept: boolean) {
    const d = await this.oneForClient(clientId, id);
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop?.cancelRequestedAt || stop.status !== StopStatus.PENDING) throw new BadRequestException('Aucune demande en attente');
    if (accept) return this.applyStopCancel(d, stopId, 'Livreur (confirmé par l’expéditeur)', stop.cancelRequestNote);
    await this.stops.update(stopId, { cancelRequestedAt: null });
    if (d.driverId) this.tracking.emitToUser(d.driverId, 'stop:cancel-refused', { deliveryId: id, stopId, recipientName: stop.recipientName });
    return this.notify(await this.findOne(id, true));
  }

  /** Demandes restées sans réponse : acceptées automatiquement */
  private async autoAcceptCancelRequests() {
    const limit = new Date(Date.now() - this.settings.pricing.cancelRequestAutoMin * 60_000);
    const due = await this.stops.find({ where: { status: StopStatus.PENDING, cancelRequestedAt: LessThan(limit) } });
    for (const s of due) {
      try {
        const d = await this.findOne(s.deliveryId, true);
        await this.applyStopCancel(d, s.id, 'Automatique (sans réponse de l’expéditeur)', s.cancelRequestNote);
      } catch (e) {
        this.logger.warn(`Annulation automatique impossible (${s.id}) : ${(e as Error).message}`);
        await this.stops.update(s.id, { cancelRequestedAt: null });
      }
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => this.autoAcceptCancelRequests().catch(() => {}), 30_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
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
  async available(user: AuthUser) {
    const list = await this.query()
      .where('d.status = :s', { s: DeliveryStatus.PENDING })
      .andWhere('(d.targetCompanyId IS NULL OR d.targetCompanyId = :companyId)', { companyId: user.companyId })
      .andWhere('(d.assignedDriverId IS NULL OR d.assignedDriverId = :me)', { me: user.sub })
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

  /**
   * Acceptation atomique : si deux livreurs acceptent en même temps, un seul gagne.
   * L'entreprise doit être abonnée et avoir assez de crédit : la commission est réservée.
   */
  async accept(user: AuthUser, id: string) {
    await this.dataSource.transaction(async (m) => {
      const d = await m.findOneBy(Delivery, { id });
      if (!d || d.status !== DeliveryStatus.PENDING) throw new ConflictException('Course déjà prise ou indisponible');
      if (d.targetCompanyId && d.targetCompanyId !== user.companyId) throw new ForbiddenException('Course réservée à une autre entreprise');
      if (d.assignedDriverId && d.assignedDriverId !== user.sub) throw new ForbiddenException('Course affectée à un autre livreur');
      const commission = await this.billing.reserve(m, user.companyId, d.price);
      const res = await m
        .createQueryBuilder()
        .update(Delivery)
        .set({ status: DeliveryStatus.ACCEPTED, driverId: user.sub, companyId: user.companyId, acceptedAt: () => 'NOW()', ...commission })
        .where('id = :id AND status = :s', { id, s: DeliveryStatus.PENDING })
        .execute();
      if (!res.affected) throw new ConflictException('Course déjà prise ou indisponible');
    });
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
    if (pending === 0) {
      // Colis non livrés (échec ou annulation) : retour à l'expéditeur confirmé par son code, si l'admin l'exige
      const undelivered = await this.stops.countBy({ deliveryId: id, status: Not(StopStatus.DELIVERED) });
      const d = await this.repo.findOneBy({ id });
      if (this.settings.pricing.returnCodeEnabled && undelivered > 0 && d?.pickedUpAt && !d.returnedAt) {
        await this.repo.update(id, { returnRequired: true });
        this.tracking.emitToUser(d.clientId, 'delivery:return', { deliveryId: id, parcels: undelivered });
      } else {
        await this.finish(id);
      }
    }
    return this.notify(await this.findOne(id));
  }

  private async finish(id: string) {
    await this.repo.update(id, { status: DeliveryStatus.DELIVERED, deliveredAt: new Date() });
    await this.billing.charge(id);
  }

  /** Le livreur rapporte les colis non livrés : l'expéditeur lui donne son code de retour */
  async confirmReturn(driverId: string, id: string, code: string) {
    const d = await this.findOne(id, true);
    if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
    if (!d.returnRequired || d.returnedAt || d.status !== DeliveryStatus.PICKED_UP) throw new BadRequestException('Aucun retour attendu');
    if (d.returnCode !== code) throw new BadRequestException('Code de retour incorrect');
    await this.repo.update(id, { returnedAt: new Date() });
    await this.finish(id);
    return this.notify(await this.findOne(id));
  }

  /** L'entreprise a récupéré les frais de déplacement auprès de l'expéditeur */
  async settleCancellationFee(companyId: string, id: string) {
    const res = await this.repo.update(
      { id, companyId, cancellationFee: Not(IsNull()), cancellationFeeSettledAt: IsNull() },
      { cancellationFeeSettledAt: new Date() },
    );
    if (!res.affected) throw new BadRequestException('Rien à régler pour cette course');
    return this.notify(await this.findOne(id));
  }

  // ---------- Entreprise / Admin ----------

  /** Courses de l'entreprise : prises par ses livreurs, ou adressées à elle (en attente) */
  forCompany(companyId: string) {
    return this.query(true)
      .where('(d.companyId = :companyId OR d.targetCompanyId = :companyId)', { companyId })
      .getMany();
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
    if (decision === DisputeDecision.UPHELD) await this.billing.refundStop(id, by);
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
