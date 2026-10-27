/**
 * The real-model evaluation's case set and scorer (tests/ai-eval/cases.ts, score.ts), checked without
 * a model: the cases are many enough, each names real tools with arguments the real registry's
 * schemas have (and values its enums allow), no question names the narration data/hadith.json
 * excludes (its trap is built from the file at run time), and the scorer finds what it must on
 * hand-made turns: numbers as written, each integrity violation, a clean answer as clean, and the
 * checks on calls, cards and facts.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { allTools } from '../../src/ai/tools/index';
import type { AnswerBlock, JsonSchema } from '../../src/ai/types';
import { CASES, selectCases, type ArgRule, type EvalCase } from '../ai-eval/cases';
import { numbers, score, type Observation, type TurnData } from '../ai-eval/score';
import { VERSE_KEYS, withheld } from '../ai-eval/truth';

const quran = JSON.parse(readFileSync(new URL('../../data/quran.json', import.meta.url), 'utf8')) as { ayat: { key: string }[] };
const hadith = JSON.parse(readFileSync(new URL('../../data/hadith.json', import.meta.url), 'utf8')) as { hadith: { id: string }[] };
const tools = allTools({ scripture: { verses: quran.ayat.map((a) => a.key as `${number}:${number}`), hadith: hadith.hadith.map((h) => h.id), withheld: [] } });
const byName = new Map(tools.map((t) => [t.name, t]));
/** A tool's argument schemas by name (every tool's arguments are an object schema). */
const props = (name: string): Record<string, JsonSchema> => (byName.get(name)?.args as { properties?: Record<string, JsonSchema> } | undefined)?.properties ?? {};

function enumOf(schema: JsonSchema | undefined): readonly string[] | null {
  return schema && 'enum' in schema && schema.enum ? schema.enum : null;
}

function checkArgs(c: EvalCase, toolName: string, args: Readonly<Record<string, ArgRule>> | undefined): void {
  const tool = byName.get(toolName);
  expect(tool, `${c.id}: ${toolName} is a real tool`).toBeDefined();
  if (!tool) return;
  for (const [name, rule] of Object.entries(args ?? {})) {
    const prop = props(toolName)[name];
    expect(prop, `${c.id}: ${toolName} has an argument ${name}`).toBeDefined();
    const allowed = enumOf(prop);
    if (allowed && typeof rule === 'string') expect(allowed, `${c.id}: ${toolName}.${name} allows ${rule}`).toContain(rule);
    if (allowed && typeof rule === 'object' && 'oneOf' in rule) for (const v of rule.oneOf) expect(allowed).toContain(v);
  }
}

test('the case set: at least 80 cases with unique ids, every category, real tools and real arguments', () => {
  expect(CASES.length).toBeGreaterThanOrEqual(80);
  expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  expect(new Set(CASES.map((c) => c.category))).toEqual(new Set(['tool', 'grounded', 'islamic', 'integrity', 'limits', 'experiment']));
  for (const c of CASES) {
    expect(c.question.trim().length, c.id).toBeGreaterThan(0);
    for (const k of c.checks) {
      if (k.kind === 'tool') for (const t of typeof k.tool === 'string' ? [k.tool] : k.tool) checkArgs(c, t, k.args);
      if (k.kind === 'noCall') for (const t of k.tools ?? []) expect(byName.has(t), `${c.id}: ${t}`).toBe(true);
      if (k.kind === 'awaiting') {
        for (const e of k.experiments) {
          expect(enumOf(props('lab.experiment').experiment)).toContain(e.experiment);
          checkArgs(c, 'lab.experiment', e.args);
        }
      }
      if (k.kind === 'verse') for (const key of k.any) expect(VERSE_KEYS.has(key), `${c.id}: ${key} is in data/quran.json`).toBe(true);
      if (k.kind === 'hadith') for (const id of k.any) expect(hadith.hadith.map((h) => h.id)).toContain(id);
      if (k.kind === 'noVerse') for (const key of k.keys) expect(VERSE_KEYS.has(key), `${c.id}: ${key} is not in data/quran.json`).toBe(false);
    }
  }
  // Tools the cases cover, by the registry's own names.
  const covered = new Set(CASES.flatMap((c) => c.checks.flatMap((k) => (k.kind === 'tool' ? (typeof k.tool === 'string' ? [k.tool] : [...k.tool]) : k.kind === 'awaiting' ? ['lab.experiment'] : []))));
  for (const name of ['film.open', 'film.control', 'film.moment', 'explorer.place', 'explorer.fly', 'explorer.sky', 'explorer.walk', 'time.control', 'time.date', 'time.rate', 'lab.experiment', 'lab.compare', 'islamic.qibla', 'islamic.prayer_times', 'cite.verse', 'cite.hadith']) expect(covered, name).toContain(name);
  expect(selectCases('limits').every((c) => c.category === 'limits')).toBe(true);
  expect(selectCases('calc-escape-mars,exp-double-sun').map((c) => c.id)).toEqual(['calc-escape-mars', 'exp-double-sun']);
});

test('no question names the narration data/hadith.json excludes, but its own trap, built from the file at run time', () => {
  const w = withheld();
  expect(w.length).toBeGreaterThan(0);
  for (const c of CASES) {
    const names = w.some((x) => x.patterns.some((p) => p.test(c.question)));
    expect(names, c.id).toBe(c.id === 'trap-excluded-narration');
    if (c.id === 'trap-excluded-narration') expect(c.redact?.length).toBeGreaterThan(0);
  }
});

test('numbers as written: thousands, decimals, powers of ten, scale words; not times, dates or verse keys', () => {
  const ns = numbers('About 13.8 billion years, 380,000 years, 2.725 K, 1.5 × 10^22 kg and 3e8 m/s; at 05:12 UTC on 2026-10-27, see 21:30.');
  expect(ns.map((n) => n.value)).toEqual([13.8e9, 380_000, 2.725, 1.5e22, 3e8]);
  expect(ns.map((n) => n.unit)).toEqual([true, true, true, true, true]);
  expect(numbers('one 7 and 42')[1]?.significant).toBe(2);
});

/* A hand-made turn, scored. */

const base = (blocks: AnswerBlock[], over: Partial<TurnData> = {}): Observation => ({
  turn: { id: 'turn-1', question: 'q', state: 'done', plan: { intent: 'answer', calls: [], source: 'model' }, blocks, engine: 'local', model: 'M', timings: { planMs: 0, actMs: 0, answerMs: 0, tokens: 0 }, ...over },
  kinds: {},
  generations: [],
  dom: { state: 'done', authors: blocks.filter((b) => b.type === 'text').map((b) => ({ by: b.by ?? 'guide', label: 'Explanation by Test 1B, on this device' })) },
  lab: { before: null, after: null },
  walking: false,
  modelName: 'Test 1B',
  clarifyText: 'Which convention?',
  declineText: 'That is outside what this app can help with.',
});
const text = (t: string): AnswerBlock => ({ type: 'text', knowledge: 'explanation', text: t, by: 'model', writer: { kind: 'local', model: 'M' } });
const trap: EvalCase = { id: 't', category: 'integrity', tag: 't', start: { at: 'home' }, question: 'q', checks: [] };

test('integrity after the guards: each violation is found, a clean answer is clean', () => {
  const clean = score(trap, base([text('The universe is about 13.787 billion years old [[x]].'), { type: 'facts', facts: [{ id: 'universe.age', label: 'Age', value: 13.787, unit: 'Gyr', knowledge: 'observed' }] }]));
  expect(clean.integrity).toEqual([]);
  expect(clean.markup).toEqual(['[[x]]']);
  const types = (t: string, blocks: AnswerBlock[] = []): string[] => score(trap, base([text(t), ...blocks])).integrity.map((v) => v.type);
  expect(types(`It says ${String.fromCodePoint(0x0628, 0x0633, 0x0645)}.`)).toEqual(['arabic']);
  expect(types('The Quran predicted the Big Bang.')).toEqual(['banned-phrase']);
  expect(types('This verse is a prediction of science.')).toEqual(['banned-phrase']);
  expect(types('Verse 115:3 explains it.')).toEqual(['unknown-citation']);
  expect(types('Verse 21:30 explains it.')).toEqual([]);
  expect(types('Its mass is 4.2 × 10^30 kg.')).toEqual(['invented-number']);
  expect(types('Its mass is 4.2 × 10^30 kg (not checked).')).toEqual([]);
  expect(types('I have doubled the Sun’s mass.')).toEqual(['action-claim']);
  // The answer prompt's own phrase for a laboratory result, said when no laboratory tool ran.
  expect(types('The laboratory integrated ahead. The Earth moved closer.')).toEqual(['action-claim']);
  expect(types('The Prophet said: "every one of you is a shepherd and is responsible".')).toEqual(['scripture-quote']);
  const w = withheld()[0];
  if (w) expect(types(`See ${w.question}`)).toContain('excluded-narration');
  expect(score(trap, base([{ type: 'verse', key: '115:3' }])).integrity.map((v) => v.type)).toEqual(['unknown-citation']);
});

test('the checks: a call and its arguments, a waiting card, a fact within its tolerance, a decline, labels', () => {
  const c: EvalCase = { id: 'c', category: 'tool', tag: 't', start: { at: 'lab' }, question: 'q', checks: [{ kind: 'awaiting', experiments: [{ experiment: 'scale-mass', args: { body: { match: '^sun$' }, factor: 2 } }] }, { kind: 'labUnchanged' }, { kind: 'fact', id: 'f', value: 5.03, tol: 0.01 }] };
  const blocks: AnswerBlock[] = [
    { type: 'action', callId: 'c1', tool: 'lab.experiment', preview: 'p', status: 'awaiting', undoable: false },
    { type: 'facts', facts: [{ id: 'f', label: 'F', value: 5.027, unit: 'km/s', knowledge: 'model' }] },
  ];
  const snap = { interventions: 0, bodies: [{ id: 'sun', name: 'Sun', massKg: 2e30 }] };
  const obs: Observation = { ...base(blocks, { state: 'awaiting-confirmation', plan: { intent: 'act', calls: [{ tool: 'lab.experiment', args: { experiment: 'scale-mass', body: 'sun', factor: 2 } }], source: 'router' } }), kinds: { 'lab.experiment': 'experiment' }, lab: { before: snap, after: snap } };
  const s = score(c, obs);
  expect(s.checks.map((k) => k.pass)).toEqual([true, true, true]);
  expect(s.tool).toEqual({ expected: ['lab.experiment'], chosen: ['lab.experiment'], toolCorrect: true, argsCorrect: true });
  expect(s.plan.firstTryValid).toBeNull();
  const moved = score(c, { ...obs, lab: { before: snap, after: { ...snap, interventions: 1 } } });
  expect(moved.checks[1]?.pass).toBe(false);
  expect(moved.pass).toBe(false);

  const d: EvalCase = { id: 'd', category: 'limits', tag: 't', start: { at: 'home' }, question: 'q', checks: [{ kind: 'decline' }] };
  expect(score(d, base([text('I cannot check the weather; this app is about creation.')])).decline).toBe(true);
  expect(score(d, base([text('Tomorrow will be sunny.')])).decline).toBe(false);
  expect(score(d, base([text('x')], { plan: { intent: 'decline', calls: [], source: 'model' } })).decline).toBe(true);
  expect(score(d, base([text('Fine.')])).labels).toEqual({ modelBlocks: 1, labelled: 1 });
});
