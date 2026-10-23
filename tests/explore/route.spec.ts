/**
 * The solar-system explorer's route and its hand-over with the film (docs/CONTRACTS.md, "URL
 * parameters and routes" and "Test hooks"): #/universe loads and renders, a chapter and the
 * explorer can swap back and forth without leaking GPU resources and with the film resuming where
 * it was, history works both ways, and nothing logs an error. An explorer that cannot load says
 * so and hands the screen back to the film.
 */
import type { Page } from '@playwright/test';
import { expectCanvasNotBlank } from '../support/canvas';
import { expect, test, type FrameStats, type KfHook } from '../support/fixtures';

/** Loading, compiling and the fades take a few seconds; software renderers take much longer. */
const UNIVERSE_TIMEOUT = 90_000;
/** A date inside the Moon table's span, so the sky does not depend on the day the test runs. */
const JD = '2461336.75';

const html = (page: Page) => page.locator('html');

async function waitForUniverse(page: Page): Promise<void> {
  await expect(html(page)).toHaveAttribute('data-universe-ready', 'true', { timeout: UNIVERSE_TIMEOUT });
  await expect(html(page)).toHaveAttribute('data-experience', 'universe');
}

async function waitForFilm(page: Page, chapter: string): Promise<void> {
  await expect(html(page)).toHaveAttribute('data-chapter-ready', chapter, { timeout: UNIVERSE_TIMEOUT });
  await expect(html(page)).toHaveAttribute('data-experience', 'film');
  await expect(html(page)).not.toHaveAttribute('data-universe-ready', /.*/);
}

const stats = (page: Page): Promise<FrameStats> => page.evaluate(() => (window as unknown as KfHook).__kf.frameStats());
const filmClock = (page: Page): Promise<{ chapter: string | null; time: number; paused: boolean }> =>
  page.evaluate(() => {
    const { app } = (window as unknown as KfHook).__kf;
    return { chapter: app.chapter, time: app.time, paused: app.paused };
  });

test('#/universe reaches data-universe-ready and draws the solar system', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe', { query: { jd: JD } });
  await waitForUniverse(page);
  await expect(page.getByTestId('universe')).toBeVisible();
  await expect(page.getByTestId('universe-readout')).toContainText(/Earth/i);
  await expect(page.getByTestId('timeline')).toBeHidden();
  const view = await page.evaluate(() => (window as unknown as KfHook).__kf.universe.state());
  expect(view?.focus).toBe('earth');
  // True scale: the Earth's radius and a real distance from it.
  expect(view?.distanceKm).toBeGreaterThan(6_378);
  await expectCanvasNotBlank(page);
  expect(pageErrors).toEqual([]);
});

test('a deep link to a body opens on it, at the date it pins', async ({ page, kf, pageErrors }) => {
  await kf.open(`/universe/saturn?jd=${JD}`);
  await waitForUniverse(page);
  const view = await page.evaluate(() => (window as unknown as KfHook).__kf.universe.state());
  expect(view?.focus).toBe('saturn');
  // The pinned UTC date, as TDB (69.2 s later) and moving on in real time since.
  expect(view?.jdTdb ?? 0).toBeGreaterThan(Number(JD));
  expect(view?.jdTdb ?? 0).toBeLessThan(Number(JD) + 0.01);
  await expect(page.getByRole('button', { name: 'Saturn', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(pageErrors).toEqual([]);
});

test('five round trips ch07 -> universe -> ch07 resume the film where it was and keep GPU memory stable', async ({ page, kf, pageErrors }) => {
  test.setTimeout(420_000);
  await kf.openChapter('ch07', { t: 150, query: { jd: JD } });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.pause();
  });
  const before = await filmClock(page);
  expect(before.chapter).toBe('ch07');

  const memory: Array<FrameStats['memory']> = [];
  for (let round = 0; round < 5; round += 1) {
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.openUniverse();
    });
    await waitForUniverse(page);
    await expect(page).toHaveURL(/#\/universe$/);
    // Back with Esc on odd rounds, with the interface's own button on even ones.
    if (round % 2 === 1) await page.keyboard.press('Escape');
    else await page.getByTestId('universe-back').click();
    await waitForFilm(page, 'ch07');
    const after = await filmClock(page);
    expect(after.chapter).toBe('ch07');
    expect(after.time, `round ${round}: the film resumes where it was`).toBeCloseTo(before.time, 6);
    expect(after.paused).toBe(true);
    // Let a few frames render so renderer.info reflects the chapter on screen.
    await page.waitForTimeout(400);
    memory.push((await stats(page)).memory);
  }
  // The explorer is kept after its first visit (as a prefetched chapter is), so the first round
  // sets the level and every later round must return to it exactly.
  const [first] = memory;
  expect(first?.geometries ?? 0).toBeGreaterThan(0);
  expect(first?.textures ?? 0).toBeGreaterThan(0);
  for (const [round, m] of memory.entries()) expect(m, `round ${round}`).toEqual(first);
  expect(pageErrors).toEqual([]);
});

test('back and forward move between a chapter and the explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000);
  await kf.openChapter('ch08', { t: 40, query: { jd: JD } });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.pause();
  });
  const before = await filmClock(page);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.openUniverse('moon');
  });
  await waitForUniverse(page);
  await expect(page).toHaveURL(/#\/universe\/moon$/);

  await page.goBack();
  await waitForFilm(page, 'ch08');
  expect((await filmClock(page)).time).toBeCloseTo(before.time, 6);
  await expect(page).toHaveURL(/#\/ch\/8$/);

  await page.goForward();
  await waitForUniverse(page);
  const view = await page.evaluate(() => (window as unknown as KfHook).__kf.universe.state());
  expect(view?.focus).toBe('moon');
  expect(pageErrors).toEqual([]);
});

test('an explorer that cannot load says so and hands back to the film it was opened from', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000);
  // The explorer's code (its engine and interface chunks) never arrives, as on a dropped connection.
  await page.route(/\/assets\/explore-[^/]+\.js$/, (route) => route.abort());
  await kf.openChapter('ch07', { t: 150, query: { jd: JD } });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.pause();
  });
  const before = await filmClock(page);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.openUniverse();
  });
  await expect(page.getByTestId('error')).toContainText(/explorer could not be loaded/i);
  await waitForFilm(page, 'ch07');
  const after = await filmClock(page);
  expect(after.time).toBeCloseTo(before.time, 6);
  expect(after.paused).toBe(true);
  // The explorer's address is replaced, so Back does not lead into it again.
  await expect(page).toHaveURL(/#\/ch\/7$/);
  // The failure is logged (with the browser's failed requests), but nothing throws.
  expect(pageErrors.some((error) => error.includes('solar system explorer failed'))).toBe(true);
  expect(pageErrors.filter((error) => error.startsWith('pageerror'))).toEqual([]);
});

test('the welcome screen offers the explorer, and leaving it from a deep link goes home', async ({ page, kf, pageErrors }) => {
  await kf.open('/', { query: { jd: JD } });
  await page.getByTestId('intro').getByTestId('open-universe').click();
  await waitForUniverse(page);
  await expect(page.getByTestId('universe-back')).toHaveText(/start/i);
  // Flying to another body from the list changes the focus (an eased flight, not a jump).
  await page.getByRole('button', { name: 'Jupiter', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.focus)).toBe('jupiter');
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.travelling)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(html(page)).toHaveAttribute('data-experience', 'film', { timeout: UNIVERSE_TIMEOUT });
  await expect(page.getByTestId('intro')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/');
  expect(pageErrors).toEqual([]);
});
