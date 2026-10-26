import { readPreference, writePreference } from './preferences';

/**
 * Which English the film's verse cards show: the published translation (the default), or the
 * verse's plain-words explanation in its place, labelled as an explanation. The notes always show
 * both. The visitor's choice is kept with their other UI conveniences.
 */
type Listener = (plain: boolean) => void;

const PREFERENCE = 'versePlain';
const listeners = new Set<Listener>();
let plain: boolean | null = null;

export function versePlain(): boolean {
  plain ??= readPreference(PREFERENCE) ?? false;
  return plain;
}

export function setVersePlain(next: boolean): void {
  if (next === versePlain()) return;
  plain = next;
  writePreference(PREFERENCE, next);
  for (const listener of listeners) listener(next);
}

export function onVersePlainChange(listener: Listener): void {
  listeners.add(listener);
}
