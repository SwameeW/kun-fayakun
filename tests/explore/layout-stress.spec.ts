/**
 * The explorer's interface under stress, at every window size it is built for (tests/support/layout):
 * desktop windows of 1280x800, 1440x900 and 2000x1300, and a touch phone held upright (390x844) and
 * sideways (844x390). At each, every section of the navigator opened and closed again and again (by
 * bursts of presses faster than a hand, then by hand; the field notes within the Living Earth and the
 * imagery's credits too), the navigator folded and unfolded in bursts, bursts of random presses over its
 * controls (the time machine's among them), photo mode, the orbital laboratory (its sections, a lesson,
 * folded) and the stars (their diagram, folded); after each, every control is inside the window (or its
 * own scroller), nothing is wider than the window, no two controls overlap, no text is cut off, and
 * nothing was logged as an error. On foot and going down through clouds, the HUDs fit as well, their
 * readouts opened and closed, the navigator folded and unfolded over them. The small worlds' names
 * (Jupiter's, Saturn's and Uranus's moons, from their planets and from Io), with the navigator unfolded
 * and folded, never under the interface, over one another, or over a disc (the ten bodies', the world
 * flown to's, Saturn's rings). Reduced motion, so trips land at once and nothing is caught halfway
 * through a transition.
 */
import type { Page } from '@playwright/test';
import type { UniversePose } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { everyInsideViewport, frames, noClippedText, noHorizontalOverflow, noOverlappingTargets, spam } from '../support/layout';
import { JD, place, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };
const DESKTOP = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 2000, height: 1300 },
] as const;
const TOUCH = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const;
const SIZES = [...DESKTOP.map((v) => ({ ...v, touch: false })), ...TOUCH.map((v) => ({ ...v, touch: true }))];

test.use({ reducedMotion: 'reduce' });

/** Every check of tests/support/layout, on the explorer's interface, each with what it was doing. */
async function expectLayout(page: Page, label: string): Promise<void> {
  await frames(page, 3);
  const universe = '[data-testid="universe"]';
  expect(await everyInsideViewport(page, universe), `${label}: every control inside the window`).toEqual([]);
  expect(await noHorizontalOverflow(page), `${label}: nothing wider than the window`).toEqual([]);
  expect(await noOverlappingTargets(page, universe), `${label}: no control over another`).toEqual([]);
  expect(await noClippedText(page.getByTestId('universe')), `${label}: no text cut off`).toEqual([]);
}

/** The navigator folded or not, as its toggle says and as it is drawn (they never disagree). */
async function expanded(page: Page): Promise<boolean> {
  const state = await page.getByTestId('universe-bodies').evaluate((nav) => ({ cls: nav.classList.contains('is-expanded'), aria: nav.querySelector('[data-testid="universe-nav-toggle"]')?.getAttribute('aria-expanded') }));
  expect(state.aria).toBe(String(state.cls));
  return state.cls;
}

async function setExpanded(page: Page, want: boolean): Promise<void> {
  if ((await expanded(page)) !== want) await page.getByTestId('universe-nav-toggle').click();
  await expect(page.getByTestId('universe-nav-toggle')).toHaveAttribute('aria-expanded', String(want));
}

/** A lazily loaded part has come (its waiting line gone) and none failed. */
async function loaded(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="part-waiting"]')).toHaveCount(0, LIVE);
}

/** Opens a section by a burst of presses (an odd number: it ends open), checks it, and closes it by hand. */
async function section(page: Page, details: ReturnType<Page['locator']>, label: string): Promise<void> {
  const summary = details.locator(':scope > summary');
  await summary.scrollIntoViewIfNeeded();
  // (From closed: one that starts open, as a wide screen's walk readout does, is closed first.)
  if (await details.evaluate((d) => (d as HTMLDetailsElement).open)) await summary.click();
  await spam(summary, 7);
  await expect(details).toHaveAttribute('open', '');
  await loaded(page);
  await expectLayout(page, `${label} open`);
  await spam(summary, 6);
  await expect(details).toHaveAttribute('open', '');
  await summary.click();
  await expect(details).not.toHaveAttribute('open', '');
}

for (const size of SIZES) {
  const at = `${String(size.width)}x${String(size.height)}${size.touch ? ' (touch)' : ''}`;
  test.describe(at, () => {
    test.use({ viewport: { width: size.width, height: size.height }, hasTouch: size.touch, isMobile: size.touch });

    test(`the navigator's sections, folding, random bursts and photo mode at ${at}`, async ({ page, kf, pageErrors }) => {
      test.setTimeout(240_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      await expectLayout(page, 'on arrival');
      await setExpanded(page, true);
      await expectLayout(page, 'navigator open');

      // Every section, opened and closed again and again; the detail menu and the keys too.
      for (const id of ['universe-about', 'universe-sky', 'universe-worlds', 'saved-views', 'living-earth', 'universe-islamic', 'universe-seen']) await section(page, page.getByTestId(id), id);
      await section(page, page.locator('.kf-nav-keys'), 'keys');
      // A section within a section: the Living Earth's field notes on the prophets.
      const living = page.getByTestId('living-earth').locator(':scope > summary');
      await living.click();
      await loaded(page);
      await section(page, page.getByTestId('field-prophets'), 'field notes: the prophets');
      await living.click();
      await expect(page.getByTestId('living-earth')).not.toHaveAttribute('open', '');
      // The imagery's credits, which open from the readout over the view.
      await section(page, page.getByTestId('universe-credits'), 'the imagery’s credits');
      // The detail menu opens over the list (on a phone's sheet) or beside the panel: a menu, closed by a
      // press elsewhere, so what it covers is not checked under it; it fits, and nothing in it overlaps.
      const detail = page.getByTestId('universe-detail');
      await spam(detail, 11);
      await expect(detail).toHaveAttribute('aria-expanded', 'true');
      await frames(page, 3);
      expect(await everyInsideViewport(page, '[data-testid="universe"]'), 'detail menu open: every control inside the window').toEqual([]);
      expect(await noHorizontalOverflow(page), 'detail menu open: nothing wider than the window').toEqual([]);
      expect(await noOverlappingTargets(page, '.kf-nav-detail-panel'), 'detail menu open: no control over another in it').toEqual([]);
      expect(await noClippedText(page.locator('.kf-nav-detail-panel')), 'detail menu open: no text cut off').toEqual([]);
      await page.getByTestId('universe-detail-close').click();
      await expect(detail).toHaveAttribute('aria-expanded', 'false');
      // Each lazy section's body came once, however often it was opened.
      for (const [id, part] of [
        ['universe-about', '.kf-about-body'],
        ['universe-sky', '.kf-about-body'],
        ['universe-worlds', '.kf-about-body'],
        ['saved-views', '.kf-living-body'],
        ['living-earth', '.kf-living-body'],
        ['universe-islamic', '[data-testid="islamic-panel"]'],
      ] as const) {
        await expect(page.getByTestId(id).locator(`:scope > ${part}`), id).toHaveCount(1);
      }

      // Folded and unfolded in bursts (25 presses fold it, 25 more unfold it), and by hand.
      const toggle = page.getByTestId('universe-nav-toggle');
      await spam(toggle, 25);
      expect(await expanded(page)).toBe(false);
      await expectLayout(page, 'folded after a burst');
      await spam(toggle, 25);
      expect(await expanded(page)).toBe(true);
      await expectLayout(page, 'unfolded after a burst');
      await toggle.click();
      expect(await expanded(page)).toBe(false);
      await toggle.click();
      expect(await expanded(page)).toBe(true);

      // Bursts of random presses within a frame over the navigator's own controls (its sections, the
      // fold, the sky's switches, the "?"s, the time machine's buttons but photo mode's, which hides the
      // navigator): whatever state that leaves is a whole one.
      await page.getByTestId('universe-sky').locator(':scope > summary').click();
      await loaded(page);
      for (const seed of [1, 2, 3]) {
        await page.evaluate(
          ([s, n]) => {
            let x = s * 2654435761;
            const random = (): number => {
              x = (x * 1664525 + 1013904223) % 4294967296;
              return x / 4294967296;
            };
            const pool = [...document.querySelectorAll<HTMLElement>('[data-testid="universe-bodies"] :is(summary, .kf-living-switch, .kf-help, [data-testid="universe-nav-toggle"], [data-testid="universe-time"] button:not([data-testid="universe-photo"]))')];
            if (!pool.some((el) => el.closest('[data-testid="universe-time"]'))) throw new Error('the time machine is not in the pool');
            for (let i = 0; i < n && pool.length > 0; i += 1) pool[Math.floor(random() * pool.length)]?.click();
          },
          [seed, 120] as const,
        );
        await frames(page, 3);
        // At most one explanation open; Esc closes it (with none open, Esc would leave the explorer).
        const popovers = page.locator('[data-testid="help-popover"]:not([hidden])');
        expect(await popovers.count()).toBeLessThanOrEqual(1);
        if ((await popovers.count()) > 0) await page.keyboard.press('Escape');
        await expect(popovers).toHaveCount(0);
        await expanded(page);
        await setExpanded(page, true);
        await loaded(page);
        await expectLayout(page, `after random burst ${String(seed)}`);
      }
      // Still one body each (the Living Earth's and saved views' are its two .kf-living-body).
      expect(await page.locator('[data-testid="islamic-panel"]').count()).toBe(1);
      expect(await page.locator('.kf-living-body').count()).toBe(2);

      // Photo mode: only the view and its bar (its camera's settings open too), in and out.
      await page.getByTestId('universe-photo').click();
      await expect(page.locator('html')).toHaveClass(/kf-photo/);
      await expect(page.getByTestId('universe-photo-exit')).toBeVisible(LIVE);
      for (const camera of [false, true]) {
        if (camera) await page.getByTestId('universe-photo-camera').locator(':scope > summary').click();
        await frames(page, 3);
        expect(await everyInsideViewport(page, '.kf-universe-photo-bar'), `photo mode (camera ${String(camera)}): its bar inside the window`).toEqual([]);
        expect(await noOverlappingTargets(page, '.kf-universe-photo-bar'), `photo mode (camera ${String(camera)}): no control over another`).toEqual([]);
        expect(await noHorizontalOverflow(page), `photo mode (camera ${String(camera)}): nothing wider than the window`).toEqual([]);
      }
      await page.getByTestId('universe-photo-exit').click();
      await expect(page.locator('html')).not.toHaveClass(/kf-photo/);
      await expectLayout(page, 'after photo mode');
      expect(pageErrors).toEqual([]);
    });

    test(`the orbital laboratory: its sections, a lesson, folded, and in and out at ${at}`, async ({ page, kf, pageErrors }) => {
      test.setTimeout(240_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      await setExpanded(page, true);
      await page.getByTestId('lab-open').click();
      const panel = page.getByTestId('lab-panel');
      await expect(panel).toBeVisible(LIVE);
      await expect.poll(async () => (await view(page))?.lab?.bodies.length ?? 0, LIVE).toBe(10);
      // Entered from the foot of the navigator, the panel is in view from its top.
      await expect.poll(() => panel.locator('h3').first().evaluate((h) => {
        const body = h.closest('.kf-nav-body-wrap')?.getBoundingClientRect();
        const r = h.getBoundingClientRect();
        return body !== undefined && r.top >= body.top - 1 && r.bottom <= body.bottom + 1;
      })).toBe(true);
      await expectLayout(page, 'laboratory');
      // Each of its sections in turn, open (and the lessons, with one begun and a step taken).
      const sections = panel.locator('details');
      const n = await sections.count();
      for (let i = 0; i < n; i += 1) {
        const details = sections.nth(i);
        if (!(await details.isVisible())) continue;
        await section(page, details, `laboratory section ${String(i)}`);
      }
      await panel.getByTestId('lab-lessons').locator(':scope > summary').click();
      await page.getByTestId('lab-lesson-kepler').click();
      await expect(page.getByTestId('lab-lesson-step-1')).toBeEnabled(LIVE);
      await expectLayout(page, 'a lesson begun');
      await spam(page.getByTestId('lab-lesson-step-1'), 9);
      await expect(page.getByTestId('lab-lesson-step-1')).toBeDisabled();
      await expect.poll(async () => (await view(page))?.lab?.logLength, LIVE).toBe(1);
      await expectLayout(page, 'a lesson under way');
      await page.getByTestId('lab-lesson-end').click();

      // Folded in the experiment: its worlds as portraits, nothing of the panel; unfolded, the panel as it was.
      await spam(page.getByTestId('universe-nav-toggle'), 25);
      expect(await expanded(page)).toBe(false);
      await expect(panel).toBeHidden();
      await expectLayout(page, 'laboratory folded');
      await spam(page.getByTestId('universe-nav-toggle'), 25);
      expect(await expanded(page)).toBe(true);
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('lab-lessons')).toHaveAttribute('open', '');

      // Out and in again, and out by the way back, as the history goes.
      for (let i = 0; i < 3; i += 1) {
        await page.evaluate(() => {
          (window as unknown as KfHook).__kf.app.closeLab();
        });
        await expect.poll(async () => (await view(page))?.lab ?? null, LIVE).toBeNull();
        await page.evaluate(() => {
          (window as unknown as KfHook).__kf.app.openLab();
        });
        await expect.poll(async () => (await view(page))?.lab?.bodies.length ?? 0, LIVE).toBe(10);
      }
      await page.getByTestId('lab-back').click();
      await expect.poll(async () => (await view(page))?.lab ?? null, LIVE).toBeNull();
      await expect(panel).toBeHidden();
      await expectLayout(page, 'back from the laboratory');
      expect(pageErrors).toEqual([]);
    });

    test(`among the stars: their panel, its diagram, folded, and back at ${at}`, async ({ page, kf, pageErrors }) => {
      test.setTimeout(240_000 * SLOW);
      await kf.open('/universe/earth', { query: { jd: JD } });
      await waitForUniverse(page);
      await setExpanded(page, true);
      await page.getByTestId('stars-open').click();
      await expect.poll(async () => (await view(page))?.neighbourhood !== null, LIVE).toBe(true);
      // A phone's sheet folds for the trip out: pulled up again, the panel is there.
      await setExpanded(page, true);
      const panel = page.getByTestId('stars-panel');
      await expect(panel).toBeVisible(LIVE);
      const hr = page.getByTestId('stars-hr');
      await expect(hr).toHaveAttribute('data-count', /\d+/, LIVE);
      await hr.scrollIntoViewIfNeeded();
      // The diagram drawn at its shown size and the screen's density, its words at least 11 px.
      const drawn = await hr.evaluate((c) => ({ width: (c as HTMLCanvasElement).width, wanted: Math.round(c.clientWidth * devicePixelRatio), fontPx: Number((c as HTMLCanvasElement).dataset.fontPx) }));
      expect(drawn.width).toBe(drawn.wanted);
      expect(drawn.fontPx).toBeGreaterThanOrEqual(11);
      await expectLayout(page, 'among the stars');
      await spam(page.getByTestId('universe-nav-toggle'), 25);
      expect(await expanded(page)).toBe(false);
      await expect(panel).toBeHidden();
      await expectLayout(page, 'among the stars, folded');
      await spam(page.getByTestId('universe-nav-toggle'), 25);
      expect(await expanded(page)).toBe(true);
      await expect(panel).toBeVisible();
      await page.getByTestId('stars-end').click();
      await expect.poll(async () => (await view(page))?.neighbourhood ?? null, LIVE).toBeNull();
      await expect(panel).toBeHidden();
      await expectLayout(page, 'back from the stars');
      expect(pageErrors).toEqual([]);
    });
  });
}

/** A HUD's readout opened and closed (in bursts), then the navigator folded and unfolded over it (in bursts): it fits each way. */
async function hud(page: Page, element: ReturnType<Page['locator']>, label: string): Promise<void> {
  await section(page, element.locator('details').first(), `${label}: its readout`);
  const toggle = page.getByTestId('universe-nav-toggle');
  const was = await expanded(page);
  await spam(toggle, 25);
  expect(await expanded(page)).toBe(!was);
  await expectLayout(page, `${label}, the navigator ${was ? 'folded' : 'pulled up'}`);
  await spam(toggle, 25);
  expect(await expanded(page)).toBe(was);
  await expectLayout(page, `${label}, the navigator back as it was`);
}

test.describe('on foot and going down', () => {
  for (const group of [
    { name: 'desktop', sizes: DESKTOP, touch: false },
    { name: 'touch', sizes: TOUCH, touch: true },
  ] as const) {
    test.describe(group.name, () => {
      test.use({ viewport: { width: group.sizes[0].width, height: group.sizes[0].height }, hasTouch: group.touch, isMobile: group.touch });

      test(`the walk's and the descent's HUDs fit (${group.name})`, async ({ page, kf, pageErrors }) => {
        test.setTimeout(300_000 * SLOW);
        await kf.open('/universe/moon', { query: { jd: JD } });
        await waitForUniverse(page);
        await place(page, { body: 'moon', distanceKm: 5000, azimuthDeg: 40, elevationDeg: 15 });
        await expect.poll(async () => (await view(page))?.walkHere?.world ?? null, LIVE).toBe('moon');
        await page.evaluate(() => {
          (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk' });
        });
        await expect.poll(async () => (await view(page))?.walk?.state ?? null, LIVE).toBe('walking');
        await expect(page.getByTestId('walk-hud')).toBeVisible(LIVE);
        for (const size of group.sizes) {
          await page.setViewportSize(size);
          await expectLayout(page, `on foot at ${String(size.width)}x${String(size.height)}`);
          await hud(page, page.getByTestId('walk-hud'), `on foot at ${String(size.width)}x${String(size.height)}`);
        }
        await page.keyboard.press('Escape');
        await expect.poll(async () => (await view(page))?.walk ?? null, LIVE).toBeNull();
        await page.evaluate(() => {
          (window as unknown as KfHook).__kf.app.focusBody('venus');
        });
        await expect.poll(async () => {
          const v = await view(page);
          return v?.focus === 'venus' && !v.travelling;
        }, LIVE).toBe(true);
        await page.evaluate(() => {
          (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'descent', world: 'venus' });
        });
        await expect(page.getByTestId('descent-hud')).toBeVisible(LIVE);
        for (const size of group.sizes) {
          await page.setViewportSize(size);
          await expectLayout(page, `going down at ${String(size.width)}x${String(size.height)}`);
          await hud(page, page.getByTestId('descent-hud'), `going down at ${String(size.width)}x${String(size.height)}`);
        }
        expect(pageErrors).toEqual([]);
      });
    });
  }
});

/**
 * The worlds' names (the small worlds', by their names in the view's list) on show over the way back,
 * the readout or the navigator, over one another, over any of the ten bodies' discs or the world flown
 * to's, or (on Saturn) inside the rings' outline seen at their opening: each as its text and where.
 */
async function worldNamesInTheWay(page: Page): Promise<string[]> {
  const v = await view(page);
  const names = (v?.worlds?.list ?? []).map((w) => w.name);
  const discs: Array<{ id: string; x: number; y: number; r: number; ring: number }> = (v?.bodies ?? []).filter((b) => b.screen.inView && b.screen.radiusPx > 1.5).map((b) => ({ id: b.id, x: b.screen.x, y: b.screen.y, r: b.screen.radiusPx * (b.id === 'saturn' ? 2.33 : 1), ring: b.id === 'saturn' ? Math.max(Math.abs(Math.sin(b.ringOpening)), 1 / 2.33) : 1 }));
  const f = v?.worlds?.focus;
  if (f && f.screen.inView) discs.push({ id: f.name, x: f.screen.x, y: f.screen.y, r: f.screen.radiusPx, ring: 1 });
  return page.evaluate(
    ([list, ds]) => {
      const covers = ['universe-back', 'universe-readout', 'universe-bodies']
        .map((id) => ({ id, r: document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect() }))
        .filter((c): c is { id: string; r: DOMRect } => c.r !== undefined && c.r.width > 0);
      const meet = (a: DOMRect, b: DOMRect): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
      const tags = [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || '1') > 0.1).map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
      const out: string[] = [];
      for (const [k, t] of tags.entries()) {
        if (!list.includes(t.text)) continue;
        const where = `${t.text} ${String(Math.round(t.r.left))},${String(Math.round(t.r.top))}`;
        for (const c of covers) if (meet(t.r, c.r)) out.push(`${where} under ${c.id}`);
        for (const [j, u] of tags.entries()) if (j !== k && meet(t.r, u.r)) out.push(`${where} over ${u.text}`);
        for (const d of ds) {
          if (d.id === t.text) continue;
          // The nearest point of the tag to the disc's centre, inside it (Saturn's rings: inside the circle
          // their outline's narrowest width makes, the planet's own at least, which they always cover).
          const nx = Math.max(t.r.left, Math.min(d.x, t.r.right)) - d.x;
          const ny = Math.max(t.r.top, Math.min(d.y, t.r.bottom)) - d.y;
          if (Math.hypot(nx, ny) < d.r * d.ring - 1) out.push(`${where} over ${d.id}`);
        }
      }
      return out;
    },
    [names, discs] as const,
  );
}

for (const size of [...SIZES, { width: 768, height: 1024, touch: true }, { width: 1920, height: 1080, touch: false }]) {
  const at = `${String(size.width)}x${String(size.height)}${size.touch ? ' (touch)' : ''}`;
  test(`the small worlds' names keep clear of the interface, of one another and of every disc at ${at}`, async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await page.setViewportSize({ width: size.width, height: size.height });
    await kf.open('/universe/jupiter', { query: { jd: JD, detail: 'high' } });
    await waitForUniverse(page);
    await expect.poll(async () => (await view(page))?.worlds?.shown ?? 0, LIVE).toBeGreaterThan(0.99);
    let named = 0;
    for (const unfolded of [true, false]) {
      await setExpanded(page, unfolded);
      for (const poses of [
        // Jupiter's system, from Io (Jupiter behind it, then the Sun), Saturn's and Uranus's.
        [
          { body: 'jupiter', distanceKm: 1.6e6, elevationDeg: 4 },
          { body: 'jupiter', distanceKm: 6e5, azimuthDeg: 40, elevationDeg: 10 },
        ],
        [
          { body: 'w:Io', distanceKm: 9000, from: 'jupiter', azimuthDeg: 20 },
          { body: 'w:Io', distanceKm: 2.5e5, from: 'sun', azimuthDeg: 30 },
        ],
        [
          { body: 'saturn', distanceKm: 1.4e6, elevationDeg: 12 },
          { body: 'saturn', distanceKm: 3e6, azimuthDeg: 70, elevationDeg: 25 },
        ],
        [{ body: 'uranus', distanceKm: 7e5, elevationDeg: 20 }],
      ] satisfies UniversePose[][]) {
        for (const pose of poses) {
          await place(page, pose);
          // The names settle (in a third of a second, out at once where they are in the way).
          await page.waitForTimeout(900);
          expect(await worldNamesInTheWay(page), `${at} ${unfolded ? 'unfolded' : 'folded'}: ${JSON.stringify(pose)}`).toEqual([]);
          named += await page.evaluate((list) => [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')].filter((t) => Number(t.style.opacity || '1') > 0.5 && list.includes(t.textContent)).length, ((await view(page))?.worlds?.list ?? []).map((w) => w.name));
        }
      }
    }
    // Names do show, where there is room for them.
    if (size.width >= 768) expect(named).toBeGreaterThan(3);
    expect(pageErrors).toEqual([]);
  });
}
