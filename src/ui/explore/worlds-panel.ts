import worldsMessages from '../../i18n/en.worlds.json';
import type { App, UniverseView, WorldId } from '../../core/types';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * The navigator's "Small worlds" (src/explore/worlds): the small bodies' layer and its colouring by
 * group (pressed-or-not buttons), how many asteroids and comets are drawn and the asteroids' groups,
 * and a search over the worlds to fly to (moons, dwarf planets, notable asteroids and comets): each
 * match a button that flies there (the explorer's `world` command, as a tool would send it). Its own
 * chunk, loaded the first time the section opens (the section and its summary are the navigator's);
 * its strings travel with it (src/i18n/en.worlds.json). Opening it asks for the worlds if they have
 * not come yet.
 */

export interface WorldsPanel {
  readonly body: HTMLElement;
  update(view: UniverseView, slow: boolean): void;
}

/** At most this many matches are listed (the rest are counted). */
const MAX_RESULTS = 8;
const GROUPS = ['main', 'near', 'trojans', 'hildas', 'centaurs', 'kuiper'] as const;

export function createWorldsPanel(app: App, f: Formatters): WorldsPanel {
  const { i18n } = app;
  i18n.extend('en.worlds.json', worldsMessages);
  const toggle = (testId: string, key: string, send: (on: boolean) => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'kf-living-switch', 'aria-pressed': 'false', 'data-testid': testId }, h('span', { class: 'kf-living-switch-mark', 'aria-hidden': 'true' }), i18n.t(key));
    b.addEventListener('click', () => {
      // Pressed at once (the view follows within a frame), so a burst of presses alternates as it should.
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      send(on);
    });
    return b;
  };
  const layer = toggle('worlds-layer', 'ui.universe.worlds.layer', (on) => { app.earthCommand({ kind: 'smallBodies', on }); });
  const grouped = toggle('worlds-grouped', 'ui.universe.worlds.grouped', (on) => { app.earthCommand({ kind: 'smallBodiesGrouped', on }); });
  const intro = h('p', { class: 'kf-living-hint', 'data-testid': 'worlds-intro', role: 'status' }, i18n.t('ui.universe.worlds.loading'));
  const counts = h('dl', { class: 'kf-about-facts kf-worlds-groups', 'aria-label': i18n.t('ui.universe.worlds.groupsLabel'), 'data-testid': 'worlds-groups' });
  const values = GROUPS.map((g) => {
    const dd = h('dd', { 'data-testid': `worlds-group-${g}` });
    counts.append(h('dt', {}, i18n.t(`ui.universe.worlds.group.${g}`)), dd);
    return dd;
  });

  // Find a world: matches by name (or designation), each a button that flies there.
  const findId = uniqueId('worlds-find');
  const input = h('input', { id: findId, type: 'search', class: 'kf-living-input', placeholder: i18n.t('ui.universe.worlds.findPlaceholder'), autocomplete: 'off', spellcheck: 'false', 'data-testid': 'worlds-search' });
  const results = h('ul', { class: 'kf-living-list', 'data-testid': 'worlds-results' });
  const none = h('p', { class: 'kf-living-hint', hidden: true, 'data-testid': 'worlds-none' }, i18n.t('ui.universe.worlds.none'));
  const more = h('p', { class: 'kf-living-hint', hidden: true });
  let list: NonNullable<UniverseView['worlds']>['list'] = [];
  const kindOf = (w: (typeof list)[number]): string => (w.kind === 'moon' ? i18n.t('ui.universe.worlds.moonOf', { body: f.name(w.host) }) : i18n.t(`ui.universe.worlds.kind.${w.kind}`));
  const show = (): void => {
    const q = input.value.trim().toLowerCase();
    const found = q === '' ? list.filter((w) => w.kind !== 'moon' || ['w:Io', 'w:Europa', 'w:Ganymede', 'w:Callisto', 'w:Titan', 'w:Triton', 'w:Charon'].includes(w.id)) : list.filter((w) => w.name.toLowerCase().includes(q) || kindOf(w).toLowerCase().includes(q));
    none.hidden = q === '' || found.length > 0 || list.length === 0;
    more.hidden = found.length <= MAX_RESULTS;
    if (!more.hidden) more.textContent = i18n.t('ui.universe.worlds.more', { count: found.length - MAX_RESULTS });
    results.replaceChildren(
      ...found.slice(0, MAX_RESULTS).map((w) => {
        const b = h('button', { type: 'button', class: 'kf-living-place', 'data-testid': `worlds-go-${w.name}` }, h('span', { class: 'kf-living-place-name' }, w.name), ' ', h('span', { class: 'kf-living-place-where' }, kindOf(w)));
        b.addEventListener('click', () => {
          app.earthCommand({ kind: 'world', name: w.name });
        });
        return h('li', {}, b);
      }),
    );
  };
  input.addEventListener('input', show);
  const find = h('form', { class: 'kf-living-group', role: 'search' }, h('label', { class: 'kf-living-label', for: findId }, i18n.t('ui.universe.worlds.find')), input, none, results, more);
  find.addEventListener('submit', (event) => {
    event.preventDefault();
    results.querySelector('button')?.click();
  });
  const body = h(
    'div',
    { class: 'kf-about-body kf-worlds' },
    intro,
    h('div', { class: 'kf-living-group' }, layer, grouped),
    counts,
    find,
    h('p', { class: 'kf-about-sources' }, i18n.t('ui.universe.worlds.note')),
  );
  let shown = '';
  let asked = false;
  let current: WorldId | null = null;
  return {
    body,
    update(view, slow) {
      const w = view.worlds;
      if (!w) {
        // Opening the section asks for the worlds (once a visit), if they have not come yet.
        if (!asked) {
          asked = true;
          app.earthCommand({ kind: 'smallBodies', on: true });
        }
        return;
      }
      for (const [b, on] of [
        [layer, w.layer],
        [grouped, w.grouped],
      ] as const) {
        if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
      }
      grouped.disabled = !w.layer;
      if (list !== w.list) {
        list = w.list;
        show();
      }
      const focus = w.focus?.id ?? null;
      if (focus !== current) {
        current = focus;
        for (const b of results.querySelectorAll('button')) b.toggleAttribute('aria-current', b.dataset.testid === `worlds-go-${w.focus?.name ?? ''}`);
      }
      if (!slow) return;
      const key = `${w.asteroids}|${w.asteroidsLoaded}|${w.comets}|${w.tails}`;
      if (key === shown) return;
      shown = key;
      intro.textContent = i18n.t('ui.universe.worlds.intro', { asteroids: w.asteroids, loaded: w.asteroidsLoaded, comets: w.comets, tails: w.tails });
      GROUPS.forEach((g, i) => {
        const dd = values[i];
        if (dd) dd.textContent = f.number(w.layer ? w.groups[g] : 0);
      });
    },
  };
}
