/**
 * Ships in the orbital laboratory (ledger SC-1, SC-3), in the browser: a ship added on a circular
 * orbit about the Earth, its rocket read out (propellant, change of speed left by the rocket
 * equation), a prograde burn planned by its change of speed, the burn run as the time runs (the
 * propellant spent, the orbit's far side raised, the note that the rocket adds energy), and a burn
 * planned for later and called off. The physics is checked in tests/unit/ships.spec.ts.
 */
import type { Page } from '@playwright/test';
import type { UniverseLab } from '../../src/core/types';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const shipOf = async (page: Page) => (await lab(page))?.bodies.find((b) => b.ship !== null) ?? null;
/**
 * Paused, and its snapshots settled: the step the same twice, a fifth of a second apart. (The pause is
 * the panel's at once, the worker's a moment later; a figure read between the two belongs to a step
 * the experiment then passes, and on an orbit the Earth's oblateness swings the osculating elements.)
 */
const settled = async (page: Page): Promise<void> => {
  let step = -1;
  await expect
    .poll(async () => {
      const now = (await lab(page))?.step ?? -2;
      const same = now === step;
      step = now;
      return same;
    }, { ...LIVE, intervals: [200] })
    .toBe(true);
};
/** The time machine's Space, with no control focused (Space would press a focused button instead). */
const playPause = async (page: Page): Promise<void> => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
};

test('a ship about the Earth: its rocket read out, a prograde burn planned and run, a later burn called off', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  // Paused while it is set up.
  await playPause(page);
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // Added at 7,000 km from the Earth's centre: 10 t dry, 10 t of propellant, 50 kN, 320 s.
  await page.getByTestId('lab-add-ship').locator('summary').click();
  await expect(page.getByTestId('lab-ship-primary')).toHaveValue('earth');
  await page.getByTestId('lab-ship-add').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.fuelKg ?? 0, LIVE).toBe(10_000);
  const ship = await shipOf(page);
  expect(ship?.primary).toBe('earth');
  expect(ship?.orbit?.e ?? 1).toBeLessThan(0.001);
  expect(ship?.orbit?.aKm ?? 0).toBeCloseTo(7000, -1);
  // 320 s x g0 x ln 2: 2,175 m/s of change of speed in it.
  expect(ship?.ship?.deltaVLeftMs ?? 0).toBeCloseTo(320 * 9.80665 * Math.log(2), 3);
  await expect(page.getByTestId('lab-ship')).toBeVisible();
  await expect(page.getByTestId('lab-ship-readout')).toContainText('2,175 m/s of change of speed');
  // Its own figures: the rocket's mass, and no size, escape speed or spin to show or edit (it pulls on nothing).
  await expect(page.getByTestId('lab-fact-mass')).toHaveText(/^20,000 kg with its propellant/u);
  for (const fact of ['lab-fact-radius', 'lab-fact-escape', 'lab-fact-rotation']) await expect(page.getByTestId(fact)).toHaveCount(0);
  await expect(page.getByTestId('lab-mass-input')).toBeHidden();
  await expect(page.getByTestId('lab-spin-period')).toBeHidden();
  // Its burn directions marked and named about it (ledger SC-2), seen with the camera on the Earth beside it.
  const shipId = (await shipOf(page))?.id ?? '';
  await page.getByTestId('lab-body-earth').click();
  await expect.poll(async () => (await lab(page))?.selected, LIVE).toBe('earth');
  // A world's own figures back again.
  await expect(page.getByTestId('lab-fact-radius')).toBeVisible();
  await expect(page.getByTestId('lab-mass-input')).toBeVisible();
  await page.getByTestId('lab-follow').click();
  await page.getByTestId(`lab-body-${shipId}`).click();
  await expect.poll(async () => (await lab(page))?.selected, LIVE).toBe(shipId);
  const hud = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __kf: { app: { hud(): { labels: Array<{ id: string }> } } } }).__kf.app.hud().labels.map((l) => l.id));
  // (Names never show behind a world's disc: looked at from round the Earth, a quarter turn at a time,
  // until the ship, held still at 629 km up, is on the near side.)
  const named = ['lab-direction-normal', 'lab-direction-prograde', 'lab-direction-radialOut'];
  let azimuth = 0;
  await expect
    .poll(async () => {
      const shown = (await hud()).filter((id) => id.startsWith('lab-direction-')).sort();
      if (shown.join() !== named.join()) {
        azimuth = (azimuth + 90) % 360;
        await place(page, { body: 'earth', distanceKm: 40_000, azimuthDeg: azimuth, elevationDeg: 20 });
      }
      return shown;
    }, { ...LIVE, intervals: [1500] })
    .toEqual(named);
  // A burn of 100 m/s prograde, now.
  await page.getByTestId('lab-ship-direction').selectOption('prograde');
  await expect(page.getByTestId('lab-ship-ref')).toHaveValue('earth');
  await page.getByTestId('lab-ship-dv').fill('100');
  await page.getByTestId('lab-ship-in').fill('0');
  await page.getByTestId('lab-ship-plan').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 0, LIVE).toBe(1);
  await expect(page.getByTestId('lab-ship-burns')).toContainText(/^Now: 100 m\/s prograde about Earth, burning \d+\s+s in all$/u);
  // Run, at a minute a second: the burn (about 40 s) happens; the propellant spent is the rocket
  // equation's, the far side raised. (At the default day a second the pause would come many orbits
  // later, the ship anywhere on its orbit; at a minute a second it comes near the burn's periapsis.)
  await page.evaluate(() => {
    (window as unknown as { __kf: { app: { universeTime(c: { kind: 'rate'; rate: number }): void } } }).__kf.app.universeTime({ kind: 'rate', rate: 60 });
  });
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 1, LIVE).toBe(0);
  await playPause(page);
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await settled(page);
  const after = await shipOf(page);
  expect(10_000 - (after?.ship?.fuelKg ?? 0)).toBeCloseTo(20_000 * (1 - Math.exp(-100 / (320 * 9.80665))), 0);
  expect(after?.orbit?.apoapsisKm ?? 0).toBeGreaterThan(7300);
  // The autopilot: round the orbit at its far side, about half an orbit away (some 50 minutes), for
  // a little under the 100 m/s that raised it.
  await expect(page.getByTestId('lab-ship-circularise')).toBeEnabled();
  const paused = await shipOf(page);
  const round = paused?.ship?.circularise;
  expect(round?.possible).toBe(true);
  expect(round?.deltaVMs ?? 0).toBeGreaterThan(80);
  expect(round?.deltaVMs ?? 0).toBeLessThan(100);
  // The far side comes when Kepler's equation says, from the ship's own elements where it was paused
  // (wherever on its orbit that is): mean anomaly pi, against its mean anomaly now.
  const orbit = paused?.orbit;
  const e = orbit?.e ?? 0;
  const period = orbit?.periodS ?? 0;
  const nu = ((orbit?.trueAnomalyDeg ?? 0) * Math.PI) / 180;
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const M = E - e * Math.sin(E);
  const toFarSide = ((((Math.PI - M) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * period;
  expect(period).toBeGreaterThan(0);
  expect(Math.abs((round?.inS ?? 0) - toFarSide), `far side in ${String(round?.inS)} s; Kepler: ${String(toFarSide)} s`).toBeLessThan(0.01 * period);
  await page.getByTestId('lab-ship-circularise').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 0, LIVE).toBe(1);
  const planned = (await shipOf(page))?.ship?.burns[0];
  expect(planned?.direction).toBe('prograde');
  expect(planned?.deltaVMs ?? 0).toBeCloseTo(round?.deltaVMs ?? 0, 0);
  // Centred on the far side: it starts half its length before it.
  expect(Math.abs((planned?.inS ?? 0) - ((round?.inS ?? 0) - (planned?.durationS ?? 0) / 2))).toBeLessThan(1);
  await page.getByTestId('lab-ship-cancel').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 1, LIVE).toBe(0);
  // A burn planned for an hour from now, and called off.
  await page.getByTestId('lab-ship-in').fill('60');
  await page.getByTestId('lab-ship-plan').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 0, LIVE).toBe(1);
  expect((await shipOf(page))?.ship?.burns[0]?.inS ?? 0).toBeGreaterThan(3500);
  await page.getByTestId('lab-ship-cancel').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 1, LIVE).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('the transfer autopilot: a ship taken from 7,000 km to a round orbit at 9,000 km by two burns', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  await playPause(page);
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // A stronger engine than the form's (200 kN): the burns short beside the orbit, as the transfer assumes.
  await page.getByTestId('lab-add-ship').locator('summary').click();
  await page.getByTestId('lab-ship-thrust').fill('200000');
  await page.getByTestId('lab-ship-add').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.thrustN ?? 0, LIVE).toBe(200_000);
  // Below the Earth's surface: refused, and said so.
  await page.getByTestId('lab-ship-to').fill('5000');
  await expect(page.getByTestId('lab-ship-transfer-text')).toContainText('below the surface of Earth');
  await expect(page.getByTestId('lab-ship-transfer')).toBeDisabled();
  // To 9,000 km: Vallado's algorithm 36 gives 458 m/s now and 430 m/s at the far side, about an hour later.
  await page.getByTestId('lab-ship-to').fill('9000');
  await expect(page.getByTestId('lab-ship-transfer-text')).toHaveText(/^An autopilot: 45\d m\/s prograde now, then 4[23]\d m\/s prograde at the far side of the transfer orbit/u);
  await page.getByTestId('lab-ship-transfer').click();
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 0, LIVE).toBe(2);
  const burns = (await shipOf(page))?.ship?.burns ?? [];
  expect(burns.map((b) => b.direction)).toEqual(['prograde', 'prograde']);
  // Half the transfer orbit's period (a = 8,000 km) between the burns' middles.
  const coast = Math.PI * Math.sqrt(8000 ** 3 / 398_600.435);
  const mid = (b: (typeof burns)[number] | undefined): number => (b?.inS ?? 0) + (b?.durationS ?? 0) / 2;
  expect((mid(burns[1]) - mid(burns[0])) / coast).toBeCloseTo(1, 2);
  // A transfer under way: another waits until its burns are done or called off.
  await expect(page.getByTestId('lab-ship-transfer')).toBeDisabled();
  await expect(page.getByTestId('lab-ship-transfer-text')).toContainText('call those off first');
  // Run: both burns, then a round orbit at 9,000 km.
  await playPause(page);
  await expect.poll(async () => (await shipOf(page))?.ship?.burns.length ?? 1, LIVE).toBe(0);
  await playPause(page);
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  const after = await shipOf(page);
  expect((after?.orbit?.aKm ?? 0) / 9000).toBeGreaterThan(0.985);
  expect((after?.orbit?.aKm ?? 0) / 9000).toBeLessThan(1.015);
  expect(after?.orbit?.e ?? 1).toBeLessThan(0.02);
  expect(pageErrors).toEqual([]);
});
