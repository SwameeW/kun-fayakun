/*
 * Where the evaluation keeps the models' files on this Mac (docs/AI-INTELLIGENCE.md §9), shared by
 * scripts/ai-eval/fetch-models.ts (which downloads them once), tests/ai-eval/eval.spec.ts (which
 * serves them to the page in place of Hugging Face and jsDelivr) and scripts/ai-eval/report.ts.
 *
 * The files live in the MAIN checkout's .work/ (gitignored), found through git's common directory,
 * so that every worktree uses the same copy and the copy outlives any worktree. KF_MODELS_DIR
 * overrides it. Nothing here touches the network.
 *
 * Kept to the few Node APIs the browser-typed tsconfig declares (tests/support/node-fs.d.ts), since
 * the spec imports it too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** One file of a model as WebLLM fetches it: its pinned URL and where its copy is on disk. */
export interface StoredFile {
  /** The exact URL WebLLM requests (weightsUrl + name, or the library's libUrl). */
  url: string;
  /** Path relative to the model's directory. */
  path: string;
  bytes: number;
  /** SHA-256 Hugging Face lists for the file at the pinned commit (LFS files), when it lists one. */
  sha256?: string;
}

/** What fetch-models.ts wrote for one model, once every check passed (raw data of that run). */
export interface ModelManifest {
  id: string;
  weightsUrl: string;
  libUrl: string;
  libIntegrity: string | null;
  /** The catalogue's downloadBytes, read when the files were fetched. */
  downloadBytes: number;
  /** The files' bytes on disk: weights (config, tokenizer, tensor cache, shards) and library. */
  weightBytes: number;
  libBytes: number;
  files: StoredFile[];
  verification: {
    /** The library's SHA-384 against the catalogue's libIntegrity. */
    lib: 'match' | 'mismatch' | 'no-integrity';
    /** weightBytes + libBytes against downloadBytes. */
    bytes: 'match' | 'mismatch';
    /** Files whose SHA-256 Hugging Face lists, and how many of them matched. */
    sha256: { listed: number; matched: number };
    /** Every file's size against the size Hugging Face (or tensor-cache.json) gives. */
    sizes: { checked: number; matched: number };
  };
  fetchedAt: string;
}

let cached: string | null = null;

/** The directory that holds one directory per model id. */
export function modelsDir(): string {
  const override = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.KF_MODELS_DIR;
  if (override) return override.replace(/\/+$/u, '');
  if (cached) return cached;
  // The main checkout is the parent of git's common directory, from any worktree.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const main = common.replace(/\/\.git\/?$/u, '');
  cached = `${main}/.work/models`;
  return cached;
}

export function modelDir(id: string): string {
  return `${modelsDir()}/${id}`;
}

export function manifestPath(id: string): string {
  return `${modelDir(id)}/manifest.json`;
}

/** The manifest of a model fetched and verified, or null when it is not on disk. */
export function readManifest(id: string): ModelManifest | null {
  const path = manifestPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as ModelManifest;
}

/** Whether a manifest records every check passing. */
export function manifestVerified(m: ModelManifest): boolean {
  const v = m.verification;
  return v.lib === 'match' && v.bytes === 'match' && v.sha256.matched === v.sha256.listed && v.sizes.matched === v.sizes.checked;
}
