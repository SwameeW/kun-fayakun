/// <reference lib="webworker" />
import { luminosities } from './climate';
import { commandId, Engine, Prediction } from './engine';
import { accelerations, diagnostics, drift, type Diagnostics } from './nbody';
import type { LabReply, LabRequest, LabSnapshot } from './protocol';
import { Rewind, swarmPlaces } from './rewind';

/**
 * The orbital laboratory's worker: the engine (./engine) in Float64, off the main thread.
 *
 * Each tick (about 60 a second) it runs whole steps toward the time the requested rate asks for,
 * for at most STEP_BUDGET_MS of the tick (so the controls stay responsive however heavy the
 * scenario), and reports the rate it achieved: when it falls short, simulated time runs slower, never
 * skips. Going backwards (a negative rate) it shows the history replayed exactly (./rewind), a whole
 * step at a time, replaying the part before within the same budget, and stops (paused) at the start.
 * Going to a moment (`goto`) steps toward it within the budget. Predictions (engine Prediction) run
 * after the live steps, PREDICT_BUDGET_MS a tick, and a newer request or any edit replaces the one
 * under way. Snapshots go out about 30 times a second, with what the page needs to draw between them
 * smoothly (accelerations, the time owed) and a timeline count that changes only when the run jumps.
 */

const TICK_MS = 16;
const STEP_BUDGET_MS = 8;
const PREDICT_BUDGET_MS = 3;
const SNAPSHOT_MS = 33;
/** A stall longer than this (a hidden tab) is not made up for. */
const MAX_WALL_S = 0.25;
/** The achieved rate is measured since the rate was set, over the last second at most. */
const ACHIEVED_WINDOW_S = 1;
/** A budget spent this recently (ms) still counts: the rate shown as the most possible here does not flicker. */
const BOUND_HOLD_MS = 1000;
const PREDICTION_SAMPLES = 360;
/** The most steps one prediction may take (a long horizon is sampled more coarsely, not without end). */
const PREDICTION_STEPS = 400_000;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: Engine | null = null;
let generation = 0;
let seq = 0;
let applied = 0;
let rate = 86_400;
let paused = false;
let lastTick = performance.now();
let lastSnapshot = 0;
let achieved = 0;
/** Simulated time asked for and not yet stepped (a step can be longer than a tick's share), in the direction of travel. */
let owed = 0;
let recent: Array<{ wall: number; sim: number }> = [];
let job: { revision: number; prediction: Prediction } | null = null;
let revision = 0;
let pendingPrediction: { id: string | null; horizonS: number; accuracy: number } | null = null;
/** The page's latest run or goto request, echoed; the run's discontinuities; the history being played backwards; a stop at the start. */
let control = 0;
let timeline = 0;
let rewind: Rewind | null = null;
let atStart = false;
/** A goto under way: the simulated time it is going to. */
let seekTo: number | null = null;
let boundAt = Number.NEGATIVE_INFINITY;
/** The diagnostics at the scenario's start (drift going backwards is measured from the edit before the moment shown, or from here). */
let startDiagnostics: Diagnostics | null = null;
const accScratch: number[] = [];

const post = (reply: LabReply, transfer: Transferable[] = []): void => {
  scope.postMessage(reply, transfer);
};

/** The run put exactly at the moment the history shows (before an edit, a run forwards, a seek), and the history let go. */
function settleRewind(): void {
  rewind?.commit();
  rewind = null;
}

function startPrediction(): void {
  if (!engine || !pendingPrediction?.id) {
    job = null;
    return;
  }
  revision += 1;
  const { id, horizonS, accuracy } = pendingPrediction;
  // A finer prediction is allowed more steps (four times finer, four times as many); going back, from the moment shown.
  job = { revision, prediction: new Prediction(engine, id, horizonS, PREDICTION_SAMPLES, Math.round(PREDICTION_STEPS / Math.min(1, accuracy)), accuracy, rewind ? rewind.shown : engine) };
}

function snapshot(): void {
  if (!engine) return;
  // Going backwards, the moment the history shows; otherwise the run itself.
  const shown = rewind?.shown ?? null;
  const s = shown ? shown.state : engine.state;
  const logIndex = shown ? shown.logIndex : engine.applied;
  const pos = Float64Array.from(s.pos);
  const vel = Float64Array.from(s.vel);
  const spin = Float64Array.from(s.spin);
  accelerations(s, accScratch);
  const acc = Float64Array.from(accScratch.slice(0, s.ids.length * 3));
  const swarms = rewind ? rewind.swarms.map((w) => ({ ...w, rel: w.rel.slice() })) : swarmPlaces(s);
  const reference = engine.interventions[logIndex - 1]?.after ?? (startDiagnostics ??= diagnostics(engine.checkpoints[0]?.state ?? s));
  const reply: LabSnapshot = {
    type: 'snapshot',
    generation,
    seq: (seq += 1),
    applied,
    t: s.t,
    step: s.step,
    dt: shown ? shown.dt : engine.dt,
    owed: seekTo === null ? owed : 0,
    timeline,
    control,
    edge: atStart ? 'start' : null,
    seekingS: seekTo,
    budgetBound: performance.now() - boundAt < BOUND_HOLD_MS,
    ids: [...s.ids],
    names: [...s.names],
    gm: Float64Array.from(s.gm),
    radius: Float64Array.from(s.radius),
    pos,
    vel,
    acc,
    spin,
    j2: Float64Array.from(s.j2),
    inertia: Float64Array.from(s.inertia),
    fixed: [...s.fixed],
    undoable: engine.undoable,
    redoable: engine.redoable,
    drift: shown ? drift(reference, diagnostics(s)) : engine.drift(),
    requestedRate: rate,
    achievedRate: achieved,
    paused,
    failure: engine.failure,
    interventions: engine.interventions.slice(0, logIndex).slice(-40).map((i) => ({ step: i.step, t: i.t, kind: i.command.kind, id: commandId(i.command) })),
    // Collisions with a step happen in the step after it: those before the moment shown.
    events: (shown ? engine.events.filter((e) => e.step < s.step) : engine.events).slice(-40),
    checkpoints: engine.checkpoints.map((c) => ({ step: c.step, t: c.t })),
    swarms,
    climate: Object.entries(s.climate).map(([id, c]) => ({ id, t: [...c.t], spec: { ...c.spec } })),
    light: luminosities(s),
    logLength: engine.scenario.log.length,
    discarded: engine.discarded,
    ships: Object.entries(s.ships).map(([id, x]) => ({ id, dryKg: x.dryKg, fuelKg: x.fuelKg, thrustN: x.thrustN, ispS: x.ispS, burns: x.burns.map((b) => ({ ...b })) })),
  };
  post(reply, [pos.buffer, vel.buffer, acc.buffer, spin.buffer, ...swarms.map((w) => w.rel.buffer)]);
}

function tick(): void {
  const now = performance.now();
  const wall = Math.min(MAX_WALL_S, (now - lastTick) / 1000);
  lastTick = now;
  let moved = 0;
  if (engine && seekTo !== null) {
    // Going to a moment: whole steps toward it within the budget, whatever the rate.
    while (engine.state.t + engine.dt <= seekTo && !engine.failure && performance.now() - now < STEP_BUDGET_MS) engine.stepOnce();
    if (engine.failure || engine.state.t + engine.dt > seekTo) {
      seekTo = null;
      owed = 0;
      recent = [];
    }
  } else if (engine && !paused && !engine.failure && rate < 0) {
    // Backwards: the history a step at a time, the part before it replayed meanwhile; paused at the start.
    const r = (rewind ??= new Rewind(engine));
    const t0 = r.shown.t;
    owed = Math.min(owed - rate * wall, -rate * MAX_WALL_S + r.shown.dt);
    owed = r.back(owed);
    r.work(STEP_BUDGET_MS);
    if (r.waiting) boundAt = now;
    if (r.atStart) {
      paused = true;
      atStart = true;
      owed = 0;
    }
    moved = r.shown.t - t0;
  } else if (engine && !paused && !engine.failure) {
    // Owed time carries over, but never more than a quarter-second's worth and a step: a slow machine runs slower, it does not pile up a backlog.
    const t0 = engine.state.t;
    owed = Math.min(owed + rate * wall, rate * MAX_WALL_S + engine.dt);
    while (owed >= engine.dt && !engine.failure) {
      if (performance.now() - now >= STEP_BUDGET_MS) {
        boundAt = now;
        break;
      }
      const dt = engine.dt;
      engine.stepOnce();
      owed -= dt;
    }
    moved = engine.state.t - t0;
  } else {
    owed = 0;
    // Paused going backwards: the history before the moment shown is made ready meanwhile.
    rewind?.work(STEP_BUDGET_MS);
  }
  recent.push({ wall, sim: moved });
  // The achieved rate since the rate was set, over the last second at most.
  let w = 0;
  let sim = 0;
  for (let i = recent.length - 1; i >= 0 && w < ACHIEVED_WINDOW_S; i -= 1) {
    w += recent[i]?.wall ?? 0;
    sim += recent[i]?.sim ?? 0;
  }
  if (recent.length > 120) recent = recent.slice(-120);
  achieved = w > 0 ? sim / w : 0;
  if (job && engine) {
    const started = performance.now();
    let done = false;
    while (!done && performance.now() - started < PREDICT_BUDGET_MS) done = job.prediction.work(256);
    if (done) {
      const r = job.prediction.result();
      const path = Float64Array.from(r.path);
      const framePath = Float64Array.from(r.framePath);
      post({ type: 'prediction', generation, revision: job.revision, id: r.id, horizonS: job.prediction.horizonS, path, merged: r.merged, frame: r.frame, framePath, encounters: r.encounters }, [path.buffer, framePath.buffer]);
      job = null;
    }
  }
  if (now - lastSnapshot >= SNAPSHOT_MS) {
    lastSnapshot = now;
    snapshot();
  }
}

scope.onmessage = (event: MessageEvent<LabRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      generation = msg.generation;
      engine = new Engine(msg.scenario);
      seq = 0;
      applied = 0;
      job = null;
      recent = [];
      owed = 0;
      timeline = 0;
      rewind = null;
      atStart = false;
      seekTo = null;
      startDiagnostics = null;
      snapshot();
      startPrediction();
      return;
    }
    // Anything for an older scenario is ignored.
    if (msg.generation !== generation || !engine) return;
    switch (msg.type) {
      case 'run':
        control = msg.control;
        // Achieved is measured from a change of rate; time owed one way is not owed the other.
        if (msg.rate !== rate) recent = [];
        if (Math.sign(msg.rate) !== Math.sign(rate)) owed = 0;
        rate = msg.rate;
        paused = msg.paused;
        // Forwards again: the run goes on from the moment shown, exactly.
        if (rate > 0) {
          atStart = false;
          if (rewind) {
            settleRewind();
            startPrediction();
          }
        }
        break;
      case 'goto': {
        control = msg.control;
        rewind = null;
        atStart = false;
        const target = Math.max(0, Number.isFinite(msg.t) ? msg.t : 0);
        // Back through the checkpoints (a jump: the page's drawn clock follows it), then on to it a few steps a tick.
        if (target < engine.state.t) {
          engine.restoreBefore(target);
          timeline += 1;
        }
        seekTo = target;
        owed = 0;
        recent = [];
        startPrediction();
        snapshot();
        break;
      }
      case 'command': {
        applied += 1;
        settleRewind();
        seekTo = null;
        const before = engine.state.step;
        engine.applyAt(msg.command, msg.atStep ?? engine.state.step);
        // Made on a view the run had passed: it went back there first.
        if (engine.state.step < before) timeline += 1;
        startPrediction();
        snapshot();
        break;
      }
      case 'predict':
        pendingPrediction = { id: msg.id, horizonS: msg.horizonS, accuracy: msg.accuracy };
        startPrediction();
        break;
      case 'undo':
      case 'redo':
        applied += 1;
        settleRewind();
        seekTo = null;
        atStart = false;
        if (msg.type === 'undo') engine.undo();
        else engine.redo();
        timeline += 1;
        startPrediction();
        snapshot();
        break;
      case 'seek':
        rewind = null;
        seekTo = null;
        atStart = false;
        engine.seek(msg.step);
        timeline += 1;
        startPrediction();
        snapshot();
        break;
      case 'replay':
        rewind = null;
        seekTo = null;
        atStart = false;
        engine.replayFromStart();
        timeline += 1;
        startPrediction();
        snapshot();
        break;
      case 'save':
        post({ type: 'saved', generation, requestId: msg.requestId, scenario: engine.toScenario() });
        break;
    }
  } catch (err) {
    post({ type: 'error', generation: msg.generation, message: err instanceof Error ? err.message : String(err) });
  }
};

setInterval(tick, TICK_MS);
