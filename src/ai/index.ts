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
 *   the visitor (confirm), because it changes the laboratory. A model's plan may use only the tools
 *   it was offered, checked against the plan's schema as a whole; prayer times only by a convention
 *   the question names. Once a tool has started, what it did is kept even if the turn is stopped
 *   meanwhile: its card shows its outcome and its Undo.
 * - verifying: what is said about an action comes only from its tool's outcome (read back from the
 *   app's state), never from the plan.
 * - answering: with a model, its prose grounded in the passages and facts, streamed, then passed
 *   through the output guards and its citation markers expanded into verse, hadith, fact and passage
 *   blocks; with the guide, a template from en.ai.mind.json and the top passages.
 * Every block carries its knowledge kind (blockKnowledge); the text block is always 'explanation',
 * and a model's text block names the engine that wrote it.
 *
 * With opt-in memory on, each finished turn's question and answer are kept in this browser
 * (./memory.ts); restore() brings them back as earlier turns, which a model then reads as the
 * conversation so far.
 */
import type { App, BodyId, I18n } from '../core/types';
import { createEventBus } from '../core/events';
import messages from '../i18n/en.ai.mind.json' with { type: 'json' };
import { readContext } from './context';
import { guardInput, guardOutput, stripMarkers, type OutcomeSummary, type WithheldNarration } from './guards';
import { createMemory, type AiMemory } from './memory';
import { ANSWER_MAX_TOKENS, buildAnswerMessages, buildPlanMessages, buildRepairMessages, PLAN_MAX_TOKENS, planSchema, type ActionLine, type HistoryItem } from './prompts';
import { conventionsNamed, route, type NamedPlace } from './router';
import { PLACE_NAME_ARG, placeById } from './tools/explorer';
import { validateSchema } from './tools/schema';
import type {
  AiContext,
  AnswerBlock,
  ChatMessage,
  EngineError,
  EngineHost,
  EngineKind,
  ExplanationLevel,
  Fact,
  EvaluationOptions,
  GenerateResult,
  GenerationRecord,
  Intelligence,
  IntelligenceEvents,
  KnowledgeKind,
  LanguageEngine,
  ModelSpec,
  Passage,
  Plan,
  Retriever,
  TaskState,
  TextWriter,
  ToolCall,
  ToolDefinition,
  ToolEnv,
  ToolKind,
  ToolOutcome,
  ToolRegistry,
  Turn,
  UndoOutcome,
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
  /** Narrations data/hadith.json excludes (the scripture catalogue's): a model's sentence naming one is removed. */
  withheld?: readonly WithheldNarration[];
  /**
   * The real-model evaluation's seam (tests/ai-eval, through the test hook's evaluate() in
   * ./boot.ts), read at each turn: whether the router goes first (null: the shipping order), and
   * where each generation is recorded. Visitors never reach it.
   */
  evaluation?: {
    options(): EvaluationOptions | null;
    record(entry: GenerationRecord): void;
  };
}

/** The assistant, with what the test hook and the interface's settings also need. */
export interface AiOrchestrator extends Intelligence {
  /** Uses this engine directly (the scripted test engine, through the test hook). */
  attach(engine: LanguageEngine): void;
  readonly memory: AiMemory;
  /** How much a model's explanations assume (the visitor's setting; 'standard' until chosen). */
  level(): ExplanationLevel;
  setLevel(level: ExplanationLevel): void;
  /** A tool's kind by its name, or null (the interface minimises its phone sheet while a view or experiment runs). */
  kindOf(tool: string): ToolKind | null;
  /** With memory on, brings back the turns it kept as earlier turns (once, before any question); resolves to how many. */
  restore(): Promise<number>;
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
/** Turns brought back from memory. */
const RESTORE_TURNS = 20;
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
  /** Experiments confirmed whose run has not begun yet (a second Confirm does nothing). */
  confirming: Set<string>;
  /** Calls whose tool is running now, with the tool's name. */
  running: Map<string, string>;
  /** The engine whose plan this turn follows, when a model planned it. */
  planner: TextWriter | null;
  /** The model's plan could not be used: the guide answers this turn, as its notice says. */
  guideOnly: boolean;
  undo: Map<string, NonNullable<ToolOutcome['undo']>>;
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

/** The knowledge index's passages for the field notes' atlas: "place:atlas.<field-notes id>". */
const ATLAS_PREFIX = 'place:atlas.';

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/['’]/gu, '').trim();
}

/**
 * A named place from the knowledge index (its places carry "lat,lon" as ref), for the router: the
 * field notes' own places first (with their id, which the place tools take), then the most populous
 * town of that name (the index numbers the smaller ones that share it "-2", "-3"…).
 */
export function placeFrom(retriever: Retriever, name: string): NamedPlace | null {
  const want = fold(name);
  const found: Array<{ rank: number; place: NamedPlace }> = [];
  for (const { passage } of retriever.search(name, { kinds: ['place'], limit: 12 })) {
    if (!passage.ref) continue;
    const title = fold(passage.title);
    if (title !== want && !title.startsWith(`${want},`) && !title.startsWith(`${want} (`)) continue;
    const [lat, lon] = passage.ref.split(',').map(Number);
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const atlas = passage.id.startsWith(ATLAS_PREFIX) ? passage.id.slice(ATLAS_PREFIX.length) : null;
    const numbered = /-(\d+)$/u.exec(passage.id);
    const rank = atlas ? 0 : numbered ? Number(numbered[1]) : 1;
    found.push({ rank, place: { name: passage.title, lat, lon, ...(atlas ? { place: atlas } : {}) } });
  }
  found.sort((a, b) => a.rank - b.rank);
  return found[0]?.place ?? null;
}

/** A name as places are compared: folded, without a leading "the", up to a comma or a bracket ("The Grand Canyon, Arizona" → "grand canyon"). */
function placeKey(name: string): string {
  return fold(name).replace(/^the\s+/u, '').split(/,|\s\(/u)[0]?.trim() ?? '';
}

/**
 * A place by its name, for a model's plan: a field-notes place by its id ("mecca") or its title in
 * the knowledge index ("Mount Everest", "Salar de Uyuni"), else what placeFrom finds (a town).
 */
export function placeNamed(retriever: Retriever, name: string): NamedPlace | null {
  const want = placeKey(name);
  if (!want) return null;
  const byId = placeById(want.replace(/[^a-z0-9]+/gu, '-'));
  if (byId) return { name, lat: byId.lat, lon: byId.lon, place: byId.id };
  for (const { passage } of retriever.search(name, { kinds: ['place'], limit: 12 })) {
    if (!passage.id.startsWith(ATLAS_PREFIX) || placeKey(passage.title) !== want) continue;
    const atlas = placeById(passage.id.slice(ATLAS_PREFIX.length));
    if (atlas) return { name: passage.title, lat: atlas.lat, lon: atlas.lon, place: atlas.id };
  }
  return placeFrom(retriever, name);
}

function problemText(i18n: I18n, call: ToolCall, problems: readonly { path: string; messageKey: string; values?: Record<string, string | number> }[]): string[] {
  return problems.map((p) => `${call.tool}${p.path ? ` ${p.path}` : ''}: ${i18n.has(p.messageKey) ? i18n.t(p.messageKey, p.values) : p.messageKey}`);
}

/** The numbers a question states ("35.36", "-0.12", "138,73" is two). */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/[-−]?\d+(?:\.\d+)?/gu)].map((m) => Number(m[0].replace('−', '-'))).filter((n) => Number.isFinite(n));
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
  let explanationLevel: ExplanationLevel = 'standard';
  /** Memory has been read back (restore() runs once). */
  let restored = false;
  const withheld = deps.withheld ?? [];
  /** Records a generation for the evaluation, when it is on (nothing is kept otherwise). */
  const observe = (rec: TurnRecord, e: LanguageEngine, purpose: GenerationRecord['purpose'], request: Parameters<LanguageEngine['generate']>[0], result: GenerateResult, wallMs: number, extra: Pick<GenerationRecord, 'offered' | 'valid' | 'problems'> = {}): void => {
    if (!deps.evaluation?.options()) return;
    deps.evaluation.record({
      turnId: rec.turn.id,
      purpose,
      engine: { kind: e.kind, model: e.model },
      messages: request.messages,
      raw: result.text,
      finish: result.finish,
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      prefillMs: result.prefillMs,
      decodeMs: result.decodeMs,
      engineUsage: result.engineUsage ?? null,
      wallMs,
      ...extra,
    });
  };

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
    return { id: t.id, question: t.question, state: t.state, plan: t.plan, blocks: [...t.blocks], engine: t.engine, model: t.model, timings: { ...t.timings }, running: [...rec.running].map(([callId, tool]) => ({ callId, tool })) };
  }

  function emit(rec: TurnRecord): void {
    // A turn cleared away says nothing more (a tool that was still running when Clear was pressed).
    if (!records.includes(rec)) return;
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
    rec.confirming.clear();
    // A tool already running may have changed something: its card says so until its own outcome comes (record()).
    for (const callId of rec.running.keys()) {
      const i = actionIndex(rec, callId);
      const b = rec.turn.blocks[i];
      if (b?.type === 'action') rec.turn.blocks[i] = { ...b, status: 'not-confirmed' };
    }
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
    const card: AnswerBlock = {
      type: 'action',
      callId,
      tool: tool.name,
      preview: shown,
      status: outcome.status,
      // Sent but not seen yet may still have changed something, so it can be undone too (the undo reads the state back).
      undoable: Boolean(outcome.undo) && (outcome.status === 'done' || outcome.status === 'not-confirmed'),
      ...(outcome.status === 'refused' && outcome.problem ? { reason: outcome.problem } : {}),
    };
    if (i >= 0) rec.turn.blocks[i] = card;
    else if (tool.kind === 'view' || tool.kind === 'experiment' || outcome.status !== 'done') rec.turn.blocks.push(card);
    if (outcome.facts?.length) rec.facts.push(...outcome.facts);
    const blocks = outcome.blocks ?? [];
    rec.turn.blocks.push(...blocks);
    if (outcome.facts?.length && !blocks.some((b) => b.type === 'facts')) rec.turn.blocks.push({ type: 'facts', facts: outcome.facts });
    emit(rec);
  }

  /**
   * Runs one call and records what it reported. Nothing starts once the turn is stopped; once a view or
   * an experiment has started, its outcome is recorded even if the turn is stopped meanwhile (what it
   * changed stays on its card, with its undo), and only then does the turn end as stopped. A read, a
   * calculation or a citation stopped midway changed nothing, so it is not reported.
   */
  async function act(rec: TurnRecord, callId: string, tool: ToolDefinition, call: ToolCall, shown: string, retriever: Retriever): Promise<void> {
    checkpoint(rec);
    rec.pending.delete(callId);
    rec.confirming.delete(callId);
    rec.running.set(callId, tool.name);
    // The interface hears that it started (a phone's sheet steps aside while a view or an experiment runs).
    emit(rec);
    let outcome: ToolOutcome;
    try {
      outcome = await runTool(rec, tool, call, retriever);
    } finally {
      rec.running.delete(callId);
    }
    if (!rec.controller.signal.aborted || tool.kind === 'view' || tool.kind === 'experiment') record(rec, callId, tool, call, outcome, shown);
    checkpoint(rec);
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
      await act(rec, callId, tool, call, shown, retriever);
    }
  }

  /** The model's plan, validated; one repair attempt; null when it cannot be used (the guide then answers the turn). */
  async function modelPlan(rec: TurnRecord, question: string, retriever: Retriever): Promise<Plan | null> {
    const e = engine;
    if (!e) return null;
    const tools = registry.shortlist(question, rec.ctx, SHORTLIST);
    const schema = planSchema(tools, rec.ctx);
    let messagesNow: ChatMessage[] = buildPlanMessages(question, rec.ctx, tools, history(rec));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request = { messages: messagesNow, format: { kind: 'json' as const, schema }, maxTokens: PLAN_MAX_TOKENS, temperature: 0, signal: rec.controller.signal };
      const began = now();
      const result = await generate(rec, e, request);
      checkpoint(rec);
      const parsed = result.finish === 'error' ? { plan: null, problems: ['the engine stopped with an error'] } : parsePlan(result.text, rec.ctx, question, tools, schema, retriever, attempt === 0);
      observe(rec, e, attempt === 0 ? 'plan' : 'repair', request, result, now() - began, { offered: tools.map((t) => t.name), valid: parsed.plan !== null, problems: parsed.problems });
      if (parsed.plan) {
        rec.planner = { kind: e.kind, model: e.model };
        return parsed.plan;
      }
      if (result.finish === 'error') break;
      messagesNow = buildRepairMessages(messagesNow, result.text, parsed.problems);
    }
    addBlock(rec, { type: 'notice', key: 'ai.mind.notice.planFallback' });
    rec.guideOnly = true;
    return null;
  }

  /**
   * A model's reply as a plan, or what is wrong with it (for the repair prompt). Each call must name a
   * tool it was offered (the shortlist) and pass the registry's checks, and the reply as a whole must
   * fit the plan's schema: constrained decoding has open bugs, so nothing is taken on trust.
   */
  function parsePlan(text: string, ctx: AiContext, question: string, offered: readonly ToolDefinition[], schema: ReturnType<typeof planSchema>, retriever: Retriever, first: boolean): { plan: Plan; problems: [] } | { plan: null; problems: string[] } {
    let raw: unknown;
    try {
      raw = jsonObject(text);
    } catch {
      return { plan: null, problems: ['the reply was not one JSON object'] };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { plan: null, problems: ['the reply was not a JSON object'] };
    const names = new Set(offered.map((t) => t.name));
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
      const given = typeof c.args === 'object' && c.args !== null && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};
      if (!names.has(c.tool)) {
        problems.push(`${c.tool}: not offered; use only the tools listed`);
        continue;
      }
      const where = placeOfCall(c.tool, given, question, retriever);
      if (typeof where === 'string') {
        problems.push(where);
        continue;
      }
      const call: ToolCall = { tool: c.tool, args: where };
      const v = registry.validate(call, ctx);
      if (v.ok) calls.push(v.call);
      else problems.push(...(v.problems.length ? problemText(i18n, call, v.problems) : [`${call.tool}: not accepted here`]));
    }
    // The reply as a whole, against the schema it was asked for.
    if (problems.length === 0) problems.push(...problemText(i18n, { tool: 'plan', args: {} }, validateSchema(schema, raw)).slice(0, 4));
    // "act" with no call at all says one thing and does another (Qwen3 4B, "Play chapter 3"): the first
    // reply is asked again; a second such reply is taken as an answer.
    if (first && problems.length === 0 && intent === 'act' && list.length === 0 && offered.length > 0) problems.push('intent "act" needs a call to one of the listed tools; if none of them does what is asked, use intent "answer"');
    if (problems.length > 0 || !intent) return { plan: null, problems };
    // Prayer times differ by convention, and the visitor chooses it: a model may not choose one for them.
    const named = conventionsNamed(question);
    if (calls.some((c) => c.tool === 'islamic.prayer_times' && !named.includes(String(c.args.convention)))) {
      const key = 'ai.mind.clarify.convention';
      return { plan: { intent: 'clarify', calls: [], source: 'model', question: i18n.t(key), questionKey: key }, problems: [] };
    }
    const query = typeof r.query === 'string' && r.query.trim() ? r.query.trim().slice(0, 160) : undefined;
    const clarify = typeof r.question === 'string' && r.question.trim() ? r.question.trim().slice(0, 200) : undefined;
    if (intent === 'clarify' && !clarify) return { plan: null, problems: ['clarify needs a question'] };
    const effective: Plan['intent'] = intent === 'act' && calls.length === 0 ? 'answer' : intent;
    return {
      plan: { intent: effective, calls, source: 'model', query: query ?? (effective === 'answer' ? question : undefined), ...(clarify ? { question: clarify } : {}) },
      problems: [],
    };
  }

  /**
   * A model's place, made the app's own: a place it names is found by the app (a field-notes place
   * by its id or title, else a town in the knowledge index, by its degrees), and degrees are taken
   * only when the visitor gave them, so a named place's latitude and longitude never come from a
   * model's memory. The arguments as the tool takes them, or what is wrong (for the repair prompt).
   */
  function placeOfCall(tool: string, args: Record<string, unknown>, question: string, retriever: Retriever): Record<string, unknown> | string {
    const { [PLACE_NAME_ARG]: named, ...out } = args;
    if (named !== undefined) {
      const name = typeof named === 'string' ? named.trim() : '';
      const found = name ? placeNamed(retriever, name) : null;
      if (!found) return `${tool} ${PLACE_NAME_ARG}: no place called "${name.slice(0, 60)}" in the app; give another name, or leave it out`;
      if (found.place) out.place = found.place;
      else {
        out.lat = found.lat;
        out.lon = found.lon;
      }
      return out;
    }
    const asked = numbersIn(question);
    for (const key of ['lat', 'lon'] as const) {
      const v = out[key];
      if (typeof v === 'number' && !asked.some((n) => Math.abs(Math.abs(n) - Math.abs(v)) < 0.005)) return `${tool} ${key}: degrees only when the question gives them; name the place (${PLACE_NAME_ARG}) instead`;
    }
    return out;
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
    // The words are this engine's, whichever was in use when the turn began (a model may be loaded while a card waits).
    const writer: TextWriter = { kind: e.kind, model: e.model };
    rec.turn.engine = e.kind;
    rec.turn.model = e.model;
    const msgs = buildAnswerMessages(question, rec.ctx, passages, rec.facts, actionLines(rec), history(rec), explanationLevel);
    const factIds = new Set(rec.facts.map((f) => f.id));
    const passageIds = new Set(passages.map((p) => p.id));
    const given = [question, rec.ctx.summary, ...rec.done.map((d) => JSON.stringify(d.call.args)), ...actionLines(rec).map((a) => a.observed ?? '')];
    const guard = (text: string, truncated: boolean, streaming = false): ReturnType<typeof guardOutput> =>
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
        withheld,
        streaming,
      });
    const index = addBlock(rec, { type: 'text', knowledge: 'explanation', text: '', by: 'model', writer });
    let streamed = '';
    const request: Parameters<LanguageEngine['generate']>[0] = {
      messages: msgs,
      format: { kind: 'text' },
      maxTokens: ANSWER_MAX_TOKENS,
      temperature: 0.3,
      signal: rec.controller.signal,
      onText: (delta) => {
        streamed += delta;
        if (rec.controller.signal.aborted) return;
        // What is on screen while it streams has passed the guards too, and what cannot be judged yet is held back.
        replaceBlock(rec, index, { type: 'text', knowledge: 'explanation', text: stripMarkers(guard(streamed, false, true).text), by: 'model', writer });
      },
    };
    const began = now();
    const result = await generate(rec, e, request);
    observe(rec, e, 'answer', request, result, now() - began);
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
    replaceBlock(rec, index, { type: 'text', knowledge: 'explanation', text, ...(final.flags.length ? { flags: final.flags } : {}), by: 'model', writer });
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
    if (engine && !rec.guideOnly && !(plan?.intent === 'act' && onlyViews)) answered = await modelAnswer(rec, rec.turn.question, passages, retriever);
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
      const writer = rec.turn.blocks.findLast((b): b is Extract<AnswerBlock, { type: 'text' }> => b.type === 'text' && b.writer !== undefined);
      if (answer) void memory.remember({ question: rec.turn.question, answer, at: Date.now(), ...(writer?.writer ? { writer: writer.writer } : {}) });
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
    // The evaluation alone may skip the router, to measure a model's own planning (a model must be loaded).
    const skipRouter = engine !== null && deps.evaluation?.options()?.router === 'skip';
    let plan = skipRouter ? null : route(input.text, rec.ctx, registry, { place: (name) => placeFrom(retriever, name) });
    if (!plan && engine) plan = await modelPlan(rec, input.text, retriever);
    checkpoint(rec);
    // No rule matched, and no model plan: retrieval answers.
    plan ??= { intent: 'answer', query: input.text, calls: [], source: 'fallback' };
    rec.turn.plan = plan;
    rec.turn.timings.planMs = now() - started;
    emit(rec);

    if (plan.intent === 'decline') {
      rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text: i18n.t(plan.questionKey ?? 'ai.mind.guide.decline') });
      finish(rec, 'done');
      return;
    }
    if (plan.intent === 'clarify' && plan.questionKey) {
      // The app's own question back (a prayer-time convention the visitor has not named, say).
      rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text: i18n.t(plan.questionKey) });
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
        withheld,
      });
      const text = stripMarkers(g.text);
      const by = plan.source === 'model' && rec.planner ? { by: 'model' as const, writer: rec.planner } : {};
      if (rec.planner) {
        rec.turn.engine = rec.planner.kind;
        rec.turn.model = rec.planner.model;
      }
      if (text) rec.turn.blocks.push({ type: 'text', knowledge: 'explanation', text, ...(g.flags.length ? { flags: g.flags } : {}), ...by });
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
      confirming: new Set(),
      running: new Map(),
      planner: null,
      guideOnly: false,
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
      if (!rec || !pending || rec.confirming.has(callId)) return;
      const index = actionIndex(rec, callId);
      const card = rec.turn.blocks[index];
      const shown = card?.type === 'action' ? card.preview : pending.tool.name;
      if (!accept) {
        rec.pending.delete(callId);
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
      // Still pending until it starts, so Stop before then cancels it (and its card says so).
      rec.confirming.add(callId);
      touch();
      await guarded(rec, async () => {
        setState(rec, 'acting');
        const started = now();
        const retriever = await getRetriever().catch(() => EMPTY_RETRIEVER);
        await act(rec, callId, pending.tool, pending.call, shown, retriever);
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
      let result: UndoOutcome | null;
      try {
        const reported = await fn();
        result = typeof reported === 'object' ? reported : null;
      } catch (err) {
        console.warn('ai: undo failed', err);
        result = { status: 'not-confirmed' };
      }
      const index = actionIndex(rec, callId);
      const card = rec.turn.blocks[index];
      const what = card?.type === 'action' ? card.preview : callId;
      if (result && result.status === 'refused') {
        // Nothing was sent: the card keeps its Undo and says why it cannot be done yet.
        rec.undo.set(callId, fn);
        if (card?.type === 'action') rec.turn.blocks[index] = { ...card, undoRefused: result.problem };
        emit(rec);
        announce('ai.mind.announce.undoRefused');
        return;
      }
      if (card?.type === 'action') {
        const next: AnswerBlock = { ...card, undoable: false };
        delete next.undoRefused;
        rec.turn.blocks[index] = next;
      }
      // "Put back as it was" only when the state was read back and shows it (or the tool reads nothing back).
      rec.turn.blocks.push({ type: 'notice', key: result?.status === 'not-confirmed' ? 'ai.mind.notice.undoNotSeen' : 'ai.mind.notice.undone', values: { what } });
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

    level(): ExplanationLevel {
      return explanationLevel;
    },

    setLevel(level: ExplanationLevel): void {
      explanationLevel = level;
    },

    kindOf(tool: string): ToolKind | null {
      return registry.get(tool)?.kind ?? null;
    },

    async restore(): Promise<number> {
      if (restored || !memory.enabled()) return 0;
      restored = true;
      const kept = await memory.recall(RESTORE_TURNS);
      // Questions asked while it read come after what it brings back.
      const asked = records;
      records = [];
      for (const entry of kept) {
        counter += 1;
        const writer = entry.writer;
        records.push({
          turn: {
            id: `turn-${counter}`,
            question: entry.question,
            state: 'done',
            plan: null,
            blocks: [
              { type: 'notice', key: 'ai.mind.notice.kept' },
              { type: 'text', knowledge: 'explanation', text: entry.answer, ...(writer ? { by: 'model' as const, writer } : {}) },
            ],
            engine: writer?.kind ?? 'guide',
            model: writer?.model ?? null,
            timings: { planMs: 0, actMs: 0, answerMs: 0, tokens: 0 },
          },
          controller: new AbortController(),
          ctx: context(),
          pending: new Map(),
          confirming: new Set(),
          running: new Map(),
          planner: null,
          guideOnly: false,
          undo: new Map(),
          done: [],
          facts: [],
          passages: [],
        });
      }
      records.push(...asked);
      if (records.length > KEEP_TURNS) records = records.slice(-KEEP_TURNS);
      for (const rec of records.slice(0, kept.length)) emit(rec);
      return kept.length;
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
