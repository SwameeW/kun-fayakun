import type { App, I18nKey, UniverseView, UniverseWalk, WalkableWorld } from '../../core/types';
import { h } from '../dom';
import { icon } from '../icons';
import type { Formatters } from './format';
import { withHelp } from './help';

/**
 * The suit's readout while walking on the Earth, the Moon, Mars, Mercury or Venus (src/explore/walk),
 * loaded with the first walk (its own chunk, with walking's). It leaves the view to the world:
 *
 * - **The way back** stands where "Back to the start" stands in orbit (top left; that button waits
 *   while the visitor is on foot, so no press leaves the explorer from the ground), with Esc named
 *   beside it. It shows from the moment a walk is asked for, through the landing, until back in orbit.
 * - **The suit's line** (lower left): the title, the ground's height, the Sun's height and the local
 *   solar time on one line; under it, folded, the figures (where the walker stands, the ground's height
 *   above the world's datum, its gravity, the air's pressure at the feet from the cited surface pressure
 *   and scale height and the world's mean temperature, named as a mean, or on an airless world the
 *   vacuum and its ground's range, the Sun's height and the local solar time, the qibla on the Earth),
 *   the keys, and where the ground comes from.
 * - **The controls' card**, for a few seconds after landing (and said to a screen reader once): the
 *   keys, or on a touch screen the pad and the look.
 * - **The pad**: walk forward and back, step left and right (held down, as the keys are; a keyboard's
 *   press on one takes a short step), run (a toggle) and jump.
 * - **Notices**: a walk refused at Makkah, a step refused there, heights that came only coarse, and
 *   heights that could not be loaded at all (with Retry beside the way back).
 */

/** Each world's title, height line and credit. */
const WORLD: Record<WalkableWorld, { title: I18nKey; ground: I18nKey; credit: I18nKey }> = {
  earth: { title: 'ui.universe.walk.title', ground: 'ui.universe.walk.ground', credit: 'ui.universe.walk.credit' },
  moon: { title: 'ui.universe.walk.titleMoon', ground: 'ui.universe.walk.groundMoon', credit: 'ui.universe.walk.creditMoon' },
  mars: { title: 'ui.universe.walk.titleMars', ground: 'ui.universe.walk.groundMars', credit: 'ui.universe.walk.creditMars' },
  mercury: { title: 'ui.universe.walk.titleMercury', ground: 'ui.universe.walk.groundMercury', credit: 'ui.universe.walk.creditMercury' },
  venus: { title: 'ui.universe.walk.titleVenus', ground: 'ui.universe.walk.groundVenus', credit: 'ui.universe.walk.creditVenus' },
};

/** How long a keyboard press on a pad button walks (ms); the controls' card after landing: at least this long, then until the visitor moves, at most this long (ms). */
const PAD_STEP_MS = 600;
const HELP = { minMs: 5000, maxMs: 20_000 } as const;

export interface WalkHud {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
}

/** The pad's held buttons: each one's test id, label, icon turn (degrees) and what it adds while held. */
const PAD = [
  { which: 'left', label: 'ui.universe.walk.left', turn: -90, forward: 0, right: -1 },
  { which: 'forward', label: 'ui.universe.walk.forward', turn: 0, forward: 1, right: 0 },
  { which: 'right', label: 'ui.universe.walk.right', turn: 90, forward: 0, right: 1 },
  { which: 'backward', label: 'ui.universe.walk.backward', turn: 180, forward: -1, right: 0 },
] as const;

export function createWalkHud(app: App, f: Formatters, host: () => HTMLElement, announce: (text: string) => void): WalkHud {
  const { i18n } = app;
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const titleText = h('span', { 'data-testid': 'walk-title' });
  const brief = h('span', { class: 'kf-walk-brief', 'data-testid': 'walk-brief' });
  const title = h('summary', { class: 'kf-walk-title' }, h('span', { class: 'kf-walk-heading' }, titleText, brief));
  const place = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-place' });
  const ground = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-ground' });
  const gravity = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-gravity' });
  const air = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-air' });
  const sun = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-sun' });
  // On the Earth, the qibla's great-circle direction from where the walker stands, and which way to turn to face it.
  const qibla = h('p', { class: 'kf-walk-line', 'data-testid': 'walk-qibla' });
  const notice = h('p', { class: 'kf-walk-notice', 'data-testid': 'walk-notice', hidden: true, role: 'status' });
  // The controls: the keys, or on a touch screen the pad and the look (shown after landing, and with the figures).
  const help = h('div', { class: 'kf-walk-help', 'data-testid': 'walk-help' }, h('p', { class: 'kf-walk-keys' }, i18n.t('ui.universe.walk.keys')), h('p', { class: 'kf-walk-touch' }, i18n.t('ui.universe.walk.touch')));

  const held = { forward: 0, right: 0, run: false, jump: false };
  const pressed = new Set<string>();
  const send = (): void => {
    let forward = 0;
    let right = 0;
    for (const p of PAD) {
      if (!pressed.has(p.which)) continue;
      forward += p.forward;
      right += p.right;
    }
    held.forward = forward;
    held.right = right;
    held.jump = pressed.has('jump');
    app.earthCommand({ kind: 'walkPad', forward: held.forward, right: held.right, run: held.run, jump: held.jump });
  };
  /** A button held while pressed (the pointer captured, so a finger sliding off still lets go here); a keyboard's press takes a short step. */
  const holdButton = (which: string, label: string, content: Node): HTMLElement => {
    const b = h('button', { type: 'button', class: 'kf-btn kf-walk-pad-btn', 'aria-label': label, 'data-testid': `walk-${which}` }, content);
    const press = (on: boolean): void => {
      if (pressed.has(which) === on) return;
      if (on) pressed.add(which);
      else pressed.delete(which);
      send();
    };
    // The press counts first: capture can be refused (a pointer the browser does not count as active),
    // and then leaving the button lets go instead.
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
  const arrow = (turn: number): Node => {
    const svg = icon('chevron');
    svg.style.transform = `rotate(${String(turn)}deg)`;
    return svg;
  };
  const [left, forward, right, backward] = PAD.map((p) => holdButton(p.which, i18n.t(p.label), arrow(p.turn)));
  const jump = holdButton('jump', i18n.t('ui.universe.walk.jump'), h('span', {}, i18n.t('ui.universe.walk.jump')));
  const run = h('button', { type: 'button', class: 'kf-btn kf-walk-pad-btn', 'aria-pressed': 'false', 'data-testid': 'walk-run' }, i18n.t('ui.universe.walk.run'));
  run.addEventListener('click', () => {
    held.run = !held.run;
    run.setAttribute('aria-pressed', String(held.run));
    send();
  });
  // Run and jump above, the arrows below: a thumb's reach on a phone.
  const pad = h('div', { class: 'kf-walk-pad', role: 'group', 'aria-label': i18n.t('ui.universe.walk.pad') }, run, forward, jump, left, backward, right);

  const back = h('button', { type: 'button', class: 'kf-btn kf-walk-back', 'aria-keyshortcuts': 'Escape', 'data-testid': 'walk-end' }, icon('back'), h('span', {}, i18n.t('ui.universe.walk.back')), h('kbd', { class: 'kf-walk-esc', 'aria-hidden': 'true' }, 'Esc'));
  back.addEventListener('click', () => {
    app.earthCommand({ kind: 'walkEnd' });
  });
  // Retry is there only while the ground's heights could not be loaded.
  const retry = h('button', { type: 'button', class: 'kf-btn kf-walk-retry', 'data-testid': 'walk-retry' }, i18n.t('ui.universe.walk.retry'));
  retry.addEventListener('click', () => {
    app.earthCommand({ kind: 'walkRetry' });
  });
  const credit = h('p', { class: 'kf-walk-credit', 'data-testid': 'walk-credit', 'data-photo-credit': '' });
  // The figures a newcomer may not know, each with its "?" (a row hides with its line).
  const groundRow = withHelp(app, ground, 'walkGround', i18n.t('ui.help.label.walkGround'));
  const gravityRow = withHelp(app, gravity, 'walkGravity', i18n.t('ui.help.label.walkGravity'));
  const airRow = withHelp(app, air, 'walkAir', i18n.t('ui.help.label.walkAir'));
  const sunRow = withHelp(app, sun, 'walkSun', i18n.t('ui.help.label.walkSun'));
  const qiblaRow = withHelp(app, qibla, 'walkQibla', i18n.t('ui.help.label.walkQibla'));
  qiblaRow.hidden = true;
  // Folded to its one line on every screen: the view is the world's.
  const suit = h('details', { class: 'kf-walk-suit' }, title, place, groundRow, gravityRow, airRow, sunRow, qiblaRow, credit);
  const figures = [place, groundRow, gravityRow, airRow, sunRow];
  const dock = h('div', { class: 'kf-walk-dock' }, notice, help, suit, pad);
  const top = h('div', { class: 'kf-walk-top' }, back);
  const element = h('aside', { class: 'kf-walk', 'aria-label': i18n.t('ui.universe.walk.label'), 'data-testid': 'walk-hud', hidden: true }, top, dock);

  const coords = (lat: number, lon: number): string => f.coordinates(lat, lon, 4);
  /** A whole number (degrees, metres), below zero with a true minus sign. */
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
  /** When the controls' card came up (performance.now() ms; 0: not shown), and where the walker stood and faced then. */
  let helpSince = 0;
  let helpFrom = { walked: 0, heading: 0 };
  let landed = false;
  let unavailable = false;

  return {
    element,
    update(view) {
      const w = view.walk;
      element.hidden = w === null && !view.walkRefused;
      const root = host();
      root.classList.toggle('is-walking', w !== null && w.state === 'walking');
      // On foot (landing included): the way back to orbit stands in for the way back to the start.
      root.classList.toggle('is-on-foot', w !== null);
      if (!w) {
        write(titleText, view.walkRefused ? i18n.t('ui.universe.walk.refusedTitle') : '');
        write(brief, '');
        notice.hidden = !view.walkRefused;
        write(notice, view.walkRefused ? i18n.t('ui.universe.walk.refused') : '');
        for (const el of [back, pad, ...figures, credit]) el.hidden = true;
        retry.remove();
        qiblaRow.hidden = true;
        if (pressed.size > 0 || held.run) {
          pressed.clear();
          held.run = false;
          run.setAttribute('aria-pressed', 'false');
          send();
        }
        landed = false;
        unavailable = false;
        helpSince = 0;
        help.classList.remove('is-shown');
        return;
      }
      back.hidden = false;
      const walking = w.state === 'walking';
      for (const el of [pad, ...figures, credit]) el.hidden = !walking;
      const on = WORLD[w.world];
      write(titleText, i18n.t(w.state === 'landing' ? 'ui.universe.walk.landing' : w.state === 'unavailable' ? 'ui.universe.walk.unavailableTitle' : on.title));
      write(brief, walking ? i18n.t('ui.universe.walk.brief', { metres: degrees(w.groundM), sun: degrees(w.sunElevationDeg), time: clock(w.solarTimeH) }) : '');
      write(place, coords(w.lat, w.lon));
      write(ground, i18n.t(on.ground, { metres: f.number(Math.abs(w.groundM), 0), side: w.groundM < 0 ? 'below' : 'above', walked: f.number(w.walkedM, 0) }));
      write(gravity, i18n.t('ui.universe.walk.gravity', { g: f.number(w.gravity, 2) }));
      write(air, airLine(w));
      write(credit, i18n.t(on.credit));
      write(sun, i18n.t(w.sunElevationDeg < 0 ? 'ui.universe.walk.sunDown' : w.sunSeen ? 'ui.universe.walk.sunUp' : 'ui.universe.walk.sunClouded', { degrees: f.number(Math.abs(w.sunElevationDeg), 0), time: clock(w.solarTimeH) }));
      // The one notice that matters most: a step refused, heights that never came, or heights only coarse.
      const say = w.blocked ? 'ui.universe.walk.blocked' : w.state === 'unavailable' ? 'ui.universe.walk.unavailable' : w.coarse ? 'ui.universe.walk.coarse' : null;
      notice.hidden = say === null;
      write(notice, say ? i18n.t(say) : '');
      if (w.state !== 'unavailable') retry.remove();
      else if (!retry.isConnected) top.append(retry);
      if (w.state === 'unavailable' && !unavailable) back.focus({ preventScroll: true });
      unavailable = w.state === 'unavailable';
      qiblaRow.hidden = !walking || w.qiblaDeg === null;
      if (w.qiblaDeg !== null) {
        // How far to turn, and which way, from the heading now (within 2 degrees: ahead).
        const turn = ((((w.qiblaDeg - w.headingDeg) % 360) + 540) % 360) - 180;
        const bearing = f.number(Math.round(w.qiblaDeg) % 360, 0);
        write(qibla, Math.abs(turn) < 2 ? i18n.t('ui.universe.walk.qiblaAhead', { bearing }) : i18n.t(turn > 0 ? 'ui.universe.walk.qiblaRight' : 'ui.universe.walk.qiblaLeft', { bearing, turn: f.number(Math.round(Math.abs(turn)), 0) }));
      }
      // Landed: the controls' card, until the visitor has moved (after a few seconds at least), and said once.
      const now = performance.now();
      if (walking && !landed) {
        helpSince = now;
        helpFrom = { walked: w.walkedM, heading: w.headingDeg };
        announce(i18n.t('ui.universe.walk.landed', { title: i18n.t(on.title) }));
      }
      landed = walking;
      if (helpSince > 0) {
        const moved = w.walkedM - helpFrom.walked > 1 || Math.abs(w.headingDeg - helpFrom.heading) > 10;
        if (now - helpSince > HELP.maxMs || (moved && now - helpSince > HELP.minMs)) helpSince = 0;
      }
      help.classList.toggle('is-shown', helpSince > 0);
    },
  };
}
