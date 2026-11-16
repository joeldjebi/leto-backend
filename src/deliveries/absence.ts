/**
 * Règles de vérification d'un échec de livraison (destinataire absent / refus).
 * Le livreur doit être réellement sur place, avoir attendu, et prendre une photo.
 */
export const ARRIVAL_RADIUS_M = 150; // « arrivé » détecté par GPS sous ce rayon
export const FAIL_RADIUS_M = 250; // l'échec ne peut être signalé que sur place
export const LOCATION_MAX_AGE_MS = 2 * 60 * 1000; // position GPS récente exigée
/** Attente minimale après l'arrivée avant de pouvoir signaler une absence */
export const absenceWaitMs = () => Number(process.env.ABSENCE_WAIT_MIN ?? 5) * 60 * 1000;
