/**
 * The laboratory's history played backwards (src/sim/rewind) and its drawn clock (src/explore/lab-clock):
 * every moment gone back through is the state the run had there, bit for bit (the solar system with
 * the IAU spins and J2s; with an edit and a merger; past evicted checkpoints; with a ring's particles);
 * going back stops at the start; the run put at a moment gone back to goes on exactly as it did; the
 * checkpoints stay spread over the whole run; going back from the run's own recent states replays
 * only the last few steps first, and the pace history is made at is measured; and the drawn clock
 * never turns back, keeps its pace (also when the worker is short of its budget, either way), lands
 * on the worker's state when paused within a quarter of a second, and draws a planet between
 * snapshots where Kepler puts it.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { Engine, type Scenario } from '../../src/sim/engine';
import { REWIND_SEGMENT, Rewind } from '../../src/sim/rewind';
import type { Checkpoint } from '../../src/sim/engine';
import { seedLaboratory, seedSolarSystem } from '../../src/sim/seed';
import { BOUND_LAG_S, DRAW_LAG_S, LAND_S, LabClock, placeAt, type PlaceSnapshot } from '../../src/explore/lab-clock';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;

interface Seen {
  t: number;
  step: number;
  pos: number[];
  vel: number[];
  spin: number[];
  ids: string[];
}
const seen = (e: Engine): Seen => ({ t: e.state.t, step: e.state.step, pos: [...e.state.pos], vel: [...e.state.vel], spin: [...e.state.spin], ids: [...e.state.ids] });

/** Runs `e` forward to `steps`, keeping every `every`th state (and the last); `edits` at their steps (applied as the visitor would, after the state there is kept). */
function run(e: Engine, steps: number, every: number, edits: Record<number, Parameters<Engine['apply']>[0]> = {}): Map<number, Seen> {
  const kept = new Map<number, Seen>();
  while (e.state.step < steps) {
    e.stepOnce();
    const step = e.state.step;
    if (step % every === 0 || step === steps) kept.set(step, seen(e));
    const edit = edits[step];
    if (edit) e.apply(edit);
  }
  return kept;
}

/** Plays `e`'s history all the way back, one step at a time, checking every kept state on the way; returns the steps passed. */
function rewindChecking(e: Engine, kept: Map<number, Seen>, start: number): number {
  const r = new Rewind(e);
  let passed = 0;
  let guard = 0;
  let last = r.shown.step;
  while (!r.atStart && guard < 10_000_000) {
    guard += 1;
    r.work(1e9);
    if (!r.stepBack()) continue;
    const x = r.shown;
    // Always one step back, never a skip.
    expect(x.step).toBe(last - 1);
    last = x.step;
    passed += 1;
    const want = kept.get(x.step);
    if (want) {
      expect(x.t).toBe(want.t);
      expect(x.state.ids).toEqual(want.ids);
      expect(x.state.pos).toEqual(want.pos);
      expect(x.state.vel).toEqual(want.vel);
      expect(x.state.spin).toEqual(want.spin);
    }
  }
  expect(r.atStart).toBe(true);
  expect(r.shown.step).toBe(0);
  expect(r.shown.t).toBe(0);
  // At the start nothing more is owed or taken.
  expect(r.back(1e9)).toBe(0);
  expect(passed).toBe(start);
  return passed;
}

/** The sourced constants: each world's J2 and moment of inertia, as the explorer seeds an experiment with them. */
const constants = (readJson('data/constants.json') as { constants: Array<{ id: string; value: number }> }).constants;
const figure = (id: string): number | null => constants.find((c) => c.id === id)?.value ?? null;
const SOLAR_IDS = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/** The solar system as an experiment forks it: with each world's J2 about its spin's axis, so the pull and the spins are coupled. */
function solar(): Scenario {
  const eph = createEphemeris(readJson('public/assets/jpl/planets.json') as PlanetsFile, readJson('public/assets/jpl/moon.json') as MoonFile, physical);
  const shapes = Object.fromEntries(SOLAR_IDS.map((id) => [id, { j2: figure(`${id}.j2`), inertia: figure(`${id}.momentOfInertia`) }]));
  return seedSolarSystem(eph, physical, 2_461_336.75, {}, shapes);
}

test('the solar system played backwards: every moment is the run’s own, bit for bit, back to the fork', () => {
  const e = new Engine(solar());
  // Oblate, as an experiment's worlds are: the Earth's and Jupiter's J2s, so a replay that worked the pull out afresh would drift in the last bits.
  expect(e.state.j2[e.state.ids.indexOf('earth')]).toBeGreaterThan(1e-3);
  expect(e.state.j2[e.state.ids.indexOf('jupiter')]).toBeGreaterThan(1e-2);
  const kept = run(e, 5000, 100);
  rewindChecking(e, kept, 5000);
  // The run itself was never touched while its history was replayed.
  expect(e.state.step).toBe(5000);
  expect(seen(e)).toEqual(kept.get(5000));
});

test('backwards through an edit and a merger: the state before each, exactly, and the run put there goes on as it did', () => {
  const base = solar();
  const e = new Engine(structuredClone(base));
  const moon = (s: Engine): number => s.state.ids.indexOf('moon');
  // The Sun's mass doubled at step 1000; at 2000 the Moon thrown at the Earth (a merger soon after).
  const kept = run(e, 1999, 50, { 1000: { kind: 'setMass', id: 'sun', gm: 2 * 132_712_440_041.279 } });
  const earth = e.state.ids.indexOf('earth');
  const at = [0, 1, 2].map((k) => e.state.pos[earth * 3 + k] ?? 0);
  const v = [0, 1, 2].map((k) => e.state.vel[earth * 3 + k] ?? 0);
  e.stepOnce();
  kept.set(e.state.step, seen(e));
  e.apply({ kind: 'setState', id: 'moon', pos: [(at[0] ?? 0) + 20_000, at[1] ?? 0, at[2] ?? 0], vel: [(v[0] ?? 0) - 3, v[1] ?? 0, v[2] ?? 0] });
  for (const [step, s] of run(e, 4000, 50)) kept.set(step, s);
  expect(moon(e)).toBe(-1);
  expect(e.events.some((x) => x.absorbed === 'moon' || x.survivor === 'moon')).toBe(true);
  const final = seen(e);
  rewindChecking(e, kept, 4000);

  // Gone back to a moment between the edits: the run put exactly there, then on to the end, reaches the same end.
  const r = new Rewind(e);
  while (r.shown.step > 1500) {
    r.work(1e9);
    r.stepBack();
  }
  expect(r.shown.step).toBe(1500);
  r.commit();
  expect(seen(e)).toEqual(kept.get(1500));
  // The merger has not happened there yet; the Sun's doubling has.
  expect(e.events.filter((x) => x.step >= 1500)).toEqual([]);
  expect(e.interventions.map((i) => i.command.kind)).toEqual(['setMass']);
  e.advanceTo(Number.POSITIVE_INFINITY, 4000 - 1500);
  expect(seen(e)).toEqual(final);
});

test('backwards past evicted checkpoints: the checkpoints stay spread over the run, and a long gap is replayed a segment at a time', () => {
  const e = new Engine(seedLaboratory(physical, false));
  const kept = run(e, 30_000, 500);
  const steps = e.checkpoints.map((c) => c.step);
  // At most 48, in order, from the start to the latest, none of the gaps more than a few times the average.
  expect(steps.length).toBeLessThanOrEqual(48);
  expect(steps[0]).toBe(0);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
  const gaps = steps.slice(1).map((s, k) => s - (steps[k] ?? 0));
  expect(Math.max(...gaps)).toBeLessThan((4 * 30_000) / 48);
  rewindChecking(e, kept, 30_000);
});

test('a ring’s particles are carried back with the bodies, and the run put back among them goes on exactly', () => {
  const s = seedLaboratory(physical, false);
  s.log.push({ step: 10, command: { kind: 'addSwarm', swarm: { id: 'ring-1', name: 'Ring', primary: 'planet', count: 300, innerKm: 20_000, outerKm: 60_000, eccentricity: 0, inclinationDeg: 0, normal: [0, 0, 1], seed: 7 } } });
  const e = new Engine(s);
  const kept = run(e, 2 * REWIND_SEGMENT + 40, 7);
  const final = { ...seen(e), ring: [...(e.state.swarms[0]?.pos ?? [])] };
  expect(final.ring.length).toBeGreaterThan(0);
  const r = new Rewind(e);
  while (r.shown.step > REWIND_SEGMENT + 3) {
    r.work(1e9);
    r.stepBack();
  }
  // The particles drawn are the ring's at (or a few steps before) the moment shown.
  expect(r.swarms[0]?.rel.length).toBe(final.ring.length);
  const x = r.shown.step;
  r.commit();
  expect(x % 7).toBe(0);
  expect(seen(e)).toEqual(kept.get(x));
  expect(e.state.swarms.length).toBe(1);
  e.advanceTo(Number.POSITIVE_INFINITY, 2 * REWIND_SEGMENT + 40 - x);
  expect({ ...seen(e), ring: [...(e.state.swarms[0]?.pos ?? [])] }).toEqual(final);
});

test('the drawn clock: never back, an even pace, a little behind the worker and holding when it falls behind', () => {
  // A synthetic worker: steps of 3,700 s, a snapshot every 48 ms (each a few ms late), at a day a second; frames at 60 Hz.
  const rate = 86_400;
  const dtStep = 3700;
  const clock = new LabClock();
  let workerT = 0;
  let owed = 0;
  let nextSnap = 0;
  let snapshot = { t: 0, dt: dtStep, owed: 0, timeline: 0, at: 0 };
  const shownByFrame: number[] = [];
  for (let frame = 0; frame < 60 * 8; frame += 1) {
    const now = (frame * 1000) / 60;
    // The worker: whole steps of what is owed, ticking every 16 ms.
    owed += rate / 60;
    while (owed >= dtStep) {
      workerT += dtStep;
      owed -= dtStep;
    }
    if (now >= nextSnap) {
      snapshot = { t: workerT, dt: dtStep, owed, timeline: 0, at: now + (frame % 3) * 2 };
      nextSnap += 48;
    }
    shownByFrame.push(clock.advance(1 / 60, rate, true, snapshot, now));
  }
  const steps = shownByFrame.slice(60).map((t, k) => t - (shownByFrame[59 + k] ?? 0));
  // Never back.
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
  // An even pace: the 95th percentile step within 1.6 times the median, and the median the rate's.
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  expect(median).toBeGreaterThan(0.9 * (rate / 60));
  expect(median).toBeLessThan(1.1 * (rate / 60));
  expect(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toBeLessThan(1.6 * median);
  // Behind the moment asked for by about the lag, never by more than the lag and a step.
  const asked = rate * 8;
  expect(asked - (shownByFrame.at(-1) ?? 0)).toBeLessThan(rate * DRAW_LAG_S + dtStep + rate / 30);

  // Paused, it stays; a worker that stops sending holds it a step past its last snapshot, never back.
  const paused = clock.shown;
  for (let k = 0; k < 10; k += 1) expect(clock.advance(1 / 60, rate, false, snapshot, 8000 + k * 16)).toBe(paused);
  let held = paused;
  for (let k = 0; k < 120; k += 1) {
    const next = clock.advance(1 / 60, rate, true, snapshot, 8000 + k * 16);
    expect(next).toBeGreaterThanOrEqual(held);
    held = next;
  }
  expect(held).toBeLessThanOrEqual(snapshot.t + dtStep);
  // A new timeline (a seek) alone moves it back.
  expect(clock.advance(1 / 60, rate, true, { ...snapshot, t: 1000, timeline: 1 }, 10_000)).toBe(1000);

  // Backwards, the mirror: never forward.
  const back = new LabClock();
  let t = 1e7;
  back.advance(0, -rate, true, { t, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 0);
  let prev = back.shown;
  for (let frame = 1; frame < 240; frame += 1) {
    const now = (frame * 1000) / 60;
    if (frame % 3 === 0) t -= dtStep * Math.floor(rate / 20 / dtStep);
    const shown = back.advance(1 / 60, -rate, true, { t, dt: dtStep, owed: 0, timeline: 0, at: now }, now);
    expect(shown).toBeLessThanOrEqual(prev);
    prev = shown;
  }
  expect(prev).toBeLessThan(1e7 - rate * 2);
  // Landing at the start: on to the worker's moment, then still.
  const land = new LabClock();
  land.advance(0, -rate, true, { t: 5000, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 0);
  for (let k = 0; k < 30; k += 1) land.advance(1 / 60, -rate, false, { t: 0, dt: dtStep, owed: 0, timeline: 0, at: 0 }, k * 16, 'land');
  expect(land.shown).toBe(0);
  // Paused: on to the worker's moment in the direction of travel, never back to it.
  const still = new LabClock();
  still.advance(0, rate, true, { t: 5000, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 0);
  expect(still.advance(1 / 60, rate, false, { t: 4000, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 16, 'land')).toBe(5000);
  expect(still.advance(1 / 60, rate, false, { t: 9000, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 32, 'land')).toBe(5000 + rate / 60);
  expect(still.advance(1, rate, false, { t: 9000, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 48, 'land')).toBe(9000);
  // A new scenario: set wherever its first snapshot is.
  still.restart();
  expect(still.advance(1 / 60, rate, true, { t: 0, dt: dtStep, owed: 0, timeline: 0, at: 0 }, 64)).toBe(0);
});

test('going back from the run’s own recent states: only the steps since the latest one are replayed first, exactly; the pace of replay is measured', () => {
  // As the worker runs forwards: a full state every REWIND_SEGMENT steps (no checkpoint near the end).
  const e = new Engine(solar());
  const marks: Checkpoint[] = [];
  const kept = new Map<number, Seen>();
  const forwards = (to: number): void => {
    while (e.state.step < to) {
      e.stepOnce();
      kept.set(e.state.step, seen(e));
      if (e.state.step % REWIND_SEGMENT === 0) marks.push(e.snapshotNow());
    }
  };
  // On until well past the latest periodic checkpoint (two marks and a hundred steps beyond it).
  forwards(1000);
  const latest = Math.max(...e.checkpoints.map((c) => c.step));
  const end = (Math.floor(Math.max(latest, e.state.step) / REWIND_SEGMENT) + 3) * REWIND_SEGMENT + 108;
  forwards(end);
  expect(Math.max(...e.checkpoints.map((c) => c.step))).toBe(latest);
  const lastMark = Math.floor(end / REWIND_SEGMENT) * REWIND_SEGMENT;
  /** Steps a replica takes before the history before the moment shown is ready (a clock that counts calls, one per step). */
  const replayed = (r: Rewind): number => {
    let calls = 0;
    const now = (): number => (calls += 1);
    while (r.waiting) r.work(1e9, now);
    return calls;
  };
  const withMarks = new Rewind(e, marks);
  const fresh = new Rewind(e);
  const a = replayed(withMarks);
  const b = replayed(fresh);
  // From the latest mark: the 108 steps since, not all those since the last checkpoint.
  expect(a).toBeLessThan(end - lastMark + 10);
  expect(b).toBeGreaterThan(end - latest);
  // The same history either way, bit for bit.
  for (let k = 0; k < 150; k += 1) {
    expect(withMarks.stepBack()).toBe(true);
    const x = withMarks.shown;
    const want = kept.get(x.step);
    expect(x.state.pos).toEqual(want?.pos);
    expect(x.state.vel).toEqual(want?.vel);
    withMarks.work(1e9);
  }
  // How fast history is made ready, measured (here from a clock of whole milliseconds: finite, positive).
  expect(Number.isFinite(withMarks.made)).toBe(true);
  expect(withMarks.made).toBeGreaterThan(0);
  // With a segment being replayed and none ready ahead, no faster than what is left to show lasts while it
  // is: the slower its replay has gone so far, the slower the history may be shown.
  const slow = new Rewind(e, marks);
  let ms = 0;
  const clock = (): number => (ms += 1);
  slow.work(1e9, clock);
  // Into the segment just made (none ready ahead), half of it shown, and a few steps of the one before replayed.
  slow.back((slow.shown.t - (e.state.t - 60 * 3300)) / 1);
  slow.work(5, clock);
  const soon = slow.pace(ms + 10);
  const later = slow.pace(ms + 10_000);
  expect(soon).toBeGreaterThan(0);
  expect(later).toBeLessThan(soon);
});

test('the drawn clock short of the worker’s budget (heavy rings at thirty days a second): it moves every frame, evenly, a little behind, either way', () => {
  // The probe's pattern: the worker reaches about 1.5 million s a second of the 2.6 asked for, a snapshot every 33 to 50 ms
  // carrying 40,000 to 61,000 s (whole steps of 3,300 s), and owing more than a step all along.
  const rate = 2_592_000;
  const dtStep = 3300;
  for (const d of [1, -1]) {
    const clock = new LabClock();
    let workerT = d > 0 ? 0 : 1e9;
    let nextSnap = 0;
    let k = 0;
    const held: Array<{ t: number; at: number }> = [];
    let snapshot = { t: workerT, dt: dtStep, owed: 200_000, budgetBound: true, timeline: 0, at: 0 };
    clock.advance(0, d * rate, true, snapshot, 0);
    const shown: number[] = [];
    for (let frame = 0; frame < 60 * 6; frame += 1) {
      const now = (frame * 1000) / 60;
      if (now >= nextSnap) {
        workerT += d * dtStep * (k % 3 === 1 ? 12 : 18);
        k += 1;
        snapshot = { t: workerT, dt: dtStep, owed: 200_000, budgetBound: true, timeline: 0, at: now };
        held.push({ t: workerT, at: now });
        if (held.length > 6) held.shift();
        nextSnap += k % 2 === 0 ? 33 : 50;
      }
      // The pace reached, as the laboratory measures it over the snapshots it holds.
      const first = held[0];
      const reached = first && snapshot.at - first.at > 100 ? (Math.abs(snapshot.t - first.t) * 1000) / (snapshot.at - first.at) : 0;
      shown.push(clock.advance(1 / 60, d * rate, true, snapshot, now, 'run', reached));
    }
    const steps = shown.slice(60).map((t, i) => d * (t - (shown[59 + i] ?? 0)));
    // Never back, frozen on at most a couple of frames, and even.
    expect(Math.min(...steps), `${String(d)}: never back`).toBeGreaterThanOrEqual(0);
    expect(steps.filter((x) => x === 0).length, `${String(d)}: frozen frames`).toBeLessThanOrEqual(2);
    const sorted = [...steps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(sorted[Math.floor(sorted.length * 0.95)] ?? 0, `${String(d)}: even`).toBeLessThan(1.6 * median);
    // At the pace the worker reaches (not the rate asked for), a little behind its newest snapshot, never past it.
    const reachedPace = (Math.abs(workerT - (d > 0 ? 0 : 1e9)) * 1000) / (6 * 1000);
    expect(median * 60).toBeGreaterThan(0.8 * reachedPace);
    expect(median * 60).toBeLessThan(1.2 * reachedPace);
    const behind = d * (snapshot.t - (shown.at(-1) ?? 0));
    expect(behind).toBeGreaterThanOrEqual(0);
    expect(behind).toBeLessThan(reachedPace * (BOUND_LAG_S + 0.1));
  }
});

test('paused, the drawn clock lands on the worker’s state within a quarter of a second, however far (a whole 14-hour step at ten seconds a second), and stays', () => {
  for (const [rate, shownAt, workerAt] of [
    [10, 30, 50_226],
    [3600, 20_506, 50_226],
    [-86_400, 40_000, 37_000],
  ] as const) {
    const clock = new LabClock();
    clock.advance(0, rate, true, { t: shownAt, dt: 50_226, owed: 0, timeline: 0, at: 0 }, 0);
    const path: number[] = [];
    for (let frame = 1; frame <= 60; frame += 1) path.push(clock.advance(1 / 60, rate, false, { t: workerAt, dt: 50_226, owed: 0, timeline: 0, at: 0 }, (frame * 1000) / 60, 'land'));
    const d = rate > 0 ? 1 : -1;
    // On in the direction of travel only, there by LAND_S (and a frame), and still there.
    for (let k = 1; k < path.length; k += 1) expect(d * ((path[k] ?? 0) - (path[k - 1] ?? 0))).toBeGreaterThanOrEqual(0);
    expect(path[Math.ceil(LAND_S * 60)]).toBe(workerAt);
    expect(path.at(-1)).toBe(workerAt);
  }
});

test('drawn between snapshots: a planet where Kepler puts it, within a kilometre, at half a step and a whole one', () => {
  const GM = 132_712_440_041.279 + 398_600.435;
  const r = 149_597_870.7;
  const n = Math.sqrt(GM / r ** 3);
  const at = (t: number): PlaceSnapshot => {
    const c = Math.cos(n * t);
    const s = Math.sin(n * t);
    const v = n * r;
    const a = n * n * r;
    return { t, dt: 50_226, ids: ['planet'], pos: [r * c, r * s, 0], vel: [-v * s, v * c, 0], acc: [-a * c, -a * s, 0] };
  };
  const dt = 50_226;
  const list = [at(0), at(dt)];
  for (const tau of [dt / 2, dt]) {
    const out = [0, 0, 0];
    expect(placeAt(list, 'planet', tau, out)).toBe(true);
    const want = at(tau).pos;
    expect(Math.hypot((out[0] ?? 0) - (want[0] ?? 0), (out[1] ?? 0) - (want[1] ?? 0), (out[2] ?? 0) - (want[2] ?? 0))).toBeLessThan(1);
  }
  // Beyond the newest, carried on by its velocity and acceleration (the second order term): within a kilometre over half a step.
  const out = [0, 0, 0];
  placeAt([at(0)], 'planet', dt / 2, out);
  const want = at(dt / 2).pos;
  expect(Math.hypot((out[0] ?? 0) - (want[0] ?? 0), (out[1] ?? 0) - (want[1] ?? 0))).toBeLessThan(25);
  // Never further than a step from what is known; unknown bodies are not drawn.
  placeAt([at(0)], 'planet', 10 * dt, out);
  const edge = at(0);
  expect(Math.hypot((out[0] ?? 0) - (edge.pos[0] ?? 0), (out[1] ?? 0) - (edge.pos[1] ?? 0))).toBeLessThan(n * r * dt * 1.01);
  expect(placeAt([at(0)], 'moon', 0, out)).toBe(false);
});
