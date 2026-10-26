/**
 * Down through an atmosphere where a probe went (ledger GR-6), in the browser: Venus's clouds with the
 * Pioneer Venus probes' readings (at one bar, between the two probes, and on the ground, where the
 * walk lands), and Jupiter's with the Galileo probe's (its winds, and where its signal stopped). The
 * readout's figures are the committed profiles' (public/assets/descent), read here as the explorer
 * reads them. Reduced motion, so the dips are cuts.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { createProfile, type DescentFile } from '../../src/explore/descent/profile';
import { JD, view, waitForUniverse } from '../support/universe';

test.use({ reducedMotion: 'reduce' });

const LIVE = { timeout: 60_000 * SLOW };
const ROOT = new URL('../../', import.meta.url);
const profile = (world: string) => createProfile(JSON.parse(readFileSync(new URL(`public/assets/descent/${world}.json`, ROOT), 'utf8')) as DescentFile);
const descentView = async (page: Page) => (await view(page))?.descent ?? null;
const command = (page: Page, c: object): Promise<void> =>
  page.evaluate((x) => {
    (window as unknown as KfHook).__kf.app.earthCommand(x as never);
  }, c);

test('down through Venus’s clouds with the Pioneer Venus probes: one bar near 50 km, between the probes, then the ground and a walk', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  const venus = profile('venus');
  await kf.open('/universe/venus', { query: { jd: JD } });
  await waitForUniverse(page);
  await expect(page.getByTestId('world-descent-entry')).toContainText('Pioneer Venus Large Probe');
  await page.getByTestId('world-descent').click();
  await expect.poll(async () => (await descentView(page))?.world ?? null, LIVE).toBe('venus');
  await expect(page.getByTestId('descent-hud')).toBeVisible(LIVE);
  await expect(page.getByTestId('descent-title')).toHaveText('Down through Venus’s clouds');
  // Held, then straight to one bar: the readout is the profile's there.
  await command(page, { kind: 'descentPad', climb: 0, held: true });
  await command(page, { kind: 'descentTo', pressureBar: 1 });
  await expect.poll(async () => Math.abs(((await descentView(page))?.pressureBar ?? 0) - 1), LIVE).toBeLessThan(1e-3);
  const d = await descentView(page);
  const expected = venus.at(d?.altitudeKm ?? 0);
  expect(d?.altitudeKm ?? 0).toBeGreaterThan(48);
  expect(d?.altitudeKm ?? 0).toBeLessThan(52);
  expect(d?.temperatureK).toBeCloseTo(expected.temperatureK, 6);
  expect(d?.densityKgM3).toBeCloseTo(expected.densityKgM3, 6);
  await expect(page.getByTestId('descent-height')).toContainText('km above Venus’s 6,052 km radius');
  await expect(page.getByTestId('descent-state')).toContainText('1 bar');
  await expect(page.getByTestId('descent-probe')).toContainText('Pioneer Venus Large Probe’s, measured as it went down on December 9, 1978');
  // Between the probes (64.8 to 70.5 km): said so.
  const gap = venus.file.gapKm ?? [0, 0];
  await command(page, { kind: 'descentTo', pressureBar: venus.at((gap[0] + gap[1]) / 2).pressureBar });
  await expect(page.getByTestId('descent-notice')).toContainText('Between the two probes’ readings');
  // To the ground: the Large Probe's last reading, then the walk lands there.
  await command(page, { kind: 'descentTo', pressureBar: 100 });
  await expect.poll(async () => (await view(page))?.walk?.world ?? null, LIVE).toBe('venus');
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  await expect.poll(async () => await descentView(page), LIVE).toBeNull();
  await expect(page.getByTestId('walk-title')).toHaveText('On foot on Venus');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await view(page))?.walk, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('down into Jupiter’s clouds with the Galileo probe: its winds, the one-bar level, and where its signal stopped; Esc back to orbit', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  const jupiter = profile('jupiter');
  await kf.open('/universe/jupiter', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('world-descent').click();
  await expect.poll(async () => (await descentView(page))?.world ?? null, LIVE).toBe('jupiter');
  await command(page, { kind: 'descentPad', climb: 0, held: true });
  await command(page, { kind: 'descentTo', pressureBar: 5 });
  await expect.poll(async () => Math.abs(((await descentView(page))?.pressureBar ?? 0) - 5), LIVE).toBeLessThan(5e-3);
  const d = await descentView(page);
  expect(d?.altitudeKm ?? 0).toBeLessThan(-40);
  expect(d?.windMs ?? 0).toBeCloseTo(jupiter.at(d?.altitudeKm ?? 0).windMs ?? -1, 6);
  await expect(page.getByTestId('descent-height')).toContainText('km below the 1-bar level');
  await expect(page.getByTestId('descent-wind')).toContainText('m/s from the west');
  // The bottom: 22 bar, where the probe's signal stopped.
  await command(page, { kind: 'descentTo', pressureBar: 30 });
  await expect.poll(async () => (await descentView(page))?.atBottom, LIVE).toBe(true);
  expect((await descentView(page))?.temperatureK).toBeCloseTo(428, 6);
  await expect(page.getByTestId('descent-notice')).toContainText('signal stopped here, at 22 bar');
  // Esc: back to orbit.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(async () => await descentView(page), LIVE).toBeNull();
  await expect(page.getByTestId('descent-hud')).toBeHidden({ timeout: 120_000 * SLOW });
  expect(pageErrors).toEqual([]);
});
