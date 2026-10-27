/**
 * Pointer, touch, wheel and keyboard input for the explorer's camera, attached to the canvas only
 * while the explorer is on screen (and touch-action: none on it only then, restored after).
 *
 * Mouse: drag to orbit (or, in free flight, to look), right or middle drag (or Shift-drag) to pan,
 * wheel to zoom in log height, double-click a body to travel to it. Touch: one finger orbits, two
 * pinch (log zoom) and pan together, a double tap on a body travels there. Something under the
 * pointer may take a drag instead of the camera (the laboratory's velocity arrow, by its tip: grab),
 * follow a hovering mouse (a placing preview: hover) or take a tap (placing a body: tap).
 * Keys, by physical code so other layouts work: W A S D fly forward, left, back and right, R and F
 * up and down, Q and E roll, Shift for five times the speed, arrows orbit (or look), + and - zoom,
 * O orbits the nearest body again, Esc stops a trip (a second Esc, with nothing to stop, goes on to
 * the interface and back to the film; a held Esc's repeats go nowhere). Keys are ignored while typing
 * in a field, inside a dialog or in a widget that owns them (data-kf-keys="own"), and with Ctrl, Cmd
 * or Alt held.
 *
 * On foot (the target's onFoot, from what is shown: not while the camera still waits in orbit for the
 * ground): on the ground Space jumps (the page's play key is left alone then, except on a focused
 * button or link, which Space presses); there and on the way down through an air, a click on the view
 * (a mouse's, without a drag) locks the pointer for mouse-look until Esc (the browser's own key for
 * it) lets it go. On the way down Space stays the page's play key (a descent has no jump). On the
 * ground V held rides the rover.
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
  // Up on foot only: a jump (elsewhere Space is the page's play key).
  Space: [0, 1, 0],
};
/** Mouse-look's turn per pixel moved, as a share of a drag's (a locked pointer reports raw movement). */
const LOCKED_LOOK = 0.7;
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
/** On foot, V held rides the rover. */
const RIDE_KEY = 'KeyV';

/** What the input steers (the explorer wires these to its navigator). */
export interface InputTarget {
  /** One pointer: orbit, or look in free flight. CSS px, x right, y down. */
  drag(dx: number, dy: number): void;
  /** Two fingers, or a right, middle or Shift drag: the view follows the pointer. */
  pan(dx: number, dy: number): void;
  /** Natural-log units of height, positive away. */
  zoom(dLn: number): void;
  orbitKeys(azimuth: number, elevation: number, zoom: number): void;
  /** Moves (W A S D, R F, Space), roll (Q E), Shift's boost, and on foot V's ride. */
  flightKeys(move: Km, roll: number, boost: boolean, ride?: boolean): void;
  /** Esc: true when it stopped a trip (then nothing else hears it). */
  stop(): boolean;
  /** The eye shown on the ground (Space jumps) or going down through an air, where a click locks the pointer for mouse-look; null otherwise (landing still waits in orbit). */
  onFoot?(): 'ground' | 'air' | null;
  /** O: orbit the body the camera is near. */
  orbit(): void;
  /** The body under a point of the canvas (client px), or null. */
  pick(clientX: number, clientY: number): BodyId | null;
  /** A double tap or click on a body. */
  travel(body: BodyId): void;
  /** A press at a point (client px): true when something there takes the drag (then it moves that, not the camera, until let go). */
  grab?(clientX: number, clientY: number): boolean;
  grabMove?(clientX: number, clientY: number): void;
  /** The grabbed thing let go, or cancelled (Esc, a lost pointer). */
  grabEnd?(cancelled: boolean): void;
  /** A mouse moving over the canvas with no button held. */
  hover?(clientX: number, clientY: number): void;
  /** A tap or click: true when it was used (then it is not the start of a double tap). */
  tap?(clientX: number, clientY: number): boolean;
}

export interface ExploreInput {
  attach(): void;
  detach(): void;
}

/** A focused control Space presses (a button, a link, a summary): Space is its own there. */
const pressable = (target: EventTarget | null): boolean => target instanceof HTMLElement && target.closest('button, a[href], summary, [role="button"]') !== null;

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
  /** This pointer took something under it (grab), not the camera. */
  grab: boolean;
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
    target.flightKeys(move, Math.sign(roll), [...held].some((code) => BOOST_KEYS.has(code)), held.has(RIDE_KEY));
    target.orbitKeys(Math.sign(azimuth), Math.sign(elevation), Math.sign(zoom));
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const pan = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || e.shiftKey);
    // The first pointer, a plain press: something under it may take the drag.
    const grab = pointers.size === 0 && !pan && (target.grab?.(e.clientX, e.clientY) ?? false);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, type: e.pointerType, pan, grab });
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
    // Mouse-look: a locked pointer turns the view by how far the mouse moves, no button held.
    if (document.pointerLockElement === element) {
      if (target.onFoot?.()) target.drag(e.movementX * LOCKED_LOOK, e.movementY * LOCKED_LOOK);
      return;
    }
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && pointers.size === 0) target.hover?.(e.clientX, e.clientY);
      return;
    }
    if (p.grab) {
      p.x = e.clientX;
      p.y = e.clientY;
      target.grabMove?.(e.clientX, e.clientY);
      return;
    }
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
    if (p?.grab) {
      target.grabEnd?.(e.type === 'pointercancel');
      lastTap = null;
      return;
    }
    if (!p || e.type === 'pointercancel' || pointers.size > 0) return;
    // A tap: little movement. Two in quick succession on a body travel there.
    if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > TAP_PX) {
      lastTap = null;
      return;
    }
    // On foot a mouse's click takes the pointer for mouse-look (where the browser allows it); clicks
    // while it is taken do nothing else (its place on screen is wherever it was taken).
    if (document.pointerLockElement === element) {
      lastTap = null;
      return;
    }
    if (p.type === 'mouse' && target.onFoot?.()) {
      lastTap = null;
      try {
        void Promise.resolve(element.requestPointerLock()).catch(() => undefined);
      } catch {
        /* Refused (an embedded page, a browser without it): dragging still looks. */
      }
      return;
    }
    if (target.tap?.(e.clientX, e.clientY)) {
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

  const known = (code: string): boolean => code in MOVE_KEYS || code in ROLL_KEYS || code in TURN_KEYS || code in ZOOM_KEYS || BOOST_KEYS.has(code) || (code === RIDE_KEY && target.onFoot?.() === 'ground');

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || ownedElsewhere(e.target)) return;
    if (e.code === 'Space' && (target.onFoot?.() !== 'ground' || pressable(e.target))) return;
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

  /**
   * Before the page hears a key: on foot Space is the walk's (the page's play key waits); Esc first
   * lets go of a grabbed thing, then stops a trip; only when there is neither does it go on to the
   * interface, and a held Esc's repeats never do.
   */
  const onEscape = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && !ownedElsewhere(e.target) && !pressable(e.target) && target.onFoot?.() === 'ground') {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || ownedElsewhere(e.target)) return;
    if (e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const grabbed = [...pointers.values()].find((p) => p.grab);
    if (grabbed) {
      grabbed.grab = false;
      target.grabEnd?.(true);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (target.stop()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onBlur = (): void => {
    held.clear();
    if ([...pointers.values()].some((p) => p.grab)) target.grabEnd?.(true);
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
