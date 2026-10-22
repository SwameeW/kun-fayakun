import { h } from './dom';

export interface Announcer {
  readonly element: HTMLElement;
  /** Politely announces text to screen readers (chapter changes, the current verse translation). */
  announce(text: string): void;
}

export function createAnnouncer(): Announcer {
  const element = h('div', { class: 'kf-sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let timer: number | undefined;
  return {
    element,
    announce(text) {
      window.clearTimeout(timer);
      // Clearing first makes repeated identical messages announce again.
      element.textContent = '';
      timer = window.setTimeout(() => {
        element.textContent = text;
      }, 60);
    },
  };
}
