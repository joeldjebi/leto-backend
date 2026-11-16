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

export interface VehicleConfig {
  label: string;
  description: string;
  base: number;
  perKm: number;
  min: number;
  enabled: boolean;
}

export interface SpeedConfig {
  label: string;
  description: string;
  factor: number;
}

/** Grille tarifaire et règles, modifiables par le Super Admin (back-office → Tarifs et règles) */
export interface PricingGrid {
  vehicles: Record<VehicleType, VehicleConfig>;
  speeds: Record<DeliverySpeed, SpeedConfig>;
  /** Paiement à la livraison proposé aux clients (désactivé par défaut) */
  codEnabled: boolean;
  /** Frais par arrêt où le livreur encaisse le prix de la marchandise */
  codFee: number;
  /** Tournée : supplément par arrêt au-delà du premier */
  extraStopFee: number;
  /** Nombre maximum d'arrêts par tournée (10 au plus) */
  maxStops: number;
  /** Attente minimale (minutes) avant de pouvoir signaler un destinataire absent */
  absenceWaitMin: number;
}

/** Limite technique du nombre d'arrêts */
export const MAX_STOPS = 10;

/** Valeurs par défaut (utilisées tant que le SA n'a rien modifié) */
export const defaultGrid = (): PricingGrid => ({
  vehicles: {
    MOTO: { label: 'Livraison à moto', description: 'Petits colis, documents', base: 500, perKm: 150, min: 1000, enabled: true },
    CAR: { label: 'Voiture', description: 'Colis moyens ou fragiles', base: 1000, perKm: 250, min: 2000, enabled: true },
    CARGO: { label: 'Cargo', description: 'Gros volumes', base: 3000, perKm: 400, min: 5000, enabled: true },
  },
  speeds: {
    EXPRESS: { label: 'Express', description: 'Livreur dédié, départ immédiat', factor: 1.2 },
    STANDARD: { label: 'Standard', description: 'Le livreur peut livrer un autre colis sur la route', factor: 1 },
    SCHEDULED: { label: 'Dans 2 heures', description: 'Le moins cher', factor: 0.85 },
  },
  codEnabled: false,
  codFee: 250,
  extraStopFee: 300,
  maxStops: MAX_STOPS,
  absenceWaitMin: Number(process.env.ABSENCE_WAIT_MIN ?? 5),
});

/**
 * Prix d'une course ou d'une tournée.
 * (max(minimum, base + prixKm × distance) + supplément arrêts) × facteur délai + frais d'encaissement,
 * arrondi aux 50 F supérieurs.
 */
export function computePrice(
  grid: PricingGrid,
  distanceKm: number,
  vehicle: VehicleType,
  speed: DeliverySpeed,
  stops = 1,
  codStops = 0,
): number {
  const v = grid.vehicles[vehicle];
  const raw =
    (Math.max(v.min, v.base + v.perKm * distanceKm) + grid.extraStopFee * Math.max(0, stops - 1)) * grid.speeds[speed].factor +
    grid.codFee * codStops;
  return Math.ceil(raw / 50) * 50;
}
