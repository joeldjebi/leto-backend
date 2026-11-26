import { Countries } from '../countries/phone';
import { money } from '../countries/phone';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'crypto';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { SavedAddress } from '../addresses/saved-address.entity';
import { BillingService } from '../billing/billing.service';
import { IndependentsService } from '../independents/independents.service';
import { NotifyService } from '../notifications/notify.service';
import { AuthUser } from '../common/decorators';
import { Company } from '../companies/company.entity';
import { allInGrandAbidjan, haversineKm, nearestCommune } from '../geo/communes';
import { GeoService } from '../geo/geo.service';
import { Offer, OfferStatus } from '../offers/offer.entity';
import { activeCourses, assertCanTakeMore, Match } from './dispatch';
import { DispatchService } from './dispatch.service';
import { PlanService } from './plan.service';
import { computePrice, DeliverySpeed, stopDiscountPct, VehicleType } from '../pricing/pricing';
import { SurchargeService } from '../pricing/surcharge.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Role, User } from '../users/user.entity';
import { SettingsService } from '../settings/settings.service';
import { FAIL_RADIUS_M, LOCATION_MAX_AGE_MS } from './absence';
import { CompanyOrderDto, CreateDeliveryDto, FailStopDto, FollowUpDto, HelpAnswerDto, RateDto } from './deliveries.dto';
import { DeliveryStop, DisputeDecision, FailureReason, FollowUp, MAX_ATTEMPTS, StopStatus } from './delivery-stop.entity';
import { Delivery, DeliveryStatus } from './delivery.entity';

/** Motif d'échec, en clair pour l'expéditeur et le back-office */
const FAILURE_TEXT: Record<FailureReason, string> = {
  ABSENT: 'destinataire absent ou injoignable',
  REFUSED: 'colis refusé',
  WRONG_ADDRESS: 'adresse introuvable',
  NO_MONEY: 'le destinataire n’avait pas l’argent',
  DAMAGED: 'colis abîmé',
  UNSAFE: 'lieu dangereux ou inaccessible',
};
/** L'expéditeur demande d'attendre : minutes ajoutées */
const HELP_WAIT_MIN = 5;
/** Nouvelle tentative : nouvelle adresse à moins de ce rayon de la première (sinon nouvelle commande) */
const RETRY_MAX_KM = 5;

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
    private independents: IndependentsService,
    private push: NotifyService,
    private surcharge: SurchargeService,
    private dispatch: DispatchService,
    private plan: PlanService,
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
    const forIndependents = !opts.companyId && dto.forIndependents === true && (opts.source ?? 'CLIENT') === 'CLIENT';
    if (forIndependents) {
      // Choix explicite du client : livreurs indépendants, règles LETO par défaut, sans encaissement
      if (!this.independents.config.enabled) throw new BadRequestException('Les livreurs indépendants ne sont pas disponibles pour le moment');
      if (dto.stops.some((s) => (s.codAmount ?? 0) > 0)) {
        throw new BadRequestException('Les livreurs indépendants ne prennent pas de paiement à la livraison : choisissez une entreprise');
      }
    }
    if (opts.companyId) {
      company = await this.companies.findOneBy({ id: opts.companyId });
      // Abonnée, en essai gratuit, ou abonnements désactivés par LETO
      if (!company?.active || !this.billing.subscribed(company)) throw new BadRequestException('Cette entreprise ne prend pas de commandes pour le moment');
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
    const { companyId: _target, keepOrder: _keep, forIndependents: _li, ...fields } = dto;
    void _target; void _keep; void _li;
    const delivery = await this.repo.save(
      this.repo.create({
        currency: Countries.operating.currencyCode,
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
        forIndependents,
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
      this.push.send([opts.assignedDriverId], 'ASSIGNED', {
        title: 'Course affectée par votre entreprise',
        body: `${money(delivery.price)} · départ ${delivery.pickupCommune ?? ''}`.trim(),
        deliveryId: delivery.id,
      });
    } else {
      void this.dispatch.start(delivery.id, grid);
    }
    if (company) this.tracking.emitToCompany(company.id, 'delivery:new', { deliveryId: delivery.id });
    // Back-office : l'entreprise choisie par le client (pas pour ses propres commandes) et le SA
    this.push.office(
      { companyId: company && opts.source !== 'COMPANY' ? company.id : null, sa: true },
      'NEW_ORDER',
      {
        title: opts.source === 'COMPANY' ? `Commande saisie par ${company?.name ?? 'une entreprise'}` : company ? 'Nouvelle commande pour vous' : 'Nouvelle commande',
        body: `${money(delivery.price)} · ${ordered.length} arrêt${ordered.length > 1 ? 's' : ''} · départ ${delivery.pickupCommune ?? delivery.pickupAddress}`,
        link: `/courses/${delivery.id}`,
        deliveryId: delivery.id,
      },
    );
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
    if (driverId) void this.dispatch.closed(id);
    if (previous && previous !== driverId) {
      this.tracking.emitToUser(previous, 'delivery:unassigned', { deliveryId: id });
      this.push.send([previous], 'UPDATED', { title: 'Affectation retirée', body: 'Votre entreprise a retiré cette course', deliveryId: id });
    }
    if (driverId) {
      this.tracking.emitToUser(driverId, 'delivery:assigned', { deliveryId: id });
      this.push.send([driverId], 'ASSIGNED', {
        title: 'Course affectée par votre entreprise',
        body: `${money(d.price)} · départ ${d.pickupCommune ?? ''}`.trim(),
        deliveryId: id,
      });
    }
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
    if (d.driverId) {
      await this.plan.applyCompanyOrder(d.driverId, id, stopIds);
      this.tracking.emitToUser(d.driverId, 'delivery:reordered', { deliveryId: id });
      this.push.send([d.driverId], 'UPDATED', { title: 'Ordre de passage modifié', body: 'Votre entreprise a changé l’ordre des arrêts', deliveryId: id });
    }
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
      this.push.office({ companyId: d.targetCompanyId }, 'DECLINED', {
        title: 'Affectation refusée',
        body: `${driver?.name ?? 'Le livreur'} a refusé la course${reason ? ` : ${reason}` : ''}. Choisissez un autre livreur.`,
        link: `/courses/${id}`,
        deliveryId: id,
      });
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
    const opened = await this.findOne(id, true);
    void this.dispatch.start(opened.id);
    return this.notify(opened);
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
    // Itinéraire réel : la tournée (départ → arrêts restants) et l'approche du livreur vers sa prochaine étape
    // Toujours la tournée complète (départ puis arrêts non annulés), quel que soit l'avancement
    const tourPoints = [
      { lat: d.pickupLat, lng: d.pickupLng },
      ...d.stops.filter((s) => s.status !== StopStatus.CANCELLED).map((s) => ({ lat: s.lat, lng: s.lng })),
    ];
    const tour = tourPoints.length >= 2 ? await this.geo.routeVia(tourPoints).catch(() => null) : null;
    const driverPos = active && live && d.driver.lastLat != null ? { lat: d.driver.lastLat, lng: d.driver.lastLng } : null;
    // Position arrondie (~100 m) : l'itinéraire d'approche est réutilisé tant que le livreur n'a pas beaucoup bougé
    const approach =
      driverPos && target
        ? await this.geo
            .routeVia([{ lat: Math.round(driverPos.lat * 1000) / 1000, lng: Math.round(driverPos.lng * 1000) / 1000 }, target])
            .catch(() => null)
        : null;
    return {
      status: d.status,
      route: tour?.points ?? null,
      approach: approach?.points ?? null,
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
            // Dernière position connue (jusqu'à 30 min) ; `live` : mise à jour il y a moins de 2 min
            position:
              active && d.driver.lastLat != null && d.driver.lastLocationAt && Date.now() - d.driver.lastLocationAt.getTime() < 30 * 60_000
                ? { lat: d.driver.lastLat, lng: d.driver.lastLng, at: d.driver.lastLocationAt, live: !!live }
                : null,
            vehicle: d.driver.vehicleType ?? d.vehicleType,
            plate: d.driver.plate,
            rating: d.driver.ratingCount >= 3 ? d.driver.ratingAvg : null,
          }
        : null,
      etaMin: approach ? Math.max(1, approach.durationMin) : etaMin,
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

  /** Le client note le livreur (1 à 5 étoiles, compliments, commentaire) ; la moyenne du livreur est recalculée */
  async rate(clientId: string, id: string, dto: RateDto) {
    const d = await this.oneForClient(clientId, id);
    if (d.status !== DeliveryStatus.DELIVERED || !d.driverId) throw new BadRequestException('Vous pourrez noter le livreur une fois la livraison terminée');
    if (d.ratedAt) throw new BadRequestException('Vous avez déjà noté cette livraison');
    const res = await this.repo.update(
      { id, ratedAt: IsNull() },
      { rating: dto.stars, ratingTags: dto.tags?.length ? [...new Set(dto.tags)] : null, ratingComment: dto.comment?.trim() || null, ratedAt: new Date() },
    );
    if (!res.affected) throw new BadRequestException('Vous avez déjà noté cette livraison');
    const [{ avg, count }] = await this.repo.query(
      `SELECT avg(rating)::float AS avg, count(*)::int AS count FROM deliveries WHERE "driverId" = $1 AND rating IS NOT NULL`,
      [d.driverId],
    );
    await this.users.update(d.driverId, { ratingAvg: avg == null ? null : Math.round(avg * 100) / 100, ratingCount: count });
    return this.oneForClient(clientId, id);
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
  async cancel(clientId: string, id: string, by = 'Client', reason: string | null = null) {
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
      { status: DeliveryStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: by, cancellationFee: fee || null, ...(reason ? { cancelReason: reason } : {}) },
    );
    if (!res.affected) throw new ConflictException('La course vient de changer d’état : réessayez');
    await this.closeOffers(id);
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'delivery:cancelled', { deliveryId: id, reason: reason ?? 'Annulée par l’expéditeur', fee });
      this.push.send([d.driverId], 'CANCELLED', {
        title: 'Course annulée',
        body: `L’expéditeur a annulé la course${reason ? ` : ${reason}` : ''}${fee ? ` · frais de déplacement ${money(fee)}` : ''}`,
        deliveryId: id,
      });
    } else if (d.assignedDriverId) {
      this.push.send([d.assignedDriverId], 'CANCELLED', { title: 'Course annulée', body: 'L’expéditeur a annulé la course', deliveryId: id });
    }
    if (d.companyId && fee) this.tracking.emitToCompany(d.companyId, 'delivery:cancel-fee', { deliveryId: id, fee });
    const concerned = d.companyId ?? d.targetCompanyId;
    if (concerned) {
      this.push.office({ companyId: concerned }, 'CANCELLED', {
        title: 'Course annulée par le client',
        body: `${reason ?? 'Sans motif'}${fee ? ` · frais de déplacement ${money(fee)}` : ''}`,
        link: `/courses/${id}`,
        deliveryId: id,
      });
    }
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
    if (beforePickup && remaining.length === 0) return this.cancel(d.clientId, d.id, by, reason);

    await this.stops.update(stopId, {
      status: StopStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledBy: by,
      cancelReason: reason,
      cancelRequestedAt: null,
      // Après la récupération, le colis revient chez l'expéditeur : retour facturé
      ...(beforePickup ? {} : { followUp: FollowUp.RETURN, followUpBy: by, returnFee: this.stopFee(d, this.settings.pricing.returnFeePct) }),
    });
    if (beforePickup) await this.reprice(d, remaining);
    else await this.refreshFees(d.id);
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'stop:cancelled', { deliveryId: d.id, stopId, recipientName: stop.recipientName });
      this.push.send([d.driverId], 'UPDATED', {
        title: 'Arrêt annulé',
        body: `${stop.recipientName} · ${stop.address}${beforePickup ? '' : ' : rapportez le colis à l’expéditeur'}`,
        deliveryId: d.id,
      });
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
    if (d.companyId && !d.company?.independent) {
      this.push.office({ companyId: d.companyId }, 'CANCEL_REQUEST', {
        title: 'Annulation signalée par un livreur',
        body: `${d.driver?.name ?? 'Le livreur'} : ${stop.recipientName} annule${note ? ` (« ${note} »)` : ''}. L’expéditeur doit confirmer.`,
        link: `/courses/${id}`,
        deliveryId: id,
      });
    }
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

  /** Commandes restées sans livreur au-delà du délai fixé par l'admin : expirées (annulées) */
  private async expireOrders() {
    const min = this.settings.pricing.orderExpiryMin ?? 0;
    if (!min) return;
    const limit = new Date(Date.now() - min * 60_000);
    const due = await this.repo.find({ where: { status: DeliveryStatus.PENDING, createdAt: LessThan(limit) }, take: 100 });
    for (const d of due) {
      const reason = `Aucun livreur n’a accepté la commande dans les ${min} min`;
      const res = await this.repo.update(
        { id: d.id, status: DeliveryStatus.PENDING },
        { status: DeliveryStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: 'Expiration', cancelReason: reason },
      );
      if (!res.affected) continue; // acceptée entre-temps
      await this.closeOffers(d.id);
      this.tracking.emitToUser(d.clientId, 'delivery:cancelled', { deliveryId: d.id, reason });
      this.push.send([d.clientId], 'CANCELLED', {
        title: 'Commande expirée',
        body: `${reason}. Vous pouvez la relancer depuis l’app.`,
        deliveryId: d.id,
      });
      if (d.assignedDriverId) this.push.send([d.assignedDriverId], 'CANCELLED', { title: 'Course expirée', body: reason, deliveryId: d.id });
      if (d.targetCompanyId) {
        this.push.office({ companyId: d.targetCompanyId }, 'CANCELLED', { title: 'Commande expirée', body: reason, link: `/courses/${d.id}`, deliveryId: d.id });
      }
      this.notify(await this.findOne(d.id));
      this.logger.log(`Commande ${d.id} expirée après ${min} min sans livreur`);
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      this.autoAcceptCancelRequests().catch(() => {});
      this.autoReturns().catch((e) => this.logger.warn(`Retours automatiques : ${(e as Error).message}`));
      this.expireOrders().catch((e) => this.logger.warn(`Expiration des commandes : ${(e as Error).message}`));
    }, 30_000);
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
    this.push.office({ companyId: d.companyId, sa: true }, 'DISPUTE', {
      title: 'Nouveau litige',
      body: `L’expéditeur conteste l’échec chez ${stop.recipientName}${note ? ` : « ${note} »` : ''}`,
      link: '/litiges',
      deliveryId: id,
    });
    return this.notify(await this.findOne(id, true));
  }

  // ---------- Livreur ----------

  /** Courses en attente (sans les numéros des destinataires tant que la course n'est pas acceptée) */
  async available(user: AuthUser) {
    // Livreur indépendant : uniquement les courses où le client a choisi les indépendants
    const independent = await this.independents.isIndependent(user.companyId);
    if (independent && (await this.independents.blocker(user.companyId!))) return [];
    const list = await this.query()
      .where('d.status = :s', { s: DeliveryStatus.PENDING })
      .andWhere('d.forIndependents = :li', { li: independent })
      .andWhere(independent ? 'TRUE' : '(d.targetCompanyId IS NULL OR d.targetCompanyId = :companyId)', { companyId: user.companyId })
      .andWhere('(d.assignedDriverId IS NULL OR d.assignedDriverId = :me)', { me: user.sub })
      .orderBy('d.createdAt', 'ASC')
      .addOrderBy('stop.position', 'ASC')
      .getMany();
    for (const d of list) {
      if (d.client) d.client.phone = undefined;
      for (const s of d.stops) s.recipientPhone = undefined;
    }
    // Envoi par vagues : une course n'apparaît qu'une fois le livreur prévenu (ou toutes les vagues passées)
    const visible = list.filter((d) => d.assignedDriverId === user.sub || this.dispatch.canSee(d.id, user.sub));
    list.length = 0;
    list.push(...visible);
    // Livreur déjà en course : seulement les commandes sur son trajet ou près de lui (et celles que son entreprise lui affecte)
    const courses = (await activeCourses(this.dataSource, [user.sub])).get(user.sub) ?? [];
    if (!courses.length) return list;
    const me = await this.users.findOne({ where: { id: user.sub }, select: { id: true, lastLat: true, lastLng: true } });
    const out: (Delivery & { match?: Match | null })[] = [];
    for (const d of list) {
      if (d.assignedDriverId === user.sub) {
        out.push(d);
        continue;
      }
      if (me?.lastLat == null || me.lastLng == null) continue;
      const match = await this.dispatch.matchFor(user.sub, { lat: me.lastLat, lng: me.lastLng }, courses, { lat: d.pickupLat, lng: d.pickupLng }, d.speed);
      if (match) out.push(Object.assign(d, { match }));
    }
    return out;
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
      // Course affectée par son entreprise : acceptée même au-delà du maximum
      if (d.assignedDriverId !== user.sub) await assertCanTakeMore(m, user.sub, this.settings.pricing, d.speed);
      if (d.targetCompanyId && d.targetCompanyId !== user.companyId) throw new ForbiddenException('Course réservée à une autre entreprise');
      if (d.assignedDriverId && d.assignedDriverId !== user.sub) throw new ForbiddenException('Course affectée à un autre livreur');
      const independent = await this.independents.isIndependent(user.companyId);
      if (d.forIndependents !== independent) {
        throw new ForbiddenException(independent ? 'Course réservée aux livreurs des entreprises' : 'Course réservée aux livreurs indépendants');
      }
      const commission = await this.billing.reserve(m, user.companyId, d.price);
      const res = await m
        .createQueryBuilder()
        .update(Delivery)
        .set({ status: DeliveryStatus.ACCEPTED, driverId: user.sub, companyId: user.companyId, acceptedAt: () => 'NOW()', ...commission })
        .where('id = :id AND status = :s', { id, s: DeliveryStatus.PENDING })
        .execute();
      if (!res.affected) throw new ConflictException('Course déjà prise ou indisponible');
    });
    await this.dispatch.accepted(id, user.sub);
    await this.closeOffers(id);
    const accepted = await this.findOne(id);
    if (accepted.companyId && !accepted.company?.independent) {
      this.push.office({ companyId: accepted.companyId }, 'ACCEPTED', {
        title: 'Course acceptée',
        body: `${accepted.driver?.name ?? 'Un livreur'} · ${money(accepted.price)} · départ ${accepted.pickupCommune ?? accepted.pickupAddress}`,
        link: `/courses/${id}`,
        deliveryId: id,
      });
    }
    this.push.send([accepted.clientId], 'CLIENT_UPDATE', {
      title: 'Livreur trouvé',
      body: `${accepted.driver?.name ?? 'Un livreur'}${accepted.company?.independent ? ' (livreur indépendant)' : ''} arrive au point de départ`,
      deliveryId: id,
    });
    return this.notify(accepted);
  }

  async pickup(driverId: string, id: string, checkCalls = true) {
    if (checkCalls && this.settings.pricing.preCallRequired !== false) {
      const d = await this.findOne(id);
      if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
      const missing = d.stops.filter((s) => s.status === StopStatus.PENDING && !s.calledAt);
      if (missing.length) {
        throw new BadRequestException(
          missing.length === 1
            ? `Appelez ${missing[0].recipientName} avant de prendre la route, pour confirmer qu’il ou elle est disponible`
            : `Appelez les ${missing.length} destinataires avant de prendre la route, pour confirmer qu’ils sont disponibles`,
        );
      }
    }
    const res = await this.repo.update(
      { id, driverId, status: DeliveryStatus.ACCEPTED },
      { status: DeliveryStatus.PICKED_UP, pickedUpAt: new Date() },
    );
    if (!res.affected) throw new BadRequestException('Action impossible pour cette course');
    const picked = await this.findOne(id);
    this.push.send([picked.clientId], 'CLIENT_UPDATE', { title: 'Colis récupérés', body: `${picked.driver?.name ?? 'Le livreur'} est en route vers les destinataires`, deliveryId: id });
    // Destinataires qui ont un compte LETO (même numéro) : prévenus par push
    const phones = picked.stops.filter((s) => s.status === StopStatus.PENDING).map((s) => s.recipientPhone);
    if (phones.length) {
      const recipients = await this.users.find({ where: phones.map((phone) => ({ phone, role: Role.CLIENT })), select: { id: true } });
      const ids = recipients.map((u) => u.id).filter((uid) => uid !== picked.clientId);
      if (ids.length) {
        this.push.send(ids, 'CLIENT_UPDATE', { title: 'Votre colis est en route', body: `${picked.driver?.name ?? 'Un livreur LETO'} vous l’apporte. Vous serez prévenu à son approche.` });
      }
    }
    return this.notify(picked);
  }

  /** Livraison d'un arrêt : le destinataire donne son code au livreur */
  async deliverStop(driverId: string, id: string, stopId: string, code: string) {
    const d = await this.findOne(id, true);
    const stop = this.driverStop(d, driverId, stopId);
    // Code du destinataire exigé seulement si l'admin l'a activé
    if (this.settings.pricing.deliveryCodeEnabled !== false && stop.confirmationCode !== code) {
      throw new BadRequestException(code ? 'Code incorrect' : 'Code du destinataire obligatoire');
    }
    await this.stops.update(stopId, { status: StopStatus.DELIVERED, deliveredAt: new Date() });
    this.push.send([d.clientId], 'CLIENT_UPDATE', { title: 'Colis livré', body: `Livré à ${stop.recipientName}`, deliveryId: id });
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
    if ((dto.reason === FailureReason.ABSENT || dto.reason === FailureReason.WRONG_ADDRESS) && !stop.callCount) {
      throw new BadRequestException('Appelez d’abord le destinataire depuis l’app');
    }
    if (dto.reason === FailureReason.ABSENT && stop.waitUntil && stop.waitUntil.getTime() > Date.now()) {
      const left = Math.ceil((stop.waitUntil.getTime() - Date.now()) / 60000);
      throw new BadRequestException(`L’expéditeur vous demande de patienter encore ${left} min`);
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

    // Suite : l'expéditeur choisit (nouvelle tentative ou retour), sauf 2e passage ou colis abîmé → retour
    const g = this.settings.pricing;
    const canRetry = stop.attempt < MAX_ATTEMPTS && dto.reason !== FailureReason.DAMAGED;
    await this.stops.update(stopId, {
      status: StopStatus.FAILED,
      failedAt: new Date(),
      failureReason: dto.reason,
      failurePhotoUrl: dto.photoUrl,
      failureNote: dto.note ?? null,
      failureLat: driver.lastLat,
      failureLng: driver.lastLng,
      ...(canRetry
        ? { followUp: FollowUp.DECIDING, followUpDeadline: new Date(Date.now() + g.followUpAutoMin * 60_000), followUpBy: null }
        : { followUp: FollowUp.RETURN, followUpBy: 'Automatique', returnFee: this.stopFee(d, g.returnFeePct) }),
    });
    if (!canRetry) await this.refreshFees(id);
    const why = FAILURE_TEXT[dto.reason] ?? 'voir le détail';
    this.tracking.emitToUser(d.clientId, 'stop:failed', { deliveryId: id, stopId, recipientName: stop.recipientName, deciding: canRetry, autoMin: g.followUpAutoMin });
    this.push.send([d.clientId], 'CLIENT_UPDATE', {
      title: 'Livraison non effectuée',
      body: canRetry
        ? `${stop.recipientName} : ${why}. Choisissez une nouvelle tentative ou le retour du colis (sinon retour dans ${g.followUpAutoMin} min).`
        : `${stop.recipientName} : ${why}. Le colis vous est rapporté.`,
      deliveryId: id,
    });
    this.push.office({ companyId: d.companyId }, 'FAILED', {
      title: 'Livraison non effectuée',
      body: `${stop.recipientName} : ${why}${stop.attempt > 1 ? ' (2e passage)' : ''}`,
      link: `/courses/${id}`,
      deliveryId: id,
    });
    this.checkFailRate(driverId, driver.name, d.companyId).catch(() => {});
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
    // Encore à livrer, ou échec en attente du choix de l'expéditeur
    const pending = await this.stops.count({
      where: [
        { deliveryId: id, status: StopStatus.PENDING },
        { deliveryId: id, status: StopStatus.FAILED, followUp: FollowUp.DECIDING },
      ],
    });
    if (pending === 0) {
      // Colis non livrés (échec ou annulation) : toujours rapportés à l'expéditeur (code exigé si l'admin l'a activé)
      const undelivered = await this.stops.countBy({ deliveryId: id, status: Not(StopStatus.DELIVERED) });
      const d = await this.repo.findOneBy({ id });
      if (undelivered > 0 && d?.pickedUpAt && !d.returnedAt) {
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
    const d = await this.repo.findOneBy({ id });
    if (d) this.push.send([d.clientId], 'CLIENT_UPDATE', { title: 'Course terminée', body: 'Tous les arrêts sont traités. Merci d’avoir choisi LETO !', deliveryId: id });
    if (d?.companyId) {
      this.push.office({ companyId: d.companyId }, 'FINISHED', {
        title: 'Tournée terminée',
        body: `${money(d.price)} · tous les arrêts sont traités`,
        link: `/courses/${id}`,
        deliveryId: id,
      });
    }
  }

  /** Le livreur rapporte les colis non livrés : l'expéditeur lui donne son code de retour */
  async confirmReturn(driverId: string, id: string, code?: string) {
    const d = await this.findOne(id, true);
    if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
    if (!d.returnRequired || d.returnedAt || d.status !== DeliveryStatus.PICKED_UP) throw new BadRequestException('Aucun retour attendu');
    if (this.settings.pricing.returnCodeEnabled) {
      if (d.returnCode !== code) throw new BadRequestException(code ? 'Code de retour incorrect' : 'Demandez le code de retour à l’expéditeur');
    } else {
      // Sans code : le livreur doit être au point de départ
      const driver = await this.users.findOneBy({ id: driverId });
      const fresh = driver?.lastLocationAt && Date.now() - driver.lastLocationAt.getTime() < LOCATION_MAX_AGE_MS;
      if (!fresh || driver?.lastLat == null) throw new BadRequestException('Position GPS indisponible : activez la localisation');
      const distM = haversineKm(driver.lastLat, driver.lastLng, d.pickupLat, d.pickupLng) * 1000;
      if (distM > FAIL_RADIUS_M) throw new BadRequestException(`Rendez le colis au point de départ (vous êtes à ${Math.round(distM)} m)`);
    }
    await this.repo.update(id, { returnedAt: new Date() });
    this.push.send([d.clientId], 'CLIENT_UPDATE', { title: 'Colis rapporté', body: `${d.driver?.name ?? 'Le livreur'} vous a rendu les colis non livrés`, deliveryId: id });
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
    this.push.send([d.clientId, d.driverId], 'CANCELLED', { title: 'Course annulée par LETO', body: reason, deliveryId: id });
    if (d.companyId ?? d.targetCompanyId) {
      this.push.office({ companyId: d.companyId ?? d.targetCompanyId }, 'CANCELLED', { title: 'Course annulée par LETO', body: reason, link: `/courses/${id}`, deliveryId: id });
    }
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
    if (decision === DisputeDecision.UPHELD) {
      await this.stops.update(stopId, { returnFee: 0, retryFee: 0 });
      await this.refreshFees(id);
      await this.billing.refundStop(id, by);
    }
    this.tracking.emitToUser(d.clientId, 'dispute:resolved', { deliveryId: id, stopId, decision });
    return this.notify(await this.findOne(id));
  }

  // ---------- Appels, aide sur place, suite d'un échec ----------

  /** Le livreur appelle un destinataire (ou l'expéditeur si [stopId] est vide) depuis l'app : l'appel est enregistré */
  async logCall(driverId: string, id: string, stopId: string | null) {
    const d = await this.findOne(id);
    if (d.driverId !== driverId) throw new ForbiddenException('Ce n’est pas votre course');
    if (d.status !== DeliveryStatus.ACCEPTED && d.status !== DeliveryStatus.PICKED_UP) throw new BadRequestException('Course non active');
    if (!stopId) {
      await this.repo.update(id, { pickupCalledAt: new Date() });
    } else {
      const stop = d.stops.find((s) => s.id === stopId);
      if (!stop || stop.status !== StopStatus.PENDING) throw new BadRequestException('Cet arrêt est déjà traité');
      await this.stops.update(stopId, { calledAt: new Date(), callCount: () => '"callCount" + 1' });
    }
    return this.notify(await this.findOne(id));
  }

  /** Sur place, le destinataire ne répond pas : le livreur demande à l'expéditeur quoi faire */
  async requestHelp(driverId: string, id: string, stopId: string, note?: string) {
    const d = await this.findOne(id);
    const stop = this.driverStop(d, driverId, stopId);
    if (!stop.arrivedAt) throw new BadRequestException('Arrivez d’abord à l’adresse du destinataire');
    if (!stop.callCount) throw new BadRequestException('Appelez d’abord le destinataire depuis l’app');
    if (stop.helpRequestedAt && !stop.helpAnswer) throw new BadRequestException('Demande déjà envoyée à l’expéditeur');
    await this.stops.update(stopId, { helpRequestedAt: new Date(), helpAnswer: null });
    this.tracking.emitToUser(d.clientId, 'stop:help', { deliveryId: id, stopId, recipientName: stop.recipientName, note: note ?? null });
    this.push.send([d.clientId], 'CLIENT_UPDATE', {
      title: 'Le destinataire ne répond pas',
      body: `${d.driver?.name ?? 'Le livreur'} est chez ${stop.recipientName}${note ? ` (« ${note} »)` : ''}. Dites-lui quoi faire dans l’app.`,
      deliveryId: id,
    });
    return this.notify(await this.findOne(id));
  }

  /** Réponse de l'expéditeur : attendre 5 min de plus, nouveau numéro / indications, ou annuler (colis rapporté) */
  async answerHelp(clientId: string, id: string, stopId: string, dto: HelpAnswerDto) {
    const d = await this.oneForClient(clientId, id);
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop?.helpRequestedAt || stop.status !== StopStatus.PENDING) throw new BadRequestException('Aucune demande en attente');
    if (dto.action === 'CANCEL') {
      await this.stops.update(stopId, { helpAnswer: 'Annuler : rapporter le colis' });
      return this.applyStopCancel(d, stopId, 'Client (destinataire injoignable)', 'Destinataire injoignable');
    }
    let answer = 'Attendre 5 min de plus';
    const patch: Partial<DeliveryStop> = { waitUntil: new Date(Date.now() + HELP_WAIT_MIN * 60_000) };
    if (dto.action === 'UPDATE') {
      const phone = dto.recipientPhone?.trim();
      const details = dto.details?.trim();
      if (!phone && !details) throw new BadRequestException('Indiquez un nouveau numéro ou des indications');
      if (phone) patch.recipientPhone = phone;
      if (details) patch.details = details;
      answer = [phone && `Nouveau numéro : ${phone}`, details && `Indications : ${details}`].filter(Boolean).join(' · ');
    }
    await this.stops.update(stopId, { ...patch, helpAnswer: answer });
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'stop:help-answer', { deliveryId: id, stopId, recipientName: stop.recipientName, answer });
      this.push.send([d.driverId], 'UPDATED', { title: `Réponse de l’expéditeur · ${stop.recipientName}`, body: answer, deliveryId: id });
    }
    return this.notify(await this.findOne(id, true));
  }

  /** Après un échec : l'expéditeur choisit une nouvelle tentative (à prix réduit) ou le retour du colis */
  async chooseFollowUp(clientId: string, id: string, stopId: string, dto: FollowUpDto) {
    const d = await this.oneForClient(clientId, id);
    const stop = d.stops.find((s) => s.id === stopId);
    if (!stop || stop.status !== StopStatus.FAILED || stop.followUp !== FollowUp.DECIDING || d.status !== DeliveryStatus.PICKED_UP) {
      throw new BadRequestException('Le choix n’est plus possible pour ce colis');
    }
    if (dto.action === 'RETURN') {
      await this.setReturn(d, stop, 'Client');
      return this.afterStop(id);
    }
    if (stop.disputedAt) throw new BadRequestException('Un litige est en cours sur ce colis : il vous sera rapporté');
    const moved = dto.lat != null && dto.lng != null;
    if (moved) {
      if (!dto.address?.trim()) throw new BadRequestException('Adresse de la nouvelle tentative obligatoire');
      const km = haversineKm(stop.lat, stop.lng, dto.lat!, dto.lng!);
      if (km > RETRY_MAX_KM) throw new BadRequestException(`Nouvelle adresse à plus de ${RETRY_MAX_KM} km : passez une nouvelle commande`);
    }
    const g = this.settings.pricing;
    const past = [
      ...(stop.pastAttempts ?? []),
      { failedAt: (stop.failedAt ?? new Date()).toISOString(), reason: stop.failureReason!, photoUrl: stop.failurePhotoUrl, note: stop.failureNote, address: stop.address },
    ];
    const res = await this.stops.update(
      { id: stopId, status: StopStatus.FAILED, followUp: FollowUp.DECIDING },
      {
        status: StopStatus.PENDING,
        attempt: stop.attempt + 1,
        pastAttempts: past,
        followUp: FollowUp.RETRY,
        followUpBy: 'Client',
        followUpDeadline: null,
        retryFee: this.stopFee(d, g.retryFeePct),
        failedAt: null,
        failureReason: null,
        failurePhotoUrl: null,
        failureNote: null,
        failureLat: null,
        failureLng: null,
        arrivedAt: null,
        calledAt: null,
        callCount: 0,
        helpRequestedAt: null,
        helpAnswer: null,
        waitUntil: null,
        ...(dto.recipientPhone?.trim() ? { recipientPhone: dto.recipientPhone.trim() } : {}),
        ...(dto.details?.trim() ? { details: dto.details.trim() } : {}),
        ...(moved ? { lat: dto.lat!, lng: dto.lng!, address: dto.address!.trim(), commune: nearestCommune(dto.lat!, dto.lng!) } : {}),
      },
    );
    if (!res.affected) throw new ConflictException('Le colis vient de changer d’état : réessayez');
    await this.refreshFees(id);
    if (d.driverId) {
      const body = `${stop.recipientName}${moved ? ` · nouvelle adresse : ${dto.address!.trim()}` : ''}${dto.recipientPhone ? ` · nouveau numéro` : ''}. Appelez le destinataire avant d’y retourner.`;
      this.tracking.emitToUser(d.driverId, 'stop:retry', { deliveryId: id, stopId, recipientName: stop.recipientName });
      this.push.send([d.driverId], 'UPDATED', { title: 'Nouvelle tentative demandée', body, deliveryId: id });
    }
    return this.notify(await this.findOne(id, true));
  }

  /** Le colis non livré sera rapporté à l'expéditeur (retour facturé) */
  private async setReturn(d: Delivery, stop: DeliveryStop, by: string) {
    const res = await this.stops.update(
      { id: stop.id, status: StopStatus.FAILED, followUp: FollowUp.DECIDING },
      { followUp: FollowUp.RETURN, followUpBy: by, followUpDeadline: null, returnFee: this.stopFee(d, this.settings.pricing.returnFeePct) },
    );
    if (!res.affected) return false;
    await this.refreshFees(d.id);
    if (d.driverId) {
      this.tracking.emitToUser(d.driverId, 'stop:return', { deliveryId: d.id, stopId: stop.id, recipientName: stop.recipientName });
      this.push.send([d.driverId], 'UPDATED', { title: 'Colis à rapporter', body: `${stop.recipientName} : rapportez le colis à l’expéditeur`, deliveryId: d.id });
    }
    return true;
  }

  /** Échecs sans choix de l'expéditeur dans le délai : retour automatique */
  private async autoReturns() {
    const due = await this.stops.find({ where: { status: StopStatus.FAILED, followUp: FollowUp.DECIDING, followUpDeadline: LessThan(new Date()) }, take: 100 });
    for (const s of due) {
      try {
        const d = await this.findOne(s.deliveryId);
        if (!(await this.setReturn(d, s, 'Automatique (sans réponse de l’expéditeur)'))) continue;
        this.push.send([d.clientId], 'CLIENT_UPDATE', { title: 'Colis rapporté', body: `${s.recipientName} : sans réponse de votre part, le colis vous est rapporté`, deliveryId: d.id });
        await this.afterStop(d.id);
      } catch (e) {
        this.logger.warn(`Retour automatique impossible (${s.id}) : ${(e as Error).message}`);
      }
    }
  }

  /** Part du prix d'un arrêt × [pct] %, arrondie aux 50 F supérieurs (arrêts retirés avant la récupération exclus) */
  private stopFee(d: Delivery, pct: number) {
    if (!pct || pct <= 0) return 0;
    const counted = d.stops.filter(
      (s) => !(s.status === StopStatus.CANCELLED && (!d.pickedUpAt || (s.cancelledAt && s.cancelledAt < d.pickedUpAt))),
    ).length;
    const share = d.price / Math.max(1, counted);
    return Math.ceil((share * pct) / 100 / 50) * 50;
  }

  /** Total des frais ajoutés (retours, nouvelles tentatives) et commission ajustée */
  private async refreshFees(id: string) {
    const [{ total }] = await this.stops.query(
      `SELECT COALESCE(sum("returnFee" + "retryFee"), 0)::int AS total FROM delivery_stops WHERE "deliveryId" = $1`,
      [id],
    );
    await this.repo.update(id, { extraFees: total });
    await this.billing.recompute(id);
  }

  /** Taux d'échec d'un livreur sur 7 jours : alerte au back-office au-delà du seuil (une fois par jour) */
  private failAlerted = new Map<string, number>();
  private async checkFailRate(driverId: string, name: string, companyId: string | null) {
    const pct = this.settings.pricing.failAlertPct;
    if (!pct) return;
    const last = this.failAlerted.get(driverId) ?? 0;
    if (Date.now() - last < 24 * 3600_000) return;
    const [r] = await this.repo.query(
      `SELECT count(*) FILTER (WHERE s.status = 'FAILED')::int + COALESCE(sum(jsonb_array_length(COALESCE(s."pastAttempts", '[]'::jsonb))), 0)::int AS failed,
              count(*) FILTER (WHERE s.status IN ('FAILED', 'DELIVERED'))::int + COALESCE(sum(jsonb_array_length(COALESCE(s."pastAttempts", '[]'::jsonb))), 0)::int AS done
         FROM delivery_stops s JOIN deliveries d ON d.id = s."deliveryId"
        WHERE d."driverId" = $1 AND COALESCE(s."failedAt", s."deliveredAt") >= now() - interval '7 days'`,
      [driverId],
    );
    if (r.failed < 3 || r.done < 5 || r.failed * 100 < pct * r.done) return;
    this.failAlerted.set(driverId, Date.now());
    this.push.office({ companyId, sa: true }, 'FAILED', {
      title: 'Taux d’échec élevé',
      body: `${name} : ${r.failed} échecs sur ${r.done} livraisons en 7 jours (${Math.round((r.failed * 100) / r.done)} %). Vérifiez ses signalements.`,
      link: `/livreurs/${driverId}`,
    });
  }

  /** Refuse les propositions de prix encore en attente sur une course (prise, annulée ou expirée) et prévient leurs livreurs */
  private async closeOffers(deliveryId: string) {
    await this.dispatch.closed(deliveryId);
    const pending = await this.offers.find({ where: { deliveryId, status: OfferStatus.PENDING }, select: { id: true, driverId: true } });
    if (!pending.length) return;
    await this.offers.update({ deliveryId, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
    const d = await this.repo.findOneBy({ id: deliveryId });
    const taken = d?.status === DeliveryStatus.ACCEPTED;
    const drivers = pending.map((o) => o.driverId).filter((id) => id !== d?.driverId);
    for (const id of drivers) this.tracking.emitToUser(id, 'offer:rejected', { deliveryId });
    this.push.send(drivers, 'UPDATED', {
      title: taken ? 'Course attribuée à un autre livreur' : 'Course plus disponible',
      body: taken ? 'Un livreur a accepté la course au prix affiché.' : 'L’expéditeur ou LETO a annulé la course : votre proposition est retirée.',
      deliveryId,
    });
  }

  private async findOne(id: string, withCodes = false) {
    const d = await this.query(withCodes).where('d.id = :id', { id }).getOne();
    if (!d) throw new NotFoundException('Course introuvable');
    return d;
  }
}
