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

  /** Grille d'une entreprise : ses prix (engins, délais, supplément arrêt, frais d'encaissement) sur les règles LETO */
  gridFor(company?: { pricing?: Record<string, unknown> | null } | null): PricingGrid {
    if (!company?.pricing) return this.grid;
    return this.merge(this.priceOnly(company.pricing as Partial<PricingGrid>), this.grid);
  }

  /** Valide et nettoie une grille d'entreprise (seuls les prix sont gardés) */
  companyGrid(input: Partial<PricingGrid>) {
    const clean = this.priceOnly(input);
    const merged = this.merge(clean, this.grid);
    this.validate(merged);
    return {
      vehicles: Object.fromEntries(
        Object.entries(merged.vehicles).map(([k, v]) => [k, { base: v.base, perKm: v.perKm, min: v.min, enabled: v.enabled }]),
      ),
      speeds: Object.fromEntries(Object.entries(merged.speeds).map(([k, v]) => [k, { factor: v.factor }])),
      extraStopFee: merged.extraStopFee,
      codFee: merged.codFee,
    };
  }

  private priceOnly(input: Partial<PricingGrid>): Partial<PricingGrid> {
    const out: Partial<PricingGrid> = {};
    if (input.vehicles) {
      out.vehicles = Object.fromEntries(
        Object.entries(input.vehicles).map(([k, v]) => [k, { base: v?.base, perKm: v?.perKm, min: v?.min, enabled: v?.enabled }]),
      ) as PricingGrid['vehicles'];
    }
    if (input.speeds) {
      out.speeds = Object.fromEntries(Object.entries(input.speeds).map(([k, v]) => [k, { factor: v?.factor }])) as PricingGrid['speeds'];
    }
    if (input.extraStopFee !== undefined) out.extraStopFee = input.extraStopFee;
    if (input.codFee !== undefined) out.codFee = input.codFee;
    return out;
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
    if (typeof input.codEnabled === 'boolean') out.codEnabled = input.codEnabled;
    if (typeof input.cancelFeeEnabled === 'boolean') out.cancelFeeEnabled = input.cancelFeeEnabled;
    if (typeof input.returnCodeEnabled === 'boolean') out.returnCodeEnabled = input.returnCodeEnabled;
    if (input.cancelFeeType === 'PERCENT' || input.cancelFeeType === 'FIXED') out.cancelFeeType = input.cancelFeeType;
    for (const k of ['codFee', 'extraStopFee', 'maxStops', 'absenceWaitMin', 'cancelFeeValue', 'cancelFreeMinutes', 'cancelRequestAutoMin'] as const) {
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
    if (g.cancelFeeType === 'PERCENT') num(g.cancelFeeValue, 'Frais de déplacement (%)', 0, 100);
    else num(g.cancelFeeValue, 'Frais de déplacement (F)', 0, 100_000);
    num(g.cancelFreeMinutes, 'Annulation gratuite (min)', 0, 60);
    num(g.cancelRequestAutoMin, 'Délai de confirmation d’une annulation (min)', 1, 120);
  }
}
