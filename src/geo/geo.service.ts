import { Injectable, Logger } from '@nestjs/common';
import { haversineKm, nearestCommune } from './communes';

export interface Place {
  label: string;
  sublabel: string;
  lat: number;
  lng: number;
  source: 'google' | 'osm';
}

export interface Route {
  distanceKm: number;
  durationMin: number;
  /** Tracé [lat, lng] */
  points: [number, number][];
  source: 'google' | 'osrm' | 'estimate';
}

type LatLng = { lat: number; lng: number };

const UA = 'LETO-delivery/0.1'; // Nominatim exige un User-Agent identifiable
const ABIDJAN_VIEWBOX = '-4.35,5.60,-3.70,5.15';

/**
 * Cartographie « combinée » :
 *  - Affichage : tuiles OpenStreetMap (dans les apps).
 *  - Recherche de lieux : Google Places (si GOOGLE_MAPS_API_KEY) + OpenStreetMap/Nominatim, fusionnés.
 *  - Adresse d'un point : Google Geocoding, sinon Nominatim.
 *  - Itinéraire / distance : Google Routes, sinon OSRM, sinon estimation à vol d'oiseau × 1,35.
 * Sans clé Google, tout fonctionne avec OpenStreetMap uniquement.
 */
@Injectable()
export class GeoService {
  private logger = new Logger(GeoService.name);
  private key = process.env.GOOGLE_MAPS_API_KEY;
  private cache = new Map<string, unknown>();

  // ---------- Recherche ----------

  async search(q: string, near?: LatLng): Promise<Place[]> {
    const query = q.trim();
    if (query.length < 2) return [];
    const [google, osm] = await Promise.all([
      this.key ? this.safe(() => this.googleSearch(query, near), []) : Promise.resolve([] as Place[]),
      this.safe(() => this.osmSearch(query, near), []),
    ]);
    // Google d'abord, puis les résultats OSM qui ne sont pas des doublons (< 80 m)
    const merged = [...google];
    for (const p of osm) {
      if (!merged.some((m) => haversineKm(m.lat, m.lng, p.lat, p.lng) < 0.08)) merged.push(p);
    }
    if (near) merged.sort((a, b) => this.dist(near, a) - this.dist(near, b));
    return merged.slice(0, 10);
  }

  private async googleSearch(q: string, near?: LatLng): Promise<Place[]> {
    const center = near ?? { lat: 5.3364, lng: -4.0267 };
    const res = await this.http('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: q,
        languageCode: 'fr',
        regionCode: 'CI',
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 40000 } },
      }),
    });
    return (res.places ?? []).map((p: any) => ({
      label: p.displayName?.text ?? p.formattedAddress,
      sublabel: p.formattedAddress ?? '',
      lat: p.location.latitude,
      lng: p.location.longitude,
      source: 'google' as const,
    }));
  }

  private async osmSearch(q: string, near?: LatLng): Promise<Place[]> {
    const params = new URLSearchParams({
      q,
      format: 'jsonv2',
      countrycodes: 'ci',
      limit: '8',
      'accept-language': 'fr',
      viewbox: ABIDJAN_VIEWBOX,
      bounded: '0',
    });
    const res = await this.http(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'User-Agent': UA } });
    return (res as any[]).map((r) => {
      const parts = String(r.display_name).split(',').map((s) => s.trim());
      return {
        label: r.name || parts[0],
        sublabel: parts.slice(r.name ? 0 : 1, 3).filter((s) => s !== r.name).join(', '),
        lat: Number(r.lat),
        lng: Number(r.lon),
        source: 'osm' as const,
      };
    });
  }

  // ---------- Adresse d'un point ----------

  async reverse(lat: number, lng: number): Promise<{ label: string; sublabel: string; commune: string }> {
    const commune = nearestCommune(lat, lng);
    const key = `rev:${lat.toFixed(4)},${lng.toFixed(4)}`;
    return this.cached(key, async () => {
      const found =
        (this.key ? await this.safe(() => this.googleReverse(lat, lng), null) : null) ??
        (await this.safe(() => this.osmReverse(lat, lng), null));
      return { label: found?.label || commune, sublabel: found?.sublabel || commune, commune };
    });
  }

  private async googleReverse(lat: number, lng: number) {
    const res = await this.http(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=fr&key=${this.key}`,
    );
    const addr: string | undefined = res.results?.[0]?.formatted_address;
    if (!addr) return null;
    const [label, ...rest] = addr.split(',').map((s) => s.trim());
    return { label, sublabel: rest.slice(0, 2).join(', ') };
  }

  private async osmReverse(lat: number, lng: number) {
    const res = await this.http(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=18&accept-language=fr`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res || res.error) return null;
    const a = res.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    return {
      label: res.name || street || String(res.display_name ?? '').split(',')[0],
      sublabel: [a.neighbourhood || a.suburb || a.quarter, a.city_district || a.city || a.town].filter(Boolean).join(', '),
    };
  }

  // ---------- Itinéraire ----------

  async route(a: LatLng, b: LatLng): Promise<Route> {
    const key = `route:${a.lat.toFixed(4)},${a.lng.toFixed(4)}:${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
    return this.cached(key, async () => {
      return (
        (this.key ? await this.safe(() => this.googleRoute(a, b), null) : null) ??
        (await this.safe(() => this.osrmRoute(a, b), null)) ??
        this.estimateRoute(a, b)
      );
    });
  }

  private async googleRoute(a: LatLng, b: LatLng): Promise<Route> {
    const res = await this.http('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
        destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
        travelMode: 'DRIVE',
      }),
    });
    const r = res.routes?.[0];
    if (!r) throw new Error('Aucun itinéraire Google');
    return {
      distanceKm: r.distanceMeters / 1000,
      durationMin: Math.ceil(parseInt(r.duration, 10) / 60),
      points: decodePolyline(r.polyline.encodedPolyline),
      source: 'google',
    };
  }

  private async osrmRoute(a: LatLng, b: LatLng): Promise<Route> {
    const res = await this.http(
      `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`,
      { headers: { 'User-Agent': UA } },
    );
    const r = res.routes?.[0];
    if (!r) throw new Error('Aucun itinéraire OSRM');
    return {
      distanceKm: r.distance / 1000,
      durationMin: Math.ceil(r.duration / 60),
      points: r.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]),
      source: 'osrm',
    };
  }

  /** Secours hors ligne : vol d'oiseau × 1,35, à 20 km/h de moyenne (trafic d'Abidjan) */
  estimateRoute(a: LatLng, b: LatLng): Route {
    const distanceKm = haversineKm(a.lat, a.lng, b.lat, b.lng) * 1.35;
    return {
      distanceKm,
      durationMin: Math.max(1, Math.ceil((distanceKm / 20) * 60)),
      points: [
        [a.lat, a.lng],
        [b.lat, b.lng],
      ],
      source: 'estimate',
    };
  }

  // ---------- Utilitaires ----------

  private dist(a: LatLng, p: Place) {
    return haversineKm(a.lat, a.lng, p.lat, p.lng);
  }

  private async http(url: string, init: RequestInit = {}) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url.split('?')[0]} → HTTP ${res.status}`);
    return res.json();
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.logger.warn((e as Error).message);
      return fallback;
    }
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const value = await fn();
    this.cache.set(key, value);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}

/** Décode une polyline Google en [lat, lng][] */
function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < str.length) {
    lat += next();
    lng += next();
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
