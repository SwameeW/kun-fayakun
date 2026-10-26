/**
 * The explorer's camera: orbiting one body, flying freely, or travelling between bodies. Pure (no
 * three.js); positions are float64 km in the render frame (./space/origin).
 *
 * Orbit (./flight OrbitRig): drags turn the camera round the body in focus, the wheel and pinches
 * zoom in the logarithm of its height above the surface, two fingers (or a right drag) pan. Drags
 * turn more gently low over a world, so the ground under the pointer moves about as far as it.
 * Free flight (./flight FreeFlight): W A S D, R F and Q E fly the camera in its own frame, at a speed
 * proportional to its height above the nearest surface; a drag then turns the view. Any flight
 * input leaves orbit seamlessly (the camera stays exactly where it was), and "orbit" (O, or the
 * interface's button) hands back to orbiting the nearest body, the gaze easing round to it.
 *
 * Framing: a body is shown at a distance that fits it (with Saturn's rings) to a set share of the
 * narrower side of the part of the view the interface leaves clear, so a phone held upright frames
 * it as well as a wide screen. Each body is first seen from its own side: the sunlit face turned a
 * little away so the terminator shows, Jupiter from low latitude, Saturn from the side of its rings
 * the Sun lights.
 *
 * Travel (./travel): a cinematic trip in log space with ease in and out, banking a little into its
 * turns and widening the lens a touch at speed, never through a body. Esc (cancelTravel) stops it:
 * the camera coasts to rest where it is, in free flight. A body asked for during a trip is flown to
 * once the camera has arrived (never a swerve in mid-air). With reduced motion a trip is a dimmed
 * cut instead, and the lens and the bank stay still; Esc before the cut calls it off (the light
 * comes back where the visitor was). Entering, the camera pushes in gently on the first body, which
 * already fills much of the view (none with reduced motion).
 */

import type { BodyId } from '../core/types';
import {
  angles,
  clamp,
  copy,
  cross,
  direction,
  dot,
  FreeFlight,
  flightControls,
  len,
  lookDirection,
  MAX_ALTITUDE_KM,
  MAX_ELEVATION,
  nearestSurface,
  normalize,
  OrbitRig,
  rigPose,
  rotateAbout,
  set,
  slerpDir,
  smootherstep,
  springOf,
  squareUp,
  stepSpring,
  sub,
  UP,
  keepOutside,
  type FlightControls,
} from './flight';
import { km, type Km } from './space/origin';
import { planTravel, travelFrame, type TravelFrame, type TravelPlan } from './travel';

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
  /** Every body, to keep the camera out of them all. */
  readonly all: readonly NavBody[];
  /** The Sun's centre (for the sunlit side). */
  readonly sun: Km;
}

/**
 * The view the camera frames bodies in: its vertical half-angle's tangent at the resting lens, its
 * aspect, and the shares of its height (top, bottom) and width (left, right) the interface covers.
 */
export interface NavView {
  tanHalfFov: number;
  aspect: number;
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}

export interface CameraPose {
  /** Camera position, render frame, km (float64). */
  readonly position: Km;
  /** A point it looks at (on its line of sight). */
  readonly target: Km;
}

export type NavMode = 'orbit' | 'flight';

export interface NavOutput extends CameraPose {
  /** Unit line of sight and unit "up" (square to it, including any bank). */
  readonly forward: Km;
  readonly up: Km;
  /** Vertical field of view, degrees. */
  fov: number;
  /** How much the picture is dimmed for a reduced-motion cut (1 = not at all). */
  dim: number;
  /** True on the one frame a reduced-motion cut moves the camera (the exposure may jump with it). */
  cut: boolean;
  /** 0 at the start of a trip, 1 when the camera has arrived (1 while orbiting or flying). */
  progress: number;
  /** The body the trip left, while travelling. */
  from: BodyId | null;
  mode: NavMode;
  /** Camera speed, km/s (relative to the body it is near). */
  speedKmS: number;
}

export const navOutput = (): NavOutput => ({
  position: km(),
  target: km(),
  forward: km(0, 0, -1),
  up: km(0, 1, 0),
  fov: 50,
  dim: 1,
  cut: false,
  progress: 1,
  from: null,
  mode: 'orbit',
  speedKmS: 0,
});

/** Drag rate far from a body, radians per CSS pixel; low over one it falls with the height (see dragRate). */
const DRAG_RADIANS_PER_PX = 0.0055;
/** Keyboard rates: radians and natural-log units of height per second. */
const KEY_TURN = 1.1;
/**
 * The Earth's zoom lens ("zoom anywhere"): past the lowest orbit, zooming in narrows the field of
 * view instead, down to this many degrees (set by the imagery: about four screen pixels per texel of
 * the finest layer streaming). A glide between places takes this long per radian of arc (within the
 * bounds) and lifts this much (natural-log units of height per radian) on long ones.
 */
export const LENS = { minDeg: 1.2, glidePerRadian: 1.5, glideSeconds: [1.4, 4.5], liftPerRadian: 1.4, maxLift: 2.4 } as const;
const KEY_ZOOM = 1.2;
/**
 * Entry glide: a slow push in from this many times the framing distance, over this long, swinging
 * round by `swing` radians and settling `drop` radians lower. The first frame already has the world
 * filling a good part of the view (never a dot in an empty sky), and the glide is a camera move, not
 * a journey: the picture comes up under it.
 */
const APPROACH = { from: 2.4, seconds: 5.5, swing: 0.32, drop: 0.1 } as const;
/** Reduced-motion cut: the dim (a share of the light), and how long each half takes. */
const CUT = { dim: 0.15, seconds: 1.1 } as const;
/** A cut's dim at progress s: down over its first third, held, back up over its last half (eased both ways). */
const cutDim = (s: number): number =>
  s < 0.5 ? CUT.dim + (1 - CUT.dim) * (1 - smootherstep(0, 0.35, s)) : CUT.dim + (1 - CUT.dim) * smootherstep(0.55, 1, s);
/** Bank into a trip's turns: radians per (radian per second) of turn, its limit, and its spring. */
const BANK = { perTurnRate: 0.55, max: 0.14, omega: 3.5 } as const;
/** The lens widens by up to this many degrees at a trip's fastest, and eases back (its spring, rad/s). */
const TRIP_LENS = { widen: 5, omega: 3.5 } as const;
/** The gaze eases to straight down over a place, and back up after, at this spring rate (rad/s). */
const NADIR_OMEGA = 2.8;
/** After free flight the gaze eases round to the orbited body over about a second (spring, rad/s). */
const HANDOFF_OMEGA = 4.2;
/** Closer than this many framing distances, a body asked for is orbited where the camera is rather than flown to. */
const ALREADY_THERE = 1.25;
/** The camera counts as moving while its pose changes by more than this share of its distance per frame. */
const STILL = 1e-6;
/** The pan keeps the rig within this many bounding radii (plus height) of the body. */
const PAN_LIMIT = 2;

interface Trip {
  /**
   * 'travel' a flight, 'cut' a reduced-motion cut, 'approach' the entry glide; 'uncut' a cut that
   * Esc stopped before it moved the camera: the light comes back where the visitor was.
   */
  kind: 'travel' | 'cut' | 'approach' | 'uncut';
  from: BodyId;
  to: BodyId;
  elapsed: number;
  seconds: number;
  /** Travel: its plan. */
  plan: TravelPlan | null;
  /** Cut and approach: the start's direction and log height above the surface, and the end's. */
  dirFrom: Km;
  lnFrom: number;
  dirTo: Km;
  lnTo: number;
  /** Cut: how the camera moved and what it orbited before it (an uncut hands back to them). */
  modeBefore: NavMode;
  focusBefore: BodyId;
  /** Uncut: the dim it starts from. */
  dimFrom: number;
}

export class Navigator {
  focus: BodyId;
  reducedMotion = false;
  /** The camera's pose changed this frame. */
  moving = false;
  private modeValue: NavMode = 'orbit';
  private readonly orbit = new OrbitRig();
  private readonly flight = new FreeFlight();
  private readonly controls: FlightControls = flightControls();
  /** Held orbit keys: [azimuth, elevation, zoom], -1 to 1. */
  private readonly orbitKeys: [number, number, number] = [0, 0, 0];
  private trip: Trip | null = null;
  private queued: BodyId | null = null;
  /** The gaze and "up" the camera had when it handed back from free flight, and how far it has eased from them (0 to 1). */
  private handoff: { forward: Km; up: Km; blend: ReturnType<typeof springOf> } | null = null;
  private readonly bank = springOf();
  private readonly fov = springOf(50);
  private baseFov = 50;
  /** The zoom lens over the Earth (degrees; the base field of view when not zoomed) and its narrowest. */
  private lensDeg = 50;
  lensMinDeg: number = LENS.minDeg;
  /**
   * Looking straight down (1) rather than lifting toward the horizon low over a world (0): eased in
   * while the lens is narrowed, a glide runs or the view is held over a place (placeView), eased out after.
   */
  private readonly nadir = springOf(0);
  placeView = false;
  /** A glide to a place under way (on the Earth: ./earth-tiles' places, the field notes' tour; anywhere: the descent before a walk). */
  private glide: { from: Km; to: Km; lnFrom: number; lnTo: number; lift: number; lensFrom: number; lensTo: number; t: number; seconds: number } | null = null;
  private view: NavView = { tanHalfFov: Math.tan((25 * Math.PI) / 180), aspect: 16 / 10, top: 0, bottom: 0 };
  /** The last pose written, so a new trip or flight starts exactly where the camera is. */
  private readonly last = rigPose();
  private hasPose = false;
  private readonly velocity = km();
  private readonly frame: TravelFrame = { position: km(), forward: km(0, 0, -1), up: km(0, 1, 0), pace: 0 };
  private readonly pose = rigPose();
  private readonly scratch = { a: km(), b: km(), c: km(), d: km(), e: km(), before: km() };
  /** tripState's object, rewritten on each read (no garbage per frame). */
  private readonly tripView: { from: BodyId; to: BodyId; progress: number; endKm: number } = { from: 'earth', to: 'earth', progress: 0, endKm: 0 };

  constructor(focus: BodyId) {
    this.focus = focus;
  }

  /** The field of view the camera is easing to (the lens's when zoomed over the Earth). */
  private get fovGoal(): number {
    return this.lensActive ? this.lensDeg : this.baseFov;
  }

  /** True while the Earth's lens is narrower than the base field of view. */
  get lensActive(): boolean {
    return this.focus === 'earth' && this.modeValue === 'orbit' && this.lensDeg < this.baseFov - 1e-6;
  }

  /** The lens now (degrees): the base field of view when not zoomed. */
  get lens(): number {
    return this.lensActive ? this.lensDeg : this.baseFov;
  }

  /** A glide to a place is under way. */
  get gliding(): boolean {
    return this.glide !== null;
  }

  /** The narrowest lens the imagery supports (degrees); a lens narrower than that widens to it. */
  setLensMin(deg: number): void {
    this.lensMinDeg = deg;
    if (this.lensDeg < deg) this.lensDeg = deg;
  }

  /** Back to the base field of view (a trip begins, or the camera leaves the Earth's orbit). */
  private resetLens(): void {
    this.lensDeg = this.baseFov;
    this.glide = null;
    this.placeView = false;
  }

  /**
   * Glides the camera, orbiting the body in view, until it looks straight down on `dir` (a unit
   * direction from the body's centre, render frame) from `altitudeKm`, through a lens of `lensDeg`:
   * along the great circle, lifting on long glides, eased at both ends. With reduced motion it is
   * there at once.
   */
  glideTo(world: NavWorld, dir: Km, altitudeKm: number, lensDeg: number): void {
    if (this.trip) return;
    const body = world.body(this.focus);
    if (this.modeValue === 'flight') this.orbitFromHere(body);
    const to = normalize(copy(km(), dir));
    const ln = Math.log(Math.max(altitudeKm, body.minAltitudeKm));
    const lens = clamp(lensDeg, this.lensMinDeg, this.baseFov);
    if (this.reducedMotion) {
      this.orbit.hold(to, Math.exp(ln));
      this.lensDeg = lens;
      this.fov.x = lens;
      this.fov.v = 0;
      this.glide = null;
      return;
    }
    const from = this.orbit.directionNow(km());
    const arc = Math.acos(clamp(dot(from, to), -1, 1));
    this.glide = {
      from,
      to,
      lnFrom: Math.log(Math.max(this.orbit.altitudeKm, body.minAltitudeKm)),
      lnTo: ln,
      lift: Math.min(LENS.maxLift, arc * LENS.liftPerRadian),
      lensFrom: this.lens,
      lensTo: lens,
      t: 0,
      seconds: clamp(LENS.glideSeconds[0] + arc * LENS.glidePerRadian, LENS.glideSeconds[0], LENS.glideSeconds[1]),
    };
    this.handoff = null;
  }

  /** Carries the orbit round an axis through the Earth by `angle` (its spin since the last frame), so the ground below stays put. */
  spinWithEarth(axis: Km, angle: number): void {
    if (this.focus === 'earth') this.turnAbout(axis, angle);
  }

  /**
   * Carries the orbit round an axis through the focus by `angle` (a unit axis, radians): with the
   * Earth's spin, or with a body photo mode keeps in view as it moves round the focus. Not on a trip.
   */
  turnAbout(axis: Km, angle: number): void {
    if (this.modeValue !== 'orbit' || this.trip) return;
    this.orbit.spin(axis, angle);
    if (this.glide) {
      rotateAbout(this.glide.from, axis, angle, this.glide.from);
      rotateAbout(this.glide.to, axis, angle, this.glide.to);
    }
  }

  /** A trip is under way (not the entry glide, nor the light coming back after Esc called a cut off). */
  get travelling(): boolean {
    return this.trip !== null && this.trip.kind !== 'approach' && this.trip.kind !== 'uncut';
  }

  /** True during the entry glide too. */
  get busy(): boolean {
    return this.trip !== null;
  }

  get mode(): NavMode {
    return this.modeValue;
  }

  /** The trip under way: where from and to, its progress (0 to 1) and the height above the destination it ends at, km. */
  get tripState(): { from: BodyId; to: BodyId; progress: number; endKm: number } | null {
    const t = this.trip;
    if (!t || t.kind === 'approach' || t.kind === 'uncut') return null;
    const v = this.tripView;
    v.from = t.from;
    v.to = t.to;
    v.progress = clamp(t.elapsed / t.seconds, 0, 1);
    v.endKm = Math.exp(t.lnTo);
    return v;
  }

  /** The view bodies are framed in (call when the window or the interface around it changes). */
  setView(view: NavView, fovDeg = this.baseFov): void {
    this.view = { ...view };
    if (fovDeg !== this.baseFov) {
      this.baseFov = fovDeg;
      if (!this.trip) this.fov.x = fovDeg;
    }
  }

  /** The framing distance for a body in the current view, km from its centre. */
  framingKm(body: NavBody): number {
    const { tanHalfFov, aspect, top, bottom } = this.view;
    const clearHeight = Math.max(0.35, 1 - top - bottom);
    const clearWidth = Math.max(0.35, 1 - (this.view.left ?? 0) - (this.view.right ?? 0));
    // On the image plane at distance 1 the view is 2 tan(fov/2) high; the narrower clear side, then
    // the bounding sphere's tangent half-angle that spans `fill` of it.
    const narrower = 2 * tanHalfFov * Math.min(clearHeight, aspect * clearWidth);
    const t = (body.fill * narrower) / 2;
    return (body.boundKm * Math.sqrt(1 + t * t)) / t;
  }

  private minDistance(body: NavBody): number {
    return body.radiusKm + body.minAltitudeKm;
  }

  /**
   * The direction (from a body's centre) it is seen from at first: its sunlit face (the Sun: the
   * Earth's side) turned by its preferred azimuth, toward `toward` when given (the side a trip
   * comes from), at its preferred latitude.
   */
  private preferredDirection(world: NavWorld, body: NavBody, toward: Km | null, out: Km): Km {
    const { a, b, c } = this.scratch;
    const light = body.id === 'sun' ? world.body('earth').position : world.sun;
    normalize(set(a, light.x - body.position.x, light.y - body.position.y, light.z - body.position.z));
    const pole = body.pole;
    // The light's direction across the body's equator, and the equator's direction a quarter turn on.
    const lightLatitude = dot(a, pole);
    set(b, a.x - pole.x * lightLatitude, a.y - pole.y * lightLatitude, a.z - pole.z * lightLatitude);
    if (len(b) < 1e-6) set(b, 1, 0, 0);
    normalize(b);
    cross(pole, b, c);
    let azimuth = body.view.azimuth;
    if (toward && dot(toward, c) < 0) azimuth = -azimuth;
    const latitude = body.view.litFace && lightLatitude < 0 ? -body.view.latitude : body.view.latitude;
    const cosA = Math.cos(azimuth);
    const sinA = Math.sin(azimuth);
    const cosL = Math.cos(latitude);
    const sinL = Math.sin(latitude);
    return normalize(
      set(
        out,
        (b.x * cosA + c.x * sinA) * cosL + pole.x * sinL,
        (b.y * cosA + c.y * sinA) * cosL + pole.y * sinL,
        (b.z * cosA + c.z * sinA) * cosL + pole.z * sinL,
      ),
    );
  }

  /** Starts at a body: with `approach`, a glide in from far away (the entry), else straight at its framing distance. */
  begin(world: NavWorld, id: BodyId, approach: boolean): void {
    const body = world.body(id);
    this.focus = id;
    this.queued = null;
    this.handoff = null;
    this.modeValue = 'orbit';
    this.bank.x = this.bank.v = 0;
    this.fov.x = this.baseFov;
    this.fov.v = 0;
    const dirTo = this.preferredDirection(world, body, null, km());
    const lnTo = Math.log(this.framingKm(body) - body.radiusKm);
    if (!approach || this.reducedMotion) {
      this.trip = null;
      this.orbit.settle(dirTo, Math.exp(lnTo));
      this.writeOrbit(body, this.last);
      this.hasPose = true;
      return;
    }
    // Swing in from a little to one side and above, so the arrival has some parallax.
    const { azimuth, elevation } = angles(dirTo);
    const dirFrom = direction(azimuth - APPROACH.swing, clamp(elevation + APPROACH.drop, -MAX_ELEVATION, MAX_ELEVATION), km());
    const lnFrom = Math.log(APPROACH.from * this.framingKm(body));
    this.trip = { kind: 'approach', from: id, to: id, elapsed: 0, seconds: APPROACH.seconds, plan: null, dirFrom, lnFrom, dirTo, lnTo, modeBefore: 'orbit', focusBefore: id, dimFrom: 1 };
    this.orbit.settle(dirFrom, Math.exp(lnFrom));
    this.approachStep(world, this.trip, 0, this.last);
    this.hasPose = true;
  }

  /** Flies to a body from wherever the camera is now (after the current trip, if one is under way). */
  flyTo(world: NavWorld, id: BodyId): void {
    if (this.trip && this.trip.kind !== 'approach') {
      this.queued = id === this.trip.to ? null : id;
      return;
    }
    if (this.trip) this.endApproach(world);
    this.resetLens();
    const to = world.body(id);
    const framing = this.framingKm(to);
    const distance = Math.hypot(this.last.position.x - to.position.x, this.last.position.y - to.position.y, this.last.position.z - to.position.z);
    if (id === this.focus || distance < ALREADY_THERE * framing) {
      // Here already: orbit it from where the camera is and ease to its framing distance.
      if (this.modeValue === 'flight' || id !== this.focus) this.orbitFromHere(to);
      this.orbit.goal.lnAltitude = Math.log(framing - to.radiusKm);
      set(this.orbit.goal.pan, 0, 0, 0);
      return;
    }
    const from = world.body(this.focus);
    const incoming = normalize(sub(this.last.position, to.position, km()));
    const endDir = this.preferredDirection(world, to, incoming, km());
    if (this.reducedMotion) {
      const startDir = normalize(sub(this.last.position, from.position, km()));
      const startAltitude = Math.max(1e-6, len(sub(this.last.position, from.position, this.scratch.a)) - from.radiusKm);
      this.trip = {
        kind: 'cut',
        from: this.focus,
        to: id,
        elapsed: 0,
        seconds: 2 * CUT.seconds,
        plan: null,
        dirFrom: startDir,
        lnFrom: Math.log(startAltitude),
        dirTo: endDir,
        lnTo: Math.log(framing - to.radiusKm),
        modeBefore: this.modeValue,
        focusBefore: this.focus,
        dimFrom: 1,
      };
    } else {
      // The trip starts from the pose on screen: free flight's, or the orbit's (pan included).
      const plan = planTravel({ from, to, pose: this.last, endDir, endDistance: framing, bodies: world.all, sun: world.body('sun') });
      this.trip = {
        kind: 'travel',
        from: this.focus,
        to: id,
        elapsed: 0,
        seconds: plan.seconds,
        plan,
        dirFrom: km(),
        lnFrom: 0,
        dirTo: endDir,
        lnTo: Math.log(framing - to.radiusKm),
        modeBefore: this.modeValue,
        focusBefore: this.focus,
        dimFrom: 1,
      };
    }
    this.handoff = null;
    this.modeValue = 'orbit';
    this.focus = id;
  }

  /**
   * Stops a trip where the camera is (Esc): it coasts to rest in free flight. A reduced-motion cut
   * that has not yet moved the camera is called off: the light comes back where the visitor was, as
   * they were (orbiting or flying); one that has already cut lets the light come back at the
   * destination. Either way the Esc is spent here, so only a second one leaves the explorer. Returns
   * false when there is nothing to stop: no trip, or the entry glide (not a trip the visitor asked
   * for: Esc then goes straight back).
   */
  cancelTravel(world: NavWorld): boolean {
    const trip = this.trip;
    if (!trip || trip.kind === 'approach') return false;
    if (trip.kind === 'uncut') return true;
    if (trip.kind === 'cut') {
      const s = clamp(trip.elapsed / trip.seconds, 0, 1);
      if (s < 0.5) {
        // Still dimming at the start: the light eases back from where it is, at the same pose.
        this.trip = {
          ...trip,
          kind: 'uncut',
          to: trip.from,
          elapsed: 0,
          seconds: CUT.seconds * 0.6,
          dimFrom: cutDim(s),
        };
        this.focus = trip.focusBefore;
        this.queued = null;
      }
      return true;
    }
    this.trip = null;
    this.queued = null;
    const near = nearestSurface(world.all, this.last.position).body as NavBody | null;
    const ref = near ?? world.body(trip.to);
    this.focus = ref.id;
    this.flight.begin(this.last, ref, this.velocity);
    this.resetLens();
    this.modeValue = 'flight';
    return true;
  }

  /** Leaves free flight to orbit the body the camera is nearest (O, or the interface's button). */
  orbitNearest(world: NavWorld): void {
    if (this.modeValue !== 'flight' || this.trip) return;
    const ref = (this.flight.ref as NavBody | null) ?? world.body(this.focus);
    this.orbitFromHere(ref);
  }

  /** Puts the camera at once (tests, captures): no trip, no easing. */
  place(id: BodyId, dir: Km, distanceKm: number, world: NavWorld): void {
    this.resetLens();
    this.focus = id;
    this.trip = null;
    this.queued = null;
    this.handoff = null;
    this.modeValue = 'orbit';
    this.bank.x = this.bank.v = 0;
    this.fov.x = this.baseFov;
    this.fov.v = 0;
    const body = world.body(id);
    const distance = clamp(distanceKm, this.minDistance(body), body.radiusKm + MAX_ALTITUDE_KM);
    this.orbit.settle(normalize(copy(km(), dir)), distance - body.radiusKm);
    this.writeOrbit(body, this.last);
    this.hasPose = true;
    set(this.velocity, 0, 0, 0);
  }

  /** A drag: turns round the body (orbit) or turns the view (flight). dx right, dy down, CSS px. */
  drag(world: NavWorld, dxPx: number, dyPx: number): void {
    if (this.trip?.kind === 'approach') this.endApproach(world);
    if (this.trip) return;
    if (this.modeValue === 'flight') {
      const perPx = (2 * Math.tan(((this.fov.x * Math.PI) / 180) / 2)) / Math.max(1, this.viewportPx);
      this.flight.look(dxPx * perPx, -dyPx * perPx);
      return;
    }
    this.glide = null;
    const rate = this.dragRate(world);
    this.orbit.rotate(-dxPx * rate, dyPx * rate);
  }

  /** Height of the view in CSS px, for drags and pans that track the pointer. */
  viewportPx = 800;

  /** Orbit drag rate: full far away, falling with the height low over a world (precise close in). */
  private dragRate(world: NavWorld): number {
    const body = world.body(this.focus);
    const h = this.orbit.altitudeKm;
    // Through a narrowed lens the ground moves with the pointer as it would at the lens's width.
    return DRAG_RADIANS_PER_PX * clamp((1.6 * h) / (h + body.radiusKm), 0.012, 1) * (this.fov.x / Math.max(this.baseFov, 1e-6));
  }

  /** Zoom (wheel, pinch, keys): natural-log units of height, positive away. */
  zoom(world: NavWorld, dLn: number): void {
    if (this.trip?.kind === 'approach') this.endApproach(world);
    if (this.trip) return;
    this.glide = null;
    if (this.modeValue === 'flight') this.flight.dollyBy(dLn);
    else this.zoomOrbit(world, dLn);
  }

  /**
   * Orbit zoom, with the Earth's lens: zooming in goes down to the lowest orbit and then narrows the
   * lens; zooming out widens the lens back to the base field of view first, then climbs.
   */
  private zoomOrbit(world: NavWorld, dLn: number): void {
    if (this.focus !== 'earth' || dLn === 0) {
      this.orbit.zoom(dLn);
      return;
    }
    let left = dLn;
    if (left < 0) {
      const room = Math.max(0, this.orbit.goal.lnAltitude - Math.log(world.body('earth').minAltitudeKm));
      const down = Math.max(left, -room);
      this.orbit.zoom(down);
      left -= down;
      if (left < 0) this.lensDeg = Math.max(this.lensMinDeg, Math.min(this.baseFov, this.lensDeg) * Math.exp(left));
      return;
    }
    if (this.lensDeg < this.baseFov) {
      const widen = Math.min(left, Math.log(this.baseFov / this.lensDeg));
      this.lensDeg = Math.min(this.baseFov, this.lensDeg * Math.exp(widen));
      left -= widen;
    }
    if (left > 0) this.orbit.zoom(left);
  }

  /** Pan (two fingers, a right drag): moves the view with the pointer. dx right, dy down, CSS px. */
  pan(world: NavWorld, dxPx: number, dyPx: number): void {
    if (this.trip?.kind === 'approach') this.endApproach(world);
    if (this.trip) return;
    const { a, b } = this.scratch;
    const body = world.body(this.focus);
    const right = normalize(cross(this.last.forward, this.last.up, a));
    const up = this.last.up;
    // Scaled so the body's centre plane moves with the fingers.
    const depth = Math.max(body.radiusKm * 0.05, Math.hypot(this.last.position.x - body.position.x, this.last.position.y - body.position.y, this.last.position.z - body.position.z));
    const perPx = (2 * Math.tan(((this.fov.x * Math.PI) / 180) / 2) * depth) / Math.max(1, this.viewportPx);
    set(b, (-right.x * dxPx + up.x * dyPx) * perPx, (-right.y * dxPx + up.y * dyPx) * perPx, (-right.z * dxPx + up.z * dyPx) * perPx);
    if (this.modeValue === 'flight') {
      const p = this.flight.offset;
      set(p, p.x + b.x, p.y + b.y, p.z + b.z);
      return;
    }
    this.orbit.panBy(b, PAN_LIMIT * (body.boundKm + this.orbit.goalAltitudeKm));
  }

  /** Held orbit keys (arrows, + and -), each -1 to 1: azimuth, elevation, zoom. In free flight the arrows turn the view. */
  setOrbitKeys(azimuth: number, elevation: number, zoom: number): void {
    this.orbitKeys[0] = azimuth;
    this.orbitKeys[1] = elevation;
    this.orbitKeys[2] = zoom;
  }

  /** Held flight keys: move (right, up, forward), roll and boost. Any of them leaves orbit (and stops a trip). */
  setFlightKeys(world: NavWorld, move: Km, roll: number, boost: boolean): void {
    copy(this.controls.move, move);
    this.controls.roll = roll;
    this.controls.boost = boost;
    const active = move.x !== 0 || move.y !== 0 || move.z !== 0 || roll !== 0;
    if (!active || this.trip?.kind === 'cut' || this.trip?.kind === 'uncut') return;
    if (this.trip?.kind === 'travel') {
      // Taking the controls stops the trip: the camera flies on from where it is.
      this.cancelTravel(world);
      return;
    }
    if (this.trip) this.endApproach(world);
    if (this.modeValue !== 'flight') this.beginFlight(world);
  }

  /** Free flight from the pose on screen. */
  private beginFlight(world: NavWorld): void {
    const near = (nearestSurface(world.all, this.last.position).body as NavBody | null) ?? world.body(this.focus);
    this.flight.begin(this.last, near, null);
    this.focus = near.id;
    this.handoff = null;
    this.resetLens();
    this.modeValue = 'flight';
  }

  /** Orbits `body` from where the camera is, the gaze easing from where it was to the body. */
  private orbitFromHere(body: NavBody): void {
    const { a } = this.scratch;
    sub(this.last.position, body.position, a);
    const distance = Math.max(len(a), this.minDistance(body));
    this.orbit.settle(normalize(a), distance - body.radiusKm);
    this.handoff = { forward: copy(km(), this.last.forward), up: copy(km(), this.last.up), blend: springOf() };
    this.focus = body.id;
    this.modeValue = 'orbit';
  }

  private endApproach(world: NavWorld): void {
    const trip = this.trip;
    if (!trip || trip.kind !== 'approach') return;
    this.trip = null;
    const body = world.body(trip.to);
    this.orbitFromHere(body);
    // The approach looked at the body already: nothing to ease.
    this.handoff = null;
  }

  /** Advances by dt seconds and writes the camera pose. */
  update(world: NavWorld, dt: number, out: NavOutput): NavOutput {
    const { e } = this.scratch;
    copy(e, this.last.position);
    const before = copy(this.scratch.before, this.last.forward);
    out.dim = 1;
    out.cut = false;
    out.progress = 1;
    out.from = null;
    const pose = this.pose;
    const trip = this.trip;
    let lensWiden = 0;
    if (trip) {
      const was = trip.elapsed / trip.seconds;
      trip.elapsed += dt;
      const s = clamp(trip.elapsed / trip.seconds, 0, 1);
      if (trip.kind === 'approach') {
        this.approachStep(world, trip, s, pose);
      } else if (trip.kind === 'uncut') {
        // The camera never moved: it holds the pose it had (riding with its body) while the light comes back up, eased.
        const body = world.body(trip.from);
        const r = body.radiusKm + Math.exp(trip.lnFrom);
        set(pose.position, body.position.x + trip.dirFrom.x * r, body.position.y + trip.dirFrom.y * r, body.position.z + trip.dirFrom.z * r);
        copy(pose.forward, this.last.forward);
        copy(pose.up, this.last.up);
        out.dim = trip.dimFrom + (1 - trip.dimFrom) * smootherstep(0, 1, s);
      } else {
        out.progress = s;
        out.from = trip.from;
        if (trip.kind === 'cut') {
          this.cutStep(world, trip, s, pose, out);
          out.cut = was < 0.5 && s >= 0.5;
        } else if (trip.plan) {
          travelFrame(trip.plan, s, this.frame);
          copy(pose.position, this.frame.position);
          copy(pose.forward, this.frame.forward);
          copy(pose.up, this.frame.up);
          // The lens widens with the pace: most at the fastest point (mid-trip), none at either end.
          const p = this.frame.pace;
          lensWiden = TRIP_LENS.widen * Math.sin(Math.PI * p) ** 2;
        }
      }
      if (s >= 1 && trip.kind === 'uncut') {
        // Called off: back to orbiting or flying as before (the rigs were never moved meanwhile).
        this.trip = null;
        this.modeValue = trip.modeBefore;
        this.focus = trip.focusBefore;
      } else if (s >= 1) {
        // Arrived: the orbit takes over exactly where the trip ends (same place, gaze and up).
        this.trip = null;
        const body = world.body(trip.to);
        this.orbit.settle(trip.dirTo, Math.exp(trip.lnTo));
        this.modeValue = 'orbit';
        this.focus = trip.to;
        this.writeOrbit(body, pose);
      } else {
        keepOutside(world.all, pose.position);
      }
    } else if (this.modeValue === 'flight') {
      this.controls.yaw = this.orbitKeys[0] === 0 ? 0 : -this.orbitKeys[0];
      this.controls.pitch = this.orbitKeys[1];
      if (this.orbitKeys[2] !== 0) this.flight.dollyBy(this.orbitKeys[2] * KEY_ZOOM * dt);
      this.flight.update(world.all, this.controls, dt, this.reducedMotion);
      this.flight.position(pose.position);
      copy(pose.forward, this.flight.forward);
      copy(pose.up, this.flight.up);
      if (this.flight.ref) this.focus = this.flight.ref.id as BodyId;
    } else {
      const body = world.body(this.focus);
      const rate = this.dragRate(world) / DRAG_RADIANS_PER_PX;
      this.orbit.rotate(this.orbitKeys[0] * KEY_TURN * rate * dt, this.orbitKeys[1] * KEY_TURN * rate * dt);
      if (this.orbitKeys[2] !== 0) {
        this.glide = null;
        this.zoomOrbit(world, this.orbitKeys[2] * KEY_ZOOM * dt);
      }
      this.orbit.instant = this.reducedMotion;
      const glide = this.glide;
      if (glide && (this.orbitKeys[0] !== 0 || this.orbitKeys[1] !== 0)) this.glide = null;
      if (glide && this.glide) {
        glide.t += dt;
        const p = smootherstep(0, 1, glide.t / glide.seconds);
        const along = slerpDir(glide.from, glide.to, p, this.scratch.d);
        const ln = glide.lnFrom + (glide.lnTo - glide.lnFrom) * p + glide.lift * Math.sin(Math.PI * p);
        this.orbit.hold(along, Math.exp(ln));
        this.lensDeg = Math.exp(Math.log(glide.lensFrom) + (Math.log(glide.lensTo) - Math.log(glide.lensFrom)) * p);
        if (glide.t >= glide.seconds) this.glide = null;
      }
      this.orbit.update(body, dt);
      const down = this.focus === 'earth' && (this.placeView || this.glide !== null || this.lensActive) ? 1 : 0;
      stepSpring(this.nadir, down, this.reducedMotion ? Infinity : NADIR_OMEGA, dt);
      this.writeOrbit(body, pose);
      keepOutside(world.all, pose.position);
    }

    // Easing round from free flight's gaze to the orbited body.
    const handoff = this.handoff;
    if (handoff && this.modeValue === 'orbit' && !this.trip) {
      stepSpring(handoff.blend, 1, this.reducedMotion ? Infinity : HANDOFF_OMEGA, dt);
      const w = clamp(handoff.blend.x, 0, 1);
      slerpDir(handoff.forward, pose.forward, w, pose.forward);
      const upFrom = squareUp(pose.forward, handoff.up, this.scratch.b);
      const upTo = squareUp(pose.forward, UP, this.scratch.c);
      slerpDir(upFrom, upTo, w, pose.up);
      squareUp(pose.forward, pose.up, pose.up);
      if (handoff.blend.x >= 1) this.handoff = null;
    } else if (this.modeValue !== 'orbit' || this.trip) {
      this.handoff = null;
    }

    // Bank into the turn (trips only): the gaze's turn rate about "up", rolled the other way.
    let bankGoal = 0;
    if (this.travelling && !this.reducedMotion && dt > 0 && this.hasPose) {
      const turn = Math.asin(clamp(dot(cross(before, pose.forward, this.scratch.d), pose.up), -1, 1)) / dt;
      bankGoal = clamp(-turn * BANK.perTurnRate, -BANK.max, BANK.max);
    }
    stepSpring(this.bank, bankGoal, BANK.omega, dt);
    copy(out.forward, pose.forward);
    if (Math.abs(this.bank.x) > 1e-7) rotateAbout(pose.up, pose.forward, this.bank.x, out.up);
    else copy(out.up, pose.up);
    squareUp(out.forward, out.up, out.up);

    // The lens: wider at a trip's fastest, back to rest otherwise; never with reduced motion.
    const glidingLens = this.glide !== null;
    stepSpring(this.fov, this.fovGoal + (this.reducedMotion ? 0 : lensWiden), this.reducedMotion || glidingLens ? Infinity : TRIP_LENS.omega, dt);
    out.fov = this.fov.x;

    copy(out.position, pose.position);
    const focusBody = world.body(this.focus);
    const range = Math.max(1, len(sub(focusBody.position, pose.position, this.scratch.a)));
    set(out.target, pose.position.x + out.forward.x * range, pose.position.y + out.forward.y * range, pose.position.z + out.forward.z * range);
    out.mode = this.modeValue;

    // Velocity (for a trip stopped mid-way to coast on) and whether anything moved.
    if (dt > 0 && this.hasPose) set(this.velocity, (pose.position.x - e.x) / dt, (pose.position.y - e.y) / dt, (pose.position.z - e.z) / dt);
    out.speedKmS = this.modeValue === 'flight' && !this.trip ? this.flight.speed : this.trip ? len(this.velocity) : 0;
    const scale = Math.max(1, range);
    const moved = Math.hypot(pose.position.x - e.x, pose.position.y - e.y, pose.position.z - e.z) + range * Math.hypot(out.forward.x - before.x, out.forward.y - before.y, out.forward.z - before.z);
    this.moving = this.trip !== null || this.handoff !== null || moved > STILL * scale || Math.abs(this.bank.x) > 1e-5 || this.glide !== null || Math.abs(this.fov.x - this.fovGoal) > 1e-4;
    copy(this.last.position, out.position);
    copy(this.last.forward, out.forward);
    copy(this.last.up, out.up);
    this.hasPose = true;
    if (!this.trip && this.queued) {
      const next = this.queued;
      this.queued = null;
      this.flyTo(world, next);
    }
    return out;
  }

  private writeOrbit(body: NavBody, out: { position: Km; forward: Km; up: Km }): void {
    this.orbit.pose(body, out, 1 - clamp(this.nadir.x, 0, 1));
  }

  /** The entry glide: centred on the one body, its height falling smoothly in log space. */
  private approachStep(world: NavWorld, trip: Trip, s: number, out: { position: Km; forward: Km; up: Km }): void {
    const body = world.body(trip.to);
    const w = smootherstep(0, 1, s);
    const dir = slerpDir(trip.dirFrom, trip.dirTo, w, this.scratch.d);
    const r = body.radiusKm + Math.exp(trip.lnFrom + (trip.lnTo - trip.lnFrom) * w);
    set(out.position, body.position.x + dir.x * r, body.position.y + dir.y * r, body.position.z + dir.z * r);
    lookDirection(out.position, body.position, body.radiusKm, UP, out.forward);
    squareUp(out.forward, UP, out.up);
  }

  private cutStep(world: NavWorld, trip: Trip, s: number, out: { position: Km; forward: Km; up: Km }, nav: NavOutput): void {
    // First half: dim at the start pose. Second half: the new pose, the light returning.
    const first = s < 0.5;
    const body = world.body(first ? trip.from : trip.to);
    const dir = first ? trip.dirFrom : trip.dirTo;
    const ln = first ? trip.lnFrom : trip.lnTo;
    nav.dim = cutDim(s);
    const r = body.radiusKm + Math.exp(ln);
    set(out.position, body.position.x + dir.x * r, body.position.y + dir.y * r, body.position.z + dir.z * r);
    if (first && trip.kind === 'cut' && this.hasPose) {
      // Hold the gaze the camera had (an orbit with a pan, or free flight, looked elsewhere).
      copy(out.forward, this.last.forward);
      copy(out.up, this.last.up);
      return;
    }
    lookDirection(out.position, body.position, body.radiusKm, UP, out.forward);
    squareUp(out.forward, UP, out.up);
  }
}
