/**
 * Tournée d'un livreur qui a plusieurs courses : une seule liste ordonnée d'étapes
 * (récupérer les colis d'une course, livrer un arrêt, rapporter les colis non livrés).
 * Règle : on récupère avant de livrer, et on rapporte après le dernier arrêt de la course.
 */
import { distanceM, LatLng } from './dispatch';

export type TaskType = 'PICKUP' | 'STOP' | 'RETURN';

export interface PlanTask {
  /** P:<course>, S:<arrêt>, R:<course> */
  key: string;
  type: TaskType;
  deliveryId: string;
  stopId?: string;
  lat: number;
  lng: number;
}

/** Course en cours, telle que chargée pour la tournée */
export interface PlanCourse {
  id: string;
  status: string;
  pickupLat: number;
  pickupLng: number;
  returnRequired?: boolean;
  returnedAt?: Date | string | null;
  stops: { id: string; lat: number; lng: number; status: string; position: number }[];
}

/** Étapes restantes de toutes les courses (dans l'ordre naturel : départ puis arrêts) */
export function tasksOf(courses: PlanCourse[]): PlanTask[] {
  const out: PlanTask[] = [];
  for (const c of courses) {
    if (c.status === 'ACCEPTED') {
      out.push({ key: `P:${c.id}`, type: 'PICKUP', deliveryId: c.id, lat: c.pickupLat, lng: c.pickupLng });
    }
    const pending = c.stops.filter((s) => s.status === 'PENDING').sort((a, b) => a.position - b.position);
    for (const s of pending) out.push({ key: `S:${s.id}`, type: 'STOP', deliveryId: c.id, stopId: s.id, lat: s.lat, lng: s.lng });
    if (c.status === 'PICKED_UP' && !pending.length && c.returnRequired && !c.returnedAt) {
      out.push({ key: `R:${c.id}`, type: 'RETURN', deliveryId: c.id, lat: c.pickupLat, lng: c.pickupLng });
    }
  }
  return out;
}

/** Première règle non respectée par cet ordre (null si l'ordre est valable) */
export function planError(order: PlanTask[]): string | null {
  const seen = new Set<string>();
  for (const t of order) {
    if (t.type !== 'PICKUP' && order.some((o) => o.key === `P:${t.deliveryId}`) && !seen.has(`P:${t.deliveryId}`)) {
      return 'Récupérez les colis avant de les livrer';
    }
    if (t.type === 'RETURN' && order.some((o) => o.type === 'STOP' && o.deliveryId === t.deliveryId && !seen.has(o.key))) {
      return 'Le retour des colis vient après le dernier arrêt de la course';
    }
    seen.add(t.key);
  }
  return null;
}

/** Longueur (m) du trajet : position du livreur puis chaque étape */
export function pathLength(me: LatLng | null, order: PlanTask[]) {
  let total = 0;
  let prev: LatLng | null = me;
  for (const t of order) {
    if (prev) total += distanceM(prev, t);
    prev = t;
  }
  return total;
}

/** Insère une étape là où elle allonge le moins le trajet, sans casser les règles */
function insertCheapest(me: LatLng | null, order: PlanTask[], t: PlanTask): PlanTask[] {
  let best: PlanTask[] | null = null;
  let bestLen = Infinity;
  for (let i = 0; i <= order.length; i++) {
    const next = [...order.slice(0, i), t, ...order.slice(i)];
    if (planError(next)) continue;
    const len = pathLength(me, next);
    if (len < bestLen) {
      bestLen = len;
      best = next;
    }
  }
  return best ?? [...order, t];
}

/**
 * Tournée à suivre : l'ordre enregistré par le livreur (étapes terminées retirées),
 * les nouvelles étapes insérées au meilleur endroit. Sans ordre enregistré : ordre optimisé.
 */
export function mergePlan(me: LatLng | null, courses: PlanCourse[], saved: string[] | null): PlanTask[] {
  const tasks = tasksOf(courses);
  if (!saved?.length) return optimizePlan(me, courses);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  let order = saved.map((k) => byKey.get(k)).filter((t): t is PlanTask => !!t);
  if (planError(order)) return optimizePlan(me, courses);
  const kept = new Set(order.map((t) => t.key));
  // Nouvelles étapes : d'abord les départs (les arrêts d'une course viennent après son départ)
  const fresh = tasks.filter((t) => !kept.has(t.key)).sort((a, b) => (a.type === 'PICKUP' ? -1 : 0) - (b.type === 'PICKUP' ? -1 : 0));
  for (const t of fresh) order = insertCheapest(me, order, t);
  return order;
}

/** Ordre de passage le plus court (insertion au moindre détour, puis amélioration par déplacements) */
export function optimizePlan(me: LatLng | null, courses: PlanCourse[]): PlanTask[] {
  const tasks = tasksOf(courses);
  // Les étapes les plus éloignées d'abord : l'insertion construit une meilleure tournée
  const sorted = [...tasks].sort((a, b) => (me ? distanceM(me, b) - distanceM(me, a) : 0));
  let order: PlanTask[] = [];
  for (const t of sorted.filter((x) => x.type === 'PICKUP')) order = insertCheapest(me, order, t);
  for (const t of sorted.filter((x) => x.type !== 'PICKUP')) order = insertCheapest(me, order, t);
  // Amélioration : déplacer chaque étape à sa meilleure place tant que ça raccourcit
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const t of [...order]) {
      const rest = order.filter((x) => x.key !== t.key);
      const candidate = insertCheapest(me, rest, t);
      if (pathLength(me, candidate) + 1 < pathLength(me, order)) {
        order = candidate;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return order;
}
