/**
 * The explorer's camera rigs, pure (no three.js) so the unit tests drive them without a browser.
 * Positions are float64 km in the render frame (./space/origin); directions are unit vectors.
 *
 * Every smoothed quantity follows an exact critically damped spring: the closed-form solution of
 * x'' = -2w x' - w^2 (x - goal) over each frame, so the motion is the same at 30, 60 or 144 Hz, it
 * never overshoots, and it starts and stops without a jolt. The orbit rig springs its angles, the
 * logarithm of its height above the surface (so a wheel notch means the same 15% at 200 km or at
 * 5 au, and the last few hundred km above a world are as easy to judge as the first million) and
 * its pan; free flight springs its velocity and its turn rates.
 *
 * Orbit: the camera circles the body in focus, looking at its centre, or, low over it, at a point
 * lifted toward the horizon so the limb, the air and space stay in view. Free flight: the camera
 * keeps its own heading and moves in its own frame, at a speed proportional to its height above the
 * nearest surface (fast between worlds, slow and precise just above one), five times faster with
 * the boost; it is carried along with the body it is near (in that body's frame, not turning with
 * it), so a world it hangs above does not drift away at 30 km/s. No pose of either rig is ever
 * inside a body.
 */

import { km, type Km } from './space/origin';

/* ------------------------------------------------------------------ */
/* Springs                                                              */
/* ------------------------------------------------------------------ */

/** One damped quantity: its value and its rate of change per second. */
export interface Spring {
  x: number;
  v: number;
}

export const springOf = (x = 0): Spring => ({ x, v: 0 });

/** Below this distance from the goal (and speed), a spring is at rest: it snaps there and stops. */
const REST = 1e-9;

/**
 * Advances a critically damped spring by dt toward `goal` with natural frequency `omega` (rad/s; it
 * covers 90% of a step in about 3.9 / omega seconds). Exact for a goal held over the step. An
 * omega of Infinity (or dt with no omega) puts it at the goal at once.
 */
export function stepSpring(s: Spring, goal: number, omega: number, dt: number): void {
  if (!(dt > 0)) return;
  if (!(omega > 0) || !Number.isFinite(omega)) {
    s.x = goal;
    s.v = 0;
    return;
  }
  const y = s.x - goal;
  const j = s.v + omega * y;
  const e = Math.exp(-omega * dt);
  s.x = goal + (y + j * dt) * e;
  s.v = (s.v - omega * j * dt) * e;
  if (Math.abs(s.x - goal) < REST * Math.max(1, Math.abs(goal)) && Math.abs(s.v) < REST) {
    s.x = goal;
    s.v = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Vectors and rotations (doubles)                                      */
/* ------------------------------------------------------------------ */

export const set = (out: Km, x: number, y: number, z: number): Km => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const copy = (out: Km, v: Km): Km => set(out, v.x, v.y, v.z);
export const dot = (a: Km, b: Km): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (v: Km): number => Math.hypot(v.x, v.y, v.z);
export const cross = (a: Km, b: Km, out: Km): Km => set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const sub = (a: Km, b: Km, out: Km): Km => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const addScaled = (out: Km, v: Km, k: number): Km => set(out, out.x + v.x * k, out.y + v.y * k, out.z + v.z * k);
export function normalize(v: Km, fallback: Km = { x: 0, y: 1, z: 0 }): Km {
  const l = len(v);
  if (!(l > 1e-300)) return copy(v, fallback);
  return set(v, v.x / l, v.y / l, v.z / l);
}
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const smootherstep = (a: number, b: number, x: number): number => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/** Ecliptic north in the render frame: the "up" every view returns to. */
export const UP: Readonly<Km> = { x: 0, y: 1, z: 0 };

/** `up` made square to `forward` (unit), falling back to any square direction when they are parallel. */
export function squareUp(forward: Km, up: Km, out: Km): Km {
  const d = dot(up, forward);
  set(out, up.x - forward.x * d, up.y - forward.y * d, up.z - forward.z * d);
  if (len(out) < 1e-9) {
    // Looking straight along "up": take the axis most square to the line of sight.
    const ax = Math.abs(forward.x) < 0.6 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
    const e = dot(ax, forward);
    set(out, ax.x - forward.x * e, ax.y - forward.y * e, ax.z - forward.z * e);
  }
  return normalize(out);
}

/** Rotates v about a unit axis by angle (Rodrigues). */
export function rotateAbout(v: Km, axis: Km, angle: number, out: Km): Km {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = dot(axis, v) * (1 - c);
  const x = v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d;
  const y = v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d;
  const z = v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d;
  return set(out, x, y, z);
}

/**
 * Spherical interpolation between unit vectors. Nearly opposite ones turn through `via` (a unit
 * direction square to them, e.g. ecliptic north), so the path goes over a body, never through it.
 */
export function slerpDir(a: Km, b: Km, t: number, out: Km, via: Km = UP): Km {
  if (t <= 0) return copy(out, a);
  if (t >= 1) return copy(out, b);
  const d = clamp(dot(a, b), -1, 1);
  const theta = Math.acos(d);
  if (theta < 1e-9) return copy(out, a);
  if (Math.PI - theta < 1e-3) {
    // Through the midpoint square to both, on the side of `via`.
    const mid = squareUp(a, via, { x: 0, y: 0, z: 0 });
    if (t < 0.5) return slerpDir(a, mid, t * 2, out, via);
    return slerpDir(mid, b, (t - 0.5) * 2, out, via);
  }
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return normalize(set(out, a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb));
}

/** Unit direction from azimuth (about +y, from +z toward +x) and elevation. */
export function direction(azimuth: number, elevation: number, out: Km): Km {
  const c = Math.cos(elevation);
  return set(out, c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth));
}

/** An angle brought into (-pi, pi]. */
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

export function angles(dir: Km): { azimuth: number; elevation: number } {
  return { azimuth: Math.atan2(dir.x, dir.z), elevation: Math.asin(clamp(dir.y, -1, 1)) };
}

/* ------------------------------------------------------------------ */
/* Where the camera looks                                               */
/* ------------------------------------------------------------------ */

/**
 * Low over a body the gaze lifts from its centre toward the horizon: the horizon is held this far
 * (radians) above the middle of the view once it would otherwise climb past it.
 */
export const HORIZON_VIEW = 0.3;

const lookScratch = km();

/**
 * The unit direction to look from `position` at a body (centre `centre`, radius `radius`): at the
 * centre, or, once the horizon would climb past HORIZON_VIEW above the middle of the view, that
 * much lower than the horizon, lifted toward `up` (square to the line of sight). `lift` scales that
 * lift (0: straight down at the centre, as a view held over a place looks).
 */
export function lookDirection(position: Km, centre: Km, radius: number, up: Km, out: Km, lift = 1): Km {
  set(out, centre.x - position.x, centre.y - position.y, centre.z - position.z);
  const r = len(out);
  if (!(r > 0)) return set(out, 0, 0, -1);
  set(out, out.x / r, out.y / r, out.z / r);
  const tilt = Math.max(0, Math.asin(Math.min(1, radius / r)) - HORIZON_VIEW) * lift;
  if (tilt <= 0) return out;
  const u = squareUp(out, up, lookScratch);
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return normalize(set(out, out.x * c + u.x * s, out.y * c + u.y * s, out.z * c + u.z * s));
}

/* ------------------------------------------------------------------ */
/* The pose a rig writes                                                */
/* ------------------------------------------------------------------ */

export interface RigPose {
  /** Camera position, render frame, km. */
  readonly position: Km;
  /** Unit line of sight and unit "up" (square to it). */
  readonly forward: Km;
  readonly up: Km;
}

export const rigPose = (): { position: Km; forward: Km; up: Km } => ({ position: km(), forward: km(0, 0, -1), up: km(0, 1, 0) });

/** A body as the rigs see it. */
export interface RigBody {
  readonly id: string;
  readonly radiusKm: number;
  readonly boundKm: number;
  /** The rigs never go lower than this above the equatorial surface, km. */
  readonly minAltitudeKm: number;
  /** Centre now, render frame, km. */
  readonly position: Km;
}

/** Pushes `position` out of every body to just above its floor; returns the body it was pushed from, or null. */
export function keepOutside(bodies: readonly RigBody[], position: Km): RigBody | null {
  let pushed: RigBody | null = null;
  for (const body of bodies) {
    const dx = position.x - body.position.x;
    const dy = position.y - body.position.y;
    const dz = position.z - body.position.z;
    const d = Math.hypot(dx, dy, dz);
    const floor = body.radiusKm + body.minAltitudeKm;
    if (d >= floor) continue;
    if (d === 0) {
      set(position, body.position.x, body.position.y + floor, body.position.z);
    } else {
      const k = floor / d;
      set(position, body.position.x + dx * k, body.position.y + dy * k, body.position.z + dz * k);
    }
    pushed = body;
  }
  return pushed;
}

/** Height of `position` above the nearest surface, km, and that body. */
export function nearestSurface(bodies: readonly RigBody[], position: Km): { body: RigBody | null; altitude: number } {
  let best: RigBody | null = null;
  let altitude = Infinity;
  for (const body of bodies) {
    const h = Math.hypot(position.x - body.position.x, position.y - body.position.y, position.z - body.position.z) - body.radiusKm;
    if (h < altitude) {
      altitude = h;
      best = body;
    }
  }
  return { body: best, altitude };
}

/* ------------------------------------------------------------------ */
/* Orbit rig                                                            */
/* ------------------------------------------------------------------ */

/** Orbit springs (rad/s): turning and panning, and zooming. Snappy, but never a jump. */
export const ORBIT_OMEGA = { turn: 15, zoom: 11, pan: 12 } as const;
/** Elevation stays clear of the poles of the orbit frame, where "up" would flip. */
export const MAX_ELEVATION = 1.45;
const AU_KM = 149_597_870.7;
/** The farthest the orbit rig goes from its body's surface: 50 au. */
export const MAX_ALTITUDE_KM = 50 * AU_KM;

/**
 * The camera circling a body: azimuth and elevation about ecliptic north, the logarithm of the
 * height above the equatorial surface, and a pan (a shift of the whole rig, so the body can be
 * moved off the middle of the view). All four are springs toward goals the input moves.
 */
export class OrbitRig {
  readonly azimuth = springOf();
  readonly elevation = springOf(0.2);
  readonly lnAltitude = springOf(Math.log(30_000));
  readonly pan = { x: springOf(), y: springOf(), z: springOf() };
  readonly goal = { azimuth: 0, elevation: 0.2, lnAltitude: Math.log(30_000), pan: km() };
  /** Instant moves (reduced motion): the springs sit on their goals. */
  instant = false;
  private readonly dir = km();
  private readonly centre = km();

  /** Puts the rig exactly at a direction (from the body) and height, with no pan and nothing moving. */
  settle(dir: Km, altitudeKm: number): void {
    const { azimuth, elevation } = angles(dir);
    const ln = Math.log(Math.max(altitudeKm, 1e-6));
    this.azimuth.x = this.goal.azimuth = azimuth;
    this.elevation.x = this.goal.elevation = clamp(elevation, -MAX_ELEVATION, MAX_ELEVATION);
    this.lnAltitude.x = this.goal.lnAltitude = ln;
    this.azimuth.v = this.elevation.v = this.lnAltitude.v = 0;
    for (const axis of ['x', 'y', 'z'] as const) {
      this.pan[axis].x = this.pan[axis].v = 0;
      this.goal.pan[axis] = 0;
    }
  }

  /**
   * Turns the rig, now and its goals, about an axis through the body (the Earth's pole as it spins),
   * so the ground below keeps its place in the view. Velocities are kept: a turn under way carries on.
   */
  spin(axis: Km, angle: number): void {
    if (angle === 0) return;
    const turn = (azimuth: number, elevation: number): { azimuth: number; elevation: number } => {
      direction(azimuth, elevation, this.dir);
      rotateAbout(this.dir, axis, angle, this.dir);
      const next = angles(this.dir);
      // The same way round as before (no jump of a whole turn in the spring).
      return { azimuth: azimuth + wrapAngle(next.azimuth - azimuth), elevation: clamp(next.elevation, -MAX_ELEVATION, MAX_ELEVATION) };
    };
    const now = turn(this.azimuth.x, this.elevation.x);
    this.azimuth.x = now.azimuth;
    this.elevation.x = now.elevation;
    const goal = turn(this.goal.azimuth, this.goal.elevation);
    this.goal.azimuth = goal.azimuth;
    this.goal.elevation = goal.elevation;
  }

  /** Sets the rig exactly over a direction and height, keeping the azimuth on the side it was (for glides). */
  hold(dir: Km, altitudeKm: number): void {
    const { azimuth, elevation } = angles(dir);
    const a = this.azimuth.x + wrapAngle(azimuth - this.azimuth.x);
    this.azimuth.x = this.goal.azimuth = a;
    this.elevation.x = this.goal.elevation = clamp(elevation, -MAX_ELEVATION, MAX_ELEVATION);
    this.lnAltitude.x = this.goal.lnAltitude = Math.log(Math.max(altitudeKm, 1e-6));
    this.azimuth.v = this.elevation.v = this.lnAltitude.v = 0;
    for (const axis of ['x', 'y', 'z'] as const) {
      this.pan[axis].x = this.pan[axis].v = 0;
      this.goal.pan[axis] = 0;
    }
  }

  /** The direction from the body the rig is at now (render frame). */
  directionNow(out: Km): Km {
    return direction(this.azimuth.x, this.elevation.x, out);
  }

  /** The height above the surface now and at rest, km. */
  get altitudeKm(): number {
    return Math.exp(this.lnAltitude.x);
  }

  get goalAltitudeKm(): number {
    return Math.exp(this.goal.lnAltitude);
  }

  rotate(dAzimuth: number, dElevation: number): void {
    this.goal.azimuth += dAzimuth;
    this.goal.elevation = clamp(this.goal.elevation + dElevation, -MAX_ELEVATION, MAX_ELEVATION);
  }

  zoom(dLn: number): void {
    this.goal.lnAltitude += dLn;
  }

  /** Shifts the rig by a vector (km, render frame), its length kept within `limit` of the body. */
  panBy(delta: Km, limit: number): void {
    const p = this.goal.pan;
    set(p, p.x + delta.x, p.y + delta.y, p.z + delta.z);
    const l = len(p);
    if (l > limit) set(p, (p.x * limit) / l, (p.y * limit) / l, (p.z * limit) / l);
  }

  /** True while any spring is still moving toward its goal. */
  get busy(): boolean {
    return (
      this.azimuth.x !== this.goal.azimuth ||
      this.elevation.x !== this.goal.elevation ||
      this.lnAltitude.x !== this.goal.lnAltitude ||
      this.pan.x.x !== this.goal.pan.x ||
      this.pan.y.x !== this.goal.pan.y ||
      this.pan.z.x !== this.goal.pan.z
    );
  }

  /** Advances the springs (the height kept between `minAltitudeKm` and MAX_ALTITUDE_KM). */
  update(body: RigBody, dt: number): void {
    this.goal.lnAltitude = clamp(this.goal.lnAltitude, Math.log(body.minAltitudeKm), Math.log(MAX_ALTITUDE_KM));
    const turn = this.instant ? Infinity : ORBIT_OMEGA.turn;
    stepSpring(this.azimuth, this.goal.azimuth, turn, dt);
    stepSpring(this.elevation, this.goal.elevation, turn, dt);
    stepSpring(this.lnAltitude, this.goal.lnAltitude, this.instant ? Infinity : ORBIT_OMEGA.zoom, dt);
    const pan = this.instant ? Infinity : ORBIT_OMEGA.pan;
    stepSpring(this.pan.x, this.goal.pan.x, pan, dt);
    stepSpring(this.pan.y, this.goal.pan.y, pan, dt);
    stepSpring(this.pan.z, this.goal.pan.z, pan, dt);
  }

  /** The rig's pose now around `body`; `lift` scales the gaze's lift toward the horizon low over it (0: straight down). */
  pose(body: RigBody, out: { position: Km; forward: Km; up: Km }, lift = 1): void {
    direction(this.azimuth.x, this.elevation.x, this.dir);
    const r = body.radiusKm + Math.exp(this.lnAltitude.x);
    set(this.centre, body.position.x + this.pan.x.x, body.position.y + this.pan.y.x, body.position.z + this.pan.z.x);
    set(out.position, this.centre.x + this.dir.x * r, this.centre.y + this.dir.y * r, this.centre.z + this.dir.z * r);
    lookDirection(out.position, this.centre, body.radiusKm, UP, out.forward, lift);
    squareUp(out.forward, UP, out.up);
  }
}

/* ------------------------------------------------------------------ */
/* Free flight                                                          */
/* ------------------------------------------------------------------ */

/**
 * Free flight: speed per second as a share of the height above the nearest surface, the boost's
 * factor, and the velocity's and turn rates' springs (rad/s). The look spring is quick (a drag
 * feels direct), the velocity's slower (the camera has a little mass).
 */
export const FLIGHT = { speedPerAltitude: 0.7, boost: 5, velocityOmega: 3.2, lookOmega: 16, rollRate: 1.1, turnRate: 1.1, minSpeedAltitudeKm: 0.05 } as const;

/** Held controls of free flight, each -1 to 1: right, up, forward (camera frame); roll (positive: clockwise). */
export interface FlightControls {
  move: Km;
  roll: number;
  /** Look rates from held keys (positive: right, up), as shares of FLIGHT.turnRate. */
  yaw: number;
  pitch: number;
  boost: boolean;
}

export const flightControls = (): FlightControls => ({ move: km(), roll: 0, yaw: 0, pitch: 0, boost: false });

/**
 * A free-flying camera. Its position is kept relative to a reference body (the one it is near),
 * so it travels with that body; its orientation is a right-handed basis (forward, up).
 */
export class FreeFlight {
  ref: RigBody | null = null;
  readonly offset = km();
  readonly forward = km(0, 0, -1);
  readonly up = km(0, 1, 0);
  /** Velocity relative to the reference body, km/s, render frame. */
  readonly velocity = km();
  /** Look and roll springs (radians turned so far) and their goals. */
  private readonly yaw = springOf();
  private readonly pitch = springOf();
  private readonly roll = springOf();
  private readonly goal = { yaw: 0, pitch: 0, roll: 0 };
  /** Log-distance still to dolly along the line of sight (wheel steps), as a spring. */
  private readonly dolly = springOf();
  private dollyGoal = 0;
  private readonly scratch = { a: km(), b: km(), c: km(), position: km() };

  /** Starts free flight from a pose (seamless: the camera stays exactly where it was, looking the same way). */
  begin(pose: RigPose, ref: RigBody, velocity: Km | null = null): void {
    this.ref = ref;
    sub(pose.position, ref.position, this.offset);
    copy(this.forward, pose.forward);
    squareUp(this.forward, pose.up, this.up);
    if (velocity) copy(this.velocity, velocity);
    else set(this.velocity, 0, 0, 0);
    this.yaw.x = this.yaw.v = this.pitch.x = this.pitch.v = this.roll.x = this.roll.v = 0;
    this.goal.yaw = this.goal.pitch = this.goal.roll = 0;
    this.dolly.x = this.dolly.v = 0;
    this.dollyGoal = 0;
  }

  /** Turns the view (radians; positive yaw turns right, positive pitch looks up). */
  look(dYaw: number, dPitch: number): void {
    this.goal.yaw += dYaw;
    this.goal.pitch += dPitch;
  }

  /** Dolly along the line of sight by a share of the height above the nearest surface (log units; negative: forward). */
  dollyBy(dLn: number): void {
    this.dollyGoal += dLn;
  }

  /** The camera's position now, render frame, km. */
  position(out: Km): Km {
    const ref = this.ref;
    if (!ref) return copy(out, this.offset);
    return set(out, ref.position.x + this.offset.x, ref.position.y + this.offset.y, ref.position.z + this.offset.z);
  }

  /** Speed now, km/s. */
  get speed(): number {
    return len(this.velocity);
  }

  get busy(): boolean {
    return (
      this.speed > 1e-6 ||
      this.yaw.x !== this.goal.yaw ||
      this.pitch.x !== this.goal.pitch ||
      this.roll.x !== this.goal.roll ||
      this.dolly.x !== this.dollyGoal
    );
  }

  /** Advances by dt: turns, moves, keeps above every surface and re-anchors to the body it is nearest. */
  update(bodies: readonly RigBody[], controls: FlightControls, dt: number, reducedMotion: boolean): void {
    if (!(dt > 0) || !this.ref) return;
    const { a, b, position } = this.scratch;
    // Turning: held keys move the goals at a rate, drags by steps; the springs follow.
    this.goal.yaw += controls.yaw * FLIGHT.turnRate * dt;
    this.goal.pitch += controls.pitch * FLIGHT.turnRate * dt;
    this.goal.roll += controls.roll * FLIGHT.rollRate * dt;
    const look = reducedMotion ? Infinity : FLIGHT.lookOmega;
    const yawBefore = this.yaw.x;
    const pitchBefore = this.pitch.x;
    const rollBefore = this.roll.x;
    stepSpring(this.yaw, this.goal.yaw, look, dt);
    stepSpring(this.pitch, this.goal.pitch, look, dt);
    stepSpring(this.roll, this.goal.roll, look, dt);
    const dYaw = this.yaw.x - yawBefore;
    const dPitch = this.pitch.x - pitchBefore;
    const dRoll = this.roll.x - rollBefore;
    // Yaw about the camera's up, pitch about its right, roll about its line of sight.
    const right = normalize(cross(this.forward, this.up, a));
    if (dYaw !== 0) rotateAbout(this.forward, this.up, -dYaw, this.forward);
    if (dPitch !== 0) {
      rotateAbout(this.forward, right, dPitch, this.forward);
      rotateAbout(this.up, right, dPitch, this.up);
    }
    if (dRoll !== 0) rotateAbout(this.up, this.forward, dRoll, this.up);
    normalize(this.forward);
    squareUp(this.forward, this.up, this.up);

    // Moving: toward the held direction at a speed proportional to the height above the nearest surface.
    this.position(position);
    const near = nearestSurface(bodies, position);
    const altitude = Math.max(FLIGHT.minSpeedAltitudeKm, near.altitude);
    const speed = FLIGHT.speedPerAltitude * altitude * (controls.boost ? FLIGHT.boost : 1);
    cross(this.forward, this.up, right);
    normalize(right);
    const m = controls.move;
    set(
      b,
      right.x * m.x + this.up.x * m.y + this.forward.x * m.z,
      right.y * m.x + this.up.y * m.y + this.forward.y * m.z,
      right.z * m.x + this.up.z * m.y + this.forward.z * m.z,
    );
    const l = len(b);
    if (l > 1) set(b, b.x / l, b.y / l, b.z / l);
    // The velocity approaches its goal exponentially (no overshoot of speed), integrated exactly
    // over the frame, so a flight covers the same ground at any frame rate.
    const e = Math.exp(-FLIGHT.velocityOmega * dt);
    const drift = (1 - e) / FLIGHT.velocityOmega;
    for (const axis of ['x', 'y', 'z'] as const) {
      const goal = b[axis] * speed;
      const v0 = this.velocity[axis];
      position[axis] += goal * dt + (v0 - goal) * drift;
      this.velocity[axis] = goal + (v0 - goal) * e;
    }
    // Wheel steps: the height above the nearest surface scales by e^dLn, along the line of sight.
    const dollyBefore = this.dolly.x;
    stepSpring(this.dolly, this.dollyGoal, reducedMotion ? Infinity : ORBIT_OMEGA.zoom, dt);
    const dLn = this.dolly.x - dollyBefore;
    if (dLn !== 0) addScaled(position, this.forward, (1 - Math.exp(dLn)) * altitude);
    // Never inside a body: held just above its floor, sliding along it rather than into it.
    const pushed = keepOutside(bodies, position);
    if (pushed) {
      sub(position, pushed.position, a);
      normalize(a);
      const inward = dot(this.velocity, a);
      if (inward < 0) addScaled(this.velocity, a, -inward);
    }
    // Never beyond the explorer's horizon either (the orbit rig's ceiling): at MAX_ALTITUDE_KM above
    // the nearest surface the camera is held, its outward speed taken away. Speed grows with height,
    // so without this a held boost would overflow the doubles in a few minutes.
    const far = nearestSurface(bodies, position);
    if (far.body && far.altitude > MAX_ALTITUDE_KM) {
      const body = far.body;
      sub(position, body.position, a);
      const d = len(a);
      const k = (body.radiusKm + MAX_ALTITUDE_KM) / Math.max(d, 1e-9);
      set(position, body.position.x + a.x * k, body.position.y + a.y * k, body.position.z + a.z * k);
      normalize(a);
      const outward = dot(this.velocity, a);
      if (outward > 0) addScaled(this.velocity, a, -outward);
    }
    // Re-anchor to the body whose surface is nearest in its own radii (with some stickiness), so the
    // camera travels with the world it is near.
    const anchor = this.anchorFor(bodies, position);
    this.ref = anchor;
    sub(position, anchor.position, this.offset);
  }

  private anchorFor(bodies: readonly RigBody[], position: Km): RigBody {
    const current = this.ref;
    const ratio = (body: RigBody): number =>
      (Math.hypot(position.x - body.position.x, position.y - body.position.y, position.z - body.position.z) - body.radiusKm) / body.radiusKm;
    let best = current;
    let bestRatio = current ? ratio(current) : Infinity;
    for (const body of bodies) {
      if (body === current) continue;
      const r = ratio(body);
      // Another body takes over only once clearly nearer, so the anchor never flickers between two.
      if (r < bestRatio * 0.8) {
        best = body;
        bestRatio = r;
      }
    }
    return best ?? (bodies[0] as RigBody);
  }
}
