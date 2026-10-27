import type { App } from '../../core/types';
import type { ToolDefinition, ToolRegistry } from '../types';
import { CALC_TOOLS } from './calc';
import { citeTools, loadScriptureCatalogue, searchKnowledge, type ScriptureCatalogue } from './cite';
import { EXPLORER_TOOLS } from './explorer';
import { FILM_TOOLS } from './film';
import { ISLAMIC_TOOLS } from './islamic';
import { LAB_TOOLS } from './lab';
import { createToolRegistry } from './registry';
import { ensureMessages } from './shared';
import { TIME_TOOLS } from './time';

/**
 * The assistant's tools (docs/AI-INTELLIGENCE.md section 4): the only way it does anything. Lazy:
 * nothing here is imported by the shell or the explorer's chunk.
 *
 * `createRegistry()` holds every tool; the citation tools offer the verses and hadith of a catalogue
 * read from the data files (`createRegistryFor(app)` reads it; without one they are not offered).
 */

export interface RegistryOptions {
  scripture?: ScriptureCatalogue;
}

export function allTools(options: RegistryOptions = {}): ToolDefinition[] {
  return [...FILM_TOOLS, ...EXPLORER_TOOLS, ...TIME_TOOLS, ...ISLAMIC_TOOLS, ...LAB_TOOLS, ...CALC_TOOLS, ...citeTools(options.scripture), searchKnowledge];
}

export function createRegistry(options: RegistryOptions = {}): ToolRegistry {
  return createToolRegistry(allTools(options));
}

/** The registry with the scripture catalogue read from data/quran.json and data/hadith.json, and the tools' messages added. */
export async function createRegistryFor(app: App): Promise<ToolRegistry> {
  ensureMessages(app.i18n);
  return createRegistry({ scripture: await loadScriptureCatalogue(app) });
}

/** Adds the tools' messages (src/i18n/en.ai.tools.json) to the app's catalogue. */
export const registerToolMessages = ensureMessages;

export { validateSchema, fits } from './schema';
export { stem, terms, navigationTool } from './registry';
export { catalogueFrom, loadScriptureCatalogue, withheldFrom, type ScriptureCatalogue } from './cite';
export { MESSAGE_FILE } from './shared';
