import type { JsonSchema, ToolProblem } from '../types';

/**
 * The JSON Schema subset the assistant's tools are described in (src/ai/types.ts JsonSchema), checked
 * in plain code: the same schema constrains a model's reply while it is generated and is checked
 * again here afterwards, because constrained decoding has open bugs.
 *
 * - object: a plain object (not null, not a list); `required` names must be present; with
 *   `additionalProperties: false` any other name is a problem; each present property is checked.
 * - array: a list, at least `minItems` and at most `maxItems` long; each item is checked.
 * - string: text; one of `enum`, equal to `const`, at most `maxLength` characters (code points), and
 *   matching `pattern` (a regular expression searched in the text, as JSON Schema does: anchor it to
 *   match the whole).
 * - number and integer: a finite number (an integer for 'integer'), at least `minimum`, at most
 *   `maximum` (both inclusive).
 * - boolean: true or false.
 * - anyOf: at least one of the forms; when none fits, the problem is reported with the problems of
 *   the form that came nearest (fewest problems; the first of equals).
 *
 * Nothing is coerced: "3" is not the number 3, 1 is not true, null is not a missing value. Paths name
 * the argument at fault: "body", "position.lat", "kinds[2]"; '' is the value as a whole.
 */

type Problems = ToolProblem[];

const KEY = 'ai.tool.problem';

/** At most this many allowed values are named in a problem; the rest are counted. */
const ALLOWED_SHOWN = 20;

const join = (path: string, name: string): string => (path === '' ? name : `${path}.${name}`);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** What a value is, in the schema's words, for a type problem. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'non-finite';
  return typeof value;
}

/** A string's length in code points (a character outside the Basic Multilingual Plane counts once). */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // A high surrogate followed by a low one is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

function typeProblem(path: string, expected: string, value: unknown): ToolProblem {
  return { path, messageKey: `${KEY}.type`, values: { expected, got: kindOf(value) } };
}

function allowedValues(list: readonly string[]): { allowed: string; more: number } {
  return { allowed: list.slice(0, ALLOWED_SHOWN).join(', '), more: Math.max(0, list.length - ALLOWED_SHOWN) };
}

/** A compiled pattern per source (patterns are fixed in the tools' schemas). */
const patterns = new Map<string, RegExp | null>();
function patternOf(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let re: RegExp | null;
    try {
      re = new RegExp(source, 'u');
    } catch {
      re = null;
    }
    patterns.set(source, re);
  }
  return patterns.get(source) ?? null;
}

function checkString(schema: Extract<JsonSchema, { type: 'string' }>, value: unknown, path: string, out: Problems): void {
  if (typeof value !== 'string') {
    out.push(typeProblem(path, 'string', value));
    return;
  }
  if (schema.const !== undefined && value !== schema.const) out.push({ path, messageKey: `${KEY}.const`, values: { allowed: schema.const } });
  if (schema.enum !== undefined && !schema.enum.includes(value)) out.push({ path, messageKey: `${KEY}.enum`, values: allowedValues(schema.enum) });
  if (schema.maxLength !== undefined && codePoints(value) > schema.maxLength) out.push({ path, messageKey: `${KEY}.maxLength`, values: { limit: schema.maxLength } });
  if (schema.pattern !== undefined) {
    const re = patternOf(schema.pattern);
    // A pattern that does not compile matches nothing: the schema is at fault, and nothing passes it unchecked.
    if (!re?.test(value)) out.push({ path, messageKey: `${KEY}.pattern`, values: {} });
  }
}

function checkNumber(schema: Extract<JsonSchema, { type: 'number' | 'integer' }>, value: unknown, path: string, out: Problems): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    out.push(typeProblem(path, schema.type, value));
    return;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) {
    out.push(typeProblem(path, 'integer', value));
    return;
  }
  if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, messageKey: `${KEY}.minimum`, values: { limit: schema.minimum } });
  if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, messageKey: `${KEY}.maximum`, values: { limit: schema.maximum } });
}

function checkObject(schema: Extract<JsonSchema, { type: 'object' }>, value: unknown, path: string, out: Problems): void {
  if (!isPlainObject(value)) {
    out.push(typeProblem(path, 'object', value));
    return;
  }
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name) || value[name] === undefined) out.push({ path: join(path, name), messageKey: `${KEY}.required`, values: {} });
  }
  // Names in a fixed order (the schema's, then the value's own), so problems come out the same each time.
  for (const [name, sub] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, name) && value[name] !== undefined) check(sub, value[name], join(path, name), out);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, name)) out.push({ path: join(path, name), messageKey: `${KEY}.additional`, values: {} });
    }
  }
}

function checkArray(schema: Extract<JsonSchema, { type: 'array' }>, value: unknown, path: string, out: Problems): void {
  if (!Array.isArray(value)) {
    out.push(typeProblem(path, 'array', value));
    return;
  }
  const list: readonly unknown[] = value;
  if (schema.minItems !== undefined && list.length < schema.minItems) out.push({ path, messageKey: `${KEY}.minItems`, values: { limit: schema.minItems } });
  if (schema.maxItems !== undefined && list.length > schema.maxItems) out.push({ path, messageKey: `${KEY}.maxItems`, values: { limit: schema.maxItems } });
  list.forEach((item, i) => {
    check(schema.items, item, `${path}[${i}]`, out);
  });
}

function check(schema: JsonSchema, value: unknown, path: string, out: Problems): void {
  if ('anyOf' in schema) {
    let best: Problems | null = null;
    for (const option of schema.anyOf) {
      const found: Problems = [];
      check(option, value, path, found);
      if (found.length === 0) return;
      if (best === null || found.length < best.length) best = found;
    }
    out.push({ path, messageKey: `${KEY}.anyOf`, values: { forms: schema.anyOf.length } }, ...(best ?? []));
    return;
  }
  switch (schema.type) {
    case 'object':
      checkObject(schema, value, path, out);
      return;
    case 'array':
      checkArray(schema, value, path, out);
      return;
    case 'string':
      checkString(schema, value, path, out);
      return;
    case 'number':
    case 'integer':
      checkNumber(schema, value, path, out);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(typeProblem(path, 'boolean', value));
      return;
  }
}

/** Every way `value` breaks `schema`, with the path to each; empty when it fits. */
export function validateSchema(schema: JsonSchema, value: unknown, path = ''): ToolProblem[] {
  const out: Problems = [];
  check(schema, value, path, out);
  return out;
}

/** True when `value` fits `schema`. */
export const fits = (schema: JsonSchema, value: unknown): boolean => validateSchema(schema, value).length === 0;
