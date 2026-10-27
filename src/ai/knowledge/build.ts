/**
 * The knowledge index (public/assets/ai/index.json): every piece of the app's verified content the
 * assistant may retrieve, as short English passages. Pure: the inputs are read by the caller
 * (scripts/build-ai-index.ts on disk, the validator's rule l, the unit tests), so a build from the
 * same files gives the same bytes. No timestamps; passages sorted by id.
 *
 * What goes in, and what never does:
 * - chapters (src/chapters/<id>/content.json): verse and hadith notes, the classical and modern
 *   readings, the science with its values from data/constants.json, open questions, the film's
 *   captions, Explore Mode's moments, process and closer looks, the words to know;
 * - verses (data/quran.json): the key and the English translation only. Never the Arabic, never the
 *   transliteration (its licence is non-commercial; it is neither indexed nor quoted);
 * - the verses in plain words (src/i18n/en.plain.json), labelled an explanation, not a translation;
 * - hadith (data/hadith.json): reference, narrator, grading and the chapter's sourced summary,
 *   never wording; an excluded narration is skipped, read from the file's own `excluded` list;
 * - constants (value, unit, uncertainty, citation) and source titles;
 * - the explorer: each world's facts (src/explore/about.ts over the JPL files), the field notes'
 *   atlas and the prophets' lands, the populated places, the named stars and the constellations;
 * - the plain-words help.
 * Every visible template is a message in src/i18n/en.ai.mind.json (ai.mind.index.*).
 */
import { IntlMessageFormat } from 'intl-messageformat';
import type { PlanetsFile } from '../../astro/ephemeris';
import type { PhysicalFile } from '../../astro/physical';
import {
  BODY_IDS,
  type BodyId,
  type ChapterContent,
  type ChapterId,
  type ConstantsFile,
  type ConstantValueRef,
  type HadithFile,
  type ProseBlock,
  type ScienceConstant,
  type SourcesFile,
} from '../../core/types';
import { worldFacts } from '../../explore/about';
import { ATLAS, PROPHETS, SITES } from '../../explore/field-notes/data';
import type { KnowledgeKind, Passage, PassageKind } from '../types';

export const AI_INDEX_VERSION = 1;
/** Where the index is published, relative to the deployed base (app.assets.json). */
export const AI_INDEX_URL = 'assets/ai/index.json';
/** Where it is written, relative to the repository root. */
export const AI_INDEX_FILE = 'public/assets/ai/index.json';

export interface AiIndexFile {
  version: number;
  passages: Passage[];
}

/** The message files the index reads, in the order their keys are looked up. */
export const AI_INDEX_MESSAGE_FILES = [
  'en.json',
  'en.chapters.json',
  'en.plain.json',
  'en.discover.json',
  'en.help.json',
  'en.explore.json',
  'en.ai.mind.json',
] as const;

type Messages = Readonly<Record<string, string>>;

interface SkyFile {
  sources?: Record<string, { id?: string }>;
  starFields: readonly string[];
  stars: ReadonlyArray<readonly number[]>;
  names: ReadonlyArray<readonly [number, string]>;
  constellations: ReadonlyArray<{ id: string; name: string }>;
}

interface PlacesFile {
  source?: { id?: string };
  places: ReadonlyArray<readonly unknown[]>;
}

export interface AiIndexInputs {
  /** Every chapter's content.json, by chapter id. */
  chapters: readonly ChapterContent[];
  /** The message files above, by file name. */
  messages: Readonly<Record<string, Messages>>;
  /** data/quran.json, of which only the key, translation and the translation's source id are read. */
  quran: { ayat: ReadonlyArray<{ key: string; translation: string; source?: { translation?: string } }> };
  hadith: HadithFile;
  constants: ConstantsFile;
  sources: SourcesFile;
  physical: PhysicalFile;
  planets: PlanetsFile;
  places: PlacesFile;
  sky: SkyFile;
}

/** The files the index is built from, relative to the repository root. */
export const AI_INDEX_INPUT_FILES = {
  quran: 'data/quran.json',
  hadith: 'data/hadith.json',
  constants: 'data/constants.json',
  sources: 'data/sources.json',
  physical: 'public/assets/jpl/physical.json',
  planets: 'public/assets/jpl/planets.json',
  places: 'public/assets/places/places.json',
  sky: 'public/assets/sky/sky.json',
} as const;

/**
 * Reads the inputs through the caller's file access: `read` returns a file's text by its path from
 * the repository root, `chapterDirs` lists the chapter directories under src/chapters ("ch00"...).
 */
export function collectAiIndexInputs(read: (path: string) => string, chapterDirs: readonly string[]): AiIndexInputs {
  const json = (path: string): unknown => JSON.parse(read(path)) as unknown;
  const messages: Record<string, Messages> = {};
  for (const name of AI_INDEX_MESSAGE_FILES) messages[name] = json(`src/i18n/${name}`) as Messages;
  const chapters = [...chapterDirs]
    .filter((d) => /^ch\d\d$/u.test(d))
    .sort()
    .map((d) => json(`src/chapters/${d}/content.json`) as ChapterContent);
  const f = AI_INDEX_INPUT_FILES;
  return {
    chapters,
    messages,
    quran: json(f.quran) as AiIndexInputs['quran'],
    hadith: json(f.hadith) as HadithFile,
    constants: json(f.constants) as ConstantsFile,
    sources: json(f.sources) as SourcesFile,
    physical: json(f.physical) as PhysicalFile,
    planets: json(f.planets) as PlanetsFile,
    places: json(f.places) as PlacesFile,
    sky: json(f.sky) as SkyFile,
  };
}

/** The bytes written to disk: compact JSON and a newline. */
export function serialiseAiIndex(index: AiIndexFile): string {
  return `${JSON.stringify(index)}\n`;
}

/** Longest passage text kept (long prose is cut at a sentence end). */
const MAX_TEXT = 900;

function cut(text: string, max = MAX_TEXT): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (end > max * 0.5) return head.slice(0, end + 1);
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 0 ? space : max)}…`;
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

const numberFormats = new Map<number, Intl.NumberFormat>();
function num(value: number, digits = 3): string {
  let format = numberFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('en', { maximumFractionDigits: digits });
    numberFormats.set(digits, format);
  }
  return format.format(value);
}

/** Significant figures for a measured value, written the app's way (thousands separated). */
function sig(value: number, figures = 4): string {
  if (value === 0 || !Number.isFinite(value)) return num(value);
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  if (magnitude >= 15 || magnitude <= -5) return value.toExponential(figures - 1).replace('e+', ' × 10^').replace('e-', ' × 10^-');
  const digits = Math.max(0, figures - 1 - magnitude);
  return num(Number(value.toPrecision(figures)), digits);
}

class Words {
  private readonly merged: Map<string, string>;
  private readonly compiled = new Map<string, IntlMessageFormat>();

  constructor(files: Readonly<Record<string, Messages>>) {
    this.merged = new Map();
    for (const name of AI_INDEX_MESSAGE_FILES) {
      for (const [key, value] of Object.entries(files[name] ?? {})) if (!key.startsWith('$')) this.merged.set(key, value);
    }
  }

  has(key: string): boolean {
    return this.merged.has(key);
  }

  /** The message, formatted; null when it is missing or needs a value not given. */
  t(key: string, values: Record<string, string | number> = {}): string | null {
    const source = this.merged.get(key);
    if (source === undefined) return null;
    let format = this.compiled.get(key);
    if (!format) {
      format = new IntlMessageFormat(source, 'en');
      this.compiled.set(key, format);
    }
    try {
      const out = format.format<string>(values);
      return Array.isArray(out) ? out.join('') : out;
    } catch {
      return null;
    }
  }

  /** As t, for the index's own templates, which must exist. */
  must(key: string, values: Record<string, string | number> = {}): string {
    const out = this.t(key, values);
    if (out === null) throw new Error(`ai index: message ${key} is missing or lacks a value`);
    return out;
  }

  /** Keys starting with a prefix, in file order. */
  keys(prefix: string): string[] {
    return [...this.merged.keys()].filter((k) => k.startsWith(prefix));
  }
}

function constantField(c: ScienceConstant, field: ConstantValueRef['field']): number | null {
  if (field === 'value') return c.value;
  const u = c.uncertainty;
  if (u === null) return null;
  if (typeof u === 'number') return u;
  if (field === 'plus') return u.plus;
  if (field === 'minus') return u.minus;
  return Math.max(u.plus, u.minus);
}

const BODY_NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  mercury: 'ui.hud.planet.mercury',
  venus: 'ui.hud.planet.venus',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  mars: 'ui.hud.planet.mars',
  jupiter: 'ui.hud.planet.jupiter',
  saturn: 'ui.hud.planet.saturn',
  uranus: 'ui.hud.planet.uranus',
  neptune: 'ui.hud.planet.neptune',
};

/** Which of Explore Mode's closer looks reads which messages (only those that need no live value). */
const EXTRA_PREFIXES: Readonly<Record<string, { title: string; prefixes: readonly string[] }>> = {
  'expansion-model': { title: 'discover.expansion.title', prefixes: ['discover.expansion.'] },
  cmb: { title: 'discover.cmb.title', prefixes: ['discover.cmb.'] },
  supernovae: { title: 'discover.sn.title', prefixes: ['discover.sn.'] },
  orbits: { title: 'discover.orbits.title', prefixes: ['discover.orbits.lead'] },
  earth: { title: 'discover.earth.title', prefixes: ['discover.earth.lead', 'discover.earth.day'] },
  water: { title: 'discover.water.title', prefixes: ['discover.water.'] },
  futures: { title: 'discover.futures.title', prefixes: ['discover.futures.text'] },
  stretch: { title: 'ui.stretch.title', prefixes: ['ui.stretch.note'] },
};

/** Builds the index. Throws when a template the index needs is missing. */
export function buildAiIndex(inputs: AiIndexInputs): AiIndexFile {
  const w = new Words(inputs.messages);
  const out = new Map<string, Passage>();
  const add = (p: Passage): void => {
    if (out.has(p.id)) return; // the first chapter to show something owns it
    const passage: Passage = { ...p, title: cut(p.title, 160), text: cut(p.text) };
    out.set(p.id, passage);
  };
  const constants = new Map(inputs.constants.constants.map((c) => [c.id, c]));
  const prose = (block: ProseBlock): string | null => {
    const values: Record<string, string> = {};
    for (const [name, ref] of Object.entries(block.values ?? {})) {
      const c = constants.get(ref.constant);
      const raw = c ? constantField(c, ref.field) : null;
      if (raw === null) return null;
      values[name] = num(raw / (ref.scale ?? 1), ref.digits ?? 3);
    }
    return w.t(block.key, values);
  };
  const citesOf = (block: ProseBlock): string[] => [...new Set([...(block.cite ?? []), ...Object.values(block.values ?? {}).map((r) => r.constant)])].sort();
  const chapterOfVerse = new Map<string, ChapterId>();
  const summaries = new Map<string, string>();

  for (const content of inputs.chapters) {
    const chapter = content.id;
    const number = Number.parseInt(chapter.slice(2), 10);
    const title = w.t(`timeline.${chapter}.title`) ?? chapter;
    const chapterName = w.must('ai.mind.index.chapterTitle', { number, title });
    add({
      id: `chapter:${chapter}`,
      kind: 'prose',
      title: chapterName,
      text: w.must('ai.mind.index.chapterText', {
        title: w.t(content.intro.titleKey) ?? title,
        subtitle: (content.intro.subtitleKey ? (w.t(content.intro.subtitleKey) ?? '') : '').replace(/[.!?]$/u, ''),
        epoch: w.t(`timeline.${chapter}.epoch`) ?? '',
      }),
      chapter,
      key: `timeline.${chapter}.title`,
      knowledge: 'explanation',
    });
    const note = (key: string, ref: string): void => {
      const text = w.t(key);
      if (text) add({ id: `note:${key}`, kind: 'prose', title: w.must('ai.mind.index.noteTitle', { chapter: chapterName, ref }), text, chapter, key, knowledge: 'explanation' });
    };
    for (const block of content.panel.text) {
      if (block.type === 'verse') {
        if (!chapterOfVerse.has(block.key)) chapterOfVerse.set(block.key, chapter);
        if (block.noteKey) note(block.noteKey, block.key);
      } else {
        if (block.summaryKey && !summaries.has(block.id)) summaries.set(block.id, block.summaryKey);
        if (block.noteKey) note(block.noteKey, block.id);
      }
    }
    for (const cue of content.cues) {
      if (cue.type === 'hadith' && cue.summaryKey) {
        for (const id of [cue.id, ...(cue.also ?? [])]) if (!summaries.has(id)) summaries.set(id, cue.summaryKey);
      }
    }
    for (const [layer, key] of Object.entries(content.panel.notes ?? {})) {
      if (key) note(key, w.t(`ui.panel.layer.${layer}`) ?? layer);
    }
    const layered = (blocks: readonly ProseBlock[], layerKey: string, knowledge: KnowledgeKind): void => {
      const layerTitle = w.must('ai.mind.index.layerTitle', { chapter: chapterName, layer: w.t(layerKey) ?? layerKey });
      for (const block of blocks) {
        const text = prose(block);
        if (!text) continue;
        const cites = citesOf(block);
        add({ id: `prose:${block.key}`, kind: 'prose', title: layerTitle, text, chapter, key: block.key, knowledge, ...(cites.length ? { sourceIds: cites } : {}) });
      }
    };
    layered(content.panel.scholarly.classical, 'ui.panel.classical', 'explanation');
    layered(content.panel.scholarly.modern, 'ui.panel.modern', 'explanation');
    layered(content.panel.science, 'ui.panel.layer.science', 'observed');
    layered(content.panel.openQuestions, 'ui.panel.openQuestions', 'explanation');
    const film = w.must('ai.mind.index.filmTitle', { chapter: chapterName });
    for (const cue of content.cues) {
      if (cue.type !== 'caption') continue;
      const text = w.t(cue.key);
      if (text) add({ id: `prose:${cue.key}`, kind: 'prose', title: film, text, chapter, key: cue.key, knowledge: 'explanation' });
    }
    for (const point of content.explore.points ?? []) {
      const text = prose(point.text);
      if (!text) continue;
      const knowledge: KnowledgeKind = point.kind === 'measured' ? 'observed' : point.kind === 'model' ? 'model' : 'explanation';
      const cites = citesOf(point.text);
      add({ id: `explore:${chapter}.${point.id}`, kind: 'explore', title: w.t(point.titleKey) ?? point.id, text, chapter, key: point.text.key, knowledge, ...(cites.length ? { sourceIds: cites } : {}) });
    }
    const process = content.explore.process;
    if (process) {
      const parts = [process.startKey, process.endKey].map((k) => w.t(k)).filter((t): t is string => t !== null);
      add({ id: `explore:${chapter}.process`, kind: 'explore', title: w.t(process.titleKey) ?? chapterName, text: parts.join(' … '), chapter, key: process.titleKey, knowledge: 'model' });
    }
    for (const extra of content.explore.extras ?? []) {
      if (extra === 'terms') {
        for (const key of w.keys('discover.terms.')) {
          const term = key.slice('discover.terms.'.length);
          if (term === 'title' || term === 'lead') continue;
          const text = w.t(key);
          if (text) add({ id: `term:${term}`, kind: 'term', title: w.t('discover.terms.title') ?? term, text, chapter, key, knowledge: 'explanation' });
        }
        continue;
      }
      const spec = EXTRA_PREFIXES[extra];
      if (!spec) continue;
      const texts = spec.prefixes.flatMap((prefix) => w.keys(prefix)).filter((k) => k !== spec.title).map((k) => w.t(k)).filter((t): t is string => t !== null && t.length > 30);
      if (texts.length === 0) continue;
      add({ id: `explore:extra.${extra}`, kind: 'explore', title: w.must('ai.mind.index.extraTitle', { title: w.t(spec.title) ?? extra }), text: texts.join(' '), chapter, key: spec.title, knowledge: 'explanation' });
    }
  }

  // Verses: key and translation only.
  for (const ayah of inputs.quran.ayat) {
    const chapter = chapterOfVerse.get(ayah.key);
    const source = ayah.source?.translation;
    add({
      id: `verse:${ayah.key}`,
      kind: 'verse',
      title: w.must('ai.mind.index.verseTitle', { key: ayah.key }),
      text: ayah.translation,
      ref: ayah.key,
      knowledge: 'scripture',
      ...(chapter ? { chapter } : {}),
      ...(source ? { sourceIds: [source] } : {}),
    });
  }
  for (const key of w.keys('plain.')) {
    const verse = key.slice('plain.'.length);
    const text = w.t(key);
    if (!text) continue;
    const chapter = chapterOfVerse.get(verse);
    add({ id: `plain:${verse}`, kind: 'prose', title: w.must('ai.mind.index.plainTitle', { key: verse }), text, key, knowledge: 'explanation', ...(chapter ? { chapter } : {}) });
  }

  // Hadith: reference, grading and the summary; never wording, never an excluded narration.
  const excluded = new Set(inputs.hadith.excluded.map((e) => e.sunnahKey));
  for (const entry of inputs.hadith.hadith) {
    if (excluded.has(entry.sunnahKey) || entry.parallels.some((k) => excluded.has(k))) continue;
    const summaryKey = summaries.get(entry.id);
    const summary = summaryKey ? w.t(summaryKey) : null;
    const parts = [
      w.must('ai.mind.index.hadithText', { collection: entry.collection, number: entry.number, narrator: entry.narrator || '—', grading: entry.grading, grader: entry.grader }),
      summary ? w.must('ai.mind.index.hadithSummary', { summary }) : '',
      entry.disputedNote ? w.must('ai.mind.index.hadithDispute', { note: entry.disputedNote }) : '',
    ];
    const sourceIds = inputs.sources.sources.filter((s) => s.hadithIds?.includes(entry.id)).map((s) => s.id);
    add({
      id: `hadith:${entry.id}`,
      kind: 'hadith',
      title: w.must('ai.mind.index.hadithTitle', { collection: entry.collection, number: entry.number }),
      text: parts.filter((p) => p.length > 0).join(' '),
      ref: entry.id,
      knowledge: 'scripture',
      ...(summaryKey ? { key: summaryKey } : {}),
      ...(sourceIds.length ? { sourceIds } : {}),
    });
  }

  // Constants and sources.
  for (const c of inputs.constants.constants) {
    const title = cut((c.description.split(/(?<=\.)\s/u)[0] ?? c.id).replace(/\.$/u, ''), 120).replace(/…$/u, '');
    const digits = 6;
    const unit = c.unit;
    const u = c.uncertainty;
    const value =
      u === null
        ? w.must('ai.mind.index.constantValue', { value: num(c.value, digits), unit })
        : typeof u === 'number'
          ? w.must('ai.mind.index.constantUncertain', { value: num(c.value, digits), uncertainty: num(u, digits), unit })
          : w.must('ai.mind.index.constantAsymmetric', { value: num(c.value, digits), plus: num(u.plus, digits), minus: num(u.minus, digits), unit });
    const stated = c.qualifier ? w.must('ai.mind.index.constantQualified', { value: value.trim(), qualifier: c.qualifier }) : value.trim();
    const parts = [w.must('ai.mind.index.constantText', { title, value: stated }), w.must('ai.mind.index.citation', { citation: c.citation.text })];
    add({ id: `constant:${c.id}`, kind: 'constant', title, text: parts.filter((p) => p.length > 0).join(' '), sourceIds: [c.id], knowledge: 'observed' });
  }
  for (const s of inputs.sources.sources) {
    add({
      id: `source:${s.id}`,
      kind: 'source',
      title: s.title,
      text: w.must('ai.mind.index.sourceText', { title: s.title, credit: s.credit, licence: s.license }),
      sourceIds: [s.id],
      knowledge: 'observed',
    });
  }

  // Help in plain words.
  for (const key of w.keys('help.')) {
    const topic = key.slice('help.'.length);
    if (topic === 'close') continue;
    const text = w.t(key);
    if (!text) continue;
    const body = topic.startsWith('body.') ? topic.slice('body.'.length) : null;
    const name = body && body in BODY_NAME_KEYS ? w.t(BODY_NAME_KEYS[body as BodyId]) : null;
    const words = name ?? topic.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
    add({ id: `help:${topic}`, kind: 'help', title: w.must('ai.mind.index.helpTitle', { topic: words }), text, key, knowledge: 'explanation' });
  }

  // The worlds' facts, from the JPL tables as the explorer shows them.
  for (const id of BODY_IDS) {
    const facts = worldFacts(id, inputs.physical, inputs.planets);
    const body = w.t(id === 'sun' ? 'ui.hud.sun' : id === 'moon' ? 'ui.universe.note.moon.title' : BODY_NAME_KEYS[id]) ?? id;
    const line = (labelKey: string, value: string): string => w.must('ai.mind.index.factLine', { label: w.t(labelKey) ?? labelKey, value });
    const lines = [
      line('ui.universe.about.radius', w.must('ai.mind.index.kmValue', { value: sig(facts.meanRadiusKm, 5) })),
      line('ui.universe.about.mass', `${w.must('ai.mind.index.kgValue', { value: sig(facts.massKg, 4) })} (${w.must(facts.massEarths >= 1 ? 'ui.universe.about.timesEarth' : 'ui.universe.about.ofEarth', { value: sig(facts.massEarths, 3) })})`),
      line('ui.universe.about.density', w.must('ui.universe.about.densityValue', { value: sig(facts.densityGcm3, 3) })),
      line(facts.gravityAt === 'equator' ? 'ui.universe.about.gravityEquator' : 'ui.universe.about.gravitySurface', w.must('ui.universe.about.gravityValue', { value: sig(facts.gravityMs2, 3) })),
      line('ui.universe.about.escape', w.must('ui.universe.about.speedValue', { value: sig(facts.escapeKmS, 3) })),
      line('ui.universe.about.day', Math.abs(facts.rotationDays) < 2 ? w.must('ai.mind.index.hoursValue', { value: sig(Math.abs(facts.rotationDays) * 24, 4) }) : w.must('ui.universe.about.days', { value: sig(Math.abs(facts.rotationDays), 4) })),
    ];
    if (facts.orbit) {
      const period = facts.orbit.periodDays;
      lines.push(
        facts.orbit.around === 'sun'
          ? line('ui.universe.about.year', w.must('ui.universe.about.years', { years: sig(period / 365.25, 4), days: sig(period, 5) }))
          : line('ui.universe.about.orbit', w.must('ui.universe.about.orbitMoon', { period: w.must('ui.universe.about.days', { value: sig(period, 4) }) })),
      );
      if (facts.orbit.semiMajorKm !== null && facts.orbit.eccentricity !== null) {
        const au = facts.orbit.semiMajorKm / inputs.physical.auKm;
        lines.push(line('ui.universe.about.orbit', w.must('ui.universe.about.orbitEarth', { au: `${sig(au, 4)} au`, km: w.must('ai.mind.index.kmValue', { value: sig(facts.orbit.semiMajorKm, 4) }), e: sig(facts.orbit.eccentricity, 3) })));
      }
    }
    if (facts.tiltDeg !== null) lines.push(line(facts.kind === 'planet' ? 'ui.universe.about.tilt' : 'ui.universe.about.tiltEcliptic', w.must('ui.universe.about.degrees', { value: sig(facts.tiltDeg, 3) })));
    const title = w.must('ai.mind.index.worldTitle', { body });
    add({ id: `fact:world.${id}`, kind: 'fact', title, text: `${title}. ${lines.join('. ')}.`, sourceIds: [...facts.sources].sort(), knowledge: 'observed' });
  }

  // The field notes: the atlas and the prophets' lands (by tradition).
  for (const place of ATLAS) {
    const name = w.t(`ui.universe.field.atlas.${place.id}.name`);
    const text = w.t(`ui.universe.field.atlas.${place.id}.text`);
    if (!name || !text) continue;
    add({
      id: `place:atlas.${place.id}`,
      kind: 'place',
      title: name,
      text: `${text} ${w.must('ai.mind.index.coordinates', { lat: num(place.lat, 4), lon: num(place.lon, 4) })}`,
      ref: `${place.lat},${place.lon}`,
      key: `ui.universe.field.atlas.${place.id}.text`,
      sourceIds: ['wikidata-coordinates'],
      knowledge: 'observed',
    });
  }
  const siteById = new Map(SITES.map((s) => [s.id, s]));
  for (const prophet of PROPHETS) {
    const name = w.t(`ui.universe.field.prophet.${prophet.id}.name`);
    const text = w.t(`ui.universe.field.prophet.${prophet.id}.text`);
    if (!name || !text) continue;
    const first = prophet.sites.map((id) => siteById.get(id)).find((s) => s !== undefined);
    const siteNames = prophet.sites.map((id) => w.t(`ui.universe.field.site.${id}`)).filter((t): t is string => t !== null);
    add({
      id: `place:prophet.${prophet.id}`,
      kind: 'place',
      title: siteNames.length ? w.must('ai.mind.index.siteTitle', { prophet: name, site: siteNames.join(', ') }) : name,
      text,
      key: `ui.universe.field.prophet.${prophet.id}.text`,
      knowledge: 'explanation',
      ...(first ? { ref: `${first.lat},${first.lon}`, sourceIds: ['wikidata-coordinates'] } : {}),
    });
  }

  // Populated places (Natural Earth), each a short line with its coordinates.
  const placeSource = inputs.places.source?.id;
  const seen = new Map<string, number>();
  for (const row of inputs.places.places) {
    const [name, lat, lon, population] = row;
    if (typeof name !== 'string' || typeof lat !== 'number' || typeof lon !== 'number' || typeof population !== 'number') continue;
    const base = slug(name) || 'place';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    add({
      id: `place:${base}${n > 1 ? `-${n}` : ''}`,
      kind: 'place',
      title: name,
      text: w.must('ai.mind.index.placeText', { name, lat: num(lat, 3), lon: num(lon, 3), population: num(population, 0) }),
      ref: `${lat},${lon}`,
      knowledge: 'observed',
      ...(placeSource ? { sourceIds: [placeSource] } : {}),
    });
  }

  // Named stars and the constellations (the explorer's sky).
  const fields = inputs.sky.starFields;
  const column = (name: string): number => fields.indexOf(name);
  const [hrAt, raAt, decAt, magAt] = [column('hr'), column('raDeg'), column('decDeg'), column('vmag')];
  const byHr = new Map<number, readonly number[]>();
  for (const star of inputs.sky.stars) {
    const hr = star[hrAt];
    if (hr !== undefined) byHr.set(hr, star);
  }
  const starSources = ['stars', 'names'].map((k) => inputs.sky.sources?.[k]?.id).filter((s): s is string => typeof s === 'string');
  for (const [hr, name] of inputs.sky.names) {
    const star = byHr.get(hr);
    if (!star) continue;
    const [ra, dec, vmag] = [star[raAt], star[decAt], star[magAt]];
    if (ra === undefined || dec === undefined || vmag === undefined) continue;
    add({
      id: `star:${slug(name)}`,
      kind: 'place',
      title: name,
      text: w.must('ai.mind.index.starText', { name, vmag: num(vmag, 2), hr, ra: num(ra, 2), dec: num(dec, 2) }),
      knowledge: 'observed',
      ...(starSources.length ? { sourceIds: starSources } : {}),
    });
  }
  const constellationSource = inputs.sky.sources?.constellations?.id;
  for (const c of inputs.sky.constellations) {
    add({
      id: `constellation:${c.id.toLowerCase()}`,
      kind: 'fact',
      title: w.must('ai.mind.index.constellationTitle', { name: c.name }),
      text: w.must('ai.mind.index.constellationText', { name: c.name, id: c.id }),
      knowledge: 'observed',
      ...(constellationSource ? { sourceIds: [constellationSource] } : {}),
    });
  }

  const passages = [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: AI_INDEX_VERSION, passages };
}

/** The kinds of passage, for filters and the validator. */
export const PASSAGE_KINDS: readonly PassageKind[] = ['verse', 'hadith', 'prose', 'constant', 'term', 'explore', 'fact', 'source', 'help', 'place'];
