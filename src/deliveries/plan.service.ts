import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { User } from '../users/user.entity';
import { activeCourses } from './dispatch';
import { DeliveryStatus } from './delivery.entity';
import { DeliveryStop } from './delivery-stop.entity';
import { mergePlan, optimizePlan, pathLength, PlanCourse, PlanTask, planError, tasksOf } from './route-plan';

/**
 * Tournée du livreur : toutes ses courses en cours dans un seul ordre de passage.
 * L'ordre est optimisé à l'arrivée de chaque course, et le livreur peut le changer
 * (destinataire indisponible : il livre ailleurs et revient plus tard).
 * L'ordre des arrêts de chaque course suit la tournée (vu aussi par l'expéditeur et l'entreprise).
 */
@Injectable()
export class PlanService {
  constructor(
    private db: DataSource,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(DeliveryStop) private stops: Repository<DeliveryStop>,
    private tracking: TrackingGateway,
  ) {}

  private async load(driverId: string) {
    const [u] = await this.db.query(`SELECT "lastLat", "lastLng", "routePlan" FROM users WHERE id = $1`, [driverId]);
    const me = u?.lastLat != null ? { lat: Number(u.lastLat), lng: Number(u.lastLng) } : null;
    const courses = ((await activeCourses(this.db, [driverId])).get(driverId) ?? []) as PlanCourse[];
    return { me, courses, saved: (u?.routePlan ?? null) as string[] | null };
  }

  private view(order: PlanTask[], me: { lat: number; lng: number } | null, optimized: PlanTask[]) {
    return {
      keys: order.map((t) => t.key),
      tasks: order.map(({ key, type, deliveryId, stopId }) => ({ key, type, deliveryId, stopId: stopId ?? null })),
      /** Distance restante (km, à vol d'oiseau) de cet ordre et de l'ordre optimisé */
      km: Math.round(pathLength(me, order) / 100) / 10,
      optimizedKm: Math.round(pathLength(me, optimized) / 100) / 10,
    };
  }

  /** Tournée actuelle (les nouvelles courses insérées au meilleur endroit) */
  async get(driverId: string) {
    const { me, courses, saved } = await this.load(driverId);
    const order = mergePlan(me, courses, saved);
    await this.persist(driverId, courses, order, saved);
    return this.view(order, me, optimizePlan(me, courses));
  }

  /** Le livreur range ses étapes comme il veut (dans le respect des règles) */
  async save(driverId: string, keys: string[]) {
    const { me, courses, saved } = await this.load(driverId);
    const tasks = tasksOf(courses);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    if (keys.length !== tasks.length || new Set(keys).size !== keys.length || keys.some((k) => !byKey.has(k))) {
      throw new BadRequestException('La tournée a changé entre-temps : rechargez-la');
    }
    const order = keys.map((k) => byKey.get(k)!);
    const err = planError(order);
    if (err) throw new BadRequestException(err);
    await this.persist(driverId, courses, order, saved);
    return this.view(order, me, optimizePlan(me, courses));
  }

  /** Ordre le plus court, recalculé depuis la position du livreur */
  async optimize(driverId: string) {
    const { me, courses, saved } = await this.load(driverId);
    const order = optimizePlan(me, courses);
    await this.persist(driverId, courses, order, saved);
    return this.view(order, me, order);
  }

  /** L'entreprise a changé l'ordre des arrêts d'une course : la tournée suit ce nouvel ordre */
  async applyCompanyOrder(driverId: string, deliveryId: string, stopIds: string[]) {
    const [u] = await this.db.query(`SELECT "routePlan" FROM users WHERE id = $1`, [driverId]);
    const plan: string[] | null = u?.routePlan ?? null;
    if (!plan?.length) return;
    const wanted = stopIds.map((id) => `S:${id}`).filter((k) => plan.includes(k));
    let i = 0;
    const next = plan.map((k) => (wanted.includes(k) ? wanted[i++] : k));
    await this.users.update(driverId, { routePlan: next });
    this.tracking.emitToUser(driverId, 'plan:changed', {});
  }

  /** Enregistre l'ordre et renumérote les arrêts des courses dont l'ordre a changé */
  private async persist(driverId: string, courses: PlanCourse[], order: PlanTask[], saved: string[] | null) {
    const keys = order.map((t) => t.key);
    if (JSON.stringify(keys) !== JSON.stringify(saved ?? [])) await this.users.update(driverId, { routePlan: keys });
    for (const c of courses) {
      if (c.status !== DeliveryStatus.ACCEPTED && c.status !== DeliveryStatus.PICKED_UP) continue;
      const done = c.stops.filter((s) => s.status !== 'PENDING').sort((a, b) => a.position - b.position);
      const pending = order.filter((t) => t.type === 'STOP' && t.deliveryId === c.id).map((t) => c.stops.find((s) => s.id === t.stopId)!);
      const next = [...done, ...pending];
      const changed = next.some((s, position) => s.position !== position);
      if (!changed) continue;
      await this.db.transaction(async (m) => {
        for (const [position, s] of next.entries()) await m.update(DeliveryStop, s.id, { position });
      });
      this.tracking.deliveryChanged({ id: c.id, status: c.status as DeliveryStatus });
    }
  }
}
