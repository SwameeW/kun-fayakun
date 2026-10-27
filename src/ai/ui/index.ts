/**
 * Kun Fayakun Intelligence's interface (docs/AI-INTELLIGENCE.md §2): the panel the header's Ask
 * button (or /) opens. Its own chunk, with its strings (src/i18n/en.ai.json) and styles (./ai.css),
 * loaded the first time Ask is pressed; it starts the assistant (src/ai/boot.ts) as it mounts.
 *
 * - A wide window: a non-modal column at the inline start, below the header (and the explorer's way
 *   back), ending above the film's timeline or the explorer's readout (./layout.ts measures them). The
 *   explorer is told how much of the view it covers, so it frames the worlds in the rest; in Explore
 *   Mode, Discover's dock folds and the stage steps aside.
 * - A phone or a narrow window: a bottom sheet on a modal <dialog>, which minimises to a bar while a
 *   view or an experiment runs, so the scene is in sight.
 * Esc closes it and focus goes back to Ask. Every key pressed inside the panel is its own (it is
 * marked data-kf-keys="own"), and none pressed outside it is: the scene keeps its keys whenever the
 * panel is not focused. Answers are real DOM text. Screen readers hear one line per finished answer
 * (the assistant's announcement), never each word as it streams.
 */
import type { App } from '../../core/types';
import messages from '../../i18n/en.ai.json';
import { h, uniqueId } from '../../ui/dom';
import { loadArabicFont } from '../../ui/fonts';
import { icon } from '../../ui/icons';
import { loadPlainWords } from '../../ui/plain-words';
import { startIntelligence } from '../boot';
import type { AiOrchestrator } from '../index';
import type { Intelligence, Turn } from '../types';
import { ACTIVE_STATES, createTurnView, modelName, stateText, type TurnView } from './blocks';
import { place, sheetBox, SIDE_QUERY, sideBox, type Box } from './layout';
import { createModelSection } from './model';
import { createSettings } from './settings';
import './ai.css';

export interface AssistantUi {
  open(): void;
  close(): void;
  /** Ask's press: opens the panel, or closes it when it is open. */
  toggle(): void;
}

/** The longest question read (the input guard keeps the same). */
const MAX_QUESTION = 600;
/** Turns kept on screen (the assistant keeps as many). */
const KEEP_TURNS = 50;
/** Frames to wait for Discover's dock to appear, when Explore Mode begins with the panel open. */
const DOCK_WAIT_FRAMES = 120;
/** The window event the explorer listens for when the panel's cover of the view changes. */
const INSET_EVENT = 'kf-ai-inset';

type EngineState = ReturnType<Intelligence['engine']>;

/** What is answering, for the panel's header. */
function engineText(app: App, e: EngineState): string {
  const { i18n } = app;
  if (e.kind === 'scripted') return i18n.t('ai.ui.engine.scripted');
  if (e.kind === 'guide') return i18n.t('ai.ui.engine.guide');
  const name = e.kind === 'browser' ? i18n.t('ai.ui.engine.browser') : modelName(e.model);
  if (e.state === 'loading') return i18n.t('ai.ui.engine.loading', { model: name });
  if (e.state === 'error') return i18n.t('ai.ui.engine.error', { model: name });
  if (e.state === 'off') return i18n.t('ai.ui.engine.off', { model: name });
  return e.kind === 'browser' ? name : i18n.t('ai.ui.engine.local', { model: name });
}

/**
 * Mounts the panel into the interface's root and starts the assistant; resolves once both are ready
 * (the Ask button shows that it is busy until then).
 */
export async function mountAssistant(app: App, root: HTMLElement, askButton: HTMLButtonElement, announce: (text: string) => void): Promise<AssistantUi> {
  const { i18n } = app;
  i18n.extend('en.ai.json', messages);
  // Scripture in answers shows its plain words and its Arabic typeface, as the notes do.
  void loadArabicFont();
  const [ai] = await Promise.all([startIntelligence(app, announce), loadPlainWords(app)]);
  return createPanel(app, ai, root, askButton, announce);
}

function createPanel(app: App, ai: AiOrchestrator, root: HTMLElement, askButton: HTMLButtonElement, announce: (text: string) => void): AssistantUi {
  const { i18n } = app;
  const html = document.documentElement;
  const sideQuery = window.matchMedia(SIDE_QUERY);

  /* ---------------- the panel's content ---------------- */

  const titleId = uniqueId('ai-title');
  const engineValue = h('span', { 'data-testid': 'ai-engine' });
  const engineChip = h('p', { class: 'kf-ai-engine' }, h('span', { class: 'kf-ai-engine-label' }, i18n.t('ai.ui.engine.label')), ' ', engineValue);
  const headStatus = h('p', { class: 'kf-ai-head-status', 'data-testid': 'ai-head-status', hidden: true });
  const minimise = h('button', { type: 'button', class: 'kf-btn kf-btn--icon kf-btn--quiet kf-ai-minimise', 'aria-expanded': 'true', 'data-testid': 'ai-minimise' }, icon('chevron'), h('span', { class: 'kf-sr-only' }));
  const closeButton = h('button', { type: 'button', class: 'kf-btn kf-btn--icon kf-btn--quiet', 'data-testid': 'ai-close' }, icon('close'), h('span', { class: 'kf-sr-only' }, i18n.t('ai.ui.close')));
  const head = h(
    'div',
    { class: 'kf-ai-head' },
    h('div', { class: 'kf-ai-heading' }, h('h2', { id: titleId, class: 'kf-ai-title' }, i18n.t('ai.ui.title')), engineChip, headStatus),
    minimise,
    closeButton,
  );

  const log = h('ol', { class: 'kf-ai-log', 'aria-label': i18n.t('ai.ui.conversation'), 'data-testid': 'ai-log' });
  const suggestions = h('div', { class: 'kf-ai-suggest', role: 'group', 'aria-label': i18n.t('ai.ui.suggestions'), 'data-testid': 'ai-suggestions' });
  const actions = {
    confirm(turnId: string, callId: string, accept: boolean) {
      void ai.confirm(turnId, callId, accept);
    },
    undo(turnId: string, callId: string) {
      void ai.undo(turnId, callId);
    },
    kindOf: (tool: string) => ai.kindOf(tool),
    navigated() {
      // On a phone the sheet steps aside to show where the link went.
      if (mode === 'sheet') close(false);
    },
  };
  const model = createModelSection(app, ai, announce);
  const settings = createSettings(app, ai, announce, () => {
    log.replaceChildren();
    views.clear();
    showBusy(null);
    showSuggestions();
  });
  // The conversation ends the scrolling part, so following it shows the latest answer and what to ask next.
  const scroller = h('div', { class: 'kf-ai-scroll' }, h('p', { class: 'kf-ai-intro' }, i18n.t('ai.ui.intro')), model.element, settings.element, log, suggestions);

  const inputId = uniqueId('ai-input');
  const hintId = uniqueId('ai-hint');
  const input = h('textarea', { id: inputId, class: 'kf-ai-input', rows: 2, maxlength: MAX_QUESTION, placeholder: i18n.t('ai.ui.input.placeholder'), 'aria-describedby': hintId, 'data-testid': 'ai-input' });
  const send = h('button', { type: 'submit', class: 'kf-btn kf-btn--primary', 'data-testid': 'ai-send' }, i18n.t('ai.ui.send'));
  const stop = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'ai-stop', hidden: true }, i18n.t('ai.ui.stop'));
  const form = h(
    'form',
    { class: 'kf-ai-form' },
    h('label', { class: 'kf-ai-field', for: inputId }, i18n.t('ai.ui.input.label')),
    input,
    h('div', { class: 'kf-ai-form-foot' }, h('p', { id: hintId, class: 'kf-ai-hint' }, i18n.t('ai.ui.input.hint')), stop, send),
  );
  const content = h('div', { class: 'kf-ai-content' }, head, scroller, form);

  // Two homes for the same content: a column beside the scene, or a sheet on a phone. Only the one in use is in the page.
  const aside = h('aside', { class: 'kf-ai kf-ai--side', 'aria-labelledby': titleId, 'data-testid': 'ai-panel', 'data-kf-keys': 'own' });
  const sheet = h('dialog', { class: 'kf-dialog kf-ai kf-ai--sheet', 'aria-labelledby': titleId, 'data-testid': 'ai-panel', 'data-kf-keys': 'own' });

  let isOpen = false;
  let mode: 'side' | 'sheet' = 'side';
  let minimised = false;
  /** Turns already minimised for (a turn minimises the sheet once, when its action starts). */
  let minimisedFor: string | null = null;
  let inset = 0;
  const views = new Map<string, TurnView>();

  /* ---------------- the conversation ---------------- */

  function showEngine(): void {
    engineValue.textContent = engineText(app, ai.engine());
  }
  showEngine();
  ai.events.on('engine', showEngine);

  function showSuggestions(): void {
    suggestions.replaceChildren(
      ...ai.suggestions().map((text) => {
        const chip = h('button', { type: 'button', class: 'kf-ai-chip', 'data-testid': 'ai-suggestion' }, text);
        chip.addEventListener('click', () => {
          submit(text);
        });
        return chip;
      }),
    );
  }

  /** Stop while a turn works; the header's status line while the sheet is minimised (what it does, or what its action did). */
  function showBusy(turn: Turn | null): void {
    const busy = turn !== null && ACTIVE_STATES.has(turn.state);
    stop.hidden = !busy;
    const action = turn?.blocks.findLast((b) => b.type === 'action');
    const line = turn ? (stateText(turn, i18n) ?? (action?.type === 'action' ? i18n.t(`ai.ui.action.status.${action.status}`) : null)) : null;
    headStatus.textContent = line ?? '';
    headStatus.hidden = !minimised || line === null;
  }

  function latest(): Turn | null {
    return ai.turns().at(-1) ?? null;
  }

  function render(turn: Turn): void {
    let view = views.get(turn.id);
    if (!view) {
      view = createTurnView(app, actions);
      views.set(turn.id, view);
      log.append(view.element);
      for (const [id, old] of views) {
        if (views.size <= KEEP_TURNS) break;
        old.element.remove();
        views.delete(id);
      }
    }
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    view.update(turn);
    if (turn.id === latest()?.id) showBusy(turn);
    // Follow the conversation, unless the visitor has scrolled back to read.
    if (atEnd || turn.blocks.length === 0) scroller.scrollTop = scroller.scrollHeight;
    // On a phone, a view or an experiment that starts running is watched with the sheet out of the way.
    if (mode === 'sheet' && isOpen && !minimised && turn.state === 'acting' && minimisedFor !== turn.id && turn.plan?.calls.some((c) => ['view', 'experiment'].includes(ai.kindOf(c.tool) ?? ''))) {
      minimisedFor = turn.id;
      setMinimised(true);
    }
    if (turn.state === 'done' && isOpen) showSuggestions();
  }
  ai.events.on('turn', ({ turn }) => {
    render(turn);
  });
  for (const turn of ai.turns()) render(turn);

  function submit(text: string): void {
    const question = text.trim().slice(0, MAX_QUESTION);
    if (!question) return;
    input.value = '';
    void ai.ask(question).catch(() => undefined);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submit(input.value);
  });
  stop.addEventListener('click', () => {
    ai.cancel();
    input.focus();
  });

  /* ---------------- where it stands ---------------- */

  const container = (): HTMLElement => (mode === 'side' ? aside : sheet);

  function setInset(px: number): void {
    if (px === inset) return;
    inset = px;
    html.style.setProperty('--kf-ai-inset', `${px}px`);
    window.dispatchEvent(new Event(INSET_EVENT));
  }

  function layout(): void {
    if (!isOpen) {
      setInset(0);
      return;
    }
    const box: Box = mode === 'side' ? sideBox() : sheetBox();
    const el = container();
    place(el, box);
    if (mode === 'sheet' && minimised) {
      // The bar sits at the foot of the clear part of the view.
      el.style.height = 'auto';
      el.style.top = `${Math.round(box.top + box.height - el.offsetHeight)}px`;
    }
    setInset(mode === 'side' && !html.classList.contains('kf-photo') ? Math.round(box.left + box.width) : 0);
  }

  let frame = 0;
  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  }
  const watcher = new ResizeObserver(schedule);
  /** Watches the chrome the panel keeps clear of (the explorer's comes and goes with it). */
  function watchChrome(): void {
    watcher.disconnect();
    for (const sel of ['.kf-header', '[data-testid="timeline"]', '[data-testid="universe-back"]', '[data-testid="universe-readout"]', '[data-testid="universe-bodies"]', '[data-testid="panel"]']) {
      const el = document.querySelector(sel);
      if (el) watcher.observe(el);
    }
  }
  window.addEventListener('resize', schedule);
  // Chrome that slides (a sheet folding, the notes closing) changes no size: measure again once it has moved.
  document.addEventListener(
    'transitionend',
    () => {
      if (isOpen) schedule();
    },
    true,
  );
  new MutationObserver(schedule).observe(html, { attributes: true, attributeFilter: ['class', 'data-experience', 'data-universe-ready'] });

  /** Explore Mode's dock folds to its title, so it and the panel share the side of the view. */
  function foldDock(frames = DOCK_WAIT_FRAMES): void {
    if (!isOpen || mode !== 'side' || app.state !== 'explore') return;
    const fold = document.querySelector<HTMLButtonElement>('[data-testid="discover"]:not([hidden]) [data-testid="discover-collapse"]');
    if (fold) {
      if (fold.getAttribute('aria-expanded') === 'true') fold.click();
      return;
    }
    if (frames > 0)
      requestAnimationFrame(() => {
        foldDock(frames - 1);
      });
  }

  /** The explorer's pulled-up sheet (a phone) folds, so the panel has room above it. */
  function foldNavigator(): void {
    document.querySelector<HTMLButtonElement>('.kf-universe.is-sheet-open [data-testid="universe-nav-toggle"]')?.click();
  }

  function setMinimised(next: boolean): void {
    minimised = next;
    const el = container();
    el.classList.toggle('is-minimised', next);
    minimise.setAttribute('aria-expanded', String(!next));
    (minimise.lastElementChild as HTMLElement).textContent = i18n.t(next ? 'ai.ui.restore' : 'ai.ui.minimise');
    if (mode === 'sheet' && isOpen) {
      // Minimised, the sheet is a bar beside the scene (not modal): the scene can be watched and touched.
      if (sheet.open) sheet.close();
      if (next) sheet.show();
      else sheet.showModal();
      (next ? minimise : input).focus({ preventScroll: true });
    }
    showBusy(latest());
    layout();
  }

  /** Puts the content in the column or the sheet, and shows it (the sheet as a modal dialog). */
  function mountIn(next: 'side' | 'sheet'): void {
    mode = next;
    const el = container();
    const other = next === 'side' ? sheet : aside;
    if (sheet.open) sheet.close();
    other.remove();
    other.classList.remove('is-minimised');
    el.append(content);
    root.append(el);
    minimise.hidden = next === 'side';
    html.classList.toggle('kf-ai-side-open', next === 'side');
    html.classList.toggle('kf-ai-sheet-open', next === 'sheet');
    if (next === 'sheet') foldNavigator();
    setMinimised(false);
  }

  function open(): void {
    if (isOpen) {
      if (minimised) setMinimised(false);
      input.focus();
      return;
    }
    isOpen = true;
    askButton.setAttribute('aria-expanded', 'true');
    mountIn(sideQuery.matches ? 'side' : 'sheet');
    watchChrome();
    foldDock();
    showEngine();
    showSuggestions();
    showBusy(latest());
    layout();
    input.focus({ preventScroll: true });
    // With a conversation, the latest of it; without, the introduction from its start.
    scroller.scrollTop = views.size > 0 ? scroller.scrollHeight : 0;
  }

  /** Closes the panel; focus goes back to Ask unless it already went somewhere on purpose. */
  function close(refocus = true): void {
    if (!isOpen) return;
    isOpen = false;
    const hadFocus = content.contains(document.activeElement);
    if (sheet.open) sheet.close();
    aside.remove();
    sheet.remove();
    html.classList.remove('kf-ai-side-open', 'kf-ai-sheet-open');
    askButton.setAttribute('aria-expanded', 'false');
    watcher.disconnect();
    layout();
    if (refocus || hadFocus) askButton.focus({ preventScroll: true });
  }

  closeButton.addEventListener('click', () => {
    close();
  });
  minimise.addEventListener('click', () => {
    setMinimised(!minimised);
  });
  // Esc inside the panel closes it (and nothing else hears it); outside, the scene's Esc is its own.
  content.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  sheet.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  // Behind the modal sheet nothing else can take a key: an Esc with focus fallen to the page closes the sheet too.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !isOpen || mode !== 'sheet' || minimised || !sheet.open) return;
      if (event.target instanceof Node && content.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    true,
  );

  sideQuery.addEventListener('change', () => {
    if (!isOpen) return;
    const focused = content.contains(document.activeElement);
    mountIn(sideQuery.matches ? 'side' : 'sheet');
    watchChrome();
    layout();
    if (focused) input.focus({ preventScroll: true });
  });

  for (const name of ['route', 'state', 'universe', 'chapter'] as const) {
    app.events.on(name, () => {
      if (!isOpen) return;
      watchChrome();
      schedule();
      if (name === 'state') foldDock();
      if (name === 'route') showSuggestions();
    });
  }

  return {
    open,
    close() {
      close();
    },
    toggle() {
      if (isOpen) close();
      else open();
    },
  };
}
