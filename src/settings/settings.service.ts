import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { defaultGrid, DeliverySpeed, MAX_STOPS, PRICING_REV, PricingGrid, SPEED_TEXT, VehicleType } from '../pricing/pricing';
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
      const stored = row.value as Partial<PricingGrid>;
      this.grid = this.merge(stored);
      this.meta = { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
      // Règles v2 (une seule fois) : prix au km réduits et plafonds moto dans le Grand Abidjan
      // Règles v3 : réduction tournée et majorations (valeurs par défaut via merge)
      if ((stored.rev ?? 1) < PRICING_REV) {
        if ((stored.rev ?? 1) < 2) {
          const d = defaultGrid();
          for (const v of Object.values(VehicleType)) {
            this.grid.vehicles[v].perKm = Math.min(this.grid.vehicles[v].perKm, d.vehicles[v].perKm);
            this.grid.vehicles[v].maxAbidjan = d.vehicles[v].maxAbidjan;
          }
        }
        // v4 : textes des délais mis à jour s'ils n'avaient pas été personnalisés
        if (this.grid.speeds.EXPRESS.description === SPEED_TEXT.OLD_EXPRESS) this.grid.speeds.EXPRESS.description = SPEED_TEXT.EXPRESS;
        if (this.grid.speeds.STANDARD.description === SPEED_TEXT.OLD_STANDARD) this.grid.speeds.STANDARD.description = SPEED_TEXT.STANDARD;
        this.grid.rev = PRICING_REV;
        const saved = await this.repo.save({ key: KEY, value: this.grid, updatedBy: `Mise à jour des règles (v${PRICING_REV})` });
        this.meta = { updatedAt: saved.updatedAt, updatedBy: saved.updatedBy };
      }
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

  /**
   * Grille d'une entreprise : ses prix (engins, délais, plafonds, supplément arrêt, frais d'encaissement) sur les règles LETO.
   * Un engin n'est proposé que s'il est activé par LETO ET que l'entreprise en dispose.
   */
  gridFor(company?: { pricing?: Record<string, unknown> | null; vehicles?: string[] | null } | null): PricingGrid {
    if (!company) return this.grid;
    const g = company.pricing ? this.merge(this.priceOnly(company.pricing as Partial<PricingGrid>), this.grid) : structuredClone(this.grid);
    for (const v of Object.values(VehicleType)) {
      // Anciennes grilles : « non proposé » enregistré dans les prix
      const legacyOff = (company.pricing as { vehicles?: Record<string, { enabled?: boolean }> } | null)?.vehicles?.[v]?.enabled === false;
      const has = company.vehicles ? company.vehicles.includes(v) : !legacyOff;
      g.vehicles[v].enabled = this.grid.vehicles[v].enabled && has;
    }
    return g;
  }

  /** Valide et nettoie une grille d'entreprise (seuls les prix sont gardés) */
  companyGrid(input: Partial<PricingGrid>) {
    const clean = this.priceOnly(input);
    const merged = this.merge(clean, this.grid);
    this.validate(merged);
    return {
      vehicles: Object.fromEntries(
        Object.entries(merged.vehicles).map(([k, v]) => [k, { base: v.base, perKm: v.perKm, min: v.min, maxAbidjan: v.maxAbidjan }]),
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
        Object.entries(input.vehicles).map(([k, v]) => [k, { base: v?.base, perKm: v?.perKm, min: v?.min, maxAbidjan: v?.maxAbidjan }]),
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
      if (src.maxAbidjan && typeof src.maxAbidjan === 'object') {
        for (const sp of Object.values(DeliverySpeed)) {
          const cap = (src.maxAbidjan as Record<string, unknown>)[sp];
          if (cap !== undefined) out.vehicles[v].maxAbidjan[sp] = cap === null ? 0 : (cap as number);
        }
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
    if (typeof input.deliveryCodeEnabled === 'boolean') out.deliveryCodeEnabled = input.deliveryCodeEnabled;
    if (input.cancelFeeType === 'PERCENT' || input.cancelFeeType === 'FIXED') out.cancelFeeType = input.cancelFeeType;
    if (typeof input.rev === 'number') out.rev = input.rev;
    for (const k of ['multiStopDiscountPct', 'multiStopDiscountMaxPct'] as const) {
      if (input[k] !== undefined) out[k] = input[k] as number;
    }
    const sc = input.surcharges as Partial<PricingGrid['surcharges']> | undefined;
    if (sc && typeof sc === 'object') {
      for (const k of ['rushEnabled', 'nightEnabled', 'aboveCap'] as const) if (typeof sc[k] === 'boolean') out.surcharges[k] = sc[k];
      for (const k of ['rushPct', 'nightPct', 'rainPct', 'rainThresholdMm', 'floodPct'] as const) if (sc[k] !== undefined) out.surcharges[k] = sc[k] as number;
      if (sc.rainMode === 'AUTO' || sc.rainMode === 'ON' || sc.rainMode === 'OFF') out.surcharges.rainMode = sc.rainMode;
      if (typeof sc.nightRange === 'string') out.surcharges.nightRange = sc.nightRange.trim();
      if (Array.isArray(sc.rushRanges)) out.surcharges.rushRanges = sc.rushRanges.map((x) => String(x).trim()).filter(Boolean);
      if (Array.isArray(sc.floodCommunes)) out.surcharges.floodCommunes = sc.floodCommunes.map((x) => String(x).trim()).filter(Boolean);
    }
    for (const k of ['codFee', 'extraStopFee', 'maxStops', 'absenceWaitMin', 'cancelFeeValue', 'cancelFreeMinutes', 'cancelRequestAutoMin', 'orderExpiryMin', 'dispatchRadiusKm', 'busyRadiusKm', 'routeCorridorM', 'maxActiveCourses', 'standardMaxActiveCourses', 'standardMaxDetourMin', 'orderPopupSec', 'dispatchWaveSize', 'dispatchWaveSec'] as const) {
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
      for (const [sp, cap] of Object.entries(v.maxAbidjan)) {
        num(cap, `${k} · prix maximum ${g.speeds[sp as DeliverySpeed]?.label ?? sp} (0 = aucun)`, 0, 1_000_000);
      }
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
    num(g.orderExpiryMin, 'Expiration des commandes sans livreur (min, 0 = jamais)', 0, 1440);
    num(g.dispatchRadiusKm, 'Rayon des nouvelles commandes (km)', 1, 50);
    num(g.busyRadiusKm, 'Livreur en course : rayon autour de lui (km)', 0, 20);
    num(g.routeCorridorM, 'Livreur en course : distance au trajet (m)', 0, 5000);
    num(g.maxActiveCourses, 'Courses en même temps par livreur', 1, 10);
    if (!Number.isInteger(g.maxActiveCourses)) throw new BadRequestException('Courses en même temps : nombre entier attendu');
    num(g.standardMaxActiveCourses, 'Standard : courses en même temps', 1, 10);
    if (!Number.isInteger(g.standardMaxActiveCourses)) throw new BadRequestException('Standard : courses en même temps, nombre entier attendu');
    num(g.standardMaxDetourMin, 'Standard : retard maximum (min)', 0, 60);
    num(g.orderPopupSec, 'Durée de l’alerte nouvelle commande (s)', 10, 120);
    num(g.dispatchWaveSize, 'Livreurs prévenus par vague', 1, 50);
    num(g.dispatchWaveSec, 'Délai entre deux vagues (s)', 5, 120);
    num(g.multiStopDiscountPct, 'Réduction par arrêt supplémentaire (%)', 0, 50);
    num(g.multiStopDiscountMaxPct, 'Réduction tournée maximum (%)', 0, 80);
    const sc = g.surcharges;
    const range = (v: string, name: string) => {
      if (!/^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new BadRequestException(`${name} : plage « HH:MM-HH:MM » attendue`);
    };
    num(sc.rushPct, 'Majoration heure de pointe (%)', 0, 100);
    num(sc.nightPct, 'Majoration de nuit (%)', 0, 100);
    num(sc.rainPct, 'Majoration pluie (%)', 0, 100);
    num(sc.floodPct, 'Majoration zone inondable (%)', 0, 100);
    num(sc.rainThresholdMm, 'Seuil de pluie (mm)', 0.1, 50);
    if (sc.rushRanges.length > 4) throw new BadRequestException('4 plages d’heures de pointe au plus');
    sc.rushRanges.forEach((r) => range(r, 'Heure de pointe'));
    range(sc.nightRange, 'Nuit');
    if (sc.floodCommunes.length > 20) throw new BadRequestException('20 communes inondables au plus');
  }
}
