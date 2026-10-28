/*
 * Engine failures as the interface shows them: a code the assistant can act on (retry smaller after
 * device lost or out of memory, free space after quota) and a message key in en.ai.engine.json.
 * WebLLM's errors reach the page from its worker as strings ("IntegrityError: …", "TypeError:
 * Failed to execute 'add' on 'Cache': Request failed"), so they are read by name and wording.
 */
import type { EngineError } from '../types';

export type EngineErrorCode = EngineError['code'];

/** An EngineError that is also an Error, so it can be thrown and carries a stack. */
export class EngineFailure extends Error implements EngineError {
  readonly code: EngineErrorCode;
  readonly messageKey: string;
  readonly detail?: string;

  constructor(code: EngineErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'EngineError';
    this.code = code;
    this.messageKey = `ai.engine.error.${code}`;
    if (detail !== undefined) this.detail = detail;
  }
}

export function engineError(code: EngineErrorCode, detail?: string): EngineFailure {
  return new EngineFailure(code, detail);
}

/** Throws the aborted EngineError when the signal has fired (a function, so each call reads it afresh). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw engineError('aborted');
}

export function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { code?: unknown; messageKey?: unknown };
  return typeof v.code === 'string' && typeof v.messageKey === 'string' && v.messageKey.startsWith('ai.engine.error.');
}

/** The text of anything thrown: an Error's name and message, a DOMException's, or the string itself. */
function describe(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException)) return `${err.name}: ${err.message}`;
  if (typeof err === 'object' && err !== null) {
    const e = err as { name?: unknown; message?: unknown };
    if (typeof e.message === 'string') return `${typeof e.name === 'string' ? e.name : 'Error'}: ${e.message}`;
  }
  return String(err);
}

/** In order: the first that matches decides (a quota failure is also a failure to store, say). */
const RULES: ReadonlyArray<readonly [EngineErrorCode, RegExp]> = [
  ['aborted', /\bAbortError\b|\baborted\b|Engine\.unload\(\) is called/u],
  ['quota', /QuotaExceeded|quota|insufficient storage|no space/iu],
  ['integrity', /IntegrityError|Integrity verification failed|integrity/iu],
  ['device-lost', /DeviceLostError|device (?:was )?lost|GPUDevice lost/iu],
  ['out-of-memory', /out of memory|OutOfMemory|\bOOM\b|allocation failed|failed to allocate/iu],
  ['unsupported', /ShaderF16SupportError|FeatureSupportError|shader-f16|exceeds limit|not supported by this browser/iu],
  ['no-webgpu', /WebGPUNotAvailableError|WebGPUNotFoundError|Cannot find WebGPU|WebGPU is not supported|compatible GPU/iu],
  ['network', /Failed to fetch|NetworkError|Request failed|Cannot fetch|Network response was not ok|Unable to fetch|Load failed|ERR_[A-Z_]+|status (?:4|5)\d\d|network/iu],
];

/** Maps anything a load or a generation threw to an EngineError (an EngineFailure passes through). */
export function toEngineError(err: unknown): EngineFailure {
  if (err instanceof EngineFailure) return err;
  if (isEngineError(err)) return engineError(err.code, err.detail);
  const text = describe(err);
  for (const [code, pattern] of RULES) if (pattern.test(text)) return engineError(code, text.slice(0, 500));
  return engineError('unknown', text.slice(0, 500));
}
