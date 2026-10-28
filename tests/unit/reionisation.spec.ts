/**
 * Chapter 3's reionisation (src/chapters/ch03/reionisation.ts), worked out as the chapter does at
 * load: the bubbles light with their own stars (one set of ignition times), grow from the knots out
 * (the dense gas first, the voids last), and stop partway, about 40% of the visible gas ionised with
 * neutral islands left; reduced motion's slower pace leaves less. Its tag's words come in the
 * chapter's own lazy file, clear of every other message file and of the forbidden phrasing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DataUtils } from 'three/webgpu';
import { createIonisationField, ignitionDelays, type IonisationField } from '../../src/chapters/ch03/reionisation';
import { FIELD, GROWTH, IGNITION_SEED, IONISED_AT_END, STAR_SPREAD, TAG_FROM } from '../../src/chapters/ch03/settings';
import { createWebField, type WebField } from '../../src/chapters/ch03/zeldovich';
import { BANNED_PHRASES } from '../../src/core/phrasing';
import type { ChapterContent, Cue } from '../../src/core/types';

const content = JSON.parse(readFileSync(new URL('../../src/chapters/ch03/content.json', import.meta.url), 'utf8')) as ChapterContent;
const stars = content.cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === 'stars')?.t ?? 36;
const END = content.duration - stars;
const VIEW = content.camera[content.camera.length - 1]?.position ?? [0, 0, 1];

let field: WebField;
let delays: Float32Array;
let gas: IonisationField;

test.beforeAll(async () => {
  field = await createWebField(FIELD);
  delays = ignitionDelays(field.peaks, STAR_SPREAD, IGNITION_SEED);
  gas = await createIonisationField(field, delays, { end: END, fraction: IONISED_AT_END, growth: GROWTH.final, view: VIEW, tagFrom: TAG_FROM });
});

const texel = (q: readonly number[]): number => {
  const n = field.size;
  const [x, y, z] = q.map((c) => Math.round((c + field.box / 2) / (field.box / n) - 0.5) & (n - 1)) as [number, number, number];
  return (z * n + y) * n + x;
};
const ionisedAt = (v: number): number => DataUtils.fromHalfFloat((gas.texture.image.data as Uint16Array)[v * 4] ?? 0);

test('nothing is ionised before the first star; partway by the end, with neutral islands left', () => {
  expect(gas.ionisedFraction(-1)).toBe(0);
  expect(gas.ionisedFraction(0)).toBe(0);
  const end = gas.ionisedFraction(END);
  expect(end).toBeGreaterThan(0.3);
  expect(end).toBeLessThan(0.5);
  // It only grows, and it is under way well before the end.
  let last = 0;
  for (let clock = 0; clock <= END; clock += 0.5) {
    const now = gas.ionisedFraction(clock);
    expect(now).toBeGreaterThanOrEqual(last - 1e-9);
    last = now;
  }
  expect(gas.ionisedFraction(END / 2)).toBeGreaterThan(0.02);
  // Reduced motion runs the chapter's clock at 1/1.25: less is ionised by its end, still some.
  const reduced = gas.ionisedFraction(END / 1.25);
  expect(reduced).toBeLessThan(end);
  expect(reduced).toBeGreaterThan(0.15);
});

test('the front passes softly: a few world units a second at most, slowing as a bubble grows', () => {
  const data = gas.texture.image.data as Uint16Array;
  const n3 = field.size ** 3;
  const early: number[] = [];
  const late: number[] = [];
  let slowest = Infinity;
  let fastest = 0;
  for (let v = 0; v < n3; v += 1) {
    const t = DataUtils.fromHalfFloat(data[v * 4] ?? 0);
    const speed = DataUtils.fromHalfFloat(data[v * 4 + 1] ?? 0);
    slowest = Math.min(slowest, speed);
    fastest = Math.max(fastest, speed);
    if (t > END) continue;
    (t < END / 3 ? early : late).push(speed);
  }
  expect(slowest).toBeGreaterThan(0);
  expect(fastest).toBeLessThanOrEqual(3.01);
  const median = (list: number[]): number => list.sort((a, b) => a - b)[list.length >> 1] ?? 0;
  expect(median(late)).toBeLessThan(median(early));
  expect(median(late)).toBeLessThan(0.5);
});

test('each bubble starts at its own star, after the star has lit (one set of ignition times)', () => {
  const first = Math.min(...delays);
  let checked = 0;
  field.peaks.forEach((peak, i) => {
    const v = texel(peak.q);
    const t = ionisedAt(v);
    // No gas anywhere is reached before the first star has lit.
    expect(t).toBeGreaterThanOrEqual(first);
    // A star that shows (well inside the stars' fading edge): its gas is reached a moment after it
    // lights (by its own bubble, or a neighbour's first).
    const end = peak.q.map((q, axis) => {
      const x = q + GROWTH.final * (field.displacement[v * 3 + axis] ?? 0);
      return x - Math.floor(x / field.box + 0.5) * field.box;
    });
    if (Math.hypot(...end) > 0.7 * (field.box / 2)) return;
    checked += 1;
    expect(t).toBeLessThanOrEqual((delays[i] ?? 0) + 2);
  });
  expect(checked).toBeGreaterThan(5);
  // The stars light in the chapter's order: highest peaks first, over STAR_SPREAD seconds and a little.
  expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...delays)).toBeLessThanOrEqual(STAR_SPREAD + 1.5);
});

test('inside-out: the dense gas is ionised first, the voids last', () => {
  const field4 = field.texture.image.data as Uint16Array;
  let ionised = { sum: 0, count: 0 };
  let neutral = { sum: 0, count: 0 };
  const n3 = field.size ** 3;
  for (let v = 0; v < n3; v += 1) {
    const delta = DataUtils.fromHalfFloat(field4[v * 4 + 3] ?? 0);
    if (ionisedAt(v) <= END) ionised = { sum: ionised.sum + delta, count: ionised.count + 1 };
    else neutral = { sum: neutral.sum + delta, count: neutral.count + 1 };
  }
  expect(ionised.count).toBeGreaterThan(0);
  expect(neutral.count).toBeGreaterThan(0);
  expect(ionised.sum / ionised.count).toBeGreaterThan(neutral.sum / neutral.count + 0.3);
});

test('the tag points at a bubble near the middle, in the upper half of the picture', () => {
  expect(gas.anchor).not.toBeNull();
  const anchor = gas.anchor;
  if (!anchor) return;
  const at = anchor.q.map((q, axis) => {
    const x = q + GROWTH.final * (anchor.psi[axis] ?? 0);
    return x - Math.floor(x / field.box + 0.5) * field.box;
  });
  expect(Math.hypot(...at)).toBeLessThan(0.6 * (field.box / 2));
  // Up in the picture from the camera's place at the end, looking at the middle.
  const [vx, vy, vz] = VIEW;
  const forward = [-vx, -vy, -vz].map((c) => c / Math.hypot(vx, vy, vz));
  const [fx = 0, fy = 0, fz = 0] = forward;
  const right = [-fz, 0, fx].map((c) => c / Math.hypot(fz, fx));
  const [rx = 0, ry = 0, rz = 0] = right;
  const up = [ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx];
  expect(at.reduce((sum, c, i) => sum + c * (up[i] ?? 0), 0)).toBeGreaterThan(0);
});

test("the tag's words are the chapter's own: lazy, unique, labelled an illustration, plainly phrased", () => {
  const dir = new URL('../../src/i18n/', import.meta.url);
  const own = JSON.parse(readFileSync(new URL('en.ch03.json', dir), 'utf8')) as Record<string, string>;
  const text = own['ch03.hud.ionisedGas'] ?? '';
  expect(text).toContain('illustration');
  expect(text).toContain('time compressed');
  for (const [key, message] of Object.entries(own)) {
    if (key.startsWith('$')) continue;
    for (const [phrase, pattern] of BANNED_PHRASES) expect(pattern.test(message), `${key}: "${phrase}"`).toBe(false);
  }
  for (const file of readdirSync(dir).filter((f) => f.startsWith('en.') && f.endsWith('.json') && f !== 'en.ch03.json')) {
    const other = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, string>;
    for (const key of Object.keys(own)) if (!key.startsWith('$')) expect(key in other, `${key} also in ${file}`).toBe(false);
  }
  // Not in the shell: the eager message files never carry it.
  const shell = readFileSync(new URL('../../src/i18n/index.ts', import.meta.url), 'utf8');
  expect(shell).not.toContain('en.ch03.json');
});
