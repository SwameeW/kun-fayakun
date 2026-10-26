import type { App } from '../../core/types';
import { h } from '../dom';

/**
 * Parts of the explorer's interface that are chunks of their own (a section's body, the laboratory's
 * or the stars' panel), loaded the first time they are wanted. `once` loads a chunk a single time
 * however often it is asked for while on its way (a section opened and closed quickly gets one body),
 * and forgets a failure, so asking again tries again. `waiting` is the line in the part's place
 * meanwhile: it says the part is coming, or that it did not come (offline, or a new version published
 * under an open page) with a button to try again; a polite status. Nothing is thrown and no section is
 * left empty.
 */

export function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    }));
}

export interface Waiting {
  readonly element: HTMLElement;
  /** Says the part did not come, with its button to try again. */
  failed(): void;
}

/** `retry` asks for the part again; `extra` (a way out of a mode whose panel did not come) sits beside the button. */
export function waiting(app: App, retry: () => void, extra?: HTMLElement): Waiting {
  const { i18n } = app;
  const text = h('span', {}, i18n.t('ui.universe.partLoading'));
  const again = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'part-retry', hidden: true }, i18n.t('ui.universe.partRetry'));
  const element = h('div', { class: 'kf-part-waiting', 'data-testid': 'part-waiting' }, h('p', { class: 'kf-living-hint', role: 'status' }, text), h('div', { class: 'kf-lab-row' }, again, extra));
  if (extra) extra.hidden = true;
  again.addEventListener('click', () => {
    // The button keeps focus (it is not hidden under it) until the part arrives or fails again.
    if (again.getAttribute('aria-disabled') === 'true') return;
    again.setAttribute('aria-disabled', 'true');
    text.textContent = i18n.t('ui.universe.partLoading');
    retry();
  });
  return {
    element,
    failed() {
      text.textContent = i18n.t('ui.universe.partFailed');
      again.hidden = false;
      again.removeAttribute('aria-disabled');
      if (extra) extra.hidden = false;
    },
  };
}
