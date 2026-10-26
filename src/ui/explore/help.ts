import type { App } from '../../core/types';
import { h } from '../dom';

/**
 * Plain-words help: the small "?" beside a label. It is a button of its own, never part of the
 * label's control (it opens no section, flies nowhere and changes no value), and it opens an
 * explanation a child could follow. The explanations and their popover come with their own chunk
 * (./help-popover, with src/i18n/en.help.json), loaded the first time one is opened.
 */
export function helpButton(app: App, topic: string, label: string): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'kf-help', 'aria-label': app.i18n.t('ui.help.ask', { label }), 'aria-expanded': 'false', 'aria-haspopup': 'dialog', 'data-testid': `help-${topic}` }, '?');
  b.addEventListener('click', (e) => {
    // Its own action only: not the summary, row or control it sits beside.
    e.stopPropagation();
    e.preventDefault();
    void import('./help-popover').then((m) => {
      m.toggleHelp(app, b, topic, label);
    });
  });
  return b;
}

/** A label with its "?" beside it, on one line. */
export function withHelp(app: App, el: HTMLElement, topic: string, label = el.textContent.trim()): HTMLElement {
  return h('div', { class: 'kf-help-row' }, el, helpButton(app, topic, label));
}
