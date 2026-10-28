/**
 * The assistant's panel on a phone (the "mobile" project: Pixel 7 emulation, 412×839, touch): a
 * bottom sheet on a modal <dialog class="kf-dialog">.
 * - Layout on the start, in a chapter, in the explorer and in the laboratory: the sheet covers none
 *   of the header, the timeline, the explorer's way back, readout or navigator (the laboratory's
 *   navigator stays tall even folded, so there the sheet comes up over it, inert behind the modal);
 *   nothing scrolls sideways and no text is cut off.
 * - "Fly to Mars": while the flight runs the sheet minimises to a bar that is not modal, so the scene
 *   is in sight; the bar shows the conversation again, and Undo returns.
 * - "What if the Sun were twice as massive?": the card waits in the open sheet (Confirm in sight),
 *   and the sheet minimises when the confirmed experiment runs.
 * - Esc closes it, and focus goes back to Ask.
 * - axe: no serious or critical violations in the open sheet.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { ask, LIVE, openPanel, panel, ready, realErrors, s } from './support/ai';
import { SLOW } from './support/env';
import { expect, test, type KfHook } from './support/fixtures';
import { boxes, chromeCovered, clippedText, sidewaysOverflow, type ChromeName } from './support/panel-layout';
import { waitForUniverse } from './support/universe';

test.use({ reducedMotion: 'reduce' });

/* eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures argument destructured even when none is used. */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'runs on the mobile project');
  test.setTimeout(240_000 * SLOW);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const isModal = (page: Page): Promise<boolean> => page.evaluate(() => document.querySelector('dialog.kf-ai')?.matches(':modal') ?? false);

async function checkSheet(page: Page, label: string, except: readonly ChromeName[] = []): Promise<void> {
  await openPanel(page);
  expect(await isModal(page), `${label}: a modal sheet`).toBe(true);
  await expect
    .poll(
      async () => {
        const { box } = await boxes(page, { box: '[data-testid="ai-panel"]' });
        return box ? chromeCovered(page, box, except) : ['no panel'];
      },
      { message: `${label}: the sheet covers no chrome`, timeout: 10_000 },
    )
    .toEqual([]);
  expect(await sidewaysOverflow(page), `${label}: the page scrolls sideways`).toBe(0);
  expect(await clippedText(page, '[data-testid="ai-panel"]'), `${label}: text cut off`).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId('ask')).toBeFocused();
}

test('the sheet stands clear of the chrome on the start, in a chapter, in the explorer and in the laboratory', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await checkSheet(page, 'start');
  await kf.openChapter('ch02', { autoplay: true, t: 20 });
  await checkSheet(page, 'chapter');
  await openPanel(page);
  await ask(page, 'Escape speed of Mars');
  await ask(page, 'Show verse 21:30');
  await checkSheet(page, 'chapter, with answers');
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.openUniverse('earth');
  });
  await waitForUniverse(page);
  await checkSheet(page, 'explorer');
  await page.evaluate(async () => {
    await (await (window as unknown as KfHook).__kf.ai.start()).ask('open the lab');
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), LIVE).toBe(10);
  await checkSheet(page, 'laboratory', ['navigator']);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('"Fly to Mars": the sheet minimises while the flight runs, comes back from its bar, and Undo returns', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  const input = page.getByTestId('ai-input');
  await input.fill('Fly to Mars');
  await input.press('Enter');
  // Minimised: a bar, not modal, so the scene can be watched and touched.
  await expect(panel(page)).toHaveClass(/is-minimised/u, LIVE);
  expect(await isModal(page)).toBe(false);
  await expect(page.getByTestId('ai-input')).toBeHidden();
  await expect(page.getByTestId('ai-minimise')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ai-minimise')).toHaveAccessibleName(s('ai.ui.restore'));
  await waitForUniverse(page);
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.focus)).toBe('mars');
  const bar = await boxes(page, { box: '[data-testid="ai-panel"]' });
  expect(bar.box ? bar.box.bottom - bar.box.top : 999, 'the bar is small').toBeLessThan(120);
  expect(bar.box ? await chromeCovered(page, bar.box) : ['no bar']).toEqual([]);

  await page.getByTestId('ai-minimise').tap();
  await expect(panel(page)).not.toHaveClass(/is-minimised/u);
  expect(await isModal(page)).toBe(true);
  const turn = page.getByTestId('ai-log').locator(':scope > li').last();
  await expect(turn).toHaveAttribute('data-state', 'done');
  await turn.getByTestId('ai-undo').tap();
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()), LIVE).toBeNull();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByTestId('ask')).toBeFocused();
  expect(realErrors(pageErrors)).toEqual([]);
});

test('an experiment’s card waits in the open sheet; the sheet minimises when the confirmed experiment runs', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  await page.evaluate(async () => {
    await (await (window as unknown as KfHook).__kf.ai.start()).ask('open the lab');
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), LIVE).toBe(10);
  await openPanel(page);
  const turn = await ask(page, 'What if the Sun were twice as massive?', 'awaiting-confirmation');
  await page.waitForTimeout(500);
  await expect(panel(page)).not.toHaveClass(/is-minimised/u);
  expect(await isModal(page)).toBe(true);
  const confirm = turn.getByTestId('ai-confirm');
  await expect(confirm).toBeVisible();
  await confirm.tap();
  await expect(panel(page)).toHaveClass(/is-minimised/u, LIVE);
  expect(await isModal(page)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.find((b) => b.id === 'sun')?.massKg ?? 0), LIVE).toBeGreaterThan(3e30);
  await page.getByTestId('ai-minimise').tap();
  await expect(turn).toHaveAttribute('data-state', 'done', LIVE);
  await expect(turn.getByTestId('ai-action')).toHaveAttribute('data-status', 'done');
  expect(realErrors(pageErrors)).toEqual([]);
});

test('axe: the open sheet, with answers, has no serious or critical violations', async ({ page, kf }, testInfo) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  await ask(page, 'Show verse 21:30');
  await ask(page, 'Escape speed of Mars');
  await page.getByTestId('ai-settings').locator('summary').tap();
  const results = await new AxeBuilder({ page }).include('[data-testid="ai-panel"]').withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-ai-sheet.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ rule: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(' ')) }));
  expect(serious).toEqual([]);
});
