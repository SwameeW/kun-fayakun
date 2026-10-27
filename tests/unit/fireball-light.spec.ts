/**
 * How the laboratory's browser specs judge a fireball's light frame by frame (tests/support/fireball-light,
 * used by tests/explore/lab-flash): against its own peak, the most it is drawn in its whole life, never
 * the part of its rise a watch happened to see. Frames are made by the effects' own fireballs
 * (src/explore/lab-fx/fireball), advanced and read back as the page reads them.
 */
import { expect, test } from '@playwright/test';
import { FIREBALL, Fireballs, type FireballEvent } from '../../src/explore/lab-fx/fireball';
import { fireballSteps, type LightFrame } from '../support/fireball-light';

const event = (key: string): FireballEvent => ({ key, body: 'moon', site: [1, 0, 0], energyJ: 1e24, speedKmS: 20, impactorKm: 50, targetKm: 1737 });

/**
 * The effects advanced `dts[n]` seconds at frame n (their clock), fireballs begun at the frames `born` names,
 * each drawn and read back as it is then; frames from `windowEnd` on are past the window (`extra`).
 */
function frames(dts: readonly number[], born: ReadonlyMap<number, string>, windowEnd = Number.POSITIVE_INFINITY): LightFrame[] {
  const f = new Fireballs();
  const out: LightFrame[] = [];
  let fx = 0;
  let t = 0;
  dts.forEach((dt, n) => {
    fx += dt;
    t += 1 / 60;
    const key = born.get(n);
    if (key) f.add(event(key), fx);
    f.update(fx, dt, false);
    out.push({ t, fx, fire: f.live.map((b): [string, number] => [b.key, b.luminance]), extra: n >= windowEnd });
  });
  return out;
}

const steps = (fs: readonly LightFrame[], key: string): ReturnType<typeof fireballSteps>[number] | undefined => fireballSteps(fs).find((s) => s.key === key);
/** Frames enough for a fireball's whole life at 60 a second, and some. */
const LIFE = Math.ceil((FIREBALL.riseS + FIREBALL.holdS + FIREBALL.fadeS) * 60) + 30;

test('a fireball begun three frames before the watch would end: the window saw a hundredth of its peak, so it is not judged on that; watched on until it has gone, its rise is a thirtieth of its peak a frame or less', () => {
  // As the run that failed: one fireball whole, another begun at the window's last frames (0, then 0.0013, 0.0051, 0.0112 of a peak of 1).
  const windowEnd = 300;
  const all = frames(new Array<number>(windowEnd + LIFE).fill(1 / 60), new Map([[5, 'early'], [windowEnd - 4, 'late']]), windowEnd);
  const cut = all.slice(0, windowEnd);
  const late = steps(cut, 'late');
  expect(late?.whole).toBe(false);
  expect(late?.extra).toBe(false);
  expect(late?.peak ?? 1).toBeLessThan(0.02);
  // Judged on the most the window saw, its first eased step would read as several times a thirtieth: the failure, and why the window's most is no peak.
  const seen = cut.flatMap((f) => f.fire.filter((x) => x[0] === 'late').map((x) => x[1]));
  expect(seen[0]).toBe(0);
  expect(((seen[1] ?? 0) - (seen[0] ?? 0)) / ((late?.peak ?? 1) * (2 / 60))).toBeGreaterThan(3);
  // Watched on (as the spec's watch goes on for it): whole, its peak its own, every step within a thirtieth of it.
  const whole = steps(all, 'late');
  expect(whole?.whole).toBe(true);
  expect(whole?.extra).toBe(false);
  expect(whole?.peak ?? 0).toBeGreaterThan(0.9);
  expect(whole?.worst ?? 2).toBeLessThanOrEqual(1);
  expect(steps(all, 'early')?.worst ?? 2).toBeLessThanOrEqual(1);
});

test('a fireball at uneven frame times, or sampled a frame late: its eased rise and fade within a thirtieth of its peak a 60th of a second by the effects’ clock', () => {
  const dts = Array.from({ length: LIFE * 2 }, (_, n) => [1 / 60, 1 / 30, 1 / 144, 1 / 60, 0.05][n % 5] ?? 1 / 60);
  const fs = frames(dts, new Map([[3, 'a']]));
  expect(steps(fs, 'a')?.whole).toBe(true);
  expect(steps(fs, 'a')?.worst ?? 2).toBeLessThanOrEqual(1);
  // A sample missed (the page's frame and the effects' out of step): the change over two of the effects' frames, judged over both.
  const missed = fs.filter((_, n) => n % 7 !== 3);
  expect(steps(missed, 'a')?.worst ?? 2).toBeLessThanOrEqual(1);
});

test('the measure still catches a fireball that comes in already lit, one that steps, and one the watch did not see through', () => {
  const fs = frames(new Array<number>(LIFE + 60).fill(1 / 60), new Map([[3, 'a']]));
  // Drawn first at a sixth of its peak (its first twelve frames not drawn).
  const lit = fs.map((f, n) => ({ ...f, fire: n < 15 ? [] : f.fire }));
  expect(steps(lit, 'a')?.whole).toBe(true);
  expect(steps(lit, 'a')?.worst ?? 0).toBeGreaterThan(1);
  // A step: one frame half as bright again.
  const stepped = fs.map((f, n) => ({ ...f, fire: n === 80 ? f.fire.map(([k, v]): [string, number] => [k, v * 1.5]) : f.fire }));
  expect(steps(stepped, 'a')?.worst ?? 0).toBeGreaterThan(1);
  // Still drawn when the watch ended: not whole. Begun in the window, the spec fails it; begun only past it, not judged.
  const short = fs.slice(0, 30);
  expect(steps(short, 'a')?.whole).toBe(false);
  expect(steps(short, 'a')?.extra).toBe(false);
  const after = fs.slice(0, 30).map((f) => ({ ...f, extra: true }));
  expect(steps(after, 'a')?.extra).toBe(true);
  // Drawn on the watch's first frame: its beginning unseen, not whole either.
  expect(steps(fs.slice(20), 'a')?.whole).toBe(false);
});
