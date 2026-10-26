import type { App, UniverseBulletin, UniverseSatellite, UniverseView } from '../../core/types';
import { ATLAS, PROPHETS, site, type FieldPlace } from '../../explore/field-notes/data';
import { loadPlaces, searchPlaces, type Place } from '../../explore/field-notes/places';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';
import '../styles/living.css';

/**
 * The navigator's Living Earth: the imagery (cloud-free, or the last whole day's), the live layers
 * (satellites and earthquakes, each with what it holds now), a place search, and the field notes,
 * by Samee: "Today on Earth" (src/explore/field-notes/bulletin composes it), an atlas of wonders to
 * tour, and the places tradition associates with the prophets, peace be upon them.
 *
 * Everything is a real button; a choice that flies somewhere says where in its accessible name
 * ("Go to Makkah", its visible "Go" first). A
 * tour moves only when asked (Next, Previous), so nothing flies on its own. While the atlas tour runs
 * its places are named on the globe, and while the prophets' list is open, theirs are. Lines are
 * rewritten only when their text changes, and nothing here is a live region (the bulletin changes
 * every second).
 */

export interface LivingEarth {
  readonly element: HTMLDetailsElement;
  update(view: UniverseView, slow: boolean): void;
}

/** Below this distance (km) a point is "near" the place named for it; beyond, the distance is said. */
const NEAR_KM = 100;
/** Ground framed by the bulletin's flights (km): the Sun's point and the terminator are wide views. */
const VIEW_KM = { sun: 2500, terminator: 800, station: 2500, quake: 400 } as const;
/** Ground framed for a found place, km: a city of a million or more, or anything smaller. */
const FIND_VIEW_KM = { city: 60, town: 30 } as const;
const CITY = 1_000_000;
/** Earthquakes listed (the strongest of the day). */
const QUAKES_LISTED = 5;

interface Stop {
  title: string;
  subtitle: string | null;
  text: string;
  place: FieldPlace;
}

export function createLivingEarth(app: App, f: Formatters, onGo: () => void): LivingEarth {
  const { i18n } = app;
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const go = (lat: number, lon: number, viewKm: number, fold = true): void => {
    app.earthCommand({ kind: 'goto', lat, lon, viewKm });
    if (fold) onGo();
  };
  const goButton = (place: string, onClick: () => void, testId?: string): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'kf-living-go', 'aria-label': i18n.t('ui.universe.living.goTo', { place }), ...(testId ? { 'data-testid': testId } : {}) }, i18n.t('ui.universe.living.go'));
    b.addEventListener('click', onClick);
    return b;
  };
  const coords = (lat: number, lon: number): string =>
    `${i18n.t(lat >= 0 ? 'ui.universe.living.latN' : 'ui.universe.living.latS', { value: f.number(Math.abs(lat), 1) })}, ${i18n.t(lon >= 0 ? 'ui.universe.living.lonE' : 'ui.universe.living.lonW', { value: f.number(Math.abs(lon), 1) })}`;
  const ago = (ms: number): string => {
    const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
    return minutes < 60 ? i18n.t('ui.universe.living.ago.min', { value: minutes }) : i18n.t('ui.universe.living.ago.h', { value: Math.round(minutes / 60) });
  };
  const lit = (sunlit: boolean): string => i18n.t(sunlit ? 'ui.universe.living.sunlit' : 'ui.universe.living.shadow');
  const satelliteName = (s: UniverseSatellite): string => (s.station ? i18n.t(`ui.universe.station.${s.station}`) : s.name);
  const period = (minutes: number): string => (minutes > 120 ? f.hours(minutes / 60) : f.keep(i18n.t('ui.universe.living.minutes', { value: f.number(minutes, 0) })));

  // Imagery: two choices, one pressed.
  const imageryButtons = (['clear', 'today'] as const).map((mode) => {
    const b = h('button', { type: 'button', class: 'kf-living-choice', 'aria-pressed': String(mode === 'clear'), 'data-testid': `living-imagery-${mode}` }, i18n.t(`ui.universe.living.${mode}`));
    b.addEventListener('click', () => {
      app.earthCommand({ kind: 'imagery', mode });
    });
    return [mode, b] as const;
  });
  const imageryHint = h('p', { class: 'kf-living-hint' });
  const imageryLabel = uniqueId('living-imagery');
  const imagery = h(
    'div',
    { class: 'kf-living-group' },
    h('p', { id: imageryLabel, class: 'kf-living-label' }, i18n.t('ui.universe.living.imagery')),
    h('div', { class: 'kf-living-choices', role: 'group', 'aria-labelledby': imageryLabel }, ...imageryButtons.map(([, b]) => b)),
    imageryHint,
  );

  // The live layers: a switch each, with what it holds now.
  const layerOn = { satellites: false, quakes: false };
  const layerSwitch = (layer: 'satellites' | 'quakes'): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'kf-living-switch', 'aria-pressed': 'false', 'data-testid': `living-${layer}` }, h('span', { class: 'kf-living-switch-mark', 'aria-hidden': 'true' }), i18n.t(`ui.universe.living.${layer}`));
    b.addEventListener('click', () => {
      layerOn[layer] = !layerOn[layer];
      b.setAttribute('aria-pressed', String(layerOn[layer]));
      app.earthCommand({ kind: 'layer', layer, on: layerOn[layer] });
    });
    return b;
  };
  const satSwitch = layerSwitch('satellites');
  const satStatus = h('p', { class: 'kf-living-hint', 'data-testid': 'living-satellites-status' });
  const selectedText = h('span', {});
  const deselect = h('button', { type: 'button', class: 'kf-living-go' }, i18n.t('ui.universe.living.deselect'));
  deselect.addEventListener('click', () => {
    app.earthCommand({ kind: 'select', id: null });
  });
  const selected = h('p', { class: 'kf-living-selected', 'data-testid': 'living-selected', hidden: true }, selectedText, deselect);
  const quakeSwitch = layerSwitch('quakes');
  const quakeStatus = h('p', { class: 'kf-living-hint', 'data-testid': 'living-quakes-status' });
  const quakeList = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.living.quakeList'), 'data-testid': 'living-quake-list' });
  const layers = h('div', { class: 'kf-living-group' }, h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.living.layers')), satSwitch, satStatus, selected, quakeSwitch, quakeStatus, quakeList);

  // Find a place.
  let places: readonly Place[] = [];
  const findId = uniqueId('living-find');
  const findInput = h('input', { id: findId, type: 'search', class: 'kf-living-input', placeholder: i18n.t('ui.universe.living.findHint'), autocomplete: 'off', spellcheck: 'false', 'data-testid': 'living-find' });
  const findResults = h('ul', { class: 'kf-living-list', 'data-testid': 'living-find-results' });
  const findNone = h('p', { class: 'kf-living-hint', hidden: true }, i18n.t('ui.universe.living.findNone'));
  const showFound = (): void => {
    const query = findInput.value;
    const found = searchPlaces(places, query);
    findNone.hidden = query.trim() === '' || found.length > 0 || places.length === 0;
    findResults.replaceChildren(
      ...found.map((p) => {
        const b = h('button', { type: 'button', class: 'kf-living-place' }, h('span', { class: 'kf-living-place-name' }, p.name), ' ', h('span', { class: 'kf-living-place-where' }, coords(p.lat, p.lon)));
        b.addEventListener('click', () => {
          go(p.lat, p.lon, p.population >= CITY ? FIND_VIEW_KM.city : FIND_VIEW_KM.town);
        });
        return h('li', {}, b);
      }),
    );
  };
  findInput.addEventListener('input', showFound);
  const find = h('form', { class: 'kf-living-group', role: 'search' }, h('label', { class: 'kf-living-label', for: findId }, i18n.t('ui.universe.living.find')), findInput, findNone, findResults);
  find.addEventListener('submit', (event) => {
    event.preventDefault();
    findResults.querySelector('button')?.click();
  });

  // Field notes, by Samee: today, the atlas and the prophets' lands.
  /** A line of the bulletin, with its Go button kept (only its name and destination change, so focus stays on it). */
  const line = (testId: string): { li: HTMLLIElement; text: HTMLSpanElement; setGo(place: string | null, onClick: () => void): void } => {
    const text = h('span', { class: 'kf-living-line-text' });
    const button = h('button', { type: 'button', class: 'kf-living-go', hidden: true }, i18n.t('ui.universe.living.go'));
    let action: (() => void) | null = null;
    button.addEventListener('click', () => {
      action?.();
    });
    return {
      li: h('li', { class: 'kf-living-line', 'data-testid': testId }, text, button),
      text,
      setGo(place, onClick) {
        button.hidden = place === null;
        const name = place === null ? '' : i18n.t('ui.universe.living.goTo', { place });
        if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
        action = onClick;
      },
    };
  };
  const today = {
    sun: line('field-sun'),
    dawn: line('field-dawn'),
    dusk: line('field-dusk'),
    station: line('field-station'),
    satellites: line('field-satellites'),
    quake: line('field-quake'),
  };
  const todayLoading = h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.field.loading'));
  const todayList = h('ul', { class: 'kf-living-today', 'data-testid': 'field-today', hidden: true }, ...Object.values(today).map((l) => l.li));

  const tourTitle = h('h5', { class: 'kf-living-tour-title' });
  const tourSubtitle = h('p', { class: 'kf-living-tour-subtitle' });
  const tourText = h('p', { class: 'kf-living-tour-text' });
  const tourStep = h('p', { class: 'kf-living-hint' });
  const tourPrevious = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'field-tour-previous' }, i18n.t('ui.universe.field.previous'));
  const tourNext = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'field-tour-next' }, i18n.t('ui.universe.field.next'));
  const tourStop = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'field-tour-stop' }, i18n.t('ui.universe.field.stop'));
  const tourBox = h('div', { class: 'kf-living-tour', 'data-testid': 'field-tour', hidden: true, tabindex: '-1' }, tourTitle, tourSubtitle, tourText, h('div', { class: 'kf-living-tour-moves' }, tourPrevious, tourNext, tourStop), tourStep);
  let tour: { kind: 'atlas' | 'prophets'; stops: Stop[]; at: number } | null = null;

  const atlasStops = (): Stop[] =>
    ATLAS.map((p) => ({ title: i18n.t(`ui.universe.field.atlas.${p.id}.name`), subtitle: null, text: i18n.t(`ui.universe.field.atlas.${p.id}.text`), place: p }));
  const prophetStops = (): Stop[] =>
    PROPHETS.flatMap((prophet) =>
      prophet.sites.flatMap((id) => {
        const place = site(id);
        return place
          ? [{ title: i18n.t(`ui.universe.field.prophet.${prophet.id}.name`), subtitle: i18n.t(`ui.universe.field.site.${id}`), text: i18n.t(`ui.universe.field.prophet.${prophet.id}.text`), place }]
          : [];
      }),
    );
  let prophetsOpen = false;
  const markers = (): void => {
    app.earthCommand({ kind: 'markers', set: tour?.kind ?? (prophetsOpen ? 'prophets' : null) });
  };
  const showStop = (): void => {
    if (!tour) return;
    const stop = tour.stops[tour.at];
    if (!stop) return;
    write(tourTitle, stop.title);
    tourSubtitle.hidden = stop.subtitle === null;
    write(tourSubtitle, stop.subtitle ?? '');
    write(tourText, stop.text);
    write(tourStep, i18n.t('ui.universe.field.step', { n: f.number(tour.at + 1), total: f.number(tour.stops.length) }));
    // aria-disabled, not disabled: a button that disables itself under the keyboard would drop its focus.
    tourPrevious.setAttribute('aria-disabled', String(tour.at === 0));
    tourNext.setAttribute('aria-disabled', String(tour.at === tour.stops.length - 1));
    go(stop.place.lat, stop.place.lon, stop.place.viewKm, false);
  };
  const startTour = (kind: 'atlas' | 'prophets'): void => {
    tour = { kind, stops: kind === 'atlas' ? atlasStops() : prophetStops(), at: 0 };
    tourBox.hidden = false;
    // The tour's box sits just under the button that began it.
    (kind === 'atlas' ? atlasTour : prophetsTour).after(tourBox);
    showStop();
    markers();
    tourBox.focus({ preventScroll: true });
    tourBox.scrollIntoView({ block: 'nearest' });
  };
  tourPrevious.addEventListener('click', () => {
    if (!tour || tour.at === 0) return;
    tour.at -= 1;
    showStop();
  });
  tourNext.addEventListener('click', () => {
    if (!tour || tour.at === tour.stops.length - 1) return;
    tour.at += 1;
    showStop();
  });
  const endTour = (): void => {
    const box = tour?.kind === 'atlas' ? atlasTour : prophetsTour;
    tour = null;
    tourBox.hidden = true;
    markers();
    box.focus({ preventScroll: true });
  };
  tourStop.addEventListener('click', endTour);

  const atlasTour = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'field-atlas-tour' }, i18n.t('ui.universe.field.tour'));
  atlasTour.addEventListener('click', () => {
    startTour('atlas');
  });
  const atlasBox = h(
    'section',
    { class: 'kf-living-notes-part', 'data-testid': 'field-atlas' },
    h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.field.atlas')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.field.atlasIntro', { count: ATLAS.length })),
    atlasTour,
  );

  const prophetsTour = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'field-prophets-tour' }, i18n.t('ui.universe.field.prophetTour'));
  prophetsTour.addEventListener('click', () => {
    startTour('prophets');
  });
  const prophetList = h(
    'ol',
    { class: 'kf-living-prophets', 'data-testid': 'field-prophets-list' },
    ...PROPHETS.map((prophet) => {
      const name = i18n.t(`ui.universe.field.prophet.${prophet.id}.name`);
      const sites = prophet.sites.flatMap((id) => {
        const place = site(id);
        if (!place) return [];
        const label = i18n.t(`ui.universe.field.site.${id}`);
        return [
          h('li', {}, h('span', {}, label), goButton(label, () => {
            go(place.lat, place.lon, place.viewKm);
          })),
        ];
      });
      return h(
        'li',
        { class: 'kf-living-prophet', 'data-prophet': prophet.id },
        h('p', { class: 'kf-living-prophet-name' }, name),
        h('p', { class: 'kf-living-prophet-text' }, i18n.t(`ui.universe.field.prophet.${prophet.id}.text`)),
        sites.length > 0 ? h('ul', { class: 'kf-living-sites' }, ...sites) : h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.field.noPlace')),
      );
    }),
  );
  const prophetsBody = h(
    'div',
    { class: 'kf-living-prophets-body' },
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.field.prophetsIntro')),
    h('p', { class: 'kf-living-review' }, i18n.t('ui.universe.field.prophetsReview')),
    prophetsTour,
    prophetList,
  );
  const prophets = h('details', { class: 'kf-living-notes-part kf-living-prophets-box', 'data-testid': 'field-prophets' }, h('summary', {}, i18n.t('ui.universe.field.prophets')), prophetsBody);
  prophets.addEventListener('toggle', () => {
    prophetsOpen = prophets.open;
    if (!prophetsOpen && tour?.kind === 'prophets') endTour();
    else markers();
  });

  const notes = h(
    'section',
    { class: 'kf-living-notes', 'data-testid': 'field-notes' },
    h('h3', { class: 'kf-living-notes-title' }, i18n.t('ui.universe.field.title')),
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.field.intro')),
    h('section', { class: 'kf-living-notes-part' }, h('h4', { class: 'kf-living-subtitle' }, i18n.t('ui.universe.field.today')), todayLoading, todayList),
    atlasBox,
    prophets,
  );

  // On foot: a walk at the point below (src/explore/walk), in a space suit at the Earth's own gravity.
  const walkButton = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'living-walk' }, i18n.t('ui.universe.walk.here'));
  walkButton.addEventListener('click', () => {
    app.earthCommand({ kind: 'walk' });
    onGo();
  });
  const walkHere = h('div', { class: 'kf-living-group' }, walkButton, h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.walk.hereHint')));

  const summary = h('summary', {}, i18n.t('ui.universe.living.title'));
  const element = h(
    'details',
    { class: 'kf-nav-living', 'data-testid': 'living-earth' },
    summary,
    h('div', { class: 'kf-living-body' }, h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.living.intro')), imagery, layers, find, walkHere, notes),
  );
  element.addEventListener('toggle', () => {
    if (!element.open) return;
    void loadPlaces(app.assets).then((list) => {
      places = list;
      if (findInput.value) showFound();
    });
  });

  let imageryMode: 'clear' | 'today' | null = null;
  const writeBulletin = (b: UniverseBulletin): void => {
    todayLoading.hidden = true;
    todayList.hidden = false;
    const near = b.sun.near;
    write(today.sun.text, near && near.km < NEAR_KM ? i18n.t('ui.universe.field.sunNear', { place: near.name }) : near ? i18n.t('ui.universe.field.sunFar', { distance: f.distance(near.km), place: near.name }) : '');
    today.sun.setGo(near?.name ?? null, () => {
      go(b.sun.lat, b.sun.lon, VIEW_KM.sun);
    });
    for (const [key, at, message] of [['dawn', b.dawn, 'ui.universe.field.dawn'], ['dusk', b.dusk, 'ui.universe.field.dusk']] as const) {
      today[key].li.hidden = !at;
      if (!at) continue;
      write(today[key].text, i18n.t(message, { place: at.name }));
      today[key].setGo(at.name, () => {
        go(at.lat, at.lon, VIEW_KM.terminator);
      });
    }
    const s = b.station;
    if (s) {
      const where = s.near && s.near.km < NEAR_KM ? 'ui.universe.field.stationNear' : 'ui.universe.field.stationFar';
      write(today.station.text, i18n.t(where, { altitude: f.distance(s.altitudeKm), place: s.near?.name ?? '', distance: f.distance(s.near?.km ?? 0), lit: lit(s.sunlit) }));
    } else {
      write(today.station.text, i18n.t(layerOn.satellites ? 'ui.universe.field.stationAway' : 'ui.universe.field.stationOff'));
    }
    const stationName = s ? i18n.t(`ui.universe.stationName.${s.station ?? 'iss'}`) : null;
    today.station.setGo(stationName, () => {
      // Follow it (its orbit drawn, its name and height given), from above the ground it is crossing.
      const now = app.universe()?.living?.station ?? s;
      if (!now) return;
      app.earthCommand({ kind: 'select', id: String(now.index) });
      go(now.lat, now.lon, VIEW_KM.station);
    });
    today.satellites.li.hidden = !b.satellites;
    if (b.satellites) write(today.satellites.text, i18n.t('ui.universe.field.satellites', { count: f.number(b.satellites.count), sunlit: f.number(b.satellites.sunlit) }));
    const q = b.quakes;
    const strongest = q?.strongest ?? null;
    write(today.quake.text, !q ? i18n.t('ui.universe.field.quakeOff') : strongest ? i18n.t('ui.universe.field.quake', { magnitude: f.number(strongest.magnitude, 1), place: strongest.place, ago: ago(strongest.timeMs) }) : i18n.t('ui.universe.field.quakeNone'));
    today.quake.setGo(strongest?.place ?? null, () => {
      if (strongest) go(strongest.lat, strongest.lon, VIEW_KM.quake);
    });
  };

  let quakesShown = '';
  return {
    element,
    update(view, slow) {
      const im = view.imagery;
      if (im && im.mode !== imageryMode) {
        imageryMode = im.mode;
        for (const [mode, b] of imageryButtons) b.setAttribute('aria-pressed', String(mode === im.mode));
      }
      if (!slow || !element.open) return;
      write(imageryHint, im?.mode === 'today' ? i18n.t('ui.universe.living.todayHint', { date: im.date }) : i18n.t('ui.universe.living.clearHint'));
      const living = view.living;
      if (!living) return;
      const sat = living.satellites;
      satStatus.hidden = !layerOn.satellites;
      write(
        satStatus,
        sat.state === 'loading'
          ? i18n.t('ui.universe.living.satLoading')
          : sat.state === 'ready'
            ? i18n.t('ui.universe.living.satReady', { count: f.number(sat.count), sunlit: f.number(sat.sunlit) })
            : sat.state === 'failed'
              ? i18n.t('ui.universe.living.satFailed')
              : sat.state === 'out-of-range'
                ? i18n.t('ui.universe.living.satStale')
                : '',
      );
      const chosen = sat.selected;
      selected.hidden = !chosen || !layerOn.satellites;
      if (chosen) {
        write(selectedText, i18n.t('ui.universe.living.selected', { name: satelliteName(chosen), altitude: f.distance(chosen.altitudeKm), period: period(chosen.periodMin), lit: lit(chosen.sunlit) }));
      }
      const qs = living.quakes;
      quakeStatus.hidden = !layerOn.quakes;
      write(
        quakeStatus,
        qs.state === 'loading'
          ? i18n.t('ui.universe.living.quakeLoading')
          : qs.state === 'ready'
            ? i18n.t('ui.universe.living.quakeReady', { count: qs.list.length })
            : qs.state === 'failed'
              ? i18n.t('ui.universe.living.quakeFailed')
              : '',
      );
      // Rebuilt only when the events listed change (never under the keyboard's focus as the minutes pass); their times are rewritten in place.
      const top = layerOn.quakes && qs.state === 'ready' ? qs.list.slice(0, QUAKES_LISTED) : [];
      const key = top.map((q) => q.id).join('|');
      if (key !== quakesShown) {
        quakesShown = key;
        quakeList.replaceChildren(
          ...top.map((q) =>
            h('li', { class: 'kf-living-line' }, h('span', { class: 'kf-living-line-text' }), goButton(q.place, () => {
              go(q.lat, q.lon, VIEW_KM.quake);
            })),
          ),
        );
      }
      top.forEach((q, i) => {
        const text = quakeList.children[i]?.firstElementChild;
        if (text instanceof HTMLElement) write(text, i18n.t('ui.universe.living.quakeItem', { magnitude: f.number(q.magnitude, 1), place: q.place, ago: ago(q.timeMs) }));
      });
      if (living.bulletin) writeBulletin(living.bulletin);
    },
  };
}
