import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { defaultGrid, DeliverySpeed, MAX_STOPS, PricingGrid, VehicleType } from '../pricing/pricing';
import { Setting } from './setting.entity';

const KEY = 'pricing';

/** Grille tarifaire et règles : valeurs par défaut du code, surchargées par le SA (gardées en mémoire) */
@Injectable()
export class SettingsService implements OnModuleInit {
  private grid: PricingGrid = defaultGrid();
  private meta: { updatedAt: Date | null; updatedBy: string | null } = { updatedAt: null, updatedBy: null };

  constructor(@InjectRepository(Setting) private repo: Repository<Setting>) {}

  async onModuleInit() {
    const row = await this.repo.findOneBy({ key: KEY });
    if (row) {
      this.grid = this.merge(row.value as Partial<PricingGrid>);
      this.meta = { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    }
  }

  get pricing(): PricingGrid {
    return this.grid;
  }

  get info() {
    return { ...this.grid, ...this.meta };
  }

  async updatePricing(input: Partial<PricingGrid>, by: string) {
    const next = this.merge(input, this.grid);
    this.validate(next);
    const row = await this.repo.save({ key: KEY, value: next, updatedBy: by });
    this.grid = next;
    this.meta = { updatedAt: row.updatedAt, updatedBy: by };
    return this.info;
  }

  async reset(by: string) {
    await this.repo.delete({ key: KEY });
    this.grid = defaultGrid();
    this.meta = { updatedAt: new Date(), updatedBy: by };
    return this.info;
  }

  /** Fusionne une saisie partielle sur une base (seules les clés connues sont gardées) */
  private merge(input: Partial<PricingGrid> = {}, base: PricingGrid = defaultGrid()): PricingGrid {
    const out = structuredClone(base);
    for (const v of Object.values(VehicleType)) {
      const src = input.vehicles?.[v];
      if (!src) continue;
      for (const k of ['label', 'description', 'base', 'perKm', 'min', 'enabled'] as const) {
        if (src[k] !== undefined) (out.vehicles[v] as any)[k] = src[k];
      }
    }
    for (const sp of Object.values(DeliverySpeed)) {
      const src = input.speeds?.[sp];
      if (!src) continue;
      for (const k of ['label', 'description', 'factor'] as const) {
        if (src[k] !== undefined) (out.speeds[sp] as any)[k] = src[k];
      }
    }
    for (const k of ['codFee', 'extraStopFee', 'maxStops', 'absenceWaitMin'] as const) {
      if (input[k] !== undefined) out[k] = input[k] as number;
    }
    return out;
  }

  private validate(g: PricingGrid) {
    const num = (v: unknown, name: string, min: number, max: number) => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        throw new BadRequestException(`${name} : valeur entre ${min} et ${max} attendue`);
      }
    };
    const text = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v.trim() || v.length > 80) throw new BadRequestException(`${name} : texte requis (80 caractères max)`);
    };
    for (const [k, v] of Object.entries(g.vehicles)) {
      text(v.label, `${k} · nom`);
      if (typeof v.description !== 'string' || v.description.length > 120) throw new BadRequestException(`${k} · description trop longue`);
      num(v.base, `${k} · prix de base`, 0, 1_000_000);
      num(v.perKm, `${k} · prix par km`, 0, 100_000);
      num(v.min, `${k} · minimum`, 0, 1_000_000);
      if (typeof v.enabled !== 'boolean') throw new BadRequestException(`${k} · activé : vrai ou faux`);
    }
    if (!Object.values(g.vehicles).some((v) => v.enabled)) throw new BadRequestException('Au moins une offre doit rester active');
    for (const [k, s] of Object.entries(g.speeds)) {
      text(s.label, `${k} · nom`);
      num(s.factor, `${k} · coefficient`, 0.3, 5);
    }
    num(g.codFee, 'Frais de paiement à la livraison', 0, 100_000);
    num(g.extraStopFee, 'Supplément par arrêt', 0, 100_000);
    num(g.maxStops, 'Arrêts maximum', 1, MAX_STOPS);
    num(g.absenceWaitMin, 'Attente avant absence (min)', 1, 60);
  }
}
