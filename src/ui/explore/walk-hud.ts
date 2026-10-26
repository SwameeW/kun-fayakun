import type { App, UniverseView } from '../../core/types';
import { h } from '../dom';
import type { Formatters } from './format';

/**
 * The suit's readout while walking on the Earth (src/explore/walk): where the walker stands, the
 * ground's height, the world's gravity, the air's pressure at the feet (an isothermal atmosphere from
 * the cited sea-level pressure and scale height), the Earth's mean surface temperature (named as a
 * mean, not today's), the Sun's height and the local solar time, folded under the title on a small
 * screen; the keys; and the way back to orbit.
 * While a walk lands (its ground loading) it says so; a walk refused at Makkah says why. Forward,
 * Back and Jump buttons walk without a keyboard (held down, as the keys are; a keyboard's press on
 * one takes a short step).
 */

/** How long a keyboard press on a pad button walks (ms). */
const PAD_STEP_MS = 600;
/** The explorer's narrow layout (its sheet at the foot; ../styles/explore.css). */
const NARROW = '(max-width: 899.98px), (max-height: 559.98px)';

export interface WalkHud {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
}

export function createWalkHud(app: App, f: Formatters, host: () => HTMLElement): WalkHud {
  const { i18n } = app;
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const title = h('summary', { class: 'kf-walk-title', 'data-testid': 'walk-title' });
  const place = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-place' });
  const ground = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-ground' });
  const gravity = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-gravity' });
  const air = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-air' });
  const sun = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-sun' });
  const notice = h('p', { class: 'kf-walk-notice', 'data-testid': 'walk-notice', hidden: true, role: 'status' });
  const keys = h('p', { class: 'kf-walk-keys' }, i18n.t('ui.universe.walk.keys'));
  const touch = h('p', { class: 'kf-walk-touch' }, i18n.t('ui.universe.walk.touch'));
  const held = { forward: false, backward: false, jump: false };
  const send = (): void => {
    app.earthCommand({ kind: 'walkPad', forward: (held.forward ? 1 : 0) - (held.backward ? 1 : 0), jump: held.jump });
  };
  const padButton = (which: keyof typeof held, label: string): HTMLElement => {
    const b = h('button', { type: 'button', class: 'kf-btn kf-walk-pad-btn', 'data-testid': `walk-${which}` }, label);
    const press = (on: boolean): void => {
      if (held[which] === on) return;
      held[which] = on;
      send();
    };
    b.addEventListener('pointerdown', (e) => {
      b.setPointerCapture(e.pointerId);
      press(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(type, () => {
        press(false);
      });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    b.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      press(true);
      window.setTimeout(() => {
        press(false);
      }, PAD_STEP_MS);
    });
    return b;
  };
  const pad = h(
    'div',
    { class: 'kf-walk-pad', role: 'group', 'aria-label': i18n.t('ui.universe.walk.pad') },
    padButton('forward', i18n.t('ui.universe.walk.forward')),
    padButton('backward', i18n.t('ui.universe.walk.backward')),
    padButton('jump', i18n.t('ui.universe.walk.jump')),
  );
  const back = h('button', { type: 'button', class: 'kf-btn kf-walk-back', 'data-testid': 'walk-end' }, i18n.t('ui.universe.walk.back'));
  back.addEventListener('click', () => {
    app.earthCommand({ kind: 'walkEnd' });
  });
  const controls = h('div', { class: 'kf-walk-controls' }, pad, back);
  const credit = h('p', { class: 'kf-walk-credit' }, i18n.t('ui.universe.walk.credit'));
  // The suit's figures fold under the title; on a small screen they start folded, leaving the view and the pad.
  const suit = h('details', { class: 'kf-walk-suit' }, title, place, ground, gravity, air, sun, credit);
  suit.open = !window.matchMedia(NARROW).matches;
  const element = h('aside', { class: 'kf-walk', 'aria-label': i18n.t('ui.universe.walk.label'), 'data-testid': 'walk-hud', hidden: true }, suit, notice, keys, touch, controls);
  const coords = (lat: number, lon: number): string => f.coordinates(lat, lon, 4);
  const clock = (hours: number): string => {
    const m = Math.floor(hours * 60) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  return {
    element,
    update(view) {
      const w = view.walk;
      element.hidden = w === null && !view.walkRefused;
      host().classList.toggle('is-walking', w !== null && w.state === 'walking');
      if (!w) {
        write(title, view.walkRefused ? i18n.t('ui.universe.walk.refusedTitle') : '');
        notice.hidden = !view.walkRefused;
        write(notice, view.walkRefused ? i18n.t('ui.universe.walk.refused') : '');
        for (const el of [place, ground, gravity, air, sun, keys, touch, controls, credit]) el.hidden = view.walkRefused;
        if (held.forward || held.backward || held.jump) {
          held.forward = held.backward = held.jump = false;
          send();
        }
        return;
      }
      for (const el of [place, ground, gravity, air, sun, keys, touch, controls, credit]) el.hidden = false;
      write(title, i18n.t(w.state === 'landing' ? 'ui.universe.walk.landing' : 'ui.universe.walk.title'));
      write(place, coords(w.lat, w.lon));
      write(ground, i18n.t('ui.universe.walk.ground', { metres: f.number(w.groundM, 0), walked: f.number(w.walkedM, 0) }));
      write(gravity, i18n.t('ui.universe.walk.gravity', { g: f.number(w.gravity, 2) }));
      write(air, w.pressureKpa === null ? '' : i18n.t('ui.universe.walk.air', { kpa: f.number(w.pressureKpa, 1), mean: w.meanTempC === null ? '' : f.number(w.meanTempC, 0) }));
      write(sun, i18n.t(w.sunElevationDeg >= 0 ? 'ui.universe.walk.sunUp' : 'ui.universe.walk.sunDown', { degrees: f.number(Math.abs(w.sunElevationDeg), 0), time: clock(w.solarTimeH) }));
      notice.hidden = !w.blocked;
      write(notice, w.blocked ? i18n.t('ui.universe.walk.blocked') : '');
    },
  };
}
