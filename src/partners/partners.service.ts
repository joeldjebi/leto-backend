import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes } from 'crypto';
import { DataSource, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { Delivery, DeliveryStatus } from '../deliveries/delivery.entity';
import { Setting } from '../settings/setting.entity';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { AccountType, Role, User } from '../users/user.entity';
import { Partner, PartnerKey, PartnerWebhook } from './partner.entities';

const KEY = 'partners';
interface PartnersConfig {
  /** Interrupteur général de l'API partenaire */
  enabled: boolean;
}
/** Relances d'un webhook en échec : 30 s, 2 min, 10 min, 1 h, 6 h, 24 h */
const BACKOFF_S = [30, 120, 600, 3600, 21_600, 86_400];
const WORKER_MS = 10_000;
const TIMEOUT_MS = 10_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Lien de suivi public (site VITE) */
const trackingBase = () => process.env.PUBLIC_TRACKING_URL ?? 'https://vite.ci/#/suivi/';

/**
 * API partenaire de VITE : comptes partenaires (Adjamé-Smart, boutiques en ligne…), clés d'API,
 * interrupteurs du SA (général et par partenaire), webhooks signés avec relances,
 * relevé des encaissements par partenaire.
 */
@Injectable()
export class PartnersService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(PartnersService.name);
  private cfg: PartnersConfig = { enabled: false };
  private worker?: NodeJS.Timeout;
  private sending = false;

  constructor(
    private db: DataSource,
    @InjectRepository(Partner) private partners: Repository<Partner>,
    @InjectRepository(PartnerKey) private keys: Repository<PartnerKey>,
    @InjectRepository(PartnerWebhook) private hooks: Repository<PartnerWebhook>,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Setting) private settings: Repository<Setting>,
    private tracking: TrackingGateway,
  ) {}

  async onModuleInit() {
    const row = await this.settings.findOneBy({ key: KEY });
    if (row) this.cfg = { enabled: false, ...(row.value as Partial<PartnersConfig>) };
    // Chaque changement d'une course passe par le temps réel : on y branche les webhooks des partenaires
    this.tracking.onDeliveryChanged = (id) => this.onDeliveryChanged(id).catch((e) => this.logger.warn(`Webhook partenaire : ${e}`));
    this.worker = setInterval(() => this.flush().catch((e) => this.logger.warn(`Envoi des webhooks : ${e}`)), WORKER_MS);
    this.worker.unref();
  }

  onModuleDestroy() {
    if (this.worker) clearInterval(this.worker);
  }

  // ---------- Réglages (SA) ----------

  get config() {
    return { ...this.cfg };
  }

  async setEnabled(enabled: boolean, by: string) {
    this.cfg = { ...this.cfg, enabled };
    await this.settings.save({ key: KEY, value: this.cfg, updatedBy: by });
    return this.list();
  }

  async list() {
    const rows = await this.db.query(
      `SELECT p.*, u.phone, u.name AS "accountName",
              (SELECT count(*)::int FROM partner_keys k WHERE k."partnerId" = p.id AND k."revokedAt" IS NULL) AS keys,
              (SELECT count(*)::int FROM deliveries d WHERE d."partnerId" = p.id) AS deliveries,
              (SELECT count(*)::int FROM deliveries d WHERE d."partnerId" = p.id AND d."createdAt" > now() - interval '7 days') AS "deliveriesWeek",
              (SELECT count(*)::int FROM partner_webhooks w WHERE w."partnerId" = p.id AND w.status = 'FAILED') AS "failedHooks",
              (SELECT max(k."lastUsedAt") FROM partner_keys k WHERE k."partnerId" = p.id) AS "lastUsedAt"
         FROM partners p JOIN users u ON u.id = p."userId" ORDER BY p."createdAt" DESC`,
    );
    return { config: this.config, partners: rows.map((r: Partner) => ({ ...r, webhookSecret: undefined })) };
  }

  /** Nouveau partenaire : son compte client VITE (existant par téléphone, sinon créé) */
  async create(dto: { name: string; phone: string; webhookUrl?: string; note?: string }) {
    let user = await this.users.findOneBy({ phone: dto.phone });
    if (user && user.role !== Role.CLIENT) throw new ConflictException('Ce numéro est déjà utilisé par un compte qui n’est pas client');
    if (user && (await this.partners.existsBy({ userId: user.id }))) throw new ConflictException('Ce compte client est déjà relié à un partenaire');
    if (!user) {
      user = await this.users.save(
        this.users.create({
          name: dto.name.trim(),
          phone: dto.phone,
          role: Role.CLIENT,
          accountType: AccountType.SHOP,
          passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
        }),
      );
    }
    const p = await this.partners.save({
      name: dto.name.trim(),
      userId: user.id,
      webhookUrl: this.checkUrl(dto.webhookUrl),
      webhookSecret: `whsec_${randomBytes(24).toString('hex')}`,
      note: dto.note?.trim() || null,
    });
    return this.detail(p.id);
  }

  private checkUrl(url?: string | null) {
    if (!url?.trim()) return null;
    const u = url.trim();
    if (!/^https?:\/\/[^\s]+$/.test(u)) throw new BadRequestException('Adresse du webhook invalide (http:// ou https://)');
    if (process.env.NODE_ENV === 'production' && !u.startsWith('https://')) throw new BadRequestException('Le webhook doit être en https');
    return u;
  }

  async update(id: string, dto: { name?: string; active?: boolean; webhookUrl?: string | null; note?: string | null }) {
    const p = await this.mine(id);
    if (dto.name !== undefined) p.name = dto.name.trim();
    if (dto.active !== undefined) p.active = dto.active;
    if (dto.webhookUrl !== undefined) p.webhookUrl = this.checkUrl(dto.webhookUrl);
    if (dto.note !== undefined) p.note = dto.note?.trim() || null;
    await this.partners.save(p);
    return this.detail(id);
  }

  /** Nouveau secret de signature (montré une fois) */
  async rotateSecret(id: string) {
    const p = await this.mine(id);
    p.webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
    await this.partners.save(p);
    return { ...(await this.detail(id)), webhookSecret: p.webhookSecret };
  }

  private async mine(id: string) {
    const p = await this.partners.findOneBy({ id });
    if (!p) throw new NotFoundException('Partenaire introuvable');
    return p;
  }

  async detail(id: string) {
    const p = await this.mine(id);
    const user = await this.users.findOneBy({ id: p.userId });
    const keys = await this.keys.find({ where: { partnerId: id }, order: { createdAt: 'DESC' } });
    const webhooks = await this.hooks.find({ where: { partnerId: id }, order: { createdAt: 'DESC' }, take: 50 });
    const recent = await this.deliveries.find({ where: { partnerId: id }, order: { createdAt: 'DESC' }, take: 20, relations: { stops: true } });
    return {
      ...p,
      webhookSecret: `${p.webhookSecret.slice(0, 10)}…`,
      phone: user?.phone ?? null,
      keys: keys.map((k) => ({ ...k, hash: undefined })),
      webhooks,
      deliveries: recent.map((d) => ({ id: d.id, reference: d.partnerReference, status: d.status, price: d.price, createdAt: d.createdAt, stops: d.stops?.length ?? 0 })),
      statement: await this.statement(id),
      config: this.config,
    };
  }

  // ---------- Clés d'API ----------

  async createKey(partnerId: string, label: string) {
    await this.mine(partnerId);
    const raw = `leto_live_${randomBytes(24).toString('hex')}`;
    const k = await this.keys.save({ partnerId, label: label.trim() || 'Clé', prefix: raw.slice(0, 16), hash: sha256(raw) });
    // La clé complète n'est renvoyée qu'ici : seule son empreinte est gardée
    return { id: k.id, label: k.label, prefix: k.prefix, key: raw, createdAt: k.createdAt };
  }

  async revokeKey(partnerId: string, keyId: string) {
    const res = await this.keys.update({ id: keyId, partnerId, revokedAt: IsNull() }, { revokedAt: new Date() });
    if (!res.affected) throw new NotFoundException('Clé introuvable ou déjà révoquée');
    return this.detail(partnerId);
  }

  /** Clé reçue sur l'API partenaire → partenaire (interrupteurs du SA vérifiés) */
  async authenticate(raw: string | undefined) {
    if (!raw) throw new UnauthorizedException('Clé d’API manquante (en-tête Authorization: Bearer <clé>)');
    if (!this.cfg.enabled) throw new ForbiddenException('L’API partenaire VITE est désactivée pour le moment');
    const k = await this.keys.findOneBy({ hash: sha256(raw) });
    if (!k || k.revokedAt) throw new UnauthorizedException('Clé d’API invalide ou révoquée');
    const p = await this.partners.findOneBy({ id: k.partnerId });
    if (!p) throw new UnauthorizedException('Clé d’API invalide');
    if (!p.active) throw new ForbiddenException('Votre accès à l’API VITE est désactivé : contactez VITE');
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) await this.keys.update(k.id, { lastUsedAt: new Date() });
    return p;
  }

  // ---------- Vue partenaire d'une course ----------

  view(d: Delivery) {
    const active = d.status === DeliveryStatus.ACCEPTED || d.status === DeliveryStatus.PICKED_UP;
    const stops = [...(d.stops ?? [])].sort((a, b) => a.position - b.position);
    return {
      id: d.id,
      reference: d.partnerReference,
      status: d.status,
      vehicleType: d.vehicleType,
      speed: d.speed,
      price: d.price + (d.extraFees ?? 0),
      currency: d.currency,
      feePaidBy: d.feePaidBy,
      distanceKm: d.distanceKm,
      durationMin: d.durationMin,
      trackingUrl: d.trackingToken ? `${trackingBase()}${d.trackingToken}` : null,
      pickup: { address: d.pickupAddress, lat: d.pickupLat, lng: d.pickupLng, phone: d.pickupPhone },
      driver: d.driver
        ? {
            name: d.driver.name,
            phone: active ? d.driver.phone : null,
            vehicleType: d.driver.vehicleType,
            plate: d.driver.plate,
            position: active && d.driver.lastLat != null ? { lat: d.driver.lastLat, lng: d.driver.lastLng, at: d.driver.lastLocationAt } : null,
          }
        : null,
      stops: stops.map((s) => ({
        id: s.id,
        position: s.position,
        status: s.status,
        address: s.address,
        recipientName: s.recipientName,
        recipientPhone: s.recipientPhone,
        codAmount: s.codAmount,
        feeDue: s.feeDue,
        paymentRequired: s.paymentRequired,
        paymentConfirmedAt: s.paymentConfirmedAt,
        // Code à donner au destinataire (le livreur le demande à la remise)
        confirmationCode: s.confirmationCode,
        deliveredAt: s.deliveredAt,
        failedAt: s.failedAt,
        failureReason: s.failureReason,
        codRemittedAt: s.codRemittedAt,
      })),
      returnRequired: d.returnRequired,
      returnedAt: d.returnedAt,
      cancelledAt: d.cancelledAt,
      cancelReason: d.cancelReason,
      acceptedAt: d.acceptedAt,
      pickedUpAt: d.pickedUpAt,
      deliveredAt: d.deliveredAt,
      createdAt: d.createdAt,
    };
  }

  /** Relevé : montants encaissés à la livraison pour le partenaire, reversés ou non */
  async statement(partnerId: string, from?: string, to?: string) {
    const [r] = await this.db.query(
      `SELECT count(DISTINCT d.id)::int AS deliveries,
              coalesce(sum(s."codAmount") FILTER (WHERE s.status = 'DELIVERED'), 0)::int AS "codCollected",
              coalesce(sum(s."codAmount") FILTER (WHERE s.status = 'DELIVERED' AND s."codRemittedAt" IS NOT NULL), 0)::int AS "codRemitted",
              coalesce(sum(s."codAmount") FILTER (WHERE s.status = 'DELIVERED' AND s."codRemittedAt" IS NULL), 0)::int AS "codPending",
              count(*) FILTER (WHERE s.status = 'DELIVERED')::int AS "stopsDelivered",
              count(*) FILTER (WHERE s.status = 'FAILED')::int AS "stopsFailed"
         FROM deliveries d JOIN delivery_stops s ON s."deliveryId" = d.id
        WHERE d."partnerId" = $1 AND ($2::date IS NULL OR d."createdAt" >= $2::date) AND ($3::date IS NULL OR d."createdAt" < $3::date + 1)`,
      [partnerId, from ?? null, to ?? null],
    );
    return { from: from ?? null, to: to ?? null, ...r };
  }

  // ---------- Webhooks ----------

  /** Événements depuis le dernier état envoyé : statut de la course, statut de chaque arrêt, retour */
  private async onDeliveryChanged(id: string) {
    const d = await this.deliveries.findOne({ where: { id }, relations: { stops: true, driver: true } });
    if (!d?.partnerId) return;
    const before = d.partnerSnapshot ?? {};
    const now: Record<string, string> = { status: d.status, returned: d.returnedAt ? 'yes' : 'no' };
    for (const s of d.stops ?? []) {
      now[`stop:${s.id}`] = s.status;
      if (s.paymentConfirmedAt) now[`pay:${s.id}`] = 'yes';
    }
    const events: { event: string; stopId?: string }[] = [];
    if (before.status !== now.status) {
      const map: Record<string, string> = { PENDING: 'delivery.created', ACCEPTED: 'delivery.accepted', PICKED_UP: 'delivery.picked_up', DELIVERED: 'delivery.completed', CANCELLED: 'delivery.cancelled' };
      events.push({ event: map[d.status] ?? 'delivery.updated' });
    }
    for (const s of d.stops ?? []) {
      const k = `stop:${s.id}`;
      if (before[k] === now[k] || s.status === 'PENDING') continue;
      events.push({ event: `stop.${s.status.toLowerCase()}`, stopId: s.id });
    }
    for (const s of d.stops ?? []) if (now[`pay:${s.id}`] && !before[`pay:${s.id}`]) events.push({ event: 'stop.payment_confirmed', stopId: s.id });
    if (before.returned !== 'yes' && now.returned === 'yes') events.push({ event: 'delivery.returned' });
    if (!events.length) return;
    await this.deliveries.update(d.id, { partnerSnapshot: now });
    const p = await this.partners.findOneBy({ id: d.partnerId });
    if (!p?.webhookUrl) return;
    const data = this.view(d);
    for (const e of events) {
      await this.hooks.save({
        partnerId: p.id,
        deliveryId: d.id,
        event: e.event,
        payload: { id: `evt_${randomBytes(12).toString('hex')}`, event: e.event, createdAt: new Date().toISOString(), stopId: e.stopId ?? null, delivery: data },
        nextAttemptAt: new Date(),
      });
    }
    void this.flush();
  }

  /** Signature : en-tête X-Leto-Signature = t=<horodatage>,v1=<HMAC SHA-256 de « horodatage.corps »> */
  static sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
    return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  }

  private async send(h: PartnerWebhook, p: Partner) {
    const body = JSON.stringify(h.payload);
    let code: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(p.webhookUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'VITE-Webhooks/1.0', 'X-Leto-Event': h.event, 'X-Leto-Delivery': h.deliveryId ?? '', 'X-Leto-Signature': PartnersService.sign(p.webhookSecret, body) },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      code = res.status;
      if (!res.ok) error = `Réponse ${res.status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const attempts = h.attempts + 1;
    if (!error) {
      await this.hooks.update(h.id, { status: 'SENT', attempts, responseCode: code, lastError: null, sentAt: new Date() });
      return { ok: true, code };
    }
    const wait = BACKOFF_S.at(attempts - 1);
    await this.hooks.update(h.id, {
      status: wait == null ? 'FAILED' : 'PENDING',
      attempts,
      responseCode: code,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + (wait ?? 0) * 1000),
    });
    return { ok: false, code, error };
  }

  /** Envoie les webhooks dus (un seul envoi à la fois) */
  async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      const due = await this.hooks.find({ where: { status: 'PENDING', nextAttemptAt: LessThanOrEqual(new Date()) }, order: { createdAt: 'ASC' }, take: 25 });
      for (const h of due) {
        const p = await this.partners.findOneBy({ id: h.partnerId });
        if (!p?.webhookUrl || !p.active) {
          await this.hooks.update(h.id, { status: 'FAILED', lastError: !p?.active ? 'Partenaire désactivé' : 'Aucune adresse de webhook' });
          continue;
        }
        await this.send(h, p);
      }
    } finally {
      this.sending = false;
    }
  }

  /** SA : webhook de test (événement « ping »), envoyé tout de suite */
  async test(partnerId: string) {
    const p = await this.mine(partnerId);
    if (!p.webhookUrl) throw new BadRequestException('Renseignez d’abord l’adresse du webhook');
    const h = await this.hooks.save({ partnerId, deliveryId: null, event: 'ping', payload: { id: `evt_${randomBytes(12).toString('hex')}`, event: 'ping', createdAt: new Date().toISOString() }, nextAttemptAt: new Date(Date.now() + 3600_000) });
    const r = await this.send(h, p);
    // Un test raté n'est pas relancé
    if (!r.ok) await this.hooks.update(h.id, { status: 'FAILED' });
    return r;
  }

  /** SA : relancer un webhook en échec */
  async retry(partnerId: string, hookId: string) {
    const res = await this.hooks.update({ id: hookId, partnerId }, { status: 'PENDING', nextAttemptAt: new Date() });
    if (!res.affected) throw new NotFoundException('Envoi introuvable');
    await this.flush();
    return this.detail(partnerId);
  }
}
