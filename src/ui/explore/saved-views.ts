import { julianDateUtc } from '../../astro/time';
import { BODY_IDS, type App, type BodyId, type UniverseView, type WalkableWorld } from '../../core/types';
import { readPreferenceString, writePreferenceString } from '../preferences';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';
import { helpButton } from './help';

/**
 * Saved views (ledger GR-4): the world in view, the place beneath the camera and its height, the
 * date, and on foot the walker's place, heading and look, kept in this browser under a name (a
 * per-viewer convenience: nothing leaves the browser, and nothing breaks without storage). Going back
 * to one sets its date, travels to its world if the camera is elsewhere, glides over its place, and
 * on foot begins the walk again, facing as it did.
 */

export interface SavedViews {
  readonly element: HTMLDetailsElement;
  update(view: UniverseView): void;
}

export interface Saved {
  id: string;
  name: string;
  body: BodyId;
  lat: number;
  lon: number;
  altitudeKm: number;
  jdUtc: number;
  walk: { world: WalkableWorld; lat: number; lon: number; headingDeg: number; pitchDeg: number } | null;
}

const STORE = 'savedViews';
/** The most views kept. */
const MAX_SAVED = 50;
const WALKABLE: readonly string[] = ['earth', 'moon', 'mars', 'mercury', 'venus'];
const UNIX_EPOCH_JD = 2440587.5;

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The stored list, newest first, keeping only well-formed entries (storage is the visitor's own, and may hold anything). */
export function load(): Saved[] {
  try {
    const raw: unknown = JSON.parse(readPreferenceString(STORE) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is Saved => {
      if (typeof x !== 'object' || x === null) return false;
      const s = x as Record<string, unknown>;
      const walk = s.walk as Record<string, unknown> | null | undefined;
      const walkOk = walk === null || (typeof walk === 'object' && typeof walk.world === 'string' && WALKABLE.includes(walk.world) && isNumber(walk.lat) && isNumber(walk.lon) && isNumber(walk.headingDeg) && isNumber(walk.pitchDeg));
      return typeof s.id === 'string' && typeof s.name === 'string' && typeof s.body === 'string' && (BODY_IDS as readonly string[]).includes(s.body) && isNumber(s.lat) && isNumber(s.lon) && isNumber(s.altitudeKm) && isNumber(s.jdUtc) && walkOk;
    }).slice(0, MAX_SAVED);
  } catch {
    return [];
  }
}

export function createSavedViews(app: App, f: Formatters, onGo: () => void): SavedViews {
  const { i18n } = app;
  let saved = load();
  let latest: UniverseView | null = null;
  /** A walk to begin again once the trip to its world has arrived. */
  let pendingWalk: Saved['walk'] = null;

  const nameId = uniqueId('saved-name');
  const nameInput = h('input', { id: nameId, type: 'text', class: 'kf-living-input', maxlength: '60', autocomplete: 'off', 'data-testid': 'saved-name' });
  const saveButton = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'saved-save' }, i18n.t('ui.universe.saved.save'));
  const notice = h('p', { class: 'kf-living-hint', 'data-testid': 'saved-notice', hidden: true });
  const empty = h('p', { class: 'kf-living-hint', 'data-testid': 'saved-empty' }, i18n.t('ui.universe.saved.empty'));
  const list = h('ul', { class: 'kf-living-places', 'data-testid': 'saved-list' });
  const summary = h('summary', {}, i18n.t('ui.universe.saved.title'));
  const element = h(
    'details',
    { class: 'kf-nav-saved', 'data-testid': 'saved-views' },
    summary,
    h(
      'div',
      { class: 'kf-living-body' },
      h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.saved.intro'), helpButton(app, 'saved', i18n.t('ui.universe.saved.title'))),
      h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: nameId }, i18n.t('ui.universe.saved.name')), nameInput, saveButton, notice),
      empty,
      list,
    ),
  );

  const dateOf = (jdUtc: number): string => new Date((jdUtc - UNIX_EPOCH_JD) * 86_400_000).toLocaleDateString(i18n.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const describe = (s: Saved): string =>
    s.walk
      ? i18n.t('ui.universe.saved.onFoot', { body: f.name(s.walk.world), place: f.coordinates(s.walk.lat, s.walk.lon, 2), date: dateOf(s.jdUtc) })
      : i18n.t('ui.universe.saved.over', { body: f.name(s.body), height: f.distance(Math.max(0, s.altitudeKm)), place: f.coordinates(s.lat, s.lon, 2), date: dateOf(s.jdUtc) });

  const store = (): void => {
    writePreferenceString(STORE, JSON.stringify(saved));
  };

  const render = (): void => {
    empty.hidden = saved.length > 0;
    list.replaceChildren(
      ...saved.map((s) => {
        const go = h('button', { type: 'button', class: 'kf-btn', 'data-testid': `saved-go-${s.id}`, 'aria-label': i18n.t('ui.universe.saved.goLabel', { name: s.name }) }, i18n.t('ui.universe.saved.go'));
        go.addEventListener('click', () => {
          goTo(s);
        });
        const remove = h('button', { type: 'button', class: 'kf-btn', 'data-testid': `saved-delete-${s.id}`, 'aria-label': i18n.t('ui.universe.saved.deleteLabel', { name: s.name }) }, i18n.t('ui.universe.saved.delete'));
        remove.addEventListener('click', () => {
          saved = saved.filter((x) => x.id !== s.id);
          store();
          render();
        });
        return h('li', { class: 'kf-living-place-row', 'data-testid': `saved-${s.id}` }, h('span', { class: 'kf-living-place-name' }, s.name), h('span', { class: 'kf-living-place-where' }, describe(s)), h('span', { class: 'kf-lab-row' }, go, remove));
      }),
    );
  };

  const goTo = (s: Saved): void => {
    app.universeTime({ kind: 'date', jdUtc: s.jdUtc });
    app.earthCommand({ kind: 'view', body: s.body, lat: s.lat, lon: s.lon, altitudeKm: s.altitudeKm });
    pendingWalk = s.walk;
    onGo();
  };

  saveButton.addEventListener('click', () => {
    const v = latest;
    if (!v) return;
    const place = v.place;
    const w = v.walk;
    if (!place && !w) return;
    if (saved.length >= MAX_SAVED) {
      notice.hidden = false;
      notice.textContent = i18n.t('ui.universe.saved.full');
      return;
    }
    notice.hidden = true;
    const jdUtc = julianDateUtc(v.unixMs);
    const body = w ? w.world : (place?.body ?? v.focus);
    const name = nameInput.value.trim() || i18n.t('ui.universe.saved.defaultName', { body: f.name(body), date: dateOf(jdUtc) });
    const entry: Saved = {
      id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      name,
      body,
      // On foot, the view to come back to is over the walker, from the lowest orbit (the walk then lands there).
      lat: w ? w.lat : (place?.lat ?? 0),
      lon: w ? w.lon : (place?.lon ?? 0),
      altitudeKm: w ? 0 : (place?.altitudeKm ?? 0),
      jdUtc,
      walk: w ? { world: w.world, lat: w.lat, lon: w.lon, headingDeg: w.headingDeg, pitchDeg: w.pitchDeg } : null,
    };
    saved = [entry, ...saved];
    store();
    nameInput.value = '';
    render();
  });

  render();
  return {
    element,
    update(view) {
      latest = view;
      saveButton.disabled = view.place === null && view.walk === null;
      // A saved walk begins once its world is reached (a trip under way would end it).
      const w = pendingWalk;
      if (w && view.focus === w.world && view.trip === null && view.place !== null) {
        pendingWalk = null;
        app.earthCommand({ kind: 'walk', world: w.world, lat: w.lat, lon: w.lon, headingDeg: w.headingDeg, pitchDeg: w.pitchDeg });
      }
    },
  };
}
