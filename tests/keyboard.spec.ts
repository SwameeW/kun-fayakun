/**
 * Keyboard-only run-through (spec section 7: full keyboard control, visible
 * focus, pause always available). Nothing in this test clicks.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, type KfHook } from './support/fixtures';
import { SLOW } from './support/env';

interface FocusTarget {
  /** CSS selector the focused element may match. */
  selector: string;
  /** Or: a case-insensitive pattern for its aria-label / text. */
  namePattern?: string;
}

/** Presses Tab until the focused element matches the target. */
async function tabTo(page: Page, target: FocusTarget, label: string, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(({ selector, namePattern }) => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      if (el.matches(selector)) return true;
      if (namePattern === undefined) return false;
      const name = el.getAttribute('aria-label') ?? el.textContent;
      return new RegExp(namePattern, 'iu').test(name);
    }, target);
    if (reached) return;
  }
  throw new Error(`Tab did not reach ${label} within ${maxPresses} presses`);
}

/** The focused element must match :focus-visible and draw an outline or ring. */
async function expectVisibleFocus(page: Page, label: string): Promise<void> {
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const style = getComputedStyle(el);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    return { focusVisible: el.matches(':focus-visible'), indicator: outline || style.boxShadow !== 'none' };
  });
  expect(focus, `${label} has focus`).not.toBeNull();
  expect(focus?.focusVisible, `${label} matches :focus-visible`).toBe(true);
  expect(focus?.indicator, `${label} draws an outline or focus ring`).toBe(true);
}

const appState = (page: Page): Promise<{ paused: boolean; time: number }> =>
  page.evaluate(() => {
    const { app } = (window as unknown as KfHook).__kf;
    return { paused: app.paused, time: app.time };
  });

async function expectState(html: Locator, state: string): Promise<void> {
  await expect(html).toHaveAttribute('data-state', state, { timeout: 60_000 });
}

test('keyboard-only run-through', async ({ page, kf }) => {
  test.setTimeout(240_000 * SLOW);
  const html = page.locator('html');

  await kf.open('/');
  await expect(page.getByTestId('intro')).toBeVisible();
  await tabTo(page, { selector: '[data-testid="begin"]' }, 'Begin');
  await expectVisibleFocus(page, 'Begin');

  await page.keyboard.press('Enter');
  await kf.waitForChapterReady('ch00');
  await expectState(html, 'playing');

  await page.keyboard.press('Space');
  await expect.poll(async () => (await appState(page)).paused, { message: 'Space pauses' }).toBe(true);
  const pausedAt = (await appState(page)).time;
  await page.waitForTimeout(600);
  expect((await appState(page)).time, 'chapter clock holds while paused').toBe(pausedAt);
  await page.keyboard.press('Space');
  await expect.poll(async () => (await appState(page)).paused, { message: 'Space resumes' }).toBe(false);

  await page.keyboard.press('ArrowRight');
  await kf.waitForChapterReady('ch01');
  await expect(html).toHaveAttribute('data-chapter', 'ch01');
  await expectState(html, 'playing');

  await page.keyboard.press('e');
  await expectState(html, 'explore');

  await page.keyboard.press('Escape');
  await expectState(html, 'playing');
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (document.activeElement?.closest('[data-testid="timeline"]') ?? null) !== null,
        ),
      { message: 'Esc returns focus to the timeline' },
    )
    .toBe(true);
  await expectVisibleFocus(page, 'timeline control after Esc');

  await tabTo(
    page,
    { selector: 'a[href*="#/sources"], [data-testid="sources-link"]', namePattern: '\\bsources\\b' },
    'the Sources link',
  );
  await expectVisibleFocus(page, 'Sources link');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sources-page')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/sources');
});
