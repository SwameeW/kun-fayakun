/**
 * The light on foot, measured from the picture (src/explore/walk/light, sky, ground; the Sun's disc and
 * glare): on the Earth at noon the Sun a small disc at its true size (0.53 degrees) in a sky that is
 * never blown out round it, the ground near middle grey; at sunset the Sun and the sky under it
 * reddened, and the land still seen; at night dark; on the Moon and Mars the ground near middle grey
 * too. The luma ranges are the ones measured when the light was made (docs/WALKING.md, "Light and
 * depth"). And the ground's heights decoded to the metre: every point of every ring on the flat mocked
 * ground at 1,000 m (this spec runs in Brave too, whose canvas read-backs are tampered with). Mocked
 * flat terrain at 1,000 m and a one-pixel imagery tile.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { MOCK_GROUND_M } from '../support/live';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };

test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

type World = 'earth' | 'moon' | 'mars';

/** A walk at a place, the clock held at the moment the Sun stands `sunDeg` high (rising, or setting), facing `fromSunDeg` from it and looking `pitchDeg` up. */
async function stand(page: Page, at: { world: World; lat: number; lon: number }, sunDeg: number, rising: boolean, span: number, stepDays: number): Promise<number> {
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, at);
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  return page.evaluate(
    ([target, days, stepD, up]) => {
      const kf = (window as unknown as KfHook).__kf;
      kf.app.universeTime({ kind: 'rate', rate: 0 });
      const base = Number(new URL(location.href).searchParams.get('jd')) || 2461336.75;
      const at = (jdUtc: number): number => {
        kf.app.universeTime({ kind: 'date', jdUtc });
        kf.step(1, 1 / 60);
        return kf.universe.state()?.walk?.sunElevationDeg ?? Number.NaN;
      };
      let prev = at(base);
      for (let t = base + stepD; t <= base + days; t += stepD) {
        const e = at(t);
        if (up ? prev <= target && e >= target : prev >= target && e <= target) {
          let lo = t - stepD;
          let hi = t;
          for (let i = 0; i < 30; i += 1) {
            const mid = (lo + hi) / 2;
            const em = at(mid);
            if (up ? em < target : em > target) lo = mid;
            else hi = mid;
          }
          at(hi);
          return hi;
        }
        prev = e;
      }
      return Number.NaN;
    },
    [sunDeg, span, stepDays, rising] as const,
  );
}

/** Faces a way (degrees from the Sun's azimuth, or absolute) and lets the eye adapt (six stops at most, at its slew). */
async function face(page: Page, at: { world: World; lat: number; lon: number }, jd: number, fromSunDeg: number, pitchDeg: number): Promise<void> {
  const az = (await view(page))?.walk?.sunAzimuthDeg ?? 0;
  await page.evaluate(
    ([a, j, heading, pitch]) => {
      const kf = (window as unknown as KfHook).__kf;
      kf.app.earthCommand({ kind: 'walk', ...a, headingDeg: heading, pitchDeg: pitch });
      kf.app.universeTime({ kind: 'date', jdUtc: j });
    },
    [at, jd, (az + fromSunDeg + 360) % 360, pitchDeg] as const,
  );
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  await expect.poll(async () => (await view(page))?.walk?.tiles.loading ?? 1, LIVE).toBe(0);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.step(360, 1 / 60);
  });
}

interface Shot {
  mean: number;
  max: number;
  clipped: number;
  /** Mean luma of the lowest third (the ground, looking level or down) and the top third. */
  low: number;
  top: number;
  /** Around the Sun's centre (when in view): the share of pixels at luma 245 or more within 40 to 300 px, the farthest such pixel, and the mean colour at 14 to 30 px. */
  ring: { hot: number; reach: number; near: [number, number, number] } | null;
}

/** The canvas alone (the interface hidden), as luma statistics. */
async function shot(page: Page): Promise<Shot> {
  const sun = (await view(page))?.bodies.find((b) => b.id === 'sun')?.screen ?? null;
  const png = (await page.locator('#scene').screenshot({ style: 'body > :not(#scene) { visibility: hidden !important; }' })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ b64, s }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2D context');
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = width / innerWidth;
      let sum = 0;
      let max = 0;
      let clipped = 0;
      let low = 0;
      let lowN = 0;
      let top = 0;
      let topN = 0;
      let hot = 0;
      let ringN = 0;
      let reach = 0;
      const near = [0, 0, 0];
      let nearN = 0;
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const r = data[i] ?? 0;
          const gg = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          sum += l;
          max = Math.max(max, l);
          if (Math.min(r, gg, b) >= 250) clipped += 1;
          if (y > (height * 2) / 3) {
            low += l;
            lowN += 1;
          } else if (y < height / 3) {
            top += l;
            topN += 1;
          }
          if (s && s.inView) {
            const d = Math.hypot(x / scale - s.x, y / scale - s.y);
            if (l >= 245) reach = Math.max(reach, d);
            if (d >= 40 && d < 300) {
              ringN += 1;
              if (l >= 245) hot += 1;
            }
            if (d >= 14 && d < 30) {
              near[0] = (near[0] ?? 0) + r;
              near[1] = (near[1] ?? 0) + gg;
              near[2] = (near[2] ?? 0) + b;
              nearN += 1;
            }
          }
        }
      const n = width * height;
      return {
        mean: sum / n,
        max,
        clipped: clipped / n,
        low: low / Math.max(lowN, 1),
        top: top / Math.max(topN, 1),
        ring: s && s.inView ? { hot: hot / Math.max(ringN, 1), reach, near: near.map((v) => v / Math.max(nearN, 1)) as [number, number, number] } : null,
      };
    },
    { b64: btoa(binary), s: sun },
  );
}

const SAHARA = { world: 'earth', lat: 23.4, lon: 25 } as const;

test('the Earth at noon: the Sun a small disc at its true size, the sky round it never blown out, no names on the daylit sky, the ground near middle grey', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const jd = await stand(page, SAHARA, 50, true, 1, 1 / 96);
  expect(jd).not.toBeNaN();
  // Facing the Sun, looking 30 degrees up: it is in view.
  await face(page, SAHARA, jd, 0, 30);
  const sun = (await view(page))?.bodies.find((b) => b.id === 'sun')?.screen;
  expect(sun?.inView).toBe(true);
  // Its disc's radius on screen is the true one: 900 px over 70 degrees of field, tan(0.2666 degrees).
  const pxPerTan = 900 / (2 * Math.tan((35 * Math.PI) / 180));
  expect(sun?.radiusPx ?? 0).toBeGreaterThan(pxPerTan * Math.tan((0.26 * Math.PI) / 180));
  expect(sun?.radiusPx ?? 0).toBeLessThan(pxPerTan * Math.tan((0.275 * Math.PI) / 180));
  const toward = await shot(page);
  // A small white disc (its glare's core included): nothing near white beyond 20 px of its centre, and nothing clipped round it.
  expect(toward.ring?.reach ?? 999).toBeLessThan(20);
  expect(toward.ring?.hot ?? 1).toBe(0);
  expect(toward.clipped).toBeLessThan(0.0005);
  // No world's name on a daylit sky (the Sun's never on foot), however the view turns.
  for (const fromSunDeg of [0, 90, 180, 270]) {
    await face(page, SAHARA, jd, fromSunDeg, 20);
    const named = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || 0) > 0.05).map((t) => t.textContent));
    expect(named, `facing ${String(fromSunDeg)} degrees from the Sun`).toEqual([]);
  }
  // Facing away, looking 10 degrees down: the ground near middle grey, the sky blue and lighter.
  await face(page, SAHARA, jd, 180, -10);
  const away = await shot(page);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ toward, away }) });
  // (The Sahara's sand is bright: about middle grey's twice.)
  expect(away.low).toBeGreaterThan(110);
  expect(away.low).toBeLessThan(205);
  expect(away.max).toBeLessThan(250);
  expect(away.clipped).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('the Earth at sunset: the Sun and the sky under it reddened, nothing blown out, the land still seen; at night, dark', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const jd = await stand(page, SAHARA, 1.5, false, 1, 1 / 96);
  expect(jd).not.toBeNaN();
  await face(page, SAHARA, jd, 0, 2);
  const toward = await shot(page);
  // Round the Sun, red over green over blue: its light through the long path near the horizon.
  const [r, g, b] = toward.ring?.near ?? [0, 0, 0];
  expect(r).toBeGreaterThan(g);
  expect(g).toBeGreaterThan(b);
  expect(b / r).toBeLessThan(0.75);
  expect(toward.clipped).toBeLessThan(0.002);
  expect(toward.ring?.hot ?? 1).toBeLessThan(0.02);
  // Facing away the land is seen, not night.
  await face(page, SAHARA, jd, 180, 0);
  const away = await shot(page);
  expect(away.mean).toBeGreaterThan(60);
  expect(away.low).toBeGreaterThan(30);
  // Night: the Sun 18 degrees down.
  const night = await stand(page, SAHARA, -18, false, 1, 1 / 96);
  await face(page, SAHARA, night, 180, 0);
  const dark = await shot(page);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ toward, away, dark }) });
  expect(dark.mean).toBeLessThan(25);
  expect(pageErrors).toEqual([]);
});

for (const [world, at, sunDeg, span, stepDays] of [
  ['moon', { world: 'moon', lat: 0.67416, lon: 23.47314 }, 30, 30, 0.25],
  ['mars', { world: 'mars', lat: 18.4447, lon: 77.4508 }, 40, 1.05, 1 / 96],
] as const) {
  test(`the ground of ${world} by day as dark as its albedo, the eye metered for it, the Sun's sky (where there is one) never blown out`, async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open(`/universe/${world}`, { query: { jd: JD } });
    await waitForUniverse(page);
    const jd = await stand(page, at, sunDeg, true, span, stepDays);
    expect(jd).not.toBeNaN();
    await face(page, at, jd, 180, -12);
    const away = await shot(page);
    test.info().annotations.push({ type: 'light', description: JSON.stringify({ away }) });
    // Measured when the light was made: about 47 (Apollo 11's mare) and 44 (Jezero's floor), each among its
    // world's darker plains, its colour map scaled to the world's measured albedo and the eye metered for it.
    expect(away.low).toBeGreaterThan(world === 'moon' ? 40 : 37);
    expect(away.low).toBeLessThan(170);
    expect(away.clipped).toBe(0);
    await face(page, at, jd, 0, sunDeg - 10);
    const toward = await shot(page);
    expect(toward.ring?.hot ?? 1).toBeLessThan(0.01);
    expect(toward.clipped).toBeLessThan(0.0005);
    expect(pageErrors).toEqual([]);
  });
}

test('the ground decoded to the metre: every point of every ring on the flat mocked ground at 1,000 m, no spikes, no pits', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25 });
  });
  await expect.poll(async () => (await view(page))?.walk?.rings ?? 0, LIVE).toBe(11);
  await expect.poll(async () => (await view(page))?.walk?.tiles.loading ?? 1, LIVE).toBe(0);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.step(10, 1 / 60);
  });
  const off = await page.evaluate((expected) => {
    const app = (window as unknown as KfHook).__kf.app as unknown as { scene: { getObjectByName(n: string): { geometry: { getAttribute(n: string): { array: Float32Array } } } | undefined } };
    let worst = 0;
    let points = 0;
    for (let level = 0; level < 11; level += 1) {
      const ring = app.scene.getObjectByName(`explore-walk-ring-${String(level)}`);
      const above = ring?.geometry.getAttribute('above').array;
      if (!above) continue;
      for (const h of above) {
        worst = Math.max(worst, Math.abs(h - expected));
        points += 1;
      }
    }
    return { worst, points };
  }, MOCK_GROUND_M);
  expect(off.points).toBeGreaterThan(11 * 2000);
  expect(off.worst).toBeLessThan(1);
  expect((await view(page))?.walk?.groundM).toBeCloseTo(MOCK_GROUND_M, 3);
  expect(pageErrors).toEqual([]);
});
