/**
 * Black holes (src/explore/neighbourhood/holes.ts, lens.ts, lens-view.ts; docs/NEIGHBOURHOOD.md), in the
 * browser: the seven listed, each flown to with its cited mass and distance; the shadow drawn at the
 * size the light bending gives (sqrt(27)/2 r_s, about 2.6 Schwarzschild radii seen from afar; here from
 * 20 r_s, Synge's 7.27 degrees), measured on the screen against the projection; down to two of its radii
 * of a stellar one, kilometres out, and never inside; TON 618's mass a range; found by name as a tool
 * would; the model said to be one; and the picture never flashing as the camera goes round. The stars
 * past a hole are points bent in their own vertex stage (sharp and as many as elsewhere, none in the
 * shadow); a stellar hole kiloparsecs out has a sky (the Sun's, stood in and said so); the lens's
 * capture of the sky's glow is never another hole's; under reduced motion a flight there is a cut.
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

/** The canvas's pixels (CSS px at this DPR 1 project), as luma 0-255, from a screenshot with the interface hidden: along `count` rays out from a point. */
async function lumaAround(page: Page, cx: number, cy: number, maxR: number, count = 8): Promise<number[][]> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ base64, x, y, r, n }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2D context');
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      // Rays out from the centre, a pixel at a time.
      const rays: number[][] = [];
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * 2 * Math.PI;
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
    { base64: btoa(binary), x: cx, y: cy, r: maxR, n: count },
  );
}

/**
 * The canvas's light outside a circle (CSS px, at this project's density): its mean luma (0-255) and how
 * many separate spots are lit (64 of 255 or more, touching eight ways).
 */
async function skyOutside(page: Page, cx: number, cy: number, r: number): Promise<{ mean: number; lit: number }> {
  const png = (await page.locator('#scene').screenshot({ style: HIDE_UI, scale: 'css' })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ base64, x, y, radius }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2D context');
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      const luma = new Float32Array(width * height);
      let sum = 0;
      let n = 0;
      for (let py = 0; py < height; py += 1)
        for (let px = 0; px < width; px += 1) {
          const i = py * width + px;
          const l = 0.2126 * (data[i * 4] ?? 0) + 0.7152 * (data[i * 4 + 1] ?? 0) + 0.0722 * (data[i * 4 + 2] ?? 0);
          luma[i] = Math.hypot(px - x, py - y) < radius ? 0 : l;
          if (Math.hypot(px - x, py - y) >= radius) {
            sum += l;
            n += 1;
          }
        }
      const seen = new Uint8Array(width * height);
      let lit = 0;
      const stack: number[] = [];
      for (let i = 0; i < luma.length; i += 1) {
        if (seen[i] || (luma[i] ?? 0) < 64) continue;
        lit += 1;
        seen[i] = 1;
        stack.push(i);
        while (stack.length > 0) {
          const j = stack.pop() ?? 0;
          const jx = j % width;
          const jy = (j - jx) / width;
          for (let dy = -1; dy <= 1; dy += 1)
            for (let dx = -1; dx <= 1; dx += 1) {
              const qx = jx + dx;
              const qy = jy + dy;
              if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
              const q = qy * width + qx;
              if (seen[q] || (luma[q] ?? 0) < 64) continue;
              seen[q] = 1;
              stack.push(q);
            }
        }
      }
      return { mean: sum / Math.max(n, 1), lit };
    },
    { base64: btoa(binary), x: cx, y: cy, radius: r },
  );
}

async function enterStars(page: Page, kf: { open: (r: string, o?: { query?: Record<string, string> }) => Promise<void> }): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The tier fixed by the address holds the resolution at full (./quality): these tests count stars and
  // judge flashes in pixels, and a GPU shared with other tests would otherwise lower it mid-measure (by
  // 4 per cent, upscaled, it halves the faint stars counted past a hole).
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'high' } });
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
  // How its mass was measured in the messages' words; the model's galactic centre and GRAVITY's, two measurements 127 pc apart.
  await expect(page.getByTestId('stars-bh-observation')).toContainText('S2 and others');
  await expect(page.getByTestId('stars-bh-observation')).toContainText('127 parsecs farther');
  // The shadow on the screen: its edge, where the dark inside gives way most steeply to the photon ring (light that has gone round
  // the hole), on the light averaged all round, at tan(7.27 deg) / tan(25 deg) of half the canvas's height from where the hole
  // projects; and on most rays the ring is there (the hot gas in front glows over its rim, inside).
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
  // (The stars' secondary images sit just outside the edge, so a ray's brightest pixel may be one of them: the edge from the average.)
  const all = await lumaAround(page, at.x - box.x, at.y - box.y, expected * 2, 360);
  const profile = Array.from({ length: Math.floor(expected * 1.4) }, (_, s) => all.reduce((sum, ray) => sum + (ray[s] ?? 0), 0) / all.length);
  let edgeAt = 0;
  let rise = -Infinity;
  for (let s = Math.floor(expected * 0.7); s < Math.min(profile.length - 2, expected * 1.3); s += 1) {
    const d = (profile[s + 2] ?? 0) - (profile[s - 2] ?? 0);
    if (d > rise) {
      rise = d;
      edgeAt = s;
    }
  }
  expect(Math.abs(edgeAt - expected) / expected).toBeLessThan(0.05);
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

test('past a stellar black hole the stars are sharp points, as many as elsewhere, none in its shadow; one kiloparsecs out has the Sun’s sky stood in, said so', async ({ page, kf, pageErrors }, testInfo) => {
  test.setTimeout(300_000 * SLOW);
  await enterStars(page, kf);
  const box = await page.locator('#scene').boundingBox();
  if (!box) throw new Error('no canvas');
  // The stars by default, to compare with: lit spots over the whole canvas.
  await page.waitForTimeout(1500);
  const home = await skyOutside(page, -1e4, -1e4, 0);
  const counts: string[] = [`stars: ${String(home.lit)} lit, mean ${home.mean.toFixed(2)}`];
  for (const id of ['gaia-bh3', 'gaia-bh2', 'cyg-x-1']) {
    await command(page, { kind: 'starsPlace', place: `bh:${id}` });
    await expect.poll(async () => (await stars(page))?.blackHole?.id ?? null, LIVE).toBe(id);
    await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
    await page.waitForTimeout(1500);
    const b = (await stars(page))?.blackHole;
    const at = await page.evaluate((hid) => (window as unknown as KfHook).__kf.app.hud().labels.find((l) => l.id === `bh-${hid}`), id);
    if (!at || !b) throw new Error(`${id} is not on the screen`);
    // Outside the shadow and the disc (a disc of 12 r_s seen from 55: within 13 degrees of the hole).
    const r = (Math.tan(((b.model === 'thin-disc' ? 13 : b.shadowDeg) * Math.PI) / 180) / Math.tan(((FOV / 2) * Math.PI) / 180)) * (box.height / 2);
    const sky = await skyOutside(page, at.x - box.x, at.y - box.y, r * 1.05);
    counts.push(`${id}: ${String(sky.lit)} lit, mean ${sky.mean.toFixed(2)}`);
    expect(sky.lit, `${id}: stars past it`).toBeGreaterThan(0.25 * home.lit);
    expect(sky.mean, `${id}: not a black sky`).toBeGreaterThan(1);
    // Kiloparsecs out the stars there are not catalogued: the Sun's sky stands in, and the panel says so.
    expect(b.skyFromSun).toBe(true);
    await expect(page.getByTestId('stars-bh-observation')).toContainText('stand-in');
    if (b.model === 'dormant') {
      // Nothing drawn in its shadow: no star bent into it.
      const shadow = (Math.tan((b.shadowDeg * Math.PI) / 180) / Math.tan(((FOV / 2) * Math.PI) / 180)) * (box.height / 2);
      for (const ray of await lumaAround(page, at.x - box.x, at.y - box.y, shadow)) expect(Math.max(...ray.slice(24, Math.floor(shadow * 0.95)))).toBeLessThan(8);
    }
  }
  testInfo.annotations.push({ type: 'skies', description: counts.join('; ') });
  // Back near the Sun's own stars, nothing stands in.
  await command(page, { kind: 'starsPlace', place: 'bh:sgr-a' });
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  expect((await stars(page))?.blackHole?.skyFromSun).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('the lens’s capture of the sky’s glow is never another hole’s: forgotten on the way to the next, taken again there', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await enterStars(page, kf);
  await command(page, { kind: 'starsPlace', place: 'bh:sgr-a' });
  await expect.poll(async () => (await stars(page))?.travelling, LIVE).toBe(false);
  await expect.poll(async () => (await stars(page))?.blackHole?.skyCaptured ?? false, LIVE).toBe(true);
  await command(page, { kind: 'starsPlace', place: 'bh:gaia-bh1' });
  // All the way there, near the new hole too, the capture is not Sagittarius A*'s. Each sample is one
  // view, the travel and the capture together (read apart, the trip could end between them and the
  // capture taken on arrival be read as one taken on the way).
  let samples = 0;
  for (;;) {
    const n = await stars(page);
    if (!n?.travelling) break;
    if (n.blackHole?.id === 'gaia-bh1') {
      expect(n.blackHole.skyCaptured).toBe(false);
      samples += 1;
    }
    await page.waitForTimeout(50);
  }
  expect(samples).toBeGreaterThan(5);
  await expect.poll(async () => (await stars(page))?.blackHole?.skyCaptured ?? false, LIVE).toBe(true);
  expect(pageErrors).toEqual([]);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('a flight to a black hole is a cut: the camera is where it was, then there, never between', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await enterStars(page, kf);
    const from = (await stars(page))?.fromSunPc ?? 0;
    await command(page, { kind: 'starsPlace', place: 'bh:gaia-bh3' });
    const seen: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 3000) {
      seen.push((await stars(page))?.fromSunPc ?? 0);
      await page.waitForTimeout(20);
    }
    const there = (await stars(page))?.blackHole;
    expect(there?.id).toBe('gaia-bh3');
    expect((await stars(page))?.travelling).toBe(false);
    expect(there?.cameraRs ?? 0).toBeCloseTo(20, 6);
    const to = seen[seen.length - 1] ?? 0;
    // Every sample at one end or the other.
    for (const d of seen) expect(Math.min(Math.abs(d - from), Math.abs(d - to)), `${String(d)} pc from the Sun, between ${String(from)} and ${String(to)}`).toBeLessThan(1e-6);
    expect(pageErrors).toEqual([]);
  });
});
