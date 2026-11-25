import { ConflictException } from '@nestjs/common';

/**
 * Nouvelles commandes pour un livreur déjà en course : on ne lui propose que celles
 * dont le départ est sur son trajet restant ou près de lui.
 */

export type LatLng = { lat: number; lng: number };

/** Course en cours d'un livreur (départ, statut et arrêts encore à livrer, dans l'ordre) */
export interface ActiveCourse {
  status: string;
  pickupLat: number;
  pickupLng: number;
  returnRequired?: boolean;
  returnedAt?: Date | string | null;
  stops: { lat: number; lng: number; status: string; position: number }[];
}

export interface DispatchRules {
  busyRadiusKm: number;
  routeCorridorM: number;
  maxActiveCourses: number;
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
 */
export function matchBusyDriver(me: LatLng, courses: ActiveCourse[], pickup: LatLng, rules: DispatchRules): Match | null {
  if (courses.length >= rules.maxActiveCourses) return null;
  const km = Math.round(distanceM(me, pickup) / 100) / 10;
  const path = remainingPath(me, courses);
  if (rules.routeCorridorM > 0) {
    for (let i = 0; i + 1 < path.length; i++) {
      if (distanceToSegmentM(pickup, path[i], path[i + 1]) <= rules.routeCorridorM) return { kind: 'ROUTE', km };
    }
  }
  if (km <= rules.busyRadiusKm) return { kind: 'NEARBY', km };
  return null;
}

type Db = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

/** Courses en cours (acceptées ou colis récupérés) de ces livreurs, dans l'ordre d'acceptation */
export async function activeCourses(db: Db, driverIds: string[]): Promise<Map<string, ActiveCourse[]>> {
  const out = new Map<string, ActiveCourse[]>();
  if (!driverIds.length) return out;
  const rows: any[] = await db.query(
    `SELECT d.id, d."driverId", d.status, d."pickupLat", d."pickupLng", d."returnRequired", d."returnedAt",
            COALESCE(json_agg(json_build_object('lat', s.lat, 'lng', s.lng, 'status', s.status, 'position', s.position))
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
      status: r.status,
      pickupLat: Number(r.pickupLat),
      pickupLng: Number(r.pickupLng),
      returnRequired: r.returnRequired,
      returnedAt: r.returnedAt,
      stops: (r.stops as any[]).map((s) => ({ lat: Number(s.lat), lng: Number(s.lng), status: s.status, position: s.position })),
    });
    out.set(r.driverId, list);
  }
  return out;
}

/** Refuse une nouvelle course si le livreur a déjà le nombre maximum de courses en cours */
export async function assertCanTakeMore(db: Db, driverId: string, max: number) {
  const [{ n }] = await db.query(
    `SELECT COUNT(*)::int AS n FROM deliveries WHERE "driverId" = $1 AND status IN ('ACCEPTED', 'PICKED_UP')`,
    [driverId],
  );
  if (n >= max) {
    throw new ConflictException(
      `Vous avez déjà ${n} course${n > 1 ? 's' : ''} en cours (maximum ${max}) : terminez-en une avant d’en accepter une autre`,
    );
  }
}
