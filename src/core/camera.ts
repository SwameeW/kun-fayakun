import { Vector3, type PerspectiveCamera } from 'three/webgpu';
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
const scratch = new Vector3();

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

function setFromKey(out: CameraPose, key: CameraKeyframe, fov: number): CameraPose {
  out.position.set(...key.position);
  out.target.set(...key.target);
  out.fov = fov;
  return out;
}

interface PathKey {
  key: CameraKeyframe;
  /** fov carried forward from earlier keys when a key leaves it out. */
  fov: number;
}

/**
 * Samples a keyframed path at t, easing into each key with that key's ease.
 * Holds the first key before it and the last after it. With `gentle`
 * (reduced motion) every segment uses inOutSine: no abrupt starts or stops.
 */
export function samplePath(path: readonly PathKey[], t: number, gentle: boolean, out: CameraPose): CameraPose {
  const first = path[0];
  if (!first) {
    out.position.copy(DEFAULT_POSITION);
    out.target.set(0, 0, 0);
    out.fov = DEFAULT_FOV;
    return out;
  }
  if (t <= first.key.t) return setFromKey(out, first.key, first.fov);
  for (let i = 1; i < path.length; i += 1) {
    const b = path[i];
    const a = path[i - 1];
    if (!a || !b || t > b.key.t) continue;
    const span = b.key.t - a.key.t;
    // Keys at the same time are a cut.
    if (span <= 0) return setFromKey(out, b.key, b.fov);
    const ease = EASINGS[gentle ? 'inOutSine' : (b.key.ease ?? 'inOutSine')];
    const s = ease((t - a.key.t) / span);
    out.position.set(...a.key.position).lerp(scratch.set(...b.key.position), s);
    out.target.set(...a.key.target).lerp(scratch.set(...b.key.target), s);
    out.fov = a.fov + (b.fov - a.fov) * s;
    return out;
  }
  const last = path[path.length - 1] ?? first;
  return setFromKey(out, last.key, last.fov);
}

function toPath(keys: readonly CameraKeyframe[]): PathKey[] {
  const sorted = keys.map((key, i) => ({ key, i })).sort((a, b) => a.key.t - b.key.t || a.i - b.i);
  let fov = sorted[0]?.key.fov ?? DEFAULT_FOV;
  return sorted.map(({ key }) => {
    fov = key.fov ?? fov;
    return { key, fov };
  });
}

/**
 * Owns the camera: follows the chapter's keyframes in cinematic mode, hands
 * control to the explore controller in explore mode, and eases back onto the
 * path when explore ends.
 */
export class CameraDirector {
  private path: PathKey[] = [];
  private readonly onPath = createPose();
  private readonly from = createPose();
  private readonly pose = createPose();
  private returnLeft = 0;
  private returnTotal = 0;

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
    this.path = toPath(keys);
    this.explore.disable();
    this.returnLeft = 0;
    this.resetLens();
    this.apply(samplePath(this.path, t, this.gentle(), this.onPath));
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
    this.explore.enable(limits, this.pose.target);
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
    if (this.explore.enabled) {
      this.explore.update(dt);
      this.pose.position.copy(this.camera.position);
      this.pose.target.copy(this.explore.target);
      this.pose.fov = this.camera.fov;
      return;
    }
    samplePath(this.path, t, this.gentle(), this.onPath);
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

  private apply(pose: CameraPose): void {
    if (pose !== this.pose) copyPose(this.pose, pose);
    this.camera.position.copy(pose.position);
    this.camera.lookAt(pose.target);
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
