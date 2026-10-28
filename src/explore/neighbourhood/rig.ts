/**
 * The camera among the stars (docs/NEIGHBOURHOOD.md, "Moving among the stars"): pure, so its
 * behaviour is tested in Node. Its place is held as a point it is anchored to (the star or black hole
 * chosen, in parsecs from the Sun, render frame) and its offset from it, both in double precision, so
 * it can come within kilometres of a stellar black hole 500 parsecs away; its orientation as a
 * quaternion, with no limit on pitch.
 *
 * Two ways of looking:
 * - Free look (the way in): a drag turns the camera where it stands, the sky following the hand
 *   (the point under the pointer stays under it); W A S D, R and F (or Space and C) fly along its
 *   axes and Q and E roll, at a speed set by the distance to the nearest star (half of it each second,
 *   five times that with Shift), so a parsec takes seconds and the last astronomical units slow down;
 *   the wheel or a pinch moves toward the point under the pointer.
 * - Orbit, round the star chosen (after flying to it, or O): a drag turns the camera round it, the
 *   wheel moves in or out (never inside it), and a move key lets go of it into free look.
 * A pan moves the camera across the view in either. A flight to a star or a place rises to see both
 * ends and comes down again, turning to look at where it goes, and arrives in orbit; under reduced
 * motion it is a cut.
 */

export type V3 = [number, number, number];
/** A rotation as a unit quaternion (x, y, z, w); the camera looks along its -z and its up is +y. */
export type Quat = [number, number, number, number];
export type RigMode = 'look' | 'orbit';

/**
 * Radians per CSS pixel dragged in orbit (the solar system's orbit's rate); the speed's share of the
 * nearest distance a second, Shift's multiple, and its bounds (pc/s); under reduced motion a flight is
 * a cut, halfway through this wait (s), as the solar system's navigator cuts.
 */
export const RIG = { orbitPerPx: 0.005, speedShare: 0.5, boost: 5, minSpeed: 1e-16, maxSpeed: 2e4, keyTurn: 0.9, keyZoom: 1.2, aimSeconds: 0.4, cutSeconds: 0.6 } as const;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const normalise = (a: V3): V3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function axisAngle(axis: V3, angle: number): Quat {
  const [x, y, z] = normalise(axis);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** a then b: the rotation b applied after a. */
export function compose(b: Quat, a: Quat): Quat {
  const [bx, by, bz, bw] = b;
  const [ax, ay, az, aw] = a;
  return [bw * ax + bx * aw + by * az - bz * ay, bw * ay - bx * az + by * aw + bz * ax, bw * az + bx * ay - by * ax + bz * aw, bw * aw - bx * ax - by * ay - bz * az];
}

export function rotate(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  // v + 2w (q x v) + 2 q x (q x v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function normaliseQuat(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export const forwardOf = (q: Quat): V3 => rotate(q, [0, 0, -1]);
export const upOf = (q: Quat): V3 => rotate(q, [0, 1, 0]);
export const rightOf = (q: Quat): V3 => rotate(q, [1, 0, 0]);

/** The orientation looking along `forward` with `upHint` as near up as it can be. */
export function lookRotation(forward: V3, upHint: V3): Quat {
  const f = normalise(forward);
  let r = cross(f, upHint);
  if (length(r) < 1e-9) r = cross(f, Math.abs(f[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  r = normalise(r);
  const u = cross(r, f);
  // Columns: right, up, -forward (a camera looks down its -z).
  const m00 = r[0];
  const m01 = u[0];
  const m02 = -f[0];
  const m10 = r[1];
  const m11 = u[1];
  const m12 = -f[1];
  const m20 = r[2];
  const m21 = u[2];
  const m22 = -f[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return normaliseQuat([(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return normaliseQuat([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return normaliseQuat([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return normaliseQuat([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const c: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : [...b];
  d = Math.abs(d);
  if (d > 0.9995) return normaliseQuat([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t, a[3] + (c[3] - a[3]) * t]);
  const theta = Math.acos(Math.min(1, d));
  const s = Math.sin(theta);
  const ka = Math.sin((1 - t) * theta) / s;
  const kb = Math.sin(t * theta) / s;
  return [a[0] * ka + c[0] * kb, a[1] * ka + c[1] * kb, a[2] * ka + c[2] * kb, a[3] * ka + c[3] * kb];
}

const smootherstep = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Keys held: moves along the camera's right, up and forward (-1, 0 or 1), roll, Shift; turns (arrows) and zoom (+ and -). */
export interface RigKeys {
  move: V3;
  roll: number;
  boost: boolean;
  turnX: number;
  turnY: number;
  zoom: number;
}

export interface Trip {
  /** The target's place (the new anchor) and where the camera looked from at the start, relative to it. */
  to: V3;
  fromCentre: V3;
  fromDir: V3;
  toDir: V3;
  fromLn: number;
  toLn: number;
  lift: number;
  t: number;
  seconds: number;
  up: V3;
  /** An up to turn to by the end (a black hole's disc's axis), or null to keep it. */
  upTo: V3 | null;
}

export interface Rig {
  mode: RigMode;
  /** The point the camera is anchored to (pc from the Sun) and its offset from it (pc). */
  anchor: V3;
  rel: V3;
  q: Quat;
  /** Orbit's nearest and farthest (pc from the anchor). */
  minPc: number;
  maxPc: number;
  trip: Trip | null;
  /** Seconds left of an aim toward the anchor (after O), and the orientation it started from. */
  aim: { t: number; from: Quat } | null;
  keys: RigKeys;
  /** This frame's speed (pc/s) when flying, else 0. */
  speed: number;
}

export function createRig(anchor: V3, rel: V3, minPc: number, maxPc: number): Rig {
  return { mode: 'look', anchor: [...anchor], rel: [...rel], q: lookRotation(scale(rel, -1), [0, 1, 0]), minPc, maxPc, trip: null, aim: null, keys: { move: [0, 0, 0], roll: 0, boost: false, turnX: 0, turnY: 0, zoom: 0 }, speed: 0 };
}

/** The camera's place, pc from the Sun. */
export const cameraOf = (rig: Rig): V3 => add(rig.anchor, rig.rel);

/** A turn of the camera by a drag (CSS px): in free look by `radPerPx` (the view's own, so the sky follows the hand), in orbit round the anchor. */
export function drag(rig: Rig, dx: number, dy: number, radPerPx: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  rig.aim = null;
  if (rig.mode === 'look') {
    const yaw = axisAngle(upOf(rig.q), dx * radPerPx);
    const pitch = axisAngle(rightOf(rig.q), dy * radPerPx);
    rig.q = normaliseQuat(compose(pitch, compose(yaw, rig.q)));
    return;
  }
  // Round the anchor: the camera and its offset turn together (the up carried along, no pole to stop at).
  // (A drag to the right takes the camera to the left round it, a drag down takes it up, as round a world.)
  const turn = compose(axisAngle(rightOf(rig.q), -dy * RIG.orbitPerPx), axisAngle(upOf(rig.q), -dx * RIG.orbitPerPx));
  rig.rel = rotate(turn, rig.rel);
  rig.q = normaliseQuat(compose(turn, rig.q));
}

/** A pan: the camera moves across the view by `pcPerPx` a pixel, letting go of an orbit. */
export function pan(rig: Rig, dx: number, dy: number, pcPerPx: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(pcPerPx)) return;
  rig.mode = 'look';
  rig.aim = null;
  const r = rightOf(rig.q);
  const u = upOf(rig.q);
  rig.rel = add(rig.rel, add(scale(r, -dx * pcPerPx), scale(u, dy * pcPerPx)));
}

/**
 * A zoom (natural-log units, positive away): in orbit, in or out from the anchor within its reach; in
 * free look, along `ray` (the pointer's direction, unit, render frame) by its share of `towardPc`, the
 * distance to what is there, never past `nearestPc` of it.
 */
export function zoom(rig: Rig, dLn: number, ray: V3 | null, towardPc: number): void {
  if (!Number.isFinite(dLn) || dLn === 0) return;
  if (rig.mode === 'orbit') {
    const d = length(rig.rel);
    const next = Math.max(rig.minPc, Math.min(rig.maxPc, d * Math.exp(dLn)));
    rig.rel = scale(rig.rel, next / Math.max(d, 1e-300));
    return;
  }
  const dir = ray ?? forwardOf(rig.q);
  const step = (1 - Math.exp(dLn)) * Math.max(towardPc, 0);
  rig.rel = add(rig.rel, scale(dir, step));
}

/** O: into orbit round the anchor, turning to face it; or back to free look. */
export function toggleMode(rig: Rig): void {
  if (rig.mode === 'orbit') {
    rig.mode = 'look';
    return;
  }
  rig.mode = 'orbit';
  const d = length(rig.rel);
  if (d < rig.minPc) rig.rel = scale(normalise(rig.rel), rig.minPc);
  rig.aim = { t: 0, from: rig.q };
}

/** A flight to `to` (pc from the Sun), arriving `arrivePc` from it, from `toward` (a unit direction from it) or from where the camera is. */
export function flyTo(rig: Rig, to: V3, arrivePc: number, toward: V3 | null, upTo: V3 | null = null): void {
  const camera = cameraOf(rig);
  const f = forwardOf(rig.q);
  const offset = sub(camera, to);
  const sep = length(offset);
  const fromDist = Math.max(sep, 1e-300);
  // Where the camera looks now (as far ahead as the target is), relative to the target.
  const fromCentre = add(offset, scale(f, fromDist));
  const toDir = toward ? normalise(toward) : sep > 1e-300 ? normalise(offset) : scale(f, -1);
  // Rising to see both ends when the target is far from where the camera looks.
  const travel = length(fromCentre);
  rig.trip = {
    to: [...to],
    fromCentre,
    fromDir: scale(f, -1),
    toDir,
    fromLn: Math.log(fromDist),
    toLn: Math.log(Math.max(arrivePc, 1e-300)),
    lift: 0.6 * Math.max(0, Math.log(travel / Math.max(fromDist, arrivePc))),
    t: 0,
    seconds: Math.min(8, 3 + 0.7 * Math.log1p(travel)),
    up: upOf(rig.q),
    upTo,
  };
  rig.anchor = [...to];
  rig.rel = offset;
  rig.aim = null;
}

/** Stops a flight where it is, in free look. */
export function stopTrip(rig: Rig): void {
  rig.trip = null;
  rig.mode = 'look';
}

/** Slerped unit vectors (a and b not opposite). */
function blend(a: V3, b: V3, t: number): V3 {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  const theta = Math.acos(d);
  if (theta < 1e-6) return normalise(add(scale(a, 1 - t), scale(b, t)));
  if (Math.PI - theta < 1e-3) {
    // Opposite: round any perpendicular.
    const p = normalise(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    return t < 0.5 ? blend(a, p, t * 2) : blend(p, b, t * 2 - 1);
  }
  const s = Math.sin(theta);
  return add(scale(a, Math.sin((1 - t) * theta) / s), scale(b, Math.sin(t * theta) / s));
}

/** A flight's arrival: its distance from what it went to, looking at it; at its end, in orbit round it. */
function arrive(rig: Rig, trip: Trip, end: boolean): void {
  rig.rel = scale(trip.toDir, Math.exp(trip.toLn));
  rig.q = lookRotation(scale(trip.toDir, -1), trip.upTo ?? trip.up);
  if (!end) return;
  rig.trip = null;
  rig.mode = 'orbit';
}

/**
 * Steps the camera by `dt` seconds: a flight, an aim, the keys. `nearestPc` is the distance to the
 * nearest star's (or black hole's) surface, which sets the speed of flight; `reduced`: reduced
 * motion (no easing of the aim; a flight is a cut: the view holds, then is at its arrival).
 */
export function step(rig: Rig, dt: number, nearestPc: number, reduced: boolean): void {
  const h = Math.min(Math.max(dt, 0), 0.1);
  rig.speed = 0;
  const trip = rig.trip;
  if (trip && reduced) {
    trip.t += h;
    // Still a flight until its wait is over (Esc stops it, the panel says so), but already there from halfway.
    if (trip.t >= RIG.cutSeconds / 2) arrive(rig, trip, trip.t >= RIG.cutSeconds);
    return;
  }
  if (trip) {
    trip.t += h;
    const s = smootherstep(trip.t / trip.seconds);
    const centre = scale(trip.fromCentre, 1 - s);
    const dir = blend(trip.fromDir, trip.toDir, s);
    const distance = Math.exp(trip.fromLn + (trip.toLn - trip.fromLn) * s + trip.lift * Math.sin(Math.PI * s));
    rig.rel = add(centre, scale(dir, distance));
    const look = sub(centre, rig.rel);
    // The up carried along, kept square to the gaze.
    rig.q = lookRotation(length(look) > 0 ? look : scale(dir, -1), trip.upTo ? blend(trip.up, trip.upTo, s * s) : trip.up);
    trip.up = upOf(rig.q);
    if (trip.t >= trip.seconds) arrive(rig, trip, true);
    return;
  }
  if (rig.aim) {
    rig.aim.t += h;
    const target = lookRotation(scale(rig.rel, -1), upOf(rig.q));
    const k = reduced ? 1 : smootherstep(rig.aim.t / RIG.aimSeconds);
    rig.q = slerp(rig.aim.from, target, k);
    if (k >= 1) rig.aim = null;
  }
  const { move, roll, boost, turnX, turnY, zoom: zoomKey } = rig.keys;
  if (roll !== 0) rig.q = normaliseQuat(compose(axisAngle(forwardOf(rig.q), -roll * RIG.keyTurn * h), rig.q));
  if (turnX !== 0 || turnY !== 0) {
    // The left arrow as a drag to the right: in free look the view turns left; in orbit the camera goes round as the drag takes it.
    if (rig.mode === 'orbit') drag(rig, (turnX * RIG.keyTurn * h) / RIG.orbitPerPx, (turnY * RIG.keyTurn * h) / RIG.orbitPerPx, 0);
    else drag(rig, turnX * h, turnY * h, RIG.keyTurn);
  }
  if (zoomKey !== 0) zoom(rig, zoomKey * RIG.keyZoom * h, null, nearestPc * 2);
  if (move[0] !== 0 || move[1] !== 0 || move[2] !== 0) {
    rig.mode = 'look';
    rig.aim = null;
    const speed = Math.max(RIG.minSpeed, Math.min(RIG.maxSpeed, RIG.speedShare * Math.max(nearestPc, 0))) * (boost ? RIG.boost : 1);
    const dir = normalise(add(add(scale(rightOf(rig.q), move[0]), scale(upOf(rig.q), move[1])), scale(forwardOf(rig.q), move[2])));
    rig.rel = add(rig.rel, scale(dir, speed * h));
    rig.speed = speed;
  }
}

/** Re-anchors the camera to another point, keeping where it is (the offset in double precision from the new anchor). */
export function reanchor(rig: Rig, anchor: V3, minPc: number): void {
  const camera = cameraOf(rig);
  rig.anchor = [...anchor];
  rig.rel = sub(camera, anchor);
  rig.minPc = minPc;
}
