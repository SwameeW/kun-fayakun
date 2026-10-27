import type { App, UniverseView } from '../../core/types';
import { h } from '../dom';
import { createFadeSlot } from '../fade';
import { icon } from '../icons';
import type { Formatters } from './format';

/**
 * A quiet note about what the camera is near (src/explore/discoveries chooses which and computes
 * its numbers from cited data): it fades in when the visitor arrives, out when they leave or set
 * off on a trip, one at a time, and says where its numbers come from. It is announced once, politely,
 * when it appears; its numbers (a phase, a tilt) are rounded so they do not churn.
 *
 * It shares the top of the view with the trip indicator, never at the same time: the stylesheet
 * fades the note right out before the indicator comes in, and the indicator out before a note comes
 * back, and both have the same width. Its title folds it (to the title alone) and opens it again; on a
 * phone it folds by itself after a few seconds, or as soon as the visitor touches the scene, so the
 * world gets the screen back.
 */

export interface Notes {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
  /** Folds the note showing to its title (a touch on the scene, on a phone). */
  fold(): void;
}

type Values = Readonly<Record<string, number>>;

/** On a phone a note folds to its title this long after it appears, ms. */
const FOLD_MS = 6500;

export function createNotes(app: App, f: Formatters, announce: (text: string) => void, compact: () => boolean): Notes {
  const { i18n } = app;
  const n = (v: number | undefined, digits = 0): string => f.number(v ?? 0, digits);
  /** The lines of each note, from its values. */
  const lines = (id: string, v: Values): string[] => {
    switch (id) {
      case 'earth':
        return [
          i18n.t('ui.universe.note.earth.day', { sidereal: f.hours(v.sidereal ?? 0), solar: f.hours(v.solar ?? 0) }),
          i18n.t('ui.universe.note.earth.tilt', { tilt: n(v.tilt, 1) }),
        ];
      case 'earth-air':
        return [i18n.t('ui.universe.note.earthAir.body', { scaleHeight: n(v.scaleHeight, 1), depth: n(v.depth), below: n(v.below, 2), share: n(v.share, 1) })];
      case 'moon':
        return [
          i18n.t('ui.universe.note.moon.phase', { lit: n(v.lit), waxing: (v.waxing ?? 0) > 0 ? 'waxing' : 'waning' }),
          i18n.t('ui.universe.note.moon.terminator', { speed: n(v.terminator) }),
          i18n.t('ui.universe.note.moon.rotation', { days: n(v.rotation, 1) }),
        ];
      case 'sun':
        return [
          i18n.t('ui.universe.note.sun.light', { time: f.lightTime(v.lightSeconds ?? 0) }),
          i18n.t('ui.universe.note.sun.surface', { temperature: n(v.temperature) }),
          i18n.t('ui.universe.note.sun.rotation', { days: n(v.rotation, 1) }),
        ];
      case 'jupiter':
        return [
          i18n.t('ui.universe.note.jupiter.day', { day: f.hours(v.day ?? 0) }),
          i18n.t('ui.universe.note.jupiter.flattening', { percent: n(v.flattening, 1) }),
          i18n.t('ui.universe.note.jupiter.light', { time: f.lightTime(v.lightSeconds ?? 0) }),
        ];
      case 'saturn':
        return [
          i18n.t('ui.universe.note.saturn.span', { inner: f.distance(v.inner ?? 0), outer: f.distance(v.outer ?? 0) }),
          i18n.t('ui.universe.note.saturn.tilt', { tilt: n(v.tilt, 1), years: n(v.edgeOn, 1) }),
          i18n.t('ui.universe.note.saturn.day', { day: f.hours(v.day ?? 0) }),
        ];
      default:
        return [];
    }
  };
  const TITLES: Readonly<Record<string, string>> = {
    earth: 'ui.universe.note.earth.title',
    'earth-air': 'ui.universe.note.earthAir.title',
    moon: 'ui.universe.note.moon.title',
    sun: 'ui.universe.note.sun.title',
    jupiter: 'ui.universe.note.jupiter.title',
    saturn: 'ui.universe.note.saturn.title',
  };
  const SOURCES: Readonly<Record<string, string>> = {
    earth: 'ui.universe.note.source.rotation',
    'earth-air': 'ui.universe.note.source.air',
    moon: 'ui.universe.note.source.moon',
    sun: 'ui.universe.note.source.sun',
    jupiter: 'ui.universe.note.source.rotation',
    saturn: 'ui.universe.note.source.rings',
  };

  const element = h('aside', { class: 'kf-note-slot', 'aria-label': i18n.t('ui.universe.noteLabel'), 'data-testid': 'universe-note' });
  const slot = createFadeSlot(element, 900, 300);
  let shownKey = '';
  let currentId: string | null = null;
  let quiet = false;
  let card: HTMLElement | null = null;
  let foldTimer = 0;

  const setFolded = (target: HTMLElement, folded: boolean): void => {
    target.classList.toggle('is-folded', folded);
    const toggle = target.querySelector<HTMLButtonElement>('.kf-note-toggle');
    // Its name is its title (what it shows); aria-expanded says whether the rest is open.
    toggle?.setAttribute('aria-expanded', String(!folded));
  };

  const render = (id: string, v: Values): HTMLElement => {
    const bodyId = `kf-note-body-${id}`;
    const toggle = h(
      'button',
      { type: 'button', class: 'kf-note-toggle', 'aria-expanded': 'true', 'aria-controls': bodyId },
      h('span', { class: 'kf-note-title' }, i18n.t(TITLES[id] ?? '')),
      icon('chevron'),
    );
    const body = h(
      'div',
      { id: bodyId, class: 'kf-note-body' },
      ...lines(id, v).map((line) => h('p', { class: 'kf-note-line' }, line)),
      h('p', { class: 'kf-note-source' }, i18n.t(SOURCES[id] ?? '')),
    );
    const next = h('div', { class: 'kf-note', 'data-note': id }, toggle, body);
    toggle.addEventListener('click', () => {
      window.clearTimeout(foldTimer);
      setFolded(next, !next.classList.contains('is-folded'));
    });
    return next;
  };

  return {
    element,
    update(view) {
      // On foot (landing included) the notes step aside, and say nothing over the walk's own words.
      quiet = view.walk !== null || view.walkWaiting;
      const d = view.discovery;
      if (!d) {
        if (currentId !== null) slot.want(null);
        currentId = null;
        card = null;
        window.clearTimeout(foldTimer);
        return;
      }
      if (d.id !== currentId) {
        currentId = d.id;
        const id = d.id;
        const values = d.values;
        shownKey = lines(id, values).join('|');
        window.clearTimeout(foldTimer);
        slot.want({
          key: id,
          render: () => {
            card = render(id, values);
            return card;
          },
          onShow: () => {
            if (!quiet) announce(`${i18n.t(TITLES[id] ?? '')}. ${lines(id, values)[0] ?? ''}`);
            // On a phone the note gives the world its screen back after a while.
            if (compact()) {
              const shown = card;
              foldTimer = window.setTimeout(() => {
                if (shown && shown === card) setFolded(shown, true);
              }, FOLD_MS);
            }
          },
        });
        return;
      }
      // Same note, new numbers (a phase, a tilt): its lines are rewritten in place, quietly.
      const key = lines(d.id, d.values).join('|');
      if (key !== shownKey && card) {
        shownKey = key;
        const fresh = lines(d.id, d.values);
        card.querySelectorAll('.kf-note-line').forEach((el, i) => {
          if (fresh[i] !== undefined && el.textContent !== fresh[i]) el.textContent = fresh[i];
        });
      }
    },
    fold() {
      window.clearTimeout(foldTimer);
      if (card && compact()) setFolded(card, true);
    },
  };
}
