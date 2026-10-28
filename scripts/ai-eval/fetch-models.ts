/*
 * Downloads, once, exactly the files WebLLM 0.2.86 fetches for each pinned build in
 * src/ai/engine/catalogue.ts, so the evaluation (tests/ai-eval) can serve them to the page offline
 * (docs/AI-INTELLIGENCE.md §9). Local only, never CI; run it outside any sandbox (Hugging Face
 * redirects to its CDN hosts, the libraries come from cdn.jsdelivr.net).
 *
 *   node --import tsx scripts/ai-eval/fetch-models.ts            the default set (below)
 *   node --import tsx scripts/ai-eval/fetch-models.ts <id>...    those catalogue ids
 *   node --import tsx scripts/ai-eval/fetch-models.ts --check    verify what is on disk, no network
 *
 * What WebLLM fetches for a model record (MLCEngine.reloadInternal in @mlc-ai/web-llm 0.2.86): from
 * the weights URL, mlc-chat-config.json; tokenizer.json when the config's tokenizer_files has it (else
 * tokenizer.model); tensor-cache.json and every records[].dataPath it lists; and the model library
 * from model_lib. The same list is built here from the files themselves, never copied.
 *
 * Checks: the library against the catalogue's libIntegrity (SHA-384); the bytes of every file
 * against the size Hugging Face's tree API gives at the pinned commit (and tensor-cache.json's nbytes
 * for the shards); each LFS file's SHA-256 against the one Hugging Face lists; and the total against
 * the catalogue's downloadBytes. Downloads resume from a .part file. The result is written as
 * <models>/<id>/manifest.json only when every check passes (scripts/ai-eval/store.ts).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EVAL_CANDIDATES, VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import type { ModelSpec } from '../../src/ai/types';
import { useEnvProxy } from '../lib/net';
import { manifestPath, manifestVerified, modelDir, modelsDir, readManifest, type ModelManifest, type StoredFile } from './store';

const CATALOGUE: readonly ModelSpec[] = [...VISITOR_MODELS, ...EVAL_CANDIDATES];
/** The q4f16 builds of the visitor tiers and of the evaluation candidates (this Mac has shader-f16). */
const DEFAULT_IDS = CATALOGUE.filter((m) => m.quant === 'q4f16_1').map((m) => m.id);

const IDLE_MS = 60_000;
const RETRIES = 6;
const CONCURRENCY = 6;

interface TreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
}

/** The pinned commit's file list from Hugging Face's API (following its pages). */
async function listTree(model: ModelSpec): Promise<Map<string, TreeEntry>> {
  const match = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/$/u.exec(model.weightsUrl);
  if (!match) throw new Error(`${model.id}: weightsUrl is not a pinned Hugging Face URL: ${model.weightsUrl}`);
  const [, repo, sha] = match;
  const out = new Map<string, TreeEntry>();
  let url: string | null = `https://huggingface.co/api/models/${repo}/tree/${sha}?recursive=false`;
  while (url) {
    const res: Response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    for (const e of (await res.json()) as TreeEntry[]) if (e.type === 'file') out.set(e.path, e);
    const link = res.headers.get('link');
    const next = link ? /<([^>]+)>;\s*rel="next"/u.exec(link) : null;
    url = next?.[1] ?? null;
  }
  return out;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

async function hashFile(path: string, algorithm: 'sha256' | 'sha384'): Promise<Buffer> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest();
}

/** Downloads `url` to `path`, resuming a .part left by an earlier run; resolves when `bytes` are on disk. */
async function download(url: string, path: string, bytes: number, log: (line: string) => void): Promise<void> {
  if (sizeOf(path) === bytes) return;
  if (existsSync(path)) rmSync(path);
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  for (let attempt = 1; ; attempt += 1) {
    let have = sizeOf(part);
    if (have > bytes) {
      rmSync(part);
      have = 0;
    }
    if (have < bytes) {
      const controller = new AbortController();
      let timer = setTimeout(() => {
        controller.abort();
      }, IDLE_MS);
      const idle = new Transform({
        transform(chunk: Buffer, _enc, done) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            controller.abort();
          }, IDLE_MS);
          done(null, chunk);
        },
      });
      try {
        const res = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: controller.signal, redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const append = have > 0 && res.status === 206;
        if (have > 0 && !append) have = 0;
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), idle, createWriteStream(part, { flags: append ? 'a' : 'w' }));
      } catch (err) {
        const got = sizeOf(part);
        if (attempt >= RETRIES) throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)} after ${attempt} attempts (${got} of ${bytes} bytes)`, { cause: err });
        log(`  retry ${attempt} for ${url.split('/').pop() ?? url} at ${got} bytes: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (sizeOf(part) === bytes) {
      renameSync(part, path);
      return;
    }
    if (attempt >= RETRIES) throw new Error(`${url}: ${sizeOf(part)} bytes on disk, ${bytes} expected`);
  }
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function libName(model: ModelSpec): string {
  return `lib/${model.libUrl.split('/').pop() ?? 'model.wasm'}`;
}

/** The files WebLLM fetches for this build, read from its own config and tensor cache. */
async function plan(model: ModelSpec, tree: Map<string, TreeEntry>): Promise<{ name: string; bytes: number; sha256?: string }[]> {
  const config = JSON.parse(await getText(`${model.weightsUrl}mlc-chat-config.json`)) as { tokenizer_files?: string[] };
  const tokenizerFiles = config.tokenizer_files ?? [];
  const tokenizer = tokenizerFiles.includes('tokenizer.json') ? 'tokenizer.json' : tokenizerFiles.includes('tokenizer.model') ? 'tokenizer.model' : null;
  if (!tokenizer) throw new Error(`${model.id}: mlc-chat-config.json names no tokenizer.json or tokenizer.model`);
  const cache = JSON.parse(await getText(`${model.weightsUrl}tensor-cache.json`)) as { records: { dataPath: string; nbytes: number }[] };
  const names: { name: string; nbytes?: number }[] = [{ name: 'mlc-chat-config.json' }, { name: tokenizer }, { name: 'tensor-cache.json' }, ...cache.records.map((r) => ({ name: r.dataPath, nbytes: r.nbytes }))];
  return names.map(({ name, nbytes }) => {
    const entry = tree.get(name);
    if (!entry) throw new Error(`${model.id}: ${name} is not in the pinned commit's tree`);
    if (nbytes !== undefined && nbytes !== entry.size) throw new Error(`${model.id}: ${name} is ${entry.size} bytes in the tree, ${nbytes} in tensor-cache.json`);
    return { name, bytes: entry.size, ...(entry.lfs ? { sha256: entry.lfs.oid } : {}) };
  });
}

async function fetchModel(model: ModelSpec, log: (line: string) => void): Promise<ModelManifest> {
  const dir = modelDir(model.id);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const tree = await listTree(model);
  const weights = await plan(model, tree);
  const weightTotal = weights.reduce((s, f) => s + f.bytes, 0);
  log(`${model.id}: ${weights.length} weight files, ${weightTotal} bytes; library ${model.libUrl}`);
  let done = 0;
  let lastLog = 0;
  await pool(weights, CONCURRENCY, async (f) => {
    await download(`${model.weightsUrl}${f.name}`, `${dir}/weights/${f.name}`, f.bytes, log);
    done += f.bytes;
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`  ${model.id}: ${(done / 1e6).toFixed(0)} of ${(weightTotal / 1e6).toFixed(0)} MB`);
    }
  });
  // The library: its size is whatever jsDelivr serves; the SHA-384 decides.
  const libPath = `${dir}/${libName(model)}`;
  if (!existsSync(libPath)) {
    const res = await fetch(model.libUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`GET ${model.libUrl}: HTTP ${res.status}`);
    mkdirSync(dirname(libPath), { recursive: true });
    writeFileSync(`${libPath}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${libPath}.part`, libPath);
  }
  const manifest = await verify(model, weights);
  log(`${model.id}: fetched and checked in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return manifest;
}

/** Checks the files on disk and returns the manifest (written only when every check passed). */
async function verify(model: ModelSpec, weights: readonly { name: string; bytes: number; sha256?: string }[]): Promise<ModelManifest> {
  const dir = modelDir(model.id);
  const files: StoredFile[] = [];
  let sizesMatched = 0;
  let listed = 0;
  let matched = 0;
  await pool(weights, 4, async (f) => {
    const path = `${dir}/weights/${f.name}`;
    const size = sizeOf(path);
    if (size === f.bytes) sizesMatched += 1;
    if (f.sha256) {
      listed += 1;
      if (size === f.bytes && (await hashFile(path, 'sha256')).toString('hex') === f.sha256) matched += 1;
    }
    files.push({ url: `${model.weightsUrl}${f.name}`, path: `weights/${f.name}`, bytes: size, ...(f.sha256 ? { sha256: f.sha256 } : {}) });
  });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  const libPath = `${dir}/${libName(model)}`;
  const libBytes = sizeOf(libPath);
  const integrity = model.libIntegrity ?? null;
  let lib: ModelManifest['verification']['lib'] = 'no-integrity';
  if (integrity) {
    const [algo, b64] = integrity.split('-', 2);
    lib = algo === 'sha384' && libBytes > 0 && (await hashFile(libPath, 'sha384')).toString('base64') === b64 ? 'match' : 'mismatch';
  }
  files.push({ url: model.libUrl, path: libName(model), bytes: libBytes });
  const weightBytes = files.filter((f) => f.path.startsWith('weights/')).reduce((s, f) => s + f.bytes, 0);
  const manifest: ModelManifest = {
    id: model.id,
    weightsUrl: model.weightsUrl,
    libUrl: model.libUrl,
    libIntegrity: integrity,
    downloadBytes: model.downloadBytes,
    weightBytes,
    libBytes,
    files,
    verification: {
      lib,
      bytes: weightBytes + libBytes === model.downloadBytes ? 'match' : 'mismatch',
      sha256: { listed, matched },
      sizes: { checked: weights.length, matched: sizesMatched },
    },
    fetchedAt: new Date().toISOString(),
  };
  if (manifestVerified(manifest)) writeFileSync(manifestPath(model.id), `${JSON.stringify(manifest, null, 2)}\n`);
  else writeFileSync(`${dir}/manifest.failed.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** --check: re-verifies a stored model from its manifest, without the network. */
async function check(model: ModelSpec): Promise<ModelManifest | null> {
  const m = readManifest(model.id);
  if (!m) return null;
  if (m.weightsUrl !== model.weightsUrl || m.libUrl !== model.libUrl) throw new Error(`${model.id}: the manifest was written for other pins (${m.weightsUrl}); fetch it again`);
  const weights = m.files.filter((f) => f.path.startsWith('weights/')).map((f) => ({ name: f.path.slice('weights/'.length), bytes: f.bytes, ...(f.sha256 ? { sha256: f.sha256 } : {}) }));
  return verify(model, weights);
}

function row(m: ModelManifest): string {
  const v = m.verification;
  return `| ${m.id} | ${m.weightBytes} | ${m.libBytes} | ${m.weightBytes + m.libBytes} | ${m.downloadBytes} | ${v.bytes} | ${v.lib} | ${v.sha256.matched}/${v.sha256.listed} | ${v.sizes.matched}/${v.sizes.checked} |`;
}

async function main(): Promise<void> {
  useEnvProxy();
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const ids = args.filter((a) => !a.startsWith('--'));
  const chosen = ids.length > 0 ? ids : DEFAULT_IDS;
  const models = chosen.map((id) => {
    const m = CATALOGUE.find((x) => x.id === id);
    if (!m) throw new Error(`${id} is not in src/ai/engine/catalogue.ts (${CATALOGUE.map((x) => x.id).join(', ')})`);
    return m;
  });
  const log = (line: string): void => {
    process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  };
  log(`models directory: ${modelsDir()}`);
  const results: ModelManifest[] = [];
  let failed = false;
  for (const model of models) {
    try {
      const existing = readManifest(model.id);
      const m = checkOnly ? await check(model) : existing && existing.weightsUrl === model.weightsUrl && existing.libUrl === model.libUrl && manifestVerified(existing) ? existing : await fetchModel(model, log);
      if (!m) {
        log(`${model.id}: not on disk`);
        failed = true;
        continue;
      }
      if (!manifestVerified(m)) failed = true;
      results.push(m);
    } catch (err) {
      failed = true;
      log(`${model.id}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write('\n| Model | Weight bytes | Library bytes | Total on disk | Catalogue downloadBytes | Total | Library SHA-384 | LFS SHA-256 | Sizes |\n|---|---|---|---|---|---|---|---|---|\n');
  for (const m of results) process.stdout.write(`${row(m)}\n`);
  if (failed) process.exitCode = 1;
}

await main();
