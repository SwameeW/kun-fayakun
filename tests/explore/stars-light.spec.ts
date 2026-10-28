/**
 * Star light among the stars (src/explore/starlight.ts), in the browser: as many stars lit at one
 * device pixel per CSS pixel as at two (each star's light shared over the pixels it touches, sized in
 * device pixels with a floor: before, 178 against 973 in the same view), and plenty of them; the
 * visitor's brightness and faintest magnitude change what is drawn, and the deep catalogue arrives as
 * the faintest magnitude calls for it (and those too faint stop being drawn when it goes back); the
 * faintest magnitude adds or takes away stars without brightening the rest; the visitor's star light
 * is the stars' own, the solar system's sky keeping its.
 */
import type { Browser, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { mockLiveHosts } from '../support/live';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 90_000 * SLOW };
const VIEWPORT = { width: 2000, height: 1300 };
const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';
const stars = async (page: Page) => (await view(page))?.neighbourhood ?? null;

/**
 * Stars visibly lit: the separate lit spots, pixels at 64 of 255 or more touching (eight ways), in the
 * left 72% of the canvas (clear of the panel). By default in CSS pixels as a viewer receives them: the
 * light (linear, not the screen's codes) of each CSS pixel's device pixels averaged, then encoded again;
 * a screen of two device pixels a CSS pixel shows each star over four smaller ones, the eye sums them.
 * 'device' counts at the device pixels themselves (the film grain, a code or two either way, then
 * lifts some of a faint star's several top pixels past the line at a density of two where its one
 * pixel at one stays under: reported, not asserted).
 */
async function litStars(page: Page, scale: 'css' | 'device' = 'css'): Promise<number> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  const dpr = scale === 'css' ? await page.evaluate(() => window.devicePixelRatio) : 1;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(async ({ base64, block }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d');
    if (!g) return 0;
    g.drawImage(bitmap, 0, 0);
    const image = g.getImageData(0, 0, bitmap.width, bitmap.height);
    const toLinear = (c: number): number => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const toCode = (l: number): number => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
    const b = Math.max(1, Math.round(block));
    const width = Math.floor(image.width / b);
    const height = Math.floor(image.height / b);
    const luma = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        for (let dy = 0; dy < b; dy += 1)
          for (let dx = 0; dx < b; dx += 1) {
            const i = ((y * b + dy) * image.width + x * b + dx) * 4;
            sum += 0.2126 * toLinear(image.data[i] ?? 0) + 0.7152 * toLinear(image.data[i + 1] ?? 0) + 0.0722 * toLinear(image.data[i + 2] ?? 0);
          }
        luma[y * width + x] = toCode(sum / (b * b));
      }
    let count = 0;
    const right = Math.floor(width * 0.72);
    const seen = new Uint8Array(width * height);
    const stack: number[] = [];
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < right; x += 1) {
        const start = y * width + x;
        if (seen[start] || (luma[start] ?? 0) < 64) continue;
        count += 1;
        seen[start] = 1;
        stack.push(start);
        while (stack.length > 0) {
          const i = stack.pop() ?? 0;
          const px = i % width;
          const py = (i - px) / width;
          for (let dy = -1; dy <= 1; dy += 1)
            for (let dx = -1; dx <= 1; dx += 1) {
              const qx = px + dx;
              const qy = py + dy;
              if (qx < 0 || qy < 0 || qx >= right || qy >= height) continue;
              const j = qy * width + qx;
              if (seen[j] || (luma[j] ?? 0) < 64) continue;
              seen[j] = 1;
              stack.push(j);
            }
        }
      }
    return count;
  }, { base64: btoa(binary), block: dpr });
}

async function enter(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForUniverse(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  // Hipparcos's other stars and Tycho-2's first pack.
  await expect.poll(async () => (await stars(page))?.stars.loaded ?? 0, LIVE).toBeGreaterThan(400_000);
  await page.waitForTimeout(1500);
}

async function atTwo(browser: Browser, baseURL: string | undefined): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, ...(baseURL ? { baseURL } : {}) });
  const page = await context.newPage();
  await mockLiveHosts(page);
  return { page, close: () => context.close() };
}

test('as many stars lit at one device pixel per CSS pixel as at two, and plenty of them', async ({ page, kf, browser, pageErrors }, testInfo) => {
  test.setTimeout(300_000 * SLOW);
  await page.setViewportSize(VIEWPORT);
  const url = kf.url('/universe/earth', { query: { jd: JD } });
  await enter(page, url);
  const one = await litStars(page);
  const two = await atTwo(browser, testInfo.project.use.baseURL);
  await enter(two.page, url);
  const twice = await litStars(two.page);
  const twiceDevice = await litStars(two.page, 'device');
  await two.close();
  testInfo.annotations.push({ type: 'lit stars', description: `DPR 1: ${String(one)}, DPR 2: ${String(twice)} (its device pixels: ${String(twiceDevice)})` });
  expect(one).toBeGreaterThanOrEqual(0.8 * twice);
  expect(one).toBeGreaterThan(600);
  // Even counted at device pixels (grain and all), most of them: before, 178 against 973.
  expect(one).toBeGreaterThanOrEqual(0.6 * twiceDevice);
  expect(pageErrors).toEqual([]);
});

test('the visitor’s star light: fainter stars drawn or not, brighter or dimmer, the deep catalogue fetched as it is called for', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await page.setViewportSize({ width: 1440, height: 900 });
  // At High (a WebGL2 browser's own default may be lower, which draws 600,000 at most).
  await enter(page, kf.url('/universe/earth', { query: { jd: JD, detail: 'high' } }));
  const usual = await litStars(page);
  const faintest = page.getByTestId('stars-faintest');
  await faintest.fill('6');
  await expect.poll(async () => (await stars(page))?.starlight.faintest, LIVE).toBe(6);
  await expect(page.getByTestId('stars-faintest-value')).toHaveText('magnitude 6');
  await page.waitForTimeout(500);
  const fewer = await litStars(page);
  expect(fewer).toBeLessThan(0.7 * usual);
  // To magnitude 12.5: Tycho-2's other packs come (all 2.5 million at this detail), every one as bright as 12.5 drawn (Tycho-2 reaches 15.4).
  await faintest.fill('12.5');
  await expect.poll(async () => (await stars(page))?.stars.loaded ?? 0, LIVE).toBeGreaterThan(2_500_000);
  await expect.poll(async () => (await stars(page))?.stars.far ?? 0, LIVE).toBeGreaterThan(2_350_000);
  // Back to 8.5: those too faint to be seen are no longer drawn (the packs are in magnitude order).
  await faintest.fill('8.5');
  await expect.poll(async () => (await stars(page))?.stars.far ?? Infinity, LIVE).toBeLessThan(100_000);
  await faintest.fill('12.5');
  await expect.poll(async () => (await stars(page))?.stars.far ?? 0, LIVE).toBeGreaterThan(2_350_000);
  await page.getByTestId('stars-brightness').fill('-2');
  await expect.poll(async () => (await stars(page))?.starlight.brightness, LIVE).toBe(0.25);
  await expect(page.getByTestId('stars-brightness-value')).toHaveText('0.25 times');
  // Out of range from a tool: held to the range.
  await page.evaluate(() => {
    (window as unknown as { __kf: { app: { earthCommand(c: unknown): void } } }).__kf.app.earthCommand({ kind: 'starsLight', brightness: 1e9, faintest: -40 });
  });
  await expect.poll(async () => (await stars(page))?.starlight, LIVE).toEqual({ brightness: 4, faintest: 4 });
  // The figures switch.
  await page.getByTestId('stars-figures').click();
  await expect.poll(async () => (await stars(page))?.figures, LIVE).toBe(false);
  await expect(page.getByTestId('stars-figures')).toHaveAttribute('aria-pressed', 'false');
  expect(pageErrors).toEqual([]);
});

test('the visitor’s star light is the stars’: the solar system’s sky keeps its own, the stars theirs when visited again', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(kf.url('/universe/earth', { query: { jd: JD } }));
  await waitForUniverse(page);
  // The solar system's sky first.
  await page.waitForTimeout(1500);
  const solar = await litStars(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await expect.poll(async () => (await stars(page))?.stars.loaded ?? 0, LIVE).toBeGreaterThan(400_000);
  await page.waitForTimeout(1500);
  // Faintest 4 among the stars, then back to the solar system: its sky as it was; among the stars again, the visitor's 4.
  await page.getByTestId('stars-faintest').fill('4');
  await expect.poll(async () => (await stars(page))?.starlight.faintest, LIVE).toBe(4);
  await page.getByTestId('stars-end').click();
  await expect.poll(async () => await stars(page), LIVE).toBeNull();
  await page.waitForTimeout(2500);
  const back = await litStars(page);
  expect(back).toBeGreaterThan(0.85 * solar);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.starlight.faintest ?? null, LIVE).toBe(4);
  await expect(page.getByTestId('stars-faintest-value')).toHaveText('magnitude 4');
  expect(pageErrors).toEqual([]);
});
