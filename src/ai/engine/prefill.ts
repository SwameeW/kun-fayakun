/*
 * The prompt read in smaller pieces (docs/AI-INTELLIGENCE.md §6).
 *
 * WebLLM 0.2.86 reads a prompt (its prefill) in chunks of the size its model library was compiled
 * with: 1,024 tokens in every pinned q4f16 build (the library's metadata, prefill_chunk_size). tvmjs
 * records every kernel of a chunk into one command encoder and submits it only at the next copy to
 * or from the GPU, which comes with the next chunk (or the first token's readback), so each chunk
 * reaches the GPU as one long submission. On this Mac the explorer's frames waited on them: every
 * frame over 50 ms while a model wrote fell in a prefill (docs/AI-EVALUATION.md). The compiled
 * kernels take any length up to that size (a prompt's last chunk is any length already), so a
 * smaller chunk on the loaded pipeline makes each submission shorter.
 *
 * WebLLM has no option for it: the size is read into LLMChatPipeline.prefillChunkSize when a
 * pipeline is made, and MLCEngine keeps its pipelines in loadedModelIdToPipeline, neither of them
 * its API. So every step here is checked, nothing throws, nothing changes unless all of it is as
 * expected, and what happened is reported (PrefillReport): a WebLLM that moves either field leaves
 * the model as it was compiled, and the report says why, in each generation's engine usage. The
 * setting is made after every load, so a model switched to (a new pipeline) gets it too.
 *
 * Text only: an image larger than the chunk could not be read (WebLLM refuses it); the assistant
 * sends none.
 */
import type { ModelSpec, ModelTier, PrefillOutcome, PrefillReport } from '../types';

/** What a load asks for: the chunk (tokens; null asks nothing) and whether to wait between chunks. */
export interface PrefillSetting {
  chunkTokens: number | null;
  /**
   * Before each chunk after the first, wait for the model's GPU queue to empty and let the worker's
   * event loop run, so the scene's work is not queued behind the model's next chunk.
   */
  yieldBetween: boolean;
}

/** The smallest chunk asked for: below it the prompt would be read nearly token by token. */
export const MIN_CHUNK_TOKENS = 16;

/** No setting: the model reads its prompt as it was compiled. */
export const NO_PREFILL_SETTING: PrefillSetting = { chunkTokens: null, yieldBetween: false };

/**
 * The prompt's chunk, tokens: measured on this Mac at 1,024 (as compiled), 512, 256 and 128, with and
 * without the wait, for Qwen3 0.6B and 1.7B and Qwen3.5 4B and 9B (docs/AI-EVALUATION.md, "Reading
 * the prompt in smaller pieces"). At 128 with the wait the explorer's longest frame while the
 * standard tier (Qwen3.5 4B) wrote fell from 1.0–1.6 s (as compiled) to 133–167 ms, for 8–12% longer
 * to the first token; without the wait 128 left it at 183–233 ms, and 256 at 300–417 ms either way.
 * At 128 the small models' plans tipped the other way on a few prompts, each time from a passed case
 * to a failed one (Qwen3 1.7B: film-moment-redshift, lab-state; Qwen3 0.6B, which plans only in the
 * evaluation: isl-iron), where 256 with the wait changed none; which of the two the pocket and
 * compact tiers take is the owner's call (the same document, "The setting").
 */
export const PREFILL_CHUNK_TOKENS = 128;

/** Each tier's own setting: the same for all, as measured for the tier's model (q4f16 builds). */
const BY_TIER: Readonly<Record<ModelTier, PrefillSetting>> = {
  pocket: { chunkTokens: PREFILL_CHUNK_TOKENS, yieldBetween: true },
  compact: { chunkTokens: PREFILL_CHUNK_TOKENS, yieldBetween: true },
  standard: { chunkTokens: PREFILL_CHUNK_TOKENS, yieldBetween: true },
  large: { chunkTokens: PREFILL_CHUNK_TOKENS, yieldBetween: true },
};

/** A model's own setting: its tier's. */
export function prefillFor(model: Pick<ModelSpec, 'tier'>): PrefillSetting {
  return BY_TIER[model.tier];
}

/** The parts of WebLLM's objects this module reads, all optional: none of them is WebLLM's API. */
type Loose = Record<string, unknown>;

const asObject = (x: unknown): Loose | null => (typeof x === 'object' && x !== null ? (x as Loose) : null);

/** MLCEngine's pipeline for this model, where WebLLM 0.2.86 keeps it (loadedModelIdToPipeline, a Map). */
export function pipelineOf(engine: unknown, modelId: string): Loose | null {
  const pipelines = asObject(engine)?.loadedModelIdToPipeline;
  if (!(pipelines instanceof Map)) return null;
  return asObject((pipelines as Map<unknown, unknown>).get(modelId));
}

/** The chunk a pipeline reads prompts in now (tokens), or null where it holds no such number. */
export function chunkOf(pipeline: unknown): number | null {
  try {
    const n = asObject(pipeline)?.prefillChunkSize;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Wraps the pipeline's per-chunk forward (embedAndForward) so that before every prompt chunk that
 * follows another, the model's queue is waited on (its device's sync: the previous chunk submitted
 * and done) and one macrotask passes. Decoding (one token a call) is untouched. False, changing
 * nothing, where the pipeline has no such method or device, or reads its prompt another way (a
 * library with a program artifact, which WebLLM 0.2.86 forwards without embedAndForward; none of
 * the pinned builds has one).
 */
function waitBetweenChunks(pipeline: Loose): boolean {
  if (pipeline.artifact !== undefined) return false;
  const forward = pipeline.embedAndForward;
  const device = asObject(pipeline.device);
  const sync = device?.sync;
  if (typeof forward !== 'function' || typeof sync !== 'function') return false;
  let afterChunk = false;
  pipeline.embedAndForward = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const length = args[1];
    const chunk = typeof length === 'number' && length > 1;
    if (chunk && afterChunk) {
      await (sync as () => Promise<void>).call(device);
      await macrotask();
    }
    afterChunk = chunk;
    return (forward as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  };
  return true;
}

/**
 * Sets the loaded model's prompt chunk (and the wait between chunks) on WebLLM's engine, after a
 * load. Never throws; changes nothing unless the pipeline is where WebLLM 0.2.86 keeps it and holds
 * a whole number for its chunk. A chunk larger than the setting is lowered to it ('set'); one no
 * larger is left as it is ('kept'). Either way the wait, when asked, goes between the chunks.
 * Reports what happened.
 */
export function applyPrefill(engine: unknown, modelId: string, setting: PrefillSetting): PrefillReport {
  const report = (outcome: PrefillOutcome, compiled: number | null, chunkTokens: number | null, yieldBetween = false): PrefillReport => ({ outcome, compiled, chunkTokens, yieldBetween });
  const asked = setting.chunkTokens;
  if (asked === null || !Number.isInteger(asked) || asked < MIN_CHUNK_TOKENS) return report('off', null, null);
  let pipeline: Loose | null;
  try {
    pipeline = pipelineOf(engine, modelId);
  } catch {
    return report('failed', null, null);
  }
  if (!pipeline) return report('no-pipeline', null, null);
  const compiled = chunkOf(pipeline);
  if (compiled === null) return report('no-field', null, null);
  // Already no larger than asked: the chunk is kept as compiled, and the wait (if asked) still goes
  // between its chunks, which would otherwise be queued back to back.
  if (compiled <= asked) return report('kept', compiled, compiled, setting.yieldBetween && waitSafely(pipeline));
  try {
    pipeline.prefillChunkSize = asked;
    if (chunkOf(pipeline) !== asked) {
      pipeline.prefillChunkSize = compiled;
      return report('failed', compiled, chunkOf(pipeline));
    }
  } catch {
    return report('failed', compiled, chunkOf(pipeline));
  }
  return report('set', compiled, asked, setting.yieldBetween && waitSafely(pipeline));
}

/** waitBetweenChunks, false where it throws (a pipeline whose fields cannot be written). */
function waitSafely(pipeline: Loose): boolean {
  try {
    return waitBetweenChunks(pipeline);
  } catch {
    return false;
  }
}
