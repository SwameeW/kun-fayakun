import type { App, BodyId, UniverseView } from '../../core/types';
import { PLANETS_MANIFEST_URL, planetCredits, type PlanetsManifest } from '../../explore/assets/planets';
import { h } from '../dom';
import type { Formatters } from './format';

/**
 * The explorer's heads-up readout and its trip indicator.
 *
 * The readout (where the chapters' scale bar sits) gives true distances, since bodies far away are
 * drawn in scaled space and one metres-per-pixel bar would mislead: the world in view and the height
 * above it, how the camera moves (orbiting it, or in free flight at a stated speed, with a way back
 * to orbiting), and plainly what the view is (true scale; the date and its source; the Sun through a
 * filter when it fills the view; whose imagery the surface is, folded into one short line).
 *
 * During a trip a short indicator shows the distance falling through its orders of magnitude: a
 * scale with a tick for each factor of ten from the height the trip began at (named in plain words
 * at its left) to the destination (named at its right), a marker sliding along it, the light-time,
 * and a way to stop (Esc, said only where there is a keyboard). Its scale is decorative
 * (aria-hidden): its line of text says the same. Nothing here is a live region (it changes every
 * frame). When the indicator goes while it holds keyboard focus (its Stop was pressed), focus moves
 * to the readout's Orbit button or, failing that, to the explorer itself, never to the page.
 */

export interface FlightHud {
  readonly readout: HTMLElement;
  readonly trip: HTMLElement;
  update(view: UniverseView): void;
}

/** Sunlight is a percentage of the Earth's below this share, and "times the Earth's" from it on. */
const TIMES_FROM = 2;
/** Below this speed (km/s, 1 m/s) free flight is "holding still"; below 1 km/s a speed is in m/s (never "0 km/s"). */
const STILL_KM_S = 0.001;

export function createFlightHud(app: App, f: Formatters, surfaceKey: (id: BodyId) => string, fallbackFocus: () => HTMLElement): FlightHud {
  const { i18n } = app;
  const coarse = window.matchMedia('(pointer: coarse)');

  const title = h('p', { class: 'kf-universe-title' });
  const altitude = h('p', { class: 'kf-universe-line kf-universe-altitude' });
  const modeText = h('span', { class: 'kf-universe-mode-text' });
  const orbit = h('button', { type: 'button', class: 'kf-btn kf-universe-orbit', hidden: true, 'data-testid': 'universe-orbit' });
  orbit.addEventListener('click', () => {
    app.steerUniverse('orbit');
  });
  const mode = h('p', { class: 'kf-universe-line kf-universe-mode' }, modeText, orbit);
  // In full on a wide screen; on a phone the short form, so the line never wraps (only one is ever shown).
  const scale = h(
    'p',
    { class: 'kf-universe-line kf-universe-scale kf-universe-part' },
    h('span', { class: 'kf-universe-long' }, i18n.t('ui.universe.trueScale')),
    h('span', { class: 'kf-universe-short' }, i18n.t('ui.universe.trueScaleShort')),
  );
  const sunlight = h('p', { class: 'kf-universe-line kf-universe-extra' });
  const filter = h('p', { class: 'kf-universe-line kf-universe-extra kf-universe-filter', hidden: true }, i18n.t('ui.universe.filter'));
  const date = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-extra' });
  const illustrative = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-illustrative kf-universe-part', hidden: true }, i18n.t('ui.universe.illustrative'));
  // Whose imagery the surface is: one short line that opens to the full credits (the Sources page has them too).
  const imageryText = h('p', { class: 'kf-universe-imagery-text' });
  const imagery = h(
    'details',
    { class: 'kf-universe-line kf-universe-faint kf-universe-imagery', 'data-testid': 'universe-imagery', hidden: true },
    h('summary', {}, i18n.t('ui.universe.imageryTitle')),
    imageryText,
  );
  const readout = h('div', { class: 'kf-universe-readout', 'data-testid': 'universe-readout' }, title, altitude, mode, scale, illustrative, sunlight, filter, date, imagery);

  /** Per body: its maps' credits (and the Earth's caption), once planets.json has loaded. */
  let credits: Partial<Record<BodyId, string>> = {};
  void app.assets.json<PlanetsManifest>(PLANETS_MANIFEST_URL).then(
    (manifest) => {
      const next: Partial<Record<BodyId, string>> = {};
      for (const body of ['earth', 'moon', 'jupiter', 'saturn'] as const) {
        const lines = planetCredits(manifest.files.filter((file) => file.body === body));
        if (lines.length === 0) continue;
        const caption = body === 'earth' ? manifest.bodies?.earth?.caption : undefined;
        next[body] = [caption, i18n.t('ui.universe.imagery', { credits: lines.join('; ') })].filter(Boolean).join(' ');
      }
      credits = next;
    },
    () => undefined,
  );

  const tripTitle = h('p', { class: 'kf-trip-title' });
  const stop = h('button', { type: 'button', class: 'kf-btn kf-trip-stop', 'data-testid': 'universe-stop' });
  const labelStop = (): void => {
    // The key is only worth naming where there is a keyboard.
    stop.textContent = i18n.t(coarse.matches ? 'ui.universe.stopTouch' : 'ui.universe.stop');
    if (coarse.matches) stop.removeAttribute('aria-keyshortcuts');
    else stop.setAttribute('aria-keyshortcuts', 'Escape');
  };
  labelStop();
  coarse.addEventListener('change', labelStop);
  stop.addEventListener('click', () => {
    app.steerUniverse('stop');
  });
  const marker = h('span', { class: 'kf-trip-marker' });
  const fill = h('span', { class: 'kf-trip-fill' });
  const startLabel = h('span', { class: 'kf-trip-end kf-trip-end--start' });
  const endLabel = h('span', { class: 'kf-trip-end kf-trip-end--to' });
  const ruler = h('div', { class: 'kf-trip-ruler', 'aria-hidden': 'true' }, fill, marker);
  const scaleRow = h('div', { class: 'kf-trip-scale', 'aria-hidden': 'true' }, startLabel, ruler, endLabel);
  const tripLine = h('p', { class: 'kf-trip-line' });
  const trip = h('div', { class: 'kf-trip', 'data-testid': 'universe-trip' }, h('div', { class: 'kf-trip-head' }, tripTitle, stop), scaleRow, tripLine);

  const dateFormat = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long', timeZone: 'UTC' });
  const text = new Map<Element, string>();
  const write = (el: Element, value: string): void => {
    if (text.get(el) === value) return;
    text.set(el, value);
    el.textContent = value;
  };

  /** Sunlight as a percentage of the Earth's, or, far above it (near the Sun), as a multiple, three figures. */
  const formatSunlight = (share: number): string => {
    if (share >= TIMES_FROM) {
      const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(share)) - 2);
      const rounded = Math.round(share / magnitude) * magnitude;
      return i18n.t('ui.universe.sunlightTimes', { times: i18n.number(rounded, rounded < 10 ? 1 : 0) });
    }
    const percent = share * 100;
    const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : 2;
    return i18n.t('ui.universe.sunlight', { percent: `${i18n.number(percent, digits)}%` });
  };

  /** Two significant figures (or three from 100 up), for speeds. */
  const figures = (value: number): string => {
    const magnitude = 10 ** Math.max(-3, Math.floor(Math.log10(Math.max(value, 1e-3))) - (value >= 100 ? 2 : 1));
    const rounded = Math.round(value / magnitude) * magnitude;
    return i18n.number(rounded, magnitude < 1 ? Math.min(3, Math.round(-Math.log10(magnitude))) : 0);
  };
  /** Speed in m/s below 1 km/s, km/s up to the speed of light, then as a multiple of it (a camera, not a craft). */
  const formatSpeed = (kmS: number, lightKmS: number): string => {
    if (lightKmS > 0 && kmS >= lightKmS) {
      const times = kmS / lightKmS;
      return i18n.t('ui.universe.speedLight', { times: i18n.number(times, times < 10 ? 1 : 0) });
    }
    if (kmS < 1) return f.keep(i18n.t('ui.universe.speedM', { speed: figures(kmS * 1000) }));
    return f.keep(i18n.t('ui.universe.speed', { speed: figures(kmS) }));
  };

  // The trip's scale (log height above the destination): a tick per factor of ten, rebuilt for each trip.
  let scaleFor = '';
  let hi = 1;
  let lo = 0;
  const buildScale = (startKm: number, endKm: number, to: BodyId): void => {
    const key = `${startKm.toPrecision(3)}:${endKm.toPrecision(3)}:${to}`;
    if (key === scaleFor) return;
    scaleFor = key;
    hi = Math.log10(Math.max(startKm, 10));
    lo = Math.log10(Math.max(1, Math.min(endKm, startKm / 10)));
    for (const old of ruler.querySelectorAll('.kf-trip-tick')) old.remove();
    for (let p = Math.floor(hi); p >= Math.ceil(lo); p--) {
      const tick = h('span', { class: 'kf-trip-tick', 'data-power': String(p) });
      tick.style.setProperty('--at', ((hi - p) / Math.max(1e-6, hi - lo)).toFixed(4));
      ruler.append(tick);
    }
    write(startLabel, f.distanceWords(startKm));
    write(endLabel, f.name(to));
  };

  let tripShown = false;
  return {
    readout,
    trip,
    update(view) {
      const focus = view.bodies.find((b) => b.id === view.focus);
      if (view.travelling && view.from) {
        write(title, i18n.t('ui.universe.flying', { from: f.name(view.from), to: f.name(view.focus) }));
        write(altitude, i18n.t('ui.universe.toGo', { distance: f.distance(view.altitudeKm), body: f.name(view.focus) }));
      } else {
        write(title, f.name(view.focus));
        write(altitude, i18n.t(surfaceKey(view.focus), { distance: f.distance(view.altitudeKm) }));
      }
      const flying = view.mode === 'flight' && !view.travelling;
      const modeLine = view.travelling
        ? i18n.t('ui.universe.modeTravel')
        : flying
          ? view.speedKmS < STILL_KM_S
            ? i18n.t('ui.universe.modeHold')
            : i18n.t('ui.universe.modeFlight', { speed: formatSpeed(view.speedKmS, view.lightKmS) })
          : i18n.t('ui.universe.modeOrbit');
      write(modeText, modeLine);
      orbit.hidden = !flying;
      if (flying) write(orbit, i18n.t('ui.universe.orbitButton', { body: f.name(view.focus) }));
      write(sunlight, formatSunlight(view.sunlight));
      filter.hidden = !view.solarFilter;
      readout.classList.toggle('is-filtered', view.solarFilter);
      write(date, i18n.t('ui.universe.date', { date: dateFormat.format(new Date(view.unixMs)) }));
      // Whose imagery this is (the focus's maps), or, for the procedural Sun, that it is illustrative.
      const line = credits[view.focus];
      if (!line && imagery.open) imagery.open = false;
      imagery.hidden = !line;
      write(imageryText, line ?? '');
      illustrative.hidden = view.focus !== 'sun';

      const t = view.travelling ? view.trip : null;
      trip.classList.toggle('is-active', t !== null);
      if (!t) {
        if (tripShown && trip.contains(document.activeElement)) {
          // Its Stop was pressed (or the trip ended under the keyboard's focus): focus goes somewhere that stays.
          (orbit.hidden ? fallbackFocus() : orbit).focus({ preventScroll: true });
        }
        tripShown = false;
        return;
      }
      tripShown = true;
      buildScale(t.startKm, t.endKm, view.focus);
      const now = Math.log10(Math.max(t.remainingKm, 1));
      const at = Math.min(1, Math.max(0, (hi - now) / Math.max(1e-6, hi - lo)));
      marker.style.setProperty('--at', at.toFixed(4));
      fill.style.setProperty('--at', at.toFixed(4));
      for (const tick of ruler.querySelectorAll<HTMLElement>('.kf-trip-tick')) tick.classList.toggle('is-passed', Number(tick.dataset.power) >= now);
      write(tripTitle, i18n.t('ui.universe.flying', { from: f.name(view.from ?? view.focus), to: f.name(view.focus) }));
      const time = focus && view.lightKmS > 0 ? f.lightTime(focus.lightSeconds) : '';
      write(tripLine, time ? i18n.t('ui.universe.tripLine', { distance: f.distance(t.remainingKm), body: f.name(view.focus), time }) : i18n.t('ui.universe.toGo', { distance: f.distance(t.remainingKm), body: f.name(view.focus) }));
    },
  };
}
