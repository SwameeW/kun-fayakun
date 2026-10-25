import { expect, test, type KfHook } from '../support/fixtures';
import { expectCanvasNotBlank } from '../support/canvas';
import { JD, fly, step, view, waitForUniverse } from '../support/universe';
import { SLOW } from '../support/env';

const added = ['mercury', 'venus', 'mars', 'uranus', 'neptune'] as const;
for (const body of added) {
  test(`${body}: a deep link renders the world with sourced imagery and ten navigator entries`, async ({ page, kf, pageErrors }) => {
    await kf.open(`/universe/${body}`, { query: { jd: JD, detail: 'low' } });
    await waitForUniverse(page);
    await expect.poll(async () => (await view(page))?.focus).toBe(body);
    await expect(page.locator('.kf-nav-row')).toHaveCount(10);
    await expect(page.locator(`.kf-nav-row[data-body="${body}"] button`)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('universe-imagery')).toContainText(/NASA|Irwin|USGS/);
    await expect(page.locator('.kf-universe-altitude')).toContainText(/\d.*(?:km|AU).*above/);
    await expectCanvasNotBlank(page);
    expect(pageErrors).toEqual([]);
  });
}

test('travel to each added world arrives above its surface', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD, detail: 'low' } });
  await waitForUniverse(page);
  await step(page, 200);
  for (const body of added) {
    const trip = await fly(page, body);
    expect(trip.focus).toBe(body);
    expect(trip.hookAfter).toBe('arrived');
    expect(trip.lowestKm).toBeGreaterThan(0);
    expect(trip.endKm / trip.plannedEndKm).toBeCloseTo(1, 2);
  }
  expect(pageErrors).toEqual([]);
});

test('an explorer visit cannot reposition the film’s scripture annotations', async ({ page, kf }) => {
  await kf.openChapter('ch07', { t: 150, query: { jd: JD } });
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.openUniverse(); });
  await waitForUniverse(page);
  await page.getByTestId('universe-back').click();
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'film');
  const toggle = page.getByTestId('panel-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const annotation = page.locator('.kf-hadith .kf-note').first();
  await expect(annotation).toHaveCSS('position', 'static');
});
