/*
 * The model hosts, answered from disk for the real-model evaluation (./eval.spec.ts, ./grammar.spec.ts).
 *
 * Playwright's route.fulfill sends a body through the DevTools pipe as base64, and Chromium closes
 * that pipe for a message over 100 MiB: a file over about 75 MB (the first weight shard of every build
 * but Qwen3 0.6B, 156–509 MB) ended the browser at once. So the pinned URLs are not fulfilled through
 * the protocol. Instead Chromium resolves huggingface.co and cdn.jsdelivr.net to a local HTTPS server
 * (--host-resolver-rules) and accepts its self-signed certificate (--ignore-certificate-errors), and
 * the server streams each pinned file from the shared model store (scripts/ai-eval/store.ts). The
 * app's own path is unchanged: our worker fetches the pinned https URL, WebLLM stores it in the Cache
 * API. Any other request to a model host is answered 404 and recorded, which fails the run; every
 * other model host still resolves to nothing.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { ModelManifest } from '../../scripts/ai-eval/store';
import { modelsDir } from '../../scripts/ai-eval/store';

/** The hosts the pinned files come from (src/ai/engine/catalogue.ts). */
export const SERVED_HOSTS = ['huggingface.co', 'cdn.jsdelivr.net'] as const;
/** Every other model host, as the ai-eval project resolves it (playwright.config.ts). */
const NOWHERE = ['*.huggingface.co', 'hf.co', '*.hf.co', 'raw.githubusercontent.com'];

export interface ModelServer {
  port: number;
  /** Requests answered with a pinned file, and their bytes, so far. */
  served: { requests: number; bytes: number };
  /** Requests for anything else ("GET https://…"). */
  unexpected: string[];
  /** Chromium's arguments: the project's own, with model hosts resolved to this server and its certificate accepted. */
  args(projectArgs: readonly string[]): string[];
  close(): Promise<void>;
}

/** A self-signed certificate, made once with openssl and kept beside the model store. */
function certificate(): { key: string; cert: string } {
  const dir = `${modelsDir().replace(/\/models$/u, '')}/ai-eval/tls`;
  const key = `${dir}/key.pem`;
  const cert = `${dir}/cert.pem`;
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=kun-fayakun-ai-eval'], { encoding: 'utf8' });
  }
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

/** Starts the server for one model's pinned files. */
export function serveModel(manifest: ModelManifest): Promise<ModelServer> {
  const files = new Map(manifest.files.map((f) => [f.url, f]));
  const dir = `${modelsDir()}/${manifest.id}`;
  const served = { requests: 0, bytes: 0 };
  const unexpected: string[] = [];
  const server = createServer(certificate(), (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/u, '');
    const url = `https://${host}${req.url ?? '/'}`;
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, HEAD' });
      res.end();
      return;
    }
    const f = files.get(url);
    if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) {
      unexpected.push(`${req.method ?? '?'} ${url}`);
      res.writeHead(404, { ...cors, 'content-type': 'text/plain' });
      res.end('Not a pinned file.');
      return;
    }
    served.requests += 1;
    res.writeHead(200, {
      ...cors,
      'content-type': f.path.endsWith('.json') ? 'application/json' : f.path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
      'content-length': String(f.bytes),
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(`${dir}/${f.path}`);
    stream.on('end', () => {
      served.bytes += f.bytes;
    });
    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        served,
        unexpected,
        args(projectArgs) {
          const rules = [...SERVED_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`), ...NOWHERE.map((h) => `MAP ${h} ~NOTFOUND`)].join(', ');
          return [...projectArgs.filter((a) => !a.startsWith('--host-resolver-rules=')), `--host-resolver-rules=${rules}`, '--ignore-certificate-errors'];
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
