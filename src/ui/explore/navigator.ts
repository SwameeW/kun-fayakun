import { BODY_IDS, type App, type BodyId, type UniverseView } from '../../core/types';
import { h, uniqueId } from '../dom';
import { icon } from '../icons';
import { createBodyIcon, type BodyIcon } from './body-icon';
import type { Formatters } from './format';
import { createOrrery } from './orrery';
import { createQualityMenu } from './quality-menu';

/**
 * The celestial navigator: every world the explorer shows, each with a small live portrait (lit as
 * the camera sees it), its distance and how long its light takes to arrive, all live from the
 * ephemeris; a compact orrery to fly by; the phenomena seen on this visit; the detail menu; and the
 * keys. On a wide screen it is a side panel (folding to a rail of portraits); on a phone a bottom
 * sheet (folding to a row of them). Every move is a real button: the list works by keyboard and
 * screen reader, the map is a pointer shortcut to the same moves.
 */

export interface Navigator {
  readonly element: HTMLElement;
  /** 'panel' (wide screens) or 'sheet' (phones), and whether it is folded. */
  readonly layout: 'panel' | 'sheet';
  readonly expanded: boolean;
  update(view: UniverseView, slow: boolean): void;
  /** Folds it (a phone's sheet after a choice, so the view is clear for the trip). */
  setExpanded(expanded: boolean): void;
  closeMenus(): boolean;
  /** Called when its size or layout changes (the explorer reframes around it). */
  onResize(fn: () => void): void;
}

/** Wide enough (and tall enough) for the side panel; otherwise the bottom sheet. */
const PANEL_QUERY = '(min-width: 900px) and (min-height: 560px)';

export function createNavigator(app: App, f: Formatters): Navigator {
  const { i18n } = app;
  const panelQuery = window.matchMedia(PANEL_QUERY);
  const coarse = window.matchMedia('(pointer: coarse)');
  const listId = uniqueId('nav-list');
  const bodyId = uniqueId('nav-body');

  const toggleText = h('span', { class: 'kf-nav-toggle-text' });
  const toggle = h('button', { type: 'button', class: 'kf-nav-toggle', 'aria-expanded': 'true', 'aria-controls': bodyId, 'data-testid': 'universe-nav-toggle' }, h('span', { class: 'kf-nav-grip', 'aria-hidden': 'true' }), icon('chevron'), toggleText);
  const title = h('h2', { class: 'kf-nav-title' }, i18n.t('ui.universe.navigator'));
  const head = h('div', { class: 'kf-nav-head' }, title, toggle);

  const orrery = createOrrery(
    (id) => {
      go(id);
    },
    (id) => f.name(id),
  );
  const caption = h('p', { class: 'kf-nav-caption' }, i18n.t('ui.universe.orreryCaption'));
  const map = h('div', { class: 'kf-nav-map' }, orrery.element, caption);

  // One button per world: in the list (with its distance beside it) and, folded, as a portrait chip.
  const rows = new Map<BodyId, { button: HTMLButtonElement; icon: BodyIcon; distance: HTMLElement; light: HTMLElement; row: HTMLElement }>();
  const list = h('ul', { id: listId, class: 'kf-nav-list', 'aria-label': i18n.t('ui.universe.bodies') });
  for (const id of BODY_IDS) {
    const portrait = createBodyIcon(id);
    const button = h('button', { type: 'button', class: 'kf-nav-body', 'aria-pressed': 'false', 'data-body': id }, portrait.element, h('span', { class: 'kf-nav-name' }, f.name(id)));
    button.addEventListener('click', () => {
      go(id);
    });
    const distance = h('span', { class: 'kf-nav-distance' });
    const light = h('span', { class: 'kf-nav-light' });
    const row = h('li', { class: 'kf-nav-row', 'data-body': id }, button, h('span', { class: 'kf-nav-meta' }, distance, light));
    rows.set(id, { button, icon: portrait, distance, light, row });
    list.append(row);
  }

  const seenList = h('ul', { class: 'kf-nav-seen-list' });
  const seenEmpty = h('p', { class: 'kf-nav-seen-empty' }, i18n.t('ui.universe.seenEmpty'));
  const seen = h('details', { class: 'kf-nav-seen', 'data-testid': 'universe-seen' }, h('summary', {}, i18n.t('ui.universe.seen')), seenEmpty, seenList);
  // Opened at the foot of the list, it scrolls into view rather than opening out of sight.
  seen.addEventListener('toggle', () => {
    if (seen.open) seen.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });

  const quality = createQualityMenu(app);
  const keys = h(
    'details',
    { class: 'kf-nav-keys' },
    h('summary', {}, i18n.t(coarse.matches ? 'ui.universe.touchTitle' : 'ui.universe.keysTitle')),
    h('p', {}, i18n.t(coarse.matches ? 'ui.universe.touchList' : 'ui.universe.keysList')),
  );
  // The foot stays put below the scrolling part, so the detail menu can open over the list.
  const foot = h('div', { class: 'kf-nav-foot' }, keys, quality.element);
  const body = h('div', { id: bodyId, class: 'kf-nav-body-wrap' }, map, list, seen);

  const element = h('nav', { class: 'kf-nav', 'aria-label': i18n.t('ui.universe.navigator'), 'data-testid': 'universe-bodies' }, head, body, foot);

  let layout: 'panel' | 'sheet' = panelQuery.matches ? 'panel' : 'sheet';
  let expanded = layout === 'panel';
  const resizeListeners = new Set<() => void>();
  const notify = (): void => {
    for (const fn of resizeListeners) fn();
  };

  const apply = (): void => {
    element.classList.toggle('is-panel', layout === 'panel');
    element.classList.toggle('is-sheet', layout === 'sheet');
    element.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggleText.textContent = i18n.t(expanded ? 'ui.universe.navigatorHide' : 'ui.universe.navigatorShow');
    // Folded, the list stays (as portraits); the map, the log and the menu go.
    for (const el of [map, seen, foot]) el.hidden = !expanded;
    for (const { row } of rows.values()) row.classList.toggle('is-chip', !expanded);
    if (!expanded) quality.close();
    notify();
  };

  const setExpanded = (next: boolean): void => {
    if (next === expanded) return;
    const hadFocus = element.contains(document.activeElement) && document.activeElement !== toggle;
    expanded = next;
    apply();
    // Focus inside what folded away goes to the toggle, never to the page.
    if (hadFocus && !expanded && document.activeElement instanceof HTMLElement && document.activeElement.closest('[hidden]')) toggle.focus();
  };
  toggle.addEventListener('click', () => {
    setExpanded(!expanded);
  });
  panelQuery.addEventListener('change', () => {
    layout = panelQuery.matches ? 'panel' : 'sheet';
    expanded = layout === 'panel';
    apply();
  });
  new ResizeObserver(notify).observe(element);

  const go = (id: BodyId): void => {
    app.focusBody(id);
    // On a phone the sheet folds so the trip has the screen.
    if (layout === 'sheet') setExpanded(false);
  };

  let seenShown = -1;
  apply();

  return {
    element,
    get layout() {
      return layout;
    },
    get expanded() {
      return expanded;
    },
    update(view, slow) {
      for (const b of view.bodies) {
        const row = rows.get(b.id);
        if (!row) continue;
        const pressed = String(b.id === view.focus);
        if (row.button.getAttribute('aria-pressed') !== pressed) row.button.setAttribute('aria-pressed', pressed);
        if (!slow) continue;
        row.icon.update(b);
        const d = f.distance(b.distanceKm);
        if (row.distance.textContent !== d) row.distance.textContent = d;
        const l = i18n.t('ui.universe.lightTime', { time: f.lightTime(b.lightSeconds) });
        if (row.light.textContent !== l) row.light.textContent = l;
      }
      if (slow && expanded) orrery.update(view);
      if (view.witnessed.length !== seenShown) {
        seenShown = view.witnessed.length;
        seenEmpty.hidden = seenShown > 0;
        seenList.replaceChildren(...view.witnessed.map((id) => h('li', {}, i18n.t(`ui.universe.seen.${id}`))));
      }
      quality.update(view.detail);
    },
    setExpanded,
    closeMenus() {
      if (quality.open) {
        quality.close();
        return true;
      }
      return false;
    },
    onResize(fn) {
      resizeListeners.add(fn);
    },
  };
}
