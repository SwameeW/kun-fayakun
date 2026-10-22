/** Repository paths and file loading shared by the data scripts. */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (scripts/lib/ is two levels below it). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function rootPath(...parts: string[]): string {
  return join(ROOT, ...parts);
}

/** Path relative to the repository root, for messages. */
export function relPath(absolute: string): string {
  return relative(ROOT, absolute);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** Parses a JSON file. Callers assert or check the shape themselves. */
export function readJson(path: string): unknown {
  return JSON.parse(readText(path)) as unknown;
}

/** Writes pretty-printed JSON with a trailing newline (stable diffs). */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Result of loading a data file that another builder may not have written yet. */
export type Loaded<T> =
  | { status: 'ok'; path: string; value: T }
  | { status: 'missing'; path: string }
  | { status: 'invalid'; path: string; error: string };

export function loadJson<T>(path: string): Loaded<T> {
  if (!existsSync(path)) return { status: 'missing', path };
  try {
    return { status: 'ok', path, value: readJson(path) as T };
  } catch (err) {
    return { status: 'invalid', path, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every file below `dir` (recursive), sorted for deterministic output. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ktx2', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.glb']);

/** Every file below `dir` that is not a known binary format, sorted. */
export function listTextFiles(dir: string): string[] {
  return listFiles(dir).filter((f) => !BINARY_EXTENSIONS.has(extname(f).toLowerCase()));
}

/** Immediate subdirectories of `dir`, sorted. */
export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isDirectory());
}
