/**
 * The hadith in two levels (src/ui/cue-text.ts, scripture.ts). In the film, Chapter 0 shows two short
 * cards instead of a card per narration: each a sourced summary under a label saying it is not a
 * quotation (no wording is shown until a person has entered and checked it), its references, and the
 * hadith of the Pen's two gradings side by side. In the notes every narration keeps its own entry:
 * the summary, grading and grading notes first, and behind "Source details" the narrator, why the
 * wording is not shown, and the link to sunnah.com.
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { HadithFile } from '../src/core/types';
import { chapterContent } from './support/data';
import { SLOW } from './support/env';
import { expect, test, type KfHook } from './support/fixtures';

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const en = read('../src/i18n/en.json') as Record<string, string>;
const chapters = read('../src/i18n/en.chapters.json') as Record<string, string>;
const hadith = new Map((read('../data/hadith.json') as HadithFile).hadith.map((e) => [e.id, e]));
const ref = (id: string): string => `${hadith.get(id)?.collection ?? '?'} ${hadith.get(id)?.number ?? '?'}`;

async function pause(page: Page): Promise<void> {
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.paused)).toBe(true);
}

test('Chapter 0’s film shows two short hadith cards: labelled summaries, their references, the Pen’s two gradings', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  const cues = chapterContent('ch00').cues.filter((c) => c.type === 'hadith');
  expect(cues.map((c) => [c.id, ...(c.also ?? [])])).toEqual([
    ['bukhari-3191', 'muslim-2653'],
    ['abudawud-4700', 'tirmidhi-2155'],
  ]);
  const overlay = page.getByTestId('verse-overlay');
  // The first: two narrations in the Sahih collections, named alone.
  await kf.openChapter('ch00', { autoplay: true, t: (cues[0]?.t ?? 0) + 2 });
  await pause(page);
  const first = overlay.locator('.kf-card[data-hadith="bukhari-3191"]');
  await expect(first).toBeVisible({ timeout: 30_000 * SLOW });
  await expect(first.locator('.kf-card-plain-label')).toHaveText(en['ui.hadith.summaryLabel'] ?? '?');
  await expect(first.locator('.kf-card-summary')).toHaveText(chapters['ch00.hadith.before.summary'] ?? '?');
  await expect(first.locator('.kf-card-ref')).toHaveText(`${ref('bukhari-3191')} · ${ref('muslim-2653')}`);
  await expect(first.locator('.kf-card-details')).toHaveText(en['ui.hadith.cardDetails'] ?? '?');
  // No quotation: no quotation marks, no blockquote, no wording.
  await expect(first.locator('blockquote, q')).toHaveCount(0);
  expect(await first.textContent()).not.toMatch(/[“”"]/);
  // The second: the hadith of the Pen, each narration with its own grading and grader.
  await page.goto('about:blank');
  await kf.openChapter('ch00', { autoplay: true, t: (cues[1]?.t ?? 0) + 2 });
  await pause(page);
  const pen = overlay.locator('.kf-card[data-hadith="abudawud-4700"]');
  await expect(pen).toBeVisible({ timeout: 30_000 * SLOW });
  await expect(pen.locator('.kf-card-summary')).toHaveText(chapters['ch00.hadith.pen.summary'] ?? '?');
  const graded = (id: string): string => `${ref(id)}, graded ${hadith.get(id)?.grading ?? '?'} by ${hadith.get(id)?.grader ?? '?'}`;
  await expect(pen.locator('.kf-card-ref')).toHaveText([graded('abudawud-4700'), graded('tirmidhi-2155')]);
  await expect(overlay.locator('.kf-card')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('in the notes each narration keeps its entry: summary and gradings first, the rest behind “Source details”', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.openChapter('ch00', { autoplay: true, t: 1 });
  await pause(page);
  await kf.ensurePanelOpen();
  const panel = page.getByTestId('panel');
  const ids = chapterContent('ch00').panel.text.flatMap((b) => (b.type === 'hadith' ? [b.id] : []));
  expect(ids).toEqual(['bukhari-3191', 'muslim-2653', 'abudawud-4700', 'tirmidhi-2155']);
  for (const id of ids) {
    const entry = hadith.get(id);
    const article = panel.locator(`article.kf-hadith[data-hadith="${id}"]`);
    await expect(article.locator('h3')).toHaveText(ref(id));
    await expect(article.locator('.kf-grading')).toBeVisible();
    await expect(article.locator('.kf-grading')).toContainText(entry?.grading ?? '?');
    // A note on the grading stays in view, so gradings that differ are plain to see.
    if (entry?.disputedNote) await expect(article.locator('.kf-note').first()).toContainText(entry.disputedNote);
    // The rest, on request.
    const source = article.getByTestId('hadith-source');
    await expect(source).not.toHaveAttribute('open');
    await expect(source.locator('.kf-pending')).toBeHidden();
    await source.locator('summary').click();
    await expect(source).toHaveAttribute('open', '');
    await expect(source.locator('.kf-meta').first()).toContainText(entry?.narrator ?? '?');
    await expect(source.locator('.kf-pending')).toHaveText(en['ui.hadith.pending'] ?? '?');
    await expect(source.locator('.kf-link a')).toHaveAttribute('href', `https://sunnah.com/${entry?.sunnahKey ?? '?'}`);
    for (const parallel of entry?.parallels ?? []) await expect(source.locator(`a[href="https://sunnah.com/${parallel}"]`)).toBeVisible();
  }
  // Both gradings of the hadith of the Pen, in view at once.
  await expect(panel.locator('article[data-hadith="abudawud-4700"] .kf-grading')).toContainText('al-Albani');
  await expect(panel.locator('article[data-hadith="tirmidhi-2155"] .kf-grading')).toContainText('Gharib');
  const results = await new AxeBuilder({ page }).include('[data-testid="layer-text"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
