/*
 * The models kept in this browser (docs/AI-INTELLIGENCE.md §3 and §7, step 5). WebLLM stores them
 * in the Cache API under three caches: "webllm/model" (tensor-cache.json, the weight shards and the
 * tokenizer), "webllm/config" and "webllm/wasm". What is stored is read straight from those caches,
 * so looking costs nothing to download; deleting goes through WebLLM's deleteModelAllInfoInCache,
 * run in the model's worker (./webllm.ts: the page never imports WebLLM), then a sweep of what it
 * left. Every call is guarded: storage can be blocked (private windows, Shields).
 */
import type { ModelSpec } from '../types';

/** A model with files in this browser's storage. */
export interface StoredModel {
  id: string;
  /** Bytes on disk: the cached responses' Content-Length, or the catalogue's size where a header is missing. */
  bytes: number;
  /** Every weight shard is there: it loads without a download. False after a download that stopped part way. */
  complete: boolean;
}

const MODEL_CACHE = 'webllm/model';
const OTHER_CACHES = ['webllm/config', 'webllm/wasm'] as const;

const lengthOf = (response: Response | undefined): number | null => {
  const header = response?.headers.get('content-length');
  const n = header ? Number(header) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function openIfPresent(name: string): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  // caches.open would create an empty cache: look first.
  return (await caches.has(name)) ? caches.open(name) : null;
}

/** Which of these models have files cached here, with their sizes. */
export async function storedModels(models: readonly ModelSpec[]): Promise<StoredModel[]> {
  try {
    const cache = await openIfPresent(MODEL_CACHE);
    if (!cache) return [];
    const keys = new Set((await cache.keys()).map((r) => r.url));
    const others = (await Promise.all(OTHER_CACHES.map(openIfPresent))).filter((c): c is Cache => c !== null);
    const found: StoredModel[] = [];
    for (const model of models) {
      const manifestUrl = new URL('tensor-cache.json', model.weightsUrl).href;
      const own = [...keys].filter((url) => url.startsWith(model.weightsUrl));
      if (own.length === 0) continue;
      let shards: string[] = [];
      const manifest = keys.has(manifestUrl) ? await cache.match(manifestUrl) : undefined;
      if (manifest) {
        const records = ((await manifest.json()) as { records?: { dataPath?: string }[] }).records ?? [];
        shards = records.map((r) => new URL(r.dataPath ?? '', model.weightsUrl).href);
      }
      const complete = shards.length > 0 && shards.every((url) => keys.has(url));
      let bytes = 0;
      let missingHeader = false;
      for (const url of own) {
        const n = lengthOf(await cache.match(url));
        if (n === null) missingHeader = true;
        else bytes += n;
      }
      for (const other of others) {
        for (const url of [new URL('mlc-chat-config.json', model.weightsUrl).href, model.libUrl]) {
          const response = await other.match(url);
          if (response) bytes += lengthOf(response) ?? 0;
        }
      }
      // Without sizes on every entry, a complete model is counted at its catalogue size.
      if (missingHeader && complete) bytes = Math.max(bytes, model.downloadBytes);
      found.push({ id: model.id, bytes, complete });
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Deletes a model's weights, tokenizer, library and configuration: WebLLM's own deletion (`own`,
 * in its worker), then whatever it could not find (a download that stopped before
 * tensor-cache.json was stored).
 */
export async function removeModel(model: ModelSpec, own: (model: ModelSpec) => Promise<void>): Promise<void> {
  try {
    await own(model);
  } catch {
    // Already gone, or WebLLM could not read its manifest: the sweep below still clears it.
  }
  try {
    const cache = await openIfPresent(MODEL_CACHE);
    if (cache) for (const request of await cache.keys()) if (request.url.startsWith(model.weightsUrl)) await cache.delete(request);
    for (const other of await Promise.all(OTHER_CACHES.map(openIfPresent))) {
      await other?.delete(new URL('mlc-chat-config.json', model.weightsUrl).href);
      await other?.delete(model.libUrl);
    }
  } catch {
    // Storage blocked: nothing more can be done from here.
  }
}

/** Asks the browser to keep what is stored (navigator.storage.persist()); false where it will not say yes. */
export async function persistStorage(): Promise<boolean> {
  try {
    const s = (navigator as { storage?: StorageManager }).storage;
    return (await s?.persist()) ?? false;
  } catch {
    return false;
  }
}
