import type { App, DataStore, HadithEntry, HadithFile, HadithId, QuranFile, VerseKey } from '../../core/types';
import type { WithheldNarration } from '../guards';
import type { AnswerBlock, Fact, PassageKind, ToolDefinition } from '../types';
import { done, ensureMessages, fact, num, problem, refused, say, str } from './shared';

/**
 * Scripture and sources by reference. A verse or a hadith is named by its key or id and shown by the
 * interface from data/quran.json and data/hadith.json (src/ui/scripture.ts), never in the assistant's
 * words: the tools return the reference, never text. A hadith's wording is never shown (none has
 * been entered and reviewed); its reference, narrator and grading come from the data. The narrations
 * data/hadith.json excludes are read from its `excluded` list at run time and never offered.
 */

/**
 * The verses and hadith that can be cited: every key in data/quran.json the data store shows, every
 * hadith not excluded; and the excluded narrations themselves, so the output guards can remove a
 * sentence that names one.
 */
export interface ScriptureCatalogue {
  verses: readonly VerseKey[];
  hadith: readonly HadithId[];
  withheld: readonly WithheldNarration[];
}

const VERSE_KEY = /^\d{1,3}:\d{1,3}$/u;

/** The data store withholds a verse whose checksum fails (it then has no Arabic). */
export function verseAvailable(data: DataStore, key: string): key is VerseKey {
  if (!VERSE_KEY.test(key)) return false;
  try {
    return data.verse(key as VerseKey).arabic.length > 0;
  } catch {
    return false;
  }
}

/** The data store has no entry for an excluded or unknown hadith (it throws). */
export function hadithEntry(data: DataStore, id: string): HadithEntry | null {
  try {
    return data.hadith(id);
  } catch {
    return null;
  }
}

/** Builds the catalogue from the data files themselves, through the app's asset loader. */
export async function loadScriptureCatalogue(app: App): Promise<ScriptureCatalogue> {
  const [quran, hadith] = await Promise.all([app.assets.json<QuranFile>('data/quran.json'), app.assets.json<HadithFile>('data/hadith.json'), app.data.ready]);
  return catalogueFrom(quran, hadith, app.data);
}

/** The catalogue from the files' contents: verses the store shows, hadith neither excluded nor withheld. */
export function catalogueFrom(quran: Pick<QuranFile, 'ayat'>, hadith: Pick<HadithFile, 'hadith' | 'excluded'>, data: DataStore): ScriptureCatalogue {
  const excluded = new Set(hadith.excluded.map((e) => e.sunnahKey));
  return {
    verses: quran.ayat.map((a) => a.key).filter((k) => verseAvailable(data, k)),
    hadith: hadith.hadith.filter((h) => !excluded.has(h.sunnahKey) && !h.parallels.some((p) => excluded.has(p)) && hadithEntry(data, h.id) !== null).map((h) => h.id),
    withheld: withheldFrom(hadith),
  };
}

/** A collection's title, and the shorter names it goes by ("Sahih al-Bukhari", "al-Bukhari", "Bukhari"). */
function collectionNames(title: string): string[] {
  const short = title.replace(/^(?:sahih|sunan|jami['’`]?|musnad|muwatta)\s+/iu, '');
  return [...new Set([title, short, short.replace(/^(?:al|at|an|ad|as|ash|ibn)-/iu, ''), short.replace(/^abi\s/iu, 'Abu ')])];
}

/** The narrations the hadith file excludes, each with the names its collection goes by (from the file's own entries). */
export function withheldFrom(hadith: Pick<HadithFile, 'hadith' | 'excluded'>): WithheldNarration[] {
  const titles = new Map<string, string>();
  for (const h of hadith.hadith) titles.set(h.sunnahKey.split(':')[0] ?? '', h.collection);
  return hadith.excluded.map((e) => {
    const title = titles.get(e.sunnahKey.split(':')[0] ?? '');
    return { sunnahKey: e.sunnahKey, collection: title ? collectionNames(title) : [] };
  });
}

const EMPTY: ScriptureCatalogue = { verses: [], hadith: [], withheld: [] };

export function citeTools(catalogue: ScriptureCatalogue = EMPTY): ToolDefinition[] {
  const verse: ToolDefinition = {
    name: 'cite.verse',
    kind: 'cite',
    summary: 'Show a verse of the Quran by its key (surah:ayah) from the verified data.',
    keywords: ['verse', 'ayah', 'quran', 'surah', 'scripture', 'what does the quran say'],
    args: { type: 'object', properties: { key: { type: 'string', enum: catalogue.verses, description: 'surah:ayah' } }, required: ['key'], additionalProperties: false },
    available: () => catalogue.verses.length > 0,
    preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.cite.verse.preview', { key: str(args, 'key') ?? '' }),
    run(args, env) {
      ensureMessages(env.i18n);
      const key = str(args, 'key') ?? '';
      if (!catalogue.verses.includes(key as VerseKey) || !verseAvailable(env.app.data, key)) return Promise.resolve(refused(problem('key', 'ai.tool.cite.verse.unavailable', { key })));
      return Promise.resolve(done('ai.tool.cite.verse.observed', { key }, { blocks: [{ type: 'verse', key }] }));
    },
  };

  const hadith: ToolDefinition = {
    name: 'cite.hadith',
    kind: 'cite',
    summary: "Show a hadith's reference, narrator and grading by its id (never its wording).",
    keywords: ['hadith', 'prophet', 'narration', 'sunnah', 'bukhari', 'muslim', 'tirmidhi', 'abu dawud', 'grading'],
    args: { type: 'object', properties: { id: { type: 'string', enum: catalogue.hadith } }, required: ['id'], additionalProperties: false },
    available: () => catalogue.hadith.length > 0,
    preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.cite.hadith.preview', { id: str(args, 'id') ?? '' }),
    run(args, env) {
      ensureMessages(env.i18n);
      const id = str(args, 'id') ?? '';
      const entry = catalogue.hadith.includes(id) ? hadithEntry(env.app.data, id) : null;
      if (!entry) return Promise.resolve(refused(problem('id', 'ai.tool.cite.hadith.unavailable', { id })));
      const i18n = env.i18n;
      const facts: Fact[] = [
        fact(i18n, `hadith:${id}.reference`, 'ai.tool.cite.hadith.reference', {}, `${entry.collection} ${entry.number}`, undefined, 'scripture', [id]),
        fact(i18n, `hadith:${id}.narrator`, 'ai.tool.cite.hadith.narrator', {}, entry.narrator, undefined, 'scripture', [id]),
        fact(i18n, `hadith:${id}.grading`, 'ai.tool.cite.hadith.grading', { grader: entry.grader }, entry.grading, undefined, 'scripture', [id]),
        ...(entry.disputedNote ? [fact(i18n, `hadith:${id}.disputed`, 'ai.tool.cite.hadith.disputed', {}, entry.disputedNote, undefined, 'scripture', [id])] : []),
      ];
      const blocks: AnswerBlock[] = [{ type: 'hadith', id }, { type: 'notice', key: 'ai.tool.cite.hadith.note' }];
      return Promise.resolve(done('ai.tool.cite.hadith.observed', { id, reference: `${entry.collection} ${entry.number}` }, { facts, blocks }));
    },
  };

  const constant: ToolDefinition = {
    name: 'cite.constant',
    kind: 'cite',
    summary: 'A measured constant by its id in data/constants.json (e.g. universe.age, cmb.temperature, light.speed), with its uncertainty and citation.',
    keywords: ['constant', 'measured', 'how old', 'age of the universe', 'temperature', 'hubble', 'value', 'measurement', 'uncertainty'],
    args: { type: 'object', properties: { id: { type: 'string', maxLength: 80, pattern: '^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$' } }, required: ['id'], additionalProperties: false },
    available: () => true,
    preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.cite.constant.preview', { id: str(args, 'id') ?? '' }),
    run(args, env) {
      ensureMessages(env.i18n);
      const id = str(args, 'id') ?? '';
      let c;
      try {
        c = env.app.data.constant(id);
      } catch {
        return Promise.resolve(refused(problem('id', 'ai.tool.cite.constant.unknown', { id })));
      }
      const i18n = env.i18n;
      const u = c.uncertainty;
      const facts: Fact[] = [fact(i18n, `constant:${id}`, 'ai.tool.cite.constant.value', { id }, c.value, c.unit, 'observed', [id])];
      if (u !== null) facts.push(fact(i18n, `constant:${id}.uncertainty`, 'ai.tool.cite.constant.uncertainty', {}, typeof u === 'number' ? `± ${u}` : `+${u.plus} / -${u.minus}`, c.unit, 'observed', [id]));
      if (c.qualifier) facts.push(fact(i18n, `constant:${id}.qualifier`, 'ai.tool.cite.constant.qualifier', {}, c.qualifier, undefined, 'observed', [id]));
      facts.push(fact(i18n, `constant:${id}.citation`, 'ai.tool.cite.constant.citation', {}, c.citation.text, undefined, 'observed', [id]));
      return Promise.resolve(done('ai.tool.cite.constant.observed', { id }, { facts, blocks: [{ type: 'facts', facts }] }));
    },
  };

  const source: ToolDefinition = {
    name: 'cite.source',
    kind: 'cite',
    summary: 'A source by its id in data/sources.json: its title, author, licence and link.',
    keywords: ['source', 'reference', 'citation', 'where does this come from', 'licence', 'license', 'credit', 'data'],
    args: { type: 'object', properties: { id: { type: 'string', maxLength: 80, pattern: '^[a-z0-9]+([.-][a-z0-9]+)*$' } }, required: ['id'], additionalProperties: false },
    available: () => true,
    preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.cite.source.preview', { id: str(args, 'id') ?? '' }),
    run(args, env) {
      ensureMessages(env.i18n);
      const id = str(args, 'id') ?? '';
      let entry;
      try {
        entry = env.app.data.sources().sources.find((s) => s.id === id);
      } catch {
        entry = undefined;
      }
      if (!entry) return Promise.resolve(refused(problem('id', 'ai.tool.cite.source.unknown', { id })));
      const i18n = env.i18n;
      const facts: Fact[] = [
        fact(i18n, `source:${id}.title`, 'ai.tool.cite.source.title', {}, entry.title, undefined, 'observed', [id]),
        ...(entry.author ? [fact(i18n, `source:${id}.author`, 'ai.tool.cite.source.author', {}, entry.author, undefined, 'observed', [id])] : []),
        fact(i18n, `source:${id}.licence`, 'ai.tool.cite.source.licence', {}, entry.license, undefined, 'observed', [id]),
        fact(i18n, `source:${id}.url`, 'ai.tool.cite.source.url', {}, entry.url, undefined, 'observed', [id]),
        fact(i18n, `source:${id}.credit`, 'ai.tool.cite.source.credit', {}, entry.credit, undefined, 'observed', [id]),
      ];
      return Promise.resolve(done('ai.tool.cite.source.observed', { id, title: entry.title }, { facts, blocks: [{ type: 'facts', facts }] }));
    },
  };

  return [verse, hadith, constant, source];
}

const KINDS: readonly PassageKind[] = ['verse', 'hadith', 'prose', 'constant', 'term', 'explore', 'fact', 'source', 'help', 'place'];

/**
 * The search of the verified content (the retriever's index). A verse or hadith it finds comes back
 * as a reference for the interface to render from data (an excluded or withheld one is dropped);
 * everything else as the passage, in the app's own words.
 */
export const searchKnowledge: ToolDefinition = {
  name: 'search.knowledge',
  kind: 'read',
  summary: "Search the app's verified content (chapters, verses, sources, constants, help) for passages about the question.",
  keywords: ['what', 'why', 'how', 'explain', 'tell me about', 'meaning', 'search', 'find', 'learn'],
  args: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 200, pattern: '\\S', description: 'What to look for' },
      kinds: { type: 'array', items: { type: 'string', enum: KINDS }, minItems: 1, maxItems: KINDS.length },
      limit: { type: 'integer', minimum: 1, maximum: 8 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  available: () => true,
  // A query with a verse key is not said back before the key is checked (run leaves out one the data does not hold).
  preview: (args, _ctx, i18n) => {
    const query = str(args, 'query') ?? '';
    return /\d{1,3}:\d{1,3}/u.test(query) ? say(i18n, 'ai.tool.search.previewVerse') : say(i18n, 'ai.tool.search.preview', { query });
  },
  run(args, env) {
    ensureMessages(env.i18n);
    // A verse key the data does not hold is not searched for, nor said back: "Quran 2:999" found four
    // other verses "for “Quran 2:999”" (docs/AI-EVALUATION.md).
    const query = (str(args, 'query') ?? '').replace(/(?<![\w.:/-])(\d{1,3}):(\d{1,3})(?![\w:/-])/gu, (key, s: string, a: string) => (env.retriever.get(`verse:${Number(s)}:${Number(a)}`) ? key : ' ')).replace(/\s+/gu, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(query)) return Promise.resolve(refused(problem('query', 'ai.tool.search.unheld')));
    const list: readonly unknown[] = Array.isArray(args.kinds) ? args.kinds : [];
    const kinds = Array.isArray(args.kinds) ? list.filter((k): k is PassageKind => typeof k === 'string' && (KINDS as readonly string[]).includes(k)) : undefined;
    const ctx = env.context();
    const found = env.retriever.search(query, { ...(kinds ? { kinds } : {}), chapter: ctx.chapter, limit: num(args, 'limit') ?? 4 });
    const blocks: AnswerBlock[] = [];
    for (const { passage } of found) {
      if (passage.kind === 'verse') {
        if (passage.ref !== undefined && verseAvailable(env.app.data, passage.ref)) blocks.push({ type: 'verse', key: passage.ref });
      } else if (passage.kind === 'hadith') {
        if (passage.ref !== undefined && hadithEntry(env.app.data, passage.ref)) blocks.push({ type: 'hadith', id: passage.ref });
      } else {
        blocks.push({ type: 'passage', passage });
      }
    }
    return Promise.resolve(done(blocks.length > 0 ? 'ai.tool.search.observed' : 'ai.tool.search.none', { query, count: blocks.length }, { blocks }));
  },
};
