/**
 * The hold of a world's turn at fast time (src/explore/time-beyond createSpinHold), frame by frame on
 * a world of its own (the Earth's spin, the Sun along +x): held past 30 degrees a frame; let go, it
 * catches up the way time runs (backwards in time, backwards), never more than 30 degrees a frame;
 * paused or on a trip it stays held, still; with reduced motion it lets go at once; a laboratory's goto
 * (a jump every few frames, none between) keeps it held; and a cut (a date gone to) never holds it.
 */
import { expect, test } from '@playwright/test';
import { BODY_IDS, type BodyId } from '../../src/core/types';
import type { SolarSystem } from '../../src/explore/system';
import { createSpinHold } from '../../src/explore/time-beyond';

const EARTH_DEG_PER_DAY = 360.9856235;
const DEG = Math.PI / 180;
const spin = Object.fromEntries(BODY_IDS.map((id) => [id, id === 'earth' ? EARTH_DEG_PER_DAY : 0])) as Record<BodyId, number>;

/** A system of the Sun (far along +x) and the Earth turning about +y: the Sun's longitude on it is -spin x days. */
function world(): { sys: SolarSystem; at(days: number): void; sunLon(): number } {
  const earth = { position: { x: 0, y: 0, z: 0 }, basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const sun = { position: { x: 1.5e8, y: 0, z: 0 }, basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const sys = { bodies: { earth, sun } } as unknown as SolarSystem;
  return {
    sys,
    // The true basis at a date, as the system writes it each frame (the hold then turns it).
    at(days) {
      const th = -EARTH_DEG_PER_DAY * days * DEG;
      earth.basis = [Math.cos(th), 0, Math.sin(th), 0, 1, 0, -Math.sin(th), 0, Math.cos(th)];
    },
    sunLon() {
      const m = earth.basis;
      return Math.atan2(-(m[6] ?? 0), m[0] ?? 0) / DEG;
    },
  };
}

/** Runs `frames` frames at `rate` (s/s) from `days`, the clock `running` or not; returns each frame's drawn turn (degrees of the Sun's longitude) and the date reached. */
function frames(w: ReturnType<typeof world>, hold: ReturnType<typeof createSpinHold>, from: number, rate: number, n: number, running = true, reduced = false): { steps: number[]; days: number } {
  const steps: number[] = [];
  let days = from;
  w.at(days);
  hold.update(w.sys, 0, 0, running, reduced);
  let last = w.sunLon();
  for (let k = 0; k < n; k += 1) {
    const move = running ? rate / 86_400 / 60 : 0;
    days += move;
    w.at(days);
    hold.update(w.sys, move, 1 / 60, running, reduced);
    const lon = w.sunLon();
    steps.push(((lon - last + 540) % 360) - 180);
    last = lon;
  }
  return { steps, days };
}

test('let go while time runs backwards, it catches up backwards: every frame turns the way the clock travels, never more than 30 degrees', () => {
  for (const fast of [-604_800, -2_592_000]) {
    const w = world();
    const hold = createSpinHold(spin);
    const held = frames(w, hold, 1000, fast, 60);
    // Held where it was drawn before the first fast frame: no jump at all.
    expect(hold.held('earth')).toBe(true);
    for (const d of held.steps) expect(Math.abs(d)).toBeLessThan(1e-9);
    // A day a second backwards: the Sun's longitude on a prograde world rises as time runs back.
    const free = frames(w, hold, held.days, -86_400, 240);
    expect(hold.held('earth')).toBe(false);
    for (const d of free.steps) {
      expect(d, `${String(fast)} then a day a second back: ${String(d)}`).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(30);
    }
    // Caught up: drawn as it truly is.
    const truth = ((-EARTH_DEG_PER_DAY * free.days + 540) % 360) - 180;
    expect(Math.abs(((w.sunLon() - truth + 540) % 360) - 180)).toBeLessThan(0.1);
  }
  // Forwards, the mirror.
  const w = world();
  const hold = createSpinHold(spin);
  const held = frames(w, hold, 1000, 604_800, 60);
  const free = frames(w, hold, held.days, 86_400, 240);
  for (const d of free.steps) {
    expect(d).toBeLessThanOrEqual(0);
    expect(d).toBeGreaterThan(-30);
  }
});

test('paused or held to real time by a trip, a held world stays held and still; with reduced motion it lets go at once', () => {
  const w = world();
  const hold = createSpinHold(spin);
  const held = frames(w, hold, 1000, 604_800, 60);
  // Paused: no time, not running: sixty frames and more without a turn.
  const paused = frames(w, hold, held.days, 0, 120, false);
  for (const d of paused.steps) expect(Math.abs(d)).toBeLessThan(1e-9);
  expect(hold.held('earth')).toBe(true);
  // A trip: the clock creeps at real time but does not run on its own: still held, still.
  let days = held.days;
  let last = w.sunLon();
  for (let k = 0; k < 120; k += 1) {
    days += 1 / 86_400 / 60;
    w.at(days);
    hold.update(w.sys, 1 / 86_400 / 60, 1 / 60, false, false);
    expect(Math.abs(w.sunLon() - last)).toBeLessThan(1e-6);
    last = w.sunLon();
  }
  expect(hold.held('earth')).toBe(true);
  // Reduced motion: let go after the calm, at once (one jump), then the true turn only.
  const reduced = frames(w, hold, days, 3600, 90, true, true);
  expect(hold.held('earth')).toBe(false);
  const jumps = reduced.steps.filter((d) => Math.abs(d) > 1);
  expect(jumps.length).toBeLessThanOrEqual(1);
  const truth = ((-EARTH_DEG_PER_DAY * reduced.days + 540) % 360) - 180;
  expect(Math.abs(((w.sunLon() - truth + 540) % 360) - 180)).toBeLessThan(1e-6);
});

test('a laboratory’s goto (a jump of a month every third frame, none between) keeps the world held; a cut never holds it', () => {
  const w = world();
  const hold = createSpinHold(spin);
  let days = 0;
  w.at(days);
  hold.update(w.sys, 0, 0, true, false);
  let last = w.sunLon();
  for (let k = 0; k < 240; k += 1) {
    const move = k % 3 === 0 ? 34.5 : 0;
    days += move;
    w.at(days);
    hold.update(w.sys, move, 1 / 60, true, false);
    const d = ((w.sunLon() - last + 540) % 360) - 180;
    last = w.sunLon();
    expect(Math.abs(d), `frame ${String(k)}`).toBeLessThan(30);
    expect(hold.held('earth')).toBe(true);
  }
  // A date gone to (a cut: the clock's change is not a movement) leaves a free world free.
  const free = createSpinHold(spin);
  w.at(5000);
  free.update(w.sys, 0, 1 / 60, true, false);
  expect(free.held('earth')).toBe(false);
});
