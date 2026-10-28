/**
 * Chapter 2's polarisation lines on the CMB globe (src/chapters/ch02/cmb-sphere.ts): none under the
 * verse (41:11, 46 to 72 s), then Planck's directions drawn as thin dark lines from 73 s, with the
 * legend's line naming them; the same with reduced motion. Measured on the canvas with the interface
 * hidden, on the manual clock (__kf.step), as the darkest share of the globe's middle: the lines add
 * dark pixels, the temperature map alone has few.
 */
import type { Page } from '@playwright/test';
import { SLOW } from './support/env';
import { expect, test, type Kf, type KfHook } from './support/fixtures';

const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';
/** 8-bit luma below which a pixel of the globe counts as dark (the map's own darkest blues and reds are rarer). */
const DARK_LUMA = 70;
const LEGEND_LINE = 'Lines: direction of polarisation (Planck)';

/** Base64 without Node's Buffer (see support/node-fs.d.ts). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Plays the six seconds up to t on the manual clock (the eye's adaptation settles), from a seek. */
async function at(page: Page, t: number): Promise<void> {
  await page.evaluate((time) => {
    const kfHook = (window as unknown as KfHook).__kf;
    const from = Math.max(0, time - 6);
    kfHook.app.seek(from);
    kfHook.step(Math.round((time - from) * 30), 1 / 30);
  }, t);
}

/** Share of dark pixels in a disc in the middle of the globe (well inside its limb in any landscape view). */
async function darkShare(page: Page): Promise<number> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  return page.evaluate(
    async ({ base64, dark }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D context unavailable');
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const cx = 0.48 * width;
      const cy = 0.46 * height;
      const r = 0.17 * height;
      let inside = 0;
      let darkCount = 0;
      for (let y = Math.floor(cy - r); y < cy + r; y += 1) {
        for (let x = Math.floor(cx - r); x < cx + r; x += 1) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          const i = (y * width + x) * 4;
          const luma = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
          inside += 1;
          if (luma < dark) darkCount += 1;
        }
      }
      return darkCount / Math.max(1, inside);
    },
    { base64: toBase64(png), dark: DARK_LUMA },
  );
}

async function openOnTheClock(page: Page, kf: Kf, query: Record<string, string> = {}): Promise<void> {
  await kf.openChapter('ch02', { autoplay: true, query });
  await page.evaluate(() => {
    const kfHook = (window as unknown as KfHook).__kf;
    if (kfHook.app.paused) kfHook.app.play();
    kfHook.step();
    for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
  });
}

for (const reduced of [false, true]) {
  test(`the polarisation lines come onto the globe after the verse, not under it${reduced ? ' (reduced motion)' : ''}`, async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await openOnTheClock(page, kf, reduced ? { reducedMotion: '1' } : {});
    const legendLine = page.getByTestId('cmb-lines');

    // Under the verse and just after it: the map alone, and the legend without the line.
    await at(page, 60);
    const underVerse = await darkShare(page);
    await at(page, 72.5);
    const beforeLines = await darkShare(page);
    await expect(legendLine).toBeHidden();
    await expect(legendLine).toHaveAttribute('aria-hidden', 'true');
    expect(beforeLines / Math.max(underVerse, 1e-4), `dark share ${underVerse.toFixed(4)} at 60 s, ${beforeLines.toFixed(4)} at 72.5 s`).toBeLessThan(1.3);

    // After 77 s: the lines are drawn and named.
    await at(page, 80);
    const withLines = await darkShare(page);
    expect(withLines, `dark share ${beforeLines.toFixed(4)} at 72.5 s, ${withLines.toFixed(4)} at 80 s`).toBeGreaterThan(1.5 * beforeLines);
    await expect(legendLine).toBeVisible({ timeout: 10_000 * SLOW });
    await expect(legendLine).toHaveText(LEGEND_LINE);
    await expect(legendLine).toHaveAttribute('aria-hidden', 'false');

    // Taken back before them, both go again.
    await at(page, 70);
    expect(await darkShare(page)).toBeLessThan(1.3 * beforeLines);
    await expect(legendLine).toBeHidden({ timeout: 10_000 * SLOW });
    expect(pageErrors).toEqual([]);
  });
}
