/**
 * Typed access to assets/planets/planets.json, written by scripts/planets (docs/CONTRACTS.md):
 * finds a body's texture for a detail tier and loads it through the engine's KTX2 loader with
 * the sampler state the manifest documents. Exploration only; nothing in the film imports it.
 */
import { ClampToEdgeWrapping, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, type Texture } from 'three/webgpu';
import type { AssetLoader } from '../../core/types';

export const PLANETS_MANIFEST_URL = 'assets/planets/planets.json';

/** Published detail tiers. Ultra (8192) is built locally and not in the manifest's files. */
export type PlanetTier = 'low' | 'medium' | 'high';
export type PlanetBody = 'earth' | 'moon' | 'jupiter' | 'saturn';
export type PlanetMap = 'day' | 'night' | 'clouds' | 'water' | 'normal' | 'colour' | 'rings';

export interface PlanetCredit {
  sourceId: string;
  credit: string;
}

/** One file of planets.json (one map at one tier). */
export interface PlanetTexture extends PlanetCredit {
  body: PlanetBody;
  map: PlanetMap;
  tier: PlanetTier;
  /** Site path, straight into AssetLoader.ktx2. */
  path: string;
  width: number;
  height: number;
  levels: number;
  codec: 'etc1s' | 'uastc' | 'r8' | 'rgba8';
  colorSpace: 'srgb' | 'linear';
  bytes: number;
  sha256: string;
  /** u of east longitude 0, and the direction east longitude grows; null for the ring strip. */
  uAtLon0: number | null;
  lonIncreases: 'left' | 'right' | null;
  latitude: string | null;
  /** Always true: the first stored row is the south pole, so v = 0 is south (use as loaded). */
  rowsBottomUp: true;
  alsoFrom?: PlanetCredit[];
  /** Normal maps: the factor their relief was exaggerated by. */
  reliefExaggeration?: number;
  /** Ring strip: the radius (km from Saturn's centre) at u = 0 and u = 1. */
  radiusKm?: [number, number];
}

export interface PlanetsManifest {
  schema: number;
  tiers: Record<PlanetTier | 'ultra', { width: number; bytes: number; budgetBytes: number; published: boolean }>;
  files: PlanetTexture[];
  /** Per body: captions and conventions (as written by scripts/planets/manifest.py). */
  bodies?: Partial<Record<PlanetBody, { caption?: string }>>;
  facts?: {
    saturnRings?: {
      /** The geometry the ring strip's colour was measured in (the PIA11142 mosaic's lit face). */
      colourModel?: { viewElevationDeg: number; sunElevationDeg: number };
    };
  };
}

/**
 * The ring strip's colour is a thick ring's lit face as the PIA11142 mosaic shows it, seen from 10
 * degrees below the rings with the Sun 4 degrees below them, at 28 degrees phase (planets.json
 * facts.saturnRings.observation.colour gives the phase in words; colourModel the elevations).
 */
export const RING_MOSAIC_PHASE_DEG = 28;

/** The geometry the ring strip's colour was measured in: |sin| of the Sun's and the view's elevations and the phase angle. */
export function ringColourGeometry(manifest: PlanetsManifest): { mu0: number; mu: number; phaseRad: number } {
  const model = manifest.facts?.saturnRings?.colourModel;
  const sunDeg = model?.sunElevationDeg ?? -4.04;
  const viewDeg = model?.viewElevationDeg ?? 10;
  const rad = Math.PI / 180;
  return { mu0: Math.abs(Math.sin(sunDeg * rad)), mu: Math.abs(Math.sin(viewDeg * rad)), phaseRad: RING_MOSAIC_PHASE_DEG * rad };
}

export function findPlanetTexture(manifest: PlanetsManifest, body: PlanetBody, map: PlanetMap, tier: PlanetTier): PlanetTexture | undefined {
  return manifest.files.find((f) => f.body === body && f.map === map && f.tier === tier);
}

/** Texture coordinates of a place (east longitude and latitude in degrees, in the map's own latitude convention). */
export function planetUv(texture: PlanetTexture, eastLonDeg: number, latDeg: number): [number, number] {
  if (texture.uAtLon0 === null) throw new Error(`${texture.path} is not a longitude-latitude map`);
  const sign = texture.lonIncreases === 'left' ? -1 : 1;
  const u = (((texture.uAtLon0 + (sign * eastLonDeg) / 360) % 1) + 1) % 1;
  return [u, 0.5 + latDeg / 180];
}

/** u of a ring radius (km from Saturn's centre) on the ring strip. */
export function ringU(texture: PlanetTexture, radiusKm: number): number {
  if (!texture.radiusKm) throw new Error(`${texture.path} is not the ring strip`);
  const [inner, outer] = texture.radiusKm;
  return (radiusKm - inner) / (outer - inner);
}

/**
 * Loads one texture and sets what planets.json asks for: longitude wraps, latitude (and the
 * ring radius) clamps, trilinear filtering. Raw r8/rgba8 files arrive from KTX2Loader as
 * DataTextures with nearest filtering, so the filters are always set here.
 */
export async function loadPlanetTexture(assets: AssetLoader, texture: PlanetTexture): Promise<Texture> {
  const loaded = await assets.ktx2(texture.path);
  loaded.wrapS = texture.map === 'rings' ? ClampToEdgeWrapping : RepeatWrapping;
  loaded.wrapT = ClampToEdgeWrapping;
  loaded.minFilter = texture.levels > 1 ? LinearMipmapLinearFilter : LinearFilter;
  loaded.magFilter = LinearFilter;
  loaded.generateMipmaps = false;
  loaded.needsUpdate = true;
  return loaded;
}

/** The distinct credit lines of some textures, in order, for an info card or caption. */
export function planetCredits(textures: readonly PlanetTexture[]): string[] {
  const lines = textures.flatMap((t) => [t.credit, ...(t.alsoFrom ?? []).map((a) => a.credit)]);
  return [...new Set(lines)];
}
