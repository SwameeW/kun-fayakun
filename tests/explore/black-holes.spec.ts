/**
 * Black holes (src/explore/neighbourhood/holes.ts, lens.ts, lens-view.ts; docs/NEIGHBOURHOOD.md), in the
 * browser: the seven listed, each flown to with its cited mass and distance; the shadow drawn at the
 * size the light bending gives (sqrt(27)/2 r_s, about 2.6 Schwarzschild radii seen from afar; here from
 * 20 r_s, Synge's 7.27 degrees), measured on the screen against the projection; down to two of its radii
 * of a stellar one, kilometres out, and never inside; TON 618's mass a range; found by name as a tool
 * would; the model said to be one; and the picture never flashing as the camera goes round.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 90_000 * SLOW };
/** The explorer's field of view among the stars (src/core/camera.ts DEFAULT_FOV), degrees. */
const FOV = 50;
const stars = async (page: Page) => (await view(page))?.neighbourhood ?? null;
const command = (page: Page, c: unknown): Promise<void> =>
  page.evaluate((x) => {
    (window as unknown as KfHook).__kf.app.earthCommand(x as never);
  }, c);
const HIDE_UI = 'body > :not(#scene) { visibility: hidden !important; }';

/** The canvas's pixels (CSS px at this DPR 1 project), as luma 0-255, from a screenshot with the interface hidden. */
async function lumaAround(page: Page, cx: number, cy: number, maxR: number): Promise<number[][]> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ base64, x, y, r }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2D context');
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      // Eight rays out from the centre, a pixel at a time.
      const rays: number[][] = [];
      for (let k = 0; k < 8; k += 1) {
        const a = (k / 8) * 2 * Math.PI;
        const ray: number[] = [];
        for (let s = 0; s < r; s += 1) {
          const px = Math.round(x + Math.cos(a) * s);
          const py = Math.round(y + Math.sin(a) * s);
          if (px < 0 || py < 0 || px >= width || py >= height) break;
          const i = (py * width + px) * 4;
          ray.push(0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0));
        }
        rays.push(ray);
      }
      return rays;
    },
    { base64: btoa(binary), x: cx, y: cy, r: maxR },
  );
}

async function enterStars(page: Page, kf: { open: (r: string, o?: { query?: Record<string, string> }) => Promise<void> }): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await stars(page))?.focus.name ?? null, LIVE).toBe('Sun');
  await expect.poll(async () => (await stars(page))?.blackHoles.length ?? 0, LIVE).toBe(7);
}

test('the seven black holes listed and flown to, each with its cited mass and distance; the shadow on the screen at the size the bending gives', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await enterStars(page, kf);
  await expect(page.getByTestId('stars-black-holes').getByRole('button')).toHaveCount(7);
  // Sagittarius A*: GRAVITY's mass and distance, its horizon 0.085 au; arrived 20 of its radii out, its shadow 14.5 degrees across.
  await page.getByTestId('stars-bh-sgr-a').click();
  await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe('sgr-a');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  const b = (await stars(page))?.blackHole;
  expect(b?.massMsun).toBe(4.297e6);
  expect(b?.massSource).toBe('gravity-2022-sgr-a');
  expect(b?.distPc).toBe(8277);
  expect(b?.rsAu ?? 0).toBeCloseTo(0.0848, 3);
  expect(b?.cameraRs ?? 0).toBeCloseTo(20, 6);
  expect(b?.shadowDeg ?? 0).toBeCloseTo(7.274, 2);
  expect(b?.observation?.ringMicroArcsec).toBe(51.8);
  await expect(page.getByTestId('stars-bh-model')).toContainText('computed');
  await expect(page.getByTestId('stars-bh-model')).toContainText('illustrative');
  await expect(page.getByTestId('stars-bh-here')).toContainText('14.5 degrees');
  await expect(page.getByTestId('stars-bh-observation')).toContainText('51.8');
  // The shadow on the screen: its edge, where the photon ring shines (light that has gone round the hole), at tan(7.27 deg) /
  // tan(25 deg) of half the canvas's height from where the hole projects; black well inside it (the hot gas in front glows over its rim).
  await page.waitForTimeout(1500);
  const at = await page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.find((l) => l.id === 'bh-sgr-a'));
  const box = await page.locator('#scene').boundingBox();
  if (!at || !box) throw new Error('the hole is not on the screen');
  const expected = (Math.tan(((b?.shadowDeg ?? 0) * Math.PI) / 180) / Math.tan(((FOV / 2) * Math.PI) / 180)) * (box.height / 2);
  const rays = await lumaAround(page, at.x - box.x, at.y - box.y, expected * 2);
  const rings = rays
    .map((ray) => {
      // The brightest pixel between 0.7 and 1.3 of the expected radius: the photon ring.
      let best = Number.NaN;
      let bright = 0;
      for (let s = Math.floor(expected * 0.7); s < Math.min(ray.length, expected * 1.3); s += 1) {
        if ((ray[s] ?? 0) > bright) {
          bright = ray[s] ?? 0;
          best = s;
        }
      }
      return bright > 60 ? best : Number.NaN;
    })
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  expect(rings.length).toBeGreaterThanOrEqual(6);
  const median = rings[Math.floor(rings.length / 2)] ?? 0;
  expect(Math.abs(median - expected) / expected).toBeLessThan(0.05);
  // A dormant one (no gas in front to glow over its shadow): black to its edge, past the ring that marks the hole in orbit (34 px across).
  await command(page, { kind: 'starsPlace', place: 'bh:gaia-bh1' });
  await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe('gaia-bh1');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await page.waitForTimeout(1500);
  const dormant = (await stars(page))?.blackHole;
  const hole = await page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.find((l) => l.id === 'bh-gaia-bh1'));
  if (!hole) throw new Error('Gaia BH1 is not on the screen');
  const edge = (Math.tan(((dormant?.shadowDeg ?? 0) * Math.PI) / 180) / Math.tan(((FOV / 2) * Math.PI) / 180)) * (box.height / 2);
  expect(Math.abs(edge - expected) / expected).toBeLessThan(0.01);
  for (const ray of await lumaAround(page, hole.x - box.x, hole.y - box.y, edge)) expect(Math.max(...ray.slice(30, Math.floor(edge * 0.95)))).toBeLessThan(8);
  expect(pageErrors).toEqual([]);
});

test('a stellar black hole to two of its radii, kilometres out and never inside; TON 618 found by name, its mass a range; holes in the search', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await enterStars(page, kf);
  await command(page, { kind: 'starsPlace', place: 'bh:gaia-bh1' });
  await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe('gaia-bh1');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  const b = (await stars(page))?.blackHole;
  expect(b?.massMsun).toBe(9.62);
  expect(b?.rsKm ?? 0).toBeCloseTo(28.41, 1);
  expect(b?.model).toBe('dormant');
  // In with the wheel a hundred notches: down to two of its radii (57 km), held exactly there.
  await page.mouse.move(400, 450);
  for (let k = 0; k < 100; k += 1) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  const near = (await stars(page))?.blackHole;
  expect(near?.cameraRs ?? 0).toBeGreaterThanOrEqual(2 - 1e-9);
  expect(near?.cameraRs ?? 0).toBeLessThan(2.01);
  expect((near?.cameraRs ?? 0) * (near?.rsKm ?? 0)).toBeCloseTo(56.8, 0);
  expect(near?.shadowDeg ?? 0).toBeGreaterThan(60);
  await expect(page.getByTestId('stars-bh-here')).toContainText('km');
  // Going round it there: the distance held to a millionth.
  for (let k = 0; k < 5; k += 1) {
    await page.mouse.move(300, 450);
    await page.mouse.down();
    await page.mouse.move(500, 470, { steps: 8 });
    await page.mouse.up();
  }
  expect((await stars(page))?.blackHole?.cameraRs ?? 0).toBeCloseTo(near?.cameraRs ?? 0, 6);
  // By name, as a tool would: TON 618, its mass the range of two estimates from one spectrum.
  await command(page, { kind: 'starsFind', name: 'TON 618' });
  await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe('ton-618');
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  const ton = (await stars(page))?.blackHole;
  expect(ton?.massLow).toBe(4.07e10);
  expect(ton?.massMsun).toBe(6.6e10);
  expect(ton?.rsAu ?? 0).toBeCloseTo(1303, -1);
  expect(ton?.redshift).toBe(2.219);
  await expect(page.getByTestId('stars-bh-mass')).toContainText('41 billion to 66 billion');
  // The search finds them too.
  await page.getByTestId('stars-search').fill('Cygnus');
  await page.getByTestId('stars-result-bh-cyg-x-1').click();
  await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe('cyg-x-1');
  // Back and forth between two, twenty times, as fast as it goes: it ends at one, still.
  for (let k = 0; k < 20; k += 1) await command(page, { kind: 'starsPlace', place: k % 2 ? 'bh:sgr-a' : 'bh:ton-618' });
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  expect((await stars(page))?.blackHole?.id).toBe('sgr-a');
  expect(pageErrors).toEqual([]);
});

test('going round a black hole never flashes: the picture’s mean light never swings by a tenth and back within a third of a second', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await enterStars(page, kf);
  await command(page, { kind: 'starsPlace', place: 'bh:ton-618' });
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await page.waitForTimeout(1000);
  const samples: Array<{ t: number; luma: number }> = [];
  const start = Date.now();
  await page.mouse.move(300, 450);
  await page.mouse.down();
  for (let k = 0; k < 24; k += 1) {
    await page.mouse.move(300 + 40 * (k + 1), 450 + (k % 2 ? 6 : -6));
    const png = (await page.locator('#scene').screenshot({ style: HIDE_UI, scale: 'css' })) as Uint8Array;
    let binary = '';
    for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
    const luma = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) return 0;
      g.drawImage(bitmap, 0, 0);
      const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      return sum / (data.length / 16) / 255;
    }, btoa(binary));
    samples.push({ t: Date.now() - start, luma });
  }
  await page.mouse.up();
  // A flash (WCAG 2.3.1): a pair of opposing changes of the mean of 0.1 or more within a third of a second.
  for (let i = 0; i < samples.length; i += 1)
    for (let j = i + 1; j < samples.length; j += 1)
      for (let k = j + 1; k < samples.length; k += 1) {
        const [a, b, c] = [samples[i], samples[j], samples[k]];
        if (!a || !b || !c || c.t - a.t > 333) continue;
        const up = b.luma - a.luma;
        const down = c.luma - b.luma;
        expect(Math.abs(up) >= 0.1 && Math.abs(down) >= 0.1 && Math.sign(up) !== Math.sign(down), `a flash between ${String(a.t)} and ${String(c.t)} ms`).toBe(false);
      }
  expect(pageErrors).toEqual([]);
});
