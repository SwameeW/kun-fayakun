/// <reference lib="webworker" />
import { planThrow } from './aim';
import { nextApproach } from './approach';
import { luminosities } from './climate';
import { commandId, Engine, Prediction, type Checkpoint } from './engine';
import { lookOf } from './looks';
import { accelerations, diagnostics, drift, type Diagnostics } from './nbody';
import type { LabReply, LabRequest, LabSnapshot } from './protocol';
import { REWIND_SEGMENT, Rewind, swarmPlaces } from './rewind';

/**
 * The orbital laboratory's worker: the engine (./engine) in Float64, off the main thread.
 *
 * Each tick (about 60 a second) it runs whole steps toward the time the requested rate asks for,
 * for at most STEP_BUDGET_MS of the tick (so the controls stay responsive however heavy the
 * scenario), and reports the rate it achieved: when it falls short, simulated time runs slower, never
 * skips. Going backwards (a negative rate) it shows the history replayed exactly (./rewind), a whole
 * step at a time, replaying the part before within the same budget, and stops (paused) at the start.
 * Going backwards it keeps to the pace the history can be replayed at, so a heavy experiment goes
 * back evenly; going forwards it keeps a full state every REWIND_SEGMENT steps (the latest
 * RECENT_MARKS), so going back starts from near the moment shown. Paused, it steps on (or back) to
 * the moment the page draws, so an edit is made on what is drawn. Going to a moment (`goto`) steps
 * toward it within the budget, and stops where it is at any run request (a pause, a rate).
 * Predictions (engine Prediction) run after the live steps, PREDICT_BUDGET_MS a tick, and a newer
 * request or any edit replaces the one under way. Snapshots go out about 30 times a second, with
 * what the page needs to draw between them smoothly (accelerations, the time owed) and a timeline
 * count that changes only when the run jumps.
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
/** Full states of the run kept as it goes forwards (one every REWIND_SEGMENT steps): going back replays from them. */
const RECENT_MARKS = 16;
/** Going back is shown at most this share of the pace its history is replayed at. */
const REWIND_MARGIN = 0.85;
const PREDICTION_SAMPLES = 360;
/** The fastest the clock runs either way (simulated seconds a second: thirty days, the time machine's top rung); a rate asked for beyond it is held to it, one not finite refused. */
const MAX_RATE = 2_592_000;
/** What is coming is looked for this many real seconds ahead at the rate asked for (./approach). */
const LOOKAHEAD_S = 4;
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
/** Paused: the moment the page draws, which the run steps on to (back to, going backwards) and stops at; or null. */
let landTo: number | null = null;
/** The run's recent full states, oldest first (./rewind replays from them). */
let marks: Checkpoint[] = [];
let boundAt = Number.NEGATIVE_INFINITY;
/** The diagnostics at the scenario's start (drift going backwards is measured from the edit before the moment shown, or from here). */
let startDiagnostics: Diagnostics | null = null;
const accScratch: number[] = [];

const post = (reply: LabReply, transfer: Transferable[] = []): void => {
  scope.postMessage(reply, transfer);
};

/** One step of the run forwards, keeping a full state every REWIND_SEGMENT steps. */
function stepOn(e: Engine): void {
  e.stepOnce();
  if (e.state.step % REWIND_SEGMENT === 0) {
    marks.push(e.snapshotNow());
    if (marks.length > RECENT_MARKS) marks.shift();
  }
}

/** The recent states still the run's own: after a jump back or a change of its log, those of a future it no longer has go. */
function trimMarks(e: Engine): void {
  marks = marks.filter((m) => m.step <= e.state.step && m.logIndex <= e.applied);
}

/** The run put exactly at the moment the history shows (before an edit, a run forwards, a seek), and the history let go. */
function settleRewind(): void {
  rewind?.commit();
  rewind = null;
  if (engine) trimMarks(engine);
}

/** Paused: whole steps on to the moment the page draws (back to it, going backwards) within the budget, and still there. */
function land(e: Engine, started: number): void {
  const to = landTo;
  if (to === null) return;
  if (rewind) {
    let guard = 0;
    while (rewind.shown.t > to && guard < 100_000 && rewind.stepBack()) guard += 1;
    if (rewind.shown.t <= to || rewind.atStart) landTo = null;
    return;
  }
  while (e.state.t < to && !e.failure && performance.now() - started < STEP_BUDGET_MS) stepOn(e);
  if (e.state.t >= to || e.failure) landTo = null;
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
  // What is coming within a few real seconds at the rate asked for (forwards only: going back, it has happened).
  const coming = !paused && rate > 0 && !shown ? nextApproach(s, rate * LOOKAHEAD_S, engine.keep) : null;
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
    looks: s.ids.map((_, i) => lookOf(s, i)),
    origin: s.ids.map((id) => s.origins[id] ?? null),
    rubble: [...s.rubble],
    upcoming: coming ? { ...coming, t: s.t + coming.inS } : null,
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
    // Going to a moment: whole steps toward it within the budget, whatever the rate, to the first at or past
    // it (with long steps, the last one short of it could be most of a day before: another date).
    while (engine.state.t < seekTo && !engine.failure && performance.now() - now < STEP_BUDGET_MS) stepOn(engine);
    if (engine.failure || engine.state.t >= seekTo) {
      seekTo = null;
      owed = 0;
      recent = [];
    }
  } else if (engine && !paused && !engine.failure && rate < 0) {
    // Backwards: the history a step at a time, the part before it replayed meanwhile (at the pace that can
    // be done, when that is short of the rate: evenly, not in bursts); paused at the start.
    if (!rewind) {
      rewind = new Rewind(engine, marks);
      // Short of its budget going forwards, replaying is no faster: shown at that pace from the first step back.
      if (now - boundAt < BOUND_HOLD_MS && achieved > 0) rewind.made = achieved;
    }
    const r = rewind;
    const t0 = r.shown.t;
    // A little under the pace history is made at, so the segments replayed ahead build up rather than run out.
    const speed = Math.min(-rate, REWIND_MARGIN * r.pace(now));
    if (speed < -rate) boundAt = now;
    // Waiting for the history before the moment shown, no backlog piles up (it would be taken in a burst after).
    owed = Math.min(owed + speed * wall, r.waiting ? r.shown.dt : speed * MAX_WALL_S + r.shown.dt);
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
      stepOn(engine);
      owed -= dt;
    }
    moved = engine.state.t - t0;
  } else {
    owed = 0;
    if (engine) land(engine, now);
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
      landTo = null;
      marks = [];
      startDiagnostics = null;
      // Held at its start until the page says how to run it (its 'run' follows): a tick between the two
      // would otherwise step the new scenario at the old one's pace, a Reset landing a step past the fork.
      paused = true;
      snapshot();
      startPrediction();
      return;
    }
    // Anything for an older scenario is ignored.
    if (msg.generation !== generation || !engine) return;
    switch (msg.type) {
      case 'run':
        control = msg.control;
        // A goto under way stops where it is (paused there, or running on from there).
        if (seekTo !== null) {
          seekTo = null;
          owed = 0;
          recent = [];
        }
        // Achieved is measured from a change of rate; time owed one way is not owed the other. A rate not
        // finite (or none) is refused (the last one kept); one beyond the fastest is held to it.
        if (Number.isFinite(msg.rate) && msg.rate !== 0) {
          const next = Math.sign(msg.rate) * Math.min(MAX_RATE, Math.abs(msg.rate));
          if (next !== rate) recent = [];
          if (Math.sign(next) !== Math.sign(rate)) owed = 0;
          rate = next;
        }
        paused = msg.paused;
        landTo = msg.paused && typeof msg.landAt === 'number' && Number.isFinite(msg.landAt) ? msg.landAt : null;
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
        landTo = null;
        const target = Math.max(0, Number.isFinite(msg.t) ? msg.t : 0);
        // To the fork, paused (a date before it): stopped at the start, as going backwards stops there.
        atStart = target === 0 && paused;
        // Back through the checkpoints (a jump: the page's drawn clock follows it), then on to it a few steps a tick.
        if (target < engine.state.t) {
          engine.restoreBefore(target);
          timeline += 1;
          trimMarks(engine);
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
        landTo = null;
        const before = engine.state.step;
        const had = new Set(engine.state.ids);
        const refused = engine.applyAt(msg.command, Number.isFinite(msg.atStep) ? (msg.atStep ?? engine.state.step) : engine.state.step);
        // Made on a view the run had passed: it went back there first.
        if (engine.state.step < before) timeline += 1;
        post({ type: 'ack', generation, editSeq: msg.editSeq ?? applied, ok: refused === null, reason: refused, created: engine.state.ids.filter((id) => !had.has(id)) });
        trimMarks(engine);
        startPrediction();
        snapshot();
        break;
      }
      case 'aim': {
        // From the moment shown (going backwards, the run is first put there exactly).
        settleRewind();
        const plan = planThrow(engine.state, engine.dt, engine.scenario.integrator, engine.keep, msg.request);
        post({ type: 'aimed', generation, requestId: msg.requestId, plan });
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
        landTo = null;
        atStart = false;
        if (msg.type === 'undo') engine.undo();
        else engine.redo();
        timeline += 1;
        trimMarks(engine);
        startPrediction();
        snapshot();
        break;
      case 'seek':
        // Only to a whole step up to the run's or its latest checkpoint's (one beyond would be replayed here at once, a huge one without end).
        if (!Number.isFinite(msg.step)) break;
        rewind = null;
        seekTo = null;
        landTo = null;
        atStart = false;
        engine.seek(Math.min(Math.max(engine.state.step, engine.checkpoints.at(-1)?.step ?? 0), Math.max(0, Math.floor(msg.step))));
        timeline += 1;
        trimMarks(engine);
        startPrediction();
        snapshot();
        break;
      case 'replay':
        rewind = null;
        seekTo = null;
        landTo = null;
        atStart = false;
        engine.replayFromStart();
        timeline += 1;
        trimMarks(engine);
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
