/**
 * The explorer's time machine (src/explore/time.ts): the ladder of rates, stepped faster and slower
 * in either direction, put into words' parts, and the clock kept inside the data's span.
 */
import { expect, test } from '@playwright/test';
import { advanceClock, fasterRate, rateParts, slowerRate, TIME_RATES } from '../../src/explore/time';

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
  // A rate off the ladder steps from its nearest rung.
  expect(fasterRate(50)).toBe(600);
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
