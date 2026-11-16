import { Logger } from '@nestjs/common';
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
import { In, Repository } from 'typeorm';
import { AuthUser } from '../common/decorators';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { Role, User } from '../users/user.entity';

/**
 * Temps réel (Socket.IO).
 *
 * Salles :
 *  - `drivers`            : tous les livreurs (nouvelles courses disponibles)
 *  - `delivery:<id>`      : client / livreur / entreprise / SA qui suivent une course
 *  - `company:<id>`       : gérant d'une entreprise (positions de ses livreurs)
 *  - `super-admin`        : SA (toutes les positions)
 *
 * Événements émis par le serveur :
 *  - `driver:location`    { deliveryId?, driverId, lat, lng, at }
 *  - `delivery:updated`   { id, status }   → l'app recharge la course via l'API REST
 *  - `deliveries:changed` {}               → les livreurs rechargent la liste des courses disponibles
 *  - `driver:offline`     { driverId }     → un livreur est passé hors ligne
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class TrackingGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server: Server;
  private logger = new Logger(TrackingGateway.name);

  constructor(
    private jwt: JwtService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
  ) {}

  /**
   * Authentification AVANT l'acceptation de la connexion (middleware) :
   * le client ne reçoit « connect » qu'une fois son token et son compte vérifiés.
   */
  afterInit(server: Server) {
    server.use(async (socket, next) => {
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
    const user: AuthUser = socket.data.user;
    if (!user) return socket.disconnect(true);
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

  /** Le livreur envoie sa position GPS */
  @SubscribeMessage('driver:location')
  async location(@ConnectedSocket() socket: Socket, @MessageBody() body: { lat: number; lng: number }) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.DRIVER) return { ok: false };
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false };
    }
    const at = new Date();
    await this.users.update(user.sub, { lastLat: lat, lastLng: lng, lastLocationAt: at });

    const payload = { driverId: user.sub, lat, lng, at };
    this.server.to(`company:${user.companyId}`).to('super-admin').emit('driver:location', payload);

    // Diffuse aux clients qui suivent les courses en cours de ce livreur
    const active = await this.deliveries.find({
      where: { driverId: user.sub, status: In([DeliveryStatus.ACCEPTED, DeliveryStatus.PICKED_UP]) },
      select: { id: true },
    });
    for (const d of active) {
      this.server.to(`delivery:${d.id}`).emit('driver:location', { ...payload, deliveryId: d.id });
    }
    return { ok: true };
  }

  /** Le livreur passe « hors ligne » : il n'apparaît plus sur les cartes ni dans les délais */
  @SubscribeMessage('driver:offline')
  async offline(@ConnectedSocket() socket: Socket) {
    const user: AuthUser = socket.data.user;
    if (user?.role !== Role.DRIVER) return { ok: false };
    await this.users.update(user.sub, { lastLocationAt: null });
    this.server.to(`company:${user.companyId}`).to('super-admin').emit('driver:offline', { driverId: user.sub });
    return { ok: true };
  }

  // ---------- Appelé par DeliveriesService ----------

  deliveryChanged(d: { id: string; status: DeliveryStatus }) {
    this.server?.to(`delivery:${d.id}`).emit('delivery:updated', { id: d.id, status: d.status });
    this.server?.to('drivers').emit('deliveries:changed', {});
  }
}
