/**
 * axe-core scans of the home intro, each playable chapter with its panel open,
 * and the Sources page. Spec section 8 requires "axe passes", so any violation
 * of any impact fails the test; the full results are attached to the report.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { PLAYABLE_CHAPTERS, chapterContent, visibleTime } from './support/data';
import { expect, test } from './support/fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function expectNoViolations(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  const violations = results.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
  expect(violations, `axe violations on ${label}`).toEqual([]);
}

test('home intro has no accessibility violations', async ({ page, kf }, testInfo) => {
  await kf.open('/');
  await expect(page.getByTestId('intro')).toBeVisible();
  await expectNoViolations(page, testInfo, 'home');
});

for (const chapter of PLAYABLE_CHAPTERS) {
  test(`${chapter.id} with the panel open has no accessibility violations`, async ({
    page,
    kf,
  }, testInfo) => {
    const content = chapterContent(chapter.id);
    await kf.openChapter(chapter.id, { autoplay: true, t: visibleTime(content) });
    await kf.ensurePanelOpen();
    await expectNoViolations(page, testInfo, chapter.id);
  });
}

test('sources page has no accessibility violations', async ({ page, kf }, testInfo) => {
  await kf.open('/sources');
  await expect(page.getByTestId('sources-page')).toBeVisible();
  await expectNoViolations(page, testInfo, 'sources');
});

test('the solar-system explorer has no accessibility violations', async ({ page, kf }, testInfo) => {
  await kf.open('/universe/saturn', { query: { jd: '2461336.75' } });
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: 90_000 });
  await expect(page.getByTestId('universe-readout')).toBeVisible();
  await expectNoViolations(page, testInfo, 'universe');
});
