/**
 * Layout and stress checks for any page state (tests/explore/layout-stress.spec.ts uses them all):
 * presses in bursts, and what a layout must hold at every window size. Each check runs in the page in
 * one round trip and returns its offenders as short lines (an empty list passes), so a failure says
 * which control, where.
 *
 * What counts as shown: an element the browser renders (checkVisibility: not display:none, not inside
 * a closed <details>, not visibility:hidden or fully transparent), with a box, inside no [hidden]; and
 * of it, only the part no ancestor clips away (a scroller's overflow, the window's edge).
 */
import type { Locator, Page } from '@playwright/test';

/** The controls a visitor can reach: what clicks, types, opens or takes focus. */
export const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [tabindex]:not([tabindex="-1"])';

/**
 * Presses a control `n` times: 'burst' (the default) clicks it synchronously n times within one task
 * (faster than any hand, so no frame runs between presses: it finds missing in-flight guards); 'human'
 * clicks it with real pointer events, each waiting until the control can take it.
 */
export async function spam(locator: Locator, n: number, mode: 'burst' | 'human' = 'burst'): Promise<void> {
  if (mode === 'human') {
    for (let i = 0; i < n; i += 1) await locator.click();
    return;
  }
  await locator.evaluate((el, count) => {
    for (let i = 0; i < count; i += 1) (el as HTMLElement).click();
  }, n);
}

/** Waits for `n` animation frames (the interface writes in its frame loop, a frame behind what a press did). */
export const frames = (page: Page, n = 2): Promise<void> =>
  page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let k = 0;
        const tick = (): void => {
          k += 1;
          if (k >= count) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

/**
 * The browser-side helpers every check shares (installed once per page, on window.__kfLayout): whether
 * an element is shown, the part of its box no ancestor clips, and a short name for it.
 */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __kfLayout?: unknown };
    if (w.__kfLayout) return;
    const clips = (style: CSSStyleDeclaration): { x: boolean; y: boolean } => ({ x: style.overflowX !== 'visible', y: style.overflowY !== 'visible' });
    const shown = (el: Element): boolean => {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
      if (el.closest('[hidden]')) return false;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    /** The box left once every clipping ancestor (and the window) has cut it; null when nothing is left. */
    const visibleRect = (el: Element): { left: number; top: number; right: number; bottom: number } | null => {
      const r = el.getBoundingClientRect();
      let left = r.left;
      let top = r.top;
      let right = r.right;
      let bottom = r.bottom;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const c = clips(getComputedStyle(a));
        if (!c.x && !c.y) continue;
        const q = a.getBoundingClientRect();
        if (c.x) {
          left = Math.max(left, q.left);
          right = Math.min(right, q.right);
        }
        if (c.y) {
          top = Math.max(top, q.top);
          bottom = Math.min(bottom, q.bottom);
        }
      }
      left = Math.max(left, 0);
      top = Math.max(top, 0);
      right = Math.min(right, window.innerWidth);
      bottom = Math.min(bottom, window.innerHeight);
      return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null;
    };
    const name = (el: Element): string => {
      const id = el.getAttribute('data-testid');
      const label = (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/gu, ' ').trim().slice(0, 32);
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${id ? `[${id}]` : ''} "${label}" ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    /** The nearest ancestor that scrolls (or could: overflow auto or scroll) on an axis. */
    const scroller = (el: Element, axis: 'x' | 'y'): HTMLElement | null => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        const o = axis === 'x' ? s.overflowX : s.overflowY;
        if (o === 'auto' || o === 'scroll') return a;
      }
      return null;
    };
    w.__kfLayout = { shown, visibleRect, name, scroller, clips };
  });
}

interface LayoutHelpers {
  shown(el: Element): boolean;
  visibleRect(el: Element): { left: number; top: number; right: number; bottom: number } | null;
  name(el: Element): string;
  scroller(el: Element, axis: 'x' | 'y'): HTMLElement | null;
  clips(style: CSSStyleDeclaration): { x: boolean; y: boolean };
}

/**
 * Every shown control in `scope` is inside the window, or can be scrolled to within a scroller of its
 * own that is itself inside the window (a control past the foot of a panel that runs off the screen
 * cannot be reached). Also flags a scroller that runs past the window's edge.
 */
export async function everyInsideViewport(page: Page, scope = 'body'): Promise<string[]> {
  await install(page);
  return page.evaluate(
    ([sel, interactive]) => {
      const L = (window as unknown as { __kfLayout: LayoutHelpers }).__kfLayout;
      const out = new Set<string>();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inside = (r: { left: number; top: number; right: number; bottom: number }): boolean => r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
      /**
       * Reachable: inside the window, or (each of its scrollers holding it side to side) brought into view
       * by its scrollers in turn, the outermost of them inside the window (a list scrolling within a
       * panel that scrolls is reached by both).
       */
      const reachable = (el: Element): boolean => {
        let r = el.getBoundingClientRect();
        if (inside(r)) return true;
        for (let s = L.scroller(el, 'y'); s; s = L.scroller(s, 'y')) {
          const q = s.getBoundingClientRect();
          if (r.left < q.left - 1 || r.right > q.right + 1) return false;
          if (inside(q)) return true;
          r = q;
        }
        return false;
      };
      for (const root of document.querySelectorAll(sel)) {
        for (const el of root.querySelectorAll(interactive)) {
          if (L.shown(el) && !reachable(el)) out.add(`outside the window: ${L.name(el)}`);
        }
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (!(el instanceof HTMLElement) || !L.shown(el)) continue;
          const s = getComputedStyle(el);
          const scrolls = (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
          if (scrolls && !reachable(el)) out.add(`a scroller past the window's edge: ${L.name(el)}`);
        }
      }
      return [...out];
    },
    [scope, INTERACTIVE] as const,
  );
}

/** Nothing is wider than the window: the page does not scroll sideways, and no shown element runs past its left or right edge unclipped. */
export async function noHorizontalOverflow(page: Page): Promise<string[]> {
  await install(page);
  return page.evaluate(() => {
    const L = (window as unknown as { __kfLayout: LayoutHelpers }).__kfLayout;
    const out: string[] = [];
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) out.push(`the page scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
    const vw = window.innerWidth;
    for (const el of document.body.querySelectorAll('*')) {
      if (!L.shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left >= -1 && r.right <= vw + 1) continue;
      // Cut by a clipping ancestor inside the window (a scroller's content, the scene's tags layer) is not page overflow.
      const v = L.visibleRect(el);
      let clipped = false;
      for (let a = el.parentElement; a && !clipped; a = a.parentElement) {
        if (!L.clips(getComputedStyle(a)).x) continue;
        const q = a.getBoundingClientRect();
        if (q.left >= -1 && q.right <= vw + 1) clipped = true;
      }
      if (!clipped && v) out.push(`past the window's side: ${L.name(el)}`);
    }
    return out;
  });
}

/**
 * No two shown controls in `scope` overlap (by more than 2 px each way, in the parts of them on show:
 * a control scrolled under a panel's foot is cut by its scroller), and nothing that takes the pointer
 * covers a control's centre. A control inside another (a "?" in a summary) is not an overlap.
 */
export async function noOverlappingTargets(page: Page, scope = 'body'): Promise<string[]> {
  await install(page);
  return page.evaluate(
    ([sel, interactive]) => {
      const L = (window as unknown as { __kfLayout: LayoutHelpers }).__kfLayout;
      const out: string[] = [];
      const targets: Array<{ el: Element; r: { left: number; top: number; right: number; bottom: number } }> = [];
      for (const root of document.querySelectorAll(sel)) {
        for (const el of root.querySelectorAll(interactive)) {
          if (!L.shown(el)) continue;
          const r = L.visibleRect(el);
          if (r) targets.push({ el, r });
        }
      }
      for (let i = 0; i < targets.length; i += 1) {
        const a = targets[i];
        if (!a) continue;
        for (let j = i + 1; j < targets.length; j += 1) {
          const b = targets[j];
          if (!b || a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (x > 2 && y > 2) out.push(`overlap: ${L.name(a.el)} and ${L.name(b.el)}`);
        }
        // Its centre answers to it (or to what it holds, or to the label, summary or row it is part of).
        const cx = (a.r.left + a.r.right) / 2;
        const cy = (a.r.top + a.r.bottom) / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && !a.el.contains(hit) && !hit.contains(a.el) && !hit.closest('label')?.contains(a.el)) out.push(`covered: ${L.name(a.el)} under ${L.name(hit)}`);
      }
      return out;
    },
    [scope, INTERACTIVE] as const,
  );
}

/**
 * No shown text in `scope` is cut off: by its own box (wider than it, unclipped by an ellipsis), or by
 * an ancestor that clips it sideways (a column too narrow for its words), or, where the ancestor does
 * not scroll, at its top or foot. Text a scroller holds out of sight is not cut (it scrolls into view).
 * Screen-reader-only text (a 1 px box) is left out.
 */
export async function noClippedText(scope: Locator): Promise<string[]> {
  const page = scope.page();
  await install(page);
  return scope.evaluateAll((roots) => {
    const L = (window as unknown as { __kfLayout: LayoutHelpers }).__kfLayout;
    const out = new Set<string>();
    for (const root of roots) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (!(el instanceof HTMLElement) || !L.shown(el)) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!own) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) continue;
        const s = getComputedStyle(el);
        if (s.textOverflow !== 'ellipsis' && L.clips(s).x && el.scrollWidth > el.clientWidth + 1) out.add(`wider than its box: ${L.name(el)}`);
        for (let a = el.parentElement; a; a = a.parentElement) {
          const as = getComputedStyle(a);
          const c = L.clips(as);
          if (!c.x && !c.y) continue;
          const q = a.getBoundingClientRect();
          if (c.x && (r.left < q.left - 1 || r.right > q.right + 1)) {
            out.add(`cut at the side by ${L.name(a)}: ${L.name(el)}`);
            break;
          }
          // A scroller brings what it holds into view (whether it fits the window is everyInsideViewport's question).
          if (as.overflowY === 'auto' || as.overflowY === 'scroll') break;
          if (c.y && (r.top < q.top - 1 || r.bottom > q.bottom + 1)) {
            out.add(`cut at the top or foot by ${L.name(a)}: ${L.name(el)}`);
            break;
          }
        }
      }
    }
    return [...out];
  });
}
