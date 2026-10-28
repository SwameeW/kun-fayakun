/*
 * The models the assistant can download (docs/AI-INTELLIGENCE.md §1 and §3), pinned so that what a
 * visitor fetches is exactly what was measured: the weights to a Hugging Face commit of the MLC
 * builds, the compiled model library to a commit of github.com/mlc-ai/binary-mlc-llm-libs served by
 * jsDelivr (with its SHA-384), and the GPU memory and context from WebLLM 0.2.86's own
 * prebuiltAppConfig. Nothing here is fetched until a visitor asks for a model.
 *
 * How the numbers were found (2026-10-26):
 * - revision: GET https://huggingface.co/api/models/mlc-ai/<id> → sha;
 * - downloadBytes: the sizes, from https://huggingface.co/api/models/mlc-ai/<id>/tree/<sha>, of every
 *   file WebLLM fetches (mlc-chat-config.json, tensor-cache.json, tokenizer.json and each
 *   params_shard_*.bin listed in tensor-cache.json), plus the model library's size;
 * - libUrl: the latest commit touching the library's path (GitHub API), served through jsDelivr
 *   with access-control-allow-origin: *, downloaded once to record libIntegrity;
 * - vramMB, context and low_resource_required: prebuiltAppConfig of @mlc-ai/web-llm 0.2.86.
 */
import type { I18nKey } from '../../core/types';
import type { ModelSpec, ModelTier } from '../types';

/** WebLLM's AppConfig, as far as the assistant fills it (structurally the library's own type). */
export interface WebLlmAppConfig {
  model_list: WebLlmModelRecord[];
  cacheBackend: 'cache';
}

export interface WebLlmModelRecord {
  model: string;
  model_id: string;
  model_lib: string;
  vram_required_MB: number;
  low_resource_required: boolean;
  required_features?: string[];
  overrides: { context_window_size: number; max_history_size?: number };
  integrity?: { model_lib: string; onFailure: 'error' };
}

/** The model library commit every entry is pinned to (all of v0_2_86/base was built at it). */
const LIB_COMMIT = '00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0';
const LIB_BASE = `https://cdn.jsdelivr.net/gh/mlc-ai/binary-mlc-llm-libs@${LIB_COMMIT}/web-llm-models/v0_2_86/base/`;
const HF = 'https://huggingface.co/mlc-ai/';

/** The base models' licence files, pinned to the commits read on 2026-10-26. */
const LICENCE: Readonly<Record<string, string>> = {
  'Qwen3-0.6B': 'https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE',
  'Qwen3-1.7B': 'https://huggingface.co/Qwen/Qwen3-1.7B/blob/70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/LICENSE',
  'Qwen3-4B': 'https://huggingface.co/Qwen/Qwen3-4B/blob/1cfa9a7208912126459214e8b04321603b3df60c/LICENSE',
  'Qwen3-8B': 'https://huggingface.co/Qwen/Qwen3-8B/blob/b968826d9c46dd6066d109eabc6255188de91218/LICENSE',
  'Qwen3.5-4B': 'https://huggingface.co/Qwen/Qwen3.5-4B/blob/851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a/LICENSE',
  'Qwen3.5-9B': 'https://huggingface.co/Qwen/Qwen3.5-9B/blob/c202236235762e1c871ad0ccb60c8ee5ba337b9a/LICENSE',
};

/**
 * What a model of each size cannot do well, said before it is downloaded (src/i18n/en.ai.engine.json),
 * as the evaluation measured it on this Mac (docs/AI-EVALUATION.md).
 */
const LIMITS: Readonly<Record<ModelTier, readonly I18nKey[]>> = {
  pocket: ['ai.engine.limit.pocket.tools', 'ai.engine.limit.pocket.explain', 'ai.engine.limit.facts', 'ai.engine.limit.context'],
  compact: ['ai.engine.limit.compact.tools', 'ai.engine.limit.compact.explain', 'ai.engine.limit.facts', 'ai.engine.limit.context'],
  standard: ['ai.engine.limit.standard.plans', 'ai.engine.limit.facts', 'ai.engine.limit.context'],
  large: ['ai.engine.limit.large.speed', 'ai.engine.limit.facts', 'ai.engine.limit.context'],
};

/** The parts of one build that are not in ModelSpec: what WebLLM's model record also needs. */
interface Pin {
  /** e.g. "Qwen3-4B": the base model (its licence) and the library file's stem. */
  base: string;
  quant: ModelSpec['quant'];
  tier: ModelTier;
  name: string;
  paramsB: number;
  /** Hugging Face commit of the MLC build. */
  sha: string;
  /** Files WebLLM fetches from the build, bytes. */
  weightBytes: number;
  libBytes: number;
  libIntegrity: string;
  vramMB: number;
  lowResource: boolean;
  /** WebLLM's override for this family (Qwen3.5 keeps one turn of history). */
  maxHistory?: number;
  sourceId: string;
  /** false: explanations only, the router chooses every tool (ModelSpec.plans). */
  plans?: false;
}

function spec(pin: Pin): ModelSpec {
  const id = `${pin.base}-${pin.quant}-MLC`;
  return {
    id,
    tier: pin.tier,
    name: pin.name,
    paramsB: pin.paramsB,
    quant: pin.quant,
    needsF16: pin.quant === 'q4f16_1',
    downloadBytes: pin.weightBytes + pin.libBytes,
    vramMB: pin.vramMB,
    contextTokens: 4096,
    weightsUrl: `${HF}${id}/resolve/${pin.sha}/`,
    libUrl: `${LIB_BASE}${pin.base}-${pin.quant}_cs1k-webgpu.wasm`,
    libIntegrity: pin.libIntegrity,
    licence: { name: 'Apache-2.0', url: LICENCE[pin.base] ?? '' },
    sourceId: pin.sourceId,
    limitKeys: LIMITS[pin.tier],
    ...(pin.plans === false ? { plans: false } : {}),
  };
}

const PINS: readonly Pin[] = [
  // Pocket writes explanations only: in the evaluation Qwen3 0.6B made no call in any of its plans (docs/AI-EVALUATION.md).
  { base: 'Qwen3-0.6B', quant: 'q4f16_1', tier: 'pocket', name: 'Qwen3 0.6B', paramsB: 0.6, sha: '8c14ce481d4c692769976ad52afea453a102df19', weightBytes: 346_926_408, libBytes: 6_358_805, libIntegrity: 'sha384-l+z226DC4XeJrqhzjXTtmWuMke7hpfJbQc4fElaJevDKbOEPqRlh2j/c+J9nzcu5', vramMB: 1403.34, lowResource: true, sourceId: 'qwen3', plans: false },
  { base: 'Qwen3-0.6B', quant: 'q4f32_1', tier: 'pocket', name: 'Qwen3 0.6B', paramsB: 0.6, sha: '9b4f0b05b08c692ea86fe151ea878406ad22f428', weightBytes: 346_926_409, libBytes: 6_239_496, libIntegrity: 'sha384-myAJdwhFfl9FnWXksrRVZ3HfxYMt83kv79qZT9mvyN2GcI7kO5IcLPmm/lP+zbbK', vramMB: 1924.98, lowResource: true, sourceId: 'qwen3', plans: false },
  { base: 'Qwen3-1.7B', quant: 'q4f16_1', tier: 'compact', name: 'Qwen3 1.7B', paramsB: 1.7, sha: '80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc', weightBytes: 979_560_600, libBytes: 6_386_879, libIntegrity: 'sha384-Nl0m2ynzyk2i2j+XyK8Og/dAjX2xlKfgrkjOCwmhQEgmOit1qbAqcrhKy9WjE0J4', vramMB: 2036.66, lowResource: true, sourceId: 'qwen3' },
  { base: 'Qwen3-1.7B', quant: 'q4f32_1', tier: 'compact', name: 'Qwen3 1.7B', paramsB: 1.7, sha: 'bddd4d584cabe19113f7e4ff46fd9e73b4d3dc89', weightBytes: 979_560_601, libBytes: 6_266_325, libIntegrity: 'sha384-EcVJCw92YQJ8iX+8RQ6Z2BsjLPluluc0r3+l4FtMilOq5YvvVN9vtrqszhcbzdZq', vramMB: 2635.44, lowResource: true, sourceId: 'qwen3' },
  // Standard and large are Qwen3.5 since the evaluation of 2026-10-27 (docs/AI-EVALUATION.md): Qwen3.5 4B passed
  // 122 and 119 of 128 cases (shipping order, model alone) where Qwen3 4B passed 117 and 111, and Qwen3.5 9B
  // 124 and 122 where Qwen3 8B passed 122 and 117, each with no integrity violation after the guards.
  { base: 'Qwen3.5-4B', quant: 'q4f16_1', tier: 'standard', name: 'Qwen3.5 4B', paramsB: 4, sha: '44b42469f9e192814bfd90440e3b377d89ba7a13', weightBytes: 2_380_165_548, libBytes: 7_466_230, libIntegrity: 'sha384-w7goHkFvA18IfLENRf/+uYqYy8kbgR9eTpCb/3rC7BApZw52TjXY6uZf+vBKwbfK', vramMB: 3867.82, lowResource: false, maxHistory: 1, sourceId: 'qwen3-5' },
  { base: 'Qwen3.5-4B', quant: 'q4f32_1', tier: 'standard', name: 'Qwen3.5 4B', paramsB: 4, sha: 'ce39652c7b493d59331e40ef9c7a87de5a47abe3', weightBytes: 2_380_165_548, libBytes: 7_323_514, libIntegrity: 'sha384-poeaI5UJzZuB5tK3pn8fB8PbJsGLZz/C+kQ34fYXo6h9Ym69ntYxITSAeca/kYtw', vramMB: 4680.36, lowResource: false, maxHistory: 1, sourceId: 'qwen3-5' },
  { base: 'Qwen3.5-9B', quant: 'q4f16_1', tier: 'large', name: 'Qwen3.5 9B', paramsB: 9, sha: 'c7c5d3f5a81e37b8facbb72970940a1b131314a8', weightBytes: 5_051_100_190, libBytes: 7_488_165, libIntegrity: 'sha384-eCaqjaer6oGlGI9t4q1ponZO+1A4gRFUvwyjKPgxckmGu5WsoudMf4fPcPnDOTKj', vramMB: 6433.01, lowResource: false, maxHistory: 1, sourceId: 'qwen3-5' },
  { base: 'Qwen3.5-9B', quant: 'q4f32_1', tier: 'large', name: 'Qwen3.5 9B', paramsB: 9, sha: 'f8f042bfb68cb88573af4c8e0ef9b1a26bef4ad0', weightBytes: 5_051_100_190, libBytes: 7_347_353, libIntegrity: 'sha384-+csrga+DKrCKKcrvIWwigkI4tSKluGGNoHPAOL/eGCPgIiOUcTncrto1zLhGqvhd', vramMB: 7544.74, lowResource: false, maxHistory: 1, sourceId: 'qwen3-5' },
];

/**
 * Measured on this Mac by the evaluation (tests/ai-eval) and kept for it, not offered to visitors: the
 * Qwen3 4B and 8B builds the Qwen3.5 ones replaced (docs/AI-EVALUATION.md).
 */
const EVAL_PINS: readonly Pin[] = [
  { base: 'Qwen3-4B', quant: 'q4f16_1', tier: 'standard', name: 'Qwen3 4B', paramsB: 4, sha: 'a5c9fab855e3ccbdfed2e7e69683d75f30332161', weightBytes: 2_274_525_373, libBytes: 6_667_148, libIntegrity: 'sha384-UI6LgZYcCgIdelusHFxuBMRNhkUKhxLXvMmW71jcrJVQio574h1T1jFYJb8Ka9N8', vramMB: 3431.59, lowResource: true, sourceId: 'qwen3' },
  { base: 'Qwen3-4B', quant: 'q4f32_1', tier: 'standard', name: 'Qwen3 4B', paramsB: 4, sha: 'b7e4eb1ba80728187fb5df44055cc1a7c32310e0', weightBytes: 2_274_525_372, libBytes: 6_527_308, libIntegrity: 'sha384-jlJqEAc0or29EDKLWK3g87aR4QtLfeKIw1lP9gvy1N+xhc29camjWoCgcjKrE4gD', vramMB: 4327.71, lowResource: true, sourceId: 'qwen3' },
  { base: 'Qwen3-8B', quant: 'q4f16_1', tier: 'large', name: 'Qwen3 8B', paramsB: 8, sha: 'b3d55c289eae58f77095f5b68c895eeea358ee09', weightBytes: 4_619_346_526, libBytes: 6_668_936, libIntegrity: 'sha384-9n+UFYZ4MJEaacxyJMsHc+XLoZeLl+qFi5coUAi1FDDz5mNyKKVdmV6w/U2+7EBJ', vramMB: 5695.78, lowResource: false, sourceId: 'qwen3' },
  { base: 'Qwen3-8B', quant: 'q4f32_1', tier: 'large', name: 'Qwen3 8B', paramsB: 8, sha: '34026572351006ba1865d11319309b151d9ccf16', weightBytes: 4_619_346_526, libBytes: 6_530_710, libIntegrity: 'sha384-y0he30qiA/VRrqfjn11TCGq0hpytNf4rgCRfQCFncyi0DvAd/z+sw3za7cw4UZgf', vramMB: 6852.55, lowResource: false, sourceId: 'qwen3' },
];

/** The visitor tiers, smallest first, each as a q4f16 build and its q4f32 fallback for adapters without shader-f16. */
export const VISITOR_MODELS: readonly ModelSpec[] = PINS.map(spec);

/** Evaluation candidates (not offered to visitors). */
export const EVAL_CANDIDATES: readonly ModelSpec[] = EVAL_PINS.map(spec);

/** The tiers from smallest to largest. */
export const MODEL_TIERS: readonly ModelTier[] = ['pocket', 'compact', 'standard', 'large'];

const PIN_BY_ID = new Map([...PINS, ...EVAL_PINS].map((p) => [`${p.base}-${p.quant}-MLC`, p]));

/** The build of a tier this adapter can run: q4f16 with shader-f16, else q4f32. */
export function modelFor(tier: ModelTier, f16: boolean, models: readonly ModelSpec[] = VISITOR_MODELS): ModelSpec | null {
  return models.find((m) => m.tier === tier && m.needsF16 === f16) ?? null;
}

/** Every catalogue model (visitor tiers and evaluation candidates) by id. */
export function findModel(id: string): ModelSpec | null {
  return [...VISITOR_MODELS, ...EVAL_CANDIDATES].find((m) => m.id === id) ?? null;
}

/**
 * WebLLM's AppConfig for these models: the pinned weights and library (with its SRI hash), the GPU
 * memory WebLLM estimates, shader-f16 where the build needs it, the context window, and the
 * Cache API as the store (the most tested of WebLLM's backends; deleteModelAllInfoInCache clears it).
 */
export function buildAppConfig(models: readonly ModelSpec[]): WebLlmAppConfig {
  return {
    model_list: models.map((m) => {
      const pin = PIN_BY_ID.get(m.id);
      const record: WebLlmModelRecord = {
        model: m.weightsUrl,
        model_id: m.id,
        model_lib: m.libUrl,
        vram_required_MB: m.vramMB,
        low_resource_required: pin?.lowResource ?? false,
        overrides: { context_window_size: m.contextTokens, ...(pin?.maxHistory !== undefined ? { max_history_size: pin.maxHistory } : {}) },
      };
      if (m.needsF16) record.required_features = ['shader-f16'];
      if (m.libIntegrity) record.integrity = { model_lib: m.libIntegrity, onFailure: 'error' };
      return record;
    }),
    cacheBackend: 'cache',
  };
}
