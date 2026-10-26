import { sharedPreference } from './preferences';

/**
 * Sound on or off: one choice for the film's sound (./film-sound) and the explorer's wind (its
 * navigator's Sound), on unless the visitor turned it off, kept for the next visit.
 */
export const sound = sharedPreference('sound', true);
