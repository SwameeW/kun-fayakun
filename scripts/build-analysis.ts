/**
 * npm run preprocess:analysis
 *
 * Builds the letter analyses named under "analysis" in data/citations.json (docs/SPEC.md,
 * Chapter 7, "Each in an orbit") from the verified Tanzil text in data/quran.json, and writes
 * public/assets/analysis/<id>.json. It asserts that every cited verse yields the same base
 * letters and that they read the same in both directions; any mismatch stops the build.
 * `npm run validate` re-derives each asset and fails if the file differs.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveAnalysis, type AnalysisSpec } from './lib/analysis';
import { readJson, relPath, rootPath, writeJson } from './lib/files';
import { sha256Hex } from './lib/text';

interface Citations {
  analysis?: Record<string, AnalysisSpec | string>;
}
interface Quran {
  ayat: Array<{ key: string; arabic: string }>;
}

const citations = readJson(rootPath('data', 'citations.json')) as Citations;
const quran = readJson(rootPath('data', 'quran.json')) as Quran;
const arabicOf = (key: string): string | undefined => quran.ayat.find((a) => a.key === key)?.arabic;

for (const [id, spec] of Object.entries(citations.analysis ?? {})) {
  if (typeof spec === 'string') continue; // $comment
  const asset = deriveAnalysis(id, spec, arabicOf, sha256Hex);
  const dir = rootPath('public', 'assets', 'analysis');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeJson(path, asset);
  console.log(`${relPath(path)}: ${asset.letters.join(' ')} (${asset.names.join(', ')}); reads the same in both directions`);
}
