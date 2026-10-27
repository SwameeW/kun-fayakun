import { cloneState } from './nbody';
import { Engine, type Checkpoint } from './engine';

/**
 * Playing an experiment's history backwards (the time machine's Reverse in the laboratory), exactly.
 *
 * The engine (./engine) runs only forward, but deterministically: from any of its checkpoints the
 * log replays to the same state, bit for bit. So going back is replaying: from the latest checkpoint
 * before the moment shown, a replica of the engine (never the run itself) steps forward over a
 * segment of at most REWIND_SEGMENT steps, keeping a sample of every step (the bodies, their spins,
 * climates and ships; the rings' particles every few steps), and the samples are then shown in
 * reverse, a whole step at a time. While one segment is shown, the ones before it are replayed (up to
 * READY_AHEAD of them), a few steps a tick within the worker's budget (`work`). Across a long gap
 * between checkpoints the replica keeps full states every REWIND_SEGMENT steps on its way (marks), so
 * each segment further back replays only its own steps; the run's own recent marks (kept by the
 * worker as it runs forwards) let the first ones start there too. `pace` is how fast the history may
 * be shown so as not to run out (the pace segments are made ready at, and with none ready ahead, what
 * the one being replayed leaves time for), so a heavy experiment (rings of thousands of particles)
 * goes back at the pace it can be replayed, evenly, rather than in bursts and waits. Going back stops
 * at the scenario's start (step 0).
 *
 * The run itself stays where it was until the moment shown is needed (an edit, running forwards
 * again, a seek): `commit` then puts it exactly there (from that segment's full state, or from the
 * sample itself when no rings need their particles), so the history after it, the log and the
 * checkpoints are as they were, and an edit there branches as any edit does.
 *
 * A sample is the state as stepping reached its step, before the edits logged for that step are
 * applied (as a checkpoint taken there is): collisions with that step happen in the step after it.
 */

/** Steps in a segment of history replayed at once (and the spacing of the marks kept across a long gap). */
export const REWIND_SEGMENT = 256;
/** Segments replayed ahead of the one shown, at most. */
const READY_AHEAD = 2;
/** Particles' places a segment keeps, at most (single-precision triples: about 0.4 MB): every step for a few hundred particles, every 32nd for the most a scenario may have. */
const SWARM_BUDGET = 32_000;

/** The rings' particles as the worker sends them: each ring's id, name, primary, particles lost, and places relative to its primary (km). */
export type SwarmPlaces = Array<{ id: string; name: string; primary: string; lost: number; rel: Float32Array }>;

/** A moment of the history: a checkpoint without the rings' particles, and their places where this sample keeps them. */
export interface Sample extends Checkpoint {
  swarms: SwarmPlaces | null;
}

interface Segment {
  /** Its first step, its full state there (rings and all, to commit from), and one sample for each step from there. */
  lo: number;
  start: Checkpoint;
  samples: Sample[];
}

interface Job {
  /** The segment being made: from step lo up to (not including) hi; the replica on its way, and the segment once the replica reaches lo. */
  lo: number;
  hi: number;
  /** The checkpoint or mark the replica started from (marks are kept every REWIND_SEGMENT steps from it), and when it began (ms). */
  from: number;
  began: number;
  replica: Engine;
  segment: Segment | null;
  stride: number;
}

export const swarmPlaces = (state: Checkpoint['state']): SwarmPlaces => state.swarms.map((w) => ({ id: w.id, name: w.name, primary: w.primary, lost: w.lost, rel: Float32Array.from(w.pos) }));

function sampleOf(engine: Engine, keepSwarms: boolean): Sample {
  const s = engine.state;
  // Without the rings' particles, but with the accelerations the step from it starts from (commit goes on from it exactly).
  return { ...engine.snapshotNow(false), swarms: keepSwarms && s.swarms.length > 0 ? swarmPlaces(s) : null };
}

export class Rewind {
  private segment: Segment;
  private index = 0;
  /** The segments before the one shown, once replayed (the nearest first). */
  private ready: Segment[] = [];
  private job: Job | null = null;
  private marks: Checkpoint[];
  /** A replay that could not be made (the history did not replay healthily): going back stops where it is. */
  private broken = false;
  /** Simulated seconds of history made ready each real second, over the last segments replayed (Infinity until one is, unless set). */
  made = Number.POSITIVE_INFINITY;

  /** `marks`: full states of the run before now (with the edits applied by then) to replay from. */
  constructor(
    private readonly engine: Engine,
    marks: readonly Checkpoint[] = [],
  ) {
    // The moment shown first is the run's own state now (with its rings).
    const start = engine.snapshotNow();
    this.segment = { lo: start.step, start, samples: [{ ...start, state: cloneState(engine.state, false), swarms: swarmPlaces(engine.state) }] };
    this.marks = marks.filter((m) => m.step < start.step);
  }

  /** The moment shown. */
  get shown(): Sample {
    return this.segment.samples[this.index] ?? this.segment.samples[0] ?? { ...this.segment.start, swarms: null };
  }

  /** The rings' particles to draw at the moment shown: its own, or the segment's latest kept before it. */
  get swarms(): SwarmPlaces {
    for (let k = this.index; k >= 0; k -= 1) {
      const w = this.segment.samples[k]?.swarms;
      if (w) return w;
    }
    return swarmPlaces(this.segment.start.state);
  }

  /** Back at the scenario's start (or as far back as the history could be replayed). */
  get atStart(): boolean {
    return this.index === 0 && (this.segment.lo === 0 || this.broken);
  }

  /** Waiting for the history before the moment shown (going back holds there meanwhile). */
  get waiting(): boolean {
    return this.index === 0 && !this.atStart && this.ready.length === 0;
  }

  /**
   * Goes back by up to `seconds` of simulated time, a whole step at a time, and returns what is left
   * (less than the step before the moment shown, or all of it while that step is being replayed; 0 at
   * the start).
   */
  back(seconds: number): number {
    let left = seconds;
    for (;;) {
      if (this.index > 0) {
        const step = (this.segment.samples[this.index]?.t ?? 0) - (this.segment.samples[this.index - 1]?.t ?? 0);
        if (left < step) return left;
        left -= step;
        this.index -= 1;
        continue;
      }
      if (this.atStart) return 0;
      const before = this.ready[0];
      const last = before?.samples[before.samples.length - 1];
      if (!before || !last) return left;
      const step = (this.segment.samples[0]?.t ?? 0) - last.t;
      if (left < step) return left;
      left -= step;
      this.segment = before;
      this.index = before.samples.length - 1;
      this.ready.shift();
      // Marks after this segment's start are behind the moment shown for good.
      this.marks = this.marks.filter((m) => m.step <= before.lo);
    }
  }

  /**
   * How fast the history may be shown going back (simulated s per real s, `nowMs` now): the pace it is
   * made ready at, and, with none ready ahead, no faster than lets what is left of the segment shown
   * last until the one being replayed is ready (from the replay's own pace so far).
   */
  pace(nowMs: number = performance.now()): number {
    const job = this.job;
    if (!job || this.ready.length > 0) return this.made;
    const done = job.replica.state.step - job.from;
    const seconds = (nowMs - job.began) / 1000;
    if (!(done > 0) || !(seconds > 0)) return this.made;
    const left = ((job.hi - 1 - job.from - done) * seconds) / done;
    const showable = this.shown.t - (this.segment.samples[0]?.t ?? this.shown.t);
    return left > 0 ? Math.min(this.made, showable / left) : this.made;
  }

  /** Goes back exactly one step, if the history before it is ready (false at the start or while it is replayed). */
  stepBack(): boolean {
    const t = this.shown.t;
    const before = this.index > 0 ? this.segment.samples[this.index - 1] : this.ready[0]?.samples.at(-1);
    if (!before || this.atStart) return false;
    this.back(t - before.t);
    return this.shown.t !== t;
  }

  /** Replays the history before the segments shown and made ready, for at most `budgetMs` (`now` in ms). */
  work(budgetMs: number, now: () => number = () => performance.now()): void {
    const earliest = this.ready.at(-1) ?? this.segment;
    if (this.ready.length >= READY_AHEAD || earliest.lo === 0 || this.broken) return;
    const started = now();
    const job = (this.job ??= this.plan(earliest.lo, started));
    while (now() - started < budgetMs) {
      const r = job.replica;
      if (r.failure) {
        this.broken = true;
        this.job = null;
        return;
      }
      if (!job.segment) {
        if (r.state.step >= job.lo) {
          job.segment = { lo: job.lo, start: r.snapshotNow(), samples: [sampleOf(r, true)] };
        } else {
          r.stepOnce();
          if (r.state.step < job.lo && (r.state.step - job.from) % REWIND_SEGMENT === 0) this.marks.push(r.snapshotNow());
          continue;
        }
      }
      const seg = job.segment;
      if (r.state.step >= job.hi - 1) {
        this.ready.push(seg);
        this.job = null;
        // The pace history is made at (a mean over the last few, so one slow replay across a long gap counts, not rules).
        const made = (seg.samples.at(-1)?.t ?? 0) - (seg.samples[0]?.t ?? 0) + (seg.samples.at(-1)?.dt ?? 0);
        const took = Math.max(1e-3, (now() - job.began) / 1000);
        this.made = Number.isFinite(this.made) ? 0.5 * this.made + 0.5 * (made / took) : made / took;
        return;
      }
      r.stepOnce();
      seg.samples.push(sampleOf(r, (r.state.step - job.lo) % job.stride === 0));
    }
  }

  /** The segment ending just before `hi`: from the latest checkpoint or mark before it, on the grid of marks from there (`began`: now, ms). */
  private plan(hi: number, began: number): Job {
    const e = this.engine;
    let base: Checkpoint | undefined;
    for (const c of [...e.checkpoints, ...this.marks]) {
      if (c.step >= hi || c.logIndex > e.scenario.log.length) continue;
      // At the same step, the one with fewer edits applied (the state before them, as samples are).
      if (!base || c.step > base.step || (c.step === base.step && c.logIndex < base.logIndex)) base = c;
    }
    const from = base ?? this.segment.start;
    const lo = from.step + Math.floor(Math.max(0, hi - 1 - from.step) / REWIND_SEGMENT) * REWIND_SEGMENT;
    const particles = from.state.swarms.reduce((n, w) => n + w.pos.length / 3, 0);
    const kept = Math.max(1, Math.min(REWIND_SEGMENT, Math.floor(SWARM_BUDGET / Math.max(particles, 1))));
    return { lo, hi, from: from.step, began, replica: new Engine(e.scenario, from), segment: null, stride: Math.ceil(REWIND_SEGMENT / kept) };
  }

  /**
   * Puts the run exactly at the moment shown: from the sample itself when no rings are about (it holds
   * everything else), otherwise from its segment's full state, replayed (at most REWIND_SEGMENT steps).
   */
  commit(): void {
    const x = this.shown;
    const e = this.engine;
    if (x.step === e.state.step && x.t === e.state.t) return;
    const ringsAbout = this.segment.start.state.swarms.length > 0 || e.scenario.log.some((l) => l.step >= this.segment.lo && l.step <= x.step && l.command.kind === 'addSwarm');
    if (ringsAbout) e.restoreFrom(this.segment.start, x.step);
    else e.restoreFrom(x);
  }
}
