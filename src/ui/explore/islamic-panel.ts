import type { App, CrescentCriterion, CrescentZoneName, PrayerConventionId, UniverseIslamic, UniversePrayer, UniverseView } from '../../core/types';
import { loadPlaces, searchPlaces, type Place } from '../../explore/field-notes/places';
import { HERITAGE } from '../../explore/islamic/heritage';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * The qibla and the new moon (its own chunk, loaded when the navigator's section first opens): the
 * qibla from the point beneath the camera or a place found by name, and its path on the globe; the
 * next times the Sun stands over the Kaaba or the point opposite it, each a moment to go to; the
 * times of prayer the Sun marks there, by each published convention; the golden latitude beside the Kaaba's, with its actual size; and the new moon with the new crescent's
 * map for the evenings after it (Yallop's zones or Odeh's), the place in view read out in words. Everything it
 * shows comes from src/explore/islamic; it decides nothing for anyone: the notes say the qibla is
 * a great-circle direction and that communities begin each month by their own practice.
 */

export interface IslamicPanel {
  readonly element: HTMLElement;
  update(view: UniverseView, slow: boolean): void;
}

const ZONES: readonly CrescentZoneName[] = ['A', 'B', 'C', 'D', 'E', 'F'];
/** Odeh's zones, and their swatches: the colours of Yallop's zones nearest in meaning (as the map draws them). */
const ODEH_ZONES: readonly CrescentZoneName[] = ['A', 'B', 'C', 'D'];
const ODEH_SWATCH: Partial<Record<CrescentZoneName, string>> = { A: 'a', B: 'b', C: 'd', D: 'e' };
const CRITERIA: readonly CrescentCriterion[] = ['yallop', 'odeh'];
/** The conventions for the times of prayer, in PrayTimes.org's order. */
const CONVENTIONS: readonly PrayerConventionId[] = ['mwl', 'isna', 'egypt', 'makkah', 'karachi', 'tehran', 'qum', 'france', 'russia', 'singapore'];
/** Why a place has no zone, as message keys. */
const NONE_KEYS = { 'moon-sets-first': 'moonSetsFirst', 'before-new-moon': 'beforeNewMoon', 'no-sunset': 'noSunset', 'high-latitude': 'highLatitude' } as const;
/** How wide the view is when going to a moment of the Sun over the Kaaba (km of ground): the whole lit face of the Earth. */
const WHOLE_EARTH_KM = 16_000;
/** Ground framed to see the golden latitude part from the Kaaba's (km): the two are under 10 km apart. */
const GOLDEN_VIEW_KM = 60;

export function createIslamicPanel(app: App, f: Formatters, onGo: () => void): IslamicPanel {
  const { i18n } = app;
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const utc = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
  const utcDay = new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const utcTime = new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short', timeZone: 'UTC' });
  const utcDate = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long', timeZone: 'UTC' });
  /** A number shown with exactly `digits` decimals (a bearing of 119.0, a ratio of 1.6210: the precision is part of the figure). */
  const fixedFormats = new Map<number, Intl.NumberFormat>();
  const fixed = (value: number, digits: number): string => {
    let format = fixedFormats.get(digits);
    if (!format) {
      format = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
      fixedFormats.set(digits, format);
    }
    return format.format(value);
  };
  const when = (ms: number): string => i18n.t('ui.universe.islamic.utc', { time: utc.format(new Date(ms)) });
  const coords = (lat: number, lon: number): string => f.coordinates(lat, lon);
  const toggleButton = (text: string, testId: string, onChange: (on: boolean) => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'kf-living-choice', 'aria-pressed': 'false', 'data-testid': testId }, text);
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      onChange(on);
    });
    return b;
  };
  const send = app.universeIslamic.bind(app);

  // The qibla.
  const qiblaFrom = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-qibla-from' });
  const qiblaText = h('p', { class: 'kf-islamic-figure', 'data-testid': 'islamic-qibla' });
  const fromBelow = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'islamic-from-below', hidden: true }, i18n.t('ui.universe.islamic.fromBelow'));
  fromBelow.addEventListener('click', () => {
    send({ kind: 'qiblaFromBelow' });
  });
  const line = toggleButton(i18n.t('ui.universe.islamic.showPath'), 'islamic-qibla-line', (on) => {
    send({ kind: 'qiblaLine', on });
  });
  let places: readonly Place[] = [];
  void loadPlaces(app.assets).then((list) => {
    places = list;
  });
  const findId = uniqueId('islamic-find');
  const findInput = h('input', { id: findId, type: 'search', class: 'kf-living-input', placeholder: i18n.t('ui.universe.living.findHint'), autocomplete: 'off', spellcheck: 'false', 'data-testid': 'islamic-find' });
  const findResults = h('ul', { class: 'kf-living-list', 'data-testid': 'islamic-find-results' });
  findInput.addEventListener('input', () => {
    findResults.replaceChildren(
      ...searchPlaces(places, findInput.value, 5).map((p) => {
        const b = h('button', { type: 'button', class: 'kf-living-place' }, h('span', { class: 'kf-living-place-name' }, p.name), ' ', h('span', { class: 'kf-living-place-where' }, coords(p.lat, p.lon)));
        b.addEventListener('click', () => {
          send({ kind: 'qiblaFrom', lat: p.lat, lon: p.lon, name: p.name });
          findInput.value = '';
          findResults.replaceChildren();
        });
        return h('li', {}, b);
      }),
    );
  });
  const find = h('form', { class: 'kf-living-group', role: 'search' }, h('label', { class: 'kf-living-label', for: findId }, i18n.t('ui.universe.islamic.find')), findInput, findResults);
  find.addEventListener('submit', (event) => {
    event.preventDefault();
    findResults.querySelector('button')?.click();
  });

  // The Sun over the Kaaba.
  const sunList = h('ul', { class: 'kf-living-list', 'data-testid': 'islamic-kaaba-sun' });
  let sunKey = '';

  // The Sun and the times of prayer: a convention, Asr's shadow, and the times for the place.
  const conventionId = uniqueId('islamic-convention');
  const conventionSelect = h('select', { id: conventionId, class: 'kf-living-input', 'data-testid': 'islamic-convention' }, ...CONVENTIONS.map((id) => h('option', { value: id }, i18n.t(`ui.universe.islamic.prayer.convention.${id}`))));
  let asrChoice: 1 | 2 = 1;
  const sendPrayer = (): void => {
    const convention = CONVENTIONS.find((id) => id === conventionSelect.value) ?? 'mwl';
    send({ kind: 'prayer', convention, asrFactor: asrChoice });
  };
  conventionSelect.addEventListener('change', sendPrayer);
  const asrButtons = ([1, 2] as const).map((factor) => {
    const b = h('button', { type: 'button', class: 'kf-living-choice', 'aria-pressed': String(factor === 1), 'data-testid': `islamic-asr-${factor}` }, i18n.t(`ui.universe.islamic.prayer.asr${factor}`));
    b.addEventListener('click', () => {
      asrChoice = factor;
      sendPrayer();
    });
    return b;
  });
  const prayerFor = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-prayer-for' });
  const prayerList = h('dl', { class: 'kf-about-facts', 'data-testid': 'islamic-prayer' });
  let prayerKey = '';
  const degrees = (deg: number): string => fixed(deg, Number.isInteger(deg) ? 0 : 1);
  const prayerRows = (p: UniversePrayer): HTMLElement[] => {
    const t = p.times;
    const time = (ms: number | null, none: string): string => (ms === null ? i18n.t(none) : i18n.t('ui.universe.islamic.prayer.time', { time: utcTime.format(new Date(ms)) }));
    const below = 'ui.universe.islamic.prayer.none';
    const noSun = 'ui.universe.islamic.prayer.noSun';
    const rows: Array<[string, string, string]> = [
      ['fajr', i18n.t('ui.universe.islamic.prayer.fajr', { deg: degrees(p.fajrDeg) }), time(t.fajr, below)],
      ['sunrise', i18n.t('ui.universe.islamic.prayer.sunrise'), time(t.sunrise, noSun)],
      ['dhuhr', i18n.t('ui.universe.islamic.prayer.dhuhr', { alt: fixed(p.noonAltitudeDeg, 1) }), time(t.dhuhr, noSun)],
      ['asr', p.asrAltitudeDeg === null ? i18n.t('ui.universe.islamic.prayer.asrPlain') : i18n.t('ui.universe.islamic.prayer.asr', { alt: fixed(p.asrAltitudeDeg, 1) }), time(t.asr, 'ui.universe.islamic.prayer.noTime')],
      ['maghrib', p.maghribDeg === null ? i18n.t('ui.universe.islamic.prayer.maghribSunset') : i18n.t('ui.universe.islamic.prayer.maghribDeg', { deg: degrees(p.maghribDeg) }), time(t.maghrib, p.maghribDeg === null ? noSun : below)],
      [
        'isha',
        p.ishaDeg !== null
          ? i18n.t('ui.universe.islamic.prayer.ishaDeg', { deg: degrees(p.ishaDeg) })
          : i18n.t(p.ramadan && p.convention === 'makkah' ? 'ui.universe.islamic.prayer.ishaRamadan' : 'ui.universe.islamic.prayer.ishaMinutes', { minutes: p.ishaMinutes ?? 0 }),
        time(t.isha, p.ishaDeg === null ? noSun : below),
      ],
    ];
    return rows.flatMap(([id, term, detail]) => [h('dt', {}, term), h('dd', { 'data-testid': `islamic-prayer-${id}` }, detail)]);
  };

  // The golden latitude.
  const goldenText = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-golden' });
  const goldenLine = toggleButton(i18n.t('ui.universe.islamic.showLatitudes'), 'islamic-golden-line', (on) => {
    send({ kind: 'golden', on });
  });
  const goldenGo = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'islamic-golden-go' }, i18n.t('ui.universe.islamic.goldenGo'));
  let golden: UniverseIslamic['golden'] | null = null;
  goldenGo.addEventListener('click', () => {
    if (!golden) return;
    // Between the two lines, wide enough to see both (the explorer never frames Makkah closer than its own minimum).
    app.earthCommand({ kind: 'goto', lat: (golden.latDeg + golden.kaabaLatDeg) / 2, lon: golden.kaabaLonDeg, viewKm: GOLDEN_VIEW_KM });
    if (goldenLine.getAttribute('aria-pressed') !== 'true') goldenLine.click();
    onGo();
  });

  // The new moon and the crescent's map.
  const moonText = h('p', { class: 'kf-islamic-figure', 'data-testid': 'islamic-new-moon' });
  const ageText = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-moon-age' });
  const previous = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'islamic-moon-previous' }, i18n.t('ui.universe.islamic.previous'));
  const next = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'islamic-moon-next' }, i18n.t('ui.universe.islamic.next'));
  previous.addEventListener('click', () => {
    send({ kind: 'newMoon', step: -1 });
  });
  next.addEventListener('click', () => {
    send({ kind: 'newMoon', step: 1 });
  });
  const evenings = ([0, 1, 2] as const).map((evening) => {
    const b = h('button', { type: 'button', class: 'kf-living-choice', 'aria-pressed': 'false', 'data-testid': `islamic-evening-${evening}` });
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      send({ kind: 'evening', evening: on ? evening : null });
    });
    return b;
  });
  // The test the map is drawn by: Yallop's or Odeh's (the layer works out both; a choice recolours it).
  const criteria = CRITERIA.map((criterion) => {
    const b = h('button', { type: 'button', class: 'kf-living-choice', 'aria-pressed': String(criterion === 'yallop'), 'data-testid': `islamic-criterion-${criterion}` }, i18n.t(`ui.universe.islamic.criterion.${criterion}`));
    b.addEventListener('click', () => {
      send({ kind: 'criterion', criterion });
    });
    return b;
  });
  const zonesOf = (criterion: CrescentCriterion): readonly CrescentZoneName[] => (criterion === 'odeh' ? ODEH_ZONES : ZONES);
  const zoneText = (criterion: CrescentCriterion, zone: string): string => i18n.t(criterion === 'odeh' ? `ui.universe.islamic.odeh.${zone}` : `ui.universe.islamic.zone.${zone}`);
  const legendRows = new Map<CrescentZoneName, HTMLElement>();
  const legend = h('ul', { class: 'kf-islamic-legend', 'data-testid': 'islamic-legend', hidden: true });
  let legendFor: CrescentCriterion | null = null;
  const buildLegend = (criterion: CrescentCriterion): void => {
    legendFor = criterion;
    legendRows.clear();
    legend.replaceChildren(
      ...zonesOf(criterion).map((zone) => {
        const count = h('span', { class: 'kf-islamic-count' });
        legendRows.set(zone, count);
        const swatch = criterion === 'odeh' ? (ODEH_SWATCH[zone] ?? 'f') : zone.toLowerCase();
        return h('li', {}, h('span', { class: `kf-islamic-swatch is-${swatch}`, 'aria-hidden': 'true' }), h('span', {}, zoneText(criterion, zone)), count);
      }),
    );
  };
  buildLegend('yallop');
  const mapNote = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-map-note' }, i18n.t('ui.universe.islamic.mapNote'));
  const mapState = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-map-state', 'aria-live': 'polite' });
  const here = h('p', { class: 'kf-living-hint', 'data-testid': 'islamic-here' });

  // Astronomers and geometers: each place a note and a way to fly there.
  const heritage = h(
    'ul',
    { class: 'kf-living-list', 'data-testid': 'islamic-heritage' },
    ...HERITAGE.map((p) => {
      const name = i18n.t(`ui.universe.islamic.heritage.${p.id}.name`);
      const go = h('button', { type: 'button', class: 'kf-living-go', 'aria-label': i18n.t('ui.universe.islamic.heritage.go', { place: name }), 'data-testid': `islamic-heritage-${p.id}` }, i18n.t('ui.universe.living.go'));
      go.addEventListener('click', () => {
        app.earthCommand({ kind: 'goto', lat: p.lat, lon: p.lon, viewKm: p.viewKm });
        onGo();
      });
      return h('li', { class: 'kf-living-line' }, h('span', { class: 'kf-living-line-text' }, h('strong', {}, name), ' ', i18n.t(`ui.universe.islamic.heritage.${p.id}.note`)), go);
    }),
  );

  const element = h(
    'div',
    { class: 'kf-islamic', 'data-testid': 'islamic-panel' },
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.intro')),
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.qibla')),
    qiblaFrom,
    qiblaText,
    h('div', { class: 'kf-lab-row' }, line, fromBelow),
    find,
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.qiblaNote')),
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.sunTitle')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.sunIntro')),
    sunList,
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.prayerTitle')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.prayerIntro')),
    h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: conventionId }, i18n.t('ui.universe.islamic.prayer.convention')), conventionSelect),
    h('div', { class: 'kf-lab-row', role: 'group', 'aria-label': i18n.t('ui.universe.islamic.prayer.asrGroup') }, ...asrButtons),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.prayer.asrNote')),
    prayerFor,
    prayerList,
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.prayer.note')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.prayer.credit')),
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.goldenTitle')),
    goldenText,
    h('div', { class: 'kf-lab-row' }, goldenLine, goldenGo),
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.moonTitle')),
    moonText,
    ageText,
    h('div', { class: 'kf-lab-row' }, previous, next),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.mapIntro')),
    h('div', { class: 'kf-lab-row', role: 'group', 'aria-label': i18n.t('ui.universe.islamic.evenings') }, ...evenings),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.islamic.criterionIntro')),
    h('div', { class: 'kf-lab-row', role: 'group', 'aria-label': i18n.t('ui.universe.islamic.criterion') }, ...criteria),
    mapState,
    legend,
    here,
    mapNote,
    h('h3', { class: 'kf-living-label' }, i18n.t('ui.universe.islamic.heritage.title')),
    heritage,
  );

  send({ kind: 'open' });

  const placeName = (s: NonNullable<UniverseIslamic['qibla']>): string => s.from.name ?? i18n.t('ui.universe.islamic.belowYou');
  const hours = (h: number): string => {
    const days = Math.floor(h / 24);
    const rest = Math.round(h - days * 24);
    return days > 0 ? i18n.t('ui.universe.islamic.ageDays', { days, hours: rest }) : i18n.t('ui.universe.islamic.ageHours', { hours: Math.max(0, Math.round(h)) });
  };

  return {
    element,
    update(view, slow) {
      const s = view.islamic;
      if (!s || !slow) return;
      // The qibla.
      if (s.qibla) {
        write(qiblaFrom, i18n.t(s.qibla.from.name === null ? 'ui.universe.islamic.fromBelowText' : 'ui.universe.islamic.fromPlace', { place: placeName(s.qibla), where: coords(s.qibla.from.lat, s.qibla.from.lon) }));
        write(qiblaText, i18n.t('ui.universe.islamic.bearing', { degrees: fixed(s.qibla.bearingDeg, 1), compass: i18n.t(`ui.universe.islamic.compass.${s.qibla.compass}`), distance: f.distance(s.qibla.distanceKm) }));
      } else {
        write(qiblaFrom, i18n.t('ui.universe.islamic.noPlace'));
        write(qiblaText, '');
      }
      fromBelow.hidden = s.qibla?.from.name === null || s.qibla === null;
      line.setAttribute('aria-pressed', String(s.qibla?.line ?? false));
      // The Sun over the Kaaba: each moment a button to go to it (the date set, the clock paused, the lit face in view).
      const key = s.kaabaSun.map((e) => `${e.kind}${Math.round(e.unixMs / 60_000)}`).join('|');
      if (key !== sunKey) {
        sunKey = key;
        sunList.replaceChildren(
          ...s.kaabaSun.map((e) => {
            const text = i18n.t(e.kind === 'over' ? 'ui.universe.islamic.sunOver' : 'ui.universe.islamic.sunOpposite', { time: when(e.unixMs) });
            const go = h('button', { type: 'button', class: 'kf-living-go', 'aria-label': i18n.t('ui.universe.islamic.goMoment', { moment: text }), 'data-testid': `islamic-sun-go-${e.kind}` }, i18n.t('ui.universe.living.go'));
            go.addEventListener('click', () => {
              app.universeTime({ kind: 'date', jdUtc: e.unixMs / 86_400_000 + 2440587.5 });
              app.universeTime({ kind: 'rate', rate: 0 });
              // Over the Kaaba, the Earth's lit face is centred on it; over its opposite point, on that point.
              app.earthCommand({ kind: 'goto', lat: e.lat, lon: e.lon, viewKm: WHOLE_EARTH_KM });
              onGo();
            });
            return h('li', { class: 'kf-living-line' }, h('span', { class: 'kf-living-line-text' }, text), go);
          }),
        );
      }
      // The times of prayer.
      const pr = s.prayer;
      if (pr && s.qibla) {
        if (conventionSelect.value !== pr.convention) conventionSelect.value = pr.convention;
        asrChoice = pr.asrFactor;
        asrButtons.forEach((b, k) => {
          b.setAttribute('aria-pressed', String(k + 1 === pr.asrFactor));
        });
        write(prayerFor, i18n.t('ui.universe.islamic.prayer.for', { place: placeName(s.qibla), date: utcDate.format(new Date(pr.times.dhuhr)) }));
        const k = JSON.stringify(pr);
        if (k !== prayerKey) {
          prayerKey = k;
          prayerList.replaceChildren(...prayerRows(pr));
        }
      } else {
        write(prayerFor, i18n.t('ui.universe.islamic.noPlace'));
        prayerKey = '';
        prayerList.replaceChildren();
      }
      // The golden latitude.
      const g = s.golden;
      golden = g;
      write(
        goldenText,
        i18n.t('ui.universe.islamic.golden', {
          ratio: fixed(g.kaabaRatio, 4),
          golden: fixed(g.ratio, 4),
          latitude: fixed(g.latDeg, 3),
          kaaba: fixed(g.kaabaLatDeg, 4),
          km: fixed(g.kaabaNorthKm, 1),
        }),
      );
      goldenLine.setAttribute('aria-pressed', String(g.on));
      // The new moon and the evenings after it.
      const m = s.newMoon;
      write(moonText, m ? i18n.t('ui.universe.islamic.newMoon', { time: when(m.unixMs) }) : '');
      write(ageText, m?.ageHours === null || m?.ageHours === undefined ? '' : i18n.t('ui.universe.islamic.age', { age: hours(m.ageHours) }));
      previous.disabled = m?.previousMs === null || !m;
      next.disabled = m?.nextMs === null || !m;
      evenings.forEach((b, k) => {
        if (m) write(b, utcDay.format(new Date(Math.floor(m.unixMs / 86_400_000) * 86_400_000 + k * 86_400_000)));
        b.setAttribute('aria-pressed', String(s.crescent?.evening === k));
      });
      const criterion = s.criterion;
      criteria.forEach((b, k) => {
        b.setAttribute('aria-pressed', String(CRITERIA[k] === criterion));
      });
      if (criterion !== legendFor) buildLegend(criterion);
      write(mapNote, i18n.t(criterion === 'odeh' ? 'ui.universe.islamic.mapNoteOdeh' : 'ui.universe.islamic.mapNote'));
      const c = s.crescent;
      legend.hidden = !c || c.progress < 1;
      if (!c) write(mapState, '');
      else if (c.progress < 1) write(mapState, i18n.t('ui.universe.islamic.mapComputing', { percent: Math.round(c.progress * 100) }));
      else write(mapState, i18n.t('ui.universe.islamic.mapReady', { date: utcDay.format(new Date(c.dateMs)) }));
      if (c) for (const zone of zonesOf(criterion)) write(legendRows.get(zone) ?? h('span'), f.number(c.counts[zone], 0));
      const hereNow = c?.here;
      if (!c || !hereNow || !s.qibla) write(here, '');
      else {
        const place = placeName(s.qibla);
        const best = hereNow.bestMs === null ? null : utcTime.format(new Date(hereNow.bestMs));
        if (criterion === 'odeh' && hereNow.v !== null && best !== null && hereNow.zone.length === 1)
          write(here, i18n.t('ui.universe.islamic.hereOdeh', { place, zone: zoneText('odeh', hereNow.zone), v: fixed(hereNow.v, 2), best }));
        else if (criterion === 'yallop' && hereNow.q !== null && best !== null && hereNow.zone.length === 1)
          write(here, i18n.t('ui.universe.islamic.here', { place, zone: zoneText('yallop', hereNow.zone), q: fixed(hereNow.q, 2), best }));
        else write(here, i18n.t(`ui.universe.islamic.none.${NONE_KEYS[hereNow.zone as keyof typeof NONE_KEYS]}`, { place }));
      }
    },
  };
}
