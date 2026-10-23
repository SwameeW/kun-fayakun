import { RenderPipeline, type Camera, type Node, type Scene, type WebGPURenderer } from 'three/webgpu';
import {
  dot,
  float,
  hash,
  length,
  pass,
  renderOutput,
  screenCoordinate,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { ExposureControl } from './types';

/* ------------------------------------------------------------------ */
/* Render pipeline                                                     */
/* ------------------------------------------------------------------ */

export interface PostPipeline {
  /** Renders the scene through the pipeline; the only render call in the app. */
  render(): void;
  setBloom(enabled: boolean): void;
  /**
   * Film grain changes each frame only while the film plays; paused or with reduced
   * motion it holds still (WCAG 2.2.2: nothing moves on its own while paused).
   */
  advanceGrain(): void;
  dispose(): void;
}

/** Soft bloom for light sources; the threshold keeps ordinary surfaces out of it. */
const BLOOM = { strength: 0.5, radius: 0.5, threshold: 0.75 } as const;

/**
 * Optical vignette, applied to linear light before tone mapping as a real lens
 * would: a gentle fall-off toward the corners (25% at the corners of a 16:9
 * frame) that draws the eye inward without a visible ring.
 */
const VIGNETTE = { inner: 0.4, outer: 1.1, depth: 0.25 } as const;

/**
 * Film grain and dither, in display space after tone mapping. Night-sky imagery
 * is mostly dark gradients, which band badly at 8 bits; a triangular dither of
 * ±1 code value removes the bands, and a fine grain (strongest in the shadows
 * and mid-tones, as in film) gives the frame a photographic texture. Both fade
 * out toward pure black, so darkness stays truly dark.
 */
const GRAIN = { amount: 0.013, dither: 1 / 255, blackEnd: 0.04 } as const;

/** Luminance weights of linear sRGB / Rec. 709. */
const LUMA = vec3(0.2126, 0.7152, 0.0722);

function vignette(hdr: Node<'vec3'>): Node<'vec3'> {
  const aspect = screenSize.x.div(screenSize.y);
  const r = length(screenUV.sub(0.5).mul(vec2(aspect, 1)).mul(2));
  const fall = smoothstep(VIGNETTE.inner, VIGNETTE.outer, r);
  return hdr.mul(float(1).sub(fall.mul(fall).mul(VIGNETTE.depth)));
}

function grain(display: Node<'vec3'>, seed: Node<'float'>): Node<'vec3'> {
  // Hashed white noise per pixel and frame: two independent samples summed give
  // triangular noise in [-1, 1]. (Interleaved gradient noise is better for jitter
  // that a filter later averages, but on its own its diagonal structure shows.)
  const p = screenCoordinate.xy.floor();
  const pixel = p.x.add(p.y.mul(8192)).toUint();
  const frame = seed.toUint().mul(0x9e3779b1);
  const n1 = hash(pixel.add(frame));
  const n2 = hash(pixel.mul(3).add(frame).add(0x68e31da4));
  const tpdf = n1.add(n2).sub(1);
  const luma = dot(display, LUMA);
  const presence = smoothstep(0, GRAIN.blackEnd, luma);
  // Film grain peaks in the shadows and lower mid-tones and thins toward white.
  const amount = presence.mul(float(GRAIN.amount).mul(float(1).sub(luma).mul(0.7).add(0.3)).add(GRAIN.dither));
  return display.add(tpdf.mul(amount));
}

/**
 * scene pass (HDR, half float) → TSL bloom (optional) → vignette (linear light)
 * → tone mapping (ACES) and sRGB output → dither and film grain. Exposure is
 * renderer.toneMappingExposure, which renderOutput reads every frame.
 */
export function createPostPipeline(renderer: WebGPURenderer, scene: Scene, camera: Camera, options: { bloom: boolean }): PostPipeline {
  const pipeline = new RenderPipeline(renderer);
  // We tone-map ourselves so grain and dither can be added after it, in display space.
  pipeline.outputColorTransform = false;
  const scenePass = pass(scene, camera);
  const color = scenePass.getTextureNode('output');
  const seed = uniform(0);
  let bloomNode: ReturnType<typeof bloom> | null = null;

  const build = (withBloom: boolean): void => {
    bloomNode?.dispose();
    bloomNode = withBloom ? bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold) : null;
    const hdr = bloomNode ? color.rgb.add(bloomNode.rgb) : color.rgb;
    const display = renderOutput(vec4(vignette(hdr), 1));
    pipeline.outputNode = vec4(grain(display.rgb, seed), 1);
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
    advanceGrain() {
      // Wraps long before float precision matters; the pattern has no visible period.
      seed.value = (seed.value + 1) % 4096;
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
/**
 * Seven stops above neutral: room for the solar-system explorer's adaptation to sunlight (Saturn gets
 * about 1.1% of the Earth's), which it asks for gradually like any target. Chapters ask for 1 or less.
 */
const MAX_EXPOSURE = 128;
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
