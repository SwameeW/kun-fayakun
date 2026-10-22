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
  try {
    window.localStorage.setItem(PREFIX + name, String(value));
  } catch {
    /* Storage unavailable: the preference lasts for this page only. */
  }
}
