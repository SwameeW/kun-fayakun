/**
 * Layout checks for the explorer's interface (tests/explore): every control drawn inside the window
 * (or reachable by scrolling its own list) and not covered by anything else, no two overlapping, no
 * sideways scroll, and no text of the walk's readout cut off.
 */
import type { Page } from '@playwright/test';
import { expect } from './fixtures';

export interface Control {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** What is drawn at its middle is the control itself (or inside it). */
  hit: boolean;
  /** It sits in a list that scrolls (reachable by scrolling it). */
  scrolls: boolean;
}

/** The interface's controls on screen: each one's box, test id and name; and what is drawn at its middle. */
export async function controls(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    const out: Array<{ id: string; x: number; y: number; w: number; h: number; hit: boolean; scrolls: boolean }> = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="universe"] :is(button, summary, a[href], input, select)')) {
      const r = el.getBoundingClientRect();
      // Drawn at all (not in a folded disclosure, not hidden).
      if (r.width === 0 || r.height === 0 || !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) || el.closest('[hidden], [aria-hidden="true"]')) continue;
      // Inside a container that scrolls (the navigator's list), reachable by scrolling it.
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight + 1) scrolls = true;
      }
      const hitEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      out.push({ id: el.dataset.testid ?? `${el.tagName.toLowerCase()}:${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20)}`, x: r.x, y: r.y, w: r.width, h: r.height, hit: hitEl !== null && (el === hitEl || el.contains(hitEl)), scrolls });
    }
    return out;
  });
}

/** Every control inside the window (or reachable by scrolling its own list), none over another, no sideways scroll, no text cut off in the walk's readout. */
export async function fits(page: Page, label: string): Promise<void> {
  const list = await controls(page);
  const vw = page.viewportSize()?.width ?? 0;
  const vh = page.viewportSize()?.height ?? 0;
  for (const c of list) {
    if (c.scrolls) continue;
    expect(c.x, `${label}: ${c.id} left`).toBeGreaterThanOrEqual(-0.5);
    expect(c.y, `${label}: ${c.id} top`).toBeGreaterThanOrEqual(-0.5);
    expect(c.x + c.w, `${label}: ${c.id} right`).toBeLessThanOrEqual(vw + 0.5);
    expect(c.y + c.h, `${label}: ${c.id} bottom`).toBeLessThanOrEqual(vh + 0.5);
    expect(c.hit, `${label}: ${c.id} is covered`).toBe(true);
  }
  // No two controls overlap (one inside another, as a "?" beside its label in a row, is not an overlap).
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (!a || !b || a.scrolls || b.scrolls) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const inside = (p: typeof a, q: typeof a): boolean => p.x >= q.x - 0.5 && p.y >= q.y - 0.5 && p.x + p.w <= q.x + q.w + 0.5 && p.y + p.h <= q.y + q.h + 0.5;
      if (inside(a, b) || inside(b, a)) continue;
      expect(w > 1 && h > 1, `${label}: ${a.id} overlaps ${b.id}`).toBe(false);
    }
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(overflow.scroll, `${label}: page wider than the window`).toBeLessThanOrEqual(overflow.width);
  // No text cut off: every piece of the readout's text inside each box that clips it, and inside the window.
  const cut = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-testid="walk-hud"] :is(p, span, summary, button, kbd)')) {
      if (!el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) || el.textContent.trim() === '') continue;
      const r = el.getBoundingClientRect();
      const name = el.dataset.testid ?? el.className;
      // In a box that scrolls (the suit's figures), what is scrolled away is reached by scrolling it.
      let scrolled = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) scrolled = true;
      if (r.left < -1 || r.right > innerWidth + 1 || (!scrolled && (r.top < -1 || r.bottom > innerHeight + 1))) out.push(`${name} outside the window`);
      for (let p = el.parentElement; p && !p.matches('[data-testid="universe"]'); p = p.parentElement) {
        const style = getComputedStyle(p);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const box = p.getBoundingClientRect();
        // A box that scrolls shows the rest by scrolling (the suit's figures): only what it clips sideways is cut.
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (r.left < box.left - 1 || r.right > box.right + 1 || (!scrolls && (r.top < box.top - 1 || r.bottom > box.bottom + 1))) out.push(`${name} cut by ${p.className}`);
      }
    }
    return out;
  });
  expect(cut, `${label}: text cut off`).toEqual([]);
}
