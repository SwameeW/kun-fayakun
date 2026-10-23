/**
 * The planet textures (public/assets/planets, scripts/planets) through the app's own KTX2 loader
 * on this project's backend: every published file decodes at its size with its whole mip chain
 * and colour space, every map, raw or compressed, puts known places where planets.json says they
 * are (rows stored bottom-up, so v = 0 is the south pole), the ring strip has straight alpha, and
 * every credit shows on the Sources page.
 */
import { readFileSync } from 'node:fs';
import type { PlanetsManifest, PlanetTexture } from '../../src/explore/assets/planets';
import { expect, test, type KfHook } from '../support/fixtures';

const manifest = JSON.parse(readFileSync(new URL('../../public/assets/planets/planets.json', import.meta.url), 'utf8')) as PlanetsManifest & {
  facts: { jupiter: { greatRedSpot: { westLongitudeSystemIII: number; latitudePlanetographic: number } } };
};
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

/** A patch of a map: east longitude and latitude of its centre and its half-size, in degrees. */
interface Probe extends Place {
  radius: number;
  /** Every longitude between lat - radius and lat + radius. */
  band?: boolean;
}

/** Means over a probe's texels: Rec. 709 luma, red minus blue, and the tilt of a normal-mode texel. */
interface ProbeMeans {
  luma: number;
  redness: number;
  tilt: number;
}

/** The Basis Universal transcoder's KTX2 API, as three's KTX2Loader worker calls it. */
interface BasisKtx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, getAlphaForOpaque: number, channel0: number, channel1: number): number;
  close(): void;
  delete(): void;
}
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => BasisKtx2File;
}

const GRS = manifest.facts.jupiter.greatRedSpot;
const GRS_EAST = 360 - GRS.westLongitudeSystemIII;

/**
 * Places on the compressed (etc1s, uastc) maps and what must hold between them: [what, value, the
 * bound it must exceed]. Each check fails under a north-south flip, a mirror in longitude or a
 * half-turn (Saturn's banded map only under a flip), because a swapped place lands on ocean, mare
 * or highland that breaks it.
 */
const COMPRESSED: Record<string, { probes: Probe[]; check: (m: ProbeMeans[]) => [string, number, number] }> = {
  // The Sahara and the Australian interior (whose mirror image is the South Pacific) against the Pacific.
  'earth/day': {
    probes: [{ lon: 10, lat: 23, radius: 2 }, { lon: 133, lat: -25, radius: 2 }, { lon: -150, lat: 0, radius: 3 }],
    check: ([sahara, australia, pacific]) => [
      'darker of the Sahara and the Australian interior / Pacific, luma',
      Math.min(sahara?.luma ?? 0, australia?.luma ?? 0) / Math.max(pacific?.luma ?? 0, 1),
      4,
    ],
  },
  // Himalaya / equatorial Pacific: relief against flat water.
  'earth/normal': {
    probes: [{ lon: 86, lat: 29, radius: 3 }, { lon: -150, lat: 0, radius: 3 }],
    check: ([himalaya, pacific]) => ['Himalaya tilt / Pacific tilt', (himalaya?.tilt ?? 0) / Math.max(pacific?.tilt ?? 0, 0.01), 4],
  },
  // Tycho and Copernicus (whose mirror image is in Mare Tranquillitatis) against Mare Imbrium.
  'moon/colour': {
    probes: [{ lon: -11.36, lat: -43.31, radius: 0.6 }, { lon: -20.08, lat: 9.62, radius: 0.6 }, { lon: -16, lat: 33, radius: 3 }],
    check: ([tycho, copernicus, imbrium]) => [
      'darker of Tycho and Copernicus / Mare Imbrium, luma',
      Math.min(tycho?.luma ?? 0, copernicus?.luma ?? 0) / Math.max(imbrium?.luma ?? 0, 1),
      1.35,
    ],
  },
  // Farside highlands against two smooth maria, Imbrium and Moscoviense (whose mirror image is highland).
  'moon/normal': {
    probes: [{ lon: 160, lat: 10, radius: 4 }, { lon: -20, lat: 30, radius: 2 }, { lon: 147.9, lat: 27.3, radius: 2 }],
    check: ([highlands, imbrium, moscoviense]) => [
      'farside highlands tilt / the rougher of Mare Imbrium and Mare Moscoviense',
      (highlands?.tilt ?? 0) / Math.max(imbrium?.tilt ?? 0, moscoviense?.tilt ?? 0, 0.001),
      2,
    ],
  },
  // The Great Red Spot where planets.json's facts put it, against the same latitude half a turn away.
  'jupiter/colour': {
    probes: [{ lon: GRS_EAST, lat: GRS.latitudePlanetographic, radius: 3 }, { lon: GRS_EAST + 180, lat: GRS.latitudePlanetographic, radius: 3 }],
    check: ([spot, away]) => ['Great Red Spot red - blue, minus the same latitude half a turn away', (spot?.redness ?? 0) - (away?.redness ?? 0), 15],
  },
  // August 2025: the southern high latitudes, leaving winter, were bluer than the northern.
  'saturn/colour': {
    probes: [{ lon: 0, lat: -70, radius: 4, band: true }, { lon: 0, lat: 70, radius: 4, band: true }],
    check: ([south, north]) => ['70 S minus 70 N, blue - red', (north?.redness ?? 0) - (south?.redness ?? 0), 15],
  },
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
          const luma = (uu: number): number => 0.2126 * at(uu, 0, 0) + 0.7152 * at(uu, 0, 1) + 0.0722 * at(uu, 0, 2);
          // Opacity of the B ring and the Cassini Division; colour of the Encke Gap and the A ring either side.
          out = [at(u(107_500), 0, 3), at(u(119_000), 0, 3), at(u(133_590), 0, 3), luma(u(133_590)), (luma(u(133_000)) + luma(u(134_200))) / 2];
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
      const [bRing = 0, cassini = 255, enckeAlpha = 255, enckeLuma = 0, aRingLuma = 0] = sample;
      // The B ring is nearly opaque, the Cassini Division mostly clear.
      expect(bRing, `${entry.path} B ring`).toBeGreaterThan(0.9 * 255);
      expect(cassini, `${entry.path} Cassini Division`).toBeLessThan(0.4 * 255);
      // Straight alpha: the clear Encke Gap keeps the A ring's colour (premultiplied it would be black).
      expect(enckeAlpha, `${entry.path} Encke Gap opacity`).toBeLessThan(0.15 * 255);
      expect(enckeLuma, `${entry.path} Encke Gap colour against the A ring's`).toBeGreaterThan(0.8 * aRingLuma);
      continue;
    }
    if (!check) throw new Error(`no place check for ${entry.map}`);
    const [bright = 0, dark = 0] = sample;
    expect(bright, `${entry.path} ${JSON.stringify(check.bright)}`).toBeGreaterThan(check.minRatio * Math.max(dark, 1));
  }
});

test('compressed maps put the Sahara, Tycho, the Great Red Spot and Saturn\'s seasons where planets.json says', async ({ page, pageErrors }) => {
  test.setTimeout(300_000);
  // The GPU formats KTX2Loader picks (ASTC, BC7, ETC) cannot be read back here, so each file goes
  // through the same Basis transcoder the loader runs (assets/basis), asked for plain RGBA8. Rows
  // come out as stored, so v = 0.5 + latitude / 180 picks the row as it does on the GPU.
  const compressed = files.filter((f): f is PlanetTexture => f.codec === 'etc1s' || f.codec === 'uastc');
  expect(new Set(compressed.map((f) => `${f.body}/${f.map}`))).toEqual(new Set(Object.keys(COMPRESSED)));
  for (const entry of compressed) {
    const spec = COMPRESSED[`${entry.body}/${entry.map}`];
    if (!spec) throw new Error(`no landmark check for ${entry.body}/${entry.map}`);
    const means = await page.evaluate(
      async ({ path, uAtLon0, sign, probes }) => {
        const assets = (window as unknown as KfHook).__kf.app.assets;
        const scope = window as unknown as { BASIS?: (module: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>; kfBasis?: Promise<BasisModule> };
        scope.kfBasis ??= (async () => {
          if (!scope.BASIS) {
            await new Promise<void>((resolve, reject) => {
              const script = document.createElement('script');
              script.src = assets.url('assets/basis/basis_transcoder.js');
              script.onload = () => {
                resolve();
              };
              script.onerror = () => {
                reject(new Error('assets/basis/basis_transcoder.js did not load'));
              };
              document.head.append(script);
            });
          }
          const factory = scope.BASIS;
          if (!factory) throw new Error('basis_transcoder.js defined no BASIS factory');
          const module = await factory({ wasmBinary: await assets.binary('assets/basis/basis_transcoder.wasm') });
          module.initializeBasis();
          return module;
        })();
        const basis = await scope.kfBasis;
        const file = new basis.KTX2File(new Uint8Array(await assets.binary(path)));
        try {
          // TranscoderFormat.RGBA32 in three's KTX2Loader: 8 bits per channel, level 0 only.
          const RGBA32 = 13;
          if (!file.isValid() || !file.startTranscoding()) throw new Error(`${path}: the transcoder rejected the file`);
          const width = file.getWidth();
          const height = file.getHeight();
          const texels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
          if (!file.transcodeImage(texels, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error(`${path}: transcoding failed`);
          return probes.map((p) => {
            // Rows within the probe's latitudes (row k is centred on latitude (k + 0.5) / height * 180 - 90).
            const rows: number[] = [];
            for (let k = 0; k < height; k += 1) if (Math.abs(((k + 0.5) / height) * 180 - 90 - p.lat) <= p.radius) rows.push(k);
            if (rows.length === 0) rows.push(Math.min(height - 1, Math.max(0, Math.floor((0.5 + p.lat / 180) * height))));
            const centre = (((uAtLon0 + (sign * p.lon) / 360) % 1) + 1) % 1;
            const halfU = p.radius / Math.max(Math.cos((p.lat * Math.PI) / 180), 0.05) / 360;
            const cols: number[] = [];
            for (let i = 0; i < width; i += 1) {
              const du = Math.abs(((((i + 0.5) / width - centre + 0.5) % 1) + 1) % 1 - 0.5);
              if (p.band === true || du <= halfU) cols.push(i);
            }
            if (cols.length === 0) cols.push(Math.floor(centre * width) % width);
            let luma = 0;
            let redness = 0;
            let tilt = 0;
            for (const k of rows) {
              for (const i of cols) {
                const at = (k * width + i) * 4;
                const r = texels[at] ?? 0;
                const g = texels[at + 1] ?? 0;
                const b = texels[at + 2] ?? 0;
                const a = texels[at + 3] ?? 0;
                luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                redness += r - b;
                // UASTC normal mode: x in r (and g, b), y in a.
                tilt += Math.hypot((r / 255) * 2 - 1, (a / 255) * 2 - 1);
              }
            }
            const n = rows.length * cols.length;
            return { luma: luma / n, redness: redness / n, tilt: tilt / n };
          });
        } finally {
          file.close();
          file.delete();
        }
      },
      { path: entry.path, uAtLon0: entry.uAtLon0 ?? 0, sign: entry.lonIncreases === 'left' ? -1 : 1, probes: spec.probes },
    );
    const [what, value, bound] = spec.check(means);
    expect(value, `${entry.path}: ${what}`).toBeGreaterThan(bound);
  }
  expect(pageErrors).toEqual([]);
});

test('the Sources page credits every planet source', async ({ page, kf }) => {
  await kf.open('/sources');
  const sourcesPage = page.getByTestId('sources-page');
  await expect(sourcesPage).toBeVisible({ timeout: 30_000 });
  const credits = new Set(manifest.files.flatMap((f) => [f.credit, ...(f.alsoFrom ?? []).map((a) => a.credit)]));
  for (const credit of credits) await expect(sourcesPage.getByText(credit, { exact: true }).first(), credit).toBeVisible();
});
