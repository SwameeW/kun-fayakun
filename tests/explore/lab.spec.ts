/**
 * The orbital laboratory in the browser (src/explore/lab, src/sim, src/ui/explore/lab-panel): the
 * explorer's system is forked into an experiment with its own address and clock; pausing stops its
 * physics; a mass edit changes the other bodies' motion and is logged; bodies are added (on a
 * circular orbit), duplicated and removed with stable ids; predictions follow the edits; mergers
 * are accounted; the experiment is saved, reset, loaded, rewound to a checkpoint and replayed; files
 * export and bad ones are refused; leaving gives the real explorer back exactly as it was, and the
 * film after it; and removing the world the camera is on moves the camera, not into nothing.
 * Reduced motion, so flights land at once.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { UniverseLab } from '../../src/core/types';
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
  await page.getByTestId('lab-mass-double').click();
  await expect(page.getByTestId('lab-history')).toContainText('Sun: mass changed');
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
  // Back to a checkpoint: the clock goes back to it.
  const now = (await lab(page))?.elapsedS ?? 0;
  const first = page.getByTestId('lab-checkpoints').getByRole('button').last();
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
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
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
  await page.getByTestId('lab-import-file').setInputFiles(path);
  await expect(page.getByTestId('lab-status')).toHaveText('Loaded.', LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(2);
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
