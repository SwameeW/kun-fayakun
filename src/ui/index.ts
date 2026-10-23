import { isPlayable } from '../chapters/index';
import type { App, ChapterId, Route } from '../core/types';
import { createAnnouncer } from './announcer';
import type { UniverseUi } from './explore/index';
import { createCueText } from './cue-text';
import { focusLost, h } from './dom';
import { ARABIC_FONT_PATH, declareArabicFont, loadArabicFont } from './fonts';
import { createFpsReadout } from './fps';
import { icon } from './icons';
import { createIntro } from './intro';
import { createShortcuts } from './keyboard';
import { createPanel } from './panel';
import { chapterHash, parseHash } from './route';
import { createSourcesPage } from './sources-page';
import { createStageCards } from './stage-cards';
import { createHud } from './hud';
import { createStatus } from './status';
import { createTimeline } from './timeline';
import './styles/base.css';

/** Publishes the header and timeline heights so overlays can sit between them. */
function trackHeight(el: HTMLElement, property: string): void {
  new ResizeObserver(() => {
    document.documentElement.style.setProperty(property, `${el.offsetHeight}px`);
  }).observe(el);
}

/**
 * Mounts the whole interface into `root`. Everything is real DOM; nothing is
 * drawn into the canvas. Safe to call before the renderer exists: the intro
 * paints from plain DOM and CSS.
 */
export function mountUI(app: App, root: HTMLElement): void {
  const { i18n } = app;
  const params = new URLSearchParams(window.location.search);
  const autoplay = params.get('autoplay') === '1';
  declareArabicFont(app.assets.url(ARABIC_FONT_PATH));
  root.classList.add('kf-root');
  document.documentElement.classList.toggle('kf-reduced-motion', app.reducedMotion);

  const announcer = createAnnouncer();
  const timeline = createTimeline(app, (text) => {
    announcer.announce(text);
  });
  const panel = createPanel(app);
  const cueText = createCueText(app, (text) => {
    announcer.announce(text);
  });
  const cards = createStageCards(app);
  const hud = createHud(app);
  const status = createStatus(app);
  const sources = createSourcesPage(app);

  let view: Route['name'] = 'home';
  let introDismissed = false;

  function begin(): void {
    intro.setVisible(false);
    if (app.mode !== 'cinematic') app.setMode('cinematic');
    app
      .goTo('ch00', 0)
      .then(() => {
        if (app.paused) app.play();
      })
      .catch((err: unknown) => {
        console.error(err);
      });
    timeline.focusPlay();
  }

  const intro = createIntro(i18n, {
    begin,
    exploreTimeline() {
      introDismissed = true;
      intro.setVisible(false);
      timeline.focusStops();
    },
    exploreUniverse() {
      app.openUniverse();
    },
  });

  function step(direction: 1 | -1): void {
    const index = app.chapters.findIndex((c) => c.id === app.chapter);
    const target = index >= 0 ? app.chapters[index + direction] : undefined;
    if (!target) return;
    if (!isPlayable(target)) {
      announcer.announce(i18n.t('ui.announce.upcoming', { title: i18n.t(target.titleKey) }));
      return;
    }
    if (direction === 1) app.next();
    else app.prev();
  }

  const inChapter = (): boolean => view === 'chapter' && app.chapter !== null;
  const shortcuts = createShortcuts(i18n, {
    togglePlay() {
      // The explorer has no film to play (and Space must not start Chapter 0 behind it).
      if (view === 'sources' || view === 'universe') return;
      if (app.chapter === null) begin();
      else app.togglePause();
    },
    previous() {
      if (inChapter()) step(-1);
    },
    next() {
      if (inChapter()) step(1);
    },
    seekBy(seconds) {
      if (!inChapter()) return;
      const duration = app.content?.duration ?? Number.POSITIVE_INFINITY;
      app.seek(Math.min(duration, Math.max(0, app.time + seconds)));
    },
    togglePanel() {
      panel.toggle();
    },
    explore() {
      if (inChapter()) app.setMode('explore');
    },
    leaveExplore() {
      if (view === 'universe') {
        // Esc in the explorer: back to the film where the visitor came from.
        app.closeUniverse();
        return;
      }
      if (app.mode !== 'explore') return;
      app.setMode('cinematic');
      timeline.focusStops();
    },
  });

  /* Header ------------------------------------------------------------ */

  const brand = h('a', { href: '#/', class: 'kf-brand-link' }, i18n.t('ui.app.title'));
  brand.addEventListener('click', (event) => {
    event.preventDefault();
    app.home();
  });
  const shortcutsButton = h(
    'button',
    { type: 'button', class: 'kf-btn kf-btn--icon kf-btn--quiet', title: i18n.t('ui.header.shortcuts') },
    icon('keyboard'),
    h('span', { class: 'kf-sr-only' }, i18n.t('ui.header.shortcuts')),
  );
  shortcutsButton.addEventListener('click', () => {
    shortcuts.openHelp();
  });
  const header = h(
    'header',
    { class: 'kf-header' },
    h('h1', { class: 'kf-brand' }, brand),
    params.get('fps') === '1' ? createFpsReadout(app) : null,
    h('div', { class: 'kf-header-actions' }, shortcutsButton, panel.toggleButton),
  );

  /* Main stage -------------------------------------------------------- */

  const main = h(
    'main',
    { id: 'kf-main', class: 'kf-main', tabindex: '-1' },
    // The HUD (scene tags, scale bar) belongs to the stage's landmark; it is fixed to the viewport.
    hud.element,
    intro.element,
    h(
      'div',
      { class: 'kf-stage' },
      h('div', { class: 'kf-stage-top' }, cards.cmbOverlay, ...cards.figureOverlays, cards.exploreHint),
      cards.titleCard,
      h('div', { class: 'kf-stage-text' }, cueText.verseOverlay, cueText.captions),
      cards.outro,
      status.loading,
      status.error,
    ),
    sources.element,
  );

  // The skip link must not touch the hash: the hash is the router's.
  const skip = h('a', { href: '#kf-main', class: 'kf-skip' }, i18n.t('ui.skip.main'));
  skip.addEventListener('click', (event) => {
    event.preventDefault();
    main.focus();
  });

  root.replaceChildren(skip, header, main, timeline.element, panel.element, shortcuts.dialog, announcer.element);
  trackHeight(header, '--kf-header-h');
  trackHeight(timeline.element, '--kf-timeline-h');

  /* Routes ------------------------------------------------------------ */

  function backHref(): string {
    const meta = app.chapters.find((c) => c.id === app.chapter);
    return meta ? chapterHash(meta.number) : '#/';
  }

  /* The solar-system explorer's interface: its own chunk, loaded the first time its route shows. */
  let universe: Promise<UniverseUi> | null = null;
  /** The chapter the explorer was opened from (its "back" returns there), or null for the start. */
  let universeOrigin: ChapterId | null = null;

  function showUniverse(visible: boolean): void {
    if (!visible) {
      // An interface that never loaded has nothing to hide; its failure is reported where it was asked for.
      universe
        ?.then((ui) => {
          ui.setVisible(false);
        })
        .catch(() => undefined);
      return;
    }
    universe ??= import('./explore/index').then(({ mountUniverse }) => {
      const ui = mountUniverse(app, (text) => {
        announcer.announce(text);
      });
      main.append(ui.element);
      return ui;
    });
    universe
      .then((ui) => {
        if (view !== 'universe') return;
        ui.setOrigin(universeOrigin);
        ui.setVisible(true);
      })
      .catch((err: unknown) => {
        console.error('[ui] The explorer interface could not be loaded', err);
        universe = null;
      });
  }

  function applyRoute(route: Route): void {
    if (route.name !== 'home') introDismissed = false;
    // Entering the explorer from the film (not coming back to it from the Sources page): remember the chapter.
    if (route.name === 'universe' && view !== 'universe' && view !== 'sources') universeOrigin = app.chapter;
    const leavingUniverse = view === 'universe' && route.name !== 'universe';
    view = route.name;
    root.dataset.view = route.name;
    if (route.name === 'sources') sources.show(backHref());
    else sources.hide();
    intro.setVisible(route.name === 'home' && !introDismissed && !autoplay);
    timeline.element.hidden = route.name === 'sources' || route.name === 'universe';
    panel.setAvailable(route.name === 'chapter');
    showUniverse(route.name === 'universe');
    if (leavingUniverse) {
      // The explorer's controls are going away: keyboard focus goes back where the film keeps it
      // (the transport, or the welcome screen's way into the explorer), not to the page itself.
      requestAnimationFrame(() => {
        if (!focusLost()) return;
        if (view === 'home' && intro.visible) intro.focusUniverse();
        else if (view === 'chapter') timeline.focusPlay();
        else main.focus();
      });
    }
  }

  app.events.on('route', ({ route }) => {
    applyRoute(route);
  });
  app.events.on('state', ({ state }) => {
    document.documentElement.classList.toggle('kf-busy', state === 'loading');
  });
  // Fallback for routes the engine may not announce (e.g. a plain link to #/sources).
  window.addEventListener('hashchange', () => {
    applyRoute(parseHash(window.location.hash));
  });
  app.events.on('chapter', ({ chapter }) => {
    // Start fetching the Arabic font as soon as a chapter (and so scripture) is on its way.
    void loadArabicFont();
    const meta = app.chapters.find((c) => c.id === chapter);
    if (meta) announcer.announce(i18n.t('ui.announce.chapter', { number: meta.number, title: i18n.t(meta.titleKey) }));
    if (view !== 'chapter') applyRoute({ name: 'chapter', chapter, t: null });
  });

  applyRoute(parseHash(window.location.hash));
}
