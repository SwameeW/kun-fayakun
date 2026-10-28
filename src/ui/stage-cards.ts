import { isPlayable } from '../chapters/index';
import type { App, ChapterContent, ChapterId, FigureId, TimelineState } from '../core/types';
import { commitStyles, h } from './dom';
import { createFadeSlot } from './fade';
import { cmbLegend, cosmicFutures, decayChain, hubbleTension } from './figures';
import './styles/stage.css';

const TITLE_FADE_MS = 1000;

/** Toggles a fading element without ever cutting it: opacity only, then `hidden` once invisible. */
function fader(el: HTMLElement, ms: number): (visible: boolean) => void {
  let timer: number | undefined;
  let target = false;
  el.hidden = true;
  el.classList.add('kf-fade');
  el.style.setProperty('--kf-fade-ms', `${ms}ms`);
  return (visible) => {
    if (visible === target) return;
    target = visible;
    window.clearTimeout(timer);
    if (visible) {
      if (el.hidden) {
        el.hidden = false;
        commitStyles(el);
      }
      el.classList.add('is-visible');
    } else if (!el.hidden) {
      el.classList.remove('is-visible');
      timer = window.setTimeout(() => {
        el.hidden = true;
      }, ms);
    }
  };
}

export interface StageCards {
  readonly titleCard: HTMLElement;
  readonly outro: HTMLElement;
  readonly exploreHint: HTMLElement;
  readonly cmbOverlay: HTMLElement;
  /** Further overlay figures ('overlay' cues), stacked beside the CMB legend. */
  readonly figureOverlays: readonly HTMLElement[];
}

export function createStageCards(app: App): StageCards {
  const { i18n } = app;
  let chapter: ChapterId | null = app.chapter;
  let content: ChapterContent | null = app.content;
  let state: TimelineState = app.state;
  let onChapterRoute = true;
  /** Overlay figures are lasting state: each overlay cue sets its figure's visibility (seeks resend it). */
  const overlays = new Map<FigureId, boolean>();

  /* Chapter title card, shown in the 'intro' state. */
  const titleCard = h('div', { class: 'kf-title-card-slot', 'aria-hidden': 'true' });
  const titleSlot = createFadeSlot(titleCard, TITLE_FADE_MS);

  function renderTitleCard(id: ChapterId, c: ChapterContent): HTMLElement {
    const meta = app.chapters.find((m) => m.id === id);
    const title = i18n.has(c.intro.titleKey) ? i18n.t(c.intro.titleKey) : meta ? i18n.t(meta.titleKey) : id;
    return h(
      'div',
      { class: 'kf-title-card' },
      meta ? h('p', { class: 'kf-title-card-number' }, i18n.t('ui.timeline.chapter', { number: meta.number })) : null,
      h('p', { class: 'kf-title-card-title' }, title),
      c.intro.subtitleKey ? h('p', { class: 'kf-title-card-subtitle' }, i18n.t(c.intro.subtitleKey)) : null,
    );
  }

  /* Outro: what next. */
  const outro = h('div', { class: 'kf-outro', role: 'group', 'aria-label': i18n.t('ui.outro.label') });
  const showOutro = fader(outro, 600);

  function renderOutro(): void {
    const index = app.chapters.findIndex((m) => m.id === chapter);
    const next = index >= 0 ? app.chapters[index + 1] : undefined;
    const replay = h('button', { type: 'button', class: 'kf-btn' }, i18n.t('ui.outro.replay'));
    replay.addEventListener('click', () => {
      app.seek(0);
      app.play();
    });
    const explore = h('button', { type: 'button', class: 'kf-btn' }, i18n.t('ui.outro.explore'));
    explore.addEventListener('click', () => {
      app.setMode('explore');
    });
    const actions = h('div', { class: 'kf-outro-actions' });
    if (next && isPlayable(next)) {
      const continueButton = h(
        'button',
        { type: 'button', class: 'kf-btn kf-btn--primary' },
        i18n.t('ui.outro.next', { title: i18n.t(next.titleKey) }),
      );
      continueButton.addEventListener('click', () => {
        app.next();
      });
      actions.append(continueButton);
    }
    actions.append(replay, explore);
    outro.replaceChildren(actions);
    if (app.chapters[index]?.opensUniverse) outro.append(universeButton('kf-btn kf-btn--quiet kf-universe-entry'));
    if (next && !isPlayable(next)) outro.prepend(h('p', { class: 'kf-outro-note' }, i18n.t('ui.outro.later')));
    // After the last chapter, the end credits roll above the actions.
    if (!next && index >= 0) outro.prepend(credits());
  }

  /** End credits: the app's name, then every source and licence, any recorded review and the disclaimer. */
  function credits(): HTMLElement {
    const file = app.data.sources();
    const roll = h(
      'div',
      { class: 'kf-credits-roll' },
      h('p', { class: 'kf-credits-made' }, i18n.t('ui.credits.app')),
      h('h3', { class: 'kf-credits-heading' }, i18n.t('ui.credits.sources')),
      h('ul', { class: 'kf-credits-list' }, ...file.sources.map((s) => h('li', {}, h('span', { class: 'kf-credits-title' }, s.title), h('span', { class: 'kf-credits-credit' }, s.credit), h('span', { class: 'kf-credits-license' }, s.license)))),
      file.reviews.length > 0 ? h('ul', { class: 'kf-credits-list' }, ...file.reviews.map((r) => h('li', {}, `${r.reviewer}, ${r.role} (${r.area}, ${r.date})`))) : null,
      h('p', { class: 'kf-credits-disclaimer' }, i18n.t('ui.disclaimer')),
    );
    return h('section', { class: 'kf-credits', 'aria-label': i18n.t('ui.credits.title'), 'data-testid': 'credits' }, roll);
  }

  /** "Explore the solar system": from the eras that have one (Chapters 7 to 10), a quiet way into the explorer. */
  function universeButton(className: string): HTMLButtonElement {
    const button = h('button', { type: 'button', class: className, 'data-testid': 'open-universe' }, i18n.t('ui.universe.enter'));
    button.addEventListener('click', () => {
      app.openUniverse();
    });
    return button;
  }

  /* Explore hint, with the way into the explorer in the chapters that offer it. */
  const hintUniverse = universeButton('kf-btn kf-btn--quiet kf-universe-entry');
  hintUniverse.hidden = true;
  const exploreHint = h('p', { class: 'kf-explore-hint' }, i18n.t('ui.explore.hint'), ' ', hintUniverse);
  const showExploreHint = fader(exploreHint, 400);

  /* CMB legend overlay, driven by 'overlay' cues. */
  const cmbOverlay = cmbLegend(app, { 'data-testid': 'cmb-legend' });
  cmbOverlay.classList.add('kf-overlay-figure');
  const showCmb = fader(cmbOverlay, 800);

  /*
   * Other overlay figures, also driven by 'overlay' cues (shown and hidden by fading). They read the
   * constants, which on a first visit arrive after the interface is built: each is built again with
   * them once they have loaded, so none is left saying its values are not available.
   */
  const overlayFigures = new Map<FigureId, { el: HTMLElement; show: (visible: boolean) => void }>();
  const figureBuilds = [
    ['hubble-tension', () => hubbleTension(app)],
    ['decay-chain', () => decayChain(app)],
    ['cosmic-futures', () => cosmicFutures(app)],
  ] as const;
  for (const [id, build] of figureBuilds) {
    const el = build();
    el.classList.add('kf-overlay-figure');
    el.dataset.testid = `overlay-${id}`;
    overlayFigures.set(id, { el, show: fader(el, 800) });
  }
  void app.data.ready.then(
    () => {
      for (const [id, build] of figureBuilds) overlayFigures.get(id)?.el.replaceChildren(...build().childNodes);
    },
    () => undefined,
  );

  function sync(): void {
    const active = onChapterRoute && chapter !== null && state !== 'loading' && state !== 'idle';
    if (active && state === 'intro' && chapter && content) {
      const id = chapter;
      const c = content;
      titleSlot.want({ key: id, render: () => renderTitleCard(id, c) });
    } else {
      titleSlot.want(null);
    }
    showOutro(active && state === 'outro');
    hintUniverse.hidden = !app.chapters.find((m) => m.id === chapter)?.opensUniverse;
    showExploreHint(active && app.mode === 'explore');
    showCmb(active && overlays.get('cmb-legend') === true);
    for (const [id, figure] of overlayFigures) figure.show(active && overlays.get(id) === true);
  }

  app.events.on('chapter', (e) => {
    if (e.chapter !== chapter) overlays.clear();
    chapter = e.chapter;
    content = e.content;
    sync();
  });
  app.events.on('state', (e) => {
    state = e.state;
    if (e.chapter !== chapter) overlays.clear();
    chapter = e.chapter;
    if (state === 'outro') renderOutro();
    sync();
  });
  app.events.on('mode', sync);
  app.events.on('cue', ({ chapter: cueChapter, cue, active }) => {
    if (cue.type !== 'overlay' || !active || cueChapter !== chapter) return;
    overlays.set(cue.id, cue.visible);
    sync();
  });
  app.events.on('route', ({ route }) => {
    onChapterRoute = route.name === 'chapter';
    sync();
  });
  app.events.on('error', () => {
    titleSlot.clearFast();
  });

  sync();
  return { titleCard, outro, exploreHint, cmbOverlay, figureOverlays: [...overlayFigures.values()].map((f) => f.el) };
}
