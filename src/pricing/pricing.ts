/**
 * Grille tarifaire LETO — tout se règle ici.
 * Prix = max(minimum, base + prixKm × distance) × facteur délai (+ frais paiement à la livraison),
 * arrondi aux 50 FCFA supérieurs.
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

export enum PaymentMethod {
  CASH = 'CASH',
  WAVE = 'WAVE',
  ORANGE_MONEY = 'ORANGE_MONEY',
  MTN_MOMO = 'MTN_MOMO',
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

/** Frais ajoutés quand le livreur encaisse le prix de la marchandise */
export const COD_FEE = 250;

export function computePrice(distanceKm: number, vehicle: VehicleType, speed: DeliverySpeed, cod: boolean): number {
  const v = VEHICLES[vehicle];
  const raw = Math.max(v.min, v.base + v.perKm * distanceKm) * SPEEDS[speed].factor + (cod ? COD_FEE : 0);
  return Math.ceil(raw / 50) * 50;
}
