import type { App, ChapterContent, ChapterId, ProseBlock, ScienceBlock, TextBlock } from '../core/types';
import { externalLink, h, uniqueId } from './dom';
import { figure } from './figures';
import { blockCitations, formatProse } from './format';
import { icon } from './icons';
import { discoveryBlock, type DiscoveryBlock } from './discovery';
import { hadithArticle, plainExplanation, verseArticle } from './scripture';
import { readPreference, writePreference } from './preferences';
import { setVersePlain, versePlain } from './verse-english';
import './styles/panel.css';

type Section = 'text' | 'scholarly' | 'science';

const SECTION_HEADINGS: Readonly<Record<Section, string>> = {
  text: 'ui.panel.layer.text',
  scholarly: 'ui.panel.layer.scholarly',
  science: 'ui.panel.layer.science',
};

/**
 * Under this width the panel is a bottom sheet with a peek state. Short screens
 * (phones held sideways) keep the side panel: a peek bar there would leave no
 * room for verse cards. Keep in step with the matching rule in styles/base.css.
 */
const SHEET_QUERY = '(max-width: 767.98px) and (min-height: 500.02px)';
/** Wide screens open the panel by default; narrower ones start collapsed. */
const OPEN_BY_DEFAULT_QUERY = '(min-width: 1024px)';
/** A panel cue does not scroll the panel if the reader touched it this recently. */
const READING_GRACE_MS = 8000;

export interface Panel {
  readonly element: HTMLElement;
  /** Header button that shows or hides the panel (data-testid="panel-toggle"). */
  readonly toggleButton: HTMLButtonElement;
  toggle(): void;
  /** Hidden on the home and sources routes, where there is no chapter. */
  setAvailable(available: boolean): void;
  /**
   * The invitation to the chapter's letter analysis, shown on the stage under the verse it reads
   * while that verse's cue plays (so it is found without scrolling the notes, or opening them on a phone).
   */
  readonly invite: HTMLElement;
}

/** How long the stage invitation stays after its verse's cue ends (ms). */
const INVITE_LINGER_MS = 6000;

export function createPanel(app: App): Panel {
  const { i18n } = app;
  const panelId = uniqueId('panel');
  const titleId = uniqueId('panel-title');
  const bodyId = uniqueId('panel-body');
  const sheetQuery = window.matchMedia(SHEET_QUERY);

  let open = readPreference('panelOpen') ?? window.matchMedia(OPEN_BY_DEFAULT_QUERY).matches;
  /** The route shows a chapter, and a chapter's content has arrived. */
  let routeAllows = true;
  let hasContent = false;
  let renderedChapter: ChapterId | null = null;
  /** A panel cue that arrived before its chapter's content was rendered. */
  let pendingSection: { chapter: ChapterId; section: Section } | null = null;
  let dataReady = false;
  let lastReaderActivity = 0;
  const sections = new Map<Section, HTMLElement>();
  /** The chapter's letter analysis, if it has one: it must close before the panel hides or re-renders it. */
  let discovery: DiscoveryBlock | null = null;

  const title = h('p', { id: titleId, class: 'kf-panel-title' });
  const peek = h('span', { class: 'kf-panel-peek' });
  const handle = h(
    'button',
    { type: 'button', class: 'kf-sheet-handle', 'aria-controls': bodyId },
    h('span', { class: 'kf-sheet-grip', 'aria-hidden': 'true' }),
    h('span', { class: 'kf-sheet-label' }, i18n.t('ui.panel.handle')),
    peek,
    icon('chevron'),
  );
  const body = h('div', { id: bodyId, class: 'kf-panel-body', tabindex: '-1' });
  const element = h(
    'aside',
    { id: panelId, class: 'kf-panel', 'data-testid': 'panel', 'aria-labelledby': titleId, hidden: true },
    h('div', { class: 'kf-panel-head' }, handle, title),
    body,
  );

  const toggleLabel = h('span', {});
  const toggleButton = h(
    'button',
    { type: 'button', class: 'kf-btn kf-btn--quiet', 'data-testid': 'panel-toggle', 'aria-controls': panelId, hidden: true },
    icon('panel'),
    toggleLabel,
  );

  // Reader input only: 'scroll' would also catch the panel's own cue-driven scrolling.
  for (const event of ['pointerdown', 'touchstart', 'wheel', 'keydown', 'focusin'] as const) {
    body.addEventListener(event, () => {
      lastReaderActivity = performance.now();
    }, { passive: true });
  }

  function sync(): void {
    const sheet = sheetQuery.matches;
    const available = routeAllows && hasContent;
    element.hidden = !available;
    toggleButton.hidden = !available;
    element.classList.toggle('is-open', open);
    element.classList.toggle('is-sheet', sheet);
    // Collapsed content must not take keyboard focus: the sheet keeps only its handle, the side panel hides.
    body.inert = !open;
    element.classList.toggle('is-collapsed', !open);
    toggleButton.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-expanded', String(open));
    toggleLabel.textContent = i18n.t(open ? 'ui.panel.hide' : 'ui.panel.show');
    document.documentElement.classList.toggle('kf-panel-open', available && open && !sheet);
  }

  function setOpen(next: boolean): void {
    if (!next) discovery?.close();
    open = next;
    writePreference('panelOpen', open);
    sync();
  }

  /*
   * Finding the letter analysis: besides its quiet button at the end of the scholarly layer, a
   * button under the last verse of the text layer (the verse the analysis is introduced under:
   * 21:33 in Chapter 7), where the reader is, and on the stage, while that verse's cue plays, an
   * invitation under the verse itself. Either opens the notes if they are closed and then the
   * analysis, scrolled into view. Neither loads the analysis: it still loads when it opens.
   */
  let inviteKey: string | null = null;
  let inviteTimer = 0;
  const invite = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discovery-invite', 'data-testid': 'discovery-invite', 'aria-hidden': 'true', tabindex: '-1' }, i18n.t('ui.discovery.invite'));
  const showInvite = (shown: boolean): void => {
    window.clearTimeout(inviteTimer);
    invite.classList.toggle('is-shown', shown);
    invite.setAttribute('aria-hidden', String(!shown));
    invite.tabIndex = shown ? 0 : -1;
  };
  const openAnalysis = (): void => {
    showInvite(false);
    if (!open && routeAllows && hasContent) setOpen(true);
    // The notes take a frame to show (they are inert while closed): the analysis opens after.
    requestAnimationFrame(() => {
      discovery?.open();
      discovery?.element.scrollIntoView({ block: 'nearest', behavior: app.reducedMotion ? 'auto' : 'smooth' });
    });
  };
  invite.addEventListener('click', openAnalysis);

  toggleButton.addEventListener('click', () => {
    setOpen(!open);
  });
  handle.addEventListener('click', () => {
    setOpen(!open);
  });
  sheetQuery.addEventListener('change', sync);

  function prose(block: ProseBlock): HTMLElement[] {
    const out: HTMLElement[] = [h('p', { class: 'kf-prose' }, formatProse(block, app.data, i18n))];
    const cites = blockCitations(block, app.data).map((c) => h('li', {}, c.url ? externalLink(c.url, c.text) : c.text));
    if (cites.length > 0) {
      out.push(
        h('div', { class: 'kf-cites' }, h('span', { class: 'kf-cites-label' }, i18n.t('ui.panel.cites')), h('ul', {}, ...cites)),
      );
    }
    return out;
  }

  function scienceBlock(block: ScienceBlock): HTMLElement[] {
    const out = prose(block);
    if (block.figure) out.splice(1, 0, figure(app, block.figure));
    return out;
  }

  function textBlock(block: TextBlock): HTMLElement | null {
    if (block.type === 'verse') return verseArticle(block.key, app.data, i18n, block.noteKey);
    return hadithArticle(block.id, app.data, i18n, {
      ...(block.summaryKey ? { summaryKey: block.summaryKey } : {}),
      ...(block.noteKey ? { noteKey: block.noteKey } : {}),
    });
  }

  /**
   * The switch between the published translation and the plain-words explanation on the film's
   * verse cards, at the top of the text layer of a chapter whose verses have explanations.
   */
  function plainSwitch(blocks: readonly TextBlock[]): HTMLElement | null {
    if (!blocks.some((b) => b.type === 'verse' && plainExplanation(b.key, i18n) !== null)) return null;
    const hintId = uniqueId('plain-hint');
    const button = h(
      'button',
      { type: 'button', class: 'kf-plain-switch', 'aria-pressed': String(versePlain()), 'aria-describedby': hintId, 'data-testid': 'verse-plain-switch' },
      h('span', { class: 'kf-plain-switch-track', 'aria-hidden': 'true' }),
      i18n.t('ui.verse.plainSwitch'),
    );
    button.addEventListener('click', () => {
      setVersePlain(!versePlain());
      button.setAttribute('aria-pressed', String(versePlain()));
    });
    return h('div', { class: 'kf-plain-choice' }, button, h('p', { id: hintId, class: 'kf-plain-hint' }, i18n.t('ui.verse.plainSwitchHint')));
  }

  /** A plain note at the top of a layer (e.g. a chapter that pairs no text with the science). */
  function layerNote(key: string | undefined): HTMLElement | null {
    return key ? h('p', { class: 'kf-layer-note' }, i18n.t(key)) : null;
  }

  function subheading(key: string, blocks: readonly ProseBlock[]): HTMLElement[] {
    if (blocks.length === 0) return [];
    return [h('h3', { class: 'kf-subheading' }, i18n.t(key)), ...blocks.flatMap(prose)];
  }

  function section(name: Section, children: ReadonlyArray<HTMLElement | null>): HTMLElement {
    const headingId = uniqueId(`layer-${name}`);
    const el = h(
      'section',
      { class: 'kf-layer', 'data-testid': `layer-${name}`, 'data-section': name, 'aria-labelledby': headingId },
      h('h2', { id: headingId, class: 'kf-layer-heading' }, i18n.t(SECTION_HEADINGS[name])),
      ...children,
    );
    sections.set(name, el);
    return el;
  }

  function render(chapter: ChapterId, content: ChapterContent): void {
    const meta = app.chapters.find((c) => c.id === chapter);
    const chapterTitle = meta ? i18n.t(meta.titleKey) : chapter;
    title.textContent = meta ? `${i18n.t('ui.timeline.chapter', { number: meta.number })} · ${chapterTitle}` : chapterTitle;
    peek.textContent = chapterTitle;
    sections.clear();
    discovery?.close();
    const { panel } = content;
    discovery = panel.discovery ? discoveryBlock(app, panel.discovery) : null;
    try {
      body.replaceChildren(
        // The order of the three layers is a core principle: text, then scholars, then science.
        section('text', [layerNote(panel.notes?.text), plainSwitch(panel.text), ...panel.text.map(textBlock)]),
        section('scholarly', [
          layerNote(panel.notes?.scholarly),
          ...subheading('ui.panel.classical', panel.scholarly.classical),
          ...subheading('ui.panel.modern', panel.scholarly.modern),
          discovery?.element ?? null,
        ]),
        section('science', [
          ...panel.science.flatMap(scienceBlock),
          ...subheading('ui.panel.openQuestions', panel.openQuestions),
        ]),
      );
      body.scrollTop = 0;
      renderedChapter = chapter;
      showInvite(false);
      inviteKey = null;
      const verses = sections.get('text')?.querySelectorAll('[data-verse]');
      const last = verses?.[verses.length - 1];
      if (discovery && last) {
        inviteKey = last.getAttribute('data-verse');
        const inline = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discovery-inline', 'data-testid': 'discovery-inline' }, i18n.t('ui.discovery.inline'));
        inline.addEventListener('click', openAnalysis);
        last.after(inline);
      }
      if (pendingSection?.chapter === chapter) focusSection(pendingSection.section);
      pendingSection = null;
    } catch (err) {
      console.error('ui: could not render the panel', err);
      body.replaceChildren(h('p', { class: 'kf-muted' }, i18n.t('ui.error.title')));
    }
  }

  function focusSection(name: Section): void {
    sections.forEach((el, key) => el.classList.toggle('is-current', key === name));
    peek.textContent = i18n.t('ui.panel.now', { section: i18n.t(SECTION_HEADINGS[name]) });
    const target = sections.get(name);
    // An open analysis (data-kf-engaged) is never scrolled away, even by the cues a seek replays.
    const engaged = body.querySelector('[data-kf-engaged]') !== null;
    const reading = engaged || performance.now() - lastReaderActivity < READING_GRACE_MS || element.contains(document.activeElement);
    if (!target || !open || reading) return;
    body.scrollTo({ top: target.offsetTop - body.offsetTop, behavior: app.reducedMotion ? 'auto' : 'smooth' });
  }

  /** Renders at once when data is loaded, so cues the engine emits right after 'chapter' find the panel ready. */
  function show(chapter: ChapterId, content: ChapterContent): void {
    hasContent = true;
    renderedChapter = null;
    sync();
    if (dataReady) {
      render(chapter, content);
      return;
    }
    // The engine reports a data failure itself; the panel then stays empty.
    app.data.ready.then(
      () => {
        if (app.chapter === chapter) render(chapter, content);
      },
      () => undefined,
    );
  }

  app.data.ready.then(
    () => {
      dataReady = true;
    },
    () => undefined,
  );
  app.events.on('chapter', ({ chapter, content }) => {
    show(chapter, content);
  });
  app.events.on('cue', ({ chapter, cue, active }) => {
    // The stage invitation follows the cue of a verse the analysis reads, lingering a little after it.
    if (cue.type === 'verse' && chapter === renderedChapter && cue.key === inviteKey) {
      if (active) showInvite(true);
      else
        inviteTimer = window.setTimeout(() => {
          showInvite(false);
        }, INVITE_LINGER_MS);
      return;
    }
    if (!active || cue.type !== 'panel') return;
    if (chapter === renderedChapter) focusSection(cue.section);
    else pendingSection = { chapter, section: cue.section };
  });

  if (app.chapter && app.content) show(app.chapter, app.content);
  sync();

  return {
    element,
    toggleButton,
    invite,
    toggle() {
      if (routeAllows && hasContent) setOpen(!open);
    },
    setAvailable(next) {
      if (!next) discovery?.close();
      routeAllows = next;
      sync();
    },
  };
}
