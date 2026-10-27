/**
 * Starts Kun Fayakun Intelligence (docs/AI-INTELLIGENCE.md §2): the one place that puts the
 * assistant together. The shell reaches this module only through a dynamic import, so nothing under
 * src/ai is downloaded until the assistant is first asked for; WebLLM is further off still, in the
 * model's worker, fetched only when a visitor chooses a model.
 *
 * It adds the assistant's message files to the catalogue (en.ai.engine.json, en.ai.tools.json,
 * en.ai.mind.json), builds the tool registry (with the verses and hadith the data files hold, and
 * the narrations they exclude for the output guards), the engine host and the knowledge index's
 * retriever, and returns createIntelligence(app, deps), with any conversation memory kept brought
 * back. There is one assistant per page: later calls return the same one.
 *
 * It also gives the test hook its assistant part (window.__kf.ai): start(); useScripted(), which
 * switches the running assistant to the scripted test engine (labelled as such on screen);
 * useReport(), which makes detection answer with a canned device (CI has no GPU to find); and, for
 * the real-model evaluation alone (tests/ai-eval), evaluate(), which records every generation
 * (taken with generations()), can skip the router so a model plans every question, and can set how
 * a model loaded after it reads its prompt (the prefill setting being measured). Nothing a visitor
 * does reaches these.
 */
import { extendTestHandle, setHook } from '../core/hooks';
import type { App } from '../core/types';
import engineMessages from '../i18n/en.ai.engine.json' with { type: 'json' };
import mindMessages from '../i18n/en.ai.mind.json' with { type: 'json' };
import { createEngineHost } from './engine';
import { createScriptedEngine, type ScriptedOptions, type ScriptedReply } from './engine/scripted';
import { createIntelligence, type AiOrchestrator } from './index';
import { loadRetriever } from './knowledge';
import { createRegistry, loadScriptureCatalogue, registerToolMessages } from './tools';
import type { CapabilityReport, EvaluationOptions, GenerationRecord } from './types';

let started: Promise<AiOrchestrator> | null = null;
/** The engine host of the page's assistant, for the test hook's useReport. */
let engineHost: ReturnType<typeof createEngineHost> | null = null;
/** The evaluation's settings (null: off, the shipping order) and what it has recorded since last taken. */
let evaluation: EvaluationOptions | null = null;
let recorded: GenerationRecord[] = [];

async function build(app: App, announce: (text: string) => void): Promise<AiOrchestrator> {
  const { i18n } = app;
  i18n.extend('en.ai.engine.json', engineMessages);
  registerToolMessages(i18n);
  i18n.extend('en.ai.mind.json', mindMessages);
  // The verses and hadith the data files hold (and the narrations they exclude, for the output guards).
  const scripture = await loadScriptureCatalogue(app);
  const registry = createRegistry({ scripture });
  const host = createEngineHost(app);
  engineHost = host;
  const ai = createIntelligence(app, {
    registry,
    host,
    retriever: () => loadRetriever(app),
    announce,
    withheld: scripture.withheld,
    evaluation: {
      options: () => evaluation,
      record: (entry) => {
        recorded.push(entry);
      },
    },
  });
  // What tests wait on (docs/CONTRACTS.md, "Test hooks"): the engine in use and the latest turn's state.
  setHook('data-ai-engine', ai.engine().kind);
  ai.events.on('engine', ({ kind }) => {
    setHook('data-ai-engine', kind);
  });
  ai.events.on('turn', ({ turn }) => {
    setHook('data-ai-turn', turn.state);
  });
  // With memory on, the conversation kept in this browser comes back before the panel shows it.
  await ai.restore().catch(() => 0);
  return ai;
}

/** The page's assistant, made once (a failed start is forgotten, so it can be tried again). */
function orchestrator(app: App, announce: (text: string) => void): Promise<AiOrchestrator> {
  if (started) return started;
  const making = build(app, announce);
  started = making;
  making.catch(() => {
    if (started === making) started = null;
  });
  return making;
}

/**
 * The page's assistant, made the first time it is asked for. `announce` speaks a short status line
 * to screen readers (the interface's live region).
 */
export function startIntelligence(app: App, announce: (text: string) => void): Promise<AiOrchestrator> {
  const start = (): Promise<AiOrchestrator> => orchestrator(app, announce);
  extendTestHandle({
    ai: {
      start,
      async useScripted(script: readonly ScriptedReply[], options?: ScriptedOptions) {
        (await start()).attach(createScriptedEngine(script, options));
      },
      async useReport(report: CapabilityReport) {
        await start();
        engineHost?.assume(report);
      },
      async evaluate(options: EvaluationOptions | null) {
        await start();
        const prefill = options?.prefill ? { chunkTokens: options.prefill.chunkTokens, yieldBetween: options.prefill.yieldBetween } : undefined;
        evaluation = options ? { router: options.router === 'skip' ? 'skip' : 'first', ...(prefill ? { prefill } : {}) } : null;
        // Only a load after this reads it; without one, each model's own setting.
        engineHost?.assumePrefill(prefill ?? null);
        recorded = [];
      },
      generations() {
        const taken = recorded;
        recorded = [];
        return taken;
      },
    },
  });
  return start();
}
