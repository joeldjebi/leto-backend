/**
 * Grille tarifaire LETO — tout se règle ici.
 * Prix = max(minimum, base + prixKm × distance) × facteur délai, plafonné dans le Grand Abidjan,
 * (+ arrêts supplémentaires, + frais paiement à la livraison), arrondi aux 50 FCFA supérieurs.
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
  /** Prix maximum d'une course dans le Grand Abidjan, par délai (0 = pas de plafond) */
  maxAbidjan: Record<DeliverySpeed, number>;
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
  /** Frais de déplacement si l'expéditeur annule alors que le livreur est en route */
  cancelFeeEnabled: boolean;
  cancelFeeType: 'PERCENT' | 'FIXED';
  cancelFeeValue: number;
  /** Annulation gratuite pendant ces minutes après l'acceptation */
  cancelFreeMinutes: number;
  /** Colis non livrés : retour à l'expéditeur confirmé par un code */
  returnCodeEnabled: boolean;
  /** Livraison confirmée par le code à 4 chiffres du destinataire (sinon le livreur valide seul) */
  deliveryCodeEnabled: boolean;
  /** Sans réponse de l'expéditeur, l'annulation signalée par le livreur est acceptée après ces minutes */
  cancelRequestAutoMin: number;
  /** Échec ou arrêt annulé après la récupération : retour à l'expéditeur facturé (% du prix de l'arrêt) */
  returnFeePct: number;
  /** Nouvelle tentative après un échec : prix en % du prix de l'arrêt (70 = 30 % de réduction) */
  retryFeePct: number;
  /** Après un échec, l'expéditeur choisit (nouvelle tentative ou retour) ; sans réponse : retour après ces minutes */
  followUpAutoMin: number;
  /** Le livreur doit appeler chaque destinataire avant de partir avec les colis */
  preCallRequired: boolean;
  /** Alerte au back-office quand le taux d'échec d'un livreur dépasse ce % sur 7 jours (0 = jamais) */
  failAlertPct: number;
  /** Notes des clients : priorité aux livreurs bien notés (à distance proche), alerte sous ce seuil sur les N dernières notes */
  ratingPriority: boolean;
  ratingWindow: number;
  /** 0 = jamais */
  ratingAlertBelow: number;
  /** Commande sans livreur : expirée (annulée automatiquement) après ces minutes ; 0 = jamais */
  orderExpiryMin: number;
  /** Tournées : réduction (%) par arrêt au-delà du premier, plafonnée */
  multiStopDiscountPct: number;
  multiStopDiscountMaxPct: number;
  /** Livreurs libres : rayon (km) autour du départ pour être prévenus d'une nouvelle commande */
  dispatchRadiusKm: number;
  /** Livreur déjà en course : prévenu si le départ est à moins de ce rayon (km) de lui… */
  busyRadiusKm: number;
  /** … ou à moins de cette distance (m) de son trajet restant */
  routeCorridorM: number;
  /** Nombre maximum de courses en cours en même temps par livreur (livraisons « Dans 2 heures ») */
  maxActiveCourses: number;
  /** Livreur avec une livraison Standard : courses en même temps au maximum (Express : toujours seule) */
  standardMaxActiveCourses: number;
  /** … et retard maximum (min) qu'une course ajoutée peut causer à sa livraison Standard */
  standardMaxDetourMin: number;
  /** Durée d'affichage de l'alerte « nouvelle commande » chez le livreur (secondes) */
  orderPopupSec: number;
  /** Envoi par vagues : nombre de livreurs prévenus à chaque vague (les plus proches d'abord) */
  dispatchWaveSize: number;
  /** … et délai (secondes) avant de prévenir les suivants si personne n'a accepté */
  dispatchWaveSec: number;
  /** Majorations selon l'heure, la météo et les zones inondables */
  surcharges: SurchargeRules;
  /** Version des règles par défaut appliquées (mise à jour automatique des anciennes grilles) */
  rev: number;
}

/** Plage horaire « HH:MM-HH:MM » (heure d'Abidjan = UTC) */
export type TimeRange = string;

export interface SurchargeRules {
  /** Heures de pointe (embouteillages), du lundi au samedi */
  rushEnabled: boolean;
  rushPct: number;
  rushRanges: TimeRange[];
  /** Nuit */
  nightEnabled: boolean;
  nightPct: number;
  nightRange: TimeRange;
  /** Pluie : AUTO = météo en direct, ON = forcée par l'admin, OFF = jamais */
  rainMode: 'AUTO' | 'ON' | 'OFF';
  rainPct: number;
  /** Seuil de pluie (mm sur la dernière heure) pour la météo automatique */
  rainThresholdMm: number;
  /** Quand il pleut : majoration en plus si le trajet touche une commune inondable */
  floodPct: number;
  floodCommunes: string[];
  /** Les majorations peuvent-elles dépasser le prix maximum du Grand Abidjan ? */
  aboveCap: boolean;
}

/** Version courante des règles par défaut */
export const PRICING_REV = 6;

/** Textes des délais (v4 : règles de courses simultanées selon le délai) */
export const SPEED_TEXT = {
  EXPRESS: 'Livreur dédié : il ne fait que votre course',
  STANDARD: 'Le livreur peut prendre un autre colis sur sa route, sans retarder le vôtre',
  OLD_EXPRESS: 'Livreur dédié, départ immédiat',
  OLD_STANDARD: 'Le livreur peut livrer un autre colis sur la route',
};

export const defaultSurcharges = (): SurchargeRules => ({
  rushEnabled: true,
  rushPct: 10,
  rushRanges: ['07:00-09:30', '17:00-20:00'],
  nightEnabled: true,
  nightPct: 15,
  nightRange: '21:00-06:00',
  rainMode: 'AUTO',
  rainPct: 15,
  rainThresholdMm: 1,
  floodPct: 10,
  floodCommunes: ['Abobo', 'Attécoubé', 'Yopougon', 'Cocody', 'Port-Bouët', 'Koumassi'],
  aboveCap: false,
});

const noCap = (): Record<DeliverySpeed, number> => ({ EXPRESS: 0, STANDARD: 0, SCHEDULED: 0 });

/** Limite technique du nombre d'arrêts */
export const MAX_STOPS = 10;

/** Valeurs par défaut (utilisées tant que le SA n'a rien modifié) */
export const defaultGrid = (): PricingGrid => ({
  vehicles: {
    // Moto : très compétitif, plafonné dans le Grand Abidjan (Express 2 500 F · Standard 2 200 F · Dans 2 h 2 000 F)
    MOTO: {
      label: 'Livraison à moto', description: 'Petits colis, documents', base: 300, perKm: 85, min: 450, enabled: true,
      maxAbidjan: { EXPRESS: 2500, STANDARD: 2200, SCHEDULED: 2000 },
    },
    CAR: { label: 'Voiture', description: 'Colis moyens ou fragiles', base: 1000, perKm: 175, min: 2000, enabled: true, maxAbidjan: noCap() },
    CARGO: { label: 'Cargo', description: 'Gros volumes', base: 3000, perKm: 300, min: 5000, enabled: true, maxAbidjan: noCap() },
  },
  speeds: {
    EXPRESS: { label: 'Express', description: SPEED_TEXT.EXPRESS, factor: 1.1 },
    STANDARD: { label: 'Standard', description: SPEED_TEXT.STANDARD, factor: 1 },
    SCHEDULED: { label: 'Dans 2 heures', description: 'Le moins cher', factor: 0.85 },
  },
  codEnabled: false,
  codFee: 250,
  extraStopFee: 300,
  maxStops: MAX_STOPS,
  absenceWaitMin: Number(process.env.ABSENCE_WAIT_MIN ?? 5),
  cancelFeeEnabled: false,
  cancelFeeType: 'FIXED',
  cancelFeeValue: 500,
  cancelFreeMinutes: 2,
  returnCodeEnabled: false,
  deliveryCodeEnabled: true,
  cancelRequestAutoMin: 10,
  returnFeePct: 50,
  retryFeePct: 70,
  followUpAutoMin: 10,
  preCallRequired: true,
  failAlertPct: 15,
  ratingPriority: true,
  ratingWindow: 20,
  ratingAlertBelow: 3.5,
  orderExpiryMin: 30,
  multiStopDiscountPct: 5,
  multiStopDiscountMaxPct: 25,
  dispatchRadiusKm: 10,
  busyRadiusKm: 2,
  routeCorridorM: 500,
  maxActiveCourses: 3,
  standardMaxActiveCourses: 2,
  standardMaxDetourMin: 10,
  orderPopupSec: 30,
  dispatchWaveSize: 3,
  dispatchWaveSec: 15,
  surcharges: defaultSurcharges(),
  rev: PRICING_REV,
});

/** Contexte du prix : zone, majorations en cours */
export interface PriceContext {
  /** Départ et arrêts tous dans le Grand Abidjan : plafonds appliqués */
  inAbidjan?: boolean;
  /** Total des majorations en % (heure de pointe, nuit, pluie, inondation) */
  surchargePct?: number;
}

/** Réduction tournée (%) pour [stops] adresses */
export const stopDiscountPct = (grid: PricingGrid, stops: number) =>
  Math.min(grid.multiStopDiscountMaxPct ?? 0, (grid.multiStopDiscountPct ?? 0) * Math.max(0, stops - 1));

/**
 * Prix d'une course ou d'une tournée.
 * 1. Course = max(minimum, base + prixKm × distance) × coefficient du délai × (1 + majorations)
 * 2. Plafond si tout le trajet est dans le Grand Abidjan (majorations comprises, sauf si l'admin les autorise au-dessus)
 * 3. + supplément par arrêt au-delà du premier (× coefficient × majorations)
 * 4. − réduction tournée (plus il y a d'arrêts, plus elle est forte)
 * 5. + frais d'encaissement ; arrondi aux 50 F supérieurs.
 */
export function computePrice(
  grid: PricingGrid,
  distanceKm: number,
  vehicle: VehicleType,
  speed: DeliverySpeed,
  stops = 1,
  codStops = 0,
  ctx: PriceContext = {},
): number {
  const v = grid.vehicles[vehicle];
  const factor = grid.speeds[speed].factor;
  const up = 1 + Math.max(0, ctx.surchargePct ?? 0) / 100;
  let course = Math.ceil((Math.max(v.min, v.base + v.perKm * distanceKm) * factor * up) / 50) * 50;
  const cap = v.maxAbidjan?.[speed] ?? 0;
  if (ctx.inAbidjan && cap > 0) course = Math.min(course, grid.surcharges?.aboveCap ? Math.ceil((cap * up) / 50) * 50 : cap);
  const extras = grid.extraStopFee * Math.max(0, stops - 1) * factor * up;
  const discounted = (course + extras) * (1 - stopDiscountPct(grid, stops) / 100);
  return Math.ceil((discounted + grid.codFee * codStops) / 50) * 50;
}
