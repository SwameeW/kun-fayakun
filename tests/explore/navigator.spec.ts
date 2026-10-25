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
import { SLOW } from '../support/env';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test('every world is listed with its distance and light-time, live from the ephemeris', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  for (const name of ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
  const row = (body: string) => nav.locator(`.kf-nav-row[data-body="${body}"]`);
  // The Sun is about 1 au away, its light about 8 minutes old; Saturn's over an hour.
  await expect(row('sun')).toContainText(/0\.9\d\sAU|1\.0\d\sAU/);
  await expect(row('sun')).toContainText(/light 8\smin/);
  await expect(row('saturn')).toContainText(/light 1\sh/);
  await expect(nav.getByRole('button', { name: 'Earth', exact: true })).toHaveAttribute('aria-current', 'true');
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
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  await nav.getByRole('button', { name: 'Jupiter', exact: true }).click();
  await expect.poll(async () => (await view(page))?.travelling).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'flying');
  await expect(nav.getByRole('button', { name: 'Jupiter', exact: true })).toHaveAttribute('aria-current', 'true');
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
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await place(page, { body: 'saturn', distanceKm: 400_000, azimuthDeg: 25, elevationDeg: 10 });
  await step(page, 90);
  const note = page.getByTestId('universe-note');
  await expect(note).toContainText(/Saturn’s rings/);
  // The rings' span from the Cassini profile, and the source named.
  await expect(note).toContainText(/74,500\skm to 137,000\skm/);
  await expect(note).toContainText(/Cassini/);
  await place(page, { body: 'earth', distanceKm: 6378 + 900, azimuthDeg: 60, elevationDeg: 5 });
  await step(page, 90);
  await expect(note).toContainText(/Earth’s atmosphere/);
  await expect(note).toContainText(/8\.5\skm/);
  const seen = page.getByTestId('universe-seen');
  await seen.locator('summary').click();
  await expect(seen).toContainText('Saturn’s rings in sunlight');
  await expect(seen).toContainText('Earth’s atmosphere, edge on');
  // Once each, and no score or count anywhere.
  expect(await seen.locator('li').count()).toBe(new Set(await seen.locator('li').allTextContents()).size);
  await expect(seen).not.toContainText(/\d+\s*\/\s*\d+|score|points/i);
  expect(pageErrors).toEqual([]);
});

test('something seen for the first time gets a quiet toast, and the log says how many entries it holds (no totals)', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  await place(page, { body: 'saturn', distanceKm: 400_000, azimuthDeg: 25, elevationDeg: 10 });
  await step(page, 30);
  const toast = page.getByTestId('universe-toast');
  // A polite live region, there from the start; it never takes focus.
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  await expect(toast).toContainText('Saturn’s rings in sunlight');
  await expect(toast).toContainText('Added to Seen on this visit');
  const summary = page.getByTestId('universe-seen').locator('summary');
  await expect(summary).toContainText(/Seen on this visit \(\d+\)/);
  await expect(summary).not.toContainText(/\/|of \d/);
  expect(pageErrors).toEqual([]);
});

test('a note and the trip indicator share their place but never show at once (no ghost text), and have the same width', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await expect(page.locator('.kf-note.is-visible')).toBeVisible({ timeout: 20_000 });
  await settled(page, ['universe-readout']);
  // Sample both cards' opacity on every frame from the moment a trip starts, through its arrival.
  const worst = await page.evaluate(async () => {
    const kf = (window as unknown as KfHook).__kf;
    const slot = document.querySelector<HTMLElement>('[data-testid="universe-note"]');
    const trip = document.querySelector<HTMLElement>('[data-testid="universe-trip"]');
    if (!slot || !trip) return { both: 1, widths: [0, 0] };
    const noteOpacity = (): number => {
      const card = slot.querySelector<HTMLElement>('.kf-note');
      if (!card || getComputedStyle(slot).visibility === 'hidden') return 0;
      return Number(getComputedStyle(slot).opacity) * Number(getComputedStyle(card).opacity);
    };
    const tripOpacity = (): number => (getComputedStyle(trip).visibility === 'hidden' ? 0 : Number(getComputedStyle(trip).opacity));
    const widths = [slot.getBoundingClientRect().width, trip.getBoundingClientRect().width];
    kf.app.focusBody('moon');
    let both = 0;
    const until = performance.now() + 9000;
    while (performance.now() < until) {
      await new Promise((r) => requestAnimationFrame(r));
      both = Math.max(both, Math.min(noteOpacity(), tripOpacity()));
    }
    return { both, widths };
  });
  expect(worst.both).toBeLessThan(0.05);
  expect(Math.abs((worst.widths[0] ?? 0) - (worst.widths[1] ?? 0))).toBeLessThan(2);
  expect(pageErrors).toEqual([]);
});

test('names beside the worlds stay inside the view (never cut off at its edge or under the interface)', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  const poses = [
    { body: 'earth', distanceKm: 26_000 },
    { body: 'moon', distanceKm: 7_000, azimuthDeg: 70 },
    { body: 'moon', distanceKm: 90_000, from: 'earth', azimuthDeg: 30 },
    { body: 'jupiter', distanceKm: 3e6, azimuthDeg: -50, elevationDeg: 20 },
    { body: 'sun', distanceKm: 4e7, azimuthDeg: 40 },
  ] as const;
  for (const pose of poses) {
    await place(page, pose);
    await step(page, 60);
    const outside = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')]
        .filter((t) => Number(t.style.opacity || '1') > 0.05)
        .map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight)
        .map(({ text, r }) => `${text} ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`),
    );
    expect(outside, JSON.stringify(pose)).toEqual([]);
  }
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
