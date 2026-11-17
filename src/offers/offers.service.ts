import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { AuthUser } from '../common/decorators';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { haversineKm } from '../geo/communes';
import { IndependentsService } from '../independents/independents.service';
import { NotifyService } from '../notifications/notify.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { Offer, OfferStatus } from './offer.entity';

/** Durée de validité d'une proposition */
export const OFFER_TTL_MS = 2 * 60 * 1000;
/** Une proposition ne peut pas dépasser 2 × le prix affiché */
export const MAX_OFFER_FACTOR = 2;
const UNPAYABLE = 'Ce livreur ne peut plus prendre la course : choisissez une autre proposition';

@Injectable()
export class OffersService {
  constructor(
    private dataSource: DataSource,
    @InjectRepository(Offer) private offers: Repository<Offer>,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
    private tracking: TrackingGateway,
    private billing: BillingService,
    private independents: IndependentsService,
    private push: NotifyService,
  ) {}

  // ---------- Livreur ----------

  async propose(user: AuthUser, deliveryId: string, price: number) {
    const d = await this.deliveries.findOneBy({ id: deliveryId });
    if (!d || d.status !== DeliveryStatus.PENDING) throw new BadRequestException('Cette course n’est plus disponible');
    if (d.targetCompanyId && d.targetCompanyId !== user.companyId) throw new BadRequestException('Course réservée à une autre entreprise');
    if (d.assignedDriverId && d.assignedDriverId !== user.sub) throw new BadRequestException('Course affectée à un autre livreur');
    if (d.forIndependents !== (await this.independents.isIndependent(user.companyId))) {
      throw new BadRequestException(d.forIndependents ? 'Course réservée aux livreurs indépendants' : 'Course réservée aux livreurs des entreprises');
    }
    if (price <= d.price) {
      throw new BadRequestException(`Proposez plus de ${d.price} F, ou acceptez la course au prix affiché`);
    }
    if (price > d.price * MAX_OFFER_FACTOR) {
      throw new BadRequestException(`Proposition trop élevée (maximum ${d.price * MAX_OFFER_FACTOR} F)`);
    }
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
    this.push.send([d.clientId], 'CLIENT_UPDATE', { title: 'Nouvelle proposition', body: `Un livreur propose ${price.toLocaleString('fr-FR')} F pour votre course`, deliveryId });
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
      }
      throw e;
    });

    this.tracking.emitToUser(offer.driverId, 'offer:accepted', { deliveryId: offer.deliveryId });
    this.push.send([offer.driverId], 'ASSIGNED', { title: 'Proposition acceptée', body: `Le client a accepté ${offer.price.toLocaleString('fr-FR')} F : allez au point de départ`, deliveryId: offer.deliveryId });
    for (const o of others) this.tracking.emitToUser(o.driverId, 'offer:rejected', { deliveryId: offer.deliveryId });
    this.tracking.deliveryChanged({ id: offer.deliveryId, status: DeliveryStatus.ACCEPTED });
    return { ok: true, deliveryId: offer.deliveryId, price: offer.price };
  }

  async decline(clientId: string, offerId: string) {
    const offer = await this.ownedOffer(clientId, offerId);
    await this.offers.update({ id: offer.id, status: OfferStatus.PENDING }, { status: OfferStatus.REJECTED });
    this.tracking.emitToUser(offer.driverId, 'offer:rejected', { deliveryId: offer.deliveryId });
    this.tracking.emitToDelivery(offer.deliveryId, 'delivery:offers', { deliveryId: offer.deliveryId });
    return { ok: true };
  }

  private async ownedOffer(clientId: string, offerId: string) {
    const offer = await this.offers.findOne({ where: { id: offerId }, relations: { delivery: true } });
    if (!offer || offer.delivery.clientId !== clientId) throw new NotFoundException('Proposition introuvable');
    return offer;
  }
}
