import type { Command, Encounter, Scenario } from './engine';
import type { MergeEvent } from './nbody';

/**
 * Messages between the orbital laboratory's worker (./worker) and the page (./client). Every
 * request and reply carries the scenario's `generation`: the page starts a new generation for each
 * new or loaded scenario, and drops any reply from an older one, so a late snapshot can never bring
 * back a deleted body or an exited experiment. Snapshots also carry a sequence number.
 */

export type LabRequest =
  | { type: 'load'; generation: number; scenario: Scenario }
  | { type: 'run'; generation: number; rate: number; paused: boolean }
  | { type: 'command'; generation: number; command: Command }
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
  ids: string[];
  names: string[];
  gm: Float64Array;
  radius: Float64Array;
  /** Positions (km) and velocities (km/s), three per body, in the scenario's frame. */
  pos: Float64Array;
  vel: Float64Array;
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
  /** Requested and achieved simulated seconds per real second (achieved: over the last second). */
  requestedRate: number;
  achievedRate: number;
  paused: boolean;
  failure: string | null;
  interventions: Array<{ step: number; t: number; kind: Command['kind']; id: string }>;
  events: MergeEvent[];
  checkpoints: Array<{ step: number; t: number }>;
  logLength: number;
  discarded: number;
}

export type LabReply =
  | LabSnapshot
  | { type: 'prediction'; generation: number; revision: number; id: string; horizonS: number; path: Float64Array; merged: { t: number; with: string; pos: [number, number, number] } | null; frame: string | null; framePath: Float64Array; encounters: Encounter[] }
  | { type: 'saved'; generation: number; requestId: number; scenario: Scenario }
  | { type: 'error'; generation: number; message: string };
