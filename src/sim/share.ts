import type { Scenario } from './engine';

/**
 * Scenarios carried in a link (ledger SB-37): the scenario's JSON (its start, settings and edit
 * log), deflated (raw DEFLATE, the browser's own CompressionStream) and written in base64url, so a
 * small experiment can be sent as an address. Opening the link imports it as a file is imported:
 * validated first (src/sim/engine validateScenario), refused with its reasons if anything is wrong.
 */

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const fromBase64Url = (text: string): Uint8Array => {
  const b64 = text.replace(/-/gu, '+').replace(/_/gu, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The scenario as a link's text. */
export async function encodeScenario(scenario: Scenario): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(scenario)), new CompressionStream('deflate-raw')));
}

/** A link's text back as parsed JSON (not yet validated), or null where it is not one. */
export async function decodeScenario(text: string): Promise<unknown> {
  try {
    const bytes = await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}
