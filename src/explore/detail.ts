import type { QualityTier } from '../core/types';
import type { PlanetTier } from './assets/planets';

/**
 * The explorer's detail ladder: Ultra, High, Medium and Low. It is separate from the film's
 * three quality tiers (QualityTier), which twelve chapter tables key on exhaustively; the
 * explorer maps onto them only where it shares film code (FILM_TIER).
 *
 * This file is the contract between the two halves of the explorer: the bodies read an
 * ExploreDetail to decide what to draw and which textures to stream (setDetail), and the
 * quality governance decides which tier runs and at what render scale. Neither half changes
 * the presets' meaning without the other.
 */

export type ExploreTier = 'ultra' | 'high' | 'medium' | 'low';

export const EXPLORE_TIERS: readonly ExploreTier[] = ['ultra', 'high', 'medium', 'low'];

export interface ExploreDetail {
  readonly tier: ExploreTier;
  /** Widest planet texture to stream. Published files stop at 4096; 8192 needs the locally built Ultra set. */
  readonly maxTexture: 1024 | 2048 | 4096 | 8192;
  /** Atmosphere model: an analytic chord-length glow, or single scattering through a transmittance table. */
  readonly atmosphere: 'chord' | 'scatter';
  /** View-ray steps of the scattering model (ignored by 'chord'). */
  readonly atmosphereSteps: number;
  /** Globe tessellation (segments around the equator; also the cube-sphere face resolution where used). */
  readonly sphereSegments: number;
  readonly clouds: boolean;
  /** Clouds cast shadows on the ground (one extra texture tap). */
  readonly cloudShadows: boolean;
  /** City lights on Earth's night side ("today" Earth only; never in the chapters' early Earths). */
  readonly nightLights: boolean;
  /** Relief from normal maps. */
  readonly normalMaps: boolean;
  /** Saturn's rings: the radial strip only, or with close-range particle detail. */
  readonly ringDetail: 'strip' | 'particles';
  /** The Sun: granulation and limb only, or with prominences and a layered corona. */
  readonly sunDetail: 'basic' | 'full';
  readonly bloom: boolean;
  /** Device-pixel-ratio ceiling for the canvas. */
  readonly dprCap: number;
  /** Stars in the backdrop. */
  readonly starCount: number;
  /** Lowest internal render scale the governor may use before it drops a tier. */
  readonly minRenderScale: number;
}

export const DETAIL: Readonly<Record<ExploreTier, ExploreDetail>> = {
  ultra: {
    tier: 'ultra', maxTexture: 8192, atmosphere: 'scatter', atmosphereSteps: 16, sphereSegments: 256, clouds: true, cloudShadows: true,
    nightLights: true, normalMaps: true, ringDetail: 'particles', sunDetail: 'full', bloom: true, dprCap: 2, starCount: 20_000, minRenderScale: 0.6,
  },
  high: {
    tier: 'high', maxTexture: 4096, atmosphere: 'scatter', atmosphereSteps: 12, sphereSegments: 192, clouds: true, cloudShadows: true,
    nightLights: true, normalMaps: true, ringDetail: 'particles', sunDetail: 'full', bloom: true, dprCap: 2, starCount: 12_000, minRenderScale: 0.6,
  },
  medium: {
    tier: 'medium', maxTexture: 2048, atmosphere: 'scatter', atmosphereSteps: 8, sphereSegments: 128, clouds: true, cloudShadows: false,
    nightLights: true, normalMaps: true, ringDetail: 'strip', sunDetail: 'basic', bloom: true, dprCap: 1.5, starCount: 7000, minRenderScale: 0.6,
  },
  low: {
    tier: 'low', maxTexture: 1024, atmosphere: 'chord', atmosphereSteps: 0, sphereSegments: 64, clouds: true, cloudShadows: false,
    nightLights: false, normalMaps: false, ringDetail: 'strip', sunDetail: 'basic', bloom: false, dprCap: 1.5, starCount: 3500, minRenderScale: 0.55,
  },
};

/** The film tier whose shared code paths (bloom, star counts in shared modules) match an explorer tier. */
export const FILM_TIER: Readonly<Record<ExploreTier, QualityTier>> = { ultra: 'high', high: 'high', medium: 'mid', low: 'low' };

/** The published texture tier to stream for a detail level (Ultra streams High until an Ultra set is hosted). */
export function textureTier(detail: ExploreDetail): PlanetTier {
  if (detail.maxTexture >= 4096) return 'high';
  return detail.maxTexture >= 2048 ? 'medium' : 'low';
}
