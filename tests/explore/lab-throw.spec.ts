/**
 * Throwing a rock, slowing down for events, and edits with answers, in the laboratory's panel
 * (src/ui/explore/lab-panel, src/explore/lab; docs/SANDBOX-ROADMAP.md W1.1, W1.12, W1.13):
 * - the throw worked out first and shown ("integrated ahead with the same rules"), then thrown: the rock
 *   chosen, the clock slowing as it comes, the event card naming what was asked beside what happened;
 * - "Slow down for events" on by default, kept when turned off (this browser), Esc and "Full speed"
 *   calling it off without leaving the laboratory;
 * - every edit answered (applied with the bodies it made, or refused with the reason): the tenth doubling
 *   of the Sun refused and Double then disabled with why, the save still restoring; a rate past the
 *   fastest held to it; a command sent with the laboratory's opening honoured;
 * - presses in bursts on every new control, the throw section opened and closed twenty times, and the
 *   panel fitting at five window sizes.
 */
import type { Page } from '@playwright/test';
import type { LabCommand, LabEditResult, UniverseLab } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { fits, frames, spam } from '../support/layout';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 90_000 * SLOW };
test.use({ reducedMotion: 'reduce', labSlow: true });

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const command = (page: Page, c: LabCommand): Promise<LabEditResult> =>
  page.evaluate(async (x) => {
    const answer = await (window as unknown as KfHook).__kf.universe.lab?.(x);
    if (!answer) throw new Error('the laboratory is not loaded');
    return answer;
  }, c);

async function openLab(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
}

async function pause(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (!(await lab(page))?.paused) await page.locator('body').press('Space');
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
}

test('a rock thrown from the panel: worked out first, then thrown; the clock slows as it comes; the card says what was asked and what happened', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  await page.getByTestId('lab-throw').locator('summary').click();
  await expect(page.getByTestId('lab-throw-target')).toHaveValue('earth');
  // Nothing to throw before it is worked out.
  await expect(page.getByTestId('lab-throw-go')).toBeDisabled();
  await page.getByTestId('lab-throw-impactor').selectOption('asteroid');
  await page.getByTestId('lab-throw-speed').fill('18');
  await page.getByTestId('lab-throw-angle').fill('45');
  await page.getByTestId('lab-throw-lead').selectOption(String(10 * 86_400));
  await page.getByTestId('lab-aim').click();
  await expect(page.getByTestId('lab-aim-result')).toContainText('Integrated ahead with the same rules: it strikes Earth in', LIVE);
  await expect(page.getByTestId('lab-aim-result')).toContainText('crater');
  const aimed = (await lab(page))?.aim;
  expect(aimed?.status).toBe('ready');
  // Within 2 per cent of the speed asked for (with the fall) and 2 degrees of the angle.
  expect(Math.abs((aimed?.contact?.angleDeg ?? 0) - 45)).toBeLessThanOrEqual(2);
  // A change to what is asked puts the worked-out throw away.
  await page.getByTestId('lab-throw-speed').fill('19');
  await page.getByTestId('lab-throw-speed').dispatchEvent('change');
  await expect.poll(async () => (await lab(page))?.aim ?? null).toBeNull();
  await page.getByTestId('lab-throw-speed').fill('18');
  await page.getByTestId('lab-aim').click();
  await expect(page.getByTestId('lab-throw-go')).toBeEnabled(LIVE);
  await page.getByTestId('lab-throw-go').click();
  await expect(page.getByTestId('lab-aim-result')).toContainText('Thrown.');
  await expect.poll(async () => (await lab(page))?.selected ?? '', LIVE).toMatch(/^rock-/u);
  const rock = (await lab(page))?.selected ?? '';
  // A second press throws nothing more.
  await spam(page.getByTestId('lab-throw-go'), 10);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Space');
  // The clock slows as it comes (the line says so, and how long), then the card.
  await expect(page.getByTestId('lab-slow')).toContainText('Slowed for the impact', LIVE);
  await expect(page.getByTestId('lab-event-card')).toBeVisible(LIVE);
  await expect(page.getByTestId('lab-event-title')).toContainText('Impact: Earth');
  await expect(page.getByTestId('lab-event-facts')).toContainText('Thrown at 18');
  await expect(page.getByTestId('lab-event-facts')).toContainText('A crater');
  expect((await lab(page))?.bodies.filter((b) => b.id.startsWith('rock-')).length).toBe(0);
  expect((await lab(page))?.events.filter((e) => e.absorbed === rock).length).toBe(1);
  // Closed, it stays closed until the next event.
  await page.getByTestId('lab-event-close').click();
  await expect(page.getByTestId('lab-event-card')).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('slowing down for events: on by default, kept off once turned off, called off by Esc and by Full speed without leaving the laboratory', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await expect(page.getByTestId('lab-slow-toggle')).toBeChecked();
  expect((await lab(page))?.slow.on).toBe(true);
  const throwAt = async (): Promise<void> => {
    await command(page, { kind: 'reset' });
    await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
    await command(page, { kind: 'aim', target: 'earth', impactor: 'stone', vInfKmS: 20, angleDeg: 45, leadS: 10 * 86_400 });
    await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
    expect((await command(page, { kind: 'throw' })).ok).toBe(true);
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 86_400 });
    });
  };
  // Esc while it slows: back to the rate set, still in the laboratory.
  await throwAt();
  await expect.poll(async () => (await lab(page))?.slow.active?.rate ?? 86_400, LIVE).toBeLessThan(86_400);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').press('Escape');
  await expect.poll(async () => (await lab(page))?.slow.active ?? null).toBeNull();
  await expect(page).toHaveURL(/#\/universe\/lab/u);
  await expect(page.getByTestId('lab-panel')).toBeVisible();
  // Full speed, the same (a phone has no Esc).
  await throwAt();
  await expect(page.getByTestId('lab-slow-cancel')).toBeVisible(LIVE);
  await page.getByTestId('lab-slow-cancel').click();
  await expect.poll(async () => (await lab(page))?.slow.active ?? null).toBeNull();
  await expect(page.getByTestId('lab-slow-cancel')).toBeHidden();
  // Turned off, it stays off (kept in this browser), and nothing slows.
  await page.getByTestId('lab-slow-toggle').uncheck();
  await expect.poll(async () => (await lab(page))?.slow.on).toBe(false);
  await page.reload();
  await waitForUniverse(page);
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect(page.getByTestId('lab-slow-toggle')).not.toBeChecked();
  await expect.poll(async () => (await lab(page))?.slow.on, LIVE).toBe(false);
  expect(pageErrors).toEqual([]);
});

test('every edit answered: applied with what it made, or refused with why; the tenth doubling of the Sun refused, Double disabled with the reason, the save restoring', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // A command in the same task as opening the laboratory is honoured once it has come (here: the two-body laboratory).
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.openLab();
    app.universeLab({ kind: 'start', seed: 'two' });
  });
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  await command(page, { kind: 'start', seed: 'solar' });
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  await pause(page);
  // Answers: an add says what it made; a body that is not there is refused.
  const made = await command(page, { kind: 'addOrbit', primary: 'earth', distanceKm: 50_000, massKg: 1e15, radiusKm: 5, name: 'probe' });
  expect(made.ok).toBe(true);
  expect(made.ok && made.created.length).toBe(1);
  expect(await command(page, { kind: 'mass', id: 'nobody', massKg: 1 })).toEqual({ ok: false, reason: 'names a body that does not exist' });
  expect((await command(page, { kind: 'remove', id: 'sun' })).ok).toBe(false);
  // Double on the Sun: nine doublings fit; the tenth would pass what a save can hold (GM 10^14).
  await page.getByTestId('lab-body-sun').click();
  for (let k = 0; k < 20; k += 1) {
    if (await page.getByTestId('lab-mass-double').isDisabled()) break;
    await page.getByTestId('lab-mass-double').click();
    await expect.poll(async () => (await lab(page))?.unapplied, LIVE).toBe(0);
  }
  await expect(page.getByTestId('lab-mass-double')).toBeDisabled();
  await expect(page.getByTestId('lab-mass-limit')).toContainText('the most mass an experiment can hold');
  const sun = (await lab(page))?.bodies.find((b) => b.id === 'sun');
  expect(sun?.gm).toBeGreaterThan(1e14 / 2);
  expect(sun?.gm).toBeLessThanOrEqual(1e14);
  // A tool asking anyway is refused, with the reason shown.
  const refused = await command(page, { kind: 'mass', id: 'sun', massKg: (sun?.massKg ?? 0) * 2 });
  expect(refused).toEqual({ ok: false, reason: 'mass out of range' });
  // Said in the visitor's words, not the engine's.
  await expect(page.getByTestId('lab-refused')).toContainText('Not done: that mass is more than an experiment can hold');
  // The save restores.
  await page.getByTestId('lab-tools').locator('summary').click();
  await page.getByTestId('lab-save').click();
  await expect(page.getByTestId('lab-status')).toContainText('Saved', LIVE);
  await page.getByTestId('lab-restore-saved').click();
  await expect(page.getByTestId('lab-status')).toContainText('Loaded', LIVE);
  // A rate past the fastest is held to it; one not a number changes nothing.
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.universeTime({ kind: 'rate', rate: 1e15 });
    app.universeTime({ kind: 'rate', rate: Number.NaN });
  });
  await expect.poll(async () => (await lab(page))?.requestedRate, LIVE).toBe(2_592_000);
  expect(pageErrors).toEqual([]);
});

test('bursts on the new controls, the throw section opened and closed twenty times, and the panel fitting at five window sizes', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  const summary = page.getByTestId('lab-throw').locator('summary');
  for (let k = 0; k < 20; k += 1) await summary.click();
  await expect(page.getByTestId('lab-throw')).not.toHaveAttribute('open', '');
  await summary.click();
  // Presses in bursts: working it out, throwing, the slowing's switch and Full speed, the card's Close.
  await spam(page.getByTestId('lab-aim'), 30);
  await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
  await spam(page.getByTestId('lab-throw-go'), 30);
  await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('rock-')).length, LIVE).toBe(1);
  await spam(page.getByTestId('lab-slow-toggle'), 31);
  await expect.poll(async () => (await lab(page))?.slow.on).toBe(false);
  await spam(page.getByTestId('lab-slow-toggle'), 1);
  await expect.poll(async () => (await lab(page))?.slow.on).toBe(true);
  await spam(page.getByTestId('lab-slow-cancel'), 20);
  await frames(page, 4);
  expect((await lab(page))?.bodies.filter((b) => b.id.startsWith('rock-')).length).toBe(1);
  for (const [width, height] of [[1280, 800], [1920, 1080], [768, 1024], [390, 844], [844, 390]] as const) {
    await page.setViewportSize({ width, height });
    await frames(page, 6);
    // On a phone the navigator is a sheet: pulled up, the panel is there.
    const toggle = page.getByTestId('universe-nav-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('lab-throw')).toBeVisible(LIVE);
    await page.getByTestId('lab-throw').scrollIntoViewIfNeeded();
    await page.getByTestId('lab-aim').scrollIntoViewIfNeeded();
    await fits(page, `${width}x${height}`);
  }
  expect(pageErrors).toEqual([]);
});

test('a throw worked out after an edit at the same step and thrown after the clock has run on strikes exactly as shown; a refusal says what to change; Throw says how it comes in', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  // An edit at this step (a small moon), then the throw worked out here, the clock run on, then thrown.
  expect((await command(page, { kind: 'addOrbit', primary: 'earth', distanceKm: 900_000, massKg: 1e15, radiusKm: 5, name: 'probe' })).ok).toBe(true);
  await expect.poll(async () => (await lab(page))?.unapplied, LIVE).toBe(0);
  await command(page, { kind: 'aim', target: 'earth', impactor: 'asteroid', vInfKmS: 18, angleDeg: 50, leadS: 2 * 86_400 });
  await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
  const planned = (await lab(page))?.aim?.contact;
  expect(planned?.with).toBe('earth');
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 3600 });
  });
  await expect.poll(async () => (await lab(page))?.elapsedS ?? 0, LIVE).toBeGreaterThan(3 * 3600);
  // With slowing down for events off, Throw says it comes in at the rate set.
  await command(page, { kind: 'slow', on: false });
  expect((await command(page, { kind: 'throw' })).ok).toBe(true);
  await expect(page.getByTestId('lab-aim-result')).toContainText('It comes in at the rate set');
  const rock = (await lab(page))?.aim?.id ?? '';
  expect(rock).toMatch(/^rock-/u);
  // The run went back to just after the edit, kept it, and the contact is the one shown, bit for bit.
  expect((await lab(page))?.bodies.some((b) => b.name === 'probe')).toBe(true);
  await expect.poll(async () => (await lab(page))?.events.find((e) => e.absorbed === rock || e.survivor === rock)?.speedKmS ?? null, LIVE).toBe(planned?.speedKmS ?? -1);
  // A refusal in the visitor's words, with what to change: worked out, then an edit, then Throw (the experiment has changed).
  await command(page, { kind: 'aim', target: 'earth', impactor: 'stone', vInfKmS: 20, angleDeg: 45, leadS: 86_400 });
  await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
  expect((await command(page, { kind: 'addOrbit', primary: 'earth', distanceKm: 950_000, massKg: 1e15, radiusKm: 5, name: 'second probe' })).ok).toBe(true);
  await expect.poll(async () => (await lab(page))?.unapplied, LIVE).toBe(0);
  expect((await command(page, { kind: 'throw' })).ok).toBe(false);
  await page.getByTestId('lab-throw').locator('summary').click();
  await expect(page.getByTestId('lab-aim-result')).toContainText('the experiment has changed since it was worked out: work it out again');
  await expect(page.getByTestId('lab-aim-result')).toHaveAttribute('aria-live', 'polite');
  expect(pageErrors).toEqual([]);
});

test('working a heavy throw out a month ahead never holds up the run, and Work it out waits while it works (bursts of presses ask once)', async ({ page, kf, pageErrors }) => {
  test.setTimeout(300_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await page.getByTestId('lab-throw').locator('summary').click();
  await page.getByTestId('lab-throw-impactor').selectOption('mars');
  await page.getByTestId('lab-throw-speed').fill('2');
  await page.getByTestId('lab-throw-angle').fill('15');
  await page.getByTestId('lab-throw-lead').selectOption(String(30 * 86_400));
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 3600 });
  });
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(false);
  // While it works the button waits (a press then does nothing), and the run goes on at its pace.
  await page.getByTestId('lab-aim').click();
  await expect(page.getByTestId('lab-aim')).toBeDisabled();
  const samples: number[] = [];
  for (let k = 0; k < 10; k += 1) {
    samples.push((await lab(page))?.elapsedS ?? 0);
    await spam(page.getByTestId('lab-aim'), 5);
    await page.waitForTimeout(150);
  }
  for (let k = 1; k < samples.length; k += 1) expect(samples[k] ?? 0).toBeGreaterThan(samples[k - 1] ?? 0);
  await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).not.toBe('working');
  await expect(page.getByTestId('lab-aim')).toBeEnabled();
  // Thirty presses in a burst through the API too: one answer, the latest, and the run never stalls a second.
  const before = (await lab(page))?.elapsedS ?? 0;
  const t0 = Date.now();
  await page.evaluate(async () => {
    const kf = (window as unknown as KfHook).__kf;
    await Promise.all(Array.from({ length: 30 }, () => kf.universe.lab?.({ kind: 'aim', target: 'earth', impactor: 'mars', vInfKmS: 2, angleDeg: 15, leadS: 30 * 86_400 }) ?? Promise.resolve(null)));
  });
  await page.waitForTimeout(1000);
  const ran = ((await lab(page))?.elapsedS ?? 0) - before;
  expect(ran).toBeGreaterThan(0.4 * 3600 * ((Date.now() - t0) / 1000));
  expect(pageErrors).toEqual([]);
});

test('the chosen body off the view has a pointer at the clear view’s edge, toward it, and none once it is in view', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await pause(page);
  // A small body behind the camera (the view's direction, render frame to the scenario's: x, -z, y), chosen.
  const back = await page.evaluate(() => {
    const c = ((window as unknown as KfHook).__kf.universe.labDraw?.() as { camera: { x: number; y: number; z: number } | null } | null)?.camera;
    return c ? [-c.x, c.z, -c.y] : [1, 0, 0];
  });
  const made = await command(page, { kind: 'addState', relativeTo: 'earth', posKm: [(back[0] ?? 0) * 200_000, (back[1] ?? 0) * 200_000, (back[2] ?? 0) * 200_000], velKmS: [0, 0, 0], massKg: 1e15, radiusKm: 5, name: 'far probe' });
  expect(made.ok).toBe(true);
  const id = made.ok ? (made.created[0] ?? '') : '';
  await command(page, { kind: 'select', id });
  const pointers = async (): Promise<Array<{ text: string; x: number; y: number; w: number; h: number }>> =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')]
        .filter((el) => /^far probe [→↘↓↙←↖↑↗]$/u.test(el.textContent.trim()) && Number(getComputedStyle(el.closest('[style]') ?? el).opacity) > 0.1)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
        }),
    );
  await expect.poll(async () => (await pointers()).length, LIVE).toBe(1);
  // Inside the view, clear of the panel.
  const [p] = await pointers();
  const panel = await page.getByTestId('universe-bodies').boundingBox();
  const size = page.viewportSize();
  expect(p?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((p?.x ?? 0) + (p?.w ?? 0)).toBeLessThanOrEqual(size?.width ?? 0);
  expect(p?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((p?.y ?? 0) + (p?.h ?? 0)).toBeLessThanOrEqual(size?.height ?? 0);
  if (panel && p) expect(p.x + p.w <= panel.x || p.y >= panel.y + panel.height || p.x >= panel.x + panel.width).toBe(true);
  // Choosing another body (a world of the ten has its own names): no pointer.
  await command(page, { kind: 'select', id: 'moon' });
  await expect.poll(async () => (await pointers()).length, LIVE).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('the two-body laboratory opens on its star (the view never left on the world it lacks), even during the entry glide', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.evaluate(() => {
    const app = (window as unknown as KfHook).__kf.app;
    app.openLab();
    app.universeLab({ kind: 'start', seed: 'two' });
  });
  await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
  // Within two seconds the view is going to (or at) the star: the Earth, hidden, is no longer in focus.
  await expect.poll(async () => (await view(page))?.focus, { timeout: 2000 * SLOW }).toBe('sun');
  expect((await lab(page))?.standIn?.name).toBe('Star');
  expect(pageErrors).toEqual([]);
});

test('a thrown rock’s encounters count down from the moment drawn: its merger and the names of its closest approaches never say a time already past', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  await openLab(page);
  await command(page, { kind: 'slow', on: false });
  await pause(page);
  await command(page, { kind: 'aim', target: 'earth', impactor: 'stone', vInfKmS: 15, angleDeg: 45, leadS: 2 * 86_400 });
  await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
  expect((await command(page, { kind: 'throw' })).ok).toBe(true);
  await expect.poll(async () => (await lab(page))?.prediction?.merged?.t ?? null, LIVE).not.toBeNull();
  const first = await lab(page);
  const left0 = first?.prediction?.merged?.t ?? 0;
  const at0 = first?.elapsedS ?? 0;
  // Paused where it was worked out: what is left is the contact's time (the prediction's own steps, begun anew, within a thousandth).
  expect(Math.abs(left0 - (first?.aim?.contact?.inS ?? 0))).toBeLessThan(0.001 * left0);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: 3600 });
  });
  await expect.poll(async () => ((await lab(page))?.elapsedS ?? 0) - at0, LIVE).toBeGreaterThan(6 * 3600);
  // Counted down by the time that passed (within the prediction's own sampling), as the encounter names say.
  const later = await lab(page);
  const passed = (later?.elapsedS ?? 0) - at0;
  const left1 = later?.prediction?.merged?.t ?? 0;
  expect(Math.abs(left0 - passed - left1)).toBeLessThan(0.05 * left0);
  const said = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].map((el) => el.textContent).filter((t) => t.startsWith('Closest to')));
  for (const t of said) {
    const m = /in ([\d.]+) (h|days)/u.exec(t);
    const s = m ? Number(m[1]) * (m[2] === 'h' ? 3600 : 86_400) : -1;
    expect(s, t).toBeGreaterThanOrEqual(0);
    expect(s, t).toBeLessThanOrEqual(left1 + 3 * 3600);
  }
  expect(pageErrors).toEqual([]);
});
