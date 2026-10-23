/**
 * The planets' raw files (r8 and rgba8 KTX2, zstd-supercompressed: the Earth's night lights, clouds
 * and water, Saturn's ring strip), fetched with the engine's loader and inflated in a worker
 * (./raw-ktx2.worker), then built into the same DataTexture three's KTX2Loader makes of them (format,
 * type, colour space from the file's descriptor, its mip levels as stored). KTX2Loader inflates these
 * on the main thread: the 4096 cloud map alone held it for over 30 ms, a dropped frame. Here the main
 * thread only receives the levels (transferred, not copied).
 */

import { DataTexture, LinearSRGBColorSpace, NoColorSpace, RedFormat, RGBAFormat, SRGBColorSpace, UnsignedByteType, type Texture } from 'three/webgpu';
import type { AssetLoader } from '../../core/types';

/** The Vulkan formats these files hold, and the descriptor's BT.709 primaries and sRGB transfer codes (KHR DFD). */
const VK = { r8: 9, rgba8: 37, rgba8Srgb: 43 } as const;
const PRIMARIES_BT709 = 1;
const TRANSFER_SRGB = 2;

interface Level {
  data: Uint8Array;
  width: number;
  height: number;
}

interface Decoded {
  id: number;
  vkFormat: number;
  width: number;
  height: number;
  primaries: number;
  transfer: number;
  levels: Level[];
}

type Reply = Decoded | { id: number; error: string };

export interface RawDecoder {
  /** The texture of a raw KTX2 file at `path` (as AssetLoader.ktx2 would give it). */
  load(assets: AssetLoader, path: string): Promise<Texture>;
  dispose(): void;
}

export function createRawDecoder(): RawDecoder {
  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<number, { resolve: (decoded: Decoded) => void; reject: (error: Error) => void }>();

  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL('./raw-ktx2.worker.ts', import.meta.url), { type: 'module', name: 'explore-raw-ktx2' });
    w.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      if ('error' in reply) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply);
    };
    w.onerror = (event) => {
      for (const waiting of pending.values()) waiting.reject(new Error(event.message || 'raw KTX2 worker failed'));
      pending.clear();
    };
    worker = w;
    return w;
  };

  return {
    async load(assets, path) {
      const buffer = await assets.binary(path);
      const id = next;
      next += 1;
      const decoded = await new Promise<Decoded>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        start().postMessage({ id, buffer }, [buffer]);
      });
      const [first] = decoded.levels;
      if (!first) throw new Error(`${path}: no levels`);
      const format = decoded.vkFormat === VK.r8 ? RedFormat : decoded.vkFormat === VK.rgba8 || decoded.vkFormat === VK.rgba8Srgb ? RGBAFormat : null;
      if (format === null) throw new Error(`${path}: unsupported vkFormat ${decoded.vkFormat}`);
      const texture = new DataTexture(first.data, decoded.width, decoded.height, format, UnsignedByteType);
      texture.mipmaps = decoded.levels;
      texture.colorSpace = decoded.primaries === PRIMARIES_BT709 ? (decoded.transfer === TRANSFER_SRGB ? SRGBColorSpace : LinearSRGBColorSpace) : NoColorSpace;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const waiting of pending.values()) waiting.reject(new Error('raw KTX2 decoder disposed'));
      pending.clear();
    },
  };
}
