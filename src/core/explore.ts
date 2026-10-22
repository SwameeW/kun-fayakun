import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ChapterContent } from './types';

export type ExploreLimits = ChapterContent['explore'];

export interface ExploreController {
  readonly enabled: boolean;
  /** The point the camera orbits (and looks at) while exploring. */
  readonly target: Vector3;
  /** Starts orbiting from the current view; lookAt is what the camera looks at now. */
  enable(limits: ExploreLimits, lookAt: Vector3): void;
  disable(): void;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Key → [right, forward] direction, by physical key so non-QWERTY layouts work.
 * Esc and E belong to the UI's shortcuts (leave/enter explore), so only WASD is used here.
 */
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};

/** Movement speed as a fraction of the current orbit distance per second, so it suits any scale. */
const MOVE_SPEED = 0.6;
/** Time constant for easing into the chapter's explore target and distance limits (no snapping). */
const SETTLE_SECONDS = 0.6;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Free-explore camera: OrbitControls (mouse, touch) plus WASD movement. */
export function createExploreController(
  camera: PerspectiveCamera,
  element: HTMLElement,
  options: { gentle: () => boolean },
): ExploreController {
  const controls = new OrbitControls(camera, element);
  controls.enabled = false;
  controls.enablePan = true;

  const pressed = new Set<string>();
  const center = new Vector3();
  let limits: ExploreLimits | null = null;
  // The target eases toward the chapter's explore target until the user takes over.
  let settling = false;

  const forward = new Vector3();
  const right = new Vector3();
  const move = new Vector3();
  const offset = new Vector3();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!controls.enabled || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (e.code in MOVE_KEYS) {
      pressed.add(e.code);
      settling = false;
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    pressed.delete(e.code);
  };
  const onBlur = (): void => {
    pressed.clear();
  };
  const onStart = (): void => {
    settling = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  controls.addEventListener('start', onStart);

  /** Keeps the orbit target within maxDistance of the chapter's explore target. */
  const clampTarget = (): void => {
    if (!limits) return;
    offset.subVectors(controls.target, center);
    const excess = offset.length() - limits.maxDistance;
    if (excess > 0) {
      offset.setLength(excess);
      controls.target.sub(offset);
      camera.position.sub(offset);
    }
  };

  return {
    get enabled() {
      return controls.enabled;
    },
    get target() {
      return controls.target;
    },
    enable(next, lookAt) {
      limits = next;
      center.set(...next.target);
      controls.target.copy(lookAt);
      const distance = camera.position.distanceTo(lookAt);
      // Start from limits that contain the current view, then ease into the real ones.
      controls.minDistance = Math.min(next.minDistance, distance);
      controls.maxDistance = Math.max(next.maxDistance, distance);
      const gentle = options.gentle();
      controls.enableDamping = !gentle;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = gentle ? 0.5 : 0.9;
      controls.zoomSpeed = gentle ? 0.6 : 1;
      controls.panSpeed = gentle ? 0.6 : 1;
      settling = true;
      pressed.clear();
      controls.enabled = true;
      controls.update();
    },
    disable() {
      controls.enabled = false;
      pressed.clear();
      limits = null;
    },
    update(dt) {
      if (!controls.enabled || !limits) return;
      const k = 1 - Math.exp(-dt / SETTLE_SECONDS);
      controls.minDistance += (limits.minDistance - controls.minDistance) * k;
      controls.maxDistance += (limits.maxDistance - controls.maxDistance) * k;
      if (settling) controls.target.lerp(center, k);

      if (pressed.size > 0) {
        camera.getWorldDirection(forward);
        right.crossVectors(forward, camera.up).normalize();
        move.set(0, 0, 0);
        for (const code of pressed) {
          const dir = MOVE_KEYS[code];
          if (!dir) continue;
          move.addScaledVector(right, dir[0]).addScaledVector(forward, dir[1]);
        }
        if (move.lengthSq() > 0) {
          const distance = Math.max(limits.minDistance, camera.position.distanceTo(controls.target));
          move.setLength(distance * MOVE_SPEED * dt);
          camera.position.add(move);
          controls.target.add(move);
        }
      }
      clampTarget();
      controls.update(dt);
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      controls.removeEventListener('start', onStart);
      controls.dispose();
    },
  };
}
