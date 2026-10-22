/** Minimal HTTP helpers for the data scripts (Node's built-in fetch). */
import * as http from 'node:http';

let proxyConfigured = false;

/**
 * Node's fetch ignores HTTP(S)_PROXY unless told otherwise. Behind a proxy
 * (CI runners, sandboxes) route requests through it; without one, do nothing.
 */
export function useEnvProxy(): void {
  if (proxyConfigured) return;
  proxyConfigured = true;
  const env = process.env;
  const hasProxy = Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy);
  // setGlobalProxyFromEnv is missing on older Node 22 releases; treat it as optional.
  const setProxy = (http as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv;
  if (hasProxy && setProxy) setProxy();
}

const TIMEOUT_MS = 60_000;

export async function fetchBytes(url: string, init: RequestInit = {}): Promise<Uint8Array> {
  useEnvProxy();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseJsonOrNull(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** Status and parsed JSON body (null when the body is empty or not JSON). */
export async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  useEnvProxy();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: parseJsonOrNull(await res.text()) };
}
