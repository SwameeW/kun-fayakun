/**
 * npm run preprocess:ai
 *
 * Builds the assistant's knowledge index, public/assets/ai/index.json, from the chapters'
 * content.json, the message files, data/*.json, the explorer's JPL tables, the field notes, the
 * populated places and the named stars (src/ai/knowledge/build.ts says what goes in and what never
 * does). Deterministic: no timestamps, passages sorted by id, so a rebuild gives the same bytes.
 * `npm run validate` (rule l) rebuilds it in memory and fails if the file differs.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { AI_INDEX_FILE, buildAiIndex, collectAiIndexInputs, serialiseAiIndex, type AiIndexFile } from '../src/ai/knowledge/build';
import { readText, relPath, rootPath } from './lib/files';

/** The index built from the files on disk now. */
export function buildAiIndexFromDisk(): AiIndexFile {
  const inputs = collectAiIndexInputs((path) => readText(rootPath(path)), readdirSync(rootPath('src', 'chapters')));
  return buildAiIndex(inputs);
}

function main(): void {
  const index = buildAiIndexFromDisk();
  const text = serialiseAiIndex(index);
  const path = rootPath(AI_INDEX_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  const counts = new Map<string, number>();
  for (const p of index.passages) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const bytes = Buffer.byteLength(text, 'utf8');
  const gzip = gzipSync(text, { level: 9 }).length;
  console.log(`${relPath(path)}: ${index.passages.length} passages (${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  console.log(`${(bytes / 1024).toFixed(1)} KB, ${(gzip / 1024).toFixed(1)} KB gzipped`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, '/'))) main();
