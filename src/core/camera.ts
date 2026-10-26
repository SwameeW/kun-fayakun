import { Quaternion, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { ExploreController, ExploreLimits } from './explore';
import type { CameraKeyframe, Ease } from './types';

export const EASINGS: Readonly<Record<Ease, (x: number) => number>> = {
  linear: (x) => x,
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inOutCubic: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  outCubic: (x) => 1 - (1 - x) ** 3,
};

export const DEFAULT_FOV = 50;
export const NEAR = 0.05;
export const FAR = 5000;
const DEFAULT_POSITION = new Vector3(0, 0, 8);

/** Seconds to ease from the explore view back onto the cinematic path. */
const RETURN_SECONDS = 1.6;
const RETURN_SECONDS_GENTLE = 2.8;

export interface CameraPose {
  readonly position: Vector3;
  readonly target: Vector3;
  fov: number;
}

export const createPose = (): CameraPose => ({ position: DEFAULT_POSITION.clone(), target: new Vector3(), fov: DEFAULT_FOV });

function copyPose(out: CameraPose, from: CameraPose): CameraPose {
  out.position.copy(from.position);
  out.target.copy(from.target);
  out.fov = from.fov;
  return out;
}

/** Position xyz, target xyz, fov: every pose component is interpolated on its own. */
const COMPONENTS = 7;

/**
 * A keyframed camera path prepared for monotone cubic (PCHIP, Fritsch–Carlson)
 * interpolation of each pose component over time.
 *
 * Why: easing into and out of every key makes a multi-key move stop dead at each
 * one. A cubic spline keeps velocity continuous through intermediate keys, so the
 * camera glides; the monotone variant never overshoots a key (no swinging past a
 * framing), and a hold (two keys with equal values) gets zero slope, so moves still
 * ease into and out of holds and at the ends of the path. Keys at the same time are
 * a cut. The per-key `ease` is no longer needed and is ignored.
 */
export interface CameraPath {
  readonly times: readonly number[];
  readonly values: readonly (readonly number[])[];
  readonly slopes: readonly (readonly number[])[];
}

function keyValues(key: CameraKeyframe, fov: number): number[] {
  return [...key.position, ...key.target, fov];
}

/** Fritsch–Carlson slopes for one component; zero at path ends, at cuts and at turning points. */
function monotoneSlopes(times: readonly number[], ys: readonly number[]): number[] {
  const n = ys.length;
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    const h0 = (times[i] ?? 0) - (times[i - 1] ?? 0);
    const h1 = (times[i + 1] ?? 0) - (times[i] ?? 0);
    if (h0 <= 0 || h1 <= 0) continue;
    const d0 = ((ys[i] ?? 0) - (ys[i - 1] ?? 0)) / h0;
    const d1 = ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / h1;
    if (d0 * d1 <= 0) continue;
    const w0 = 2 * h1 + h0;
    const w1 = h1 + 2 * h0;
    m[i] = (w0 + w1) / (w0 / d0 + w1 / d1);
  }
  return m;
}

export function preparePath(keys: readonly CameraKeyframe[]): CameraPath {
  const sorted = keys.map((key, i) => ({ key, i })).sort((a, b) => a.key.t - b.key.t || a.i - b.i);
  let fov = sorted[0]?.key.fov ?? DEFAULT_FOV;
  const times: number[] = [];
  const values: number[][] = [];
  for (const { key } of sorted) {
    fov = key.fov ?? fov;
    times.push(key.t);
    values.push(keyValues(key, fov));
  }
  const slopes: number[][] = values.map(() => new Array<number>(COMPONENTS).fill(0));
  for (let c = 0; c < COMPONENTS; c += 1) {
    const m = monotoneSlopes(times, values.map((v) => v[c] ?? 0));
    m.forEach((slope, i) => {
      const row = slopes[i];
      if (row) row[c] = slope;
    });
  }
  return { times, values, slopes };
}

const sampled = new Array<number>(COMPONENTS).fill(0);

function writePose(out: CameraPose, v: readonly number[]): CameraPose {
  out.position.set(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  out.target.set(v[3] ?? 0, v[4] ?? 0, v[5] ?? 0);
  out.fov = v[6] ?? DEFAULT_FOV;
  return out;
}

/** Samples the path at t; holds the first key before it and the last after it. */
export function samplePath(path: CameraPath, t: number, out: CameraPose): CameraPose {
  const { times, values, slopes } = path;
  const n = times.length;
  const first = values[0];
  if (n === 0 || !first) {
    out.position.copy(DEFAULT_POSITION);
    out.target.set(0, 0, 0);
    out.fov = DEFAULT_FOV;
    return out;
  }
  if (t <= (times[0] ?? 0)) return writePose(out, first);
  // Last key at or before t (a cut resolves to the later of two equal times).
  let i = 0;
  while (i < n - 1 && (times[i + 1] ?? Infinity) <= t) i += 1;
  const a = values[i];
  const b = values[i + 1];
  if (!a || !b) return writePose(out, values[n - 1] ?? first);
  const t0 = times[i] ?? 0;
  const h = (times[i + 1] ?? t0) - t0;
  const ma = slopes[i];
  const mb = slopes[i + 1];
  if (h <= 0 || !ma || !mb) return writePose(out, b);
  // Cubic Hermite basis.
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  for (let c = 0; c < COMPONENTS; c += 1) {
    sampled[c] = h00 * (a[c] ?? 0) + h10 * h * (ma[c] ?? 0) + h01 * (b[c] ?? 0) + h11 * h * (mb[c] ?? 0);
  }
  return writePose(out, sampled);
}

/* ------------------------------------------------------------------ */
/* Living camera                                                       */
/* ------------------------------------------------------------------ */

/**
 * A very slow, almost subliminal float, as if the camera were held rather than
 * locked off: sums of incommensurate sines (periods of 12 to 31 s), scaled to the
 * viewing distance so it reads the same at every framing. Phase comes from the
 * cinematic clock, so pausing freezes it; reduced motion and explore mode turn it
 * off (eased, never stepped).
 */
const FLOAT = {
  /** Position sway as a fraction of the distance to the target. */
  sway: 0.0065,
  /** Look-point sway, smaller, so the frame breathes with a little parallax. */
  look: 0.0035,
  /** Roll in radians (about 0.17 degrees). */
  roll: 0.003,
  /** Seconds to ease the float in or out when it is switched. */
  ramp: 2,
} as const;

const TAU = Math.PI * 2;
function drift(t: number, f1: number, f2: number, phase: number): number {
  return 0.62 * Math.sin(TAU * f1 * t + phase) + 0.38 * Math.sin(TAU * f2 * t + phase * 1.7 + 1.3);
}

const right = new Vector3();
const upAxis = new Vector3();
const forward = new Vector3();
const rolled = new Quaternion();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Owns the camera: follows the chapter's keyframes in cinematic mode, hands
 * control to the explore controller in explore mode, and eases back onto the
 * path when explore ends.
 */
export class CameraDirector {
  private path: CameraPath = preparePath([]);
  private readonly onPath = createPose();
  private readonly from = createPose();
  private readonly pose = createPose();
  private returnLeft = 0;
  private returnTotal = 0;
  /** 0..1 strength of the living float, eased toward its goal (1 in cinematic mode, 0 otherwise). */
  private floatAmount = 0;
  private roll = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly explore: ExploreController,
    private readonly gentle: () => boolean,
  ) {}

  get exploring(): boolean {
    return this.explore.enabled;
  }

  /** New chapter (or none): resets lens defaults and snaps to the path at t. */
  setPath(keys: readonly CameraKeyframe[], t: number): void {
    this.path = preparePath(keys);
    this.explore.disable();
    this.returnLeft = 0;
    this.floatAmount = this.gentle() ? 0 : 1;
    this.resetLens();
    this.apply(this.addFloat(samplePath(this.path, t, this.onPath), t));
  }

  /** Lens defaults every chapter's enter() may rely on (also before a re-enter on seek). */
  resetLens(): void {
    this.camera.near = NEAR;
    this.camera.far = FAR;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
  }

  enterExplore(limits: ExploreLimits): void {
    if (this.explore.enabled) return;
    this.returnLeft = 0;
    // The orbit controls assume an upright camera; the float's roll is tiny, but clear it.
    this.camera.up.copy(WORLD_UP);
    this.explore.enable(limits, this.pose.target);
  }

  /** In Explore Mode: eases the free camera to the film's view at chapter time t (null: back to where exploring began). */
  focusFilmView(t: number | null): void {
    if (!this.explore.enabled) return;
    if (t === null) {
      this.explore.focus(null);
      return;
    }
    const pose = samplePath(this.path, t, this.from);
    this.explore.focus({ position: pose.position, target: pose.target, fov: pose.fov });
  }

  leaveExplore(): void {
    if (!this.explore.enabled) return;
    this.from.position.copy(this.camera.position);
    this.from.target.copy(this.explore.target);
    this.from.fov = this.camera.fov;
    this.explore.disable();
    this.returnTotal = this.gentle() ? RETURN_SECONDS_GENTLE : RETURN_SECONDS;
    this.returnLeft = this.returnTotal;
  }

  /** t = cinematic time; dt = real seconds (the return ease is user-initiated, so it runs while paused). */
  update(t: number, dt: number): void {
    const goal = this.explore.enabled || this.gentle() ? 0 : 1;
    const step = dt / FLOAT.ramp;
    this.floatAmount = goal > this.floatAmount ? Math.min(goal, this.floatAmount + step) : Math.max(goal, this.floatAmount - step);
    if (this.explore.enabled) {
      this.explore.update(dt);
      this.pose.position.copy(this.camera.position);
      this.pose.target.copy(this.explore.target);
      this.pose.fov = this.camera.fov;
      return;
    }
    this.addFloat(samplePath(this.path, t, this.onPath), t);
    if (this.returnLeft > 0) {
      this.returnLeft = Math.max(0, this.returnLeft - dt);
      const s = EASINGS.inOutCubic(1 - this.returnLeft / this.returnTotal);
      this.pose.position.lerpVectors(this.from.position, this.onPath.position, s);
      this.pose.target.lerpVectors(this.from.target, this.onPath.target, s);
      this.pose.fov = this.from.fov + (this.onPath.fov - this.from.fov) * s;
      this.apply(this.pose);
    } else {
      this.apply(this.onPath);
    }
  }

  /** Adds the living float to a sampled path pose (in place). */
  private addFloat(pose: CameraPose, t: number): CameraPose {
    const k = EASINGS.inOutSine(this.floatAmount);
    this.roll = 0;
    if (k <= 0) return pose;
    forward.subVectors(pose.target, pose.position);
    const distance = forward.length();
    if (distance < 1e-6) return pose;
    forward.divideScalar(distance);
    right.crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    upAxis.crossVectors(right, forward);
    const sway = FLOAT.sway * distance * k;
    const look = FLOAT.look * distance * k;
    pose.position.addScaledVector(right, sway * drift(t, 1 / 23, 1 / 13.7, 0.4)).addScaledVector(upAxis, sway * drift(t, 1 / 29, 1 / 17.3, 2.1));
    pose.target.addScaledVector(right, look * drift(t, 1 / 31, 1 / 19.1, 4.2)).addScaledVector(upAxis, look * drift(t, 1 / 27, 1 / 12.1, 5.3));
    this.roll = FLOAT.roll * k * drift(t, 1 / 37, 1 / 21.4, 1.1);
    return pose;
  }

  private apply(pose: CameraPose): void {
    if (pose !== this.pose) copyPose(this.pose, pose);
    this.camera.position.copy(pose.position);
    // Roll by turning the up vector about the view axis before lookAt.
    forward.subVectors(pose.target, pose.position).normalize();
    rolled.setFromAxisAngle(forward, this.roll);
    this.camera.up.copy(WORLD_UP).applyQuaternion(rolled);
    this.camera.lookAt(pose.target);
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
