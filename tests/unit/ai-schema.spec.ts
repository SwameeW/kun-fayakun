/**
 * The assistant's JSON Schema subset (src/ai/tools/schema.ts): every keyword, nested paths, anyOf,
 * and no silent coercion ("3" is not 3, 1 is not true, null is not missing).
 */
import { expect, test } from '@playwright/test';
import { fits, validateSchema } from '../../src/ai/tools/schema';
import type { JsonSchema } from '../../src/ai/types';

const keys = (schema: JsonSchema, value: unknown): string[] => validateSchema(schema, value).map((p) => `${p.path}:${p.messageKey.replace('ai.tool.problem.', '')}`);

test('types: nothing is coerced', () => {
  expect(keys({ type: 'number' }, 3)).toEqual([]);
  expect(keys({ type: 'number' }, '3')).toEqual([':type']);
  expect(keys({ type: 'number' }, Number.NaN)).toEqual([':type']);
  expect(keys({ type: 'number' }, Number.POSITIVE_INFINITY)).toEqual([':type']);
  expect(keys({ type: 'integer' }, 3)).toEqual([]);
  expect(keys({ type: 'integer' }, 3.5)).toEqual([':type']);
  expect(validateSchema({ type: 'integer' }, 3.5)[0]?.values).toEqual({ expected: 'integer', got: 'number' });
  expect(keys({ type: 'boolean' }, true)).toEqual([]);
  expect(keys({ type: 'boolean' }, 1)).toEqual([':type']);
  expect(keys({ type: 'boolean' }, 'true')).toEqual([':type']);
  expect(keys({ type: 'string' }, 'a')).toEqual([]);
  expect(keys({ type: 'string' }, 7)).toEqual([':type']);
  expect(keys({ type: 'string' }, null)).toEqual([':type']);
  expect(keys({ type: 'array', items: { type: 'number' } }, {})).toEqual([':type']);
  expect(keys({ type: 'object', properties: {} }, [])).toEqual([':type']);
  expect(keys({ type: 'object', properties: {} }, null)).toEqual([':type']);
});

test('numbers: minimum and maximum are inclusive', () => {
  const s: JsonSchema = { type: 'number', minimum: 0.01, maximum: 100 };
  expect(keys(s, 0.01)).toEqual([]);
  expect(keys(s, 100)).toEqual([]);
  expect(keys(s, 0.001)).toEqual([':minimum']);
  expect(keys(s, 100.5)).toEqual([':maximum']);
  expect(validateSchema(s, 101)[0]?.values).toEqual({ limit: 100 });
});

test('strings: enum, const, maxLength in code points, pattern', () => {
  expect(keys({ type: 'string', enum: ['a', 'b'] }, 'b')).toEqual([]);
  expect(keys({ type: 'string', enum: ['a', 'b'] }, 'c')).toEqual([':enum']);
  expect(validateSchema({ type: 'string', enum: ['a', 'b'] }, 'c')[0]?.values).toEqual({ allowed: 'a, b', more: 0 });
  const many = Array.from({ length: 25 }, (_, i) => `k${i}`);
  expect(validateSchema({ type: 'string', enum: many }, 'x')[0]?.values).toMatchObject({ more: 5 });
  expect(keys({ type: 'string', const: 'yes' }, 'yes')).toEqual([]);
  expect(keys({ type: 'string', const: 'yes' }, 'no')).toEqual([':const']);
  expect(keys({ type: 'string', maxLength: 3 }, 'abc')).toEqual([]);
  expect(keys({ type: 'string', maxLength: 3 }, 'abcd')).toEqual([':maxLength']);
  // Two characters outside the Basic Multilingual Plane are two, not four.
  expect(keys({ type: 'string', maxLength: 2 }, '\u{1F319}\u{1F31F}')).toEqual([]);
  expect(keys({ type: 'string', pattern: '^\\d{1,3}:\\d{1,3}$' }, '21:30')).toEqual([]);
  expect(keys({ type: 'string', pattern: '^\\d{1,3}:\\d{1,3}$' }, '21:30a')).toEqual([':pattern']);
  // Unanchored patterns search, as JSON Schema's do.
  expect(keys({ type: 'string', pattern: '\\S' }, '  x ')).toEqual([]);
  expect(keys({ type: 'string', pattern: '\\S' }, '   ')).toEqual([':pattern']);
  // A pattern that does not compile lets nothing through.
  expect(keys({ type: 'string', pattern: '(' }, 'anything')).toEqual([':pattern']);
});

test('objects: required, additionalProperties false, nested paths', () => {
  const s: JsonSchema = {
    type: 'object',
    properties: {
      body: { type: 'string', enum: ['earth', 'mars'] },
      where: { type: 'object', properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number' } }, required: ['lat', 'lon'], additionalProperties: false },
      tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', maxLength: 4 } }, required: ['name'] }, maxItems: 3 },
    },
    required: ['body'],
    additionalProperties: false,
  };
  expect(keys(s, { body: 'earth' })).toEqual([]);
  expect(keys(s, {})).toEqual(['body:required']);
  expect(keys(s, { body: undefined })).toEqual(['body:required']);
  expect(keys(s, { body: null })).toEqual(['body:type']);
  expect(keys(s, { body: 'earth', extra: 1 })).toEqual(['extra:additional']);
  expect(keys(s, { body: 'earth', where: { lat: 100 } })).toEqual(['where.lon:required', 'where.lat:maximum']);
  expect(keys(s, { body: 'earth', where: { lat: 0, lon: '0' } })).toEqual(['where.lon:type']);
  expect(keys(s, { body: 'earth', where: { lat: 0, lon: 0, alt: 1 } })).toEqual(['where.alt:additional']);
  expect(keys(s, { body: 'earth', tags: [{ name: 'ok' }, { name: 'too long' }, {}] })).toEqual(['tags[1].name:maxLength', 'tags[2].name:required']);
  // Without additionalProperties: false, other names are allowed.
  expect(keys({ type: 'object', properties: {} }, { anything: 1 })).toEqual([]);
});

test('arrays: minItems, maxItems and each item', () => {
  const s: JsonSchema = { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 2 };
  expect(keys(s, [1])).toEqual([]);
  expect(keys(s, [])).toEqual([':minItems']);
  expect(keys(s, [1, 2, 3])).toEqual([':maxItems']);
  expect(keys(s, [1, 0])).toEqual(['[1]:minimum']);
  expect(keys(s, [1, '2'])).toEqual(['[1]:type']);
});

test('anyOf: any form fits, else the nearest form’s problems', () => {
  const s: JsonSchema = {
    anyOf: [
      { type: 'object', properties: { place: { type: 'string' } }, required: ['place'], additionalProperties: false },
      { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' } }, required: ['lat', 'lon'], additionalProperties: false },
    ],
  };
  expect(fits(s, { place: 'everest' })).toBe(true);
  expect(fits(s, { lat: 1, lon: 2 })).toBe(true);
  expect(keys(s, { lat: 1 })).toEqual([':anyOf', 'lon:required']);
  expect(validateSchema(s, { lat: 1 })[0]?.values).toEqual({ forms: 2 });
  // Nested inside an object, the path is the argument's.
  const nested: JsonSchema = { type: 'object', properties: { at: s }, required: ['at'] };
  expect(keys(nested, { at: { place: 3 } })).toEqual(['at:anyOf', 'at.place:type']);
  expect(keys({ anyOf: [{ type: 'number' }, { type: 'string', enum: ['now'] }] }, 'now')).toEqual([]);
  expect(keys({ anyOf: [{ type: 'number' }, { type: 'string', enum: ['now'] }] }, true)).toEqual([':anyOf', ':type']);
});

test('the same value gives the same problems in the same order', () => {
  const s: JsonSchema = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false };
  const v = { z: 1, b: 2, y: 3 };
  expect(validateSchema(s, v)).toEqual(validateSchema(s, v));
  expect(keys(s, v)).toEqual(['a:required', 'b:type', 'z:additional', 'y:additional']);
});
