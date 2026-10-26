/**
 * Plain-words help (src/ui/explore/help.ts, help-popover.ts) in the browser: the navigator's "?"
 * buttons open an explanation beside them (from src/i18n/en.help.json), by mouse, keyboard or touch;
 * Esc, the close button, a press elsewhere or the same "?" closes it, focus going back to the "?";
 * a "?" never does what the control beside it does (no flight, no section opened, no value changed);
 * it stays inside the screen on a phone; and axe finds nothing with one open.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const help = JSON.parse(readFileSync(new URL('../../src/i18n/en.help.json', import.meta.url), 'utf8')) as Record<string, string>;
const popover = (page: Page) => page.getByTestId('help-popover');

test('a "?" explains in plain words, closes by Esc, the close button, a press elsewhere or itself, and does nothing else', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/jupiter', { query: { jd: JD } });
  await waitForUniverse(page);
  const before = await view(page);
  // The list's distance "?": the explanation, and no flight (the list's rows are the buttons that fly).
  const distance = page.getByTestId('help-distance');
  await distance.click();
  await expect(popover(page)).toBeVisible();
  await expect(page.getByTestId('help-text')).toHaveText(help['help.distance'] ?? '');
  await expect(distance).toHaveAttribute('aria-expanded', 'true');
  expect((await view(page))?.focus).toBe(before?.focus);
  // Esc closes it, focus back on its "?".
  await page.keyboard.press('Escape');
  await expect(popover(page)).toBeHidden();
  await expect(distance).toBeFocused();
  await expect(distance).toHaveAttribute('aria-expanded', 'false');
  // By keyboard: Enter opens it, its close button closes it.
  await distance.press('Enter');
  await expect(popover(page)).toBeVisible();
  await popover(page).getByRole('button').click();
  await expect(popover(page)).toBeHidden();
  // A press elsewhere closes it; the same "?" again closes it.
  await distance.click();
  await expect(popover(page)).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(popover(page)).toBeHidden();
  await distance.click();
  await distance.click();
  await expect(popover(page)).toBeHidden();
  // In the About section a term's "?" explains the term and leaves the section as it was.
  const about = page.getByTestId('universe-about');
  await about.locator('summary').click();
  await expect(about).toHaveAttribute('open', '');
  await page.getByTestId('help-gravity').click();
  await expect(page.getByTestId('help-text')).toHaveText(help['help.gravity'] ?? '');
  await expect(about).toHaveAttribute('open', '');
  // The world itself, in a few plain words.
  await page.getByTestId('help-body.jupiter').click();
  await expect(page.getByTestId('help-text')).toHaveText(help['help.body.jupiter'] ?? '');
  // Opening one closes the other; axe finds nothing with one open.
  await expect(page.locator('[data-testid="help-popover"]:not([hidden])')).toHaveCount(1);
  const results = await new AxeBuilder({ page }).include('.kf-nav').include('[data-testid="help-popover"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect((await view(page))?.focus).toBe(before?.focus);
  expect(pageErrors).toEqual([]);
});

test('in the laboratory a fact’s "?" stays open as the run rewrites its figures, and changes nothing', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect.poll(async () => (await view(page))?.lab?.bodies.length ?? 0, LIVE).toBe(10);
  await page.getByTestId('lab-body-earth').click();
  await expect(page.getByTestId('lab-fact-mass')).toBeVisible(LIVE);
  const massBefore = (await view(page))?.lab?.bodies.find((b) => b.id === 'earth')?.massKg;
  await page.getByTestId('lab-facts').getByTestId('help-mass').click();
  await expect(page.getByTestId('help-text')).toHaveText(help['help.mass'] ?? '');
  // The run goes on (a day a second) and the facts are rewritten; the explanation stays.
  const t0 = (await view(page))?.lab?.elapsedS ?? 0;
  await expect.poll(async () => ((await view(page))?.lab?.elapsedS ?? 0) - t0, LIVE).toBeGreaterThan(86_400);
  await expect(popover(page)).toBeVisible();
  expect((await view(page))?.lab?.bodies.find((b) => b.id === 'earth')?.massKg).toBe(massBefore);
  // A section's "?" (inside it, at its top corner) explains it and leaves it open.
  const climate = page.getByTestId('lab-climate');
  await climate.locator('summary').click();
  await page.getByTestId('help-climate').click();
  await expect(page.getByTestId('help-text')).toHaveText(help['help.climate'] ?? '');
  await expect(climate).toHaveAttribute('open', '');
  expect(pageErrors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 740 }, hasTouch: true });

  test('a "?" opens by touch, its explanation inside the screen', async ({ page, kf, pageErrors }) => {
    test.setTimeout(150_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    const toggle = page.getByTestId('universe-nav-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    const sound = page.getByTestId('help-sound');
    await sound.scrollIntoViewIfNeeded();
    await sound.tap();
    await expect(popover(page)).toBeVisible();
    const box = await popover(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(740);
    // The sound itself untouched.
    await expect(page.getByTestId('universe-sound')).toHaveAttribute('aria-pressed', 'true');
    expect(pageErrors).toEqual([]);
  });
});
