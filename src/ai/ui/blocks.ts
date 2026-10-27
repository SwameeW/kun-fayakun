/**
 * A turn of the conversation on screen: the question, then each answer block as real DOM text,
 * labelled with what kind of thing it is (docs/AI-INTELLIGENCE.md §5).
 * - text: the explanation, with who wrote it (a model on this device, the browser's model, the
 *   guide, or the test engine) and an honest note of anything the guards changed;
 * - verse and hadith: drawn from data by src/ui/scripture.ts (never a model's words; no hadith
 *   wording, no transliteration);
 * - facts: value, unit, kind and source links;
 * - comparison: the laboratory's two runs side by side, a thought experiment with each run's energy error;
 * - passage: the app's own notes, with a link to where they live;
 * - action: the preview sentence and its status in words, with Confirm and Cancel for an experiment
 *   (nothing runs before Confirm) and Undo for a view;
 * - notice.
 * A turn re-renders only the blocks that changed, so a streamed explanation grows in place and
 * scripture is not rebuilt with every word.
 */
import type { App, I18n } from '../../core/types';
import { externalLink, h } from '../../ui/dom';
import { resolveCitation, scientificNode } from '../../ui/format';
import { chapterHash } from '../../ui/route';
import { hadithArticle, verseArticle } from '../../ui/scripture';
import { findModel } from '../engine/catalogue';
import { blockKnowledge } from '../index';
import type { AnswerBlock, Comparison, Fact, KnowledgeKind, ToolKind, Turn } from '../types';

export interface TurnActions {
  confirm(turnId: string, callId: string, accept: boolean): void;
  undo(turnId: string, callId: string): void;
  kindOf(tool: string): ToolKind | null;
  /** A link inside an answer took the visitor elsewhere in the app. */
  navigated(): void;
}

export interface TurnView {
  readonly element: HTMLLIElement;
  update(turn: Turn): void;
}

/** The task states while a turn is still working. */
export const ACTIVE_STATES: ReadonlySet<Turn['state']> = new Set(['understanding', 'planning', 'acting', 'verifying', 'answering']);

/** A turn's state in plain words while it works, or null once it has finished. */
export function stateText(turn: Turn, i18n: I18n): string | null {
  if (turn.state === 'awaiting-confirmation') return i18n.t('ai.ui.state.awaiting');
  return ACTIVE_STATES.has(turn.state) ? i18n.t(`ai.ui.state.${turn.state}`) : null;
}

/** A model's name for the visitor: the catalogue's ("Qwen3 4B"), else its id. */
export function modelName(id: string | null): string {
  return (id && findModel(id)?.name) ?? id ?? '';
}

/** Who wrote a text block, as its label says. */
function authorLabel(block: Extract<AnswerBlock, { type: 'text' }>, turn: Turn, i18n: I18n): string {
  if (block.by !== 'model') return i18n.t('ai.ui.by.guide');
  if (turn.engine === 'scripted') return i18n.t('ai.ui.by.scripted');
  if (turn.engine === 'browser') return i18n.t('ai.ui.by.browser');
  return i18n.t('ai.ui.by.model', { model: modelName(turn.model) });
}

function label(text: string): HTMLElement {
  return h('p', { class: 'kf-ai-label' }, text);
}

function kindLabel(kind: KnowledgeKind | null, i18n: I18n): HTMLElement | null {
  return kind ? h('p', { class: `kf-ai-label kf-ai-label--${kind}`, 'data-kind': kind }, i18n.t(`ai.ui.kind.${kind}`)) : null;
}

/** A value as the app shows numbers: grouped, a sensible number of decimals, very large or small ones in powers of ten. */
function valueNode(value: number | string, i18n: I18n): Node {
  if (typeof value === 'string') return document.createTextNode(value);
  const a = Math.abs(value);
  if (value !== 0 && (a >= 1e7 || a < 1e-3)) return scientificNode(value, i18n, 3);
  return document.createTextNode(i18n.number(value, Number.isInteger(value) || a >= 1000 ? 0 : a >= 10 ? 2 : 3));
}

/** A message with nodes in place of its {name} arguments (for values drawn as elements). */
function richText(message: string, nodes: Readonly<Record<string, Node>>): Node[] {
  return message.split(/\uE000(\w+)\uE000/u).map((part, i) => (i % 2 === 1 ? (nodes[part] ?? document.createTextNode('')) : document.createTextNode(part)));
}

function richMessage(i18n: I18n, key: string, nodes: Readonly<Record<string, Node>>): Node[] {
  const marks = Object.fromEntries(Object.keys(nodes).map((name) => [name, `\uE000${name}\uE000`]));
  return richText(i18n.t(key, marks), nodes);
}

/* ---------------- each kind of block ---------------- */

function textBlock(block: Extract<AnswerBlock, { type: 'text' }>, turn: Turn, i18n: I18n): HTMLElement {
  const paragraphs = block.text
    .split(/\n{2,}/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => h('p', {}, p));
  const flags = block.flags ?? [];
  let note: HTMLElement | null = null;
  if (flags.length > 0) {
    const unchecked = block.text.split(i18n.t('ai.mind.guard.unchecked')).length - 1;
    const lines = [...new Set(flags)].flatMap((flag) => {
      if (flag === 'unchecked-number') return unchecked > 0 ? [i18n.t('ai.ui.flag.unchecked', { count: unchecked })] : [];
      return [i18n.t(`ai.ui.flag.${flag}`)];
    });
    if (lines.length > 0) {
      note = h(
        'div',
        { class: 'kf-ai-flags', role: 'note', 'data-testid': 'ai-flags' },
        h('p', { class: 'kf-ai-flags-title' }, i18n.t('ai.ui.flags.title')),
        h('ul', {}, ...lines.map((line) => h('li', {}, line))),
      );
    }
  }
  return h(
    'section',
    { class: 'kf-ai-block kf-ai-text', 'data-block': 'text', 'data-by': block.by ?? 'guide' },
    h('p', { class: 'kf-ai-label kf-ai-label--explanation', 'data-testid': 'ai-author' }, authorLabel(block, turn, i18n)),
    h('div', { class: 'kf-ai-prose' }, ...paragraphs),
    note,
  );
}

function scriptureBlock(block: Extract<AnswerBlock, { type: 'verse' | 'hadith' }>, app: App): HTMLElement {
  const { i18n, data } = app;
  // The verse without the transliteration (licensed for non-commercial use, and not the assistant's to use); a hadith without wording.
  const article =
    block.type === 'verse'
      ? verseArticle(block.key, data, i18n, undefined, { translit: false })
      : hadithArticle(block.id, data, i18n, { ...(block.summaryKey ? { summaryKey: block.summaryKey } : {}), wording: false });
  return h('section', { class: 'kf-ai-block kf-ai-scripture', 'data-block': block.type }, kindLabel('scripture', i18n), article);
}

function sources(fact: Fact, app: App): Node[] {
  const ids = fact.sourceIds ?? [];
  const links = ids.flatMap((id) => {
    const c = resolveCitation(id, app.data);
    if (!c) return [];
    return [c.url ? externalLink(c.url, c.text) : document.createTextNode(c.text)];
  });
  if (links.length === 0) return [document.createTextNode(app.i18n.t('ai.ui.facts.calculated'))];
  return links.flatMap((link, i) => (i === 0 ? [link] : [document.createTextNode('; '), link]));
}

function factsBlock(block: Extract<AnswerBlock, { type: 'facts' }>, app: App): HTMLElement {
  const { i18n } = app;
  const rows = block.facts.map((f) =>
    h(
      'tr',
      { 'data-fact': f.id },
      h('th', { scope: 'row' }, f.label),
      h('td', { class: 'kf-ai-value' }, valueNode(f.value, i18n), f.unit ? ` ${f.unit}` : ''),
      h('td', { 'data-kind': f.knowledge }, i18n.t(`ai.ui.kindShort.${f.knowledge}`)),
      h('td', { class: 'kf-ai-source' }, ...sources(f, app)),
    ),
  );
  return h(
    'section',
    { class: 'kf-ai-block kf-ai-facts', 'data-block': 'facts' },
    kindLabel(blockKnowledge(block), i18n),
    h(
      'table',
      { class: 'kf-ai-table', 'data-testid': 'ai-facts' },
      h('caption', {}, i18n.t('ai.ui.facts.caption')),
      h('thead', {}, h('tr', {}, ...['what', 'value', 'kind', 'source'].map((c) => h('th', { scope: 'col' }, i18n.t(`ai.ui.facts.${c}`))))),
      h('tbody', {}, ...rows),
    ),
  );
}

function comparisonBlock(c: Comparison, i18n: I18n): HTMLElement {
  const cell = (v: number | null): Node => (v === null ? document.createTextNode(i18n.t('ai.ui.compare.missing')) : valueNode(v, i18n));
  const energy = (v: number): Node => (Number.isFinite(v) ? scientificNode(Math.abs(v), i18n, 1) : document.createTextNode(i18n.t('ai.ui.compare.missing')));
  return h(
    'section',
    { class: 'kf-ai-block kf-ai-compare', 'data-block': 'comparison' },
    kindLabel('simulation', i18n),
    h(
      'table',
      { class: 'kf-ai-table', 'data-testid': 'ai-comparison' },
      h('caption', {}, i18n.t('ai.ui.compare.caption', { days: i18n.number(c.horizonDays, 2) })),
      h('thead', {}, h('tr', {}, ...['what', 'baseline', 'variant'].map((k) => h('th', { scope: 'col' }, i18n.t(`ai.ui.compare.${k}`))))),
      h('tbody', {}, ...c.rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, r.unit ? `${r.label} (${r.unit})` : r.label), h('td', {}, cell(r.baseline)), h('td', {}, cell(r.variant))))),
    ),
    c.events.length > 0
      ? h('div', {}, h('p', { class: 'kf-ai-subhead' }, i18n.t('ai.ui.compare.events')), h('ul', { class: 'kf-ai-events' }, ...c.events.map((e) => h('li', {}, e))))
      : h('p', {}, i18n.t('ai.ui.compare.noEvents')),
    h('p', { class: 'kf-ai-energy' }, ...richMessage(i18n, 'ai.ui.compare.energy', { baseline: energy(c.energyError.baseline), variant: energy(c.energyError.variant) })),
  );
}

function passageBlock(block: Extract<AnswerBlock, { type: 'passage' }>, app: App, actions: TurnActions): HTMLElement {
  const { i18n } = app;
  const p = block.passage;
  const meta = p.chapter ? app.chapters.find((c) => c.id === p.chapter) : undefined;
  let link: HTMLAnchorElement | null = null;
  if (meta) link = h('a', { href: chapterHash(meta.number) }, i18n.t('ai.ui.passage.chapter', { number: meta.number }));
  else if (p.kind === 'source') link = h('a', { href: '#/sources' }, i18n.t('ai.ui.passage.sources'));
  else if (p.kind === 'place' || p.kind === 'fact') link = h('a', { href: '#/universe' }, i18n.t('ai.ui.passage.explorer'));
  link?.addEventListener('click', () => {
    actions.navigated();
  });
  return h(
    'section',
    { class: 'kf-ai-block kf-ai-passage', 'data-block': 'passage', 'data-passage': p.id },
    kindLabel(blockKnowledge(block), i18n),
    h('h3', { class: 'kf-ai-passage-title' }, p.title),
    h('p', {}, p.text),
    link ? h('p', { class: 'kf-ai-link' }, link) : null,
  );
}

function actionStatus(block: Extract<AnswerBlock, { type: 'action' }>, i18n: I18n): string {
  if (block.status === 'refused' && block.reason && i18n.has(block.reason.messageKey)) {
    return i18n.t('ai.ui.action.status.refusedWhy', { why: i18n.t(block.reason.messageKey, block.reason.values) });
  }
  return i18n.t(`ai.ui.action.status.${block.status}`);
}

function actionBlock(block: Extract<AnswerBlock, { type: 'action' }>, turn: Turn, i18n: I18n, actions: TurnActions): HTMLElement {
  const experiment = actions.kindOf(block.tool) === 'experiment';
  const buttons: HTMLButtonElement[] = [];
  const button = (text: string, testId: string, primary: boolean, run: () => void): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: `kf-btn${primary ? ' kf-btn--primary' : ''}`, 'data-testid': testId }, text);
    b.addEventListener('click', () => {
      // One press is enough: the card's buttons go quiet until the turn says what happened.
      for (const other of buttons) other.disabled = true;
      run();
    });
    buttons.push(b);
    return b;
  };
  if (block.status === 'awaiting') {
    button(i18n.t('ai.ui.action.confirm'), 'ai-confirm', true, () => {
      actions.confirm(turn.id, block.callId, true);
    });
    button(i18n.t('ai.ui.action.cancel'), 'ai-cancel', false, () => {
      actions.confirm(turn.id, block.callId, false);
    });
  } else if (block.undoable) {
    button(i18n.t('ai.ui.action.undo'), 'ai-undo', false, () => {
      actions.undo(turn.id, block.callId);
    });
  }
  return h(
    'section',
    { class: 'kf-ai-block kf-ai-action', 'data-block': 'action', 'data-status': block.status, 'data-tool': block.tool, 'data-testid': 'ai-action' },
    label(i18n.t(experiment ? 'ai.ui.action.experiment' : 'ai.ui.action.label')),
    h('p', { class: 'kf-ai-preview' }, block.preview),
    h('p', { class: 'kf-ai-status', 'data-testid': 'ai-action-status' }, actionStatus(block, i18n)),
    buttons.length > 0 ? h('div', { class: 'kf-ai-buttons' }, ...buttons) : null,
  );
}

function render(block: AnswerBlock, turn: Turn, app: App, actions: TurnActions): HTMLElement {
  const { i18n } = app;
  switch (block.type) {
    case 'text':
      return textBlock(block, turn, i18n);
    case 'verse':
    case 'hadith':
      return scriptureBlock(block, app);
    case 'facts':
      return factsBlock(block, app);
    case 'comparison':
      return comparisonBlock(block.comparison, i18n);
    case 'passage':
      return passageBlock(block, app, actions);
    case 'action':
      return actionBlock(block, turn, i18n, actions);
    case 'notice':
      return h('p', { class: 'kf-ai-block kf-ai-notice', 'data-block': 'notice', 'data-key': block.key }, i18n.t(block.key, block.values));
  }
}

/** What a block shows, so an unchanged block is left alone (a streamed text block also depends on who wrote it). */
function signature(block: AnswerBlock, turn: Turn): string {
  return block.type === 'text' ? `${JSON.stringify(block)}|${turn.engine}|${turn.model ?? ''}` : JSON.stringify(block);
}

export function createTurnView(app: App, actions: TurnActions): TurnView {
  const { i18n } = app;
  const question = h('p', { class: 'kf-ai-question' });
  const blocks = h('div', { class: 'kf-ai-blocks' });
  const status = h('p', { class: 'kf-ai-turn-state', 'data-testid': 'ai-turn-state', hidden: true });
  const element = h('li', { class: 'kf-ai-turn' }, h('p', { class: 'kf-ai-label kf-ai-you' }, i18n.t('ai.ui.you')), question, blocks, status);
  let shown: { sig: string; el: HTMLElement }[] = [];

  return {
    element,
    update(turn) {
      element.dataset.turn = turn.id;
      element.dataset.state = turn.state;
      if (question.textContent !== turn.question) question.textContent = turn.question;
      const next: { sig: string; el: HTMLElement }[] = [];
      turn.blocks.forEach((block, i) => {
        const sig = signature(block, turn);
        const old = shown[i];
        if (old?.sig === sig) {
          next.push(old);
          return;
        }
        const el = render(block, turn, app, actions);
        const hadFocus = old?.el.contains(document.activeElement) ?? false;
        if (old) old.el.replaceWith(el);
        else blocks.append(el);
        // A card redrawn under the visitor's focus (Confirm, Undo pressed) keeps it: its new button, or the card.
        if (hadFocus) {
          const target = el.querySelector<HTMLElement>('button') ?? el;
          if (target === el) el.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
        next.push({ sig, el });
      });
      for (const extra of shown.slice(turn.blocks.length)) extra.el.remove();
      shown = next;
      const line = stateText(turn, i18n);
      status.hidden = line === null;
      status.textContent = line ?? '';
    },
  };
}
