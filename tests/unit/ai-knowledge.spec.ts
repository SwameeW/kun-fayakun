/**
 * The knowledge index (src/ai/knowledge/build.ts → public/assets/ai/index.json) and retrieval
 * (src/ai/knowledge/retrieve.ts): the build is deterministic and equals the committed file, it holds
 * only what it may, and thirty questions find what answers them in their top three.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { AI_INDEX_FILE, buildAiIndex, collectAiIndexInputs, serialiseAiIndex } from '../../src/ai/knowledge/build';
import { createRetriever } from '../../src/ai/knowledge/retrieve';
import { stem, synonymTokens, tokenize } from '../../src/ai/knowledge/text';
import type { Passage } from '../../src/ai/types';

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const inputs = collectAiIndexInputs(read, readdirSync(new URL('src/chapters/', root)));
const committed = read(AI_INDEX_FILE);
const index = JSON.parse(committed) as { version: number; passages: Passage[] };
const retriever = createRetriever(index.passages);

test('the build is deterministic and equals the committed index, byte for byte', () => {
  const a = serialiseAiIndex(buildAiIndex(inputs));
  const b = serialiseAiIndex(buildAiIndex(collectAiIndexInputs(read, readdirSync(new URL('src/chapters/', root)))));
  expect(a).toBe(b);
  expect(a).toBe(committed);
  expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  const ids = index.passages.map((p) => p.id);
  expect(ids).toEqual([...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  expect(new Set(ids).size).toBe(ids.length);
});

test('holds the verses’ translation only, hadith without wording and nothing excluded', () => {
  const quran = JSON.parse(read('data/quran.json')) as { ayat: { key: string; translation: string; translit: string }[] };
  const hadith = JSON.parse(read('data/hadith.json')) as { hadith: { id: string }[]; excluded: { sunnahKey: string }[] };
  for (const ayah of quran.ayat) {
    expect(retriever.get(`verse:${ayah.key}`)?.text).toBe(ayah.translation);
    expect(committed.includes(ayah.translit.slice(0, 40))).toBe(false);
  }
  for (const { sunnahKey } of hadith.excluded) {
    expect(retriever.get(`hadith:${sunnahKey.replace(':', '-')}`)).toBeNull();
    expect(committed.toLowerCase().includes(sunnahKey.toLowerCase())).toBe(false);
  }
  const arabic = Array.from(committed, (c) => c.codePointAt(0) ?? 0).filter((cp) => ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0xfb50 && cp <= 0xfeff)) && cp !== 0xfdfa);
  expect(arabic).toEqual([]);
  for (const p of index.passages.filter((x) => x.kind === 'hadith')) {
    expect(p.knowledge).toBe('scripture');
    expect(p.text).toContain('not a quotation');
  }
  const plain = retriever.get('plain:21:30');
  expect(plain?.title).toContain('not a translation');
  expect(plain?.knowledge).toBe('explanation');
});

test('stays small enough to fetch on request', () => {
  expect(committed.length).toBeLessThan(1_200_000);
});

test('tokenises with verse keys whole, stop words out and light stems', () => {
  expect(tokenize('What does 21:30 say about the heavens?')).toEqual(['21:30', 'heaven']);
  expect(stem('galaxies')).toBe('galaxy');
  expect(stem('orbits')).toBe('orbit');
  expect(stem('created')).toBe(stem('create'));
  expect(stem('spinning')).toBe('spin');
  expect(stem('ages')).toBe('ages');
  expect(synonymTokens('where is the qibla').map(([t]) => t)).toEqual(expect.arrayContaining(['kaaba', 'direction']));
});

const QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['how old is the universe', 'constant:universe.age'],
  ['what does 21:30 say', 'verse:21:30'],
  ['36:38', 'verse:36:38'],
  ['qibla', 'help:qibla'],
  ['why is the sky dark at night', 'explore:ch05.observable'],
  ['what is the big bang', 'prose:ch01.scholarly.modern.bigBang'],
  ['how far is a light year', 'help:lightYear'],
  ['what is the cmb', 'prose:ch02.science.cmb'],
  ['where does iron come from', 'prose:ch06.science.us'],
  ['how did the moon form', 'prose:ch08.open.moon'],
  ['how will the universe end', 'prose:ch10.science.futures'],
  ['what is the hubble tension', 'prose:ch04.open.tension'],
  ['polaris', 'star:polaris'],
  ['orion', 'constellation:ori'],
  ['london', 'place:london'],
  ['what is kun fayakun', 'term:kun'],
  ['seven heavens', 'chapter:ch05'],
  ['the throne', 'term:arsh'],
  ['how old is the earth', 'constant:earth.age'],
  ["the sun's resting place", 'verse:36:38'],
  ['what is dark energy', 'prose:ch04.open.darkEnergy'],
  ['six days of creation', 'verse:7:54'],
  ['what is a supernova', 'prose:ch06.science.typeIa'],
  ['prayer times', 'help:prayerTimes'],
  ['hijri calendar', 'help:hijri'],
  ['the pen', 'term:qalam'],
  ['first stars', 'chapter:ch03'],
  ['what is dark matter', 'prose:ch05.open.darkMatter'],
  ['the richat structure', 'place:atlas.richat'],
  ['hadith of imran ibn husain', 'hadith:bukhari-3191'],
  ['speed of light', 'constant:light.speed'],
  ['the oldest traces of life', 'explore:ch09.ocean'],
  ['mars in numbers', 'fact:world.mars'],
];

for (const [query, id] of QUERIES) {
  test(`"${query}" finds ${id} in its top three`, () => {
    const top = retriever.search(query, { limit: 3 }).map((r) => r.passage.id);
    expect(top).toContain(id);
  });
}

test('has at least thirty retrieval cases', () => {
  expect(QUERIES.length).toBeGreaterThanOrEqual(30);
});

test('filters by kind, raises the chapter on screen, breaks ties by id, and gets by id', () => {
  const verses = retriever.search('heavens and the earth', { kinds: ['verse'], limit: 10 });
  expect(verses.length).toBeGreaterThan(3);
  expect(verses.every((r) => r.passage.kind === 'verse')).toBe(true);
  const plain = retriever.search('each in an orbit', { limit: 5 }).map((r) => r.passage.chapter);
  const inCh07 = retriever.search('each in an orbit', { chapter: 'ch07', limit: 5 });
  expect(inCh07[0]?.passage.chapter).toBe('ch07');
  expect(plain.length).toBeGreaterThan(0);
  const tie = createRetriever([
    { id: 'b', kind: 'prose', title: 'Stars', text: 'stars', knowledge: 'explanation' },
    { id: 'a', kind: 'prose', title: 'Stars', text: 'stars', knowledge: 'explanation' },
  ]);
  expect(tie.search('stars').map((r) => r.passage.id)).toEqual(['a', 'b']);
  expect(retriever.get('verse:21:30')?.ref).toBe('21:30');
  expect(retriever.get('nothing:here')).toBeNull();
  expect(retriever.search('')).toEqual([]);
  expect(retriever.search('the of and')).toEqual([]);
});

test('is deterministic for the same question', () => {
  for (const [query] of QUERIES) {
    expect(JSON.stringify(retriever.search(query))).toBe(JSON.stringify(retriever.search(query)));
  }
});
