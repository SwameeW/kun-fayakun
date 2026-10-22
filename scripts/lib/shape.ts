/**
 * Field checks on untrusted JSON. Data files are written by several people, so
 * required-field rules inspect `unknown` values instead of trusting the types.
 */

export type FieldRule = 'nonempty' | 'string' | 'string|null' | 'nonempty|null' | 'number' | 'boolean' | 'array' | 'object';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(value: unknown, rule: FieldRule): boolean {
  switch (rule) {
    case 'nonempty':
      return typeof value === 'string' && value.trim() !== '';
    case 'string':
      return typeof value === 'string';
    case 'string|null':
      return value === null || typeof value === 'string';
    case 'nonempty|null':
      return value === null || (typeof value === 'string' && value.trim() !== '');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
  }
}

const DESCRIBE: Record<FieldRule, string> = {
  nonempty: 'a non-empty string',
  string: 'a string',
  'string|null': 'a string or null',
  'nonempty|null': 'a non-empty string or null',
  number: 'a finite number',
  boolean: 'a boolean',
  array: 'an array',
  object: 'an object',
};

/**
 * Checks `fields` on `value` (dotted paths reach into nested objects).
 * Returns one message per problem, prefixed with `label`.
 */
export function checkFields(value: unknown, fields: Record<string, FieldRule>, label: string): string[] {
  if (!isRecord(value)) return [`${label}: expected an object`];
  const problems: string[] = [];
  for (const [path, rule] of Object.entries(fields)) {
    const found = getPath(value, path);
    if (!matches(found, rule)) problems.push(`${label}: "${path}" must be ${DESCRIBE[rule]}`);
  }
  return problems;
}

export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** Values that occur more than once. */
export function duplicates<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}
