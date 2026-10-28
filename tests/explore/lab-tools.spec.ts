/**
 * The orbital laboratory's tools (src/explore/lab, src/ui/explore/lab-panel; ledger SB-20 to SB-37):
 * the inspector's orbit, rotation and limits for real worlds; mass, radius and density edits with one
 * held; a name, a hold, undo and redo; a push, a whole orbit by elements, a rotation; the prediction's
 * accuracy and its encounters; Lagrange points and a body put at L4; the palette of real bodies;
 * placing with the pointer and dragging the velocity arrow; frames, measurements, a quantity followed,
 * the library, a link that opens the experiment again, and several bodies at once; the camera following
 * and framing the laboratory's own bodies (docs/SANDBOX-ROADMAP.md W1.9).
 */
import type { Page } from '@playwright/test';
import type { LabCommand, LabEditResult, UniverseLab } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const AU = 149_597_870.7;

test.use({ reducedMotion: 'reduce' });

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const command = (page: Page, c: LabCommand): Promise<LabEditResult | undefined> => page.evaluate((x) => (window as unknown as KfHook).__kf.universe.lab?.(x), c);
/** Settled on a body: the view's focus, and no trip under way. */
const settledOn = async (page: Page): Promise<string | null> => {
  const v = await view(page);
  return v && !v.travelling ? v.focus : null;
};
const body = async (page: Page, id: string) => (await lab(page))?.bodies.find((b) => b.id === id) ?? null;

async function openLab(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page).toHaveURL(/#\/universe\/lab/);
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
}

async function pause(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
}

async function choose(page: Page, id: string): Promise<void> {
  // A click on the chosen body unchooses it: only click when it is not chosen already.
  if ((await lab(page))?.selected !== id) await page.getByTestId(`lab-body-${id}`).click();
  await expect.poll(async () => (await lab(page))?.selected, LIVE).toBe(id);
  await expect(page.getByTestId('lab-inspector')).toBeVisible(LIVE);
}

async function preset(page: Page, seed: 'two' | 'three'): Promise<void> {
  const tools = page.getByTestId('lab-tools');
  if (!(await tools.evaluate((d) => (d as HTMLDetailsElement).open))) await tools.locator('summary').click();
  await page.getByTestId(`lab-preset-${seed}`).click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id).join(','), LIVE).toBe(seed === 'two' ? 'star,planet' : 'star,planet,giant');
}

test('a world’s orbit, rotation and limits; mass, radius and density with one held; a name, a hold, undo and redo', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  await choose(page, 'earth');
  // The Earth about the Sun: a year, a slightly eccentric orbit; a sidereal day and the seasons' tilt; its J2.
  const earth = await body(page, 'earth');
  expect(earth?.orbit?.e ?? 0).toBeGreaterThan(0.012);
  expect(earth?.orbit?.e ?? 1).toBeLessThan(0.021);
  expect((earth?.orbit?.periodS ?? 0) / 86_400).toBeCloseTo(365.25, -1);
  expect(earth?.rotation.periodS ?? 0).toBeCloseTo(86_164.1, -1);
  expect(earth?.rotation.tiltDeg ?? 0).toBeCloseTo(23.44, 0);
  expect(earth?.j2).toBeCloseTo(1.08263e-3, 8);
  await expect(page.getByTestId('lab-fact-rotation')).toContainText('23.4');
  await expect(page.getByTestId('lab-fact-hill')).toBeVisible();
  // The Moon: the Earth's Roche limits for it, about 18,400 km for a fluid body.
  await choose(page, 'moon');
  const moon = await body(page, 'moon');
  expect((moon?.roche?.fluidKm ?? 0) / 1000).toBeCloseTo(18.4, 0);
  expect(moon?.rotation.periodS ?? 0).toBeCloseTo(27.3217 * 86_400, -3);
  await expect(page.getByTestId('lab-fact-roche')).toContainText('fluid');
  // A larger Moon of the same mass (less dense), then denser at that size (more massive).
  await page.getByTestId('lab-hold').selectOption('mass');
  await page.getByTestId('lab-radius-input').fill('2000');
  await page.getByTestId('lab-radius-apply').click();
  await expect.poll(async () => (await body(page, 'moon'))?.radiusKm, LIVE).toBe(2000);
  const bigger = await body(page, 'moon');
  expect(bigger?.massKg ?? 0).toBeCloseTo(moon?.massKg ?? 1, -18);
  expect(bigger?.densityKgM3 ?? 0).toBeCloseTo((moon?.densityKgM3 ?? 0) * (1737.4 / 2000) ** 3, -1);
  await page.getByTestId('lab-hold').selectOption('radius');
  await page.getByTestId('lab-density-input').fill('4000');
  await page.getByTestId('lab-density-apply').click();
  await expect.poll(async () => Math.round((await body(page, 'moon'))?.densityKgM3 ?? 0), LIVE).toBe(4000);
  expect((await body(page, 'moon'))?.radiusKm).toBe(2000);
  // Renamed, held in place (said to break conservation), let go; undo and redo the name.
  await page.getByTestId('lab-rename-input').fill('Luna');
  await page.getByTestId('lab-rename-apply').click();
  await expect(page.getByTestId('lab-body-moon')).toContainText('Luna');
  await page.getByTestId('lab-fixed').check();
  await expect.poll(async () => (await body(page, 'moon'))?.fixed, LIVE).toBe(true);
  await expect(page.getByTestId('lab-constrained')).toBeVisible();
  await page.getByTestId('lab-fixed').uncheck();
  await expect.poll(async () => (await body(page, 'moon'))?.fixed, LIVE).toBe(false);
  await expect(page.getByTestId('lab-constrained')).toBeHidden();
  // Undo the letting go, then the hold: held, then free again; then the name.
  await page.getByTestId('lab-undo').click();
  await expect.poll(async () => (await body(page, 'moon'))?.fixed, LIVE).toBe(true);
  await page.getByTestId('lab-undo').click();
  await expect.poll(async () => (await body(page, 'moon'))?.fixed, LIVE).toBe(false);
  await page.getByTestId('lab-undo').click();
  await expect.poll(async () => (await body(page, 'moon'))?.name, LIVE).toBe('Moon');
  await page.getByTestId('lab-redo').click();
  await expect.poll(async () => (await body(page, 'moon'))?.name, LIVE).toBe('Luna');
  await expect(page.getByTestId('lab-history')).toContainText('renamed');
  expect(pageErrors).toEqual([]);
});

test('a push, an orbit by elements, a rotation; the prediction’s accuracy and encounters; Lagrange points and a body at L4', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await preset(page, 'three');
  await pause(page);
  await choose(page, 'planet');
  const start = await body(page, 'planet');
  expect(start?.orbit?.e ?? 1).toBeLessThan(1e-3);
  expect((start?.orbit?.aKm ?? 0) / AU).toBeCloseTo(1, 2);
  // A thousand metres a second along its motion: faster about the star by 1 km/s, and no longer circular.
  await page.getByTestId('lab-impulse-prograde').fill('1000');
  await page.getByTestId('lab-impulse-apply').click();
  await expect.poll(async () => ((await body(page, 'planet'))?.relativeSpeedKmS ?? 0) - (start?.relativeSpeedKmS ?? 0), LIVE).toBeGreaterThan(0.99);
  expect((await body(page, 'planet'))?.orbit?.e ?? 0).toBeGreaterThan(0.05);
  // Its whole orbit set: a = 1.6e8 km, e = 0.2.
  const els = page.getByTestId('lab-elements');
  await els.locator('summary').click();
  await page.getByTestId('lab-el-a').fill('160000000');
  await page.getByTestId('lab-el-e').fill('0.2');
  await page.getByTestId('lab-el-apply').click();
  await expect.poll(async () => (await body(page, 'planet'))?.orbit?.e ?? 0, LIVE).toBeCloseTo(0.2, 3);
  expect((await body(page, 'planet'))?.orbit?.aKm ?? 0).toBeCloseTo(1.6e8, -3);
  // A rotation: once every ten hours, its axis tilted 30 degrees.
  await page.getByTestId('lab-spin-period').fill('10');
  await page.getByTestId('lab-spin-tilt').fill('30');
  await page.getByTestId('lab-spin-apply').click();
  await expect.poll(async () => (await body(page, 'planet'))?.rotation.periodS ?? 0, LIVE).toBeCloseTo(36_000, -1);
  expect((await body(page, 'planet'))?.rotation.tiltDeg ?? 0).toBeCloseTo(30, 3);
  // Ten years ahead, finely: its closest approaches to the giant named.
  await page.getByTestId('lab-horizon').selectOption({ index: 3 });
  await page.getByTestId('lab-accuracy').selectOption('precise');
  await expect.poll(async () => (await lab(page))?.accuracy, LIVE).toBe('precise');
  await expect.poll(async () => (await lab(page))?.prediction?.encounters.some((e) => e.with === 'giant') ?? false, LIVE).toBe(true);
  await expect(page.getByTestId('lab-encounters')).toContainText('Closest to Giant');
  // The giant's Lagrange points with the star, and a body put at L4 on the giant's orbit.
  await choose(page, 'giant');
  await page.getByTestId('lab-lagrange').check();
  await expect.poll(async () => (await lab(page))?.lagrange, LIVE).toEqual({ primary: 'star', secondary: 'giant' });
  await page.getByTestId('lab-lagrange-point').selectOption('L4');
  await page.getByTestId('lab-lagrange-add').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(4);
  const trojan = (await lab(page))?.bodies.find((b) => b.name === 'At L4');
  const giant = await body(page, 'giant');
  expect((trojan?.orbit?.aKm ?? 0) / (giant?.orbit?.aKm ?? 1)).toBeCloseTo(1, 2);
  expect(pageErrors).toEqual([]);
});

test('the palette adds real bodies; placing with the pointer; dragging the velocity arrow', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  // Io, from JPL's satellite parameters, about Jupiter at its real distance.
  await page.getByTestId('lab-add').locator('summary').click();
  await page.getByTestId('lab-palette-search').fill('io');
  await page.getByTestId('lab-preset-io').click();
  await expect(page.getByTestId('lab-add-name')).toHaveValue('Io');
  await page.getByTestId('lab-add-primary').selectOption('jupiter');
  await page.getByTestId('lab-add-distance').fill('421700');
  await page.getByTestId('lab-add-orbit').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(11);
  const io = (await lab(page))?.bodies.find((b) => b.name === 'Io');
  expect(io?.radiusKm).toBeCloseTo(1821.49, 2);
  expect((io?.massKg ?? 0) / 8.93e22).toBeCloseTo(1, 2);
  expect(io?.primary).toBe('jupiter');
  // Placed with the pointer about the Earth: seen from above its orbit, a point beside it.
  await place(page, { body: 'earth', distanceKm: 120_000, azimuthDeg: 20, elevationDeg: 50 });
  await page.getByTestId('lab-palette-search').fill('');
  await page.getByTestId('lab-add-name').fill('Pointer moon');
  await page.getByTestId('lab-add-mass').fill('1e20');
  await page.getByTestId('lab-add-radius').fill('200');
  await page.getByTestId('lab-add-primary').selectOption('earth');
  await page.getByTestId('lab-place').click();
  await expect(page.getByTestId('lab-placing')).toBeVisible();
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  const at = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 };
  await page.mouse.move(at.x - 20, at.y);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  await expect.poll(async () => (await lab(page))?.placing?.offsetKm ?? 0, LIVE).toBeGreaterThan(7000);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await lab(page))?.bodies.some((b) => b.name === 'Pointer moon') ?? false, LIVE).toBe(true);
  expect((await lab(page))?.placing).toBeNull();
  const placed = (await lab(page))?.bodies.find((b) => b.name === 'Pointer moon');
  expect(placed?.primary).toBe('earth');
  expect(placed?.orbit?.e ?? 1).toBeLessThan(0.01);
  // Its velocity arrow, dragged by the tip: a new velocity.
  await expect.poll(async () => (await lab(page))?.handle !== null, LIVE).toBe(true);
  const before = (await lab(page))?.bodies.find((b) => b.name === 'Pointer moon')?.relativeVelKmS ?? [0, 0, 0];
  const handle = (await lab(page))?.handle;
  if (!handle) throw new Error('no handle');
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40, handle.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const v = (await lab(page))?.bodies.find((b) => b.name === 'Pointer moon')?.relativeVelKmS ?? before;
    return Math.hypot(v[0] - before[0], v[1] - before[1], v[2] - before[2]);
  }, LIVE).toBeGreaterThan(0.01);
  expect(pageErrors).toEqual([]);
});

test('frames, measurements and a quantity followed', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  // Turning with the Sun and Jupiter.
  await choose(page, 'jupiter');
  await page.getByTestId('lab-view-box').locator('summary').click();
  await page.getByTestId('lab-view').selectOption('corotating');
  await expect.poll(async () => (await lab(page))?.corotatingPair, LIVE).toEqual({ a: 'sun', b: 'jupiter' });
  await expect(page.getByTestId('lab-view-text')).toContainText('Jupiter');
  // Over the ground: the Moon's path as the turning Earth sees it.
  await choose(page, 'moon');
  await page.getByTestId('lab-view').selectOption('bodyfixed');
  await expect.poll(async () => (await lab(page))?.view, LIVE).toBe('bodyfixed');
  await expect(page.getByTestId('lab-view-text')).toContainText('Earth turns');
  await page.getByTestId('lab-view').selectOption('primary');
  // The Moon from the Earth: about 1.3 light seconds, half a degree; and the angle to the Sun.
  await page.getByTestId('lab-measure').locator('summary').click();
  await page.getByTestId('lab-measure-from').selectOption('earth');
  await page.getByTestId('lab-measure-to').selectOption('moon');
  await page.getByTestId('lab-measure-via').selectOption('sun');
  await expect.poll(async () => (await lab(page))?.measure?.lightS ?? 0, LIVE).toBeGreaterThan(1.1);
  const m = (await lab(page))?.measure;
  expect(m?.lightS ?? 0).toBeLessThan(1.4);
  expect(m?.angularSizeDeg ?? 0).toBeCloseTo(0.52, 1);
  expect(m?.separationDeg ?? -1).toBeGreaterThanOrEqual(0);
  await expect(page.getByTestId('lab-measure-result')).toContainText('light takes');
  await expect(page.getByTestId('lab-measure-angle')).toContainText('apart');
  // The Moon's distance followed while the clock runs.
  await page.getByTestId('lab-graph-box').locator('summary').click();
  await page.getByTestId('lab-graph-body').selectOption('moon');
  await page.getByTestId('lab-graph-quantity').selectOption('distance');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.graph?.points.length ?? 0, LIVE).toBeGreaterThan(10);
  await expect(page.getByTestId('lab-graph-summary')).toContainText('samples');
  expect(await page.getByTestId('lab-graph').locator('polyline').getAttribute('points')).toMatch(/\d/);
  await pause(page);
  expect(pageErrors).toEqual([]);
});

test('a body renamed, the library, and a link that opens the experiment again', async ({ page, kf, pageErrors, context }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  // Renamed, saved to the library, deleted from it.
  await choose(page, 'moon');
  await page.getByTestId('lab-rename-input').fill('Luna');
  await page.getByTestId('lab-rename-apply').click();
  await expect.poll(async () => (await body(page, 'moon'))?.name, LIVE).toBe('Luna');
  const tools = page.getByTestId('lab-tools');
  await tools.locator('summary').click();
  await page.getByTestId('lab-library-name').fill('test one');
  await page.getByTestId('lab-library-save').click();
  await expect(page.getByTestId('lab-library-load-test one')).toBeVisible(LIVE);
  await page.getByTestId('lab-library-delete-test one').click();
  await expect(page.getByTestId('lab-library-load-test one')).toBeHidden(LIVE);
  // A link to it, opened in another page: the same experiment, the Moon still Luna.
  await page.getByTestId('lab-share').click();
  await expect(page.getByTestId('lab-share-url')).toHaveValue(/#\/universe\/lab\?s=[A-Za-z0-9_-]+$/u, LIVE);
  const url = await page.getByTestId('lab-share-url').inputValue();
  const other = await context.newPage();
  await other.goto(url);
  await expect.poll(async () => (await other.evaluate(() => (window as unknown as { __kf?: { universe?: { state(): { lab: UniverseLab | null } | null } } }).__kf?.universe?.state()?.lab?.bodies.find((b) => b.id === 'moon')?.name ?? null)), LIVE).toBe('Luna');
  await other.close();
  expect(pageErrors).toEqual([]);
});

test('several bodies at once: two copies of the Moon, ticked and removed together', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  await choose(page, 'moon');
  await page.getByTestId('lab-duplicate').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(11);
  await choose(page, 'moon');
  await page.getByTestId('lab-duplicate').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(12);
  const copies = ((await lab(page))?.bodies ?? []).filter((b) => b.name.includes('(copy)')).map((b) => b.id);
  expect(copies.length).toBe(2);
  for (const id of copies) await page.getByTestId(`lab-tick-${id}`).check();
  await expect(page.getByTestId('lab-many')).toContainText('2 ticked bodies');
  await page.getByTestId('lab-many-remove').click();
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(10);
  expect(pageErrors).toEqual([]);
});

test('rings and belts: a main belt about the Sun and a ring about the Earth, drawn as points, kept as they run, removed; a gravitating ring of bodies', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  const rings = page.getByTestId('lab-rings');
  await rings.locator('summary').click();
  // Saturn's drawn rings are the decorative kind, and say so.
  await expect(page.getByTestId('lab-rings-decorative')).toBeVisible();
  // No body chosen: a ring needs one.
  await expect(page.getByTestId('lab-ring-preset-ring')).toBeDisabled();
  await page.getByTestId('lab-ring-preset-asteroid').click();
  await expect.poll(async () => (await lab(page))?.swarms.map((w) => [w.primary, w.count]), LIVE).toEqual([['sun', 1000]]);
  await expect.poll(async () => (await lab(page))?.particlesDrawn, LIVE).toBe(1000);
  await expect(page.getByTestId('lab-rings-list')).toContainText('Main belt: 1,000 test particles about Sun');
  // A ring about the Earth, 500 particles, in its equator's plane.
  await page.getByTestId('lab-body-earth').click();
  await page.getByTestId('lab-ring-count').selectOption('500');
  await page.getByTestId('lab-ring-preset-ring').click();
  await expect.poll(async () => (await lab(page))?.swarms.map((w) => [w.primary, w.count]), LIVE).toEqual([['sun', 1000], ['earth', 500]]);
  await expect.poll(async () => (await lab(page))?.particlesDrawn, LIVE).toBe(1500);
  await expect(page.getByTestId('lab-history')).toContainText('Ring of Earth added');
  // Run a few days: the belt and the ring keep their particles (none flung out or struck).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan(3 * 86_400);
  expect((await lab(page))?.swarms.map((w) => w.count + w.lost)).toEqual([1000, 500]);
  // Removed: gone from the list and the drawing.
  await page.getByTestId('lab-ring-remove-swarm-1').click();
  await expect.poll(async () => (await lab(page))?.swarms.map((w) => w.id), LIVE).toEqual(['swarm-2']);
  await expect.poll(async () => (await lab(page))?.particlesDrawn, LIVE).toBe(500);
  // A gravitating ring: a dozen bodies about the Earth, each one a body of the experiment (counted
  // paused: running, two could meet and merge before a slow machine looks).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await page.getByTestId('lab-ring-preset-moonlets').click();
  await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('moonlets-1-')).length, LIVE).toBe(12);
  expect(pageErrors).toEqual([]);
});

test('worlds that respond: the Earth’s climate today, its ice and water, the greenhouse doubled; a planet moved out freezes over; the temperature view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await choose(page, 'earth');
  const climate = page.getByTestId('lab-climate');
  await climate.locator('summary').click();
  // North, Cahalan and Coakley's Earth: about 15 C, ice caps at the poles, liquid water on most of the ocean.
  const earth = async () => (await lab(page))?.bodies.find((b) => b.id === 'earth')?.climate ?? null;
  const today = await earth();
  expect(today?.model).toBe('budyko');
  expect((today?.meanK ?? 0) - 273.15).toBeGreaterThan(12);
  expect((today?.meanK ?? 0) - 273.15).toBeLessThan(19);
  expect(today?.ice ?? 0).toBeGreaterThan(0);
  expect(today?.ice ?? 1).toBeLessThan(0.2);
  expect(today?.gases.map((g) => g.gas)).toEqual(['n2', 'o2', 'co2', 'ar']);
  await expect(page.getByTestId('lab-climate-light')).toContainText(/1,3\d\d W\/m², 1\.0\d times the Earth’s|1,3\d\d W\/m², 0\.9\d times the Earth’s/);
  await expect(page.getByTestId('lab-climate-water')).toContainText('could lie on');
  await expect(page.getByTestId('lab-climate-gases')).toContainText('nitrogen 78.08%');
  // The temperature view, on and off.
  await page.getByTestId('lab-climate-view').click();
  await expect.poll(async () => (await lab(page))?.climateView, LIVE).toBe(true);
  await expect(page.getByTestId('lab-climate-view')).toHaveAttribute('aria-pressed', 'true');
  // Carbon dioxide doubled (IPCC AR6's 3.93 W/m^2): logged, and the Earth warms over the years that follow (slowly: its oceans hold heat).
  await page.getByTestId('lab-climate-more').click();
  await expect.poll(async () => (await earth())?.forcing, LIVE).toBeCloseTo(3.93, 6);
  await expect(page.getByTestId('lab-history')).toContainText('Earth: atmosphere changed');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 6; i += 1) await page.locator('body').press(']');
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, { timeout: 120_000 * SLOW }).toBeGreaterThan(3 * 365.25 * 86_400);
  expect(((await earth())?.meanK ?? 0) - (today?.meanK ?? 0)).toBeGreaterThan(0.2);
  // The two-body laboratory: its planet (the Earth's mass, size and climate) moved out to 1.3 au freezes over.
  await page.locator('body').press('Space');
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-preset-two').click();
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  const planet = async () => (await lab(page))?.bodies.find((b) => b.id === 'planet')?.climate ?? null;
  expect((await planet())?.ice ?? 1).toBeLessThan(0.3);
  await page.evaluate(() => {
    const kf = (window as unknown as { __kf: { app: { universeLab(c: { kind: 'elements'; id: string; aKm: number; e: number; iDeg: number; nodeDeg: number; periapsisArgDeg: number; trueAnomalyDeg: number }): void } } }).__kf;
    kf.app.universeLab({ kind: 'elements', id: 'planet', aKm: 1.3 * 149_597_870.7, e: 0, iDeg: 0, nodeDeg: 0, periapsisArgDeg: 0, trueAnomalyDeg: 0 });
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 6; i += 1) await page.locator('body').press(']');
  await expect.poll(async () => (await planet())?.ice ?? 0, { timeout: 120_000 * SLOW }).toBeGreaterThan(0.999);
  expect(pageErrors).toEqual([]);
});

test('the tides tear a moon apart: the Moon sent inside the Earth’s Roche limit becomes pieces and a ring of dust', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  // The Moon's fluid Roche limit about the Earth is about 18,400 km: put it on a circular orbit at 15,000 km.
  await choose(page, 'moon');
  await expect(page.getByTestId('lab-fact-roche')).toContainText('18,');
  await page.evaluate(() => {
    const kf = (window as unknown as { __kf: { app: { universeLab(c: { kind: 'elements'; id: string; aKm: number; e: number; iDeg: number; nodeDeg: number; periapsisArgDeg: number; trueAnomalyDeg: number }): void } } }).__kf;
    kf.app.universeLab({ kind: 'elements', id: 'moon', aKm: 15_000, e: 0, iDeg: 5, nodeDeg: 0, periapsisArgDeg: 0, trueAnomalyDeg: 0 });
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  await expect(page.getByTestId('lab-history')).toContainText('Moon torn apart by Earth’s tides inside its Roche limit', LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('moon-piece-')).length, LIVE).toBe(8);
  await expect.poll(async () => (await lab(page))?.swarms.find((w) => w.id.startsWith('dust-moon'))?.primary, LIVE).toBe('earth');
  expect((await lab(page))?.bodies.some((b) => b.id === 'moon')).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('the camera follows and frames the laboratory’s own bodies: by the keyboard; a body that breaks up hands it to the largest of what is left, one that merges to its survivor; a piece kept framed as it flies, the camera above every body', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await preset(page, 'two');
  await pause(page);
  // A Mars-mass body 20,000 km from the planet, closing at 40 km/s: Leinhardt and Stewart's erosion regime (as lab.spec's breakup).
  expect((await command(page, { kind: 'addState', relativeTo: 'planet', posKm: [-20_000, 1500, 0], velKmS: [40, 0, 0], massKg: 6.4e23, radiusKm: 3390, name: 'Impactor' }))?.ok).toBe(true);
  await expect.poll(async () => (await lab(page))?.bodies.length, LIVE).toBe(3);
  // Followed by the keyboard: from Remove, Tab reaches Follow and Enter presses it; the readout names it and measures from it.
  await choose(page, 'body-1');
  await page.getByTestId('lab-remove').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('lab-follow')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => settledOn(page), LIVE).toBe('lab:body-1');
  await expect(page.getByTestId('universe-readout')).toContainText('Impactor');
  const near = await view(page);
  expect((near?.distanceKm ?? 0) - (near?.altitudeKm ?? 0)).toBeCloseTo(3390, 0);
  // At a minute a second it strikes the planet and breaks up: the camera goes on with the planet's remnant, the largest of what is left.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 60 });
  });
  await expect(page.getByTestId('lab-history')).toContainText(/Impactor struck Planet at [\d.]+ km\/s: erosion/, LIVE);
  await expect.poll(() => (view(page).then((v) => v?.focus)), LIVE).toBe('lab:planet');
  await pause(page);
  // Its first piece of debris, followed with the inspector's button.
  const breakup = (await lab(page))?.events.find((e) => e.kind === 'fragment');
  expect(breakup?.absorbed).toBe('body-1');
  const pieces = ((await lab(page))?.bodies ?? []).map((b) => b.id).filter((id) => /^debris-\d+-\d+$/u.test(id));
  const piece = pieces.find((id) => id.endsWith('-1')) ?? pieces[0] ?? '';
  expect(piece).toMatch(/^debris-\d+-1$/u);
  await choose(page, piece);
  await page.getByTestId('lab-follow').click();
  await expect.poll(() => settledOn(page), LIVE).toBe(`lab:${piece}`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const framed = (await view(page))?.distanceKm ?? 0;
  const from = (await body(page, piece))?.distanceKm ?? 0;
  // Ten seconds of its flight at a minute a second, every frame: the distance within 5% of its framing, the camera above every body of the experiment.
  const run = await page.evaluate(async () => {
    const kf = (window as unknown as KfHook).__kf;
    kf.universe.labDraw?.();
    kf.app.universeTime({ kind: 'rate', rate: 60 });
    const out: Array<{ focus: string; distanceKm: number; lowestKm: number | null; at: [number, number, number] }> = [];
    const start = performance.now();
    while (performance.now() - start < 10_000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const v = kf.universe.state();
      const d = kf.universe.labDraw?.() as { lowestKm: number | null } | null;
      if (v) out.push({ focus: v.focus, distanceKm: v.distanceKm, lowestKm: d?.lowestKm ?? null, at: [v.camera.x, v.camera.y, v.camera.z] });
    }
    return out;
  });
  await pause(page);
  expect(run.length).toBeGreaterThan(100);
  expect(run.filter((r) => r.focus !== `lab:${piece}`)).toEqual([]);
  const spread = Math.max(...run.map((r) => Math.abs(r.distanceKm / framed - 1)));
  expect(spread).toBeLessThan(0.05);
  expect(Math.min(...run.map((r) => r.lowestKm ?? Infinity))).toBeGreaterThan(0);
  // It flew (from the planet by a fifth of the camera's distance from it at least: four times what the framing allows), and the camera went with it.
  expect(Math.abs(((await body(page, piece))?.distanceKm ?? 0) - from)).toBeGreaterThan(0.2 * framed);
  const [x0 = 0, y0 = 0, z0 = 0] = run[0]?.at ?? [];
  const [x1 = 0, y1 = 0, z1 = 0] = run[run.length - 1]?.at ?? [];
  expect(Math.hypot(x1 - x0, y1 - y0, z1 - z0)).toBeGreaterThan(0.2 * framed);
  // A stone falling straight on to the planet below the escape speed (about 6 km/s at contact) merges: the camera following it goes on with the planet.
  const stone = await command(page, { kind: 'addState', relativeTo: 'planet', posKm: [-8000, 0, 0], velKmS: [3, 0, 0], massKg: 1.571e12, radiusKm: 0.5, name: 'Stone' });
  const stoneId = stone?.ok ? (stone.created[0] ?? '') : '';
  expect(stoneId).not.toBe('');
  await expect.poll(async () => (await command(page, { kind: 'follow', id: stoneId }))?.ok, LIVE).toBe(true);
  await expect.poll(() => settledOn(page), LIVE).toBe(`lab:${stoneId}`);
  // Down to the ground with it, every frame: held above the planet's floor as the stone goes in, above every body.
  const fall = await page.evaluate(async (id) => {
    const kf = (window as unknown as KfHook).__kf;
    kf.universe.labDraw?.();
    kf.app.universeTime({ kind: 'rate', rate: 60 });
    let lowest = Infinity;
    let frames = 0;
    const start = performance.now();
    while (performance.now() - start < 60_000 && !kf.universe.state()?.lab?.events.some((e) => e.absorbed === id)) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      lowest = Math.min(lowest, (kf.universe.labDraw?.() as { lowestKm: number | null } | null)?.lowestKm ?? Infinity);
      frames += 1;
    }
    return { lowest, frames };
  }, stoneId);
  expect(fall.frames).toBeGreaterThan(30);
  expect(fall.lowest).toBeGreaterThan(0);
  await expect.poll(async () => (await lab(page))?.events.find((e) => e.absorbed === stoneId)?.kind, LIVE).toBe('merge');
  await expect.poll(() => (view(page).then((v) => v?.focus)), LIVE).toBe('lab:planet');
  expect(pageErrors).toEqual([]);
});

test('the two-body laboratory opens on its star, the Earth’s tiles aimed at nothing; its planet followed, named and measured; a body removed lets the camera go where it is; leaving, the real bodies are flown to as ever', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await preset(page, 'two');
  // On its star, the hidden Sun standing in (as built: docs/SANDBOX-ROADMAP.md W1.9), the readout naming it; the Earth hidden, its tiles streaming nothing.
  await expect.poll(() => settledOn(page), LIVE).toBe('sun');
  await expect(page.getByTestId('universe-readout')).toHaveText(/^Star\d/u, LIVE);
  await expect.poll(async () => (await view(page))?.imagery?.clear.zoom, LIVE).toBe(-1);
  expect((await view(page))?.imagery?.showing).toEqual({ clear: false, today: false });
  await pause(page);
  // Its planet, followed: named and measured as itself (the Earth's size, from its own centre).
  await choose(page, 'planet');
  await page.getByTestId('lab-follow').click();
  await expect.poll(() => settledOn(page), LIVE).toBe('lab:planet');
  await expect(page.getByTestId('universe-readout')).toHaveText(/^Planet\d/u, LIVE);
  const on = await view(page);
  expect((on?.distanceKm ?? 0) - (on?.altitudeKm ?? 0)).toBeCloseTo(6371, -1);
  expect((await view(page))?.imagery?.showing.clear).toBe(false);
  // A rock beside it, followed, then removed: the follow ends where the camera is, flying freely (paused: nothing moves).
  const rock = await command(page, { kind: 'addState', relativeTo: 'planet', posKm: [30_000, 0, 0], velKmS: [0, 3.6, 0], massKg: 1e19, radiusKm: 100, name: 'Rock' });
  const rockId = rock?.ok ? (rock.created[0] ?? '') : '';
  await expect.poll(async () => (await command(page, { kind: 'follow', id: rockId }))?.ok, LIVE).toBe(true);
  await expect.poll(() => settledOn(page), LIVE).toBe(`lab:${rockId}`);
  const before = (await view(page))?.camera;
  expect((await command(page, { kind: 'remove', id: rockId }))?.ok).toBe(true);
  await expect.poll(async () => (await view(page))?.mode, LIVE).toBe('flight');
  const after = await view(page);
  expect(after?.focus).not.toBe(`lab:${rockId}`);
  expect(Math.hypot((after?.camera.x ?? 0) - (before?.x ?? 0), (after?.camera.y ?? 0) - (before?.y ?? 0), (after?.camera.z ?? 0) - (before?.z ?? 0))).toBeLessThan(1);
  // Following the planet again, then leaving: the camera by a real body, and the Earth flown to from the navigator.
  await command(page, { kind: 'follow', id: 'planet' });
  await expect.poll(() => settledOn(page), LIVE).toBe('lab:planet');
  await page.getByTestId('lab-back').click();
  await expect.poll(async () => (await view(page))?.lab ?? null, LIVE).toBeNull();
  expect((await view(page))?.focus).not.toMatch(/^lab:/u);
  await page.getByTestId('universe-bodies').getByRole('button', { name: 'Earth', exact: true }).click();
  await expect.poll(() => settledOn(page), LIVE).toBe('earth');
  expect(pageErrors).toEqual([]);
});
