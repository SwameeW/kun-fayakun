/**
 * Kun Fayakun Intelligence: the orchestrator (docs/AI-INTELLIGENCE.md §2). Lazy: nothing here
 * loads until the visitor presses Ask, and it never runs inference anywhere but this browser.
 *
 * A turn moves through the task states:
 *   understanding → planning → (awaiting-confirmation) → acting → verifying → answering → done
 * (or failed, or cancelled at any point).
 * - understanding: the input guard cleans the question.
 * - planning: the deterministic router first; if it is unsure and a model is loaded, the model
 *   plans under a JSON schema over a shortlist of tools (temperature 0), each call validated by the
 *   registry, with one repair attempt that tells it what was wrong; otherwise retrieval answers.
 * - acting: read, calc, cite and view tools run at once; an experiment becomes a card that waits for
 *   the visitor (confirm), because it changes the laboratory.
 * - verifying: what is said about an action comes only from its tool's outcome (read back from the
 *   app's state), never from the plan.
 * - answering: with a model, its prose grounded in the passages and facts, streamed, then passed
 *   through the output guards and its citation markers expanded into verse, hadith, fact and passage
 *   blocks; with the guide, a template from en.ai.mind.json and the top passages.
 * Every block carries its knowledge kind (blockKnowledge); the text block is always 'explanation'.
 */
import type { App, BodyId, I18n } from '../core/types';
import { createEventBus } from '../core/events';
import messages from '../i18n/en.ai.mind.json' with { type: 'json' };
import { readContext } from './context';
import { guardInput, guardOutput, stripMarkers, type OutcomeSummary } from './guards';
import { createMemory, type AiMemory } from './memory';
import { ANSWER_MAX_TOKENS, buildAnswerMessages, buildPlanMessages, buildRepairMessages, PLAN_MAX_TOKENS, planSchema, type ActionLine, type HistoryItem } from './prompts';
import { route } from './router';
import type {
  AiContext,
  AnswerBlock,
  ChatMessage,
  EngineError,
  EngineHost,
  EngineKind,
  Fact,
  GenerateResult,
  Intelligence,
  IntelligenceEvents,
  KnowledgeKind,
  LanguageEngine,
  ModelSpec,
  Passage,
  Plan,
  Retriever,
  TaskState,
  ToolCall,
  ToolDefinition,
  ToolEnv,
  ToolOutcome,
  ToolRegistry,
  Turn,
} from './types';

export { readContext } from './context';
export { route } from './router';
export { createScriptedEngine } from './engine/scripted';
export { loadRetriever } from './knowledge';

export interface IntelligenceDeps {
  registry: ToolRegistry;
  host: EngineHost;
  /** The knowledge index's retriever (loadRetriever(app)), asked for once and kept. */
  retriever: () => Promise<Retriever>;
  /** Speaks a short status line to screen readers (an aria-live region). */
  announce?: (text: string) => void;
  /** Where the visitor is; readContext(app) unless a test gives its own. */
  context?: () => AiContext;
  /** Opt-in memory; createMemory() unless a test gives its own. */
  memory?: AiMemory;
  /** A model is unloaded after this long without use (default 10 minutes). */
  idleUnloadMs?: number;
}

/** The assistant, with what the test hook and the interface's settings also need. */
export interface AiOrchestrator extends Intelligence {
  /** Uses this engine directly (the scripted test engine, through the test hook). */
  attach(engine: LanguageEngine): void;
  readonly memory: AiMemory;
}

/** The knowledge kind a block shows (null for the interface's own blocks: actions and notices). */
export function blockKnowledge(block: AnswerBlock): KnowledgeKind | null {
  switch (block.type) {
    case 'text':
      return 'explanation';
    case 'passage':
      return block.passage.knowledge;
    case 'verse':
    case 'hadith':
      return 'scripture';
    case 'facts':
      return block.facts[0]?.knowledge ?? null;
    case 'comparison':
      return 'simulation';
    case 'action':
    case 'notice':
      return null;
  }
}

const IDLE_UNLOAD_MS = 10 * 60 * 1000;
/** Tools offered to a model for one plan. */
const SHORTLIST = 9;
/** Passages given to a model, and shown by the guide. */
const MODEL_PASSAGES = 5;
const GUIDE_PASSAGES = 3;
/** Retrieval results below this score are not shown (they share a word or two by chance). */
const MIN_SCORE = 1.5;
/** Turns kept for turns() and for the prompts' history. */
const KEEP_TURNS = 50;
const HISTORY_TURNS = 3;
const ACTIVE: ReadonlySet<TaskState> = new Set(['understanding', 'planning', 'acting', 'verifying', 'answering']);

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Pending {
  call: ToolCall;
  tool: ToolDefinition;
}

interface Done {
  callId: string;
  call: ToolCall;
  tool: ToolDefinition;
  preview: string;
  outcome: ToolOutcome;
}

interface TurnRecord {
  turn: {
    id: string;
    question: string;
    state: TaskState;
    plan: Plan | null;
    blocks: AnswerBlock[];
    engine: EngineKind;
    model: string | null;
    timings: { planMs: number; actMs: number; answerMs: number; tokens: number };
  };
  controller: AbortController;
  ctx: AiContext;
  pending: Map<string, Pending>;
  undo: Map<string, () => Promise<void> | void>;
  done: Done[];
  facts: Fact[];
  passages: Passage[];
}

type EngineState = ReturnType<Intelligence['engine']>;

function isEngineError(value: unknown): value is EngineError {
  return typeof value === 'object' && value !== null && typeof (value as EngineError).code === 'string' && typeof (value as EngineError).messageKey === 'string';
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const BODY_NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName', mercury: 'ui.hud.planet.mercury', venus: 'ui.hud.planet.venus', earth: 'ui.hud.earth', moon: 'ui.hud.moon',
  mars: 'ui.hud.planet.mars', jupiter: 'ui.hud.planet.jupiter', saturn: 'ui.hud.planet.saturn', uranus: 'ui.hud.planet.uranus', neptune: 'ui.hud.planet.neptune',
};

const SUGGESTIONS: Readonly<Record<AiContext['where'], readonly string[]>> = {
  home: ['ai.mind.suggest.home.1', 'ai.mind.suggest.home.2', 'ai.mind.suggest.home.3', 'ai.mind.suggest.home.4'],
  chapter: ['ai.mind.suggest.chapter.1', 'ai.mind.suggest.chapter.2', 'ai.mind.suggest.chapter.3'],
  sources: ['ai.mind.suggest.sources.1', 'ai.mind.suggest.sources.2', 'ai.mind.suggest.sources.3'],
  explorer: ['ai.mind.suggest.explorer.1', 'ai.mind.suggest.explorer.2', 'ai.mind.suggest.explorer.3', 'ai.mind.suggest.explorer.4'],
  lab: ['ai.mind.suggest.lab.1', 'ai.mind.suggest.lab.2', 'ai.mind.suggest.lab.3', 'ai.mind.suggest.lab.4'],
};

const EMPTY_RETRIEVER: Retriever = { search: () => [], get: () => null };

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/['’]/gu, '').trim();
}

/** A named place's coordinates from the knowledge index (its places carry "lat,lon" as ref). */
function placeFrom(retriever: Retriever, name: string): { name: string; lat: number; lon: number } | null {
  const want = fold(name);
  for (const { passage } of retriever.search(name, { kinds: ['place'], limit: 8 })) {
    if (!passage.ref) continue;
    const title = fold(passage.title);
    if (title !== want && !title.startsWith(`${want},`) && !title.startsWith(`${want} (`)) continue;
    const [lat, lon] = passage.ref.split(',').map(Number);
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    return { name: passage.title, lat, lon };
  }
  return null;
}

function problemText(i18n: I18n, call: ToolCall, problems: readonly { path: string; messageKey: string; values?: Record<string, string | number> }[]): string[] {
  return problems.map((p) => `${call.tool}${p.path ? ` ${p.path}` : ''}: ${i18n.has(p.messageKey) ? i18n.t(p.messageKey, p.values) : p.messageKey}`);
}

/** The first JSON object in a reply (models sometimes wrap it in a code fence or a sentence). */
function jsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

export function createIntelligence(app: App, deps: IntelligenceDeps): AiOrchestrator {
  const { i18n } = app;
  i18n.extend('en.ai.mind.json', messages);
  const events = createEventBus<IntelligenceEvents>();
  const registry = deps.registry;
  const host = deps.host;
  const memory = deps.memory ?? createMemory();
  const context = deps.context ?? ((): AiContext => readContext(app));
  const idleMs = deps.idleUnloadMs ?? IDLE_UNLOAD_MS;
  const announce = (key: string, values?: Record<string, string | number>): void => {
    try {
      deps.announce?.(i18n.t(key, values));
    } catch {
      /* the interface's live region is optional */
    }
  };

  let records: TurnRecord[] = [];
  let current: TurnRecord | null = null;
  let counter = 0;
  let engine: LanguageEngine | null = null;
  /** What the visitor chose, so a model unloaded while idle loads again with the next question. */
  let chosen: ModelSpec | 'browser' | LanguageEngine | null = null;
  let engineState: EngineState = { kind: 'guide', model: null, state: 'ready' };
  let loading: AbortController | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let retrieverPromise: Promise<Retriever> | null = null;

  /* ---------------- engine ---------------- */

  function setEngine(state: EngineState & { progress?: IntelligenceEvents['engine']['progress']; error?: EngineError }): void {
    engineState = { kind: state.kind, model: state.model, state: state.state };
    events.emit('engine', state);
  }

  function nameOf(choice: ModelSpec | 'browser' | LanguageEngine): { kind: EngineKind; model: string } {
    if (choice === 'browser') return { kind: 'browser', model: 'browser' };
    if ('generate' in choice) return { kind: choice.kind, model: choice.model };
    return { kind: 'local', model: choice.id };
  }

  function touch(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!engine) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!engine || (current && ACTIVE.has(current.turn.state))) {
        touch();
        return;
      }
      const e = engine;
      engine = null;
      void e.unload().catch(() => undefined);
      setEngine({ kind: engineState.kind, model: engineState.model, state: 'off' });
      announce('ai.mind.announce.engineOff');
    }, idleMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function load(choice: ModelSpec | 'browser' | LanguageEngine, signal?: AbortSignal): Promise<boolean> {
    const { kind, model } = nameOf(choice);
    if (typeof choice === 'object' && 'generate' in choice) {
      engine = choice;
      chosen = choice;
      setEngine({ kind, model, state: 'ready' });
      touch();
      return true;
    }
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    const onAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    setEngine({ kind, model, state: 'loading' });
    announce('ai.mind.announce.engineLoading', { model });
    try {
      const loaded = await host.load(choice, (progress) => {
        if (loading === controller) events.emit('engine', { kind, model, state: 'loading', progress });
      }, controller.signal);
      if (controller.signal.aborted) {
        void loaded.unload().catch(() => undefined);
        return false;
      }
      engine = loaded;
      chosen = choice;
      setEngine({ kind: loaded.kind, model: loaded.model, state: 'ready' });
      announce('ai.mind.announce.engineReady', { model: loaded.model });
      touch();
      return true;
    } catch (err) {
      if (controller.signal.aborted) {
        setEngine({ kind: 'guide', model: null, state: 'ready' });
        return false;
      }
      const error: EngineError = isEngineError(err) ? err : { code: 'unknown', messageKey: 'ai.mind.announce.engineError', detail: err instanceof Error ? err.message : String(err) };
      engine = null;
      setEngine({ kind, model, state: 'error', error });
      announce('ai.mind.announce.engineError', { model });
      return false;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (loading === controller) loading = null;
    }
  }

  async function unloadEngine(): Promise<void> {
    loading?.abort();
    const e = engine;
    engine = null;
    chosen = null;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (e) await e.unload().catch(() => undefined);
  }

  /** A model chosen but unloaded while idle loads again before it is needed. */
  async function ensureEngine(signal: AbortSignal): Promise<void> {
    if (engine || !chosen) return;
    await load(chosen, signal);
  }

  /* ---------------- turns ---------------- */

  function snapshot(rec: TurnRecord): Turn {
    const t = rec.turn;
    return { id: t.id, question: t.question, state: t.state, plan: t.plan, blocks: [...t.blocks], engine: t.engine, model: t.model, timings: { ...t.timings } };
  }

  function emit(rec: TurnRecord): void {
    events.emit('turn', { turn: snapshot(rec) });
  }

  function setState(rec: TurnRecord, state: TaskState): void {
    if (rec.turn.state === state) return;
    rec.turn.state = state;
    emit(rec);
  }

  function addBlock(rec: TurnRecord, block: AnswerBlock): number {
    rec.turn.blocks.push(block);
    emit(rec);
    return rec.turn.blocks.length - 1;
  }

  function replaceBlock(rec: TurnRecord, index: number, block: AnswerBlock): void {
    rec.turn.blocks[index] = block;
    emit(rec);
  }

  function actionIndex(rec: TurnRecord, callId: string): number {
    return rec.turn.blocks.findIndex((b) => b.type === 'action' && b.callId === callId);
  }

  function checkpoint(rec: TurnRecord): void {
    if (rec.controller.signal.aborted) throw new Cancelled();
  }

  function finished(rec: TurnRecord): boolean {
    return rec.turn.state === 'done' || rec.turn.state === 'failed' || rec.turn.state === 'cancelled';
  }

  function cancelRecord(rec: TurnRecord): void {
    if (finished(rec)) return;
    rec.controller.abort();
    engine?.interrupt();
    for (const callId of rec.pending.keys()) {
      const i = actionIndex(rec, callId);
      const b = rec.turn.blocks[i];
      if (b?.type === 'action') rec.turn.blocks[i] = { ...b, status: 'cancelled' };
    }
    rec.pending.clear();
    rec.turn.blocks.push({ type: 'notice', key: 'ai.mind.notice.cancelled' });
    rec.turn.state = 'cancelled';
    emit(rec);
    announce('ai.mind.announce.cancelled');
  }

  function history(except: TurnRecord): HistoryItem[] {
    return records
      .filter((r) => r !== except && r.turn.state === 'done')
      .slice(-HISTORY_TURNS)
      .map((r) => ({ question: r.turn.question, answer: answerText(r) }));
  }

  function answerText(rec: TurnRecord): string {
    return rec.turn.blocks
      .filter((b): b is Extract<AnswerBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .slice(0, 600);
  }

  function getRetriever(): Promise<Retriever> {
    retrieverPromise ??= deps.retriever().catch((err: unknown) => {
      retrieverPromise = null;
      throw err;
    });
    return retrieverPromise;
  }

  function env(rec: TurnRecord, retriever: Retriever): ToolEnv {
    const signal = rec.controller.signal;
    return {
      app,
      i18n,
      signal,
      context,
      retriever,
      until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
          const start = Date.now();
          const tick = (): void => {
            if (signal.aborted) {
              resolve(false);
              return;
            }
            let held: boolean;
            try {
              held = predicate();
            } catch {
              held = false;
            }
            if (held) resolve(true);
            else if (Date.now() - start >= timeoutMs) resolve(false);
            else setTimeout(tick, 40);
          };
          tick();
        });
      },
    };
  }

  function preview(tool: ToolDefinition, args: Record<string, unknown>, ctx: AiContext): string {
    try {
      return tool.preview(args, ctx, i18n);
    } catch {
      return tool.name;
    }
  }

  async function runTool(rec: TurnRecord, tool: ToolDefinition, call: ToolCall, retriever: Retriever): Promise<ToolOutcome> {
    try {
      const outcome = await tool.run(call.args, env(rec, retriever));
      return outcome;
    } catch (err) {
      if (rec.controller.signal.aborted) throw new Cancelled();
      console.warn(`ai: ${tool.name} failed`, err);
      return { status: 'failed' };
    }
  }

  /** Records what a tool reported: its facts and blocks, and the action card for a view or experiment. */
  function record(rec: TurnRecord, callId: string, tool: ToolDefinition, call: ToolCall, outcome: ToolOutcome, shown: string): void {
    rec.done.push({ callId, call, tool, preview: shown, outcome });
    if (outcome.undo) rec.undo.set(callId, outcome.undo);
    const i = actionIndex(rec, callId);
    const card: AnswerBlock = { type: 'action', callId, tool: tool.name, preview: shown, status: outcome.status, undoable: Boolean(outcome.undo) && outcome.status === 'done' };
    if (i >= 0) rec.turn.blocks[i] = card;
    else if (tool.kind === 'view' || tool.kind === 'experiment' || outcome.status !== 'done') rec.turn.blocks.push(card);
    if (outcome.facts?.length) rec.facts.push(...outcome.facts);
    const blocks = outcome.blocks ?? [];
    rec.turn.blocks.push(...blocks);
    if (outcome.facts?.length && !blocks.some((b) => b.type === 'facts')) rec.turn.blocks.push({ type: 'facts', facts: outcome.facts });
    emit(rec);
  }

  async function execute(rec: TurnRecord, calls: readonly ToolCall[], retriever: Retriever): Promise<void> {
    for (const [n, call] of calls.entries()) {
      checkpoint(rec);
      const tool = registry.get(call.tool);
      if (!tool) continue;
      const callId = `c${n + 1}`;
      const shown = preview(tool, call.args, rec.ctx);
      if (tool.kind === 'experiment') {
        rec.pending.set(callId, { call, tool });
        addBlock(rec, { type: 'action', callId, tool: tool.name, preview: shown, status: 'awaiting', undoable: false });
        continue;
      }
      const outcome = await runTool(rec, tool, call, retriever);
      checkpoint(rec);
      record(rec, callId, tool, call, outcome, shown);
    }
  }

  /** The model's plan, validated; one repair attempt; null when it cannot be used. */
  async function modelPlan(rec: TurnRecord, question: string): Promise<Plan | null> {
    const e = engine;
    if (!e) return null;
    const tools = registry.shortlist(question, rec.ctx, SHORTLIST);
    const schema = planSchema(tools);
    let messagesNow: ChatMessage[] = buildPlanMessages(question, rec.ctx, tools, history(rec));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generate(rec, e, { messages: messagesNow, format: { kind: 'json', schema }, maxTokens: PLAN_MAX_TOKENS, temperature: 0, signal: rec.controller.signal });
      checkpoint(rec);
      const parsed = result.finish === 'error' ? { plan: null, problems: ['the engine stopped with an error'] } : parsePlan(result.text, rec.ctx, question);
      if (parsed.plan) return parsed.plan;
      if (result.finish === 'error') break;
      messagesNow = buildRepairMessages(messagesNow, result.text, parsed.problems);
    }
    addBlock(rec, { type: 'notice', key: 'ai.mind.notice.planFallback' });
    return null;
  }

  function parsePlan(text: string, ctx: AiContext, question: string): { plan: Plan; problems: [] } | { plan: null; problems: string[] } {
    let raw: unknown;
    try {
      raw = jsonObject(text);
    } catch {
      return { plan: null, problems: ['the reply was not one JSON object'] };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { plan: null, problems: ['the reply was not a JSON object'] };
    const r = raw as { intent?: unknown; query?: unknown; question?: unknown; calls?: unknown };
    const problems: string[] = [];
    const intent = typeof r.intent === 'string' && ['answer', 'act', 'clarify', 'decline'].includes(r.intent) ? (r.intent as Plan['intent']) : null;
    if (!intent) problems.push('intent must be one of answer, act, clarify, decline');
    const callsRaw = r.calls === undefined ? [] : r.calls;
    if (!Array.isArray(callsRaw)) problems.push('calls must be an array');
    const list = Array.isArray(callsRaw) ? (callsRaw as unknown[]) : [];
    if (list.length > 3) problems.push('at most 3 calls');
    const calls: ToolCall[] = [];
    for (const item of list.slice(0, 3)) {
      if (typeof item !== 'object' || item === null || typeof (item as ToolCall).tool !== 'string') {
        problems.push('each call needs a tool name and args');
        continue;
      }
      const c = item as { tool: string; args?: unknown };
      const args = typeof c.args === 'object' && c.args !== null && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};
      const call: ToolCall = { tool: c.tool, args };
      const v = registry.validate(call, ctx);
      if (v.ok) calls.push(v.call);
      else problems.push(...(v.problems.length ? problemText(i18n, call, v.problems) : [`${call.tool}: not accepted here`]));
    }
    if (problems.length > 0 || !intent) return { plan: null, problems };
    const query = typeof r.query === 'string' && r.query.trim() ? r.query.trim().slice(0, 160) : undefined;
    const clarify = typeof r.question === 'string' && r.question.trim() ? r.question.trim().slice(0, 200) : undefined;
    if (intent === 'clarify' && !clarify) return { plan: null, problems: ['clarify needs a question'] };
    const effective: Plan['intent'] = intent === 'act' && calls.length === 0 ? 'answer' : intent;
    return {
      plan: { intent: effective, calls, source: 'model', query: query ?? (effective === 'answer' ? question : undefined), ...(clarify ? { question: clarify } : {}) },
      problems: [],
    };
  }

  async function generate(rec: TurnRecord, e: LanguageEngine, request: Parameters<LanguageEngine['generate']>[0]): Promise<GenerateResult> {
    setEngine({ ...engineState, state: 'busy' });
    try {
      const result = await e.generate(request);
      rec.turn.timings.tokens += result.promptTokens + result.outputTokens;
      if (result.finish === 'abort' || rec.controller.signal.aborted) throw new Cancelled();
      return result;
    } finally {
      if (engine === e) setEngine({ ...engineState, state: 'ready' });
      touch();
    }
  }

  function outcomesFor(rec: TurnRecord): OutcomeSummary[] {
    return rec.done.map((d) => ({ tool: d.tool.name, kind: d.tool.kind, status: d.outcome.status }));
  }

  function actionLines(rec: TurnRecord): ActionLine[] {
    const lines: ActionLine[] = rec.done.map((d) => ({
      tool: d.tool.name,
      preview: d.preview,
      status: d.outcome.status,
      ...(d.outcome.observedKey ? { observed: i18n.t(d.outcome.observedKey, d.outcome.observedValues) } : {}),
    }));
    for (const [callId, p] of rec.pending) {
      const b = rec.turn.blocks[actionIndex(rec, callId)];
      lines.push({ tool: p.tool.name, preview: b?.type === 'action' ? b.preview : p.tool.name, status: 'awaiting' });
    }
    return lines;
  }

  function search(retriever: Retriever, rec: TurnRecord, query: string, limit: number): Passage[] {
    return retriever
      .search(query, { chapter: rec.ctx.chapter, limit })
      .filter((r) => r.score >= MIN_SCORE)
      .map((r) => r.passage);
  }

  /** A passage as the block that shows it best: verses and hadith from data, the rest as passages. */
  function passageBlock(p: Passage): AnswerBlock {
    if (p.kind === 'verse' && p.ref) return { type: 'verse', key: p.ref as `${number}:${number}` };
    if (p.kind === 'hadith' && p.ref) return { type: 'hadith', id: p.ref, ...(p.key ? { summaryKey: p.key } : {}) };
    return { type: 'passage', passage: p };
  }

  function alreadyShown(rec: TurnRecord, block: AnswerBlock): boolean {
    return rec.turn.blocks.some((b) => {
      if (b.type !== block.type) return false;
      if (b.type === 'verse' && block.type === 'verse') return b.key === block.key;
      if (b.type === 'hadith' && block.type === 'hadith') return b.id === block.id;
      if (b.type === 'passage' && block.type === 'passage') return b.passage.id === block.passage.id;
      return false;
    });
  }

  function guideAnswer(rec: TurnRecord, passages: readonly Passage[]): void {
    const lines: string[] = [];
    for (const d of rec.done) {
      const o = d.outcome;
      if (o.status === 'done') {
        if (o.observedKey) lines.push(i18n.t(o.observedKey, o.observedValues));
      } else if (o.status === 'not-confirmed') lines.push(i18n.t('ai.mind.guide.notConfirmed', { what: d.preview }));
      else if (o.status === 'refused') {
        const why = o.problem && i18n.has(o.problem.messageKey) ? i18n.t(o.problem.messageKey, o.problem.values) : '';
        lines.push(why ? i18n.t('ai.mind.guide.refusedWhy', { what: d.preview, why }) : i18n.t('ai.mind.guide.refused', { what: d.preview }));
      } else lines.push(i18n.t('ai.mind.guide.failed', { what: d.preview }));
    }
    if (rec.facts.length > 0) lines.push(i18n.t('ai.mind.guide.facts'));
    const shown = passages.slice(0, GUIDE_PASSAGES).map(passageBlock).filter((b) => !alreadyShown(rec, b));
    if (shown.length > 0) lines.push(i18n.t('ai.mind.guide.found'));
    const hasContent = rec.turn.blocks.some((b) => b.type === 'verse' || b.type === 'hadith' || b.type === 'facts' || b.type === 'comparison' || b.type === 'passage');
    if (lines.length === 0 && !hasContent) lines.push(i18n.t('ai.mind.guide.nothing'));
    if (lines.length > 0) rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text: lines.join(' ') });
    rec.turn.blocks.push(...shown);
    emit(rec);
  }

  async function modelAnswer(rec: TurnRecord, question: string, passages: readonly Passage[], retriever: Retriever): Promise<boolean> {
    const e = engine;
    if (!e) return false;
    const msgs = buildAnswerMessages(question, rec.ctx, passages, rec.facts, actionLines(rec), history(rec));
    const factIds = new Set(rec.facts.map((f) => f.id));
    const passageIds = new Set(passages.map((p) => p.id));
    const given = [question, rec.ctx.summary, ...rec.done.map((d) => JSON.stringify(d.call.args)), ...actionLines(rec).map((a) => a.observed ?? '')];
    const guard = (text: string, truncated: boolean): ReturnType<typeof guardOutput> =>
      guardOutput(text, {
        facts: rec.facts,
        passages,
        given,
        outcomes: outcomesFor(rec),
        known: {
          verse: (key) => retriever.get(`verse:${key}`) !== null,
          hadith: (id) => retriever.get(`hadith:${id}`) !== null,
          fact: (id) => factIds.has(id),
          passage: (id) => passageIds.has(id) || retriever.get(id) !== null,
        },
        verses: (quote) =>
          retriever
            .search(quote, { kinds: ['verse'], limit: 4 })
            .map((r) => ({ key: r.passage.ref ?? r.passage.id.slice('verse:'.length), text: r.passage.text })),
        uncheckedLabel: i18n.t('ai.mind.guard.unchecked'),
        truncated,
      });
    const index = addBlock(rec, { type: 'text', knowledge: 'explanation', text: '' });
    let streamed = '';
    const result = await generate(rec, e, {
      messages: msgs,
      format: { kind: 'text' },
      maxTokens: ANSWER_MAX_TOKENS,
      temperature: 0.3,
      signal: rec.controller.signal,
      onText: (delta) => {
        streamed += delta;
        if (rec.controller.signal.aborted) return;
        // What is on screen while it streams has passed the guards too.
        replaceBlock(rec, index, { type: 'text', knowledge: 'explanation', text: stripMarkers(guard(streamed, false).text) });
      },
    });
    checkpoint(rec);
    if (result.finish === 'error') {
      rec.turn.blocks.splice(index, 1);
      addBlock(rec, { type: 'notice', key: 'ai.mind.notice.engineError' });
      return false;
    }
    const final = guard(result.text, result.finish === 'length');
    const text = stripMarkers(final.text);
    if (text.length === 0) {
      rec.turn.blocks.splice(index, 1);
      if (final.flags.length > 0) addBlock(rec, { type: 'notice', key: 'ai.mind.notice.guarded' });
      return false;
    }
    replaceBlock(rec, index, { type: 'text', knowledge: 'explanation', text, ...(final.flags.length ? { flags: final.flags } : {}) });
    // Citations become blocks shown from data, in the order the text cites them.
    const cited: AnswerBlock[] = [];
    const citedFacts: Fact[] = [];
    for (const c of final.citations) {
      if (c.kind === 'verse') cited.push({ type: 'verse', key: c.id as `${number}:${number}` });
      else if (c.kind === 'hadith') {
        const p = retriever.get(`hadith:${c.id}`);
        cited.push({ type: 'hadith', id: c.id, ...(p?.key ? { summaryKey: p.key } : {}) });
      } else if (c.kind === 'fact') {
        const f = rec.facts.find((x) => x.id === c.id);
        const inFacts = rec.turn.blocks.some((b) => b.type === 'facts' && b.facts.some((x) => x.id === c.id));
        if (f && !inFacts) citedFacts.push(f);
      } else {
        const p = passages.find((x) => x.id === c.id) ?? retriever.get(c.id);
        if (p) cited.push(passageBlock(p));
      }
    }
    if (citedFacts.length) cited.push({ type: 'facts', facts: citedFacts });
    for (const b of cited) if (!alreadyShown(rec, b)) rec.turn.blocks.push(b);
    emit(rec);
    return true;
  }

  /** Verifying and answering, once nothing waits for the visitor. */
  async function conclude(rec: TurnRecord, retriever: Retriever): Promise<void> {
    setState(rec, 'verifying');
    // The action cards already hold each tool's own outcome; nothing is said beyond them.
    checkpoint(rec);
    setState(rec, 'answering');
    const started = now();
    const plan = rec.turn.plan;
    const wantsAnswer = plan?.intent === 'answer';
    const query = plan?.query ?? rec.turn.question;
    const passages = wantsAnswer ? search(retriever, rec, query, MODEL_PASSAGES) : [];
    rec.passages = passages;
    const onlyViews = rec.done.length > 0 && rec.done.every((d) => d.tool.kind === 'view');
    let answered = false;
    if (engine && !(plan?.intent === 'act' && onlyViews)) answered = await modelAnswer(rec, rec.turn.question, passages, retriever);
    checkpoint(rec);
    if (!answered) guideAnswer(rec, passages);
    rec.turn.timings.answerMs += now() - started;
    finish(rec, 'done');
  }

  function finish(rec: TurnRecord, state: 'done' | 'failed'): void {
    rec.turn.state = state;
    emit(rec);
    if (state === 'done') {
      announce('ai.mind.announce.answer');
      const answer = answerText(rec);
      if (answer) void memory.remember({ question: rec.turn.question, answer, at: Date.now() });
    }
  }

  async function runTurn(rec: TurnRecord, raw: string): Promise<void> {
    const started = now();
    const input = guardInput(raw);
    rec.turn.question = input.text;
    if (input.truncated) addBlock(rec, { type: 'notice', key: 'ai.mind.notice.truncated' });
    if (input.text.length === 0) {
      addBlock(rec, { type: 'notice', key: 'ai.mind.notice.empty' });
      finish(rec, 'done');
      return;
    }
    setState(rec, 'planning');
    await ensureEngine(rec.controller.signal);
    checkpoint(rec);
    rec.turn.engine = engine ? engine.kind : 'guide';
    rec.turn.model = engine ? engine.model : null;
    let retriever: Retriever;
    try {
      retriever = await getRetriever();
    } catch {
      retriever = EMPTY_RETRIEVER;
      addBlock(rec, { type: 'notice', key: 'ai.mind.notice.noKnowledge' });
    }
    checkpoint(rec);
    let plan = route(input.text, rec.ctx, registry, { place: (name) => placeFrom(retriever, name) });
    if (!plan && engine) plan = await modelPlan(rec, input.text);
    checkpoint(rec);
    plan ??= { intent: 'answer', query: input.text, calls: [], source: 'router' };
    rec.turn.plan = plan;
    rec.turn.timings.planMs = now() - started;
    emit(rec);

    if (plan.intent === 'decline') {
      rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text: i18n.t('ai.mind.guide.decline') });
      finish(rec, 'done');
      return;
    }
    if (plan.intent === 'clarify' && plan.question) {
      const g = guardOutput(plan.question, {
        facts: [],
        passages: [],
        given: [input.text],
        outcomes: [],
        known: { verse: () => false, hadith: () => false, fact: () => false, passage: () => false },
        verses: (q) => retriever.search(q, { kinds: ['verse'], limit: 4 }).map((r) => ({ key: r.passage.ref ?? '', text: r.passage.text })),
        uncheckedLabel: i18n.t('ai.mind.guard.unchecked'),
      });
      const text = stripMarkers(g.text);
      if (text) rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text, ...(g.flags.length ? { flags: g.flags } : {}) });
      finish(rec, 'done');
      return;
    }

    if (plan.calls.length > 0) {
      setState(rec, 'acting');
      const acting = now();
      await execute(rec, plan.calls, retriever);
      rec.turn.timings.actMs += now() - acting;
      checkpoint(rec);
    }
    if (rec.pending.size > 0) {
      setState(rec, 'awaiting-confirmation');
      announce('ai.mind.announce.awaiting');
      return;
    }
    await conclude(rec, retriever);
  }

  function newRecord(question: string): TurnRecord {
    counter += 1;
    const rec: TurnRecord = {
      turn: {
        id: `turn-${counter}`,
        question,
        state: 'understanding',
        plan: null,
        blocks: [],
        engine: engine ? engine.kind : 'guide',
        model: engine ? engine.model : null,
        timings: { planMs: 0, actMs: 0, answerMs: 0, tokens: 0 },
      },
      controller: new AbortController(),
      ctx: context(),
      pending: new Map(),
      undo: new Map(),
      done: [],
      facts: [],
      passages: [],
    };
    records.push(rec);
    if (records.length > KEEP_TURNS) records = records.slice(-KEEP_TURNS);
    return rec;
  }

  async function guarded(rec: TurnRecord, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (err instanceof Cancelled || rec.controller.signal.aborted) {
        if (!finished(rec)) cancelRecord(rec);
        return;
      }
      console.error('ai: turn failed', err);
      rec.turn.blocks.push({ type: 'notice', key: 'ai.mind.notice.failed' });
      finish(rec, 'failed');
    }
  }

  const intelligence: AiOrchestrator = {
    events,
    host,
    memory,

    async ask(question: string): Promise<Turn> {
      if (current && ACTIVE.has(current.turn.state)) cancelRecord(current);
      const rec = newRecord(question);
      current = rec;
      emit(rec);
      touch();
      await guarded(rec, () => runTurn(rec, question));
      return snapshot(rec);
    },

    async confirm(turnId: string, callId: string, accept: boolean): Promise<void> {
      const rec = records.find((r) => r.turn.id === turnId);
      const pending = rec?.pending.get(callId);
      if (!rec || !pending) return;
      rec.pending.delete(callId);
      const index = actionIndex(rec, callId);
      const card = rec.turn.blocks[index];
      const shown = card?.type === 'action' ? card.preview : pending.tool.name;
      if (!accept) {
        if (card?.type === 'action') rec.turn.blocks[index] = { ...card, status: 'cancelled' };
        rec.turn.blocks.push({ type: 'notice', key: 'ai.mind.notice.experimentCancelled' });
        if (rec.pending.size === 0) {
          rec.turn.state = rec.done.length > 0 ? 'done' : 'cancelled';
          emit(rec);
          if (rec.turn.state === 'cancelled') announce('ai.mind.announce.cancelled');
        } else emit(rec);
        return;
      }
      if (current && current !== rec && ACTIVE.has(current.turn.state)) cancelRecord(current);
      current = rec;
      if (rec.controller.signal.aborted) rec.controller = new AbortController();
      touch();
      await guarded(rec, async () => {
        setState(rec, 'acting');
        const started = now();
        const retriever = await getRetriever().catch(() => EMPTY_RETRIEVER);
        const outcome = await runTool(rec, pending.tool, pending.call, retriever);
        checkpoint(rec);
        record(rec, callId, pending.tool, pending.call, outcome, shown);
        rec.turn.timings.actMs += now() - started;
        if (rec.pending.size > 0) {
          setState(rec, 'awaiting-confirmation');
          return;
        }
        await conclude(rec, retriever);
      });
    },

    async undo(turnId: string, callId: string): Promise<void> {
      const rec = records.find((r) => r.turn.id === turnId);
      const fn = rec?.undo.get(callId);
      if (!rec || !fn) return;
      rec.undo.delete(callId);
      try {
        await fn();
      } catch (err) {
        console.warn('ai: undo failed', err);
        return;
      }
      const index = actionIndex(rec, callId);
      const card = rec.turn.blocks[index];
      if (card?.type === 'action') rec.turn.blocks[index] = { ...card, undoable: false };
      rec.turn.blocks.push({ type: 'notice', key: 'ai.mind.notice.undone', values: { what: card?.type === 'action' ? card.preview : callId } });
      emit(rec);
    },

    cancel(): void {
      if (current && !finished(current)) cancelRecord(current);
    },

    engine(): EngineState {
      return { ...engineState };
    },

    async use(choice: ModelSpec | 'browser' | 'guide', signal?: AbortSignal): Promise<void> {
      if (current && ACTIVE.has(current.turn.state)) cancelRecord(current);
      if (choice === 'guide') {
        await unloadEngine();
        setEngine({ kind: 'guide', model: null, state: 'ready' });
        announce('ai.mind.announce.guide');
        return;
      }
      if (engine) await unloadEngine();
      await load(choice, signal);
    },

    attach(e: LanguageEngine): void {
      void load(e);
    },

    suggestions(): readonly string[] {
      const ctx = context();
      const out: string[] = [];
      if (ctx.where === 'chapter' && ctx.verses[0]) out.push(i18n.t('ai.mind.suggest.verse', { key: ctx.verses[0] }));
      if ((ctx.where === 'explorer' || ctx.where === 'lab') && ctx.explorer) out.push(i18n.t('ai.mind.suggest.facts', { body: i18n.t(BODY_NAME_KEYS[ctx.explorer.focus]) }));
      for (const key of SUGGESTIONS[ctx.where]) out.push(i18n.t(key));
      return [...new Set(out)].slice(0, 4);
    },

    turns(): readonly Turn[] {
      return records.map(snapshot);
    },

    clear(): void {
      if (current && !finished(current)) cancelRecord(current);
      records = [];
      current = null;
      void memory.forget();
    },
  };
  return intelligence;
}
