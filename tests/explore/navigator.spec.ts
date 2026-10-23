/**
 * The explorer's celestial navigator and its notes (src/ui/explore): every world listed with a live
 * distance and light-time; a choice from the list, the keyboard or the orrery flies there and the
 * address follows; the panel folds and unfolds without losing focus; notes about what is near carry
 * numbers from cited data and name their sources; the log lists what was seen; and axe finds
 * nothing to fix on the navigator or the heads-up readout.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type KfHook } from '../support/fixtures';
import { JD, place, settled, step, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test('every world is listed with its distance and light-time, live from the ephemeris', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  for (const name of ['Sun', 'Earth', 'Moon', 'Jupiter', 'Saturn']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
  const row = (body: string) => nav.locator(`.kf-nav-row[data-body="${body}"]`);
  // The Sun is about 1 au away, its light about 8 minutes old; Saturn's over an hour.
  await expect(row('sun')).toContainText(/0\.9\d AU|1\.0\d AU/);
  await expect(row('sun')).toContainText(/light 8 min/);
  await expect(row('saturn')).toContainText(/light 1 h/);
  await expect(nav.getByRole('button', { name: 'Earth', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Moving the camera changes the numbers.
  await step(page, 1);
  await place(page, { body: 'earth', distanceKm: 30_000 });
  await step(page, 20);
  const near = await row('earth').locator('.kf-nav-distance').textContent();
  await place(page, { body: 'earth', distanceKm: 300_000 });
  await step(page, 20);
  await expect(row('earth').locator('.kf-nav-distance')).not.toHaveText(near ?? '');
  expect(pageErrors).toEqual([]);
});

test('a choice from the list, by mouse or keyboard, flies there and the address follows', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  await nav.getByRole('button', { name: 'Jupiter', exact: true }).click();
  await expect.poll(async () => (await view(page))?.travelling).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'flying');
  await expect(nav.getByRole('button', { name: 'Jupiter', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/#\/universe\/jupiter/);
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'arrived', { timeout: 30_000 });
  // The keyboard: focus the Moon's button and press Enter.
  await nav.getByRole('button', { name: 'Moon', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await view(page))?.focus).toBe('moon');
  await expect(page).toHaveURL(/#\/universe\/moon/);
  expect(pageErrors).toEqual([]);
});

test('the orrery flies to the world tapped on it', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const saturn = page.locator('.kf-orrery-body--saturn');
  await expect(saturn).toBeVisible();
  await saturn.click();
  await expect.poll(async () => (await view(page))?.focus).toBe('saturn');
  expect((await view(page))?.travelling).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('the panel folds to a rail of portraits and unfolds, focus staying on its toggle', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const toggle = page.getByTestId('universe-nav-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.kf-nav-map')).toBeHidden();
  // Folded, the worlds are still there (as portraits), and still fly.
  await expect(page.getByRole('button', { name: 'Moon', exact: true })).toBeVisible();
  await expect(toggle).toBeFocused();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.kf-nav-map')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('near a world a note gives facts from cited data, and the log lists what was seen, once each', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000);
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await place(page, { body: 'saturn', distanceKm: 400_000, azimuthDeg: 25, elevationDeg: 10 });
  await step(page, 90);
  const note = page.getByTestId('universe-note');
  await expect(note).toContainText(/Saturn’s rings/);
  // The rings' span from the Cassini profile, and the source named.
  await expect(note).toContainText(/74,500 km to 137,000 km/);
  await expect(note).toContainText(/Cassini/);
  await place(page, { body: 'earth', distanceKm: 6378 + 900, azimuthDeg: 60, elevationDeg: 5 });
  await step(page, 90);
  await expect(note).toContainText(/Earth’s atmosphere/);
  await expect(note).toContainText(/8\.5 km/);
  const seen = page.getByTestId('universe-seen');
  await seen.locator('summary').click();
  await expect(seen).toContainText('Saturn’s rings in sunlight');
  await expect(seen).toContainText('Earth’s atmosphere, edge on');
  // Once each, and no score or count anywhere.
  expect(await seen.locator('li').count()).toBe(new Set(await seen.locator('li').allTextContents()).size);
  await expect(seen).not.toContainText(/\d+\s*\/\s*\d+|score|points/i);
  expect(pageErrors).toEqual([]);
});

test('axe finds nothing to fix on the navigator and the heads-up readout', async ({ page, kf }, testInfo) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await settled(page, ['universe-readout', 'universe-bodies']);
  await page.getByTestId('universe-detail').click();
  const results = await new AxeBuilder({ page }).include('[data-testid="universe"]').withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-navigator.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  expect(results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
  // And with a trip under way (the trip indicator showing).
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.focusBody('moon');
  });
  await expect(page.getByTestId('universe-trip')).toHaveClass(/is-active/);
  await settled(page, ['universe-trip']);
  const during = await new AxeBuilder({ page }).include('[data-testid="universe"]').withTags(WCAG_TAGS).analyze();
  expect(during.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
});
