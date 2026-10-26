import type { ClimateSpec } from './climate';
import type { Command, Encounter, Scenario } from './engine';
import type { MergeEvent } from './nbody';
import type { Burn } from './ships';

/**
 * Messages between the orbital laboratory's worker (./worker) and the page (./client). Every
 * request and reply carries the scenario's `generation`: the page starts a new generation for each
 * new or loaded scenario, and drops any reply from an older one, so a late snapshot can never bring
 * back a deleted body or an exited experiment. Snapshots also carry a sequence number.
 */

export type LabRequest =
  | { type: 'load'; generation: number; scenario: Scenario }
  /**
   * The clock: simulated seconds per real second (negative: the history played backwards, exactly, by
   * replaying it from its checkpoints: ./rewind) and whether paused. `control` counts the page's run
   * and goto requests; snapshots echo the latest they had, so the page takes a stop at the start or a
   * goto's end only from a snapshot that knew its latest request.
   */
  | { type: 'run'; generation: number; control: number; rate: number; paused: boolean }
  /** Go to simulated time `t` (s since the epoch, at least 0): back through the checkpoints, then on a few steps a tick; the clock then runs (or not) as `run` last said. */
  | { type: 'goto'; generation: number; control: number; t: number }
  /** `atStep`: the step of the view the edit was made on (the run goes back to it: Engine.applyAt). */
  | { type: 'command'; generation: number; command: Command; atStep?: number }
  | { type: 'predict'; generation: number; id: string | null; horizonS: number; accuracy: number }
  | { type: 'undo'; generation: number }
  | { type: 'redo'; generation: number }
  | { type: 'seek'; generation: number; step: number }
  | { type: 'replay'; generation: number }
  | { type: 'save'; generation: number; requestId: number };

export interface LabSnapshot {
  type: 'snapshot';
  generation: number;
  seq: number;
  /** Edits received in this generation: a snapshot with fewer than the page has sent was taken before its latest edit. */
  applied: number;
  /** Simulated seconds since the epoch, steps taken, the current step (s). */
  t: number;
  step: number;
  dt: number;
  /**
   * Simulated time asked for and not yet stepped (s, in the direction of travel: the page's drawn clock
   * aims at t + owed, or t - owed going back); counts discontinuities of the run (a load, seek, replay,
   * undo, redo, a goto going back, an edit made on an earlier view), which alone may move the drawn
   * clock against its direction; the latest run or goto request it had (LabRequest `control`).
   */
  owed: number;
  timeline: number;
  control: number;
  /** Back at the scenario's start while going backwards (the worker has paused there), or null. */
  edge: 'start' | null;
  /** A goto under way: the time it is going to (s), or null. */
  seekingS: number | null;
  /** The worker's step budget was spent before the time asked for was reached (the achieved rate is then the most possible here). */
  budgetBound: boolean;
  ids: string[];
  names: string[];
  gm: Float64Array;
  radius: Float64Array;
  /** Positions (km), velocities (km/s) and accelerations (km/s^2), three per body, in the scenario's frame (the page draws between snapshots with them). */
  pos: Float64Array;
  vel: Float64Array;
  acc: Float64Array;
  /** Spin angular momenta (G units, three per body), J2s and moment of inertia factors; the bodies held in place. */
  spin: Float64Array;
  j2: Float64Array;
  inertia: Float64Array;
  fixed: string[];
  /** Edits that can be undone and redone. */
  undoable: number;
  redoable: number;
  /** Drift since the last intervention (relative), and the closed model's totals now. */
  drift: { energy: number; momentum: number; angularMomentum: number };
  /** Requested and achieved simulated seconds per real second (achieved: since the rate was set, over at least a second and two steps). */
  requestedRate: number;
  achievedRate: number;
  paused: boolean;
  failure: string | null;
  interventions: Array<{ step: number; t: number; kind: Command['kind']; id: string }>;
  events: MergeEvent[];
  checkpoints: Array<{ step: number; t: number }>;
  /** Each solid world's climate (./climate): its bands' temperatures (K, south to north) and what it is set to; every star's luminosity now (W). */
  climate: Array<{ id: string; t: number[]; spec: ClimateSpec }>;
  light: Record<string, number>;
  /** Rings and belts: their particles' places relative to each one's primary (km, three per particle; single precision is ample to draw). */
  swarms: Array<{ id: string; name: string; primary: string; lost: number; rel: Float32Array }>;
  logLength: number;
  discarded: number;
  /** Ships (./ships): their rocket, propellant now and burns to come. */
  ships: Array<{ id: string; dryKg: number; fuelKg: number; thrustN: number; ispS: number; burns: Burn[] }>;
}

export type LabReply =
  | LabSnapshot
  | { type: 'prediction'; generation: number; revision: number; id: string; horizonS: number; path: Float64Array; merged: { t: number; with: string; pos: [number, number, number] } | null; frame: string | null; framePath: Float64Array; encounters: Encounter[] }
  | { type: 'saved'; generation: number; requestId: number; scenario: Scenario }
  | { type: 'error'; generation: number; message: string };
