/**
 * Pointer, touch, wheel and keyboard input for the explorer's camera, attached to the canvas only
 * while the explorer is on screen (and touch-action: none on it only then, restored after).
 *
 * Mouse: drag to orbit (or, in free flight, to look), right or middle drag (or Shift-drag) to pan,
 * wheel to zoom in log height, double-click a body to travel to it. Touch: one finger orbits, two
 * pinch (log zoom) and pan together, a double tap on a body travels there.
 * Keys, by physical code so other layouts work: W A S D fly forward, left, back and right, R and F
 * up and down, Q and E roll, Shift for five times the speed, arrows orbit (or look), + and - zoom,
 * O orbits the nearest body again, Esc stops a trip (a second Esc, with nothing to stop, goes on to
 * the interface and back to the film). Keys are ignored while typing in a field, inside a dialog
 * or in a widget that owns them (data-kf-keys="own"), and with Ctrl, Cmd or Alt held.
 *
 * Keyboard table (the film's shortcuts in the explorer): Space, the arrows' chapter steps, P and E
 * do nothing here (the film's handler finds no chapter), so E can roll and the arrows orbit; Esc is
 * shared as above; ? still opens the shortcuts list.
 */

import type { BodyId } from '../core/types';
import { km, type Km } from './space/origin';

/** Lines and pages in wheel deltas, as pixels. */
const LINE_PX = 16;
/** Log-height units per wheel pixel (a typical notch of 100 px zooms by about 16%). */
const WHEEL_LN_PER_PX = 0.0015;
/** A trackpad pinch arrives as Ctrl+wheel with small deltas: scaled up to feel like a pinch. */
const PINCH_WHEEL_SCALE = 6;
/** Two taps (or clicks) within this long and this far apart are a double tap; a tap moves less than TAP_PX. */
const DOUBLE = { ms: 340, px: 32 } as const;
const TAP_PX = 10;

const MOVE_KEYS: Readonly<Record<string, readonly [number, number, number]>> = {
  KeyW: [0, 0, 1],
  KeyS: [0, 0, -1],
  KeyA: [-1, 0, 0],
  KeyD: [1, 0, 0],
  KeyR: [0, 1, 0],
  KeyF: [0, -1, 0],
};
const ROLL_KEYS: Readonly<Record<string, number>> = { KeyQ: -1, KeyE: 1 };
const TURN_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};
const ZOOM_KEYS: Readonly<Record<string, number>> = {
  Equal: -1,
  NumpadAdd: -1,
  PageUp: -1,
  Minus: 1,
  NumpadSubtract: 1,
  PageDown: 1,
};
const BOOST_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

/** What the input steers (the explorer wires these to its navigator). */
export interface InputTarget {
  /** One pointer: orbit, or look in free flight. CSS px, x right, y down. */
  drag(dx: number, dy: number): void;
  /** Two fingers, or a right, middle or Shift drag: the view follows the pointer. */
  pan(dx: number, dy: number): void;
  /** Natural-log units of height, positive away. */
  zoom(dLn: number): void;
  orbitKeys(azimuth: number, elevation: number, zoom: number): void;
  flightKeys(move: Km, roll: number, boost: boolean): void;
  /** Esc: true when it stopped a trip (then nothing else hears it). */
  stop(): boolean;
  /** O: orbit the body the camera is near. */
  orbit(): void;
  /** The body under a point of the canvas (client px), or null. */
  pick(clientX: number, clientY: number): BodyId | null;
  /** A double tap or click on a body. */
  travel(body: BodyId): void;
}

export interface ExploreInput {
  attach(): void;
  detach(): void;
}

function ownedElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-kf-keys="own"], dialog[open]')) return true;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

interface Pointer {
  x: number;
  y: number;
  /** Where and when it went down, for taps. */
  x0: number;
  y0: number;
  t0: number;
  type: string;
  /** Pan with this pointer (right or middle mouse button, or Shift held at the start). */
  pan: boolean;
}

export function createInput(element: HTMLElement, target: InputTarget): ExploreInput {
  const pointers = new Map<number, Pointer>();
  const held = new Set<string>();
  let pinch = 0;
  let mid: { x: number; y: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let touchAction = '';
  const move = km();

  const twoTouches = (): [Pointer, Pointer] | null => {
    const touches = [...pointers.values()].filter((p) => p.type !== 'mouse');
    const [a, b] = touches;
    return a && b ? [a, b] : null;
  };

  const syncKeys = (): void => {
    let x = 0;
    let y = 0;
    let z = 0;
    let roll = 0;
    let azimuth = 0;
    let elevation = 0;
    let zoom = 0;
    for (const code of held) {
      const m = MOVE_KEYS[code];
      if (m) {
        x += m[0];
        y += m[1];
        z += m[2];
      }
      roll += ROLL_KEYS[code] ?? 0;
      const t = TURN_KEYS[code];
      if (t) {
        azimuth += t[0];
        elevation += t[1];
      }
      zoom += ZOOM_KEYS[code] ?? 0;
    }
    move.x = Math.sign(x);
    move.y = Math.sign(y);
    move.z = Math.sign(z);
    target.flightKeys(move, Math.sign(roll), [...held].some((code) => BOOST_KEYS.has(code)));
    target.orbitKeys(Math.sign(azimuth), Math.sign(elevation), Math.sign(zoom));
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const pan = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, type: e.pointerType, pan });
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      /* A synthetic pointer may not be capturable; moves still arrive. */
    }
    const two = twoTouches();
    if (two) {
      pinch = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      mid = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
    }
    if (e.pointerType === 'mouse' && e.button === 1) e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const two = twoTouches();
    if (two) {
      // Two fingers: the spread zooms, the midpoint pans (both at once, as on a map).
      const spread = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
      if (pinch > 0 && spread > 0) target.zoom(-Math.log(spread / pinch));
      pinch = spread;
      const m = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 };
      if (mid) target.pan(m.x - mid.x, m.y - mid.y);
      mid = m;
      return;
    }
    if (pointers.size !== 1) return;
    if (p.pan) target.pan(dx, dy);
    else target.drag(dx, dy);
  };

  const onPointerUp = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    const two = twoTouches();
    pinch = two ? Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) : 0;
    mid = two ? { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 } : null;
    if (!p || e.type === 'pointercancel' || pointers.size > 0) return;
    // A tap: little movement. Two in quick succession on a body travel there.
    if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > TAP_PX) {
      lastTap = null;
      return;
    }
    const now = e.timeStamp;
    if (lastTap && now - lastTap.t < DOUBLE.ms && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < DOUBLE.px) {
      lastTap = null;
      const body = target.pick(e.clientX, e.clientY);
      if (body) target.travel(body);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? element.clientHeight : 1;
    target.zoom(e.deltaY * unit * WHEEL_LN_PER_PX * (e.ctrlKey ? PINCH_WHEEL_SCALE : 1));
  };

  const onContextMenu = (e: Event): void => {
    // A right drag pans; no menu over the sky.
    e.preventDefault();
  };

  const known = (code: string): boolean => code in MOVE_KEYS || code in ROLL_KEYS || code in TURN_KEYS || code in ZOOM_KEYS || BOOST_KEYS.has(code);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || ownedElsewhere(e.target)) return;
    if (e.code === 'KeyO' && !e.repeat) {
      target.orbit();
      e.preventDefault();
      return;
    }
    if (!known(e.code)) return;
    held.add(e.code);
    syncKeys();
    // Shift alone is left to the page (it may start a selection or a shortcut).
    if (!BOOST_KEYS.has(e.code)) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (held.delete(e.code)) syncKeys();
  };

  /** Esc first stops a trip; only when there is none does it go on to the interface. */
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || ownedElsewhere(e.target)) return;
    if (target.stop()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onBlur = (): void => {
    held.clear();
    pointers.clear();
    pinch = 0;
    mid = null;
    syncKeys();
  };

  let attached = false;
  return {
    attach() {
      if (attached) return;
      attached = true;
      touchAction = element.style.touchAction;
      element.style.touchAction = 'none';
      element.addEventListener('pointerdown', onPointerDown);
      element.addEventListener('pointermove', onPointerMove);
      element.addEventListener('pointerup', onPointerUp);
      element.addEventListener('pointercancel', onPointerUp);
      element.addEventListener('wheel', onWheel, { passive: false });
      element.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('keydown', onEscape, true);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    },
    detach() {
      if (!attached) return;
      attached = false;
      element.style.touchAction = touchAction;
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerUp);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      onBlur();
    },
  };
}
