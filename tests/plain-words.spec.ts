/**
 * The verses in plain words (src/ui/scripture.ts, cue-text.ts, verse-english.ts). In the notes every
 * verse keeps its translation exactly as data/quran.json has it, with its translator named, and below
 * the attribution a separate block labelled as an explanation, not a translation. The switch at the top
 * of the notes' text layer puts the explanation on the film's verse cards in the translation's place,
 * under a label that says what it is; the choice is remembered, and the Arabic stays verbatim either way.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import type { SourcesFile, VerseKey } from '../src/core/types';
import { expectVersesVerbatim } from './support/arabic';
import { chapterContent, panelVerseKeys, quranByKey } from './support/data';
import { SLOW } from './support/env';
import { expect, test, type KfHook } from './support/fixtures';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const en = read('../src/i18n/en.json') as Record<string, string>;
const chapters = read('../src/i18n/en.plain.json') as Record<string, string>;
const sources = read('../data/sources.json') as SourcesFile;
const quran = quranByKey();

const text = (locator: Locator): Promise<string | null> => locator.evaluate((el) => el.textContent);
const paused = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as KfHook).__kf.app.paused);

async function pause(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(() => paused(page)).toBe(true);
}

test('in the notes each verse keeps its translation verbatim and attributed, with its explanation apart and labelled', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  const content = chapterContent('ch07');
  await kf.openChapter('ch07', { autoplay: true, t: 1 });
  await pause(page);
  await kf.ensurePanelOpen();
  const keys = panelVerseKeys(content);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    const entry = quran.get(key);
    const article = page.getByTestId('panel').locator(`article[data-verse="${key}"]`);
    // The translation, word for word, and its translator.
    expect(await text(article.locator('blockquote.kf-translation')), `${key} translation verbatim`).toBe(entry?.translation);
    const translator = sources.sources.find((s) => s.id === entry?.source.translation);
    await expect(article.locator('.kf-attrib')).toContainText(translator?.author ?? translator?.title ?? '?');
    // The explanation: its own labelled block after the attribution, never inside the translation's quotation.
    const plain = article.getByTestId('verse-plain');
    await expect(plain).toHaveAttribute('role', 'group');
    await expect(plain).toHaveAccessibleName(en['ui.verse.plainLabel'] ?? '?');
    expect(await text(plain.locator('.kf-plain-text')), `${key} explanation`).toBe(chapters[`plain.${key}`]);
    await expect(plain.locator('.kf-plain-note')).toHaveText(en['ui.verse.plainNote'] ?? '?');
    await expect(article.locator('blockquote [data-testid="verse-plain"]')).toHaveCount(0);
    const order = await article.evaluate((el) => [...el.children].map((c) => c.className));
    expect(order.indexOf('kf-attrib'), `${key}: the explanation follows the attribution`).toBeLessThan(order.indexOf('kf-plain'));
  }
  await expectVersesVerbatim(page, content);
  const results = await new AxeBuilder({ page }).include('[data-testid="layer-text"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the switch puts the plain words on the film’s verse card in the translation’s place, labelled, and is remembered', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  const key: VerseKey = '51:47';
  const cue = chapterContent('ch04').cues.find((c) => c.type === 'verse' && c.key === key);
  expect(cue).toBeDefined();
  await kf.openChapter('ch04', { autoplay: true, t: (cue?.t ?? 0) + 2 });
  await pause(page);
  const card = page.getByTestId('verse-overlay').locator(`.kf-card[data-verse="${key}"]`);
  // By default: the translation.
  await expect(card).toBeVisible({ timeout: 30_000 * SLOW });
  await expect(card).not.toHaveAttribute('data-plain');
  expect(await text(card.locator('.kf-card-translation'))).toBe(quran.get(key)?.translation);
  await kf.ensurePanelOpen();
  const toggle = page.getByTestId('verse-plain-switch');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAccessibleName(en['ui.verse.plainSwitch'] ?? '?');
  await expect(toggle).toHaveAccessibleDescription(en['ui.verse.plainSwitchHint'] ?? '?');
  // Switched on (by keyboard): the card fades out and back with the explanation under its label.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const plainCard = page.getByTestId('verse-overlay').locator(`.kf-card[data-verse="${key}"][data-plain]`);
  await expect(plainCard).toBeVisible();
  await expect(plainCard.locator('.kf-card-plain-label')).toHaveText(en['ui.verse.plainCard'] ?? '?');
  expect(await text(plainCard.locator('.kf-card-plain'))).toBe(chapters[`plain.${key}`]);
  await expect(plainCard.getByText(quran.get(key)?.translation ?? '?', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('verse-overlay').locator('.kf-card')).toHaveCount(1);
  // The notes still give the translation.
  expect(await text(page.getByTestId('panel').locator(`article[data-verse="${key}"] blockquote.kf-translation`))).toBe(quran.get(key)?.translation);
  await expectVersesVerbatim(page, chapterContent('ch04'));
  // Remembered across a fresh load.
  await page.goto('about:blank');
  await kf.openChapter('ch04', { autoplay: true, t: (cue?.t ?? 0) + 2 });
  await pause(page);
  await expect(plainCard).toBeVisible({ timeout: 30_000 * SLOW });
  await kf.ensurePanelOpen();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Switched off: the translation is back.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(card).not.toHaveAttribute('data-plain');
  expect(await text(card.locator('.kf-card-translation'))).toBe(quran.get(key)?.translation);
  expect(pageErrors).toEqual([]);
});
