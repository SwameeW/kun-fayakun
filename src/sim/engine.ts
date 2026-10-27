import {
  accelerations,
  addBody,
  cloneState,
  consumes,
  diagnostics,
  drift,
  emptyState,
  healthy,
  indexOf,
  MAX_BODIES,
  primaryOf,
  removeAt,
  resolveContacts,
  spinVector,
  step,
  timescale,
  UNIFORM_INERTIA,
  type Diagnostics,
  type MergeEvent,
  type SimState,
  successorIn,
} from './nbody';
import { brightestStar, CLIMATE_STEP_S, mainSequenceLuminosityW, settleClimate, STAR_MIN_GM, startingBands, stepClimates, SUN_GM, type ClimateSpec } from './climate';
import { BURN_DIRECTIONS, burnStep, planBurn, type Burn, type ShipSpec } from './ships';
import { makeSwarm, particleCount, rehomeSwarms, ringPlaces, SWARM_LIMITS, swarmHomes, type SwarmSpec } from './swarms';

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
 * reruns the whole log. Playing the history backwards (./rewind) replays it the same way, with a
 * replica made from a checkpoint (the constructor's `from`), and puts the run back with restoreFrom.
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
  /** Its rotation (once every periodS seconds, prograde about the unit pole, scenario frame); none: it does not turn. */
  spin?: { periodS: number; pole: [number, number, number] };
  /** Its J2 (flattening's lowest zonal harmonic, normalised to its radius; 0 or none: spherical) and moment of inertia factor (I / M R^2; none: 0.4). */
  j2?: number;
  inertia?: number;
  /** A star's luminosity (W) at this mass (a body of 0.075 solar masses or more without one shines by the main-sequence relation: ./climate). */
  luminosityW?: number;
  /** A solid world's climate (./climate); none: no climate is kept for it. */
  climate?: ClimateSpec;
  /** A ship (./ships): its dry mass and propellant (kg), its engine's thrust (N) and specific impulse (s); it should weigh nothing in GM (a test particle). */
  ship?: ShipSpec;
}

export type Command =
  | { kind: 'setMass'; id: string; gm: number }
  | { kind: 'setVelocity'; id: string; vel: [number, number, number] }
  | { kind: 'setState'; id: string; pos: [number, number, number]; vel: [number, number, number] }
  | { kind: 'setRadius'; id: string; radiusKm: number; gm?: number }
  | { kind: 'setSpin'; id: string; periodS: number; pole: [number, number, number] }
  | { kind: 'setFixed'; id: string; fixed: boolean }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'add'; body: BodySpec }
  | { kind: 'remove'; id: string }
  /** A ring or belt of test particles (./swarms), and its removal. */
  | { kind: 'addSwarm'; swarm: SwarmSpec }
  | { kind: 'removeSwarm'; id: string }
  /** A gravitating ring: `count` bodies of `gm` in all, on near-circular orbits (ids `<id>-1` on). */
  | { kind: 'addRing'; ring: RingSpec }
  /** A world's atmosphere changed (./climate): a grey atmosphere's infrared optical depth, a greenhouse forcing (W/m^2) on the Earth's model, its surface pressure (Pa). */
  | { kind: 'setAtmosphere'; id: string; tau?: number; forcing?: number; pressurePa?: number }
  /** A ship's burn (./ships), planned for its start time (at once if that has passed), and all its planned burns called off. */
  | { kind: 'burn'; id: string; burn: Burn }
  | { kind: 'cancelBurns'; id: string };

/** A gravitating ring as made: its bodies are ordinary bodies from then on. */
export interface RingSpec {
  id: string;
  name: string;
  primary: string;
  count: number;
  innerKm: number;
  outerKm: number;
  /** All its bodies' GM together (km^3 s^-2), and each one's radius (km). */
  gm: number;
  radiusKm: number;
  normal: [number, number, number];
  seed: number;
}

/** The most bodies a gravitating ring makes. */
export const RING_MAX_BODIES = 24;

/** The body, swarm or ring an edit is about. */
export const commandId = (c: Command): string => (c.kind === 'add' ? c.body.id : c.kind === 'addSwarm' ? c.swarm.id : c.kind === 'addRing' ? c.ring.id : c.id);

/**
 * A body's light and climate into the state as its spec gives them: a star's luminosity (or, heavy
 * enough, the main-sequence relation's), and a solid world's climate (returning its id, to settle
 * once every star is in place).
 */
function lightAndClimate(s: SimState, b: BodySpec): string | null {
  if (b.luminosityW !== undefined && b.luminosityW > 0) s.stars[b.id] = { watts: b.luminosityW, gm: b.gm };
  else if (b.gm >= STAR_MIN_GM) s.stars[b.id] = { watts: mainSequenceLuminosityW(b.gm / SUN_GM), gm: b.gm };
  if (!b.climate || b.gm >= STAR_MIN_GM) return null;
  s.climate[b.id] = { spec: { ...b.climate }, t: startingBands(b.climate) };
  return b.id;
}

/** Climates just made put in balance with their light now. */
function settle(s: SimState, ids: readonly string[]): void {
  for (const id of ids) {
    const i = indexOf(s, id);
    if (i >= 0) settleClimate(s, i, brightestStar(s, i));
  }
}

/** Light and climates of bodies that are gone (merged, removed) dropped. */
function pruneGone(s: SimState): void {
  if (Object.keys(s.stars).some((id) => indexOf(s, id) < 0)) s.stars = Object.fromEntries(Object.entries(s.stars).filter(([id]) => indexOf(s, id) >= 0));
  if (Object.keys(s.climate).some((id) => indexOf(s, id) < 0)) s.climate = Object.fromEntries(Object.entries(s.climate).filter(([id]) => indexOf(s, id) >= 0));
}

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
  /** The body it moved about at the start (its primary, followed through mergers), with its positions at the same samples, so the path can be drawn as an orbit about it; null and empty for none. */
  frame: string | null;
  framePath: number[];
  /** Its closest approaches to other bodies (at most ENCOUNTERS, nearest first relative to their size): when (s from now), how close (km between centres), where it is then and where the other is. */
  encounters: Encounter[];
}

export interface Encounter {
  with: string;
  t: number;
  distanceKm: number;
  pos: [number, number, number];
  otherPos: [number, number, number];
}

/** The closest approaches a prediction reports. */
export const ENCOUNTERS = 3;

const MAX_CHECKPOINTS = 48;

/** A body spec's state: its rotation as a spin angular momentum, its J2 and moment of inertia factor. */
function bodyOf(b: BodySpec): Parameters<typeof addBody>[1] {
  const inertia = b.inertia ?? UNIFORM_INERTIA;
  return { id: b.id, name: b.name, gm: b.gm, radiusKm: b.radiusKm, pos: b.pos, vel: b.vel, spin: b.spin ? spinVector(b.gm, b.radiusKm, inertia, b.spin.periodS, b.spin.pole) : undefined, j2: b.j2 ?? 0, inertia };
}

export function stateFrom(bodies: readonly BodySpec[]): SimState {
  const s = emptyState();
  const made: string[] = [];
  for (const b of bodies) {
    addBody(s, bodyOf(b));
    const id = lightAndClimate(s, b);
    if (id) made.push(id);
  }
  settle(s, made);
  return s;
}

export class Engine {
  readonly scenario: Scenario;
  state: SimState;
  dt = 0;
  private acc: number[] = [];
  /** Log entries applied so far (the rest replay as the steps reach them). */
  private logIndex = 0;
  /** Checkpoints in order of step (at most MAX_CHECKPOINTS, spread over the whole run: see checkpoint()). */
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
  /** Edits undone, the latest last, for redo (cleared by any new edit). */
  private readonly undone: LoggedCommand[] = [];

  /** Whether a body keeps its identity in a merger (Scenario.persistentIds). */
  readonly keep = (id: string): boolean => this.scenario.persistentIds?.includes(id) ?? false;

  /**
   * A scenario run from its start; or, given `from` (one of another engine's checkpoints for the same
   * scenario), a replica that goes on from that checkpoint exactly as the run did, without touching
   * that engine (./rewind replays history with one). A replica only reads the scenario's log.
   */
  constructor(scenario: Scenario, from?: Checkpoint) {
    this.scenario = scenario;
    if (from) {
      this.state = cloneState(from.state);
      this.dt = from.dt;
      this.logIndex = from.logIndex;
      this.lastPeriodic = from.step;
      this.reference = diagnostics(this.state);
      return;
    }
    this.state = stateFrom(scenario.bodies);
    resolveContacts(this.state, 0, null, this.events, this.keep);
    this.retime();
    this.reference = diagnostics(this.state);
    this.checkpoint();
  }

  /** Log entries applied so far: what a checkpoint taken now would record. */
  get applied(): number {
    return this.logIndex;
  }

  /** The state now as a checkpoint (a deep copy; without the rings' particles when `withSwarms` is false). */
  snapshotNow(withSwarms = true): Checkpoint {
    return { step: this.state.step, t: this.state.t, state: cloneState(this.state, withSwarms), dt: this.dt, logIndex: this.logIndex };
  }

  /** The step size the state calls for now (or for a timescale already found). */
  private retime(shortest = timescale(this.state)): void {
    const g = this.scenario.integrator;
    this.dt = g.fixedDtS ?? Math.min(g.dtMaxS, Math.max(g.dtMinS, g.eta * shortest));
    if (!Number.isFinite(this.dt)) this.dt = g.dtMaxS;
  }

  /**
   * Takes a checkpoint, kept in order of step (a run gone back over and run again takes them again:
   * one already held for the same step and edits is not repeated). Bounded: past MAX_CHECKPOINTS, the
   * one whose loss leaves the shortest gap goes, so they stay spread over the whole run (going back
   * anywhere replays at most a gap's steps); the first (the scenario's start) and the latest stay.
   */
  private checkpoint(): void {
    const list = this.checkpoints;
    const { step } = this.state;
    if (list.some((c) => c.step === step && c.logIndex === this.logIndex)) return;
    let at = list.length;
    while (at > 0 && (list[at - 1]?.step ?? 0) > step) at -= 1;
    list.splice(at, 0, this.snapshotNow());
    while (list.length > MAX_CHECKPOINTS) {
      let drop = 1;
      let shortest = Number.POSITIVE_INFINITY;
      for (let k = 1; k < list.length - 1; k += 1) {
        const gap = (list[k + 1]?.step ?? 0) - (list[k - 1]?.step ?? 0);
        if (gap < shortest) {
          shortest = gap;
          drop = k;
        }
      }
      list.splice(drop, 1);
    }
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
    const homes = s.swarms.length > 0 ? swarmHomes(s) : null;
    switch (command.kind) {
      case 'setMass': {
        const i = indexOf(s, command.id);
        if (i >= 0 && Number.isFinite(command.gm) && command.gm >= 0) {
          // Its rotation kept: the same period about the same pole, so the spin scales with GM.
          const old = s.gm[i] ?? 0;
          for (let k = 0; k < 3; k += 1) s.spin[i * 3 + k] = old > 0 ? (s.spin[i * 3 + k] ?? 0) * (command.gm / old) : 0;
          s.gm[i] = command.gm;
        }
        break;
      }
      case 'setVelocity': {
        const i = indexOf(s, command.id);
        if (i >= 0 && command.vel.every(Number.isFinite) && !s.fixed.includes(command.id)) for (let k = 0; k < 3; k += 1) s.vel[i * 3 + k] = command.vel[k] ?? 0;
        break;
      }
      case 'setState': {
        const i = indexOf(s, command.id);
        if (i >= 0 && command.pos.every(Number.isFinite) && command.vel.every(Number.isFinite)) {
          for (let k = 0; k < 3; k += 1) {
            s.pos[i * 3 + k] = command.pos[k] ?? 0;
            s.vel[i * 3 + k] = s.fixed.includes(command.id) ? 0 : (command.vel[k] ?? 0);
          }
        }
        break;
      }
      case 'setRadius': {
        const i = indexOf(s, command.id);
        const gm = command.gm ?? s.gm[i] ?? 0;
        if (i >= 0 && Number.isFinite(command.radiusKm) && command.radiusKm > 0 && Number.isFinite(gm) && gm >= 0) {
          // Its rotation kept: the same period about the same pole, so the spin scales with GM R^2 (with the mass too, when the density is held).
          const old = s.radius[i] ?? command.radiusKm;
          const oldGm = s.gm[i] ?? 0;
          const f = oldGm > 0 ? (gm / oldGm) * (command.radiusKm / old) ** 2 : 0;
          for (let k = 0; k < 3; k += 1) s.spin[i * 3 + k] = (s.spin[i * 3 + k] ?? 0) * f;
          s.radius[i] = command.radiusKm;
          s.gm[i] = gm;
        }
        break;
      }
      case 'setSpin': {
        const i = indexOf(s, command.id);
        if (i >= 0 && Number.isFinite(command.periodS) && command.periodS > 0 && command.pole.every(Number.isFinite)) {
          const v = spinVector(s.gm[i] ?? 0, s.radius[i] ?? 0, s.inertia[i] ?? UNIFORM_INERTIA, command.periodS, command.pole);
          for (let k = 0; k < 3; k += 1) s.spin[i * 3 + k] = v[k] ?? 0;
        }
        break;
      }
      case 'setFixed': {
        const i = indexOf(s, command.id);
        if (i < 0) break;
        const at = s.fixed.indexOf(command.id);
        if (command.fixed && at < 0) {
          s.fixed.push(command.id);
          for (let k = 0; k < 3; k += 1) s.vel[i * 3 + k] = 0;
        } else if (!command.fixed && at >= 0) {
          s.fixed.splice(at, 1);
        }
        break;
      }
      case 'rename': {
        const i = indexOf(s, command.id);
        const name = command.name.trim().slice(0, IMPORT_LIMITS.nameLength);
        if (i >= 0 && name.length > 0) s.names[i] = name;
        break;
      }
      case 'add':
        if (indexOf(s, command.body.id) < 0) {
          addBody(s, bodyOf(command.body));
          const made = lightAndClimate(s, command.body);
          if (made) settle(s, [made]);
          const ship = command.body.ship;
          if (ship) s.ships[command.body.id] = { dryKg: ship.dryKg, fuelKg: ship.fuelKg, thrustN: ship.thrustN, ispS: ship.ispS, burns: [] };
        }
        break;
      case 'burn': {
        const ship = s.ships[command.id];
        const b = command.burn;
        if (ship && Number.isFinite(b.durationS) && b.durationS > 0 && b.throttle > 0 && b.throttle <= 1) planBurn(ship, { ...b, startT: Math.max(b.startT, s.t) });
        break;
      }
      case 'cancelBurns': {
        const ship = s.ships[command.id];
        if (ship) ship.burns.length = 0;
        break;
      }
      case 'remove': {
        const i = indexOf(s, command.id);
        if (i >= 0 && !this.keep(command.id)) removeAt(s, i);
        break;
      }
      case 'setAtmosphere': {
        const c = s.climate[command.id];
        if (!c) break;
        if (command.tau !== undefined && Number.isFinite(command.tau) && command.tau >= 0) c.spec.tau = command.tau;
        if (command.forcing !== undefined && Number.isFinite(command.forcing)) c.spec.forcing = command.forcing;
        if (command.pressurePa !== undefined && Number.isFinite(command.pressurePa) && command.pressurePa >= 0) c.spec.pressurePa = command.pressurePa;
        break;
      }
      case 'addSwarm': {
        if (s.swarms.some((w) => w.id === command.swarm.id)) break;
        // As many as the limits leave room for.
        const room = Math.min(SWARM_LIMITS.perSwarm, SWARM_LIMITS.total - particleCount(s));
        const made = room > 0 ? makeSwarm(s, { ...command.swarm, count: Math.min(command.swarm.count, room) }) : null;
        if (made) s.swarms.push(made);
        break;
      }
      case 'removeSwarm': {
        const k = s.swarms.findIndex((w) => w.id === command.id);
        if (k >= 0) s.swarms.splice(k, 1);
        break;
      }
      case 'addRing': {
        const r = command.ring;
        const p = indexOf(s, r.primary);
        const places = ringPlaces(s, { ...r, count: Math.min(r.count, RING_MAX_BODIES, MAX_BODIES - s.ids.length) });
        if (p < 0 || !places) break;
        places.forEach((place, k) => {
          const id = `${r.id}-${k + 1}`;
          if (indexOf(s, id) >= 0) return;
          const pos = [0, 1, 2].map((c) => (s.pos[p * 3 + c] ?? 0) + (place.pos[c] ?? 0));
          const vel = [0, 1, 2].map((c) => (s.vel[p * 3 + c] ?? 0) + (place.vel[c] ?? 0));
          addBody(s, { id, name: `${r.name} ${k + 1}`.slice(0, IMPORT_LIMITS.nameLength), gm: r.gm / places.length, radiusKm: r.radiusKm, pos, vel });
        });
        break;
      }
    }
    // Bodies placed touching one another merge before any force is felt.
    resolveContacts(s, 0, null, this.events, this.keep);
    // Rings whose primary was removed or merged go on about another body.
    if (homes) rehomeSwarms(s, homes, successorIn(this.events));
    pruneGone(s);
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
    // A new branch: checkpoints of the future it replaces go with it (after going back, those of the run as it was).
    this.prune(this.state.step, log.length);
    this.undone.length = 0;
    this.checkpoint();
    log.push({ step: this.state.step, command });
    this.applyDue();
  }

  /**
   * An edit made to the run as the visitor saw it, at `atStep`. The worker runs on between the view
   * last shown and the edit's arrival (a frame or two: a long stretch at a fast rate), so the run goes
   * back to that step first (exactly: a checkpoint, the log replayed), unless an edit has been made
   * since. A body placed beside another is then placed where that one was seen, not where it has
   * moved since (at a day a second, a hundred thousand kilometres for the Earth).
   */
  applyAt(command: Command, atStep: number): void {
    const last = this.logIndex > 0 ? (this.scenario.log[this.logIndex - 1]?.step ?? 0) : -1;
    if (!this.failure && atStep > last && atStep < this.state.step) this.restore(atStep);
    this.apply(command);
  }

  /** Edits that can be undone (applied ones) and redone. */
  get undoable(): number {
    return this.logIndex;
  }
  get redoable(): number {
    return this.undone.length;
  }

  /**
   * Undoes the latest applied edit: the run goes back to the moment it was made, as it was before it
   * (bit for bit: from the checkpoint taken before it), and it is kept for redo. Later edits, if the run
   * had been taken back before them, go with it.
   */
  undo(): boolean {
    if (this.logIndex === 0) return false;
    const log = this.scenario.log;
    const index = this.logIndex - 1;
    const last = log[index];
    if (!last) return false;
    log.length = index;
    this.undone.push(last);
    this.discarded = 0;
    this.failure = null;
    // From the checkpoint taken just before it (several edits may share a step: the one with exactly the
    // edits before it applied), and nothing of the future that had it.
    this.prune(last.step, index);
    this.restore(last.step, true, index);
    this.applyDue();
    return true;
  }

  /** Drops checkpoints a change of the log makes stale: later than `step`, or with more of the log applied than `logLength`. The first (the start) stays. */
  private prune(step: number, logLength: number): void {
    for (let k = this.checkpoints.length - 1; k >= 1; k -= 1) {
      const c = this.checkpoints[k];
      if (c && (c.step > step || c.logIndex > logLength)) this.checkpoints.splice(k, 1);
    }
  }

  /** Redoes the latest undone edit, at the moment it was first made (the run goes back there if it has moved on). */
  redo(): boolean {
    const next = this.undone.pop();
    if (!next) return false;
    if (this.state.step !== next.step) {
      this.failure = null;
      this.restore(next.step);
    }
    const log = this.scenario.log;
    log.length = this.logIndex;
    // Checkpoints taken since the undo belong to a run without it.
    this.prune(this.state.step, log.length);
    this.checkpoint();
    log.push({ step: this.state.step, command: next.command });
    this.applyDue();
    return true;
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
    const before = this.events.length;
    // A ship's burn begins and ends on time, in short steps while it runs.
    const shortest = step(this.state, burnStep(this.state, this.dt), this.acc, this.events, this.keep);
    const s = this.state;
    if (this.events.length !== before) pruneGone(s);
    // The climates, slower than gravity: stepped once a day of the experiment's clock (or sooner after a long step).
    if (s.t - s.climateAt >= CLIMATE_STEP_S || s.t < s.climateAt) {
      if (s.t > s.climateAt) stepClimates(s, s.t - s.climateAt);
      s.climateAt = s.t;
    }
    if (!healthy(this.state)) {
      this.failure = 'non-finite';
      // The last good checkpoint: the latest at or before this step.
      this.restore(this.state.step, false);
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

  /** Goes back (or forward) to `targetStep`: the latest checkpoint at or before it (with at most `maxLogIndex` edits applied), then the log replayed up to it. */
  restore(targetStep: number, replayTo = true, maxLogIndex = Number.POSITIVE_INFINITY): void {
    let best: Checkpoint | undefined;
    for (const c of this.checkpoints) if (c.step <= targetStep && c.logIndex <= maxLogIndex && (!best || c.step > best.step || (c.step === best.step && c.logIndex >= best.logIndex))) best = c;
    const c = best ?? this.checkpoints[0];
    if (c) this.restoreFrom(c, replayTo ? targetStep : c.step);
  }

  /**
   * Goes to `targetStep` from a given checkpoint of this run (one of its own, or one a replica took:
   * ./rewind), replaying the log from it; exactly the state the run had there.
   */
  restoreFrom(c: Checkpoint, targetStep = c.step): void {
    this.state = cloneState(c.state);
    this.dt = c.dt;
    this.logIndex = c.logIndex;
    // The history as it stood then (the replay adds back what it passes again): interventions mirror the log entries applied, collisions their steps.
    this.interventions.length = Math.min(this.interventions.length, c.logIndex);
    for (let k = this.events.length - 1; k >= 0; k -= 1) if ((this.events[k]?.step ?? 0) >= c.step) this.events.splice(k, 1);
    this.acc.length = 0;
    this.reference = diagnostics(this.state);
    this.lastPeriodic = this.state.step;
    // Checkpoints later than this one belong to a future that is no longer certain: keep them (the log replays the same way) unless a new edit branches.
    while (this.state.step < targetStep && !this.failure) this.stepOnce();
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

  /** Back to the latest checkpoint at or before simulated time `t` (s), not replayed: the caller steps on toward `t` (a few steps at a time). */
  restoreBefore(t: number): void {
    this.failure = null;
    let best: Checkpoint | undefined;
    for (const c of this.checkpoints) if (c.t <= t && c.logIndex <= this.scenario.log.length && (!best || c.step > best.step)) best = c;
    const c = best ?? this.checkpoints[0];
    if (c) this.restoreFrom(c);
  }

  /** Integrates a copy of the current state `horizonS` ahead with the same rules, sampling body `id` `samples` times (all at once: see Prediction for the sliced form). */
  predict(id: string, horizonS: number, samples: number, maxSteps: number, accuracy = 1): PredictionResult {
    const p = new Prediction(this, id, horizonS, samples, maxSteps, accuracy);
    p.work(Number.POSITIVE_INFINITY);
    return p.result();
  }

  /** Drift since the last intervention (relative to its own scales). */
  drift(): { energy: number; momentum: number; angularMomentum: number } {
    return drift(this.reference, diagnostics(this.state));
  }

  /** The scenario as saved: its start, settings and the log so far (not the derived state). */
  toScenario(): Scenario {
    return { ...this.scenario, bodies: this.scenario.bodies.map(cloneBody), log: this.scenario.log.map((e) => ({ step: e.step, command: structuredCloneCommand(e.command) })) };
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
  private readonly frame: string | null;
  private follow: string | null;
  private readonly framePath: number[] = [];
  private frameAt: [number, number, number] = [0, 0, 0];
  /** Each other body's closest approach so far (by id): its distance then, when, where both were; and its distance at the start. */
  private readonly nearest = new Map<string, { d0: number; d: number; t: number; pos: [number, number, number]; otherPos: [number, number, number] }>();
  private readonly eta: number;
  done = false;

  /**
   * `accuracy` scales the step (eta): 0.25 four times finer than the live run, 4 four times coarser and
   * faster. `from`: a moment of the run's history shown instead of its state now (while it is played
   * backwards: ./rewind), with the step it had there.
   */
  constructor(
    engine: Engine,
    readonly id: string,
    readonly horizonS: number,
    readonly samples: number,
    readonly maxSteps: number,
    accuracy = 1,
    from: { state: SimState; dt: number } = engine,
  ) {
    // Test particles pull nothing, so the bodies' future is the same without them.
    this.copy = cloneState(from.state, false);
    this.start = this.copy.t;
    this.g = engine.scenario.integrator;
    this.eta = this.g.eta * accuracy;
    this.dt = this.g.fixedDtS ?? Math.min(this.g.dtMaxS, Math.max(this.g.dtMinS, from.dt * accuracy));
    this.keep = engine.keep;
    const i = indexOf(this.copy, id);
    if (i < 0) this.done = true;
    const p = i < 0 ? -1 : primaryOf(this.copy.gm, this.copy.pos, i);
    this.frame = p < 0 ? null : (this.copy.ids[p] ?? null);
    this.follow = this.frame;
    if (p >= 0) this.frameAt = [this.copy.pos[p * 3] ?? 0, this.copy.pos[p * 3 + 1] ?? 0, this.copy.pos[p * 3 + 2] ?? 0];
  }

  /** Up to `budget` more steps; true when the prediction is complete. */
  work(budget: number): boolean {
    const copy = this.copy;
    const g = this.g;
    let used = 0;
    while (!this.done && used < budget) {
      const until = this.start + (this.horizonS * this.k) / this.samples;
      if (copy.t + this.dt <= until && this.steps < this.maxSteps) {
        const shortest = step(copy, burnStep(copy, this.dt), this.acc, this.events, this.keep);
        this.steps += 1;
        used += 1;
        // The same retiming as the live run's (at its own accuracy).
        if (g.fixedDtS === null && (this.eta * shortest < 0.5 * this.dt || copy.step % g.retimeSteps === 0)) this.dt = Math.min(g.dtMaxS, Math.max(g.dtMinS, this.eta * shortest));
        this.watch();
        // The frame merged: its survivor carries on as the frame (should that be the body itself, the frame stays where it was).
        const lost = this.follow === null ? undefined : this.events.find((ev) => consumes(ev) && ev.absorbed === this.follow);
        if (lost) this.follow = lost.survivor === this.id ? null : lost.survivor;
        const e = this.events.find((ev) => consumes(ev) && ev.absorbed === this.id);
        if (e) {
          const i = indexOf(copy, e.survivor);
          this.merged = { t: copy.t - this.start, with: e.survivor, pos: [copy.pos[i * 3] ?? 0, copy.pos[i * 3 + 1] ?? 0, copy.pos[i * 3 + 2] ?? 0] };
          this.path.push(...this.merged.pos);
          this.sampleFrame();
          this.done = true;
        }
        continue;
      }
      // A sample, then on to the next (or done: the horizon reached, or the step budget spent).
      const i = indexOf(copy, this.id);
      if (i >= 0) {
        this.path.push(copy.pos[i * 3] ?? 0, copy.pos[i * 3 + 1] ?? 0, copy.pos[i * 3 + 2] ?? 0);
        this.sampleFrame();
      }
      this.k += 1;
      if (this.k > this.samples || this.steps >= this.maxSteps || i < 0) this.done = true;
    }
    return this.done;
  }

  /** Notes each body's distance from the predicted one, keeping the closest so far. */
  private watch(): void {
    const copy = this.copy;
    const i = indexOf(copy, this.id);
    if (i < 0) return;
    const x = copy.pos[i * 3] ?? 0;
    const y = copy.pos[i * 3 + 1] ?? 0;
    const z = copy.pos[i * 3 + 2] ?? 0;
    for (let j = 0; j < copy.ids.length; j += 1) {
      const other = copy.ids[j] ?? '';
      if (j === i || other === this.frame || (copy.gm[j] ?? 0) <= 0) continue;
      const ox = copy.pos[j * 3] ?? 0;
      const oy = copy.pos[j * 3 + 1] ?? 0;
      const oz = copy.pos[j * 3 + 2] ?? 0;
      const d = Math.hypot(ox - x, oy - y, oz - z);
      const seen = this.nearest.get(other);
      if (!seen) this.nearest.set(other, { d0: d, d, t: copy.t - this.start, pos: [x, y, z], otherPos: [ox, oy, oz] });
      else if (d < seen.d) {
        seen.d = d;
        seen.t = copy.t - this.start;
        seen.pos = [x, y, z];
        seen.otherPos = [ox, oy, oz];
      }
    }
  }

  /** The closest approaches that are encounters: nearer than at the start and than at the end (it came in and went away), nearest first for the other body's size. */
  private encounters(): Encounter[] {
    const copy = this.copy;
    const i = indexOf(copy, this.id);
    const out: Array<Encounter & { rank: number }> = [];
    for (const [other, n] of this.nearest) {
      const j = indexOf(copy, other);
      if (j < 0 || n.d >= n.d0 * 0.999) continue;
      const end = i < 0 ? n.d : Math.hypot((copy.pos[j * 3] ?? 0) - (copy.pos[i * 3] ?? 0), (copy.pos[j * 3 + 1] ?? 0) - (copy.pos[i * 3 + 1] ?? 0), (copy.pos[j * 3 + 2] ?? 0) - (copy.pos[i * 3 + 2] ?? 0));
      if (i >= 0 && n.d >= end * 0.999) continue;
      out.push({ with: other, t: n.t, distanceKm: n.d, pos: n.pos, otherPos: n.otherPos, rank: n.d / Math.max(copy.radius[j] ?? 1, 1e-9) });
    }
    return out
      .sort((a, b) => a.rank - b.rank)
      .slice(0, ENCOUNTERS)
      .map(({ rank: _rank, ...e }) => e);
  }

  /** The frame body's place at this sample (its last place, once it has merged into the body itself). */
  private sampleFrame(): void {
    if (this.frame === null) return;
    const f = this.follow === null ? -1 : indexOf(this.copy, this.follow);
    if (f >= 0) this.frameAt = [this.copy.pos[f * 3] ?? 0, this.copy.pos[f * 3 + 1] ?? 0, this.copy.pos[f * 3 + 2] ?? 0];
    this.framePath.push(...this.frameAt);
  }

  result(): PredictionResult {
    return { id: this.id, path: [...this.path], merged: this.merged, frame: this.frame, framePath: [...this.framePath], encounters: this.encounters() };
  }
}

/** A periodic checkpoint every this many steps (about 2,000, fewer when the steps are long). */
function checkpointSteps(dt: number): number {
  return Math.max(200, Math.round(2000 * Math.min(1, 3600 / Math.max(dt, 1))));
}

function structuredCloneCommand(c: Command): Command {
  switch (c.kind) {
    case 'add':
      return { kind: 'add', body: cloneBody(c.body) };
    case 'setVelocity':
      return { kind: 'setVelocity', id: c.id, vel: [...c.vel] };
    case 'setState':
      return { kind: 'setState', id: c.id, pos: [...c.pos], vel: [...c.vel] };
    case 'setSpin':
      return { kind: 'setSpin', id: c.id, periodS: c.periodS, pole: [...c.pole] };
    case 'burn':
      return { kind: 'burn', id: c.id, burn: { ...c.burn } };
    default:
      return { ...c };
  }
}

function cloneBody(b: BodySpec): BodySpec {
  return { ...b, pos: [...b.pos], vel: [...b.vel], sourceIds: [...b.sourceIds], ...(b.spin ? { spin: { periodS: b.spin.periodS, pole: [...b.spin.pole] } } : {}), ...(b.ship ? { ship: { ...b.ship } } : {}) };
}

/** Limits on an imported scenario (a file could ask for anything). */
export const IMPORT_LIMITS = { bodies: MAX_BODIES, log: 5000, nameLength: 60, coordinateKm: 1e12, speedKmS: 3e5, gm: 1e14, radiusKm: 1e7, periodS: 1e12, particles: SWARM_LIMITS.perSwarm, ringBodies: RING_MAX_BODIES } as const;

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
    const spin = b.spin;
    const spinOk = spin === undefined || (obj(spin) && num(spin.periodS, 1e-3, L.periodS) && vec(spin.pole, 1e6) && Math.hypot(...(spin.pole as number[])) > 0);
    const ok =
      typeof b.id === 'string' && /^[a-z0-9-]{1,40}$/u.test(b.id) &&
      typeof b.name === 'string' && b.name.length > 0 && b.name.length <= L.nameLength &&
      num(b.gm, 0, L.gm) && num(b.radiusKm, 1e-6, L.radiusKm) && vec(b.pos, L.coordinateKm) && vec(b.vel, L.speedKmS) &&
      (b.origin === 'observed' || b.origin === 'modelled' || b.origin === 'user-edited') && Array.isArray(b.sourceIds) && b.sourceIds.every((x) => typeof x === 'string') &&
      spinOk && (b.j2 === undefined || num(b.j2, 0, 0.5)) && (b.inertia === undefined || num(b.inertia, 0.01, 0.67)) &&
      (b.ship === undefined || (obj(b.ship) && num(b.ship.dryKg, 1, 1e9) && num(b.ship.fuelKg, 0, 1e10) && num(b.ship.thrustN, 1e-3, 1e10) && num(b.ship.ispS, 1, 1e5)));
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
  const swarmIds = new Set<string>();
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
    } else if (c.kind === 'addSwarm' || c.kind === 'addRing') {
      const spec = c.kind === 'addSwarm' ? c.swarm : c.ring;
      const ring = c.kind === 'addRing';
      const made = obj(spec) && typeof spec.primary === 'string' && /^(remnant|debris)-\d+(-\d+)*$/u.test(spec.primary);
      const shape =
        obj(spec) && typeof spec.id === 'string' && /^[a-z0-9-]{1,40}$/u.test(spec.id) &&
        typeof spec.name === 'string' && spec.name.length > 0 && spec.name.length <= L.nameLength &&
        typeof spec.primary === 'string' && (ids.has(spec.primary) || made) &&
        Number.isInteger(spec.count) && num(spec.count, ring ? 2 : 1, ring ? L.ringBodies : L.particles) &&
        num(spec.innerKm, 1e-3, L.coordinateKm) && num(spec.outerKm, typeof spec.innerKm === 'number' ? spec.innerKm : 0, L.coordinateKm) &&
        vec(spec.normal, 1e6) && Math.hypot(...(spec.normal as number[])) > 0 &&
        Number.isInteger(spec.seed) && num(spec.seed, 0, 4294967295) &&
        (ring ? num(spec.gm, 0, L.gm) && num(spec.radiusKm, 1e-6, L.radiusKm) : num(spec.eccentricity, 0, 0.95) && num(spec.inclinationDeg, 0, 180));
      if (!shape) errors.push(`${where}: ${ring ? 'ring' : 'swarm'} values missing or out of range`);
      else if (ring) for (let k = 1; k <= (spec.count as number); k += 1) ids.add(`${spec.id as string}-${k}`);
      else {
        if (swarmIds.has(spec.id as string)) errors.push(`${where}: adds a swarm id that already exists (${spec.id as string})`);
        swarmIds.add(spec.id as string);
      }
    } else if (c.kind === 'removeSwarm') {
      if (typeof c.id !== 'string' || !swarmIds.has(c.id)) errors.push(`${where}: names a swarm that does not exist`);
    } else if (c.kind === 'burn' || c.kind === 'cancelBurns') {
      if (typeof c.id !== 'string' || !ids.has(c.id)) errors.push(`${where}: names a ship that does not exist`);
      const b: unknown = c.kind === 'burn' ? c.burn : null;
      if (c.kind === 'burn' && !(obj(b) && num(b.startT, -1e12, 1e13) && num(b.durationS, 1e-3, 1e9) && num(b.throttle, 1e-3, 1) && typeof b.ref === 'string' && typeof b.direction === 'string' && (BURN_DIRECTIONS as readonly string[]).includes(b.direction)))
        errors.push(`${where}: not a burn`);
    } else if (c.kind === 'setMass' || c.kind === 'setVelocity' || c.kind === 'remove' || c.kind === 'setState' || c.kind === 'setRadius' || c.kind === 'setSpin' || c.kind === 'setFixed' || c.kind === 'rename') {
      // Bodies a collision made (src/sim/nbody fragment()) exist only once the run reaches it: their ids are checked for form, not presence.
      const made = typeof c.id === 'string' && /^(remnant|debris)-\d+(-\d+)*$/u.test(c.id);
      if (typeof c.id !== 'string' || !(ids.has(c.id) || made)) errors.push(`${where}: names a body that does not exist`);
      if (c.kind === 'setMass' && !num(c.gm, 0, L.gm)) errors.push(`${where}: mass out of range`);
      if (c.kind === 'setVelocity' && !vec(c.vel, L.speedKmS)) errors.push(`${where}: velocity out of range`);
      if (c.kind === 'setState' && !(vec(c.pos, L.coordinateKm) && vec(c.vel, L.speedKmS))) errors.push(`${where}: position or velocity out of range`);
      if (c.kind === 'setRadius' && !(num(c.radiusKm, 1e-6, L.radiusKm) && (c.gm === undefined || num(c.gm, 0, L.gm)))) errors.push(`${where}: radius out of range`);
      if (c.kind === 'setSpin' && !(num(c.periodS, 1e-3, L.periodS) && vec(c.pole, 1e6) && Math.hypot(...(c.pole as number[])) > 0)) errors.push(`${where}: rotation out of range`);
      if (c.kind === 'setFixed' && typeof c.fixed !== 'boolean') errors.push(`${where}: not a hold`);
      if (c.kind === 'rename' && !(typeof c.name === 'string' && c.name.trim().length > 0 && c.name.length <= L.nameLength)) errors.push(`${where}: not a name`);
    } else {
      errors.push(`${where}: unknown edit`);
    }
  });
  if (raw.persistentIds !== undefined && !(Array.isArray(raw.persistentIds) && raw.persistentIds.every((id) => typeof id === 'string' && ids.has(id)))) errors.push('persistent ids must name bodies of the scenario');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scenario: raw as unknown as Scenario };
}
