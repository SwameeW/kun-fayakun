/**
 * Drivers for the solar-system explorer's browser specs (tests/explore): waiting for it, reading
 * its view, stepping its clock, and flying a trip frame by frame inside the page (one round trip to
 * the browser per trip, so a several-second flight is checked at every one of its frames).
 */
import type { Page } from '@playwright/test';
import type { BodyId, UniversePose, UniverseView } from '../../src/core/types';
import { expect, type KfHook } from './fixtures';
import { SLOW } from './env';

/** A date inside the Moon table's span, so the sky does not depend on the day the test runs. */
export const JD = '2461336.75';
/** Loading, compiling and the fades take a few seconds; software renderers take much longer. */
export const UNIVERSE_TIMEOUT = 90_000 * SLOW;

export async function waitForUniverse(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-universe-ready', 'true', { timeout: UNIVERSE_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-experience', 'universe');
}

export const view = (page: Page): Promise<UniverseView | null> => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state());

/** Switches the page to the manual clock (for good) and advances it. */
export const step = (page: Page, frames = 1, dt = 1 / 60): Promise<void> =>
  page.evaluate(([n, d]) => {
    (window as unknown as KfHook).__kf.step(n, d);
  }, [frames, dt] as const);

export const place = (page: Page, pose: UniversePose): Promise<void> =>
  page.evaluate((p) => {
    (window as unknown as KfHook).__kf.universe.place(p);
  }, pose);

export interface TripRecord {
  frames: number;
  seconds: number;
  /** The lowest height above any body's surface on any frame, km, and that body. */
  lowestKm: number;
  lowestBody: string;
  /** data-travel on the first frame of the trip and once it is over. */
  hookDuring: string | null;
  hookAfter: string | null;
  /** The height above the destination at the start, at arrival, and the one the trip said it would end at. */
  startKm: number;
  endKm: number;
  plannedEndKm: number;
  focus: BodyId;
}

/**
 * Starts a trip to `to` on the manual clock and steps it at 60 Hz until it arrives (or `maxSeconds`
 * pass), checking every frame in the page. The page must already be on the manual clock.
 */
export function fly(page: Page, to: BodyId, maxSeconds = 12): Promise<TripRecord> {
  return page.evaluate(
    ([target, limit]) => {
      const kf = (window as unknown as KfHook).__kf;
      kf.app.focusBody(target);
      const state = (): UniverseView => {
        const v = kf.universe.state();
        if (!v) throw new Error('the explorer is not on screen');
        return v;
      };
      let frames = 0;
      let lowestKm = Infinity;
      let lowestBody = '';
      let hookDuring: string | null = null;
      let plannedEndKm = 0;
      const first = state();
      const startKm = first.altitudeKm;
      while (frames < limit * 60) {
        kf.step(1, 1 / 60);
        frames += 1;
        const v = state();
        if (frames === 1) hookDuring = document.documentElement.getAttribute('data-travel');
        if (v.trip) plannedEndKm = v.trip.endKm;
        for (const b of v.bodies) {
          if (b.distanceKm < lowestKm) {
            lowestKm = b.distanceKm;
            lowestBody = b.id;
          }
        }
        if (!v.travelling) break;
      }
      const end = state();
      return {
        frames,
        seconds: frames / 60,
        lowestKm,
        lowestBody,
        hookDuring,
        hookAfter: document.documentElement.getAttribute('data-travel'),
        startKm,
        endKm: end.altitudeKm,
        plannedEndKm,
        focus: end.focus,
      };
    },
    [to, maxSeconds] as const,
  );
}

/**
 * Waits until these parts of the interface have finished fading in (axe judges contrast with the
 * opacity as it is, so text halfway through a fade would read as faint).
 */
export async function settled(page: Page, testIds: readonly string[]): Promise<void> {
  for (const id of testIds) {
    await expect
      .poll(() => page.getByTestId(id).evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 10_000 })
      .toBe(1);
  }
}

/** The explorer's interface has nothing wider than the viewport (no sideways scroll on a phone). */
export function overflow(page: Page): Promise<{ scroll: number; client: number; offenders: string[] }> {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const width = window.innerWidth;
    const offenders: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="universe"] *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right > width + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { scroll: root.scrollWidth, client: root.clientWidth, offenders };
  });
}
