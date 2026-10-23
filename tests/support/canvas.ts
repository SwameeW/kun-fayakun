/**
 * Samples what the 3D canvas actually shows. A screenshot is used rather than
 * reading the canvas back, because WebGPU and WebGL2 drawing buffers are not
 * readable after compositing; the DOM UI is hidden while it is taken so
 * overlay text cannot make a black canvas look lit.
 */
import { expect, test, type Page } from '@playwright/test';

export interface CanvasStats {
  width: number;
  height: number;
  maxLuma: number;
  meanLuma: number;
  /** Fraction of pixels brighter than LIT_LUMA. */
  litFraction: number;
}

/** 8-bit luma above which a pixel counts as lit (the page background is near black). */
const LIT_LUMA = 40;
/** At least this fraction of the canvas must be lit to count as "not blank". */
const MIN_LIT_FRACTION = 0.0005;

const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';

/** Base64 without Node's Buffer (see node-fs.d.ts for why tests avoid Node types). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function canvasStats(page: Page): Promise<CanvasStats> {
  // Playwright returns a Node Buffer, which is a Uint8Array.
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  return page.evaluate(
    async ({ base64, lit }): Promise<CanvasStats> => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D context unavailable');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let max = 0;
      let sum = 0;
      let litCount = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
        sum += luma;
        if (luma > max) max = luma;
        if (luma > lit) litCount += 1;
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        maxLuma: Math.round(max),
        meanLuma: Math.round((sum / pixels) * 10) / 10,
        litFraction: litCount / pixels,
      };
    },
    { base64: toBase64(png), lit: LIT_LUMA },
  );
}

/**
 * Retries until the canvas shows something, since exposure eases in after a seek. The fade
 * advances with frame time (capped per frame), so on a software renderer (GPU-less CI, a few
 * frames per second) it takes far longer in real time: those runs get a longer wait.
 */
export async function expectCanvasNotBlank(page: Page, timeout?: number): Promise<void> {
  const software = await page.evaluate(() => document.documentElement.dataset.tier === 'low' && navigator.webdriver);
  const wait = timeout ?? (software ? 75_000 : 20_000);
  await expect(async () => {
    const stats = await canvasStats(page);
    expect(stats.litFraction, `lit fraction of the canvas ${JSON.stringify(stats)}`).toBeGreaterThan(
      MIN_LIT_FRACTION,
    );
    test.info().annotations.push({ type: 'canvas', description: JSON.stringify(stats) });
  }).toPass({ timeout: wait, intervals: [250, 500, 1000] });
}
