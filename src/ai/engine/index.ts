/*
 * The engine host (docs/AI-INTELLIGENCE.md §3, src/ai/types.ts EngineHost): what this device can
 * run, the pinned catalogue it may download from, loading a model (WebLLM in a worker, or the
 * browser's own), and what is stored. Lazy: the shell never imports it, and WebLLM's runtime is a
 * further chunk fetched only by load().
 */
import messages from '../../i18n/en.ai.engine.json';
import type { App } from '../../core/types';
import type { CapabilityReport, EngineHost, LanguageEngine, LoadProgress, ModelSpec } from '../types';
import { browserModelAvailability, loadBrowserModel } from './browser';
import { findModel, VISITOR_MODELS } from './catalogue';
import { detectCapabilities } from './detect';
import { engineError } from './errors';
import { createPacer, type Pacer } from './pacing';
import { persistStorage, removeModel, storedModels, type StoredModel } from './storage';
import { loadWebLLM } from './webllm';

export { buildAppConfig, EVAL_CANDIDATES, VISITOR_MODELS } from './catalogue';
export { chooseTier } from './detect';
export { isEngineError, toEngineError } from './errors';
export type { StoredModel } from './storage';

/** The host, with the pacer it shares between engines (the orchestrator may pace its own work too). */
export interface KfEngineHost extends EngineHost {
  readonly pacer: Pacer;
  /** The last report detect() made, or null before it has run. */
  readonly report: CapabilityReport | null;
  stored(): Promise<readonly StoredModel[]>;
}

export function createEngineHost(app: App): KfEngineHost {
  app.i18n.extend('en.ai.engine.json', messages);
  const pacer = createPacer(app);
  let report: CapabilityReport | null = null;

  /** The builds this adapter can run: q4f16 with shader-f16, else q4f32; all of them before detection; none without WebGPU. */
  const runnable = (): readonly ModelSpec[] => {
    if (!report) return VISITOR_MODELS;
    if (!report.webgpu || report.fallbackAdapter) return [];
    const f16 = report.f16;
    return VISITOR_MODELS.filter((m) => m.needsF16 === f16);
  };

  return {
    pacer,
    get report() {
      return report;
    },
    async detect() {
      report = await detectCapabilities(browserModelAvailability);
      return report;
    },
    catalogue: runnable,
    async load(model: ModelSpec | 'browser', onProgress: (p: LoadProgress) => void, signal: AbortSignal): Promise<LanguageEngine> {
      if (model === 'browser') return loadBrowserModel(onProgress, signal, pacer);
      if (!findModel(model.id)) throw engineError('unsupported', `Not in the catalogue: ${model.id}`);
      if (report && (!report.webgpu || report.fallbackAdapter)) throw engineError('no-webgpu');
      if (report && model.needsF16 && !report.f16) throw engineError('unsupported', 'This adapter has no shader-f16: use the q4f32 build');
      return loadWebLLM(model, onProgress, signal, pacer);
    },
    stored() {
      return storedModels(VISITOR_MODELS);
    },
    async remove(id: string) {
      const model = findModel(id);
      if (model) await removeModel(model);
    },
    persist: persistStorage,
  };
}
