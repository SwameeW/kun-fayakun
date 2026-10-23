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
 * to orbiting), and plainly what the view is (true scale; surfaces illustrative; the date and its
 * source; the Sun through a filter when it fills the view).
 *
 * During a trip a short indicator shows the distance falling through its orders of magnitude: a
 * scale of powers of ten from the height the trip began at to the one it ends at, a marker sliding
 * along it, the light-time, and a way to stop (Esc). Its scale is decorative (aria-hidden): its line
 * of text says the same. Nothing here is a live region (it changes every frame).
 */

export interface FlightHud {
  readonly readout: HTMLElement;
  readonly trip: HTMLElement;
  update(view: UniverseView): void;
}

/** Sunlight is a percentage of the Earth's below this share, and "times the Earth's" from it on. */
const TIMES_FROM = 2;
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const power = (n: number): string =>
  `10${String(n)
    .split('')
    .map((d) => SUPERSCRIPT[Number(d)] ?? d)
    .join('')}`;

export function createFlightHud(app: App, f: Formatters, surfaceKey: (id: BodyId) => string): FlightHud {
  const { i18n } = app;

  const title = h('p', { class: 'kf-universe-title' });
  const altitude = h('p', { class: 'kf-universe-line kf-universe-altitude' });
  const modeText = h('span', { class: 'kf-universe-mode-text' });
  const orbit = h('button', { type: 'button', class: 'kf-btn kf-universe-orbit', hidden: true, 'data-testid': 'universe-orbit' });
  orbit.addEventListener('click', () => {
    app.steerUniverse('orbit');
  });
  const mode = h('p', { class: 'kf-universe-line kf-universe-mode' }, modeText, orbit);
  const scale = h('p', { class: 'kf-universe-line kf-universe-scale' }, i18n.t('ui.universe.trueScale'));
  const sunlight = h('p', { class: 'kf-universe-line kf-universe-extra' });
  const filter = h('p', { class: 'kf-universe-line kf-universe-extra kf-universe-filter', hidden: true }, i18n.t('ui.universe.filter'));
  const date = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-extra' });
  const illustrative = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-illustrative', hidden: true }, i18n.t('ui.universe.illustrative'));
  const imagery = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-imagery', 'data-testid': 'universe-imagery', hidden: true });
  const readout = h('div', { class: 'kf-universe-readout', 'data-testid': 'universe-readout' }, title, altitude, mode, scale, sunlight, filter, date, illustrative, imagery);

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
  const stop = h('button', { type: 'button', class: 'kf-btn kf-trip-stop', 'data-testid': 'universe-stop' }, i18n.t('ui.universe.stop'));
  stop.addEventListener('click', () => {
    app.steerUniverse('stop');
  });
  const marker = h('span', { class: 'kf-trip-marker' });
  const fill = h('span', { class: 'kf-trip-fill' });
  const unit = h('span', { class: 'kf-trip-unit' }, i18n.t('ui.universe.tripUnit'));
  const ruler = h('div', { class: 'kf-trip-ruler', 'aria-hidden': 'true' }, fill, marker, unit);
  const tripLine = h('p', { class: 'kf-trip-line' });
  const trip = h('div', { class: 'kf-trip', 'data-testid': 'universe-trip' }, h('div', { class: 'kf-trip-head' }, tripTitle, stop), ruler, tripLine);

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

  /** Speed in km/s (three figures), or as a multiple of the speed of light once past it (a camera, not a craft). */
  const formatSpeed = (kmS: number, lightKmS: number): string => {
    if (lightKmS > 0 && kmS >= lightKmS) {
      const times = kmS / lightKmS;
      return i18n.t('ui.universe.speedLight', { times: i18n.number(times, times < 10 ? 1 : 0) });
    }
    const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(kmS, 1))) - 2);
    return i18n.t('ui.universe.speed', { speed: i18n.number(Math.round(kmS / magnitude) * magnitude, kmS < 10 ? 1 : 0) });
  };

  // The trip's scale of powers of ten (log height above the destination), rebuilt for each trip.
  let scaleFor = '';
  let hi = 1;
  let lo = 0;
  const buildScale = (startKm: number, endKm: number): void => {
    const key = `${startKm.toPrecision(3)}:${endKm.toPrecision(3)}`;
    if (key === scaleFor) return;
    scaleFor = key;
    hi = Math.log10(Math.max(startKm, 10));
    lo = Math.log10(Math.max(1, Math.min(endKm, startKm / 10)));
    for (const old of ruler.querySelectorAll('.kf-trip-tick')) old.remove();
    for (let p = Math.floor(hi); p >= Math.ceil(lo); p--) {
      const tick = h('span', { class: 'kf-trip-tick', 'data-power': String(p) }, h('span', { class: 'kf-trip-tick-label' }, power(p)));
      tick.style.setProperty('--at', ((hi - p) / Math.max(1e-6, hi - lo)).toFixed(4));
      ruler.insertBefore(tick, unit);
    }
  };

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
          ? i18n.t('ui.universe.modeFlight', { speed: formatSpeed(view.speedKmS, view.lightKmS) })
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
      imagery.hidden = !line;
      write(imagery, line ?? '');
      illustrative.hidden = view.focus !== 'sun';

      const t = view.travelling ? view.trip : null;
      trip.classList.toggle('is-active', t !== null);
      if (!t) return;
      buildScale(t.startKm, t.endKm);
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
