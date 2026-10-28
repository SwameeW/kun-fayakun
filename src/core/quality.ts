import { createFrameCadence } from './cadence';
import type { BackendName, GpuInfo } from './renderer';
import { QUALITY_PROFILES, type QualityProfile, type QualityTier } from './types';

/* ------------------------------------------------------------------ */
/* Initial tier                                                        */
/* ------------------------------------------------------------------ */

export interface TierInput {
  backend: BackendName;
  gpu: Pick<GpuInfo, 'description' | 'software'>;
  override: QualityTier | null;
}

/** Integrated GPUs that should start at mid even on WebGPU. Apple Silicon counts as high. */
const INTEGRATED_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr|vega \d+ graphics|radeon\(tm\) graphics/;

/** A phone or tablet: the only pointer is coarse, or the UA says mobile. (The explorer's detail starts from it too.) */
export function isMobileDevice(): boolean {
  const coarseOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
  const uaMobile = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true;
  return coarseOnly || uaMobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function chooseInitialTier(input: TierInput): { profile: QualityProfile; reason: 'initial' | 'override' } {
  if (input.override) return { profile: QUALITY_PROFILES[input.override], reason: 'override' };
  let tier: QualityTier;
  if (isMobileDevice() || input.gpu.software) tier = 'low';
  else if (input.backend === 'webgl2') tier = 'mid';
  else if (/apple/.test(input.gpu.description)) tier = 'high';
  else if (INTEGRATED_GPU.test(input.gpu.description)) tier = 'mid';
  else tier = 'high';
  return { profile: QUALITY_PROFILES[tier], reason: 'initial' };
}

/* ------------------------------------------------------------------ */
/* Governor                                                            */
/* ------------------------------------------------------------------ */

/**
 * Mean frame time above this multiple of the display's cadence counts as slow: 20 ms at
 * 60 Hz, 40 ms when rAF is capped at 30 Hz (where 33 ms frames are as fast as it goes).
 */
const SLOW_FRAME = 1.2;
/** Frame times are averaged over buckets this long, so one hitch cannot decide anything. */
const BUCKET = 0.5;
/** Consecutive slow buckets before dropping a tier: frames stayed slow for 2 s. */
const SLOW_BUCKETS = 4;
/** Ignore this long after a chapter loads or the tier changes (shader compiles, uploads). */
const GRACE = 3;
/** Frames longer than this are stalls (tab switch, GC), not sustained load. */
const STALL = 0.5;

const LOWER: Readonly<Record<QualityTier, QualityTier | null>> = { high: 'mid', mid: 'low', low: null };

export interface QualityGovernor {
  /** Feeds one frame's real duration; returns the new profile when it drops a tier. */
  sample(frameSeconds: number): QualityProfile | null;
  /** Starts a grace period (call when a chapter has been entered). */
  holdOff(): void;
  /** Stops sampling (e.g. while loading); holdOff() resumes it. */
  suspend(): void;
}

/**
 * Drops one tier when frame time stays above 20 ms (at 60 Hz) for 2 s; never upgrades mid-session.
 * While `held()` is true (a render budget: another load shares the GPU) every sample is ignored.
 */
export function createQualityGovernor(initial: QualityProfile, options: { enabled: boolean; held?: () => boolean }): QualityGovernor {
  let tier = initial.tier;
  let grace = GRACE;
  let suspended = false;
  let bucketTime = 0;
  let bucketFrames = 0;
  let slowBuckets = 0;
  const cadence = createFrameCadence();

  const restart = (): void => {
    grace = GRACE;
    bucketTime = 0;
    bucketFrames = 0;
    slowBuckets = 0;
  };

  return {
    sample(dt) {
      if (!options.enabled) return null;
      // Learned even while suspended: loading frames are light and show the display's real rate.
      cadence.sample(dt);
      if (suspended || options.held?.() || dt <= 0 || dt > STALL) return null;
      if (grace > 0) {
        grace -= dt;
        return null;
      }
      bucketTime += dt;
      bucketFrames += 1;
      if (bucketTime < BUCKET) return null;
      slowBuckets = bucketTime / bucketFrames > SLOW_FRAME * cadence.interval ? slowBuckets + 1 : 0;
      bucketTime = 0;
      bucketFrames = 0;
      if (slowBuckets < SLOW_BUCKETS) return null;
      const lower = LOWER[tier];
      restart();
      if (!lower) return null;
      tier = lower;
      return QUALITY_PROFILES[lower];
    },
    holdOff() {
      suspended = false;
      restart();
    },
    suspend() {
      suspended = true;
    },
  };
}
