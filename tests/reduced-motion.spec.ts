/**
 * prefers-reduced-motion (spec section 7): the app must detect it, and verses
 * may only cross-fade (Core Principle 5: verses fade in and out whole).
 */
import type { Page } from '@playwright/test';
import type { ChapterId, Cue } from '../src/core/types';
import { PLAYABLE_CHAPTERS, chapterContent } from './support/data';
import { expect, test } from './support/fixtures';

type VerseCue = Extract<Cue, { type: 'verse' }>;

/** The first verse cue in story order, so the test lands on a real verse fade. */
function firstVerseCue(): { chapter: ChapterId; cue: VerseCue } {
  for (const meta of PLAYABLE_CHAPTERS) {
    const cue = chapterContent(meta.id).cues.find((c): c is VerseCue => c.type === 'verse');
    if (cue) return { chapter: meta.id, cue };
  }
  throw new Error('No playable chapter has a verse cue');
}

/**
 * Lists anything in the verse overlay that moves other than by opacity:
 * configured CSS transitions with a duration, plus any running CSS or Web
 * Animations whose keyframes touch another property.
 */
async function overlayMotion(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="verse-overlay"]');
    if (!root) return ['verse-overlay is missing'];
    const label = (el: Element): string =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el === root ? ' (overlay)' : ''}`;
    const offenders: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(el);
      const properties = style.transitionProperty.split(',').map((p) => p.trim());
      const durations = style.transitionDuration.split(',').map((d) => Number.parseFloat(d));
      properties.forEach((property, i) => {
        const duration = durations[i % durations.length] ?? 0;
        if (duration > 0 && property !== 'opacity') offenders.push(`${label(el)} transitions ${property}`);
      });
    }
    const timing = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !effect.target || !root.contains(effect.target)) continue;
      const animated = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
      for (const property of animated) {
        if (!timing.has(property) && property !== 'opacity') {
          offenders.push(`${label(effect.target)} animates ${property}`);
        }
      }
    }
    return offenders;
  });
}

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('is detected and the verse overlay only fades', async ({ page, kf }) => {
    const { chapter, cue } = firstVerseCue();
    await kf.openChapter(chapter, { autoplay: true, t: Math.max(0, cue.t - 1) });
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');

    const overlay = page.getByTestId('verse-overlay');
    await expect(overlay.locator('[lang|="ar"]').first()).toBeAttached({ timeout: 30_000 });

    // Sample across the fade-in: transitions only exist while they run.
    const offenders = new Set<string>();
    for (let sample = 0; sample < 8; sample += 1) {
      for (const offender of await overlayMotion(page)) offenders.add(offender);
      await page.waitForTimeout(250);
    }
    expect([...offenders], 'verse overlay motion other than opacity').toEqual([]);
  });
});

test.describe('without reduced motion', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('reports data-reduced-motion=false', async ({ page, kf }) => {
    await kf.open('/');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'false', {
      timeout: 30_000,
    });
  });
});
