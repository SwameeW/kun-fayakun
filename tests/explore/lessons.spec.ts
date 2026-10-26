/**
 * Lessons in the orbital laboratory (ledger CR-4), in the browser: Kepler's third law (a year 2.828
 * times as long at twice the distance), escape speed (an orbit opened by a push past it), and a
 * Hohmann transfer (its first burn planned and run, the orbit's far side reaching geostationary
 * height, the autopilot's second burn planned), each set up from the start. Steps wait for their
 * experiment and go in order, each once (presses in bursts change nothing more); the first figures
 * are kept once the first edit is made, so a torn Moon's lesson never shows an empty step; the steps
 * are a numbered list beside their buttons; and the torn Moon's pieces' names never overlap.
 */
import type { Page } from '@playwright/test';
import type { UniverseLab } from '../../src/core/types';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { spam } from '../support/layout';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const steps = (page: Page) => page.getByTestId('lab-lesson-steps');
/** The words of each step on show (an item shown with no words is a defect: the empty "1."). */
const shownTexts = (page: Page): Promise<string[]> => steps(page).locator('li').evaluateAll((items) => items.filter((li) => !(li as HTMLElement).hidden).map((li) => (li.querySelector('p:not([hidden])')?.textContent ?? '') + (li.querySelector('button') ? '[button]' : '')));

async function openLessons(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await page.getByTestId('lab-lessons').locator('summary').click();
}

test('lessons: Kepler’s third law, escape speed and a Hohmann transfer, each from the start', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await page.getByTestId('lab-lessons').locator('summary').click();

  // Kepler: a star and a planet, the planet moved out to twice its distance; its year 2.828 times as long.
  await page.getByTestId('lab-lesson-kepler').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id).join(), LIVE).toBe('star,planet');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('The planet goes round once every');
  const before = (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.periodS ?? 0;
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => ((await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.periodS ?? 0) / before, LIVE).toBeCloseTo(2 ** 1.5, 3);
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('2.828 times as long');

  // Escape: a push a little past escape speed opens the orbit.
  await page.getByTestId('lab-lesson-escape').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.bound, LIVE).toBe(true);
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.id === 'planet')?.orbit?.bound, LIVE).toBe(false);
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('It will not come back');

  // Hohmann: a ship at 7,000 km; the first burn planned and run; the far side at geostationary height.
  await page.getByTestId('lab-lesson-hohmann').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.fuelKg ?? 0, LIVE).toBe(18_000);
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('The transfer needs');
  await page.getByTestId('lab-lesson-step-1').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await page.getByTestId('lab-lesson-step-2').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 1, LIVE).toBe(0);
  const apo = (await lab(page))?.bodies.find((b) => b.ship !== null)?.orbit?.apoapsisKm ?? 0;
  expect(apo / 42_164).toBeGreaterThan(0.98);
  expect(apo / 42_164).toBeLessThan(1.02);
  await page.getByTestId('lab-lesson-step-3').click();
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await expect(page.getByTestId('lab-lesson-text-3')).toContainText('The autopilot’s burn');
  await page.getByTestId('lab-lesson-end').click();
  await expect(page.getByTestId('lab-lesson')).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('a lesson’s steps wait for its experiment, go in order and once each, and say beforehand what they will do', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLessons(page);
  // Kepler: begun, every step waits for the experiment, the first step's place saying it is being set up.
  await page.getByTestId('lab-lesson-kepler').click();
  for (const k of [1, 2]) await expect(page.getByTestId(`lab-lesson-step-${String(k)}`)).toBeDisabled();
  await expect(page.getByTestId('lab-lesson-text-0')).toHaveText(/Setting up the experiment|The planet goes round/);
  await expect(page.getByTestId('lab-lesson-step-1')).toBeEnabled(LIVE);
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('1 AU from its star');
  // In order: the second waits for the first; the first says beforehand what it will do; the second has no words yet.
  await expect(page.getByTestId('lab-lesson-step-2')).toBeDisabled();
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('2.83 times as long');
  await expect(page.getByTestId('lab-lesson-text-2')).toBeHidden();
  expect(await shownTexts(page)).not.toContain('');
  // Pressed twice within one task: one edit (the planet moved out once), the step then done.
  await spam(page.getByTestId('lab-lesson-step-1'), 2);
  await expect.poll(async () => (await lab(page))?.logLength, LIVE).toBe(1);
  await expect(page.getByTestId('lab-lesson-step-1')).toBeDisabled();
  await expect(page.getByTestId('lab-lesson-step-2')).toBeEnabled();
  await expect(page.getByTestId('lab-lesson-text-1')).toContainText('2.828 times as long', LIVE);
  // The first figures are kept as they were before the edit (not the planet's new distance).
  await expect(page.getByTestId('lab-lesson-text-0')).toContainText('1 AU from its star');
  expect((await lab(page))?.logLength).toBe(1);

  // Hohmann: the lesson pressed six times in a burst sets up once; its first burn, pressed twice, is planned once.
  await spam(page.getByTestId('lab-lesson-hohmann'), 6);
  await expect(page.getByTestId('lab-lesson-step-1')).toBeEnabled(LIVE);
  await expect.poll(async () => (await lab(page))?.logLength, LIVE).toBe(1);
  for (const k of [2, 3, 4]) {
    await expect(page.getByTestId(`lab-lesson-step-${String(k)}`)).toBeDisabled();
    await expect(page.getByTestId(`lab-lesson-text-${String(k)}`)).toBeHidden();
  }
  await spam(page.getByTestId('lab-lesson-step-1'), 2);
  await expect.poll(async () => (await lab(page))?.bodies.find((b) => b.ship !== null)?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await expect.poll(async () => (await lab(page))?.logLength, LIVE).toBe(2);
  await expect(page.getByTestId('lab-lesson-text-2')).toBeHidden();
  // Started again (pressed again and again), it is set up once more, from the start.
  await spam(page.getByTestId('lab-lesson-restart'), 10);
  await expect(page.getByTestId('lab-lesson-step-1')).toBeEnabled(LIVE);
  await expect.poll(async () => (await lab(page))?.logLength, LIVE).toBe(1);
  expect(await shownTexts(page)).not.toContain('');
  expect(pageErrors).toEqual([]);
});

test('the Roche limit: the Moon’s first figures stay once it is torn apart, the steps are a numbered list beside their buttons, and the pieces’ names never overlap', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await page.setViewportSize({ width: 1440, height: 900 });
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLessons(page);
  // The lessons to choose from: each title on one line, what it is about beneath it.
  for (const id of ['kepler', 'escape', 'hohmann', 'roche']) {
    const b = page.getByTestId(`lab-lesson-${id}`);
    const [name, what] = await Promise.all([b.locator('.kf-living-place-name').boundingBox(), b.locator('.kf-living-place-where').boundingBox()]);
    expect(name && what && name.y + name.height <= what.y + 1, id).toBe(true);
    expect(name?.height ?? 99, id).toBeLessThan(24);
  }
  await page.getByTestId('lab-lesson-roche').click();
  await expect(page.getByTestId('lab-lesson-step-1')).toBeEnabled(LIVE);
  await expect(page.getByTestId('lab-lesson-text-0')).toHaveText(/^The Moon is \d{3},\d{3}\skm from the Earth\. .*18,\d{3}\skm for a fluid moon/u);
  const first = await page.getByTestId('lab-lesson-text-0').textContent();
  // A numbered list: a small indent, a gap between steps, each step's words under its button.
  const layout = await steps(page).evaluate((ol) => {
    const items = [...ol.querySelectorAll(':scope > li')].filter((li) => !(li as HTMLElement).hidden);
    const gaps = items.slice(1).map((li, k) => li.getBoundingClientRect().top - (items[k]?.getBoundingClientRect().bottom ?? 0));
    const aligned = items.map((li) => {
      const b = li.querySelector('button')?.getBoundingClientRect();
      const p = li.querySelector('p')?.getBoundingClientRect();
      return b && p && p.height > 0 ? Math.abs(b.left - p.left) : 0;
    });
    return { indent: getComputedStyle(ol).paddingInlineStart, gaps, aligned };
  });
  expect(layout.indent).not.toBe('40px');
  for (const gap of layout.gaps) expect(gap).toBeGreaterThanOrEqual(8);
  for (const d of layout.aligned) expect(d).toBeLessThanOrEqual(4);
  /** No two names on show (above a fifth of their opacity) sit on one another, sampled every frame for a while. */
  const apart = async (when: string, ms: number): Promise<void> => {
    const overlaps = await page.evaluate(async (until) => {
      const out = new Set<string>();
      const end = performance.now() + until;
      while (performance.now() < end) {
        const tags = [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || '1') > 0.2).map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
        for (let a = 0; a < tags.length; a += 1) {
          for (let b = a + 1; b < tags.length; b += 1) {
            const p = tags[a];
            const q = tags[b];
            if (p && q && Math.min(p.r.right, q.r.right) - Math.max(p.r.left, q.r.left) > 2 && Math.min(p.r.bottom, q.r.bottom) - Math.max(p.r.top, q.r.top) > 2) out.add(`${p.text} / ${q.text}`);
          }
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return [...out];
    }, ms);
    expect(overlaps, when).toEqual([]);
  };
  // The Moon moved inside the limit: the names hand over (the Moon's pointer at the edge going, its tag coming) without meeting.
  await page.getByTestId('lab-lesson-step-1').click();
  await apart('as the Moon moves in', 1500);
  await page.getByTestId('lab-lesson-step-2').click();
  await expect.poll(async () => (await lab(page))?.events.some((e) => e.kind === 'disrupt'), { timeout: 180_000 * SLOW }).toBe(true);
  // The names of the pieces (and the worlds') never sit on one another as they come and go round.
  await apart('as the Moon is torn apart', 3000);
  await expect(page.getByTestId('lab-lesson-text-2')).toContainText('Torn apart', LIVE);
  // The Moon is gone (its pieces have their own ids): its first figures stay, and no step is left empty.
  expect((await lab(page))?.bodies.some((b) => b.id === 'moon')).toBe(false);
  await expect(page.getByTestId('lab-lesson-text-0')).toHaveText(first ?? '');
  expect(await shownTexts(page)).not.toContain('');
  expect(pageErrors).toEqual([]);
});
