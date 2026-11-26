import { money } from '../countries/phone';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { AuthUser } from '../common/decorators';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { haversineKm } from '../geo/communes';
import { IndependentsService } from '../independents/independents.service';
import { NotifyService } from '../notifications/notify.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Offer, OfferStatus } from './offer.entity';
import { assertCanTakeMore } from '../deliveries/dispatch';
import { DispatchService } from '../deliveries/dispatch.service';
import { SettingsService } from '../settings/settings.service';
import { User } from '../users/user.entity';

/** Durée de validité d'une proposition */
export const OFFER_TTL_MS = 2 * 60 * 1000;
/** Une proposition ne peut pas dépasser 2 × le prix affiché */
export const MAX_OFFER_FACTOR = 2;
const UNPAYABLE = 'Ce livreur ne peut plus prendre la course : choisissez une autre proposition';

@Injectable()
export class OffersService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(OffersService.name);
  private timer?: NodeJS.Timeout;
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Offer) private offers: Repository<Offer>,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
    private tracking: TrackingGateway,
    private billing: BillingService,
    private independents: IndependentsService,
    private push: NotifyService,
    private settings: SettingsService,
    private dispatch: DispatchService,
  ) {}

  // ---------- Livreur ----------

  async propose(user: AuthUser, deliveryId: string, price: number) {
    const d = await this.deliveries.findOneBy({ id: deliveryId });
    if (!d || d.status !== DeliveryStatus.PENDING) throw new BadRequestException('Cette course n’est plus disponible');
    if (d.assignedDriverId && d.assignedDriverId !== user.sub) throw new BadRequestException('Course affectée à un autre livreur');
    const access = await this.independents.access(user.companyId);
    if (access.blocker) throw new BadRequestException(access.blocker);
    const [cod] = await this.deliveries.query(`SELECT 1 FROM delivery_stops WHERE "deliveryId" = $1 AND "codAmount" > 0 LIMIT 1`, [deliveryId]);
    if (!this.independents.canTake(access, d, !!cod)) {
      throw new BadRequestException(access.independent && cod ? 'Les livreurs indépendants ne prennent pas de paiement à la livraison' : 'Course réservée à une autre entreprise');
    }
    if (price <= d.price) {
      throw new BadRequestException(`Proposez plus de ${money(d.price)}, ou acceptez la course au prix affiché`);
    }
    if (price > d.price * MAX_OFFER_FACTOR) {
      throw new BadRequestException(`Proposition trop élevée (maximum ${money(d.price * MAX_OFFER_FACTOR)})`);
    }
    await assertCanTakeMore(this.dataSource, user.sub, this.settings.pricing, d.speed);
    // L'entreprise doit pouvoir payer la commission à ce prix (vérifié à nouveau quand le client accepte)
    await this.billing.check(user.companyId, price);
    // Une seule proposition active par livreur et par course : la nouvelle remplace l'ancienne
    await this.offers.update(
      { deliveryId, driverId: user.sub, status: OfferStatus.PENDING },
      { status: OfferStatus.REJECTED },
    );
    const offer = await this.offers.save(
      this.offers.create({
        deliveryId,
        driverId: user.sub,
        companyId: user.companyId,
        price,
        expiresAt: new Date(Date.now() + OFFER_TTL_MS),
      }),
    );
    this.tracking.emitToDelivery(deliveryId, 'delivery:offers', { deliveryId });
    void this.dispatch.proposed(deliveryId, user.sub);
    const driver = await this.dataSource.getRepository(User).findOneBy({ id: user.sub });
    this.push.send([d.clientId], 'CLIENT_UPDATE', {
      title: 'Nouvelle proposition de prix',
      body: `${driver?.name ?? 'Un livreur'} propose ${money(price)} (prix affiché ${money(d.price)}). Répondez dans les 2 min.`,
      deliveryId,
    });
    return offer;
  }

  /** Propositions en attente du livreur (pour afficher « en attente » dans sa liste) */
  mine(driverId: string) {
    return this.offers.find({
      where: { driverId, status: OfferStatus.PENDING, expiresAt: MoreThan(new Date()) },
      select: { id: true, deliveryId: true, price: true, expiresAt: true },
    });
  }

  // ---------- Client ----------

  async forClient(clientId: string, deliveryId: string) {
    const d = await this.deliveries.findOneBy({ id: deliveryId, clientId });
    if (!d) throw new NotFoundException('Course introuvable');
    if (d.status !== DeliveryStatus.PENDING) return [];
    const list = await this.offers.find({
      where: { deliveryId, status: OfferStatus.PENDING, expiresAt: MoreThan(new Date()) },
      relations: { driver: true, company: true },
      order: { price: 'ASC' },
    });
    return list.map((o) => ({
      id: o.id,
      price: o.price,
      expiresAt: o.expiresAt,
      driver: { name: o.driver.name, avatarUrl: o.driver.avatarUrl, vehicleType: o.driver.vehicleType },
      // Livreur indépendant : toujours signalé au client (pas d'entreprise derrière lui)
      independent: !!o.company?.independent,
      company: o.company && !o.company.independent ? { name: o.company.name } : null,
      // Délai d'arrivée estimé du livreur au point de départ (20 km/h en ville)
      etaMin:
        o.driver.lastLat != null && d.pickupLat != null
          ? Math.max(2, Math.ceil(((haversineKm(o.driver.lastLat, o.driver.lastLng, d.pickupLat, d.pickupLng) * 1.35) / 20) * 60) + 2)
          : null,
    }));
  }

  /** Le client accepte une proposition : la course est attribuée au livreur, au prix proposé */
  async accept(clientId: string, offerId: string) {
    const offer = await this.ownedOffer(clientId, offerId);
    if (offer.status === OfferStatus.ACCEPTED) throw new BadRequestException('Proposition déjà acceptée');
    if (offer.status !== OfferStatus.PENDING || offer.expiresAt < new Date()) {
      throw new BadRequestException('Cette proposition a expiré');
    }
    const others = await this.dataSource.transaction(async (m) => {
      // Le livreur a pu accepter d'autres courses entre-temps
      await assertCanTakeMore(m, offer.driverId, this.settings.pricing, offer.delivery?.speed).catch(() => {
        throw new BadRequestException('Ce livreur a désormais trop de courses en cours : choisissez une autre proposition');
      });
      const commission = await this.billing.reserve(m, offer.companyId, offer.price).catch(() => {
        throw new BadRequestException(UNPAYABLE);
      });
      const res = await m
        .createQueryBuilder()
        .update(Delivery)
        .set({
          status: DeliveryStatus.ACCEPTED,
          driverId: offer.driverId,
          companyId: offer.companyId,
          price: offer.price,
          acceptedAt: () => 'NOW()',
          ...commission,
        })
        .where('id = :id AND status = :s', { id: offer.deliveryId, s: DeliveryStatus.PENDING })
        .execute();
      if (!res.affected) throw new ConflictException('La course n’est plus disponible');
      await m.update(Offer, { id: offer.id }, { status: OfferStatus.ACCEPTED });
      const rest = await m.find(Offer, { where: { deliveryId: offer.deliveryId, status: OfferStatus.PENDING } });
      await m.update(Offer, { deliveryId: offer.deliveryId, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
      return rest;
    }).catch(async (e) => {
      // Entreprise du livreur sans crédit ou abonnement : sa proposition est écartée
      if (e?.message === UNPAYABLE) {
        await this.offers.update({ id: offer.id, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
        this.tracking.emitToUser(offer.driverId, 'offer:rejected', { deliveryId: offer.deliveryId });
        this.push.send([offer.driverId], 'UPDATED', {
          title: 'Proposition écartée',
          body: 'Le client voulait l’accepter, mais le crédit ou l’abonnement de votre entreprise ne le permet pas.',
          deliveryId: offer.deliveryId,
        });
      }
      throw e;
    });

    await this.dispatch.accepted(offer.deliveryId, offer.driverId);
    this.tracking.emitToUser(offer.driverId, 'offer:accepted', { deliveryId: offer.deliveryId });
    this.push.send([offer.driverId], 'ASSIGNED', { title: 'Proposition acceptée', body: `Le client a accepté ${money(offer.price)} : allez au point de départ`, deliveryId: offer.deliveryId });
    for (const o of others) this.tracking.emitToUser(o.driverId, 'offer:rejected', { deliveryId: offer.deliveryId });
    this.push.send(others.map((o) => o.driverId), 'UPDATED', {
      title: 'Course attribuée à un autre livreur',
      body: 'Le client a choisi une autre proposition.',
      deliveryId: offer.deliveryId,
    });
    this.tracking.deliveryChanged({ id: offer.deliveryId, status: DeliveryStatus.ACCEPTED });
    return { ok: true, deliveryId: offer.deliveryId, price: offer.price };
  }

  async decline(clientId: string, offerId: string) {
    const offer = await this.ownedOffer(clientId, offerId);
    await this.offers.update({ id: offer.id, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
    this.tracking.emitToUser(offer.driverId, 'offer:rejected', { deliveryId: offer.deliveryId });
    this.tracking.emitToDelivery(offer.deliveryId, 'delivery:offers', { deliveryId: offer.deliveryId });
    this.push.send([offer.driverId], 'UPDATED', {
      title: 'Proposition refusée',
      body: `Le client a refusé ${money(offer.price)}. Vous pouvez accepter au prix affiché ou proposer un autre prix.`,
      deliveryId: offer.deliveryId,
    });
    return { ok: true };
  }

  /** Propositions sans réponse après 2 min : expirées, le livreur est prévenu, la liste du client se met à jour */
  private async expireOffers() {
    const due = await this.offers.find({ where: { status: OfferStatus.PENDING, expiresAt: LessThan(new Date()) }, take: 200 });
    if (!due.length) return;
    const res = await this.offers.update({ id: In(due.map((o) => o.id)), status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
    if (!res.affected) return;
    for (const o of due) {
      this.tracking.emitToUser(o.driverId, 'offer:rejected', { deliveryId: o.deliveryId });
      this.tracking.emitToDelivery(o.deliveryId, 'delivery:offers', { deliveryId: o.deliveryId });
      this.push.send([o.driverId], 'UPDATED', {
        title: 'Proposition expirée',
        body: `Le client n’a pas répondu à ${money(o.price)} à temps. La course est peut-être encore disponible.`,
        deliveryId: o.deliveryId,
      });
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => this.expireOffers().catch((e) => this.logger.warn(`Expiration des propositions : ${(e as Error).message}`)), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async ownedOffer(clientId: string, offerId: string) {
    const offer = await this.offers.findOne({ where: { id: offerId }, relations: { delivery: true } });
    if (!offer || offer.delivery.clientId !== clientId) throw new NotFoundException('Proposition introuvable');
    return offer;
  }
}
