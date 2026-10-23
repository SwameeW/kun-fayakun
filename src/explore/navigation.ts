/**
 * The explorer's camera for this stage: it orbits one body at a time and flies between them.
 * Pure (no three.js); positions are float64 km in the render frame (./space/origin).
 *
 * Orbiting: azimuth and elevation around the body, and the distance, all eased toward their
 * goals (an exponential approach, so drags and wheel steps glide to rest). Distance moves in
 * log space, so a wheel step changes the view by the same proportion at 200 km or at 5 au,
 * between a floor above the body's air (or 2% of its radius) and 50 au.
 *
 * Framing: a body is shown at a distance that fits it (with Saturn's rings) to a set share of the
 * narrower side of the part of the view the interface leaves clear, so a phone held upright frames
 * it as well as a wide screen; the explorer tilts the camera so the body sits in the middle of that
 * clear part. Each body is first seen from its own side: the sunlit face turned a little away so
 * the terminator shows, Jupiter from low latitude, Saturn from the side of its rings the Sun lights.
 *
 * Flying: the camera turns to the destination and comes in on it, its distance to it falling
 * smoothly in log space the whole way (never swinging away), along an arc that rises out of the
 * planets' plane and keeps well clear of the Sun; the destination stays centred, a point and its
 * name growing into a world. Its length grows with the zoom it covers (2.6 to 8 s). With reduced
 * motion the flight is a dimmed cut instead (the picture dips, the camera moves unseen, it returns).
 * Entering, the camera glides in from far away to the first body (none with reduced motion).
 */

import type { BodyId } from '../core/types';
import { km, type Km } from './space/origin';

/** How a body is first seen: turned this far (radians) from its sunlit face, from this latitude. */
export interface ViewPreference {
  azimuth: number;
  latitude: number;
  /** The latitude is taken on the side of the equator the Sun lights (Saturn: its rings' lit face). */
  litFace: boolean;
}

export interface NavBody {
  readonly id: BodyId;
  readonly radiusKm: number;
  readonly boundKm: number;
  readonly minAltitudeKm: number;
  /** Share of the narrower clear side of the view the bounding sphere spans when framed. */
  readonly fill: number;
  readonly view: ViewPreference;
  /** Centre now, render frame, km. */
  readonly position: Km;
  /** North pole (unit), render frame. */
  readonly pole: Km;
}

export interface NavWorld {
  body(id: BodyId): NavBody;
  /** Every body, to keep a flight's camera out of them all. */
  readonly all: readonly NavBody[];
  /** The Sun's centre (for the sunlit side). */
  readonly sun: Km;
}

/** The view the camera frames bodies in: its vertical half-angle's tangent, its aspect, and the shares of its height the interface covers. */
export interface NavView {
  tanHalfFov: number;
  aspect: number;
  top: number;
  bottom: number;
}

export interface CameraPose {
  /** Camera position, render frame, km (float64). */
  readonly position: Km;
  /** The point it looks at. */
  readonly target: Km;
}

export interface NavOutput extends CameraPose {
  /** How much the picture is dimmed for a reduced-motion cut (1 = not at all). */
  dim: number;
  /** True on the one frame a reduced-motion cut moves the camera (the exposure may jump with it). */
  cut: boolean;
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
/** Flight length: base and per decade of the distance it covers (over the arrival distance), seconds, and its bounds. */
const FLIGHT = { base: 2.6, perDecade: 0.85, min: 2.6, max: 8 } as const;
/**
 * The arc's angle out of the planets' plane at its middle (radians, about 20 degrees), and how close
 * to the Sun a flight between two other bodies may pass, as a share of the nearer one's distance from it.
 */
const ARC = { lift: 0.35, sunClearance: 0.45 } as const;
/** Share of a flight spent turning the gaze from where it was to the destination. */
const GAZE_TURN = 0.3;
/** Reduced-motion cut: the dim (a share of the light), and how long each half takes. */
const CUT = { dim: 0.15, seconds: 1.1 } as const;
/**
 * Low over a body the gaze lifts from its centre toward the horizon, so the limb, the air and space
 * stay in view instead of a screen of ground: the horizon is held this far (radians) above the
 * middle of the view once it would otherwise climb past it.
 */
const HORIZON_VIEW = 0.3;
/** The camera counts as moving while its pose changes by more than this share of its distance per frame. */
const STILL = 1e-6;

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
const copy = (out: Km, v: Km): Km => set(out, v.x, v.y, v.z);
const norm = (v: Km): Km => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return set(v, v.x / l, v.y / l, v.z / l);
};
const dot = (a: Km, b: Km): number => a.x * b.x + a.y * b.y + a.z * b.z;

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
  const d = clamp(dot(a, b), -1, 1);
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
  /** The start: the camera's offset from the body it left, and the direction it was looking. */
  startOffset: Km;
  gaze: Km;
  /** The end: direction from the destination to the camera, and log distance. */
  dirTo: Km;
  lnTo: number;
  /** How far the arc rises out of the planets' plane (a tangent). */
  lift: number;
  /** A reduced-motion cut instead of a flight; for a cut, the start's direction and log distance. */
  cut: boolean;
  dirFrom: Km;
  lnFrom: number;
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
  private readonly last: NavOutput = { position: km(), target: km(), dim: 1, cut: false, progress: 1, from: null };
  /** Held keys' rates: [azimuth, elevation, zoom] per second. */
  private readonly keyRates: [number, number, number] = [0, 0, 0];
  reducedMotion = false;
  /** The camera's pose changed this frame. */
  moving = false;
  private view: NavView = { tanHalfFov: Math.tan((25 * Math.PI) / 180), aspect: 16 / 10, top: 0, bottom: 0 };
  private readonly scratch = { a: km(), b: km(), c: km(), d: km(), e: km(), f: km(), g: km(), h: km() };

  constructor(focus: BodyId) {
    this.focus = focus;
  }

  get travelling(): boolean {
    return this.flight !== null;
  }

  /** The view bodies are framed in (call when the window or the interface around it changes). */
  setView(view: NavView): void {
    this.view = { ...view };
  }

  /** The framing distance for a body in the current view, km from its centre. */
  framingKm(body: NavBody): number {
    const { tanHalfFov, aspect, top, bottom } = this.view;
    const clear = Math.max(0.35, 1 - top - bottom);
    // On the image plane at distance 1 the view is 2 tan(fov/2) high; the narrower clear side, then
    // the bounding sphere's tangent half-angle that spans `fill` of it.
    const narrower = 2 * tanHalfFov * Math.min(clear, aspect);
    const t = (body.fill * narrower) / 2;
    return (body.boundKm * Math.sqrt(1 + t * t)) / t;
  }

  private minDistance(body: NavBody): number {
    return body.radiusKm + body.minAltitudeKm;
  }

  /**
   * The direction (from a body's centre) it is seen from at first: its sunlit face (the Sun: the
   * Earth's side) turned by its preferred azimuth, toward `toward` when given (the side a flight
   * comes from), at its preferred latitude.
   */
  private preferredDirection(world: NavWorld, body: NavBody, toward: Km | null, out: Km): Km {
    const { a, b, c } = this.scratch;
    const light = body.id === 'sun' ? world.body('earth').position : world.sun;
    norm(set(a, light.x - body.position.x, light.y - body.position.y, light.z - body.position.z));
    const pole = body.pole;
    // The light's direction across the body's equator, and the equator's direction a quarter turn on.
    const lightLatitude = dot(a, pole);
    set(b, a.x - pole.x * lightLatitude, a.y - pole.y * lightLatitude, a.z - pole.z * lightLatitude);
    if (Math.hypot(b.x, b.y, b.z) < 1e-6) set(b, 1, 0, 0);
    norm(b);
    set(c, pole.y * b.z - pole.z * b.y, pole.z * b.x - pole.x * b.z, pole.x * b.y - pole.y * b.x);
    let azimuth = body.view.azimuth;
    if (toward && dot(toward, c) < 0) azimuth = -azimuth;
    const latitude = body.view.litFace && lightLatitude < 0 ? -body.view.latitude : body.view.latitude;
    const cosA = Math.cos(azimuth);
    const sinA = Math.sin(azimuth);
    const cosL = Math.cos(latitude);
    const sinL = Math.sin(latitude);
    return norm(
      set(
        out,
        (b.x * cosA + c.x * sinA) * cosL + pole.x * sinL,
        (b.y * cosA + c.y * sinA) * cosL + pole.y * sinL,
        (b.z * cosA + c.z * sinA) * cosL + pole.z * sinL,
      ),
    );
  }

  /**
   * Starts at a body: with `approach`, a glide in from far away (the entry), else straight at its
   * framing distance.
   */
  begin(world: NavWorld, id: BodyId, approach: boolean): void {
    const body = world.body(id);
    this.focus = id;
    this.queued = null;
    const dirTo = this.preferredDirection(world, body, null, km());
    const lnTo = Math.log(this.framingKm(body));
    if (!approach || this.reducedMotion) {
      this.flight = null;
      this.settle(dirTo, lnTo);
      this.orbitPose(body, this.last);
      return;
    }
    // Swing in from a little to one side and above, so the arrival has some parallax.
    const { azimuth, elevation } = angles(dirTo);
    const dirFrom = direction(azimuth - 0.6, clamp(elevation + 0.18, -MAX_ELEVATION, MAX_ELEVATION), km());
    const lnFrom = lnTo + Math.log(APPROACH.from);
    const r = Math.exp(lnFrom);
    const startOffset = km(dirFrom.x * r, dirFrom.y * r, dirFrom.z * r);
    const gaze = km(-dirFrom.x, -dirFrom.y, -dirFrom.z);
    this.flight = { from: id, to: id, elapsed: 0, seconds: APPROACH.seconds, startOffset, gaze, dirTo, lnTo, lift: 0, cut: false, dirFrom, lnFrom, approach: true };
    this.settle(dirFrom, lnFrom);
    set(this.last.position, body.position.x + startOffset.x, body.position.y + startOffset.y, body.position.z + startOffset.z);
    copy(this.last.target, body.position);
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
      this.goal.lnDistance = Math.log(this.framingKm(to));
      return;
    }
    const camera = this.last.position;
    const startOffset = km(camera.x - from.position.x, camera.y - from.position.y, camera.z - from.position.z);
    const gaze = norm(km(this.last.target.x - camera.x, this.last.target.y - camera.y, this.last.target.z - camera.z));
    const incoming = norm(km(camera.x - to.position.x, camera.y - to.position.y, camera.z - to.position.z));
    const dirTo = this.preferredDirection(world, to, incoming, km());
    const lnTo = Math.log(this.framingKm(to));
    const distance = Math.max(1, Math.hypot(camera.x - to.position.x, camera.y - to.position.y, camera.z - to.position.z));
    const decades = Math.max(0, Math.log10(distance) - lnTo / Math.LN10);
    const seconds = this.reducedMotion ? 2 * CUT.seconds : clamp(FLIGHT.base + FLIGHT.perDecade * decades, FLIGHT.min, FLIGHT.max);
    // Short hops barely leave the plane; long flights rise out of it (to ecliptic north, the same for all).
    const lift = ARC.lift * smootherstep(0.5, 2.5, decades);
    const dirFrom = norm(km(startOffset.x, startOffset.y, startOffset.z));
    this.flight = {
      from: this.focus,
      to: id,
      elapsed: 0,
      seconds,
      startOffset,
      gaze,
      dirTo,
      lnTo,
      lift,
      cut: this.reducedMotion,
      dirFrom,
      lnFrom: Math.log(Math.max(1, Math.hypot(startOffset.x, startOffset.y, startOffset.z))),
      approach: false,
    };
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
    const { e, f } = this.scratch;
    copy(e, this.last.position);
    copy(f, this.last.target);
    this.advance(world, dt, out);
    const scale = Math.max(1, Math.hypot(out.position.x - out.target.x, out.position.y - out.target.y, out.position.z - out.target.z));
    const moved = Math.hypot(out.position.x - e.x, out.position.y - e.y, out.position.z - e.z) + Math.hypot(out.target.x - f.x, out.target.y - f.y, out.target.z - f.z);
    this.moving = this.flight !== null || moved > STILL * scale;
    copy(this.last.position, out.position);
    copy(this.last.target, out.target);
    if (!this.flight && this.queued) {
      const next = this.queued;
      this.queued = null;
      this.flyTo(world, next);
    }
    return out;
  }

  private advance(world: NavWorld, dt: number, out: NavOutput): void {
    out.dim = 1;
    out.cut = false;
    out.progress = 1;
    out.from = null;
    const flight = this.flight;
    if (flight) {
      const before = flight.elapsed / flight.seconds;
      flight.elapsed += dt;
      const s = clamp(flight.elapsed / flight.seconds, 0, 1);
      out.progress = s;
      out.from = flight.approach ? null : flight.from;
      if (flight.cut) {
        this.cutStep(world, flight, s, out);
        out.cut = before < 0.5 && s >= 0.5;
      } else {
        this.flightStep(world, flight, s, out);
      }
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

  /**
   * One frame of a flight. The camera travels from where it was to the arrival pose along an arc
   * that rises out of the planets' plane, its progress paced in log space: leaving, its distance
   * from the start grows exponentially from nothing (the body it left recedes as if zooming out);
   * arriving, its distance to the end shrinks exponentially (the destination grows from a point into
   * a world), so its distance to the destination only ever falls. The gaze turns from where it was
   * to the destination early and then stays on it.
   */
  private flightStep(world: NavWorld, f: Flight, s: number, out: NavOutput): void {
    const { a, b, d } = this.scratch;
    const from = world.body(f.from);
    const to = world.body(f.to);
    if (f.approach) {
      // The entry glide: centred on the one body, its distance falling smoothly in log space.
      norm(copy(a, f.startOffset));
      const ln = Math.log(Math.max(1, Math.hypot(f.startOffset.x, f.startOffset.y, f.startOffset.z)));
      const lnNow = ln + (f.lnTo - ln) * smootherstep(0, 1, s);
      const dir = slerp(a, f.dirTo, smootherstep(0, 1, s), d);
      const r = Math.exp(lnNow);
      set(out.position, to.position.x + dir.x * r, to.position.y + dir.y * r, to.position.z + dir.z * r);
      lookTarget(out.position, to.position, to.radiusKm, out.target);
      this.lnDistance = lnNow;
      return;
    }
    // Leaving, centred on the body left; arriving, centred on the destination. Each half moves in
    // log distance from its body, exponentially away and exponentially in, and they meet halfway,
    // raised out of the planets' plane by the arc's angle (both halves reach the same point).
    const { g: c, h: e } = this.scratch;
    set(c, to.position.x - from.position.x, to.position.y - from.position.y, to.position.z - from.position.z);
    const span = Math.max(1, Math.hypot(c.x, c.y, c.z));
    norm(c);
    const tilt = f.lift;
    const halfway = span / 2 / Math.cos(tilt);
    // "Up" square to the line between the bodies (ecliptic north, or any square direction if they lie along it).
    set(e, -c.y * c.x, 1 - c.y * c.y, -c.y * c.z);
    if (Math.hypot(e.x, e.y, e.z) < 1e-6) set(e, 1, 0, 0);
    norm(e);
    const lnLeave = Math.log(Math.max(1, Math.hypot(f.startOffset.x, f.startOffset.y, f.startOffset.z)));
    const lnHalf = Math.log(halfway);
    // Leaving takes at most a third of the time: once the body left is a point there is little to
    // see until the destination grows, so the arrival, slowing all the way in, gets the rest.
    const leaveShare = clamp((lnHalf - lnLeave) / Math.max(1e-6, lnHalf - lnLeave + (lnHalf - f.lnTo)), 0.2, 0.34);
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    if (s < leaveShare) {
      const t = s / leaveShare;
      norm(copy(a, f.startOffset));
      set(b, c.x * cosT + e.x * sinT, c.y * cosT + e.y * sinT, c.z * cosT + e.z * sinT);
      const dir = slerp(a, b, smootherstep(0, 1, t), d);
      const r = Math.exp(lnLeave + (lnHalf - lnLeave) * t * t);
      set(out.position, from.position.x + dir.x * r, from.position.y + dir.y * r, from.position.z + dir.z * r);
    } else {
      const t = (s - leaveShare) / (1 - leaveShare);
      set(a, -c.x * cosT + e.x * sinT, -c.y * cosT + e.y * sinT, -c.z * cosT + e.z * sinT);
      const dir = slerp(a, f.dirTo, smootherstep(0, 1, t), d);
      const r = Math.exp(lnHalf + (f.lnTo - lnHalf) * (1 - (1 - t) ** 3));
      set(out.position, to.position.x + dir.x * r, to.position.y + dir.y * r, to.position.z + dir.z * r);
    }
    if (f.to !== 'sun' && f.from !== 'sun') this.clearOfSun(world, from, to, out.position);
    // The gaze: from where it was to the destination's (the lifted horizon gaze if arriving low).
    lookTarget(out.position, to.position, to.radiusKm, b);
    const range = Math.max(1, Math.hypot(b.x - out.position.x, b.y - out.position.y, b.z - out.position.z));
    norm(set(b, b.x - out.position.x, b.y - out.position.y, b.z - out.position.z));
    const gaze = slerp(f.gaze, b, smootherstep(0, GAZE_TURN, s), a);
    set(out.target, out.position.x + gaze.x * range, out.position.y + gaze.y * range, out.position.z + gaze.z * range);
    this.lnDistance = Math.log(Math.max(1, Math.hypot(out.position.x - to.position.x, out.position.y - to.position.y, out.position.z - to.position.z)));
  }

  /** Pushes a flight's camera out from the Sun to a share of the nearer body's distance from it. */
  private clearOfSun(world: NavWorld, from: NavBody, to: NavBody, position: Km): void {
    const sun = world.sun;
    const dx = position.x - sun.x;
    const dy = position.y - sun.y;
    const dz = position.z - sun.z;
    const r = Math.hypot(dx, dy, dz);
    const nearest = Math.min(Math.hypot(from.position.x - sun.x, from.position.y - sun.y, from.position.z - sun.z), Math.hypot(to.position.x - sun.x, to.position.y - sun.y, to.position.z - sun.z));
    const floor = ARC.sunClearance * nearest;
    if (r >= floor || r === 0) return;
    // A soft floor (x + (1 - x)^2 / 2 of it): no kink where it starts to push, and never under half of it.
    const x = r / floor;
    const k = (floor * (x + 0.5 * (1 - x) * (1 - x))) / r;
    set(position, sun.x + dx * k, sun.y + dy * k, sun.z + dz * k);
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
