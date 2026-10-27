/*
 * Kun Fayakun Intelligence: the contracts every part of the assistant is built against
 * (docs/AI-INTELLIGENCE.md). Everything runs in the visitor's browser: no API key, no account,
 * no hosted inference. Words come from a language model on this device (or, where present, the
 * browser's own), or from the guide's templates when there is none. Facts, numbers, scripture
 * and actions never come from a model: they come from verified data, deterministic code and the
 * app's own state, read back after every command.
 */
import type {
  App,
  BodyId,
  ChapterId,
  EventBus,
  HadithId,
  I18n,
  I18nKey,
  LabCommand,
  VerseKey,
} from '../core/types';

/* ------------------------------------------------------------------ */
/* Engines: where the words come from                                   */
/* ------------------------------------------------------------------ */

/**
 * - guide: no language model. A deterministic router, retrieval over verified content and the
 *   tools. Works on every device, offline, at once.
 * - local: an open-weight model downloaded to this device on request and run by WebLLM in a worker.
 * - browser: the browser's own built-in model (Chrome's Prompt API), only where it is already there.
 * - scripted: a fake for tests, with replies written in the test. Never offered to visitors, always
 *   labelled "test engine" on screen.
 */
export type EngineKind = 'guide' | 'local' | 'browser' | 'scripted';

/** Device tiers, from what the device can actually hold (never from "WebGPU exists"). */
export type DeviceTier = 'none' | 'pocket' | 'compact' | 'standard' | 'large';
export type ModelTier = Exclude<DeviceTier, 'none'>;

/** An open-weight model the assistant can download (src/ai/engine/catalogue.ts). */
export interface ModelSpec {
  /** WebLLM's model_id, e.g. "Qwen3-4B-q4f16_1-MLC". */
  id: string;
  tier: ModelTier;
  /** Shown to the visitor: "Qwen3 4B". */
  name: string;
  paramsB: number;
  quant: 'q4f16_1' | 'q4f32_1';
  /** Needs the shader-f16 feature (q4f16 builds). */
  needsF16: boolean;
  /** Every file the engine fetches for it, summed at the pinned revision. */
  downloadBytes: number;
  /** GPU memory it needs at contextTokens (WebLLM's estimate, checked by our own measurement). */
  vramMB: number;
  contextTokens: number;
  /** Weights, pinned to a commit: https://huggingface.co/mlc-ai/<id>/resolve/<sha>/ */
  weightsUrl: string;
  /** The compiled model library (.wasm), pinned to a commit. */
  libUrl: string;
  /** Subresource integrity of the library, when known. */
  libIntegrity?: string;
  licence: { name: string; url: string };
  /** Its entry in data/sources.json. */
  sourceId: string;
  /** Plain limits shown before download ("can lose track of long tasks"). */
  limitKeys: readonly I18nKey[];
}

/** What this device can do, found without downloading anything (src/ai/engine/detect.ts). */
export interface CapabilityReport {
  secure: boolean;
  webgpu: boolean;
  /** A software adapter (e.g. SwiftShader): no model is offered. */
  fallbackAdapter: boolean;
  f16: boolean;
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
    maxComputeWorkgroupStorageSize: number;
    maxComputeInvocationsPerWorkgroup: number;
  } | null;
  platform: 'ios' | 'android' | 'desktop' | 'unknown';
  browser: 'chromium' | 'brave' | 'safari' | 'firefox' | 'unknown';
  /** navigator.deviceMemory where the browser gives it (bucketed, capped); else null. */
  deviceMemoryGB: number | null;
  /** GPU memory the assistant may use, MB, after what the scene holds. */
  budgetMB: number;
  /** An earlier attempt on this device stopped the page at this stage (a crash marker). */
  crashedBefore: { stage: string; model: string } | null;
  saveData: boolean;
  /** True on a cellular or slow connection where the browser says so; null where it cannot tell. */
  metered: boolean | null;
  storage: { quotaBytes: number | null; usageBytes: number | null; persisted: boolean | null };
  /** The browser's own model (Chrome's Prompt API): its availability() answer, or 'absent'. */
  browserModel: 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'absent';
  recommended: DeviceTier;
  /** Plain reasons for the recommendation, shown to the visitor. */
  reasons: readonly I18nKey[];
}

export interface LoadProgress {
  phase: 'download' | 'compile' | 'ready';
  loadedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A JSON Schema subset: what the validator checks and what constrained decoding is given. */
export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: readonly string[]; additionalProperties?: false; description?: string }
  | { type: 'array'; items: JsonSchema; minItems?: number; maxItems?: number; description?: string }
  | { type: 'string'; enum?: readonly string[]; const?: string; maxLength?: number; pattern?: string; description?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { anyOf: readonly JsonSchema[]; description?: string };

export interface GenerateRequest {
  messages: readonly ChatMessage[];
  /** json: the reply is constrained to this schema while it is generated (and validated again after). */
  format: { kind: 'json'; schema: JsonSchema } | { kind: 'text' };
  maxTokens: number;
  /** 0 for plans; a little for prose. */
  temperature?: number;
  signal?: AbortSignal;
  /** Each new piece of a free-text reply, as it arrives. */
  onText?: (delta: string) => void;
}

export interface GenerateResult {
  text: string;
  finish: 'stop' | 'length' | 'abort' | 'error';
  promptTokens: number;
  outputTokens: number;
  prefillMs: number;
  decodeMs: number;
  /**
   * The engine's own figures for this generation, where it reports them (WebLLM's usage: its
   * prefill and decode rates, time to first token, end to end, and its grammar matcher's start for a
   * schema). Read by the evaluation (tests/ai-eval), never shown to visitors.
   */
  engineUsage?: { prefillTokensPerS: number; decodeTokensPerS: number; ttftMs: number; e2eMs: number; grammarInitMs: number | null };
}

/** A language model the assistant can use (local, browser or scripted). */
export interface LanguageEngine {
  readonly kind: Exclude<EngineKind, 'guide'>;
  /** Model id, "browser", or "scripted". */
  readonly model: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Stops a generation at its next token. */
  interrupt(): void;
  unload(): Promise<void>;
}

/** Loads engines and manages what is stored (src/ai/engine/index.ts). */
export interface EngineHost {
  detect(): Promise<CapabilityReport>;
  catalogue(): readonly ModelSpec[];
  /** Downloads (if needed), compiles and readies a model. Rejects with an EngineError. */
  load(model: ModelSpec | 'browser', onProgress: (p: LoadProgress) => void, signal: AbortSignal): Promise<LanguageEngine>;
  /** Models kept in this browser's storage, with their sizes. */
  stored(): Promise<readonly { id: string; bytes: number }[]>;
  remove(id: string): Promise<void>;
  /** Asks the browser to keep stored models (navigator.storage.persist()). */
  persist(): Promise<boolean>;
}

export interface EngineError {
  code: 'no-webgpu' | 'too-small' | 'quota' | 'network' | 'aborted' | 'device-lost' | 'out-of-memory' | 'integrity' | 'unsupported' | 'unknown';
  messageKey: I18nKey;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Knowledge: verified passages and the kinds of content                */
/* ------------------------------------------------------------------ */

/**
 * The kinds of content, kept apart and labelled on screen (SPEC §0):
 * - observed: measured data (catalogues, constants with their citations);
 * - model: a scientific model's numbers (the ephemeris, the climate model, impact scaling);
 * - simulation: the laboratory's integration, a thought experiment;
 * - scripture: Quran or hadith, shown from verified data only;
 * - explanation: words written by the assistant (its model or the guide's templates). Never
 *   scripture, never a measurement.
 */
export type KnowledgeKind = 'observed' | 'model' | 'simulation' | 'scripture' | 'explanation';

export type PassageKind = 'verse' | 'hadith' | 'prose' | 'constant' | 'term' | 'explore' | 'fact' | 'source' | 'help' | 'place';

/** A retrievable piece of verified content (public/assets/ai/index.json, built by scripts/build-ai-index.ts). */
export interface Passage {
  /** Stable: "verse:21:30", "prose:ch07.science.sun", "constant:solarSystem.age", "term:kun". */
  id: string;
  kind: PassageKind;
  title: string;
  /** English text as the app shows it (for a verse: its translation; never Arabic). */
  text: string;
  chapter?: ChapterId;
  /** For verse/hadith: the key or id to render from data. */
  ref?: string;
  /** The message key the text came from, so the UI shows the app's own wording. */
  key?: I18nKey;
  sourceIds?: readonly string[];
  knowledge: KnowledgeKind;
}

export interface Retriever {
  search(query: string, options?: { kinds?: readonly PassageKind[]; chapter?: ChapterId | null; limit?: number }): readonly { passage: Passage; score: number }[];
  get(id: string): Passage | null;
}

/** A value an answer may state: from data, a calculator, the explorer or the laboratory. */
export interface Fact {
  id: string;
  /** Plain label: "Escape speed at Mars's surface". */
  label: string;
  value: number | string;
  unit?: string;
  knowledge: KnowledgeKind;
  sourceIds?: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Context: what the visitor is looking at                              */
/* ------------------------------------------------------------------ */

export interface AiContext {
  where: 'home' | 'chapter' | 'sources' | 'explorer' | 'lab';
  chapter: ChapterId | null;
  /** Film time in the chapter, s. */
  chapterT: number | null;
  mode: 'cinematic' | 'explore';
  explorer: {
    focus: BodyId;
    distanceKm: number;
    /** ISO date (UTC) shown. */
    date: string;
    /** Simulated seconds per real second; negative backwards. */
    rate: number;
    paused: boolean;
    walking: BodyId | null;
    stars: boolean;
  } | null;
  lab: {
    bodies: readonly { id: string; name: string; massKg: number; centralId: string | null; aKm: number | null; e: number | null }[];
    status: string;
    /** Days integrated since the experiment began. */
    days: number;
    events: number;
  } | null;
  /** Verses this chapter shows (for "explain this verse"). */
  verses: readonly VerseKey[];
  /** At most ~600 characters for the model: where the visitor is and what is on screen. */
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Tools: the only way the assistant does anything                      */
/* ------------------------------------------------------------------ */

/**
 * - read: reads app state or verified data; runs at once.
 * - calc: a deterministic calculation; runs at once.
 * - cite: shows verified scripture or a source by its id; runs at once.
 * - view: moves the camera, the film or the clock; runs at once and can be undone.
 * - experiment: changes the laboratory; shown as a preview and runs only after the visitor confirms.
 */
export type ToolKind = 'read' | 'calc' | 'cite' | 'view' | 'experiment';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolProblem {
  /** The argument at fault, or '' for the call as a whole. */
  path: string;
  messageKey: I18nKey;
  values?: Record<string, string | number>;
}

export interface ToolEnv {
  app: App;
  i18n: I18n;
  signal: AbortSignal;
  /** The context as it is now (re-read after each command). */
  context(): AiContext;
  retriever: Retriever;
  /** Waits until the predicate holds on the app's state, or the timeout; resolves to whether it held. */
  until(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
}

export interface ToolOutcome {
  /**
   * done: the app's state shows the change (or the value was computed);
   * not-confirmed: the command was sent but the state did not show it in time;
   * refused: a check stopped it before anything was sent;
   * failed: it threw.
   */
  status: 'done' | 'not-confirmed' | 'refused' | 'failed';
  /** One plain line for the log: what the app reported back. */
  observedKey?: I18nKey;
  observedValues?: Record<string, string | number>;
  facts?: readonly Fact[];
  blocks?: readonly AnswerBlock[];
  /**
   * Puts things back as they were before this call (view tools; the lab's own undo for experiments).
   * What it reports, when it reads the state back (UndoOutcome); nothing means it was sent.
   */
  undo?: (() => Promise<void> | void) | (() => Promise<UndoOutcome> | UndoOutcome);
  problem?: ToolProblem;
}

/**
 * What an undo found:
 * - done: the app's state shows things as they were;
 * - not-confirmed: the undo was sent, but the state does not show things as they were;
 * - refused: nothing was sent, and why (a later change sits on top of this one, say).
 */
export type UndoOutcome = { status: 'done' | 'not-confirmed' } | { status: 'refused'; problem: ToolProblem };

export interface ToolDefinition {
  /** "explorer.fly", "calc.escape_speed", "cite.verse" */
  name: string;
  kind: ToolKind;
  /** One plain English line the model reads. */
  summary: string;
  /** Words that make retrieval shortlist this tool ("orbit", "escape", "qibla"). */
  keywords: readonly string[];
  /** An object schema for its arguments. */
  args: JsonSchema & { type: 'object' };
  /** Offered only where it can work (the lab tools in the lab, say). */
  available(ctx: AiContext): boolean;
  /** Checks beyond the schema, against the app's state. */
  check?(args: Record<string, unknown>, ctx: AiContext): readonly ToolProblem[];
  /** What it will do, in a plain sentence (the confirmation card and the log). */
  preview(args: Record<string, unknown>, ctx: AiContext, i18n: I18n): string;
  run(args: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome>;
}

export interface ToolRegistry {
  all(): readonly ToolDefinition[];
  get(name: string): ToolDefinition | null;
  /** The tools worth offering a small model for this question here (always includes the core few). */
  shortlist(question: string, ctx: AiContext, limit: number): readonly ToolDefinition[];
  /** Schema + kind checks; arguments are coerced only where lossless ("3" → 3 is not). */
  validate(call: ToolCall, ctx: AiContext): { ok: true; call: ToolCall; tool: ToolDefinition } | { ok: false; problems: readonly ToolProblem[] };
}

/* ------------------------------------------------------------------ */
/* Experiments: deterministic plans for the laboratory                  */
/* ------------------------------------------------------------------ */

export type ExperimentId =
  | 'scale-mass'
  | 'remove-body'
  | 'kick-body'
  | 'impact'
  | 'add-moon'
  | 'second-star'
  | 'change-orbit';

export interface ExperimentPlan {
  id: ExperimentId;
  params: Readonly<Record<string, number | string>>;
  /** The validated commands, in order, applied to a copy of the current laboratory. */
  commands: readonly LabCommand[];
  /** Plain sentence of what will change. */
  previewKey: I18nKey;
  previewValues: Record<string, string | number>;
  /** How far ahead to integrate when comparing, days. */
  horizonDays: number;
}

export interface ComparisonRow {
  label: string;
  unit: string;
  baseline: number | null;
  variant: number | null;
}

/** Two runs of the same laboratory in a background worker, side by side (knowledge: simulation). */
export interface Comparison {
  experiment: ExperimentId;
  horizonDays: number;
  rows: readonly ComparisonRow[];
  /** Collisions, escapes, breakups seen in the variant. */
  events: readonly string[];
  /** Relative energy error of each run, so the visitor can judge it. */
  energyError: { baseline: number; variant: number };
}

/* ------------------------------------------------------------------ */
/* Plans, answers and turns                                             */
/* ------------------------------------------------------------------ */

export interface Plan {
  intent: 'answer' | 'act' | 'clarify' | 'decline';
  /** What to look up in the verified content. */
  query?: string;
  calls: readonly ToolCall[];
  /**
   * router: the router matched it deterministically; model: a model chose it; fallback: neither
   * (no rule matched, and there was no model or its plan could not be used), so retrieval answers.
   */
  source: 'router' | 'model' | 'fallback';
  /** For clarify: the question back to the visitor. */
  question?: string;
  /** For clarify: the question is the app's own words (this message), not the model's. */
  questionKey?: I18nKey;
}

/** Changes the guards made to a model's words before they were shown. */
export type GuardFlag =
  | 'arabic-removed'
  | 'banned-phrase'
  | 'unknown-citation'
  | 'unchecked-number'
  | 'action-claim'
  | 'scripture-quote'
  | 'truncated';

/** How much an explanation assumes, chosen by the visitor (the answer prompt says it in one line). */
export type ExplanationLevel = 'plain' | 'standard' | 'deeper';

export type AnswerBlock =
  /**
   * `by: 'model'` when a language model wrote it, and `writer` the engine that did (its label names
   * that one, whatever is in use later); both absent for the guide's own templates.
   */
  | { type: 'text'; knowledge: 'explanation'; text: string; flags?: readonly GuardFlag[]; by?: 'model'; writer?: TextWriter }
  | { type: 'passage'; passage: Passage }
  | { type: 'verse'; key: VerseKey }
  | { type: 'hadith'; id: HadithId; summaryKey?: I18nKey }
  | { type: 'facts'; facts: readonly Fact[] }
  | { type: 'comparison'; comparison: Comparison }
  /** `reason`: why a check refused it, when one did (shown on its card); `undoRefused`: why its Undo was refused, the last time it was pressed. */
  | { type: 'action'; callId: string; tool: string; preview: string; status: ToolOutcome['status'] | 'awaiting' | 'cancelled'; undoable: boolean; reason?: ToolProblem; undoRefused?: ToolProblem }
  | { type: 'notice'; key: I18nKey; values?: Record<string, string | number> };

/** The engine that wrote a text block: its kind and its model id ("browser", "scripted" for those). */
export interface TextWriter {
  kind: Exclude<EngineKind, 'guide'>;
  model: string;
}

/** The task state machine (docs/AI-INTELLIGENCE.md, "Tasks"). */
export type TaskState =
  | 'understanding'
  | 'planning'
  | 'awaiting-confirmation'
  | 'acting'
  | 'verifying'
  | 'answering'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Turn {
  id: string;
  question: string;
  state: TaskState;
  plan: Plan | null;
  blocks: readonly AnswerBlock[];
  engine: EngineKind;
  model: string | null;
  timings: { planMs: number; actMs: number; answerMs: number; tokens: number };
  /** The calls whose tool is running now (an experiment's only once it is confirmed and starts). */
  running: readonly { callId: string; tool: string }[];
}

export interface IntelligenceEvents {
  /** A turn changed (state, a new block, a streamed word). */
  turn: { turn: Turn };
  engine: { kind: EngineKind; model: string | null; state: 'off' | 'loading' | 'ready' | 'busy' | 'error'; progress?: LoadProgress; error?: EngineError };
}

/* ------------------------------------------------------------------ */
/* Evaluation: the test hook's seam for measuring real models           */
/* ------------------------------------------------------------------ */

/**
 * What the real-model evaluation (tests/ai-eval, through the test hook's evaluate()) sets. Never
 * set for visitors: without it the router always goes first and nothing is recorded.
 * - router 'first': the shipping order (the deterministic router, then the model);
 * - router 'skip': a loaded model plans every question, so its own planning is measured.
 */
export interface EvaluationOptions {
  router: 'first' | 'skip';
}

/** One generation of a turn, as the evaluation records it: what it was for, the raw reply and the engine's figures. */
export interface GenerationRecord {
  turnId: string;
  /** plan: the first plan; repair: the one retry after an unusable plan; answer: the prose. */
  purpose: 'plan' | 'repair' | 'answer';
  engine: TextWriter;
  /** The messages sent, as sent. */
  messages: readonly ChatMessage[];
  /** For a plan: the tools offered (the shortlist), by name. */
  offered?: readonly string[];
  /** The reply exactly as the engine gave it, before any parsing or guard. */
  raw: string;
  finish: GenerateResult['finish'];
  promptTokens: number;
  outputTokens: number;
  prefillMs: number;
  decodeMs: number;
  engineUsage: GenerateResult['engineUsage'] | null;
  /** Wall time of the generation as the orchestrator saw it, ms. */
  wallMs: number;
  /** For a plan: whether it could be used, and what was wrong with it otherwise (the repair prompt's lines). */
  valid?: boolean;
  problems?: readonly string[];
}

/** The assistant as the interface sees it (src/ai/index.ts → createIntelligence(app)). */
export interface Intelligence {
  readonly events: EventBus<IntelligenceEvents>;
  ask(question: string): Promise<Turn>;
  /** Answers an experiment's confirmation card. */
  confirm(turnId: string, callId: string, accept: boolean): Promise<void>;
  undo(turnId: string, callId: string): Promise<void>;
  /** Stops the turn in progress (generation, waits, a background run). */
  cancel(): void;
  engine(): { kind: EngineKind; model: string | null; state: 'off' | 'loading' | 'ready' | 'busy' | 'error' };
  readonly host: EngineHost;
  /** Switches to a model (downloading it if needed) or back to the guide. */
  use(choice: ModelSpec | 'browser' | 'guide', signal?: AbortSignal): Promise<void>;
  /** Questions worth asking here, from the context (deterministic). */
  suggestions(): readonly string[];
  turns(): readonly Turn[];
  /** Forgets the conversation (and, if memory was on, what was stored). */
  clear(): void;
}
