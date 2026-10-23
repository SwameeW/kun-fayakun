import type { App, UniverseDetail } from '../../core/types';
import { DETAIL, textureTier, type ExploreTier } from '../../explore/detail';
import { h, uniqueId } from '../dom';
import { icon } from '../icons';
import { readPreferenceString, writePreferenceString } from '../preferences';

/**
 * The explorer's detail menu: Auto, or a tier kept until the visitor chooses again (remembered on
 * this browser). A disclosure button opens a small panel, headed and with its own close control,
 * holding a group of native radio buttons (screen readers announce the group; each tier says in a
 * line what it draws, read from the presets in src/explore/detail.ts so the words cannot drift from
 * what runs). Ultra is listed only where the device may run it.
 *
 * Choosing is deliberate: the arrow keys only move the selection (a tier switch rebuilds the globes
 * and may compile materials, so it is not done for every step of a keyboard's browsing); a click or
 * tap, Enter or Space applies the selected tier and closes the panel, and so does leaving it with the
 * selection moved (Tab away, a click outside). Esc closes it and puts the selection back. Applying
 * says what the tier draws (onApplied, the explorer's quiet toast). The button reads what is
 * running, and the panel notes when frames are drawn at a lower internal resolution to stay smooth.
 */

export interface QualityMenu {
  readonly element: HTMLElement;
  update(detail: UniverseDetail): void;
  close(): void;
  readonly open: boolean;
}

type Choice = 'auto' | ExploreTier;

const PREFERENCE = 'exploreDetail';
const CHOICES: readonly Choice[] = ['auto', 'ultra', 'high', 'medium', 'low'];
const isChoice = (value: string | null): value is Choice => CHOICES.some((c) => c === value);
/** Published map widths by texture tier, px. */
const MAP_PX = { low: 1024, medium: 2048, high: 4096, ultra: 8192 } as const;
/** A radio's click within this long of a press on its row is the pointer's (a click, a tap), not the keyboard's. */
const POINTER_CLICK_MS = 1500;

/** The visitor's remembered choice, or null (Auto). */
export function storedDetailChoice(): Choice | null {
  const raw = readPreferenceString(PREFERENCE);
  return isChoice(raw) ? raw : null;
}

export function createQualityMenu(app: App, onApplied: (title: string, line: string) => void): QualityMenu {
  const { i18n } = app;
  const tierName = (tier: ExploreTier): string => i18n.t(`ui.universe.detail.${tier}`);
  /** What a tier draws, in a line: its maps, its air, and what it adds (from the presets). */
  const describe = (tier: ExploreTier): string => {
    const d = DETAIL[tier];
    const parts = [
      i18n.t('ui.universe.detailMaps', { size: MAP_PX[textureTier(d)] / 1024 }),
      i18n.t(`ui.universe.detailAir.${d.atmosphere}`),
      d.cloudShadows ? i18n.t('ui.universe.detailHas.cloudShadows') : null,
      d.normalMaps ? i18n.t('ui.universe.detailHas.relief') : null,
      d.nightLights ? i18n.t('ui.universe.detailHas.nightLights') : null,
      d.ringDetail === 'particles' ? i18n.t('ui.universe.detailHas.particles') : null,
      d.sunDetail === 'full' ? i18n.t('ui.universe.detailHas.corona') : null,
      d.bloom ? i18n.t('ui.universe.detailHas.glow') : null,
      // The 8K maps are a large download: said before anyone chooses them.
      tier === 'ultra' ? i18n.t('ui.universe.detailHas.download') : null,
    ];
    return parts.filter((p): p is string => p !== null).join(' · ');
  };

  const panelId = uniqueId('detail');
  const headingId = uniqueId('detail-heading');
  const button = h('button', { type: 'button', class: 'kf-btn kf-nav-detail-button', 'aria-expanded': 'false', 'aria-controls': panelId, 'data-testid': 'universe-detail' });
  const label = h('span', { class: 'kf-nav-detail-label' }, i18n.t('ui.universe.detail'));
  const value = h('span', { class: 'kf-nav-detail-value' });
  button.append(label, value);

  const heading = h('h3', { id: headingId, class: 'kf-nav-detail-heading' }, i18n.t('ui.universe.detailTitle'));
  const closeButton = h('button', { type: 'button', class: 'kf-nav-detail-close', 'aria-label': i18n.t('ui.universe.detailClose'), 'data-testid': 'universe-detail-close' }, icon('close'));
  const options = new Map<Choice, { row: HTMLElement; input: HTMLInputElement }>();
  const name = uniqueId('detail-choice');
  const fieldset = h('fieldset', { class: 'kf-nav-detail-options', 'aria-labelledby': headingId });
  for (const choice of CHOICES) {
    const input = h('input', { type: 'radio', name, value: choice, 'data-testid': `universe-detail-${choice}` });
    const text = h('span', { class: 'kf-nav-detail-option-name' }, choice === 'auto' ? i18n.t('ui.universe.detailAuto') : tierName(choice));
    const what = h('span', { class: 'kf-nav-detail-option-what' }, choice === 'auto' ? i18n.t('ui.universe.detailAutoWhat') : describe(choice));
    const row = h('label', { class: 'kf-nav-detail-option' }, input, h('span', { class: 'kf-nav-detail-option-text' }, text, what));
    options.set(choice, { row, input });
    fieldset.append(row);
  }
  const note = h('p', { class: 'kf-nav-detail-note' });
  const panel = h(
    'div',
    { id: panelId, class: 'kf-nav-detail-panel', hidden: true, 'data-kf-keys': 'own' },
    h('div', { class: 'kf-nav-detail-head' }, heading, closeButton),
    fieldset,
    note,
  );
  const element = h('div', { class: 'kf-nav-detail' }, button, panel);

  /** The choice applied now (the explorer's), and the one the radios show. */
  let applied: Choice = 'auto';
  const checked = (): Choice => [...options].find(([, o]) => o.input.checked)?.[0] ?? applied;
  const showChecked = (choice: Choice): void => {
    for (const [c, o] of options) o.input.checked = c === choice;
  };

  const commit = (choice: Choice): void => {
    if (choice === applied) return;
    applied = choice;
    writePreferenceString(PREFERENCE, choice);
    app.setUniverseDetail(choice);
    // Say what it means; Auto names the tier once the explorer reports it (update()).
    if (choice !== 'auto') onApplied(i18n.t('ui.universe.detailApplied', { tier: tierName(choice), what: describe(choice) }), '');
    else announceAuto = true;
  };
  let announceAuto = false;

  let open = false;
  const setOpen = (next: boolean, focusButton = false): void => {
    open = next;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    element.classList.toggle('is-open', next);
    if (next) {
      showChecked(applied);
      (options.get(applied) ?? options.get('auto'))?.input.focus();
    } else if (focusButton) {
      button.focus();
    }
  };
  /** Closes it, applying the selection if it was moved (leaving with it moved is a choice). */
  const closeApplying = (focusButton = false): void => {
    if (!open) return;
    commit(checked());
    setOpen(false, focusButton);
  };
  /** Closes it, putting the selection back (Esc, the close control). */
  const closeReverting = (focusButton = false): void => {
    if (!open) return;
    showChecked(applied);
    setOpen(false, focusButton);
  };

  button.addEventListener('click', () => {
    if (open) closeApplying();
    else setOpen(true);
  });
  closeButton.addEventListener('click', () => {
    closeReverting(true);
  });
  // A click or tap on a tier applies it at once. The arrow keys (and Space) also make the browser
  // click a radio, so a click counts as the pointer's only right after a press on that same row.
  let pressed: { choice: Choice; at: number } | null = null;
  for (const [choice, o] of options) {
    o.row.addEventListener('pointerdown', (event) => {
      if (event.button === 0) pressed = { choice, at: performance.now() };
    });
    o.input.addEventListener('click', () => {
      const press = pressed;
      pressed = null;
      if (!press || press.choice !== choice || performance.now() - press.at > POINTER_CLICK_MS) return;
      commit(choice);
      setOpen(false, true);
    });
  }
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeReverting(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      closeApplying(true);
    }
  });
  panel.addEventListener('keyup', (event) => {
    // Space on a radio selects it (the browser's own) and here also applies it.
    if (event.key === ' ' && event.target instanceof HTMLInputElement) closeApplying(true);
  });
  // Leaving the panel with the keyboard (Tab) applies what is selected.
  element.addEventListener('focusout', (event) => {
    if (open && !(event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) && event.relatedTarget !== null) closeApplying();
  });
  // A click or tap elsewhere closes it (applying a moved selection).
  document.addEventListener('pointerdown', (event) => {
    if (open && event.target instanceof Node && !element.contains(event.target)) closeApplying();
  });

  let shown = '';
  return {
    element,
    get open() {
      return open;
    },
    close() {
      closeApplying();
    },
    update(detail) {
      const key = `${detail.tier}|${detail.choice}|${detail.available.join(',')}|${detail.renderScale.toFixed(2)}|${String(detail.fixed)}`;
      if (key === shown) return;
      shown = key;
      applied = detail.choice;
      value.textContent = detail.choice === 'auto' ? i18n.t('ui.universe.detailAutoNow', { tier: tierName(detail.tier) }) : tierName(detail.tier);
      for (const [choice, o] of options) o.row.hidden = choice !== 'auto' && !detail.available.includes(choice);
      // While the panel is open the visitor's selection stands; otherwise it follows what runs.
      if (!open) showChecked(detail.choice);
      if (announceAuto && detail.choice === 'auto') {
        announceAuto = false;
        onApplied(i18n.t('ui.universe.detailApplied', { tier: i18n.t('ui.universe.detailAutoNow', { tier: tierName(detail.tier) }), what: describe(detail.tier) }), '');
      }
      const parts = [detail.fixed ? i18n.t('ui.universe.detailFixed') : i18n.t('ui.universe.detailKept')];
      if (detail.renderScale < 0.995) parts.push(i18n.t('ui.universe.detailScale', { percent: `${i18n.number(Math.round(detail.renderScale * 100), 0)}%` }));
      note.textContent = parts.join(' ');
    },
  };
}
