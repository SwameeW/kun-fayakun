/**
 * Explore Mode's dock (src/ui/discover-dock.ts). Entering Explore Mode offers each chapter's moments,
 * its process and its closer looks; a moment shows the scene as it is then (the film's clock stays
 * put), moves the camera to the film's view of it and says what the picture is (measured, a model, an
 * illustration); the slider runs the process; "Back to the film's moment" and leaving Explore Mode
 * return everything. The closer looks do what they say: the model of expanding space scales every
 * distance alike, Kepler's law comes out of JPL's real orbits, the Earth today opens in the explorer.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { ChapterId } from '../src/core/types';
import { canvasStats } from './support/canvas';
import { chapterContent } from './support/data';
import { SLOW } from './support/env';
import { expect, test, type Kf, type KfHook } from './support/fixtures';
import { view, waitForUniverse } from './support/universe';

const LIVE = { timeout: 30_000 * SLOW };
const strings = JSON.parse(readFileSync(new URL('../src/i18n/en.discover.json', import.meta.url), 'utf8')) as Record<string, string>;
const CHAPTERS: readonly ChapterId[] = ['ch00', 'ch01', 'ch02', 'ch03', 'ch04', 'ch05', 'ch06', 'ch07', 'ch08', 'ch09', 'ch10'];

const exploreTime = (page: Page): Promise<number | null> => page.evaluate(() => (window as unknown as KfHook).__kf.app.exploreTime);
const filmTime = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as KfHook).__kf.app.time);

async function explore(page: Page, kf: Kf, chapter: ChapterId, t = 10): Promise<void> {
  await kf.openChapter(chapter, { autoplay: true, t });
  await page.keyboard.press('Space');
  await page.keyboard.press('e');
  await expect(page.locator('html')).toHaveAttribute('data-state', 'explore');
}

for (const chapter of CHAPTERS) {
  test(`${chapter}: Explore Mode offers its moments, process and closer looks, and gives the film back as it was`, async ({ page, kf, pageErrors }) => {
    test.setTimeout(120_000 * SLOW);
    const { points = [], process, extras = [] } = chapterContent(chapter).explore;
    await explore(page, kf, chapter);
    const dock = page.getByTestId('discover');
    await expect(dock).toBeVisible(LIVE);
    const film = await filmTime(page);
    await expect(dock.locator('[data-point]')).toHaveCount(points.length);
    await expect(dock.getByTestId('discover-process')).toHaveCount(process ? 1 : 0);
    for (const name of extras) await expect(dock.getByTestId(`discover-extra-${name}`)).toBeVisible();
    // Every moment: the scene at its time, its card saying what the picture is.
    for (const point of points) {
      await dock.getByTestId(`discover-point-${point.id}`).click();
      expect(await exploreTime(page)).toBe(point.t);
      await expect(dock.getByTestId(`discover-point-${point.id}`)).toHaveAttribute('aria-pressed', 'true');
      await expect(dock.getByTestId('discover-kind')).toHaveText(strings[`discover.kind.${point.kind}`] ?? '?');
      await expect(dock.getByTestId('discover-card').locator('h3')).toHaveText(strings[point.titleKey] ?? '?');
      const text = (await dock.getByTestId('discover-text').textContent()) ?? '';
      expect(text.length, `${chapter} ${point.id}: card text`).toBeGreaterThan(40);
      expect(text, `${chapter} ${point.id}: every value filled`).not.toMatch(/[{}]/);
    }
    // The process, by its slider.
    if (process) {
      await dock.getByTestId('discover-process').fill(String((process.from + process.to) / 2));
      expect(await exploreTime(page)).toBeCloseTo((process.from + process.to) / 2, 1);
      await expect(dock.getByTestId('discover-card')).toBeHidden();
    }
    // The film's clock never moved; back to its moment, then out of Explore Mode.
    expect(await filmTime(page)).toBeCloseTo(film, 3);
    if (points.length > 0 || process) {
      await dock.getByTestId('discover-reset').click();
      expect(await exploreTime(page)).toBeNull();
    }
    await page.locator('body').press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-state', 'playing');
    await expect(dock).toBeHidden();
    expect(await exploreTime(page)).toBeNull();
    expect(pageErrors).toEqual([]);
  });
}

test('a moment shows its own picture, and reset gives the film’s moment back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await explore(page, kf, 'ch06');
  const before = await canvasStats(page);
  await page.getByTestId('discover-point-type-ia').click();
  // The Type Ia's scene, seen as the film sees it, is not the layered star of the film's moment.
  await expect.poll(async () => Math.abs((await canvasStats(page)).meanLuma - before.meanLuma), LIVE).toBeGreaterThan(1);
  await page.getByTestId('discover-reset').click();
  await expect.poll(async () => Math.abs((await canvasStats(page)).meanLuma - before.meanLuma), LIVE).toBeLessThan(1);
  expect(pageErrors).toEqual([]);
});

test('the model of expanding space: every distance scales alike, from whichever dot', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await explore(page, kf, 'ch01');
  const extra = page.getByTestId('discover-extra-expansion-model');
  await extra.locator('summary').click();
  await extra.getByTestId('expansion-factor').fill('2');
  await expect(extra.getByTestId('expansion-readout')).toContainText('2');
  const pairs = async (): Promise<Array<[number, number]>> =>
    (await extra.getByTestId('expansion-distances').locator('li').allTextContents()).map((line) => {
      const [d, d0] = [...line.matchAll(/(\d+(?:\.\d+)?)/gu)].map((m) => Number(m[1]));
      return [d ?? 0, d0 ?? 0];
    });
  for (const [d, d0] of await pairs()) expect(d).toBeCloseTo(2 * d0, 0);
  // Watching from another dot (by keyboard): the same law.
  await extra.getByTestId('expansion-dot-A').focus();
  await page.keyboard.press('Enter');
  await expect(extra.locator('.kf-expansion-chosen')).toContainText('A');
  for (const [d, d0] of await pairs()) expect(d).toBeCloseTo(2 * d0, 0);
  // The farther, the faster: the largest change belongs to the farthest dot.
  const changes = (await pairs()).map(([d, d0]) => d - d0);
  expect(changes[changes.length - 1]).toBeGreaterThan(changes[0] ?? 0);
  expect(pageErrors).toEqual([]);
});

test('Kepler’s law from the real orbits: a planet’s year is its distance to the power three halves', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await explore(page, kf, 'ch07', 120);
  const extra = page.getByTestId('discover-extra-orbits');
  await extra.locator('summary').click();
  for (const planet of ['jupiter', 'mars', 'neptune']) {
    await extra.getByTestId(`orbit-${planet}`).click();
    const text = (await extra.getByTestId('orbits-readout').textContent()) ?? '';
    const numbers = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)/gu)].map((m) => Number((m[1] ?? '').replace(/,/gu, '')));
    const [a, years, , root] = numbers;
    expect(Math.abs((years ?? 0) - (root ?? 0)) / (years ?? 1), `${planet}: ${text}`).toBeLessThan(0.01);
    expect(Math.abs((a ?? 0) ** 1.5 - (years ?? 0)) / (years ?? 1), `${planet}: ${text}`).toBeLessThan(0.01);
  }
  expect(pageErrors).toEqual([]);
});

test('the Earth today opens in the solar system explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await explore(page, kf, 'ch08');
  const extra = page.getByTestId('discover-extra-earth');
  await extra.locator('summary').click();
  await extra.getByTestId('discover-earth').click();
  await waitForUniverse(page);
  await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('earth');
  expect(pageErrors).toEqual([]);
});

test('the dock is reachable by keyboard, passes axe, and on a phone the film’s text steps aside', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await explore(page, kf, 'ch06');
  const dock = page.getByTestId('discover');
  await dock.getByTestId('discover-point-layers').focus();
  await page.keyboard.press('Enter');
  expect(await exploreTime(page)).toBe(chapterContent('ch06').explore.points?.find((p) => p.id === 'layers')?.t);
  await dock.getByTestId('discover-extra-supernovae').locator('summary').click();
  await expect(dock.getByTestId('supernova-table').locator('tbody tr')).toHaveCount(5);
  const results = await new AxeBuilder({ page }).include('[data-testid="discover"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  // Showing another moment, the film's captions and verse cards step aside.
  await expect(page.locator('.kf-stage-text')).toHaveCSS('opacity', '0');
  await dock.getByTestId('discover-reset').click();
  await expect(page.locator('.kf-stage-text')).toHaveCSS('opacity', '1');
  // Collapsed, it keeps out of the way; opened again, it is all there.
  await dock.getByTestId('discover-collapse').click();
  await expect(dock.getByTestId('discover-point-layers')).toBeHidden();
  await dock.getByTestId('discover-collapse').click();
  await expect(dock.getByTestId('discover-point-layers')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 740 });
  await expect(page.locator('.kf-stage-text')).toHaveCSS('opacity', '0');
  const box = await dock.boundingBox();
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 375).toBe(true);
  expect(pageErrors).toEqual([]);
});
