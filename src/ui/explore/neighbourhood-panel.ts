import type { App, NeighbourPlanet, UniverseNeighbourhood, UniverseView } from '../../core/types';
import starsMessages from '../../i18n/en.stars.json';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * Among the stars (ledger IS-3, IS-4, IS-7; its own chunk, loaded with the first visit): the star in
 * view (its distance from the Sun with the parallax's uncertainty, its type, temperature and
 * magnitudes) and its known planets (each value the NASA Exoplanet Archive calculated rather than
 * measured marked so, and masses that are only lower limits said to be), a search by name or
 * catalogue number, the stars nearest the one in view, and the ways back: to the Sun, and to the
 * solar system. Beyond the stars (ledger IS-6): places to go (the galaxy's centre, the Milky Way from
 * above, the Magellanic Clouds, Andromeda and Triangulum, the Local Group, the cosmic web), a note on
 * what each scale shows and where it comes from, and a galaxy's figures from the catalogue. It takes
 * the navigator's place while there, as the laboratory's panel does.
 */

type PlaceId = UniverseNeighbourhood['places'][number]['id'];
/** Light years per kiloparsec. */
const LY_PER_KPC = 3261.5638;

export interface NeighbourhoodPanel {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
}

export function createNeighbourhoodPanel(app: App, f: Formatters): NeighbourhoodPanel {
  const { i18n } = app;
  // This panel's messages come with its chunk.
  i18n.extend('en.stars.json', starsMessages);
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const go = (hip: number | null): void => {
    app.earthCommand({ kind: 'starsGoTo', hip });
  };
  const name = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'stars-focus-name' });
  const facts = h('dl', { class: 'kf-about-facts', 'data-testid': 'stars-facts' });
  const planetsTitle = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'stars-planets-title', hidden: true });
  const planets = h('ul', { class: 'kf-stars-planets', 'data-testid': 'stars-planets' });
  const planetsNote = h('p', { class: 'kf-living-hint', hidden: true }, i18n.t('ui.universe.stars.planetsNote'));
  const where = h('p', { class: 'kf-living-hint', 'data-testid': 'stars-where' });
  const stop = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'stars-stop', hidden: true }, i18n.t('ui.universe.stars.stop'));
  stop.addEventListener('click', () => {
    app.earthCommand({ kind: 'starsStop' });
  });
  const toSun = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'stars-sun' }, i18n.t('ui.universe.stars.toSun'));
  toSun.addEventListener('click', () => {
    go(null);
  });
  const back = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'stars-end' }, i18n.t('ui.universe.stars.back'));
  back.addEventListener('click', () => {
    app.earthCommand({ kind: 'starsEnd' });
  });
  // Search: names (the IAU's, the planet hosts'), Hipparcos and Bright Star numbers.
  const searchId = uniqueId('stars-search');
  const search = h('input', { id: searchId, type: 'search', class: 'kf-living-input', autocomplete: 'off', 'data-testid': 'stars-search' });
  const results = h('ul', { class: 'kf-living-places', 'data-testid': 'stars-results' });
  const nearestList = h('ul', { class: 'kf-living-places', 'data-testid': 'stars-nearest' });
  const nearestTitle = h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.stars.nearest'));
  // Beyond the stars: places to go, and what the scale in view shows.
  const placesList = h('ul', { class: 'kf-living-places', 'data-testid': 'stars-places' });
  const scaleNote = h('p', { class: 'kf-living-hint', 'data-testid': 'stars-scale-note' });
  let placesKey = '';
  const starButton = (label: string, detail: string, hip: number | null, testId: string): HTMLElement => {
    const b = h('button', { type: 'button', class: 'kf-living-place', 'data-testid': testId }, h('span', { class: 'kf-living-place-name' }, label), h('span', { class: 'kf-living-place-where' }, detail));
    b.addEventListener('click', () => {
      go(hip);
    });
    return h('li', {}, b);
  };
  search.addEventListener('input', () => {
    app.earthCommand({ kind: 'starsSearch', text: search.value.trim() });
  });
  let resultsKey = '';
  const element = h(
    'section',
    { class: 'kf-living-notes-part kf-stars', 'data-testid': 'stars-panel' },
    h('h3', { class: 'kf-living-notes-title' }, i18n.t('ui.universe.stars.title')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.stars.intro')),
    where,
    name,
    facts,
    planetsTitle,
    planets,
    planetsNote,
    h('div', { class: 'kf-lab-row' }, stop, toSun),
    h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: searchId }, i18n.t('ui.universe.stars.search')), search, results),
    nearestTitle,
    nearestList,
    h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.stars.beyond.title')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.stars.beyond.intro')),
    placesList,
    scaleNote,
    back,
    h('p', { class: 'kf-living-hint kf-stars-credit' }, i18n.t('ui.universe.stars.credit')),
  );

  const pc = (value: number): string => f.number(value, value < 10 ? 2 : 1);
  /** A distance in light years in words past ten thousand (2.5 million), and in parsecs with its prefix (783 kpc). */
  const lyWords = (ly: number): string =>
    ly < 1e4 ? f.number(ly, ly < 10 ? 2 : 1) : ly < 1e6 ? i18n.t('ui.universe.stars.thousand', { n: f.number(ly / 1e3, ly < 1e5 ? 1 : 0) }) : ly < 1e9 ? i18n.t('ui.universe.stars.million', { n: f.number(ly / 1e6, ly < 1e8 ? 2 : 0) }) : i18n.t('ui.universe.stars.billion', { n: f.number(ly / 1e9, 2) });
  const pcWords = (parsecs: number): string =>
    parsecs < 1e3 ? i18n.t('ui.universe.stars.pc', { n: pc(parsecs) }) : parsecs < 1e6 ? i18n.t('ui.universe.stars.kpc', { n: f.number(parsecs / 1e3, parsecs < 1e4 ? 2 : 0) }) : parsecs < 1e9 ? i18n.t('ui.universe.stars.mpc', { n: f.number(parsecs / 1e6, 2) }) : i18n.t('ui.universe.stars.gpc', { n: f.number(parsecs / 1e9, 2) });
  /** A count in words past a thousand (1.5 billion). */
  const lyWordsPlain = (value: number): string =>
    value < 1e6 ? f.number(value, 0) : value < 1e9 ? i18n.t('ui.universe.stars.million', { n: f.number(value / 1e6, value < 1e7 ? 1 : 0) }) : i18n.t('ui.universe.stars.billion', { n: f.number(value / 1e9, value < 1e10 ? 1 : 0) });
  const placeName = (id: PlaceId, galaxy: string | null): string => (id === 'local-group' && galaxy ? galaxy : i18n.t(`ui.universe.stars.beyond.place.${id}`));
  const row = (term: string, detail: string, testId: string): HTMLElement[] => [h('dt', {}, term), h('dd', { 'data-testid': `stars-${testId}` }, detail)];
  const calc = (text: string, calculated: boolean): string => (calculated ? i18n.t('ui.universe.stars.calculated', { value: text }) : text);
  const planetLine = (p: NeighbourPlanet): HTMLElement => {
    const parts: string[] = [];
    if (p.aAu !== null) parts.push(calc(i18n.t('ui.universe.stars.planet.a', { au: f.number(p.aAu, p.aAu < 0.1 ? 4 : 3) }), p.aCalculated));
    if (p.periodDays !== null) parts.push(i18n.t('ui.universe.stars.planet.period', { days: f.number(p.periodDays, p.periodDays < 10 ? 2 : 1) }));
    if (p.radiusEarth !== null) parts.push(calc(i18n.t('ui.universe.stars.planet.radius', { r: f.number(p.radiusEarth, 2) }), p.radiusCalculated));
    if (p.massEarth !== null) parts.push(calc(i18n.t(p.massKind === 'Msini' ? 'ui.universe.stars.planet.massAtLeast' : 'ui.universe.stars.planet.mass', { m: f.number(p.massEarth, p.massEarth < 10 ? 2 : 1) }), p.massCalculated));
    if (p.eqTempK !== null) parts.push(i18n.t('ui.universe.stars.planet.temperature', { k: f.number(p.eqTempK, 0) }));
    if (p.year !== null && p.method) parts.push(i18n.t('ui.universe.stars.planet.found', { method: p.method, year: String(p.year) }));
    return h('li', { class: 'kf-stars-planet' }, h('span', { class: 'kf-living-place-name' }, p.name), h('span', { class: 'kf-living-place-where' }, parts.join(' · ')));
  };
  let shownFor = '';

  return {
    element,
    update(view) {
      const n = view.neighbourhood;
      element.hidden = n === null;
      if (!n) return;
      stop.hidden = !n.travelling;
      write(where, n.fromSunPc < 1000 ? i18n.t('ui.universe.stars.where', { ly: f.number(n.fromSunLy, n.fromSunLy < 10 ? 2 : 1), pc: pc(n.fromSunPc) }) : i18n.t('ui.universe.stars.whereFar', { ly: lyWords(n.fromSunLy), pc: pcWords(n.fromSunPc) }));
      write(scaleNote, n.scale === 'stars' ? '' : n.scale === 'universe' && n.webGalaxies === 0 ? i18n.t('ui.universe.stars.beyond.scale.loading') : i18n.t(`ui.universe.stars.beyond.scale.${n.scale}`, { count: f.number(n.webGalaxies, 0) }));
      const pk = n.places.map((x) => x.id).join('|');
      if (pk !== placesKey) {
        placesKey = pk;
        placesList.replaceChildren(
          ...n.places.map((x) => {
            const b = h('button', { type: 'button', class: 'kf-living-place', 'data-testid': `stars-place-${x.id}` }, h('span', { class: 'kf-living-place-name' }, placeName(x.id, null)), h('span', { class: 'kf-living-place-where' }, x.id === 'web' || x.id === 'local-group' || x.id === 'milky-way' ? i18n.t(`ui.universe.stars.beyond.view.${x.id}`) : i18n.t('ui.universe.stars.lyAway', { ly: lyWords(x.distKpc * LY_PER_KPC) })));
            b.addEventListener('click', () => {
              app.earthCommand({ kind: 'starsPlace', place: x.id });
            });
            return h('li', {}, b);
          }),
        );
      }
      const rk = n.results.map((r) => `${String(r.hip)}:${r.name}`).join('|');
      if (rk !== resultsKey) {
        resultsKey = rk;
        results.replaceChildren(
          ...n.results.map((r) => {
            if (r.galaxy !== null) {
              const galaxy = r.galaxy;
              const b = h('button', { type: 'button', class: 'kf-living-place', 'data-testid': `stars-result-galaxy-${galaxy.replace(/\W+/gu, '-')}` }, h('span', { class: 'kf-living-place-name' }, r.name), h('span', { class: 'kf-living-place-where' }, i18n.t('ui.universe.stars.galaxyAway', { ly: lyWords(((r.distPc ?? 0) / 1000) * LY_PER_KPC) })));
              b.addEventListener('click', () => {
                app.earthCommand({ kind: 'starsPlace', place: `galaxy:${galaxy}` });
              });
              return h('li', {}, b);
            }
            return starButton(r.name, r.distPc === null ? i18n.t('ui.universe.stars.unplaced') : i18n.t(r.planets > 0 ? 'ui.universe.stars.fromSunWithPlanets' : 'ui.universe.stars.fromSun', { pc: pc(r.distPc), count: r.planets }), r.hip, `stars-result-${String(r.hip ?? 'sun')}`);
          }),
        );
      }
      const s = n.focus;
      const pl = n.place;
      const key = `${String(s.hip)}:${String(s.name)}:${pl?.id ?? ''}:${pl?.galaxy ?? ''}`;
      if (key === shownFor) return;
      shownFor = key;
      nearestTitle.hidden = pl !== null;
      nearestList.hidden = pl !== null;
      if (pl) {
        // A place beyond the stars: its name, and a galaxy's figures from the catalogue.
        write(name, placeName(pl.id, pl.galaxy));
        const rows: HTMLElement[] = [...row(i18n.t('ui.universe.stars.distance'), i18n.t('ui.universe.stars.placeDistance', { ly: lyWords(pl.distKpc * LY_PER_KPC), pc: pcWords(pl.distKpc * 1000) }), 'distance')];
        if (pl.type) rows.push(...row(i18n.t('ui.universe.stars.galaxyType'), pl.type, 'galaxy-type'));
        if (pl.absV !== null) rows.push(...row(i18n.t('ui.universe.stars.absolute'), pl.absVDerived ? i18n.t('ui.universe.stars.derived', { value: f.number(pl.absV, 1) }) : f.number(pl.absV, 1), 'absolute'));
        if (pl.massMsun !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyMass'), i18n.t('ui.universe.stars.suns', { n: lyWordsPlain(pl.massMsun) }), 'galaxy-mass'));
        if (pl.diameterKpc !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyDiameter'), i18n.t('ui.universe.stars.kpcAcross', { n: f.number(pl.diameterKpc, 1), ly: lyWords(pl.diameterKpc * LY_PER_KPC) }), 'galaxy-diameter'));
        else if (pl.radiusKpc !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyRadius'), i18n.t('ui.universe.stars.kpcRadius', { n: f.number(pl.radiusKpc, pl.radiusKpc < 1 ? 2 : 1) }), 'galaxy-radius'));
        if (pl.group) rows.push(...row(i18n.t('ui.universe.stars.galaxyGroup'), i18n.t(`ui.universe.stars.group.${pl.group === 'MW' ? 'mw' : pl.group === 'M31' ? 'm31' : 'rest'}`), 'galaxy-group'));
        facts.replaceChildren(...rows);
        planetsTitle.hidden = true;
        planetsNote.hidden = true;
        planets.replaceChildren();
        return;
      }
      write(name, s.name ?? (s.hip !== null ? `HIP ${String(s.hip)}` : ''));
      const items: HTMLElement[] = [];
      if (s.distPc !== null && s.distPc > 0) {
        items.push(...row(i18n.t('ui.universe.stars.distance'), i18n.t('ui.universe.stars.distanceValue', { ly: f.number(s.distLy ?? 0, 2), pc: pc(s.distPc), percent: f.number(s.relativeError * 100, 1) }), 'distance'));
      }
      if (s.spType) items.push(...row(i18n.t('ui.universe.stars.type'), s.spType, 'type'));
      if (s.temperatureK !== null) items.push(...row(i18n.t('ui.universe.stars.temperature'), i18n.t('ui.universe.stars.kelvin', { k: f.number(Math.round(s.temperatureK / 10) * 10, 0) }), 'temperature'));
      if (s.vmag !== null) items.push(...row(i18n.t('ui.universe.stars.vmag'), f.number(s.vmag, 2), 'vmag'));
      if (s.absoluteV !== null) items.push(...row(i18n.t('ui.universe.stars.absolute'), f.number(s.absoluteV, 2), 'absolute'));
      if (s.starsInSystem > 1) items.push(...row(i18n.t('ui.universe.stars.multiple'), f.number(s.starsInSystem, 0), 'multiple'));
      facts.replaceChildren(...items);
      planetsTitle.hidden = s.planets.length === 0;
      planetsNote.hidden = s.planets.length === 0;
      write(planetsTitle, i18n.t('ui.universe.stars.planets', { count: s.planets.length }));
      planets.replaceChildren(...s.planets.map(planetLine));
      nearestList.replaceChildren(...n.nearest.map((x) => starButton(x.name, i18n.t(x.planets > 0 ? 'ui.universe.stars.nearWithPlanets' : 'ui.universe.stars.near', { pc: pc(x.distPc), count: x.planets }), x.hip, `stars-near-${String(x.hip ?? 'sun')}`)));
    },
  };
}
