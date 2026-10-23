/**
 * Cinematic travel between bodies, pure (no three.js). Positions are float64 km in the render frame.
 *
 * The path. The camera rides an arc from the body it leaves (A) to its destination (B), raised out of
 * the planets' plane (further for longer trips, and as far as needed to pass well clear of the Sun
 * and of any other body), and timed so that both ends change in log space: leaving, A recedes as if
 * the view were zooming out; arriving, B grows from a point into a world, its distance only ever
 * falling. The timing variable is phi = ln(distance to A) - ln(distance to B), which runs smoothly
 * from very negative (beside A) through 0 (halfway) to very positive (beside B), eased in and out
 * so the flight starts and stops softly. The departure is paced faster than the arrival: once A is
 * a point there is little to see until B grows.
 *
 * Near each end the path bends into the pose it starts from and the one it arrives at: leaving, the
 * camera swings around A from wherever it was (round the body, never through it, a waypoint the
 * path makes for itself) while its distance grows; arriving, it comes round B to the side it is
 * meant to see while closing in. Both bends stay at least as far from the body as the start and
 * the arrival pose.
 *
 * The length: 2.5 s plus 0.9 s per factor of ten in distance it covers, 2.5 to 9 s.
 */

import {
  clamp,
  copy,
  cross,
  dot,
  len,
  lookDirection,
  normalize,
  rotateAbout,
  set,
  slerpDir,
  smootherstep,
  squareUp,
  sub,
  UP,
  type RigBody,
  type RigPose,
} from './flight';
import { km, type Km } from './space/origin';

/** Length of a trip: base, per decade of distance covered, and its bounds (seconds). */
export const TRAVEL_SECONDS = { base: 2.5, perDecade: 0.9, min: 2.5, max: 9 } as const;
/**
 * The arc's rise out of the planets' plane at its middle (seen from either end), radians: none for a
 * hop of under a decade, up to about 20 degrees for long trips; and how far up it may be raised to
 * clear the Sun or a body.
 */
const ARC = { lift: 0.35, maxLift: 1.1, sunClearance: 0.45, bodyClearance: 4 } as const;
/** The time a unit of phi takes while leaving, against arriving (leaving goes faster). */
const DEPARTURE_PACE = 0.38;
/**
 * While both ends are mere points of light (angular radius under about a pixel's worth), the trip
 * hurries on through: that stretch is a third as slow per unit of phi, so it never becomes a long
 * spell of empty sky. The angular radii (radians) between which an end counts as a point, then a disc.
 */
const POINT_PACE = 0.22;
const DISC = { from: 0.0008, to: 0.004 } as const;
/** The ends' bends play out over this many natural-log units of distance from the body (a factor of about 5). */
const NEAR = 1.6;
/**
 * The gaze: held on the world left for the first tenth (a pull-back: it shrinks in view), then turned
 * to the destination, on it from just under a third of the trip on; the "up" settles over half.
 * A camera that was not looking at the world it leaves (free flight) turns straight to the destination.
 */
const GAZE_HOLD = 0.1;
const GAZE_TURN = 0.32;
const UP_TURN = 0.5;
/** The start's gaze counts as on the world left within this angle of its centre (radians). */
const PULL_BACK_ANGLE = 0.6;
/** Samples of the timing table. */
const TABLE = 256;

export interface TravelPlan {
  readonly from: RigBody;
  readonly to: RigBody;
  readonly seconds: number;
  /** The start: the camera's offset from A, its gaze then, and how far its "up" was rolled from ecliptic north. */
  readonly startOffset: Km;
  readonly startForward: Km;
  readonly startRoll: number;
  /** The end: direction from B to the camera, and the distance from B's centre. */
  readonly endDir: Km;
  readonly endDistance: number;
  /** The arc's rise (tangent of its angle seen from an end), and the direction it rises toward. */
  readonly lift: number;
  /** phi at the start and the end, and the eased-pace table (sigma by phi). */
  readonly phiStart: number;
  readonly phiEnd: number;
  readonly sigma: Float64Array;
  /** Whether A was left from its far side (the camera swings round it first). */
  readonly farSide: boolean;
  /** Whether the start looked at A (the trip opens by pulling back from it). */
  readonly pullBack: boolean;
  /** Where the arc's points sit relative to the chord at plan time (|Q(u) - A| at the start, |Q(u) - B| at the end). */
  readonly startRadius: number;
  readonly endRadius: number;
}

export interface TravelFrame {
  position: Km;
  forward: Km;
  up: Km;
  /** Eased progress of the pace (0 to 1), for speed-dependent touches (the lens). */
  pace: number;
}

/** Scratch vectors (one trip is planned or framed at a time); `arc` holds the frame's point on the arc. */
const scratch = { a: km(), b: km(), c: km(), d: km(), e: km(), k: km(), q: km(), t: km(), arc: km() };

/** The trip's length for a camera this far (km) from the destination's centre, arriving at `endDistance`. */
export function travelSeconds(startDistance: number, endDistance: number): number {
  const decades = Math.max(0, Math.log10(Math.max(startDistance, 1) / Math.max(endDistance, 1)));
  return clamp(TRAVEL_SECONDS.base + TRAVEL_SECONDS.perDecade * decades, TRAVEL_SECONDS.min, TRAVEL_SECONDS.max);
}

/** The direction the arc rises toward: ecliptic north square to the chord (any square direction if they are parallel). */
function liftAxis(A: Km, B: Km, out: Km): Km {
  const t = normalize(sub(B, A, scratch.t));
  return squareUp(t, UP, out);
}

/** The arc's point at u (0 at A, 1 at B), raised by `lift`. */
function arcPoint(A: Km, B: Km, lift: number, u: number, out: Km): Km {
  const k = liftAxis(A, B, scratch.k);
  const L = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
  const h = 2 * lift * u * (1 - u) * L;
  return set(out, A.x + (B.x - A.x) * u + k.x * h, A.y + (B.y - A.y) * u + k.y * h, A.z + (B.z - A.z) * u + k.z * h);
}

const phiAt = (A: Km, B: Km, p: Km): number =>
  Math.log(Math.max(1e-9, Math.hypot(p.x - A.x, p.y - A.y, p.z - A.z))) - Math.log(Math.max(1e-9, Math.hypot(p.x - B.x, p.y - B.y, p.z - B.z)));

/** The arc's parameter whose point has this phi (phi rises along the arc), by bisection. */
function arcParameter(A: Km, B: Km, lift: number, phi: number): number {
  let lo = 0;
  let hi = 1;
  const p = scratch.q;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (phiAt(A, B, arcPoint(A, B, lift, mid, p)) < phi) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-15) break;
  }
  return (lo + hi) / 2;
}

/** Closest approach of the arc (sampled) to a point, km. */
function closestApproach(A: Km, B: Km, lift: number, point: Km, from = 0.02, to = 0.98): number {
  let best = Infinity;
  const p = scratch.q;
  for (let i = 0; i <= 64; i++) {
    const u = from + ((to - from) * i) / 64;
    arcPoint(A, B, lift, u, p);
    best = Math.min(best, Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z));
  }
  return best;
}

const paceWeight = (phi: number): number => DEPARTURE_PACE + (1 - DEPARTURE_PACE) * smootherstep(-2.5, 2.5, phi);

/**
 * Plans a trip from the camera's pose (near `from`) to the arrival pose at `to` (`endDir` from its
 * centre at `endDistance`), keeping clear of the Sun (`sun`, unless it is an end) and of `bodies`.
 */
export function planTravel(options: {
  from: RigBody;
  to: RigBody;
  pose: RigPose;
  endDir: Km;
  endDistance: number;
  bodies: readonly RigBody[];
  sun: RigBody | null;
}): TravelPlan {
  const { from, to, pose, endDistance, bodies, sun } = options;
  const A = from.position;
  const B = to.position;
  const startOffset = sub(pose.position, A, km());
  const startDistance = Math.hypot(pose.position.x - B.x, pose.position.y - B.y, pose.position.z - B.z);
  const seconds = travelSeconds(startDistance, endDistance);
  const decades = Math.max(0, Math.log10(Math.max(startDistance, 1) / Math.max(endDistance, 1)));
  // Short hops barely leave the plane; long trips rise out of it (to ecliptic north, the same for all).
  let lift = Math.tan(ARC.lift * smootherstep(0.5, 2.5, decades));
  // Raised further while the arc would pass too near the Sun (between two other bodies) or any body.
  const obstacles: Array<{ at: Km; clearance: number }> = [];
  if (sun && sun !== from && sun !== to) {
    const nearer = Math.min(Math.hypot(A.x - sun.position.x, A.y - sun.position.y, A.z - sun.position.z), Math.hypot(B.x - sun.position.x, B.y - sun.position.y, B.z - sun.position.z));
    obstacles.push({ at: sun.position, clearance: ARC.sunClearance * nearer });
  }
  for (const body of bodies) {
    if (body === from || body === to || body === sun) continue;
    obstacles.push({ at: body.position, clearance: ARC.bodyClearance * body.boundKm + body.minAltitudeKm });
  }
  for (let i = 0; i < 24 && lift < Math.tan(ARC.maxLift); i++) {
    if (obstacles.every((o) => closestApproach(A, B, lift, o.at) >= o.clearance)) break;
    lift = Math.min(Math.tan(ARC.maxLift), lift + 0.06);
  }
  const endDir = normalize(copy(km(), options.endDir));
  const end = set(km(), B.x + endDir.x * endDistance, B.y + endDir.y * endDistance, B.z + endDir.z * endDistance);
  const phiStart = phiAt(A, B, pose.position);
  const phiEnd = Math.max(phiStart + 1e-6, phiAt(A, B, end));
  // The pace table: sigma(phi) = integral of the time each unit of phi takes (less while leaving,
  // and less again while both ends are only points).
  const sigma = new Float64Array(TABLE + 1);
  const step = (phiEnd - phiStart) / TABLE;
  const at = km();
  for (let i = 1; i <= TABLE; i++) {
    const phiMid = phiStart + (i - 0.5) * step;
    arcPoint(A, B, lift, arcParameter(A, B, lift, phiMid), at);
    const seenA = smootherstep(DISC.from, DISC.to, Math.asin(Math.min(1, from.radiusKm / Math.max(1, Math.hypot(at.x - A.x, at.y - A.y, at.z - A.z)))));
    const seenB = smootherstep(DISC.from, DISC.to, Math.asin(Math.min(1, to.radiusKm / Math.max(1, Math.hypot(at.x - B.x, at.y - B.y, at.z - B.z)))));
    const points = POINT_PACE + (1 - POINT_PACE) * Math.max(seenA, seenB);
    sigma[i] = (sigma[i - 1] ?? 0) + step * paceWeight(phiMid) * points;
  }
  // Left from the far side: the line from A to B starts behind the camera.
  const toB = normalize(sub(B, A, scratch.a));
  const farSide = dot(normalize(copy(scratch.b, startOffset)), toB) < -0.2;
  const towardA = normalize(sub(A, pose.position, km()));
  const pullBack = Math.acos(clamp(dot(towardA, pose.forward), -1, 1)) < PULL_BACK_ANGLE;
  const q0 = arcPoint(A, B, lift, arcParameter(A, B, lift, phiStart), km());
  const q1 = arcPoint(A, B, lift, arcParameter(A, B, lift, phiEnd), km());
  return {
    from,
    to,
    seconds,
    startOffset,
    startForward: copy(km(), pose.forward),
    startRoll: rollOf(pose.forward, pose.up),
    endDir,
    endDistance,
    lift,
    phiStart,
    phiEnd,
    sigma,
    farSide,
    pullBack,
    startRadius: Math.max(1e-9, Math.hypot(q0.x - A.x, q0.y - A.y, q0.z - A.z)),
    endRadius: Math.max(1e-9, Math.hypot(q1.x - B.x, q1.y - B.y, q1.z - B.z)),
  };
}

/** phi at eased pace `pace` (0 to 1) from the table. */
function phiForPace(plan: TravelPlan, pace: number): number {
  const total = plan.sigma[TABLE] ?? 0;
  const target = clamp(pace, 0, 1) * total;
  let lo = 0;
  let hi = TABLE;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((plan.sigma[mid] ?? 0) < target) lo = mid;
    else hi = mid;
  }
  const s0 = plan.sigma[lo] ?? 0;
  const s1 = plan.sigma[hi] ?? 0;
  const f = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
  return plan.phiStart + ((lo + f) / TABLE) * (plan.phiEnd - plan.phiStart);
}

/**
 * The camera's pose at progress s (0 to 1, by time) of a trip, with the bodies where they are now.
 * Exactly the start pose at s = 0 and the arrival pose (looking at the destination) at s = 1.
 */
export function travelFrame(plan: TravelPlan, s: number, out: TravelFrame): TravelFrame {
  const { a, b, c, d, e, k } = scratch;
  const A = plan.from.position;
  const B = plan.to.position;
  const pace = smootherstep(0, 1, s);
  out.pace = pace;
  const phi = phiForPace(plan, pace);
  const u = arcParameter(A, B, plan.lift, phi);
  const Q = arcPoint(A, B, plan.lift, u, scratch.arc);
  const via = liftAxis(A, B, k);

  // Leaving: round A from where the camera was, its distance from A scaled to start exactly there.
  sub(Q, A, a);
  const ra = len(a);
  const ma = normalize(a);
  const r0 = Math.max(1e-9, len(plan.startOffset));
  const m0 = normalize(copy(b, plan.startOffset));
  const nearA = smootherstep(0, NEAR, Math.log(ra / plan.startRadius));
  const radiusA = Math.max(nearA, smootherstep(0.45, 0.95, s));
  // From the far side the camera swings round first, so it never backs away from B to get round A.
  const turnA = Math.max(radiusA, plan.farSide ? smootherstep(0, 0.3, s) : 0);
  const dirA = slerpDir(m0, ma, turnA, c, via);
  const rA = ra * (r0 / plan.startRadius) ** (1 - radiusA);
  const cAx = A.x + dirA.x * rA - Q.x;
  const cAy = A.y + dirA.y * rA - Q.y;
  const cAz = A.z + dirA.z * rA - Q.z;

  // Arriving: round B to the side it is meant to be seen from, closing to exactly the arrival distance.
  sub(Q, B, a);
  const rb = len(a);
  const mb = normalize(a);
  // The radius's correction depends on the arc's distance alone (never on time), so the distance to
  // B, rb scaled by a gently changing factor, falls whenever rb falls: it never dips and recovers.
  const radiusB = smootherstep(NEAR, 0, Math.log(rb / plan.endRadius));
  const turnB = Math.max(radiusB, smootherstep(0.55, 0.92, s));
  const dirB = slerpDir(mb, plan.endDir, turnB, d, via);
  const rB = rb * (plan.endDistance / plan.endRadius) ** radiusB;
  const cBx = B.x + dirB.x * rB - Q.x;
  const cBy = B.y + dirB.y * rB - Q.y;
  const cBz = B.z + dirB.z * rB - Q.z;

  // Each end's bend belongs to its own part of the trip: the departure's has gone by two thirds of
  // the way in phi, the arrival's comes in from a third. (A camera that starts far out, where the two
  // would overlap, still arrives on a distance that only falls.)
  const along = (phi - plan.phiStart) / Math.max(1e-9, plan.phiEnd - plan.phiStart);
  const fadeA = 1 - smootherstep(0.35, 0.7, along);
  const fadeB = smootherstep(0.3, 0.65, along);
  set(out.position, Q.x + fadeA * cAx + fadeB * cBx, Q.y + fadeA * cAy + fadeB * cBy, Q.z + fadeA * cAz + fadeB * cBz);

  // The gaze: on the world left while the camera pulls back from it (when it was looking at it), then
  // round to the destination, on it from a third of the way on (its lifted horizon gaze when arriving low).
  lookDirection(out.position, B, plan.to.radiusKm, UP, e);
  if (plan.pullBack) {
    lookDirection(out.position, A, plan.from.radiusKm, UP, d);
    slerpDir(plan.startForward, d, smootherstep(0, GAZE_HOLD, s), c);
    slerpDir(c, e, smootherstep(GAZE_HOLD, GAZE_TURN, s), out.forward);
  } else {
    slerpDir(plan.startForward, e, smootherstep(0, GAZE_TURN, s), out.forward);
  }
  // "Up": ecliptic north made square to the gaze, rolled by what the start had (free flight may
  // have rolled the view), that roll easing out over the first half of the trip.
  squareUp(out.forward, UP, b);
  const roll = plan.startRoll * (1 - smootherstep(0, UP_TURN, s));
  if (Math.abs(roll) > 1e-9) rotateAbout(b, out.forward, roll, out.up);
  else copy(out.up, b);
  squareUp(out.forward, out.up, out.up);
  return out;
}

/** The roll of `up` about `forward` from ecliptic north made square to it, radians (signed). */
function rollOf(forward: Km, up: Km): number {
  const ref = squareUp(forward, UP, km());
  const c = cross(ref, up, km());
  return Math.atan2(dot(c, forward), dot(ref, up));
}

/** Distance from a point to a body's surface, km. */
export function surfaceDistance(body: RigBody, p: Km): number {
  return Math.hypot(p.x - body.position.x, p.y - body.position.y, p.z - body.position.z) - body.radiusKm;
}
