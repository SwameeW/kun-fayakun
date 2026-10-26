/**
 * The qibla and the new moon in the browser (src/explore/islamic, src/ui/explore/islamic-panel): the
 * Umm al-Qura date beside the time machine's; the qibla from the point below and from a place found by
 * name, and its path on the globe; the Sun over the Kaaba as moments to go to (where the explorer's own
 * Sun then stands over it); the golden latitude beside the Kaaba's; the new moons and the crescent's
 * map for the evenings after one; and none of it in an experiment. The numbers themselves are checked
 * against published values in tests/unit/islamic.spec.ts. Reduced motion, so flights land at once.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { UniverseIslamic } from '../../src/core/types';
import { centralAngleDeg, KAABA, qiblaBearing } from '../../src/explore/islamic/astronomy';
import { hijriDate } from '../../src/explore/islamic/hijri';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 60_000 * SLOW };
const places = (JSON.parse(readFileSync(new URL('../../public/assets/places/places.json', import.meta.url), 'utf8')) as { places: Array<[string, number, number, number]> }).places;

test.use({ reducedMotion: 'reduce' });

const islamic = async (page: Page): Promise<UniverseIslamic | null> => (await view(page))?.islamic ?? null;
const hudLabels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => l.id));
const utcMs = (iso: string): number => Date.parse(iso);

async function openSection(page: Page): Promise<void> {
  await page.getByTestId('universe-islamic').locator('summary').click();
  await expect(page.getByTestId('islamic-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await islamic(page))?.newMoon?.unixMs ?? 0, LIVE).toBeGreaterThan(0);
}

test('the qibla from the point below and from a place, its path on the globe, and the Sun over the Kaaba as moments to go to', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // The day shown in the Umm al-Qura calendar, beside the time machine's date.
  const shown = (await view(page))?.unixMs ?? 0;
  const hijri = hijriDate(shown);
  expect(hijri).not.toBeNull();
  await expect(page.getByTestId('universe-time-hijri')).toHaveText(new RegExp(`^${String(hijri?.day)} .+ ${String(hijri?.year)} AH \\(Umm al-Qura\\)$`));

  await openSection(page);
  // From the point beneath the camera, its bearing as ./astronomy gives it, shown to a tenth of a degree.
  const below = await islamic(page);
  expect(below?.qibla?.from.name).toBeNull();
  const b = below?.qibla;
  expect(b?.bearingDeg).toBeCloseTo(qiblaBearing(b?.from.lat ?? 0, b?.from.lon ?? 0), 6);
  await expect(page.getByTestId('islamic-qibla')).toContainText(`${(b?.bearingDeg ?? 0).toFixed(1)}° from true north`);

  // From a place found by name.
  const london = places.find((p) => p[0] === 'London') ?? ['London', 51.5, -0.1, 0];
  await page.getByTestId('islamic-find').fill('London');
  await page.getByTestId('islamic-find-results').getByRole('button').first().click();
  await expect.poll(async () => (await islamic(page))?.qibla?.from.name, LIVE).toBe('London');
  const fromLondon = qiblaBearing(london[1], london[2]);
  await expect(page.getByTestId('islamic-qibla')).toContainText(`${fromLondon.toFixed(1)}° from true north (east-southeast)`);
  await expect(page.getByTestId('islamic-qibla-from')).toContainText('From London');

  // Its path on the globe, gathered at both ends, and gone again when switched off.
  await page.getByTestId('islamic-qibla-line').click();
  await expect(page.getByTestId('islamic-qibla-line')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await islamic(page))?.marks.path ?? 0, LIVE).toBeGreaterThan(1000);
  await page.getByTestId('islamic-from-below').click();
  await expect.poll(async () => (await islamic(page))?.qibla?.from.name, LIVE).toBeNull();

  // The next moments the Sun stands over the Kaaba or the point opposite it, after the date shown.
  const suns = (await islamic(page))?.kaabaSun ?? [];
  expect(suns.length).toBe(4);
  expect(suns.every((s) => s.unixMs >= shown - 60_000)).toBe(true);
  expect(new Set(suns.map((s) => s.kind))).toEqual(new Set(['over', 'opposite']));
  await expect(page.getByTestId('islamic-kaaba-sun').getByRole('listitem')).toHaveCount(4);
  // Going to the first moment over the Kaaba: the date set and the clock paused there, and the
  // explorer's own Sun (its bulletin's point beneath the Sun) then stands over the Kaaba.
  const over = suns.find((s) => s.kind === 'over');
  await page.getByTestId('islamic-sun-go-over').first().click();
  await expect.poll(async () => Math.abs(((await view(page))?.unixMs ?? 0) - (over?.unixMs ?? 0)), LIVE).toBeLessThan(2000);
  await expect.poll(async () => (await view(page))?.time.paused, LIVE).toBe(true);
  await expect
    .poll(async () => {
      const sun = (await view(page))?.living?.bulletin?.sun;
      return sun ? centralAngleDeg(sun.lat, sun.lon, KAABA.lat, KAABA.lon) : 180;
    }, LIVE)
    .toBeLessThan(0.5);

  const results = await new AxeBuilder({ page }).include('[data-testid="universe-islamic"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the times of prayer at a place, by each convention and either shadow for Asr', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openSection(page);
  await page.getByTestId('islamic-find').fill('London');
  await page.getByTestId('islamic-find-results').getByRole('button').first().click();
  await expect.poll(async () => (await islamic(page))?.prayer?.times.fajr ?? null, LIVE).not.toBeNull();
  // The Muslim World League's by default: every time that day, in order, each row in words.
  const mwl = (await islamic(page))?.prayer;
  expect(mwl?.convention).toBe('mwl');
  const t = mwl?.times;
  const order = [t?.fajr, t?.sunrise, t?.dhuhr, t?.asr, t?.maghrib, t?.isha];
  for (let k = 1; k < order.length; k += 1) expect(order[k] ?? 0).toBeGreaterThan(order[k - 1] ?? Infinity);
  await expect(page.getByTestId('islamic-prayer-for')).toContainText('At London, on October 23, 2026');
  await expect(page.getByTestId('islamic-prayer')).toContainText('Fajr: the Sun 18° below the horizon');
  await expect(page.getByTestId('islamic-prayer-isha')).toContainText('UTC');

  // Umm al-Qura's: Isha an hour and a half after Maghrib (the date shown is not in Ramadan).
  await page.getByTestId('islamic-convention').selectOption('makkah');
  await expect.poll(async () => (await islamic(page))?.prayer?.convention, LIVE).toBe('makkah');
  const uq = (await islamic(page))?.prayer;
  expect(uq?.ramadan).toBe(false);
  expect(((uq?.times.isha ?? 0) - (uq?.times.maghrib ?? 0)) / 60_000).toBeCloseTo(90, 6);
  await expect(page.getByTestId('islamic-prayer')).toContainText('Isha: 90 minutes after Maghrib');

  // Tehran's: Maghrib once the Sun is 4.5 degrees below the horizon, after sunset.
  await page.getByTestId('islamic-convention').selectOption('tehran');
  await expect.poll(async () => (await islamic(page))?.prayer?.convention, LIVE).toBe('tehran');
  const tehran = (await islamic(page))?.prayer;
  expect(tehran?.times.maghrib ?? 0).toBeGreaterThan(tehran?.times.sunset ?? Infinity);
  await expect(page.getByTestId('islamic-prayer')).toContainText('Maghrib: the Sun 4.5° below the horizon');

  // Asr by two shadow-lengths: later the same afternoon.
  await page.getByTestId('islamic-asr-2').click();
  await expect.poll(async () => (await islamic(page))?.prayer?.asrFactor, LIVE).toBe(2);
  await expect(page.getByTestId('islamic-asr-2')).toHaveAttribute('aria-pressed', 'true');
  expect((await islamic(page))?.prayer?.times.asr ?? 0).toBeGreaterThan(tehran?.times.asr ?? Infinity);

  const results = await new AxeBuilder({ page }).include('[data-testid="universe-islamic"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

/**
 * The Sun's altitude and local apparent time at a place, by the Astronomical Almanac's low-precision
 * formulas (good to about 0.01 degrees, 1950 to 2050): a model independent of the explorer's ephemeris.
 */
function almanacSun(jdUtc: number, latDeg: number, lonDeg: number): { altDeg: number; apparentHours: number } {
  const r = Math.PI / 180;
  const n = jdUtc - 2451545;
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * r;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * r;
  const eps = (23.439 - 0.0000004 * n) * r;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / r;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmstH = 18.697374558 + 24.06570982441908 * n;
  const hour = ((((gmstH * 15 + lonDeg - ra) % 360) + 540) % 360) - 180;
  const phi = latDeg * r;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour * r)) / r;
  return { altDeg: alt, apparentHours: (hour + 180) / 15 };
}

test('an astrolabe for the place: its plate, the rete turned to the time shown, read by the rule, north and south', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openSection(page);
  await page.getByTestId('islamic-find').fill('London');
  await page.getByTestId('islamic-find-results').getByRole('button').first().click();
  const canvas = page.getByTestId('islamic-astrolabe');
  await canvas.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await islamic(page))?.astrolabe?.latDeg ?? 0, LIVE).toBeGreaterThan(51);
  await expect(page.getByTestId('islamic-astrolabe-plate')).toContainText('Plate for 51.5° N', LIVE);
  // At 06:00 UTC on 23 October the Sun has not risen in London: below the horizon, as the almanac has it.
  const a = (await islamic(page))?.astrolabe;
  const sun = almanacSun(Number(JD), a?.latDeg ?? 0, a?.lonDeg ?? 0);
  await expect.poll(async () => Number((await canvas.getAttribute('data-sun-alt')) ?? 99), LIVE).toBeLessThan(0);
  expect(Math.abs(Number(await canvas.getAttribute('data-sun-alt')) - sun.altDeg)).toBeLessThan(0.1);
  await expect(page.getByTestId('islamic-astrolabe-reading')).toContainText('below the horizon');
  // The rule reads the local apparent time: within a minute of the almanac's (the equation of time some 15.6 minutes then).
  const reading = (await page.getByTestId('islamic-astrolabe-reading').textContent()) ?? '';
  const [, hh, mm] = /reads (\d\d):(\d\d)/u.exec(reading) ?? [];
  expect(Math.abs(Number(hh) + Number(mm) / 60 - sun.apparentHours) * 60).toBeLessThan(1.01);
  // The northern plate's stars: the named ones brighter than magnitude 2 north of the Tropic of Capricorn.
  expect(Number(await canvas.getAttribute('data-stars'))).toBeGreaterThanOrEqual(24);
  expect(await canvas.getAttribute('aria-label')).toContain('51.5° N');
  // South of the equator: a plate about the south pole.
  await page.getByTestId('islamic-find').fill('Sydney');
  await page.getByTestId('islamic-find-results').getByRole('button').first().click();
  await expect(page.getByTestId('islamic-astrolabe-plate')).toContainText('° S', LIVE);
  await expect.poll(async () => (await islamic(page))?.astrolabe?.latDeg ?? 0, LIVE).toBeLessThan(-33);
  const south = (await islamic(page))?.astrolabe;
  const there = almanacSun(Number(JD), south?.latDeg ?? 0, south?.lonDeg ?? 0);
  await expect.poll(async () => Math.abs(Number((await canvas.getAttribute('data-sun-alt')) ?? 99) - there.altDeg), LIVE).toBeLessThan(0.1);
  const results = await new AxeBuilder({ page }).include('[data-testid="islamic-panel"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the new moon and the crescent’s map for the evenings after it, read out for the place in view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openSection(page);
  // 23 October 2026: the last new moon (10 October, 15:50 UTC in Espenak's table) is more than three
  // days old, so the next is shown: 9 November, 07:02 UTC. The Moon's age is from the last one.
  const first = await islamic(page);
  const shown = (await view(page))?.unixMs ?? 0;
  expect(Math.abs((first?.newMoon?.unixMs ?? 0) - utcMs('2026-11-09T07:02Z'))).toBeLessThan(120_000);
  expect(Math.abs((first?.newMoon?.ageHours ?? 0) - (shown - utcMs('2026-10-10T15:50Z')) / 3_600_000)).toBeLessThan(0.05);
  await expect(page.getByTestId('islamic-new-moon')).toContainText('November 9, 2026');

  // The evening after it: a full map (every place between 60 S and 60 N, every 2 degrees), with
  // places where the crescent is easily seen, and the legend and the place in view read out.
  await page.getByTestId('islamic-evening-1').click();
  await expect(page.getByTestId('islamic-evening-1')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await islamic(page))?.crescent?.progress ?? 0, LIVE).toBe(1);
  const map1 = (await islamic(page))?.crescent;
  const total = Object.values(map1?.counts ?? {}).reduce((a, n) => a + n, 0);
  expect(total).toBe(61 * 180);
  expect(map1?.counts.A).toBeGreaterThan(0);
  expect((await islamic(page))?.marks.map).toBe(total - (map1?.counts.none ?? 0));
  await expect(page.getByTestId('islamic-legend')).toBeVisible();
  await expect(page.getByTestId('islamic-map-state')).toContainText('Nov 10');
  await expect(page.getByTestId('islamic-here')).toContainText('At the point below you');

  // Odeh's test: the same places recoloured at once (both tests are worked out for each), four zones.
  await page.getByTestId('islamic-criterion-odeh').click();
  await expect.poll(async () => (await islamic(page))?.criterion, LIVE).toBe('odeh');
  await expect(page.getByTestId('islamic-criterion-odeh')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('islamic-criterion-yallop')).toHaveAttribute('aria-pressed', 'false');
  const odeh = (await islamic(page))?.crescent;
  expect(odeh?.progress).toBe(1);
  expect(odeh?.counts.none).toBe(map1?.counts.none);
  expect((odeh?.counts.E ?? 0) + (odeh?.counts.F ?? 0)).toBe(0);
  expect(Object.values(odeh?.counts ?? {}).reduce((a, n) => a + n, 0)).toBe(total);
  expect((await islamic(page))?.marks.map).toBe(total - (map1?.counts.none ?? 0));
  await expect(page.getByTestId('islamic-legend').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('islamic-legend')).toContainText('Only with optical aid (C)');
  await expect(page.getByTestId('islamic-map-note')).toContainText('Odeh’s test');
  await expect(page.getByTestId('islamic-here')).toContainText('At the point below you');
  await page.getByTestId('islamic-criterion-yallop').click();
  await expect.poll(async () => (await islamic(page))?.criterion, LIVE).toBe('yallop');
  await expect(page.getByTestId('islamic-legend').locator('li')).toHaveCount(6);
  expect((await islamic(page))?.crescent?.counts).toEqual(map1?.counts);

  // The new moon's own evening: a younger Moon, fewer places that see it easily.
  await page.getByTestId('islamic-evening-0').click();
  await expect.poll(async () => (await islamic(page))?.crescent?.evening, LIVE).toBe(0);
  await expect.poll(async () => (await islamic(page))?.crescent?.progress ?? 0, LIVE).toBe(1);
  expect((await islamic(page))?.crescent?.counts.A ?? Infinity).toBeLessThan(map1?.counts.A ?? 0);

  // The next new moon and back: 9 December 00:52 and 10 October 15:50 UTC in Espenak's table.
  await page.getByTestId('islamic-moon-next').click();
  await expect.poll(async () => Math.abs(((await islamic(page))?.newMoon?.unixMs ?? 0) - utcMs('2026-12-09T00:52Z')), LIVE).toBeLessThan(120_000);
  for (let k = 0; k < 2; k += 1) await page.getByTestId('islamic-moon-previous').click();
  await expect.poll(async () => Math.abs(((await islamic(page))?.newMoon?.unixMs ?? 0) - utcMs('2026-10-10T15:50Z')), LIVE).toBeLessThan(120_000);

  // The map hidden again by its pressed evening.
  await expect.poll(async () => (await islamic(page))?.crescent?.progress ?? 0, LIVE).toBe(1);
  await page.getByTestId('islamic-evening-0').click();
  await expect.poll(async () => (await islamic(page))?.crescent, LIVE).toBeNull();
  await expect.poll(async () => (await islamic(page))?.marks.map, LIVE).toBe(0);

  const results = await new AxeBuilder({ page }).include('[data-testid="universe-islamic"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the golden latitude beside the Kaaba’s, drawn and named near Makkah; nothing of this over an experiment', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openSection(page);
  const golden = (await islamic(page))?.golden;
  expect(golden?.kaabaRatio).toBeGreaterThan(golden?.ratio ?? Infinity);
  await expect(page.getByTestId('islamic-golden')).toContainText(`${(golden?.kaabaRatio ?? 0).toFixed(4)} times`);
  await expect(page.getByTestId('islamic-golden')).toContainText('not offered as evidence');
  await page.getByTestId('islamic-golden-go').click();
  await expect(page.getByTestId('islamic-golden-line')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await islamic(page))?.marks.lines, LIVE).toBe(2 * 2001);
  await expect.poll(async () => (await view(page))?.travelling, LIVE).toBe(false);
  await expect.poll(async () => { const ids = await hudLabels(page); return ids.includes('golden-latitude') && ids.includes('kaaba-latitude'); }, LIVE).toBe(true);
  // Never framed closer than the explorer's minimum around Makkah (30 km of ground across the view).
  const near = await view(page);
  expect((near?.lens?.metresPerPixel ?? Infinity) * (page.viewportSize()?.width ?? 0)).toBeGreaterThan(29_000);

  // A place of the heritage list: flown to, and the qibla then reckoned from beneath it.
  await page.getByTestId('islamic-heritage-samarkand').click();
  await expect.poll(async () => (await view(page))?.travelling, LIVE).toBe(false);
  await expect
    .poll(async () => {
      const q = (await islamic(page))?.qibla;
      return q && q.from.name === null ? centralAngleDeg(q.from.lat, q.from.lon, 39.674722222222, 67.005555555556) : 180;
    }, LIVE)
    .toBeLessThan(0.5);

  // In an experiment: no section, no Hijri date, nothing of it in the view.
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect(page.getByTestId('universe-islamic')).toBeHidden();
  await expect(page.getByTestId('universe-time-hijri')).toBeHidden();
  await expect.poll(async () => (await view(page))?.islamic, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});
