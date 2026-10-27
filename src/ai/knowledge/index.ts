/**
 * The assistant's verified knowledge: public/assets/ai/index.json (built by
 * scripts/build-ai-index.ts, checked by the validator's rule l), fetched once when first needed and
 * searched in the page. Nothing here is sent anywhere.
 */
import type { App } from '../../core/types';
import type { Passage, Retriever } from '../types';
import { createRetriever } from './retrieve';

export { createRetriever, KIND_WEIGHT, type SearchOptions } from './retrieve';
export { tokenize, stem, foldText, synonymTokens } from './text';

/** Where the index is published, relative to the deployed base (kept in step with ./build.ts). */
export const KNOWLEDGE_URL = 'assets/ai/index.json';
/** The index format this code reads. */
export const KNOWLEDGE_VERSION = 1;

interface IndexFile {
  version: number;
  passages: Passage[];
}

function isIndex(value: unknown): value is IndexFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { version?: unknown; passages?: unknown };
  return v.version === KNOWLEDGE_VERSION && Array.isArray(v.passages);
}

const loaded = new WeakMap<App, Promise<Retriever>>();

/**
 * The retriever over the published index, fetched through the app's asset loader the first time it
 * is asked for (and again after a failed fetch). Rejects when the file is missing or not this format.
 */
export function loadRetriever(app: App): Promise<Retriever> {
  let promise = loaded.get(app);
  if (!promise) {
    promise = app.assets.json<unknown>(KNOWLEDGE_URL).then((file) => {
      if (!isIndex(file)) throw new Error(`ai: ${KNOWLEDGE_URL} is not a version ${KNOWLEDGE_VERSION} knowledge index`);
      return createRetriever(file.passages);
    });
    promise.catch(() => loaded.delete(app));
    loaded.set(app, promise);
  }
  return promise;
}
