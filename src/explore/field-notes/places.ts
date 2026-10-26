/**
 * The world's notable places (public/assets/places/places.json, from Natural Earth by
 * scripts/places/build.py): for the explorer's place search, and for the field notes' "near" (the
 * place nearest a point on the ground). Loaded once, when first asked for, and shared by both.
 */

export interface Place {
  name: string;
  lat: number;
  lon: number;
  population: number;
}

export const PLACES_URL = 'assets/places/places.json';

const DEG = Math.PI / 180;

/** The places in a places.json (largest first, as the builder sorts them); malformed rows are skipped. */
export function parsePlaces(json: unknown): Place[] {
  const rows: unknown = typeof json === 'object' && json !== null ? (json as { places?: unknown }).places : undefined;
  if (!Array.isArray(rows)) return [];
  const out: Place[] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    const [name, lat, lon, population] = row as unknown[];
    if (typeof name !== 'string' || typeof lat !== 'number' || typeof lon !== 'number' || typeof population !== 'number') continue;
    out.push({ name, lat, lon, population });
  }
  return out;
}

let loading: Promise<Place[]> | null = null;

/** The places, fetched the first time (an empty list if they cannot be: search then finds nothing). */
export function loadPlaces(assets: { json<T>(path: string): Promise<T> }): Promise<Place[]> {
  loading ??= assets
    .json<unknown>(PLACES_URL)
    .then(parsePlaces)
    .catch((err: unknown) => {
      console.warn('explore: places could not be loaded', err);
      loading = null;
      return [];
    });
  return loading;
}

/** The angle between two points on a sphere (radians), from their latitudes and longitudes (degrees). */
export function centralAngle(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The place nearest a point, and how far it is over the ground (km, on a sphere of `radiusKm`). */
export function nearestPlace(places: readonly Place[], lat: number, lon: number, radiusKm: number): { place: Place; km: number } | null {
  let best: Place | null = null;
  let bestAngle = Number.POSITIVE_INFINITY;
  for (const p of places) {
    const a = centralAngle(lat, lon, p.lat, p.lon);
    if (a < bestAngle) {
      bestAngle = a;
      best = p;
    }
  }
  return best ? { place: best, km: bestAngle * radiusKm } : null;
}

/** Folds case and accents, so "sao paulo" finds São Paulo and "zurich" Zürich. */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Places whose names match a query: names that start with it first, then names with a word that
 * starts with it, then names containing it; within each, the larger first. At most `limit`.
 */
export function searchPlaces(places: readonly Place[], query: string, limit = 8): Place[] {
  const q = fold(query);
  if (q === '') return [];
  const starts: Place[] = [];
  const words: Place[] = [];
  const contains: Place[] = [];
  for (const p of places) {
    const n = fold(p.name);
    const at = n.indexOf(q);
    if (at < 0) continue;
    if (at === 0) starts.push(p);
    else if (/[\s\-'(]/u.test(n[at - 1] ?? '')) words.push(p);
    else contains.push(p);
  }
  return [...starts, ...words, ...contains].slice(0, limit);
}
