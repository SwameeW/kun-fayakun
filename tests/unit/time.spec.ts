/**
 * The explorer's time machine (src/explore/time.ts): the ladder of rates, stepped faster and slower
 * in either direction (to the next rung, never skipping one), put into words' parts, the clock kept
 * inside the span; the reducer every command goes through (every press at either end moves the
 * clock, a rate set into an end stays there paused), the commands checked at the boundary (no NaN or
 * infinite rate or date gets in), and the cap on foot.
 */
import { expect, test } from '@playwright/test';
import type { UniverseTimeCommand } from '../../src/core/types';
import { advanceClock, applyTimeCommand, fasterRate, FOOT_MAX_RATE, heldRate, intoEdge, MAX_RATE, rateParts, slowerRate, TIME_RATES, validTimeCommand, type ClockState } from '../../src/explore/time';

test('the ladder runs from real time to thirty days a second, and steps keep their direction', () => {
  expect(TIME_RATES[0]).toBe(1);
  expect(TIME_RATES.at(-1)).toBe(30 * 86_400);
  expect([...TIME_RATES].every((r, i, all) => i === 0 || r > (all[i - 1] ?? 0))).toBe(true);
  // Faster climbs a rung at a time and stops at the top; slower never goes below real time.
  let r = 1;
  const up: number[] = [];
  for (let i = 0; i < TIME_RATES.length + 2; i += 1) up.push((r = fasterRate(r)));
  expect(up.slice(0, TIME_RATES.length - 1)).toEqual(TIME_RATES.slice(1));
  expect(up.at(-1)).toBe(TIME_RATES.at(-1));
  expect(slowerRate(1)).toBe(1);
  expect(slowerRate(3600)).toBe(600);
  // Backwards stays backwards.
  expect(fasterRate(-60)).toBe(-600);
  expect(slowerRate(-60)).toBe(-10);
  expect(slowerRate(-1)).toBe(-1);
  // A rate off the ladder (a lesson's half hour a second) steps to the next rung either way, skipping none.
  expect(fasterRate(50)).toBe(60);
  expect(fasterRate(1800)).toBe(3600);
  expect(slowerRate(1800)).toBe(600);
  expect(fasterRate(-1800)).toBe(-3600);
  expect(fasterRate(2_592_000)).toBe(2_592_000);
  expect(slowerRate(0.5)).toBe(1);
  // From every rung, faster then slower comes back to it.
  for (const r of TIME_RATES.slice(0, -1)) expect(slowerRate(fasterRate(r))).toBe(r);
});

test('rates in words: the largest whole unit each real second', () => {
  expect(rateParts(1)).toEqual({ count: 1, unit: 'second' });
  expect(rateParts(10)).toEqual({ count: 10, unit: 'second' });
  expect(rateParts(60)).toEqual({ count: 1, unit: 'minute' });
  expect(rateParts(-600)).toEqual({ count: 10, unit: 'minute' });
  expect(rateParts(21_600)).toEqual({ count: 6, unit: 'hour' });
  expect(rateParts(86_400)).toEqual({ count: 1, unit: 'day' });
  expect(rateParts(604_800)).toEqual({ count: 1, unit: 'week' });
  expect(rateParts(2_592_000)).toEqual({ count: 30, unit: 'day' });
});

test('the clock advances at its rate and stops at either end of the span', () => {
  const start = 2_461_041.5;
  const end = start + 3653;
  // A real second at a day a second is a day.
  expect(advanceClock(start + 100, 1, 86_400, start, end)).toEqual({ jd: start + 101, edge: null });
  expect(advanceClock(start + 100, 0.5, -86_400, start, end)).toEqual({ jd: start + 99.5, edge: null });
  // Paused, nothing moves.
  expect(advanceClock(start + 100, 1, 0, start, end)).toEqual({ jd: start + 100, edge: null });
  expect(advanceClock(end - 1, 1, 2_592_000, start, end)).toEqual({ jd: end, edge: 'end' });
  expect(advanceClock(start + 1, 1, -2_592_000, start, end)).toEqual({ jd: start, edge: 'start' });
});

const KINDS: UniverseTimeCommand[] = [{ kind: 'toggle' }, { kind: 'faster' }, { kind: 'slower' }, { kind: 'reverse' }, { kind: 'now' }];

test('at either end, every press moves the clock: play, faster and slower turn it round; a rate set into the end stays there, paused', () => {
  for (const edge of ['start', 'end'] as const) {
    const into = edge === 'start' ? -604_800 : 604_800;
    const atEnd: ClockState = { rate: into, paused: true, edge };
    for (const command of KINDS) {
      const { state, turned } = applyTimeCommand(atEnd, command);
      // Running, away from the end (now: at real time, from the present).
      expect(state.paused, `${edge} ${command.kind}`).toBe(false);
      expect(state.edge).toBeNull();
      expect(state.rate).toBe(command.kind === 'now' ? 1 : -Math.sign(into) * Math.abs(state.rate));
      expect(turned).toBe(command.kind === 'toggle' || command.kind === 'faster' || command.kind === 'slower');
    }
    // Slower and faster step from the turned rate: a week a second backwards becomes a day (or thirty days) forwards.
    expect(applyTimeCommand(atEnd, { kind: 'slower' }).state.rate).toBe(-Math.sign(into) * 86_400);
    expect(applyTimeCommand(atEnd, { kind: 'faster' }).state.rate).toBe(-Math.sign(into) * 2_592_000);
    // A rate set into the end: still stopped there (never running into it), with the rate it was given.
    const set = applyTimeCommand(atEnd, { kind: 'rate', rate: into * 2 }).state;
    expect(set).toEqual({ rate: into * 2, paused: true, edge });
    // A date leaves the end (the caller marks it again if the date is out of range).
    expect(applyTimeCommand(atEnd, { kind: 'date', jdUtc: 2_461_000 }).state.edge).toBeNull();
  }
  // At an end with the rate pointing away (a date typed past it), play simply runs.
  expect(applyTimeCommand({ rate: 86_400, paused: true, edge: 'start' }, { kind: 'toggle' })).toEqual({ state: { rate: 86_400, paused: false, edge: null }, turned: false });
  expect(intoEdge({ rate: -1, paused: true, edge: 'start' })).toBe(true);
  expect(intoEdge({ rate: 1, paused: true, edge: 'start' })).toBe(false);
});

test('away from the ends: pause toggles, faster and slower step and run, the ends of the ladder hold, reverse turns and runs, now is real time', () => {
  const running: ClockState = { rate: 3600, paused: false, edge: null };
  expect(applyTimeCommand(running, { kind: 'toggle' }).state).toEqual({ rate: 3600, paused: true, edge: null });
  expect(applyTimeCommand({ ...running, paused: true }, { kind: 'faster' }).state).toEqual({ rate: 21_600, paused: false, edge: null });
  expect(applyTimeCommand(running, { kind: 'reverse' }).state.rate).toBe(-3600);
  expect(applyTimeCommand({ rate: -3600, paused: true, edge: null }, { kind: 'now' }).state).toEqual({ rate: 1, paused: false, edge: null });
  expect(applyTimeCommand({ rate: MAX_RATE, paused: false, edge: null }, { kind: 'faster' }).state.rate).toBe(MAX_RATE);
  expect(applyTimeCommand({ rate: -1, paused: false, edge: null }, { kind: 'slower' }).state.rate).toBe(-1);
  expect(applyTimeCommand(running, { kind: 'rate', rate: 0 }).state).toEqual({ rate: 3600, paused: true, edge: null });
  // A thousand random presses: the rate always on the ladder, never running into an end.
  let s: ClockState = { rate: 1, paused: false, edge: null };
  let seed = 7;
  const next = (): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let k = 0; k < 1000; k += 1) {
    s = applyTimeCommand(s, KINDS[Math.floor(next() * KINDS.length)] ?? { kind: 'toggle' }).state;
    if (next() < 0.05) s = { ...s, edge: next() < 0.5 ? 'start' : 'end', paused: true };
    expect((TIME_RATES as readonly number[]).includes(Math.abs(s.rate))).toBe(true);
    expect(intoEdge(s) && !s.paused).toBe(false);
  }
});

test('on foot faster stops at an hour a second, slower steps down from what is seen, and the clock is held there; real time on a trip', () => {
  const onFoot = (state: ClockState, command: UniverseTimeCommand): ClockState => applyTimeCommand(state, command, FOOT_MAX_RATE).state;
  expect(onFoot({ rate: 600, paused: false, edge: null }, { kind: 'faster' }).rate).toBe(3600);
  expect(onFoot({ rate: 3600, paused: false, edge: null }, { kind: 'faster' }).rate).toBe(3600);
  // Chosen at thirty days a second before landing: slower is a visible step down from the hour a second shown.
  expect(onFoot({ rate: -2_592_000, paused: false, edge: null }, { kind: 'slower' }).rate).toBe(-600);
  for (const r of TIME_RATES) {
    expect(Math.abs(heldRate(r, 'foot'))).toBe(Math.min(r, FOOT_MAX_RATE));
    expect(heldRate(-r, 'foot')).toBeLessThanOrEqual(0);
    expect(heldRate(-r, 'trip')).toBe(-1);
    expect(heldRate(r, null)).toBe(r);
  }
});

test('commands are checked at the boundary: no NaN or infinite rate or date gets in, and a rate is held to the ladder', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(validTimeCommand({ kind: 'rate', rate: bad })).toBeNull();
    expect(validTimeCommand({ kind: 'date', jdUtc: bad })).toBeNull();
  }
  expect(validTimeCommand({ kind: 'rate', rate: 1e300 })).toEqual({ kind: 'rate', rate: MAX_RATE });
  expect(validTimeCommand({ kind: 'rate', rate: -1e300 })).toEqual({ kind: 'rate', rate: -MAX_RATE });
  expect(validTimeCommand({ kind: 'rate', rate: -0 })).toEqual({ kind: 'rate', rate: 0 });
  expect(validTimeCommand({ kind: 'rate', rate: 0.25 })).toEqual({ kind: 'rate', rate: 1 });
  expect(validTimeCommand({ kind: 'rate', rate: '600' as unknown as number })).toBeNull();
  expect(validTimeCommand({ kind: 'date', jdUtc: 2_451_545 })).toEqual({ kind: 'date', jdUtc: 2_451_545 });
  // The clock itself never takes a NaN step.
  expect(advanceClock(2_461_000, Number.NaN, 86_400, 2_400_000, 2_500_000)).toEqual({ jd: 2_461_000, edge: null });
  expect(advanceClock(2_461_000, 1, Number.POSITIVE_INFINITY, 2_400_000, 2_500_000)).toEqual({ jd: 2_461_000, edge: null });
});
