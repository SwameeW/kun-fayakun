/**
 * The orbital laboratory in the browser (src/explore/lab, src/sim, src/ui/explore/lab-panel): the
 * explorer's system is forked into an experiment with its own address and clock; pausing stops its
 * physics; a mass edit changes the other bodies' motion and is logged; bodies are added (on a
 * circular orbit), duplicated and removed with stable ids; predictions follow the edits; mergers
 * are accounted; the experiment is saved, reset, loaded, rewound to a checkpoint and replayed; files
 * export and bad ones are refused; leaving gives the real explorer back exactly as it was, and the
 * film after it; and removing the world the camera is on moves the camera, not into nothing. Its
 * clock: played backwards to the fork through the run's own states, Reset paused at the fork, a drawn
 * clock that never turns back and keeps an even pace at every rate (slow ones too), a rate change
 * seen at once, Now and a date, a checkpoint gone back to paused, five hundred presses inside single
 * frames; a two-body laboratory shows its own star, not the real Earth; and the Solar system forks at
 * the explorer's date after a lesson. Reduced motion, so flights land at once.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { UniverseLab } from '../../src/core/types';
import { stateFromElements } from '../../src/sim/elements';
import { expect, test, type FrameStats, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 60_000 * SLOW };

test.use({ reducedMotion: 'reduce' });

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const body = async (page: Page, id: string) => (await lab(page))?.bodies.find((b) => b.id === id) ?? null;

async function openLab(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page).toHaveURL(/#\/universe\/lab/);
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
}

test('an experiment forked from the real system: its own clock and gravity, edits that matter, and the real explorer given back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  const before = await view(page);
  await openLab(page);
  await expect(page.getByTestId('lab-note')).toContainText('not JPL’s predictions');
  // What it is for: a thought experiment beside the real system, which stays as it is.
  await expect(page.getByTestId('lab-purpose')).toContainText('compare it with the real solar system, which stays as it is');
  await expect(page.getByTestId('universe-living')).toBeHidden();
  await expect(page.getByTestId('universe-readout')).toContainText('An experiment');

  // Its clock runs (a day a second at first), and Space stops its physics, not just the drawing.
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan(86_400);
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // A step the worker had under way when the pause reached it may still land; after that, none.
  await page.waitForTimeout(300);
  const stopped = (await lab(page))?.step ?? -1;
  await page.waitForTimeout(800);
  expect((await lab(page))?.step).toBe(stopped);

  // Twice the Sun's mass: the Earth, too slow for the new pull, falls inward (logged as an edit, not drift).
  await page.getByTestId('lab-body-sun').click();
  await expect(page.getByTestId('lab-inspector')).toBeVisible();
  // As it really is, nothing to compare.
  await expect(page.getByTestId('lab-compare')).toBeHidden();
  await page.getByTestId('lab-mass-double').click();
  await expect(page.getByTestId('lab-history')).toContainText('Sun: mass changed');
  // Compared with reality: its mass here and in reality, and one question about what changed.
  await expect(page.getByTestId('lab-compare')).toBeVisible();
  await expect(page.getByTestId('lab-compare')).toContainText('Compared with the real Sun');
  await expect(page.getByTestId('lab-compare-mass')).toContainText('in reality (2 times)');
  await expect(page.getByTestId('lab-compare-prompt')).toContainText('What changed?');
  const d0 = (await body(page, 'earth'))?.distanceKm ?? 0;
  // The button keeps the focus, and Space on a focused button presses it: away from it, Space runs the clock again.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(false);
  for (let i = 0; i < 2; i += 1) await page.locator('body').press(']');
  await expect.poll(async () => ((await body(page, 'earth'))?.distanceKm ?? Infinity) / d0, LIVE).toBeLessThan(0.97);
  await expect(page.getByTestId('lab-history').getByText('Sun: mass changed')).toHaveCount(1);
  // Paused again, so what follows happens at a known moment: the Earth's new orbit later takes it near
  // enough to the Sun for the Moon to be pulled away or into the Earth, at a time that depends on where
  // the Moon was when the Sun's mass changed (on a slow machine, it struck the Earth by day 98).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  const n0 = (await lab(page))?.bodies.length ?? 0;

  // A second moon for the Earth, on a circular orbit about it: it appears, chosen, with its prediction.
  await page.getByTestId('lab-add').locator('summary').click();
  await page.getByTestId('lab-add-primary').selectOption('earth');
  await page.getByTestId('lab-add-orbit').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(n0 + 1);
  const moonId = (await lab(page))?.selected ?? '';
  expect(moonId).toMatch(/^body-\d+$/);
  await expect(page.getByTestId('lab-prediction')).toContainText(/integrated ahead|On its present course/, LIVE);
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __kf: { app: { hud(): { labels: Array<{ id: string }> } } } }).__kf.app.hud().labels.map((l) => l.id))).includes(`lab-${moonId}`), LIVE).toBe(true);
  // Duplicated (a new id), then the copy removed; the Sun cannot be removed.
  await page.getByTestId('lab-duplicate').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(n0 + 2);
  const copy = (await lab(page))?.selected ?? '';
  expect(copy).toMatch(/^body-\d+$/);
  expect(copy).not.toBe(moonId);
  await page.getByTestId('lab-remove').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id).includes(copy), LIVE).toBe(false);
  await page.getByTestId('lab-body-sun').click();
  await expect(page.getByTestId('lab-remove')).toBeHidden();

  // Saved, reset to the fork (ten bodies), loaded again (the edits replay as their steps come round).
  const tools = page.getByTestId('lab-tools');
  await tools.locator('summary').click();
  await page.getByTestId('lab-save').click();
  await expect(page.getByTestId('lab-status')).toHaveText('Saved in this browser.', LIVE);
  await page.getByTestId('lab-reset').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(10);
  await page.getByTestId('lab-restore-saved').click();
  await expect(page.getByTestId('lab-status')).toHaveText('Loaded.', LIVE);
  // Its clock runs again: the edits replay as their steps come round, the moon added early (well before the Earth nears the Sun).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(false);
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(n0 + 1);
  // Back to a checkpoint (the oldest of the latest six, the list oldest first): the clock goes back to it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  const now = (await lab(page))?.elapsedS ?? 0;
  const first = page.getByTestId('lab-checkpoints').getByRole('button').first();
  await first.click();
  await expect.poll(async () => (await lab(page))?.elapsedS ?? Infinity, LIVE).toBeLessThan(now);
  await page.getByTestId('lab-replay').click();
  await expect.poll(async () => (await lab(page))?.logLength ?? 0, LIVE).toBeGreaterThanOrEqual(3);

  const results = await new AxeBuilder({ page }).include('[data-testid="lab-panel"]').withTags(WCAG_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  // Back to the real explorer: its date, rate and positions as they were; no experiment left.
  await page.getByTestId('lab-back').click();
  await expect(page).not.toHaveURL(/lab/);
  await expect.poll(async () => (await view(page))?.lab, LIVE).toBeNull();
  const after = await view(page);
  expect(after?.time.rate).toBe(before?.time.rate);
  expect(Math.abs((after?.jdTdb ?? 0) - (before?.jdTdb ?? 0)) * 86_400).toBeLessThan(600);
  expect(after?.bodies.find((b) => b.id === 'earth')?.ecliptic.x).toBeCloseTo(before?.bodies.find((b) => b.id === 'earth')?.ecliptic.x ?? 0, -5);
  await expect(page.getByTestId('universe-readout')).toContainText('from NASA JPL');
  expect(pageErrors).toEqual([]);
});

test('a link to the laboratory opens an experiment, and back leads to the real explorer', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/lab', { query: { jd: JD } });
  await waitForUniverse(page);
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  await page.getByTestId('lab-back').click();
  await expect(page).toHaveURL(/#\/universe(\/earth)?(\?.*)?$/);
  await expect.poll(async () => (await view(page))?.lab, LIVE).toBeNull();
  expect(pageErrors).toEqual([]);
});

test('a laboratory collision is predicted and accounted, files export, and bad ones are refused', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  // Paused, so the planet is still where the two-body system starts it (+x of the star) when it is
  // aimed along -x: a slow machine's few seconds would otherwise carry it a few degrees on, enough to miss.
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  expect((await lab(page))?.elapsedS).toBe(0);
  // Aim the planet at the star: the prediction says it will strike, and it does.
  await page.getByTestId('lab-body-planet').click();
  await page.getByTestId('lab-vel-x').fill('-29.8');
  await page.getByTestId('lab-vel-y').fill('0');
  await page.getByTestId('lab-vel-z').fill('0');
  await page.getByTestId('lab-vel-apply').click();
  await expect(page.getByTestId('lab-prediction')).toContainText('On its present course it strikes Star', LIVE);
  for (let i = 0; i < 3; i += 1) await page.locator('body').press(']');
  await expect(page.getByTestId('lab-history')).toContainText('Planet merged into Star', LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(1);
  // Exported as a file, and that file imports; a bad file is refused with its reasons.
  const download = page.waitForEvent('download');
  await page.getByTestId('lab-export').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('kun-fayakun-two-body-laboratory.json');
  const path = await file.path();
  // Paused first: a file loads at its start (both bodies, before the collision) and keeps the clock as
  // it was, so a fast clock on a slow machine cannot run it into the collision again before the check.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await page.getByTestId('lab-import-file').setInputFiles(path);
  await expect(page.getByTestId('lab-status')).toHaveText('Loaded.', LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(2);
  expect((await lab(page))?.paused).toBe(true);
  expect((await lab(page))?.elapsedS).toBe(0);
  await page.evaluate(() => {
    (window as unknown as { __kf: { app: { universeLab(c: { kind: 'import'; text: string }): void } } }).__kf.app.universeLab({ kind: 'import', text: '{"schemaVersion": 99, "bodies": []}' });
  });
  await expect(page.getByTestId('lab-status')).toContainText('Not done: unsupported schema version', LIVE);
  expect(pageErrors).toEqual([]);
});

test('three round trips from a chapter into an experiment and back: the camera leaves a removed world, the film resumes where it was, GPU memory stays level', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  const html = page.locator('html');
  const film = (): Promise<{ chapter: string | null; time: number; paused: boolean }> =>
    page.evaluate(() => {
      const { app } = (window as unknown as KfHook).__kf;
      return { chapter: app.chapter, time: app.time, paused: app.paused };
    });
  await kf.openChapter('ch07', { t: 150, query: { jd: JD } });
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.pause();
  });
  const before = await film();
  const memory: Array<FrameStats['memory']> = [];
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.openUniverse();
    });
    await waitForUniverse(page);
    await openLab(page);
    // The Earth removed while the camera is on it: the camera goes to the Sun.
    await page.getByTestId('lab-body-earth').click();
    await page.getByTestId('lab-remove').click();
    await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(9);
    await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('sun');
    // Back to the explorer (the Earth is there again), then to the film, where it was.
    await page.getByTestId('lab-back').click();
    await expect.poll(async () => (await view(page))?.lab, LIVE).toBeNull();
    await expect(page.getByTestId('universe-bodies').getByRole('button', { name: 'Earth', exact: true })).toBeVisible();
    await page.getByTestId('universe-back').click();
    await expect(html).toHaveAttribute('data-chapter-ready', 'ch07', LIVE);
    await expect(html).toHaveAttribute('data-experience', 'film');
    const after = await film();
    expect(after.chapter).toBe('ch07');
    expect(after.time, `round ${round}: the film resumes where it was`).toBeCloseTo(before.time, 6);
    expect(after.paused).toBe(true);
    await page.waitForTimeout(400);
    memory.push(await page.evaluate(() => (window as unknown as KfHook).__kf.frameStats().memory));
  }
  // The first round builds what is drawn on first sight; every later round must come back to the same level.
  const [, level] = memory;
  expect(level?.geometries ?? 0).toBeGreaterThan(0);
  for (const [round, m] of memory.slice(1).entries()) expect(m, `round ${round + 1}`).toEqual(level);
  expect(pageErrors).toEqual([]);
});

test('a fast impact breaks a planet: the outcome named, the remnant keeping its name, debris bodies in the experiment', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  // Space on the focused preset button would press it again: away from it, Space pauses the experiment.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // A Mars-mass body 20,000 km from the planet, closing at 40 km/s: Leinhardt and Stewart's erosion regime.
  await page.getByTestId('lab-add').locator('summary').click();
  await page.getByTestId('lab-add-name').fill('Impactor');
  await page.getByTestId('lab-add-mass').fill('6.4e23');
  await page.getByTestId('lab-add-radius').fill('3390');
  await page.getByTestId('lab-add-primary').selectOption('planet');
  for (const [axis, value] of [['x', '-20000'], ['y', '1500'], ['z', '0']] as const) await page.getByTestId(`lab-add-pos-${axis}`).fill(value);
  for (const [axis, value] of [['x', '40'], ['y', '0'], ['z', '0']] as const) await page.getByTestId(`lab-add-vel-${axis}`).fill(value);
  await page.getByTestId('lab-add-state').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect(page.getByTestId('lab-history')).toContainText(/Impactor struck Planet at [\d.]+ km\/s: erosion \(the target lost mass\), 7 pieces thrown off/, LIVE);
  const after = await lab(page);
  expect(after?.bodies.some((b) => b.id === 'planet')).toBe(true);
  expect(after?.bodies.some((b) => b.id === 'body-1')).toBe(false);
  const breakup = after?.events.find((e) => e.kind === 'fragment');
  expect(breakup?.regime).toBe('erosion');
  expect(breakup?.created).toBe(7);
  // The pieces are bodies of the experiment (as its clock runs on, a slow one may fall back on the planet).
  const pieces = after?.bodies.filter((b) => /^(debris|remnant)-/.test(b.id)).length ?? 0;
  expect(pieces).toBeGreaterThan(0);
  expect(pieces).toBeLessThanOrEqual(7);
  expect(pageErrors).toEqual([]);
});

test('a small body’s impact leaves a crater: its size and kind by the scaling law, and the impact’s energy, in the history', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // A stone 1 km across (3,000 kg/m^3), 1,600 km above the planet (the Earth's mass and size), falling at 20 km/s.
  await page.getByTestId('lab-add').locator('summary').click();
  await page.getByTestId('lab-add-name').fill('Stone');
  await page.getByTestId('lab-add-mass').fill('1.571e12');
  await page.getByTestId('lab-add-radius').fill('0.5');
  await page.getByTestId('lab-add-primary').selectOption('planet');
  for (const [axis, value] of [['x', '-8000'], ['y', '0'], ['z', '0']] as const) await page.getByTestId(`lab-add-pos-${axis}`).fill(value);
  for (const [axis, value] of [['x', '20'], ['y', '0'], ['z', '0']] as const) await page.getByTestId(`lab-add-vel-${axis}`).fill(value);
  await page.getByTestId('lab-add-state').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  // Collins, Melosh and Marcus's scaling: a complex crater of some 15 to 20 km; about 8 x 10^4 megatons of TNT.
  await expect(page.getByTestId('lab-history')).toContainText(/Stone struck Planet at [\d.]+ km\/s: .+; its crater about .+ across and .+ deep \(complex: a central peak and terraces\), with the energy of .+ megatons of TNT/, LIVE);
  const e = (await lab(page))?.events.find((x) => x.absorbed === 'body-1');
  expect(e?.craterComplex).toBe(true);
  expect(e?.craterKm ?? 0).toBeGreaterThan(14);
  expect(e?.craterKm ?? Infinity).toBeLessThan(22);
  expect((e?.energyJ ?? 0) / 4.184e15).toBeGreaterThan(5e4);
  expect((e?.energyJ ?? Infinity) / 4.184e15).toBeLessThan(1.2e5);
  expect(pageErrors).toEqual([]);
});

test('a crater drawn where it struck: a stone dropped on the Moon from the Earth’s direction lands near the centre of its near side', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // The Earth from the Moon (paused, so it stays so): the Moon's orbit about it, turned into a place.
  const moon = await body(page, 'moon');
  const earth = await body(page, 'earth');
  expect(moon?.primary).toBe('earth');
  if (!moon?.orbit || !earth) throw new Error('the Moon has no orbit about the Earth');
  const o = moon.orbit;
  const rad = Math.PI / 180;
  const { r } = stateFromElements({ a: o.aKm, e: o.e, i: o.iDeg * rad, node: o.nodeDeg * rad, periapsisArg: o.periapsisArgDeg * rad, trueAnomaly: o.trueAnomalyDeg * rad }, earth.gm + moon.gm);
  const d = Math.hypot(...r);
  const toEarth = r.map((x) => -x / d);
  // A stone 1 km across, 300 km above the Moon on the Earth's side, falling at 2 km/s: the Moon keeps that face to the
  // Earth (the IAU model's prime meridian is the mean Earth direction), so it strikes near 0 N, 0 E (libration aside).
  await page.getByTestId('lab-add').locator('summary').click();
  await page.getByTestId('lab-add-name').fill('Stone');
  await page.getByTestId('lab-add-mass').fill('1.571e12');
  await page.getByTestId('lab-add-radius').fill('0.5');
  await page.getByTestId('lab-add-primary').selectOption('moon');
  for (const [k, axis] of (['x', 'y', 'z'] as const).entries()) {
    await page.getByTestId(`lab-add-pos-${axis}`).fill(String((toEarth[k] ?? 0) * (moon.radiusKm + 300)));
    await page.getByTestId(`lab-add-vel-${axis}`).fill(String(-(toEarth[k] ?? 0) * 2));
  }
  await page.getByTestId('lab-add-state').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(11);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect(page.getByTestId('lab-history')).toContainText(/Stone (merged into|struck) Moon.*its crater about .+ across and .+ deep \(a simple bowl\).*; at [\d.]+° [NS], [\d.]+° [EW]/, LIVE);
  const e = (await lab(page))?.events.find((x) => x.survivor === 'moon');
  expect(e?.craterComplex).toBe(false);
  // Collins et al.'s simple crater, about a fifth as deep as it is wide.
  expect((e?.craterDepthKm ?? 0) / (e?.craterKm ?? 1)).toBeGreaterThan(0.15);
  expect((e?.craterDepthKm ?? 1) / (e?.craterKm ?? 1)).toBeLessThan(0.25);
  expect(Math.abs(e?.craterSite?.latDeg ?? 90)).toBeLessThan(10);
  expect(Math.abs(e?.craterSite?.lonDeg ?? 180)).toBeLessThan(10);
  // Its place is the Moon's own: the Moon turns on, the crater stays where it is on it.
  const placed = e?.craterSite;
  for (let i = 0; i < 2; i += 1) await page.locator('body').press(']');
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan((e?.t ?? 0) + 5 * 86_400);
  expect((await lab(page))?.events.find((x) => x.survivor === 'moon')?.craterSite).toEqual(placed);
  expect(pageErrors).toEqual([]);
});

/** The experiment's clock, frame by frame in the page (requestAnimationFrame): its drawn time (s) and step each frame. */
const sampleClock = (page: Page, ms: number): Promise<Array<{ t: number; step: number; jd: number }>> =>
  page.evaluate(
    (span) =>
      new Promise((resolve) => {
        const kf = (window as unknown as KfHook).__kf;
        const out: Array<{ t: number; step: number; jd: number }> = [];
        const t0 = performance.now();
        const tick = (): void => {
          const v = kf.universe.state();
          if (v?.lab) out.push({ t: v.lab.elapsedS, step: v.lab.step, jd: v.jdTdb });
          if (performance.now() - t0 < span) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
const setRate = (page: Page, rate: number): Promise<void> =>
  page.evaluate((r) => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: r });
  }, rate);
/** Synchronous clicks inside one task (one frame), by test id. */
const burst = (page: Page, ids: readonly string[]): Promise<void> =>
  page.evaluate((list) => {
    for (const id of list) document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
  }, ids);
const LAB_BUTTONS = ['universe-time-reverse', 'universe-time-slower', 'universe-time-pause', 'universe-time-faster', 'universe-time-now', 'universe-time-reset'] as const;

test('backwards through the experiment’s history to its fork, exactly as it ran; forwards again; Reset pauses at the fork', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  // Thirty days a second for a while, then a day a second (about a step a snapshot).
  await setRate(page, 2_592_000);
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan(30 * 86_400);
  await setRate(page, 86_400);
  // On the way forwards, each step's Earth-Moon distance as the worker had it.
  const forward = await page.evaluate(
    () =>
      new Promise<Array<[number, number]>>((resolve) => {
        const kf = (window as unknown as KfHook).__kf;
        const out: Array<[number, number]> = [];
        const t0 = performance.now();
        const tick = (): void => {
          const l = kf.universe.state()?.lab;
          const m = l?.bodies.find((b) => b.id === 'moon');
          if (l && m?.distanceKm != null && !out.some(([s]) => s === l.step)) out.push([l.step, m.distanceKm]);
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(forward.length).toBeGreaterThan(20);
  // Reverse: the clock runs back, never forwards, every frame; the moments gone back through are the
  // run's own (the same Earth-Moon distance at the same step).
  await page.getByTestId('universe-time-reverse').click();
  expect((await lab(page))?.requestedRate).toBe(-86_400);
  const backward = await page.evaluate(
    () =>
      new Promise<{ steps: Array<[number, number]>; times: number[] }>((resolve) => {
        const kf = (window as unknown as KfHook).__kf;
        const steps: Array<[number, number]> = [];
        const times: number[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          const l = kf.universe.state()?.lab;
          const m = l?.bodies.find((b) => b.id === 'moon');
          if (l) times.push(l.elapsedS);
          if (l && m?.distanceKm != null && !steps.some(([s]) => s === l.step)) steps.push([l.step, m.distanceKm]);
          if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
          else resolve({ steps, times });
        };
        requestAnimationFrame(tick);
      }),
  );
  for (let k = 1; k < backward.times.length; k += 1) expect(backward.times[k] ?? 0).toBeLessThanOrEqual(backward.times[k - 1] ?? 0);
  expect((backward.times[0] ?? 0) - (backward.times.at(-1) ?? 0)).toBeGreaterThan(2 * 86_400);
  await expect(page.getByTestId('lab-rates')).toContainText('Going back');
  const seen = new Map(forward);
  const common = backward.steps.filter(([s]) => seen.has(s));
  expect(common.length).toBeGreaterThan(10);
  for (const [s, d] of common) expect(d, `step ${String(s)}`).toBe(seen.get(s));
  // Faster backwards, to the fork.
  await page.getByTestId('universe-time-faster').click();
  await page.getByTestId('universe-time-faster').click();
  expect((await lab(page))?.requestedRate).toBe(-2_592_000);
  // At the fork: stopped there, saying so.
  await expect.poll(async () => (await view(page))?.time.edge, LIVE).toBe('start');
  await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
  expect((await lab(page))?.step).toBe(0);
  await expect(page.getByTestId('universe-time-rate')).toHaveText('Back at the start of the experiment');
  await expect(page.getByTestId('universe-time-note')).toHaveText('Play runs it forwards from here.');
  // Play runs it forwards again.
  await page.getByTestId('universe-time-pause').click();
  expect((await lab(page))?.requestedRate).toBe(2_592_000);
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan(5 * 86_400);
  // Reset: at once back at the fork, paused, at a day a second.
  await page.getByTestId('universe-time-reset').click();
  await expect.poll(async () => (await lab(page))?.elapsedS ?? Infinity, { timeout: 2000 * SLOW }).toBeLessThan(1);
  expect((await lab(page))).toMatchObject({ paused: true, requestedRate: 86_400 });
  await page.waitForTimeout(500);
  expect((await lab(page))?.elapsedS).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('the drawn clock: smooth and never turning back at every rate, a rate change seen at once, slow rates moving, a pause holding', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  const smooth = async (what: string): Promise<{ median: number; per: number }> => {
    const s = await sampleClock(page, 1500);
    const steps = s.slice(1).map((x, k) => x.t - (s[k]?.t ?? 0));
    const jds = s.slice(1).map((x, k) => x.jd - (s[k]?.jd ?? 0));
    expect(Math.min(...steps), `${what}: no frame goes back`).toBeGreaterThanOrEqual(0);
    expect(Math.min(...jds), `${what}: nor does the date`).toBeGreaterThanOrEqual(0);
    const sorted = [...steps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (median > 0) expect(sorted[Math.floor(sorted.length * 0.95)] ?? 0, `${what}: even`).toBeLessThan(1.6 * median);
    return { median, per: ((s.at(-1)?.t ?? 0) - (s[0]?.t ?? 0)) / 1.5 };
  };
  // The solar system at a day, six hours, an hour and thirty days a second.
  for (const rate of [86_400, 21_600, 3600, 2_592_000]) {
    await setRate(page, rate);
    await page.waitForTimeout(400);
    const { per } = await smooth(`solar at ${String(rate)}`);
    expect(per).toBeGreaterThan(0.7 * rate);
  }
  // A rate change shows at once: three presses of Faster from an hour a second, and the clock runs at a week a second within moments.
  await setRate(page, 3600);
  await page.waitForTimeout(400);
  await burst(page, ['universe-time-faster', 'universe-time-faster', 'universe-time-faster']);
  await page.waitForTimeout(250);
  expect((await smooth('after three presses')).per).toBeGreaterThan(0.8 * 604_800);
  // The two-body laboratory (steps of about 14 hours) at a day a second and at ten seconds a second: it moves, smoothly.
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  for (const rate of [86_400, 10]) {
    await setRate(page, rate);
    await page.waitForTimeout(400);
    const { per } = await smooth(`two-body at ${String(rate)}`);
    expect(per).toBeGreaterThan(0.6 * rate);
    expect(per).toBeLessThan(1.4 * rate);
    await expect(page.getByTestId('lab-rates')).not.toContainText('only');
  }
  // Paused: it goes on to where the run stopped, never back, and then holds.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  expect((await lab(page))?.paused).toBe(true);
  const after = await sampleClock(page, 600);
  for (let k = 1; k < after.length; k += 1) expect(after[k]?.t ?? 0).toBeGreaterThanOrEqual(after[k - 1]?.t ?? 0);
  expect(after.at(-1)?.t).toBe(after.at(-5)?.t);
  expect(pageErrors).toEqual([]);
});

test('Now and a date in an experiment, a checkpoint gone back to (paused), and hundreds of presses inside single frames', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.getByTestId('lab-tools').locator('summary').click();
  // The two-body laboratory starts at J2000: Now is a quarter of a century on, then real time.
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  await page.getByTestId('universe-time-now').click();
  const sinceJ2000 = (Date.now() - Date.UTC(2000, 0, 1, 12)) / 1000;
  await expect.poll(async () => Math.abs(((await lab(page))?.elapsedS ?? 0) - sinceJ2000), LIVE).toBeLessThan(2 * 86_400);
  await expect.poll(async () => (await lab(page))?.seekingS, LIVE).toBeNull();
  expect((await lab(page))?.requestedRate).toBe(1);
  await expect(page.getByTestId('universe-time-rate')).toHaveText('Real time');
  // A date: that day of the experiment (back through its history, then on).
  await page.getByTestId('universe-time-date').fill('2010-06-15');
  await expect.poll(async () => new Date((await view(page))?.unixMs ?? 0).toISOString().slice(0, 10), LIVE).toBe('2010-06-15');
  // Before the fork: stopped at the fork, saying so.
  await page.getByTestId('universe-time-date').fill('1990-01-01');
  await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
  expect((await lab(page))?.paused).toBe(true);
  await expect(page.getByTestId('universe-time-rate')).toHaveText('Back at the start of the experiment');
  // A checkpoint: gone back to, paused there.
  await setRate(page, 2_592_000);
  await expect.poll(async () => (await lab(page))?.checkpoints.length ?? 0, LIVE).toBeGreaterThan(2);
  const list = page.getByTestId('lab-checkpoints').getByRole('button');
  await expect(list.first()).toBeVisible();
  const target = (await lab(page))?.checkpoints.at(-2);
  await page.getByTestId(`lab-checkpoint-${String(target?.step)}`).click();
  await expect.poll(async () => (await lab(page))?.step, LIVE).toBe(target?.step);
  expect((await lab(page))?.paused).toBe(true);
  await page.waitForTimeout(300);
  expect((await lab(page))?.elapsedS).toBe(target?.t);
  // Five hundred presses in twenty bursts, each inside one frame: the clock stays sound, and one more press still turns it.
  let seed = 5;
  const next = (): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let b = 0; b < 20; b += 1) {
    await burst(page, Array.from({ length: 25 }, () => LAB_BUTTONS[Math.floor(next() * LAB_BUTTONS.length)] ?? 'universe-time-pause'));
    await page.waitForTimeout(16 + Math.floor(next() * 450));
  }
  await page.waitForTimeout(500);
  const l = await lab(page);
  expect([1, 10, 60, 600, 3600, 21_600, 86_400, 604_800, 2_592_000]).toContain(Math.abs(l?.requestedRate ?? 0));
  expect(l?.elapsedS ?? -1).toBeGreaterThanOrEqual(0);
  const before = l?.requestedRate ?? 0;
  await page.getByTestId('universe-time-reverse').click();
  expect((await lab(page))?.requestedRate).toBe(-before);
  expect(pageErrors).toEqual([]);
});

test('a laboratory of its own shows its star and planet, not the real Earth; the Solar system forks again at the explorer’s date after a lesson', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.getByTestId('lab-lessons').locator('summary').click();
  await page.getByTestId('lab-lesson-kepler').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id).join(), LIVE).toBe('star,planet');
  // The view leaves the Earth (which this experiment does not have) for its star; no Earth named or described.
  await expect.poll(async () => (await view(page))?.focus, LIVE).toBe('sun');
  await expect(page.getByTestId('universe-readout')).toHaveText(/^Sun\d/u, LIVE);
  const labels = await page.evaluate(() => (window as unknown as { __kf: { app: { hud(): { labels: Array<{ id: string }> } } } }).__kf.app.hud().labels.map((x) => x.id));
  expect(labels.filter((id) => /^(earth|edge-earth)$/u.test(id))).toEqual([]);
  // The Solar system preset: forked at the explorer's date, not the lesson's J2000.
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-solar').click();
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  expect(Math.abs(((await lab(page))?.epochJdTdb ?? 0) - Number(JD))).toBeLessThan(1 / 24);
  expect(pageErrors).toEqual([]);
});
