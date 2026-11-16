import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../settings/setting.entity';

/** Fournisseurs de fond de carte proposés au SA */
export const MAP_PROVIDERS = ['osm', 'carto', 'maptiler', 'mapbox', 'google'] as const;
export type MapProvider = (typeof MAP_PROVIDERS)[number];

/** Réglages enregistrés (clés d'accès saisies par le SA ; à défaut, variables d'environnement) */
export interface MapSettings {
  provider: MapProvider;
  cartoKey: string;
  maptilerKey: string;
  mapboxToken: string;
  googleKey: string; // clé Google avec l'API « Map Tiles » activée (sinon GOOGLE_MAPS_API_KEY)
}

/** Ce que reçoivent l'app et le back-office pour afficher les tuiles */
export interface MapStyle {
  provider: MapProvider;
  label: string;
  /** Modèle d'URL des tuiles ({z}/{x}/{y}, {s} = sous-domaine) ; images 2× pour les écrans haute densité */
  light: string;
  /** Variante sombre, ou null : le client assombrit lui-même les tuiles claires */
  dark: string | null;
  subdomains: string[];
  maxZoom: number;
  attribution: string;
  /** Le fournisseur choisi n'est pas utilisable (clé manquante ou refusée) : repli sur OpenStreetMap */
  fallback?: string;
}

const KEY = 'map';
const DEFAULT: MapSettings = { provider: 'osm', cartoKey: '', maptilerKey: '', mapboxToken: '', googleKey: '' };

export const PROVIDER_LABEL: Record<MapProvider, string> = {
  osm: 'OpenStreetMap',
  carto: 'Carto Voyager',
  maptiler: 'MapTiler Streets',
  mapbox: 'Mapbox Streets',
  google: 'Google Maps',
};

const OSM: MapStyle = {
  provider: 'osm',
  label: PROVIDER_LABEL.osm,
  light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark: null,
  subdomains: [],
  maxZoom: 19,
  attribution: '© OpenStreetMap',
};

/** Style sombre Google (mode nuit) */
const GOOGLE_DARK = [
  { elementType: 'geometry', stylers: [{ color: '#1d1d22' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9a9aa3' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1d22' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#24242a' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1f2a24' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#33333b' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4a4152' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2a2a31' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f1720' }] },
];

/**
 * Fond de carte choisi par le SA, servi à l'app et au back-office.
 * Google : jetons de session de l'API Map Tiles créés côté serveur et gardés en cache (valables ~2 semaines).
 */
@Injectable()
export class MapStyleService implements OnModuleInit {
  private logger = new Logger(MapStyleService.name);
  private settings: MapSettings = { ...DEFAULT };
  private google: { light?: { session: string; expires: number }; dark?: { session: string; expires: number } } = {};

  constructor(@InjectRepository(Setting) private repo: Repository<Setting>) {}

  async onModuleInit() {
    const row = await this.repo.findOneBy({ key: KEY });
    if (row) this.settings = { ...DEFAULT, ...(row.value as Partial<MapSettings>) };
  }

  /** Réglages pour le SA (clés comprises) */
  get adminSettings() {
    return {
      ...this.settings,
      env: {
        cartoKey: !!process.env.CARTO_KEY,
        maptilerKey: !!process.env.MAPTILER_KEY,
        mapboxToken: !!process.env.MAPBOX_TOKEN,
        googleKey: !!process.env.GOOGLE_MAPS_API_KEY,
      },
      providers: MAP_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id] })),
    };
  }

  async update(input: Partial<MapSettings>, by: string) {
    const next: MapSettings = { ...this.settings };
    if (input.provider !== undefined) {
      if (!MAP_PROVIDERS.includes(input.provider)) throw new BadRequestException('Fournisseur de carte inconnu');
      next.provider = input.provider;
    }
    for (const k of ['cartoKey', 'maptilerKey', 'mapboxToken', 'googleKey'] as const) {
      if (input[k] !== undefined) {
        const v = String(input[k] ?? '').trim();
        if (v.length > 300 || /\s/.test(v)) throw new BadRequestException('Clé d’accès invalide');
        next[k] = v;
      }
    }
    // Vérifie que le fournisseur choisi fonctionne avant d'enregistrer
    const style = await this.build(next);
    if (style.fallback && next.provider !== 'osm') throw new BadRequestException(style.fallback);
    await this.probe(style);
    this.google = {};
    await this.repo.save({ key: KEY, value: next, updatedBy: by });
    this.settings = next;
    return { ...this.adminSettings, style };
  }

  /** Demande une tuile du Plateau (Abidjan) : une clé refusée bloque l'enregistrement */
  private async probe(style: MapStyle) {
    const url = style.light
      .replace('{s}', style.subdomains[0] ?? 'a')
      .replace('{z}', '15')
      .replace('{x}', '16018')
      .replace('{y}', '15898');
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'LETO/1.0' }, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new BadRequestException(`${style.label} : serveur de tuiles injoignable`);
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) {
      throw new BadRequestException(`${style.label} : clé refusée (${res.status}) — vérifiez la clé et ses restrictions`);
    }
  }

  /** Fond de carte actuel (public) */
  style(): Promise<MapStyle> {
    return this.build(this.settings);
  }

  private async build(s: MapSettings): Promise<MapStyle> {
    const carto = s.cartoKey || process.env.CARTO_KEY || '';
    const maptiler = s.maptilerKey || process.env.MAPTILER_KEY || '';
    const mapbox = s.mapboxToken || process.env.MAPBOX_TOKEN || '';
    const google = s.googleKey || process.env.GOOGLE_MAPS_API_KEY || '';
    const fallback = (why: string): MapStyle => ({ ...OSM, fallback: why });
    switch (s.provider) {
      case 'carto':
        // Clé gratuite obligatoire (sinon tuiles marquées « API KEY REQUIRED ») : carto.com/basemaps/apikey
        if (!carto) return fallback('Carto : clé d’accès manquante');
        return {
          provider: 'carto',
          label: PROVIDER_LABEL.carto,
          light: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png?key=${carto}`,
          dark: `https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png?key=${carto}`,
          subdomains: ['a', 'b', 'c', 'd'],
          maxZoom: 20,
          attribution: '© OpenStreetMap © CARTO',
        };
      case 'maptiler':
        if (!maptiler) return fallback('MapTiler : clé d’accès manquante');
        return {
          provider: 'maptiler',
          label: PROVIDER_LABEL.maptiler,
          light: `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}@2x.png?key=${maptiler}`,
          dark: `https://api.maptiler.com/maps/streets-v2-dark/256/{z}/{x}/{y}@2x.png?key=${maptiler}`,
          subdomains: [],
          maxZoom: 20,
          attribution: '© MapTiler © OpenStreetMap',
        };
      case 'mapbox':
        if (!mapbox) return fallback('Mapbox : jeton d’accès manquant');
        return {
          provider: 'mapbox',
          label: PROVIDER_LABEL.mapbox,
          light: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=${mapbox}`,
          dark: `https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${mapbox}`,
          subdomains: [],
          maxZoom: 20,
          attribution: '© Mapbox © OpenStreetMap',
        };
      case 'google': {
        if (!google) return fallback('Google Maps : clé d’accès manquante');
        try {
          const [light, dark] = await Promise.all([this.googleSession(google, 'light'), this.googleSession(google, 'dark')]);
          const tile = (session: string) => `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${google}`;
          return {
            provider: 'google',
            label: PROVIDER_LABEL.google,
            light: tile(light),
            dark: tile(dark),
            subdomains: [],
            maxZoom: 21,
            attribution: '© Google',
          };
        } catch (e) {
          this.logger.warn(`Google Map Tiles indisponible : ${(e as Error).message}`);
          return fallback(`Google Maps : ${(e as Error).message}`);
        }
      }
      default:
        return OSM;
    }
  }

  /** Jeton de session Map Tiles (renouvelé un jour avant son expiration) */
  private async googleSession(key: string, theme: 'light' | 'dark') {
    const cached = this.google[theme];
    if (cached && cached.expires - Date.now() > 86_400_000) return cached.session;
    const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: 'roadmap',
        language: 'fr-FR',
        region: 'CI',
        scale: 'scaleFactor2x',
        highDpi: true,
        ...(theme === 'dark' ? { styles: GOOGLE_DARK } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => null)) as { session?: string; expiry?: string; error?: { message?: string } } | null;
    if (!res.ok || !data?.session) {
      throw new Error(data?.error?.message ?? `refus de Google (${res.status}) — activez « Map Tiles API » pour cette clé`);
    }
    const expires = data.expiry ? Number(data.expiry) * 1000 : Date.now() + 13 * 86_400_000;
    this.google[theme] = { session: data.session, expires };
    return data.session;
  }
}
