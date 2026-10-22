import type { EventBus } from './types';

/** Minimal typed event bus. Listeners run synchronously in subscription order. */
export function createEventBus<E>(): EventBus<E> {
  const listeners = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) (fn as (p: typeof payload) => void)(payload);
    },
  };
}
