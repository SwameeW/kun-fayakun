/**
 * The explorer's bodies, each its own shader built on the explorer's own noise volume (never the
 * chapters' objects or materials), at unit radius: the explorer scales each one to its true
 * radius (times the scaled-space factor) every frame and turns it as the body really stands.
 *
 * Surfaces are procedural and illustrative until the mission maps arrive (Stage 7): the Earth's
 * continents are not the real ones, and the giants' belts, zones and storms are drawn after their
 * general look, not measured. Sizes, shapes (flattening), tilts, spins, phases, lighting and the
 * rings' structure (the Cassini occultation profile) are real.
 */

import type { Data3DTexture, Group } from 'three/webgpu';
import type { BodyId } from '../../core/types';
import { FILM_TIER, type ExploreDetail } from '../detail';
import type { BodySpec } from '../system';
import { createEarth, type ExploreEarth } from './earth';
import { createGiant, jupiterSurface, saturnSurface, type ExploreGiant } from './giant';
import { createMoon, type ExploreMoon } from './moon';
import { createProfileTexture, type ProfileTexture, type RingProfileData } from './rings';
import type { Tier } from './shading';
import { createSun, type ExploreSun } from './sun';

/** The Sun's effective temperature, as Chapter 7 uses it (its colour, from the blackbody law). */
export const SUN_KELVIN = 5772;

export interface Bodies {
  readonly sun: ExploreSun;
  readonly earth: ExploreEarth;
  readonly moon: ExploreMoon;
  readonly jupiter: ExploreGiant;
  readonly saturn: ExploreGiant;
  /** Every body's root object, by id. */
  readonly objects: Readonly<Record<BodyId, Group>>;
  setTier(tier: Tier): void;
  /**
   * Applies an explorer detail level (../detail). Until the bodies read the whole ExploreDetail
   * (meshes, maps, atmosphere steps), this maps it onto their three shader tiers (FILM_TIER).
   */
  setDetail(detail: ExploreDetail): void;
  dispose(): void;
}

export function createBodies(noise: Data3DTexture, specs: Readonly<Record<BodyId, BodySpec>>, rings: RingProfileData, tier: Tier): Bodies {
  const polar = (spec: BodySpec): number => spec.polarKm / spec.radiusKm;
  const profile: ProfileTexture = createProfileTexture(rings);
  const sun = createSun(noise, tier);
  const earth = createEarth(noise, tier);
  const moon = createMoon(noise, tier);
  const jupiter = createGiant({ name: 'explore-jupiter', polar: polar(specs.jupiter), surface: jupiterSurface(noise) }, tier);
  const radius = specs.saturn.radiusKm;
  const saturn = createGiant(
    {
      name: 'explore-saturn',
      polar: polar(specs.saturn),
      surface: saturnSurface(noise),
      rings: { profile, inner: rings.innerKm / radius, outer: rings.outerKm / radius },
    },
    tier,
  );
  const all = [sun, earth, moon, jupiter, saturn];
  return {
    sun,
    earth,
    moon,
    jupiter,
    saturn,
    objects: { sun: sun.object, earth: earth.object, moon: moon.object, jupiter: jupiter.object, saturn: saturn.object },
    setTier(next) {
      for (const body of all) body.setTier(next);
    },
    setDetail(detail) {
      for (const body of all) body.setTier(FILM_TIER[detail.tier]);
    },
    dispose() {
      for (const body of all) body.dispose();
      profile.dispose();
    },
  };
}
