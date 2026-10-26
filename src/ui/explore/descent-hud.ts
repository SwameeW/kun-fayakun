import type { App, I18nKey, UniverseDescent, UniverseView } from '../../core/types';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * The readout while going down through an atmosphere where a probe went (src/explore/descent, ledger
 * GR-6): which probe, when and where; the height (above Venus's 6,052 km radius, or above or below
 * Jupiter's 1-bar level); what the probe measured there (pressure, temperature, density, the clouds
 * as its nephelometer saw them, Jupiter's winds); where the readings are interpolated, and where they
 * end; the keys, Faster, Climb and Hold buttons (held down, as the keys are), and the way back to
 * orbit. Folded under the title on a small screen, as the walk's is.
 */

/** The explorer's narrow layout (../styles/explore.css). */
const NARROW = '(max-width: 899.98px), (max-height: 559.98px)';
/** How long a keyboard press on a pad button acts (ms). */
const PAD_MS = 600;

const WORLD: Record<UniverseDescent['world'], { title: I18nKey; bottom: I18nKey; credit: I18nKey }> = {
  venus: { title: 'ui.universe.descent.titleVenus', bottom: 'ui.universe.descent.bottomVenus', credit: 'ui.universe.descent.creditVenus' },
  jupiter: { title: 'ui.universe.descent.titleJupiter', bottom: 'ui.universe.descent.bottomJupiter', credit: 'ui.universe.descent.creditJupiter' },
};

/** The nephelometer's reading in words (relative to the thickest it saw): clear, thin, cloud, thick. */
const cloudWord = (cloud: number): I18nKey => (cloud < 0.05 ? 'ui.universe.descent.cloud.clear' : cloud < 0.2 ? 'ui.universe.descent.cloud.thin' : cloud < 0.5 ? 'ui.universe.descent.cloud.cloud' : 'ui.universe.descent.cloud.thick');

export interface DescentHud {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
}

export function createDescentHud(app: App, f: Formatters, host: () => HTMLElement): DescentHud {
  const { i18n } = app;
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const title = h('summary', { class: 'kf-walk-title', 'data-testid': 'descent-title' });
  const place = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-place' });
  const probe = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-probe' });
  const height = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-height' });
  const state = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-state' });
  const cloud = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-cloud' });
  const wind = h('p', { class: 'kf-walk-line', 'data-testid': 'descent-wind', hidden: true });
  const notice = h('p', { class: 'kf-walk-notice', 'data-testid': 'descent-notice', hidden: true, role: 'status' });
  const keys = h('p', { class: 'kf-walk-keys' }, i18n.t('ui.universe.descent.keys'));
  const touch = h('p', { class: 'kf-walk-touch' }, i18n.t('ui.universe.descent.touch'));
  const held = { faster: false, climb: false };
  let holding = false;
  const send = (): void => {
    app.earthCommand({ kind: 'descentPad', climb: (held.climb ? 1 : 0) - (held.faster ? 1 : 0) });
  };
  const padButton = (which: keyof typeof held, label: string): HTMLElement => {
    const b = h('button', { type: 'button', class: 'kf-btn kf-walk-pad-btn', 'data-testid': `descent-${which}` }, label);
    const press = (on: boolean): void => {
      if (held[which] === on) return;
      held[which] = on;
      send();
    };
    b.addEventListener('pointerdown', (e) => {
      b.setPointerCapture(e.pointerId);
      press(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      b.addEventListener(type, () => {
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
      }, PAD_MS);
    });
    return b;
  };
  const hold = h('button', { type: 'button', class: 'kf-btn kf-walk-pad-btn', 'aria-pressed': 'false', 'data-testid': 'descent-hold' }, i18n.t('ui.universe.descent.hold'));
  hold.addEventListener('click', () => {
    holding = !holding;
    hold.setAttribute('aria-pressed', String(holding));
    app.earthCommand({ kind: 'descentPad', climb: 0, held: holding });
  });
  const pad = h('div', { class: 'kf-walk-pad', role: 'group', 'aria-label': i18n.t('ui.universe.descent.pad') }, padButton('faster', i18n.t('ui.universe.descent.faster')), padButton('climb', i18n.t('ui.universe.descent.climb')), hold);
  const back = h('button', { type: 'button', class: 'kf-btn kf-walk-back', 'data-testid': 'descent-end' }, i18n.t('ui.universe.descent.back'));
  back.addEventListener('click', () => {
    app.earthCommand({ kind: 'descentEnd' });
  });
  // The depth: from the top of the probe's column to its bottom, evenly in the logarithm of the pressure.
  const depthId = uniqueId('descent-depth');
  const depth = h('input', { id: depthId, type: 'range', min: '0', max: '1000', step: '1', value: '0', class: 'kf-descent-depth', 'data-testid': 'descent-depth' });
  const depthLabel = h('label', { class: 'kf-living-label', for: depthId }, i18n.t('ui.universe.descent.depth'));
  let span: { top: number; bottom: number } | null = null;
  let dragging = false;
  depth.addEventListener('pointerdown', () => {
    dragging = true;
  });
  depth.addEventListener('change', () => {
    dragging = false;
  });
  depth.addEventListener('input', () => {
    if (!span) return;
    const t = Number(depth.value) / 1000;
    app.earthCommand({ kind: 'descentTo', pressureBar: Math.exp(Math.log(span.top) + (Math.log(span.bottom) - Math.log(span.top)) * t) });
  });
  const credit = h('p', { class: 'kf-walk-credit', 'data-testid': 'descent-credit', 'data-photo-credit': '' });
  const readout = h('details', { class: 'kf-walk-suit' }, title, place, height, state, cloud, wind, probe, h('div', { class: 'kf-living-group' }, depthLabel, depth), credit);
  readout.open = !window.matchMedia(NARROW).matches;
  const element = h('aside', { class: 'kf-walk', 'aria-label': i18n.t('ui.universe.descent.label'), 'data-testid': 'descent-hud', hidden: true }, readout, notice, keys, touch, h('div', { class: 'kf-walk-controls' }, pad, back));

  const date = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString(i18n.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const signed = (c: number): string => {
    const whole = Math.round(c);
    return whole < 0 ? `−${f.number(-whole, 0)}` : f.number(whole === 0 ? 0 : whole, 0);
  };
  const figures = (value: number): string => f.number(Number(value.toPrecision(3)), 6);

  return {
    element,
    update(view) {
      const d = view.descent;
      element.hidden = d === null;
      host().classList.toggle('is-descending', d !== null);
      if (!d) {
        if (held.faster || held.climb) {
          held.faster = held.climb = false;
          send();
        }
        holding = false;
        hold.setAttribute('aria-pressed', 'false');
        return;
      }
      const on = WORLD[d.world];
      write(title, i18n.t(on.title));
      write(place, f.coordinates(d.hereLatDeg, d.hereLonDeg, 2));
      write(probe, i18n.t('ui.universe.descent.probe', { probe: d.probe, date: date(d.date), place: f.coordinates(d.latDeg, d.lonDeg, 1) }));
      const km = f.number(Math.abs(d.altitudeKm), Math.abs(d.altitudeKm) < 10 ? 2 : 1);
      write(height, i18n.t(d.reference === 'radius' ? 'ui.universe.descent.heightRadius' : d.altitudeKm >= 0 ? 'ui.universe.descent.heightAbove' : 'ui.universe.descent.heightBelow', { km }));
      write(state, i18n.t('ui.universe.descent.state', { bar: figures(d.pressureBar), celsius: signed(d.temperatureK - 273.15), kelvin: f.number(d.temperatureK, 0), density: figures(d.densityKgM3) }));
      write(cloud, i18n.t('ui.universe.descent.cloud', { state: i18n.t(cloudWord(d.cloud)) }));
      wind.hidden = d.windMs === null;
      write(wind, d.windMs === null ? '' : i18n.t('ui.universe.descent.wind', { speed: f.number(d.windMs, 0) }));
      write(credit, i18n.t(on.credit));
      span = { top: d.topBar, bottom: d.bottomBar };
      if (!dragging) {
        const t = (Math.log(d.pressureBar) - Math.log(d.topBar)) / (Math.log(d.bottomBar) - Math.log(d.topBar));
        const value = String(Math.round(Math.max(0, Math.min(1, t)) * 1000));
        if (depth.value !== value) depth.value = value;
      }
      depth.setAttribute('aria-valuetext', i18n.t('ui.universe.descent.depthValue', { bar: figures(d.pressureBar), km: f.number(d.altitudeKm, 1) }));
      const note = d.atBottom ? i18n.t(on.bottom) : d.between ? i18n.t('ui.universe.descent.between') : '';
      notice.hidden = note === '';
      write(notice, note);
    },
  };
}
