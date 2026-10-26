import type { App, I18nKey, UniverseView, UniverseWalk, WalkableWorld } from '../../core/types';
import { h } from '../dom';
import type { Formatters } from './format';

/**
 * The suit's readout while walking on the Earth, the Moon, Mars, Mercury or Venus (src/explore/walk): where the
 * walker stands, the ground's height above the world's datum, its gravity, the air's pressure at the
 * feet (an isothermal atmosphere from the cited surface pressure and scale height) and the world's
 * mean surface temperature (named as a mean, not today's), or on the airless Moon the vacuum and its
 * ground's range through the day, the Sun's height and the local solar time, and where the ground
 * comes from, folded under the title on a small screen; the keys; and the way back to orbit.
 * While a walk lands (its ground loading) it says so; a walk refused at Makkah says why. Forward,
 * Back and Jump buttons walk without a keyboard (held down, as the keys are; a keyboard's press on
 * one takes a short step).
 */

/** Each world's title, height line and credit. */
const WORLD: Record<WalkableWorld, { title: I18nKey; ground: I18nKey; credit: I18nKey }> = {
  earth: { title: 'ui.universe.walk.title', ground: 'ui.universe.walk.ground', credit: 'ui.universe.walk.credit' },
  moon: { title: 'ui.universe.walk.titleMoon', ground: 'ui.universe.walk.groundMoon', credit: 'ui.universe.walk.creditMoon' },
  mars: { title: 'ui.universe.walk.titleMars', ground: 'ui.universe.walk.groundMars', credit: 'ui.universe.walk.creditMars' },
  mercury: { title: 'ui.universe.walk.titleMercury', ground: 'ui.universe.walk.groundMercury', credit: 'ui.universe.walk.creditMercury' },
  venus: { title: 'ui.universe.walk.titleVenus', ground: 'ui.universe.walk.groundVenus', credit: 'ui.universe.walk.creditVenus' },
};

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
  // On the Earth, the qibla's great-circle direction from where the walker stands, and which way to turn to face it.
  const qibla = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-qibla', hidden: true });
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
    // Held while pressed: the pointer captured so a finger sliding off still lets go here. The press
    // counts first: capture can be refused (a pointer the browser does not count as active), and then
    // leaving the button lets go instead.
    let captured = false;
    b.addEventListener('pointerdown', (e) => {
      press(true);
      try {
        b.setPointerCapture(e.pointerId);
        captured = true;
      } catch {
        captured = false;
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(type, () => {
        captured = false;
        press(false);
      });
    b.addEventListener('pointerleave', () => {
      if (!captured) press(false);
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
  const credit = h('p', { class: 'kf-walk-credit', 'data-testid': 'walk-credit', 'data-photo-credit': '' });
  // The suit's figures fold under the title; on a small screen they start folded, leaving the view and the pad.
  const suit = h('details', { class: 'kf-walk-suit' }, title, place, ground, gravity, air, sun, qibla, credit);
  suit.open = !window.matchMedia(NARROW).matches;
  const element = h('aside', { class: 'kf-walk', 'aria-label': i18n.t('ui.universe.walk.label'), 'data-testid': 'walk-hud', hidden: true }, suit, notice, keys, touch, controls);
  const coords = (lat: number, lon: number): string => f.coordinates(lat, lon, 4);
  /** A temperature in whole degrees, below zero with a true minus sign. */
  const degrees = (c: number): string => {
    const whole = Math.round(c);
    return whole < 0 ? `−${f.number(-whole, 0)}` : f.number(whole === 0 ? 0 : whole, 0);
  };
  /** The air at the feet and the world's mean temperature; on an airless world the vacuum and the ground's temperatures. */
  const airLine = (w: UniverseWalk): string => {
    const mean = w.meanTempC === null ? '' : degrees(w.meanTempC);
    if (w.pressureKpa !== null) {
      const key = w.world === 'mars' ? 'ui.universe.walk.airMars' : w.world === 'venus' ? 'ui.universe.walk.airVenus' : 'ui.universe.walk.air';
      return i18n.t(key, { kpa: f.number(w.pressureKpa, w.pressureKpa < 10 ? 2 : w.pressureKpa < 1000 ? 1 : 0), mean });
    }
    if (w.dayRangeC) return i18n.t(w.world === 'mercury' ? 'ui.universe.walk.vacuumMercury' : 'ui.universe.walk.vacuum', { min: degrees(w.dayRangeC.min), max: degrees(w.dayRangeC.max), mean });
    return '';
  };
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
        qibla.hidden = true;
        if (held.forward || held.backward || held.jump) {
          held.forward = held.backward = held.jump = false;
          send();
        }
        return;
      }
      for (const el of [place, ground, gravity, air, sun, keys, touch, controls, credit]) el.hidden = false;
      const on = WORLD[w.world];
      write(title, i18n.t(w.state === 'landing' ? 'ui.universe.walk.landing' : on.title));
      write(place, coords(w.lat, w.lon));
      write(ground, i18n.t(on.ground, { metres: f.number(Math.abs(w.groundM), 0), side: w.groundM < 0 ? 'below' : 'above', walked: f.number(w.walkedM, 0) }));
      write(gravity, i18n.t('ui.universe.walk.gravity', { g: f.number(w.gravity, 2) }));
      write(air, airLine(w));
      write(credit, i18n.t(on.credit));
      write(sun, i18n.t(w.sunElevationDeg < 0 ? 'ui.universe.walk.sunDown' : w.sunSeen ? 'ui.universe.walk.sunUp' : 'ui.universe.walk.sunClouded', { degrees: f.number(Math.abs(w.sunElevationDeg), 0), time: clock(w.solarTimeH) }));
      notice.hidden = !w.blocked;
      write(notice, w.blocked ? i18n.t('ui.universe.walk.blocked') : '');
      qibla.hidden = w.qiblaDeg === null;
      if (w.qiblaDeg !== null) {
        // How far to turn, and which way, from the heading now (within 2 degrees: ahead).
        const turn = ((((w.qiblaDeg - w.headingDeg) % 360) + 540) % 360) - 180;
        const bearing = f.number(Math.round(w.qiblaDeg) % 360, 0);
        write(qibla, Math.abs(turn) < 2 ? i18n.t('ui.universe.walk.qiblaAhead', { bearing }) : i18n.t(turn > 0 ? 'ui.universe.walk.qiblaRight' : 'ui.universe.walk.qiblaLeft', { bearing, turn: f.number(Math.round(Math.abs(turn)), 0) }));
      }
    },
  };
}
