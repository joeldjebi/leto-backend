/** Horaires d'ouverture d'une entreprise aux commandes des clients (heure d'Abidjan = UTC) */
export interface OpeningHours {
  /** HH:MM */
  open: string;
  close: string;
  /** Jours d'ouverture : 1 = lundi … 7 = dimanche */
  days: number[];
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_LABEL = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function validHours(h: unknown): h is OpeningHours {
  if (!h || typeof h !== 'object') return false;
  const o = h as OpeningHours;
  return HM.test(o.open) && HM.test(o.close) && o.open !== o.close && Array.isArray(o.days) && o.days.length > 0 && o.days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

/** Ouverte maintenant ? (fermeture après minuit gérée : 18:00 → 02:00) */
export function openNow(c: { acceptingOrders: boolean; openingHours: OpeningHours | null }, at = new Date()) {
  if (!c.acceptingOrders) return false;
  const h = c.openingHours;
  if (!h) return true;
  const day = ((at.getUTCDay() + 6) % 7) + 1;
  const prev = ((day + 5) % 7) + 1;
  const now = at.getUTCHours() * 60 + at.getUTCMinutes();
  const o = minutes(h.open);
  const cl = minutes(h.close);
  if (o < cl) return h.days.includes(day) && now >= o && now < cl;
  // Ouverture de nuit : le soir du jour ouvré, ou la nuit suivante
  return (h.days.includes(day) && now >= o) || (h.days.includes(prev) && now < cl);
}

/** « Fermée pour le moment », « Ouvre à 07:00 », « Ouvre lundi à 07:00 » */
export function closedText(name: string, c: { acceptingOrders: boolean; openingHours: OpeningHours | null }, at = new Date()) {
  if (!c.acceptingOrders || !c.openingHours) return `${name} ne prend pas de commandes pour le moment`;
  const h = c.openingHours;
  const day = ((at.getUTCDay() + 6) % 7) + 1;
  const now = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (let i = 0; i < 8; i++) {
    const d = ((day - 1 + i) % 7) + 1;
    if (!h.days.includes(d)) continue;
    if (i === 0 && now >= minutes(h.open)) continue;
    return `${name} est fermée pour le moment : ouvre ${i === 0 ? 'aujourd’hui' : i === 1 ? 'demain' : DAY_LABEL[d]} à ${h.open}`;
  }
  return `${name} ne prend pas de commandes pour le moment`;
}
