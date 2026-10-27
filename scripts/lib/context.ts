/** Everything the validation rules read, loaded once. */
import type { ConstantsFile, HadithFile, QuranFile, SourcesFile } from '../../src/core/types';
import { loadCitations, type CitationsFile } from './citations';
import { collectRefs, loadChapters, type ContentLoad, type ContentRefs, type LoadedChapter } from './content';
import { loadJson, readText, relPath, rootPath, type Loaded } from './files';
import { loadMessages, type MessageLoad } from './i18n';

/** M1 chapters whose content.json must exist. */
export const M1_CHAPTERS = ['ch00', 'ch01', 'ch02'] as const;

export interface ValidationContext {
  online: boolean;
  citations: CitationsFile;
  quran: Loaded<QuranFile>;
  sources: Loaded<SourcesFile>;
  hadith: Loaded<HadithFile>;
  constants: Loaded<ConstantsFile>;
  content: ContentLoad;
  refs: Array<{ chapter: LoadedChapter; refs: ContentRefs }>;
  i18n: { en: MessageLoad; chapters: MessageLoad; explore: MessageLoad; lab: MessageLoad; islamic: MessageLoad; stars: MessageLoad; photo: MessageLoad; help: MessageLoad; plain: MessageLoad; discover: MessageLoad; aiEngine: MessageLoad; aiTools: MessageLoad; aiMind: MessageLoad; ar: MessageLoad };
  /** The disclaimer from docs/SPEC.md section 1.7, without its quotation marks. */
  specDisclaimer: string;
}

/** Reads the quoted disclaimer from the "On-screen disclaimer" line of docs/SPEC.md. */
export function readSpecDisclaimer(): string {
  const line = readText(rootPath('docs', 'SPEC.md'))
    .split('\n')
    .find((l) => l.includes('On-screen disclaimer'));
  const match = line ? /“(.+)”/.exec(line) : null;
  if (!match?.[1]) throw new Error('docs/SPEC.md: disclaimer line not found');
  return match[1];
}

export function loadContext(online: boolean): ValidationContext {
  const content = loadChapters();
  return {
    online,
    citations: loadCitations(),
    quran: loadJson<QuranFile>(rootPath('data', 'quran.json')),
    sources: loadJson<SourcesFile>(rootPath('data', 'sources.json')),
    hadith: loadJson<HadithFile>(rootPath('data', 'hadith.json')),
    constants: loadJson<ConstantsFile>(rootPath('data', 'constants.json')),
    content,
    refs: content.chapters.map((chapter) => ({ chapter, refs: collectRefs(chapter) })),
    i18n: {
      en: loadMessages('src', 'i18n', 'en.json'),
      chapters: loadMessages('src', 'i18n', 'en.chapters.json'),
      explore: loadMessages('src', 'i18n', 'en.explore.json'),
      lab: loadMessages('src', 'i18n', 'en.lab.json'),
      islamic: loadMessages('src', 'i18n', 'en.islamic.json'),
      stars: loadMessages('src', 'i18n', 'en.stars.json'),
      photo: loadMessages('src', 'i18n', 'en.photo.json'),
      help: loadMessages('src', 'i18n', 'en.help.json'),
      plain: loadMessages('src', 'i18n', 'en.plain.json'),
      discover: loadMessages('src', 'i18n', 'en.discover.json'),
      aiEngine: loadMessages('src', 'i18n', 'en.ai.engine.json'),
      aiTools: loadMessages('src', 'i18n', 'en.ai.tools.json'),
      aiMind: loadMessages('src', 'i18n', 'en.ai.mind.json'),
      ar: loadMessages('src', 'i18n', 'ar.json'),
    },
    specDisclaimer: readSpecDisclaimer(),
  };
}

/** Message for a data file that is not usable, naming who writes it. */
export function unavailable(loaded: Loaded<unknown>, owner: string): string | null {
  if (loaded.status === 'missing') return `${relPath(loaded.path)} is missing (owner: ${owner})`;
  if (loaded.status === 'invalid') return `${relPath(loaded.path)} is not valid JSON: ${loaded.error} (owner: ${owner})`;
  return null;
}
