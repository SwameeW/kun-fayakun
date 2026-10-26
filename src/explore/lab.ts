import type { Object3D } from 'three/webgpu';
import type { Ephemeris } from '../astro/ephemeris';
import type { PhysicalFile } from '../astro/physical';
import { BODY_IDS, type BodyId, type LabCommand, type SceneLabel, type UniverseLab, type UniverseLabBody } from '../core/types';
import { validateScenario, type BodySpec, type Command, type Scenario } from '../sim/engine';
import { joules } from '../sim/craters';
import { circularOrbit, consumes, primaryOf, type SimState } from '../sim/nbody';
import type { LabReply, LabRequest, LabSnapshot } from '../sim/protocol';
import { seedLaboratory, seedSolarSystem } from '../sim/seed';
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
  dispose(): void;
}

const TRAIL_SLOTS = 24;
const TRAIL_POINTS = 384;
const DOT_SLOTS = 32;
const DEFAULT_HORIZON_S = 60 * 86_400;
const SAVE_KEY = 'current';
const DB_NAME = 'kf-lab';
const STORE = 'scenarios';
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

export function createLab(ephemeris: Ephemeris, physical: PhysicalFile, earthMassKg: number, names: Readonly<Record<string, string>>): Lab {
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
  let prediction: { id: string; horizonS: number; path: Float64Array; merged: { t: number; with: string; pos: [number, number, number] } | null; frame: string | null; framePath: Float64Array; revision: number } | null = null;
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

  // Trails: each body's recent positions (scenario frame, km), sampled once a snapshot.
  const trails = new Map<string, { points: number[]; at: number }>();
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
    send({ type: 'predict', generation, id: selected, horizonS });
    predictedAt = snap?.t ?? 0;
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
      if (!prediction || msg.revision >= prediction.revision) prediction = { id: msg.id, horizonS: msg.horizonS, path: msg.path, merged: msg.merged, frame: msg.frame, framePath: msg.framePath, revision: msg.revision };
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
        t = { points: [], at: Number.NEGATIVE_INFINITY };
        trails.set(id, t);
      }
      if (s.t === t.at) continue;
      t.at = s.t;
      t.points.push(s.pos[i * 3] ?? 0, s.pos[i * 3 + 1] ?? 0, s.pos[i * 3 + 2] ?? 0);
      if (t.points.length > TRAIL_POINTS * 3) t.points.splice(0, t.points.length - TRAIL_POINTS * 3);
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
    t: s.t,
    step: s.step,
    internal: 0,
    passing: [],
  });

  const lab: Lab = {
    objects: [lines.mesh, dots.object],
    get active() {
      return active;
    },
    start(seed, jdTdb) {
      active = true;
      selected = null;
      status = null;
      seedScenario = seed === 'solar' ? seedSolarSystem(ephemeris, physical, jdTdb, names) : seedLaboratory(physical, seed === 'three');
      load(seedScenario);
      lines.mesh.visible = true;
      dots.object.visible = true;
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
    },
    update(frame, relative) {
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
      // Trails, each about its primary as the real explorer draws orbits (a moon's about its planet, not
      // smeared along the planet's path); the chosen body's in gold, the rest faint (as many as there are slots).
      // Every trail is sampled at the same snapshots, so two trails line up from their ends.
      let slot = 0;
      weights.fill(0);
      for (const [id, t] of trails) {
        const b = s.ids.indexOf(id);
        const p = b < 0 ? -1 : primaryOf(s.gm, s.pos, b);
        const pt = p < 0 ? undefined : trails.get(s.ids[p] ?? '');
        const n = Math.min(t.points.length, pt ? pt.points.length : Number.POSITIVE_INFINITY) / 3;
        if (n < 2) continue;
        const from = t.points.length / 3 - n;
        const fromP = pt ? pt.points.length / 3 - n : 0;
        if (pt) now(p, anchor);
        const pts = new Array<number>(n * 3);
        for (let k = 0; k < n; k += 1) {
          for (let c = 0; c < 3; c += 1) point[c] = (t.points[(from + k) * 3 + c] ?? 0) + (pt ? (anchor[c] ?? 0) - (pt.points[(fromP + k) * 3 + c] ?? 0) : 0);
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
      // The prediction (about the body it moved about when it was made, where that body is now), and the
      // velocity relative to the primary (a day's travel, at least a tenth of the way to it).
      const i = selected ? s.ids.indexOf(selected) : -1;
      if (prediction && i >= 0 && prediction.id === selected && prediction.path.length >= 6) {
        const n = prediction.path.length / 3;
        const f = prediction.frame === null ? -1 : s.ids.indexOf(prediction.frame);
        const about = f >= 0 && prediction.framePath.length === prediction.path.length;
        if (about) now(f, anchor);
        const pts = new Array<number>(n * 3);
        for (let k = 0; k < n; k += 1) {
          for (let c = 0; c < 3; c += 1) point[c] = (prediction.path[k * 3 + c] ?? 0) + (about ? (anchor[c] ?? 0) - (prediction.framePath[k * 3 + c] ?? 0) : 0);
          toRender(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, scratch);
          pts[k * 3] = scratch.x;
          pts[k * 3 + 1] = scratch.y;
          pts[k * 3 + 2] = scratch.z;
        }
        predictionPath.set(pts, n);
        weights[TRAIL_SLOTS + 1] = 1;
      }
      if (i >= 0) {
        const p = primaryOf(s.gm, s.pos, i);
        const vx = (s.vel[i * 3] ?? 0) - (p >= 0 ? (s.vel[p * 3] ?? 0) : 0);
        const vy = (s.vel[i * 3 + 1] ?? 0) - (p >= 0 ? (s.vel[p * 3 + 1] ?? 0) : 0);
        const vz = (s.vel[i * 3 + 2] ?? 0) - (p >= 0 ? (s.vel[p * 3 + 2] ?? 0) : 0);
        const v = Math.hypot(vx, vy, vz);
        const dist = p >= 0 ? Math.hypot((s.pos[i * 3] ?? 0) - (s.pos[p * 3] ?? 0), (s.pos[i * 3 + 1] ?? 0) - (s.pos[p * 3 + 1] ?? 0), (s.pos[i * 3 + 2] ?? 0) - (s.pos[p * 3 + 2] ?? 0)) : v * 86_400;
        const len = v > 0 ? Math.max(v * 86_400, dist * 0.1) / v : 0;
        const x0 = (s.pos[i * 3] ?? 0) + (s.vel[i * 3] ?? 0) * ahead;
        const y0 = (s.pos[i * 3 + 1] ?? 0) + (s.vel[i * 3 + 1] ?? 0) * ahead;
        const z0 = (s.pos[i * 3 + 2] ?? 0) + (s.vel[i * 3 + 2] ?? 0) * ahead;
        const a = toRender(x0, y0, z0, km());
        const b = toRender(x0 + vx * len, y0 + vy * len, z0 + vz * len, km());
        velocityPath.set([a.x, a.y, a.z, b.x, b.y, b.z], 2);
        weights[TRAIL_SLOTS + 2] = v > 0 ? 1 : 0;
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
        case 'mass':
          if (Number.isFinite(c.massKg) && c.massKg >= 0) edit({ kind: 'setMass', id: c.id, gm: c.massKg * gPerKg });
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
            const r = [0, 1, 2].map((k) => (pos[k] ?? 0) - (s.pos[p * 3 + k] ?? 0));
            const v = [0, 1, 2].map((k) => (vel[k] ?? 0) - (s.vel[p * 3 + k] ?? 0));
            const pole = poleOf(s, i);
            const n = Math.hypot(...pole) || 1;
            const u = pole.map((x) => x / n);
            const rot = (w: number[]): number[] => {
              // Rodrigues: about the pole by 60 degrees.
              const c60 = 0.5;
              const s60 = Math.sqrt(3) / 2;
              const dot = (u[0] ?? 0) * (w[0] ?? 0) + (u[1] ?? 0) * (w[1] ?? 0) + (u[2] ?? 0) * (w[2] ?? 0);
              const cr = [(u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0), (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0), (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0)];
              return [0, 1, 2].map((k) => (w[k] ?? 0) * c60 + (cr[k] ?? 0) * s60 + (u[k] ?? 0) * dot * (1 - c60));
            };
            const r2 = rot(r);
            const v2 = rot(v);
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
          bodies.push({
            id,
            name: s.names[i] ?? id,
            builtIn: builtIn(id),
            gm,
            massKg: gm / gPerKg,
            radiusKm: s.radius[i] ?? 0,
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
        prediction: prediction && prediction.id === selected ? { id: prediction.id, horizonS: prediction.horizonS, merged: prediction.merged ? { t: prediction.merged.t, with: prediction.merged.with } : null } : null,
        horizonS,
        status,
        names: Object.fromEntries(knownNames),
      };
    },
    takeRefocus() {
      const r = refocus;
      refocus = null;
      return r;
    },
    dispose() {
      lab.stop();
      lines.dispose();
      dots.dispose();
    },
  };
  return lab;
}
