/** Loading and inspecting the ICU message files under src/i18n/. */
import { IntlMessageFormat } from 'intl-messageformat';
import { fileExists, readText, relPath, rootPath } from './files';
import { isRecord } from './shape';

export interface MessageFile {
  path: string;
  /** Flat dotted key -> ICU message. Nested objects are flattened with dots. */
  messages: Map<string, string>;
  /** Non-string leaves, keys repeated inside the file, JSON errors. */
  problems: string[];
}

export type MessageLoad = { status: 'ok'; file: MessageFile } | { status: 'missing'; path: string };

function flatten(value: Record<string, unknown>, prefix: string, out: Map<string, string>, problems: string[]): void {
  for (const [key, leaf] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof leaf === 'string') out.set(full, leaf);
    else if (isRecord(leaf)) flatten(leaf, full, out, problems);
    else problems.push(`${full}: value must be a string`);
  }
}

/**
 * JSON.parse keeps the last of two equal keys silently. For flat files every
 * property name is a top-level key, so a repeated name in the raw text is a duplicate.
 */
function repeatedRawKeys(raw: string): string[] {
  const counts = new Map<string, number>();
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    const key = match[1] ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([key]) => key);
}

export function loadMessages(...parts: string[]): MessageLoad {
  const abs = rootPath(...parts);
  const path = relPath(abs);
  if (!fileExists(abs)) return { status: 'missing', path };
  const file: MessageFile = { path, messages: new Map(), problems: [] };
  const raw = readText(abs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    file.problems.push(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'ok', file };
  }
  if (!isRecord(parsed)) {
    file.problems.push('top level must be an object of messages');
    return { status: 'ok', file };
  }
  flatten(parsed, '', file.messages, file.problems);
  const isFlat = Object.values(parsed).every((v) => typeof v === 'string');
  if (isFlat) for (const key of repeatedRawKeys(raw)) file.problems.push(`${key}: key appears more than once`);
  return { status: 'ok', file };
}

/** Parses an ICU message; returns the error text, or null when it parses. */
export function messageParseError(message: string): string | null {
  try {
    new IntlMessageFormat(message, 'en');
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Names of the arguments an ICU message expects (walks plural/select branches). */
export function messageArguments(message: string): Set<string> {
  const names = new Set<string>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as unknown[]) {
      if (!isRecord(node)) continue;
      // Literal (0) and pound (7) carry no argument; tags (8) nest children.
      if (typeof node.value === 'string' && node.type !== 0 && node.type !== 7 && node.type !== 8) names.add(node.value);
      walk(node.children);
      if (isRecord(node.options)) for (const option of Object.values(node.options)) if (isRecord(option)) walk(option.value);
    }
  };
  walk(new IntlMessageFormat(message, 'en').getAst());
  return names;
}
