import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { InjectRepository } from '@nestjs/typeorm';
import { Server, Socket } from 'socket.io';
import { In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../common/decorators';
import { APPROACH_RADIUS_M, ARRIVAL_RADIUS_M } from '../deliveries/absence';
import type { NotifyService } from '../notifications/notify.service';
import { DeliveryStop, StopStatus } from '../deliveries/delivery-stop.entity';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { haversineKm } from '../geo/communes';
import { Role, User } from '../users/user.entity';

/**
 * Temps réel (Socket.IO).
 *
 * Salles :
 *  - `drivers`            : tous les livreurs (nouvelles courses disponibles)
 *  - `delivery:<id>`      : client / livreur / entreprise / SA qui suivent une course
 *  - `company:<id>`       : gérant d'une entreprise (positions de ses livreurs)
 *  - `super-admin`        : SA (toutes les positions)
 *  - `user:<id>`          : chaque utilisateur (réponses aux propositions de prix)
 *
 * Événements émis par le serveur :
 *  - `driver:location`    { deliveryId?, driverId, lat, lng, heading, speed, at }
 *  - `delivery:updated`   { id, status }   → l'app recharge la course via l'API REST
 *  - `deliveries:changed` {}               → les livreurs rechargent la liste des courses disponibles
 *  - `driver:offline`     { driverId }     → un livreur est passé hors ligne
 *  - `delivery:offers`    { deliveryId }   → nouvelle proposition de prix (client)
 *  - `offer:accepted` / `offer:rejected` { deliveryId } → réponse du client (livreur)
 *  - `stop:arrived`       { deliveryId, stopId, recipientName } → livreur arrivé chez un destinataire
 *  - `stop:failed`        { deliveryId, stopId, recipientName } → échec signalé (expéditeur)
 *  - `dispute:new`        { deliveryId, stopId } → contestation (entreprise, SA)
 *  - `client:location`    { deliveryId, lat, lng, at } | { deliveryId, stopped } → position partagée par le client (livreur)
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class TrackingGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server: Server;
  private logger = new Logger(TrackingGateway.name);

  constructor(
    private jwt: JwtService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
    @InjectRepository(DeliveryStop) private stops: Repository<DeliveryStop>,
    private moduleRef: ModuleRef,
  ) {}

  /** Notifications push (résolues à l'usage : NotifyService dépend lui-même de cette passerelle) */
  private push(): NotifyService | null {
    try {
      // Chargé à l'usage : un import direct crée une dépendance circulaire au démarrage
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NotifyService: N } = require('../notifications/notify.service') as typeof import('../notifications/notify.service');
      return this.moduleRef.get(N, { strict: false });
    } catch {
      return null;
    }
  }

  /** Comptes clients VITE du destinataire (même numéro), pour le prévenir aussi */
  private async recipientUsers(phone: string) {
    const rows = await this.users.find({ where: { phone, role: Role.CLIENT }, select: { id: true } });
    return rows.map((u) => u.id);
  }

  /**
   * Authentification AVANT l'acceptation de la connexion (middleware) :
   * le client ne reçoit « connect » qu'une fois son token et son compte vérifiés.
   */
  afterInit(server: Server) {
    server.use(async (socket, next) => {
      // Page publique de suivi : connexion anonyme limitée à la course du lien
      const trackToken = socket.handshake.auth?.trackToken;
      if (typeof trackToken === 'string') {
        const d = /^[0-9a-f]{32}$/.test(trackToken) ? await this.deliveries.findOneBy({ trackingToken: trackToken }).catch(() => null) : null;
        if (!d) return next(new Error('Lien de suivi invalide'));
        socket.data.track = d.id;
        return next();
      }
      try {
        const user: AuthUser = await this.jwt.verifyAsync(socket.handshake.auth?.token);
        const account = await this.users.findOne({ where: { id: user.sub }, relations: { company: true } });
        if (!account?.active || (account.company && !account.company.active)) throw new Error('inactif');
        socket.data.user = user;
        next();
      } catch {
        next(new Error('Non autorisé'));
      }
    });
  }

  handleConnection(socket: Socket) {
    if (socket.data.track) {
      socket.join(`delivery:${socket.data.track}`);
      return;
    }
    const user: AuthUser = socket.data.user;
    if (!user) return socket.disconnect(true);
    socket.join(`user:${user.sub}`);
    if (user.role === Role.DRIVER) socket.join('drivers');
    if (user.role === Role.COMPANY) socket.join(`company:${user.companyId}`);
    if (user.role === Role.SUPER_ADMIN) socket.join('super-admin');
  }

  /** Suivre une course (seulement si on y a droit) */
  @SubscribeMessage('delivery:watch')
  async watch(@ConnectedSocket() socket: Socket, @MessageBody() id: string) {
    const user: AuthUser = socket.data.user;
    if (!user) return { ok: false };
    const d = await this.deliveries.findOneBy({ id }).catch(() => null);
    const allowed =
      d &&
      (d.clientId === user.sub ||
        d.driverId === user.sub ||
        (user.role === Role.COMPANY && d.companyId === user.companyId) ||
        user.role === Role.SUPER_ADMIN);
    if (!allowed) return { ok: false };
    socket.join(`delivery:${id}`);
    return { ok: true };
  }

  @SubscribeMessage('delivery:unwatch')
  unwatch(@ConnectedSocket() socket: Socket, @MessageBody() id: string) {
    socket.leave(`delivery:${id}`);
    return { ok: true };
  }

  /** Entreprise de rattachement d'un LI (cache d'une minute) */
  private affCache = new Map<string, { aff: string | null; at: number }>();
  private async affiliateOf(companyId?: string | null) {
    if (!companyId) return null;
    const hit = this.affCache.get(companyId);
    if (hit && Date.now() - hit.at < 60_000) return hit.aff;
    const [row] = await this.users.manager.query(`SELECT "affiliatedCompanyId" FROM independent_profiles WHERE "companyId" = $1`, [companyId]);
    const aff = (row?.affiliatedCompanyId as string | undefined) ?? null;
    this.affCache.set(companyId, { aff, at: Date.now() });
    return aff;
  }

  /** Dernière écriture en base par livreur (la diffusion, elle, est immédiate) */
  private savedAt = new Map<string, number>();

  /** Le livreur envoie sa position GPS (≈ 1 par seconde en mouvement), avec cap et vitesse si connus */
  @SubscribeMessage('driver:location')
  async location(@ConnectedSocket() socket: Socket, @MessageBody() body: { lat: number; lng: number; heading?: number; speed?: number }) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.DRIVER) return { ok: false };
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false };
    }
    const h = Number(body?.heading);
    const v = Number(body?.speed);
    const heading = body?.heading != null && Number.isFinite(h) && h >= 0 && h <= 360 ? Math.round(h) : null;
    const speed = body?.speed != null && Number.isFinite(v) && v >= 0 && v < 70 ? Math.round(v * 10) / 10 : null;
    const at = new Date();
    // Position persistée au plus toutes les 3 s : soulage la base sans retarder le direct
    const last = this.savedAt.get(user.sub) ?? 0;
    if (at.getTime() - last >= 3000) {
      this.savedAt.set(user.sub, at.getTime());
      await this.users.update(user.sub, { lastLat: lat, lastLng: lng, lastLocationAt: at });
    }

    const payload = { driverId: user.sub, lat, lng, heading, speed, at };
    const aff = await this.affiliateOf(user.companyId);
    let rooms = this.server.to(`company:${user.companyId}`).to('super-admin');
    if (aff) rooms = rooms.to(`company:${aff}`); // LI rattaché : visible par son entreprise
    rooms.emit('driver:location', payload);

    // Diffuse aux clients qui suivent les courses en cours de ce livreur
    const active = await this.deliveries.find({
      where: { driverId: user.sub, status: In([DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP]) },
      select: { id: true, status: true, clientId: true },
    });
    for (const d of active) {
      this.server.to(`delivery:${d.id}`).emit('driver:location', { ...payload, deliveryId: d.id });
      if (d.status === DeliveryStatus.PICKED_UP) await this.detectArrivals(d, user.sub, lat, lng);
    }
    return { ok: true };
  }

  /**
   * Arrivée chez un destinataire (moins de 150 m) : enregistrée côté serveur,
   * c'est le point de départ de l'attente obligatoire avant de pouvoir signaler une absence.
   */
  private async detectArrivals(d: Delivery, driverId: string, lat: number, lng: number) {
    const pending = await this.stops.find({
      where: { deliveryId: d.id, status: StopStatus.PENDING, arrivedAt: IsNull() },
    });
    // Approche (moins de 1 km) : seulement l'arrêt le plus proche, une fois
    const near = pending
      .map((s) => ({ s, m: haversineKm(lat, lng, s.lat, s.lng) * 1000 }))
      .filter((x) => x.m <= APPROACH_RADIUS_M && x.m > ARRIVAL_RADIUS_M && !x.s.approachNotifiedAt)
      .sort((a, b) => a.m - b.m)[0];
    if (near) {
      const res = await this.stops.update({ id: near.s.id, approachNotifiedAt: IsNull() }, { approachNotifiedAt: new Date() });
      if (res.affected) {
        const push = this.push();
        push?.send([d.clientId], 'CLIENT_UPDATE', {
          title: 'Le livreur approche',
          body: `Il arrive chez ${near.s.recipientName} dans quelques minutes`,
          deliveryId: d.id,
        });
        const recipients = (await this.recipientUsers(near.s.recipientPhone)).filter((id) => id !== d.clientId);
        if (recipients.length) {
          push?.send(recipients, 'CLIENT_UPDATE', {
            title: 'Votre livreur VITE arrive',
            body: 'Il sera chez vous dans quelques minutes. Préparez-vous à recevoir votre colis.',
          });
        }
      }
    }
    for (const stop of pending) {
      if (haversineKm(lat, lng, stop.lat, stop.lng) * 1000 > ARRIVAL_RADIUS_M) continue;
      // Mise à jour conditionnelle : si deux positions arrivent en même temps, une seule l'enregistre
      const res = await this.stops.update({ id: stop.id, arrivedAt: IsNull() }, { arrivedAt: new Date() });
      if (!res.affected) continue;
      const event = { deliveryId: d.id, stopId: stop.id, recipientName: stop.recipientName };
      this.server.to(`delivery:${d.id}`).emit('delivery:updated', { id: d.id, status: d.status });
      this.emitToUser(d.clientId, 'stop:arrived', event);
      this.emitToUser(driverId, 'stop:arrived', event);
      const push = this.push();
      push?.send([d.clientId], 'CLIENT_UPDATE', { title: 'Le livreur est arrivé', body: `Il est chez ${stop.recipientName}`, deliveryId: d.id });
      const recipients = (await this.recipientUsers(stop.recipientPhone)).filter((id) => id !== d.clientId);
      if (recipients.length) push?.send(recipients, 'CLIENT_UPDATE', { title: 'Votre livreur VITE est arrivé', body: 'Il vous attend avec votre colis.' });
    }
  }

  /** Position partagée par le client (option « Montrer au livreur où je me trouve »), par course, en mémoire */
  private clientPos = new Map<string, { driverId: string; lat: number; lng: number; at: Date }>();
  private static CLIENT_POS_TTL_MS = 2 * 60_000;

  /** Course en cours du client connecté, sinon null */
  private async clientActiveDelivery(socket: Socket, deliveryId: unknown) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.CLIENT || typeof deliveryId !== 'string' || !/^[0-9a-f-]{36}$/.test(deliveryId)) return null;
    const d = await this.deliveries.findOne({ where: { id: deliveryId }, select: { id: true, clientId: true, driverId: true, status: true } }).catch(() => null);
    if (!d || d.clientId !== user.sub || !d.driverId || ![DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP].includes(d.status)) return null;
    return d;
  }

  /** Le client partage sa position : seul le livreur de la course la reçoit */
  @SubscribeMessage('client:location')
  async clientLocation(@ConnectedSocket() socket: Socket, @MessageBody() body: { deliveryId: string; lat: number; lng: number }) {
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false };
    const d = await this.clientActiveDelivery(socket, body?.deliveryId);
    if (!d) return { ok: false };
    const pos = { driverId: d.driverId!, lat, lng, at: new Date() };
    this.clientPos.set(d.id, pos);
    this.emitToUser(d.driverId!, 'client:location', { deliveryId: d.id, lat, lng, at: pos.at });
    return { ok: true };
  }

  /** Le client arrête le partage : le livreur retire sa position de la carte */
  @SubscribeMessage('client:location:stop')
  async clientLocationStop(@ConnectedSocket() socket: Socket, @MessageBody() body: { deliveryId: string }) {
    const user: AuthUser = socket.data.user;
    const pos = this.clientPos.get(body?.deliveryId);
    if (!pos || user?.role !== Role.CLIENT) return { ok: false };
    const d = await this.deliveries.findOne({ where: { id: body.deliveryId }, select: { id: true, clientId: true } }).catch(() => null);
    if (d?.clientId !== user.sub) return { ok: false };
    this.clientPos.delete(d.id);
    this.emitToUser(pos.driverId, 'client:location', { deliveryId: d.id, stopped: true });
    return { ok: true };
  }

  /** Le livreur (re)charge ses courses : positions client encore fraîches de ses courses en cours */
  @SubscribeMessage('driver:client-locations')
  driverClientLocations(@ConnectedSocket() socket: Socket) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.DRIVER) return [];
    const now = Date.now();
    const out: { deliveryId: string; lat: number; lng: number; at: Date }[] = [];
    for (const [deliveryId, p] of this.clientPos) {
      if (now - p.at.getTime() > TrackingGateway.CLIENT_POS_TTL_MS) this.clientPos.delete(deliveryId);
      else if (p.driverId === user.sub) out.push({ deliveryId, lat: p.lat, lng: p.lng, at: p.at });
    }
    return out;
  }

  /** Le livreur passe « hors ligne » : il n'apparaît plus sur les cartes ni dans les délais */
  @SubscribeMessage('driver:offline')
  async offline(@ConnectedSocket() socket: Socket) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.DRIVER) return { ok: false };
    this.savedAt.delete(user.sub);
    await this.users.update(user.sub, { lastLocationAt: null });
    this.server.to(`company:${user.companyId}`).to('super-admin').emit('driver:offline', { driverId: user.sub });
    return { ok: true };
  }

  // ---------- Appelé par DeliveriesService ----------

  emitToUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  emitToCompany(companyId: string, event: string, payload: unknown) {
    this.server?.to(`company:${companyId}`).to('super-admin').emit(event, payload);
  }

  emitToDelivery(deliveryId: string, event: string, payload: unknown) {
    this.server?.to(`delivery:${deliveryId}`).emit(event, payload);
  }

  /** Branché par l'API partenaire : webhooks à chaque changement d'une course */
  onDeliveryChanged?: (id: string) => void;

  deliveryChanged(d: { id: string; status: DeliveryStatus }) {
    this.onDeliveryChanged?.(d.id);
    // Course terminée ou annulée : la position partagée par le client n'est plus transmise
    const shared = this.clientPos.get(d.id);
    if (shared && d.status !== DeliveryStatus.ACCEPTED && d.status !== DeliveryStatus.PICKED_UP) {
      this.clientPos.delete(d.id);
      this.emitToUser(shared.driverId, 'client:location', { deliveryId: d.id, stopped: true });
    }
    this.server?.to(`delivery:${d.id}`).emit('delivery:updated', { id: d.id, status: d.status });
    this.server?.to('drivers').emit('deliveries:changed', {});
  }
}
