/// <reference lib="webworker" />
/**
 * Fetches and decodes the deep catalogue's packs (./catalogue) off the main thread: one request a
 * pack, its arrays sent back without copying.
 */
import { decodePack, transferables, type PackReply, type PackRequest } from './catalogue';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<PackRequest>) => {
  const ask = event.data;
  void fetch(ask.url)
    .then((res) => {
      if (!res.ok) throw new Error(`${ask.url}: ${String(res.status)}`);
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const pack = decodePack(ask.kind, buffer, ask.count, ask.obliquity, ask.lut, new Set(ask.exclude));
      const reply: PackReply = { id: ask.id, ok: true, pack };
      scope.postMessage(reply, transferables(pack));
    })
    .catch((error: unknown) => {
      const reply: PackReply = { id: ask.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      scope.postMessage(reply);
    });
};
