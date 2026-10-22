import { RenderPipeline, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { ExposureControl } from './types';

/* ------------------------------------------------------------------ */
/* Render pipeline                                                     */
/* ------------------------------------------------------------------ */

export interface PostPipeline {
  /** Renders the scene through the pipeline; the only render call in the app. */
  render(): void;
  setBloom(enabled: boolean): void;
  dispose(): void;
}

/** Soft bloom for light sources; the threshold keeps ordinary surfaces out of it. */
const BLOOM = { strength: 0.45, radius: 0.35, threshold: 0.75 } as const;

/**
 * scene pass (HDR, half float) → optional TSL bloom → tone mapping (ACES) and
 * sRGB output. Exposure is renderer.toneMappingExposure, which the pipeline's
 * output transform reads every frame.
 */
export function createPostPipeline(renderer: WebGPURenderer, scene: Scene, camera: Camera, options: { bloom: boolean }): PostPipeline {
  const pipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  let bloomNode: ReturnType<typeof bloom> | null = null;

  const build = (withBloom: boolean): void => {
    bloomNode?.dispose();
    bloomNode = withBloom ? bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold) : null;
    pipeline.outputNode = bloomNode ? color.add(bloomNode) : color;
    pipeline.needsUpdate = true;
  };
  build(options.bloom);

  return {
    render() {
      pipeline.render();
    },
    setBloom(enabled) {
      if (enabled !== (bloomNode !== null)) build(enabled);
    },
    dispose() {
      bloomNode?.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exposure (flash safety)                                             */
/* ------------------------------------------------------------------ */

export interface EngineExposure extends ExposureControl {
  /** Engine-only multiplier for fades between chapters (0 = black). */
  setFade(value: number): void;
  /** Resets the chapter's target to neutral before a chapter enters. */
  resetTarget(): void;
  setReducedMotion(on: boolean): void;
  /** True once the applied exposure is effectively black. */
  readonly dark: boolean;
  update(dt: number): void;
}

/**
 * Why these numbers: the limiter works on true log2 exposure. Under three's
 * ACES curve, displayed luminance changes by at most ~0.25 per stop, so a WCAG
 * "flash" (a pair of opposing luminance changes of at least 0.1) needs at
 * least ~0.4 stops each way. Rising at <= 1.4 stops/s and falling at <= 6
 * stops/s, one such pair takes at least 0.4/1.4 + 0.4/6 ≈ 0.35 s, so exposure
 * stays under 3 flashes per second (about 2.8 at worst) whatever a chapter
 * asks for. Reduced motion slows both rates to 75% and, because it must allow
 * no flashes at all (crossfades only), also makes the exposure hold still for
 * REDUCED_MOTION_REVERSAL_HOLD seconds before it may turn round: a rise and a
 * fall can then never pair up inside one second.
 */
const RISE_STOPS_PER_SECOND = 1.4;
const FALL_STOPS_PER_SECOND = 6;
const REDUCED_MOTION_SCALE = 0.75;
const REDUCED_MOTION_REVERSAL_HOLD = 1;
/** Exponential approach inside the slew limit, so ramps start and end softly. */
const SMOOTHING_SECONDS = 0.35;
/**
 * Below 2^-8 the image is treated as black: stepping between 0 and the floor
 * changes luminance by under 0.03 even for scene radiance 16 (well above anything
 * a chapter should emit), so the log scale can stop there.
 */
const FLOOR_STOPS = -8;
const MAX_EXPOSURE = 16;
/** Dark enough to swap chapters unseen. */
const DARK_STOPS = -6;
const SNAP_STOPS = 0.005;

export function createExposureControl(options: { reducedMotion: boolean }): EngineExposure {
  let target = 1;
  let fade = 0;
  let reduced = options.reducedMotion;
  let u = FLOOR_STOPS;
  let current = 0;
  /** Direction of the last change (+1 brighter, -1 darker, 0 none yet) and seconds held still since. */
  let lastDirection = 0;
  let still = Infinity;

  return {
    get current() {
      return current;
    },
    get dark() {
      return u <= DARK_STOPS;
    },
    setTarget(value) {
      target = Number.isFinite(value) ? Math.min(MAX_EXPOSURE, Math.max(0, value)) : 1;
    },
    setFade(value) {
      fade = Math.min(1, Math.max(0, value));
    },
    resetTarget() {
      target = 1;
    },
    setReducedMotion(on) {
      reduced = on;
    },
    update(dt) {
      if (dt <= 0) return;
      const goal = target * fade;
      const goalU = Math.max(FLOOR_STOPS, Math.log2(Math.max(goal, Number.MIN_VALUE)));
      const scale = reduced ? REDUCED_MOTION_SCALE : 1;
      const step = (goalU - u) * (1 - Math.exp(-dt / SMOOTHING_SECONDS));
      let next = u + Math.min(RISE_STOPS_PER_SECOND * scale * dt, Math.max(-FALL_STOPS_PER_SECOND * scale * dt, step));
      if (Math.abs(goalU - next) < SNAP_STOPS) next = goalU;
      const direction = Math.sign(next - u);
      if (reduced && direction !== 0 && direction === -lastDirection && still < REDUCED_MOTION_REVERSAL_HOLD) next = u;
      if (next === u) {
        still += dt;
      } else {
        lastDirection = direction;
        still = 0;
      }
      u = next;
      current = u <= FLOOR_STOPS ? 0 : 2 ** u;
    },
  };
}
