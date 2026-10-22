import { chapterById } from '../chapters/index';
import type { AssetLoader, ChapterContext, ChapterId, ChapterModule, QualityTier } from './types';

export interface LoadedChapter {
  id: ChapterId;
  module: ChapterModule;
  /** The context passed to load(); the same object is passed to enter(). */
  ctx: ChapterContext;
  /** Tier the chapter built its resources for. */
  tier: QualityTier;
}

export interface ChapterLoader {
  /** Imports and loads a chapter (once); progress runs 0..1. */
  load(id: ChapterId, onProgress?: (progress: number) => void): Promise<LoadedChapter>;
  /** Loads in the background; failures are logged, not thrown. */
  prefetch(id: ChapterId): void;
  /** Disposes every loaded chapter not listed (pending ones once they finish). */
  retain(keep: readonly ChapterId[]): void;
  disposeAll(): void;
}

class Entry {
  loaded: LoadedChapter | null = null;
  progress = 0;
  readonly listeners = new Set<(progress: number) => void>();
  /** Set by retain(); a pending load disposes itself when it finishes. */
  unwanted = false;
  readonly promise: Promise<LoadedChapter>;

  constructor(run: (entry: Entry) => Promise<LoadedChapter>) {
    this.promise = run(this);
  }
}

/** Share of the progress bar given to the dynamic import; the rest is the chapter's assets. */
const IMPORT_SHARE = 0.2;

export function createChapterLoader(deps: {
  makeContext: (assets: AssetLoader) => ChapterContext;
  assets: { tracked(onProgress: (done: number, started: number) => void): AssetLoader };
  currentTier: () => QualityTier;
}): ChapterLoader {
  const entries = new Map<ChapterId, Entry>();

  const report = (entry: Entry, progress: number): void => {
    // Monotonic: the asset count can grow while a chapter loads.
    if (progress <= entry.progress) return;
    entry.progress = progress;
    for (const fn of entry.listeners) fn(progress);
  };

  const disposeEntry = (id: ChapterId, entry: Entry): void => {
    entries.delete(id);
    if (!entry.loaded) return;
    try {
      entry.loaded.module.dispose();
    } catch (err) {
      console.error(`[loader] ${id}.dispose() failed`, err);
    }
  };

  const start = (id: ChapterId): Entry => {
    const entry = new Entry(async (self) => {
      const importer = chapterById(id).load;
      if (!importer) throw new Error(`Chapter ${id} is not available yet.`);
      const { default: create } = await importer();
      report(self, IMPORT_SHARE);
      const module = create();
      const ctx = deps.makeContext(
        deps.assets.tracked((done, started) => {
          report(self, IMPORT_SHARE + (1 - IMPORT_SHARE) * 0.95 * (done / Math.max(1, started)));
        }),
      );
      const tier = deps.currentTier();
      await module.load(ctx);
      report(self, 1);
      const loaded: LoadedChapter = { id, module, ctx, tier };
      self.loaded = loaded;
      if (self.unwanted) disposeEntry(id, self);
      return loaded;
    });
    entry.promise.catch(() => {
      // Forget failures so a later attempt can retry.
      if (entries.get(id) === entry) entries.delete(id);
    });
    entries.set(id, entry);
    return entry;
  };

  return {
    load(id, onProgress) {
      const entry = entries.get(id) ?? start(id);
      entry.unwanted = false;
      if (onProgress) {
        entry.listeners.add(onProgress);
        onProgress(entry.progress);
        void entry.promise.then(
          () => entry.listeners.delete(onProgress),
          () => entry.listeners.delete(onProgress),
        );
      }
      return entry.promise;
    },
    prefetch(id) {
      if (entries.has(id)) return;
      start(id).promise.catch((err: unknown) => {
        console.warn(`[loader] Prefetch of ${id} failed`, err);
      });
    },
    retain(keep) {
      for (const [id, entry] of [...entries]) {
        if (keep.includes(id)) continue;
        if (entry.loaded) disposeEntry(id, entry);
        else entry.unwanted = true;
      }
    },
    disposeAll() {
      for (const [id, entry] of [...entries]) {
        if (entry.loaded) disposeEntry(id, entry);
        else entry.unwanted = true;
      }
    },
  };
}
