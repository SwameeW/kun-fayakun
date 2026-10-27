/**
 * The explorer's celestial navigator and its notes (src/ui/explore): every world listed with a live
 * distance and light-time; a choice from the list, the keyboard or the orrery flies there and the
 * address follows; the panel folds and unfolds without losing focus; notes about what is near carry
 * numbers from cited data and name their sources; the log lists what was seen; and axe finds
 * nothing to fix on the navigator or the heads-up readout. Folded in an experiment or among the
 * stars, only their worlds stay, within the window however short; the body fades where it scrolls on;
 * a panel entered from the foot shows from its top; names and their pointers keep clear of the
 * interface over the view, on a desktop and on a phone held either way; the laboratory's names and
 * marks, the chosen body's too, keep off the worlds' discs, the interface and one another; and the
 * parts that are chunks of their own load once, and say so (with a way to try again) when their code
 * does not come, styled when it does (the laboratory's, the qibla's, the stars' panels; an explanation's
 * popover, whose failure the toast reports).
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { frames, spam } from '../support/layout';
import { JD, place, recordToasts, settled, step, toasts, view, waitForUniverse } from '../support/universe';
import { SLOW } from '../support/env';

const LIVE = { timeout: 60_000 * SLOW };
/** The navigator's box, and its scrolling body's. */
const navBox = (page: Page) => page.getByTestId('universe-bodies').evaluate((nav) => {
  const r = nav.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom, viewport: window.innerHeight };
});
/** The worlds' rows (portraits when folded) on show. */
const shownRows = (page: Page): Promise<string[]> => page.locator('.kf-nav-row').evaluateAll((rows) => rows.filter((r) => (r as HTMLElement).offsetParent !== null).map((r) => r.getAttribute('data-body') ?? ''));
const lab = (page: Page) => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.lab ?? null);

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
  await recordToasts(page);
  await place(page, { body: 'saturn', distanceKm: 400_000, azimuthDeg: 25, elevationDeg: 10 });
  await step(page, 30);
  const toast = page.getByTestId('universe-toast');
  // A polite live region, there from the start; it never takes focus.
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  // Its title and line together: what it showed (it is gone again after a few seconds, and a slow
  // machine's look could fall either side of its end).
  await expect.poll(() => toasts(page), { timeout: 60_000 * SLOW }).toMatch(/Saturn’s rings in sunlight[\s\S]*Added to Seen on this visit/);
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

test('folded in an experiment or among the stars, the rail holds only their worlds, fits the window, and unfolds as it was', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const toggle = page.getByTestId('universe-nav-toggle');
  // The plain rail, for comparison: the toggle and ten portraits.
  await toggle.click();
  const plain = await navBox(page);
  await toggle.click();
  await page.getByTestId('lab-open').click();
  const panel = page.getByTestId('lab-panel');
  await expect(panel).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 2000, height: 1300 },
  ]) {
    await page.setViewportSize(size);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Nothing of the laboratory's panel squeezed into the rail: the rail is as narrow and as tall as outside it.
    await expect(panel).toBeHidden();
    await expect(page.locator('.kf-nav-lab-slot:visible')).toHaveCount(0);
    await expect.poll(async () => (await navBox(page)).width).toBeLessThanOrEqual(70);
    const box = await navBox(page);
    expect(Math.abs(box.height - plain.height), `${String(size.width)}x${String(size.height)}`).toBeLessThanOrEqual(2);
    expect(box.bottom).toBeLessThanOrEqual(box.viewport - 8);
    expect((await shownRows(page)).sort()).toEqual(((await lab(page))?.bodies.map((b) => b.id) ?? []).sort());
    await toggle.click();
    await expect(panel).toBeVisible();
  }
  // A world removed from the experiment while folded leaves the rail at once (no unfolding needed).
  await page.setViewportSize({ width: 1280, height: 800 });
  await toggle.click();
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeLab({ kind: 'remove', id: 'mars' });
  });
  await expect.poll(async () => (await shownRows(page)).includes('mars'), LIVE).toBe(false);
  expect((await shownRows(page)).length).toBe(9);
  // Leaving the experiment folded: the plain rail again, and unfolded, the way in (no panel left over).
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.closeLab();
  });
  await expect.poll(async () => lab(page), LIVE).toBeNull();
  await expect.poll(async () => Math.abs((await navBox(page)).height - plain.height)).toBeLessThanOrEqual(2);
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('lab-open')).toBeVisible();

  // Among the stars: folded, the rail is the toggle alone (the solar system's worlds step aside there).
  await page.getByTestId('stars-open').click();
  const stars = page.getByTestId('stars-panel');
  await expect(stars).toBeVisible(LIVE);
  await toggle.click();
  await expect(stars).toBeHidden();
  expect(await shownRows(page)).toEqual([]);
  // (The rail narrows over a third of a second.)
  await expect.poll(async () => (await navBox(page)).width).toBeLessThanOrEqual(70);
  expect((await navBox(page)).height).toBeLessThan(plain.height / 3);
  await toggle.click();
  await expect(stars).toBeVisible();
  // Bursts of presses on the toggle (each within one task) end where their count says, the panel with them.
  await spam(toggle, 25);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(stars).toBeHidden();
  await spam(toggle, 26);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await spam(toggle, 1);
  await expect(stars).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('in a short window the folded rail stays inside it, and scrolls to its last world', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const toggle = page.getByTestId('universe-nav-toggle');
  await toggle.click();
  for (const size of [
    { width: 1280, height: 600 },
    { width: 1100, height: 560 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.getByTestId('universe-bodies')).toHaveClass(/is-panel/);
    await frames(page, 2);
    const box = await navBox(page);
    expect(box.bottom, `${String(size.width)}x${String(size.height)}`).toBeLessThanOrEqual(box.viewport - 8);
    const neptune = page.getByRole('button', { name: 'Neptune', exact: true });
    await neptune.scrollIntoViewIfNeeded();
    const r = await neptune.evaluate((b) => b.getBoundingClientRect().toJSON() as DOMRect);
    expect(r.top).toBeGreaterThanOrEqual(box.top);
    expect(r.bottom).toBeLessThanOrEqual(box.bottom);
  }
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.getByRole('button', { name: 'Neptune', exact: true }).click();
  await expect.poll(async () => (await view(page))?.focus).toBe('neptune');
  expect(pageErrors).toEqual([]);
});

test('the body fades where it scrolls on, at its head and its foot, and nowhere else', async ({ page, kf, pageErrors }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const body = page.locator('.kf-nav-body-wrap');
  const state = () => body.evaluate((b) => ({ above: b.classList.contains('has-above'), more: b.classList.contains('has-more'), mask: getComputedStyle(b).maskImage }));
  await body.evaluate((b) => {
    b.scrollTop = 0;
  });
  await expect.poll(state).toEqual(expect.objectContaining({ above: false, more: true }));
  expect((await state()).mask).toContain('linear-gradient');
  await body.evaluate((b) => {
    b.scrollTop = 200;
  });
  await expect.poll(state).toEqual(expect.objectContaining({ above: true, more: true }));
  expect((await state()).mask).toContain('linear-gradient');
  await body.evaluate((b) => {
    b.scrollTop = b.scrollHeight;
  });
  await expect.poll(state).toEqual(expect.objectContaining({ above: true, more: false }));
  expect(pageErrors).toEqual([]);
});

test('entered from the foot of the navigator, the laboratory and the stars show their panel from its top; left, the way in is in view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await page.setViewportSize({ width: 1280, height: 600 });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const body = page.locator('.kf-nav-body-wrap');
  const inBody = (testId: string, head = false) =>
    page.getByTestId(testId).evaluate((el, first) => {
      const target = first ? (el.querySelector('h3') ?? el) : el;
      const b = target.closest('.kf-nav-body-wrap')?.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      return b !== undefined && r.height > 0 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
    }, head);
  for (const [open, panel, back] of [
    ['lab-open', 'lab-panel', 'lab-back'],
    ['stars-open', 'stars-panel', 'stars-end'],
  ] as const) {
    await body.evaluate((b) => {
      b.scrollTop = b.scrollHeight;
    });
    await page.getByTestId(open).click();
    await expect(page.getByTestId(panel)).toBeVisible(LIVE);
    await expect.poll(() => body.evaluate((b) => b.scrollTop)).toBe(0);
    await expect.poll(() => inBody(panel, true)).toBe(true);
    await page.getByTestId(back).click();
    await expect(page.getByTestId(open)).toBeVisible(LIVE);
    await expect.poll(() => inBody(open)).toBe(true);
  }
  expect(pageErrors).toEqual([]);
});

test('narrowed to a phone’s width in an experiment the sheet folds small, and widened the panel comes back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  const toggle = page.getByTestId('universe-nav-toggle');
  // Folded small: its head and the worlds' portraits within 200 px, and the time machine's row, which a
  // sheet keeps in reach folded too; first outside an experiment at this width, to compare with.
  const folded = async (): Promise<{ height: number; time: number }> => ({ height: (await navBox(page)).height, time: (await page.locator('.kf-nav-time').boundingBox())?.height ?? 0 });
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(nav).toHaveClass(/is-sheet/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const outside = await folded();
  expect(outside.time).toBeGreaterThan(0);
  expect(outside.height - outside.time).toBeLessThanOrEqual(200);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(nav).toHaveClass(/is-panel/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(nav).toHaveClass(/is-sheet/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('lab-panel')).toBeHidden();
  // In the experiment, as small as outside one (its Reset joins the time machine's row without making it taller).
  await expect.poll(async () => (await folded()).height).toBeLessThanOrEqual(outside.height + 2);
  const inside = await folded();
  expect(inside.height - inside.time).toBeLessThanOrEqual(200);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(nav).toHaveClass(/is-panel/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('lab-panel')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

/**
 * The worlds' names on show (above a fifth of their opacity, or a tenth for `all`) that run under the
 * way back, the readout or the navigator, or (`all`) over one another: each as its text and place.
 */
const namesInTheWay = (page: Page, all = false): Promise<string[]> =>
  page.evaluate((each) => {
    const covers = ['universe-back', 'universe-readout', 'universe-bodies']
      .map((id) => ({ id, r: document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() }))
      .filter((c): c is { id: string; r: DOMRect } => c.r !== undefined && c.r.width > 0);
    const meet = (a: DOMRect, b: DOMRect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    const tags = [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || '1') > (each ? 0.1 : 0.2)).map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
    const out: string[] = [];
    for (const [k, t] of tags.entries()) {
      const where = `${t.text} ${String(Math.round(t.r.left))},${String(Math.round(t.r.top))}`;
      for (const c of covers) if (meet(t.r, c.r)) out.push(`${where} under ${c.id}`);
      if (each) for (const u of tags.slice(k + 1)) if (meet(t.r, u.r)) out.push(`${where} over ${u.text}`);
    }
    return out;
  }, all);

/** Round the Earth at 30,000 km (16 ways round, from below and above): no name or pointer under the interface over the view. */
async function namesClear(page: Page, at: string): Promise<void> {
  for (let az = 0; az < 360; az += 22.5) {
    for (const el of [-20, 25]) {
      await place(page, { body: 'earth', distanceKm: 30_000, azimuthDeg: az, elevationDeg: el });
      await step(page, 25);
      expect(await namesInTheWay(page), `${at} azimuth ${String(az)} elevation ${String(el)}`).toEqual([]);
    }
  }
}

test('names beside the worlds, and their pointers at the edge, keep clear of the way back, the readout and the navigator', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await step(page, 1);
  for (const size of [
    { width: 1280, height: 800 },
    { width: 2000, height: 1300 },
  ]) {
    await page.setViewportSize(size);
    // The renderer takes the new size on its next frame (before the manual clock is stepped at it).
    await frames(page, 3);
    await namesClear(page, `${String(size.width)}x${String(size.height)}`);
  }
  expect(pageErrors).toEqual([]);
});

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('names and their pointers keep clear of the readout and the sheet, held upright and sideways (folded and pulled up)', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await step(page, 1);
    for (const size of [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await frames(page, 3);
      for (const open of [false, true]) {
        const toggle = page.getByTestId('universe-nav-toggle');
        if ((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
        await frames(page, 3);
        await namesClear(page, `${String(size.width)}x${String(size.height)} ${open ? 'pulled up' : 'folded'}`);
      }
    }
    expect(pageErrors).toEqual([]);
  });
});

test('the laboratory’s names and marks, the chosen body’s too, keep off the worlds’ discs, the interface and one another', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  // The experiment held still, the Moon chosen with its Lagrange points shown, and a probe at its L2 (beyond the Moon).
  await page.evaluate(() => {
    const kf = (window as unknown as KfHook).__kf;
    if (kf.universe.state()?.lab?.paused === false) kf.app.universeTime({ kind: 'toggle' });
    kf.app.universeLab({ kind: 'select', id: 'moon' });
    kf.app.universeLab({ kind: 'lagrange', on: true });
  });
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeLab({ kind: 'addLagrange', point: 'L2', massKg: 0, radiusKm: 1, name: 'Probe at L2' });
  });
  await expect.poll(async () => (await lab(page))?.selected ?? '', LIVE).not.toBe('moon');
  const probe = (await lab(page))?.bodies.find((b) => b.name === 'Probe at L2');
  expect(probe).toBeDefined();
  const shown = (text: string): Promise<number> => page.evaluate((t) => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((g) => g.textContent === t).map((g) => Number(g.style.opacity || '1'))), text);
  // Beyond the Moon, looking back past it: the probe (the chosen body now) shows, with its marks.
  await place(page, { body: 'moon', distanceKm: 150_000, from: 'earth' });
  await step(page, 60);
  expect(await shown('Probe at L2')).toBeGreaterThan(0.5);
  // From the far side of the Earth from the Moon the probe is behind the Earth, and so are its L1 and L2
  // (a massless probe's, where it is): neither its name nor those marks show over the Earth's disc.
  await place(page, { body: 'earth', distanceKm: 40_000, from: 'moon' });
  await step(page, 60);
  for (const text of ['Probe at L2', 'L1', 'L2']) expect(await shown(text), text).toBeLessThan(0.05);
  // The Moon chosen again, its marks round the Earth from far out: none under the interface, none over another name.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeLab({ kind: 'select', id: 'moon' });
  });
  await expect.poll(async () => (await lab(page))?.selected, LIVE).toBe('moon');
  for (const size of [
    { width: 1280, height: 800 },
    { width: 2000, height: 1300 },
  ]) {
    await page.setViewportSize(size);
    await frames(page, 3);
    let marks = 0;
    for (let az = 0; az < 360; az += 30) {
      for (const el of [-30, 35]) {
        await place(page, { body: 'earth', distanceKm: 600_000, azimuthDeg: az, elevationDeg: el });
        await step(page, 120);
        expect(await namesInTheWay(page, true), `${String(size.width)}x${String(size.height)} azimuth ${String(az)} elevation ${String(el)}`).toEqual([]);
        marks += await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => /^L[1-5]$/u.test(t.textContent) && Number(t.style.opacity || '1') > 0.5).length);
      }
    }
    // (The marks are there to be seen: they give way, they are not gone.)
    expect(marks, `${String(size.width)}x${String(size.height)}`).toBeGreaterThan(24);
  }
  expect(pageErrors).toEqual([]);
});

test('sections opened and closed while their code is on its way get one body each', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  // The sections' chunks come slowly (a phone's network, a static host far away).
  await page.route(/\/assets\/(islamic-panel|living-earth|sections)-[\w-]+\.js$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  for (const id of ['universe-islamic', 'living-earth', 'universe-about']) {
    const summary = page.getByTestId(id).locator(':scope > summary');
    // By hand, quickly, five times (it ends open), then bursts within one task (seven, then one: open again).
    for (let i = 0; i < 5; i += 1) await summary.click();
    await spam(summary, 7);
    await spam(summary, 1);
    await expect(page.getByTestId(id)).toHaveAttribute('open', '');
  }
  await expect(page.locator('[data-testid="part-waiting"]')).toHaveCount(0, LIVE);
  await expect(page.locator('[data-testid="islamic-panel"]')).toHaveCount(1);
  await expect(page.getByTestId('living-earth').locator(':scope > .kf-living-body')).toHaveCount(1);
  await expect(page.getByTestId('universe-about').locator(':scope > .kf-about-body')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('a part whose code does not come says so and offers to try again; it comes when asked, and nothing is thrown', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  // Offline for these chunks (or a new version published under an open page), until they are let through.
  const parts = /\/assets\/(islamic-panel|sections|lab-panel)-[\w-]+\.(js|css)$/u;
  await page.route(parts, (route) => route.abort());
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  for (const id of ['universe-islamic', 'universe-sky']) {
    const section = page.getByTestId(id);
    await section.locator(':scope > summary').click();
    await expect(section.getByTestId('part-waiting').getByRole('status')).toContainText('did not load', LIVE);
    await expect(section.getByTestId('part-retry')).toBeVisible();
  }
  // The laboratory: the explorer goes on, with a way out of the experiment beside the way to try again.
  await page.getByTestId('lab-open').click();
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  const slot = page.locator('.kf-nav-lab-slot').first();
  await expect(slot.getByTestId('part-waiting').getByRole('status')).toContainText('did not load', LIVE);
  await expect(page.getByTestId('lab-leave')).toBeVisible();
  await page.unroute(parts);
  await slot.getByTestId('part-retry').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  // Styled as on a first try (its styles come with its code, not as a stylesheet asked for once).
  expect(await page.getByTestId('lab-panel').evaluate((el) => {
    const c = getComputedStyle(el);
    return [c.display, c.borderTopWidth, c.paddingTop];
  })).toEqual(['grid', '1px', '12px']);
  await page.getByTestId('lab-back').click();
  await expect.poll(async () => lab(page), LIVE).toBeNull();
  for (const [id, part] of [
    ['universe-islamic', 'islamic-panel'],
    ['universe-sky', 'sky-intro'],
  ] as const) {
    await page.getByTestId(id).getByTestId('part-retry').click();
    await expect(page.getByTestId(part)).toBeVisible(LIVE);
    await expect(page.getByTestId(id).getByTestId('part-waiting')).toHaveCount(0);
  }
  expect(await page.getByTestId('islamic-panel').evaluate((el) => [getComputedStyle(el).display, getComputedStyle(el).paddingBottom])).toEqual(['grid', '8px']);
  // Only the refused requests themselves were reported (the browser's own line for each); nothing was thrown.
  expect(pageErrors.filter((e) => !/Failed to load resource/u.test(e))).toEqual([]);
});

test('the stars’ panel and an explanation whose code does not come say so; asked again, they come styled, and nothing is thrown', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  const parts = /\/assets\/(neighbourhood-panel|help-popover)-[\w-]+\.(js|css)$/u;
  await page.route(parts, (route) => route.abort());
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // An explanation: pressed (in a burst too), the toast says it did not load, once; the "?" stays closed and asks again next time.
  const help = page.getByTestId('help-orrery');
  await help.click();
  await expect(page.getByTestId('universe-toast')).toContainText('did not load', LIVE);
  await spam(help, 5);
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('help-popover')).toHaveCount(0);
  // Among the stars: the explorer goes there, with a way back beside the way to try again.
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await view(page))?.neighbourhood !== null, LIVE).toBe(true);
  const slot = page.locator('.kf-nav-lab-slot').nth(1);
  await expect(slot.getByTestId('part-waiting').getByRole('status')).toContainText('did not load', LIVE);
  await expect(page.getByTestId('stars-leave')).toBeVisible();
  await page.unroute(parts);
  await slot.getByTestId('part-retry').click();
  const panel = page.getByTestId('stars-panel');
  await expect(panel).toBeVisible(LIVE);
  expect(await panel.evaluate((el) => [getComputedStyle(el).marginLeft, getComputedStyle(el).fontSize])).toEqual(['12px', '13px']);
  await page.getByTestId('stars-end').click();
  await expect.poll(async () => (await view(page))?.neighbourhood ?? null, LIVE).toBeNull();
  // The explanation comes on the next press, as a card beside its "?" (its styles with it).
  await help.click();
  const pop = page.getByTestId('help-popover');
  await expect(pop).toBeVisible(LIVE);
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  expect(await pop.evaluate((el) => [getComputedStyle(el).position, getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'])).toEqual(['fixed', true]);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(help).toBeFocused();
  expect(pageErrors.filter((e) => !/Failed to load resource/u.test(e))).toEqual([]);
});
