import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { App, NeighbourPlanet, UniverseNeighbourhood, UniverseView } from '../../core/types';
import type { NeighbourhoodFile } from '../../explore/neighbourhood/data';
import { bvKelvin } from '../../explore/sky';
import starsMessages from '../../i18n/en.stars.json';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';
import { helpButton, withHelp } from './help';

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
/** The Hertzsprung-Russell diagram's ranges: colour (B-V) and absolute magnitude, brightest at the top; its size in canvas pixels. */
const HR = { bv: [-0.4, 2.1], mag: [-8, 17], width: 600, height: 440, pad: { left: 56, right: 14, top: 14, bottom: 46 } } as const;
/** The Sun among them: its absolute magnitude and colour (data/constants.json's, as the scene takes them). */
const SUN_ON_HR = { bv: 0.653, mag: 4.81 } as const;
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
  const archiveNote = h('p', { class: 'kf-living-hint', 'data-testid': 'stars-archive-note', hidden: true }, i18n.t('ui.universe.stars.archiveStar'));
  const planetsTitle = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'stars-planets-title', hidden: true });
  const planets = h('ul', { class: 'kf-stars-planets', 'data-testid': 'stars-planets' });
  const planetsNote = h('p', { class: 'kf-living-hint', hidden: true }, i18n.t('ui.universe.stars.planetsNote'), helpButton(app, 'exoplanets', i18n.t('ui.help.label.exoplanets')));
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
  // The Hertzsprung-Russell diagram (ledger ST-4): every star placed in space by its colour and its
  // brightness from 10 parsecs (Hipparcos), the Sun and the star in view marked.
  const hr = h('canvas', { class: 'kf-stars-hr', width: String(HR.width), height: String(HR.height), role: 'img', 'data-testid': 'stars-hr' });
  const hrCaption = h('p', { class: 'kf-living-hint', 'data-testid': 'stars-hr-caption' });
  let hrStars: Array<{ hip: number; bv: number; mag: number; rgb: readonly number[] }> | null = null;
  let hrBase: HTMLCanvasElement | null = null;
  let hrMarked = '';
  const hrX = (bv: number): number => HR.pad.left + ((bv - HR.bv[0]) / (HR.bv[1] - HR.bv[0])) * (HR.width - HR.pad.left - HR.pad.right);
  const hrY = (mag: number): number => HR.pad.top + ((mag - HR.mag[0]) / (HR.mag[1] - HR.mag[0])) * (HR.height - HR.pad.top - HR.pad.bottom);
  const drawHrBase = (): void => {
    if (!hrStars) return;
    const base = document.createElement('canvas');
    base.width = HR.width;
    base.height = HR.height;
    const g = base.getContext('2d');
    if (!g) return;
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.font = '15px system-ui, sans-serif';
    g.lineWidth = 1;
    g.strokeRect(HR.pad.left, HR.pad.top, HR.width - HR.pad.left - HR.pad.right, HR.height - HR.pad.top - HR.pad.bottom);
    // Ticks: colour every half, magnitude every five.
    g.textAlign = 'center';
    for (let bv = 0; bv <= 2; bv += 0.5) g.fillText(f.number(bv, 1), hrX(bv), HR.height - HR.pad.bottom + 18);
    g.textAlign = 'right';
    for (let m = -5; m <= 15; m += 5) g.fillText(f.number(m, 0), HR.pad.left - 8, hrY(m) + 5);
    g.textAlign = 'center';
    g.fillText(i18n.t('ui.universe.stars.hr.colour'), (HR.pad.left + HR.width - HR.pad.right) / 2, HR.height - 6);
    g.save();
    g.translate(16, (HR.pad.top + HR.height - HR.pad.bottom) / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(i18n.t('ui.universe.stars.hr.brightness'), 0, 0);
    g.restore();
    for (const s of hrStars) {
      g.fillStyle = `rgba(${String(Math.round(255 * (s.rgb[0] ?? 1)))},${String(Math.round(255 * (s.rgb[1] ?? 1)))},${String(Math.round(255 * (s.rgb[2] ?? 1)))},0.75)`;
      g.fillRect(hrX(s.bv) - 1.2, hrY(s.mag) - 1.2, 2.4, 2.4);
    }
    // Where the kinds of star gather (names only; the regions are not drawn as boundaries).
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.textAlign = 'left';
    // Below the sequence's upper end, where no stars are.
    g.fillText(i18n.t('ui.universe.stars.hr.mainSequence'), hrX(-0.36), hrY(7.5));
    g.fillText(i18n.t('ui.universe.stars.hr.giants'), hrX(1.25), hrY(-3.2));
    g.fillText(i18n.t('ui.universe.stars.hr.whiteDwarfs'), hrX(-0.3), hrY(15.6));
    hrBase = base;
  };
  const drawHr = (focus: { hip: number | null; name: string | null } | null): void => {
    const g = hr.getContext('2d');
    if (!g || !hrBase || !hrStars) return;
    g.clearRect(0, 0, HR.width, HR.height);
    g.drawImage(hrBase, 0, 0);
    // The Sun: a circle with a point at its centre.
    g.strokeStyle = 'rgba(255,214,120,1)';
    g.fillStyle = 'rgba(255,214,120,1)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(hrX(SUN_ON_HR.bv), hrY(SUN_ON_HR.mag), 7, 0, 2 * Math.PI);
    g.stroke();
    g.fillRect(hrX(SUN_ON_HR.bv) - 1.5, hrY(SUN_ON_HR.mag) - 1.5, 3, 3);
    g.font = '15px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText(i18n.t('ui.universe.stars.hr.sun'), hrX(SUN_ON_HR.bv) + 10, hrY(SUN_ON_HR.mag) + 5);
    const s = focus?.hip === null || focus?.hip === undefined ? undefined : hrStars.find((x) => x.hip === focus.hip);
    if (s) {
      // White on a dark edge, to show on stars of any colour.
      for (const [style, width] of [
        ['rgba(0,0,0,0.85)', 5],
        ['rgba(255,255,255,1)', 2.5],
      ] as const) {
        g.strokeStyle = style;
        g.lineWidth = width;
        g.beginPath();
        g.arc(hrX(s.bv), hrY(s.mag), 11, 0, 2 * Math.PI);
        g.stroke();
      }
    }
    hr.dataset.marked = s ? (focus?.name ?? '') : '';
    hr.setAttribute('aria-label', i18n.t('ui.universe.stars.hr.label', { count: hrStars.length, marked: s ? i18n.t('ui.universe.stars.hr.labelMarked', { name: focus?.name ?? '' }) : '' }));
    write(hrCaption, i18n.t(s || !focus?.name || focus.hip === null ? 'ui.universe.stars.hr.caption' : 'ui.universe.stars.hr.captionOff', { count: f.number(hrStars.length, 0), name: focus?.name ?? '' }));
  };
  void app.assets
    .json<NeighbourhoodFile>('assets/stars/neighbourhood.json')
    .then((file) => {
      // Only the stars placed in space (parallax at least five times its error) with a colour: absolute magnitude V + 5 log10(parallax / 100 mas).
      hrStars = file.stars
        .filter(([, , , , , plx, ePlx, , bv]) => bv !== null && plx > 0 && plx / ePlx >= 5)
        .map(([hip, , , , , plx, , vmag, bv]) => ({ hip, bv: bv ?? 0, mag: vmag + 5 * Math.log10(plx / 100), rgb: blackbodyRgb(bvKelvin(bv ?? 0)) }))
        .filter((x) => x.bv >= HR.bv[0] && x.bv <= HR.bv[1] && x.mag >= HR.mag[0] && x.mag <= HR.mag[1]);
      hr.dataset.count = String(hrStars.length);
      drawHrBase();
      hrMarked = '';
    })
    .catch(() => {
      hr.hidden = true;
    });
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
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.stars.intro'), helpButton(app, 'stars', i18n.t('ui.universe.stars.title'))),
    withHelp(app, where, 'lightYear', i18n.t('ui.help.label.lightYear')),
    name,
    facts,
    archiveNote,
    planetsTitle,
    planets,
    planetsNote,
    h('div', { class: 'kf-lab-row' }, stop, toSun),
    h('div', { class: 'kf-living-group' }, withHelp(app, h('label', { class: 'kf-living-label', for: searchId }, i18n.t('ui.universe.stars.search')), 'starsSearch'), search, results),
    nearestTitle,
    nearestList,
    withHelp(app, h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.stars.hr.title')), 'hr'),
    hr,
    hrCaption,
    withHelp(app, h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.stars.beyond.title')), 'milkyWay'),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.stars.beyond.intro'), helpButton(app, 'localGroup', i18n.t('ui.help.label.localGroup')), helpButton(app, 'cosmicWeb', i18n.t('ui.help.label.cosmicWeb'))),
    placesList,
    scaleNote,
    back,
    h('p', { class: 'kf-living-hint kf-stars-credit', 'data-photo-credit': '' }, i18n.t('ui.universe.stars.credit')),
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
  /** A fact, its term with a "?" in plain words where `topic` names one. */
  const row = (term: string, detail: string, testId: string, topic?: string): HTMLElement[] => [h('dt', {}, term, topic ? helpButton(app, topic, term) : null), h('dd', { 'data-testid': `stars-${testId}` }, detail)];
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
      const marked = `${String(s.hip)}:${String(s.name)}:${String(hrBase !== null)}`;
      if (marked !== hrMarked && hrBase) {
        hrMarked = marked;
        drawHr({ hip: s.hip, name: s.name });
      }
      const key = `${String(s.hip)}:${String(s.name)}:${pl?.id ?? ''}:${pl?.galaxy ?? ''}`;
      if (key === shownFor) return;
      shownFor = key;
      nearestTitle.hidden = pl !== null;
      nearestList.hidden = pl !== null;
      if (pl) {
        // A place beyond the stars: its name, and a galaxy's figures from the catalogue.
        write(name, placeName(pl.id, pl.galaxy));
        const rows: HTMLElement[] = [...row(i18n.t('ui.universe.stars.distance'), i18n.t('ui.universe.stars.placeDistance', { ly: lyWords(pl.distKpc * LY_PER_KPC), pc: pcWords(pl.distKpc * 1000) }), 'distance', 'lightYear')];
        if (pl.type) rows.push(...row(i18n.t('ui.universe.stars.galaxyType'), pl.type, 'galaxy-type', 'galaxyType'));
        if (pl.absV !== null) rows.push(...row(i18n.t('ui.universe.stars.absolute'), pl.absVDerived ? i18n.t('ui.universe.stars.derived', { value: f.number(pl.absV, 1) }) : f.number(pl.absV, 1), 'absolute', 'absoluteMagnitude'));
        if (pl.massMsun !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyMass'), i18n.t('ui.universe.stars.suns', { n: lyWordsPlain(pl.massMsun) }), 'galaxy-mass', 'mass'));
        if (pl.diameterKpc !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyDiameter'), i18n.t('ui.universe.stars.kpcAcross', { n: f.number(pl.diameterKpc, 1), ly: lyWords(pl.diameterKpc * LY_PER_KPC) }), 'galaxy-diameter'));
        else if (pl.radiusKpc !== null) rows.push(...row(i18n.t('ui.universe.stars.galaxyRadius'), i18n.t('ui.universe.stars.kpcRadius', { n: f.number(pl.radiusKpc, pl.radiusKpc < 1 ? 2 : 1) }), 'galaxy-radius'));
        if (pl.group) rows.push(...row(i18n.t('ui.universe.stars.galaxyGroup'), i18n.t(`ui.universe.stars.group.${pl.group === 'MW' ? 'mw' : pl.group === 'M31' ? 'm31' : 'rest'}`), 'galaxy-group', 'localGroup'));
        facts.replaceChildren(...rows);
        archiveNote.hidden = true;
        planetsTitle.hidden = true;
        planetsNote.hidden = true;
        planets.replaceChildren();
        return;
      }
      write(name, s.name ?? (s.hip !== null ? `HIP ${String(s.hip)}` : ''));
      const items: HTMLElement[] = [];
      if (s.distPc !== null && s.distPc > 0) {
        items.push(...row(i18n.t('ui.universe.stars.distance'), i18n.t('ui.universe.stars.distanceValue', { ly: f.number(s.distLy ?? 0, 2), pc: pc(s.distPc), percent: f.number(s.relativeError * 100, 1) }), 'distance', 'parallax'));
      }
      if (s.spType) items.push(...row(i18n.t('ui.universe.stars.type'), s.spType, 'type', 'spectralType'));
      if (s.temperatureK !== null) items.push(...row(i18n.t('ui.universe.stars.temperature'), i18n.t('ui.universe.stars.kelvin', { k: f.number(Math.round(s.temperatureK / 10) * 10, 0) }), 'temperature', 'temperature'));
      if (s.vmag !== null) items.push(...row(i18n.t('ui.universe.stars.vmag'), f.number(s.vmag, 2), 'vmag', 'apparentMagnitude'));
      if (s.absoluteV !== null) items.push(...row(i18n.t('ui.universe.stars.absolute'), f.number(s.absoluteV, 2), 'absolute', 'absoluteMagnitude'));
      // Its light in V against the Sun's (both from 10 parsecs); a planet host's size, mass and whole light as the archive gives them.
      if (s.absoluteV !== null && s.distPc !== null && s.distPc > 0) {
        const suns = 10 ** (-0.4 * (s.absoluteV - SUN_ON_HR.mag));
        items.push(...row(i18n.t('ui.universe.stars.lightV'), i18n.t('ui.universe.stars.sunsTimes', { n: f.number(suns, suns < 0.01 ? 5 : suns < 10 ? 3 : 0) }), 'light'));
      }
      if (s.radiusSun !== null) items.push(...row(i18n.t('ui.universe.stars.radius'), i18n.t('ui.universe.stars.sunsTimes', { n: f.number(s.radiusSun, 3) }), 'radius', 'radius'));
      if (s.massSun !== null) items.push(...row(i18n.t('ui.universe.stars.mass'), i18n.t('ui.universe.stars.sunsTimes', { n: f.number(s.massSun, 3) }), 'mass', 'mass'));
      if (s.luminositySun !== null) items.push(...row(i18n.t('ui.universe.stars.luminosity'), i18n.t('ui.universe.stars.sunsTimes', { n: f.number(s.luminositySun, s.luminositySun < 0.01 ? 5 : 3) }), 'luminosity', 'luminosity'));
      archiveNote.hidden = s.radiusSun === null && s.massSun === null && s.luminositySun === null;
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
