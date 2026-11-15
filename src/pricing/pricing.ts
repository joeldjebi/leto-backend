/** Communes du Grand Abidjan */
export const COMMUNES = [
  'Abobo',
  'Adjamé',
  'Attécoubé',
  'Cocody',
  'Koumassi',
  'Marcory',
  'Plateau',
  'Port-Bouët',
  'Treichville',
  'Yopougon',
  'Bingerville',
  'Songon',
  'Anyama',
] as const;

const PERIPHERIE = ['Bingerville', 'Songon', 'Anyama'];

/** Grille simple en FCFA — à ajuster selon le marché */
export const TARIFS = {
  memeCommune: 1000,
  autreCommune: 1500,
  peripherie: 2500,
};

export function computePrice(from: string, to: string): number {
  if (PERIPHERIE.includes(from) || PERIPHERIE.includes(to)) {
    return from === to ? TARIFS.autreCommune : TARIFS.peripherie;
  }
  return from === to ? TARIFS.memeCommune : TARIFS.autreCommune;
}
