import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ChapterContent } from './types';

export type ExploreLimits = Pick<ChapterContent['explore'], 'target' | 'minDistance' | 'maxDistance'>;

/** A view to ease the free camera to: where it stands, what it looks at, its field of view. */
export interface ExploreView {
  position: Vector3;
  target: Vector3;
  fov: number;
}

export interface ExploreController {
  readonly enabled: boolean;
  /** The point the camera orbits (and looks at) while exploring. */
  readonly target: Vector3;
  /** Starts orbiting from the current view; lookAt is what the camera looks at now. */
  enable(limits: ExploreLimits, lookAt: Vector3): void;
  /**
   * Eases to a view (a moment's, from the film's camera path): the orbit then centres on its target,
   * within limits wide enough for it. Instant when motion should be gentle. null: back to where the
   * visitor was before the first moment they visited (or where Explore Mode began), with the limits then.
   */
  focus(view: ExploreView | null): void;
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
/** Time constant for easing to a moment's view. */
const FOCUS_SECONDS = 0.45;

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
  /** The chapter's own limits and the view Explore Mode began from, for focus(null). */
  let home: { limits: ExploreLimits; view: ExploreView } | null = null;
  /** A view being eased to (cleared when the visitor takes the camera). */
  let goal: ExploreView | null = null;
  /** Where the visitor was, with the limits then, before the first moment was visited: focus(null) goes back there. */
  let before: { view: ExploreView; limits: ExploreLimits } | null = null;
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
    goal = null;
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
      goal = null;
      home = { limits: next, view: { position: camera.position.clone(), target: lookAt.clone(), fov: camera.fov } };
      before = null;
      pressed.clear();
      controls.enabled = true;
      controls.update();
    },
    focus(view) {
      if (!controls.enabled || !home || !limits) return;
      if (view && !before) before = { view: { position: camera.position.clone(), target: controls.target.clone(), fov: camera.fov }, limits };
      const back = view ? null : (before ?? { view: home.view, limits: home.limits });
      if (!view) before = null;
      const to = view ?? back?.view ?? home.view;
      const distance = to.position.distanceTo(to.target);
      // Centred on the view's target, with room for its distance; back where the visitor was, with the limits then.
      limits = view
        ? { target: [to.target.x, to.target.y, to.target.z], minDistance: Math.min(home.limits.minDistance, distance * 0.25), maxDistance: Math.max(home.limits.maxDistance, distance * 2) }
        : (back?.limits ?? home.limits);
      center.set(...limits.target);
      controls.minDistance = Math.min(controls.minDistance, limits.minDistance);
      controls.maxDistance = Math.max(controls.maxDistance, limits.maxDistance, distance);
      settling = false;
      pressed.clear();
      if (options.gentle()) {
        camera.position.copy(to.position);
        controls.target.copy(to.target);
        camera.fov = to.fov;
        camera.updateProjectionMatrix();
        goal = null;
      } else goal = { position: to.position.clone(), target: to.target.clone(), fov: to.fov };
      controls.update();
    },
    disable() {
      controls.enabled = false;
      pressed.clear();
      limits = null;
      home = null;
      goal = null;
      before = null;
    },
    update(dt) {
      if (!controls.enabled || !limits) return;
      const k = 1 - Math.exp(-dt / SETTLE_SECONDS);
      controls.minDistance += (limits.minDistance - controls.minDistance) * k;
      controls.maxDistance += (limits.maxDistance - controls.maxDistance) * k;
      if (settling) controls.target.lerp(center, k);
      if (goal) {
        // Easing to a moment's view; close enough, and it is the visitor's again.
        const g = 1 - Math.exp(-dt / FOCUS_SECONDS);
        camera.position.lerp(goal.position, g);
        controls.target.lerp(goal.target, g);
        camera.fov += (goal.fov - camera.fov) * g;
        camera.updateProjectionMatrix();
        if (camera.position.distanceTo(goal.position) < 1e-3 * Math.max(1, goal.position.length())) goal = null;
      }

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
