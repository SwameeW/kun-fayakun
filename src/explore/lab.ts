import type { Object3D } from 'three/webgpu';
import type { Ephemeris } from '../astro/ephemeris';
import type { PhysicalFile } from '../astro/physical';
import { BODY_IDS, type BodyId, type LabCommand, type LabQuantity, type SceneLabel, type UniverseLab, type UniverseLabBody } from '../core/types';
import { validateScenario, type BodySpec, type Command, type Encounter, type Scenario } from '../sim/engine';
import { bulkDensity, joules } from '../sim/craters';
import { breakupPeriodS, elementsFromState, hillRadiusKm, lagrangePoints, measure as measureBetween, orbitalFrame, rocheLimits, separation, stateFromElements, type Vec3 } from '../sim/elements';
import { circularOrbit, consumes, primaryOf, type SimState } from '../sim/nbody';
import { presets as presetList, type Preset } from '../sim/presets';
import { decodeScenario, encodeScenario } from '../sim/share';
import type { LabReply, LabRequest, LabSnapshot } from '../sim/protocol';
import { seedLaboratory, seedSolarSystem, type Shapes } from '../sim/seed';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { createOrbits, type OrbitFrame, type OrbitPath, type Orbits } from './orbits';
import { km, type Km } from './space/origin';
import { placeScaled } from './space/scaled-space';
import type { SolarSystem } from './system';

/**
 * The orbital laboratory inside the explorer (Sandbox): an experiment forked from the solar system
 * at the explorer's epoch (or a clean two- or three-body laboratory), run by the engine in a worker
 * (src/sim), drawn with the explorer's own bodies, sky, lights and camera.
 *
 * State ownership: the scenario's integrator owns every position and velocity. The ten built-in
 * worlds take their places from its snapshots (their rotation still follows the IAU models at the
 * simulated date: modelled, not integrated); a world the experiment removes is hidden; new bodies are
 * drawn as points of light with their names. Nothing here writes to the real explorer's data: leaving
 * the laboratory gives the ephemeris its bodies back.
 *
 * Drawn: each body's recent path (its trail), the chosen body's predicted path (a copy of the state
 * integrated ahead in the worker, redone after every edit and as time passes) and its velocity, all
 * relative to the body it moves about (its primary: a moon's path is drawn about its planet, where the
 * planet is now), through the explorer's orbit renderer (scaled space, constant-width hairlines).
 * Positions between snapshots are carried along each body's velocity.
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
}

/** The explorer's camera for the pointer: a point (render frame, km from the camera) on the canvas (CSS px; null behind the camera), a canvas point's ray, and the view's direction (unit vectors, render frame). */
export interface LabPointerView {
  toScreen(rel: Km): { x: number; y: number } | null;
  ray(x: number, y: number): Km;
  forward(): Km;
}

export interface Lab {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  /** Forks a scenario (the solar system at `jdTdb`, or a laboratory) and runs it. */
  start(seed: 'solar' | 'two' | 'three', jdTdb: number): void;
  stop(): void;
  /** The simulated date (TDB Julian date), carried on from the last snapshot. */
  jdTdb(): number;
  /** Puts the built-in worlds where the experiment has them; returns those it no longer has. */
  applyBuiltIns(sys: SolarSystem, hidden: Set<BodyId>): void;
  update(frame: LabFrame, relative: (abs: Km, out: Km) => Km): void;
  labels(out: SceneLabel[]): void;
  /** The requested rate and pause (the time machine's controls drive them here). */
  setRun(rate: number, paused: boolean): void;
  readonly rate: number;
  readonly paused: boolean;
  command(c: LabCommand): void;
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
const DOT_SLOTS = 32;
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
/** A share link carries its scenario up to this many characters. */
const SHARE_MAX_CHARS = 8000;
/** Colours (display terms) of the Lagrange points, the encounters and the placing preview. */
const LAGRANGE = [0.55, 0.72, 0.95] as const;
const ENCOUNTER = [0.95, 0.6, 0.4] as const;
const PLACING = [0.6, 0.95, 0.7] as const;
/** The velocity arrow's tip can be taken within this many CSS px; the arrow is drawn this long on screen (its direction is the velocity's; dragging its tip twice as far doubles the speed). */
const HANDLE_PX = 14;
const ARROW_PX = 90;
const DEG = Math.PI / 180;
/** Colours of the lines (display terms): a trail, the chosen body's trail, its prediction, its velocity. */
const TRAIL = [0.16, 0.2, 0.3] as const;
const TRAIL_CHOSEN = [0.55, 0.45, 0.26] as const;
const PREDICTION = [0.35, 0.62, 0.72] as const;
const VELOCITY = [0.75, 0.62, 0.3] as const;

/** Ecliptic (the scenario's frame) to the render frame: (x, z, -y). */
const toRender = (x: number, y: number, z: number, out: Km): Km => {
  out.x = x;
  out.y = z;
  out.z = -y;
  return out;
};

/** A polyline as an orbit path: u runs along it and back (so the hairline never joins its ends). */
function polylinePath(color: readonly [number, number, number]): OrbitPath & { set(points: readonly number[], count: number): void; readonly count: number } {
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

export function createLab(ephemeris: Ephemeris, physical: PhysicalFile, earthMassKg: number, names: Readonly<Record<string, string>>, shapes: Shapes = {}): Lab {
  /** One G for every body: the Earth's GM (km^3 s^-2) over its mass (kg). */
  const gPerKg = physical.gmKm3S2.Earth / earthMassKg;
  let worker: Worker | null = null;
  let generation = 0;
  let active = false;
  let seedScenario: Scenario | null = null;
  let snap: LabSnapshot | null = null;
  let snapAt = 0;
  let rate = 86_400;
  let paused = false;
  let selected: string | null = null;
  let horizonS = DEFAULT_HORIZON_S;
  let prediction: { id: string; horizonS: number; path: Float64Array; merged: { t: number; with: string; pos: [number, number, number] } | null; frame: string | null; framePath: Float64Array; revision: number; encounters: Encounter[] } | null = null;
  let predictedAt = Number.NEGATIVE_INFINITY;
  /** Edits sent to the worker in this generation (its snapshots say how many it had). */
  let sentEdits = 0;
  let status: UniverseLab['status'] = null;
  let saveRequest = 0;
  const saveWaiters = new Map<number, (s: Scenario) => void>();
  let refocus: BodyId | null = null;
  const edited = new Set<string>();
  const seenEvents = new Set<string>();
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
  const trails = new Map<string, { points: number[]; at: number; times: number[] }>();
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
  const MARKER_SLOTS = 10;
  const markers: Impostors = createImpostors(MARKER_SLOTS);
  markers.object.visible = false;
  const markerList: ImpostorDot[] = Array.from({ length: MARKER_SLOTS }, () => ({ position: km(), color: [1, 1, 1] as const, opacity: 0, sizePx: 0, marker: 0 }));
  const dotList: ImpostorDot[] = Array.from({ length: DOT_SLOTS }, () => ({ position: km(), color: [1, 0.9, 0.75] as const, opacity: 0, sizePx: 0, marker: 0 }));
  const labelList: SceneLabel[] = [];
  const scratch = km();
  const abs = km();
  const rel = km();
  const anchor = [0, 0, 0];
  const point = [0, 0, 0];

  const send = (msg: LabRequest, transfer: Transferable[] = []): void => {
    worker?.postMessage(msg, transfer);
  };

  const builtIn = (id: string): BodyId | null => (BODY_IDS as readonly string[]).includes(id) ? (id as BodyId) : null;

  /** A body's place now (scenario frame), carried on from the snapshot along its velocity. */
  const extrapolation = (): number => {
    if (!snap || snap.paused) return 0;
    const dt = Math.min(0.1, (performance.now() - snapAt) / 1000);
    return dt * snap.achievedRate;
  };

  const load = (scenario: Scenario): void => {
    generation += 1;
    sentEdits = 0;
    snap = null;
    prediction = null;
    trails.clear();
    edited.clear();
    seenEvents.clear();
    knownNames.clear();
    if (!worker) {
      worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<LabReply>) => {
        onReply(event.data);
      };
    }
    send({ type: 'load', generation, scenario: structuredClone(scenario) });
    send({ type: 'run', generation, rate, paused });
    requestPrediction();
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

  const onReply = (msg: LabReply): void => {
    // A reply for an older scenario (reset, loaded over, or left) is dropped.
    if (msg.generation !== generation || !active) return;
    if (msg.type === 'snapshot') {
      if (snap && msg.seq <= snap.seq) return;
      snap = msg;
      snapAt = performance.now();
      msg.ids.forEach((id, i) => knownNames.set(id, msg.names[i] ?? id));
      sampleTrails(msg);
      sampleTracked(msg);
      for (const e of msg.events) {
        const key = `${e.step}:${e.absorbed}:${e.kind}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
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
      // As simulated time passes, the prediction (from "now") is redone every eighth of its horizon.
      if (selected && Math.abs(msg.t - predictedAt) > horizonS / 8) requestPrediction();
    } else if (msg.type === 'prediction') {
      if (!prediction || msg.revision >= prediction.revision) prediction = { id: msg.id, horizonS: msg.horizonS, path: msg.path, merged: msg.merged, frame: msg.frame, framePath: msg.framePath, revision: msg.revision, encounters: msg.encounters };
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
        t = { points: [], at: Number.NEGATIVE_INFINITY, times: [] };
        trails.set(id, t);
      }
      if (s.t === t.at) continue;
      t.at = s.t;
      t.points.push(s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0);
      t.times.push(s.t);
      if (t.points.length > TRAIL_POINTS * 3) {
        t.points.splice(0, t.points.length - TRAIL_POINTS * 3);
        t.times.splice(0, t.times.length - TRAIL_POINTS);
      }
    }
    for (const id of [...trails.keys()]) if (!s.ids.includes(id)) trails.delete(id);
  };

  /** Asks the worker for the scenario as it stands (start, settings, edits). */
  const saved = (): Promise<Scenario> =>
    new Promise((resolve) => {
      saveRequest += 1;
      saveWaiters.set(saveRequest, resolve);
      send({ type: 'save', generation, requestId: saveRequest });
    });

  const edit = (command: Command): void => {
    sentEdits += 1;
    send({ type: 'command', generation, command });
    if (command.kind !== 'add') edited.add(command.id);
    else edited.add(command.body.id);
  };

  /** A fresh id for a new body, never used before in this scenario. */
  const freshId = (base: string): string => {
    const used = new Set([...(seedScenario?.bodies.map((b) => b.id) ?? []), ...(snap?.ids ?? []), ...edited]);
    let n = 1;
    while (used.has(`${base}-${n}`)) n += 1;
    return `${base}-${n}`;
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
  });

  /** Body i relative to its primary (scenario frame): the primary's index, position and velocity, and the pair's GM; null without one. */
  const relativeTo = (s: LabSnapshot, i: number): { p: number; r: Vec3; v: Vec3; mu: number } | null => {
    const p = primaryOf(s.gm, s.pos, i);
    if (p < 0) return null;
    const at = (a: Float64Array, k: number): Vec3 => [a[k * 3] ?? 0, a[k * 3 + 1] ?? 0, a[k * 3 + 2] ?? 0];
    return { p, r: sub3(at(s.pos, i), at(s.pos, p)), v: sub3(at(s.vel, i), at(s.vel, p)), mu: (s.gm[p] ?? 0) + (s.gm[i] ?? 0) };
  };
  const posNow = (s: LabSnapshot, i: number, ahead: number): Vec3 => [0, 1, 2].map((k) => (s.pos[i * 3 + k] ?? 0) + (s.vel[i * 3 + k] ?? 0) * ahead) as Vec3;
  const spinOf = (s: LabSnapshot, i: number): Vec3 => [s.spin[i * 3] ?? 0, s.spin[i * 3 + 1] ?? 0, s.spin[i * 3 + 2] ?? 0];

  /** A new body's rotation from a preset's period: prograde (or backwards) about the pole of its orbit. */
  const presetSpin = (preset: Preset | null, orbitPole: readonly number[]): BodySpec['spin'] =>
    preset?.rotationH ? { periodS: Math.abs(preset.rotationH) * 3600, pole: scale3(unit3(orbitPole), preset.rotationH < 0 ? -1 : 1) } : undefined;

  /** The chosen body's velocity arrow: its tip (scenario frame), its length per km/s (s), and the velocity it shows (relative to the primary). */
  const arrow = (s: LabSnapshot, i: number, ahead: number, len: number, shown?: Vec3): { tip: Vec3; len: number; vel: Vec3 } | null => {
    const rel = relativeTo(s, i);
    const vel = shown ?? (rel ? rel.v : ([s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0] as Vec3));
    if (!(norm3(vel) > 0) || !(len > 0)) return null;
    return { tip: add3(posNow(s, i, ahead), scale3(vel, len)), len, vel };
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
    const c = posNow(s, p, extrapolation());
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

  const lab: Lab = {
    objects: [lines.mesh, dots.object, markers.object],
    get active() {
      return active;
    },
    start(seed, jdTdb) {
      active = true;
      selected = null;
      status = null;
      seedScenario = seed === 'solar' ? seedSolarSystem(ephemeris, physical, jdTdb, names, shapes) : seedLaboratory(physical, seed === 'three');
      load(seedScenario);
      lines.mesh.visible = true;
      dots.object.visible = true;
      markers.object.visible = true;
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
      placing = null;
      dragging = null;
      spinDrawn.clear();
    },
    jdTdb() {
      const epoch = seedScenario?.epochJdTdb ?? 0;
      return epoch + ((snap?.t ?? 0) + extrapolation()) / 86_400;
    },
    applyBuiltIns(sys, hidden) {
      hidden.clear();
      if (!snap) return;
      const s = snap;
      const ahead = extrapolation();
      for (const id of BODY_IDS) {
        const i = s.ids.indexOf(id);
        if (i < 0) {
          hidden.add(id);
          continue;
        }
        toRender((s.pos[i * 3] ?? 0) + (s.vel[i * 3] ?? 0) * ahead, (s.pos[i * 3 + 1] ?? 0) + (s.vel[i * 3 + 1] ?? 0) * ahead, (s.pos[i * 3 + 2] ?? 0) + (s.vel[i * 3 + 2] ?? 0) * ahead, sys.bodies[id].position);
      }
      // A world whose spin the visitor set turns as set: from the moment it was set, its drawn pole turned
      // onto the new one (or its opposite, so its north stays the side it was), at the new period. The
      // rest turn as the IAU models have them.
      const spinSet = new Set(s.interventions.filter((x) => x.kind === 'setSpin').map((x) => x.id));
      const tNow = s.t + ahead;
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
    },
    update(frame, relative) {
      lastRelative = relative;
      if (!active || !snap) {
        weights.fill(0);
        return;
      }
      const s = snap;
      const ahead = extrapolation();
      /** Where body `k` is now (scenario frame), carried on from the snapshot. */
      const now = (k: number, out: number[]): number[] => {
        for (let c = 0; c < 3; c += 1) out[c] = (s.pos[k * 3 + c] ?? 0) + (s.vel[k * 3 + c] ?? 0) * ahead;
        return out;
      };
      // The turning frame (view "corotating"): the chosen body's primary A and the heaviest body about it, B;
      // its axes now (e1 from A toward B in the pair's plane, e3 the pair's pole), and how fast the pair turns.
      const pair = viewMode === 'corotating' ? corotatingPair(s) : null;
      const ta = pair ? trails.get(s.ids[pair.a] ?? '') : undefined;
      const tb = pair ? trails.get(s.ids[pair.b] ?? '') : undefined;
      let turning: { aNow: Vec3; e1: Vec3; e2: Vec3; e3: Vec3; omega: number; ta: { points: number[] }; tb: { points: number[] } } | null = null;
      if (pair && ta && tb) {
        const aNow = now(pair.a, [0, 0, 0]) as Vec3;
        const r = sub3(now(pair.b, [0, 0, 0]), aNow);
        const v = [0, 1, 2].map((k) => (s.vel[pair.b * 3 + k] ?? 0) - (s.vel[pair.a * 3 + k] ?? 0));
        const e3 = unit3(cross3(r, v));
        const e1 = unit3(sub3(r, scale3(e3, dot3(r, e3))), [1, 0, 0]);
        turning = { aNow, e1, e2: cross3(e3, e1), e3, omega: norm3(cross3(r, v)) / Math.max(dot3(r, r), 1e-9), ta, tb };
      }
      // The frame turning with the chosen body's primary's own rotation (view "bodyfixed"): its axis and rate.
      let spinning: { a: number; aNow: Vec3; axis: Vec3; omega: number; ta: { points: number[]; times: number[] } } | null = null;
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
      const tNow = s.t + ahead;
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
        const b = s.ids.indexOf(id);
        const p = viewMode !== 'primary' || b < 0 ? -1 : primaryOf(s.gm, s.pos, b);
        const pt = p < 0 ? undefined : trails.get(s.ids[p] ?? '');
        const limit = turning ? Math.min(turning.ta.points.length, turning.tb.points.length) : spinning ? spinning.ta.points.length : pt ? pt.points.length : Number.POSITIVE_INFINITY;
        const n = Math.min(t.points.length, limit) / 3;
        if (n < 2) continue;
        const from = t.points.length / 3 - n;
        const fromP = pt ? pt.points.length / 3 - n : 0;
        const fromA = turning ? turning.ta.points.length / 3 - n : spinning ? spinning.ta.points.length / 3 - n : 0;
        const fromB = turning ? turning.tb.points.length / 3 - n : 0;
        if (pt) now(p, anchor);
        const pts = new Array<number>(n * 3);
        for (let k = 0; k < n; k += 1) {
          if (spinning) {
            // Turned back by the primary's rotation since that sample: the path as the ground under it sees it.
            const sa = spinning.ta.points;
            const rel = [0, 1, 2].map((c) => (t.points[(from + k) * 3 + c] ?? 0) - (sa[(fromA + k) * 3 + c] ?? 0));
            const q = add3(spinning.aNow, rotate3(rel, spinning.axis, spinning.omega * (tNow - (t.times[from + k] ?? tNow))));
            point[0] = q[0];
            point[1] = q[1];
            point[2] = q[2];
          } else if (turning) {
            const at = (arr: number[], k0: number): Vec3 => [arr[k0 * 3] ?? 0, arr[k0 * 3 + 1] ?? 0, arr[k0 * 3 + 2] ?? 0];
            const q = turned(at(t.points, from + k), at(turning.ta.points, fromA + k), at(turning.tb.points, fromB + k), turning);
            point[0] = q[0];
            point[1] = q[1];
            point[2] = q[2];
          } else {
            for (let c = 0; c < 3; c += 1) point[c] = (t.points[(from + k) * 3 + c] ?? 0) + (pt ? (anchor[c] ?? 0) - (pt.points[(fromP + k) * 3 + c] ?? 0) : 0);
          }
          toRender(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, scratch);
          pts[k * 3] = scratch.x;
          pts[k * 3 + 1] = scratch.y;
          pts[k * 3 + 2] = scratch.z;
        }
        if (id === selected) {
          chosenTrail.set(pts, n);
          weights[TRAIL_SLOTS] = 1;
        } else if (slot < TRAIL_SLOTS) {
          trailPaths[slot]?.set(pts, n);
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
        const b = posNow(s, i, ahead);
        const at = relative(toRender(b[0], b[1], b[2], km()), km());
        const rv = relativeTo(s, i)?.v ?? ([s.vel[i * 3] ?? 0, s.vel[i * 3 + 1] ?? 0, s.vel[i * 3 + 2] ?? 0] as Vec3);
        const speedNow = norm3(rv);
        arrowLen = speedNow > 0 ? (ARROW_PX * Math.hypot(at.x, at.y, at.z)) / Math.max(frame.pxPerTan, 1) / speedNow : 0;
      }
      const arrowNow = i >= 0 ? arrow(s, i, ahead, dragging ? dragging.len : arrowLen, shown) : null;
      if (arrowNow) {
        const base = posNow(s, i, ahead);
        const a = toRender(base[0], base[1], base[2], km());
        const b = toRender(arrowNow.tip[0], arrowNow.tip[1], arrowNow.tip[2], km());
        velocityPath.set([a.x, a.y, a.z, b.x, b.y, b.z], 2);
        weights[TRAIL_SLOTS + 2] = 1;
      }
      const orbitFrame: OrbitFrame = { camera: frame.camera, forward: frame.forward, near: frame.near, far: frame.far, focus: frame.focus, focusRadius: frame.focusRadius, focusDistance: frame.focusDistance, compensation: frame.compensation, light: 1, weights };
      lines.update(orbitFrame);

      // The new bodies (not the ten worlds) as points of light, sized by their discs, the chosen one ringed.
      labelList.length = 0;
      let d = 0;
      for (let k = 0; k < s.ids.length && d < DOT_SLOTS; k += 1) {
        const id = s.ids[k] ?? '';
        if (builtIn(id)) continue;
        toRender((s.pos[k * 3] ?? 0) + (s.vel[k * 3] ?? 0) * ahead, (s.pos[k * 3 + 1] ?? 0) + (s.vel[k * 3 + 1] ?? 0) * ahead, (s.pos[k * 3 + 2] ?? 0) + (s.vel[k * 3 + 2] ?? 0) * ahead, abs);
        relative(abs, rel);
        const dot = dotList[d];
        if (!dot) break;
        const distance = Math.max(Math.hypot(rel.x, rel.y, rel.z), 1e-9);
        placeScaled(rel, s.radius[k] ?? 1, frame.far, dot.position);
        const discPx = frame.pxPerTan * Math.tan(Math.asin(Math.min(1, (s.radius[k] ?? 1) / distance)));
        dot.sizePx = Math.max(4, Math.min(40, discPx * 2));
        dot.opacity = 1;
        dot.marker = id === selected ? 1 : 0;
        labelList.push({ id: `lab-${id}`, textKey: 'ui.universe.lab.body', text: s.names[k] ?? id, position: [dot.position.x, dot.position.y, dot.position.z], opacity: 0.9, offset: [10, -10] });
        d += 1;
      }
      for (let k = d; k < DOT_SLOTS; k += 1) {
        const dot = dotList[k];
        if (dot) dot.opacity = 0;
      }
      dots.update(dotList, frame.compensation);

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
          const k = Math.round((e.t / prediction.horizonS) * n) - 1;
          mark(framed(e.pos, k, e.t), ENCOUNTER, 8, 1, knownNames.get(e.with) ?? e.with);
        }
      }
      if (placing && hoverOffset) {
        const p = s.ids.indexOf(placing.primary);
        if (p >= 0) mark(add3(posNow(s, p, ahead), hoverOffset), PLACING, 10, 1, null);
      }
      if (arrowNow && !placing) mark(arrowNow.tip, VELOCITY, dragging ? 12 : 9, 1, null);
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
      rate = next;
      paused = nextPaused;
      send({ type: 'run', generation, rate, paused });
    },
    get rate() {
      return rate;
    },
    get paused() {
      return paused;
    },
    command(c) {
      const s = snap;
      switch (c.kind) {
        case 'start':
          lab.start(c.seed, seedScenario?.epochJdTdb ?? 0);
          return;
        case 'select':
          selected = c.id;
          prediction = null;
          requestPrediction();
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
              if (typeof text === 'string') lab.command({ kind: 'import', text });
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
        case 'importShared':
          void decodeScenario(c.data).then((raw) => {
            if (raw === null) {
              status = { kind: 'error', detail: ['the link’s scenario could not be read'] };
              return;
            }
            lab.command({ kind: 'import', text: JSON.stringify(raw) });
          });
          return;
        case 'removeMany':
          for (const id of c.ids) lab.command({ kind: 'remove', id });
          return;
        case 'duplicateMany':
          for (const id of c.ids) lab.command({ kind: 'duplicate', id });
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
          send({ type: 'seek', generation, step: c.step });
          trails.clear();
          return;
        case 'replay':
          send({ type: 'replay', generation });
          trails.clear();
          return;
        case 'reset':
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
              lab.command({ kind: 'import', text });
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
          selected = null;
          load(checked.scenario);
          status = { kind: 'loaded', detail: [] };
          return;
        }
      }
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
            speedKmS: v,
            primary: p >= 0 ? (s.ids[p] ?? null) : null,
            relativeSpeedKmS: rv,
            distanceKm: rd,
            relativeVelKmS: rel3,
            escapeKmS: Math.sqrt((2 * gm) / Math.max(s.radius[i] ?? 1, 1e-9)),
            edited: edited.has(id),
            persistent: seedScenario.persistentIds?.includes(id) ?? false,
          });
        }
      }
      return {
        name: seedScenario.name,
        seedNote: seedScenario.seedNote,
        frame: seedScenario.frame,
        epochJdTdb: seedScenario.epochJdTdb,
        elapsedS: (s?.t ?? 0) + extrapolation(),
        step: s?.step ?? 0,
        dtS: s?.dt ?? 0,
        requestedRate: rate,
        achievedRate: s?.achievedRate ?? 0,
        paused,
        failure: s?.failure ?? null,
        bodies,
        selected,
        drift: s?.drift ?? { energy: 0, momentum: 0, angularMomentum: 0 },
        interventions: s?.interventions ?? [],
        events: (s?.events ?? []).map((e) => ({ t: e.t, kind: e.kind, regime: e.regime, survivor: e.survivor, absorbed: e.absorbed, speedKmS: e.speedKmS, created: e.created.length, unresolved: e.unresolved > 0, craterKm: e.crater?.diameterKm ?? null, craterComplex: e.crater?.complex ?? false, energyJ: joules(e.energy) })),
        checkpoints: s?.checkpoints ?? [],
        logLength: s?.logLength ?? 0,
        discarded: s?.discarded ?? 0,
        prediction:
          prediction && prediction.id === selected
            ? { id: prediction.id, horizonS: prediction.horizonS, merged: prediction.merged ? { t: prediction.merged.t, with: prediction.merged.with } : null, encounters: prediction.encounters.map((e) => ({ with: e.with, t: e.t, distanceKm: e.distanceKm })) }
            : null,
        horizonS,
        accuracy,
        undoable: s?.undoable ?? 0,
        redoable: s?.redoable ?? 0,
        constrained: (s?.fixed.length ?? 0) > 0,
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
          const ahead = extrapolation();
          const r = measureBetween(posNow(s, a, ahead), posNow(s, b, ahead), s.radius[b] ?? 0);
          const c = m.via === null ? -1 : s.ids.indexOf(m.via);
          return { from: m.from, to: m.to, distanceKm: r.distanceKm, lightS: r.lightS, angularSizeDeg: r.angularSize / DEG, via: c >= 0 ? m.via : null, separationDeg: c >= 0 ? separation(posNow(s, a, ahead), posNow(s, b, ahead), posNow(s, c, ahead)) / DEG : null };
        })(),
        graph: tracked ? { id: tracked.id, quantity: tracked.quantity, points: tracked.points, mergedInto: tracked.mergedInto } : null,
        presets: presetView,
        library,
        share,
        placing: placing ? { primary: placing.primary, name: placing.name, offsetKm: hoverOffset ? norm3(hoverOffset) : null } : null,
        handle: handleAt,
        status,
        names: Object.fromEntries(knownNames),
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
      const a = i < 0 ? null : arrow(s, i, extrapolation(), arrowLen);
      if (!a) return false;
      const tipRel = rel(toRender(a.tip[0], a.tip[1], a.tip[2], km()), km());
      const sp = v.toScreen(tipRel);
      if (!sp || Math.hypot(sp.x - x, sp.y - y) > HANDLE_PX) return false;
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
      const b = posNow(s, i, extrapolation());
      const body = rel(toRender(b[0], b[1], b[2], km()), km());
      d.vel = fromRender((ray.x * t - body.x) / d.len, (ray.y * t - body.y) / d.len, (ray.z * t - body.z) / d.len);
    },
    grabEnd(cancelled) {
      const d = dragging;
      dragging = null;
      if (d && !cancelled && d.vel.every(Number.isFinite)) lab.command({ kind: 'velocity', id: d.id, relativeKmS: d.vel });
    },
    hover(x, y) {
      if (placing) hoverOffset = placeOffset(x, y);
    },
    tap(x, y) {
      if (!placing) return false;
      const off = placeOffset(x, y);
      if (off) addPlaced(off);
      return true;
    },
    get placing() {
      return placing !== null;
    },
    dispose() {
      lab.stop();
      lines.dispose();
      dots.dispose();
      markers.dispose();
    },
  };
  return lab;
}
