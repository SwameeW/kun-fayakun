import type { AiContext, ToolCall, ToolDefinition, ToolProblem, ToolRegistry } from '../types';
import { validateSchema } from './schema';
import { problem } from './shared';

/**
 * The registry of tools: every tool by name, the checks a call must pass before anything is sent
 * (its schema, then where it can work, then its own checks against the app's state), and the
 * shortlist a small model is offered for a question.
 *
 * The shortlist is deterministic: the question's words, lightly stemmed, against each tool's keywords
 * (worth most), the words of its name, and its summary; a tool that fits where the visitor is gains a
 * little. The core is always first: the search of the verified content and the way to move about
 * that fits where the visitor is (in a chapter with moments, its moments too). Ties are broken by name.
 */

/** Words that say nothing about which tool is meant. */
const STOP = new Set(
  'a an and any are as at be by can could do does for from give go how i in is it its me my of on or please show tell than that the then this to up us we what when where which who why will with would you your'.split(' '),
);

/**
 * A light stemmer, the same on both sides of the match: plural and verb endings, then a final e
 * ("escapes", "escaping" and "escape" all become "escap"; "orbits" and "orbit" "orbit").
 */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/u, '');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** A text's words, stemmed, without the stop words. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

interface Indexed {
  tool: ToolDefinition;
  /** Each keyword as its stemmed words (a phrase matches when all its words are in the question). */
  keywords: string[][];
  name: Set<string>;
  summary: Set<string>;
}

const WEIGHT = { keyword: 3, name: 2, summary: 1, here: 0.5, date: 3, verseKey: 3 } as const;

/** A date as a question writes it: 2027-08-02, 1 January 2030, January 1, 2030. */
const DATE_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{3,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{3,4}\b/iu;

/**
 * A verse key in the question ("Show me 21:30"): the tool that shows a verse by its key is offered.
 * Without it, "Show me 21:30" from home was offered only the search and the film, and every model
 * read it as a time in the film (docs/AI-EVALUATION.md).
 */
const VERSE_KEY_IN_TEXT = /(?<![\d:.])(?:[1-9]\d?|10\d|11[0-4]):[1-9]\d{0,2}(?![\d:])/u;
export const CITE_VERSE = 'cite.verse';

/** Whether a tool takes a date (its arguments name one). */
const takesDate = (tool: ToolDefinition): boolean => 'properties' in tool.args && Object.hasOwn(tool.args.properties, 'date');

/** The tool for moving about that fits where the visitor is. */
export function navigationTool(where: AiContext['where']): string {
  switch (where) {
    case 'explorer':
    case 'lab':
      return 'explorer.fly';
    case 'chapter':
      return 'film.control';
    case 'home':
    case 'sources':
      return 'film.open';
  }
}

export const CORE_SEARCH = 'search.knowledge';

/** The groups that fit where the visitor is (a small preference among matches, never a match by itself). */
const HERE: Readonly<Record<AiContext['where'], readonly string[]>> = {
  home: ['film', 'cite'],
  chapter: ['film', 'cite'],
  sources: ['cite'],
  explorer: ['explorer', 'time', 'islamic'],
  lab: ['lab', 'time'],
};

const group = (name: string): string => name.slice(0, Math.max(0, name.indexOf('.')));

export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`ai tools: "${t.name}" is defined twice`);
    byName.set(t.name, t);
  }
  const indexed: Indexed[] = [...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((tool) => ({
      tool,
      keywords: tool.keywords.map(terms).filter((k) => k.length > 0),
      name: new Set(terms(tool.name.replace(/[._]/gu, ' '))),
      summary: new Set(terms(tool.summary)),
    }));

  const score = (entry: Indexed, words: ReadonlySet<string>, ctx: AiContext, dated: boolean, keyed: boolean): number => {
    let s = 0;
    for (const k of entry.keywords) if (k.every((w) => words.has(w))) s += WEIGHT.keyword * k.length;
    for (const w of entry.name) if (words.has(w)) s += WEIGHT.name;
    for (const w of entry.summary) if (words.has(w)) s += WEIGHT.summary;
    // A date in the question is a tool's argument ("Show the sky on 2027-08-02" named no keyword of time.date).
    if (dated && takesDate(entry.tool)) s += WEIGHT.date;
    if (keyed && entry.tool.name === CITE_VERSE) s += WEIGHT.verseKey;
    if (s > 0 && HERE[ctx.where].includes(group(entry.tool.name))) s += WEIGHT.here;
    return s;
  };

  const registry: ToolRegistry = {
    all: () => indexed.map((e) => e.tool),
    get: (name) => byName.get(name) ?? null,

    shortlist(question, ctx, limit) {
      const n = Math.max(0, Math.floor(limit));
      const available = indexed.filter((e) => e.tool.available(ctx));
      // In a chapter its moments are a way about it too: "Show the orrery" names no tool's keyword.
      const coreNames = [CORE_SEARCH, navigationTool(ctx.where), ...(ctx.where === 'chapter' && ctx.moments?.length ? ['film.moment'] : [])];
      const core = coreNames.map((name) => available.find((e) => e.tool.name === name)?.tool).filter((t): t is ToolDefinition => t !== undefined);
      const words = new Set(terms(question));
      const ranked = available
        .filter((e) => !core.includes(e.tool))
        .map((e) => ({ tool: e.tool, s: score(e, words, ctx, DATE_IN_TEXT.test(question), VERSE_KEY_IN_TEXT.test(question)) }))
        .filter((r) => r.s > 0)
        // Higher scores first; the registry is sorted by name, and the sort is stable, so ties keep that order.
        .sort((a, b) => b.s - a.s)
        .map((r) => r.tool);
      return [...core, ...ranked].slice(0, n);
    },

    validate(call, ctx) {
      const tool = byName.get(call.tool) ?? null;
      if (!tool) return { ok: false, problems: [problem('tool', 'ai.tool.problem.unknownTool', { tool: call.tool })] };
      const problems: ToolProblem[] = validateSchema(tool.args, call.args);
      if (problems.length > 0) return { ok: false, problems };
      if (!tool.available(ctx)) return { ok: false, problems: [problem('', 'ai.tool.problem.unavailable', { tool: tool.name, where: ctx.where })] };
      const checked = tool.check?.(call.args, ctx) ?? [];
      if (checked.length > 0) return { ok: false, problems: [...checked] };
      const valid: ToolCall = { tool: tool.name, args: call.args };
      return { ok: true, call: valid, tool };
    },
  };
  return registry;
}
