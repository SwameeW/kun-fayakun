/// <reference lib="webworker" />
import { commandId, Engine, Prediction } from './engine';
import type { LabReply, LabRequest, LabSnapshot } from './protocol';

/**
 * The orbital laboratory's worker: the engine (./engine) in Float64, off the main thread.
 *
 * Each tick (about 60 a second) it runs whole steps toward the time the requested rate asks for,
 * for at most STEP_BUDGET_MS of the tick (so the controls stay responsive however heavy the
 * scenario), and reports the rate it achieved: when it falls short, simulated time runs slower, never
 * skips. Predictions (engine Prediction) run after the live steps, PREDICT_BUDGET_MS a tick, and a
 * newer request or any edit replaces the one under way. Snapshots go out about 30 times a second.
 */

const TICK_MS = 16;
const STEP_BUDGET_MS = 8;
const PREDICT_BUDGET_MS = 3;
const SNAPSHOT_MS = 33;
/** A stall longer than this (a hidden tab) is not made up for. */
const MAX_WALL_S = 0.25;
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
/** Simulated time asked for and not yet stepped (a step can be longer than a tick's share). */
let owed = 0;
let recent: Array<{ wall: number; sim: number }> = [];
let job: { revision: number; prediction: Prediction } | null = null;
let revision = 0;
let pendingPrediction: { id: string | null; horizonS: number; accuracy: number } | null = null;

const post = (reply: LabReply, transfer: Transferable[] = []): void => {
  scope.postMessage(reply, transfer);
};

function startPrediction(): void {
  if (!engine || !pendingPrediction?.id) {
    job = null;
    return;
  }
  revision += 1;
  const { id, horizonS, accuracy } = pendingPrediction;
  // A finer prediction is allowed more steps (four times finer, four times as many).
  job = { revision, prediction: new Prediction(engine, id, horizonS, PREDICTION_SAMPLES, Math.round(PREDICTION_STEPS / Math.min(1, accuracy)), accuracy) };
}

function snapshot(): void {
  if (!engine) return;
  const s = engine.state;
  const pos = Float64Array.from(s.pos);
  const vel = Float64Array.from(s.vel);
  const spin = Float64Array.from(s.spin);
  const swarms = s.swarms.map((w) => ({ id: w.id, name: w.name, primary: w.primary, lost: w.lost, rel: Float32Array.from(w.pos) }));
  const reply: LabSnapshot = {
    type: 'snapshot',
    generation,
    seq: (seq += 1),
    applied,
    t: s.t,
    step: s.step,
    dt: engine.dt,
    ids: [...s.ids],
    names: [...s.names],
    gm: Float64Array.from(s.gm),
    radius: Float64Array.from(s.radius),
    pos,
    vel,
    spin,
    j2: Float64Array.from(s.j2),
    inertia: Float64Array.from(s.inertia),
    fixed: [...s.fixed],
    undoable: engine.undoable,
    redoable: engine.redoable,
    drift: engine.drift(),
    requestedRate: rate,
    achievedRate: achieved,
    paused,
    failure: engine.failure,
    interventions: engine.interventions.slice(-40).map((i) => ({ step: i.step, t: i.t, kind: i.command.kind, id: commandId(i.command) })),
    events: engine.events.slice(-40),
    checkpoints: engine.checkpoints.map((c) => ({ step: c.step, t: c.t })),
    swarms,
    logLength: engine.scenario.log.length,
    discarded: engine.discarded,
  };
  post(reply, [pos.buffer, vel.buffer, spin.buffer, ...swarms.map((w) => w.rel.buffer)]);
}


function tick(): void {
  const now = performance.now();
  const wall = Math.min(MAX_WALL_S, (now - lastTick) / 1000);
  lastTick = now;
  if (engine && !paused && !engine.failure) {
    const t0 = engine.state.t;
    // Owed time carries over, but never more than a quarter-second's worth and a step: a slow machine runs slower, it does not pile up a backlog.
    owed = Math.min(owed + rate * wall, rate * MAX_WALL_S + engine.dt);
    const started = performance.now();
    while (owed >= engine.dt && performance.now() - started < STEP_BUDGET_MS && !engine.failure) {
      const dt = engine.dt;
      engine.stepOnce();
      owed -= dt;
    }
    recent.push({ wall, sim: engine.state.t - t0 });
  } else {
    owed = 0;
    recent.push({ wall, sim: 0 });
  }
  // The achieved rate over about the last second.
  let w = 0;
  let sim = 0;
  for (let i = recent.length - 1; i >= 0 && w < 1; i -= 1) {
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
      snapshot();
      startPrediction();
      return;
    }
    // Anything for an older scenario is ignored.
    if (msg.generation !== generation || !engine) return;
    switch (msg.type) {
      case 'run':
        rate = msg.rate;
        paused = msg.paused;
        break;
      case 'command':
        applied += 1;
        engine.apply(msg.command);
        startPrediction();
        snapshot();
        break;
      case 'predict':
        pendingPrediction = { id: msg.id, horizonS: msg.horizonS, accuracy: msg.accuracy };
        startPrediction();
        break;
      case 'undo':
      case 'redo':
        applied += 1;
        if (msg.type === 'undo') engine.undo();
        else engine.redo();
        startPrediction();
        snapshot();
        break;
      case 'seek':
        engine.seek(msg.step);
        startPrediction();
        snapshot();
        break;
      case 'replay':
        engine.replayFromStart();
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
