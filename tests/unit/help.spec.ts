/**
 * Plain-words help's coverage (src/ui/explore/help.ts): every topic a "?" is given in the code has
 * its explanation in src/i18n/en.help.json, every world has one, and none is long (two or three
 * short sentences, so a child reads it in one go).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BODY_IDS } from '../../src/core/types';

const help = JSON.parse(readFileSync(new URL('../../src/i18n/en.help.json', import.meta.url), 'utf8')) as Record<string, string>;
const dir = new URL('../../src/ui/explore/', import.meta.url);

test('every topic given a "?" in the code has its plain-words explanation, every world too', () => {
  const used = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    // helpButton(app, 'topic', ...), withHelp(app, el, 'topic', ...), helpFor('topic', ...), corner('topic', ...), helpDetails(key, testId, 'topic', ...), row(..., 'testId', 'topic').
    for (const m of src.matchAll(/helpButton\(app, '([\w.]+)'/gu)) used.add(m[1] ?? '');
    for (const m of src.matchAll(/withHelp\(app, [^,]+?(?:\([^)]*\))?\)?, '([\w.]+)'/gu)) used.add(m[1] ?? '');
    for (const m of src.matchAll(/(?:helpFor|corner)\('([\w.]+)'/gu)) used.add(m[1] ?? '');
    for (const m of src.matchAll(/helpDetails\(\s*'[\w.]+',\s*'[\w-]+',\s*'([\w.]+)'/gu)) used.add(m[1] ?? '');
  }
  for (const id of BODY_IDS) used.add(`body.${id}`);
  expect(used.size).toBeGreaterThan(60);
  const missing = [...used].filter((t) => !(`help.${t}` in help));
  expect(missing).toEqual([]);
});

test('each explanation is short: at most three sentences and 60 words', () => {
  for (const [key, text] of Object.entries(help)) {
    if (key.startsWith('$') || key === 'help.close') continue;
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z“])/u).length;
    expect(sentences, key).toBeLessThanOrEqual(3);
    expect(text.split(/\s+/u).length, key).toBeLessThanOrEqual(60);
  }
});
