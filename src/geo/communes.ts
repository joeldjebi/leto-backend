/** Centre approximatif des communes du Grand Abidjan */
const CENTERS: Record<string, [number, number]> = {
  Abobo: [5.418, -4.02],
  Adjamé: [5.356, -4.023],
  Attécoubé: [5.337, -4.042],
  Cocody: [5.36, -3.97],
  Koumassi: [5.295, -3.95],
  Marcory: [5.3, -3.983],
  Plateau: [5.323, -4.019],
  'Port-Bouët': [5.256, -3.926],
  Treichville: [5.293, -4.008],
  Yopougon: [5.345, -4.089],
  Bingerville: [5.355, -3.885],
  Songon: [5.32, -4.26],
  Anyama: [5.495, -4.052],
};

/** Distance à vol d'oiseau en km */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearestCommune(lat: number, lng: number): string {
  let best = 'Abidjan';
  let bestKm = Infinity;
  for (const [name, [cLat, cLng]] of Object.entries(CENTERS)) {
    const km = haversineKm(lat, lng, cLat, cLng);
    if (km < bestKm) [best, bestKm] = [name, km];
  }
  return best;
}

/** Rayon autour du centre d'une commune considéré comme « Grand Abidjan » */
export const GRAND_ABIDJAN_RADIUS_KM = 9;

/** Le point est-il dans le Grand Abidjan (13 communes du district) ? */
export function inGrandAbidjan(lat: number, lng: number): boolean {
  return Object.values(CENTERS).some(([cLat, cLng]) => haversineKm(lat, lng, cLat, cLng) <= GRAND_ABIDJAN_RADIUS_KM);
}

/** Tous les points (départ et arrêts) sont dans le Grand Abidjan */
export function allInGrandAbidjan(points: { lat: number; lng: number }[]): boolean {
  return points.length > 0 && points.every((p) => inGrandAbidjan(p.lat, p.lng));
}
