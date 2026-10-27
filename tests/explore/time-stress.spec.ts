/**
 * The time machine under stress (src/explore/time, src/ui/explore/time-control, the time handler in
 * src/explore/index): every press at either end of time moves the clock, the ladder's ends say why,
 * NaN and infinite commands never get in, the arrival glide runs at the rate set, the keys work after
 * the date field and Space never presses a focused time button, dates far beyond JPL's tables (and
 * out of range, and impossible ones) say what they do, fast time never strobes a world's turn nor
 * day and night on foot, hundreds of random presses inside single frames leave a sound state, and the
 * row fits and works at five sizes of window (two of them phones, folded and pulled up, with taps
 * between the sheet's folds). Page errors and console errors fail every test.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { UniverseView } from '../../src/core/types';
import { TIME_RATES } from '../../src/explore/time';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, place, step, view, waitForUniverse } from '../support/universe';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const LIVE = { timeout: 30_000 * SLOW };
const BUTTONS = ['universe-time-reverse', 'universe-time-slower', 'universe-time-pause', 'universe-time-faster', 'universe-time-now'] as const;
const LADDER: readonly number[] = TIME_RATES;
const MAX = 2_592_000;
const DAY_MS = 86_400_000;

const state = async (page: Page): Promise<UniverseView> => {
  const v = await view(page);
  if (!v) throw new Error('the explorer is not on screen');
  return v;
};
const dayShown = async (page: Page): Promise<string> => new Date((await state(page)).unixMs).toISOString().slice(0, 10);
const command = (page: Page, c: Parameters<KfHook['__kf']['app']['universeTime']>[0]): Promise<void> =>
  page.evaluate((x) => {
    (window as unknown as KfHook).__kf.app.universeTime(x);
  }, c);
/** Synchronous clicks inside one task (one frame), by test id. */
const burst = (page: Page, ids: readonly string[]): Promise<void> =>
  page.evaluate((list) => {
    for (const id of list) document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
  }, ids);
/** The theories beyond JPL's tables have come: the span reaches 1600 to 2400. */
const wideSpan = async (page: Page): Promise<void> => {
  await expect.poll(async () => (await state(page)).time.startMs, LIVE).toBeLessThan(Date.UTC(1601, 0, 1));
};
const sound = (v: UniverseView): void => {
  expect(LADDER.includes(Math.abs(v.time.rate))).toBe(true);
  expect(Number.isFinite(v.jdTdb)).toBe(true);
  expect(v.unixMs).toBeGreaterThanOrEqual(v.time.startMs - DAY_MS);
  expect(v.unixMs).toBeLessThanOrEqual(v.time.endMs + DAY_MS);
  // Never running into the end it stopped at.
  const into = (v.time.edge === 'start' && v.time.rate < 0) || (v.time.edge === 'end' && v.time.rate > 0);
  expect(into && !v.time.paused).toBe(false);
};

test.describe('the time machine at 1280x800', () => {
  test('every press at either end of time moves the clock; the ladder’s ends say why; NaN and infinity never get in', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await wideSpan(page);
    await step(page, 2);
    const rate = page.getByTestId('universe-time-rate');
    const note = page.getByTestId('universe-time-note');

    // Commands an interface, a lesson or an assistant might send: none breaks the clock.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, -1e300, -0]) {
      await command(page, { kind: 'rate', rate: bad });
      await step(page, 3);
      sound(await state(page));
    }
    for (const bad of [Number.NaN, 0, 1e12, Number.POSITIVE_INFINITY]) {
      await command(page, { kind: 'date', jdUtc: bad });
      await step(page, 3);
      sound(await state(page));
    }
    expect((await state(page)).time.rate).toBe(-MAX);
    await command(page, { kind: 'now' });
    await step(page, 2);

    // The ladder's ends: drawn disabled, with the reason when pressed (by click or key).
    for (let i = 0; i < 12; i += 1) await page.keyboard.press(']');
    const faster = page.getByTestId('universe-time-faster');
    await expect(faster).toHaveAttribute('aria-disabled', 'true');
    const style = await faster.evaluate((el) => ({ opacity: Number(getComputedStyle(el).opacity), cursor: getComputedStyle(el).cursor }));
    expect(style.opacity).toBeLessThan(0.6);
    expect(style.cursor).toBe('not-allowed');
    // (Forced: a pointer presses it like any button; Playwright's own check takes aria-disabled for disabled.)
    await faster.click({ force: true });
    await expect(note).toHaveText('Already the fastest');
    expect((await state(page)).time.rate).toBe(MAX);
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('[');
    await expect(page.getByTestId('universe-time-slower')).toHaveAttribute('aria-disabled', 'true');
    await expect(faster).toHaveAttribute('aria-disabled', 'false');
    await page.keyboard.press('[');
    await expect(note).toHaveText('Already the slowest: real time');
    expect((await state(page)).time.rate).toBe(1);

    // At each end, every button in turn: the clock's date or what the row says changes.
    for (const [edge, day, into] of [['start', '1600-01-02', -MAX], ['end', '2399-12-30', MAX]] as const) {
      for (const id of BUTTONS) {
        await page.getByTestId('universe-time-date').fill(day);
        await command(page, { kind: 'rate', rate: into });
        await expect.poll(async () => {
          await step(page, 2);
          return (await state(page)).time.edge;
        }, LIVE).toBe(edge);
        await expect(rate).toHaveText(edge === 'start' ? 'Time stops here: the start of the explorer’s dates' : 'Time stops here: the end of the explorer’s dates');
        await expect(note).toHaveText(edge === 'start' ? 'Play runs it forwards from here.' : 'Play runs it backwards from here.');
        const before = { jd: (await state(page)).jdTdb, text: await rate.textContent() };
        await page.getByTestId(id).click();
        await step(page, 10);
        const after = { jd: (await state(page)).jdTdb, text: await rate.textContent() };
        expect(after.jd !== before.jd || after.text !== before.text, `${edge}: ${id}`).toBe(true);
        sound(await state(page));
      }
      // Two hundred presses at the end inside one frame: sound, and Now still brings the present.
      await page.getByTestId('universe-time-date').fill(day);
      await command(page, { kind: 'rate', rate: into });
      await expect.poll(async () => {
        await step(page, 2);
        return (await state(page)).time.edge;
      }, LIVE).toBe(edge);
      await burst(page, Array.from({ length: 200 }, (_, k) => BUTTONS[(k * 7) % 4] ?? 'universe-time-pause'));
      await step(page, 5);
      sound(await state(page));
    }
    await page.getByTestId('universe-time-now').click();
    await step(page, 2);
    expect(Math.abs((await state(page)).unixMs - Date.now())).toBeLessThan(5 * 60_000);
    await expect(rate).toHaveText('Real time');
    expect(pageErrors).toEqual([]);
  });

  test('the arrival glide runs at the rate set; a trip says the rate it goes back to', async ({ page, kf, pageErrors }) => {
    test.setTimeout(150_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    // Six hours a second at once, while the camera still glides in (not a trip).
    for (let i = 0; i < 5; i += 1) await page.keyboard.press(']');
    const run = await page.evaluate(
      () =>
        new Promise<{ travelling: boolean; rate: number }>((resolve) => {
          const kf = (window as unknown as KfHook).__kf;
          // (The view is one object, rewritten each frame: its date is copied.)
          const first = kf.universe.state()?.jdTdb ?? Number.NaN;
          const t0 = performance.now();
          const tick = (): void => {
            const v = kf.universe.state();
            if (performance.now() - t0 < 1000 || !v) requestAnimationFrame(tick);
            else resolve({ travelling: v.travelling, rate: ((v.jdTdb - first) * 86_400) / ((performance.now() - t0) / 1000) });
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(run.travelling).toBe(false);
    expect(run.rate).toBeGreaterThan(0.85 * 21_600);
    expect(run.rate).toBeLessThan(1.15 * 21_600);
    // A trip: real time, and the row says what it goes back to.
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.focusBody('mars');
    });
    await expect(page.getByTestId('universe-time-rate')).toHaveText('Real time during the trip, then 6 hours a second', LIVE);
    await page.keyboard.press(']');
    await expect(page.getByTestId('universe-time-rate')).toHaveText('Real time during the trip, then 1 day a second');
    expect(pageErrors).toEqual([]);
  });

  test('keys after the date field; Space pauses even on a focused time button; Enter presses it', async ({ page, kf, pageErrors }) => {
    test.setTimeout(150_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await page.getByTestId('universe-time-date').fill('2030-06-15');
    await expect.poll(() => dayShown(page), LIVE).toBe('2030-06-15');
    await expect(page.getByTestId('universe-time-date')).toBeFocused();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press(']');
    expect((await state(page)).time.rate).toBe(600);
    await page.keyboard.press('\\');
    expect((await state(page)).time.rate).toBe(-600);
    await page.keyboard.press('Space');
    expect((await state(page)).time.paused).toBe(true);
    await page.keyboard.press('Space');
    expect((await state(page)).time.paused).toBe(false);
    // A clicked time button keeps the focus; Space still pauses, it does not press it again.
    await page.getByTestId('universe-time-faster').click();
    expect((await state(page)).time.rate).toBe(-3600);
    await page.keyboard.press('Space');
    expect((await state(page)).time).toMatchObject({ rate: -3600, paused: true });
    // Enter presses it, as a keyboard user expects.
    await page.getByTestId('universe-time-faster').focus();
    await page.keyboard.press('Enter');
    expect((await state(page)).time).toMatchObject({ rate: -21_600, paused: false });
    const results = await new AxeBuilder({ page }).include('[data-testid="universe-time"]').withTags(WCAG_TAGS).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('dates far beyond JPL’s tables, out of range and impossible; back through 4 August 2000', async ({ page, kf, pageErrors }) => {
    test.setTimeout(180_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await wideSpan(page);
    const date = page.getByTestId('universe-time-date');
    const note = page.getByTestId('universe-time-note');
    // The owner's day: shown, with the model named.
    await date.fill('2000-08-04');
    await expect.poll(() => dayShown(page), LIVE).toBe('2000-08-04');
    expect((await state(page)).time).toMatchObject({ edge: null, beyond: { moon: true, planets: false } });
    await expect(note).toContainText('Meeus’s theory');
    await expect(date).toHaveValue('2000-08-04');
    await date.fill('1750-03-01');
    await expect.poll(() => dayShown(page), LIVE).toBe('1750-03-01');
    await expect(note).toContainText('long-span elements');
    // Before the span: stopped at its start, saying so, the field showing the day it went to (valid).
    await date.fill('1500-01-01');
    await expect.poll(async () => (await state(page)).time.edge, LIVE).toBe('start');
    await expect(page.getByTestId('universe-time-rate')).toHaveText('Time stops here: the start of the explorer’s dates');
    await expect(note).toHaveText('The explorer’s dates run from 1600-01-01 to 2399-12-31');
    await expect(date).toHaveValue('1600-01-01');
    expect(await date.evaluate((el) => (el as HTMLInputElement).matches(':invalid'))).toBe(false);
    await date.fill('9999-12-31');
    await expect.poll(async () => (await state(page)).time.edge, LIVE).toBe('end');
    await expect(date).toHaveValue('2399-12-31');
    // An empty or impossible date changes nothing (the field shows the clock's day again).
    const before = await dayShown(page);
    for (const value of ['', '2030-02-30']) {
      await date.evaluate((el, v) => {
        const input = el as HTMLInputElement;
        input.value = v;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      }, value);
      await page.waitForTimeout(200);
      expect(await dayShown(page)).toBe(before);
      await expect(date).toHaveValue(before);
    }
    // Backwards at thirty days a second from 2001: through 4 August 2000 and on into 1999, nothing stops it.
    await date.fill('2001-01-01');
    await expect.poll(() => dayShown(page), LIVE).toBe('2001-01-01');
    await command(page, { kind: 'rate', rate: -MAX });
    await step(page, 1);
    for (let k = 0; k < 40 && (await state(page)).unixMs > Date.UTC(1999, 11, 1); k += 1) await step(page, 30);
    const v = await state(page);
    expect(v.unixMs).toBeLessThan(Date.UTC(1999, 11, 1));
    expect(v.time).toMatchObject({ edge: null, paused: false });
    expect(pageErrors).toEqual([]);
  });

  test('fast time never strobes the Earth’s turn nor turns it back; the view held over a place stays there', async ({ page, kf, pageErrors }) => {
    test.setTimeout(180_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await place(page, { body: 'earth', distanceKm: 30_000 });
    await step(page, 2);
    /** The longitude under the camera, frame by frame (degrees; the camera does not turn with the Earth). */
    const turns = async (rate: number, frames: number): Promise<{ steps: number[]; held: boolean }> => {
      await command(page, { kind: 'rate', rate });
      await step(page, 40);
      return page.evaluate((n) => {
        const kf = (window as unknown as KfHook).__kf;
        const out: number[] = [];
        let last = kf.universe.state()?.place?.lon ?? 0;
        for (let k = 0; k < n; k += 1) {
          kf.step(1, 1 / 60);
          const lon = kf.universe.state()?.place?.lon ?? last;
          out.push(((lon - last + 540) % 360) - 180);
          last = lon;
        }
        return { steps: out, held: kf.universe.state()?.time.spinHeld ?? false };
      }, frames);
    };
    // A day a second: the Earth turns 6 degrees a frame, eastward (the longitude below falls), shown as it is.
    const day = await turns(86_400, 60);
    expect(day.held).toBe(false);
    for (const d of day.steps) expect(d).toBeCloseTo(-6.02, 0);
    // A week and thirty days a second, either way: held at one hour of its day, never strobing, never back.
    for (const rate of [604_800, 2_592_000, -604_800, -2_592_000]) {
      const fast = await turns(rate, 90);
      expect(fast.held, `held at ${String(rate)}`).toBe(true);
      for (const d of fast.steps) {
        expect(Math.abs(d), `${String(rate)}: ${String(d)} degrees a frame`).toBeLessThan(31);
        // Forwards in time it never turns westward; backwards, never eastward.
        expect(Math.sign(rate) * d, `${String(rate)}: ${String(d)}`).toBeLessThanOrEqual(0.05);
      }
    }
    await expect(page.getByTestId('universe-time-note')).toContainText('Too fast to show it turning');
    // Let go at a day a second: it catches up forwards (westward under the camera), never back.
    const freed = await turns(86_400, 120);
    expect(freed.held).toBe(false);
    for (const d of freed.steps) expect(d).toBeLessThanOrEqual(0.05);
    // Held over a place (Cairo) at a week a second: the place stays under the view.
    await command(page, { kind: 'rate', rate: 1 });
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'goto', lat: 30.04, lon: 31.24, viewKm: 3000 });
    });
    await expect.poll(async () => {
      await step(page, 30);
      return (await state(page)).trip === null && Math.abs(((await state(page)).place?.lon ?? 0) - 31.24) < 3;
    }, LIVE).toBe(true);
    await command(page, { kind: 'rate', rate: 604_800 });
    const held = await page.evaluate(() => {
      const kf = (window as unknown as KfHook).__kf;
      const out: number[] = [];
      let last = kf.universe.state()?.place;
      for (let k = 0; k < 60; k += 1) {
        kf.step(1, 1 / 60);
        const p = kf.universe.state()?.place;
        if (p && last) out.push(Math.hypot(p.lat - last.lat, ((p.lon - last.lon + 540) % 360) - 180));
        last = p;
      }
      return out;
    });
    expect(held.length).toBe(60);
    expect(Math.max(...held)).toBeLessThan(1);
    expect(pageErrors).toEqual([]);
  });

  test('three hundred bursts of random presses inside single frames leave the clock sound', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await wideSpan(page);
    await step(page, 1);
    let seed = 11;
    const next = (): number => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    for (let b = 0; b < 300; b += 1) {
      const ids = Array.from({ length: 1 + Math.floor(next() * 6) }, () => BUTTONS[Math.floor(next() * BUTTONS.length)] ?? 'universe-time-pause');
      await burst(page, ids);
      await step(page, Math.floor(next() * 4));
      if (b % 25 === 0) sound(await state(page));
    }
    sound(await state(page));
    // One more press still changes the state.
    const before = (await state(page)).time;
    await page.getByTestId('universe-time-reverse').click();
    await step(page, 1);
    expect((await state(page)).time.rate).toBe(-before.rate);
    expect(pageErrors).toEqual([]);
  });

  test('on foot: at most an hour a second, so day and night never flicker; the rate set comes back after', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await command(page, { kind: 'rate', rate: MAX });
    await place(page, { body: 'earth', distanceKm: 20_000, azimuthDeg: 30, elevationDeg: 20 });
    await page.getByTestId('living-earth').locator(':scope > summary').click();
    await page.getByTestId('living-walk').click();
    await expect.poll(async () => (await state(page)).walk?.state, { timeout: 120_000 * SLOW }).toBe('walking');
    // Thirty days a second chosen: on foot an hour a second, said so, Faster disabled with why.
    expect((await state(page)).time).toMatchObject({ rate: MAX, held: 'foot' });
    await expect(page.getByTestId('universe-time-rate')).toHaveText('1 hour a second (the most on foot)');
    await expect(page.getByTestId('universe-time-faster')).toHaveAttribute('aria-disabled', 'true');
    await burst(page, Array.from({ length: 200 }, () => 'universe-time-faster'));
    await expect(page.getByTestId('universe-time-note')).toHaveText('On foot, at most an hour a second: day and night never flicker');
    expect((await state(page)).time.rate).toBe(MAX);
    // Slower steps down from what is shown (an hour a second): a visible change; Faster back up to the most, then no further (it says why).
    await page.getByTestId('universe-time-slower').click();
    expect((await state(page)).time.rate).toBe(600);
    await page.getByTestId('universe-time-faster').click();
    await page.getByTestId('universe-time-faster').click({ force: true });
    expect((await state(page)).time.rate).toBe(3600);
    await command(page, { kind: 'rate', rate: MAX });
    // The Sun's height over ten seconds of frames at the most allowed: at most one crossing of the horizon (not 14 a second).
    const crossings = await page.evaluate(() => {
      const kf = (window as unknown as KfHook).__kf;
      let last = kf.universe.state()?.walk?.sunElevationDeg ?? 0;
      let n = 0;
      for (let k = 0; k < 600; k += 1) {
        kf.step(1, 1 / 60);
        const e = kf.universe.state()?.walk?.sunElevationDeg ?? last;
        if (Math.sign(e) !== Math.sign(last)) n += 1;
        last = e;
      }
      return n;
    });
    expect(crossings).toBeLessThanOrEqual(1);
    // Back to orbit: the clock runs at the rate set again (thirty days a second).
    await page.getByTestId('walk-end').click();
    await expect.poll(async () => {
      await step(page, 30);
      return (await state(page)).walk;
    }, LIVE).toBeNull();
    await expect.poll(async () => {
      await step(page, 30);
      return (await state(page)).time.held;
    }, LIVE).toBeNull();
    expect((await state(page)).time.rate).toBe(MAX);
    expect(pageErrors).toEqual([]);
  });
});

/** Every control of the row: in the window, on top at its middle (or reached by scrolling its own container), not overlapping another, its text not cut; and no sideways scroll. */
async function rowFits(page: Page, touch: boolean): Promise<string[]> {
  return page.evaluate((coarse) => {
    const problems: string[] = [];
    const controls = [...document.querySelectorAll<HTMLElement>('.kf-universe-time button, .kf-universe-time input, .kf-nav-day button, .kf-nav-day input, [data-testid="universe-photo"]')].filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden');
    // No two targets overlap, as laid out now (those shown: one scrolled out of its container is clipped away).
    const shown = (el: HTMLElement, r: DOMRect): boolean => {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || el.contains(hit);
    };
    const boxes = controls.map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ el, r }) => shown(el, r));
    for (const { el, r } of boxes) {
      for (const o of boxes) {
        if (o.el === el || o.el.contains(el) || el.contains(o.el)) continue;
        const w = Math.min(r.right, o.r.right) - Math.max(r.left, o.r.left);
        const h = Math.min(r.bottom, o.r.bottom) - Math.max(r.top, o.r.top);
        if (w > 0.5 && h > 0.5) problems.push(`${el.dataset.testid ?? el.className} overlaps ${o.el.dataset.testid ?? o.el.className}`);
      }
    }
    for (const el of controls) {
      // Reached by scrolling its own container if need be (the date under a phone's list): brought into view first.
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const name = el.dataset.testid ?? el.getAttribute('aria-label') ?? el.className;
      if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) problems.push(`${name} outside the window`);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(hit === el || el.contains(hit))) problems.push(`${name} covered by ${hit?.className ?? 'nothing'}`);
      if (coarse && (r.width < 43.5 || r.height < 43.5)) problems.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.kf-universe-time-rate, .kf-universe-time-note, .kf-universe-time-hijri')) {
      if (el.offsetWidth > 0 && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.className} cut`);
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`page ${document.documentElement.scrollWidth} wide in ${innerWidth}`);
    return problems;
  }, touch);
}

for (const [width, height, touch] of [[1280, 800, false], [1440, 900, false], [2000, 1300, false], [390, 844, true], [844, 390, true]] as const) {
  test.describe(`the time row at ${String(width)}x${String(height)}${touch ? ' (touch)' : ''}`, () => {
    test.use({ viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    test('every control in reach and whole, folded and pulled up, in the explorer and in an experiment; taps between the folds', async ({ page, kf, pageErrors }) => {
      test.setTimeout(240_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      await page.getByTestId('universe-time-faster').click();
      await page.waitForTimeout(300);
      const toggle = page.getByTestId('universe-nav-toggle');
      const nav = page.getByTestId('universe-bodies');
      expect(await rowFits(page, touch)).toEqual([]);
      if (touch) {
        await toggle.click();
        await expect(nav).toHaveClass(/is-expanded/);
        await page.waitForTimeout(400);
        expect(await rowFits(page, touch)).toEqual([]);
        // Taps on Faster and Slower in turn, the sheet folded and pulled up between bursts: in reach throughout.
        for (let round = 0; round < 20; round += 1) {
          for (let k = 0; k < 5; k += 1) await page.getByTestId(k % 2 === 0 ? 'universe-time-faster' : 'universe-time-slower').tap({ force: true });
          await toggle.click();
        }
        sound(await state(page));
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        if (!(await nav.getAttribute('class'))?.includes('is-expanded')) await toggle.click();
      }
      // In an experiment: Reset joins the row, and everything still fits.
      await page.getByTestId('lab-open').click();
      await expect(page.getByTestId('universe-time-reset')).toBeVisible(LIVE);
      await expect.poll(async () => (await state(page)).lab?.bodies.length ?? 0, LIVE).toBe(10);
      await page.waitForTimeout(300);
      expect(await rowFits(page, touch)).toEqual([]);
      if (touch) {
        await toggle.click();
        await expect(nav).not.toHaveClass(/is-expanded/);
        await page.waitForTimeout(300);
        expect(await rowFits(page, touch)).toEqual([]);
      }
      expect(pageErrors).toEqual([]);
    });
  });
}
