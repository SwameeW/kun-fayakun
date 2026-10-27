/*
 * The messages between the page (./webllm.ts) and the language model's worker (./webllm-worker.ts).
 * Only the worker imports WebLLM: the page sends plain data and receives plain data, so WebLLM's
 * runtime is downloaded once, inside the worker, and only when a model is loaded or a stored one
 * deleted.
 *
 * Every request carries an id, and the worker answers it once (a load also sends progress under
 * its id first). Streaming is pulled: after `generate` the page asks for each next piece with
 * `pull`, and the worker decodes only when asked, so the page's pacer (./pacing.ts) decides how
 * fast the model runs beside the scene. Failures are sent as data: an EngineError code and the
 * text it was read from (./errors.ts), never an Error object.
 */
import type { ChatCompletionRequestStreaming } from '@mlc-ai/web-llm';
import type { EngineError } from '../types';
import type { WebLlmAppConfig } from './catalogue';

/** What the page asks of the worker. */
export type ToModelWorker =
  /** Downloads (if needed), compiles and readies a model; progress follows under the same id. */
  | { type: 'load'; id: number; appConfig: WebLlmAppConfig; model: string }
  /** Starts a streamed completion; the worker answers `started`, then a piece per `pull`. */
  | { type: 'generate'; id: number; request: ChatCompletionRequestStreaming }
  /** The next piece of the generation started by request `stream` (decoded only now). */
  | { type: 'pull'; id: number; stream: number }
  /** Ends the generation in progress at its next token (no answer). */
  | { type: 'interrupt' }
  /** Frees the model and its GPU device; aborts a load in flight. */
  | { type: 'unload'; id: number }
  /** Whether every file of a model is in this browser's cache. */
  | { type: 'hasModelInCache'; id: number; appConfig: WebLlmAppConfig; model: string }
  /**
   * Deletes a model's weights, tokenizer, library and configuration from the cache, when its manifest
   * is stored (answers false, deleting nothing, when it is not: WebLLM would download the manifest).
   */
  | { type: 'deleteModelAllInfoInCache'; id: number; appConfig: WebLlmAppConfig; model: string };

/** One streamed piece, as the page needs it. */
export interface ModelPiece {
  /** New text of the reply ('' when the piece carries none). */
  delta: string;
  /** WebLLM's finish reason, when this piece ends the reply. */
  finish: string | null;
  /**
   * Token counts and timings, on the last piece (stream_options.include_usage), with WebLLM's own
   * prefill and decode rates and the time its grammar matcher took to start (a plan's schema).
   */
  usage: { promptTokens: number; outputTokens: number; ttftMs: number; e2eMs: number; prefillTokensPerS: number; decodeTokensPerS: number; grammarInitMs: number | null } | null;
}

/** What the worker sends back. */
export type FromModelWorker =
  | { type: 'progress'; id: number; progress: number; text: string }
  | { type: 'loaded'; id: number }
  | { type: 'started'; id: number }
  /** The answer to a pull: the next piece, or done when the stream has ended (or is not the one in progress). */
  | { type: 'piece'; id: number; piece: ModelPiece | null; done: boolean }
  /** The answer to unload, hasModelInCache (value) and deleteModelAllInfoInCache. */
  | { type: 'result'; id: number; value: boolean }
  | { type: 'error'; id: number; code: EngineError['code']; detail: string };
