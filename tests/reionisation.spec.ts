/**
 * Chapter 3's reionisation (src/chapters/ch03/reionisation.ts): once the first stars light, rose
 * bubbles of ionised gas grow round them in the web, tagged as an illustration whose time is
 * compressed. The tag comes in only once bubbles are in view (never before the stars, and the
 * chapter has no verse), its words come with the chapter's own chunk, reduced motion's slower pace
 * brings everything later, and Explore Mode's card says what the picture is and where the numbers
 * come from.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { SLOW } from './support/env';
import { expect, test, type KfHook } from './support/fixtures';

const own = JSON.parse(readFileSync(new URL('../src/i18n/en.ch03.json', import.meta.url), 'utf8')) as Record<string, string>;
const discover = JSON.parse(readFileSync(new URL('../src/i18n/en.discover.json', import.meta.url), 'utf8')) as Record<string, string>;
const TAG = own['ch03.hud.ionisedGas'] ?? '?';

/** Opens Chapter 3 on the manual clock (Low: the cheapest, and the tier a phone gets). */
async function open(page: Page, kf: { openChapter: (id: 'ch03', options: { autoplay: boolean; query: Record<string, string> }) => Promise<void> }): Promise<void> {
  await kf.openChapter('ch03', { autoplay: true, query: { tier: 'low' } });
  await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    if (kfHook.app.paused) kfHook.app.play();
    kfHook.step();
    for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
  });
}

/** The gas tag's opacity at film time t (0 when it is not shown), two seconds played into it. */
function tagAt(page: Page, t: number): Promise<number> {
  return page.evaluate((time) => {
    const kfHook = (window as unknown as KfHook).__kf;
    kfHook.app.seek(Math.max(0, time - 2));
    kfHook.step(120, 1 / 60);
    return kfHook.app.hud().labels.find((l) => l.id === 'ionised-gas')?.opacity ?? 0;
  }, t);
}

/**
 * Pixels of the scene that read as the gas's rose, the interface hidden: red well over green, blue over
 * green (not the galaxies' warm glow), red near blue or over it (not the dark matter's violet).
 */
async function rosePixels(page: Page): Promise<number> {
  const png = (await page.locator('#scene').screenshot({ style: 'body > :not(#scene) { visibility: hidden !important; }' })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let rose = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r > b - 15 && b > g + 10 && r - g > 30) rose += 1;
    }
    return rose;
  }, btoa(binary));
}

test('the ionised gas comes after the first stars, tagged as an illustration, in the chapter’s own words', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await open(page, kf);
  // Before the first stars nothing is ionised and nothing is tagged.
  expect(await tagAt(page, 34)).toBe(0);
  const before = await rosePixels(page);
  expect(await tagAt(page, 44)).toBe(0);
  // Once bubbles are in view, the tag, in full, through to the chapter's last seconds.
  expect(await tagAt(page, 60)).toBeCloseTo(1, 3);
  expect(await tagAt(page, 76)).toBeCloseTo(1, 3);
  // Its words came with the chapter's chunk: the text, never the key.
  await expect(page.getByTestId('hud').locator('.kf-hud-tag', { hasText: TAG })).toHaveCount(1);
  expect(TAG).toContain('illustration');
  // The rose of the ionised gas is in the picture now, and was not before the stars.
  const after = await rosePixels(page);
  expect(before).toBeLessThan(200);
  expect(after).toBeGreaterThan(before + 1000);
  // It fades with the chapter's end rather than cutting off.
  const fading = await tagAt(page, 83);
  expect(fading).toBeGreaterThan(0);
  expect(fading).toBeLessThan(1);
  expect(pageErrors).toEqual([]);
});

test('reduced motion: the bubbles and their tag come at the chapter’s slower pace', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, kf);
  // At the normal pace the tag is coming in by 52 s; at 1.25 times slower it is not yet.
  expect(await tagAt(page, 52)).toBe(0);
  expect(await tagAt(page, 60)).toBeCloseTo(1, 3);
  expect(pageErrors).toEqual([]);
});

test('normal pace: the tag is coming in at 52 s', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await open(page, kf);
  const coming = await tagAt(page, 52);
  expect(coming).toBeGreaterThan(0);
  expect(coming).toBeLessThan(1);
  expect(pageErrors).toEqual([]);
});

test('Explore Mode: the card says the bubbles are an illustration and gives Planck’s and the quasars’ numbers', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.openChapter('ch03', { autoplay: true, t: 10 });
  await page.keyboard.press('Space');
  await page.keyboard.press('e');
  await expect(page.locator('html')).toHaveAttribute('data-state', 'explore');
  const dock = page.getByTestId('discover');
  await expect(dock).toBeVisible({ timeout: 30_000 * SLOW });
  await dock.getByTestId('discover-point-reionisation').click();
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.exploreTime)).toBe(80);
  await expect(dock.getByTestId('discover-kind')).toHaveText(discover['discover.kind.illustration'] ?? '?');
  await expect(dock.getByTestId('discover-card').locator('h3')).toHaveText(discover['discover.ch03.reionisation.title'] ?? '?');
  const text = (await dock.getByTestId('discover-text').textContent()) ?? '';
  for (const value of ['0.056', '7.8', '657', '5.3', '1.1']) expect(text).toContain(value);
  expect(text).toContain('illustration');
  expect(text).not.toMatch(/[{}]/);
  expect(pageErrors).toEqual([]);
});
