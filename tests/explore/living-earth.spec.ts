/**
 * The explorer's Living Earth (src/ui/explore/living-earth, src/explore/field-notes, living,
 * earth-tiles), against the mocked live services (tests/support/live): the imagery and the live
 * layers say what they hold; "Today on Earth" names where the Sun is overhead, the space station and
 * the day's strongest earthquake; a found place is flown to and its imagery streamed and credited;
 * the atlas tour moves only when asked; the prophets' list holds the 25 with their honorifics, says
 * "by tradition" and names their places on the globe; and Makkah is never framed closer than a city.
 * Reduced motion, so each flight lands at once.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Kf, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { liveRequests } from '../support/live';
import { view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 60_000 * SLOW };

test.use({ reducedMotion: 'reduce' });

async function openLiving(page: Page, kf: Kf): Promise<Locator> {
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  const living = page.getByTestId('living-earth');
  await living.locator('summary').first().click();
  await expect(living.getByTestId('field-notes')).toBeVisible();
  return living;
}

/** The labels the HUD shows now (ids). */
const hudLabels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => l.id));

/** Ground the view spans top to bottom while the lens is narrowed (km, straight down from its height), or null when it is not. */
const lensWidthKm = async (page: Page): Promise<number | null> => {
  const v = await view(page);
  return v?.lens ? 2 * v.altitudeKm * Math.tan((v.lens.deg * Math.PI) / 360) : null;
};

test('imagery and live layers say what they hold, and Today on Earth names the Sun, the station and the strongest quake', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  const living = await openLiving(page, kf);
  const today = living.getByTestId('living-imagery-today');
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await view(page))?.imagery?.mode).toBe('today');
  await living.getByTestId('living-imagery-clear').click();
  await expect.poll(async () => (await view(page))?.imagery?.mode).toBe('clear');

  await living.getByTestId('living-satellites').click();
  await expect(living.getByTestId('living-satellites')).toHaveAttribute('aria-pressed', 'true');
  await expect(living.getByTestId('living-satellites-status')).toContainText(/5 tracked, \d in sunlight now/, LIVE);
  await living.getByTestId('living-quakes').click();
  await expect(living.getByTestId('living-quakes-status')).toContainText('3 earthquakes of magnitude 2.5 or more in the past day', LIVE);
  const quakes = living.getByTestId('living-quake-list').locator('li');
  await expect(quakes).toHaveCount(3);
  await expect(quakes.first()).toContainText('M6.1 offshore, test region, 3 hours ago');
  expect(liveRequests(page)['celestrak.org']).toBe(1);
  expect(liveRequests(page)['earthquake.usgs.gov']).toBeGreaterThanOrEqual(1);

  await expect(living.getByTestId('field-sun')).toContainText(/The Sun is overhead (near |[\d,.]+\skm from )\S/, LIVE);
  await expect(living.getByTestId('field-station')).toContainText(/The space station is [\d,]+\skm (up|above)/, LIVE);
  await expect(living.getByTestId('field-satellites')).toContainText('Of 5 satellites tracked');
  await expect(living.getByTestId('field-quake')).toContainText('magnitude 6.1, offshore, test region');
  await expect(living.getByTestId('field-dawn')).toContainText(/Dawn is breaking over \S/);
  await expect(living.getByTestId('field-dusk')).toContainText(/The day is ending over \S/);
  // Following the station: it is chosen (its orbit drawn, its height given) and the view goes to it.
  await living.getByTestId('field-station').getByRole('button', { name: 'Go to the International Space Station' }).click();
  await expect(living.getByTestId('living-selected')).toContainText(/^ISS: [\d,]+\skm up, once round every 9\d\smin, in (sunlight|the Earth’s shadow)\./, LIVE);
  await expect.poll(async () => (await hudLabels(page)).some((id) => id.startsWith('satellite-')), LIVE).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('a found place is flown to, its imagery streamed and credited, and the lens and pixel size are given', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  const living = await openLiving(page, kf);
  await living.getByTestId('living-find').fill('tokyo');
  const result = living.getByTestId('living-find-results').getByRole('button', { name: /^Tokyo 35\.7° N, 139\.7° E$/ });
  await expect(result).toBeVisible(LIVE);
  await result.click();
  // Sixty kilometres of ground from the lowest orbit: through the lens.
  await expect.poll(async () => (await lensWidthKm(page)) ?? Infinity, LIVE).toBeLessThan(80);
  expect(await lensWidthKm(page)).toBeGreaterThan(40);
  await expect(page.getByTestId('universe-lens')).toContainText(/^Lens \d+(\.\d)?°: [\d.,]+\s(m|km) a pixel$/);
  await expect.poll(() => liveRequests(page)['tiles.maps.eox.at'], LIVE).toBeGreaterThan(0);
  const tiles = page.getByTestId('universe-tiles');
  await expect(tiles).toContainText('Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)', LIVE);
  await expect(tiles.getByRole('link', { name: 'https://s2maps.eu' })).toHaveAttribute('href', 'https://s2maps.eu');
  expect(liveRequests(page)['gibs.earthdata.nasa.gov']).toBe(0);
  // Nothing a search cannot find is offered.
  await living.getByTestId('living-find').fill('qqqqzz');
  await expect(living.getByText('No place of that name in the list.')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('the atlas tour moves only when asked, names its places on the globe and ends where it was begun', async ({ page, kf, pageErrors }) => {
  // Streaming each place's imagery in software rendering (CI) takes nearly eight minutes.
  test.setTimeout(240_000 * SLOW);
  const living = await openLiving(page, kf);
  const start = living.getByTestId('field-atlas-tour');
  await start.click();
  const tour = living.getByTestId('field-tour');
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('The Richat Structure, Mauritania');
  await expect(tour).toContainText('1 of 23');
  await expect(living.getByTestId('field-tour-previous')).toBeDisabled();
  await expect.poll(async () => (await hudLabels(page)).includes('field-richat'), LIVE).toBe(true);
  await living.getByTestId('field-tour-next').click();
  await expect(tour).toContainText('The Strait of Gibraltar');
  await expect(tour).toContainText('2 of 23');
  await living.getByTestId('field-tour-previous').click();
  await expect(tour).toContainText('1 of 23');
  await living.getByTestId('field-tour-stop').click();
  await expect(tour).toBeHidden();
  await expect(start).toBeFocused();
  await expect.poll(async () => (await hudLabels(page)).some((id) => id.startsWith('field-')), LIVE).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('the prophets’ lands: the 25 with their honorifics, by tradition, named on the globe, and Makkah framed as a city', async ({ page, kf, pageErrors }) => {
  // As the tour: nearly eight minutes in software rendering (CI), most of it streaming Makkah's imagery.
  test.setTimeout(240_000 * SLOW);
  const living = await openLiving(page, kf);
  const prophets = living.getByTestId('field-prophets');
  await prophets.locator('summary').click();
  const entries = prophets.locator('.kf-living-prophet');
  await expect(entries).toHaveCount(25);
  await expect(entries.first()).toContainText('Adam, peace be upon him');
  await expect(entries.nth(5)).toContainText('Ibrahim (Abraham), peace be upon him');
  await expect(entries.last()).toContainText('Muhammad ﷺ');
  await expect(prophets).toContainText('Peace be upon them all.');
  await expect(prophets).toContainText('it is not evidence of an event');
  await expect(entries.nth(1)).toContainText('No place is marked.');
  await expect(entries.nth(2).getByRole('button', { name: 'Go to Mount Judi' })).toBeVisible();

  // The prophets' places are named on the globe while the list is open.
  await entries.last().getByRole('button', { name: 'Go to Makkah' }).click();
  await expect.poll(async () => (await hudLabels(page)).includes('field-mecca'), LIVE).toBe(true);
  // However it is asked for, Makkah is framed at least 30 km across: the city in its valley.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'goto', lat: 21.4225, lon: 39.8261, viewKm: 1 });
  });
  await expect.poll(async () => (await lensWidthKm(page)) ?? Infinity, LIVE).toBeLessThan(45);
  expect(await lensWidthKm(page)).toBeGreaterThan(29);
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -1200);
  await page.waitForTimeout(1500);
  expect(await lensWidthKm(page)).toBeGreaterThan(29);

  await prophets.locator('summary').click();
  await expect.poll(async () => (await hudLabels(page)).includes('field-mecca'), LIVE).toBe(false);
  await prophets.locator('summary').click();
  const results = await new AxeBuilder({ page }).include('[data-testid="living-earth"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
