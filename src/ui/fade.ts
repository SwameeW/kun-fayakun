import { commitStyles } from './dom';

/**
 * A slot that shows at most one item and changes it only by whole-element
 * opacity fades. A new item never appears until the previous one has faded
 * out completely, so scripture is never cut, clipped or overlapped.
 */

export interface FadeItem {
  key: string;
  render(): HTMLElement;
  /** Called once the element is in the DOM and still transparent, before it fades in (e.g. to size it). */
  onMount?(el: HTMLElement): void;
  /** Called once the item starts fading in. */
  onShow?(): void;
}

export interface FadeSlot {
  /** Declares what should be visible; null fades the slot empty. */
  want(item: FadeItem | null): void;
  /** Fades out quickly (for loading and error screens), dropping anything pending. */
  clearFast(): void;
  readonly currentKey: string | null;
}

type Phase = 'in' | 'shown' | 'out';

export function createFadeSlot(container: HTMLElement, fadeMs: number, fastFadeMs = 250): FadeSlot {
  let current: { key: string; el: HTMLElement; phase: Phase } | null = null;
  let desired: FadeItem | null = null;
  let timer: number | undefined;

  function schedule(ms: number, fn: () => void): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  }

  function fadeIn(item: FadeItem): void {
    const el = item.render();
    el.classList.add('kf-fade');
    el.style.setProperty('--kf-fade-ms', `${fadeMs}ms`);
    container.append(el);
    item.onMount?.(el);
    // Commit the transparent start state so the opacity transition runs.
    commitStyles(el);
    el.classList.add('is-visible');
    const shown = { key: item.key, el, phase: 'in' as Phase };
    current = shown;
    item.onShow?.();
    schedule(fadeMs, () => {
      shown.phase = 'shown';
    });
  }

  function fadeOut(ms: number): void {
    if (!current) return;
    const leaving = current;
    if (leaving.phase === 'out') {
      // CSS keeps a running transition's duration when only --kf-fade-ms changes, so a
      // shorter fade would be cut off by the removal timer. Restart it from the opacity
      // it has reached; the element still fades to zero, whole, before it is removed.
      const opacity = getComputedStyle(leaving.el).opacity;
      leaving.el.style.transition = 'none';
      leaving.el.style.opacity = opacity;
      commitStyles(leaving.el);
      leaving.el.style.removeProperty('transition');
      leaving.el.style.removeProperty('opacity');
    }
    leaving.phase = 'out';
    leaving.el.style.setProperty('--kf-fade-ms', `${ms}ms`);
    leaving.el.classList.remove('is-visible');
    schedule(ms, () => {
      leaving.el.remove();
      if (current === leaving) current = null;
      if (desired) fadeIn(desired);
    });
  }

  function reconcile(): void {
    if (!current) {
      if (desired) fadeIn(desired);
      return;
    }
    if (current.phase === 'out') return; // the fade-out completion shows `desired`
    if (current.key !== desired?.key) fadeOut(fadeMs);
  }

  return {
    want(item) {
      desired = item;
      reconcile();
    },
    clearFast() {
      desired = null;
      // Also shortens a slow fade-out already under way; the element leaves whole either way.
      if (current) fadeOut(fastFadeMs);
    },
    get currentKey() {
      return current && current.phase !== 'out' ? current.key : null;
    },
  };
}
