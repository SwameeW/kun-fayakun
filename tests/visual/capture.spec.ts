/**
 * Before/after captures for visual work: every shot of the film and a fixed set of the explorer's
 * views (the Earth at several lights and heights, descents to the ground on foot, the other worlds),
 * each on the manual clock (__kf.step) so two runs show the same instant from the same camera, with
 * the GPU's time on that frame measured (?profile=1, timestamp queries). Never part of a normal run:
 *
 *   KF_VISUAL=1 KF_VISUAL_OUT=<dir> [KF_VISUAL_ONLY=ch03,explore-earth] npx playwright test --project=visual
 *
 * Writes <dir>/<name>.png and a line per view to <dir>/metrics.jsonl: its median frame time with frames
 * uncapped (what the view costs), the slowest frame, the timestamp queries' GPU time and draw calls. Run on a GPU machine. The visual project's forceWebGL option draws with WebGL2.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { FrameStats } from '../../src/core/perf';
import type { ChapterId, UniversePose } from '../../src/core/types';
import { env } from '../support/env';
import { test, type KfHook } from '../support/fixtures';

const OUT = env('KF_VISUAL_OUT') ?? 'test-results/visual';
const ONLY = env('KF_VISUAL_ONLY')?.split(',') ?? null;
/** The date every explorer view is drawn at: 2026-10-23 06:00 UT (the specs' JD), the Sun over the Indian Ocean. */
const JD = '2461336.75';
const QUERY = { tier: 'high', detail: 'high', profile: '1' };
const EARTH_KM = 6371;

const wanted = (name: string): boolean => ONLY === null || ONLY.some((o) => name.startsWith(o));

/** The GPU's time on the frame now on screen: frames keep rendering on the manual clock, the scene held still. */
async function shoot(page: Page, name: string, note: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.resetFrameStats();
  });
  await page.waitForTimeout(1500);
  const s = (await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats())) as unknown as FrameStats;
  // Frames are uncapped in the visual project: the median frame is the view's cost (the GPU's or the CPU's, whichever is slower).
  const line = { name, note, frameMs: s.medianFps > 0 ? 1000 / s.medianFps : 0, p99FrameMs: s.p99FrameMs, gpuMedianMs: s.gpuMedianMs, drawCalls: s.drawCalls, pixelRatio: s.pixelRatio };
  appendFileSync(join(OUT, 'metrics.jsonl'), `${JSON.stringify(line)}\n`);
}

interface Shot {
  chapter: string;
  start: number;
  duration: number;
  subject: string;
}
function shots(): Shot[] {
  const list: Shot[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      const s = o as Partial<Shot>;
      if (typeof s.chapter === 'string' && typeof s.start === 'number' && typeof s.subject === 'string') list.push(s as Shot);
      else Object.values(o).forEach(walk);
    }
  };
  walk(JSON.parse(readFileSync('film/shotlist.json', 'utf8')));
  return list;
}

const VIEWS: Array<{ name: string; pose: UniversePose; note: string }> = [
  { name: 'earth-disc-day', pose: { body: 'earth', distanceKm: 45_000, azimuthDeg: 0, elevationDeg: 15 }, note: 'whole Earth by day' },
  { name: 'earth-disc-quarter', pose: { body: 'earth', distanceKm: 45_000, azimuthDeg: 75, elevationDeg: 10 }, note: 'terminator across the disc' },
  { name: 'earth-disc-crescent', pose: { body: 'earth', distanceKm: 45_000, azimuthDeg: 145, elevationDeg: 5 }, note: 'crescent, forward scattering' },
  { name: 'earth-night', pose: { body: 'earth', distanceKm: 30_000, azimuthDeg: 180, elevationDeg: 20 }, note: 'night side, city lights' },
  { name: 'earth-moon', pose: { body: 'earth', distanceKm: 30_000, azimuthDeg: 20, elevationDeg: 10, from: 'moon' }, note: 'the Earth with the Moon behind' },
  { name: 'earth-12000-day', pose: { body: 'earth', distanceKm: 12_000, azimuthDeg: 30, elevationDeg: 35 }, note: 'limb by day' },
  { name: 'earth-9000-dusk', pose: { body: 'earth', distanceKm: 9_000, azimuthDeg: 85, elevationDeg: 0 }, note: 'terminator, the air lit from below' },
  { name: 'earth-8000-glint', pose: { body: 'earth', distanceKm: 8_000, azimuthDeg: 0, elevationDeg: 0 }, note: 'sunglint on the Indian Ocean' },
  { name: 'earth-asia-500', pose: { body: 'earth', distanceKm: EARTH_KM + 500, azimuthDeg: -5, elevationDeg: 40 }, note: '500 km over South Asia' },
  { name: 'earth-asia-60', pose: { body: 'earth', distanceKm: EARTH_KM + 60, azimuthDeg: -5, elevationDeg: 40 }, note: '60 km' },
  { name: 'earth-asia-12', pose: { body: 'earth', distanceKm: EARTH_KM + 12, azimuthDeg: -5, elevationDeg: 40 }, note: '12 km' },
  { name: 'earth-300-dusk', pose: { body: 'earth', distanceKm: EARTH_KM + 300, azimuthDeg: 80, elevationDeg: 20 }, note: '300 km at dusk' },
  { name: 'moon-quarter', pose: { body: 'moon', distanceKm: 1737 + 6000, azimuthDeg: 70, elevationDeg: 10 }, note: 'the Moon, a quarter lit' },
  { name: 'mars-day', pose: { body: 'mars', distanceKm: 3390 + 12_000, azimuthDeg: 25, elevationDeg: 15 }, note: 'Mars by day' },
  { name: 'jupiter', pose: { body: 'jupiter', distanceKm: 71_492 * 3.2, azimuthDeg: 30, elevationDeg: 10 }, note: 'Jupiter' },
  { name: 'saturn', pose: { body: 'saturn', distanceKm: 60_268 * 4.5, azimuthDeg: 30, elevationDeg: 20 }, note: 'Saturn and its rings' },
  { name: 'sun', pose: { body: 'sun', distanceKm: 696_000 * 4, azimuthDeg: 0, elevationDeg: 0, from: 'earth' }, note: 'the Sun' },
];

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
mkdirSync(OUT, { recursive: true });

/**
 * The Earth's streamed imagery (Sentinel-2 cloudless, NASA's daily mosaic) and heights come from the
 * real hosts, as a visitor's do: close up they are most of the picture. The other live services (the
 * satellites' elements, the earthquakes) keep their canned answers, so the views stay the same run to run.
 */
const MAP_HOSTS = ['tiles.maps.eox.at', 'gibs.earthdata.nasa.gov', 's3.amazonaws.com'];
test.beforeEach(async ({ page }) => {
  await page.route((url) => MAP_HOSTS.includes(url.hostname), (route) => route.continue());
});

/** Every shot of the film: once at its middle, or at a third and two thirds when it is longer than 40 s. */
test('the film, shot by shot', async ({ page, kf }) => {
  test.setTimeout(60 * 60_000);
  const byChapter = new Map<string, Shot[]>();
  for (const s of shots()) byChapter.set(s.chapter, [...(byChapter.get(s.chapter) ?? []), s]);
  for (const [chapter, list] of byChapter) {
    if (!wanted(chapter)) continue;
    // A new document for each chapter: the manual clock holds for the rest of a page's life, and a chapter loads on the real one.
    await page.goto('about:blank');
    await kf.openChapter(chapter as ChapterId, { autoplay: true, query: QUERY });
    await page.evaluate(() => {
      const kfHook = (window as unknown as KfHook).__kf;
      if (kfHook.app.paused) kfHook.app.play();
      kfHook.step();
      for (let i = 0; i < 200 && kfHook.app.state !== 'playing'; i += 1) kfHook.step(10, 0.1);
    });
    // The scene at the stage's full width: the notes folded away, as a visitor can.
    if (await page.locator('html.kf-panel-open').count()) await page.getByTestId('panel-toggle').click();
    for (const [k, s] of list.entries()) {
      const at = s.duration > 40 ? [s.start + s.duration / 3, s.start + (2 * s.duration) / 3] : [s.start + s.duration / 2];
      for (const t of at) {
        // A second of the film played into the instant, the same second on every run.
        await page.evaluate((time) => {
          const kfHook = (window as unknown as KfHook).__kf;
          kfHook.app.seek(Math.max(0, time - 1));
          kfHook.step(60, 1 / 60);
        }, t);
        await page.waitForTimeout(300);
        await shoot(page, `${chapter}-${String(k + 1).padStart(2, '0')}-${t.toFixed(1)}s`, s.subject);
      }
    }
  }
});

async function openExplorer(page: Page, kf: { open(route: string, options?: { query?: Record<string, string> }): Promise<void> }): Promise<void> {
  await kf.open('/universe/earth', { query: { ...QUERY, jd: JD } });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-universe-ready') === 'true', null, { timeout: 120_000 });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.step();
  });
}

/**
 * Places the camera, plays three seconds (the fades and the eye's adaptation run on the held clock),
 * lets the maps for that place arrive in real time, then plays two more as they sharpen in.
 */
async function settle(page: Page, pose: UniversePose): Promise<void> {
  await page.evaluate((p) => {
    const kfHook = (window as unknown as KfHook).__kf;
    kfHook.universe.place(p);
    kfHook.step(180, 1 / 60);
  }, pose);
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.step(120, 1 / 60);
  });
}

test('the explorer: the Earth at several lights and heights, and the other worlds', async ({ page, kf }) => {
  test.setTimeout(30 * 60_000);
  const views = VIEWS.filter((v) => wanted(`explore-${v.name}`));
  test.skip(!views.length, 'none asked for');
  await openExplorer(page, kf);
  // Photo mode: only the view.
  await page.keyboard.press('h');
  for (const v of views) {
    await settle(page, v.pose);
    await shoot(page, `explore-${v.name}`, v.note);
  }
});

/**
 * A walk asked for from 45,000 km (the explorer's own command): frames every fifth of a second of the way
 * down, and the ground once on foot. By day below Everest at local noon, looking at it; at dusk in the
 * Hooker Valley under Aoraki, the Sun about 15 degrees up in the west, looking toward it.
 */
for (const [name, walk] of [
  ['descent-day', { lat: 27.98, lon: 86.83, headingDeg: 80, pitchDeg: 8 }],
  ['descent-dusk', { lat: -43.7, lon: 170.1, headingDeg: 280, pitchDeg: 3 }],
] as const) {
  test(`${name}: from orbit to the ground on foot`, async ({ page, kf }) => {
    test.setTimeout(15 * 60_000);
    test.skip(!wanted(name), 'not asked for');
    await openExplorer(page, kf);
    await settle(page, { body: 'earth', distanceKm: 45_000, azimuthDeg: 0, elevationDeg: 15 });
    await page.evaluate((w) => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', world: 'earth', ...w });
    }, walk);
    for (let k = 0; k < 60; k += 1) {
      const state = await page.evaluate(() => {
        const kfHook = (window as unknown as KfHook).__kf;
        kfHook.step(12, 1 / 60);
        const v = kfHook.universe.state();
        return { walk: v?.walk?.state ?? null, km: v?.altitudeKm ?? 0 };
      });
      // Low down the ground's own tiles arrive: give them time.
      await page.waitForTimeout(state.km < 50 ? 2500 : 600);
      await shoot(page, `${name}-${String(k).padStart(2, '0')}`, `${state.walk ?? 'descending'}, ${state.km.toFixed(state.km < 10 ? 3 : 0)} km`);
      if (state.walk === 'walking') break;
    }
    // On foot: five seconds for the eye to adapt to the ground's light and for its finer heights and imagery.
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.step(300, 1 / 60);
    });
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.step(60, 1 / 60);
    });
    await shoot(page, `${name}-ground`, 'on foot, five seconds after landing');
  });
}
