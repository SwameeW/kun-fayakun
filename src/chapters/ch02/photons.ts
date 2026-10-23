import { Color, type Node } from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  cos,
  exp,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  sqrt,
  uniform,
  vec3,
} from 'three/tsl';
import type { QualityTier } from '../../core/types';
import { createStreakField, type StreakField } from '../shared/streaks';

/**
 * Photons in the plasma, and their release at recombination.
 *
 * Before recombination light cannot travel freely: each photon scatters off free
 * electrons again and again, so it only jitters about on a short random walk
 * (straight flights between scattering points, computed analytically from
 * hashes, so any time can be shown exactly). When electrons join nuclei the
 * scattering stops: each photon carries on in a straight line along its last
 * flight, and keeps going. Release is staggered over several seconds, nearest
 * first, as the plasma itself clears; then the freed light reddens as space
 * stretches it and fades from sight. These are the photons of the cosmic
 * microwave background.
 */

const COUNT: Readonly<Record<QualityTier, number>> = { high: 40_000, mid: 18_000, low: 7_000 };
/** Photons fill a ball around the camera's opening position. */
const CLOUD_RADIUS = 7;
/** Spread of a photon's scattering points about its home (its walk never wanders far). */
const WALK_RADIUS = 0.17;
/** Seconds per straight flight between scatterings (randomised per photon). */
const FLIGHT_SECONDS = { min: 0.16, max: 0.4 } as const;
/** Free-streaming speed after release, world units per second. */
const STREAM_SPEED = 2.6;
/** Release spreads over this many seconds after recombination begins (nearest photons first). */
const RELEASE_SPREAD = 7;
/** Trail length in seconds of motion (a streak shows direction and speed). */
const TRAIL_SECONDS = { walking: 0.04, streaming: 0.09 } as const;
/** Width as a share of screen height (≈ 2.4 px at 1080p). */
const WIDTH = 0.0022;
/** Absorption per world unit the plasma applies to a photon seen through it (matches the medium). */
const ABSORPTION = 0.22;
/** Photons closer than this to the camera fade out, so none ever streaks across the lens. */
const NEAR_FADE = { from: 0.35, to: 1.1 } as const;
const BASE_COLOR = new Color(1.0, 0.86, 0.62);
const RED_COLOR = new Color(1.0, 0.26, 0.07);

export interface PhotonState {
  /** Chapter time in seconds (the walk is a pure function of it). */
  time: number;
  /** Chapter time at which release begins (the recombination cue). */
  release: number;
  /** Overall brightness 0..1. */
  brightness: number;
  /** Plasma density 0..1 the photons are seen through. */
  density: number;
  /** 0 = freshly released light, 1 = stretched far into the red (and faded). */
  redshift: number;
  reducedMotion: boolean;
}

export interface Photons {
  readonly field: StreakField;
  update(state: PhotonState): void;
  setTier(tier: QualityTier): void;
  dispose(): void;
}

/** A uniformly random point in the unit ball from three hashes. */
const ballPoint = Fn(([a, b, c]: [Node<'float'>, Node<'float'>, Node<'float'>]) => {
  const z = a.mul(2).sub(1);
  const phi = b.mul(Math.PI * 2);
  const ring = sqrt(max(float(0), float(1).sub(z.mul(z))));
  const radius = pow(c, 1 / 3);
  return vec3(ring.mul(cos(phi)), ring.mul(sin(phi)), z).mul(radius);
});

export function createPhotons(tier: QualityTier): Photons {
  const uTime = uniform(0);
  const uRelease = uniform(0);
  const uBrightness = uniform(0);
  const uDensity = uniform(1);
  const uPace = uniform(1);
  const uTrailWalk = uniform(TRAIL_SECONDS.walking as number);
  const uTrailStream = uniform(TRAIL_SECONDS.streaming as number);
  const uColor = uniform(BASE_COLOR.clone());

  const id = instanceIndex.toUint();
  const own = (c: number) => hash(id.mul(16).add(c));

  // Home in a ball around the opening camera position.
  const home = ballPoint(own(0), own(1), own(2)).mul(CLOUD_RADIUS);
  const flight = mix(float(FLIGHT_SECONDS.min), float(FLIGHT_SECONDS.max), own(3)).mul(uPace);
  const phase = own(4).mul(17);
  // Nearest photons are released first, as the plasma clears from the viewer outward.
  const nearness = length(home).div(CLOUD_RADIUS);
  const releaseAt = uRelease.add(nearness.mul(0.55).add(own(5).mul(0.45)).mul(RELEASE_SPREAD));

  const vertexAt = (k: Node<'float'>) => {
    const seed = id.mul(65_536).add(k.toUint().mul(4));
    return home.add(ballPoint(hash(seed), hash(seed.add(1)), hash(seed.add(2))).mul(WALK_RADIUS));
  };

  // Walk up to the release time, then stream straight along the last flight.
  const walkTime = min(uTime, releaseAt);
  const s = walkTime.div(flight).add(phase);
  const k = floor(s);
  const from = vertexAt(k);
  const to = vertexAt(k.add(1));
  const walked = mix(from, to, fract(s));
  const heading = normalize(to.sub(from).add(vec3(1e-5, 0, 0)));
  const streaming = max(float(0), uTime.sub(releaseAt));
  const head = walked.add(heading.mul(streaming.mul(STREAM_SPEED).div(uPace)));
  const freed = smoothstep(0, 0.4, streaming);
  const walkVelocity = to.sub(from).div(flight);
  const streamVelocity = heading.mul(float(STREAM_SPEED).div(uPace));
  const velocity = mix(walkVelocity, streamVelocity, freed);
  const tail = head.sub(velocity.mul(mix(uTrailWalk, uTrailStream, freed)));

  // Seen through the plasma: light from deeper inside is dimmed by the medium.
  const distance = length(head.sub(cameraPosition));
  const throughPlasma = exp(distance.mul(-ABSORPTION).mul(uDensity));
  const near = smoothstep(NEAR_FADE.from, NEAR_FADE.to, distance);
  // Released light thins out as it spreads far from the camera.
  const far = float(1).sub(smoothstep(CLOUD_RADIUS * 1.2, CLOUD_RADIUS * 3.2, distance));
  // Most photons faint, a few brilliant (a cubed uniform), so the plasma glitters rather than greys.
  const luck = own(6);
  const sparkle = luck.mul(luck).mul(luck).mul(5.5).add(0.3);
  const color = uColor.mul(uBrightness.mul(throughPlasma).mul(near).mul(far).mul(sparkle));

  const field = createStreakField({ name: 'ch02-photons', maxCount: COUNT.high, head, tail, color, width: float(WIDTH) });
  field.setCount(COUNT[tier]);
  const tint = new Color();

  return {
    field,
    update(state) {
      uTime.value = state.time;
      uRelease.value = state.release;
      uDensity.value = state.density;
      uPace.value = state.reducedMotion ? 1.6 : 1;
      // Reduced motion: round sparks, no trails.
      uTrailWalk.value = state.reducedMotion ? 0 : TRAIL_SECONDS.walking;
      uTrailStream.value = state.reducedMotion ? 0 : TRAIL_SECONDS.streaming;
      // Stretched light: white-gold → orange-red, fading as it passes beyond the visible.
      const r = Math.min(1, Math.max(0, state.redshift));
      tint.copy(BASE_COLOR).lerp(RED_COLOR, Math.min(1, r * 1.6));
      uColor.value.copy(tint);
      uBrightness.value = state.brightness * (1 - r) ** 1.5;
      field.mesh.visible = uBrightness.value > 1e-4;
    },
    setTier(t) {
      field.setCount(COUNT[t]);
    },
    dispose() {
      field.dispose();
    },
  };
}
