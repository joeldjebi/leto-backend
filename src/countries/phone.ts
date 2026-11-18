import { registerDecorator, ValidationOptions } from 'class-validator';
import { Transform } from 'class-transformer';

/** Pays tel que le connaît le registre (copie en mémoire de la table countries) */
export interface CountryRule {
  iso: string;
  name: string;
  dialCode: string; // sans « + », ex. 225
  phoneLength: number; // chiffres après l'indicatif, ex. 10 pour la Côte d'Ivoire
  trunkPrefix: string; // préfixe national retiré à l'international (« 0 » au Ghana, vide en Côte d'Ivoire)
  currencyCode: string;
  currencySymbol: string;
  currencyDecimals: number;
  active: boolean;
  operating: boolean;
}

const DEFAULT: CountryRule = {
  iso: 'CI', name: 'Côte d’Ivoire', dialCode: '225', phoneLength: 10, trunkPrefix: '',
  currencyCode: 'XOF', currencySymbol: 'F', currencyDecimals: 0, active: true, operating: true,
};

/** Registre synchrone, alimenté par CountriesService (utilisable dans les validateurs et les messages) */
export const Countries = {
  list: [DEFAULT] as CountryRule[],
  get operating(): CountryRule {
    return this.list.find((c) => c.operating) ?? this.list.find((c) => c.active) ?? DEFAULT;
  },
  byIso(iso?: string | null) {
    return this.list.find((c) => c.iso === iso) ?? null;
  },
  byCode(code?: string | null) {
    return this.list.find((c) => c.currencyCode === code) ?? null;
  },
};

/** Drapeau emoji à partir du code ISO (CI → 🇨🇮) */
export const flagOf = (iso: string) =>
  iso.toUpperCase().replace(/[A-Z]/g, (ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65));

/**
 * Numéro au format international (+2250701020304).
 * Accepte : +225…, 00225…, 225…, ou un numéro local (pays où LETO opère).
 * `activeOnly` : n'accepte que les pays actifs (nouvelles saisies) ; la connexion accepte tous les pays connus.
 */
export function normalizePhone(input: unknown, activeOnly = true): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[\s.\-()/]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  const pool = Countries.list.filter((c) => !activeOnly || c.active);
  const national = (c: CountryRule, digits: string) => {
    if (c.trunkPrefix && digits.length === c.phoneLength + c.trunkPrefix.length && digits.startsWith(c.trunkPrefix))
      digits = digits.slice(c.trunkPrefix.length);
    return /^\d+$/.test(digits) && digits.length === c.phoneLength ? `+${c.dialCode}${digits}` : null;
  };
  if (s.startsWith('+')) {
    const rest = s.slice(1);
    // Indicatif le plus long d'abord (ex. 1 et 1268)
    for (const c of [...pool].sort((a, b) => b.dialCode.length - a.dialCode.length)) {
      if (rest.startsWith(c.dialCode)) {
        const r = national(c, rest.slice(c.dialCode.length));
        if (r) return r;
      }
    }
    return null;
  }
  if (!/^\d+$/.test(s)) return null;
  const home = Countries.operating;
  if (pool.includes(home)) {
    const r = national(home, s);
    if (r) return r;
  }
  // Indicatif saisi sans « + » (2250701020304)
  for (const c of pool) {
    if (s.startsWith(c.dialCode) && s.length === c.dialCode.length + c.phoneLength) return `+${s}`;
  }
  return null;
}

export const PHONE_MESSAGE = 'Numéro de téléphone invalide pour le pays choisi';

/**
 * Valide et convertit un numéro au format international.
 * `optional` : champ facultatif (vide accepté) ; `anyCountry` : accepte aussi les pays désactivés (connexion).
 */
export function IsPhone(opts: ValidationOptions & { optional?: boolean; anyCountry?: boolean } = {}) {
  const { optional, anyCountry, ...validation } = opts;
  return function (object: object, propertyName: string) {
    Transform(({ value }) => {
      if (optional && (value === undefined || value === null || value === '')) return undefined;
      return normalizePhone(value, !anyCountry) ?? value;
    })(object, propertyName);
    registerDecorator({
      name: 'isPhone',
      target: object.constructor,
      propertyName,
      options: { message: PHONE_MESSAGE, ...validation },
      validator: {
        validate(value: unknown) {
          if (optional && (value === undefined || value === null || value === '')) return true;
          return typeof value === 'string' && normalizePhone(value, !anyCountry) === value;
        },
      },
    });
  };
}

/** Montant dans une devise (par défaut celle du pays où LETO opère) : « 1 500 F » */
export function money(amount: number | null | undefined, currencyCode?: string | null) {
  const c = Countries.byCode(currencyCode) ?? Countries.operating;
  const n = Number(amount ?? 0);
  const txt = n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: c.currencyDecimals }).replace(/ | /g, ' ');
  return `${txt} ${c.currencySymbol}`;
}
