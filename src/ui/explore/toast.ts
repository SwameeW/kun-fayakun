import { h } from '../dom';

/**
 * A quiet toast for the explorer: a line or two that fades in, stays a few seconds and fades out,
 * for moments worth marking but not worth interrupting (something seen for the first time joining
 * the log; a detail level applied, with what it draws). One at a time: a second waits for the first.
 * It is its own polite live region, present from the start (so screen readers hear each message
 * once), and it never takes focus or a pointer. Its fades are eased over 0.6 s (flash safety).
 */

export interface Toast {
  readonly element: HTMLElement;
  /** Shows a message (a title, and an optional line under it), after any already showing. */
  show(title: string, line?: string): void;
}

/** How long a message stays, and the fade (matches the CSS), ms. */
const HOLD_MS = 3800;
const FADE_MS = 600;
/** At most this many wait their turn; older ones give way (a burst of discoveries on arrival). */
const QUEUE = 3;

export function createToast(testId: string): Toast {
  const title = h('p', { class: 'kf-toast-title' });
  const line = h('p', { class: 'kf-toast-line' });
  const element = h('div', { class: 'kf-toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-testid': testId }, title, line);
  const queue: Array<{ title: string; line: string }> = [];
  let busy = false;

  const next = (): void => {
    const message = queue.shift();
    if (!message) {
      busy = false;
      return;
    }
    busy = true;
    title.textContent = message.title;
    line.textContent = message.line;
    line.hidden = message.line === '';
    element.classList.add('is-visible');
    window.setTimeout(() => {
      element.classList.remove('is-visible');
      window.setTimeout(() => {
        // Emptied once faded, so the region holds nothing stale between messages.
        if (!element.classList.contains('is-visible')) {
          title.textContent = '';
          line.textContent = '';
        }
        next();
      }, FADE_MS + 100);
    }, HOLD_MS);
  };

  return {
    element,
    show(t, l = '') {
      queue.push({ title: t, line: l });
      while (queue.length > QUEUE) queue.shift();
      if (!busy) next();
    },
  };
}
