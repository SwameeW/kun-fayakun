import type { App } from '../core/types';

/**
 * The verses in plain words (src/i18n/en.plain.json, in its own chunk so the first load stays light):
 * fetched once, the first time a chapter's notes or a verse card needs them. Until they arrive the
 * notes show each verse without its explanation, and the cards show the translation.
 */
let loading: Promise<void> | null = null;

export function loadPlainWords(app: App): Promise<void> {
  loading ??= import('../i18n/en.plain.json').then((messages) => {
    app.i18n.extend('en.plain.json', messages.default);
  });
  return loading;
}
