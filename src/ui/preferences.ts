/**
 * Per-viewer UI conveniences in localStorage. Storage can be unavailable
 * (private windows, blocked site data), so every access is guarded and the
 * UI works without it.
 */
const PREFIX = 'kf.ui.';

export function readPreference(name: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + name);
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

export function writePreference(name: string, value: boolean): void {
  writePreferenceString(name, String(value));
}

/** A string preference (e.g. the explorer's detail choice), or null when unset or unavailable. */
export function readPreferenceString(name: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + name);
  } catch {
    return null;
  }
}

export function writePreferenceString(name: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + name, value);
  } catch {
    /* Storage unavailable: the preference lasts for this page only. */
  }
}

/** A remembered on/off choice that several parts of the interface show and change together. */
export interface SharedPreference {
  get(): boolean;
  set(value: boolean): void;
  /** Called after every change, whichever part made it. */
  subscribe(listener: (value: boolean) => void): void;
}

export function sharedPreference(name: string, fallback: boolean): SharedPreference {
  const listeners = new Set<(value: boolean) => void>();
  let value: boolean | null = null;
  const get = (): boolean => (value ??= readPreference(name) ?? fallback);
  return {
    get,
    set(next) {
      if (next === get()) return;
      value = next;
      writePreference(name, next);
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
    },
  };
}
