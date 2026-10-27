/**
 * The explorer on a phone (the "mobile" project: Pixel 7 emulation with touch; emulation, not a real
 * phone, so the GPU is this machine's): touch gestures through real CDP touch events (a pinch zooms
 * in log distance, two fingers pan, a double tap on a world flies there), the bottom sheet, layouts
 * in portrait and landscape with nothing wider than the screen, touch-action: none only while the
 * explorer is on screen, axe on the navigator and the heads-up readout, and the time machine's buttons
 * in reach on the sheet whether it is folded or pulled up.
 */
import AxeBuilder from '@axe-core/playwright';
import type { CDPSession, Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { fits } from '../support/layout';
import { JD, overflow, place, settled, view, waitForUniverse } from '../support/universe';
import { NEEDS_REAL_FRAMES, NO_GPU, SLOW } from '../support/env';

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

/** The middle of the clear part of the view (between the readout and the sheet, or a note standing above it: where the view frames the bodies). */
async function middle(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const readout = document.querySelector('[data-testid="universe-readout"]')?.getBoundingClientRect();
    const sheet = document.querySelector('[data-testid="universe-bodies"]')?.getBoundingClientRect();
    const card = document.querySelector('.kf-note.is-visible')?.getBoundingClientRect();
    const top = readout ? readout.bottom : 0;
    const bottom = Math.min(sheet ? sheet.top : window.innerHeight, card && card.height > 0 && card.top > top ? card.top : Infinity);
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
  await expect.poll(async () => (await view(page))?.altitudeKm ?? 0, { timeout: 5000 * SLOW }).toBeLessThan(before * 0.45);
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
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
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
  await expect.poll(async () => (await view(page))?.focus, { timeout: 5000 * SLOW }).toBe('earth');
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

test('among the stars by touch: one finger looks round (the Sun moving with it), a pinch moves toward its middle, a tap names the star there, a double tap flies to it, the Sun in the clear part of the view', async ({ page, kf, pageErrors }) => {
  test.skip(NO_GPU, NEEDS_REAL_FRAMES);
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // (The sheet's way out, as a tool would ask: its button is in the folded sheet.)
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'stars' });
  });
  const stars = async () => (await view(page))?.neighbourhood ?? null;
  await expect.poll(async () => (await stars())?.focus.name ?? null, { timeout: 60_000 * SLOW }).toBe('Sun');
  const sun = async (): Promise<Point | null> => page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.find((l) => l.id === 'star-sun') ?? null);
  await expect.poll(async () => (await sun()) !== null, { timeout: 30_000 * SLOW }).toBe(true);
  // The Sun sits in the clear part of the view, above the sheet, not under it.
  const sheet = await page.getByTestId('universe-bodies').boundingBox();
  const at = await sun();
  expect(at?.y ?? Infinity).toBeLessThan(sheet?.y ?? 0);
  const cdp = await page.context().newCDPSession(page);
  const c = await middle(page);
  // One finger: the sky follows it, the Sun with it.
  await touch(cdp, 'touchStart', [{ x: c.x - 60, y: c.y }]);
  for (let i = 1; i <= 10; i++) await touch(cdp, 'touchMove', [{ x: c.x - 60 + i * 8, y: c.y }]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(async () => ((await sun())?.x ?? 0) - (at?.x ?? 0), { timeout: 5000 * SLOW }).toBeGreaterThan(50);
  // A tap on a named star (another than the Sun where one is named) says what it is; a double tap flies there, into orbit round it.
  const named = await page.evaluate(() => {
    const top = document.querySelector('[data-testid="universe-bodies"]')?.getBoundingClientRect().top ?? 0;
    const list = (window as unknown as KfHook).__kf.app.hud().labels.filter((l) => l.id.startsWith('star-') && l.y > 80 && l.y < top - 20 && l.x > 20 && l.x < window.innerWidth - 20);
    return list.find((l) => l.id !== 'star-sun') ?? list[0] ?? null;
  });
  if (!named) throw new Error('no named star in the clear part of the view');
  await tap(cdp, { x: named.x, y: named.y });
  await expect.poll(async () => (await stars())?.hover?.name ?? null, { timeout: 5000 * SLOW }).toBe(named.text ?? '');
  // Said beside it, the sheet folded as it is.
  await expect(page.getByTestId('stars-hover')).toBeVisible();
  await expect(page.getByTestId('stars-hover')).toContainText(named.text ?? '');
  await page.waitForTimeout(80);
  await tap(cdp, { x: named.x, y: named.y });
  await expect.poll(async () => (await stars())?.travelling ?? null, { timeout: 10_000 * SLOW }).toBe(true);
  await expect.poll(async () => (await stars())?.travelling ?? null, { timeout: 30_000 * SLOW }).toBe(false);
  expect((await stars())?.focus.name).toBe(named.text ?? '');
  expect((await stars())?.camera.mode).toBe('orbit');
  // A pinch outward in orbit: in toward it, never inside it.
  const before = (await stars())?.cameraPc ?? 0;
  await twoFingers(cdp, [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }], [{ x: c.x - 140, y: c.y }, { x: c.x + 140, y: c.y }]);
  await expect.poll(async () => (await stars())?.cameraPc ?? Infinity, { timeout: 5000 * SLOW }).toBeLessThan(before * 0.6);
  // Pinches whose middle is on empty sky, away from the star and every name: still in toward it, never off to a faint star.
  const focus = (await stars())?.focus.name;
  const labels = await page.evaluate(() => (window as unknown as KfHook).__kf.app.hud().labels.map((l) => ({ x: l.x, y: l.y })));
  const sheetTop = (await page.getByTestId('universe-bodies').boundingBox())?.y ?? 600;
  const spots = [
    { x: 80, y: 140 },
    { x: 300, y: 160 },
    { x: 100, y: sheetTop - 60 },
    { x: 290, y: sheetTop - 80 },
  ].filter((p) => labels.every((l) => Math.hypot(l.x - p.x, l.y - p.y) > 60 && Math.hypot(l.x + 40 - p.x, l.y - 16 - p.y) > 60));
  expect(spots.length).toBeGreaterThanOrEqual(2);
  for (const p of spots) {
    const was = (await stars())?.cameraPc ?? 0;
    await twoFingers(cdp, [{ x: p.x - 20, y: p.y }, { x: p.x + 20, y: p.y }], [{ x: p.x - 45, y: p.y }, { x: p.x + 45, y: p.y }]);
    await page.waitForTimeout(300);
    const now = await stars();
    expect(now?.focus.name).toBe(focus);
    expect(now?.travelling).toBe(false);
    expect(now?.cameraPc ?? Infinity).toBeLessThanOrEqual(was);
  }
  expect(pageErrors).toEqual([]);
});

test('portrait: a bottom sheet of worlds that pulls up (Esc folds it), nothing wider than the screen, and axe finds nothing', async ({ page, kf, pageErrors }, testInfo) => {
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await settled(page, ['universe-readout', 'universe-bodies']);
  const nav = page.getByTestId('universe-bodies');
  await expect(nav).toHaveClass(/is-sheet/);
  for (const name of ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
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
  expect(await small('.kf-nav-body, .kf-nav-seen summary, .kf-nav-keys summary, .kf-nav-living > summary, [data-testid="universe-detail"]')).toEqual([]);
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

for (const body of ['mercury', 'venus', 'mars', 'uranus', 'neptune'] as const) {
  test(`phone: ${body} opens, renders and keeps ten usable navigator targets`, async ({ page, kf, pageErrors }) => {
    await kf.open(`/universe/${body}`, { query: { jd: JD, detail: 'low' } });
    await waitForUniverse(page);
    await settled(page, ['universe-readout', 'universe-bodies']);
    await expect(page.locator('.kf-nav-row')).toHaveCount(10);
    await expect.poll(async () => (await view(page))?.focus).toBe(body);
    const layout = await overflow(page);
    expect(layout.scroll).toBeLessThanOrEqual(layout.client);
    expect(layout.offenders).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('short landscape: the detail menu and its close control stay within the viewport', async ({ page, kf }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await kf.open('/universe/saturn', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-nav-toggle').click();
  await page.getByTestId('universe-detail').click();
  const close = page.getByTestId('universe-detail-close');
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(390);
  await page.getByTestId('universe-detail-low').scrollIntoViewIfNeeded();
  const after = await close.boundingBox();
  expect(after?.y).toBeGreaterThanOrEqual(0);
  await close.click();
  await expect(page.getByTestId('universe-detail')).toHaveAttribute('aria-expanded', 'false');
});

test('the orbital laboratory on a phone: opened from the sheet, every control a touch target, nothing wider than the screen', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-nav-toggle').click();
  await page.getByTestId('lab-open').scrollIntoViewIfNeeded();
  await page.getByTestId('lab-open').tap();
  await expect(page).toHaveURL(/#\/universe\/lab/);
  const panel = page.getByTestId('lab-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 * SLOW });
  await expect(panel.getByTestId('lab-body-earth')).toBeVisible({ timeout: 60_000 * SLOW });
  await panel.getByTestId('lab-body-earth').tap();
  await expect(panel.getByTestId('lab-inspector')).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  const problems = await page.evaluate((w) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="lab-panel"] button, [data-testid="lab-panel"] input, [data-testid="lab-panel"] select, [data-testid="lab-panel"] summary')) {
      const r = el.getBoundingClientRect();
      // Visually hidden controls (the file input, whose label is the target) are not touch targets.
      if (r.width === 0 || r.height === 0 || el.classList.contains('kf-sr-only')) continue;
      if (r.height < 43.5) out.push(`${el.dataset.testid ?? el.tagName} ${Math.round(r.height)}px tall`);
      if (r.right > w + 0.5) out.push(`${el.dataset.testid ?? el.tagName} past the screen's edge`);
    }
    return out;
  }, width);
  expect(problems).toEqual([]);
  const results = await new AxeBuilder({ page }).include('[data-testid="lab-panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await panel.getByTestId('lab-back').tap();
  await expect(page).not.toHaveURL(/lab/);
  expect(pageErrors).toEqual([]);
});

test('the orbital laboratory on a phone: entered, its panel shows from its top after the list of worlds; folded, the sheet is as small as outside it', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const nav = page.getByTestId('universe-bodies');
  const toggle = page.getByTestId('universe-nav-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const small = (await nav.boundingBox())?.height ?? 0;
  await toggle.tap();
  await page.getByTestId('lab-open').scrollIntoViewIfNeeded();
  await page.getByTestId('lab-open').tap();
  const panel = page.getByTestId('lab-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 * SLOW });
  // In view from its heading, though it was entered from the foot of the sheet.
  await expect
    .poll(() =>
      panel.locator('h3').first().evaluate((h) => {
        const body = h.closest('.kf-nav-body-wrap')?.getBoundingClientRect();
        const r = h.getBoundingClientRect();
        return body !== undefined && r.top >= body.top - 1 && r.bottom <= body.bottom + 1;
      }),
    )
    .toBe(true);
  // The sheet puts the list of worlds first: the panel comes after the last of the experiment's worlds.
  const order = await page.evaluate(() => {
    const body = document.querySelector('.kf-nav-body-wrap');
    const rows = [...document.querySelectorAll<HTMLElement>('.kf-nav-row')].filter((r) => r.offsetParent !== null);
    const lab = document.querySelector('[data-testid="lab-panel"]');
    if (!body || !lab || rows.length === 0) return null;
    return { rowsEnd: Math.max(...rows.map((r) => r.getBoundingClientRect().bottom)), panelTop: lab.getBoundingClientRect().top };
  });
  expect(order).not.toBeNull();
  expect(order?.panelTop ?? 0).toBeGreaterThanOrEqual(order?.rowsEnd ?? Infinity);
  // Folded in the experiment: its worlds in two rows, nothing of the panel, as small as outside it.
  await toggle.tap();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  await expect.poll(async () => Math.abs(((await nav.boundingBox())?.height ?? 0) - small)).toBeLessThanOrEqual(2);
  expect(pageErrors).toEqual([]);
});

test('the qibla and the new moon on a phone: opened from the sheet, every control a touch target, the map computed, nothing wider than the screen', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-nav-toggle').click();
  const section = page.getByTestId('universe-islamic');
  await section.locator('summary').scrollIntoViewIfNeeded();
  await section.locator('summary').tap();
  const panel = page.getByTestId('islamic-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 * SLOW });
  await expect(panel.getByTestId('islamic-new-moon')).toContainText('New moon', { timeout: 60_000 * SLOW });
  await panel.getByTestId('islamic-evening-1').tap();
  await expect.poll(async () => (await view(page))?.islamic?.crescent?.progress ?? 0, { timeout: 60_000 * SLOW }).toBe(1);
  await expect(panel.getByTestId('islamic-legend')).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  const problems = await page.evaluate((w) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="universe-islamic"] button, [data-testid="universe-islamic"] input, [data-testid="universe-islamic"] summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5) out.push(`${el.dataset.testid ?? el.tagName} ${Math.round(r.height)}px tall`);
      if (r.right > w + 0.5) out.push(`${el.dataset.testid ?? el.tagName} past the screen's edge`);
    }
    return out;
  }, width);
  expect(problems).toEqual([]);
  const wide = await overflow(page);
  expect(wide.offenders).toEqual([]);
  expect(wide.scroll).toBeLessThanOrEqual(wide.client);
  const results = await new AxeBuilder({ page }).include('[data-testid="universe-islamic"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('on foot on a phone: Forward held walks, a finger looks round, Jump jumps, every control a touch target, nothing wider than the screen', async ({ page, kf, pageErrors }) => {
  // In software rendering (CI) on a phone's screen every frame of the walk is slow: about fifteen minutes in all.
  test.setTimeout(450_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // What the page says to a screen reader, kept as it is said.
  await page.evaluate(() => {
    const said: string[] = [];
    (window as unknown as { said: string[] }).said = said;
    const live = document.querySelector('.kf-sr-only[aria-live="polite"]');
    if (live) new MutationObserver(() => said.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
  });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25 });
  });
  await expect.poll(async () => (await view(page))?.walk?.state, { timeout: 60_000 * SLOW }).toBe('walking');
  const hud = page.getByTestId('walk-hud');
  await expect(hud).toBeVisible();
  // A touch screen is told about the pad, not the keys (shown, and said to a screen reader).
  await expect(hud.locator('.kf-walk-touch')).toBeVisible();
  await expect(hud.locator('.kf-walk-keys')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { said: string[] }).said.some((t) => t.includes('The pad walks and jumps'))), { timeout: 30_000 * SLOW }).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { said: string[] }).said.some((t) => t.includes('W A S D')))).toBe(false);
  const cdp = await page.context().newCDPSession(page);
  const centre = async (testId: string): Promise<Point> => {
    const box = await page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`${testId} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // Forward held walks (about a metre and a half a second): held until it has gone half a metre, since a
  // slow machine's frames come seldom and each advances the walker at most 0.2 s.
  const before = (await view(page))?.walk;
  await touch(cdp, 'touchStart', [await centre('walk-forward')]);
  await expect.poll(async () => (await view(page))?.walk?.walkedM ?? 0, { timeout: 30_000 * SLOW }).toBeGreaterThan(0.5);
  await touch(cdp, 'touchEnd', []);
  // Let go, the walker stops.
  const stopped = (await view(page))?.walk?.walkedM ?? 0;
  await page.waitForTimeout(500);
  expect((await view(page))?.walk?.walkedM ?? 0).toBeCloseTo(stopped, 1);
  // A finger dragged across the scene (above the suit's readout) looks round.
  const hudBox = await hud.locator('.kf-walk-dock').boundingBox();
  const mid = { x: (page.viewportSize()?.width ?? 0) / 2, y: (hudBox?.y ?? 400) / 2 + 40 };
  await touch(cdp, 'touchStart', [mid]);
  for (let i = 1; i <= 8; i++) await touch(cdp, 'touchMove', [{ x: mid.x - i * 18, y: mid.y }]);
  await touch(cdp, 'touchEnd', []);
  await expect.poll(async () => Math.abs(((await view(page))?.walk?.headingDeg ?? 0) - (before?.headingDeg ?? 0)), { timeout: 30_000 * SLOW }).toBeGreaterThan(5);
  // Jump.
  const ground = (await view(page))?.walk?.groundM ?? 0;
  await touch(cdp, 'touchStart', [await centre('walk-jump')]);
  await expect.poll(async () => ((await view(page))?.walk?.feetM ?? 0) - ground, { timeout: 30_000 * SLOW }).toBeGreaterThan(0.05);
  await touch(cdp, 'touchEnd', []);
  // Every control a touch target, within the screen.
  const width = page.viewportSize()?.width ?? 0;
  const problems = await page.evaluate((w) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="walk-hud"] button')) {
      const r = el.getBoundingClientRect();
      if (r.height < 43.5) out.push(`${el.dataset.testid ?? el.tagName} ${Math.round(r.height)}px tall`);
      if (r.right > w + 0.5 || r.left < -0.5) out.push(`${el.dataset.testid ?? el.tagName} past the screen's edge`);
    }
    return out;
  }, width);
  expect(problems).toEqual([]);
  const wide = await overflow(page);
  expect(wide.offenders).toEqual([]);
  expect(wide.scroll).toBeLessThanOrEqual(wide.client);
  const results = await new AxeBuilder({ page }).include('[data-testid="walk-hud"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  // Back to orbit.
  await page.getByTestId('walk-end').tap();
  await expect.poll(async () => (await view(page))?.walk, { timeout: 30_000 * SLOW }).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('on foot on a phone upright and sideways (390 x 844, 844 x 390): the way back always on screen, the sheet folded or pulled up and the figures open or not; every control a 44 px target inside the screen, none over another; Step right and Run on the pad; turned ten times, Back to orbit still ends the walk', async ({ page, kf, pageErrors }) => {
  test.setTimeout(450_000 * SLOW);
  await page.setViewportSize({ width: 390, height: 844 });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', lat: 23.4, lon: 25, headingDeg: 90 });
  });
  await expect.poll(async () => (await view(page))?.walk?.state, { timeout: 60_000 * SLOW }).toBe('walking');
  const cdp = await page.context().newCDPSession(page);
  const centre = async (testId: string): Promise<Point> => {
    const box = await page.getByTestId(testId).boundingBox();
    if (!box) throw new Error(`${testId} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  // Step right, held, while facing east: the walker goes south, still facing east.
  const before = (await view(page))?.walk;
  await touch(cdp, 'touchStart', [await centre('walk-right')]);
  await expect.poll(async () => ((await view(page))?.walk?.walkedM ?? 0) - (before?.walkedM ?? 0), { timeout: 30_000 * SLOW }).toBeGreaterThan(0.3);
  await touch(cdp, 'touchEnd', []);
  const stepped = (await view(page))?.walk;
  expect(stepped?.lat ?? 0).toBeLessThan(before?.lat ?? 0);
  expect(Math.abs((stepped?.headingDeg ?? 0) - (before?.headingDeg ?? 0))).toBeLessThan(1);
  await page.getByTestId('walk-run').tap();
  await expect(page.getByTestId('walk-run')).toHaveAttribute('aria-pressed', 'true');
  for (const size of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    const label = `${String(size.width)} x ${String(size.height)}`;
    await expect(page.getByTestId('walk-end')).toBeVisible();
    await fits(page, label);
    // Every control of the walk a touch target.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="walk-hud"] :is(button, summary)')]
        .filter((el) => el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }))
        .map((el) => ({ id: el.dataset.testid ?? el.className, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.height < 43.5 || r.width < 43.5)
        .map(({ id, r }) => `${id} ${String(Math.round(r.width))} x ${String(Math.round(r.height))}`),
    );
    expect(small, label).toEqual([]);
    // The figures open: the pad and the way back still there.
    await page.getByTestId('walk-title').tap();
    await expect(page.getByTestId('walk-gravity')).toBeVisible();
    await fits(page, `${label}, figures open`);
    await expect(page.getByTestId('walk-forward')).toBeInViewport();
    await page.getByTestId('walk-title').tap();
    // The sheet pulled up: the way back stays, and reaches.
    await page.getByTestId('universe-nav-toggle').tap();
    await expect(page.getByTestId('universe-nav-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('walk-end')).toBeInViewport();
    await fits(page, `${label}, sheet pulled up`);
    await page.getByTestId('universe-nav-toggle').tap();
    const wide = await overflow(page);
    expect(wide.offenders, label).toEqual([]);
    expect(wide.scroll).toBeLessThanOrEqual(wide.client);
  }
  // Turned between upright and sideways ten times, then Back to orbit.
  for (let i = 0; i < 10; i += 1) await page.setViewportSize(i % 2 === 0 ? { width: 390, height: 844 } : { width: 844, height: 390 });
  await expect(page.getByTestId('walk-end')).toBeInViewport();
  await page.getByTestId('walk-end').tap();
  await expect.poll(async () => (await view(page))?.walk, { timeout: 30_000 * SLOW }).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('the time machine stays in reach on the sheet: its buttons above the list folded or pulled up, its date under the list, every tap answered', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await settled(page, ['universe-readout', 'universe-bodies']);
  const nav = page.getByTestId('universe-bodies');
  const ids = ['universe-time-reverse', 'universe-time-slower', 'universe-time-pause', 'universe-time-faster', 'universe-time-now', 'universe-photo'];
  /** Each button: in the window, on top at its middle, at least 44 px each way. */
  const reach = (): Promise<string[]> =>
    page.evaluate((list) => {
      const out: string[] = [];
      for (const id of list) {
        const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width === 0) {
          out.push(`${id} missing`);
          continue;
        }
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) out.push(`${id} outside`);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!(hit === el || el.contains(hit))) out.push(`${id} covered`);
        if (r.width < 43.5 || r.height < 43.5) out.push(`${id} ${String(Math.round(r.width))}x${String(Math.round(r.height))}`);
      }
      return out;
    }, ids);
  expect(await reach()).toEqual([]);
  for (let i = 0; i < 3; i += 1) await page.getByTestId('universe-time-faster').tap();
  expect((await view(page))?.time.rate).toBe(600);
  // Pulled up: the buttons stay where they were reached; the date is under the list, by scrolling the sheet.
  await page.getByTestId('universe-nav-toggle').tap();
  await expect(nav).toHaveClass(/is-expanded/);
  await page.waitForTimeout(400);
  expect(await reach()).toEqual([]);
  await page.getByTestId('universe-time-date').scrollIntoViewIfNeeded();
  await page.getByTestId('universe-time-date').fill('2031-03-20');
  await expect.poll(async () => new Date((await view(page))?.unixMs ?? 0).toISOString().slice(0, 10)).toBe('2031-03-20');
  // A hundred taps on Faster and Slower in turn, the sheet folded and pulled up between bursts (forced: a finger presses a control at a ladder's end too).
  for (let round = 0; round < 20; round += 1) {
    for (let k = 0; k < 5; k += 1) await page.getByTestId(k % 2 === 0 ? 'universe-time-faster' : 'universe-time-slower').tap({ force: true });
    await page.getByTestId('universe-nav-toggle').tap();
  }
  expect([1, 10, 60, 600, 3600, 21_600, 86_400, 604_800, 2_592_000]).toContain(Math.abs((await view(page))?.time.rate ?? 0));
  expect(await reach()).toEqual([]);
  const sides = await overflow(page);
  expect(sides.scroll).toBeLessThanOrEqual(sides.client);
  expect(pageErrors).toEqual([]);
});
