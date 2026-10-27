import type { I18n } from '../core/types';
import { h, handlesSpace, uniqueId } from './dom';
import { icon } from './icons';
import './styles/dialog.css';

export interface ShortcutActions {
  togglePlay(): void;
  previous(): void;
  next(): void;
  seekBy(seconds: number): void;
  togglePanel(): void;
  explore(): void;
  /** Esc: leave explore mode and return focus to the timeline. */
  leaveExplore(): void;
  /** /: open the assistant (its panel, with the question field focused). */
  ask(): void;
}

const SEEK_STEP_S = 10;

/**
 * Text-entry controls own every key; a slider owns only its arrow keys. A region marked
 * data-kf-keys="own" (the letter analysis) owns every key pressed inside it, so its arrows,
 * P and Escape never also seek, toggle the panel or leave explore mode.
 */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-kf-keys="own"]')) return true;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    if (target.type === 'range') return key.startsWith('Arrow') || key === 'Home' || key === 'End' || key.startsWith('Page');
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type);
  }
  return false;
}

export interface Shortcuts {
  readonly dialog: HTMLDialogElement;
  openHelp(): void;
}

function helpDialog(i18n: I18n): HTMLDialogElement {
  const titleId = uniqueId('shortcuts');
  const rows: Array<[string[], string]> = [
    [['Space'], 'ui.shortcuts.space'],
    [['←', '→'], 'ui.shortcuts.arrows'],
    [['Shift', '←', '→'], 'ui.shortcuts.shiftArrows'],
    [['P'], 'ui.shortcuts.panel'],
    [['E'], 'ui.shortcuts.explore'],
    [['/'], 'ui.shortcuts.ask'],
    [['Esc'], 'ui.shortcuts.escape'],
    [['?'], 'ui.shortcuts.help'],
  ];
  const close = h('button', { type: 'button', class: 'kf-btn kf-btn--icon kf-dialog-close' }, icon('close'), h('span', { class: 'kf-sr-only' }, i18n.t('ui.shortcuts.close')));
  const dialog = h(
    'dialog',
    { class: 'kf-dialog', 'aria-labelledby': titleId },
    h('div', { class: 'kf-dialog-head' }, h('h2', { id: titleId }, i18n.t('ui.shortcuts.title')), close),
    h(
      'dl',
      { class: 'kf-shortcuts' },
      ...rows.flatMap(([keys, label]) => [
        h('dt', {}, ...keys.flatMap((k, i) => (i === 0 ? [h('kbd', {}, k)] : [' ', h('kbd', {}, k)]))),
        h('dd', {}, i18n.t(label)),
      ]),
    ),
    h('p', { class: 'kf-muted' }, i18n.t('ui.shortcuts.note')),
  );
  close.addEventListener('click', () => {
    dialog.close();
  });
  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

export function createShortcuts(i18n: I18n, actions: ShortcutActions): Shortcuts {
  const dialog = helpDialog(i18n);
  const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

  function openHelp(): void {
    if (!dialog.open) dialog.showModal();
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (dialog.open || ownsKey(event.target, event.key)) return;
    let handled = true;
    switch (event.key) {
      case ' ':
        if (handlesSpace(event.target)) return; // let buttons and links activate natively
        actions.togglePlay();
        break;
      case forward:
        if (event.shiftKey) actions.seekBy(SEEK_STEP_S);
        else actions.next();
        break;
      case backward:
        if (event.shiftKey) actions.seekBy(-SEEK_STEP_S);
        else actions.previous();
        break;
      case 'p':
      case 'P':
        actions.togglePanel();
        break;
      case 'e':
      case 'E':
        actions.explore();
        break;
      case 'Escape':
        actions.leaveExplore();
        break;
      case '?':
        openHelp();
        break;
      case '/':
        actions.ask();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });

  return { dialog, openHelp };
}
