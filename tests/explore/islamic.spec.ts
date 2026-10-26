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
