import { ConflictException } from '@nestjs/common';

/**
 * Nouvelles commandes pour un livreur déjà en course : on ne lui propose que celles
 * dont le départ est sur son trajet restant ou près de lui.
 */

export type LatLng = { lat: number; lng: number };

/** Course en cours d'un livreur (départ, statut et arrêts, dans l'ordre) */
export interface ActiveCourse {
  id?: string;
  status: string;
  /** Délai payé par le client : EXPRESS, STANDARD ou SCHEDULED (« Dans 2 heures ») */
  speed?: string;
  pickupLat: number;
  pickupLng: number;
  returnRequired?: boolean;
  returnedAt?: Date | string | null;
  stops: { id?: string; lat: number; lng: number; status: string; position: number }[];
}

export interface DispatchRules {
  busyRadiusKm: number;
  routeCorridorM: number;
  maxActiveCourses: number;
  standardMaxActiveCourses: number;
  standardMaxDetourMin: number;
}

/**
 * Courses simultanées selon le délai payé :
 *  - Express : course exclusive (jamais avec une autre, dans un sens comme dans l'autre) ;
 *  - Standard : au plus `standardMaxActiveCourses`, seulement sur le trajet, sans retarder la livraison
 *    de plus de `standardMaxDetourMin` ;
 *  - Dans 2 heures : jusqu'à `maxActiveCourses`, sur le trajet ou près du livreur.
 */
export function speedLimit(courses: { speed?: string }[], newSpeed: string | undefined, rules: DispatchRules): { max: number; nearby: boolean; detourMin: number | null } {
  const speeds = [...courses.map((c) => c.speed ?? 'STANDARD'), newSpeed ?? 'STANDARD'];
  if (courses.length && speeds.includes('EXPRESS')) return { max: 0, nearby: false, detourMin: null };
  const standard = speeds.includes('STANDARD');
  return {
    max: standard ? Math.min(rules.maxActiveCourses, rules.standardMaxActiveCourses) : rules.maxActiveCourses,
    nearby: !standard,
    // Le retard compte pour les livraisons Standard déjà en cours
    detourMin: courses.some((c) => (c.speed ?? 'STANDARD') === 'STANDARD') ? rules.standardMaxDetourMin : null,
  };
}

/** Vitesse moyenne en ville (km/h), facteur route / vol d'oiseau, et temps passé au départ (min) */
const CITY_KMH = 20;
const ROAD_FACTOR = 1.35;
const PICKUP_STOP_MIN = 3;

/**
 * Retard (min) causé aux livraisons Standard en cours si le livreur passe d'abord récupérer ce colis :
 * meilleur détour pour insérer le départ avant la dernière livraison Standard (le nouveau colis est livré après).
 */
export function standardDelayMin(me: LatLng, courses: ActiveCourse[], pickup: LatLng): number {
  const path = remainingPath(me, courses);
  // Dernière étape d'une livraison Standard sur le trajet restant
  let last = 0;
  let i = 1;
  for (const c of courses) {
    const steps = (c.status === 'ACCEPTED' ? 1 : 0) + c.stops.filter((s) => s.status === 'PENDING').length + (c.status === 'PICKED_UP' && c.returnRequired && !c.returnedAt ? 1 : 0);
    i += steps;
    if ((c.speed ?? 'STANDARD') === 'STANDARD' && steps) last = i - 1;
  }
  if (last === 0) return 0;
  let best = Infinity;
  for (let k = 0; k < last; k++) {
    const extra = distanceM(path[k], pickup) + distanceM(pickup, path[k + 1]) - distanceM(path[k], path[k + 1]);
    best = Math.min(best, extra);
  }
  return Math.round(((best / 1000) * ROAD_FACTOR * 60) / CITY_KMH + PICKUP_STOP_MIN);
}

/** Pourquoi la commande est proposée à ce livreur occupé */
export type Match = { kind: 'ROUTE' | 'NEARBY'; km: number };

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance (m) d'un point au segment [a, b] (projection locale, précise à l'échelle d'une ville) */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng) {
  const k = Math.cos(rad(p.lat));
  const ax = (a.lng - p.lng) * k, ay = a.lat - p.lat;
  const bx = (b.lng - p.lng) * k, by = b.lat - p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx, y = ay + t * dy;
  return rad(Math.sqrt(x * x + y * y)) * R;
}

/** Trajet restant du livreur : sa position, puis chaque départ à faire et chaque arrêt à livrer */
export function remainingPath(me: LatLng, courses: ActiveCourse[]): LatLng[] {
  const path: LatLng[] = [me];
  for (const c of courses) {
    const pickup = { lat: c.pickupLat, lng: c.pickupLng };
    if (c.status === 'ACCEPTED') path.push(pickup);
    const pending = c.stops.filter((s) => s.status === 'PENDING').sort((a, b) => a.position - b.position);
    for (const s of pending) path.push({ lat: s.lat, lng: s.lng });
    // Colis non livrés : retour à l'expéditeur
    if (c.status === 'PICKED_UP' && c.returnRequired && !c.returnedAt) path.push(pickup);
  }
  return path;
}

/**
 * Une commande partant de `pickup` peut-elle être proposée à ce livreur déjà en course ?
 * Oui si le départ est à moins de `routeCorridorM` de son trajet restant, ou à moins de `busyRadiusKm` de lui.
 * `road` : tracé routier du trajet restant (sinon lignes droites entre les étapes).
 */
export function matchBusyDriver(
  me: LatLng,
  courses: ActiveCourse[],
  pickup: LatLng,
  rules: DispatchRules,
  road?: LatLng[] | null,
  newSpeed?: string,
): Match | null {
  const limit = speedLimit(courses, newSpeed, rules);
  if (courses.length >= limit.max) return null;
  if (limit.detourMin != null && standardDelayMin(me, courses, pickup) > limit.detourMin) return null;
  const km = Math.round(distanceM(me, pickup) / 100) / 10;
  const path = road && road.length >= 2 ? road : remainingPath(me, courses);
  if (rules.routeCorridorM > 0) {
    for (let i = 0; i + 1 < path.length; i++) {
      if (distanceToSegmentM(pickup, path[i], path[i + 1]) <= rules.routeCorridorM) return { kind: 'ROUTE', km };
    }
  }
  if (limit.nearby && km <= rules.busyRadiusKm) return { kind: 'NEARBY', km };
  return null;
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

/** Courses en cours (acceptées ou colis récupérés) de ces livreurs, dans l'ordre d'acceptation */
export async function activeCourses(db: Db, driverIds: string[]): Promise<Map<string, ActiveCourse[]>> {
  const out = new Map<string, ActiveCourse[]>();
  if (!driverIds.length) return out;
  const rows: any[] = await db.query(
    `SELECT d.id, d."driverId", d.status, d.speed, d."pickupLat", d."pickupLng", d."returnRequired", d."returnedAt",
            COALESCE(json_agg(json_build_object('id', s.id, 'lat', s.lat, 'lng', s.lng, 'status', s.status, 'position', s.position))
                     FILTER (WHERE s.id IS NOT NULL), '[]') AS stops
       FROM deliveries d
       LEFT JOIN delivery_stops s ON s."deliveryId" = d.id
      WHERE d."driverId" = ANY($1::uuid[]) AND d.status IN ('ACCEPTED', 'PICKED_UP')
      GROUP BY d.id
      ORDER BY d."acceptedAt" ASC NULLS LAST`,
    [driverIds],
  );
  for (const r of rows) {
    const list = out.get(r.driverId) ?? [];
    list.push({
      id: r.id,
      status: r.status,
      speed: r.speed,
      pickupLat: Number(r.pickupLat),
      pickupLng: Number(r.pickupLng),
      returnRequired: r.returnRequired,
      returnedAt: r.returnedAt,
      stops: (r.stops as any[]).map((s) => ({ id: s.id, lat: Number(s.lat), lng: Number(s.lng), status: s.status, position: s.position })),
    });
    out.set(r.driverId, list);
  }
  return out;
}

/**
 * Refuse une nouvelle course si le livreur ne peut pas la prendre en plus des siennes :
 * Express seule, Standard limitée, « Dans 2 heures » jusqu'au maximum général.
 */
export async function assertCanTakeMore(db: Db, driverId: string, rules: DispatchRules, newSpeed?: string) {
  const rows: { speed: string }[] = await db.query(
    `SELECT speed FROM deliveries WHERE "driverId" = $1 AND status IN ('ACCEPTED', 'PICKED_UP')`,
    [driverId],
  );
  const n = rows.length;
  if (!n) return;
  if (rows.some((r) => r.speed === 'EXPRESS')) {
    throw new ConflictException('Vous avez une livraison Express en cours : terminez-la avant d’accepter une autre course');
  }
  if (newSpeed === 'EXPRESS') {
    throw new ConflictException('Une livraison Express se fait seule : terminez vos courses en cours avant de l’accepter');
  }
  const { max } = speedLimit(rows, newSpeed, rules);
  if (n >= max) {
    throw new ConflictException(
      `Vous avez déjà ${n} course${n > 1 ? 's' : ''} en cours (maximum ${max}${max < rules.maxActiveCourses ? ' avec une livraison Standard' : ''}) : terminez-en une avant d’en accepter une autre`,
    );
  }
}
