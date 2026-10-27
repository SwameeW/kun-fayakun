/**
 * The orchestrator (src/ai/index.ts) end to end in Node, with the scripted engine, a stand-in
 * registry and host, and the real knowledge index: the router's path, the model's plan, invalid
 * JSON then a repair, the fall back to retrieval, an experiment waiting for confirmation (confirmed
 * and cancelled), cancelling while a reply streams, the guards on the model's words, the knowledge
 * labels on every block, and the guide with no model at all. Also: Stop pressed just after Confirm
 * or while the experiment runs, an Undo the tool refuses or cannot confirm, the engine that wrote
 * each text block, a plan held to the tools it was offered and to the schema, prayer times only by
 * a convention the question names, and memory brought back as earlier turns. And the evaluation's
 * seam (the test hook's evaluate()): off by default, it records each generation when on, and only
 * with router 'skip' does a model plan what the router would have matched.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { IntlMessageFormat } from 'intl-messageformat';
import { readContext, SUMMARY_MAX } from '../../src/ai/context';
import { blockKnowledge, createIntelligence, placeNamed, type AiOrchestrator, type IntelligenceDeps } from '../../src/ai/index';
import { createScriptedEngine, type ScriptedEngine, type ScriptedReply } from '../../src/ai/engine/scripted';
import { createRetriever } from '../../src/ai/knowledge/retrieve';
import { buildAnswerMessages, LEVEL_LINES } from '../../src/ai/prompts';
import type { AiMemory, MemoryEntry } from '../../src/ai/memory';
import type { AiContext, AnswerBlock, EngineHost, EvaluationOptions, GenerationRecord, IntelligenceEvents, JsonSchema, ModelSpec, Passage, ToolDefinition, ToolOutcome, ToolProblem, ToolRegistry, Turn, UndoOutcome } from '../../src/ai/types';
import { BODY_IDS, type App, type I18n } from '../../src/core/types';

const index = JSON.parse(readFileSync(new URL('../../public/assets/ai/index.json', import.meta.url), 'utf8')) as { passages: Passage[] };
const retriever = createRetriever(index.passages);
const enMessages = JSON.parse(readFileSync(new URL('../../src/i18n/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const TEST_MESSAGES: Record<string, string> = {
  'test.flown': 'The explorer now shows {body}.',
  'test.escape': 'Escape speed at {body}: {value} km/s.',
  'test.experiment': 'The laboratory integrated ahead {days} days.',
  'test.invalid': 'not allowed here',
};

function fakeI18n(): I18n {
  const messages: Record<string, string> = { ...enMessages, ...TEST_MESSAGES };
  return {
    locale: 'en',
    dir: 'ltr',
    t(key, values) {
      const m = messages[key];
      if (m === undefined) return key;
      const out = new IntlMessageFormat(m, 'en').format<string>(values);
      return Array.isArray(out) ? out.join('') : out;
    },
    has: (key) => key in messages,
    number: (v, d = 3) => new Intl.NumberFormat('en', { maximumFractionDigits: d }).format(v),
    extend(_name, raw) {
      Object.assign(messages, raw as Record<string, string>);
    },
  };
}

/* ---------------- a small registry ---------------- */

const BODY: JsonSchema = { type: 'string', enum: BODY_IDS };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } => ({ type: 'object', properties, required, additionalProperties: false });

interface Log {
  runs: string[];
  undone: string[];
}

interface ToolOptions {
  /** The experiment takes this long to run (it has started once log.runs names it). */
  experimentMs?: number;
  /** What the experiment's undo reports. */
  experimentUndo?: UndoOutcome;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function tools(log: Log, options: ToolOptions = {}): ToolDefinition[] {
  const t = (name: string, kind: ToolDefinition['kind'], args: JsonSchema & { type: 'object' }, run: (a: Record<string, unknown>) => ToolOutcome, available: (ctx: AiContext) => boolean = () => true): ToolDefinition => ({
    name,
    kind,
    summary: `${name} tool`,
    keywords: [],
    args,
    available,
    preview: (a) => `${name} ${JSON.stringify(a)}`,
    run: (a) => {
      log.runs.push(name);
      return Promise.resolve(run(a));
    },
  });
  return [
    t('explorer.fly', 'view', obj({ body: BODY }, ['body']), (a) => ({
      status: 'done',
      observedKey: 'test.flown',
      observedValues: { body: String(a.body) },
      undo: () => {
        log.undone.push('explorer.fly');
      },
    })),
    t('explorer.open', 'view', obj({ body: BODY }), () => ({ status: 'done', observedKey: 'test.flown', observedValues: { body: 'the explorer' } })),
    t('calc.escape_speed', 'calc', obj({ body: BODY }, ['body']), (a) => ({
      status: 'done',
      observedKey: 'test.escape',
      observedValues: { body: String(a.body), value: 5.03 },
      facts: [{ id: `escape.${String(a.body)}`, label: `Escape speed at ${String(a.body)}`, value: 5.03, unit: 'km/s', knowledge: 'model' }],
    })),
    t('cite.verse', 'cite', obj({ key: { type: 'string', pattern: '^\\d{1,3}:\\d{1,3}$' } }, ['key']), (a) => ({ status: 'done', blocks: [{ type: 'verse', key: a.key as `${number}:${number}` }] })),
    // An experiment's arguments as the real tool takes them: its id and its parameters, flat.
    {
      ...t('lab.experiment', 'experiment', obj({ experiment: { type: 'string' }, body: BODY, factor: { type: 'number' }, target: BODY }, ['experiment']), () => ({ status: 'done' })),
      async run() {
        log.runs.push('lab.experiment');
        if (options.experimentMs) await sleep(options.experimentMs);
        return {
          status: 'done',
          observedKey: 'test.experiment',
          observedValues: { days: 3652 },
          blocks: [{ type: 'comparison', comparison: { experiment: 'scale-mass', horizonDays: 3652, rows: [{ label: 'Earth’s distance', unit: 'au', baseline: 1, variant: 0.71 }], events: [], energyError: { baseline: 1e-9, variant: 2e-9 } } }],
          undo: (): UndoOutcome => {
            log.undone.push('lab.experiment');
            return options.experimentUndo ?? { status: 'done' };
          },
        };
      },
    },
    // A place as the real place tools offer it (src/ai/tools/explorer.ts placeArgsFor): by its name, or degrees.
    {
      ...t('islamic.qibla', 'calc', obj({ place: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } }), (a) => ({ status: 'done', observedKey: 'test.escape', observedValues: { body: JSON.stringify(a), value: 119 } })),
      argsFor: () => obj({ placeName: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } }),
    },
    t('islamic.prayer_times', 'calc', obj({ place: { type: 'string' }, convention: { type: 'string', enum: ['mwl', 'isna', 'egypt', 'makkah', 'karachi'] } }, ['convention']), (a) => ({
      status: 'done',
      observedKey: 'test.escape',
      observedValues: { body: String(a.place), value: 5.03 },
    })),
  ];
}

function check(schema: JsonSchema, value: unknown): boolean {
  if ('anyOf' in schema) return schema.anyOf.some((s) => check(s, value));
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null) return false;
      const v = value as Record<string, unknown>;
      if ((schema.required ?? []).some((r) => !(r in v))) return false;
      return Object.entries(v).every(([k, x]) => {
        const s = schema.properties[k];
        return s ? check(s, x) : schema.additionalProperties !== false;
      });
    }
    case 'string':
      return typeof value === 'string' && (!schema.enum || schema.enum.includes(value)) && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
  }
}

function registry(list: ToolDefinition[], offered?: readonly string[]): ToolRegistry {
  return {
    all: () => list,
    get: (name) => list.find((t) => t.name === name) ?? null,
    shortlist: (_q, ctx, limit) => list.filter((t) => t.available(ctx) && (!offered || offered.includes(t.name))).slice(0, limit),
    validate(call, ctx) {
      const tool = list.find((t) => t.name === call.tool);
      const problem: ToolProblem = { path: '', messageKey: 'test.invalid' };
      if (!tool || !tool.available(ctx) || !check(tool.args, call.args)) return { ok: false, problems: [problem] };
      return { ok: true, call, tool };
    },
  };
}

/* ---------------- the harness ---------------- */

const base: AiContext = { where: 'home', chapter: null, chapterT: null, mode: 'cinematic', explorer: null, lab: null, verses: [], summary: 'On the home screen.' };
const CTX: Record<'home' | 'explorer' | 'lab' | 'chapter', AiContext> = {
  home: base,
  chapter: { ...base, where: 'chapter', chapter: 'ch01', chapterT: 30, verses: ['21:30'], summary: 'Watching Chapter 1.' },
  explorer: { ...base, where: 'explorer', explorer: { focus: 'earth', distanceKm: 2e4, date: '2026-10-26', rate: 1, paused: false, walking: null, stars: false }, summary: 'In the explorer near the Earth.' },
  lab: { ...base, where: 'lab', explorer: { focus: 'sun', distanceKm: 3e8, date: '2026-10-26', rate: 86_400, paused: false, walking: null, stars: false }, lab: { bodies: [], status: 'running', days: 0, events: 0 }, summary: 'In the orbital laboratory.' },
};

const SPEC: ModelSpec = {
  id: 'Test-1B', tier: 'compact', name: 'Test 1B', paramsB: 1, quant: 'q4f32_1', needsF16: false, downloadBytes: 1, vramMB: 1, contextTokens: 4096,
  weightsUrl: '', libUrl: '', licence: { name: 'test', url: '' }, sourceId: 'test', limitKeys: [],
};

interface Harness {
  ai: AiOrchestrator;
  log: Log;
  where: { ctx: AiContext };
  engine: ScriptedEngine;
  loads: number;
  turnEvents: Turn[];
  engineEvents: IntelligenceEvents['engine'][];
  announced: string[];
  remembered: MemoryEntry[];
}

function harness(script: ScriptedReply[] = [], options: { delayMs?: number; where?: AiContext; idleUnloadMs?: number; memoryOn?: boolean; kept?: MemoryEntry[]; offered?: readonly string[]; evaluation?: { options: () => EvaluationOptions | null; record: (entry: GenerationRecord) => void } } & ToolOptions = {}): Harness {
  const log: Log = { runs: [], undone: [] };
  const where = { ctx: options.where ?? CTX.home };
  const engine = createScriptedEngine(script, { delayMs: options.delayMs ?? 0 });
  const remembered: MemoryEntry[] = [...(options.kept ?? [])];
  const memory: AiMemory = {
    enabled: () => options.memoryOn === true,
    setEnabled: () => undefined,
    remember: (e) => {
      if (options.memoryOn) remembered.push(e);
      return Promise.resolve();
    },
    recall: () => Promise.resolve(remembered),
    forget: () => {
      remembered.length = 0;
      return Promise.resolve();
    },
    clear: () => Promise.resolve(),
  };
  const h: Partial<Harness> & { loads: number } = { log, where, engine, loads: 0, turnEvents: [], engineEvents: [], announced: [], remembered };
  const host: EngineHost = {
    detect: () => Promise.reject(new Error('not in tests')),
    catalogue: () => [SPEC],
    load: (_model, onProgress) => {
      h.loads += 1;
      onProgress({ phase: 'download', loadedBytes: 1, totalBytes: 2, fraction: 0.5 });
      onProgress({ phase: 'ready', loadedBytes: 2, totalBytes: 2, fraction: 1 });
      return Promise.resolve(engine);
    },
    stored: () => Promise.resolve([]),
    remove: () => Promise.resolve(),
    persist: () => Promise.resolve(false),
  };
  const app = { i18n: fakeI18n() } as unknown as App;
  const deps: IntelligenceDeps = {
    registry: registry(tools(log, options), options.offered),
    host,
    retriever: () => Promise.resolve(retriever),
    announce: (text) => h.announced?.push(text),
    context: () => where.ctx,
    memory,
    ...(options.idleUnloadMs !== undefined ? { idleUnloadMs: options.idleUnloadMs } : {}),
    ...(options.evaluation ? { evaluation: options.evaluation } : {}),
  };
  const ai = createIntelligence(app, deps);
  ai.events.on('turn', ({ turn }) => h.turnEvents?.push(turn));
  ai.events.on('engine', (e) => h.engineEvents?.push(e));
  h.ai = ai;
  return h as Harness;
}

const ofType = <T extends AnswerBlock['type']>(turn: Turn, type: T): Extract<AnswerBlock, { type: T }>[] => turn.blocks.filter((b): b is Extract<AnswerBlock, { type: T }> => b.type === type);
const plan = (value: unknown): string => JSON.stringify(value);

test.describe('a model that writes explanations only', () => {
  test('is never asked to plan: the router chooses, retrieval finds, the model explains; the evaluation can still ask it', async () => {
    const explainer: ModelSpec = { ...SPEC, id: 'Test-0B', plans: false };
    const h = harness([{ format: 'json', match: '', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'saturn' } }] }) }, { format: 'text', match: '', reply: 'Saturn has rings of ice.' }], { offered: ['explorer.fly'] });
    await h.ai.use(explainer);
    const turn = await h.ai.ask('tell me something about the rings of Saturn');
    expect(h.engine.requests.filter((r) => r.format.kind === 'json')).toHaveLength(0);
    expect(turn.plan?.source).toBe('fallback');
    expect(turn.blocks.find((b) => b.type === 'text')).toMatchObject({ by: 'model', text: 'Saturn has rings of ice.' });
    // The router still acts for it.
    const routed = await h.ai.ask('escape speed of mars');
    expect(routed.plan).toMatchObject({ source: 'router', calls: [{ tool: 'calc.escape_speed' }] });
    // Asked to measure its own planning (the evaluation's model mode), it plans.
    let options: EvaluationOptions | null = { router: 'skip' };
    const measured = harness([{ format: 'json', match: '', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'saturn' } }] }) }, { format: 'text', match: '', reply: 'Saturn is in view.' }], { offered: ['explorer.fly'], evaluation: { options: () => options, record: () => undefined } });
    await measured.ai.use(explainer);
    expect((await measured.ai.ask('tell me something about the rings of Saturn')).plan?.calls).toEqual([{ tool: 'explorer.fly', args: { body: 'saturn' } }]);
    options = null;
  });
});

test.describe('a model’s plan that says act and calls nothing', () => {
  test('is asked again once; a call in the repair is used, and a second empty act is taken as an answer', async () => {
    const empty = plan({ intent: 'act', calls: [] });
    const h = harness([{ format: 'json', match: 'Saturn', reply: empty, once: true }, { format: 'json', match: 'cannot be used', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'saturn' } }] }) }, { format: 'text', match: '', reply: 'Saturn is in view.' }], { offered: ['explorer.fly'] });
    await h.ai.use(SPEC);
    const turn = await h.ai.ask('please bring Saturn into view for me');
    expect(turn.plan?.calls).toEqual([{ tool: 'explorer.fly', args: { body: 'saturn' } }]);
    expect(h.engine.requests.some((r) => r.messages.some((m) => m.content.includes('intent "act" needs a call')))).toBe(true);
    const again = harness([{ format: 'json', match: '', reply: empty }, { format: 'text', match: '', reply: 'Here is what I found.' }], { offered: ['explorer.fly'] });
    await again.ai.use(SPEC);
    const t2 = await again.ai.ask('please bring Saturn into view for me');
    expect(t2.plan).toMatchObject({ source: 'model', intent: 'answer', calls: [] });
  });
});

/* ---------------- a model's places ---------------- */

test.describe('a model’s place is the app’s own', () => {
  test('a place by its name: a town from the knowledge index, a field-notes place by its id or title', async () => {
    const h = harness([{ format: 'json', match: 'London', reply: plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { placeName: 'London' } }] }) }, { format: 'json', match: 'Mecca', reply: plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { placeName: 'Mecca' } }] }) }, { format: 'text', match: '', reply: 'The qibla is shown.' }], { offered: ['islamic.qibla'] });
    await h.ai.use(SPEC);
    const london = await h.ai.ask('Which way is the qibla from London, please?');
    // London's degrees from the index (place:london), not from the model.
    expect(london.plan?.calls).toEqual([{ tool: 'islamic.qibla', args: { lat: 51.5019, lon: -0.1187 } }]);
    const mecca = await h.ai.ask('qibla from Mecca, in which direction');
    expect(mecca.plan?.calls).toEqual([{ tool: 'islamic.qibla', args: { place: 'mecca' } }]);
  });

  test('degrees a model gives from memory are refused (the repair asks for the place’s name); degrees the visitor gave are kept', async () => {
    // As Qwen3 4B planned it: Richat's id, then London's latitude with a wrong longitude.
    const memory = plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { lat: 51.5074, lon: -113.9324 } }] });
    const h = harness([{ format: 'json', match: 'London', reply: memory }, { format: 'json', match: 'cannot be used', reply: plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { placeName: 'London' } }] }) }, { format: 'text', match: '', reply: 'Shown.' }], { offered: ['islamic.qibla'] });
    await h.ai.use(SPEC);
    const turn = await h.ai.ask('Which way is the qibla from London, please?');
    expect(turn.plan?.calls).toEqual([{ tool: 'islamic.qibla', args: { lat: 51.5019, lon: -0.1187 } }]);
    const given = harness([{ format: 'json', match: '35.36', reply: plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { lat: 35.36, lon: 138.73 } }] }) }, { format: 'text', match: '', reply: 'Shown.' }], { offered: ['islamic.qibla'] });
    await given.ai.use(SPEC);
    expect((await given.ai.ask('qibla direction from latitude 35.36, longitude 138.73 please')).plan?.calls).toEqual([{ tool: 'islamic.qibla', args: { lat: 35.36, lon: 138.73 } }]);
    // A town the index does not hold is a problem for the repair, not a guess.
    const none = harness([{ format: 'json', match: 'Atlantis', reply: plan({ intent: 'answer', calls: [{ tool: 'islamic.qibla', args: { placeName: 'Atlantis' } }] }) }, { format: 'text', match: '', reply: 'I cannot find that place.' }], { offered: ['islamic.qibla'] });
    await none.ai.use(SPEC);
    const lost = await none.ai.ask('qibla direction from Atlantis please');
    expect(lost.plan?.source).toBe('fallback');
    expect(none.engine.requests.some((r) => r.messages.some((m) => m.content.includes('no place called "Atlantis"')))).toBe(true);
  });

  test('names as a model writes them find the field notes’ places and the index’s towns', () => {
    const at = (name: string): unknown => {
      const p = placeNamed(retriever, name);
      return p ? (p.place ?? [p.lat, p.lon]) : null;
    };
    expect(at('Mount Everest')).toBe('everest');
    expect(at('the Grand Canyon')).toBe('grand-canyon');
    expect(at('Salar de Uyuni')).toBe('uyuni');
    expect(at('Uluru')).toBe('uluru');
    expect(at('Mecca')).toBe('mecca');
    expect(at('Cairo')).toEqual([30.0519, 31.248]);
    expect(at('Karachi')).toEqual([24.8719, 66.9881]);
    expect(at('Atlantis')).toBeNull();
  });
});

/* ---------------- the guide ---------------- */

test.describe('the guide, with no model', () => {
  test('a calculation through the router: the facts, then the template, all labelled', async () => {
    const { ai, log } = harness();
    expect(ai.engine()).toEqual({ kind: 'guide', model: null, state: 'ready' });
    const turn = await ai.ask('escape speed of mars');
    expect(turn.state).toBe('done');
    expect(turn.engine).toBe('guide');
    expect(turn.plan).toMatchObject({ source: 'router', intent: 'answer', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] });
    expect(log.runs).toEqual(['calc.escape_speed']);
    const facts = ofType(turn, 'facts');
    expect(facts[0]?.facts[0]?.value).toBe(5.03);
    const text = ofType(turn, 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.text).toContain('Escape speed at mars: 5.03 km/s.');
    for (const b of turn.blocks) if (b.type !== 'action' && b.type !== 'notice') expect(blockKnowledge(b)).not.toBeNull();
    expect(blockKnowledge(facts[0] as AnswerBlock)).toBe('model');
    expect(blockKnowledge(text[0] as AnswerBlock)).toBe('explanation');
  });

  test('a question no command matches is answered from retrieval: verses shown from data, passages labelled', async () => {
    const { ai } = harness([], { where: CTX.chapter });
    const turn = await ai.ask('What does the classical reading say about the heavens and the earth being joined?');
    // No rule matched and there is no model: retrieval answers, and the plan says so.
    expect(turn.plan).toMatchObject({ source: 'fallback', intent: 'answer', calls: [] });
    const text = ofType(turn, 'text')[0];
    expect(text?.text).toBe('Here is what the app’s verified content says.');
    const shown = turn.blocks.filter((b) => b.type === 'passage' || b.type === 'verse');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(3);
    for (const b of shown) expect(['explanation', 'observed', 'scripture', 'model']).toContain(blockKnowledge(b));
  });

  test('a verse by key: the cite tool’s verse block, never its text from the model', async () => {
    const { ai, log } = harness();
    const turn = await ai.ask('explain 21:30');
    expect(log.runs).toEqual(['cite.verse']);
    expect(ofType(turn, 'verse').map((b) => b.key)).toEqual(['21:30']);
    expect(blockKnowledge({ type: 'verse', key: '21:30' })).toBe('scripture');
  });

  test('nothing found says so plainly', async () => {
    const { ai } = harness();
    const turn = await ai.ask('zxqv blorf');
    expect(turn.blocks).toEqual([{ type: 'text', knowledge: 'explanation', text: 'I could not find that in the app’s verified content. Try other words, or ask about a chapter, a verse, a world, the explorer or the laboratory.' }]);
  });

  test('an empty or over-long question', async () => {
    const { ai } = harness();
    const empty = await ai.ask('   ');
    expect(empty.blocks).toEqual([{ type: 'notice', key: 'ai.mind.notice.empty' }]);
    const long = await ai.ask('tell me about the stars '.repeat(40));
    expect(long.question.length).toBeLessThanOrEqual(600);
    expect(long.blocks[0]).toEqual({ type: 'notice', key: 'ai.mind.notice.truncated' });
  });
});

/* ---------------- the model ---------------- */

test.describe('with a model', () => {
  test('the router still answers commands first; the model is not asked to plan or to narrate a view', async () => {
    const h = harness([], { where: CTX.explorer });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('fly to jupiter');
    expect(turn.plan?.source).toBe('router');
    expect(h.engine.requests).toHaveLength(0);
    expect(ofType(turn, 'action')).toEqual([{ type: 'action', callId: 'c1', tool: 'explorer.fly', preview: 'explorer.fly {"body":"jupiter"}', status: 'done', undoable: true }]);
    expect(ofType(turn, 'text')[0]?.text).toBe('The explorer now shows jupiter.');
    await h.ai.undo(turn.id, 'c1');
    expect(h.log.undone).toEqual(['explorer.fly']);
    const after = h.ai.turns().at(-1);
    expect(after?.blocks.find((b) => b.type === 'action')).toMatchObject({ undoable: false });
    expect(after?.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.undone' });
  });

  test('a model plan under the schema, validated, then a grounded answer streamed through the guards', async () => {
    const answer =
      'Leaving Mars takes 5.03 km/s [[fact:escape.mars]]. I have flown you to Mars. This proves the planets were made weak. ' +
      `Its moons are ${String.fromCodePoint(0x0642, 0x0645, 0x0631)} small, and its day is 31.7 hours. As the verse says “the heavens and the earth were of one piece, then We parted them, and we made every living thing of water” [[verse:21:30]] [[hadith:not-real-1]].`;
    const h = harness(
      [
        { format: 'json', match: 'hard to leave', reply: plan({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] }) },
        { format: 'text', match: 'hard to leave', reply: answer },
      ],
      { where: CTX.explorer },
    );
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Why is Mars hard to leave?');
    expect(turn.state).toBe('done');
    expect(turn.engine).toBe('scripted');
    expect(turn.plan).toMatchObject({ source: 'model', intent: 'answer', calls: [{ tool: 'calc.escape_speed' }] });
    const [planRequest, answerRequest] = h.engine.requests;
    expect(planRequest?.format.kind).toBe('json');
    expect(planRequest?.temperature).toBe(0);
    expect(planRequest?.maxTokens).toBe(300);
    const schema = planRequest?.format.kind === 'json' ? planRequest.format.schema : null;
    expect(schema).toMatchObject({ type: 'object', required: ['intent', 'calls'] });
    expect(answerRequest?.format.kind).toBe('text');
    expect(answerRequest?.messages[0]?.content).toContain('[[fact:escape.mars]]');

    const text = ofType(turn, 'text')[0];
    expect(text?.knowledge).toBe('explanation');
    expect(text?.flags).toEqual(expect.arrayContaining(['arabic-removed', 'banned-phrase', 'action-claim', 'unchecked-number', 'scripture-quote', 'unknown-citation']));
    expect(text?.text).toContain('Leaving Mars takes 5.03 km/s.');
    expect(text?.text).not.toContain('flown');
    expect(text?.text).not.toContain('proves');
    expect(text?.text).not.toContain('one piece');
    expect(text?.text).toContain('31.7 hours (not checked)');
    expect(text?.text).not.toContain('[[');
    expect(ofType(turn, 'verse').map((b) => b.key)).toEqual(['21:30']);
    expect(ofType(turn, 'hadith')).toEqual([]);
    expect(turn.timings.tokens).toBeGreaterThan(0);
    // What streamed on screen had passed the guards too.
    const streamed = h.turnEvents.flatMap((t) => ofType(t, 'text').map((b) => b.text));
    expect(streamed.length).toBeGreaterThan(5);
    for (const s of streamed) {
      expect(s).not.toContain('proves');
      expect(s).not.toContain('[[');
      expect(Array.from(s, (c) => c.codePointAt(0) ?? 0).some((cp) => cp >= 0x600 && cp <= 0x6ff)).toBe(false);
    }
  });

  test('invalid JSON, then a repair that the registry accepts', async () => {
    const h = harness(
      [
        { format: 'json', match: 'biggest planet', reply: 'Sure! I will fly you there.', once: true },
        { format: 'json', match: 'cannot be used', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'jupiter' } }] }) },
      ],
      { where: CTX.explorer },
    );
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Show me the biggest planet');
    expect(h.engine.requests).toHaveLength(2);
    expect(h.engine.requests[1]?.messages.at(-1)?.content).toContain('not one JSON object');
    expect(turn.plan).toMatchObject({ source: 'model', intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'jupiter' } }] });
    expect(h.log.runs).toEqual(['explorer.fly']);
    expect(ofType(turn, 'action')[0]?.status).toBe('done');
  });

  test('a plan that stays invalid falls back to retrieval, and says so: the guide answers, as the notice says', async () => {
    const h = harness([{ format: 'json', match: 'the beginning', reply: plan({ intent: 'act', calls: [{ tool: 'universe.delete', args: {} }] }) }, { format: 'text', match: 'the beginning', reply: 'The data describes an early hot, dense state [[passage:prose:ch01.science.hotDense]].' }]);
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Tell me about the beginning of the universe');
    expect(h.engine.requests.filter((r) => r.format.kind === 'json')).toHaveLength(2);
    expect(h.engine.requests[1]?.messages.at(-1)?.content).toContain('universe.delete: not offered');
    expect(turn.blocks).toContainEqual({ type: 'notice', key: 'ai.mind.notice.planFallback' });
    expect(turn.plan).toMatchObject({ source: 'fallback', intent: 'answer', calls: [] });
    expect(h.log.runs).toEqual([]);
    expect(turn.state).toBe('done');
    // "This answer comes from the app's own content": the model is not asked to write it.
    expect(h.engine.requests.filter((r) => r.format.kind === 'text')).toHaveLength(0);
    const text = ofType(turn, 'text');
    expect(text).toHaveLength(1);
    expect(text[0]?.by).toBeUndefined();
  });

  test('a plan may use only the tools it was offered, and must fit the plan’s schema as a whole', async () => {
    // explorer.fly is a real tool and valid here, but it was not offered for this question.
    const h = harness(
      [
        { format: 'json', match: 'cannot be used', reply: plan({ intent: 'answer', query: 'jupiter', calls: [], reason: 'extra' }), once: true },
        { format: 'json', match: 'largest planet', reply: plan({ intent: 'act', calls: [{ tool: 'explorer.fly', args: { body: 'jupiter' } }] }), once: true },
      ],
      { where: CTX.explorer, offered: ['calc.escape_speed'] },
    );
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Take me to the largest planet');
    expect(h.engine.requests[1]?.messages.at(-1)?.content).toContain('explorer.fly: not offered');
    // The repair has a property the schema does not allow.
    expect(turn.blocks).toContainEqual({ type: 'notice', key: 'ai.mind.notice.planFallback' });
    expect(h.log.runs).toEqual([]);
    expect(turn.plan?.source).toBe('fallback');
  });

  test('prayer times only by a convention the question names: otherwise the visitor is asked which', async () => {
    const reply = (convention: string): string => plan({ intent: 'answer', calls: [{ tool: 'islamic.prayer_times', args: { place: 'mecca', convention } }] });
    const h = harness([
      { format: 'json', match: 'pray in mecca today', reply: reply('mwl') },
      { format: 'json', match: 'umm al-qura', reply: reply('makkah') },
      { format: 'text', match: 'umm al-qura', reply: 'Here are the times.' },
    ]);
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const unnamed = await h.ai.ask('When should I pray in Mecca today?');
    expect(h.log.runs).toEqual([]);
    expect(unnamed.plan).toMatchObject({ intent: 'clarify', source: 'model', questionKey: 'ai.mind.clarify.convention', calls: [] });
    const asked = ofType(unnamed, 'text');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('Which one');
    // The question is the app's own, not the model's.
    expect(asked[0]?.by).toBeUndefined();
    const named = await h.ai.ask('When is Fajr in Mecca by Umm al-Qura?');
    expect(named.plan).toMatchObject({ intent: 'answer', calls: [{ tool: 'islamic.prayer_times', args: { convention: 'makkah' } }] });
    expect(h.log.runs).toEqual(['islamic.prayer_times']);
  });

  test('an engine error while answering falls back to the guide', async () => {
    const h = harness([{ format: 'json', match: 'stars shine', reply: plan({ intent: 'answer', query: 'stars shine', calls: [] }) }]);
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Why do stars shine?');
    expect(turn.blocks).toContainEqual({ type: 'notice', key: 'ai.mind.notice.engineError' });
    expect(turn.state).toBe('done');
    expect(ofType(turn, 'text').length).toBe(1);
  });

  test('cancel stops a reply mid-stream', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const h = harness([{ format: 'json', match: 'long story', reply: plan({ intent: 'answer', query: 'stars', calls: [] }) }, { format: 'text', match: 'long story', reply: long }], { delayMs: 15 });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const pending = h.ai.ask('Tell me a long story about the stars');
    await expect.poll(() => h.turnEvents.at(-1)?.blocks.find((b) => b.type === 'text')?.type).toBe('text');
    await expect.poll(() => (h.turnEvents.at(-1)?.blocks.find((b): b is Extract<AnswerBlock, { type: 'text' }> => b.type === 'text')?.text.length ?? 0) > 20).toBe(true);
    h.ai.cancel();
    const turn = await pending;
    expect(turn.state).toBe('cancelled');
    expect(turn.blocks.at(-1)).toEqual({ type: 'notice', key: 'ai.mind.notice.cancelled' });
    const text = ofType(turn, 'text')[0]?.text ?? '';
    expect(text).not.toContain('word119');
    expect(h.announced).toContain('Stopped.');
    expect(h.ai.engine().state).toBe('ready');
  });

  test('a new question while one is busy cancels the first', async () => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const h = harness([{ format: 'json', match: 'first question', reply: plan({ intent: 'answer', query: 'stars', calls: [] }) }, { format: 'text', match: 'first question', reply: long }], { delayMs: 15 });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const first = h.ai.ask('first question about stars');
    await expect.poll(() => h.turnEvents.some((t) => t.state === 'answering')).toBe(true);
    const second = await h.ai.ask('escape speed of mars');
    expect((await first).state).toBe('cancelled');
    expect(second.state).toBe('done');
    expect(h.ai.turns().map((t) => t.state)).toEqual(['cancelled', 'done']);
  });

  test('while it streams, words presented as the Quran are never on screen, not even before their closing mark', async () => {
    const reply = 'Stars shine by fusion. The Quran says “Do the disbelievers not see that the heavens and the earth were one mass, then they were split apart, and seven strong heavens rose above them” and more. The Sun is a star.';
    const h = harness([{ format: 'json', match: 'stars shine', reply: plan({ intent: 'answer', query: 'stars', calls: [] }) }, { format: 'text', match: 'stars shine', reply }], { delayMs: 1 });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('Why do stars shine?');
    const streamed = h.turnEvents.flatMap((t) => ofType(t, 'text').map((b) => b.text));
    expect(streamed.some((s) => s.startsWith('Stars shine by fusion.'))).toBe(true);
    for (const s of streamed) {
      expect(s).not.toContain('disbelievers');
      expect(s).not.toContain('one mass');
    }
    const text = ofType(turn, 'text')[0];
    expect(text?.text).toContain('Stars shine by fusion.');
    expect(text?.text).toContain('The Sun is a star.');
    expect(text?.flags).toContain('scripture-quote');
  });

  test('each text block names the engine that wrote it: a model attached while a card waits writes the answer, and is named', async () => {
    const h = harness([{ format: 'text', match: 'massive', reply: 'The laboratory integrated ahead 3652 days.' }], { where: CTX.lab });
    const turn = await h.ai.ask('What if the Sun were twice as massive?');
    expect(turn.engine).toBe('guide');
    expect(turn.state).toBe('awaiting-confirmation');
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    await h.ai.confirm(turn.id, 'c1', true);
    const done = h.ai.turns().find((t) => t.id === turn.id);
    const text = done ? ofType(done, 'text')[0] : undefined;
    expect(text).toMatchObject({ by: 'model', writer: { kind: 'scripted', model: 'scripted' } });
    expect(done).toMatchObject({ engine: 'scripted', model: 'scripted' });
  });
});

/* ---------------- experiments ---------------- */

test.describe('experiments wait for the visitor', () => {
  test('confirmed: it runs, the comparison is labelled simulation, and it can be undone', async () => {
    const { ai, log, announced } = harness([], { where: CTX.lab });
    const turn = await ai.ask('What if the Sun were twice as massive?');
    expect(turn.state).toBe('awaiting-confirmation');
    expect(log.runs).toEqual([]);
    expect(ofType(turn, 'action')).toEqual([{ type: 'action', callId: 'c1', tool: 'lab.experiment', preview: 'lab.experiment {"experiment":"scale-mass","body":"sun","factor":2}', status: 'awaiting', undoable: false }]);
    expect(announced).toContain('An experiment is waiting for you to confirm it.');
    await ai.confirm(turn.id, 'c1', true);
    const done = ai.turns().find((t) => t.id === turn.id);
    expect(log.runs).toEqual(['lab.experiment']);
    expect(done?.state).toBe('done');
    expect(done?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'done', undoable: true });
    const comparison = done?.blocks.find((b) => b.type === 'comparison');
    expect(comparison && blockKnowledge(comparison)).toBe('simulation');
    expect(done?.blocks.find((b) => b.type === 'text')).toMatchObject({ text: 'The laboratory integrated ahead 3652 days.' });
    await ai.undo(turn.id, 'c1');
    expect(log.undone).toEqual(['lab.experiment']);
  });

  test('cancelled: nothing runs and the card says so', async () => {
    const { ai, log } = harness([], { where: CTX.lab });
    const turn = await ai.ask('remove the moon');
    expect(turn.state).toBe('awaiting-confirmation');
    await ai.confirm(turn.id, 'c1', false);
    const after = ai.turns().find((t) => t.id === turn.id);
    expect(log.runs).toEqual([]);
    expect(after?.state).toBe('cancelled');
    expect(after?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'cancelled' });
    expect(after?.blocks).toContainEqual({ type: 'notice', key: 'ai.mind.notice.experimentCancelled' });
    // A second answer to the same card does nothing.
    await ai.confirm(turn.id, 'c1', true);
    expect(log.runs).toEqual([]);
  });

  test('Stop pressed straight after Confirm: nothing runs, and the card says it was cancelled', async () => {
    const { ai, log } = harness([], { where: CTX.lab });
    const turn = await ai.ask('What if the Sun were twice as massive?');
    const confirming = ai.confirm(turn.id, 'c1', true);
    ai.cancel();
    await confirming;
    const after = ai.turns().find((t) => t.id === turn.id);
    expect(log.runs).toEqual([]);
    expect(after?.state).toBe('cancelled');
    expect(after?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'cancelled', undoable: false });
  });

  test('Stop pressed while the experiment runs: what it did is kept on its card, with its Undo', async () => {
    const h = harness([], { where: CTX.lab, experimentMs: 150 });
    const turn = await h.ai.ask('What if the Sun were twice as massive?');
    const confirming = h.ai.confirm(turn.id, 'c1', true);
    await expect.poll(() => h.log.runs).toEqual(['lab.experiment']);
    h.ai.cancel();
    // Until its outcome comes, the card says it was sent but not seen.
    expect(h.ai.turns().find((t) => t.id === turn.id)?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'not-confirmed' });
    await confirming;
    await expect.poll(() => h.ai.turns().find((t) => t.id === turn.id)?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'done', undoable: true });
    const after = h.ai.turns().find((t) => t.id === turn.id);
    expect(after?.state).toBe('cancelled');
    expect(after?.blocks).toContainEqual({ type: 'notice', key: 'ai.mind.notice.cancelled' });
    await h.ai.undo(turn.id, 'c1');
    expect(h.log.undone).toEqual(['lab.experiment']);
    expect(h.ai.turns().find((t) => t.id === turn.id)?.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.undone' });
  });

  test('an Undo the tool refuses keeps the card’s Undo and says why; one it cannot confirm says so, never "put back"', async () => {
    const refused = harness([], { where: CTX.lab, experimentUndo: { status: 'refused', problem: { path: '', messageKey: 'test.invalid' } } });
    const turn = await refused.ai.ask('What if the Sun were twice as massive?');
    await refused.ai.confirm(turn.id, 'c1', true);
    await refused.ai.undo(turn.id, 'c1');
    const after = refused.ai.turns().find((t) => t.id === turn.id);
    expect(after?.blocks.find((b) => b.type === 'action')).toMatchObject({ status: 'done', undoable: true, undoRefused: { messageKey: 'test.invalid' } });
    expect(after?.blocks.some((b) => b.type === 'notice' && b.key === 'ai.mind.notice.undone')).toBe(false);
    // It can be pressed again.
    await refused.ai.undo(turn.id, 'c1');
    expect(refused.log.undone).toEqual(['lab.experiment', 'lab.experiment']);

    const unseen = harness([], { where: CTX.lab, experimentUndo: { status: 'not-confirmed' } });
    const t2 = await unseen.ai.ask('What if the Sun were twice as massive?');
    await unseen.ai.confirm(t2.id, 'c1', true);
    await unseen.ai.undo(t2.id, 'c1');
    const last = unseen.ai.turns().find((t) => t.id === t2.id);
    expect(last?.blocks.at(-1)).toMatchObject({ type: 'notice', key: 'ai.mind.notice.undoNotSeen' });
    expect(last?.blocks.find((b) => b.type === 'action')).toMatchObject({ undoable: false });
  });

  test('a turn shows which tool is running, an experiment only once it is confirmed', async () => {
    const h = harness([], { where: CTX.lab, experimentMs: 30 });
    const turn = await h.ai.ask('What if the Sun were twice as massive?');
    expect(h.turnEvents.every((t) => t.running.length === 0)).toBe(true);
    await h.ai.confirm(turn.id, 'c1', true);
    expect(h.turnEvents.some((t) => t.running.some((r) => r.tool === 'lab.experiment' && r.callId === 'c1'))).toBe(true);
    expect(h.ai.turns().find((t) => t.id === turn.id)?.running).toEqual([]);
  });

  test('with a model, the answer mentions only what the outcome reports', async () => {
    const h = harness([{ format: 'text', match: 'massive', reply: 'I have doubled the Sun’s mass. The laboratory integrated ahead 3652 days.' }], { where: CTX.lab });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('what if the sun were twice as massive');
    expect(turn.state).toBe('awaiting-confirmation');
    expect(h.engine.requests).toHaveLength(0);
    await h.ai.confirm(turn.id, 'c1', true);
    const done = h.ai.turns().find((t) => t.id === turn.id);
    const text = done?.blocks.find((b): b is Extract<AnswerBlock, { type: 'text' }> => b.type === 'text');
    // The outcome is done for lab.experiment, so the claim is backed and stays.
    expect(text?.text).toContain('I have doubled');
    expect(h.engine.requests[0]?.messages[0]?.content).toContain('lab.experiment');
    expect(h.engine.requests[0]?.messages[0]?.content).toContain('(done)');
  });
});

/* ---------------- engines, memory, suggestions ---------------- */

test.describe('engines and the rest', () => {
  test('use() loads through the host with progress, the guide unloads, and an idle model is unloaded then reloaded', async () => {
    const h = harness([], { idleUnloadMs: 60 });
    await h.ai.use(SPEC);
    expect(h.loads).toBe(1);
    expect(h.ai.engine()).toEqual({ kind: 'scripted', model: 'scripted', state: 'ready' });
    expect(h.engineEvents.some((e) => e.state === 'loading' && e.progress?.fraction === 0.5)).toBe(true);
    await expect.poll(() => h.ai.engine().state, { timeout: 3000 }).toBe('off');
    await h.ai.ask('escape speed of mars');
    expect(h.loads).toBe(2);
    await h.ai.use('guide');
    expect(h.ai.engine()).toEqual({ kind: 'guide', model: null, state: 'ready' });
    const turn = await h.ai.ask('escape speed of mars');
    expect(turn.engine).toBe('guide');
  });

  test('memory stores only while on, and clear() forgets', async () => {
    const off = harness();
    await off.ai.ask('escape speed of mars');
    expect(off.remembered).toEqual([]);
    const on = harness([], { memoryOn: true });
    await on.ai.ask('escape speed of mars');
    expect(on.remembered.map((e) => e.question)).toEqual(['escape speed of mars']);
    on.ai.clear();
    expect(on.ai.turns()).toEqual([]);
    await expect.poll(() => on.remembered.length).toBe(0);
  });

  test('memory on: restore() brings the kept turns back as earlier turns, labelled, and a model reads them', async () => {
    const kept: MemoryEntry[] = [
      { question: 'How old is the universe?', answer: 'About 13.8 billion years.', at: 1 },
      { question: 'Why is Mars red?', answer: 'Iron oxide in its dust.', at: 2, writer: { kind: 'local', model: 'Qwen3-4B-q4f16_1-MLC' } },
    ];
    const h = harness([{ format: 'json', match: 'stars shine', reply: plan({ intent: 'answer', query: 'stars', calls: [] }) }, { format: 'text', match: 'stars shine', reply: 'Fusion.' }], { memoryOn: true, kept });
    expect(await h.ai.restore()).toBe(2);
    // Once only.
    expect(await h.ai.restore()).toBe(0);
    const turns = h.ai.turns();
    expect(turns.map((t) => t.question)).toEqual(['How old is the universe?', 'Why is Mars red?']);
    expect(turns[0]?.blocks).toEqual([
      { type: 'notice', key: 'ai.mind.notice.kept' },
      { type: 'text', knowledge: 'explanation', text: 'About 13.8 billion years.' },
    ]);
    expect(turns[1]?.blocks[1]).toMatchObject({ by: 'model', writer: { kind: 'local', model: 'Qwen3-4B-q4f16_1-MLC' } });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    await h.ai.ask('Why do stars shine?');
    expect(h.engine.requests[0]?.messages[0]?.content).toContain('Q: Why is Mars red?');
    // What a model wrote is kept with its writer.
    expect(h.remembered.at(-1)).toMatchObject({ question: 'Why do stars shine?', writer: { kind: 'scripted', model: 'scripted' } });
    // Off: nothing is brought back.
    const off = harness([], { kept });
    expect(await off.ai.restore()).toBe(0);
    expect(off.ai.turns()).toEqual([]);
  });

  test('suggestions are deterministic for where the visitor is', () => {
    const h = harness();
    const home = h.ai.suggestions();
    expect(home).toEqual(h.ai.suggestions());
    expect(home.length).toBeGreaterThan(0);
    h.where.ctx = CTX.chapter;
    expect(h.ai.suggestions()[0]).toBe('Explain 21:30');
    h.where.ctx = CTX.lab;
    expect(h.ai.suggestions()).toContain('Remove the Moon');
    h.where.ctx = CTX.explorer;
    expect(h.ai.suggestions()[0]).toBe('Tell me about Earth');
  });

  test('events follow the task states in order', async () => {
    const h = harness([], { where: CTX.lab });
    const turn = await h.ai.ask('what if the sun were twice as massive');
    await h.ai.confirm(turn.id, 'c1', true);
    const states = h.turnEvents.map((t) => t.state).filter((s, i, all) => s !== all[i - 1]);
    expect(states).toEqual(['understanding', 'planning', 'acting', 'awaiting-confirmation', 'acting', 'verifying', 'answering', 'done']);
  });
});

/* ---------------- what the interface asks of it ---------------- */

test.describe('for the interface (src/ai/ui)', () => {
  test('the explanation level is one line of the answer prompt; a model’s words are marked as its own, the guide’s are not', async () => {
    const h = harness(
      [
        { format: 'json', match: 'hard to leave', reply: plan({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] }) },
        { format: 'text', match: 'hard to leave', reply: 'Leaving Mars takes 5.03 km/s [[fact:escape.mars]].' },
      ],
      { where: CTX.explorer },
    );
    const guide = await h.ai.ask('escape speed of mars');
    expect(ofType(guide, 'text')[0]?.by).toBeUndefined();
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    expect(h.ai.level()).toBe('standard');
    const answerPrompt = (): string => h.engine.requests.filter((r) => r.format.kind === 'text').at(-1)?.messages[0]?.content ?? '';
    await h.ai.ask('Why is Mars hard to leave?');
    expect(answerPrompt()).toContain(LEVEL_LINES.standard);
    for (const level of ['plain', 'deeper'] as const) {
      h.ai.setLevel(level);
      const turn = await h.ai.ask('Why is Mars hard to leave?');
      expect(answerPrompt()).toContain(LEVEL_LINES[level]);
      for (const other of Object.values(LEVEL_LINES)) if (other !== LEVEL_LINES[level]) expect(answerPrompt()).not.toContain(other);
      expect(ofType(turn, 'text')[0]).toMatchObject({ by: 'model', text: 'Leaving Mars takes 5.03 km/s.' });
    }
    // Without a level, the prompt is the standard one.
    expect(buildAnswerMessages('q', CTX.home, [], [], [], [])[0]?.content).toContain(LEVEL_LINES.standard);
  });

  test('kindOf names a tool’s kind', () => {
    const h = harness();
    expect(h.ai.kindOf('explorer.fly')).toBe('view');
    expect(h.ai.kindOf('lab.experiment')).toBe('experiment');
    expect(h.ai.kindOf('calc.escape_speed')).toBe('calc');
    expect(h.ai.kindOf('no.such')).toBeNull();
  });
});

/* ---------------- the context ---------------- */

test.describe('the context, read from the app', () => {
  const i18n = fakeI18n();
  test('in a chapter: where, the time, the verses it shows, and a short summary', () => {
    const app = {
      experience: 'film', chapter: 'ch07', time: 42.4, mode: 'explore', i18n, universe: () => null,
      content: { id: 'ch07', panel: { text: [{ type: 'verse', key: '36:38' }, { type: 'hadith', id: 'bukhari-3199' }, { type: 'verse', key: '21:33' }] }, explore: { points: [{ id: 'orrery', t: 60, titleKey: 'test.no-such-title', kind: 'model' }] } },
    } as unknown as App;
    const ctx = readContext(app);
    expect(ctx).toMatchObject({ where: 'chapter', chapter: 'ch07', chapterT: 42.4, mode: 'explore', explorer: null, lab: null, verses: ['36:38', '21:33'] });
    // The chapter's moments, for film.moment (a title the catalogue lacks reads as the id).
    expect(ctx.moments).toEqual([{ id: 'orrery', title: 'orrery' }]);
    // Today's date, so "today" is the visitor's.
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(ctx.summary).toContain(`Today is ${ctx.today ?? ''} (UTC).`);
    expect(ctx.summary).toContain('Chapter 7, "The Sun and its course"');
    expect(ctx.summary).toContain('36:38, 21:33');
  });

  test('in the explorer and in the laboratory', () => {
    const view = {
      focus: 'mars', distanceKm: 100_000, unixMs: Date.UTC(2026, 9, 26, 12), time: { rate: 3600, paused: false }, walk: null, neighbourhood: null, lab: null,
    };
    const app = { experience: 'universe', chapter: null, time: 0, mode: 'cinematic', i18n, content: null, universe: () => view } as unknown as App;
    const ctx = readContext(app);
    expect(ctx).toMatchObject({ where: 'explorer', chapter: null, explorer: { focus: 'mars', date: '2026-10-26', rate: 3600, paused: false, walking: null, stars: false } });
    expect(ctx.summary).toContain('near Mars');
    const bodies = Array.from({ length: 300 }, (_, i) => ({ id: `b${i}`, name: `A body with a long name ${i}`, massKg: 1e20, primary: 'sun', orbit: { aKm: 1e8, e: 0.1 } }));
    const lab = { ...view, lab: { bodies, failure: null, paused: false, elapsedS: 10 * 86_400, events: [{}, {}] } };
    const inLab = readContext({ ...app, universe: () => lab } as unknown as App);
    expect(inLab.where).toBe('lab');
    expect(inLab.lab).toMatchObject({ status: 'running', days: 10, events: 2 });
    expect(inLab.lab?.bodies[0]).toEqual({ id: 'b0', name: 'A body with a long name 0', massKg: 1e20, centralId: 'sun', aKm: 1e8, e: 0.1 });
    expect(inLab.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });
});

test.describe('the evaluation’s seam (the test hook’s evaluate(), tests/ai-eval)', () => {
  const escapePlan = plan({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] });
  const script = (): ScriptedReply[] => [
    { format: 'json', match: 'escape speed of mars', reply: 'not json', once: true },
    { format: 'json', match: 'cannot be used', reply: escapePlan },
    { format: 'text', match: 'escape speed of mars', reply: 'Leaving Mars takes 5.03 km/s [[fact:escape.mars]].' },
  ];

  test('off (the shipping order): the router goes first, the model only writes the answer, nothing is recorded', async () => {
    const records: GenerationRecord[] = [];
    const h = harness(script(), { where: CTX.explorer, evaluation: { options: () => null, record: (e) => records.push(e) } });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('escape speed of mars');
    expect(turn.plan).toMatchObject({ source: 'router', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] });
    expect(h.engine.requests.map((r) => r.format.kind)).toEqual(['text']);
    expect(records).toEqual([]);
  });

  test('router "first": the same shipping order, and the answer’s generation recorded with its raw reply', async () => {
    const records: GenerationRecord[] = [];
    const h = harness(script(), { where: CTX.explorer, evaluation: { options: () => ({ router: 'first' }), record: (e) => records.push(e) } });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('escape speed of mars');
    expect(turn.plan?.source).toBe('router');
    expect(records.map((r) => r.purpose)).toEqual(['answer']);
    expect(records[0]).toMatchObject({ turnId: turn.id, engine: { kind: 'scripted', model: 'scripted' }, raw: 'Leaving Mars takes 5.03 km/s [[fact:escape.mars]].', finish: 'stop', engineUsage: null });
  });

  test('router "skip": the model plans what the router would have matched; the first plan, its repair and the answer are recorded', async () => {
    const records: GenerationRecord[] = [];
    const h = harness(script(), { where: CTX.explorer, evaluation: { options: () => ({ router: 'skip' }), record: (e) => records.push(e) } });
    h.ai.attach(h.engine);
    await expect.poll(() => h.ai.engine().state).toBe('ready');
    const turn = await h.ai.ask('escape speed of mars');
    expect(turn.plan).toMatchObject({ source: 'model', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] });
    expect(records.map((r) => [r.purpose, r.valid])).toEqual([['plan', false], ['repair', true], ['answer', undefined]]);
    expect(records[0]?.raw).toBe('not json');
    expect(records[0]?.problems).toEqual(['the reply was not one JSON object']);
    expect(records[0]?.offered).toContain('calc.escape_speed');
    expect(records[1]?.raw).toBe(escapePlan);
    expect(records[1]?.messages.at(-1)?.content).toContain('cannot be used');
    for (const r of records) expect(r.turnId).toBe(turn.id);
  });

  test('router "skip" without a model: the router still answers (the guide has nothing else)', async () => {
    const records: GenerationRecord[] = [];
    const h = harness([], { where: CTX.explorer, evaluation: { options: () => ({ router: 'skip' }), record: (e) => records.push(e) } });
    const turn = await h.ai.ask('escape speed of mars');
    expect(turn.plan?.source).toBe('router');
    expect(records).toEqual([]);
  });
});
