import type { App } from '../../core/types';
import { h } from '../dom';
import { once } from './lazy';

/**
 * Plain-words help: the small "?" beside a label. It is a button of its own, never part of the
 * label's control (it opens no section, flies nowhere and changes no value), and it opens an
 * explanation a child could follow. The explanations and their popover come with their own chunk
 * (./help-popover, with src/i18n/en.help.json), loaded the first time one is opened (./lazy: once,
 * however many presses ask for it on its way). If it does not come, the explorer's toast says so (a
 * polite status, once for presses that asked together), nothing is thrown, and the next press tries
 * again.
 */
const popover = once(() => import('./help-popover'));
/** The load whose failure was last told (presses that shared one are told once). */
let told: Promise<unknown> | null = null;

/** The explorer's toast takes this (src/ui/explore/index.ts): a line to show and say. */
export const TOAST_EVENT = 'kf-universe-toast';

export function helpButton(app: App, topic: string, label: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'kf-help', 'aria-label': app.i18n.t('ui.help.ask', { label }), 'aria-expanded': 'false', 'aria-haspopup': 'dialog', 'data-testid': `help-${topic}` }, '?');
  b.addEventListener('click', (e) => {
    // Its own action only: not the summary, row or control it sits beside.
    e.stopPropagation();
    e.preventDefault();
    const loading = popover();
    loading
      .then((m) => {
        m.toggleHelp(app, b, topic, label);
      })
      .catch((err: unknown) => {
        if (told === loading) return;
        told = loading;
        console.warn('explore: an explanation did not load', err);
        window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: app.i18n.t('ui.help.failed') }));
      });
  });
  return b;
}

/** A label with its "?" beside it, on one line. */
export function withHelp(app: App, el: HTMLElement, topic: string, label = el.textContent.trim()): HTMLElement {
  return h('div', { class: 'kf-help-row' }, el, helpButton(app, topic, label));
}
