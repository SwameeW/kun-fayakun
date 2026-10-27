/**
 * A goto in the laboratory (src/sim/goto, as the worker runs it, on the real engine): it ends on the
 * first whole step at or past the moment asked, and a date's is kept to its day (UTC, as the date
 * field shows it), whatever the time of day and the step. Moments a second and half a minute either
 * side of midnight, and at noon, on twenty days in a row, going there forwards and going back, with
 * short steps (a quarter of an hour), the two-body laboratory's long ones (about 14 hours, retimed as
 * it runs), steps of exactly a day, and longer ones (the nearer step to the day). An edit due at the
 * step the goto reaches retimes the step before it is weighed. Each rule alone is shown to miss the
 * day here: the first step at or past a late moment, and batch 1's aim (a moment early in the day
 * moved 1.5 steps into it) with it, which together sent 2010-06-15 to the 16th (tests/explore/lab.spec.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { PhysicalFile } from '../../src/astro/physical';
import { Engine, type Scenario } from '../../src/sim/engine';
import { dayWithin, gotoMove, seekOn, validWithin, type Within } from '../../src/sim/goto';
import { seedLaboratory } from '../../src/sim/seed';

const ROOT = new URL('../../', import.meta.url);
const physical = JSON.parse(readFileSync(new URL('public/assets/jpl/physical.json', ROOT), 'utf8')) as PhysicalFile;

const DAY_MS = 86_400_000;
const AU = physical.auKm;
/** TDB minus UTC as the explorer draws the clock (its date in 2026: 37 leap seconds and 32.184 s), in days. */
const OFFSET = 69.184 / 86_400;
const tdbOf = (jdUtc: number): number => jdUtc + OFFSET;
const jdOf = (ms: number): number => ms / DAY_MS + 2_440_587.5;
/** The UTC moment (ms) a run's time is drawn at, and its day as the date field shows it. */
const msOf = (e: Engine, t: number): number => (e.scenario.epochJdTdb + t / 86_400 - OFFSET - 2_440_587.5) * DAY_MS;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Times of day asked for: a second and half a minute after midnight, noon, half a minute and a second before midnight. */
const TIMES = [1_000, 30_000, DAY_MS / 2, DAY_MS - 30_000, DAY_MS - 1_000];
/** Twenty days in a row, from 1 March 2000 (the two-body laboratory is forked at J2000). */
const DAYS = Array.from({ length: 20 }, (_, k) => Date.UTC(2000, 2, 1 + k));

function lab(fixedDtS: number | null): Scenario {
  const s = seedLaboratory(physical, false);
  s.integrator = { ...s.integrator, fixedDtS };
  return s;
}

const step = (e: Engine): void => {
  e.stepOnce();
};
const always = (): boolean => true;

/** A goto to `ms` (UTC), as the worker makes one: back through the checkpoints when it is behind the run, then on; kept to its day when `day`. */
function goTo(e: Engine, ms: number, day = true): { to: number; within: Within | null } {
  const epoch = e.scenario.epochJdTdb;
  const to = (tdbOf(jdOf(ms)) - epoch) * 86_400;
  const within = day ? validWithin(dayWithin(jdOf(ms), epoch, tdbOf), to) : null;
  if (to < e.state.t) e.restoreBefore(to);
  expect(seekOn(e, to, within, step, always)).toBe(true);
  return { to, within };
}

for (const [name, fixedDtS] of [
  ['short steps (a quarter of an hour)', 900],
  ['the two-body laboratory’s long steps (about 14 hours)', null],
  ['steps of exactly a day', 86_400],
] as const) {
  test(`a date lands on the day asked, at any time of day, with ${name}`, () => {
    const e = new Engine(lab(fixedDtS));
    if (fixedDtS === null) expect(e.dt).toBeGreaterThan(13.5 * 3600);
    let before = 0;
    let after = 0;
    for (const back of [false, true]) {
      for (const day of DAYS) {
        for (const tod of TIMES) {
          const ms = day + tod;
          // Going back: from a month on (the run restored from a checkpoint before the moment, then stepped on).
          if (back) goTo(e, day + 30 * DAY_MS + DAY_MS / 2, false);
          else e.restoreBefore(0);
          const { to, within } = goTo(e, ms);
          const at = e.state.t;
          expect(within, `${dayOf(ms)}: a span`).not.toBeNull();
          expect(dayOf(msOf(e, at)), `${new Date(ms).toISOString()} asked, ${new Date(msOf(e, at)).toISOString()} reached`).toBe(dayOf(ms));
          // The first step at or past the moment; short of it only where that one would be the next day's.
          const next = at + e.nextStepS();
          if (at < to) {
            expect(next).toBeGreaterThanOrEqual(within?.[1] ?? Infinity);
            before += 1;
          } else {
            if (fixedDtS !== null) expect(at - fixedDtS).toBeLessThan(to);
            after += 1;
          }
        }
      }
    }
    // Both kinds of landing came up: past the moment, and on the day's last step short of it.
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
  });
}

test('with steps longer than a day (a file’s own integrator) a date ends on the nearer of the steps about its day', () => {
  const dt = 1.5 * 86_400;
  const e = new Engine(lab(dt));
  let over = 0;
  for (const day of DAYS) {
    for (const tod of TIMES) {
      e.restoreBefore(0);
      const { to, within } = goTo(e, day + tod);
      const at = e.state.t;
      const [lo, hi] = within ?? [to, to];
      const off = at < lo ? lo - at : at >= hi ? at - hi : 0;
      // Inside the day when a step falls in it; else at most half the step's excess over the day away.
      expect(off).toBeLessThanOrEqual((dt - (hi - lo)) / 2 + 1e-6);
      if (off > 0) over += 1;
    }
  }
  expect(over).toBeGreaterThan(0);
});

test('an edit due at the step a goto reaches retimes the step before it is weighed', () => {
  // The planet moved out to 3 au at a step early in a day: from there on the steps are a whole day long.
  const probe = new Engine(lab(null));
  while (!(probe.state.t > 40 * 86_400 && (msOf(probe, probe.state.t) % DAY_MS) / 3_600_000 < 9)) probe.stepOnce();
  const k = probe.state.step;
  const landed = msOf(probe, probe.state.t);
  const s = lab(null);
  const v = Math.sqrt((physical.gmKm3S2.Sun + physical.gmKm3S2.Earth) / (3 * AU));
  s.log.push({ step: k, command: { kind: 'setState', id: 'planet', pos: [3 * AU, 0, 0], vel: [0, v, 0] } });
  // The same day, half a minute to midnight: the step after k (a day long once the edit is made) is the next day's.
  const e = new Engine(s);
  const ms = Math.floor(landed / DAY_MS) * DAY_MS + DAY_MS - 30_000;
  goTo(e, ms);
  expect(e.state.step).toBe(k);
  expect(e.applied).toBe(1);
  expect(e.dt).toBe(86_400);
  expect(dayOf(msOf(e, e.state.t))).toBe(dayOf(ms));
});

test('each rule alone misses the day: the first step at or past a late moment, and batch 1’s aim with it', () => {
  // The first step at or past half a minute to midnight is the next day's, with short steps and with long ones.
  for (const fixedDtS of [900, null]) {
    const e = new Engine(lab(fixedDtS));
    const missed = DAYS.filter((day) => {
      e.restoreBefore(0);
      goTo(e, day + DAY_MS - 30_000, false);
      return dayOf(msOf(e, e.state.t)) !== dayOf(day);
    });
    expect(missed.length).toBeGreaterThan(DAYS.length / 2);
  }
  // Batch 1 aimed a moment within 1.5 steps of the day's start that far into it (for the old stop short of the
  // moment). With the stop at or past it, lab.spec's 2010-06-15 at 17:06 (the clock's time of day after Now, at
  // 13:00 UTC on 27 October 2026: the two-body laboratory's first step past it) went to the 16th; kept to its
  // day, it is the 15th.
  const e = new Engine(lab(null));
  const ms = Date.UTC(2010, 5, 15, 17, 6);
  goTo(e, Math.max(ms, Date.UTC(2010, 5, 15) + 1.5 * e.dt * 1000), false);
  expect(dayOf(msOf(e, e.state.t))).toBe('2010-06-16');
  goTo(e, ms);
  expect(dayOf(msOf(e, e.state.t))).toBe('2010-06-15');
});

test('the next move of a goto, and the spans it can be kept to', () => {
  const day: Within = [100, 200];
  // There, or short of it: step on; a step on past the moment ends it next time.
  expect(gotoMove(150, 160, 150, day)).toBe('stop');
  expect(gotoMove(120, 160, 150, day)).toBe('step');
  expect(gotoMove(120, 199, 150, null)).toBe('step');
  // A step that would leave the day is not taken from inside it, whatever the moment.
  expect(gotoMove(180, 200, 190, day)).toBe('stop');
  expect(gotoMove(180, 260, 190, null)).toBe('step');
  // A step over the whole day: taken when it ends nearer the day than where the run is.
  expect(gotoMove(90, 205, 150, day)).toBe('last');
  expect(gotoMove(95, 230, 150, day)).toBe('stop');
  // Spans: finite, holding the moment, else none.
  expect(validWithin([100, 200], 150)).toEqual([100, 200]);
  expect(validWithin([100, 200], 200)).toBeNull();
  expect(validWithin([100, 200], 99)).toBeNull();
  expect(validWithin([200, 100], 150)).toBeNull();
  expect(validWithin([Number.NaN, 200], 150)).toBeNull();
  expect(validWithin([100, Number.POSITIVE_INFINITY], 150)).toBeNull();
  expect(validWithin(undefined, 150)).toBeNull();
  expect(validWithin([100], 150)).toBeNull();
  // A day as the clock shows it: midnight to midnight UTC, in the experiment's seconds.
  const [lo, hi] = dayWithin(jdOf(Date.UTC(2010, 5, 15, 23, 59, 30)), 2_451_545, tdbOf);
  expect(hi - lo).toBeCloseTo(86_400, 2);
  expect(lo).toBeCloseTo(((Date.UTC(2010, 5, 15) - Date.UTC(2000, 0, 1, 12)) / 1000) + 69.184, 2);
});
