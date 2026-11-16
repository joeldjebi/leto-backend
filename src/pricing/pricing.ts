/**
 * Grille tarifaire LETO — tout se règle ici.
 * Prix = max(minimum, base + prixKm × distance) × facteur délai (+ frais paiement à la livraison),
 * arrondi aux 50 FCFA supérieurs.
 * Paiement de la course : en espèces uniquement.
 */
export enum VehicleType {
  MOTO = 'MOTO',
  CAR = 'CAR',
  CARGO = 'CARGO',
}

export enum DeliverySpeed {
  EXPRESS = 'EXPRESS',
  STANDARD = 'STANDARD',
  SCHEDULED = 'SCHEDULED',
}

export const VEHICLES: Record<VehicleType, { label: string; description: string; base: number; perKm: number; min: number }> = {
  MOTO: { label: 'Livraison à moto', description: 'Petits colis, documents', base: 500, perKm: 150, min: 1000 },
  CAR: { label: 'Voiture', description: 'Colis moyens ou fragiles', base: 1000, perKm: 250, min: 2000 },
  CARGO: { label: 'Cargo', description: 'Gros volumes', base: 3000, perKm: 400, min: 5000 },
};

export const SPEEDS: Record<DeliverySpeed, { label: string; description: string; factor: number }> = {
  EXPRESS: { label: 'Express', description: 'Livreur dédié, départ immédiat', factor: 1.2 },
  STANDARD: { label: 'Standard', description: 'Le livreur peut livrer un autre colis sur la route', factor: 1 },
  SCHEDULED: { label: 'Dans 2 heures', description: 'Le moins cher', factor: 0.85 },
};

/** Frais par arrêt où le livreur encaisse le prix de la marchandise */
export const COD_FEE = 250;

/** Tournée : supplément par arrêt au-delà du premier, et nombre maximum d'arrêts */
export const EXTRA_STOP_FEE = 300;
export const MAX_STOPS = 10;

/**
 * Prix d'une course ou d'une tournée.
 * (max(minimum, base + prixKm × distance) + supplément arrêts) × facteur délai + frais d'encaissement.
 */
export function computePrice(
  distanceKm: number,
  vehicle: VehicleType,
  speed: DeliverySpeed,
  stops = 1,
  codStops = 0,
): number {
  const v = VEHICLES[vehicle];
  const raw =
    (Math.max(v.min, v.base + v.perKm * distanceKm) + EXTRA_STOP_FEE * Math.max(0, stops - 1)) * SPEEDS[speed].factor +
    COD_FEE * codStops;
  return Math.ceil(raw / 50) * 50;
}
