import type { App, UniverseDetail } from '../../core/types';
import type { ExploreTier } from '../../explore/detail';
import { h, uniqueId } from '../dom';
import { readPreferenceString, writePreferenceString } from '../preferences';

/**
 * The explorer's detail menu: Auto, or a tier kept until the visitor chooses again (remembered on
 * this browser). A disclosure button opens a small group of radio buttons (native, so the arrow keys
 * move between them and screen readers announce the group); Esc or a choice closes it. Ultra is
 * listed only where the device may run it. The button reads what is running, and the menu notes when
 * frames are being drawn at a lower internal resolution to stay smooth.
 */

export interface QualityMenu {
  readonly element: HTMLElement;
  update(detail: UniverseDetail): void;
  close(): void;
  readonly open: boolean;
}

const PREFERENCE = 'exploreDetail';
const CHOICES: ReadonlyArray<'auto' | ExploreTier> = ['auto', 'ultra', 'high', 'medium', 'low'];
const isChoice = (value: string | null): value is 'auto' | ExploreTier => CHOICES.some((c) => c === value);

/** The visitor's remembered choice, or null (Auto). */
export function storedDetailChoice(): 'auto' | ExploreTier | null {
  const raw = readPreferenceString(PREFERENCE);
  return isChoice(raw) ? raw : null;
}

export function createQualityMenu(app: App): QualityMenu {
  const { i18n } = app;
  const tierName = (tier: ExploreTier): string => i18n.t(`ui.universe.detail.${tier}`);
  const panelId = uniqueId('detail');
  const button = h('button', { type: 'button', class: 'kf-btn kf-nav-detail-button', 'aria-expanded': 'false', 'aria-controls': panelId, 'data-testid': 'universe-detail' });
  const label = h('span', { class: 'kf-nav-detail-label' }, i18n.t('ui.universe.detail'));
  const value = h('span', { class: 'kf-nav-detail-value' });
  button.append(label, value);
  const legendId = uniqueId('detail-legend');
  const legend = h('legend', { id: legendId, class: 'kf-sr-only' }, i18n.t('ui.universe.detail'));
  const options = new Map<'auto' | ExploreTier, { row: HTMLElement; input: HTMLInputElement }>();
  const name = uniqueId('detail-choice');
  const fieldset = h('fieldset', { class: 'kf-nav-detail-options' }, legend);
  for (const choice of CHOICES) {
    const input = h('input', { type: 'radio', name, value: choice, 'data-testid': `universe-detail-${choice}` });
    const text = h('span', { class: 'kf-nav-detail-option-text' }, choice === 'auto' ? i18n.t('ui.universe.detailAuto') : tierName(choice));
    const row = h('label', { class: 'kf-nav-detail-option' }, input, text);
    input.addEventListener('change', () => {
      if (!input.checked) return;
      writePreferenceString(PREFERENCE, choice);
      app.setUniverseDetail(choice);
    });
    options.set(choice, { row, input });
    fieldset.append(row);
  }
  const note = h('p', { class: 'kf-nav-detail-note' });
  const panel = h('div', { id: panelId, class: 'kf-nav-detail-panel', hidden: true, 'data-kf-keys': 'own' }, fieldset, note);
  const element = h('div', { class: 'kf-nav-detail' }, button, panel);

  let open = false;
  const setOpen = (next: boolean, focusButton = false): void => {
    open = next;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    element.classList.toggle('is-open', next);
    if (next) {
      const checked = [...options.values()].find((o) => o.input.checked) ?? options.get('auto');
      checked?.input.focus();
    } else if (focusButton) {
      button.focus();
    }
  };
  button.addEventListener('click', () => {
    setOpen(!open);
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  // A click elsewhere closes it.
  document.addEventListener('pointerdown', (event) => {
    if (open && event.target instanceof Node && !element.contains(event.target)) setOpen(false);
  });

  let shown = '';
  return {
    element,
    get open() {
      return open;
    },
    close() {
      if (open) setOpen(false);
    },
    update(detail) {
      const key = `${detail.tier}|${detail.choice}|${detail.available.join(',')}|${detail.renderScale.toFixed(2)}|${String(detail.fixed)}`;
      if (key === shown) return;
      shown = key;
      value.textContent = detail.choice === 'auto' ? i18n.t('ui.universe.detailAutoNow', { tier: tierName(detail.tier) }) : tierName(detail.tier);
      for (const [choice, o] of options) {
        o.row.hidden = choice !== 'auto' && !detail.available.includes(choice);
        o.input.checked = choice === detail.choice;
      }
      const parts = [detail.fixed ? i18n.t('ui.universe.detailFixed') : i18n.t('ui.universe.detailNote')];
      if (detail.renderScale < 0.995) parts.push(i18n.t('ui.universe.detailScale', { percent: `${i18n.number(Math.round(detail.renderScale * 100), 0)}%` }));
      note.textContent = parts.join(' ');
    },
  };
}
