import { sharedPreference } from './preferences';

/**
 * Which English the film's verse cards show: the published translation (the default), or the
 * verse's plain-words explanation in its place, labelled as an explanation. The notes always show
 * both. The visitor's choice is kept with their other UI conveniences.
 */
const choice = sharedPreference('versePlain', false);

export const versePlain = (): boolean => choice.get();
export const setVersePlain = (next: boolean): void => {
  choice.set(next);
};
export const onVersePlainChange = (listener: (plain: boolean) => void): void => {
  choice.subscribe(listener);
};
