/**
 * "Each in an orbit" (docs/SPEC.md, Chapter 7): the visitor-led letter analysis opens and
 * closes by keyboard, reads the seven base letters both ways (the same sequence), keeps the
 * verses untouched, and passes axe with the panel and the analysis open.
 */
import AxeBuilder from '@axe-core/playwright';
import { chapterContent, normalizeSpace, quranByKey } from './support/data';
import { expect, test } from './support/fixtures';

const NAMES = ['kāf', 'lām', 'fāʾ', 'alif maqṣūra', 'fāʾ', 'lām', 'kāf'];

test('the letter analysis opens by keyboard, reads both ways and closes with Escape', async ({ page, kf }) => {
  const content = chapterContent('ch07');
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  const opener = page.getByRole('button', { name: 'Explore the letters of this phrase' });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  await page.keyboard.press('Enter');
  const region = page.getByTestId('discovery');
  await expect(region).toBeVisible();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');

  // Seven tiles, each named with its position and its mirrored partner; real DOM text.
  const tiles = region.locator('.kf-discovery-tile');
  await expect(tiles).toHaveCount(7);
  await expect(tiles.nth(0)).toHaveAttribute('aria-label', 'kāf, letter 1 of 7, pairs with letter 7');
  await expect(tiles.nth(3)).toHaveAttribute('aria-label', 'alif maqṣūra, letter 4 of 7, the centre');
  for (const letter of await region.locator('.kf-discovery-letter').all()) {
    await expect(letter).toHaveAttribute('lang', 'ar');
    await expect(letter).toHaveAttribute('dir', 'rtl');
    await expect(letter).toHaveAttribute('translate', 'no');
  }

  // Both readings are listed as letter names, and they are the same sequence.
  const readings = region.locator('.kf-discovery-readings dd');
  await expect(readings.nth(0)).toHaveText(NAMES.join(', '));
  await expect(readings.nth(1)).toHaveText([...NAMES].reverse().join(', '));
  await region.getByRole('button', { name: 'Read left to right' }).click();
  await expect(region.locator('.kf-discovery-live')).toContainText('Left to right');

  // The analysis is labelled as such.
  await expect(region).toContainText('This is not the Quranic text as written.');

  // The verses in the text layer are untouched while it runs.
  const ayat = quranByKey();
  for (const key of ['36:40', '21:33'] as const) {
    const entry = ayat.get(key);
    const article = page.locator(`[data-verse="${key}"] [lang="ar"]`).first();
    if ((await article.count()) > 0 && entry) await expect(article).toHaveText(normalizeSpace(entry.arabic));
  }
  expect(content.panel.discovery).toBe('kullun-fi-falak');

  // Escape closes it and returns focus to the button that opened it.
  await tiles.nth(0).focus();
  await page.keyboard.press('Escape');
  await expect(region).toBeHidden();
  await expect(opener).toBeFocused();
});

test('the letter analysis has no accessibility violations', async ({ page, kf }) => {
  await kf.openChapter('ch07', { autoplay: true, t: 150 });
  await kf.ensurePanelOpen();
  await page.getByRole('button', { name: 'Explore the letters of this phrase' }).click();
  await expect(page.getByTestId('discovery')).toBeVisible();
  const results = await new AxeBuilder({ page }).include('[data-testid="discovery"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
