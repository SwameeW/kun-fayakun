/**
 * The navigator's About for the world in view (src/ui/explore/about, src/explore/about): its facts
 * as JPL gives them (the Sun's and the Moon's from their GM), its day and year, its orbit and tilt,
 * how far it is now, and a comparison to scale; it follows the world in view; axe finds nothing.
 * Reduced motion, so each flight lands at once.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { BodyId } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

test.use({ reducedMotion: 'reduce' });

async function goTo(page: Page, body: BodyId): Promise<void> {
  await page.evaluate((id) => {
    (window as unknown as KfHook).__kf.app.focusBody(id);
  }, body);
  await expect.poll(async () => {
    const v = await view(page);
    return v?.focus === body && !v.travelling;
  }, { timeout: 60_000 * SLOW }).toBe(true);
}

test('About a world: its facts from JPL, its day, year, orbit and tilt, now and to scale', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.open('/universe/jupiter', { query: { jd: JD } });
  await waitForUniverse(page);
  const about = page.getByTestId('universe-about');
  await about.locator('summary').click();
  await expect(about.locator('summary')).toHaveText('About Jupiter');
  const fact = (id: string) => about.getByTestId(`about-${id}`);
  await expect(fact('radius')).toHaveText(/^69,911\skm, 11 times the Earth’s$/);
  await expect(fact('mass')).toHaveText('1.9 × 10²⁷ kg, 318 times the Earth’s');
  await expect(fact('gravity')).toHaveText('24.8 m/s², 2.53 times the Earth’s');
  await expect(fact('escape')).toHaveText(/^60\.2\skm\/s$/);
  await expect(fact('day')).toHaveText(/^Turns once in 9\sh\s5\d\smin; sunrise to sunrise, 9\sh\s5\d\smin$/);
  await expect(fact('year')).toHaveText('11.86 Earth years (4,333 days)');
  await expect(fact('orbit')).toHaveText(/^5\.203\sAU from the Sun on average \(.+\skm\); eccentricity 0\.048; tilted 1\.3° to the Earth’s orbit$/);
  await expect(fact('tilt')).toHaveText('3.12°');
  await expect(fact('now')).toHaveText(/^\d\.\d{3}\sAU$/);
  await expect(about.locator('figcaption')).toHaveText('Jupiter beside Earth, to scale: 11 times as wide');
  await expect(about).toContainText('Sources: JPL Planetary Physical Parameters');
  const results = await new AxeBuilder({ page }).include('[data-testid="universe-about"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  // It follows the world in view: Venus turns backwards, slower than it goes round the Sun.
  await goTo(page, 'venus');
  await expect(about.locator('summary')).toHaveText('About Venus');
  await expect(fact('day')).toHaveText(/^Turns backwards once in 243\sdays; sunrise to sunrise, 117\sdays$/);
  await expect(fact('tilt')).toHaveText('177.4°');

  // The Sun's and the Moon's from their GM (DE440) and NAIF's radii.
  await goTo(page, 'sun');
  await expect(fact('mass')).toHaveText('1.99 × 10³⁰ kg, 333,000 times the Earth’s');
  await expect(fact('gravity')).toHaveText('274.2 m/s², 28 times the Earth’s');
  await expect(fact('day')).toHaveText(/^Turns once in 25\.38\sdays at its equator$/);
  await goTo(page, 'moon');
  await expect(fact('orbit')).toHaveText(/^Once round the Earth in 27\.32\sdays, keeping one face toward it$/);
  await expect(fact('now')).toHaveText(/^\d{3},\d{3}\skm$/);
  await expect(about.locator('figcaption')).toHaveText('Moon beside Earth, to scale: 0.273 of its width');
  expect(pageErrors).toEqual([]);
});
