/**
 * The newborn Sun's jets (src/chapters/ch07/jets.ts), as the film's critic bound them:
 *
 * - they fade as the Sun begins to shine (1 - smootherstep(16, 34, t)), never brightening with it;
 * - their brightest pixel, with a cavity's behind it, stays under the bloom threshold (src/core/post.ts);
 * - shock-lit red, no cyan beam;
 * - the counter-jet's base is hidden behind the disk;
 * - the knots go at half pace under reduced motion;
 * - the tag says it is an illustration, not to scale, from Chapter 7's own strings (src/i18n/en.ch07.json,
 *   no key shared with any other file), and stays readable on a phone; the Discover card credits JWST's
 *   HH 211 and L1527.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { IntlMessageFormat } from 'intl-messageformat';
import { Data3DTexture, PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  CAVITY_PEAK,
  createJets,
  diskTransmission,
  FADE_SECONDS,
  jetClock,
  jetLight,
  JET_PEAK,
  JETS_COLOURS,
  JETS_TAG_KEY,
  REDUCED_MOTION_RATE,
} from '../../src/chapters/ch07/jets';
import { BANNED_PHRASES } from '../../src/core/phrasing';
import type { ChapterContent } from '../../src/core/types';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const messages = (path: string): Record<string, string> => JSON.parse(read(path)) as Record<string, string>;
const luminance = ([r, g, b]: readonly number[]): number => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
const content = JSON.parse(read('../../src/chapters/ch07/content.json')) as ChapterContent;
const ignite = content.cues.find((c) => c.type === 'scene' && c.event === 'ignite')?.t ?? NaN;
const clear = content.cues.find((c) => c.type === 'scene' && c.event === 'clear')?.t ?? NaN;

test('the jets fade as the Sun begins to shine, never brightening with it, and are gone before the disk clears', () => {
  expect(ignite).toBe(16);
  expect(ignite + FADE_SECONDS).toBe(34);
  expect(ignite + FADE_SECONDS).toBeLessThan(clear);
  for (let t = 0; t <= ignite; t += 0.5) expect(jetLight(t, ignite)).toBe(1);
  let previous = 1;
  for (let t = ignite; t <= clear; t += 0.25) {
    const light = jetLight(t, ignite);
    expect(light, `at ${t} s`).toBeLessThanOrEqual(previous);
    previous = light;
  }
  expect(jetLight(ignite + FADE_SECONDS, ignite)).toBe(0);
  expect(jetLight(ignite + FADE_SECONDS / 2, ignite)).toBeCloseTo(0.5, 6);
});

test('at their brightest, with a cavity behind them, the jets stay under the bloom threshold', () => {
  const threshold = Number(/threshold:\s*([\d.]+)/u.exec(read('../../src/core/post.ts'))?.[1]);
  expect(threshold).toBeGreaterThan(0);
  const jet = Math.max(luminance(JETS_COLOURS.red), luminance(JETS_COLOURS.pink)) * JET_PEAK;
  const cavity = luminance(JETS_COLOURS.cavity) * CAVITY_PEAK;
  expect(jet + cavity).toBeLessThan(threshold);
});

test('shock-lit gas is red (hydrogen-alpha, ionised sulphur): no cyan beam', () => {
  for (const [r, g, b] of [JETS_COLOURS.red, JETS_COLOURS.pink]) {
    expect(r).toBe(1);
    expect(g).toBeLessThan(r / 3);
    expect(b).toBeLessThan(r / 3);
  }
});

test('behind the inner disk the counter-jet hardly shows; past its edge, all of it', () => {
  for (const radius of [0, 1, 2, 3]) expect(diskTransmission(radius)).toBeLessThanOrEqual(0.1);
  expect(diskTransmission(8.6)).toBe(1);
  expect(diskTransmission(20)).toBe(1);
  for (let r = 0; r < 9; r += 0.5) expect(diskTransmission(r + 0.5)).toBeGreaterThanOrEqual(diskTransmission(r));
});

test('under reduced motion the knots move at half pace', () => {
  expect(REDUCED_MOTION_RATE).toBe(0.5);
  expect(jetClock(12, false)).toBe(12);
  expect(jetClock(12, true)).toBe(6);
});

test('the jets build without a renderer, hide when dark, and their tag stays on screen', () => {
  const noise = new Data3DTexture(new Uint8Array(8), 2, 2, 2);
  const jets = createJets(noise, 0.32, 'high');
  const camera = new PerspectiveCamera(57.22, 1440 / 900, 0.01, 1000);
  camera.position.set(0, 7, 14);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const at = new Vector3();
  jets.update({ time: 8, light: 0, reducedMotion: false, camera });
  expect(jets.object.visible).toBe(false);
  expect(jets.tag(camera, 1440, 900, at)).toBe(0);
  jets.update({ time: 8, light: 1, reducedMotion: false, camera });
  expect(jets.object.visible).toBe(true);
  expect(jets.object.children.map((c) => c.name).sort()).toEqual(['ch07-jet-lower', 'ch07-jet-upper']);
  const onScreen = (w: number, h: number): { x: number; y: number; opacity: number } => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const opacity = jets.tag(camera, w, h, at);
    const p = at.clone().project(camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, opacity };
  };
  // A wide view: beside the upper jet, a little over halfway up.
  const wide = onScreen(1440, 900);
  expect(wide.opacity).toBe(1);
  expect(wide.x).toBeCloseTo(720, 0);
  expect(wide.y).toBeLessThan(450);
  // A phone held upright: above the jet, from the view's left edge.
  const phone = onScreen(412, 839);
  expect(phone.opacity).toBe(1);
  expect(phone.x).toBeCloseTo(12, 0);
  expect(phone.y).toBeGreaterThan(60);
  expect(phone.y).toBeLessThan(839 / 2);
  // Low builds the same pieces; disposing leaves nothing behind.
  jets.setQuality('low');
  expect(jets.object.children).toHaveLength(2);
  jets.dispose();
  expect(jets.object.children).toHaveLength(0);
});

test('the tag comes from Chapter 7’s own strings, says what it is, and shares no key', () => {
  const own = messages('../../src/i18n/en.ch07.json');
  const text = own[JETS_TAG_KEY] ?? '';
  expect(text).toBe('Jets of a young star (illustration, not to scale)');
  for (const [key, message] of Object.entries(own)) {
    if (key.startsWith('$')) continue;
    expect(() => new IntlMessageFormat(message, 'en')).not.toThrow();
    for (const [phrase, pattern] of BANNED_PHRASES) expect(pattern.test(message), `${key}: ${phrase}`).toBe(false);
  }
  const others = readdirSync(new URL('../../src/i18n/', import.meta.url)).filter((f) => f.endsWith('.json') && f !== 'en.ch07.json');
  for (const file of others) {
    const keys = Object.keys(messages(`../../src/i18n/${file}`));
    for (const key of Object.keys(own)) if (!key.startsWith('$')) expect(keys, `${key} also in ${file}`).not.toContain(key);
  }
  // Loaded with the chapter's chunk, never with the shell's files.
  expect(read('../../src/chapters/ch07/scene.ts')).toContain("i18n?.extend('en.ch07.json'");
});

test('Explore Mode’s card on the jets says it is an illustration and credits the telescope’s images', () => {
  const point = content.explore.points?.find((p) => p.id === 'jets');
  expect(point?.kind).toBe('illustration');
  const discover = messages('../../src/i18n/en.discover.json');
  const text = discover[point?.text.key ?? ''] ?? '';
  for (const words of ['HH 211', 'L1527', 'NASA, ESA, CSA, STScI', 'not to scale']) expect(text).toContain(words);
  for (const [phrase, pattern] of BANNED_PHRASES) expect(pattern.test(text), phrase).toBe(false);
});
