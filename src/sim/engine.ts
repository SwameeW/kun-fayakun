import {
  accelerations,
  addBody,
  cloneState,
  diagnostics,
  drift,
  healthy,
  indexOf,
  removeAt,
  resolveContacts,
  step,
  timescale,
  type Diagnostics,
  type MergeEvent,
  type SimState,
} from './nbody';

/**
 * The orbital laboratory's engine: a scenario (its bodies at an epoch, its integrator settings
 * and an ordered log of edits) run forward deterministically.
 *
 * Determinism: the step size depends only on the state and every edit is logged with the step it
 * was applied at, so the same scenario reaches the same state on the same engine whatever the frame
 * rate, however the steps are batched. The step is eta times the shortest dynamical timescale: it
 * shrinks at once when an encounter tightens (the timescale falls below twice what the step allows)
 * and grows only every `retimeSteps` steps and after edits, so it stays fixed for long stretches (a
 * kick-drift-kick leapfrog is symplectic at a fixed step). A change of step keeps encounters resolved
 * but is not itself symplectic: energy is watched (diagnostics, drift since the last edit), not assumed.
 *
 * Time only runs forward. Going back restores a checkpoint (taken before every edit, and every
 * `checkpointSteps` steps) and replays the log from there; an edit made after going back starts a new
 * branch, discarding the later part of the old log (the count is reported). Replay from the start
 * reruns the whole log.
 *
 * Edits are interventions, not drift: each records the diagnostics before and after, and the drift
 * the engine reports is measured from the last intervention.
 */

export const ENGINE_VERSION = 'kf-nbody-1';
export const SCHEMA_VERSION = 1;

export interface IntegratorSettings {
  id: 'kdk-leapfrog';
  /** Step = eta times the shortest dynamical timescale, kept within [dtMinS, dtMaxS]; or exactly fixedDtS when given. */
  eta: number;
  dtMinS: number;
  dtMaxS: number;
  retimeSteps: number;
  fixedDtS: number | null;
}

export const DEFAULT_INTEGRATOR: IntegratorSettings = { id: 'kdk-leapfrog', eta: 0.01, dtMinS: 1, dtMaxS: 86_400, retimeSteps: 64, fixedDtS: null };

/** Where a body's starting values come from. */
export type ValueOrigin = 'observed' | 'modelled' | 'user-edited';

export interface BodySpec {
  id: string;
  name: string;
  /** GM, km^3 s^-2 (0: a test particle). */
  gm: number;
  radiusKm: number;
  /** Position (km) and velocity (km s^-1) in the scenario's frame. */
  pos: [number, number, number];
  vel: [number, number, number];
  origin: ValueOrigin;
  sourceIds: string[];
}

export type Command =
  | { kind: 'setMass'; id: string; gm: number }
  | { kind: 'setVelocity'; id: string; vel: [number, number, number] }
  | { kind: 'add'; body: BodySpec }
  | { kind: 'remove'; id: string };

export interface LoggedCommand {
  step: number;
  command: Command;
}

export interface Scenario {
  schemaVersion: number;
  engineVersion: string;
  name: string;
  /** The epoch the bodies are given at (TDB Julian date) and the frame they are given in. */
  epochJdTdb: number;
  frame: string;
  /** How the starting state was made (its approximations), in words. */
  seedNote: string;
  integrator: IntegratorSettings;
  bodies: BodySpec[];
  log: LoggedCommand[];
  /** Bodies that keep their identity in any merger and cannot be removed (the scene's light source). */
  persistentIds?: string[];
}

export interface Intervention {
  step: number;
  t: number;
  command: Command;
  before: Diagnostics;
  after: Diagnostics;
}

export interface Checkpoint {
  step: number;
  t: number;
  state: SimState;
  dt: number;
  /** Log entries already applied when it was taken. */
  logIndex: number;
}

export interface PredictionResult {
  id: string;
  /** Positions of the body (km, three per sample) every horizon / samples seconds from now; and where a merger ended the path. */
  path: number[];
  merged: { t: number; with: string; pos: [number, number, number] } | null;
}

const MAX_CHECKPOINTS = 48;

export function stateFrom(bodies: readonly BodySpec[]): SimState {
  const s: SimState = { ids: [], names: [], gm: [], radius: [], pos: [], vel: [], spin: [], t: 0, step: 0, internal: 0 };
  for (const b of bodies) addBody(s, { id: b.id, name: b.name, gm: b.gm, radiusKm: b.radiusKm, pos: b.pos, vel: b.vel });
  return s;
}

export class Engine {
  readonly scenario: Scenario;
  state: SimState;
  dt = 0;
  private acc: number[] = [];
  /** Log entries applied so far (the rest replay as the steps reach them). */
  private logIndex = 0;
  readonly checkpoints: Checkpoint[] = [];
  readonly interventions: Intervention[] = [];
  readonly events: MergeEvent[] = [];
  /** The diagnostics drift is measured from (the last intervention's after). */
  reference: Diagnostics;
  /** Log entries discarded by the last branching edit. */
  discarded = 0;
  /** Why the run stopped, if it did (non-finite numbers): it pauses at the last good checkpoint. */
  failure: string | null = null;
  private lastPeriodic = 0;

  /** Whether a body keeps its identity in a merger (Scenario.persistentIds). */
  readonly keep = (id: string): boolean => this.scenario.persistentIds?.includes(id) ?? false;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.state = stateFrom(scenario.bodies);
    resolveContacts(this.state, 0, null, this.events, this.keep);
    this.retime();
    this.reference = diagnostics(this.state);
    this.checkpoint();
  }

  /** The step size the state calls for now (or for a timescale already found). */
  private retime(shortest = timescale(this.state)): void {
    const g = this.scenario.integrator;
    this.dt = g.fixedDtS ?? Math.min(g.dtMaxS, Math.max(g.dtMinS, g.eta * shortest));
    if (!Number.isFinite(this.dt)) this.dt = g.dtMaxS;
  }

  private checkpoint(): void {
    this.checkpoints.push({ step: this.state.step, t: this.state.t, state: cloneState(this.state), dt: this.dt, logIndex: this.logIndex });
    // Bounded: the oldest periodic checkpoints go first; the first (the scenario's start) stays.
    while (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.splice(1, 1);
  }

  /** Applies the logged edits due at the current step. */
  private applyDue(): void {
    const log = this.scenario.log;
    while (this.logIndex < log.length && (log[this.logIndex]?.step ?? Infinity) <= this.state.step) {
      const entry = log[this.logIndex];
      this.logIndex += 1;
      if (entry) this.execute(entry.command);
    }
  }

  /** Carries out an edit on the state, recording it as an intervention. */
  private execute(command: Command): void {
    const before = diagnostics(this.state);
    const s = this.state;
    switch (command.kind) {
      case 'setMass': {
        const i = indexOf(s, command.id);
        if (i >= 0 && Number.isFinite(command.gm) && command.gm >= 0) s.gm[i] = command.gm;
        break;
      }
      case 'setVelocity': {
        const i = indexOf(s, command.id);
        if (i >= 0 && command.vel.every(Number.isFinite)) for (let k = 0; k < 3; k += 1) s.vel[i * 3 + k] = command.vel[k] ?? 0;
        break;
      }
      case 'add':
        if (indexOf(s, command.body.id) < 0) addBody(s, { id: command.body.id, name: command.body.name, gm: command.body.gm, radiusKm: command.body.radiusKm, pos: command.body.pos, vel: command.body.vel });
        break;
      case 'remove': {
        const i = indexOf(s, command.id);
        if (i >= 0 && !this.keep(command.id)) removeAt(s, i);
        break;
      }
    }
    // Bodies placed touching one another merge before any force is felt.
    resolveContacts(s, 0, null, this.events, this.keep);
    this.acc.length = 0;
    this.retime();
    const after = diagnostics(s);
    this.interventions.push({ step: s.step, t: s.t, command, before, after });
    this.reference = after;
  }

  /** An edit from the visitor, at the current step: a checkpoint first; if later edits were logged (after going back), they are discarded (a new branch). */
  apply(command: Command): void {
    const log = this.scenario.log;
    this.discarded = log.length - this.logIndex;
    log.length = this.logIndex;
    this.checkpoint();
    log.push({ step: this.state.step, command });
    this.applyDue();
  }

  /** Runs whole steps until simulated time reaches `t` or `maxSteps` are taken; returns the steps taken. */
  advanceTo(t: number, maxSteps: number): number {
    let taken = 0;
    while (taken < maxSteps && this.state.t + this.dt <= t && !this.failure) {
      this.stepOnce();
      taken += 1;
    }
    return taken;
  }

  stepOnce(): void {
    this.applyDue();
    const shortest = step(this.state, this.dt, this.acc, this.events, this.keep);
    if (!healthy(this.state)) {
      this.failure = 'non-finite';
      this.restore(this.checkpoints[this.checkpoints.length - 1]?.step ?? 0, false);
      return;
    }
    // Shrink at once for a tightening encounter; otherwise retime (and grow) only every retimeSteps.
    const g = this.scenario.integrator;
    if (g.fixedDtS === null && (g.eta * shortest < 0.5 * this.dt || this.state.step % g.retimeSteps === 0)) this.retime(shortest);
    if (this.state.step - this.lastPeriodic >= checkpointSteps(this.dt)) {
      this.lastPeriodic = this.state.step;
      this.checkpoint();
    }
  }

  /** Goes back (or forward) to `targetStep`: the latest checkpoint at or before it, then the log replayed up to it. */
  restore(targetStep: number, replayTo = true): void {
    let best: Checkpoint | undefined;
    for (const c of this.checkpoints) if (c.step <= targetStep && (!best || c.step >= best.step)) best = c;
    const c = best ?? this.checkpoints[0];
    if (!c) return;
    this.state = cloneState(c.state);
    this.dt = c.dt;
    this.logIndex = c.logIndex;
    this.acc.length = 0;
    this.reference = diagnostics(this.state);
    this.lastPeriodic = this.state.step;
    // Checkpoints later than this one belong to a future that is no longer certain: keep them (the log replays the same way) unless a new edit branches.
    if (replayTo) while (this.state.step < targetStep && !this.failure) this.stepOnce();
  }

  /** The visitor going back (or forward) to a step: clears a stop for non-finite numbers, then restores and replays. */
  seek(targetStep: number): void {
    this.failure = null;
    this.restore(targetStep);
  }

  /** Back to the scenario's start, the whole log kept to replay as the steps reach it. */
  replayFromStart(): void {
    this.failure = null;
    this.restore(0, false);
  }

  /** Integrates a copy of the current state `horizonS` ahead with the same rules, sampling body `id` `samples` times (all at once: see Prediction for the sliced form). */
  predict(id: string, horizonS: number, samples: number, maxSteps: number): PredictionResult {
    const p = new Prediction(this, id, horizonS, samples, maxSteps);
    p.work(Number.POSITIVE_INFINITY);
    return p.result();
  }

  /** Drift since the last intervention (relative to its own scales). */
  drift(): { energy: number; momentum: number; angularMomentum: number } {
    return drift(this.reference, diagnostics(this.state));
  }

  /** The scenario as saved: its start, settings and the log so far (not the derived state). */
  toScenario(): Scenario {
    return { ...this.scenario, bodies: this.scenario.bodies.map((b) => ({ ...b, pos: [...b.pos], vel: [...b.vel], sourceIds: [...b.sourceIds] })), log: this.scenario.log.map((e) => ({ step: e.step, command: structuredCloneCommand(e.command) })) };
  }

  /** Accelerations now (for readouts). */
  accelerations(): number[] {
    const out: number[] = [];
    accelerations(this.state, out);
    return out;
  }
}

/**
 * A prediction: a copy of the engine's state integrated `horizonS` ahead with the same force model
 * and step rules, sampling one body's path, resumable a few steps at a time (work) so it never holds
 * up the live run, and stopped early where the body merges (its last point is the merger's place).
 * Edits logged for later steps are not applied to it: it predicts the system as it now stands.
 */
export class Prediction {
  private readonly copy: SimState;
  private readonly acc: number[] = [];
  private readonly events: MergeEvent[] = [];
  private readonly start: number;
  private readonly g: IntegratorSettings;
  private readonly keep: (id: string) => boolean;
  private dt: number;
  private steps = 0;
  private k = 1;
  private readonly path: number[] = [];
  private merged: PredictionResult['merged'] = null;
  done = false;

  constructor(
    engine: Engine,
    readonly id: string,
    readonly horizonS: number,
    readonly samples: number,
    readonly maxSteps: number,
  ) {
    this.copy = cloneState(engine.state);
    this.start = this.copy.t;
    this.dt = engine.dt;
    this.g = engine.scenario.integrator;
    this.keep = engine.keep;
    if (indexOf(this.copy, id) < 0) this.done = true;
  }

  /** Up to `budget` more steps; true when the prediction is complete. */
  work(budget: number): boolean {
    const copy = this.copy;
    const g = this.g;
    let used = 0;
    while (!this.done && used < budget) {
      const until = this.start + (this.horizonS * this.k) / this.samples;
      if (copy.t + this.dt <= until && this.steps < this.maxSteps) {
        const shortest = step(copy, this.dt, this.acc, this.events, this.keep);
        this.steps += 1;
        used += 1;
        // The same retiming as the live run's.
        if (g.fixedDtS === null && (g.eta * shortest < 0.5 * this.dt || copy.step % g.retimeSteps === 0)) this.dt = Math.min(g.dtMaxS, Math.max(g.dtMinS, g.eta * shortest));
        const e = this.events.find((ev) => ev.absorbed === this.id);
        if (e) {
          const i = indexOf(copy, e.survivor);
          this.merged = { t: copy.t - this.start, with: e.survivor, pos: [copy.pos[i * 3] ?? 0, copy.pos[i * 3 + 1] ?? 0, copy.pos[i * 3 + 2] ?? 0] };
          this.path.push(...this.merged.pos);
          this.done = true;
        }
        continue;
      }
      // A sample, then on to the next (or done: the horizon reached, or the step budget spent).
      const i = indexOf(copy, this.id);
      if (i >= 0) this.path.push(copy.pos[i * 3] ?? 0, copy.pos[i * 3 + 1] ?? 0, copy.pos[i * 3 + 2] ?? 0);
      this.k += 1;
      if (this.k > this.samples || this.steps >= this.maxSteps || i < 0) this.done = true;
    }
    return this.done;
  }

  result(): PredictionResult {
    return { id: this.id, path: [...this.path], merged: this.merged };
  }
}

/** A periodic checkpoint every this many steps (about 2,000, fewer when the steps are long). */
function checkpointSteps(dt: number): number {
  return Math.max(200, Math.round(2000 * Math.min(1, 3600 / Math.max(dt, 1))));
}

function structuredCloneCommand(c: Command): Command {
  switch (c.kind) {
    case 'add':
      return { kind: 'add', body: { ...c.body, pos: [...c.body.pos], vel: [...c.body.vel], sourceIds: [...c.body.sourceIds] } };
    case 'setVelocity':
      return { kind: 'setVelocity', id: c.id, vel: [...c.vel] };
    default:
      return { ...c };
  }
}

/** Limits on an imported scenario (a file could ask for anything). */
export const IMPORT_LIMITS = { bodies: 64, log: 5000, nameLength: 60, coordinateKm: 1e12, speedKmS: 3e5, gm: 1e14, radiusKm: 1e7 } as const;

/**
 * A scenario from a parsed file, or the reasons it is refused: unsupported version, missing or
 * non-finite numbers, impossible sizes, too many bodies or edits, duplicate ids, edits naming
 * bodies that never exist. Names are kept as text (the interface never renders them as HTML).
 */
export function validateScenario(raw: unknown): { ok: true; scenario: Scenario } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const L = IMPORT_LIMITS;
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const vec = (v: unknown, limit: number): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, -limit, limit));
  if (!obj(raw)) return { ok: false, errors: ['not a scenario object'] };
  if (raw.schemaVersion !== SCHEMA_VERSION) errors.push(`unsupported schema version ${String(raw.schemaVersion)} (this engine reads ${SCHEMA_VERSION})`);
  if (typeof raw.engineVersion !== 'string') errors.push('missing engine version');
  if (!num(raw.epochJdTdb, 0, 1e7)) errors.push('epoch is not a valid Julian date');
  const integrator = raw.integrator;
  if (!obj(integrator) || integrator.id !== 'kdk-leapfrog' || !num(integrator.eta, 1e-5, 0.1) || !num(integrator.dtMinS, 1e-3, 1e7) || !num(integrator.dtMaxS, 1e-3, 1e8) || !num(integrator.retimeSteps, 1, 1e6) || !(integrator.fixedDtS === null || num(integrator.fixedDtS, 1e-3, 1e8))) {
    errors.push('integrator settings are not valid');
  }
  const bodies: unknown[] = Array.isArray(raw.bodies) ? raw.bodies : [];
  if (!Array.isArray(raw.bodies) || bodies.length === 0) errors.push('no bodies');
  if (bodies.length > L.bodies) errors.push(`${bodies.length} bodies (at most ${L.bodies})`);
  const ids = new Set<string>();
  const body = (b: unknown, where: string): b is BodySpec => {
    if (!obj(b)) {
      errors.push(`${where}: not a body`);
      return false;
    }
    const ok =
      typeof b.id === 'string' && /^[a-z0-9-]{1,40}$/u.test(b.id) &&
      typeof b.name === 'string' && b.name.length > 0 && b.name.length <= L.nameLength &&
      num(b.gm, 0, L.gm) && num(b.radiusKm, 1e-6, L.radiusKm) && vec(b.pos, L.coordinateKm) && vec(b.vel, L.speedKmS) &&
      (b.origin === 'observed' || b.origin === 'modelled' || b.origin === 'user-edited') && Array.isArray(b.sourceIds) && b.sourceIds.every((x) => typeof x === 'string');
    if (!ok) errors.push(`${where}: a value is missing, not finite or out of range`);
    return ok;
  };
  bodies.slice(0, L.bodies).forEach((b, i) => {
    if (body(b, `bodies[${i}]`)) {
      if (ids.has(b.id)) errors.push(`bodies[${i}]: duplicate id ${b.id}`);
      ids.add(b.id);
    }
  });
  const log: unknown[] = Array.isArray(raw.log) ? raw.log : [];
  if (!Array.isArray(raw.log)) errors.push('no edit log');
  if (log.length > L.log) errors.push(`${log.length} edits (at most ${L.log})`);
  let lastStep = 0;
  log.slice(0, L.log).forEach((e, i) => {
    const where = `log[${i}]`;
    if (!obj(e) || !num(e.step, 0, 1e12) || !obj(e.command)) {
      errors.push(`${where}: not an edit`);
      return;
    }
    if (e.step < lastStep) errors.push(`${where}: out of step order`);
    lastStep = e.step;
    const c = e.command;
    if (c.kind === 'add') {
      if (body(c.body, `${where}.body`)) {
        if (ids.has(c.body.id)) errors.push(`${where}: adds an id that already exists (${c.body.id})`);
        ids.add(c.body.id);
      }
    } else if (c.kind === 'setMass' || c.kind === 'setVelocity' || c.kind === 'remove') {
      if (typeof c.id !== 'string' || !ids.has(c.id)) errors.push(`${where}: names a body that does not exist`);
      if (c.kind === 'setMass' && !num(c.gm, 0, L.gm)) errors.push(`${where}: mass out of range`);
      if (c.kind === 'setVelocity' && !vec(c.vel, L.speedKmS)) errors.push(`${where}: velocity out of range`);
    } else {
      errors.push(`${where}: unknown edit`);
    }
  });
  if (raw.persistentIds !== undefined && !(Array.isArray(raw.persistentIds) && raw.persistentIds.every((id) => typeof id === 'string' && ids.has(id)))) errors.push('persistent ids must name bodies of the scenario');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scenario: raw as unknown as Scenario };
}
