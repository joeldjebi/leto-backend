import { PayPeriod } from './payroll.entities';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** Période contenant [at] (heure d'Abidjan = UTC) : semaine lundi-dimanche, quinzaine 1-15 / 16-fin, mois */
export function periodOf(kind: PayPeriod, at = new Date()): { start: string; end: string } {
  const y = at.getUTCFullYear(), m = at.getUTCMonth(), d = at.getUTCDate();
  if (kind === 'WEEK') {
    const dow = (at.getUTCDay() + 6) % 7;
    return { start: iso(utc(y, m, d - dow)), end: iso(utc(y, m, d - dow + 6)) };
  }
  const last = utc(y, m + 1, 0).getUTCDate();
  if (kind === 'FORTNIGHT') return d <= 15 ? { start: iso(utc(y, m, 1)), end: iso(utc(y, m, 15)) } : { start: iso(utc(y, m, 16)), end: iso(utc(y, m, last)) };
  return { start: iso(utc(y, m, 1)), end: iso(utc(y, m, last)) };
}

/** Les [n] dernières périodes, la plus récente d'abord (en cours incluse) */
export function recentPeriods(kind: PayPeriod, n = 6, at = new Date()) {
  const out: { start: string; end: string }[] = [];
  let p = periodOf(kind, at);
  for (let i = 0; i < n; i++) {
    out.push(p);
    p = periodOf(kind, new Date(new Date(`${p.start}T00:00:00Z`).getTime() - 86_400_000));
  }
  return out;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** « Semaine du 23 au 29 novembre 2026 », « 1re quinzaine de novembre 2026 », « Novembre 2026 » */
export function periodLabel(kind: PayPeriod, start: string, end: string) {
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const month = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (kind === 'MONTH') return month(s).charAt(0).toUpperCase() + month(s).slice(1);
  if (kind === 'FORTNIGHT') return `${s.getUTCDate() === 1 ? '1re' : '2e'} quinzaine de ${month(s)}`;
  return `Semaine du ${s.getUTCDate()}${s.getUTCMonth() !== e.getUTCMonth() ? ` ${MONTHS[s.getUTCMonth()]}` : ''} au ${e.getUTCDate()} ${month(e)}`;
}
