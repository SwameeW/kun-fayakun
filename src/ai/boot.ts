/**
 * Starts Kun Fayakun Intelligence (docs/AI-INTELLIGENCE.md §2): the one place that puts the
 * assistant together. The shell reaches this module only through a dynamic import, so nothing under
 * src/ai is downloaded until the assistant is first asked for; WebLLM is further off still, in the
 * model's worker, fetched only when a visitor chooses a model.
 *
 * It adds the assistant's message files to the catalogue (en.ai.engine.json, en.ai.tools.json,
 * en.ai.mind.json), builds the tool registry (with the verses and hadith the data files hold), the
 * engine host and the knowledge index's retriever, and returns createIntelligence(app, deps). There
 * is one assistant per page: later calls return the same one.
 *
 * It also gives the test hook its assistant part (window.__kf.ai): start(); useScripted(), which
 * switches the running assistant to the scripted test engine (labelled as such on screen); and
 * useReport(), which makes detection answer with a canned device (CI has no GPU to find).
 */
import { extendTestHandle, setHook } from '../core/hooks';
import type { App } from '../core/types';
import engineMessages from '../i18n/en.ai.engine.json' with { type: 'json' };
import mindMessages from '../i18n/en.ai.mind.json' with { type: 'json' };
import { createEngineHost } from './engine';
import { createScriptedEngine, type ScriptedOptions, type ScriptedReply } from './engine/scripted';
import { createIntelligence, type AiOrchestrator } from './index';
import { loadRetriever } from './knowledge';
import { createRegistryFor, registerToolMessages } from './tools';
import type { CapabilityReport } from './types';

let started: Promise<AiOrchestrator> | null = null;
/** The engine host of the page's assistant, for the test hook's useReport. */
let engineHost: ReturnType<typeof createEngineHost> | null = null;

async function build(app: App, announce: (text: string) => void): Promise<AiOrchestrator> {
  const { i18n } = app;
  i18n.extend('en.ai.engine.json', engineMessages);
  registerToolMessages(i18n);
  i18n.extend('en.ai.mind.json', mindMessages);
  const registry = await createRegistryFor(app);
  const host = createEngineHost(app);
  engineHost = host;
  const ai = createIntelligence(app, { registry, host, retriever: () => loadRetriever(app), announce });
  // What tests wait on (docs/CONTRACTS.md, "Test hooks"): the engine in use and the latest turn's state.
  setHook('data-ai-engine', ai.engine().kind);
  ai.events.on('engine', ({ kind }) => {
    setHook('data-ai-engine', kind);
  });
  ai.events.on('turn', ({ turn }) => {
    setHook('data-ai-turn', turn.state);
  });
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
    },
  });
  return start();
}
