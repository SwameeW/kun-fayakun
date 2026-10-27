/**
 * Layout checks on the real page: where an element stands against the app's chrome (the header,
 * the film's timeline, the explorer's way back, readout and navigator), whether the page scrolls
 * sideways, and whether any text inside an element is cut off.
 */
import type { Page } from '@playwright/test';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The chrome a panel must keep clear of, by test id or selector. */
export const CHROME = {
  header: '.kf-header',
  timeline: '[data-testid="timeline"]',
  back: '[data-testid="universe-back"]',
  readout: '[data-testid="universe-readout"]',
  navigator: '[data-testid="universe-bodies"]',
} as const;

export type ChromeName = keyof typeof CHROME;

/** Boxes of what is on screen now (null for what is not shown). */
export async function boxes<K extends string>(page: Page, selectors: Readonly<Record<K, string>>): Promise<Record<K, Rect | null>> {
  const plain: Record<string, string> = { ...selectors };
  const out = await page.evaluate((sels) => {
    const found: Record<string, { left: number; top: number; right: number; bottom: number } | null> = {};
    for (const [name, sel] of Object.entries(sels)) {
      const el = document.querySelector<HTMLElement>(sel);
      const r = el && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden' ? el.getBoundingClientRect() : null;
      found[name] = r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    }
    return found;
  }, plain);
  return out;
}

/** Two boxes share some area (touching edges do not count). */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

/** What `box` covers of the chrome on screen, by name (empty when it covers none). */
export async function chromeCovered(page: Page, box: Rect, except: readonly ChromeName[] = []): Promise<string[]> {
  const chrome = await boxes(page, CHROME);
  return (Object.keys(CHROME) as ChromeName[]).filter((name) => !except.includes(name)).flatMap((name) => {
    const r = chrome[name];
    return r && overlaps(box, r) ? [`${name} ${JSON.stringify(r)}`] : [];
  });
}

/** The page scrolls sideways by this much (0 when nothing is wider than the window). */
export function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, (document.scrollingElement ?? document.documentElement).scrollWidth - window.innerWidth));
}

/**
 * Text cut off inside `selector`: elements whose content is wider than their box where it cannot
 * scroll, text reaching outside the element's own box sideways, and the element itself running past
 * the window. Scrolling parts (overflow auto or scroll) may be taller than their box: that is scrolling.
 */
export function clippedText(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    if (!root) return [`${sel} is not on the page`];
    const problems: string[] = [];
    const outer = root.getBoundingClientRect();
    if (outer.left < -1 || outer.right > window.innerWidth + 1 || outer.top < -1 || outer.bottom > window.innerHeight + 1) problems.push(`${sel} runs past the window`);
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid') ?? ''}]` : ''}.${el.className}`;
    /** Text hidden on purpose for screen readers only (clipped to a pixel): not cut off. */
    const forReaders: HTMLElement[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      if (el.closest('[hidden]') || el.getClientRects().length === 0) continue;
      if (forReaders.some((r) => r.contains(el))) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') continue;
      const box = el.getBoundingClientRect();
      if (style.clipPath.startsWith('inset(50%') || (box.width <= 1 && box.height <= 1)) {
        forReaders.push(el);
        continue;
      }
      const scrolls = /(auto|scroll)/u.test(style.overflowX);
      if (!scrolls && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && style.overflowX !== 'visible') problems.push(`${name(el)}: text wider than its box`);
      const r = el.getBoundingClientRect();
      const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
      if (hasText && (r.left < outer.left - 1 || r.right > outer.right + 1)) problems.push(`${name(el)}: text outside the panel sideways`);
    }
    return problems;
  }, selector);
}
