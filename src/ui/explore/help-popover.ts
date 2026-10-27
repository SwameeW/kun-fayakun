import type { App } from '../../core/types';
import helpMessages from '../../i18n/en.help.json';
import { h, uniqueId } from '../dom';
import css from '../styles/help.css?inline';

// Its styles come with its code (as ./lazy's styles puts them; this chunk takes nothing of the explorer's).
document.head.append(h('style', {}, css));

/**
 * The plain-words popover the "?" buttons open (./help; its own chunk with src/i18n/en.help.json):
 * one at a time, beside its button and inside the screen, as a non-modal dialog the screen reader
 * announces. Esc, its close button, a click elsewhere or the same "?" again closes it, and focus goes
 * back to the "?" that opened it. Nothing in it moves unless the visitor's motion preference allows.
 */

interface Popover {
  el: HTMLElement;
  title: HTMLElement;
  text: HTMLElement;
  close: HTMLButtonElement;
  owner: HTMLButtonElement | null;
}

/** Space kept between the popover and the screen's edges, and between it and its button (px). */
const MARGIN = 12;
const GAP = 6;

let pop: Popover | null = null;

function build(app: App): Popover {
  const titleId = uniqueId('help-title');
  const textId = uniqueId('help-text');
  const title = h('p', { id: titleId, class: 'kf-help-title' });
  const text = h('p', { id: textId, class: 'kf-help-text', 'data-testid': 'help-text' });
  const close = h('button', { type: 'button', class: 'kf-help-close', 'aria-label': app.i18n.t('help.close') }, '×');
  const el = h('div', { class: 'kf-help-pop', role: 'dialog', 'aria-labelledby': titleId, 'aria-describedby': textId, 'data-testid': 'help-popover', tabindex: '-1', hidden: true }, h('div', { class: 'kf-help-head' }, title, close), text);
  close.addEventListener('click', () => {
    closeHelp(true);
  });
  // Esc closes it first (before the explorer's own Esc, which leaves photo mode or a walk).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !pop?.owner) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeHelp(true);
    },
    true,
  );
  // A press anywhere else closes it (the "?" that opened it toggles it itself).
  document.addEventListener(
    'pointerdown',
    (e) => {
      const p = pop;
      if (!p?.owner || !(e.target instanceof Node)) return;
      if (p.el.contains(e.target) || p.owner.contains(e.target)) return;
      closeHelp(false);
    },
    true,
  );
  // Kept beside its button as the page scrolls or resizes; closed if the button leaves the screen.
  const follow = (): void => {
    if (pop?.owner) place(pop.el, pop.owner);
  };
  window.addEventListener('resize', follow);
  document.addEventListener('scroll', follow, true);
  document.body.append(el);
  return { el, title, text, close, owner: null };
}

/** Beside the button: below it if there is room, else above; never past the screen's edges. */
function place(el: HTMLElement, owner: HTMLElement): void {
  const r = owner.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    closeHelp(false);
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.maxInlineSize = `${String(Math.min(320, vw - 2 * MARGIN))}px`;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const below = r.bottom + GAP + hgt <= vh - MARGIN || r.top - GAP - hgt < MARGIN;
  const top = below ? Math.min(r.bottom + GAP, vh - MARGIN - hgt) : r.top - GAP - hgt;
  const left = Math.max(MARGIN, Math.min(r.left + r.width / 2 - w / 2, vw - MARGIN - w));
  el.style.insetBlockStart = `${String(Math.max(MARGIN, top))}px`;
  el.style.insetInlineStart = `${String(left)}px`;
}

/** Opens the explanation of `topic` beside `button` (or closes it, if it is that button's already). */
export function toggleHelp(app: App, button: HTMLButtonElement, topic: string, label: string): void {
  app.i18n.extend('en.help.json', helpMessages);
  if (pop?.owner === button) {
    closeHelp(true);
    return;
  }
  closeHelp(false);
  pop ??= build(app);
  const p = pop;
  p.owner = button;
  p.title.textContent = label;
  p.text.textContent = app.i18n.t(`help.${topic}`);
  p.el.dataset.topic = topic;
  p.el.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-controls', p.el.id || (p.el.id = uniqueId('help-pop')));
  place(p.el, button);
  // Into the dialog, so a screen reader reads it; Tab reaches its close button.
  p.el.focus({ preventScroll: true });
}

/** Closes it; `refocus` returns focus to the "?" that opened it. */
export function closeHelp(refocus: boolean): void {
  const p = pop;
  if (!p?.owner) return;
  const owner = p.owner;
  p.owner = null;
  p.el.hidden = true;
  owner.setAttribute('aria-expanded', 'false');
  if (refocus) owner.focus({ preventScroll: true });
}
