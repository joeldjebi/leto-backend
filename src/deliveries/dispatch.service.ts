import { money } from '../countries/phone';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DOCS_VALID_SQL, IndependentsService } from '../independents/independents.service';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { GeoService } from '../geo/geo.service';
import { NotifyService } from '../notifications/notify.service';
import { PricingGrid } from '../pricing/pricing';
import { SettingsService } from '../settings/settings.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { ActiveCourse, activeCourses, distanceM, LatLng, Match, matchBusyDriver } from './dispatch';
import { Delivery, DeliveryStatus } from './delivery.entity';
import { AlertOutcome, OrderAlert } from './order-alert.entity';
import { mergePlan } from './route-plan';

/** Livreurs considérés en ligne (dernière position GPS) */
const ONLINE_MS = 10 * 60_000;

type Rules = Pick<
  PricingGrid,
  'dispatchRadiusKm' | 'busyRadiusKm' | 'routeCorridorM' | 'maxActiveCourses' | 'standardMaxActiveCourses' | 'standardMaxDetourMin' | 'orderPopupSec' | 'dispatchWaveSize' | 'dispatchWaveSec'
>;

interface Candidate {
  id: string;
  companyId: string | null;
  me: LatLng;
  km: number;
  courses: ActiveCourse[];
  match: Match | null;
}

/**
 * Répartition d'une nouvelle commande, par vagues : les livreurs les plus proches d'abord
 * (`dispatchWaveSize` livreurs), puis les suivants toutes les `dispatchWaveSec` secondes,
 * jusqu'à ce que la course soit prise. Une course n'apparaît dans la liste d'un livreur
 * qu'une fois qu'il a été prévenu (ou quand toutes les vagues sont passées).
 * Chaque alerte est enregistrée avec la réponse du livreur (statistiques de réactivité).
 */
@Injectable()
export class DispatchService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger('Répartition');
  /** Courses en cours de répartition : livreurs déjà prévenus, prochaine vague */
  private waves = new Map<string, { notified: Set<string>; wave: number; timer?: NodeJS.Timeout }>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private db: DataSource,
    @InjectRepository(Delivery) private deliveries: Repository<Delivery>,
    @InjectRepository(OrderAlert) private alerts: Repository<OrderAlert>,
    private settings: SettingsService,
    private geo: GeoService,
    private push: NotifyService,
    private tracking: TrackingGateway,
    private independents: IndependentsService,
  ) {}

  onModuleInit() {
    // Alertes restées sans réponse (app fermée, réseau coupé) : comptées « sans réponse »
    this.sweeper = setInterval(() => this.expireAlerts().catch(() => {}), 30_000);
  }

  onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const w of this.waves.values()) if (w.timer) clearTimeout(w.timer);
  }

  // ---------- Vagues ----------

  /** Nouvelle commande (ou commande ouverte à tous) : première vague tout de suite */
  async start(deliveryId: string, rules: Rules = this.settings.pricing) {
    this.stop(deliveryId);
    this.waves.set(deliveryId, { notified: new Set(), wave: 0 });
    await this.nextWave(deliveryId, rules).catch((e) => this.logger.warn(`Vague : ${(e as Error).message}`));
  }

  /** La course n'est plus à répartir (acceptée, affectée, annulée) */
  stop(deliveryId: string) {
    const w = this.waves.get(deliveryId);
    if (w?.timer) clearTimeout(w.timer);
    this.waves.delete(deliveryId);
  }

  /** Le livreur voit-il cette course dans sa liste ? (pas encore prévenu pendant les vagues : non) */
  canSee(deliveryId: string, driverId: string) {
    const w = this.waves.get(deliveryId);
    return !w || w.notified.has(driverId);
  }

  private async nextWave(deliveryId: string, rules: Rules) {
    const w = this.waves.get(deliveryId);
    if (!w) return;
    const d = await this.deliveries.findOne({ where: { id: deliveryId }, relations: { stops: true } });
    if (!d || d.status !== DeliveryStatus.PENDING || d.assignedDriverId) return this.stop(deliveryId);
    const batch = (await this.candidates(d, rules)).filter((c) => !w.notified.has(c.id)).slice(0, Math.max(1, rules.dispatchWaveSize));
    if (!batch.length) {
      // Plus personne à prévenir : la course est visible par tous les livreurs concernés
      this.stop(deliveryId);
      return;
    }
    w.wave += 1;
    const stops = [...(d.stops ?? [])].sort((a, b) => a.position - b.position);
    const last = stops[stops.length - 1];
    const order = {
      price: d.price,
      currency: d.currency ?? null,
      pickupCommune: d.pickupCommune ?? null,
      pickupAddress: d.pickupAddress ?? null,
      dropCommune: last?.commune ?? null,
      dropAddress: last?.address ?? null,
      stops: stops.length,
      distanceKm: d.distanceKm ?? null,
      durationMin: d.durationMin ?? null,
      vehicleType: d.vehicleType ?? null,
      speed: d.speed ?? null,
      cod: stops.reduce((t, s) => t + (s.codAmount ?? 0), 0),
    };
    const expiresAt = new Date(Date.now() + rules.orderPopupSec * 1000).toISOString();
    await this.alerts
      .createQueryBuilder()
      .insert()
      .values(batch.map((c) => ({ deliveryId, driverId: c.id, companyId: c.companyId, wave: w.wave, kind: c.match?.kind ?? 'FREE', km: c.km })))
      .orIgnore()
      .execute();
    for (const c of batch) {
      w.notified.add(c.id);
      this.push.send([c.id], 'NEW_ORDER', {
        title: `${c.match?.kind === 'ROUTE' ? 'Sur votre trajet · ' : ''}Nouvelle course · ${money(d.price)}`,
        body: `Départ ${d.pickupCommune ?? 'à proximité'} (à ${c.km} km)${stops.length > 1 ? ` · ${stops.length} arrêts` : ''}`,
        deliveryId,
        order: { ...order, fromMeKm: c.km },
        match: c.match,
        busy: c.courses.length,
        wave: w.wave,
        expiresAt,
      });
    }
    // Les livreurs prévenus voient maintenant la course dans leur liste
    for (const c of batch) this.tracking.emitToUser(c.id, 'deliveries:changed', {});
    w.timer = setTimeout(() => this.nextWave(deliveryId, this.settings.pricing).catch(() => {}), rules.dispatchWaveSec * 1000);
  }

  /** Livreurs pouvant prendre la course, du plus proche au plus loin */
  private async candidates(d: Delivery, rules: Rules): Promise<Candidate[]> {
    const rows: { id: string; companyId: string; lastLat: number; lastLng: number; routePlan: string[] | null }[] = await this.db.query(
      `SELECT u.id, u."companyId", u."lastLat", u."lastLng", u."routePlan" FROM users u
         JOIN companies c ON c.id = u."companyId"
         LEFT JOIN independent_profiles p ON p."companyId" = c.id
        WHERE u.role = 'DRIVER' AND u.active AND c.active
          AND u."lastLocationAt" > $1 AND u."lastLat" IS NOT NULL
          AND (
            -- Livreurs des entreprises (de l'entreprise visée, s'il y en a une)
            (NOT c.independent AND NOT $3 AND ($2::uuid IS NULL OR u."companyId" = $2))
            -- Livreurs indépendants validés : rattachés à l'entreprise visée, ou course ouverte (rattachés ou en transition) ; paiement à la livraison si leur entreprise l'autorise
            OR ($7 AND c.independent AND p.status = 'APPROVED' AND ${DOCS_VALID_SQL('p')}
                AND (NOT EXISTS (SELECT 1 FROM delivery_stops cs WHERE cs."deliveryId" = $8 AND cs."codAmount" > 0)
                     OR EXISTS (SELECT 1 FROM companies ac WHERE ac.id = p."affiliatedCompanyId" AND ac."liCodAllowed"))
                AND (p."affiliatedCompanyId" = $2
                     OR ($2::uuid IS NULL AND (p."affiliatedCompanyId" IS NOT NULL OR p."legacyUntil" > now()))))
          )
          AND 6371 * 2 * asin(sqrt(power(sin(radians(u."lastLat" - $4) / 2), 2)
              + cos(radians($4)) * cos(radians(u."lastLat")) * power(sin(radians(u."lastLng" - $5) / 2), 2))) <= $6
        LIMIT 300`,
      [new Date(Date.now() - ONLINE_MS), d.targetCompanyId, d.forIndependents, d.pickupLat, d.pickupLng, rules.dispatchRadiusKm, this.independents.config.enabled, d.id],
    );
    const busy = await activeCourses(this.db, rows.map((r) => r.id));
    const pickup = { lat: d.pickupLat, lng: d.pickupLng };
    const out: Candidate[] = [];
    for (const r of rows) {
      const me = { lat: Number(r.lastLat), lng: Number(r.lastLng) };
      const courses = busy.get(r.id) ?? [];
      let match: Match | null = null;
      if (courses.length) {
        match = matchBusyDriver(me, courses, pickup, rules, await this.roadPath(me, courses, r.routePlan), d.speed);
        if (!match) continue;
      }
      out.push({ id: r.id, companyId: r.companyId, me, km: Math.round(distanceM(me, pickup) / 100) / 10, courses, match });
    }
    // Plus proche d'abord ; à distance égale, le livreur pour qui la course est sur son trajet
    return out.sort((a, b) => a.km - b.km || (a.match?.kind === 'ROUTE' ? -1 : 0) - (b.match?.kind === 'ROUTE' ? -1 : 0));
  }

  /**
   * Tracé routier du trajet restant d'un livreur (dans l'ordre de sa tournée), null sans itinéraire routier.
   * Position arrondie (≈ 100 m) pour réutiliser l'itinéraire en cache tant qu'il bouge peu.
   */
  async roadPath(me: LatLng, courses: ActiveCourse[], saved: string[] | null): Promise<LatLng[] | null> {
    const plan = mergePlan(me, courses as any, saved);
    if (!plan.length) return null;
    const start = { lat: Math.round(me.lat * 1000) / 1000, lng: Math.round(me.lng * 1000) / 1000 };
    const route = await this.geo.routeVia([start, ...plan.map((t) => ({ lat: t.lat, lng: t.lng }))]).catch(() => null);
    if (!route || route.source === 'estimate' || route.points.length < 2) return null;
    return route.points.map(([lat, lng]) => ({ lat, lng }));
  }

  /** Correspondance (trajet / proximité) pour la liste d'un livreur occupé */
  async matchFor(driverId: string, me: LatLng, courses: ActiveCourse[], pickup: LatLng, speed?: string) {
    const [row] = await this.db.query(`SELECT "routePlan" FROM users WHERE id = $1`, [driverId]);
    return matchBusyDriver(me, courses, pickup, this.settings.pricing, await this.roadPath(me, courses, row?.routePlan ?? null), speed);
  }

  // ---------- Réponses des livreurs ----------

  private async answer(deliveryId: string, driverId: string, outcome: AlertOutcome) {
    await this.db.query(
      `UPDATE order_alerts SET outcome = $3, "respondedAt" = now(),
              "reactionMs" = LEAST(EXTRACT(EPOCH FROM (now() - "sentAt")) * 1000, 2147483647)::int
        WHERE "deliveryId" = $1 AND "driverId" = $2 AND outcome IN ('PENDING', 'EXPIRED')`,
      [deliveryId, driverId, outcome],
    );
  }

  /** L'app du livreur signale un refus ou une alerte expirée */
  respond(driverId: string, deliveryId: string, action: 'DECLINED' | 'EXPIRED') {
    return this.answer(deliveryId, driverId, action).then(() => ({ ok: true }));
  }

  /** Course acceptée par un livreur : fin des vagues, les autres alertes « prise par un autre » */
  async accepted(deliveryId: string, driverId: string) {
    this.stop(deliveryId);
    await this.answer(deliveryId, driverId, 'ACCEPTED');
    await this.alerts.update({ deliveryId, outcome: In(['PENDING']) }, { outcome: 'TAKEN' });
  }

  proposed(deliveryId: string, driverId: string) {
    return this.answer(deliveryId, driverId, 'PROPOSED');
  }

  /** Course affectée ou annulée : plus de vagues, alertes en attente closes */
  async closed(deliveryId: string) {
    this.stop(deliveryId);
    await this.alerts.update({ deliveryId, outcome: 'PENDING' }, { outcome: 'TAKEN' });
  }

  private async expireAlerts() {
    const limit = new Date(Date.now() - (this.settings.pricing.orderPopupSec + 30) * 1000);
    await this.alerts.update({ outcome: 'PENDING', sentAt: LessThan(limit) }, { outcome: 'EXPIRED' });
  }

  // ---------- Statistiques ----------

  /** Réactivité des livreurs sur une période (tous pour le SA, ceux de l'entreprise pour un gérant) */
  async stats(companyId: string | null, days: number) {
    const rows: any[] = await this.db.query(
      `WITH a AS (
         SELECT * FROM order_alerts WHERE "sentAt" > now() - make_interval(days => $1) AND ($2::uuid IS NULL OR "companyId" = $2)
       ), done AS (
         SELECT "driverId", COUNT(*)::int AS n FROM deliveries
          WHERE status = 'DELIVERED' AND "deliveredAt" > now() - make_interval(days => $1) AND ($2::uuid IS NULL OR "companyId" = $2)
          GROUP BY "driverId"
       )
       SELECT u.id, u.name, u."avatarUrl", u."vehicleType", c.name AS company,
              COUNT(a.id)::int AS alerts,
              COUNT(a.id) FILTER (WHERE a.outcome = 'ACCEPTED')::int AS accepted,
              COUNT(a.id) FILTER (WHERE a.outcome = 'PROPOSED')::int AS proposed,
              COUNT(a.id) FILTER (WHERE a.outcome = 'DECLINED')::int AS declined,
              COUNT(a.id) FILTER (WHERE a.outcome = 'EXPIRED')::int AS expired,
              COUNT(a.id) FILTER (WHERE a.outcome = 'TAKEN')::int AS taken,
              COUNT(a.id) FILTER (WHERE a.kind <> 'FREE')::int AS "duringCourse",
              (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a."reactionMs")
                 FILTER (WHERE a.outcome IN ('ACCEPTED', 'PROPOSED', 'DECLINED')))::int AS "reactionMs",
              COALESCE(MAX(done.n), 0)::int AS delivered
         FROM users u
         LEFT JOIN companies c ON c.id = u."companyId"
         LEFT JOIN a ON a."driverId" = u.id
         LEFT JOIN done ON done."driverId" = u.id
        WHERE u.role = 'DRIVER' AND ($2::uuid IS NULL OR u."companyId" = $2)
        GROUP BY u.id, c.name
       HAVING COUNT(a.id) > 0 OR COALESCE(MAX(done.n), 0) > 0
        ORDER BY COUNT(a.id) FILTER (WHERE a.outcome = 'ACCEPTED') DESC, COUNT(a.id) DESC`,
      [days, companyId],
    );
    const totals = rows.reduce(
      (t, r) => ({
        alerts: t.alerts + r.alerts,
        accepted: t.accepted + r.accepted,
        declined: t.declined + r.declined,
        expired: t.expired + r.expired,
      }),
      { alerts: 0, accepted: 0, declined: 0, expired: 0 },
    );
    return { days, totals, drivers: rows };
  }
}
