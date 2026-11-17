import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { nearestCommune } from '../geo/communes';
import { SettingsService } from '../settings/settings.service';
import { PricingGrid, TimeRange } from './pricing';

export interface SurchargeItem {
  key: 'RUSH' | 'NIGHT' | 'RAIN' | 'FLOOD';
  label: string;
  pct: number;
}

export interface WeatherStatus {
  /** Pluie sur la dernière heure (mm), null si inconnue */
  mm: number | null;
  raining: boolean;
  checkedAt: string | null;
  error: string | null;
}

/** Abidjan (centre du district) pour la météo */
const LAT = 5.34;
const LNG = -4.03;
const REFRESH_MS = 10 * 60_000;
/** Au-delà, la mesure est trop ancienne : on considère qu'il ne pleut pas (mode AUTO) */
const STALE_MS = 60 * 60_000;

/** Minutes depuis minuit, heure d'Abidjan (UTC+0, sans heure d'été) */
const minutesOf = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

/** « 07:00-09:30 » → la date est-elle dans la plage ? (gère les plages qui passent minuit) */
export function inRange(range: TimeRange, at: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!m) return false;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  const now = minutesOf(at);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Majorations du prix selon le moment et la météo :
 * heures de pointe (embouteillages), nuit, pluie (météo en direct ou forcée par l'admin),
 * et zones inondables quand il pleut.
 */
@Injectable()
export class SurchargeService implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(SurchargeService.name);
  private timer?: NodeJS.Timeout;
  private weather: WeatherStatus = { mm: null, raining: false, checkedAt: null, error: null };

  constructor(private settings: SettingsService) {}

  onModuleInit() {
    if (process.env.WEATHER_DISABLED === '1') return;
    void this.refreshWeather();
    this.timer = setInterval(() => void this.refreshWeather(), REFRESH_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  get weatherStatus(): WeatherStatus {
    return this.weather;
  }

  /** Météo en direct (Open-Meteo, sans clé) : pluie de la dernière heure à Abidjan */
  async refreshWeather() {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}&current=precipitation&minutely_15=precipitation&past_minutely_15=4&forecast_minutely_15=0&timezone=UTC`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { current?: { precipitation?: number }; minutely_15?: { precipitation?: (number | null)[] } };
      const quarters = (j.minutely_15?.precipitation ?? []).filter((x): x is number => typeof x === 'number');
      const lastHour = quarters.length ? quarters.reduce((a, b) => a + b, 0) : (j.current?.precipitation ?? 0) * 4;
      const mm = Math.round(lastHour * 10) / 10;
      this.weather = { mm, raining: mm >= this.settings.pricing.surcharges.rainThresholdMm, checkedAt: new Date().toISOString(), error: null };
    } catch (e) {
      this.weather = { ...this.weather, error: (e as Error).message };
      this.logger.warn(`Météo indisponible : ${(e as Error).message}`);
    }
  }

  /** Pleut-il (selon le mode choisi par l'admin) ? */
  raining(grid: PricingGrid = this.settings.pricing): boolean {
    const r = grid.surcharges;
    if (r.rainMode === 'ON') return true;
    if (r.rainMode === 'OFF') return false;
    const fresh = this.weather.checkedAt && Date.now() - new Date(this.weather.checkedAt).getTime() < STALE_MS;
    return !!fresh && this.weather.mm !== null && this.weather.mm >= r.rainThresholdMm;
  }

  /** Majorations applicables à un trajet maintenant (règles LETO, communes à toutes les entreprises) */
  context(points: { lat: number; lng: number }[], at = new Date()): { items: SurchargeItem[]; pct: number } {
    const grid = this.settings.pricing;
    const r = grid.surcharges;
    const items: SurchargeItem[] = [];
    const weekday = at.getUTCDay(); // 0 = dimanche
    if (r.rushEnabled && r.rushPct > 0 && weekday !== 0 && r.rushRanges.some((x) => inRange(x, at))) {
      items.push({ key: 'RUSH', label: 'Heure de pointe', pct: r.rushPct });
    }
    if (r.nightEnabled && r.nightPct > 0 && inRange(r.nightRange, at)) {
      items.push({ key: 'NIGHT', label: 'Nuit', pct: r.nightPct });
    }
    if (this.raining(grid)) {
      if (r.rainPct > 0) items.push({ key: 'RAIN', label: 'Pluie', pct: r.rainPct });
      const flood = new Set(r.floodCommunes);
      if (r.floodPct > 0 && points.some((p) => flood.has(nearestCommune(p.lat, p.lng)))) {
        items.push({ key: 'FLOOD', label: 'Zone inondable', pct: r.floodPct });
      }
    }
    return { items, pct: items.reduce((s, x) => s + x.pct, 0) };
  }
}
