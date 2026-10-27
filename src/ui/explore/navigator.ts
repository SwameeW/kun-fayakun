import { BODY_IDS, type App, type BodyId, type UniverseView } from '../../core/types';
import { h, uniqueId } from '../dom';
import { icon } from '../icons';
import { sound as soundChoice } from '../sound-preference';
import { createBodyIcon, type BodyIcon } from './body-icon';
import type { Formatters } from './format';
import { once, waiting, type Waiting } from './lazy';
import '../styles/living.css';
import { createOrrery } from './orrery';
import { createQualityMenu } from './quality-menu';
import { helpButton } from './help';

/**
 * The celestial navigator: every world the explorer shows, each with a small live portrait (lit as
 * the camera sees it), its distance and how long its light takes to arrive, all live from the
 * ephemeris; the time machine (at its head); a compact orrery to fly by; about the world in view
 * (./about: its size, mass, gravity, day, year and orbit, to scale beside the Earth); the Living Earth (./living-earth: its imagery, live layers,
 * place search and field notes); the qibla and the new moon (./islamic-panel); the phenomena seen on this visit (its summary says how many
 * entries it holds; no totals, no scores); the detail menu; and the keys. On a wide screen it is a
 * side panel (folding to a rail of portraits, which scrolls where the window is short); on a phone a
 * bottom sheet (folding to a row of them) that puts the list first, the log next and the orrery last
 * as a small strip, sized to what it holds. Where its body scrolls it fades at the edge with more
 * beyond (never a line cut in half). Every move is a real button (the world in view marked
 * aria-current): the list works by keyboard and screen reader, the map is a pointer shortcut to the
 * same moves.
 *
 * Folded, only the portraits stay (in an experiment, its worlds; among the stars, none): every panel
 * and section folds away, the laboratory's and the stars' too, and comes back as it was. Sections read
 * only when opened (About, the sky, saved views, the Living Earth, the qibla) and the laboratory's and
 * the stars' panels are chunks of their own (./lazy), each loaded once when first wanted, with a line
 * while it comes and a way to try again if it does not.
 */

export interface Navigator {
  readonly element: HTMLElement;
  /** 'panel' (wide screens) or 'sheet' (phones), and whether it is folded. */
  readonly layout: 'panel' | 'sheet';
  readonly expanded: boolean;
  update(view: UniverseView, slow: boolean): void;
  /** Folds it (a phone's sheet after a choice, so the view is clear for the trip). */
  setExpanded(expanded: boolean): void;
  /** Called when its size or layout changes (the explorer reframes around it). */
  onResize(fn: () => void): void;
}

/** Wide enough (and tall enough) for the side panel; otherwise the bottom sheet. */
const PANEL_QUERY = '(min-width: 900px) and (min-height: 560px)';
/** The navigator's Walk here, under each world it offers a walk on. */
const WALK_HINTS = { moon: 'ui.universe.walk.hereMoon', mars: 'ui.universe.walk.hereMars', mercury: 'ui.universe.walk.hereMercury', venus: 'ui.universe.walk.hereVenus' } as const;

/** `time`: the time machine's line (./time-control and photo mode's button), placed at the head of the body. */
export function createNavigator(app: App, f: Formatters, onApplied: (title: string, line: string) => void, time: HTMLElement): Navigator {
  const { i18n } = app;
  const panelQuery = window.matchMedia(PANEL_QUERY);
  const coarse = window.matchMedia('(pointer: coarse)');
  const listId = uniqueId('nav-list');
  const bodyId = uniqueId('nav-body');
  const smooth = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

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
  const caption = h('p', { class: 'kf-nav-caption' }, i18n.t('ui.universe.orreryCaption'), helpButton(app, 'orrery', i18n.t('ui.help.label.orrery')));
  const map = h('div', { class: 'kf-nav-map' }, orrery.element, caption);

  // One button per world: in the list (with its distance beside it) and, folded, as a portrait chip.
  const rows = new Map<BodyId, { button: HTMLButtonElement; icon: BodyIcon; distance: HTMLElement; light: HTMLElement; row: HTMLElement }>();
  const list = h('ul', { id: listId, class: 'kf-nav-list', 'aria-label': i18n.t('ui.universe.bodies') });
  // What the list's figures mean, beneath it (not on any row, whose buttons fly).
  const listHead = h('p', { class: 'kf-nav-list-head' }, h('span', {}, i18n.t('ui.universe.listHead')), helpButton(app, 'distance', i18n.t('ui.help.label.distance')), helpButton(app, 'lightTime', i18n.t('ui.help.label.lightTime')));
  for (const id of BODY_IDS) {
    const portrait = createBodyIcon(id);
    const button = h('button', { type: 'button', class: 'kf-nav-body', 'data-body': id }, portrait.element, h('span', { class: 'kf-nav-name' }, f.name(id)));
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
  const seenEmpty = h('p', { class: 'kf-nav-seen-empty' }, i18n.t('ui.universe.seenEmpty'), helpButton(app, 'seen', i18n.t('ui.universe.seen')));
  const seenSummary = h('summary', {}, i18n.t('ui.universe.seen'));
  const seen = h('details', { class: 'kf-nav-seen', 'data-testid': 'universe-seen' }, seenSummary, seenEmpty, seenList);
  // Opened at the foot of the list, it scrolls into view rather than opening out of sight.
  seen.addEventListener('toggle', () => {
    if (seen.open) seen.scrollIntoView({ block: 'nearest', behavior: smooth() });
    requestAnimationFrame(edge);
  });

  /**
   * A section whose body is a chunk of its own, loaded the first time it opens (./lazy): once, however
   * often it is opened and closed while on its way, with a line while it comes and a way to try again if
   * it does not (opening it again tries again too). `opened` runs each time it opens once there.
   */
  const lazySection = <M, P>(section: HTMLDetailsElement, load: () => Promise<M>, create: (m: M) => P, bodyOf: (p: P) => HTMLElement, opened?: (p: P) => void): { readonly part: P | null } => {
    const state: { part: P | null } = { part: null };
    let loading = false;
    let wait: Waiting | null = null;
    const fetch = (): void => {
      if (state.part || loading) return;
      loading = true;
      if (!wait) {
        wait = waiting(app, fetch);
        section.append(wait.element);
      }
      load()
        .then((m) => {
          const p = create(m);
          state.part = p;
          const hadFocus = wait?.element.contains(document.activeElement) ?? false;
          wait?.element.remove();
          wait = null;
          section.append(bodyOf(p));
          if (hadFocus) section.querySelector('summary')?.focus();
          if (section.open) opened?.(p);
          requestAnimationFrame(edge);
        })
        .catch((err: unknown) => {
          console.warn('explore: a section of the navigator did not load', err);
          wait?.failed();
        })
        .finally(() => {
          loading = false;
        });
    };
    section.addEventListener('toggle', () => {
      if (section.open && state.part) opened?.(state.part);
      else if (section.open) fetch();
      requestAnimationFrame(edge);
    });
    return state;
  };

  // About the world in view (its facts from cited data), under the list; then the sky's layers; and
  // saved views: one chunk (./sections), their summaries here from the first frame.
  const sections = once(() => import('./sections'));
  const aboutSummary = h('summary', {}, i18n.t('ui.universe.about.title', { body: f.name('earth') }));
  const aboutSection = h('details', { class: 'kf-nav-about', 'data-testid': 'universe-about' }, aboutSummary);
  const about = lazySection(aboutSection, sections, (m) => m.createAbout(app, f), (p) => p.body);
  let aboutFor: BodyId = 'earth';
  const skySection = h('details', { class: 'kf-nav-about kf-nav-sky', 'data-testid': 'universe-sky' }, h('summary', {}, i18n.t('ui.universe.sky.title')));
  const sky = lazySection(skySection, sections, (m) => m.createSkyPanel(app, f), (p) => p.body);

  /** A panel has just come, or its mode been entered: brought into view from its top on the next update. */
  let toPanel = false;
  /**
   * The laboratory's panel and the stars': chunks of their own, loaded with the first experiment (or
   * visit) into their slot at the head of the body; a line while they come, and if they do not, a way to
   * try again (entering the mode again tries again too) and `leave`, a way out of the mode.
   */
  const lazyPanel = <M, P extends { readonly element: HTMLElement }>(slot: HTMLElement, load: () => Promise<M>, create: (m: M) => P, leave: HTMLElement): { readonly part: P | null; want(entering: boolean): void } => {
    let part: P | null = null;
    let loading = false;
    let wait: Waiting | null = null;
    const fetch = (): void => {
      if (part || loading) return;
      loading = true;
      if (!wait) {
        wait = waiting(app, fetch, leave);
        slot.replaceChildren(wait.element);
      }
      load()
        .then((m) => {
          const p = create(m);
          part = p;
          const hadFocus = wait?.element.contains(document.activeElement) ?? false;
          wait = null;
          slot.replaceChildren(p.element);
          if (hadFocus) p.element.querySelector<HTMLElement>('button, summary')?.focus();
          // In view from its top as it comes (the visitor had scrolled down to the way in).
          toPanel = true;
        })
        .catch((err: unknown) => {
          console.warn('explore: a panel of the navigator did not load', err);
          wait?.failed();
        })
        .finally(() => {
          loading = false;
        });
    };
    return {
      get part() {
        return part;
      },
      want(entering) {
        if (!part && !loading && (!wait || entering)) fetch();
      },
    };
  };

  // The orbital laboratory: its panel (its own chunk, loaded with the first experiment) heads the body during one; outside one, a way in.
  const labSlot = h('div', { class: 'kf-nav-lab-slot' });
  const labLeave = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'lab-leave' }, i18n.t('ui.universe.lab.leave'));
  labLeave.addEventListener('click', () => {
    app.closeLab();
  });
  const lab = lazyPanel(labSlot, () => import('./lab-panel'), (m) => m.createLabPanel(app, f), labLeave);
  const labOpen = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'lab-open' }, i18n.t('ui.universe.lab.open'));
  labOpen.addEventListener('click', () => {
    app.openLab();
  });
  const labEntry = h('div', { class: 'kf-nav-lab-entry' }, labOpen, h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.openHint'), helpButton(app, 'lab', i18n.t('ui.universe.lab.open'))));

  // On foot on the Moon, Mars, Mercury or Venus, at the point below (the Earth's walk is in its Living Earth): shown with that world in view.
  const walkGo = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'world-walk' }, i18n.t('ui.universe.walk.here'));
  const walkHint = h('p', { class: 'kf-living-hint' });
  walkGo.addEventListener('click', () => {
    app.earthCommand({ kind: 'walk' });
    if (layout === 'sheet') setExpanded(false);
  });
  const walkEntry = h('div', { class: 'kf-nav-lab-entry', 'data-testid': 'world-walk-entry', hidden: true }, walkGo, h('div', { class: 'kf-help-row' }, walkHint, helpButton(app, 'walk', i18n.t('ui.universe.walk.here'))));
  // Down through the clouds of Venus or Jupiter, where a probe went (ledger GR-6): shown with that world in view.
  const descentGo = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'world-descent' }, i18n.t('ui.universe.descent.here'));
  const descentHint = h('p', { class: 'kf-living-hint' });
  let descentWorld: 'venus' | 'jupiter' | null = null;
  descentGo.addEventListener('click', () => {
    if (!descentWorld) return;
    app.earthCommand({ kind: 'descent', world: descentWorld });
    if (layout === 'sheet') setExpanded(false);
  });
  const descentEntry = h('div', { class: 'kf-nav-lab-entry', 'data-testid': 'world-descent-entry', hidden: true }, descentGo, h('div', { class: 'kf-help-row' }, descentHint, helpButton(app, 'descent', i18n.t('ui.universe.descent.here'))));

  // Among the stars (ledger IS-3): a way out past the planets; its panel (its own chunk) heads the body while there.
  const starsOpen = h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': 'stars-open' }, i18n.t('ui.universe.stars.open'));
  starsOpen.addEventListener('click', () => {
    app.earthCommand({ kind: 'stars' });
    if (layout === 'sheet') setExpanded(false);
  });
  const starsEntry = h('div', { class: 'kf-nav-lab-entry', 'data-testid': 'stars-entry' }, starsOpen, h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.stars.openHint'), helpButton(app, 'stars', i18n.t('ui.universe.stars.open'))));
  const starsSlot = h('div', { class: 'kf-nav-lab-slot' });
  const starsLeave = h('button', { type: 'button', class: 'kf-living-go', 'data-testid': 'stars-leave' }, i18n.t('ui.universe.stars.leave'));
  starsLeave.addEventListener('click', () => {
    app.earthCommand({ kind: 'starsEnd' });
  });
  const stars = lazyPanel(starsSlot, () => import('./neighbourhood-panel'), (m) => m.createNeighbourhoodPanel(app, f), starsLeave);

  // Saved views (place, height, date; on foot the walk): going back to one folds the sheet on a phone.
  const savedSection = h('details', { class: 'kf-nav-saved', 'data-testid': 'saved-views' }, h('summary', {}, i18n.t('ui.universe.saved.title')));
  const saved = lazySection(
    savedSection,
    sections,
    (m) =>
      m.createSavedViews(app, f, () => {
        if (layout === 'sheet') setExpanded(false);
      }),
    (p) => p.body,
  );

  // The Living Earth: a section whose body (its own chunk) loads when it first opens. On a phone a
  // flight from it folds the sheet, as choosing a world does.
  const living = h('details', { class: 'kf-nav-living', 'data-testid': 'living-earth' }, h('summary', {}, i18n.t('ui.universe.living.title')));
  const livingPanel = lazySection(
    living,
    once(() => import('./living-earth')),
    (m) =>
      m.createLivingEarth(app, f, () => {
        if (layout === 'sheet') setExpanded(false);
      }),
    (p) => p.body,
    (p) => {
      p.opened();
    },
  );

  // The qibla and the new moon: a section whose panel (its own chunk, with the astronomy behind it) loads when first opened.
  const islamic = h('details', { class: 'kf-nav-islamic', 'data-testid': 'universe-islamic' }, h('summary', {}, i18n.t('ui.universe.islamic.title')));
  const islamicPanel = lazySection(
    islamic,
    once(() => import('./islamic-panel')),
    (m) =>
      m.createIslamicPanel(app, f, () => {
        if (layout === 'sheet') setExpanded(false);
      }),
    (p) => p.element,
  );
  // Opened at the foot of the list, these scroll into view rather than opening out of sight.
  for (const section of [living, islamic]) {
    section.addEventListener('toggle', () => {
      if (section.open) section.scrollIntoView({ block: 'nearest', behavior: smooth() });
    });
  }

  const quality = createQualityMenu(app, onApplied);
  // Sound where there is air (ledger CR-6): one choice with the film's speaker (../sound-preference), kept for the next visit.
  let shownSound: boolean | null = null;
  const soundValue = h('span', { class: 'kf-nav-detail-value' });
  const soundButton = h('button', { type: 'button', class: 'kf-btn kf-nav-detail-button', 'aria-pressed': String(soundChoice.get()), title: i18n.t('ui.universe.sound.hint'), 'data-testid': 'universe-sound' }, h('span', { class: 'kf-nav-detail-label' }, i18n.t('ui.universe.sound.label')), soundValue);
  const showSound = (): void => {
    const on = soundChoice.get();
    if (on === shownSound) return;
    shownSound = on;
    soundButton.setAttribute('aria-pressed', String(on));
    soundValue.textContent = i18n.t(on ? 'ui.universe.sound.on' : 'ui.universe.sound.off');
  };
  showSound();
  soundButton.addEventListener('click', () => {
    soundChoice.set(!soundChoice.get());
    showSound();
    app.earthCommand({ kind: 'sound', on: soundChoice.get() });
  });
  const sound = h('div', { class: 'kf-nav-sound' }, soundButton, helpButton(app, 'sound', i18n.t('ui.universe.sound.label')));
  const keys = h(
    'details',
    { class: 'kf-nav-keys' },
    h('summary', {}, i18n.t(coarse.matches ? 'ui.universe.touchTitle' : 'ui.universe.keysTitle')),
    h('p', {}, i18n.t(coarse.matches ? 'ui.universe.touchList' : 'ui.universe.keysList')),
  );
  // The foot stays put below the scrolling part, so the detail menu can open over the list.
  // Detail and Sound share a row, so the foot keeps its height and the list its room on a phone.
  const foot = h('div', { class: 'kf-nav-foot' }, keys, h('div', { class: 'kf-nav-foot-row' }, quality.element, sound));
  const body = h('div', { id: bodyId, class: 'kf-nav-body-wrap' }, time, labSlot, starsSlot, map, list, listHead, aboutSection, walkEntry, descentEntry, skySection, savedSection, starsEntry, labEntry, living, islamic, seen);

  const element = h('nav', { class: 'kf-nav', 'aria-label': i18n.t('ui.universe.navigator'), 'data-testid': 'universe-bodies' }, head, body, foot);

  let layout: 'panel' | 'sheet' = panelQuery.matches ? 'panel' : 'sheet';
  let expanded = layout === 'panel';
  const resizeListeners = new Set<() => void>();
  const notify = (): void => {
    for (const fn of resizeListeners) fn();
  };

  /** Where the explorer is (an experiment, among the stars) and what the world in view offers (a walk, a descent): set by update. */
  let inLab = false;
  let inStars = false;
  let walkHere = false;
  let descentHere = false;
  /** The experiment's bodies, as a key ("|earth|moon|"), for the worlds' rows shown during one. */
  let labBodies = '';
  /**
   * What shows: folded, only the portraits (in an experiment, its worlds; among the stars, none); open,
   * every section, the solar system's stepping aside in an experiment or among the stars, whose panel
   * heads the body instead.
   */
  const show = (): void => {
    const aside = inLab || inStars;
    const set = (el: HTMLElement, hidden: boolean): void => {
      if (el.hidden !== hidden) el.hidden = hidden;
    };
    set(time, !expanded);
    set(labSlot, !expanded || !inLab);
    set(starsSlot, !expanded || !inStars);
    set(map, !expanded || inStars);
    set(listHead, !expanded || inStars);
    set(skySection, !expanded || inStars);
    for (const el of [aboutSection, savedSection, starsEntry, labEntry, living, islamic]) set(el, !expanded || aside);
    set(walkEntry, !expanded || aside || !walkHere);
    set(descentEntry, !expanded || aside || !descentHere);
    set(seen, !expanded);
    set(foot, !expanded);
    for (const [id, r] of rows) set(r.row, inStars || (inLab && !labBodies.includes(`|${id}|`)));
  };

  const apply = (): void => {
    element.classList.toggle('is-panel', layout === 'panel');
    element.classList.toggle('is-sheet', layout === 'sheet');
    element.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggleText.textContent = i18n.t(expanded ? 'ui.universe.navigatorHide' : 'ui.universe.navigatorShow');
    show();
    for (const { row } of rows.values()) row.classList.toggle('is-chip', !expanded);
    if (!expanded) quality.close();
    notify();
    requestAnimationFrame(edge);
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
  // Where the body scrolls on, above or below, that edge fades (a line is never simply cut off).
  const edge = (): void => {
    body.classList.toggle('has-above', body.scrollTop > 2);
    body.classList.toggle('has-more', body.scrollTop + body.clientHeight < body.scrollHeight - 2);
  };
  body.addEventListener('scroll', edge, { passive: true });
  new ResizeObserver(edge).observe(body);

  const go = (id: BodyId): void => {
    app.focusBody(id);
    // On a phone the sheet folds so the trip has the screen.
    if (layout === 'sheet') setExpanded(false);
  };

  let seenShown = -1;
  /** The mode at the last update (an experiment, among the stars), for the moment one is entered or left. */
  let wasIn: 'lab' | 'stars' | null = null;
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
      // The explorer starts with sound on: told the visitor's choice once it is there to hear it (or as the film's speaker changes it).
      showSound();
      if (view.sound.on !== soundChoice.get()) app.earthCommand({ kind: 'sound', on: soundChoice.get() });
      for (const b of view.bodies) {
        const row = rows.get(b.id);
        if (!row) continue;
        // The world in view: aria-current (a navigation list's "you are here"), not a toggle's pressed state.
        const current = b.id === view.focus;
        if (row.button.hasAttribute('aria-current') !== current) {
          if (current) row.button.setAttribute('aria-current', 'true');
          else row.button.removeAttribute('aria-current');
        }
        if (!slow) continue;
        row.icon.update(b);
        const d = f.distance(b.distanceKm);
        if (row.distance.textContent !== d) row.distance.textContent = d;
        const l = i18n.t('ui.universe.lightTime', { time: f.lightTime(b.lightSeconds) });
        if (row.light.textContent !== l) row.light.textContent = l;
      }
      if (slow && expanded) orrery.update(view);
      // Where the explorer is, folded or not (so folding in an experiment, or leaving one folded, shows
      // only what belongs): in an experiment or among the stars their panel (loaded the first time)
      // heads the body, and the real world's facts and live observations step aside.
      inLab = view.lab !== null;
      inStars = view.neighbourhood !== null;
      labBodies = view.lab ? `|${view.lab.bodies.map((b) => b.id).join('|')}|` : '';
      // A walk on the world in view (not the Earth, whose walk is in its Living Earth), once it is drawn at its true size (walkHere says so).
      const walkWorld = view.focus === 'moon' || view.focus === 'mars' || view.focus === 'mercury' || view.focus === 'venus' ? view.focus : null;
      const onFoot = view.walk !== null || view.descent !== null;
      walkHere = walkWorld !== null && !onFoot;
      if (walkWorld) {
        walkGo.disabled = view.walkHere?.world !== walkWorld;
        const hint = i18n.t(WALK_HINTS[walkWorld]);
        if (walkHint.textContent !== hint) walkHint.textContent = hint;
      }
      descentWorld = view.focus === 'venus' || view.focus === 'jupiter' ? view.focus : null;
      descentHere = descentWorld !== null && !onFoot;
      if (descentWorld) {
        const hint = i18n.t(descentWorld === 'venus' ? 'ui.universe.descent.hereVenus' : 'ui.universe.descent.hereJupiter');
        if (descentHint.textContent !== hint) descentHint.textContent = hint;
      }
      show();
      const now = inLab ? 'lab' : inStars ? 'stars' : null;
      if (inLab) lab.want(wasIn !== 'lab');
      if (inStars) stars.want(wasIn !== 'stars');
      // The experiment's panel runs folded too (a lesson's set-up waits on it); its figures only while it shows.
      lab.part?.update(view, expanded);
      if (expanded) {
        stars.part?.update(view);
        if (view.focus !== aboutFor) {
          aboutFor = view.focus;
          aboutSummary.textContent = i18n.t('ui.universe.about.title', { body: f.name(view.focus) });
        }
        about.part?.update(view, slow, aboutSection.open);
        sky.part?.update(view, slow);
        livingPanel.part?.update(view, slow, living.open);
        if (islamic.open) islamicPanel.part?.update(view, slow);
      }
      // Saved views go on folded too (a saved walk begins once its world is reached; going back to one folds a phone's sheet).
      saved.part?.update(view);
      // Entering an experiment or the stars brings its panel into view from its top; leaving, the way in.
      if (now !== wasIn) {
        if (now) toPanel = true;
        else if (expanded && wasIn) (wasIn === 'lab' ? labEntry : starsEntry).scrollIntoView({ block: 'nearest' });
        wasIn = now;
      }
      if (toPanel && expanded && now) {
        toPanel = false;
        // The side panel from its head (the time machine, then the panel); the sheet, whose list comes first, from the panel's top.
        const slot = now === 'lab' ? labSlot : starsSlot;
        body.scrollTop = layout === 'panel' ? 0 : body.scrollTop + slot.getBoundingClientRect().top - body.getBoundingClientRect().top;
        edge();
      }
      if (view.witnessed.length !== seenShown) {
        seenShown = view.witnessed.length;
        seenEmpty.hidden = seenShown > 0;
        seenList.replaceChildren(...view.witnessed.map((id) => h('li', {}, i18n.t(`ui.universe.seen.${id}`))));
        // How many entries the log holds (no total to reach: there is nothing to complete).
        seenSummary.textContent = seenShown > 0 ? i18n.t('ui.universe.seenCount', { count: i18n.number(seenShown, 0) }) : i18n.t('ui.universe.seen');
        edge();
      }
      quality.update(view.detail);
    },
    setExpanded,
    onResize(fn) {
      resizeListeners.add(fn);
    },
  };
}
