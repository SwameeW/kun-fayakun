/**
 * Guards on what goes into the model and what comes out (docs/AI-INTELLIGENCE.md §5).
 *
 * In: the visitor's question is cut to 600 characters and stripped of control and direction-override
 * characters. Text that reads like an instruction to the model stays as it is: it is the visitor's
 * own question, and the prompts treat everything else as data.
 *
 * Out, in this order, each change flagged on the text block:
 * - arabic-removed: Arabic script is removed (the honorific U+FDFA after the Prophet's name stays,
 *   as it does in the app's own message files);
 * - scripture-quote: a quotation that matches a verse's translation (over 40 characters sharing at
 *   least 60% of the verse's words), or any quotation presented as the Quran's or a hadith's words,
 *   is removed; where the verse can be told, its marker takes the quotation's place, so the verse is
 *   shown from data instead. An unquoted sentence that repeats a verse is treated the same way;
 * - unknown-citation: a citation marker whose id is not in the data is dropped;
 * - banned-phrase: "predicted" about the laboratory becomes "integrated ahead"; any other sentence
 *   with banned phrasing (src/core/phrasing.ts) is removed;
 * - action-claim: a sentence claiming the assistant did something ("I have flown…", "Done:") that no
 *   tool outcome reports done is removed;
 * - unchecked-number: a number with two or more significant digits, or with a unit, that is not
 *   within 1% of a number in the turn's facts, passages or the visitor's own words is marked.
 */
import { BANNED_PHRASES } from '../core/phrasing';
import { tokenize, VERSE_KEY_PATTERN } from './knowledge/text';
import type { Fact, GuardFlag, Passage, ToolKind, ToolOutcome } from './types';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export const INPUT_MAX = 600;

/** C0 and C1 controls, zero-width marks, and the direction embeddings, overrides and isolates (a byte-order mark is whitespace to \s). */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/gu;

export interface InputGuardResult {
  text: string;
  truncated: boolean;
}

/** The question as the assistant reads it: clean, single-spaced, at most INPUT_MAX characters. */
export function guardInput(raw: string): InputGuardResult {
  const clean = raw.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length <= INPUT_MAX) return { text: clean, truncated: false };
  const head = clean.slice(0, INPUT_MAX);
  const space = head.lastIndexOf(' ');
  return { text: (space > INPUT_MAX * 0.8 ? head.slice(0, space) : head).trim(), truncated: true };
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export type CitationKind = 'verse' | 'hadith' | 'fact' | 'passage';
export interface Citation {
  kind: CitationKind;
  id: string;
}

export interface OutcomeSummary {
  tool: string;
  kind: ToolKind;
  status: ToolOutcome['status'];
}

export interface OutputGuardData {
  /** The facts this turn's tools returned. */
  facts: readonly Fact[];
  /** The passages the model was given. */
  passages: readonly Passage[];
  /** The visitor's question and other text whose numbers the visitor supplied (tool arguments, observed lines). */
  given?: readonly string[];
  /** What each tool call of this turn reported. */
  outcomes: readonly OutcomeSummary[];
  /** Whether a citation id is in the data. */
  known: { verse(key: string): boolean; hadith(id: string): boolean; fact(id: string): boolean; passage(id: string): boolean };
  /** Verse translations that might match a quotation (e.g. a search of the verse passages for it). */
  verses(quote: string): readonly { key: string; text: string }[];
  /** The words added after a number that could not be checked, e.g. "(not checked)". */
  uncheckedLabel: string;
  /** The reply stopped at its token limit. */
  truncated?: boolean;
}

export interface OutputGuardResult {
  text: string;
  flags: GuardFlag[];
  /** Known citations, in the order they first appear. */
  citations: Citation[];
}

const MARKER = /\[\[(verse|hadith|fact|passage):([^\]\s]{1,120})\]\]/gu;

/** The salawat ligature, kept: the app writes it after the Prophet's name. */
const SALAWAT = String.fromCodePoint(0xfdfa);

function isArabic(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
}

/** Text without Arabic script (bar the honorific), and whether any was removed. */
export function removeArabic(text: string): { text: string; removed: boolean } {
  let removed = false;
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((isArabic(cp) || /\p{Script_Extensions=Arabic}/u.test(ch)) && ch !== SALAWAT) {
      removed = true;
      continue;
    }
    out += ch;
  }
  if (!removed) return { text, removed };
  // Quotation marks or brackets left empty, and the spaces around them.
  out = out.replace(/[“"‘'«(]\s*[”"’'»)]/gu, '').replace(/[ \t]{2,}/gu, ' ').replace(/\s+([,.;:!?])/gu, '$1');
  return { text: out, removed };
}

/** Words that present a quotation as scripture when they come just before it. */
const PRESENTED = /\b(?:qur'?an|verse|ayah|aya|surah|sura|allah|god|lord|the prophet|messenger|hadith|narrat\w*|revealed|scripture)\b[^“"«]{0,40}$/iu;

interface QuoteSpan {
  start: number;
  end: number;
  inner: string;
}

function quoteSpans(text: string): QuoteSpan[] {
  const spans: QuoteSpan[] = [];
  const re = /“([^”]{2,800})”|«([^»]{2,800})»|"([^"\n]{2,800})"|‘([^’]{25,800})’/gu;
  for (const m of text.matchAll(re)) {
    spans.push({ start: m.index, end: m.index + m[0].length, inner: m[1] ?? m[2] ?? m[3] ?? m[4] ?? '' });
  }
  return spans;
}

/** The verse a passage of text repeats, if one: by quotation (40+ chars, 60% of its words) or whole sentence (80%). */
function matchVerse(text: string, data: OutputGuardData, strict: boolean): string | null {
  const q = new Set(tokenize(text));
  if (q.size < 3) return null;
  let best: { key: string; score: number } | null = null;
  for (const v of data.verses(text)) {
    const words = new Set(tokenize(v.text));
    if (words.size === 0) continue;
    let shared = 0;
    for (const w of q) if (words.has(w)) shared += 1;
    const ofVerse = shared / words.size;
    const ofQuote = shared / q.size;
    const score = strict ? (ofVerse >= 0.8 && shared >= 8 ? ofVerse : 0) : ofVerse >= 0.6 || (ofQuote >= 0.6 && shared >= 5) ? Math.max(ofVerse, ofQuote) : 0;
    if (score > 0 && (!best || score > best.score || (score === best.score && v.key < best.key))) best = { key: v.key, score };
  }
  return best?.key ?? null;
}

function scriptureQuotes(text: string, data: OutputGuardData): { text: string; changed: boolean } {
  let changed = false;
  let out = '';
  let last = 0;
  for (const span of quoteSpans(text)) {
    const before = text.slice(Math.max(0, span.start - 60), span.start);
    const after = text.slice(span.end, span.end + 30);
    const presented = PRESENTED.test(before) || /^\s*\(?\s*(?:\[\[(?:verse|hadith):|(?:quran\s+)?\d{1,3}:\d{1,3})/iu.test(after);
    const key = span.inner.length > 40 ? matchVerse(span.inner, data, false) : null;
    if (!key && !presented) continue;
    changed = true;
    out += text.slice(last, span.start);
    const nearKey = /\[\[verse:(\d{1,3}:\d{1,3})\]\]/u.exec(after)?.[1] ?? null;
    if (key && key !== nearKey) out += `[[verse:${key}]]`;
    last = span.end;
  }
  if (!changed) return { text, changed };
  out += text.slice(last);
  return { text: out, changed };
}

/** Splits text into sentences, keeping each one's trailing space. */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])(\s+)/u);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) out.push(`${parts[i] ?? ''}${parts[i + 1] ?? ''}`);
  return out;
}

function unquotedVerses(text: string, data: OutputGuardData): { text: string; changed: boolean } {
  let changed = false;
  const out = sentences(text).map((s) => {
    const bare = s.replace(MARKER, ' ');
    if (bare.trim().length <= 60) return s;
    const key = matchVerse(bare, data, true);
    if (!key) return s;
    changed = true;
    return `[[verse:${key}]]${/\s$/u.test(s) ? ' ' : ''}`;
  });
  return { text: out.join(''), changed };
}

function citationMarkers(text: string, data: OutputGuardData): { text: string; dropped: boolean; citations: Citation[] } {
  let dropped = false;
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const out = text.replace(MARKER, (_m, kind: CitationKind, id: string) => {
    const ok = kind === 'verse' ? data.known.verse(id) : kind === 'hadith' ? data.known.hadith(id) : kind === 'fact' ? data.known.fact(id) : data.known.passage(id);
    if (!ok) {
      dropped = true;
      return '';
    }
    const k = `${kind}:${id}`;
    if (!seen.has(k)) {
      seen.add(k);
      citations.push({ kind, id });
    }
    return `[[${kind}:${id}]]`;
  });
  return { text: out, dropped, citations };
}

const LAB_WORDS = /\b(?:laborator(?:y|ies)|lab|simulation|simulated|integrat\w*|n-body|run|sandbox)\b/iu;

function bannedPhrasing(text: string): { text: string; changed: boolean } {
  let changed = false;
  const out = sentences(text).map((s) => {
    if (!BANNED_PHRASES.some(([, re]) => re.test(s))) return s;
    changed = true;
    const onlyPredicted = BANNED_PHRASES.every(([phrase, re]) => phrase === 'predicted' || !re.test(s));
    if (onlyPredicted && LAB_WORDS.test(s) && !/\b(?:qur'?an|verse|hadith|scripture|prophet)\b/iu.test(s)) {
      return s.replace(/\bpredicted\b/giu, 'integrated ahead and showed');
    }
    return '';
  });
  return { text: out.join(''), changed };
}

/** Claimed deeds, and the tools whose done outcome would back each. */
const CLAIM_VERBS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^(?:flown|flew|moved|taken|took|sent|landed|walked|placed|put|brought|zoomed|travell?ed)$/u, ['explorer.', 'film.open']],
  [/^(?:set|changed|reset|reversed|sped|slowed|paused|played|resumed|turned|switched|started|stopped|enabled|disabled|activated|increased|decreased|adjusted)$/u, ['time.', 'film.', 'explorer.', 'lab.']],
  [/^(?:removed|added|doubled|halved|tripled|deleted|created|applied|made|launched|ran|run|thrown|threw|crashed|smashed|scaled|increased|kicked)$/u, ['lab.']],
  [/^(?:opened|closed|shown|showed|displayed|hidden|hid|brought up|pulled up|loaded)$/u, ['explorer.', 'film.', 'lab.', 'cite.']],
];
const CLAIM = /\b(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+(?:just\s+|now\s+|already\s+|successfully\s+|gone\s+ahead\s+and\s+)*(flown|flew|moved|taken|took|sent|landed|walked|placed|put|brought|zoomed|travell?ed|set|changed|reset|reversed|sped|slowed|paused|played|resumed|turned|switched|started|stopped|enabled|disabled|activated|increased|decreased|adjusted|removed|added|doubled|halved|tripled|deleted|created|applied|made|launched|ran|run|thrown|threw|crashed|smashed|scaled|kicked|opened|closed|shown|showed|displayed|hidden|hid|loaded)\b/iu;
const PASSIVE_CLAIM = /\b(?:has|have)\s+(?:now\s+)?been\s+(set|changed|moved|removed|added|started|opened|closed|paused|doubled|halved|tripled|applied|reset|reversed|turned|switched|deleted|launched|scaled)\b/iu;
const DONE = /^\s*(?:done|all done|finished)\s*[:!.,-]/iu;

function backed(prefixes: readonly string[], outcomes: readonly OutcomeSummary[]): boolean {
  return outcomes.some((o) => o.status === 'done' && prefixes.some((p) => o.tool.startsWith(p)));
}

function actionClaims(text: string, outcomes: readonly OutcomeSummary[]): { text: string; changed: boolean } {
  let changed = false;
  const out = sentences(text).map((s) => {
    if (DONE.test(s)) {
      if (outcomes.some((o) => o.status === 'done' && (o.kind === 'view' || o.kind === 'experiment'))) return s;
      changed = true;
      return '';
    }
    const m = CLAIM.exec(s) ?? PASSIVE_CLAIM.exec(s);
    if (!m) return s;
    const verb = (m[1] ?? '').toLowerCase();
    const prefixes = CLAIM_VERBS.find(([re]) => re.test(verb))?.[1] ?? ['explorer.', 'film.', 'time.', 'lab.'];
    if (backed(prefixes, outcomes)) return s;
    changed = true;
    return '';
  });
  return { text: out.join(''), changed };
}

/* Numbers */

const SCALE: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const UNIT = String.raw`%|°c|°f|°|percent|degrees?|km\/s|km\/h|m\/s²|m\/s\^2|m\/s|g\/cm³|kg|km|kilometres?|kilometers?|metres?|meters?|au|light[- ]years?|light[- ]minutes?|light[- ]seconds?|light[- ]hours?|ly|parsecs?|pc|mpc|gyr|myr|years?|yrs?|days?|hours?|minutes?|seconds?|kelvin|k|tonnes?|tons?|bar|kpa|pa|times`;
const NUMBER = new RegExp(
  String.raw`(?<![\w.,:\[/-])(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(?:×|x)\s*10\^?\s*(-?\d+)|e([+-]?\d+))?(?:\s+(thousand|million|billion|trillion))?(?:\s*(${UNIT})(?![\w]))?`,
  'giu',
);

interface ParsedNumber {
  /** As written, without its scale ("4.6" of "4.6 billion"). */
  mantissa: number;
  value: number;
  decimals: number;
  significant: number;
  unit: string | null;
  start: number;
  end: number;
}

function parseNumbers(text: string): ParsedNumber[] {
  const out: ParsedNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const raw = (m[1] ?? '').replace(/,/gu, '');
    const mantissa = Number(raw);
    if (!Number.isFinite(mantissa)) continue;
    const exponent = m[2] ?? m[3];
    const scale = (exponent !== undefined ? 10 ** Number(exponent) : 1) * (m[4] ? (SCALE[m[4].toLowerCase()] ?? 1) : 1);
    const digits = raw.replace(/^-/u, '').replace('.', '');
    const decimals = raw.includes('.') ? (raw.split('.')[1] ?? '').length : 0;
    const trimmed = raw.includes('.') ? digits.replace(/^0+/u, '') : digits.replace(/^0+/u, '').replace(/0+$/u, '');
    out.push({ mantissa, value: mantissa * scale, decimals, significant: Math.max(trimmed.length, 1), unit: m[5] ?? null, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function close(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= 0.01 * Math.max(Math.abs(a), Math.abs(b));
}

function rounds(written: ParsedNumber, value: number): boolean {
  const f = 10 ** written.decimals;
  return Math.round(value * f) / f === written.mantissa || Math.round((value / (written.value / (written.mantissa || 1))) * f) / f === written.mantissa;
}

/** Every number the turn's data states, as written and as scaled. */
function allowedNumbers(data: OutputGuardData): { values: number[]; mantissas: number[] } {
  const values: number[] = [];
  const mantissas: number[] = [];
  const texts: string[] = [...(data.given ?? [])];
  for (const f of data.facts) {
    if (typeof f.value === 'number') values.push(f.value, Math.abs(f.value));
    texts.push(String(f.value), f.label);
  }
  for (const p of data.passages) texts.push(p.title, p.text);
  for (const t of texts) {
    for (const n of parseNumbers(t)) {
      values.push(n.value, Math.abs(n.value));
      mantissas.push(n.mantissa, Math.abs(n.mantissa));
    }
  }
  return { values, mantissas };
}

function uncheckedNumbers(text: string, data: OutputGuardData): { text: string; changed: boolean } {
  // Markers and verse keys carry digits that are not quantities.
  const masked = text.replace(MARKER, (m) => '\u0001'.repeat(m.length)).replace(VERSE_KEY_PATTERN, (m) => '\u0001'.repeat(m.length));
  const { values, mantissas } = allowedNumbers(data);
  let changed = false;
  let out = '';
  let last = 0;
  for (const n of parseNumbers(masked)) {
    if (n.significant < 2 && n.unit === null) continue;
    const ok = values.some((v) => close(Math.abs(n.value), v) || rounds(n, v)) || mantissas.some((v) => close(Math.abs(n.mantissa), v) || rounds({ ...n, value: n.mantissa }, v));
    if (ok) continue;
    changed = true;
    out += `${text.slice(last, n.end)} ${data.uncheckedLabel}`;
    last = n.end;
  }
  if (!changed) return { text, changed };
  out += text.slice(last);
  return { text: out, changed };
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([,.;:!?])(?=\s|$)/gu, '$1')
    .replace(/\(\s*\)/gu, '')
    .trim();
}

/** The model's words made safe to show, with what was changed and the citations that remain. */
export function guardOutput(text: string, data: OutputGuardData): OutputGuardResult {
  const flags: GuardFlag[] = [];
  const flag = (f: GuardFlag, on: boolean): void => {
    if (on && !flags.includes(f)) flags.push(f);
  };
  let t = text;
  const arabic = removeArabic(t);
  t = arabic.text;
  flag('arabic-removed', arabic.removed);
  const quoted = scriptureQuotes(t, data);
  t = quoted.text;
  const repeated = unquotedVerses(t, data);
  t = repeated.text;
  flag('scripture-quote', quoted.changed || repeated.changed);
  const markers = citationMarkers(t, data);
  t = markers.text;
  flag('unknown-citation', markers.dropped);
  const banned = bannedPhrasing(t);
  t = banned.text;
  flag('banned-phrase', banned.changed);
  const claims = actionClaims(t, data.outcomes);
  t = claims.text;
  flag('action-claim', claims.changed);
  const numbers = uncheckedNumbers(t, data);
  t = numbers.text;
  flag('unchecked-number', numbers.changed);
  flag('truncated', data.truncated === true);
  t = tidy(t);
  // Citations that survived every step, in order.
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const m of t.matchAll(MARKER)) {
    const kind = m[1] as CitationKind;
    const id = m[2] ?? '';
    if (seen.has(`${kind}:${id}`)) continue;
    seen.add(`${kind}:${id}`);
    citations.push({ kind, id });
  }
  return { text: t, flags, citations };
}

/** Text with its citation markers replaced: verses by their key in brackets, the rest removed. */
export function stripMarkers(text: string): string {
  return tidy(text.replace(MARKER, (_m, kind: CitationKind, id: string) => (kind === 'verse' ? `(${id})` : '')));
}
