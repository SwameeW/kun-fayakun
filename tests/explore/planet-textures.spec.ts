/**
 * The planet textures (public/assets/planets, scripts/planets) through the app's own KTX2 loader
 * on this project's backend: every published file decodes at its size with its whole mip chain
 * and colour space, the raw maps put known places where planets.json says they are (rows stored
 * bottom-up, so v = 0 is the south pole), and every credit shows on the Sources page.
 */
import { readFileSync } from 'node:fs';
import type { PlanetsManifest, PlanetTexture } from '../../src/explore/assets/planets';
import { expect, test, type KfHook } from '../support/fixtures';

const manifest = JSON.parse(readFileSync(new URL('../../public/assets/planets/planets.json', import.meta.url), 'utf8')) as PlanetsManifest;
const files = [...new Map(manifest.files.map((f) => [f.path, f])).values()];

interface Place {
  lon: number;
  lat: number;
}

/** Places sampled on the raw (r8, rgba8) maps; each pair swaps under a flip or a half-turn. */
const CHECKS: Record<string, { bright: Place; dark: Place; minRatio: number }> = {
  night: { bright: { lon: 139.7, lat: 35.75 }, dark: { lon: 10, lat: 23 }, minRatio: 20 }, // Tokyo / Sahara
  water: { bright: { lon: -150, lat: 0 }, dark: { lon: 10, lat: 23 }, minRatio: 50 }, // Pacific / Sahara
  clouds: { bright: { lon: 90, lat: -55 }, dark: { lon: 10, lat: 23 }, minRatio: 3 }, // Southern Ocean / Sahara
};

test.beforeEach(async ({ page, kf }) => {
  await kf.open('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
});

test('every published planet texture decodes through the app loader with its size, mips and colour space', async ({ page, pageErrors }) => {
  test.setTimeout(300_000);
  for (const entry of files) {
    const got = await page.evaluate(async (path) => {
      const texture = await (window as unknown as KfHook).__kf.app.assets.ktx2(path);
      const image = texture.image as { width: number; height: number };
      const result = { width: image.width, height: image.height, levels: texture.mipmaps.length, colorSpace: texture.colorSpace };
      texture.dispose();
      return result;
    }, entry.path);
    expect([got.width, got.height, got.levels], entry.path).toEqual([entry.width, entry.height, entry.levels]);
    if (entry.colorSpace === 'srgb') expect(got.colorSpace, entry.path).toBe('srgb');
    else expect(['', 'srgb-linear'], entry.path).toContain(got.colorSpace);
  }
  expect(pageErrors).toEqual([]);
});

test('raw maps put the Earth and the rings where planets.json says they are', async ({ page }) => {
  test.setTimeout(180_000);
  const raw = files.filter((f): f is PlanetTexture => f.codec === 'r8' || f.codec === 'rgba8');
  expect(raw.length).toBeGreaterThan(0);
  for (const entry of raw) {
    const check = CHECKS[entry.map];
    const sample = await page.evaluate(
      async ({ path, uAtLon0, places, rings }) => {
        const texture = await (window as unknown as KfHook).__kf.app.assets.ktx2(path);
        const level = texture.mipmaps[0] as { data: Uint8Array; width: number; height: number };
        const channels = level.data.length / (level.width * level.height);
        // Mean of the channel over a 3 x 3 texel patch; v = 0 is the first stored row (the south pole).
        const at = (u: number, v: number, channel: number): number => {
          const cx = Math.floor((((u % 1) + 1) % 1) * level.width);
          const cy = Math.min(level.height - 1, Math.max(0, Math.floor(v * level.height)));
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const y = Math.min(level.height - 1, Math.max(0, cy + dy));
              const x = (cx + dx + level.width) % level.width;
              sum += level.data[(y * level.width + x) * channels + channel] ?? 0;
              n += 1;
            }
          }
          return sum / n;
        };
        let out: number[];
        if (rings) {
          const u = (km: number): number => (km - rings[0]) / (rings[1] - rings[0]);
          out = [at(u(107_500), 0, 3), at(u(119_000), 0, 3)];
        } else {
          out = places.map((p) => at(uAtLon0 + p.lon / 360, 0.5 + p.lat / 180, 0));
        }
        texture.dispose();
        return out;
      },
      {
        path: entry.path,
        uAtLon0: entry.uAtLon0 ?? 0,
        places: check ? [check.bright, check.dark] : [],
        rings: entry.radiusKm ?? null,
      },
    );
    if (entry.map === 'rings') {
      // The B ring is nearly opaque, the Cassini Division mostly clear.
      expect(sample[0], `${entry.path} B ring`).toBeGreaterThan(0.9 * 255);
      expect(sample[1], `${entry.path} Cassini Division`).toBeLessThan(0.4 * 255);
      continue;
    }
    if (!check) throw new Error(`no place check for ${entry.map}`);
    const [bright = 0, dark = 0] = sample;
    expect(bright, `${entry.path} ${JSON.stringify(check.bright)}`).toBeGreaterThan(check.minRatio * Math.max(dark, 1));
  }
});

test('the Sources page credits every planet source', async ({ page, kf }) => {
  await kf.open('/sources');
  const sourcesPage = page.getByTestId('sources-page');
  await expect(sourcesPage).toBeVisible({ timeout: 30_000 });
  const credits = new Set(manifest.files.flatMap((f) => [f.credit, ...(f.alsoFrom ?? []).map((a) => a.credit)]));
  for (const credit of credits) await expect(sourcesPage.getByText(credit, { exact: true }).first(), credit).toBeVisible();
});
