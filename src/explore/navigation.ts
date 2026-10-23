/**
 * The explorer's camera for this stage: it orbits one body at a time and flies between them.
 * Pure (no three.js); positions are float64 km in the render frame (./space/origin).
 *
 * Orbiting: azimuth and elevation around the body, and the distance, all eased toward their
 * goals (an exponential approach, so drags and wheel steps glide to rest). Distance moves in
 * log space, so a wheel step changes the view by the same proportion at 200 km or at 5 au,
 * between a floor above the body's air (or 2% of its radius) and 50 au.
 *
 * Flying: an eased path in log distance, never a jump. The camera backs away until both bodies fit
 * the view, pans across, then closes in on the new body from its sunlit side, so the whole move reads
 * as one gesture; its length grows with the zoom it covers (2.8 to 9 s). With reduced motion the
 * flight is a dimmed cut instead (the exposure dips, the camera moves unseen, the light returns).
 * Entering, the camera glides in from far away to the first body (none with reduced motion).
 */

import type { BodyId } from '../core/types';
import { km, type Km } from './space/origin';

export interface NavBody {
  readonly id: BodyId;
  readonly radiusKm: number;
  readonly boundKm: number;
  readonly minAltitudeKm: number;
  readonly framing: number;
  /** Centre now, render frame, km. */
  readonly position: Km;
}

export interface NavWorld {
  body(id: BodyId): NavBody;
  /** Every body, to keep a flight's camera out of them all. */
  readonly all: readonly NavBody[];
  /** The Sun's centre (for the sunlit side). */
  readonly sun: Km;
}

export interface CameraPose {
  /** Camera position, render frame, km (float64). */
  readonly position: Km;
  /** The point it looks at. */
  readonly target: Km;
}

/** How much the scene is dimmed for a reduced-motion cut (1 = not at all). */
export interface NavOutput extends CameraPose {
  dim: number;
  /** 0 at the start of a flight, 1 when the camera has arrived (1 while orbiting). */
  progress: number;
  /** The body the flight left, while flying. */
  from: BodyId | null;
}

const AU_KM = 149_597_870.7;
const MAX_DISTANCE_KM = 50 * AU_KM;
/** Orbit easing time constants, seconds. */
const TURN_SECONDS = 0.14;
const ZOOM_SECONDS = 0.2;
/** Elevation stays clear of the poles of the orbit frame, where "up" would flip. */
const MAX_ELEVATION = 1.45;
/** Keyboard rates: radians and natural-log units of distance per second. */
const KEY_TURN = 1.1;
const KEY_ZOOM = 1.2;
/** Entry glide: from this many times the framing distance, over this long. */
const APPROACH = { from: 70, seconds: 6.5 } as const;
/** Reduced-motion cut: the dim (a share of the light), and how long each half takes. */
const CUT = { dim: 0.15, seconds: 1.1 } as const;
/**
 * Low over a body the gaze lifts from its centre toward the horizon, so the limb, the air and space
 * stay in view instead of a screen of ground: the horizon is held this far (radians) above the
 * middle of the view once it would otherwise climb past it.
 */
const HORIZON_VIEW = 0.3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smootherstep = (a: number, b: number, x: number): number => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const ease = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

const set = (out: Km, x: number, y: number, z: number): Km => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
const norm = (v: Km): Km => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return set(v, v.x / l, v.y / l, v.z / l);
};

/** Unit direction from azimuth (about +y) and elevation. */
function direction(azimuth: number, elevation: number, out: Km): Km {
  const c = Math.cos(elevation);
  return set(out, c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth));
}

function angles(dir: Km): { azimuth: number; elevation: number } {
  return { azimuth: Math.atan2(dir.x, dir.z), elevation: Math.asin(clamp(dir.y, -1, 1)) };
}

/**
 * Where the camera looks: at the body's centre, or, once the horizon would climb past HORIZON_VIEW
 * above the middle of the view, that much lower than the horizon, lifted toward "up" (ecliptic
 * north, projected square to the line of sight).
 */
function lookTarget(position: Km, centre: Km, radius: number, out: Km): Km {
  const dx = position.x - centre.x;
  const dy = position.y - centre.y;
  const dz = position.z - centre.z;
  const r = Math.hypot(dx, dy, dz);
  const tilt = r > 0 ? Math.max(0, Math.asin(Math.min(1, radius / r)) - HORIZON_VIEW) : 0;
  if (tilt <= 0) return set(out, centre.x, centre.y, centre.z);
  const nx = -dx / r;
  const ny = -dy / r;
  const nz = -dz / r;
  // "Up" square to the line of sight; along it if the camera is nearly over a pole of the orbit frame.
  let ux = -ny * nx;
  let uy = 1 - ny * ny;
  let uz = -ny * nz;
  const ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) {
    ux = 1;
    uy = 0;
    uz = 0;
  } else {
    ux /= ul;
    uy /= ul;
    uz /= ul;
  }
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return set(out, position.x + (nx * c + ux * s) * r, position.y + (ny * c + uy * s) * r, position.z + (nz * c + uz * s) * r);
}

/** Spherical interpolation between unit vectors. */
function slerp(a: Km, b: Km, t: number, out: Km): Km {
  const d = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const theta = Math.acos(d);
  if (theta < 1e-6) return set(out, a.x, a.y, a.z);
  // Opposite directions: go around through "up" rather than through the body.
  if (Math.PI - theta < 1e-3) {
    const up = km(0, 1, 0);
    const half = slerp(a, up, 1, km());
    return t < 0.5 ? slerp(a, half, t * 2, out) : slerp(half, b, (t - 0.5) * 2, out);
  }
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return norm(set(out, a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb));
}

interface Flight {
  from: BodyId;
  to: BodyId;
  elapsed: number;
  seconds: number;
  /** Start and end: direction from the body to the camera, and log distance. */
  dirFrom: Km;
  dirTo: Km;
  lnFrom: number;
  lnTo: number;
  lnPeak: number;
  /** A reduced-motion cut instead of a flight. */
  cut: boolean;
  /** The entry glide: one body, distance falling smoothly the whole way. */
  approach: boolean;
}

export class Navigator {
  focus: BodyId;
  private azimuth = 0;
  private elevation = 0.2;
  private lnDistance = Math.log(30_000);
  private goal = { azimuth: 0, elevation: 0.2, lnDistance: Math.log(30_000) };
  private flight: Flight | null = null;
  /** A body asked for during a flight: the camera goes there once it has arrived (never a mid-air swerve). */
  private queued: BodyId | null = null;
  /** The last pose written, so a new flight starts exactly where the camera is. */
  private readonly last: NavOutput = { position: km(), target: km(), dim: 1, progress: 1, from: null };
  /** Held keys' rates: [azimuth, elevation, zoom] per second. */
  private readonly keyRates: [number, number, number] = [0, 0, 0];
  reducedMotion = false;
  private readonly scratch = { a: km(), b: km(), c: km(), d: km() };

  constructor(focus: BodyId) {
    this.focus = focus;
  }

  get travelling(): boolean {
    return this.flight !== null;
  }

  /** The framing distance for a body, km from its centre. */
  static framingKm(body: NavBody): number {
    return body.boundKm * body.framing;
  }

  private minDistance(body: NavBody): number {
    return body.radiusKm + body.minAltitudeKm;
  }

  /** The direction a flight arrives from: the sunlit side, a little above, partly looking back where it came from. */
  private arrival(world: NavWorld, from: NavBody, to: NavBody, out: Km): Km {
    const { a, b } = this.scratch;
    set(a, world.sun.x - to.position.x, world.sun.y - to.position.y, world.sun.z - to.position.z);
    set(b, to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z);
    if (to.id === 'sun' || Math.hypot(a.x, a.y, a.z) < 1) {
      // To the Sun: arrive from the side we came from.
      set(out, -b.x, -b.y, -b.z);
      if (Math.hypot(out.x, out.y, out.z) < 1) set(out, 0, 0, 1);
      norm(out);
      return norm(set(out, out.x, out.y + 0.3, out.z));
    }
    norm(a);
    if (Math.hypot(b.x, b.y, b.z) < 1) set(b, a.x, a.y, a.z);
    norm(b);
    return norm(set(out, a.x * 0.8 + b.x * 0.6, a.y * 0.8 + b.y * 0.6 + 0.3, a.z * 0.8 + b.z * 0.6));
  }

  /**
   * The first view of a body: its sunlit face turned a little away, so the terminator shows, from
   * slightly above its orbit. (The Sun: seen from the Earth's side.)
   */
  private entryDirection(world: NavWorld, body: NavBody, out: Km): Km {
    const toward = body.id === 'sun' ? world.body('earth').position : world.sun;
    const { a } = this.scratch;
    norm(set(a, toward.x - body.position.x, toward.y - body.position.y, toward.z - body.position.z));
    const { azimuth } = angles(a);
    return direction(azimuth + (body.id === 'sun' ? 0.35 : 0.95), 0.22, out);
  }

  /**
   * Starts at a body: with `approach`, a glide in from far away (the entry), else straight at its
   * framing distance.
   */
  begin(world: NavWorld, id: BodyId, approach: boolean): void {
    const body = world.body(id);
    this.focus = id;
    this.queued = null;
    const dirTo = this.entryDirection(world, body, km());
    const lnTo = Math.log(Navigator.framingKm(body));
    if (!approach || this.reducedMotion) {
      this.flight = null;
      this.settle(dirTo, lnTo);
      this.orbitPose(body, this.last);
      return;
    }
    // Swing in from a little to one side, so the arrival has some parallax.
    const { azimuth, elevation } = angles(dirTo);
    const dirFrom = direction(azimuth - 0.6, clamp(elevation + 0.18, -MAX_ELEVATION, MAX_ELEVATION), km());
    const lnFrom = lnTo + Math.log(APPROACH.from);
    this.flight = { from: id, to: id, elapsed: 0, seconds: APPROACH.seconds, dirFrom, dirTo, lnFrom, lnTo, lnPeak: lnFrom, cut: false, approach: true };
    this.settle(dirFrom, lnFrom);
  }

  /** Flies to a body from wherever the camera is now (after the current flight, if one is under way). */
  flyTo(world: NavWorld, id: BodyId): void {
    if (this.flight) {
      this.queued = id === this.flight.to ? null : id;
      return;
    }
    const to = world.body(id);
    const from = world.body(this.focus);
    if (id === this.focus) {
      // Already here: ease back to the framing distance.
      this.goal.lnDistance = Math.log(Navigator.framingKm(to));
      return;
    }
    const camera = this.last.position;
    const offset = set(km(), camera.x - from.position.x, camera.y - from.position.y, camera.z - from.position.z);
    const lnFrom = Math.log(Math.max(1, Math.hypot(offset.x, offset.y, offset.z)));
    const dirFrom = norm(offset);
    const dirTo = this.arrival(world, from, to, km());
    const lnTo = Math.log(Navigator.framingKm(to));
    const span = Math.hypot(to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z);
    // Far enough back that both bodies fit a 50 degree view from the midpoint.
    const lnPeak = Math.max(lnFrom, lnTo, Math.log(Math.max(1, 1.15 * span)));
    const zoom = (Math.abs(lnPeak - lnFrom) + Math.abs(lnPeak - lnTo)) / (2 * Math.LN10);
    const seconds = this.reducedMotion ? 2 * CUT.seconds : clamp(2.8 + 0.85 * zoom, 2.8, 9);
    this.flight = { from: this.focus, to: id, elapsed: 0, seconds, dirFrom, dirTo, lnFrom, lnTo, lnPeak, cut: this.reducedMotion, approach: false };
    this.focus = id;
  }

  /** Puts the camera at once (tests, captures): no flight, no easing. */
  place(id: BodyId, dir: Km, distanceKm: number, world: NavWorld): void {
    this.focus = id;
    this.flight = null;
    this.queued = null;
    const body = world.body(id);
    this.settle(norm(set(km(), dir.x, dir.y, dir.z)), Math.log(clamp(distanceKm, this.minDistance(body), MAX_DISTANCE_KM)));
    this.orbitPose(body, this.last);
  }

  /** Orbit input: radians of azimuth and elevation (drags, keys). Ignored during a flight. */
  rotate(dAzimuth: number, dElevation: number): void {
    if (this.flight) return;
    this.goal.azimuth += dAzimuth;
    this.goal.elevation = clamp(this.goal.elevation + dElevation, -MAX_ELEVATION, MAX_ELEVATION);
  }

  /** Zoom input: natural-log units of distance (positive moves away). Ignored during a flight. */
  zoom(dLn: number): void {
    if (this.flight) return;
    this.goal.lnDistance += dLn;
  }

  setKeyRates(azimuth: number, elevation: number, zoom: number): void {
    this.keyRates[0] = azimuth * KEY_TURN;
    this.keyRates[1] = elevation * KEY_TURN;
    this.keyRates[2] = zoom * KEY_ZOOM;
  }

  /** Advances by dt seconds and writes the camera pose. */
  update(world: NavWorld, dt: number, out: NavOutput): NavOutput {
    this.advance(world, dt, out);
    set(this.last.position, out.position.x, out.position.y, out.position.z);
    set(this.last.target, out.target.x, out.target.y, out.target.z);
    if (!this.flight && this.queued) {
      const next = this.queued;
      this.queued = null;
      this.flyTo(world, next);
    }
    return out;
  }

  private advance(world: NavWorld, dt: number, out: NavOutput): void {
    out.dim = 1;
    out.progress = 1;
    out.from = null;
    const flight = this.flight;
    if (flight) {
      flight.elapsed += dt;
      const s = clamp(flight.elapsed / flight.seconds, 0, 1);
      out.progress = s;
      out.from = flight.approach ? null : flight.from;
      if (flight.cut) this.cutStep(world, flight, s, out);
      else this.flightStep(world, flight, s, out);
      if (s >= 1) {
        this.flight = null;
        this.settle(flight.dirTo, flight.lnTo);
      } else {
        this.keepOutside(world, out.position);
        return;
      }
    }
    const body = world.body(this.focus);
    // Orbiting: keys add to the goals, everything eases toward them.
    this.goal.azimuth += this.keyRates[0] * dt;
    this.goal.elevation = clamp(this.goal.elevation + this.keyRates[1] * dt, -MAX_ELEVATION, MAX_ELEVATION);
    this.goal.lnDistance += this.keyRates[2] * dt;
    this.goal.lnDistance = clamp(this.goal.lnDistance, Math.log(this.minDistance(body)), Math.log(MAX_DISTANCE_KM));
    const turn = ease(dt, this.reducedMotion ? 0 : TURN_SECONDS);
    const zoom = ease(dt, this.reducedMotion ? 0 : ZOOM_SECONDS);
    this.azimuth += (this.goal.azimuth - this.azimuth) * turn;
    this.elevation += (this.goal.elevation - this.elevation) * turn;
    this.lnDistance += (this.goal.lnDistance - this.lnDistance) * zoom;
    this.orbitPose(body, out);
  }

  /** The orbiting camera's pose from its current angles and distance. */
  private orbitPose(body: NavBody, out: CameraPose): void {
    const dir = direction(this.azimuth, this.elevation, this.scratch.c);
    const r = Math.exp(this.lnDistance);
    set(out.position, body.position.x + dir.x * r, body.position.y + dir.y * r, body.position.z + dir.z * r);
    lookTarget(out.position, body.position, body.radiusKm, out.target);
  }

  private settle(dir: Km, ln: number): void {
    const { azimuth, elevation } = angles(dir);
    this.azimuth = azimuth;
    this.elevation = clamp(elevation, -MAX_ELEVATION, MAX_ELEVATION);
    this.lnDistance = ln;
    this.goal.azimuth = this.azimuth;
    this.goal.elevation = this.elevation;
    this.goal.lnDistance = ln;
  }

  private flightStep(world: NavWorld, f: Flight, s: number, out: NavOutput): void {
    const a = world.body(f.from).position;
    const b = world.body(f.to).position;
    // Pan across while backed away; turn toward the arrival side over the second half.
    const w = smootherstep(0.12, 0.88, s);
    set(out.target, a.x + (b.x - a.x) * w, a.y + (b.y - a.y) * w, a.z + (b.z - a.z) * w);
    let ln: number;
    if (f.approach) ln = f.lnFrom + (f.lnTo - f.lnFrom) * smootherstep(0, 1, s);
    else if (s < 0.5) ln = f.lnFrom + (f.lnPeak - f.lnFrom) * smootherstep(0, 0.5, s);
    else ln = f.lnPeak + (f.lnTo - f.lnPeak) * smootherstep(0.5, 1, s);
    const dir = slerp(f.dirFrom, f.dirTo, smootherstep(f.approach ? 0 : 0.2, 1, s), this.scratch.d);
    const r = Math.exp(ln);
    set(out.position, out.target.x + dir.x * r, out.target.y + dir.y * r, out.target.z + dir.z * r);
    // The same lifted gaze as when orbiting, so a flight that starts or ends low does not jump.
    const near = world.body(s < 0.5 ? f.from : f.to);
    const centre = this.scratch.b;
    set(centre, out.target.x, out.target.y, out.target.z);
    lookTarget(out.position, centre, near.radiusKm, out.target);
    this.lnDistance = ln;
  }

  private cutStep(world: NavWorld, f: Flight, s: number, out: NavOutput): void {
    // First half: dim at the start pose. Second half: the new pose, the light returning.
    const at = s < 0.5 ? world.body(f.from).position : world.body(f.to).position;
    const dir = s < 0.5 ? f.dirFrom : f.dirTo;
    const ln = s < 0.5 ? f.lnFrom : f.lnTo;
    out.dim = s < 0.5 ? CUT.dim + (1 - CUT.dim) * (1 - smootherstep(0, 0.35, s)) : CUT.dim + (1 - CUT.dim) * smootherstep(0.55, 1, s);
    const r = Math.exp(ln);
    set(out.position, at.x + dir.x * r, at.y + dir.y * r, at.z + dir.z * r);
    lookTarget(out.position, at, world.body(s < 0.5 ? f.from : f.to).radiusKm, out.target);
    this.lnDistance = ln;
  }

  /** No frame of a flight may be inside a body: push the camera out to just above any it would enter. */
  private keepOutside(world: NavWorld, position: Km): void {
    for (const body of world.all) {
      const dx = position.x - body.position.x;
      const dy = position.y - body.position.y;
      const dz = position.z - body.position.z;
      const d = Math.hypot(dx, dy, dz);
      const floor = this.minDistance(body);
      if (d >= floor || d === 0) continue;
      const k = floor / d;
      set(position, body.position.x + dx * k, body.position.y + dy * k, body.position.z + dz * k);
    }
  }
}
