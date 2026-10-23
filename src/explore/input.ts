/**
 * Pointer, wheel and keyboard input for the explorer's orbiting camera, attached to the canvas only
 * while the explorer is on screen.
 *
 * One pointer drags the view around the body; two pinch to zoom (in log distance, so a pinch means
 * the same at any scale); the wheel zooms. Keys: arrows or W A S D turn around the body, + and -
 * (or Page Up and Page Down) zoom. Keys are read by physical code, so other layouts work, and are
 * ignored while typing in a field or when a widget owns them. Esc belongs to the UI (back to the film).
 */

import type { Navigator } from './navigation';

/** Radians per CSS pixel of drag. */
const DRAG_RADIANS_PER_PX = 0.0055;
/** Log-distance units per wheel pixel (a typical notch of 100 px zooms by about 16%). */
const WHEEL_LN_PER_PX = 0.0015;
/** Lines and pages in wheel deltas, as pixels. */
const LINE_PX = 16;

const TURN_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [1, 0],
  KeyA: [1, 0],
  ArrowRight: [-1, 0],
  KeyD: [-1, 0],
  ArrowUp: [0, 1],
  KeyW: [0, 1],
  ArrowDown: [0, -1],
  KeyS: [0, -1],
};
const ZOOM_KEYS: Readonly<Record<string, number>> = {
  Equal: -1,
  NumpadAdd: -1,
  PageUp: -1,
  Minus: 1,
  NumpadSubtract: 1,
  PageDown: 1,
};

function ownedElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-kf-keys="own"], dialog[open]')) return true;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export interface ExploreInput {
  attach(): void;
  detach(): void;
}

export function createInput(element: HTMLElement, nav: Navigator): ExploreInput {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const held = new Set<string>();

  const spread = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const syncKeys = (): void => {
    let azimuth = 0;
    let elevation = 0;
    let zoom = 0;
    for (const code of held) {
      const turn = TURN_KEYS[code];
      if (turn) {
        azimuth += turn[0];
        elevation += turn[1];
      }
      zoom += ZOOM_KEYS[code] ?? 0;
    }
    nav.setKeyRates(Math.sign(azimuth), Math.sign(elevation), Math.sign(zoom));
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    element.setPointerCapture(e.pointerId);
    if (pointers.size === 2) pinch = spread();
  };
  const onPointerMove = (e: PointerEvent): void => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last.x = e.clientX;
    last.y = e.clientY;
    if (pointers.size === 1) {
      nav.rotate(-dx * DRAG_RADIANS_PER_PX, dy * DRAG_RADIANS_PER_PX);
    } else if (pointers.size === 2) {
      const now = spread();
      if (pinch > 0 && now > 0) nav.zoom(-Math.log(now / pinch));
      pinch = now;
    }
  };
  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    pinch = pointers.size === 2 ? spread() : 0;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? element.clientHeight : 1;
    nav.zoom(e.deltaY * unit * WHEEL_LN_PER_PX);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || ownedElsewhere(e.target)) return;
    if (!(e.code in TURN_KEYS) && !(e.code in ZOOM_KEYS)) return;
    held.add(e.code);
    syncKeys();
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (held.delete(e.code)) syncKeys();
  };
  const onBlur = (): void => {
    held.clear();
    pointers.clear();
    pinch = 0;
    syncKeys();
  };

  let attached = false;
  return {
    attach() {
      if (attached) return;
      attached = true;
      element.addEventListener('pointerdown', onPointerDown);
      element.addEventListener('pointermove', onPointerMove);
      element.addEventListener('pointerup', onPointerUp);
      element.addEventListener('pointercancel', onPointerUp);
      element.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    },
    detach() {
      if (!attached) return;
      attached = false;
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      onBlur();
    },
  };
}
