/**
 * The light on foot, measured from the picture (src/explore/walk/light, sky, ground, meter; the Sun's
 * disc and glare): on the Earth the Sun a small disc at its true size (0.53 degrees), always seen above
 * the sky round it, and that sky never blown out (nothing at luma 200 or more beyond a few pixels of the
 * disc at 50, 20, 5 and 1.5 degrees up, at 1280 x 800 and 2000 x 1300), the ground near middle grey; at
 * sunset the Sun and the sky under it reddened, the land still seen; at night dark; a day passing in ten
 * minute steps with no pumping; the Earth's ground with no dark streaks (no stones' shadows) at a low or a
 * high Sun; on the Moon and Mars the ground near middle grey too (the eye's meter), and on the Moon by day
 * only the brightest stars (the sunlit ground's glare), none near white; the Moon's night dark, its stars out;
 * a cliff's shadow over the ground below it (horizon mapping); and the ground's heights decoded to the
 * metre (this spec runs in Brave too, whose canvas read-backs are tampered with). Mocked flat terrain at
 * 1,000 m (or a cliff made per tile) and a one-pixel imagery tile.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { MOCK_GROUND_M } from '../support/live';
import { routeTerrain } from '../support/terrain';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
/** The canvas alone: every part of the interface hidden at once (no fade still under way). */
const HIDE = 'body > :not(#scene), body > :not(#scene) * { visibility: hidden !important; transition: none !important; }';

test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

type World = 'earth' | 'moon' | 'mars';

/** A walk at a place, the clock held at the moment the Sun stands `sunDeg` high (rising, or setting). */
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

/**
 * Faces a way (degrees from the Sun's azimuth) looking `pitchDeg` up, lets the eye's meter read the
 * ground in view (two readings after the turn), then lets the eye adapt (six stops at most, at its slew).
 */
async function face(page: Page, at: { world: World; lat: number; lon: number }, jd: number, fromSunDeg: number, pitchDeg: number): Promise<void> {
  const az = (await view(page))?.walk?.sunAzimuthDeg ?? 0;
  const before = (await view(page))?.walk?.metered ?? 0;
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
  await expect.poll(async () => (await view(page))?.walk?.metered ?? 0, LIVE).toBeGreaterThan(before + 1);
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
  /** The lower half's luma: its median, its 99th percentile, the share below 0.35 of the median (dark streaks), and the spread of its detail (a 9 x 9 high-pass's standard deviation). */
  half: { median: number; p99: number; dark: number; detail: number };
  /**
   * Round the Sun's centre (when in view): the brightest luma within 5 px (its disc), the mean colour and
   * luma at 14 to 30 px (the sky round it), and the farthest pixel at luma 200 or more above the horizon.
   */
  sun: { disc: number; ring: [number, number, number]; ringLuma: number; reach200: number; glint: number; beside: number } | null;
  /** The stars (and the planets' points) above the horizon: separate lit spots, luma 64 or more touching eight ways, beyond 30 px of the Sun's centre. */
  stars: number;
}

/** The canvas alone (the interface hidden), as luma statistics; `pitchDeg` the look, for where the horizon lies. */
async function shot(page: Page, pitchDeg = 0): Promise<Shot> {
  const sun = (await view(page))?.bodies.find((b) => b.id === 'sun')?.screen ?? null;
  const png = (await page.locator('#scene').screenshot({ style: HIDE })) as Uint8Array;
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return page.evaluate(
    async ({ b64, s, pitch }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d');
      if (!g) throw new Error('no 2D context');
      g.drawImage(bitmap, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = width / innerWidth;
      // The level horizon's row (70 degrees of field on foot).
      const horizon = innerHeight / 2 + Math.tan((pitch * Math.PI) / 180) * (innerHeight / (2 * Math.tan((35 * Math.PI) / 180)));
      const luma = new Float32Array(width * height);
      let sum = 0;
      let max = 0;
      let clipped = 0;
      let low = 0;
      let lowN = 0;
      let top = 0;
      let topN = 0;
      let disc = 0;
      let reach = 0;
      // Below the horizon: the brightest under the Sun (within 60 px of its column), and the mean well beside it.
      let glint = 0;
      let beside = 0;
      let besideN = 0;
      const ring = [0, 0, 0];
      let ringN = 0;
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const r = data[i] ?? 0;
          const gg = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          luma[y * width + x] = l;
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
            if (d < 5) disc = Math.max(disc, l);
            if (l >= 200 && y / scale < horizon - 4) reach = Math.max(reach, d);
            if (y / scale > horizon + 4) {
              const across = Math.abs(x / scale - s.x);
              if (across < 60) glint = Math.max(glint, l);
              else if (across > 300) {
                beside += l;
                besideN += 1;
              }
            }
            if (d >= 14 && d < 30) {
              ring[0] = (ring[0] ?? 0) + r;
              ring[1] = (ring[1] ?? 0) + gg;
              ring[2] = (ring[2] ?? 0) + b;
              ringN += 1;
            }
          }
        }
      // The lower half: its spread of values, and its detail (each pixel against the mean of the 9 x 9 round it, from a summed-area table).
      const y0 = Math.ceil(height / 2);
      const rows = height - y0;
      const half = Array.from(luma.subarray(y0 * width)).sort((a, b) => a - b);
      const median = half[Math.floor(half.length / 2)] ?? 0;
      const p99 = half[Math.floor(half.length * 0.99)] ?? 0;
      const dark = half.filter((l) => l < 0.35 * median).length / Math.max(half.length, 1);
      const table = new Float64Array((rows + 1) * (width + 1));
      for (let y = 0; y < rows; y += 1)
        for (let x = 0; x < width; x += 1) table[(y + 1) * (width + 1) + x + 1] = (luma[(y0 + y) * width + x] ?? 0) + (table[y * (width + 1) + x + 1] ?? 0) + (table[(y + 1) * (width + 1) + x] ?? 0) - (table[y * (width + 1) + x] ?? 0);
      let hp = 0;
      let hp2 = 0;
      let hpN = 0;
      for (let y = 4; y < rows - 4; y += 1)
        for (let x = 4; x < width - 4; x += 1) {
          const box = (table[(y + 5) * (width + 1) + x + 5] ?? 0) - (table[(y - 4) * (width + 1) + x + 5] ?? 0) - (table[(y + 5) * (width + 1) + x - 4] ?? 0) + (table[(y - 4) * (width + 1) + x - 4] ?? 0);
          const v = (luma[(y0 + y) * width + x] ?? 0) - box / 81;
          hp += v;
          hp2 += v * v;
          hpN += 1;
        }
      // The lit spots above the horizon, each counted once (flood-filled), none starting within 30 px of the Sun.
      const above = Math.max(0, Math.min(height, Math.floor((horizon - 4) * scale)));
      const seen = new Uint8Array(width * above);
      const stack: number[] = [];
      let stars = 0;
      for (let y = 0; y < above; y += 1)
        for (let x = 0; x < width; x += 1) {
          const start = y * width + x;
          if (seen[start] || (luma[start] ?? 0) < 64 || (s?.inView && Math.hypot(x / scale - s.x, y / scale - s.y) < 30)) continue;
          stars += 1;
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
                const j = qy * width + qx;
                if (qx < 0 || qy < 0 || qx >= width || qy >= above || seen[j] || (luma[j] ?? 0) < 64) continue;
                seen[j] = 1;
                stack.push(j);
              }
          }
        }
      const n = width * height;
      const near = ring.map((v) => v / Math.max(ringN, 1)) as [number, number, number];
      return {
        mean: sum / n,
        max,
        clipped: clipped / n,
        low: low / Math.max(lowN, 1),
        top: top / Math.max(topN, 1),
        half: { median, p99, dark, detail: Math.sqrt(Math.max(0, hp2 / Math.max(hpN, 1) - (hp / Math.max(hpN, 1)) ** 2)) },
        sun: s && s.inView ? { disc, ring: near, ringLuma: 0.2126 * near[0] + 0.7152 * near[1] + 0.0722 * near[2], reach200: reach, glint, beside: beside / Math.max(besideN, 1) } : null,
        stars,
      };
    },
    { b64: btoa(binary), s: sun, pitch: pitchDeg },
  );
}

const SAHARA = { world: 'earth', lat: 23.4, lon: 25 } as const;

test('the Earth at noon: the Sun a small disc at its true size, no names on the daylit sky, the ground near middle grey', async ({ page, kf, pageErrors }) => {
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
  const toward = await shot(page, 30);
  // A small bright disc over a sky that is never white round it (75 px at 1280 x 800 is 84 at 900 px tall).
  expect(toward.sun?.reach200 ?? 999).toBeLessThan(84);
  expect((toward.sun?.disc ?? 0) - (toward.sun?.ringLuma ?? 255)).toBeGreaterThanOrEqual(25);
  expect(toward.clipped).toBeLessThan(0.0005);
  // No world's name on a daylit sky (the Sun's never on foot), however the view turns.
  for (const fromSunDeg of [0, 90, 180, 270]) {
    await face(page, SAHARA, jd, fromSunDeg, 20);
    const named = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || 0) > 0.05).map((t) => t.textContent));
    expect(named, `facing ${String(fromSunDeg)} degrees from the Sun`).toEqual([]);
  }
  // Facing away, looking 10 degrees down: the ground near middle grey, the sky blue and lighter.
  await face(page, SAHARA, jd, 180, -10);
  const away = await shot(page, -10);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ toward, away }) });
  // (The Sahara's sand is bright: about middle grey's twice.)
  expect(away.low).toBeGreaterThan(110);
  expect(away.low).toBeLessThan(205);
  expect(away.max).toBeLessThan(250);
  expect(away.clipped).toBe(0);
  expect(pageErrors).toEqual([]);
});

for (const [size, limit] of [
  [{ width: 1280, height: 800 }, 75],
  [{ width: 2000, height: 1300 }, 120],
] as const) {
  test.describe(`at ${String(size.width)} x ${String(size.height)}`, () => {
    test.use({ viewport: size });
    test(`the sky round the Sun never white beyond ${String(limit)} px and its disc always seen above it, at 50, 20, 5 and 1.5 degrees up`, async ({ page, kf, pageErrors }) => {
      test.setTimeout(400_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      const seen: Record<string, unknown> = {};
      for (const [deg, rising] of [
        [50, true],
        [20, true],
        [5, false],
        [1.5, false],
      ] as const) {
        const jd = await stand(page, SAHARA, deg, rising, 1, 1 / 96);
        expect(jd).not.toBeNaN();
        // Facing the Sun, looking at it.
        await face(page, SAHARA, jd, 0, deg);
        const s = await shot(page, deg);
        seen[String(deg)] = s.sun;
        expect(s.sun, `Sun ${String(deg)}: in view`).not.toBeNull();
        // Nothing near white in the sky beyond the disc and its glare's core.
        expect(s.sun?.reach200 ?? 999, `Sun ${String(deg)}: luma 200 or more this far from the Sun`).toBeLessThanOrEqual(limit);
        // The disc well above the sky round it (the setting Sun was lost in its own glow).
        expect((s.sun?.disc ?? 0) - (s.sun?.ringLuma ?? 255), `Sun ${String(deg)}: the disc over the sky round it`).toBeGreaterThanOrEqual(25);
        expect(s.clipped, `Sun ${String(deg)}: clipped`).toBeLessThan(0.0005);
        if (deg === 1.5) {
          // Round the setting Sun, red over green over blue: its light through the long path near the horizon.
          const [r, g, b] = s.sun?.ring ?? [0, 0, 0];
          expect(r).toBeGreaterThan(g);
          expect(g).toBeGreaterThan(b);
          expect(b / r).toBeLessThan(0.75);
        }
      }
      test.info().annotations.push({ type: 'light', description: JSON.stringify(seen) });
      expect(pageErrors).toEqual([]);
    });
  });
}

test('the Earth at sunset: the land still seen facing away; at night, dark', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const jd = await stand(page, SAHARA, 1.5, false, 1, 1 / 96);
  expect(jd).not.toBeNaN();
  await face(page, SAHARA, jd, 180, 0);
  const away = await shot(page);
  expect(away.mean).toBeGreaterThan(60);
  expect(away.low).toBeGreaterThan(30);
  // Night: the Sun 18 degrees down.
  const night = await stand(page, SAHARA, -18, false, 1, 1 / 96);
  await face(page, SAHARA, night, 180, 0);
  const dark = await shot(page);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ away, dark }) });
  expect(dark.mean).toBeLessThan(25);
  expect(pageErrors).toEqual([]);
});

test.describe('a whole day', () => {
  test.use({ viewport: { width: 640, height: 400 } });
  test('a day passing in four-minute steps: the picture follows it, no step more than 25 in mean luma from the last (no jump, no pumping)', async ({ page, kf, pageErrors }) => {
    test.setTimeout(600_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    const night = await stand(page, SAHARA, -18, false, 1, 1 / 96);
    expect(night).not.toBeNaN();
    // Facing north (neither the sunrise nor the sunset in view), a second of frames a step (the eye's slew).
    // (In ten-minute steps the twilight's own change, the Sun's light arriving, is up to about 40 at sunrise; 26 in five.)
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25, headingDeg: 0, pitchDeg: 0 });
    });
    await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
    const means: number[] = [];
    for (let k = 0; k <= 360; k += 1) {
      await page.evaluate((j) => {
        const kf = (window as unknown as KfHook).__kf;
        kf.app.universeTime({ kind: 'date', jdUtc: j });
        kf.step(60, 1 / 60);
      }, night + k / 360);
      means.push((await shot(page)).mean);
    }
    const jumps = means.slice(1).map((m, i) => Math.abs(m - (means[i] ?? m)));
    test.info().annotations.push({ type: 'light', description: JSON.stringify({ worst: Math.max(...jumps), means: means.map((m) => Math.round(m)) }) });
    // Day and night both seen on the way.
    expect(Math.max(...means)).toBeGreaterThan(100);
    expect(Math.min(...means)).toBeLessThan(25);
    expect(Math.max(...jumps)).toBeLessThanOrEqual(25);
    expect(pageErrors).toEqual([]);
  });
});

test('the Earth’s ground at the feet on a slope facing the Sun: no dark streaks at a low Sun or a high one (no stones’ shadows), and grain to see', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  // A hill 1 km high and about 2 km across, its top 1 km west of the walker: the ground at the feet slopes
  // about 30 degrees down to the east, toward the morning Sun, with nothing higher in front.
  const km = 111.32 * Math.cos((SAHARA.lat * Math.PI) / 180);
  await routeTerrain(page, (lat, lon) => 1000 + 1000 * Math.exp(-(((lon - SAHARA.lon) * km + 1) ** 2 + ((lat - SAHARA.lat) * 111.32) ** 2) / 2));
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const seen: Record<string, unknown> = {};
  for (const [deg, rising] of [
    [2, true],
    [40, true],
  ] as const) {
    const jd = await stand(page, SAHARA, deg, rising, 1, 1 / 96);
    expect(jd).not.toBeNaN();
    for (const fromSunDeg of [0, 90]) {
      // Looking 30 degrees down: the slope a few metres away fills the lower half, lit by the morning Sun (facing it, and across it).
      await face(page, SAHARA, jd, fromSunDeg, -30);
      const s = await shot(page, -30);
      seen[`${String(deg)}/${String(fromSunDeg)}`] = s.half;
      const label = `Sun ${String(deg)}, ${String(fromSunDeg)} degrees from it`;
      // Under 1% of the ground at a third of its median or darker: no shadow streaks (a stone's at a low Sun read as spikes).
      expect(s.half.dark, label).toBeLessThan(0.01);
      // Its detail seen, and no harsh pattern: the 9 x 9 high-pass's spread within bounds (measured 1.1 to 1.8;
      // with the stones that were taken away, 5.7 and 1.2% dark at the low Sun facing it).
      expect(s.half.detail, label).toBeGreaterThan(0.8);
      expect(s.half.detail, label).toBeLessThan(5);
    }
  }
  test.info().annotations.push({ type: 'light', description: JSON.stringify(seen) });
  expect(pageErrors).toEqual([]);
});

for (const [world, at, sunDeg, span, stepDays, ceiling] of [
  ['moon', { world: 'moon', lat: 0.67416, lon: 23.47314 }, 30, 30, 0.25, 130],
  ['mars', { world: 'mars', lat: 18.4447, lon: 77.4508 }, 40, 1.05, 1 / 96, 170],
] as const) {
  test(`the ground of ${world} by day near middle grey (the eye’s meter), the Sun’s sky (where there is one) never blown out`, async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open(`/universe/${world}`, { query: { jd: JD } });
    await waitForUniverse(page);
    const jd = await stand(page, at, sunDeg, true, span, stepDays);
    expect(jd).not.toBeNaN();
    await face(page, at, jd, 180, -12);
    const away = await shot(page, -12);
    test.info().annotations.push({ type: 'light', description: JSON.stringify({ away }) });
    // Apollo 11's mare and Jezero's floor, each among its world's darker plains: the meter opens up for
    // them as a camera would (measured 98 and 105 when it was made; 47 and 44 before), the Moon the darker.
    expect(away.low).toBeGreaterThan(90);
    expect(away.low).toBeLessThan(ceiling);
    expect(away.clipped).toBe(0);
    await face(page, at, jd, 0, sunDeg - 10);
    const toward = await shot(page, sunDeg - 10);
    test.info().annotations.push({ type: 'light', description: JSON.stringify({ toward }) });
    expect(toward.sun?.reach200 ?? 0).toBeLessThan(84);
    // Only the brightest stars by day, under the sunlit ground's glare (or the sky): a dozen lit spots at
    // most. The star light alone lit 312 on the Moon here, some near white, 593 px from the Sun.
    expect(toward.stars).toBeLessThanOrEqual(12);
    expect(toward.clipped).toBeLessThan(0.0005);
    expect(pageErrors).toEqual([]);
  });
}

test('the Moon after sunset: its ground dark, however the eye opens', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  const APOLLO = { world: 'moon', lat: 0.67416, lon: 23.47314 } as const;
  await kf.open('/universe/moon', { query: { jd: JD } });
  await waitForUniverse(page);
  const jd = await stand(page, APOLLO, -3, false, 30, 0.25);
  expect(jd).not.toBeNaN();
  await face(page, APOLLO, jd, 180, -20);
  const s = await shot(page, -20);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ half: s.half, stars: s.stars }) });
  expect(s.half.p99).toBeLessThanOrEqual(20);
  // The stars out over it (no glare held by night): 220 lit spots when measured.
  expect(s.stars).toBeGreaterThan(100);
  expect(pageErrors).toEqual([]);
});

test('a cliff’s shadow: the ground under it lit by a morning Sun, in shadow at the same height in the evening (the terrain’s horizons)', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  // An 800 m cliff running north and south 300 m west of the walker (the ground there 1,000 m high, 1,800 m beyond it).
  const km = 111.32 * Math.cos((SAHARA.lat * Math.PI) / 180);
  await routeTerrain(page, (_lat, lon) => {
    const east = (lon - SAHARA.lon) * km;
    const t = Math.min(1, Math.max(0, (-0.28 - east) / 0.04));
    return 1000 + 800 * t * t * (3 - 2 * t);
  });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const read = async (rising: boolean): Promise<number> => {
    const jd = await stand(page, SAHARA, 10, rising, 1, 1 / 96);
    expect(jd).not.toBeNaN();
    // Facing north, looking 60 degrees down at the ground round the feet, as the eye's meter reads it (before the exposure).
    const before = (await view(page))?.walk?.metered ?? 0;
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25, headingDeg: 0, pitchDeg: -60 });
    });
    await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
    await expect.poll(async () => (await view(page))?.walk?.tiles.loading ?? 1, LIVE).toBe(0);
    await expect.poll(async () => (await view(page))?.walk?.metered ?? 0, LIVE).toBeGreaterThan(before + 1);
    expect((await view(page))?.walk?.groundM).toBeCloseTo(1000, 0);
    return (await view(page))?.walk?.groundLuminance ?? Number.NaN;
  };
  const morning = await read(true);
  const evening = await read(false);
  test.info().annotations.push({ type: 'light', description: JSON.stringify({ morning, evening }) });
  expect(morning).toBeGreaterThan(0);
  // The Sun 10 degrees up behind the cliff's 69 degrees: only the sky's light (less what the cliff hides).
  expect(evening).toBeLessThanOrEqual(0.4 * morning);
  expect(pageErrors).toEqual([]);
});

test('the sea as water: the Sun’s glint on it toward a low Sun, a path of light under the Sun and darker water beside it', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  // The sea floor 50 m down everywhere: the walker stands at sea level, on the water.
  await routeTerrain(page, () => -50);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const jd = await stand(page, SAHARA, 10, true, 1, 1 / 96);
  expect(jd).not.toBeNaN();
  expect((await view(page))?.walk?.groundM).toBeCloseTo(0, 3);
  await face(page, SAHARA, jd, 0, 2);
  const s = await shot(page, 2);
  test.info().annotations.push({ type: 'light', description: JSON.stringify(s.sun) });
  // A bright path under the Sun, the water beside it much darker.
  expect(s.sun?.glint ?? 0).toBeGreaterThan(220);
  expect(s.sun?.beside ?? 255).toBeLessThan(0.6 * (s.sun?.glint ?? 0));
  expect(pageErrors).toEqual([]);
});

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
