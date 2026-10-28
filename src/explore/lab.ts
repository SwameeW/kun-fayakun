import { Group, type Object3D } from 'three/webgpu';
import type { Ephemeris } from '../astro/ephemeris';
import type { PhysicalFile } from '../astro/physical';
import { utcToTdb } from '../astro/time';
import type { KfTestHandle } from '../core/hooks';
import { BODY_IDS, type BodyId, type LabAim, type LabCommand, type LabEditResult, type LabImpactor, type LabQuantity, type SceneLabel, type UniverseLab, type UniverseLabBody, type UniverseTimeCommand } from '../core/types';
import labMessages from '../i18n/en.lab.json';
import type { ThrowPlan } from '../sim/aim';
import { commandId, RING_MAX_BODIES, STALE, validateScenario, type BodySpec, type Command, type Encounter, type Scenario } from '../sim/engine';
import { dayWithin, type Within } from '../sim/goto';
import type { Look } from '../sim/looks';
import { bulkDensity, joules, SOLID_MAX_GM } from '../sim/craters';
import { breakupPeriodS, elementsFromState, hillRadiusKm, lagrangePoints, measure as measureBetween, orbitalFrame, rocheLimits, separation, stateFromElements, type Vec3 } from '../sim/elements';
import { circularOrbit, consumes, MAX_BODIES, primaryOf, type SimState } from '../sim/nbody';
import { burnDuration, deltaVLeft, G0, hohmann, ROUND_E, type Transfer } from '../sim/ships';
import { SWARM_LIMITS } from '../sim/swarms';
import { airlessRock, climateSummary, noonK, worldClimates } from '../sim/climate';
import { presets as presetList, type Preset } from '../sim/presets';
import { decodeScenario, encodeScenario } from '../sim/share';
import type { LabReply, LabRequest, LabSnapshot } from '../sim/protocol';
import { seedLaboratory, seedSolarSystem, type Shapes } from '../sim/seed';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { MAX_MARKS, type SurfaceMark } from './bodies/marks';
import type { ExploreTier } from './detail';
import type { FireballEvent, FxBody, FxPlume, FxReport, FxSwarm, LabFx } from './lab-fx';
import { crustK, giantMeltK, MELT } from './lab-fx/heat';
import { incandescence } from './lab-fx/incandescence';
import { LabClock, placeAt } from './lab-clock';
import { createOrbits, type OrbitFrame, type OrbitPath, type Orbits } from './orbits';
import { km, type Km } from './space/origin';
import { placeScaled } from './space/scaled-space';
import type { SolarSystem } from './system';
import { applyTimeCommand, LAB_DATE_SPAN_S } from './time';

/**
 * The orbital laboratory inside the explorer (Sandbox): an experiment forked from the solar system
 * at the explorer's epoch (or a clean two- or three-body laboratory), run by the engine in a worker
 * (src/sim), drawn with the explorer's own bodies, sky, lights and camera.
 *
 * State ownership: the scenario's integrator owns every position and velocity. The ten built-in
 * worlds take their places and drawn sizes from its snapshots (their rotation still follows the IAU
 * models at the simulated date: modelled, not integrated); a world the experiment ends shrinks away and
 * is hidden; new bodies, rings and impacts are drawn by the effects' own chunk (./lab-fx: lit rocks,
 * shining stars, soft dust and bands, fireballs), fading in and out, with their names (families of
 * pieces as one). Nothing here writes to the real explorer's data: leaving the laboratory gives the
 * ephemeris its bodies back.
 *
 * Every command is answered (Lab.command's promise: an edit applied, with the bodies it made, or refused
 * with the reason the engine's one check gives), and the clock slows down for what is coming
 * (governSlow: on unless the visitor turns it off). A rock can be thrown, worked out first in the worker
 * (src/sim/aim) and made at the step it was worked out at.
 *
 * Drawn: each body's recent path (its trail), the chosen body's predicted path (a copy of the state
 * integrated ahead in the worker, redone after every edit and as time passes) and its velocity, all
 * relative to the body it moves about (its primary: a moon's path is drawn about its planet, where the
 * planet is now), through the explorer's orbit renderer (scaled space, constant-width hairlines).
 * Between snapshots everything is drawn at the drawn clock (./lab-clock): smooth and never turning
 * back at any rate, each body between the two snapshots around it.
 *
 * Time: the time machine's commands drive the experiment's clock through the explorer's reducer
 * (./time): backwards plays its history exactly (src/sim/rewind) and stops at the fork; Now and a date
 * go to that moment of the experiment (from the fork to LAB_DATE_SPAN_S after it), a date ending on
 * the day asked whatever its time of day and the step (src/sim/goto); seek, replay and reset leave it
 * paused there.
 *
 * Masses: the engine works in GM. Kilograms for the interface use one constant, the Earth's GM (DE440)
 * over its mass (JPL's physical parameters), so every body is converted by the same G.
 */

export interface LabFrame {
  /** The camera (render frame, km), its forward direction, near and far planes; pixels per unit tangent. */
  camera: Km;
  forward: Km;
  near: number;
  far: number;
  pxPerTan: number;
  /** The body in focus (render frame, km), its radius and distance, as the orbit lines want them. */
  focus: Km;
  focusRadius: number;
  focusDistance: number;
  compensation: number;
  /** This frame's step (s, by the frames' own clock): every effect's easing is timed by it, as the frames are shown. */
  dt: number;
}

/** The explorer's camera for the pointer: a point (render frame, km from the camera) on the canvas (CSS px; null behind the camera), a canvas point's ray, the view's direction (unit vectors, render frame), and what the interface covers at the view's edges (CSS px). */
export interface LabPointerView {
  toScreen(rel: Km): { x: number; y: number } | null;
  ray(x: number, y: number): Km;
  forward(): Km;
  insets(): { top: number; bottom: number; left: number; right: number };
}

export interface Lab {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  /** Forks a scenario (the solar system at `jdTdb`, or a laboratory) and runs it. */
  start(seed: 'solar' | 'two' | 'three', jdTdb: number): void;
  stop(): void;
  /** Advances the drawn clock (./lab-clock) by a frame; once a frame, before jdTdb and the rest. True when it was set anew (a new timeline: a cut, not a movement). */
  tick(nowMs: number): boolean;
  /** The simulated date as drawn (TDB Julian date). */
  jdTdb(): number;
  /** Puts the built-in worlds where the experiment has them; returns those it no longer has (a world it has just ended shrinks away first). */
  applyBuiltIns(sys: SolarSystem, hidden: Set<BodyId>): void;
  /** A built-in world's drawn size over its real one: the experiment's radius (eased), shrinking to 0 as it leaves; 1 outside the laboratory. */
  scale(id: BodyId): number;
  /** The craters to draw on a world (in its own frame), eased in and their glow fading (flash-safe); none outside the laboratory. */
  marks(body: BodyId): SurfaceMark[];
  /** A world's climate bands to draw (K, south to north), or null; and whether the temperature view is on. */
  climateBands(body: BodyId): number[] | null;
  readonly climateView: boolean;
  update(frame: LabFrame, relative: (abs: Km, out: Km) => Km): void;
  labels(out: SceneLabel[]): void;
  /** The requested rate (negative: backwards through the history) and pause. */
  setRun(rate: number, paused: boolean): void;
  readonly rate: number;
  readonly paused: boolean;
  /** Back at the experiment's start, going backwards (stopped there), or null. */
  readonly edge: 'start' | null;
  /**
   * A time machine command (already checked: src/explore/time validTimeCommand) on the experiment's clock.
   * `tdbMinusUtcDays`: TDB minus UTC as the explorer draws the clock's date (days), so a date is the moment
   * and the day as shown; without it, UTC is turned into TDB with the leap seconds of the date asked.
   */
  time(command: UniverseTimeCommand, tdbMinusUtcDays?: number): void;
  /** A command; its answer once the run has it (an edit applied, with the bodies it made, or refused with the reason). */
  command(c: LabCommand): Promise<LabEditResult>;
  view(): UniverseLab | null;
  /** A body merged away or removed: the one the camera should go to instead (its survivor), once. */
  takeRefocus(): BodyId | null;
  /** The explorer's camera, for the pointer. */
  setPointerView(view: LabPointerView): void;
  /** A press at a canvas point (client px): true when it takes the chosen body's velocity arrow by its tip (the drag then moves the arrow, not the camera). */
  grab(x: number, y: number): boolean;
  grabMove(x: number, y: number): void;
  /** The arrow let go: its velocity applied (or not, cancelled). */
  grabEnd(cancelled: boolean): void;
  /** The pointer over the canvas: while placing, the preview follows it. */
  hover(x: number, y: number): void;
  /** A tap or click: true when it placed a body (then nothing else hears it). */
  tap(x: number, y: number): boolean;
  /** Placing a body with the pointer. */
  readonly placing: boolean;
  /** Esc: placing stops, or the slowing for an event is called off; true when it was used. */
  escape(): boolean;
  dispose(): void;
}

const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
const add3 = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] ?? 0) + (b[0] ?? 0), (a[1] ?? 0) + (b[1] ?? 0), (a[2] ?? 0) + (b[2] ?? 0)];
const scale3 = (a: readonly number[], k: number): Vec3 => [(a[0] ?? 0) * k, (a[1] ?? 0) * k, (a[2] ?? 0) * k];
const dot3 = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross3 = (a: readonly number[], b: readonly number[]): Vec3 => [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
const norm3 = (a: readonly number[]): number => Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
const unit3 = (a: readonly number[], fallback: Vec3 = [0, 0, 1]): Vec3 => {
  const l = norm3(a);
  return l > 0 ? scale3(a, 1 / l) : fallback;
};
/** Rotates v about the unit axis u by angle a (Rodrigues). */
const rotate3 = (v: readonly number[], u: readonly number[], a: number): Vec3 => {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const k = cross3(u, v);
  const d = dot3(u, v) * (1 - c);
  return [(v[0] ?? 0) * c + k[0] * sn + (u[0] ?? 0) * d, (v[1] ?? 0) * c + k[1] * sn + (u[1] ?? 0) * d, (v[2] ?? 0) * c + k[2] * sn + (u[2] ?? 0) * d];
};
/** Render frame back to the scenario's: the inverse of toRender. */
const fromRender = (x: number, y: number, z: number): Vec3 => [x, -z, y];
/** A world turning as the visitor set it: its basis at time t, from the basis captured when the spin was set, turned about the pole by the period's share of a turn. */
const drawnBasis = (d: { t: number; basis: number[]; pole: Vec3; periodS: number }, t: number): number[] => {
  const angle = (2 * Math.PI * (t - d.t)) / d.periodS;
  return [0, 1, 2].flatMap((c) => rotate3(d.basis.slice(c * 3, c * 3 + 3), d.pole, angle));
};

const TRAIL_SLOTS = 24;
const TRAIL_POINTS = 384;
const DOT_SLOTS = MAX_BODIES;
/** Rings and belts as drawn: a belt about a star warm grey, a ring about anything else icy; their points' size (CSS px) and strength (added light: dense parts brighten). */
const PARTICLES = { belt: [0.62, 0.55, 0.45], ring: [0.72, 0.76, 0.82], sizePx: 3.2, opacity: 1 } as const;
/**
 * Decorative dust (ledger IM-4): a plume of points thrown up from each impact and falling back, drawn
 * for a few seconds of the wall clock whatever the experiment's rate, and no part of its physics (the
 * debris that is, are bodies). Its height from the crater (four times its width, at least 20 km, at
 * most the target's radius) or, with none, half the target's radius; its spread a 40 degree cone. It
 * fades in and out, dim (flash safety).
 */
const DUST = { perImpact: 240, most: 720, plumes: 6, seconds: 4, cone: (40 * Math.PI) / 180, color: [0.78, 0.7, 0.6], sizePx: 3, opacity: 0.85, minPx: 6 } as const;
/** The gases whose shares the constants give (data/constants.json, `<world>.atmosphere.<gas>`), in the order shown. */
const GASES = ['n2', 'o2', 'co2', 'ar', 'co'] as const;
/** A body more massive than this (GM, km^3 s^-2: about 80 Jupiters, the least a star can be) is a star: its belts are drawn as rock. */
const STAR_GM = 1e10;
/** A ship's size in the integration (km): ten metres, for contacts; it weighs nothing there. */
const SHIP_RADIUS_KM = 0.01;
/** A gravitating ring's bodies (ids `moonlets-<n>-<k>`): named on screen only when chosen, so twenty-four labels do not crowd the view. */
const RING_MEMBER = /^moonlets-\d+-\d+$/u;
const DEFAULT_HORIZON_S = 60 * 86_400;
const SAVE_KEY = 'current';
/** Scenarios saved by name in this browser's library: their keys in the store. */
const LIBRARY_PREFIX = 'library:';
const DB_NAME = 'kf-lab';
const STORE = 'scenarios';
/** The prediction's step against the live run's, by the accuracy chosen. */
const ACCURACY = { fast: 4, normal: 1, precise: 0.25 } as const;
/** A tracked quantity keeps at most this many samples (then every other one goes: the record coarsens, never ends). */
const GRAPH_POINTS = 480;
/** The worlds drawn with a solid surface for the laboratory's craters to mark (./bodies/marks). */
const MARKED: readonly BodyId[] = ['earth', 'moon', 'mercury', 'mars'];
/**
 * A crater's drawing over time: how fast it may appear and its glow rise and fall (shares a second of
 * the wall clock: never a step in brightness, so never a flash). The glow itself follows its melt's
 * surface as a crust forms over it (./lab-fx/heat: gone from sight within minutes of simulated time) and
 * Planck's law for its brightness (./lab-fx/incandescence).
 */
const MARK_EASE = { appearPerS: 0.7, glowUpPerS: 2, glowDownPerS: 0.35 } as const;
/** A share link carries its scenario up to this many characters. */
const SHARE_MAX_CHARS = 8000;
/** Colours (display terms) of the Lagrange points, the encounters and the placing preview. */
const LAGRANGE = [0.55, 0.72, 0.95] as const;
const ENCOUNTER = [0.95, 0.6, 0.4] as const;
const PLACING = [0.6, 0.95, 0.7] as const;
/** The velocity arrow's tip can be taken within this many CSS px; the arrow is drawn this long on screen (its direction is the velocity's; dragging its tip twice as far doubles the speed). */
const HANDLE_PX = 14;
/** On a coarse pointer (a finger) the handle's reach is a 44 px target (CONTRACTS, touch rule). */
const HANDLE_TOUCH_PX = 22;
const ARROW_PX = 90;
const DEG = Math.PI / 180;
/** Colours of the lines (display terms): a trail, the chosen body's trail, its prediction, its velocity. */
const TRAIL = [0.16, 0.2, 0.3] as const;
const TRAIL_CHOSEN = [0.55, 0.45, 0.26] as const;
const PREDICTION = [0.35, 0.62, 0.72] as const;
const VELOCITY = [0.75, 0.62, 0.3] as const;
/** A ship's burn directions as markers (ledger SC-2): prograde, normal, radial out. */
const SHIP_DIRECTIONS = { prograde: [0.62, 0.86, 0.4], normal: [0.78, 0.5, 0.92], radialOut: [0.4, 0.82, 0.92] } as const;
/**
 * Slowing down for events (docs/SANDBOX-ROADMAP.md W1.13; the owner's interim choice D8: on unless the
 * visitor turns it off, the choice kept in this browser). Coming up to an impact or a tidal disruption
 * the worker sees ahead (src/sim/approach), the clock eases down (in log rate, over about `easeS`: gently
 * enough that the drawn clock, a little behind the worker, keeps with it rather than leap) so
 * the event comes `marginS` real seconds after it reaches the rate that shows it (an eighth of the time
 * the impactor takes to cross the target's radius, or a twentieth of an orbit at the Roche limit); it
 * holds there `holdS` after the event (one not seen coming slows at once) and eases back over `backS`.
 * Only the rate shown changes: the physics and the log are the same at any rate. Esc or any time
 * command calls it off for that event.
 */
const SLOW = { easeS: 2, marginS: 1.5, holdS: 2, backS: 2, minRate: 1, storage: 'kf-lab-slow' } as const;
/** Bodies and swarms fade in and out over this long (s): nothing appears or goes at once (flash safety). */
const FADE_S = 0.5;
/** A world the experiment ends shrinks away over this long (s) before it is hidden; a world's drawn size follows the experiment's with this time constant (s). */
const LEAVE_S = 0.6;
const RESIZE_S = 0.5;
/** An event first seen within this much real time's worth of the rate (s) of when it happened is new (its fireball, its slowing); older (a replay, a load) leaves only its marks. */
const FRESH_S = 0.75;
/** The crater's drawn melt glow at full strength, as a share of sunlit white ground (./bodies/marks MELT: 0.18 times its colour's luminance). */
const MELT_GLOW = 0.18 * (0.2126 + 0.7152 * 0.33 + 0.0722 * 0.07);
/** What can be thrown (W1.12): a stone a kilometre across and a ten-kilometre asteroid (illustrative rock, 3,000 and 2,600 kg/m^3), Ceres and a Mars (the palette's sourced figures). */
const IMPACTORS: Readonly<Record<LabImpactor, { radiusKm: number; densityKgM3: number } | { preset: string }>> = {
  stone: { radiusKm: 0.5, densityKgM3: 3000 },
  asteroid: { radiusKm: 5, densityKgM3: 2600 },
  ceres: { preset: 'ceres' },
  mars: { preset: 'mars' },
};
/** A grouped tag's message (pieces of one torn body, or one breakup's), and an encounter marker's. */
const MESSAGES = labMessages as Readonly<Record<string, string>>;
const fill = (key: string, values: Readonly<Record<string, string>>): string => (MESSAGES[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => values[name] ?? '');
/** A command's answer: done, or refused with its reason. */
const DONE: Promise<LabEditResult> = Promise.resolve({ ok: true, created: [] });
const no = (reason: string): Promise<LabEditResult> => Promise.resolve({ ok: false, reason });
/** Commands that are edits to the run (their answer is the worker's), those that need the run's first snapshot, and those naming a body by `id`. */
const EDITS: ReadonlySet<LabCommand['kind']> = new Set(['mass', 'radius', 'density', 'spin', 'fixed', 'rename', 'impulse', 'elements', 'addPreset', 'addLagrange', 'velocity', 'addOrbit', 'addState', 'duplicate', 'remove', 'addSwarm', 'addRing', 'removeSwarm', 'atmosphere', 'addShip', 'burn', 'circularise', 'transfer', 'cancelBurns', 'throw'] as const);
const NEEDS_RUN: ReadonlySet<LabCommand['kind']> = new Set([...EDITS, 'aim', 'seek', 'place', 'removeMany', 'duplicateMany'] as const);
const NAMES_BODY: ReadonlySet<LabCommand['kind']> = new Set(['mass', 'radius', 'density', 'spin', 'fixed', 'rename', 'impulse', 'elements', 'velocity', 'duplicate', 'remove', 'burn', 'circularise', 'transfer', 'cancelBurns', 'atmosphere'] as const);
/** A body's look before the run has said (./sim/looks: rock). */
const ROCK_LOOK: Look = { albedo: 0.12, tint: [1, 0.96, 0.9], material: 'rock' };
/** Bodies that may shade others (the largest; ./lab-fx eclipses). */
const OCCLUDERS = 8;
/** A tap within this many CSS px of a small body chooses it (a finger's reach: 44 px across). */
const PICK_PX = 22;
/** The chosen body's pointer when it is off the view: this far inside the clear view (CSS px), its arrow by direction (east, then clockwise on screen). */
const EDGE_PX = 28;
const EDGE_ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'] as const;

/** Ecliptic (the scenario's frame) to the render frame: (x, z, -y). */
const toRender = (x: number, y: number, z: number, out: Km): Km => {
  out.x = x;
  out.y = z;
  out.z = -y;
  return out;
};

/** A polyline as an orbit path: u runs along it and back (so the hairline never joins its ends). */
function polylinePath(color: readonly [number, number, number]): OrbitPath & { set(points: ArrayLike<number>, count: number): void; readonly count: number } {
  let pts = new Float64Array(0);
  let n = 0;
  const centre = km();
  return {
    body: 'sun',
    centre,
    color,
    get sizeKm() {
      return 1;
    },
    get count() {
      return n;
    },
    set(points, count) {
      if (pts.length < count * 3) pts = new Float64Array(count * 3);
      for (let i = 0; i < count * 3; i += 1) pts[i] = points[i] ?? 0;
      n = count;
      centre.x = pts[(n - 1) * 3] ?? 0;
      centre.y = pts[(n - 1) * 3 + 1] ?? 0;
      centre.z = pts[(n - 1) * 3 + 2] ?? 0;
    },
    setDate() {
      /* points are set directly */
    },
    point(u, out) {
      if (n === 0) return out;
      const v = ((u % 1) + 1) % 1;
      const s = (v < 0.5 ? v * 2 : (1 - v) * 2) * (n - 1);
      const i = Math.min(n - 2, Math.floor(s));
      const f = n > 1 ? s - Math.max(0, i) : 0;
      const a = Math.max(0, i) * 3;
      const b = Math.min(n - 1, Math.max(0, i) + 1) * 3;
      out.x = (pts[a] ?? 0) + ((pts[b] ?? 0) - (pts[a] ?? 0)) * f;
      out.y = (pts[a + 1] ?? 0) + ((pts[b + 1] ?? 0) - (pts[a + 1] ?? 0)) * f;
      out.z = (pts[a + 2] ?? 0) + ((pts[b + 2] ?? 0) - (pts[a + 2] ?? 0)) * f;
      return out;
    },
    nearest(position) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < n; i += 4) {
        const d = ((pts[i * 3] ?? 0) - position.x) ** 2 + ((pts[i * 3 + 1] ?? 0) - position.y) ** 2 + ((pts[i * 3 + 2] ?? 0) - position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return n > 1 ? (best / (n - 1)) * 0.5 : 0;
    },
  };
}

/**
 * A body's recent path (W1.0): its positions (scenario frame, km) and their times, in rings of
 * TRAIL_POINTS, the oldest first by index; sampled and drawn without allocating.
 */
class TrailRing {
  readonly pos = new Float64Array(TRAIL_POINTS * 3);
  readonly time = new Float64Array(TRAIL_POINTS);
  start = 0;
  count = 0;
  /** The simulated time it was last sampled at. */
  at = Number.NEGATIVE_INFINITY;
  /** Point k's coordinate c (oldest first). */
  x(k: number, c: number): number {
    return this.pos[((this.start + k) % TRAIL_POINTS) * 3 + c] ?? 0;
  }
  t(k: number): number {
    return this.time[(this.start + k) % TRAIL_POINTS] ?? 0;
  }
  push(x: number, y: number, z: number, t: number): void {
    let i = (this.start + this.count) % TRAIL_POINTS;
    if (this.count < TRAIL_POINTS) this.count += 1;
    else {
      i = this.start;
      this.start = (this.start + 1) % TRAIL_POINTS;
    }
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.time[i] = t;
  }
  /** Drops the newest. */
  pop(): void {
    if (this.count > 0) this.count -= 1;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB unavailable'));
    };
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function createLab(ephemeris: Ephemeris, physical: PhysicalFile, earthMassKg: number, names: Readonly<Record<string, string>>, figures: Shapes = {}, figure: (id: string) => number | null = () => null): Lab {
  // Each world's figure, its climate from the sourced constants (src/sim/climate), and the Sun's light.
  const climates = worldClimates(figure);
  const sunLight = figure('sun.luminosity');
  const shapes: Shapes = Object.fromEntries([...new Set([...Object.keys(figures), ...Object.keys(climates), 'sun'])].map((id) => [id, { ...figures[id], climate: climates[id] ?? null, luminosityW: id === 'sun' ? sunLight : null }]));
  /** One G for every body: the Earth's GM (km^3 s^-2) over its mass (kg). */
  const gPerKg = physical.gmKm3S2.Earth / earthMassKg;
  let worker: Worker | null = null;
  let generation = 0;
  let active = false;
  let seedScenario: Scenario | null = null;
  /** Whether the seed is the real solar system (JPL's states at the fork), the baseline edits are compared with. */
  let realSeed = false;
  let baselines: { from: Scenario; byId: Map<string, NonNullable<UniverseLabBody['baseline']>> } | null = null;
  /** A built-in world's real mass, size and orbit at the fork (the real seed's), or null. */
  const baselineOf = (id: string): UniverseLabBody['baseline'] => {
    const seed = seedScenario;
    if (!seed || !realSeed || !builtIn(id)) return null;
    if (baselines?.from !== seed) {
      const gm = seed.bodies.map((b) => b.gm);
      const pos = seed.bodies.flatMap((b) => [...b.pos]);
      const byId = new Map<string, NonNullable<UniverseLabBody['baseline']>>();
      seed.bodies.forEach((b, i) => {
        const p = primaryOf(gm, pos, i);
        const q = seed.bodies[p];
        const el = q ? elementsFromState(sub3(b.pos, q.pos), sub3(b.vel, q.vel), b.gm + q.gm) : null;
        const orbit = el?.bound ? el : null;
        byId.set(b.id, { massKg: b.gm / gPerKg, radiusKm: b.radiusKm, aKm: orbit ? orbit.a : null, e: orbit ? orbit.e : null, periodS: orbit ? orbit.periodS : null });
      });
      baselines = { from: seed, byId };
    }
    return baselines.byId.get(id) ?? null;
  };
  let snap: LabSnapshot | null = null;
  /** The latest snapshots of this timeline, each with when it arrived (ms): the bodies are drawn between them (./lab-clock). */
  let held: Array<LabSnapshot & { at: number }> = [];
  const clock = new LabClock();
  let clockWall = Number.NaN;
  let rate = 86_400;
  let paused = false;
  /**
   * Run and goto requests sent (snapshots echo the latest the worker had); back at the start going
   * backwards; a goto under way, one being stopped by a run request (still followed, and reported as
   * under way, until the worker says it has stopped), and one just ended or stopped (drawn at once
   * where the worker got to).
   */
  let control = 0;
  let edge: 'start' | null = null;
  let seekingS: number | null = null;
  let stopping: number | null = null;
  let arrived = false;
  /** A laboratory of its own (no Sun): its star, which the hidden Sun stands in for (the view follows it), and its height above the camera's (km); -1 for none. */
  let standIn = -1;
  let standInAltitudeKm = 0;
  /** The explorer's date the solar system was forked at (a Solar system start later forks at it again). */
  let forkJdTdb = 0;
  let selected: string | null = null;
  let horizonS = DEFAULT_HORIZON_S;
  /** The chosen body's path integrated ahead from simulated time `fromT` (its times are from then). */
  let prediction: { id: string; horizonS: number; fromT: number; path: Float64Array; merged: { t: number; with: string; pos: [number, number, number] } | null; frame: string | null; framePath: Float64Array; revision: number; encounters: Encounter[] } | null = null;
  let predictedAt = Number.NEGATIVE_INFINITY;
  /** Edits sent to the worker in this generation (its snapshots say how many it had). */
  let sentEdits = 0;
  let status: UniverseLab['status'] = null;
  let saveRequest = 0;
  const saveWaiters = new Map<number, (s: Scenario) => void>();
  let refocus: BodyId | null = null;
  const edited = new Set<string>();
  const seenEvents = new Set<string>();
  /** Craters placed on the worlds drawn, by event: where (the world's own frame, as its surface stood at the impact), and as drawn now. */
  const craterMarks = new Map<string, { body: BodyId; site: Vec3; latDeg: number; lonDeg: number; appear: number; glow: number; at: number }>();
  const eventKey = (e: { step: number; absorbed: string; kind: string }): string => `${e.step}:${e.absorbed}:${e.kind}`;
  /** Every body's name seen in this scenario, kept after it merges or is removed (for the history). */
  const knownNames = new Map<string, string>();
  const palette: Preset[] = presetList(physical);
  const presetView = palette.map((x) => ({ id: x.id, kind: x.kind, massKg: x.gm / gPerKg, radiusKm: x.radiusKm, rotationH: x.rotationH, source: x.source }));
  let accuracy: UniverseLab['accuracy'] = 'normal';
  let viewMode: UniverseLab['view'] = 'primary';
  let showLagrange = false;
  let measureAsk: { from: string; to: string; via: string | null } | null = null;
  let tracked: { id: string; quantity: LabQuantity; points: Array<[number, number]>; mergedInto: string | null; lastT: number } | null = null;
  let library: string[] = [];
  let share: UniverseLab['share'] = null;
  let copy: UniverseLab['copy'] = null;
  /** Placing a new body with the pointer: about which body, and what (a preset, or the Add form's values). */
  let placing: { primary: string; name: string; massKg: number; radiusKm: number; preset: Preset | null } | null = null;
  /** Where the pointer would place it (scenario frame, km from the primary), or null off the plane. */
  let hoverOffset: Vec3 | null = null;
  /** The velocity arrow being dragged: the body, the arrow's length per km/s, the plane it moves in, and the velocity shown meanwhile (relative to the primary, scenario frame). */
  let dragging: { id: string; len: number; tipRel: Vec3; normal: Vec3; vel: Vec3 } | null = null;
  /** The explorer's camera for the pointer (set by the explorer), and the last frame's relative-position function. */
  let pointerView: LabPointerView | null = null;
  /** The velocity arrow's tip on the canvas (client px), and its length per km/s (s), as last drawn. */
  let handleAt: { x: number; y: number } | null = null;
  let arrowLen = 0;
  let lastRelative: ((abs: Km, out: Km) => Km) | null = null;
  /** Built-in worlds whose spin the visitor set, drawn turning as set: from this moment, this basis (render frame), this pole and period. */
  const spinDrawn = new Map<BodyId, { t: number; basis: number[]; pole: Vec3; periodS: number; flip: boolean; spin: Vec3 }>();

  // Trails: each body's recent positions (scenario frame, km), sampled once a snapshot.
  const trails = new Map<string, TrailRing>();
  /** A trail as drawn this frame (render frame, km): filled for each in turn, copied by its path. */
  const trailDrawn = new Float64Array(TRAIL_POINTS * 3);
  const trailPaths = Array.from({ length: TRAIL_SLOTS }, () => polylinePath(TRAIL));
  const chosenTrail = polylinePath(TRAIL_CHOSEN);
  const predictionPath = polylinePath(PREDICTION);
  const velocityPath = polylinePath(VELOCITY);
  const paths: OrbitPath[] = [...trailPaths, chosenTrail, predictionPath, velocityPath];
  const lines: Orbits = createOrbits(paths);
  lines.mesh.visible = false;
  const weights = new Array<number>(paths.length).fill(0);
  const dots: Impostors = createImpostors(DOT_SLOTS);
  dots.object.visible = false;
  /** Markers: the five Lagrange points, the prediction's encounters, the placing preview and the velocity arrow's handle. */
  // The five Lagrange points, encounters, the placing preview, the velocity handle and a ship's three directions.
  const MARKER_SLOTS = 16;
  const markers: Impostors = createImpostors(MARKER_SLOTS);
  markers.object.visible = false;
  const markerList: ImpostorDot[] = Array.from({ length: MARKER_SLOTS }, () => ({ position: km(), color: [1, 1, 1] as const, opacity: 0, sizePx: 0, marker: 0 }));
  const dotList: ImpostorDot[] = Array.from({ length: DOT_SLOTS }, () => ({ position: km(), color: [1, 0.9, 0.75] as const, opacity: 0, sizePx: 0, marker: 0 }));
  // Rings and belts: a point for every particle.
  const particles: Impostors = createImpostors(SWARM_LIMITS.total);
  particles.object.visible = false;
  const particleList: ImpostorDot[] = Array.from({ length: SWARM_LIMITS.total }, () => ({ position: km(), color: PARTICLES.belt, opacity: 0, sizePx: PARTICLES.sizePx, marker: 0 }));
  let particlesDrawn = 0;
  /** The temperature view on the worlds drawn (ledger WR-6). */
  let climateView = false;
  // Dust plumes: where each began (its body, and the site in the scenario's frame), when, how high, and its points' throws.
  const dust: Impostors = createImpostors(DUST.perImpact * DUST.plumes);
  dust.object.visible = false;
  const dustList: ImpostorDot[] = Array.from({ length: DUST.perImpact * DUST.plumes }, () => ({ position: km(), color: DUST.color, opacity: 0, sizePx: DUST.sizePx, marker: 0 }));
  /** Plumes: where each began (its body, the site in the scenario's frame), when (wall ms), how high, its points' throws, and when it began to fade away early (a newer one wanting its place), or null. */
  const plumes: Array<{ key: string; body: string; site: Vec3; born: number; heightKm: number; throws: Float64Array; ending: number | null }> = [];
  /** The worlds' bases now (render frame), so a plume rises from its crater as the world turns. */
  const basisNow = new Map<BodyId, number[]>();
  const labelList: SceneLabel[] = [];
  const edgeAt = km();
  const scratch = km();
  const abs = km();
  const rel = km();
  const anchor = [0, 0, 0];
  const point = [0, 0, 0];

  // The effects (./lab-fx): their own chunk, loaded with the first experiment, drawn into this group.
  const fxRoot = new Group();
  fxRoot.name = 'lab-effects';
  let fx: LabFx | null = null;
  let fxLoading = false;
  let fxTier: string | null = null;
  let report: FxReport | null = null;
  const tierNow = (): ExploreTier | undefined => {
    const t = document.documentElement.getAttribute('data-detail');
    return t === 'ultra' || t === 'high' || t === 'medium' || t === 'low' ? t : undefined;
  };
  const loadFx = (): void => {
    const tier = tierNow() ?? null;
    if (fxLoading || (fx && fxTier === tier)) return;
    fxLoading = true;
    import('./lab-fx')
      .then(({ createLabFx }) => {
        // Made again for a new tier (its meshes' detail and counts are the tier's).
        if (fx) {
          fxRoot.remove(fx.root);
          fx.dispose();
        }
        fx = createLabFx(tier ?? undefined);
        fxTier = tier;
        fxRoot.add(fx.root);
      })
      .catch(() => {
        // Not loaded (offline): the bodies stay points of light; the next experiment tries again.
      })
      .finally(() => {
        fxLoading = false;
      });
  };
  const reducedNow = (): boolean => document.documentElement.getAttribute('data-reduced-motion') === 'true';

  // Fades (flash safety): each body's and swarm's, and what a body gone is drawn as while it fades.
  const bodyFades = new Map<string, { fade: number; body: FxBody }>();
  const swarmFades = new Map<string, { fade: number; swarm: FxSwarm }>();
  const fxBodies: FxBody[] = [];
  const fxSwarms: FxSwarm[] = [];
  const fxPlumes: FxPlume[] = [];
  const impacts: FireballEvent[] = [];
  /** Hot bodies (W2.3's first part): melt exposed at simulated time `t0` (s), at `meltK`, its surface crusting over (./lab-fx/heat). */
  const heats = new Map<string, { meltK: number; t0: number; event: string }>();
  /** Giant impacts' heat on the worlds drawn (no crater): a glow over the face struck, by event. */
  const heatMarks = new Map<string, { body: BodyId; site: Vec3; local: Vec3 | null; angle: number; meltK: number; t: number; glow: number; at: number }>();
  /** Craters going (a 13th came): fading before their place is given up. */
  const evicted = new Set<string>();
  /** Each body's radius and look as last seen (an impactor's, once it is gone). */
  const lastRadius = new Map<string, number>();
  const lastGm = new Map<string, number>();
  const lastLook = new Map<string, Look>();
  /** The built-in worlds' drawn sizes (eased) and those leaving (shrinking away from where they were). */
  const builtScale = new Map<BodyId, number>();
  const leaving = new Map<BodyId, { at: number; pos: Vec3; scale: number }>();
  let lastBuiltWall = Number.NaN;
  /** The latest event, for the event card, and its key (the event its pieces carry: ./sim/looks); each body's origin as last seen. */
  let latest: UniverseLab['latest'] = null;
  let latestKey = '';
  const lastOrigin = new Map<string, string>();

  // Slowing down for events (SLOW).
  let slowOn = true;
  try {
    slowOn = localStorage.getItem(SLOW.storage) !== '0';
  } catch {
    // No storage (a private window): on, as by default.
  }
  /** What it is slowing for (a pair's key), the rate that shows it, the contact's simulated time (null once it has happened), the phase and since when (wall s), and the rate it set out from. */
  let slow: { key: string; kind: 'impact' | 'disrupt'; target: string; body: string; showRate: number; contactT: number | null; phase: 'approach' | 'hold' | 'back'; since: number; from: number } | null = null;
  const dismissed = new Set<string>();
  /**
   * The rate the clock runs at now (the visitor's, or slower for an event), and the one last sent; and the
   * drawn clock's pace, the same but for an event's approach: there, by its own distance from the contact.
   */
  let shownRate = 86_400;
  let sentRate = 86_400;
  let drawnPace = 86_400;

  // A throw being aimed (W1.12).
  let aim: (LabAim & { plan: ThrowPlan | null; requestId: number; spec: { id: string; name: string; gm: number; radiusKm: number }; logLength: number }) | null = null;
  let aimRequest = 0;

  // What the effects are given each frame (reused), and their clock (s: the frames' own, so each easing is per frame as shown).
  let fxClock = 0;
  const presentIds = new Set<string>();
  const plumeBuffers: FxPlume[] = [];
  const fxLights: Array<{ id: string; pos: readonly number[]; watts: number }> = [];
  const fxOccluders: Array<{ id: string; pos: readonly number[]; radiusKm: number }> = [];
  let occluderSeq = -1;
  const occluderIndex: number[] = [];
  const viewScratch = km();
  const plumeCentre = km();
  const plumeRel = km();
  const plumePoint = km();
  /** Names: each body's place and size as seen (five numbers a body), and the families of pieces by event. */
  const labelGeom: number[] = [];
  const families = new Map<string, number[]>();

  // Answers to edits: each edit numbered, its answer waiting for the worker's 'ack'; commands sent before the first snapshot wait for it.
  let editSeq = 0;
  const acks = new Map<number, (r: LabEditResult) => void>();
  /** The answer of the edit a command made last (runCommand), and why a command was refused before any edit. */
  let lastAnswer: Promise<LabEditResult> | null = null;
  let why: string | null = null;
  const queued: Array<{ c: LabCommand; resolve: (r: LabEditResult) => void }> = [];

  const send = (msg: LabRequest, transfer: Transferable[] = []): void => {
    worker?.postMessage(msg, transfer);
  };

  const builtIn = (id: string): BodyId | null => (BODY_IDS as readonly string[]).includes(id) ? (id as BodyId) : null;

  /** Each body's place at the drawn time (scenario frame, km), by id: worked out once a frame. */
  const drawnAt = new Map<string, Vec3>();
  let drawnFor = Number.NaN;
  let drawnSnap: LabSnapshot | null = null;
  const place = (s: LabSnapshot, i: number): Vec3 => {
    if (drawnFor !== clock.shown || drawnSnap !== snap) {
      drawnAt.clear();
      drawnFor = clock.shown;
      drawnSnap = snap;
    }
    const id = s.ids[i] ?? '';
    let p = drawnAt.get(id);
    if (!p) {
      p = [s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0];
      placeAt(held, id, clock.shown, p);
      drawnAt.set(id, p);
    }
    return p;
  };
  /** The clock's rate and pause to the worker (a goto under way stops where it is, drawn there at once); paused, with the moment drawn, which the run steps on to. */
  const sendRun = (): void => {
    control += 1;
    if (seekingS !== null) stopping = seekingS;
    seekingS = null;
    sentRate = shownRate;
    send({ type: 'run', generation, control, rate: shownRate, paused, ...(paused ? { landAt: clock.shown } : {}) });
  };
  /** The visitor's own rate again: any slowing for an event called off (that event is not slowed for again). */
  const ownRate = (): void => {
    if (slow) dismissed.add(slow.key);
    slow = null;
    shownRate = rate;
  };
  /**
   * Goes to simulated time `t` (s since the epoch), kept from the fork to LAB_DATE_SPAN_S after it: to the
   * first whole step at or past it, never out of `within` (a date's day: src/sim/goto) when that holds it.
   */
  const goTo = (t: number, within: Within | null = null): void => {
    control += 1;
    seekingS = Math.min(LAB_DATE_SPAN_S, Math.max(0, t));
    edge = null;
    const kept = within !== null && within[0] <= seekingS && seekingS < within[1];
    send({ type: 'goto', generation, control, t: seekingS, ...(kept ? { within } : {}) });
  };

  const load = (scenario: Scenario): void => {
    generation += 1;
    sentEdits = 0;
    snap = null;
    held = [];
    clock.restart();
    edge = null;
    seekingS = null;
    stopping = null;
    prediction = null;
    trails.clear();
    edited.clear();
    seenEvents.clear();
    craterMarks.clear();
    knownNames.clear();
    // A new scenario: edits sent to the old one are answered (refused), its effects and slowing go.
    for (const resolve of acks.values()) resolve({ ok: false, reason: 'the experiment was replaced' });
    acks.clear();
    heats.clear();
    heatMarks.clear();
    evicted.clear();
    latest = null;
    latestKey = '';
    lastOrigin.clear();
    lastRadius.clear();
    lastGm.clear();
    lastLook.clear();
    slow = null;
    dismissed.clear();
    shownRate = rate;
    aim = null;
    fx?.clear();
    if (!worker) {
      worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<LabReply>) => {
        onReply(event.data);
      };
    }
    send({ type: 'load', generation, scenario: structuredClone(scenario) });
    sendRun();
    requestPrediction();
    // A copy or a share link asked for as the scenario was replaced is of the new one: the old one's answer is dropped.
    for (const requestId of saveWaiters.keys()) send({ type: 'save', generation, requestId });
  };

  /** The time (s) from simulated time `t` to the prediction's nearest encounter or merger still to come (infinite for none). */
  const soonest = (t: number): number => {
    const p = prediction;
    if (!p) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const e of p.encounters) if (p.fromT + e.t > t) best = Math.min(best, p.fromT + e.t - t);
    if (p.merged && p.fromT + p.merged.t > t) best = Math.min(best, p.fromT + p.merged.t - t);
    return best;
  };
  const requestPrediction = (): void => {
    send({ type: 'predict', generation, id: selected, horizonS, accuracy: ACCURACY[accuracy] });
    predictedAt = snap?.t ?? 0;
  };

  /** The tracked quantity's value for a body now. */
  const quantity = (s: LabSnapshot, i: number, q: LabQuantity): number | null => {
    if (q === 'energyDrift') return s.drift.energy;
    const p = primaryOf(s.gm, s.pos, i);
    const r = [0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) - (p >= 0 ? (s.pos[p * 3 + k] ?? 0) : 0));
    const v = [0, 1, 2].map((k) => (s.vel[i * 3 + k] ?? 0) - (p >= 0 ? (s.vel[p * 3 + k] ?? 0) : 0));
    if (q === 'distance') return p >= 0 ? Math.hypot(...r) : null;
    if (q === 'speed') return Math.hypot(...v);
    if (p < 0) return null;
    return elementsFromState(r, v, (s.gm[p] ?? 0) + (s.gm[i] ?? 0)).e;
  };

  /** One sample of the tracked quantity (following the body into whatever it merges with). */
  const sampleTracked = (s: LabSnapshot): void => {
    const t = tracked;
    if (!t || s.t === t.lastT) return;
    // Going back: what was followed after this moment has not happened yet.
    while (t.points.length > 0 && (t.points[t.points.length - 1]?.[0] ?? 0) > s.t) t.points.pop();
    const merged = s.events.find((e) => consumes(e) && e.absorbed === t.id);
    if (merged && !s.ids.includes(t.id)) {
      t.mergedInto = merged.survivor;
      t.id = merged.survivor;
    }
    const i = s.ids.indexOf(t.id);
    if (i < 0) return;
    const value = quantity(s, i, t.quantity);
    if (value === null || !Number.isFinite(value)) return;
    t.lastT = s.t;
    t.points.push([s.t, value]);
    if (t.points.length > GRAPH_POINTS) t.points = t.points.filter((_, k) => k % 2 === 0);
  };

  /**
   * An event seen for the first time: the event card's numbers; and, if it has just happened (not one a
   * replay or a load brings back), its fireball, the heat it leaves and the slowing that shows it.
   */
  const noteEvent = (msg: LabSnapshot, e: LabSnapshot['events'][number], key: string, fresh: boolean): void => {
    const ti = msg.ids.indexOf(e.survivor);
    // The event's own (its pieces may have fallen back before this snapshot), and as it is now.
    const after = e.radiusKm > 0 ? e.radiusKm : ti >= 0 ? (msg.radius[ti] ?? null) : null;
    const radiusNow = ti >= 0 ? (msg.radius[ti] ?? null) : null;
    const before = lastRadius.get(e.survivor) ?? after;
    const gmBefore = lastGm.get(e.survivor);
    // Its own pieces falling back (a breakup's debris, a torn body's pieces striking) are counted on its card, not a card of their own.
    const echo = latest !== null && e.kind !== 'disrupt' && (lastOrigin.get(e.absorbed) === latestKey || lastOrigin.get(e.survivor) === latestKey);
    // The event's own radius after stays its own; what its pieces falling back make of the survivor is said apart.
    if (echo && latest) latest = { ...latest, later: latest.later + 1, radiusNowKm: e.survivor === latest.survivor ? radiusNow : latest.radiusNowKm };
    else {
      latest = { t: e.t, kind: e.kind, regime: e.regime, survivor: e.survivor, absorbed: e.absorbed, speedKmS: e.speedKmS, angleDeg: (Math.acos(Math.min(1, Math.max(0, e.b))) * 180) / Math.PI, energyJ: joules(e.energy), created: e.created.length, craterKm: e.crater?.diameterKm ?? null, radiusBeforeKm: before, radiusAfterKm: after, massBeforeKg: gmBefore === undefined ? null : gmBefore / gPerKg, massAfterKg: e.gm > 0 ? e.gm / gPerKg : null, later: 0, radiusNowKm: null };
      latestKey = key;
      // Pieces that fell back within the snapshot that brought it: counted as they are seen (each its own event), the radius now as it is.
      if (radiusNow !== null && after !== null && Math.abs(radiusNow - after) > 1e-9 * after) latest.radiusNowKm = radiusNow;
    }
    if (!fresh || e.kind === 'graze') return;
    const now = performance.now() / 1000;
    const targetKm = after ?? 0;
    if (e.kind !== 'disrupt') {
      impacts.push({ key, body: e.survivor, site: [e.site[0], e.site[1], e.site[2]], energyJ: joules(e.energy), speedKmS: e.speedKmS, impactorKm: lastRadius.get(e.absorbed) ?? 1, targetKm });
      // A giant impact (no crater: the target reshaped) melts what it leaves: the bodies glow as a crust forms over them.
      if (!e.crater && ti >= 0) {
        const kg = [e.survivor, ...e.created].reduce((sum, id) => sum + (msg.gm[msg.ids.indexOf(id)] ?? 0), 0) / gPerKg;
        const meltK = giantMeltK(kg > 0 ? joules(e.energy) / kg : 0);
        for (const id of [e.survivor, ...e.created]) if (!builtIn(id)) heats.set(id, { meltK, t0: e.t, event: key });
        const world = builtIn(e.survivor);
        const rp = lastRadius.get(e.absorbed) ?? 0;
        if (world && MARKED.includes(world) && targetKm > 0) heatMarks.set(key, { body: world, site: [e.site[0], e.site[1], e.site[2]], local: null, angle: Math.min(Math.PI / 2, Math.max(0.05, 1.5 * Math.asin(Math.min(1, rp / targetKm)))), meltK, t: e.t, glow: 0, at: performance.now() });
      }
    }
    // Slowed to show it: held where the approach already slowed, at once where it came unseen.
    const pair = `${e.survivor}|${e.absorbed}`;
    if (!slowOn || rate <= 0 || dismissed.has(pair)) return;
    let showRate = targetKm > 0 && e.speedKmS > 0 ? targetKm / e.speedKmS / 8 : rate;
    if (e.kind === 'disrupt') {
      const pi = msg.ids.indexOf(e.created[0] ?? '');
      const d = pi >= 0 && ti >= 0 ? Math.hypot((msg.pos[pi * 3] ?? 0) - (msg.pos[ti * 3] ?? 0), (msg.pos[pi * 3 + 1] ?? 0) - (msg.pos[ti * 3 + 1] ?? 0), (msg.pos[pi * 3 + 2] ?? 0) - (msg.pos[ti * 3 + 2] ?? 0)) : 0;
      const mu = ti >= 0 ? (msg.gm[ti] ?? 0) : 0;
      showRate = d > 0 && mu > 0 ? (2 * Math.PI * Math.sqrt((d * d * d) / mu)) / 20 : rate;
    }
    showRate = Math.min(rate, Math.max(SLOW.minRate, showRate));
    if (slow && slow.key === pair && slow.phase === 'approach') {
      slow.phase = 'hold';
      slow.since = now;
      slow.contactT = null;
      return;
    }
    if (showRate >= rate * 0.999) return;
    slow = { key: pair, kind: e.kind === 'disrupt' ? 'disrupt' : 'impact', target: e.survivor, body: e.absorbed, showRate, contactT: null, phase: 'hold', since: now, from: shownRate };
  };

  const onReply = (msg: LabReply): void => {
    // A reply for an older scenario (reset, loaded over, or left) is dropped.
    if (msg.generation !== generation || !active) return;
    if (msg.type === 'ack') {
      const resolve = acks.get(msg.editSeq);
      acks.delete(msg.editSeq);
      if (!msg.ok) status = { kind: 'refused', detail: [msg.reason ?? ''] };
      resolve?.(msg.ok ? { ok: true, created: msg.created } : { ok: false, reason: msg.reason ?? 'refused' });
      return;
    }
    if (msg.type === 'aimed') {
      if (!aim || msg.requestId !== aim.requestId) return;
      const c = msg.plan.contact;
      aim.plan = msg.plan;
      aim.status = msg.plan.refused ? 'refused' : 'ready';
      aim.reason = msg.plan.refused;
      aim.missKm = msg.plan.missKm;
      aim.logLength = msg.logLength;
      aim.contact = c ? { with: c.with, inS: c.inS, speedKmS: c.speedKmS, angleDeg: c.angleDeg, regime: c.regime, craterKm: c.craterKm, energyJ: joules(c.energy) } : null;
      return;
    }
    if (msg.type === 'snapshot') {
      if (snap && msg.seq <= snap.seq) return;
      // The run going on as it was (not a jump, a load or a replay): what happens now is new.
      const continuing = snap !== null && msg.timeline === snap.timeline;
      // A jump of the run (a seek, a replay, an undo, a goto going back): drawn from its new place, its trails begun again.
      if (snap && msg.timeline !== snap.timeline) {
        held = [];
        trails.clear();
      }
      snap = msg;
      held.push({ ...msg, at: performance.now() });
      if (held.length > 6) held.shift();
      // What the worker did with the latest request: stopped at the start going backwards (paused there), or finished a goto.
      if (msg.control === control) {
        edge = msg.edge;
        if (msg.edge && rate < 0) paused = true;
        if ((seekingS !== null || stopping !== null) && msg.seekingS === null) arrived = true;
        stopping = null;
        seekingS = msg.seekingS;
      }
      msg.ids.forEach((id, i) => knownNames.set(id, msg.names[i] ?? id));
      for (const w of msg.swarms) knownNames.set(w.id, w.name);
      sampleTrails(msg);
      sampleTracked(msg);
      // Collisions gone back before (the history played backwards): their craters and dust go, and come again with them.
      const present = new Set(msg.events.map(eventKey));
      const earliest = msg.events[0]?.step ?? Number.POSITIVE_INFINITY;
      for (const key of seenEvents) {
        const step = Number(key.slice(0, key.indexOf(':')));
        if (!present.has(key) && step >= Math.min(earliest, msg.step)) {
          seenEvents.delete(key);
          craterMarks.delete(key);
          // Its heat too (an undo or a jump back before it): it glows again only if the event comes again.
          heatMarks.delete(key);
          for (const [id, h] of heats) if (h.event === key) heats.delete(id);
        }
      }
      // An event is new if the run reached it since the last snapshot (within FRESH_S of real time's worth at the rate).
      const freshWithin = Math.max(600, Math.abs(msg.achievedRate || shownRate) * FRESH_S);
      for (const e of msg.events) {
        const key = eventKey(e);
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        noteEvent(msg, e, key, continuing && msg.t - e.t <= freshWithin && msg.t >= e.t);
        // Dust from the impact (decorative): its throws fixed now, so each plume is the same however it is drawn.
        const ti = msg.ids.indexOf(e.survivor);
        const radiusKm = ti >= 0 ? (msg.radius[ti] ?? 0) : 0;
        if ((e.kind === 'merge' || e.kind === 'fragment') && radiusKm > 0) {
          let r = (Math.imul(e.step + 1, 2654435761) ^ e.absorbed.length * 40503) >>> 0;
          const next = (): number => ((r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296);
          const throws = new Float64Array(DUST.most * 3);
          for (let k = 0; k < DUST.most; k += 1) {
            throws[k * 3] = DUST.cone * Math.sqrt(next());
            throws[k * 3 + 1] = 2 * Math.PI * next();
            throws[k * 3 + 2] = 0.3 + 0.7 * next();
          }
          const heightKm = e.crater ? Math.min(radiusKm, Math.max(20, 4 * e.crater.diameterKm)) : 0.5 * radiusKm;
          // Impacts on one body within a second make one plume; past the most, the oldest fades away (none is cut off).
          const wallNow = performance.now();
          if (!plumes.some((q) => q.body === e.survivor && wallNow - q.born < 1000)) {
            plumes.push({ key, body: e.survivor, site: [e.site[0], e.site[1], e.site[2]], born: wallNow, heightKm, throws, ending: null });
            const live = plumes.filter((q) => q.ending === null);
            for (let k = 0; k < live.length - DUST.plumes; k += 1) {
              const q = live[k];
              if (q) q.ending = wallNow;
            }
          }
        }
        // A graze leaves both bodies; a merger or a breakup ends the projectile (the target keeps its id).
        if (!consumes(e)) continue;
        trails.delete(e.absorbed);
        if (selected === e.absorbed) {
          selected = e.survivor;
          requestPrediction();
        }
        const b = builtIn(e.absorbed);
        if (b) refocus = builtIn(e.survivor) ?? 'sun';
      }
      // A body just added or duplicated is chosen at once; a snapshot taken before the worker had the edit does not have it yet.
      if (selected && msg.applied >= sentEdits && !msg.ids.includes(selected)) selected = null;
      // As simulated time passes, the prediction (from "now") is redone every eighth of its horizon, and more
      // often as an encounter it found comes near (every half of the time left to it, at most hourly).
      if (selected && Math.abs(msg.t - predictedAt) > Math.min(horizonS / 8, Math.max(3600, soonest(msg.t) / 2))) requestPrediction();
      // Each body's size and look as last seen (an impactor's still known once it has gone).
      msg.ids.forEach((id, i) => {
        lastRadius.set(id, msg.radius[i] ?? 0);
        lastGm.set(id, msg.gm[i] ?? 0);
        const look = msg.looks[i];
        if (look) lastLook.set(id, look);
        const origin = msg.origin[i];
        if (origin) lastOrigin.set(id, origin.event);
      });
      // Commands sent before the first snapshot run now.
      while (queued.length > 0) {
        const q = queued.shift();
        if (q) void lab.command(q.c).then(q.resolve);
      }
    } else if (msg.type === 'prediction') {
      if (!prediction || msg.revision >= prediction.revision) prediction = { id: msg.id, horizonS: msg.horizonS, fromT: msg.fromT, path: msg.path, merged: msg.merged, frame: msg.frame, framePath: msg.framePath, revision: msg.revision, encounters: msg.encounters };
    } else if (msg.type === 'saved') {
      saveWaiters.get(msg.requestId)?.(msg.scenario);
      saveWaiters.delete(msg.requestId);
    } else {
      status = { kind: 'error', detail: [msg.message] };
    }
  };

  const sampleTrails = (s: LabSnapshot): void => {
    for (let i = 0; i < s.ids.length; i += 1) {
      const id = s.ids[i] ?? '';
      let t = trails.get(id);
      if (!t) {
        t = new TrailRing();
        trails.set(id, t);
      }
      if (s.t === t.at) continue;
      // Going back: the path after this moment is not yet travelled.
      while (t.count > 0 && t.t(t.count - 1) > s.t) t.pop();
      t.at = s.t;
      t.push(s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0, s.t);
    }
    for (const id of trails.keys()) if (!s.ids.includes(id)) trails.delete(id);
  };

  /** Asks the worker for the scenario as it stands (start, settings, edits). */
  const saved = (): Promise<Scenario> =>
    new Promise((resolve) => {
      saveRequest += 1;
      saveWaiters.set(saveRequest, resolve);
      send({ type: 'save', generation, requestId: saveRequest });
    });

  /** An edit to the run, answered once the worker has it (applied, or refused with the reason: Engine.refusal). `atStep`: the step it is made at (by default the view last seen). */
  const edit = (given: Command, atStep?: number, exact = false): void => {
    // A solid body the visitor adds has a temperature too: an airless rock, unless it comes with a climate.
    const command: Command = given.kind === 'add' && !given.body.climate && given.body.gm > 0 && given.body.gm <= SOLID_MAX_GM ? { ...given, body: { ...given.body, climate: airlessRock() } } : given;
    sentEdits += 1;
    editSeq += 1;
    const seq = editSeq;
    const answer = new Promise<LabEditResult>((resolve) => {
      acks.set(seq, resolve);
    });
    // On the run as last seen: the worker goes back to that step if it has run on since.
    const step = atStep ?? (snap?.generation === generation ? snap.step : undefined);
    send({ type: 'command', generation, command, editSeq: seq, ...(step !== undefined ? { atStep: step } : {}), ...(exact ? { exact } : {}) });
    edited.add(commandId(command));
    lastAnswer = answer;
  };

  /** A fresh id for a new body, never used before in this scenario. */
  const freshId = (base: string): string => {
    const used = new Set([...(seedScenario?.bodies.map((b) => b.id) ?? []), ...(snap?.ids ?? []), ...edited]);
    let n = 1;
    while (used.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
  };

  /** Every star's light on body `i` (W/m^2): luminosity over 4 pi d^2. */
  const insolationAt = (s: LabSnapshot, i: number): number => {
    let sum = 0;
    for (const [star, watts] of Object.entries(s.light)) {
      const j = s.ids.indexOf(star);
      if (j < 0 || j === i) continue;
      const d = Math.hypot((s.pos[j * 3] ?? 0) - (s.pos[i * 3] ?? 0), (s.pos[j * 3 + 1] ?? 0) - (s.pos[i * 3 + 1] ?? 0), (s.pos[j * 3 + 2] ?? 0) - (s.pos[i * 3 + 2] ?? 0)) * 1000;
      if (d > 0) sum += watts / (4 * Math.PI * d * d);
    }
    return sum;
  };
  /** Body `i`'s climate for the view: its bands and their summary, its greenhouse, and an airless world's noon. */
  const climateOf = (s: LabSnapshot, i: number): UniverseLabBody['climate'] => {
    const id = s.ids[i] ?? '';
    const c = s.climate.find((x) => x.id === id);
    if (!c) return null;
    const summary = climateSummary({ spec: c.spec, t: c.t });
    const airless = c.spec.model === 'grey' && c.spec.tau === 0 && c.spec.pressurePa < 1;
    const world = builtIn(id);
    const gases: Array<{ gas: string; percent: number }> = [];
    if (world) {
      for (const gas of GASES) {
        const percent = figure(`${world}.atmosphere.${gas}`);
        if (percent !== null) gases.push({ gas, percent });
      }
    }
    return { model: c.spec.model, bandsK: [...c.t], meanK: summary.meanK, minK: summary.minK, maxK: summary.maxK, ice: summary.ice, liquid: summary.liquid, iceLineDeg: summary.iceLineDeg, tau: c.spec.tau, forcing: c.spec.forcing, pressurePa: c.spec.pressurePa, albedo: c.spec.albedo, noonK: airless ? noonK(insolationAt(s, i), c.spec.albedo, c.spec.emissivity) : null, gases };
  };

  /** The pole of a body's orbit about its primary (or, with none, the scenario's mean plane: the ecliptic's). */
  const poleOf = (s: LabSnapshot, i: number): number[] => {
    const p = primaryOf(s.gm, s.pos, i);
    if (p < 0) return [0, 0, 1];
    const r = [0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) - (s.pos[p * 3 + k] ?? 0));
    const v = [0, 1, 2].map((k) => (s.vel[i * 3 + k] ?? 0) - (s.vel[p * 3 + k] ?? 0));
    const n = [(r[1] ?? 0) * (v[2] ?? 0) - (r[2] ?? 0) * (v[1] ?? 0), (r[2] ?? 0) * (v[0] ?? 0) - (r[0] ?? 0) * (v[2] ?? 0), (r[0] ?? 0) * (v[1] ?? 0) - (r[1] ?? 0) * (v[0] ?? 0)];
    return Math.hypot(...n) > 0 ? n : [0, 0, 1];
  };

  /**
   * The autopilot's burn to make a ship's orbit round at its far side: the time to the apoapsis (from
   * the mean anomaly), the change of speed there, sqrt(mu / r_a) - sqrt(mu (2 / r_a - 1 / a)), and the
   * burn's length at full thrust from the propellant left after the burns already planned.
   */
  const circularisation = (s: LabSnapshot, id: string): { inS: number; deltaVMs: number; durationS: number; ref: string } | null => {
    const i = s.ids.indexOf(id);
    const x = s.ships.find((y) => y.id === id);
    const rel = i >= 0 ? relativeTo(s, i) : null;
    if (!x || !rel) return null;
    const el = elementsFromState(rel.r, rel.v, rel.mu);
    if (!el.bound || el.e < 1e-3 || !(el.a > 0)) return null;
    const e = el.e;
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(el.trueAnomaly / 2));
    const M = E - e * Math.sin(E);
    const n = Math.sqrt(rel.mu / el.a ** 3);
    const inS = ((((Math.PI - M) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / n;
    const ra = el.a * (1 + e);
    const deltaVMs = (Math.sqrt(rel.mu / ra) - Math.sqrt(rel.mu * (2 / ra - 1 / el.a))) * 1000;
    const left = { ...x, fuelKg: x.burns.reduce((f, b) => f - ((b.throttle * x.thrustN) / (x.ispS * G0)) * b.durationS, x.fuelKg) };
    return { inS, deltaVMs, durationS: burnDuration(left, deltaVMs), ref: s.ids[rel.p] ?? '' };
  };

  /**
   * The second autopilot's plan: a Hohmann transfer from the ship's orbit (round, with no burns
   * planned) to a round one `toKm` from its primary's centre, above the primary's surface; null when
   * it cannot be done (or the propellant left cannot give it).
   */
  const transferPlan = (s: LabSnapshot, id: string, toKm: number): (Transfer & { ref: string }) | null => {
    const i = s.ids.indexOf(id);
    const x = s.ships.find((y) => y.id === id);
    const rel = i >= 0 ? relativeTo(s, i) : null;
    if (!x || !rel || x.burns.length > 0 || !(toKm > (s.radius[rel.p] ?? 0))) return null;
    const el = elementsFromState(rel.r, rel.v, rel.mu);
    const r1 = norm3(rel.r);
    if (!el.bound || el.e >= ROUND_E || Math.abs(toKm - r1) < 1) return null;
    const plan = hohmann(x, rel.mu, r1, norm3(rel.v), toKm);
    return Number.isFinite(plan.d1S) && Number.isFinite(plan.d2S) ? { ...plan, ref: s.ids[rel.p] ?? '' } : null;
  };

  /** A ship's rocket as the view gives it (src/sim/ships): its burns to come, each one's change of speed by the rocket equation. */
  const shipOf = (s: LabSnapshot, id: string): UniverseLabBody['ship'] => {
    const x = s.ships.find((y) => y.id === id);
    if (!x) return null;
    const round = circularisation(s, id);
    let fuel = x.fuelKg;
    const burns = x.burns.map((b) => {
      const spent = Math.min(fuel, ((b.throttle * x.thrustN) / (x.ispS * G0)) * Math.max(0, b.durationS - Math.max(0, s.t - b.startT)));
      const before = x.dryKg + fuel;
      fuel -= spent;
      return { inS: b.startT - s.t, durationS: b.durationS, direction: b.direction, ref: b.ref, throttle: b.throttle, deltaVMs: x.ispS * G0 * Math.log(before / (x.dryKg + fuel)) };
    });
    return {
      dryKg: x.dryKg,
      fuelKg: x.fuelKg,
      thrustN: x.thrustN,
      ispS: x.ispS,
      deltaVLeftMs: deltaVLeft(x),
      burning: x.burns.some((b) => b.startT <= s.t + 1e-9) && x.fuelKg > 0,
      burns,
      circularise: round ? { inS: round.inS, deltaVMs: round.deltaVMs, possible: Number.isFinite(round.durationS) } : null,
    };
  };

  /** The snapshot as a small state for nbody's placement helpers (the primary at index 0). */
  const stateOf = (s: LabSnapshot, i: number): SimState => ({
    ids: [s.ids[i] ?? ''],
    names: [''],
    gm: [s.gm[i] ?? 0],
    radius: [s.radius[i] ?? 1],
    pos: [s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0],
    vel: [s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0],
    spin: [0, 0, 0],
    j2: [0],
    inertia: [0.4],
    fixed: [],
    t: s.t,
    step: s.step,
    internal: 0,
    passing: [],
    swarms: [],
    stars: {},
    climate: {},
    climateAt: 0,
    rubble: [],
    ships: {},
    origins: {},
  });

  /** Body i relative to its primary (scenario frame): the primary's index, position and velocity, and the pair's GM; null without one. */
  const relativeTo = (s: LabSnapshot, i: number): { p: number; r: Vec3; v: Vec3; mu: number } | null => {
    const p = primaryOf(s.gm, s.pos, i);
    if (p < 0) return null;
    const at = (a: Float64Array, k: number): Vec3 => [a[k * 3] ?? 0, a[k * 3 + 1] ?? 0, a[k * 3 + 2] ?? 0];
    return { p, r: sub3(at(s.pos, i), at(s.pos, p)), v: sub3(at(s.vel, i), at(s.vel, p)), mu: (s.gm[p] ?? 0) + (s.gm[i] ?? 0) };
  };
  /** Body i's place as drawn now (a copy). */
  const posNow = (s: LabSnapshot, i: number): Vec3 => [...place(s, i)] as Vec3;
  const spinOf = (s: LabSnapshot, i: number): Vec3 => [s.spin[i * 3] ?? 0, s.spin[i * 3 + 1] ?? 0, s.spin[i * 3 + 2] ?? 0];

  /** A new body's rotation from a preset's period: prograde (or backwards) about the pole of its orbit. */
  const presetSpin = (preset: Preset | null, orbitPole: readonly number[]): BodySpec['spin'] =>
    preset?.rotationH ? { periodS: Math.abs(preset.rotationH) * 3600, pole: scale3(unit3(orbitPole), preset.rotationH < 0 ? -1 : 1) } : undefined;

  /** The chosen body's velocity arrow: its tip (scenario frame), its length per km/s (s), and the velocity it shows (relative to the primary). */
  const arrow = (s: LabSnapshot, i: number, len: number, shown?: Vec3): { tip: Vec3; len: number; vel: Vec3 } | null => {
    const rel = relativeTo(s, i);
    const vel = shown ?? (rel ? rel.v : ([s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0] as Vec3));
    if (!(norm3(vel) > 0) || !(len > 0)) return null;
    return { tip: add3(posNow(s, i), scale3(vel, len)), len, vel };
  };

  /** Where the pointer meets the plane of the placing primary's orbit (through its centre): the offset from it (scenario frame, km), or null. */
  const placeOffset = (x: number, y: number): Vec3 | null => {
    const s = snap;
    const v = pointerView;
    const rel = lastRelative;
    if (!s || !v || !rel || !placing) return null;
    const p = s.ids.indexOf(placing.primary);
    if (p < 0) return null;
    const pole = poleOf(s, p);
    const n = toRender(pole[0] ?? 0, pole[1] ?? 0, pole[2] ?? 0, km());
    const c = posNow(s, p);
    const P = rel(toRender(c[0], c[1], c[2], km()), km());
    const d = v.ray(x, y);
    const denom = d.x * n.x + d.y * n.y + d.z * n.z;
    if (Math.abs(denom) < 1e-9) return null;
    const t = (P.x * n.x + P.y * n.y + P.z * n.z) / denom;
    if (!(t > 0)) return null;
    const off = fromRender(d.x * t - P.x, d.y * t - P.y, d.z * t - P.z);
    return norm3(off) > (s.radius[p] ?? 0) * 1.05 ? off : null;
  };

  /** Adds a body at an offset from the placing primary, on a circular orbit about it there (prograde, in the plane of the primary's own orbit). */
  const addPlaced = (off: Vec3): void => {
    const s = snap;
    const pl = placing;
    if (!s || !pl) return;
    const p = s.ids.indexOf(pl.primary);
    if (p < 0) return;
    const gm = pl.massKg * gPerKg;
    const pole = poleOf(s, p);
    const placed = circularOrbit(stateOf(s, p), 0, norm3(off), gm, pole, off);
    const id = freshId('body');
    edit({ kind: 'add', body: { id, name: pl.name.slice(0, 60) || id, gm, radiusKm: pl.radiusKm, pos: placed.pos as Vec3, vel: placed.vel as Vec3, origin: 'user-edited', sourceIds: [], ...(presetSpin(pl.preset, pole) ? { spin: presetSpin(pl.preset, pole) } : {}) } });
    selected = id;
    placing = null;
    hoverOffset = null;
    requestPrediction();
  };

  const refreshLibrary = (): void => {
    void idb<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).then(
      (keys) => {
        library = keys.map(String).filter((k) => k.startsWith(LIBRARY_PREFIX)).map((k) => k.slice(LIBRARY_PREFIX.length)).sort((a, b) => a.localeCompare(b));
      },
      () => {
        library = [];
      },
    );
  };

  /** The pair the turning frame turns with: the chosen body's primary, and the heaviest body that moves about it (the chosen one itself, when it is). */
  const corotatingPair = (s: LabSnapshot): { a: number; b: number } | null => {
    const i = selected ? s.ids.indexOf(selected) : -1;
    if (i < 0) return null;
    const a = primaryOf(s.gm, s.pos, i);
    if (a < 0) return null;
    let b = -1;
    for (let k = 0; k < s.ids.length; k += 1) if (k !== a && primaryOf(s.gm, s.pos, k) === a && (b < 0 || (s.gm[k] ?? 0) > (s.gm[b] ?? 0))) b = k;
    return b < 0 ? null : { a, b };
  };

  /**
   * A plume's points now (render frame, km), each with its strength: up from the crater (turning with its
   * world) and back down over a few seconds, fading (and fading away early if a newer one wanted its
   * place); at least DUST.minPx tall on screen, so a small crater's plume is seen (decorative).
   */
  const plumeAt = (s: LabSnapshot, plume: (typeof plumes)[number], wallNow: number, frame: LabFrame, relative: (abs: Km, out: Km) => Km, count: number, emit: (point: Km, strength: number) => void): void => {
    const p = s.ids.indexOf(plume.body);
    if (p < 0) return;
    const x = Math.min(1, (wallNow - plume.born) / 1000 / DUST.seconds);
    const early = plume.ending === null ? 1 : Math.max(0, 1 - (wallNow - plume.ending) / (FADE_S * 1000));
    const fade = DUST.opacity * (1 - x) ** 2 * Math.min(1, x * 8) * early;
    // The site's way up now: through the world's own frame where it is drawn turning, else as it struck.
    const mark = craterMarks.get(plume.key);
    const b = builtIn(plume.body);
    const basis = b ? basisNow.get(b) : undefined;
    const up: Vec3 = mark && basis ? unit3([0, 1, 2].map((r) => (basis[r] ?? 0) * mark.site[0] + (basis[3 + r] ?? 0) * mark.site[1] + (basis[6 + r] ?? 0) * mark.site[2])) : unit3([plume.site[0], plume.site[2], -plume.site[1]]);
    const helper: Vec3 = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t1 = unit3(cross3(up, helper));
    const t2 = cross3(up, t1);
    const centre = posNow(s, p);
    toRender(centre[0], centre[1], centre[2], plumeCentre);
    const radiusKm = s.radius[p] ?? 0;
    relative(plumeCentre, plumeRel);
    const distance = Math.hypot(plumeRel.x, plumeRel.y, plumeRel.z);
    const height = Math.max(plume.heightKm, (DUST.minPx * Math.max(distance - radiusKm, 0)) / Math.max(frame.pxPerTan, 1));
    const rise = 4 * x * (1 - x);
    for (let k = 0; k < count && k * 3 < plume.throws.length; k += 1) {
      const tilt = plume.throws[k * 3] ?? 0;
      const turn = plume.throws[k * 3 + 1] ?? 0;
      const reach = (plume.throws[k * 3 + 2] ?? 0) * height;
      const across = Math.sin(tilt);
      const along = Math.cos(tilt);
      // Each point thrown along its cone direction, its height rising and falling, its spread growing.
      const way = (c: number): number => (up[c] ?? 0) * along * rise + ((t1[c] ?? 0) * Math.cos(turn) + (t2[c] ?? 0) * Math.sin(turn)) * across * x * 1.5;
      plumePoint.x = plumeCentre.x + up[0] * radiusKm + way(0) * reach;
      plumePoint.y = plumeCentre.y + up[1] * radiusKm + way(1) * reach;
      plumePoint.z = plumeCentre.z + up[2] * radiusKm + way(2) * reach;
      emit(plumePoint, fade);
    }
  };

  /**
   * The effects' frame (./lab-fx): every body not one of the ten worlds (fading in as it comes, lingering
   * where it was as it fades out), every ring and belt, the plumes, the stars' light and the bodies that
   * may shade others, and the impacts since the last frame.
   */
  const drawEffects = (effects: LabFx, s: LabSnapshot, frame: LabFrame, relative: (abs: Km, out: Km) => Km, wallNow: number, dt: number): FxReport => {
    const tNow = clock.shown;
    presentIds.clear();
    fxBodies.length = 0;
    for (let k = 0; k < s.ids.length; k += 1) {
      const id = s.ids[k] ?? '';
      if (builtIn(id)) continue;
      presentIds.add(id);
      let f = bodyFades.get(id);
      if (!f) {
        f = { fade: 0, body: { id, pos: [0, 0, 0], radiusKm: 1, gm: 0, look: ROCK_LOOK, spin: [0, 0, 0], inertia: 0.4, luminosityW: null, heatK: 0, fade: 0, selected: false } };
        bodyFades.set(id, f);
      }
      const b = f.body;
      const heat = heats.get(id);
      b.pos = place(s, k);
      b.radiusKm = s.radius[k] ?? 1;
      b.gm = s.gm[k] ?? 0;
      b.look = s.looks[k] ?? lastLook.get(id) ?? ROCK_LOOK;
      b.spin = spinOf(s, k);
      b.inertia = s.inertia[k] ?? 0.4;
      b.luminosityW = s.light[id] ?? null;
      b.heatK = heat && tNow >= heat.t0 ? crustK(heat.meltK, tNow - heat.t0) : 0;
      f.fade = Math.min(1, f.fade + dt / FADE_S);
      b.fade = f.fade;
      b.selected = id === selected;
      fxBodies.push(b);
    }
    for (const [id, f] of bodyFades) {
      if (presentIds.has(id)) continue;
      f.fade = Math.max(0, f.fade - dt / FADE_S);
      if (f.fade <= 0) {
        bodyFades.delete(id);
        heats.delete(id);
        continue;
      }
      f.body.fade = f.fade;
      f.body.selected = false;
      fxBodies.push(f.body);
    }
    presentIds.clear();
    fxSwarms.length = 0;
    for (const w of s.swarms) {
      const p = s.ids.indexOf(w.primary);
      if (p < 0) continue;
      presentIds.add(w.id);
      let f = swarmFades.get(w.id);
      if (!f) {
        f = { fade: 0, swarm: { id: w.id, kind: w.kind, look: w.look, normal: w.normal, primaryPos: [0, 0, 0], primaryKm: 1, primaryGm: 0, rel: w.rel, snapT: s.t, seq: s.seq, fade: 0 } };
        swarmFades.set(w.id, f);
      }
      const sw = f.swarm;
      sw.kind = w.kind;
      sw.look = w.look;
      sw.normal = w.normal;
      sw.primaryPos = place(s, p);
      sw.primaryKm = s.radius[p] ?? 1;
      sw.primaryGm = s.gm[p] ?? 0;
      sw.rel = w.rel;
      sw.snapT = s.t;
      sw.seq = s.seq;
      f.fade = Math.min(1, f.fade + dt / FADE_S);
      sw.fade = f.fade;
      fxSwarms.push(sw);
    }
    for (const [id, f] of swarmFades) {
      if (presentIds.has(id)) continue;
      f.fade = Math.max(0, f.fade - dt / FADE_S);
      if (f.fade <= 0) swarmFades.delete(id);
      else {
        f.swarm.fade = f.fade;
        fxSwarms.push(f.swarm);
      }
    }
    // Plumes (decorative), in the scenario's frame.
    fxPlumes.length = 0;
    plumes.forEach((plume, k) => {
      let buffer = plumeBuffers[k];
      if (!buffer) {
        buffer = { points: new Float64Array(DUST.most * 3), strength: new Float32Array(DUST.most), count: 0, look: ROCK_LOOK };
        plumeBuffers[k] = buffer;
      }
      const into = buffer;
      into.count = 0;
      into.look = lastLook.get(plume.body) ?? ROCK_LOOK;
      plumeAt(s, plume, wallNow, frame, relative, effects.effects.plumePoints, (point, strength) => {
        // Render frame back to the scenario's: (x, -z, y).
        into.points[into.count * 3] = point.x;
        into.points[into.count * 3 + 1] = -point.z;
        into.points[into.count * 3 + 2] = point.y;
        into.strength[into.count] = strength;
        into.count += 1;
      });
      fxPlumes.push(into);
    });
    // The stars' light, and the largest bodies that may shade others (chosen once a snapshot).
    fxLights.length = 0;
    for (const [id, watts] of Object.entries(s.light)) {
      const j = s.ids.indexOf(id);
      if (j >= 0) fxLights.push({ id, pos: place(s, j), watts });
    }
    if (occluderSeq !== s.seq) {
      occluderSeq = s.seq;
      occluderIndex.length = 0;
      for (let k = 0; k < s.ids.length; k += 1) occluderIndex.push(k);
      occluderIndex.sort((a, b) => (s.radius[b] ?? 0) - (s.radius[a] ?? 0));
      occluderIndex.length = Math.min(occluderIndex.length, OCCLUDERS);
    }
    fxOccluders.length = 0;
    for (const k of occluderIndex) fxOccluders.push({ id: s.ids[k] ?? '', pos: place(s, k), radiusKm: s.radius[k] ?? 0 });
    const out = effects.frame({
      nowS: fxClock,
      dtS: dt,
      simT: tNow,
      reduced: reducedNow(),
      pxPerTan: frame.pxPerTan,
      far: frame.far,
      forward: frame.forward,
      widthPx: window.innerWidth,
      heightPx: window.innerHeight,
      compensation: frame.compensation,
      toView: (pos, into) => relative(toRender(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0, viewScratch), into),
      toScreen: (at) => pointerView?.toScreen(at) ?? null,
      bodies: fxBodies,
      swarms: fxSwarms,
      plumes: fxPlumes,
      lights: fxLights,
      occluders: fxOccluders,
      impacts,
      bodyAt: (id) => {
        const i = s.ids.indexOf(id);
        return i >= 0 ? place(s, i) : null;
      },
      siteAt: (key, struck, out) => {
        // On a world drawn turning: its crater's (or melted face's) place in the world's frame, turned as it is now; else as it struck.
        const mark = craterMarks.get(key);
        const heat = heatMarks.get(key);
        const local = mark?.site ?? heat?.local ?? null;
        const basis = local ? basisNow.get(mark?.body ?? heat?.body ?? 'earth') : undefined;
        if (local && basis) {
          const r: Vec3 = [0, 1, 2].map((c) => (basis[c] ?? 0) * local[0] + (basis[3 + c] ?? 0) * local[1] + (basis[6 + c] ?? 0) * local[2]) as Vec3;
          const v = fromRender(r[0], r[1], r[2]);
          for (let c = 0; c < 3; c += 1) out[c] = v[c] ?? 0;
          return;
        }
        for (let c = 0; c < 3; c += 1) out[c] = struck[c] ?? 0;
      },
    });
    impacts.length = 0;
    return out;
  };

  /**
   * The laboratory's names (W1.10), for the explorer's layout (its declutterLab: ranks, corners, the
   * worlds' names giving way): each body's but a gravitating ring's members; the pieces of one torn
   * body, or one breakup's, three or more of them, as one name at the largest ("Moon: 8 pieces"), the
   * chosen one named as well; none for a body behind another body nearer the camera (the worlds' own
   * discs the explorer checks). The explorer eases each in and out (as the worlds' names).
   */
  const buildLabels = (s: LabSnapshot, frame: LabFrame, relative: (abs: Km, out: Km) => Km): void => {
    labelList.length = 0;
    const n = s.ids.length;
    labelGeom.length = n * 5;
    for (let k = 0; k < n; k += 1) {
      const p = place(s, k);
      toRender(p[0], p[1], p[2], abs);
      relative(abs, rel);
      const d = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
      labelGeom[k * 5] = rel.x;
      labelGeom[k * 5 + 1] = rel.y;
      labelGeom[k * 5 + 2] = rel.z;
      labelGeom[k * 5 + 3] = d;
      labelGeom[k * 5 + 4] = Math.asin(Math.min(1, (s.radius[k] ?? 0) / d));
    }
    /** Body k hidden behind a nearer laboratory body, as seen from the camera. */
    const behind = (k: number): boolean => {
      const d = labelGeom[k * 5 + 3] ?? 0;
      for (let j = 0; j < n; j += 1) {
        const dj = labelGeom[j * 5 + 3] ?? 0;
        if (j === k || dj >= d || builtIn(s.ids[j] ?? '')) continue;
        const cos = ((labelGeom[k * 5] ?? 0) * (labelGeom[j * 5] ?? 0) + (labelGeom[k * 5 + 1] ?? 0) * (labelGeom[j * 5 + 1] ?? 0) + (labelGeom[k * 5 + 2] ?? 0) * (labelGeom[j * 5 + 2] ?? 0)) / (d * dj);
        if (Math.acos(Math.min(1, Math.max(-1, cos))) < (labelGeom[j * 5 + 4] ?? 0)) return true;
      }
      return false;
    };
    // Families: the bodies one event made, by its key.
    families.clear();
    for (let k = 0; k < n; k += 1) {
      const o = s.origin[k];
      if (!o || builtIn(s.ids[k] ?? '')) continue;
      let list = families.get(o.event);
      if (!list) {
        list = [];
        families.set(o.event, list);
      }
      list.push(k);
    }
    for (let k = 0; k < n; k += 1) {
      const id = s.ids[k] ?? '';
      if (builtIn(id) || (RING_MEMBER.test(id) && id !== selected)) continue;
      const o = s.origin[k];
      const family = o ? families.get(o.event) : undefined;
      const grouped = family !== undefined && family.length >= 3;
      // In a family of three or more: named once, at its largest (the chosen one named as well).
      const largest = grouped ? family.reduce((a, b) => ((s.radius[b] ?? 0) > (s.radius[a] ?? 0) ? b : a)) : k;
      if (grouped && largest !== k && id !== selected) continue;
      if (behind(k)) continue;
      toRender(...place(s, k), abs);
      relative(abs, rel);
      placeScaled(rel, s.radius[k] ?? 1, frame.far, scratch);
      const position: [number, number, number] = [scratch.x, scratch.y, scratch.z];
      const rank = id === selected ? Number.MAX_VALUE : (s.radius[k] ?? 0);
      if (grouped && largest === k && o) {
        const name = knownNames.get(o.parent) ?? o.parent;
        const text = fill(o.kind === 'piece' ? 'ui.universe.lab.family.pieces' : 'ui.universe.lab.family.debris', { name, count: String(family.length) });
        labelList.push({ id: `lab-family-${o.event}`, textKey: 'ui.universe.lab.body', text, position, opacity: 0.9, offset: [10, -10], rank: id === selected ? (s.radius[k] ?? 0) : rank });
        if (id !== selected) continue;
      }
      labelList.push({ id: `lab-${id}`, textKey: 'ui.universe.lab.body', text: s.names[k] ?? id, position: [...position], opacity: 0.9, offset: [10, -10], rank });
    }
    edgePointer(s, frame, relative);
  };

  /**
   * The chosen body off the view (beyond its edge, or behind the camera): its name at the clear view's
   * edge, on the line from the view's middle toward it, with an arrow that way (W1.10; the explorer's
   * worlds have the same). Only the chosen body has one.
   */
  const edgePointer = (s: LabSnapshot, frame: LabFrame, relative: (abs: Km, out: Km) => Km): void => {
    const k = selected ? s.ids.indexOf(selected) : -1;
    const v = pointerView;
    if (k < 0 || !v || builtIn(s.ids[k] ?? '')) return;
    const p = place(s, k);
    relative(toRender(p[0], p[1], p[2], abs), rel);
    const f = v.forward();
    const ahead = rel.x * f.x + rel.y * f.y + rel.z * f.z;
    const d = Math.hypot(rel.x, rel.y, rel.z);
    // Behind the camera: its mirror in the screen's plane lies the same way across the screen.
    const back = ahead <= 0.05 * d ? 2 * ahead - 0.1 * d : 0;
    edgeAt.x = rel.x - back * f.x;
    edgeAt.y = rel.y - back * f.y;
    edgeAt.z = rel.z - back * f.z;
    const at = v.toScreen(edgeAt);
    if (!at) return;
    const box = v.insets();
    const left = box.left + EDGE_PX;
    const right = window.innerWidth - box.right - EDGE_PX;
    const top = box.top + EDGE_PX;
    const bottom = window.innerHeight - box.bottom - EDGE_PX;
    if (back === 0 && at.x >= left && at.x <= right && at.y >= top && at.y <= bottom) return;
    if (!(right > left && bottom > top)) return;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const dx = at.x - cx;
    const dy = at.y - cy;
    const t = Math.min(Math.abs(dx) > 1e-9 ? (dx > 0 ? right - cx : left - cx) / dx : Number.POSITIVE_INFINITY, Math.abs(dy) > 1e-9 ? (dy > 0 ? bottom - cy : top - cy) / dy : Number.POSITIVE_INFINITY);
    if (!Number.isFinite(t)) return;
    const ray = v.ray(cx + dx * t, cy + dy * t);
    const r = Math.min(d, frame.far * 0.25);
    const arrow = EDGE_ARROWS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8] ?? '';
    labelList.push({ id: `lab-edge-${selected ?? ''}`, textKey: 'ui.universe.lab.body', text: fill('ui.universe.lab.offView', { name: s.names[k] ?? selected ?? '', arrow }), position: [ray.x * r, ray.y * r, ray.z * r], opacity: 0.9, offset: [10, -10], rank: Number.MAX_VALUE });
  };

  /**
   * A command and its answer (W1.1): an edit's, once the worker has it (applied with the bodies it made,
   * or refused with the reason); anything else done at once, or refused with why. Before the run's first
   * snapshot a command that needs it waits for it.
   */
  const answerFor = (c: LabCommand): Promise<LabEditResult> => {
    if (NEEDS_RUN.has(c.kind) && (!snap || snap.generation !== generation || !active)) {
      if (!active) return no('the laboratory is not open');
      return new Promise((resolve) => {
        queued.push({ c, resolve });
      });
    }
    const id = 'id' in c && typeof c.id === 'string' && NAMES_BODY.has(c.kind) ? c.id : null;
    if (id !== null && snap && !snap.ids.includes(id)) return no('names a body that does not exist');
    lastAnswer = null;
    why = null;
    runCommand(c);
    const answer = lastAnswer as Promise<LabEditResult> | null;
    lastAnswer = null;
    if (answer) return answer;
    const reason = why as string | null;
    if (reason !== null) return no(reason);
    return EDITS.has(c.kind) ? no(`${c.kind}: not possible as asked`) : DONE;
  };

  /** A command's work (see answerFor for its answer): an edit's answer is the one edit() made last. */
  const runCommand = (c: LabCommand): void => {
    const s = snap;
    switch (c.kind) {
      case 'start':
        // The solar system forks at the explorer's date again (not the last experiment's epoch), paused as it was.
        lab.start(c.seed, forkJdTdb);
        return;
      case 'select':
        selected = c.id;
        prediction = null;
        requestPrediction();
        return;
      case 'slow':
        // The visitor's setting (kept in this browser), or the slowing under way called off.
        if (c.on !== undefined) {
          slowOn = c.on;
          try {
            localStorage.setItem(SLOW.storage, c.on ? '1' : '0');
          } catch {
            // Not kept (no storage): it holds for this visit.
          }
        }
        if (c.cancel || c.on === false) {
          ownRate();
          if (!paused) sendRun();
        }
        return;
      case 'aim': {
        // Worked out in the worker from the run as it stands (src/sim/aim), not yet made: the preview.
        const t = s ? s.ids.indexOf(c.target) : -1;
        if (!s || t < 0) {
          why = 'names a body that does not exist';
          return;
        }
        if (!(Number.isFinite(c.vInfKmS) && c.vInfKmS >= 0 && c.vInfKmS <= 100) || !(Number.isFinite(c.angleDeg) && c.angleDeg >= 5 && c.angleDeg <= 90) || !(Number.isFinite(c.leadS) && c.leadS >= 60 && c.leadS <= 100 * 86_400)) {
          why = 'speed (0 to 100 km/s), angle (5 to 90 degrees) or time to contact (a minute to a hundred days) out of range';
          return;
        }
        const kind = IMPACTORS[c.impactor];
        const preset = 'preset' in kind ? palette.find((x) => x.id === kind.preset) : undefined;
        const radiusKm = 'preset' in kind ? (preset?.radiusKm ?? 0) : kind.radiusKm;
        const gm = 'preset' in kind ? (preset?.gm ?? 0) : (4 / 3) * Math.PI * (kind.radiusKm * 1000) ** 3 * kind.densityKgM3 * gPerKg;
        if (!(radiusKm > 0) || !(gm > 0)) {
          why = 'no such impactor';
          return;
        }
        // Where it strikes: the face toward the camera, leaning to the lit side; it comes in from the camera's left.
        const at = posNow(s, t);
        const f = pointerView?.forward() ?? { x: 0, y: 0, z: -1 };
        const toCamera = fromRender(-f.x, -f.y, -f.z);
        const star = Object.keys(s.light).map((id) => s.ids.indexOf(id)).find((j) => j >= 0 && j !== t);
        const toStar = star !== undefined ? unit3(sub3(posNow(s, star), at)) : toCamera;
        const given = c.site && c.site.every(Number.isFinite) && norm3(c.site) > 0 ? unit3(c.site) : null;
        const site = given ?? unit3(add3(scale3(unit3(toCamera), 0.75), scale3(toStar, 0.45)), toCamera);
        const right = c.heading && c.heading.every(Number.isFinite) && norm3(c.heading) > 0 ? c.heading : fromRender(-f.z, 0, f.x);
        aimRequest += 1;
        const id = freshId('rock');
        const name = fill(`ui.universe.lab.throw.name.${c.impactor}`, {});
        aim = { status: 'working', target: c.target, impactor: c.impactor, vInfKmS: c.vInfKmS, angleDeg: c.angleDeg, leadS: c.leadS, contact: null, reason: null, missKm: null, id: null, plan: null, requestId: aimRequest, spec: { id, name, gm, radiusKm }, logLength: s.logLength };
        send({ type: 'aim', generation, requestId: aimRequest, request: { id, name, target: c.target, gm, radiusKm, vInfKmS: c.vInfKmS, angleDeg: c.angleDeg, leadS: c.leadS, site, heading: unit3(right, [1, 0, 0]) } });
        return;
      }
      case 'throw': {
        const a = aim;
        if (!a || a.status !== 'ready' || !a.plan || !s) {
          why = 'nothing aimed to throw';
          return;
        }
        // Made exactly as worked out: at the step it was aimed from (the run goes back there if it has moved on),
        // or refused (an edit made since, at a later step: the worker cannot put the run back there with it).
        if (s.logLength !== a.logLength || s.step < a.plan.step) {
          a.status = 'refused';
          a.reason = 'stale';
          why = STALE;
          return;
        }
        edit({ kind: 'add', body: { id: a.spec.id, name: a.spec.name, gm: a.spec.gm, radiusKm: a.spec.radiusKm, pos: a.plan.pos, vel: a.plan.vel, origin: 'user-edited', sourceIds: [] } }, a.plan.step, true);
        a.status = 'thrown';
        a.id = a.spec.id;
        selected = a.spec.id;
        requestPrediction();
        void lastAnswer?.then((r) => {
          if (r.ok || aim !== a) return;
          a.status = 'refused';
          a.reason = r.reason === STALE ? 'stale' : r.reason;
          a.id = null;
        });
        return;
      }
      case 'aimClear':
        aim = null;
        return;
      case 'mass': {
        if (!(Number.isFinite(c.massKg) && c.massKg >= 0)) return;
        const gm = c.massKg * gPerKg;
        const i = s ? s.ids.indexOf(c.id) : -1;
        // The density held: the radius follows the mass (as its cube root).
        if (s && c.keep === 'density' && i >= 0 && (s.gm[i] ?? 0) > 0 && gm > 0) {
          edit({ kind: 'setRadius', id: c.id, radiusKm: (s.radius[i] ?? 1) * Math.cbrt(gm / (s.gm[i] ?? 1)), gm });
          return;
        }
        edit({ kind: 'setMass', id: c.id, gm });
        return;
      }
      case 'radius': {
        const i = s ? s.ids.indexOf(c.id) : -1;
        if (!s || i < 0 || !(Number.isFinite(c.radiusKm) && c.radiusKm > 0)) return;
        const r0 = s.radius[i] ?? c.radiusKm;
        edit(c.keep === 'density' ? { kind: 'setRadius', id: c.id, radiusKm: c.radiusKm, gm: (s.gm[i] ?? 0) * (c.radiusKm / r0) ** 3 } : { kind: 'setRadius', id: c.id, radiusKm: c.radiusKm });
        return;
      }
      case 'density': {
        const i = s ? s.ids.indexOf(c.id) : -1;
        if (!s || i < 0 || !(Number.isFinite(c.densityKgM3) && c.densityKgM3 > 0)) return;
        const g = s.gm[i] ?? 0;
        const r = s.radius[i] ?? 1;
        if (c.keep === 'mass') {
          if (!(g > 0)) return;
          edit({ kind: 'setRadius', id: c.id, radiusKm: Math.cbrt((3 * (g / gPerKg)) / (4 * Math.PI * c.densityKgM3)) / 1000 });
        } else {
          edit({ kind: 'setMass', id: c.id, gm: c.densityKgM3 * (4 / 3) * Math.PI * (r * 1000) ** 3 * gPerKg });
        }
        return;
      }
      case 'spin': {
        const i = s ? s.ids.indexOf(c.id) : -1;
        if (!s || i < 0 || !(Number.isFinite(c.periodS) && c.periodS > 0) || !Number.isFinite(c.tiltDeg)) return;
        // Tilted from its orbit's pole (the frame's with no primary) by tiltDeg, toward where its pole leans now.
        const rel = relativeTo(s, i);
        const orbitPole = rel ? unit3(cross3(rel.r, rel.v)) : ([0, 0, 1] as Vec3);
        const now = unit3(spinOf(s, i), orbitPole);
        let lean = sub3(now, scale3(orbitPole, dot3(now, orbitPole)));
        if (norm3(lean) < 1e-9) lean = rel ? sub3(rel.r, scale3(orbitPole, dot3(rel.r, orbitPole))) : [1, 0, 0];
        lean = unit3(lean, [1, 0, 0]);
        const t = c.tiltDeg * DEG;
        edit({ kind: 'setSpin', id: c.id, periodS: c.periodS, pole: add3(scale3(orbitPole, Math.cos(t)), scale3(lean, Math.sin(t))) });
        return;
      }
      case 'fixed':
        edit({ kind: 'setFixed', id: c.id, fixed: c.fixed });
        return;
      case 'rename': {
        const name = c.name.trim().slice(0, 60);
        if (name) edit({ kind: 'rename', id: c.id, name });
        return;
      }
      case 'impulse': {
        const i = s ? s.ids.indexOf(c.id) : -1;
        if (!s || i < 0 || ![c.progradeMs, c.normalMs, c.radialMs].every(Number.isFinite)) return;
        const rel = relativeTo(s, i);
        const v: Vec3 = [s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0];
        const f = rel ? orbitalFrame(rel.r, rel.v) : orbitalFrame([s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0], v);
        const dv = add3(add3(scale3(f.prograde, c.progradeMs / 1000), scale3(f.normal, c.normalMs / 1000)), scale3(f.radial, c.radialMs / 1000));
        edit({ kind: 'setVelocity', id: c.id, vel: add3(v, dv) });
        return;
      }
      case 'elements': {
        const i = s ? s.ids.indexOf(c.id) : -1;
        const rel = s && i >= 0 ? relativeTo(s, i) : null;
        if (!s || !rel || ![c.aKm, c.e, c.iDeg, c.nodeDeg, c.periapsisArgDeg, c.trueAnomalyDeg].every(Number.isFinite)) return;
        // An ellipse needs a > 0 and e < 1, a hyperbola a < 0 and e > 1; never e = 1 exactly.
        if (c.e < 0 || Math.abs(c.e - 1) < 1e-9 || (c.e < 1 && !(c.aKm > 0)) || (c.e > 1 && !(c.aKm < 0))) return;
        const st = stateFromElements({ a: c.aKm, e: c.e, i: c.iDeg * DEG, node: c.nodeDeg * DEG, periapsisArg: c.periapsisArgDeg * DEG, trueAnomaly: c.trueAnomalyDeg * DEG }, rel.mu);
        if (![...st.r, ...st.v].every(Number.isFinite) || norm3(st.r) <= (s.radius[rel.p] ?? 0)) return;
        const pp: Vec3 = [s.pos[rel.p * 3] ?? 0, s.pos[rel.p * 3 + 1] ?? 0, s.pos[rel.p * 3 + 2] ?? 0];
        const pv: Vec3 = [s.vel[rel.p * 3] ?? 0, s.vel[rel.p * 3 + 1] ?? 0, s.vel[rel.p * 3 + 2] ?? 0];
        edit({ kind: 'setState', id: c.id, pos: add3(pp, st.r), vel: add3(pv, st.v) });
        return;
      }
      case 'addPreset': {
        const preset = palette.find((x) => x.id === c.preset);
        if (!s || !preset) return;
        const p = s.ids.indexOf(c.primary);
        if (p < 0 || !(c.distanceKm > (s.radius[p] ?? 0) + preset.radiusKm)) return;
        const pole = poleOf(s, p);
        const pp = primaryOf(s.gm, s.pos, p);
        const along = pp >= 0 ? [0, 1, 2].map((k) => (s.pos[p * 3 + k] ?? 0) - (s.pos[pp * 3 + k] ?? 0)) : [1, 0, 0];
        const placed = circularOrbit(stateOf(s, p), 0, c.distanceKm, preset.gm, pole, along);
        const id = freshId('body');
        const spin = presetSpin(preset, pole);
        edit({ kind: 'add', body: { id, name: c.name.slice(0, 60) || id, gm: preset.gm, radiusKm: preset.radiusKm, pos: placed.pos as Vec3, vel: placed.vel as Vec3, origin: 'user-edited', sourceIds: [], ...(spin ? { spin } : {}) } });
        selected = id;
        requestPrediction();
        return;
      }
      case 'addLagrange': {
        const i = s && selected ? s.ids.indexOf(selected) : -1;
        const rel = s && i >= 0 ? relativeTo(s, i) : null;
        if (!s || !rel || !(c.massKg >= 0) || !(c.radiusKm > 0)) return;
        const p = rel.p;
        const at = (a: Float64Array, k: number): Vec3 => [a[k * 3] ?? 0, a[k * 3 + 1] ?? 0, a[k * 3 + 2] ?? 0];
        const L = lagrangePoints({ gm: s.gm[p] ?? 0, pos: at(s.pos, p), vel: at(s.vel, p) }, { gm: s.gm[i] ?? 0, pos: at(s.pos, i), vel: at(s.vel, i) })[c.point];
        // Turning with the pair: the barycentre's velocity plus the pair's angular velocity crossed with the offset from it.
        const total = (s.gm[p] ?? 0) + (s.gm[i] ?? 0);
        const bary = scale3(add3(scale3(at(s.pos, p), s.gm[p] ?? 0), scale3(at(s.pos, i), s.gm[i] ?? 0)), 1 / total);
        const baryV = scale3(add3(scale3(at(s.vel, p), s.gm[p] ?? 0), scale3(at(s.vel, i), s.gm[i] ?? 0)), 1 / total);
        const w = scale3(cross3(rel.r, rel.v), 1 / dot3(rel.r, rel.r));
        const id = freshId('body');
        edit({ kind: 'add', body: { id, name: c.name.slice(0, 60) || id, gm: c.massKg * gPerKg, radiusKm: c.radiusKm, pos: L, vel: add3(baryV, cross3(w, sub3(L, bary))), origin: 'user-edited', sourceIds: [] } });
        selected = id;
        requestPrediction();
        return;
      }
      case 'place': {
        if (!c.on || !s || !c.primary || !s.ids.includes(c.primary)) {
          placing = null;
          hoverOffset = null;
          return;
        }
        const preset = c.preset ? (palette.find((x) => x.id === c.preset) ?? null) : null;
        const massKg = preset ? preset.gm / gPerKg : (c.massKg ?? 0);
        const radiusKm = preset ? preset.radiusKm : (c.radiusKm ?? 0);
        if (!(massKg >= 0) || !(radiusKm > 0)) return;
        placing = { primary: c.primary, name: c.name ?? '', massKg, radiusKm, preset };
        hoverOffset = null;
        return;
      }
      case 'undo':
      case 'redo':
        sentEdits += 1;
        send({ type: c.kind, generation });
        trails.clear();
        return;
      case 'accuracy':
        accuracy = c.level;
        requestPrediction();
        return;
      case 'view':
        viewMode = c.view;
        return;
      case 'lagrange':
        showLagrange = c.on;
        return;
      case 'measure':
        measureAsk = c.from && c.to && c.from !== c.to ? { from: c.from, to: c.to, via: c.via && c.via !== c.from && c.via !== c.to ? c.via : null } : null;
        return;
      case 'track':
        tracked = c.id ? { id: c.id, quantity: c.quantity, points: [], mergedInto: null, lastT: Number.NEGATIVE_INFINITY } : null;
        if (snap) sampleTracked(snap);
        return;
      case 'saveAs': {
        const name = c.name.trim().replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);
        if (!name) return;
        void saved().then((scenario) =>
          idb('readwrite', (store) => store.put(JSON.stringify({ ...scenario, name: name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-') || scenario.name }), LIBRARY_PREFIX + name)).then(
            () => {
              status = { kind: 'saved', detail: [name] };
              refreshLibrary();
            },
            (err: unknown) => {
              status = { kind: 'error', detail: [String(err)] };
            },
          ),
        );
        return;
      }
      case 'loadSaved':
        void idb<unknown>('readonly', (store) => store.get(LIBRARY_PREFIX + c.name)).then(
          (text) => {
            if (typeof text === 'string') void lab.command({ kind: 'import', text });
            else status = { kind: 'error', detail: ['nothing saved by that name'] };
          },
          (err: unknown) => {
            status = { kind: 'error', detail: [String(err)] };
          },
        );
        return;
      case 'deleteSaved':
        void idb('readwrite', (store) => store.delete(LIBRARY_PREFIX + c.name)).then(
          () => {
            status = { kind: 'deleted', detail: [c.name] };
            refreshLibrary();
          },
          (err: unknown) => {
            status = { kind: 'error', detail: [String(err)] };
          },
        );
        return;
      case 'share':
        void saved()
          .then((scenario) => encodeScenario(scenario))
          .then(
            (data) => {
              share = data.length <= SHARE_MAX_CHARS ? { url: `${location.origin}${location.pathname}#/universe/lab?s=${data}` } : { tooLarge: true, chars: data.length };
              status = { kind: 'shared', detail: [] };
            },
            (err: unknown) => {
              status = { kind: 'error', detail: [String(err)] };
            },
          );
        return;
      case 'copy':
        // As a share link's data, but nothing is shown and the status line is left as it was.
        void saved()
          .then((scenario) => encodeScenario(scenario))
          .then(
            (data) => {
              copy = { data };
            },
            (err: unknown) => {
              copy = { error: String(err) };
            },
          );
        return;
      case 'importShared':
        void decodeScenario(c.data).then((raw) => {
          if (raw === null) {
            status = { kind: 'error', detail: ['the link’s scenario could not be read'] };
            return;
          }
          void lab.command({ kind: 'import', text: JSON.stringify(raw) });
        });
        return;
      case 'removeMany':
        for (const id of c.ids) void lab.command({ kind: 'remove', id });
        return;
      case 'addSwarm':
      case 'addRing': {
        if (!s) return;
        const p = s.ids.indexOf(c.primary);
        if (p < 0 || !(s.gm[p] ?? 0) || ![c.innerKm, c.outerKm, c.count].every(Number.isFinite) || !(c.innerKm > (s.radius[p] ?? 0)) || !(c.outerKm >= c.innerKm) || !(c.count >= 1)) return;
        // Its plane: the primary's equator (its spin's pole) or its orbit's; the ecliptic where it has neither.
        const spin = spinOf(s, p);
        const pole = c.plane === 'equator' && norm3(spin) > 0 ? unit3(spin) : unit3(poleOf(s, p));
        const normal: [number, number, number] = [pole[0], pole[1], pole[2]];
        // A seed from the moment and the count so far: the same edit replays the same particles.
        const seed = (Math.imul(s.step + 1, 2654435761) + (s.swarms.length + s.ids.length) * 97) >>> 0;
        const name = c.name.slice(0, 60);
        if (c.kind === 'addSwarm') {
          const used = new Set(s.swarms.map((w) => w.id));
          let n = 1;
          while (used.has(`swarm-${n}`)) n += 1;
          edit({ kind: 'addSwarm', swarm: { id: `swarm-${n}`, name, primary: c.primary, count: Math.min(Math.round(c.count), SWARM_LIMITS.perSwarm), innerKm: c.innerKm, outerKm: c.outerKm, eccentricity: Math.min(Math.max(c.eccentricity, 0), 0.95), inclinationDeg: Math.min(Math.max(c.inclinationDeg, 0), 180), normal, seed } });
        } else {
          if (!(c.massKg > 0)) return;
          const base = freshId('moonlets');
          const count = Math.min(Math.round(c.count), RING_MAX_BODIES);
          // Each body as dense as icy rock (1,500 kg/m^3: illustrative), from its share of the mass.
          const radiusKm = Math.cbrt((3 * (c.massKg / count)) / (4 * Math.PI * 1500)) / 1000;
          knownNames.set(base, name);
          edit({ kind: 'addRing', ring: { id: base, name, primary: c.primary, count, innerKm: c.innerKm, outerKm: c.outerKm, gm: c.massKg * gPerKg, radiusKm, normal, seed } });
        }
        requestPrediction();
        return;
      }
      case 'removeSwarm':
        if (s?.swarms.some((w) => w.id === c.id)) edit({ kind: 'removeSwarm', id: c.id });
        return;
      case 'climateView':
        climateView = c.on;
        return;
      case 'atmosphere': {
        if (!s?.climate.some((x) => x.id === c.id)) return;
        const tau = c.tau !== undefined && Number.isFinite(c.tau) ? Math.min(Math.max(c.tau, 0), 1e4) : undefined;
        const forcing = c.forcingWm2 !== undefined && Number.isFinite(c.forcingWm2) ? Math.min(Math.max(c.forcingWm2, -100), 100) : undefined;
        const pressurePa = c.pressurePa !== undefined && Number.isFinite(c.pressurePa) ? Math.min(Math.max(c.pressurePa, 0), 1e9) : undefined;
        edit({ kind: 'setAtmosphere', id: c.id, ...(tau !== undefined ? { tau } : {}), ...(forcing !== undefined ? { forcing } : {}), ...(pressurePa !== undefined ? { pressurePa } : {}) });
        return;
      }
      case 'duplicateMany':
        for (const id of c.ids) void lab.command({ kind: 'duplicate', id });
        return;
      case 'velocity': {
        if (!s) return;
        const i = s.ids.indexOf(c.id);
        if (i < 0 || !c.relativeKmS.every(Number.isFinite)) return;
        const p = primaryOf(s.gm, s.pos, i);
        const base = [0, 1, 2].map((k) => (p >= 0 ? (s.vel[p * 3 + k] ?? 0) : 0));
        edit({ kind: 'setVelocity', id: c.id, vel: [(base[0] ?? 0) + c.relativeKmS[0], (base[1] ?? 0) + c.relativeKmS[1], (base[2] ?? 0) + c.relativeKmS[2]] });
        return;
      }
      case 'addShip': {
        if (!s) return;
        const p = s.ids.indexOf(c.primary);
        const ok = [c.dryKg, c.fuelKg, c.thrustN, c.ispS].every((x) => Number.isFinite(x) && x >= 0) && c.dryKg >= 1 && c.thrustN > 0 && c.ispS >= 1;
        if (p < 0 || !(c.distanceKm > (s.radius[p] ?? 0)) || !ok) return;
        // A test particle with a rocket, on a circular orbit in the plane of the body's own orbit.
        const pole = poleOf(s, p);
        const pp = primaryOf(s.gm, s.pos, p);
        const along = pp >= 0 ? [0, 1, 2].map((k) => (s.pos[p * 3 + k] ?? 0) - (s.pos[pp * 3 + k] ?? 0)) : [1, 0, 0];
        const placed = circularOrbit(stateOf(s, p), 0, c.distanceKm, 0, pole, along);
        const id = freshId('ship');
        const body: BodySpec = {
          id,
          name: c.name.slice(0, 60) || id,
          gm: 0,
          radiusKm: SHIP_RADIUS_KM,
          pos: placed.pos as [number, number, number],
          vel: placed.vel as [number, number, number],
          origin: 'user-edited',
          sourceIds: [],
          ship: { dryKg: c.dryKg, fuelKg: c.fuelKg, thrustN: c.thrustN, ispS: c.ispS },
        };
        edit({ kind: 'add', body });
        selected = id;
        requestPrediction();
        return;
      }
      case 'burn': {
        const ship = s?.ships.find((x) => x.id === c.id);
        if (!s || !ship || !(c.deltaVMs > 0) || !(c.inS >= 0) || !(c.throttle > 0 && c.throttle <= 1) || !s.ids.includes(c.ref)) return;
        // From the propellant left after the burns already planned: the time this burn takes at its throttle.
        const left = { ...ship, fuelKg: ship.burns.reduce((f, b) => f - ((b.throttle * ship.thrustN) / (ship.ispS * G0)) * b.durationS, ship.fuelKg) };
        const durationS = burnDuration(left, c.deltaVMs, c.throttle);
        if (!Number.isFinite(durationS) || durationS <= 0) return;
        edit({ kind: 'burn', id: c.id, burn: { startT: s.t + c.inS, durationS, direction: c.direction, ref: c.ref, throttle: c.throttle } });
        requestPrediction();
        return;
      }
      case 'circularise': {
        const round = s ? circularisation(s, c.id) : null;
        // Refused without the propellant for it: the autopilot can fail, and says so in the panel beforehand.
        if (!s || !round || !Number.isFinite(round.durationS) || round.durationS <= 0) return;
        // Centred on the far side: half the burn before it, half after.
        edit({ kind: 'burn', id: c.id, burn: { startT: s.t + Math.max(0, round.inS - round.durationS / 2), durationS: round.durationS, direction: 'prograde', ref: round.ref, throttle: 1 } });
        requestPrediction();
        return;
      }
      case 'transfer': {
        const plan = s ? transferPlan(s, c.id, c.toKm) : null;
        if (!s || !plan) return;
        // Two burns along the motion (backwards to fall): the first now, the second centred on the transfer orbit's far side.
        edit({ kind: 'burn', id: c.id, burn: { startT: s.t, durationS: plan.d1S, direction: plan.dv1Ms >= 0 ? 'prograde' : 'retrograde', ref: plan.ref, throttle: 1 } });
        edit({ kind: 'burn', id: c.id, burn: { startT: s.t + plan.d1S / 2 + plan.coastS - plan.d2S / 2, durationS: plan.d2S, direction: plan.dv2Ms >= 0 ? 'prograde' : 'retrograde', ref: plan.ref, throttle: 1 } });
        requestPrediction();
        return;
      }
      case 'cancelBurns':
        if (!s?.ships.some((x) => x.id === c.id)) return;
        edit({ kind: 'cancelBurns', id: c.id });
        requestPrediction();
        return;
      case 'addOrbit': {
        if (!s) return;
        const p = s.ids.indexOf(c.primary);
        if (p < 0 || !(c.distanceKm > (s.radius[p] ?? 0)) || !(c.massKg >= 0) || !(c.radiusKm > 0)) return;
        const gm = c.massKg * gPerKg;
        // In the plane of the primary's own orbit, starting on its far side from its own primary.
        const pole = poleOf(s, p);
        const pp = primaryOf(s.gm, s.pos, p);
        const along = pp >= 0 ? [0, 1, 2].map((k) => (s.pos[p * 3 + k] ?? 0) - (s.pos[pp * 3 + k] ?? 0)) : [1, 0, 0];
        const placed = circularOrbit(stateOf(s, p), 0, c.distanceKm, gm, pole, along);
        const id = freshId('body');
        const body: BodySpec = { id, name: c.name.slice(0, 60) || id, gm, radiusKm: c.radiusKm, pos: placed.pos as [number, number, number], vel: placed.vel as [number, number, number], origin: 'user-edited', sourceIds: [] };
        edit({ kind: 'add', body });
        selected = id;
        requestPrediction();
        return;
      }
      case 'addState': {
        if (!s) return;
        const p = s.ids.indexOf(c.relativeTo);
        if (p < 0 || ![...c.posKm, ...c.velKmS].every(Number.isFinite) || !(c.massKg >= 0) || !(c.radiusKm > 0)) return;
        const id = freshId('body');
        const pos = [0, 1, 2].map((k) => (s.pos[p * 3 + k] ?? 0) + (c.posKm[k] ?? 0)) as [number, number, number];
        const vel = [0, 1, 2].map((k) => (s.vel[p * 3 + k] ?? 0) + (c.velKmS[k] ?? 0)) as [number, number, number];
        edit({ kind: 'add', body: { id, name: c.name.slice(0, 60) || id, gm: c.massKg * gPerKg, radiusKm: c.radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] } });
        selected = id;
        requestPrediction();
        return;
      }
      case 'duplicate': {
        if (!s) return;
        const i = s.ids.indexOf(c.id);
        if (i < 0) return;
        // The copy sixty degrees ahead on the same orbit about the primary (or ten radii away, with none), so it starts apart.
        const p = primaryOf(s.gm, s.pos, i);
        const id = freshId(builtIn(c.id) ?? 'body');
        const pos = [0, 1, 2].map((k) => s.pos[i * 3 + k] ?? 0);
        const vel = [0, 1, 2].map((k) => s.vel[i * 3 + k] ?? 0);
        if (p >= 0) {
          // Turned about the pole of its orbit (Rodrigues) to the first of these places clear of every body
          // (a second copy must not land on the first): 60 degrees ahead, then behind, then further round.
          const r = [0, 1, 2].map((k) => (pos[k] ?? 0) - (s.pos[p * 3 + k] ?? 0));
          const v = [0, 1, 2].map((k) => (vel[k] ?? 0) - (s.vel[p * 3 + k] ?? 0));
          const u = unit3(poleOf(s, i));
          const clear = (at: readonly number[]): boolean => {
            for (let j = 0; j < s.ids.length; j += 1) {
              const d = Math.hypot((at[0] ?? 0) - (s.pos[j * 3] ?? 0), (at[1] ?? 0) - (s.pos[j * 3 + 1] ?? 0), (at[2] ?? 0) - (s.pos[j * 3 + 2] ?? 0));
              if (d < 3 * ((s.radius[j] ?? 0) + (s.radius[i] ?? 0))) return false;
            }
            return true;
          };
          const angles = [60, -60, 120, -120, 180, 30, -30, 90, -90, 150, -150].map((a) => a * DEG);
          const turn = angles.find((a) => clear(add3([s.pos[p * 3] ?? 0, s.pos[p * 3 + 1] ?? 0, s.pos[p * 3 + 2] ?? 0], rotate3(r, u, a)))) ?? 60 * DEG;
          const r2 = rotate3(r, u, turn);
          const v2 = rotate3(v, u, turn);
          for (let k = 0; k < 3; k += 1) {
            pos[k] = (s.pos[p * 3 + k] ?? 0) + (r2[k] ?? 0);
            vel[k] = (s.vel[p * 3 + k] ?? 0) + (v2[k] ?? 0);
          }
        } else {
          pos[0] = (pos[0] ?? 0) + 10 * (s.radius[i] ?? 1);
        }
        edit({ kind: 'add', body: { id, name: `${s.names[i] ?? id} (copy)`.slice(0, 60), gm: s.gm[i] ?? 0, radiusKm: s.radius[i] ?? 1, pos: pos as [number, number, number], vel: vel as [number, number, number], origin: 'user-edited', sourceIds: [] } });
        selected = id;
        requestPrediction();
        return;
      }
      case 'remove':
        if (seedScenario?.persistentIds?.includes(c.id)) return;
        edit({ kind: 'remove', id: c.id });
        if (selected === c.id) selected = null;
        if (builtIn(c.id)) refocus = 'sun';
        return;
      case 'seek':
        // Back (or on) to a checkpoint, paused there: the moment gone back to stays to be looked at. Only a whole
        // step up to the run's or its latest checkpoint's (the worker replays to it at once: a huge one would never end).
        if (!s || !Number.isFinite(c.step)) return;
        paused = true;
        edge = null;
        sendRun();
        send({ type: 'seek', generation, step: Math.min(Math.max(s.step, ...s.checkpoints.map((k) => k.step)), Math.max(0, Math.floor(c.step))) });
        trails.clear();
        return;
      case 'replay':
        paused = true;
        edge = null;
        sendRun();
        send({ type: 'replay', generation });
        trails.clear();
        return;
      case 'reset':
        // Back to the fork, paused, at a day a second.
        rate = 86_400;
        paused = true;
        ownRate();
        if (seedScenario) load(seedScenario);
        selected = null;
        status = { kind: 'reset', detail: [] };
        return;
      case 'horizon':
        if (c.seconds > 0) {
          horizonS = c.seconds;
          requestPrediction();
        }
        return;
      case 'save':
        void saved().then((scenario) =>
          idb('readwrite', (store) => store.put(JSON.stringify(scenario), SAVE_KEY)).then(
            () => {
              status = { kind: 'saved', detail: [] };
            },
            (err: unknown) => {
              status = { kind: 'error', detail: [String(err)] };
            },
          ),
        );
        return;
      case 'restoreSaved':
        void idb<unknown>('readonly', (store) => store.get(SAVE_KEY)).then(
          (text) => {
            if (typeof text !== 'string') {
              status = { kind: 'error', detail: ['nothing saved yet'] };
              return;
            }
            void lab.command({ kind: 'import', text });
          },
          (err: unknown) => {
            status = { kind: 'error', detail: [String(err)] };
          },
        );
        return;
      case 'export':
        void saved().then((scenario) => {
          const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `kun-fayakun-${scenario.name}.json`;
          a.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 1000);
          status = { kind: 'exported', detail: [] };
        });
        return;
      case 'import': {
        let raw: unknown;
        try {
          raw = JSON.parse(c.text);
        } catch {
          status = { kind: 'error', detail: ['not JSON'] };
          return;
        }
        const checked = validateScenario(raw);
        if (!checked.ok) {
          status = { kind: 'error', detail: checked.errors.slice(0, 6) };
          return;
        }
        seedScenario = checked.scenario;
        // A scenario from a file or a link: an experiment of its own, not the real system to compare with.
        realSeed = false;
        selected = null;
        load(checked.scenario);
        status = { kind: 'loaded', detail: [] };
        return;
      }
    }
  };

  /** A tap on one of the laboratory's own bodies (its disc, or within a finger's reach of a small one) chooses it; true when it did. */
  const pick = (x: number, y: number): boolean => {
    const s = snap;
    const v = pointerView;
    const relativeTo = lastRelative;
    if (!active || !s || !v || !relativeTo) return false;
    let best: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < s.ids.length; k += 1) {
      const id = s.ids[k] ?? '';
      if (builtIn(id)) continue;
      const p = place(s, k);
      const r = relativeTo(toRender(p[0], p[1], p[2], km()), km());
      const at = v.toScreen(r);
      if (!at) continue;
      const d = Math.hypot(at.x - x, at.y - y);
      const disc = report?.bodies.find((b) => b.id === id)?.discPx ?? 0;
      if (d <= Math.max(disc, PICK_PX) && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    if (best === null) return false;
    selected = best;
    prediction = null;
    requestPrediction();
    return true;
  };

  /**
   * The rate shown this frame (SLOW): the visitor's, or slower for an event: approaching (the worker's
   * scan says what is coming and when), held after it, eased back. The rate the worker runs at follows.
   */
  const governSlow = (nowS: number, s: LabSnapshot): void => {
    const was = shownRate;
    if (!slowOn || paused || rate <= 0 || seekingS !== null || stopping !== null) {
      slow = null;
      shownRate = rate;
      drawnPace = rate;
      if (shownRate !== was && !paused && seekingS === null && stopping === null) sendRun();
      return;
    }
    const up = s.upcoming;
    const key = up ? `${up.target}|${up.body}` : '';
    if (up && !dismissed.has(key) && (!slow || slow.phase !== 'hold' || slow.key === key)) {
      const showRate = Math.min(rate, Math.max(SLOW.minRate, up.showRate));
      if (showRate < rate * 0.999) {
        if (!slow || slow.key !== key || slow.phase === 'back') slow = { key, kind: up.kind, target: up.target, body: up.body, showRate, contactT: up.t, phase: 'approach', since: nowS, from: shownRate };
        else if (slow.phase === 'approach') {
          slow.contactT = up.t;
          slow.showRate = showRate;
        }
      }
    }
    let want = rate;
    let pace: number | null = null;
    if (slow?.phase === 'approach') {
      // From the worker's moment (it runs a little ahead of what is drawn): it is the run that must reach the event slowly.
      const contact = slow.contactT ?? 0;
      const remaining = contact - Math.max(clock.shown, s.t + s.owed);
      if (remaining < -Math.max(60, slow.showRate * SLOW.holdS)) {
        // Passed without it (the two-body guess was off, or another body got in the way): back to the rate set.
        slow.phase = 'back';
        slow.since = nowS;
        slow.from = shownRate;
      } else {
        // Easing down in log rate over about easeS, so the contact comes marginS after the slowest rate is reached.
        const floor = slow.showRate;
        const k = Math.log(rate / floor) / SLOW.easeS;
        const eased = (left: number): number => Math.min(rate, Math.max(floor, floor + k * Math.max(0, left - floor * SLOW.marginS)));
        want = Math.min(was, eased(remaining));
        // The drawn clock, behind the worker by what a few frames covered at the faster rates, eases by its own
        // distance from the contact: a little faster than the worker, so it closes on it as both slow. At the
        // worker's pace it would be left behind (steered no more than half as fast again), the gap in real
        // seconds growing as the rate fell, until it jumped.
        pace = Math.max(want, Math.min(drawnPace, eased(contact - clock.shown)));
      }
    }
    if (slow?.phase === 'hold') {
      want = slow.showRate;
      if (nowS - slow.since >= SLOW.holdS) {
        slow.phase = 'back';
        slow.since = nowS;
        slow.from = slow.showRate;
      }
    }
    if (slow?.phase === 'back') {
      const u = Math.min(1, Math.max(0, (nowS - slow.since) / SLOW.backS));
      const e = u * u * (3 - 2 * u);
      want = Math.exp(Math.log(slow.from) + (Math.log(rate) - Math.log(slow.from)) * e);
      if (u >= 1) {
        slow = null;
        want = rate;
      }
    }
    shownRate = want;
    drawnPace = pace ?? want;
    if (Math.abs(shownRate - sentRate) > 0.01 * sentRate || (shownRate === rate && sentRate !== rate)) sendRun();
  };

  const lab: Lab = {
    objects: [lines.mesh, dots.object, markers.object, particles.object, dust.object, fxRoot],
    get active() {
      return active;
    },
    start(seed, jdTdb) {
      active = true;
      selected = null;
      status = null;
      if (seed === 'solar') forkJdTdb = jdTdb;
      seedScenario = seed === 'solar' ? seedSolarSystem(ephemeris, physical, jdTdb, names, shapes) : seedLaboratory(physical, seed === 'three', shapes);
      realSeed = seed === 'solar';
      load(seedScenario);
      lines.mesh.visible = true;
      dots.object.visible = true;
      markers.object.visible = true;
      particles.object.visible = true;
      dust.object.visible = true;
      fxRoot.visible = true;
      loadFx();
      refreshLibrary();
    },
    stop() {
      active = false;
      generation += 1;
      worker?.terminate();
      worker = null;
      snap = null;
      prediction = null;
      trails.clear();
      lines.mesh.visible = false;
      dots.object.visible = false;
      markers.object.visible = false;
      particles.object.visible = false;
      particlesDrawn = 0;
      dust.object.visible = false;
      plumes.length = 0;
      placing = null;
      dragging = null;
      spinDrawn.clear();
      fxRoot.visible = false;
      fx?.clear();
      bodyFades.clear();
      swarmFades.clear();
      builtScale.clear();
      leaving.clear();
      slow = null;
      aim = null;
      report = null;
      for (const resolve of acks.values()) resolve({ ok: false, reason: 'the laboratory was left' });
      acks.clear();
      for (const q of queued.splice(0)) q.resolve({ ok: false, reason: 'the laboratory was left' });
    },
    tick(nowMs) {
      const wall = Number.isFinite(clockWall) ? Math.min(0.1, Math.max(0, (nowMs - clockWall) / 1000)) : 0;
      clockWall = nowMs;
      const s = held[held.length - 1];
      if (!s) return false;
      const cuts = clock.cuts;
      // Following a goto as it goes (and at its last moment); paused (or stopped at the start), on to where the
      // worker stopped, which it stepped on to (an edit is made on the newest snapshot, so what is drawn is then
      // exactly what it changes); else at the rate asked for, or at the pace the worker reaches when short of it
      // (over the snapshots held: a few tenths of a second).
      const mode = seekingS !== null || stopping !== null || arrived ? 'follow' : paused ? 'land' : 'run';
      arrived = false;
      const first = held[0];
      const reached = first && s.at - first.at > 100 ? (Math.abs(s.t - first.t) * 1000) / (s.at - first.at) : Math.abs(s.achievedRate);
      governSlow(nowMs / 1000, s);
      clock.advance(wall, drawnPace, !paused && !s.failure, s, nowMs, mode, reached);
      if (clock.shown < 0) clock.shown = 0;
      return clock.cuts !== cuts;
    },
    jdTdb() {
      return (seedScenario?.epochJdTdb ?? 0) + clock.shown / 86_400;
    },
    applyBuiltIns(sys, hidden) {
      hidden.clear();
      if (!snap) return;
      const s = snap;
      const wallNow = performance.now();
      const dtS = Number.isFinite(lastBuiltWall) ? Math.min(0.1, Math.max(0, (wallNow - lastBuiltWall) / 1000)) : 0;
      lastBuiltWall = wallNow;
      const seed = seedScenario;
      for (const id of BODY_IDS) {
        const i = s.ids.indexOf(id);
        if (i < 0) {
          // Ended by the experiment (merged, torn apart, removed): it shrinks away where it was (a shrinking
          // disc only darkens), then is hidden. A cut (a load, a jump back) hides it at once.
          const was = builtScale.get(id);
          const going = leaving.get(id);
          if (was !== undefined && !going && seed?.bodies.some((b) => b.id === id)) {
            const q = sys.bodies[id].position;
            leaving.set(id, { at: wallNow, pos: [q.x, q.y, q.z], scale: was });
          }
          const g = leaving.get(id);
          if (g && wallNow - g.at < LEAVE_S * 1000) {
            sys.bodies[id].position.x = g.pos[0];
            sys.bodies[id].position.y = g.pos[1];
            sys.bodies[id].position.z = g.pos[2];
            continue;
          }
          builtScale.delete(id);
          hidden.add(id);
          continue;
        }
        leaving.delete(id);
        const p = place(s, i);
        toRender(p[0], p[1], p[2], sys.bodies[id].position);
        // Its drawn size eases to the experiment's radius (from its seed's: the real one).
        const real = seed?.bodies.find((b) => b.id === id)?.radiusKm ?? (s.radius[i] ?? 1);
        const want = (s.radius[i] ?? real) / Math.max(real, 1e-9);
        const had = builtScale.get(id);
        // Eased over RESIZE_S, and never more than a thirtieth of what is left in a frame (a long frame is no jump).
        builtScale.set(id, had === undefined ? want : had + (want - had) * Math.min(1 / 30, 1 - Math.exp(-dtS / RESIZE_S)));
      }
      // A laboratory of its own: the hidden Sun stands at its heaviest body (its star), so the view goes round that.
      standIn = -1;
      if (hidden.has('sun')) {
        for (let k = 0; k < s.ids.length; k += 1) if (!builtIn(s.ids[k] ?? '') && (standIn < 0 || (s.gm[k] ?? 0) > (s.gm[standIn] ?? 0))) standIn = k;
        if (standIn >= 0) {
          const p = place(s, standIn);
          toRender(p[0], p[1], p[2], sys.bodies.sun.position);
        }
      }
      // A world whose spin the visitor set turns as set: from the moment it was set, its drawn pole turned
      // onto the new one (or its opposite, so its north stays the side it was), at the new period. The
      // rest turn as the IAU models have them.
      const spinSet = new Set(s.interventions.filter((x) => x.kind === 'setSpin').map((x) => x.id));
      const tNow = clock.shown;
      for (const id of BODY_IDS) {
        const i = s.ids.indexOf(id);
        const L = i < 0 ? ([0, 0, 0] as Vec3) : spinOf(s, i);
        const Ln = norm3(L);
        if (i < 0 || !spinSet.has(id) || !(Ln > 0)) {
          spinDrawn.delete(id);
          continue;
        }
        const basis = sys.bodies[id].basis;
        let d = spinDrawn.get(id);
        if (!d || norm3(sub3(d.spin, L)) > 1e-6 * Ln) {
          const pole = toRender(L[0] / Ln, L[1] / Ln, L[2] / Ln, km());
          const n: Vec3 = [pole.x, pole.y, pole.z];
          const current = d ? drawnBasis(d, tNow) : [...basis];
          const meshPole: Vec3 = [current[3] ?? 0, current[4] ?? 1, current[5] ?? 0];
          const flip = dot3(meshPole, n) < 0;
          const target = flip ? scale3(n, -1) : n;
          const axis = cross3(meshPole, target);
          const sinA = norm3(axis);
          const turn = Math.atan2(sinA, dot3(meshPole, target));
          const u = sinA > 1e-12 ? scale3(axis, 1 / sinA) : ([1, 0, 0] as Vec3);
          const aligned = [0, 1, 2].flatMap((c) => rotate3(current.slice(c * 3, c * 3 + 3), u, turn));
          d = { t: tNow, basis: aligned, pole: n, periodS: ((s.inertia[i] ?? 0.4) * (s.gm[i] ?? 0) * (s.radius[i] ?? 0) ** 2 * 2 * Math.PI) / Ln, flip, spin: L };
          spinDrawn.set(id, d);
        }
        const out = drawnBasis(d, tNow);
        for (let k = 0; k < 9; k += 1) basis[k] = out[k] ?? 0;
      }
      // Each crater on a world drawn solid, placed once: where the surface stood at the moment of impact
      // (turning as the IAU models have it, or as the visitor set it from then on), in the world's own frame.
      const epoch = seedScenario?.epochJdTdb ?? 0;
      for (const e of s.events) {
        const body = e.crater ? builtIn(e.survivor) : null;
        if (!body || !MARKED.includes(body) || craterMarks.has(eventKey(e))) continue;
        const d = spinDrawn.get(body);
        const basis = d && d.t <= e.t ? drawnBasis(d, e.t) : sys.basisAt(body, epoch + e.t / 86_400, new Array<number>(9).fill(0));
        const r = toRender(e.site[0], e.site[1], e.site[2], km());
        const site: Vec3 = [0, 1, 2].map((c) => r.x * (basis[c * 3] ?? 0) + r.y * (basis[c * 3 + 1] ?? 0) + r.z * (basis[c * 3 + 2] ?? 0)) as Vec3;
        // Mesh y is the pole, x the prime meridian, z the body's -y (90 degrees west): planetocentric, east positive.
        craterMarks.set(eventKey(e), { body, site, latDeg: Math.asin(Math.max(-1, Math.min(1, site[1]))) / DEG, lonDeg: Math.atan2(-site[2], site[0]) / DEG, appear: 0, glow: 0, at: performance.now() });
      }
      // A giant impact's heat on a world drawn solid: placed as a crater is, once.
      for (const h of heatMarks.values()) {
        if (h.local) continue;
        const d = spinDrawn.get(h.body);
        const basis = d && d.t <= h.t ? drawnBasis(d, h.t) : sys.basisAt(h.body, epoch + h.t / 86_400, new Array<number>(9).fill(0));
        const r = toRender(h.site[0], h.site[1], h.site[2], km());
        h.local = [0, 1, 2].map((c) => r.x * (basis[c * 3] ?? 0) + r.y * (basis[c * 3 + 1] ?? 0) + r.z * (basis[c * 3 + 2] ?? 0)) as Vec3;
      }
      // The marked worlds' turn now, so a plume and a fireball stay on their crater as it turns.
      for (const b of MARKED) {
        let now = basisNow.get(b);
        if (!now) {
          now = new Array<number>(9).fill(0);
          basisNow.set(b, now);
        }
        for (let k = 0; k < 9; k += 1) now[k] = sys.bodies[b].basis[k] ?? 0;
      }
    },
    scale(id) {
      if (!active) return 1;
      const g = leaving.get(id);
      if (g) {
        // Eased out to nothing over LEAVE_S.
        const u = Math.min(1, (performance.now() - g.at) / (LEAVE_S * 1000));
        return g.scale * (1 - u) * (1 - u);
      }
      return builtScale.get(id) ?? 1;
    },
    climateBands(body) {
      if (!active || !snap) return null;
      return snap.climate.find((c) => c.id === body)?.t ?? null;
    },
    get climateView() {
      return climateView;
    },
    marks(body) {
      const s = snap;
      if (!active || !s) return [];
      const i = s.ids.indexOf(body);
      const radius = i >= 0 ? (s.radius[i] ?? 0) : 0;
      if (!(radius > 0)) return [];
      const now = clock.shown;
      const wall = performance.now();
      const out: SurfaceMark[] = [];
      /** The melt's glow at its surface's temperature now (./lab-fx/heat: a crust forming), as a share of the drawn glow's full strength. */
      const glowOf = (meltK: number, t: number): number => (now < t ? 0 : Math.min(1, incandescence(crustK(meltK, now - t)).luminance / MELT_GLOW));
      // Craters and heat in order of time; past MAX_MARKS the oldest fades away before its place is given to the newest (which waits meanwhile).
      const list: Array<{ key: string; t: number; m: { appear: number; glow: number; at: number }; target: number; mark: Omit<SurfaceMark, 'appear' | 'glow'> }> = [];
      for (const e of s.events) {
        const key = eventKey(e);
        const m = e.crater ? craterMarks.get(key) : undefined;
        if (!m || !e.crater || m.body !== body || evicted.has(key)) continue;
        list.push({ key, t: e.t, m, target: glowOf(MELT.craterK, e.t), mark: { site: m.site, angle: e.crater.diameterKm / 2 / radius, depth: e.crater.depthKm / radius, rim: e.crater.rimKm / radius, complex: e.crater.complex } });
      }
      for (const [key, h] of heatMarks) {
        if (h.body !== body || !h.local || evicted.has(key)) continue;
        // A glow alone (no relief, no fresh rock): the face the impact melted.
        list.push({ key, t: h.t, m: { appear: 0, glow: h.glow, at: h.at }, target: glowOf(h.meltK, h.t), mark: { site: h.local, angle: h.angle, depth: 0, rim: 0, complex: false } });
      }
      list.sort((a, b) => a.t - b.t);
      const extra = Math.max(0, list.length - MAX_MARKS);
      list.forEach((item, k) => {
        if (k >= MAX_MARKS) return;
        const { m } = item;
        // Eased toward where it should be, never faster than the rates allow.
        const dtS = Math.min(0.25, Math.max(0, (wall - m.at) / 1000));
        m.at = wall;
        const heat = heatMarks.get(item.key);
        if (k < extra) {
          // Giving up its place: out over half a second.
          m.appear = Math.max(0, m.appear - dtS / FADE_S);
          m.glow = Math.max(0, m.glow - dtS / FADE_S);
          if (m.appear <= 0 && m.glow <= 0) evicted.add(item.key);
        } else {
          if (!heat) m.appear = Math.min(1, m.appear + dtS * MARK_EASE.appearPerS);
          m.glow = item.target > m.glow ? Math.min(item.target, m.glow + dtS * MARK_EASE.glowUpPerS) : Math.max(item.target, m.glow - dtS * MARK_EASE.glowDownPerS);
        }
        if (heat) {
          heat.glow = m.glow;
          heat.at = m.at;
          // Cooled and faded: gone.
          if (m.glow <= 0 && item.target <= 0 && now > heat.t) heatMarks.delete(item.key);
        }
        out.push({ ...item.mark, appear: m.appear, glow: m.glow });
      });
      return out;
    },
    update(frame, relative) {
      lastRelative = relative;
      if (!active || !snap) {
        weights.fill(0);
        return;
      }
      const s = snap;
      if (standIn >= 0) {
        const p = place(s, standIn);
        const r = relative(toRender(p[0], p[1], p[2], km()), km());
        standInAltitudeKm = Math.hypot(r.x, r.y, r.z) - (s.radius[standIn] ?? 0);
      }
      /** How far the drawn clock is past the snapshot (s), for paths integrated from it. */
      const ahead = clock.shown - s.t;
      /** Where body `k` is as drawn (scenario frame). */
      const now = (k: number, out: number[]): number[] => {
        const p = place(s, k);
        for (let c = 0; c < 3; c += 1) out[c] = p[c] ?? 0;
        return out;
      };
      // The turning frame (view "corotating"): the chosen body's primary A and the heaviest body about it, B;
      // its axes now (e1 from A toward B in the pair's plane, e3 the pair's pole), and how fast the pair turns.
      const pair = viewMode === 'corotating' ? corotatingPair(s) : null;
      const ta = pair ? trails.get(s.ids[pair.a] ?? '') : undefined;
      const tb = pair ? trails.get(s.ids[pair.b] ?? '') : undefined;
      let turning: { aNow: Vec3; e1: Vec3; e2: Vec3; e3: Vec3; omega: number; ta: TrailRing; tb: TrailRing } | null = null;
      if (pair && ta && tb) {
        const aNow = now(pair.a, [0, 0, 0]) as Vec3;
        const r = sub3(now(pair.b, [0, 0, 0]), aNow);
        const v = [0, 1, 2].map((k) => (s.vel[pair.b * 3 + k] ?? 0) - (s.vel[pair.a * 3 + k] ?? 0));
        const e3 = unit3(cross3(r, v));
        const e1 = unit3(sub3(r, scale3(e3, dot3(r, e3))), [1, 0, 0]);
        turning = { aNow, e1, e2: cross3(e3, e1), e3, omega: norm3(cross3(r, v)) / Math.max(dot3(r, r), 1e-9), ta, tb };
      }
      // The frame turning with the chosen body's primary's own rotation (view "bodyfixed"): its axis and rate.
      let spinning: { a: number; aNow: Vec3; axis: Vec3; omega: number; ta: TrailRing } | null = null;
      if (viewMode === 'bodyfixed' && selected) {
        const i0 = s.ids.indexOf(selected);
        const a = i0 < 0 ? -1 : primaryOf(s.gm, s.pos, i0);
        const ta0 = a < 0 ? undefined : trails.get(s.ids[a] ?? '');
        const L = a < 0 ? ([0, 0, 0] as Vec3) : spinOf(s, a);
        const Ln = norm3(L);
        if (a >= 0 && ta0 && Ln > 0) {
          const periodS = ((s.inertia[a] ?? 0.4) * (s.gm[a] ?? 0) * (s.radius[a] ?? 0) ** 2 * 2 * Math.PI) / Ln;
          spinning = { a, aNow: now(a, [0, 0, 0]) as Vec3, axis: scale3(L, 1 / Ln), omega: (2 * Math.PI) / periodS, ta: ta0 };
        }
      }
      const tNow = clock.shown;
      /** A point of the turning frame's sample k (A and B there) carried to the frame as it stands now. */
      const turned = (x: readonly number[], a: readonly number[], b: readonly number[], f: NonNullable<typeof turning>): Vec3 => {
        const d = sub3(x, a);
        const ab = sub3(b, a);
        const f1 = unit3(sub3(ab, scale3(f.e3, dot3(ab, f.e3))), f.e1);
        const f2 = cross3(f.e3, f1);
        return add3(f.aNow, add3(add3(scale3(f.e1, dot3(d, f1)), scale3(f.e2, dot3(d, f2))), scale3(f.e3, dot3(d, f.e3))));
      };
      // Trails: about each body's primary (as the real explorer draws orbits: a moon's about its planet, not
      // smeared along the planet's path), in the scenario's frame, or in the frame turning with the pair; the
      // chosen body's in gold, the rest faint (as many as there are slots). Every trail is sampled at the same
      // snapshots, so two trails line up from their ends.
      let slot = 0;
      weights.fill(0);
      for (const [id, t] of trails) {
        // As many as there are slots (the chosen one's always).
        if (id !== selected && slot >= TRAIL_SLOTS) continue;
        const b = s.ids.indexOf(id);
        const p = viewMode !== 'primary' || b < 0 ? -1 : primaryOf(s.gm, s.pos, b);
        const pt = p < 0 ? undefined : trails.get(s.ids[p] ?? '');
        const limit = turning ? Math.min(turning.ta.count, turning.tb.count) : spinning ? spinning.ta.count : pt ? pt.count : Number.POSITIVE_INFINITY;
        const n = Math.min(t.count, limit);
        if (n < 2) continue;
        const from = t.count - n;
        const fromP = pt ? pt.count - n : 0;
        const fromA = turning ? turning.ta.count - n : spinning ? spinning.ta.count - n : 0;
        const fromB = turning ? turning.tb.count - n : 0;
        if (pt) now(p, anchor);
        for (let k = 0; k < n; k += 1) {
          if (spinning) {
            // Turned back by the primary's rotation since that sample: the path as the ground under it sees it.
            const sa = spinning.ta;
            const rel = [0, 1, 2].map((c) => t.x(from + k, c) - sa.x(fromA + k, c));
            const q = add3(spinning.aNow, rotate3(rel, spinning.axis, spinning.omega * (tNow - t.t(from + k))));
            point[0] = q[0];
            point[1] = q[1];
            point[2] = q[2];
          } else if (turning) {
            const at = (r: TrailRing, k0: number): Vec3 => [r.x(k0, 0), r.x(k0, 1), r.x(k0, 2)];
            const q = turned(at(t, from + k), at(turning.ta, fromA + k), at(turning.tb, fromB + k), turning);
            point[0] = q[0];
            point[1] = q[1];
            point[2] = q[2];
          } else {
            for (let c = 0; c < 3; c += 1) point[c] = t.x(from + k, c) + (pt ? (anchor[c] ?? 0) - pt.x(fromP + k, c) : 0);
          }
          toRender(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, scratch);
          trailDrawn[k * 3] = scratch.x;
          trailDrawn[k * 3 + 1] = scratch.y;
          trailDrawn[k * 3 + 2] = scratch.z;
        }
        if (id === selected) {
          chosenTrail.set(trailDrawn, n);
          weights[TRAIL_SLOTS] = 1;
        } else {
          trailPaths[slot]?.set(trailDrawn, n);
          weights[slot] = 0.8;
          slot += 1;
        }
      }
      // The prediction: about the body it moved about when it was made (where that body is now), in the
      // scenario's frame, or turning with the pair (taken to turn at its present rate over the horizon).
      const i = selected ? s.ids.indexOf(selected) : -1;
      /** A predicted point (sample k of n, or at time tS) in the frame drawn now. */
      let framed: ((x: readonly number[], k: number, tS: number) => Vec3) | null = null;
      if (prediction && i >= 0 && prediction.id === selected && prediction.path.length >= 6) {
        const pr = prediction;
        const n = pr.path.length / 3;
        const f = pr.frame === null ? -1 : s.ids.indexOf(pr.frame);
        const about = f >= 0 && pr.framePath.length === pr.path.length;
        const fNow = about ? (now(f, [0, 0, 0]) as Vec3) : null;
        const frameAt = (k: number): Vec3 => [pr.framePath[k * 3] ?? 0, pr.framePath[k * 3 + 1] ?? 0, pr.framePath[k * 3 + 2] ?? 0];
        framed = (x, k, tS) => {
          const kk = Math.max(0, Math.min(n - 1, k));
          if (spinning && about && pr.frame === s.ids[spinning.a]) return add3(spinning.aNow, rotate3(sub3(x, frameAt(kk)), spinning.axis, -spinning.omega * (tS - ahead)));
          if (turning && about) return add3(turning.aNow, rotate3(sub3(x, frameAt(kk)), turning.e3, -turning.omega * tS));
          if (viewMode === 'inertial' || !about || !fNow) return [x[0] ?? 0, x[1] ?? 0, x[2] ?? 0];
          return add3(x, sub3(fNow, frameAt(kk)));
        };
        const pts = new Array<number>(n * 3);
        for (let k = 0; k < n; k += 1) {
          const q = framed([pr.path[k * 3] ?? 0, pr.path[k * 3 + 1] ?? 0, pr.path[k * 3 + 2] ?? 0], k, ((k + 1) / n) * pr.horizonS);
          toRender(q[0], q[1], q[2], scratch);
          pts[k * 3] = scratch.x;
          pts[k * 3 + 1] = scratch.y;
          pts[k * 3 + 2] = scratch.z;
        }
        predictionPath.set(pts, n);
        weights[TRAIL_SLOTS + 1] = 1;
      }
      // The velocity relative to the primary, ARROW_PX long on screen whatever its speed (kept while dragged, so the tip follows the pointer).
      const shown = dragging && dragging.id === selected ? dragging.vel : undefined;
      if (i >= 0 && !dragging) {
        const b = posNow(s, i);
        const at = relative(toRender(b[0], b[1], b[2], km()), km());
        const rv = relativeTo(s, i)?.v ?? ([s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0] as Vec3);
        const speedNow = norm3(rv);
        arrowLen = speedNow > 0 ? (ARROW_PX * Math.hypot(at.x, at.y, at.z)) / Math.max(frame.pxPerTan, 1) / speedNow : 0;
      }
      const arrowNow = i >= 0 ? arrow(s, i, dragging ? dragging.len : arrowLen, shown) : null;
      if (arrowNow) {
        const base = posNow(s, i);
        const a = toRender(base[0], base[1], base[2], km());
        const b = toRender(arrowNow.tip[0], arrowNow.tip[1], arrowNow.tip[2], km());
        velocityPath.set([a.x, a.y, a.z, b.x, b.y, b.z], 2);
        weights[TRAIL_SLOTS + 2] = 1;
      }
      const orbitFrame: OrbitFrame = { camera: frame.camera, forward: frame.forward, near: frame.near, far: frame.far, focus: frame.focus, focusRadius: frame.focusRadius, focusDistance: frame.focusDistance, compensation: frame.compensation, light: 1, weights };
      lines.update(orbitFrame);

      // The new bodies (not the ten worlds): with the effects (./lab-fx) lit rocks and shining stars at the
      // engine's radius, soft dust and rings, fireballs; until they have loaded, points of light. Their
      // names either way (buildLabels).
      const wallNow = performance.now();
      const dtFx = Math.min(0.1, Math.max(0, frame.dt));
      fxClock += dtFx;
      // Plumes over, or done fading away early, go.
      for (let k = plumes.length - 1; k >= 0; k -= 1) {
        const q = plumes[k];
        if (q && ((wallNow - q.born) / 1000 > DUST.seconds || (q.ending !== null && wallNow - q.ending > FADE_S * 1000))) plumes.splice(k, 1);
      }
      const effects = fx;
      dots.object.visible = !effects;
      particles.object.visible = !effects;
      dust.object.visible = !effects;
      if (effects) {
        report = drawEffects(effects, s, frame, relative, wallNow, dtFx);
        particlesDrawn = report.dust.particles;
      } else {
        let d = 0;
        for (let k = 0; k < s.ids.length && d < DOT_SLOTS; k += 1) {
          const id = s.ids[k] ?? '';
          if (builtIn(id)) continue;
          const p = place(s, k);
          toRender(p[0], p[1], p[2], abs);
          relative(abs, rel);
          const dot = dotList[d];
          if (!dot) break;
          const distance = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
          placeScaled(rel, s.radius[k] ?? 1, frame.far, dot.position);
          const discPx = frame.pxPerTan * Math.tan(Math.asin(Math.min(1, (s.radius[k] ?? 1) / distance)));
          dot.sizePx = Math.max(4, Math.min(40, discPx * 2));
          dot.opacity = 1;
          dot.marker = id === selected ? 1 : 0;
          d += 1;
        }
        for (let k = d; k < DOT_SLOTS; k += 1) {
          const dot = dotList[k];
          if (dot) dot.opacity = 0;
        }
        dots.update(dotList, frame.compensation);
        // Rings and belts: each particle where the snapshot had it about its primary, the primary where it is now.
        let q = 0;
        for (const w of s.swarms) {
          const p = s.ids.indexOf(w.primary);
          if (p < 0) continue;
          const primaryAt = posNow(s, p);
          const color = (s.gm[p] ?? 0) > STAR_GM ? PARTICLES.belt : PARTICLES.ring;
          const m = w.rel.length / 3;
          for (let k = 0; k < m && q < SWARM_LIMITS.total; k += 1) {
            const dot = particleList[q];
            if (!dot) break;
            toRender(primaryAt[0] + (w.rel[k * 3] ?? 0), primaryAt[1] + (w.rel[k * 3 + 1] ?? 0), primaryAt[2] + (w.rel[k * 3 + 2] ?? 0), abs);
            relative(abs, rel);
            placeScaled(rel, 1, frame.far, dot.position);
            dot.color = color;
            dot.opacity = PARTICLES.opacity;
            q += 1;
          }
        }
        for (let k = q; k < particlesDrawn; k += 1) {
          const dot = particleList[k];
          if (dot) dot.opacity = 0;
        }
        particlesDrawn = q;
        particles.update(particleList, frame.compensation);
        // Dust plumes: up from the crater (turning with its world) and back down, fading, over a few seconds.
        let u = 0;
        for (const plume of plumes) {
          plumeAt(s, plume, wallNow, frame, relative, DUST.perImpact, (point, strength) => {
            const dot = dustList[u];
            if (!dot) return;
            relative(point, rel);
            placeScaled(rel, 1, frame.far, dot.position);
            dot.opacity = strength;
            u += 1;
          });
        }
        for (let k = u; k < dustList.length; k += 1) {
          const dot = dustList[k];
          if (dot) dot.opacity = 0;
        }
        dust.update(dustList, frame.compensation);
      }
      buildLabels(s, frame, relative);

      // Markers: the Lagrange points of the chosen body and its primary, the prediction's encounters, the
      // placing preview and the velocity arrow's handle.
      let m = 0;
      const mark = (at: readonly number[], color: readonly [number, number, number], sizePx: number, ring: number, label: string | null): void => {
        const dot = markerList[m];
        if (!dot) return;
        toRender(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0, abs);
        relative(abs, rel);
        placeScaled(rel, 1, frame.far, dot.position);
        dot.color = color;
        dot.sizePx = sizePx;
        dot.opacity = 1;
        dot.marker = ring;
        if (label) labelList.push({ id: `lab-marker-${m}`, textKey: 'ui.universe.lab.body', text: label, position: [dot.position.x, dot.position.y, dot.position.z], opacity: 0.85, offset: [8, 8] });
        m += 1;
      };
      if (showLagrange && i >= 0) {
        const p = primaryOf(s.gm, s.pos, i);
        if (p >= 0) {
          const vel = (k: number): Vec3 => [s.vel[k * 3] ?? 0, s.vel[k * 3 + 1] ?? 0, s.vel[k * 3 + 2] ?? 0];
          const L = lagrangePoints({ gm: s.gm[p] ?? 0, pos: now(p, [0, 0, 0]), vel: vel(p) }, { gm: s.gm[i] ?? 0, pos: now(i, [0, 0, 0]), vel: vel(i) });
          for (const name of ['L1', 'L2', 'L3', 'L4', 'L5'] as const) mark(L[name], LAGRANGE, 7, 0, name);
        }
      }
      if (prediction && framed && prediction.id === selected) {
        const n = prediction.path.length / 3;
        for (const e of prediction.encounters) {
          // The time left from the moment drawn (the prediction began earlier); an encounter passed is not shown.
          const left = prediction.fromT + e.t - tNow;
          if (left < 0) continue;
          const k = Math.round((e.t / prediction.horizonS) * n) - 1;
          // Named as the encounter it is, not as the body (whose own name may show beside it).
          const when = left < 2 * 86_400 ? fill('ui.universe.lab.hours', { value: (left / 3600).toFixed(1) }) : fill('ui.universe.lab.days', { value: (left / 86_400).toFixed(1) });
          mark(framed(e.pos, k, e.t), ENCOUNTER, 8, 1, fill('ui.universe.lab.closest', { name: knownNames.get(e.with) ?? e.with, time: when }));
        }
      }
      if (placing && hoverOffset) {
        const p = s.ids.indexOf(placing.primary);
        if (p >= 0) mark(add3(posNow(s, p), hoverOffset), PLACING, 10, 1, null);
      }
      if (arrowNow && !placing) mark(arrowNow.tip, VELOCITY, dragging ? 12 : 9, 1, null);
      // A chosen ship's burn directions about its primary, each the arrow's length from it, named as the burns are.
      const shipRel = arrowNow && !placing && s.ships.some((x) => x.id === selected) ? relativeTo(s, i) : null;
      if (shipRel && arrowNow) {
        const base = posNow(s, i);
        const length = norm3(sub3(arrowNow.tip, base));
        const f = orbitalFrame(shipRel.r, shipRel.v);
        for (const [key, dir] of [
          ['prograde', f.prograde],
          ['normal', f.normal],
          ['radialOut', f.radial],
        ] as const) {
          const before = m;
          mark(add3(base, scale3(dir, length)), SHIP_DIRECTIONS[key], 7, 1, null);
          // Named where its marker was placed (in the scaled space the markers are drawn in).
          const dot = m > before ? markerList[m - 1] : undefined;
          if (dot) labelList.push({ id: `lab-direction-${key}`, textKey: `ui.universe.lab.ship.dirShort.${key}`, position: [dot.position.x, dot.position.y, dot.position.z], opacity: 0.85, offset: [8, -8] });
        }
      }
      // Where the handle is on the canvas (client px), for the view.
      handleAt = null;
      if (arrowNow && !placing && pointerView) {
        const tipRel = relative(toRender(arrowNow.tip[0], arrowNow.tip[1], arrowNow.tip[2], km()), km());
        handleAt = pointerView.toScreen(tipRel);
      }
      for (let k = m; k < MARKER_SLOTS; k += 1) {
        const dot = markerList[k];
        if (dot) dot.opacity = 0;
      }
      markers.update(markerList, frame.compensation);
    },
    labels(out) {
      if (active) for (const l of labelList) out.push(l);
    },
    setRun(next, nextPaused) {
      if (!Number.isFinite(next) || next === 0) return;
      rate = next;
      paused = nextPaused;
      if (rate > 0) edge = null;
      ownRate();
      sendRun();
    },
    get rate() {
      return rate;
    },
    get paused() {
      // A goto under way runs whatever the pause (a press of Pause stops it there).
      return paused && seekingS === null;
    },
    get edge() {
      return edge;
    },
    time(command, tdbMinusUtcDays) {
      // The explorer's reducer (./time): at the start going backwards, play, faster and slower turn round. A goto
      // under way counts as running: Pause stops it where it is, a rate or Reverse runs on from there (a new date
      // keeps the pause as it was set).
      const next = applyTimeCommand({ rate, paused: command.kind === 'date' ? paused : lab.paused, edge }, command).state;
      if (command.kind === 'now' || command.kind === 'date') {
        // Now and a date: that moment of the experiment (its clock is TDB), from the fork on. Now runs on at real
        // time; a date before the fork stops there (the experiment has no history before it), as at the explorer's ends.
        const epoch = seedScenario?.epochJdTdb ?? 0;
        const utc = command.kind === 'now' ? Date.now() / 86_400_000 + 2_440_587.5 : command.jdUtc;
        // In the TDB of the clock as drawn (the explorer's date), else with the leap seconds of the moment asked.
        const tdbOf = (jdUtc: number): number => (tdbMinusUtcDays !== undefined && Number.isFinite(tdbMinusUtcDays) ? jdUtc + tdbMinusUtcDays : utcToTdb(jdUtc, physical.time));
        const t = (tdbOf(utc) - epoch) * 86_400;
        rate = next.rate;
        paused = next.paused || t < 0;
        ownRate();
        sendRun();
        // A date lands on that day (UTC, as the field shows it), whatever its time of day and the step: the run
        // ends on the first whole step at or past the moment, or on the day's last step when that one is the
        // next day's (src/sim/goto).
        goTo(t, command.kind === 'date' ? dayWithin(utc, epoch, tdbOf) : null);
        if (t < 0) edge = 'start';
        return;
      }
      rate = next.rate;
      paused = next.paused;
      edge = next.edge === 'start' ? 'start' : null;
      // Any time command calls off the slowing for an event: the rate set is the visitor's.
      ownRate();
      sendRun();
    },
    command(c) {
      return answerFor(c);
    },
    view() {
      if (!active || !seedScenario) return null;
      const s = snap;
      const bodies: UniverseLabBody[] = [];
      if (s) {
        for (let i = 0; i < s.ids.length; i += 1) {
          const id = s.ids[i] ?? '';
          const p = primaryOf(s.gm, s.pos, i);
          const v = Math.hypot(s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0);
          const rv = p >= 0 ? Math.hypot((s.vel[i * 3] ?? 0) - (s.vel[p * 3] ?? 0), (s.vel[i * 3 + 1] ?? 0) - (s.vel[p * 3 + 1] ?? 0), (s.vel[i * 3 + 2] ?? 0) - (s.vel[p * 3 + 2] ?? 0)) : null;
          const rel3: [number, number, number] = [0, 0, 0];
          for (let k = 0; k < 3; k += 1) rel3[k] = (s.vel[i * 3 + k] ?? 0) - (p >= 0 ? (s.vel[p * 3 + k] ?? 0) : 0);
          const rd = p >= 0 ? Math.hypot((s.pos[i * 3] ?? 0) - (s.pos[p * 3] ?? 0), (s.pos[i * 3 + 1] ?? 0) - (s.pos[p * 3 + 1] ?? 0), (s.pos[i * 3 + 2] ?? 0) - (s.pos[p * 3 + 2] ?? 0)) : null;
          const gm = s.gm[i] ?? 0;
          const radiusKm = s.radius[i] ?? 0;
          const rel = relativeTo(s, i);
          const el = rel ? elementsFromState(rel.r, rel.v, rel.mu) : null;
          const pGm = rel ? (s.gm[rel.p] ?? 0) : 0;
          const L = spinOf(s, i);
          const turning = norm3(L) > 0 && gm > 0;
          const density = gm > 0 ? bulkDensity(gm, radiusKm) : 0;
          bodies.push({
            id,
            name: s.names[i] ?? id,
            builtIn: builtIn(id),
            gm,
            massKg: gm / gPerKg,
            radiusKm,
            densityKgM3: density,
            orbit: el
              ? {
                  aKm: el.a,
                  e: el.e,
                  iDeg: el.i / DEG,
                  nodeDeg: el.node / DEG,
                  periapsisArgDeg: el.periapsisArg / DEG,
                  trueAnomalyDeg: el.trueAnomaly / DEG,
                  periodS: el.periodS,
                  periapsisKm: el.periapsisKm,
                  apoapsisKm: el.apoapsisKm,
                  bound: el.bound,
                  hillKm: el.bound && gm > 0 && pGm > 0 ? hillRadiusKm(el.a, el.e, gm, pGm) : null,
                }
              : null,
            rotation: {
              periodS: turning ? ((s.inertia[i] ?? 0.4) * gm * radiusKm * radiusKm * 2 * Math.PI) / norm3(L) : null,
              tiltDeg: turning && rel ? Math.acos(Math.max(-1, Math.min(1, dot3(unit3(L), unit3(cross3(rel.r, rel.v)))))) / DEG : null,
              breakupPeriodS: gm > 0 ? breakupPeriodS(gm, radiusKm) : Number.POSITIVE_INFINITY,
            },
            roche: rel && pGm > 0 && gm > 0 ? rocheLimits(s.radius[rel.p] ?? 0, bulkDensity(pGm, s.radius[rel.p] ?? 1), density) : null,
            fixed: s.fixed.includes(id),
            renamed: s.interventions.some((x) => x.kind === 'rename' && x.id === id),
            j2: s.j2[i] ?? 0,
            insolationWm2: insolationAt(s, i),
            luminosityW: s.light[id] ?? null,
            climate: climateOf(s, i),
            speedKmS: v,
            primary: p >= 0 ? (s.ids[p] ?? null) : null,
            relativeSpeedKmS: rv,
            distanceKm: rd,
            relativeVelKmS: rel3,
            escapeKmS: Math.sqrt((2 * gm) / Math.max(s.radius[i] ?? 1, 1e-9)),
            edited: edited.has(id),
            baseline: baselineOf(id),
            persistent: seedScenario.persistentIds?.includes(id) ?? false,
            ship: shipOf(s, id),
          });
        }
      }
      return {
        name: seedScenario.name,
        seedNote: seedScenario.seedNote,
        frame: seedScenario.frame,
        epochJdTdb: seedScenario.epochJdTdb,
        elapsedS: clock.shown,
        t: s?.t ?? 0,
        step: s?.step ?? 0,
        dtS: s?.dt ?? 0,
        requestedRate: rate,
        achievedRate: s?.achievedRate ?? 0,
        budgetBound: s?.budgetBound ?? false,
        paused: lab.paused,
        seekingS: seekingS ?? stopping,
        standIn: s && standIn >= 0 ? { name: knownNames.get(s.ids[standIn] ?? '') ?? '', altitudeKm: standInAltitudeKm } : null,
        failure: s?.failure ?? null,
        bodies,
        selected,
        drift: s?.drift ?? { energy: 0, momentum: 0, angularMomentum: 0 },
        interventions: s?.interventions ?? [],
        events: (s?.events ?? []).map((e) => {
          const m = craterMarks.get(eventKey(e));
          return { t: e.t, kind: e.kind, regime: e.regime, survivor: e.survivor, absorbed: e.absorbed, speedKmS: e.speedKmS, created: e.created.length, unresolved: e.unresolved > 0, craterKm: e.crater?.diameterKm ?? null, craterDepthKm: e.crater?.depthKm ?? null, craterComplex: e.crater?.complex ?? false, craterSite: m ? { latDeg: m.latDeg, lonDeg: m.lonDeg } : null, energyJ: joules(e.energy) };
        }),
        checkpoints: s?.checkpoints ?? [],
        swarms: (s?.swarms ?? []).map((w) => ({ id: w.id, name: w.name, primary: w.primary, count: w.rel.length / 3, lost: w.lost })),
        particlesDrawn,
        auKm: physical.auKm,
        climateView,
        co2DoublingWm2: figure('climate.forcing.co2Doubling'),
        logLength: s?.logLength ?? 0,
        unapplied: Math.max(0, sentEdits - (s?.applied ?? 0)),
        discarded: s?.discarded ?? 0,
        prediction:
          prediction && prediction.id === selected
            ? (() => {
                // Times from the moment drawn (the prediction was made a little earlier); those passed are left out.
                const p = prediction;
                const left = (t: number): number => p.fromT + t - clock.shown;
                return { id: p.id, horizonS: p.horizonS, merged: p.merged && left(p.merged.t) >= 0 ? { t: left(p.merged.t), with: p.merged.with } : null, encounters: p.encounters.filter((e) => left(e.t) >= 0).map((e) => ({ with: e.with, t: left(e.t), distanceKm: e.distanceKm })) };
              })()
            : null,
        horizonS,
        accuracy,
        undoable: s?.undoable ?? 0,
        redoable: s?.redoable ?? 0,
        constrained: (s?.fixed.length ?? 0) > 0,
        thrusting: s ? s.ships.some((x) => x.burns.some((b) => b.startT <= s.t + 1e-9) && x.fuelKg > 0) : false,
        view: viewMode,
        corotatingPair: (() => {
          const pair = s && viewMode === 'corotating' ? corotatingPair(s) : null;
          return s && pair ? { a: s.ids[pair.a] ?? '', b: s.ids[pair.b] ?? '' } : null;
        })(),
        lagrange: (() => {
          const i = s && selected && showLagrange ? s.ids.indexOf(selected) : -1;
          const p = s && i >= 0 ? primaryOf(s.gm, s.pos, i) : -1;
          return s && selected && p >= 0 ? { primary: s.ids[p] ?? '', secondary: selected } : null;
        })(),
        measure: (() => {
          const m = measureAsk;
          if (!s || !m) return null;
          const a = s.ids.indexOf(m.from);
          const b = s.ids.indexOf(m.to);
          if (a < 0 || b < 0) return null;
          const r = measureBetween(posNow(s, a), posNow(s, b), s.radius[b] ?? 0);
          const c = m.via === null ? -1 : s.ids.indexOf(m.via);
          return { from: m.from, to: m.to, distanceKm: r.distanceKm, lightS: r.lightS, angularSizeDeg: r.angularSize / DEG, via: c >= 0 ? m.via : null, separationDeg: c >= 0 ? separation(posNow(s, a), posNow(s, b), posNow(s, c)) / DEG : null };
        })(),
        graph: tracked ? { id: tracked.id, quantity: tracked.quantity, points: tracked.points, mergedInto: tracked.mergedInto } : null,
        presets: presetView,
        library,
        share,
        copy,
        placing: placing ? { primary: placing.primary, name: placing.name, offsetKm: hoverOffset ? norm3(hoverOffset) : null } : null,
        handle: handleAt,
        status,
        names: Object.fromEntries(knownNames),
        generation,
        applied: s?.applied ?? 0,
        slow: { on: slowOn, active: slow ? { kind: slow.kind, target: slow.target, body: slow.body, rate: shownRate, inS: slow.contactT === null ? null : Math.max(0, slow.contactT - clock.shown) } : null },
        aim: aim ? { status: aim.status, target: aim.target, impactor: aim.impactor, vInfKmS: aim.vInfKmS, angleDeg: aim.angleDeg, leadS: aim.leadS, contact: aim.contact, reason: aim.reason, missKm: aim.missKm, id: aim.id } : null,
        latest,
      };
    },
    takeRefocus() {
      const r = refocus;
      refocus = null;
      return r;
    },
    setPointerView(view) {
      pointerView = view;
    },
    grab(x, y) {
      const s = snap;
      const v = pointerView;
      const rel = lastRelative;
      if (!active || !s || !v || !rel || !selected || placing) return false;
      const i = s.ids.indexOf(selected);
      const a = i < 0 ? null : arrow(s, i, arrowLen);
      if (!a) return false;
      const tipRel = rel(toRender(a.tip[0], a.tip[1], a.tip[2], km()), km());
      const sp = v.toScreen(tipRel);
      if (!sp || Math.hypot(sp.x - x, sp.y - y) > (matchMedia('(pointer: coarse)').matches ? HANDLE_TOUCH_PX : HANDLE_PX)) return false;
      const f = v.forward();
      dragging = { id: selected, len: a.len, tipRel: [tipRel.x, tipRel.y, tipRel.z], normal: [f.x, f.y, f.z], vel: a.vel };
      return true;
    },
    grabMove(x, y) {
      const d = dragging;
      const v = pointerView;
      const rel = lastRelative;
      const s = snap;
      if (!d || !v || !rel || !s) return;
      const i = s.ids.indexOf(d.id);
      if (i < 0) {
        dragging = null;
        return;
      }
      // The tip follows the pointer across the plane through it that faces the camera.
      const ray = v.ray(x, y);
      const denom = ray.x * d.normal[0] + ray.y * d.normal[1] + ray.z * d.normal[2];
      if (Math.abs(denom) < 1e-9) return;
      const t = dot3(d.tipRel, d.normal) / denom;
      if (!(t > 0)) return;
      const b = posNow(s, i);
      const body = rel(toRender(b[0], b[1], b[2], km()), km());
      d.vel = fromRender((ray.x * t - body.x) / d.len, (ray.y * t - body.y) / d.len, (ray.z * t - body.z) / d.len);
    },
    grabEnd(cancelled) {
      const d = dragging;
      dragging = null;
      if (d && !cancelled && d.vel.every(Number.isFinite)) void lab.command({ kind: 'velocity', id: d.id, relativeKmS: d.vel });
    },
    hover(x, y) {
      if (placing) hoverOffset = placeOffset(x, y);
    },
    tap(x, y) {
      if (!placing) return pick(x, y);
      const off = placeOffset(x, y);
      if (off) addPlaced(off);
      return true;
    },
    get placing() {
      return placing !== null;
    },
    escape() {
      if (placing) {
        placing = null;
        hoverOffset = null;
        return true;
      }
      if (slow) {
        ownRate();
        if (!paused) sendRun();
        return true;
      }
      return false;
    },
    dispose() {
      lab.stop();
      lines.dispose();
      dots.dispose();
      markers.dispose();
      particles.dispose();
      dust.dispose();
      // The effects' meshes and buffers (their chunk stays loaded; a new laboratory makes them again).
      fx?.dispose();
      fxRoot.removeFromParent();
      fx = null;
      fxTier = null;
    },
  };
  // For tools and the tests: commands with their answers, and what the effects drew (window.__kf; read-only).
  const kf = (window as unknown as { __kf?: KfTestHandle }).__kf;
  if (kf) {
    kf.universe.lab = (c) => lab.command(c);
    kf.universe.labEffects = (parts) => fx?.toggle(parts) ?? null;
    kf.universe.labDraw = () => (active ? { ...report, scale: Object.fromEntries(BODY_IDS.map((id) => [id, lab.scale(id)])), clock: { ms: clockWall, shownS: clock.shown, fxS: fxClock }, camera: pointerView?.forward() ?? null, heat: { marks: heatMarks.size, bodies: heats.size } } : null);
  }
  return lab;
}
