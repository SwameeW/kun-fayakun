/**
 * Chapter 7 in the browser, on the manual clock (__kf.step):
 *
 * - the orrery's Earth (src/chapters/shared/planet.ts without the air) has no lava on its night side
 *   (its crust's noise once left orange sparks there on a cooled world);
 * - the chapter loads without the explorer's air, which only Chapters 8 and 9 draw (shared/film-air.ts).
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from './support/fixtures';

const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';

/** Plays the six seconds of film up to chapter time t, on the manual clock. */
async function showAt(page: Page, t: number): Promise<void> {
  await page.evaluate((time) => {
    const kfHook = (window as unknown as KfHook).__kf;
    if (kfHook.app.paused) kfHook.app.play();
    kfHook.step();
    for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
    const from = Math.max(0, time - 6);
    kfHook.app.seek(from);
    kfHook.step(Math.round((time - from) * 60), 1 / 60);
  }, t);
}

interface Sampled {
  /** Mean red excess (R minus the mean of G and B, floored at 0) up the canvas's middle above its centre, and beside it. */
  axis: number;
  beside: number;
  /** Pixels the colour of glowing lava (bright, orange-red, little blue). */
  lava: number;
}

async function sample(page: Page): Promise<Sampled> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const red = (x: number, y: number): number => {
      const p = (y * width + x) * 4;
      return Math.max(0, (data[p] ?? 0) - ((data[p + 1] ?? 0) + (data[p + 2] ?? 0)) / 2);
    };
    const column = (cx: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = Math.round(height * 0.17); y < Math.round(height * 0.44); y += 1) {
        for (let x = cx - 4; x <= cx + 4; x += 1) {
          sum += red(x, y);
          n += 1;
        }
      }
      return sum / n;
    };
    const cx = Math.round(width / 2);
    let lava = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      if (r > 70 && (data[i + 1] ?? 0) < 0.55 * r && (data[i + 2] ?? 0) < 0.25 * r) lava += 1;
    }
    return { axis: column(cx), beside: Math.max(column(cx - Math.round(width * 0.12)), column(cx + Math.round(width * 0.12))), lava };
  }, btoa(binary));
}

test('the orrery’s Earth shows no lava on its night side', async ({ page, kf, pageErrors }) => {
  // The orrery is placed for the visitor's date: held at one where the close-up passes the night side.
  await page.clock.setFixedTime(new Date('2026-10-28T12:00:00Z'));
  await kf.openChapter('ch07', { autoplay: true, query: { tier: 'high' } });
  if (await page.locator('html.kf-panel-open').count()) await page.getByTestId('panel-toggle').click();
  for (const t of [84.5, 85]) {
    await showAt(page, t);
    const seen = await sample(page);
    expect(seen.lava, `at ${t} s`).toBeLessThan(5);
  }
  expect(pageErrors).toEqual([]);
});

test('Chapter 7 loads without the explorer’s air; Chapter 8, which draws it, loads it', async ({ page, kf, pageErrors }) => {
  // The air's model names its constants (src/explore/render/air.ts); no other code carries them.
  const scripts: Array<Promise<string>> = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.push(response.text().catch(() => ''));
  });
  const carriesAir = async (list: ReadonlyArray<Promise<string>>): Promise<boolean> => (await Promise.all(list)).some((text) => text.includes('earth.air.wavelength'));
  await kf.openChapter('ch07', { autoplay: true, query: { tier: 'high' } });
  // What the chapter needed to show itself (the next chapter's code and the explorer's are fetched 1.5 s after).
  expect(await carriesAir(scripts.slice())).toBe(false);
  await page.goto('about:blank');
  await kf.openChapter('ch08', { autoplay: true, query: { tier: 'high' } });
  expect(await carriesAir(scripts.slice())).toBe(true);
  expect(pageErrors).toEqual([]);
});
