/**
 * The explorer on a phone (the "mobile" project: Pixel 7 emulation with touch; emulation, not a real
 * phone, so the GPU is this machine's): touch gestures through real CDP touch events (a pinch zooms
 * in log distance, two fingers pan, a double tap on a world flies there), the bottom sheet, layouts
 * in portrait and landscape with nothing wider than the screen, touch-action: none only while the
 * explorer is on screen, and axe on the navigator and the heads-up readout.
 */
import AxeBuilder from '@axe-core/playwright';
import type { CDPSession, Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { JD, overflow, place, settled, view, waitForUniverse } from '../support/universe';
import { SLOW } from '../support/env';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

type Point = { x: number; y: number };

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

/** Two fingers moving from `from` to `to` (each a pair of points) in `steps` moves. */
async function twoFingers(cdp: CDPSession, from: [Point, Point], to: [Point, Point], steps = 12): Promise<void> {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const lerp = (a: Point, b: Point): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    await touch(cdp, 'touchMove', [lerp(from[0], to[0]), lerp(from[1], to[1])]);
  }
  await touch(cdp, 'touchEnd', []);
}

async function tap(cdp: CDPSession, p: Point): Promise<void> {
  await touch(cdp, 'touchStart', [p]);
  await touch(cdp, 'touchEnd', []);
}

/** The middle of the clear part of the view (between the readout and the sheet). */
async function middle(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const readout = document.querySelector('[data-testid="universe-readout"]')?.getBoundingClientRect();
    const sheet = document.querySelector('[data-testid="universe-bodies"]')?.getBoundingClientRect();
    const top = readout ? readout.bottom : 0;
    const bottom = sheet ? sheet.top : window.innerHeight;
    return { x: window.innerWidth / 2, y: (top + bottom) / 2 };
  });
}

test('a pinch zooms in log distance, two fingers pan, and touch-action is none only in the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  // The film's own canvas setting, to compare with after the explorer has gone.
  await kf.open('/', { query: { jd: JD } });
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  const canvas = page.locator('#scene');
  const filmTouchAction = await canvas.evaluate((el) => el.style.touchAction);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.openUniverse('earth');
  });
  await waitForUniverse(page);
  await page.waitForTimeout(400);
  await place(page, { body: 'earth', distanceKm: 60_000, azimuthDeg: 20 });
  await page.waitForTimeout(300);
  expect(await canvas.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  // Only the explorer's surface: the page itself still scrolls and zooms as the browser likes.
  expect(await page.evaluate(() => [getComputedStyle(document.documentElement).touchAction, getComputedStyle(document.body).touchAction])).toEqual(['auto', 'auto']);
  const cdp = await page.context().newCDPSession(page);
  const c = await middle(page);
  const before = (await view(page))?.altitudeKm ?? 0;
  // Fingers 80 px apart spread to 240 px: three times closer (in height above the surface).
  await twoFingers(cdp, [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }], [{ x: c.x - 120, y: c.y }, { x: c.x + 120, y: c.y }]);
  await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, { timeout: 5000 }).toBeLessThan(before * 0.45);
  await page.waitForTimeout(800);
  const pinched = (await view(page))?.altitudeKm ?? 0;
  expect(pinched / before).toBeGreaterThan(0.2);
  expect(pinched / before).toBeLessThan(0.45);
  // Two fingers moving together pan: the camera moves, its distance about the same.
  const panFrom = await view(page);
  await twoFingers(cdp, [{ x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y }], [{ x: c.x - 60, y: c.y - 90 }, { x: c.x + 60, y: c.y - 90 }]);
  await page.waitForTimeout(800);
  const panTo = await view(page);
  const moved = Math.hypot((panTo?.camera.x ?? 0) - (panFrom?.camera.x ?? 0), (panTo?.camera.y ?? 0) - (panFrom?.camera.y ?? 0), (panTo?.camera.z ?? 0) - (panFrom?.camera.z ?? 0));
  expect(moved).toBeGreaterThan(100);
  // Leaving the explorer gives the canvas back the film's own touch-action.
  await page.getByTestId('universe-back').click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'film', { timeout: 30_000 });
  expect(await canvas.evaluate((el) => el.style.touchAction)).toBe(filmTouchAction);
  expect(pageErrors).toEqual([]);
});

test('a double tap on a world flies there; one finger orbits', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.waitForTimeout(400);
  // From beyond the Moon, looking back toward the Earth: turned a little, the Earth shows about 5 degrees beside it.
  await place(page, { body: 'moon', distanceKm: 90_000, from: 'earth', azimuthDeg: 6, elevationDeg: 1 });
  await page.waitForTimeout(300);
  const state = await view(page);
  const earth = state?.bodies.find((b) => b.id === 'earth');
  expect(earth?.screen.inView).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  const at = { x: earth?.screen.x ?? 0, y: earth?.screen.y ?? 0 };
  await tap(cdp, at);
  await page.waitForTimeout(80);
  await tap(cdp, at);
  await expect.poll(async () => (await view(page))?.focus, { timeout: 5000 }).toBe('earth');
  expect((await view(page))?.travelling).toBe(true);
  await expect(page).toHaveURL(/#\/universe\/earth/);
  await expect(page.locator('html')).toHaveAttribute('data-travel', 'arrived', { timeout: 30_000 });
  // One finger drags the view round the world.
  const c = await middle(page);
  const a = await view(page);
  await touch(cdp, 'touchStart', [c]);
  for (let i = 1; i <= 10; i++) await touch(cdp, 'touchMove', [{ x: c.x + i * 14, y: c.y }]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(700);
  const b = await view(page);
  expect(Math.hypot((b?.camera.x ?? 0) - (a?.camera.x ?? 0), (b?.camera.z ?? 0) - (a?.camera.z ?? 0))).toBeGreaterThan(1000);
  expect(Math.abs((b?.altitudeKm ?? 0) - (a?.altitudeKm ?? 0)) / (a?.altitudeKm ?? 1)).toBeLessThan(0.05);
  expect(pageErrors).toEqual([]);
});

test('portrait: a bottom sheet of worlds that pulls up (Esc folds it), nothing wider than the screen, and axe finds nothing', async ({ page, kf, pageErrors }, testInfo) => {
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await settled(page, ['universe-readout', 'universe-bodies']);
  const nav = page.getByTestId('universe-bodies');
  await expect(nav).toHaveClass(/is-sheet/);
  for (const name of ['Sun', 'Earth', 'Moon', 'Jupiter', 'Saturn']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
  const folded = await overflow(page);
  expect(folded.scroll).toBeLessThanOrEqual(folded.client);
  expect(folded.offenders).toEqual([]);
  const axe = await new AxeBuilder({ page }).include('[data-testid="universe"]').withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-mobile-folded.json', { body: JSON.stringify(axe.violations, null, 2), contentType: 'application/json' });
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  // Pulled up: the orrery, distances and the detail menu; the world eases into the strip left clear.
  await page.getByTestId('universe-nav-toggle').click();
  await expect(nav).toHaveClass(/is-expanded/);
  await expect(page.locator('.kf-orrery')).toBeVisible();
  await expect.poll(async () => between(page, 'saturn')).toBe(true);
  await expect(nav.locator('.kf-nav-row[data-body="sun"] .kf-nav-light')).toContainText(/light/);
  const open = await overflow(page);
  expect(open.scroll).toBeLessThanOrEqual(open.client);
  expect(open.offenders).toEqual([]);
  const axeOpen = await new AxeBuilder({ page }).include('[data-testid="universe"]').withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-mobile-open.json', { body: JSON.stringify(axeOpen.violations, null, 2), contentType: 'application/json' });
  expect(axeOpen.violations.map((v) => v.id)).toEqual([]);
  // Esc (a phone with a keyboard) folds it and leaves the explorer open.
  await page.keyboard.press('Escape');
  await expect(nav).not.toHaveClass(/is-expanded/);
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
  await page.getByTestId('universe-nav-toggle').click();
  await expect(nav).toHaveClass(/is-expanded/);
  // A choice folds the sheet so the trip has the screen.
  await nav.getByRole('button', { name: 'Moon', exact: true }).click();
  await expect(nav).not.toHaveClass(/is-expanded/);
  await expect.poll(async () => (await view(page))?.focus).toBe('moon');
  expect(pageErrors).toEqual([]);
});

test('landscape: the sheet sits clear of the readout, the world beside it when pulled up, and nothing is wider than the screen', async ({ page, kf, pageErrors }) => {
  const size = page.viewportSize() ?? { width: 412, height: 839 };
  await page.setViewportSize({ width: size.height, height: size.width });
  await kf.open('/universe/jupiter', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  await expect(nav).toHaveClass(/is-sheet/);
  await expect(page.getByTestId('universe-nav-toggle')).toBeVisible();
  const folded = await overflow(page);
  expect(folded.scroll).toBeLessThanOrEqual(folded.client);
  expect(folded.offenders).toEqual([]);
  const readout = await page.getByTestId('universe-readout').boundingBox();
  const sheet = await nav.boundingBox();
  // Side by side or one above the other, never on top of each other.
  const overlapX = Math.min((readout?.x ?? 0) + (readout?.width ?? 0), (sheet?.x ?? 0) + (sheet?.width ?? 0)) - Math.max(readout?.x ?? 0, sheet?.x ?? 0);
  const overlapY = Math.min((readout?.y ?? 0) + (readout?.height ?? 0), (sheet?.y ?? 0) + (sheet?.height ?? 0)) - Math.max(readout?.y ?? 0, sheet?.y ?? 0);
  expect(overlapX <= 0 || overlapY <= 0).toBe(true);
  await page.getByTestId('universe-nav-toggle').click();
  await expect(nav).toHaveClass(/is-expanded/);
  const open = await overflow(page);
  expect(open.scroll).toBeLessThanOrEqual(open.client);
  expect(open.offenders).toEqual([]);
  // Pulled up, the sheet has the right of the screen: the world eases into the part left clear.
  await expect.poll(async () => between(page, 'jupiter')).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('every control is a 44 px touch target; the pulled-up sheet lists the worlds first, each row whole', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await settled(page, ['universe-readout', 'universe-bodies']);
  const small = (selectors: string): Promise<string[]> =>
    page.evaluate((sel) => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        // A world's button takes taps over its whole row (its ::after covers it): the row is its target.
        const r = (el.closest('.kf-nav-row') ?? el).getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
        if (r.width < 43.5 || r.height < 43.5) out.push(`${(el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    }, selectors);
  expect(await small('[data-testid="universe-back"], [data-testid="universe-nav-toggle"], .kf-nav-body')).toEqual([]);
  // Pulled up: the list first, every row inside the sheet's scrolling part (none cut mid-line).
  await page.getByTestId('universe-nav-toggle').click();
  const nav = page.getByTestId('universe-bodies');
  await expect(nav).toHaveClass(/is-expanded/);
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => {
    const wrap = document.querySelector('.kf-nav-body-wrap')?.getBoundingClientRect();
    const list = document.querySelector('.kf-nav-list')?.getBoundingClientRect();
    const map = document.querySelector('.kf-nav-map')?.getBoundingClientRect();
    const cut = [...document.querySelectorAll('.kf-nav-row')]
      .map((r) => r.getBoundingClientRect())
      .filter((r) => !wrap || r.top < wrap.top - 0.5 || r.bottom > wrap.bottom + 0.5).length;
    return { cut, listFirst: Boolean(list && map && list.top < map.top) };
  });
  expect(rows).toEqual({ cut: 0, listFirst: true });
  expect(await small('.kf-nav-body, .kf-nav-seen summary, .kf-nav-keys summary, [data-testid="universe-detail"]')).toEqual([]);
  // The detail menu closes on a choice, and on a tap outside it.
  await page.getByTestId('universe-detail').click();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'true');
  expect(await small('.kf-nav-detail-option, [data-testid="universe-detail-close"]')).toEqual([]);
  await page.getByTestId('universe-detail-low').tap();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-detail', 'low');
  await page.getByTestId('universe-detail').click();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'true');
  // A tap on the scene above the sheet.
  const cdp = await page.context().newCDPSession(page);
  const sheetTop = (await nav.boundingBox())?.y ?? 400;
  await tap(cdp, { x: 40, y: Math.max(140, sheetTop - 30) });
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
  // During a trip, Stop is a touch target too, and says nothing about a key a phone does not have.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.focusBody('jupiter');
  });
  await expect(page.getByTestId('universe-trip')).toHaveClass(/is-active/);
  await expect(page.getByTestId('universe-stop')).toHaveText('Stop');
  expect(await small('[data-testid="universe-stop"]')).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('a note folds to its title on a touch of the scene (the world gets the screen back), and opens again from its title', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const card = page.locator('.kf-note.is-visible');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('.kf-note-body')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await tap(cdp, await middle(page));
  await expect(card).toHaveClass(/is-folded/);
  await expect(card.locator('.kf-note-body')).toBeHidden();
  const toggle = card.locator('.kf-note-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.tap();
  await expect(card.locator('.kf-note-body')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(pageErrors).toEqual([]);
});

/**
 * Whether a body's centre is on screen in the part the interface leaves clear: below the readout,
 * and above the sheet (a phone held upright) or left of it (held sideways, the sheet pulled up).
 */
async function between(page: Page, id: string): Promise<boolean> {
  const body = (await view(page))?.bodies.find((b) => b.id === id);
  const readout = await page.getByTestId('universe-readout').boundingBox();
  const sheet = await page.getByTestId('universe-bodies').boundingBox();
  const size = page.viewportSize();
  if (!body || !readout || !sheet || !size) return false;
  const { x, y } = body.screen;
  const belowReadout = y > readout.y + readout.height && y < size.height;
  const clearOfSheet = sheet.x > size.width / 4 ? x > 0 && x < sheet.x : y < sheet.y;
  return belowReadout && clearOfSheet;
}
