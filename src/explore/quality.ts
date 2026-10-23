/**
 * The explorer's quality governance over the detail ladder (./detail: Ultra, High, Medium, Low).
 * Pure (no DOM, no three.js), so unit tests drive it with synthetic frame-time traces.
 *
 * Where it starts. From what the device says about itself: a phone or tablet starts Low (Medium for
 * an Apple GPU on WebGPU), a software renderer Low, a desktop whose adapter is hidden (Brave's
 * Shields blank it) or that runs WebGL2 or an integrated GPU Medium, other desktop WebGPU High.
 * Ultra is never chosen automatically: a visitor may opt into it, on a WebGPU device that is not a
 * software renderer or a phone and takes textures of 8192 px.
 *
 * What it watches. The frame's duration against the display's own rate (learned, so a 30 Hz-capped
 * display is not read as load). That is all the shipped page gives it: GPU time per frame exists
 * only where the page measures it with timestamp queries (?gpuTime=1, or ?profile=1, which also
 * holds everything still), and then the governor judges GPU time instead. Frames are judged in
 * half-second buckets by their mean, each frame counted at most two display intervals: a display
 * paced to vsync reports a GPU-bound page as whole intervals (16.7 or 33.3 ms), and a bucket where
 * one frame in three misses its vsync (45 fps) must read as slow, which a median would hide while
 * half the frames still make it. Counting a frame as at most one missed vsync keeps a single hitch
 * (or a short burst) from deciding anything, and stalls over 0.25 s (a tab switch, a compile) are
 * left out altogether. Nothing is judged for 2 s after the tier changes or a texture is uploaded
 * (holdOff).
 *
 * What it does. Slow frames first cost resolution: the scene renders at a lower internal scale (the
 * screen's own resolution untouched), in steps down to the tier's floor (minRenderScale); only slow
 * frames at the floor drop a tier. Comfortable frames win the resolution back. After 20 s stable at
 * full resolution it may try the tier above (never Ultra); a try that runs slow is undone and the
 * tier is not tried again for 20 s, longer after each failure, and after three failures not again
 * this visit (a device that cannot run it is not shown the switch over and over). On a phone, a
 * slowdown after a long stable spell is read as heat (thermal throttling): it steps down as usual
 * and does not try upward again for minutes.
 *
 * A visitor's own choice (the quality menu's Ultra, High, Medium or Low) is kept: the governor then
 * never changes the tier, only the internal resolution. A tier fixed by the address (?detail=,
 * ?tier=, ?profile=1) holds everything still.
 */

import { createFrameCadence, STALL_SECONDS } from '../core/cadence';
import { EXPLORE_TIERS, type ExploreTier } from './detail';

/* ------------------------------------------------------------------ */
/* Where it starts                                                      */
/* ------------------------------------------------------------------ */

/** What the device says about itself. */
export interface DeviceInfo {
  backend: 'webgpu' | 'webgl2';
  /** Lower-case adapter description; '' when the browser hides it (Brave's Shields, older browsers). */
  description: string;
  /** A software rasteriser or a WebGPU fallback adapter. */
  software: boolean;
  /** A phone or tablet. */
  mobile: boolean;
  /** The largest 2D texture the device takes, px (0 when unknown). */
  maxTextureSize: number;
}

/** GPUs that are integrated with the CPU (and so start at Medium even on WebGPU). Apple silicon counts as High. */
const INTEGRATED_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr|vega \d+ graphics|radeon\(tm\) graphics/;
/** Ultra streams 8192 px textures. */
const ULTRA_TEXTURE = 8192;

const rank = (tier: ExploreTier): number => EXPLORE_TIERS.length - 1 - EXPLORE_TIERS.indexOf(tier);
const byRank = (r: number): ExploreTier => EXPLORE_TIERS[EXPLORE_TIERS.length - 1 - r] ?? 'low';

/** Ultra may be chosen here: WebGPU, a real GPU, not a phone, and room for 8192 px textures. */
export function ultraAllowed(device: DeviceInfo): boolean {
  return device.backend === 'webgpu' && !device.software && !device.mobile && device.maxTextureSize >= ULTRA_TEXTURE;
}

/** The tiers a visitor may choose on this device, highest first. */
export function availableTiers(device: DeviceInfo): ExploreTier[] {
  return EXPLORE_TIERS.filter((tier) => tier !== 'ultra' || ultraAllowed(device));
}

/** The tier the explorer starts at on its own (never Ultra). */
export function initialTier(device: DeviceInfo): ExploreTier {
  if (device.software) return 'low';
  if (device.mobile) return device.backend === 'webgpu' && /apple/.test(device.description) ? 'medium' : 'low';
  if (device.description.trim() === '') return 'medium';
  if (device.backend === 'webgl2') return 'medium';
  if (INTEGRATED_GPU.test(device.description)) return 'medium';
  return 'high';
}

/* ------------------------------------------------------------------ */
/* Governor                                                             */
/* ------------------------------------------------------------------ */

export const GOVERNOR = {
  /** Frames are judged in buckets this long, by their mean load. */
  bucketSeconds: 0.5,
  /** Each frame counts at most this many display intervals in a bucket's mean (one missed vsync). */
  frameCap: 2,
  /** Frame time (as a multiple of the display's interval) above which a bucket is slow; below which it is comfortable. */
  slowFrame: 1.2,
  comfortableFrame: 1.06,
  /** GPU time (as a share of the interval) above which a bucket is slow; below which comfortable; below which a tier above may fit. */
  slowGpu: 0.9,
  comfortableGpu: 0.72,
  headroomGpu: 0.48,
  /** Consecutive slow buckets before a step down (scale, or the tier at the floor). */
  slowBuckets: 2,
  /** Render scale steps (down: a third fewer pixels), and the wait after a step down before the next can be taken. */
  scaleDown: 0.82,
  scaleUp: 1.08,
  stepCooldown: 1,
  /** Comfortable time before the scale steps back up, and before a tier above is tried. */
  scaleUpAfter: 5,
  tierUpAfter: 20,
  /** A try upward (scale or tier) is judged over this long once its hold-off has passed. */
  probeSeconds: 3,
  /** After a failed try upward: nothing upward for this long, doubled for each further failure, up to the cap. */
  lockSeconds: 20,
  maxLockSeconds: 320,
  /** A tier whose tries failed this many times is not tried again this visit. */
  maxTierFailures: 3,
  /** Nothing is judged for this long after a tier change, a texture upload or entering. */
  holdOffSeconds: 2,
  /** The scale a tier starts at after a drop (the cheaper tier usually has room to climb back). */
  afterDrop: 0.8,
  /** Mobile heat: a slowdown after this long stable locks upward tries for this long. */
  thermalStableSeconds: 30,
  thermalLockSeconds: 180,
} as const;

export type DetailChoice = 'auto' | ExploreTier;

export interface GovernorOptions {
  /** The tier to start at. */
  tier: ExploreTier;
  /** 'auto', or a tier the visitor chose (kept: only the resolution adapts). */
  choice: DetailChoice;
  /** False holds everything still (a tier fixed by the address, profiling, the manual test clock). */
  enabled: boolean;
  /** Tiers this device may run. */
  available: readonly ExploreTier[];
  /** Each tier's lowest render scale. */
  minScale: Readonly<Record<ExploreTier, number>>;
  mobile: boolean;
}

export interface GovernorDecision {
  /** A new tier to run (apply its detail); the scale is also given. */
  tier?: ExploreTier;
  /** A new internal render scale (0..1). */
  scale?: number;
  /** Why, for logs and tests. */
  reason: 'slow' | 'comfortable' | 'probe' | 'probe-failed' | 'choice';
}

export interface DetailGovernor {
  readonly tier: ExploreTier;
  readonly scale: number;
  readonly choice: DetailChoice;
  /**
   * Feeds one frame: its real duration (s), its GPU time (ms) when measured, and the display's
   * frame interval (s) when the caller knows it better (the engine learns it from every frame since
   * the page opened, light ones included); else the governor learns it from the frames it sees.
   */
  sample(frameSeconds: number, gpuMs?: number | null, intervalSeconds?: number | null): GovernorDecision | null;
  /** Nothing is judged for a while (a tier change, a texture upload, entering). */
  holdOff(seconds?: number): void;
  /** The visitor's choice: 'auto', or a tier to keep. Returns what to apply (a tier, and a scale back to full). */
  choose(choice: DetailChoice): GovernorDecision | null;
}

export function createDetailGovernor(options: GovernorOptions): DetailGovernor {
  const cadence = createFrameCadence();
  const available = options.available.length > 0 ? options.available : (['low'] as const);
  const ceiling = available.filter((t) => t !== 'ultra')[0] ?? 'low';
  let choice: DetailChoice = options.choice;
  let tier: ExploreTier = choice === 'auto' ? options.tier : choice;
  let scale = 1;
  let hold: number = GOVERNOR.holdOffSeconds;
  // Judging buckets.
  let bucket: number[] = [];
  let bucketTime = 0;
  let slowRun = 0;
  let cooldown = 0;
  let comfortableFor = 0;
  let stableFor = 0;
  // Tries upward: the state to return to, how long it is judged, and the locks after failures.
  let probe: { tier: ExploreTier; scale: number; left: number } | null = null;
  let scaleLock = 0;
  let tierLock = 0;
  let scaleFailures = 0;
  const tierFailures = new Map<ExploreTier, number>();
  /** The last bucket was judged on GPU time, and had room for the tier above. */
  let judgedOnGpu = false;
  let gpuHeadroom = false;
  /** How long frames had been steady when the current slowdown began (heat shows as a slowdown after a long steady spell). */
  let steadyBeforeSlowdown = 0;
  let lastVerdict: 'slow' | 'comfortable' | 'ok' = 'ok';

  const minScale = (t: ExploreTier): number => options.minScale[t];
  const lower = (t: ExploreTier): ExploreTier | null => {
    const r = rank(t);
    for (let i = r - 1; i >= 0; i--) {
      const candidate = byRank(i);
      if (available.includes(candidate)) return candidate;
    }
    return null;
  };
  const higher = (t: ExploreTier): ExploreTier | null => {
    const r = rank(t);
    for (let i = r + 1; i <= rank(ceiling); i++) {
      const candidate = byRank(i);
      if (available.includes(candidate)) return candidate;
    }
    return null;
  };
  const lockFor = (failures: number): number => Math.min(GOVERNOR.maxLockSeconds, GOVERNOR.lockSeconds * 2 ** Math.max(0, failures - 1));
  const resetJudging = (): void => {
    bucket = [];
    bucketTime = 0;
    slowRun = 0;
    comfortableFor = 0;
  };
  /** The bucket's load: its frames' mean, each counted at most GOVERNOR.frameCap intervals. */
  const bucketLoad = (values: readonly number[]): number => {
    let sum = 0;
    for (const v of values) sum += Math.min(GOVERNOR.frameCap, v);
    return values.length > 0 ? sum / values.length : 0;
  };

  const judge = (load: number, gpu: boolean): 'slow' | 'comfortable' | 'ok' => {
    if (gpu) return load > GOVERNOR.slowGpu ? 'slow' : load < GOVERNOR.comfortableGpu ? 'comfortable' : 'ok';
    return load > GOVERNOR.slowFrame ? 'slow' : load < GOVERNOR.comfortableFrame ? 'comfortable' : 'ok';
  };

  /** One bucket judged: returns a decision, or null. */
  const decide = (verdict: 'slow' | 'comfortable' | 'ok', seconds: number): GovernorDecision | null => {
    cooldown = Math.max(0, cooldown - seconds);
    scaleLock = Math.max(0, scaleLock - seconds);
    tierLock = Math.max(0, tierLock - seconds);
    if (verdict === 'slow' && lastVerdict !== 'slow' && stableFor > 0) steadyBeforeSlowdown = stableFor;
    if (verdict === 'comfortable' && stableFor >= GOVERNOR.scaleUpAfter) steadyBeforeSlowdown = 0;
    lastVerdict = verdict;
    if (verdict === 'slow') {
      slowRun += 1;
      comfortableFor = 0;
    } else {
      slowRun = 0;
      comfortableFor = verdict === 'comfortable' ? comfortableFor + seconds : 0;
    }

    // A try upward is judged first: slow inside its window undoes it.
    if (probe) {
      if (verdict === 'slow' && slowRun >= GOVERNOR.slowBuckets) {
        const back = probe;
        probe = null;
        const triedTier = back.tier !== tier;
        if (triedTier) {
          const failures = (tierFailures.get(tier) ?? 0) + 1;
          tierFailures.set(tier, failures);
          tierLock = Math.max(tierLock, lockFor(failures));
        } else {
          scaleFailures += 1;
          scaleLock = Math.max(scaleLock, lockFor(scaleFailures));
        }
        tier = back.tier;
        scale = back.scale;
        cooldown = GOVERNOR.stepCooldown;
        stableFor = 0;
        resetJudging();
        if (triedTier) hold = GOVERNOR.holdOffSeconds;
        return triedTier ? { tier, scale, reason: 'probe-failed' } : { scale, reason: 'probe-failed' };
      }
      probe.left -= seconds;
      if (probe.left <= 0) {
        // The try held: it is the new normal.
        const triedTier = probe.tier !== tier;
        if (triedTier) tierFailures.delete(tier);
        else scaleFailures = 0;
        probe = null;
      }
      return null;
    }

    stableFor = verdict === 'slow' ? 0 : stableFor + seconds;

    if (slowRun >= GOVERNOR.slowBuckets && cooldown <= 0) {
      slowRun = 0;
      cooldown = GOVERNOR.stepCooldown;
      if (scale > minScale(tier) + 1e-9) {
        scale = Math.max(minScale(tier), scale * GOVERNOR.scaleDown);
        return { scale, reason: 'slow' };
      }
      const next = choice === 'auto' ? lower(tier) : null;
      if (!next) return null;
      // A phone slowing after a long steady spell is heat: no tries upward for minutes.
      if (options.mobile && steadyBeforeSlowdown >= GOVERNOR.thermalStableSeconds) tierLock = Math.max(tierLock, GOVERNOR.thermalLockSeconds);
      steadyBeforeSlowdown = 0;
      tier = next;
      scale = Math.max(minScale(tier), GOVERNOR.afterDrop);
      hold = GOVERNOR.holdOffSeconds;
      stableFor = 0;
      resetJudging();
      return { tier, scale, reason: 'slow' };
    }

    if (verdict !== 'comfortable') return null;
    if (scale < 1 && comfortableFor >= GOVERNOR.scaleUpAfter && scaleLock <= 0) {
      probe = { tier, scale, left: GOVERNOR.probeSeconds };
      scale = Math.min(1, scale * GOVERNOR.scaleUp);
      comfortableFor = 0;
      return { scale, reason: 'comfortable' };
    }
    const above = choice === 'auto' ? higher(tier) : null;
    // A tier that has failed its tries too often is left alone for the rest of the visit.
    const up = above && (tierFailures.get(above) ?? 0) < GOVERNOR.maxTierFailures ? above : null;
    if (scale >= 1 && up && stableFor >= GOVERNOR.tierUpAfter && comfortableFor >= GOVERNOR.tierUpAfter && tierLock <= 0) {
      // With GPU timings, only when the tier above should fit; without, a try.
      if (judgedOnGpu && !gpuHeadroom) return null;
      probe = { tier, scale, left: GOVERNOR.probeSeconds };
      tier = up;
      comfortableFor = 0;
      stableFor = 0;
      hold = GOVERNOR.holdOffSeconds;
      resetJudging();
      return { tier, scale, reason: 'probe' };
    }
    return null;
  };

  return {
    get tier() {
      return tier;
    },
    get scale() {
      return scale;
    },
    get choice() {
      return choice;
    },
    sample(frameSeconds, gpuMs, intervalSeconds) {
      if (!(frameSeconds > 0) || frameSeconds > STALL_SECONDS) return null;
      cadence.sample(frameSeconds);
      if (!options.enabled) return null;
      if (hold > 0) {
        hold -= frameSeconds;
        return null;
      }
      const gpu = typeof gpuMs === 'number' && gpuMs > 0 && Number.isFinite(gpuMs) ? gpuMs : null;
      judgedOnGpu = gpu !== null;
      const interval = typeof intervalSeconds === 'number' && intervalSeconds > 0 ? intervalSeconds : cadence.interval;
      bucket.push(gpu !== null ? gpu / 1000 / interval : frameSeconds / interval);
      bucketTime += frameSeconds;
      if (bucketTime < GOVERNOR.bucketSeconds) return null;
      const load = bucketLoad(bucket);
      gpuHeadroom = gpu !== null && load < GOVERNOR.headroomGpu;
      const seconds = bucketTime;
      bucket = [];
      bucketTime = 0;
      return decide(judge(load, gpu !== null), seconds);
    },
    holdOff(seconds = GOVERNOR.holdOffSeconds) {
      hold = Math.max(hold, seconds);
      resetJudging();
    },
    choose(next) {
      if (next !== 'auto' && !available.includes(next)) return null;
      choice = next;
      probe = null;
      tierFailures.clear();
      tierLock = 0;
      scaleLock = 0;
      scaleFailures = 0;
      stableFor = 0;
      resetJudging();
      hold = GOVERNOR.holdOffSeconds;
      const target = next === 'auto' ? tier : next;
      const changed = target !== tier;
      tier = target;
      scale = 1;
      return changed ? { tier, scale, reason: 'choice' } : { scale, reason: 'choice' };
    },
  };
}
