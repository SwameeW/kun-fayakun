/**
 * Opt-in memory: off unless the visitor turns it on. While it is on, each question and the final
 * text of its answer are kept in this browser's IndexedDB ('kf-ai'), nowhere else; while it is off
 * nothing is written. clear() wipes both the stored turns and the preference. Every storage call is
 * guarded: in a private window, with storage blocked, or in Node, memory simply stays off and empty.
 */

/** The preference, in localStorage: "1" on, anything else off. */
export const MEMORY_PREFERENCE_KEY = 'kf.ui.aiMemory';
const DB_NAME = 'kf-ai';
const STORE = 'turns';
/** At most this many turns are kept; the oldest go first. */
const KEEP = 200;

export interface MemoryEntry {
  question: string;
  answer: string;
  /** Unix ms. */
  at: number;
}

export interface AiMemory {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Stores a turn when memory is on; resolves either way. */
  remember(entry: MemoryEntry): Promise<void>;
  /** The most recent turns, newest last. */
  recall(limit?: number): Promise<MemoryEntry[]>;
  /** Forgets the stored turns; the preference stays. */
  forget(): Promise<void>;
  /** Forgets everything stored and turns memory off. */
  clear(): Promise<void>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function idb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { autoIncrement: true });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexedDB open failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('indexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('indexedDB transaction aborted'));
    };
  });
}

export function createMemory(): AiMemory {
  const read = (): boolean => {
    try {
      return storage()?.getItem(MEMORY_PREFERENCE_KEY) === '1';
    } catch {
      return false;
    }
  };

  return {
    enabled: read,
    setEnabled(on: boolean): void {
      try {
        storage()?.setItem(MEMORY_PREFERENCE_KEY, on ? '1' : '0');
      } catch {
        /* storage blocked: memory stays as it was */
      }
    },
    async remember(entry: MemoryEntry): Promise<void> {
      const factory = idb();
      if (!read() || !factory) return;
      try {
        const db = await open(factory);
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          store.add({ question: entry.question.slice(0, 600), answer: entry.answer.slice(0, 4000), at: entry.at });
          const count = store.count();
          count.onsuccess = () => {
            let extra = count.result - KEEP;
            if (extra <= 0) return;
            const cursor = store.openCursor();
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c || extra <= 0) return;
              c.delete();
              extra -= 1;
              c.continue();
            };
          };
          await done(tx);
        } finally {
          db.close();
        }
      } catch {
        /* not stored: memory is a convenience, never required */
      }
    },
    async recall(limit = 20): Promise<MemoryEntry[]> {
      const factory = idb();
      if (!read() || !factory) return [];
      try {
        const db = await open(factory);
        try {
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).getAll();
          await done(tx);
          const all = (request.result as unknown[]).filter((e): e is MemoryEntry => typeof e === 'object' && e !== null && typeof (e as MemoryEntry).question === 'string');
          return all.slice(-Math.max(0, limit));
        } finally {
          db.close();
        }
      } catch {
        return [];
      }
    },
    async clear(): Promise<void> {
      try {
        storage()?.removeItem(MEMORY_PREFERENCE_KEY);
      } catch {
        /* nothing to remove */
      }
      await this.forget();
    },
    async forget(): Promise<void> {
      const factory = idb();
      if (!factory) return;
      await new Promise<void>((resolve) => {
        try {
          const request = factory.deleteDatabase(DB_NAME);
          request.onsuccess = () => {
            resolve();
          };
          request.onerror = () => {
            resolve();
          };
          request.onblocked = () => {
            resolve();
          };
        } catch {
          resolve();
        }
      });
    },
  };
}
