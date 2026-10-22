import { TextureLoader, type WebGPURenderer } from 'three/webgpu';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { AssetLoader } from './types';

export interface EngineAssetLoader extends AssetLoader {
  /** KTX2 needs the initialised renderer to pick a transcode target. */
  attachRenderer(renderer: WebGPURenderer): void;
  /** A view of this loader that reports how many of its requests have finished. */
  tracked(onProgress: (done: number, started: number) => void): AssetLoader;
  dispose(): void;
}

const ABSOLUTE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** Resolves a public/ path against document.baseURI (Vite base './'), so builds work from any path. */
export function resolveAssetUrl(path: string): string {
  if (ABSOLUTE_URL.test(path)) return path;
  return new URL(path.replace(/^\/+/, ''), document.baseURI).href;
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request for ${url} failed: ${res.status} ${res.statusText}`);
  return res;
}

/**
 * Notes for chapters:
 * - texture(): PNG/WebP through TextureLoader with flipY = true (three's default), colour
 *   space left as NoColorSpace so MSDF atlases stay linear; set SRGBColorSpace for photos.
 * - ktx2(): KTX2 textures are compressed, and compressed textures are never flipped on
 *   upload (flipY = false on both backends). UV v = 0 therefore samples the FIRST row
 *   stored in the file. A KTX2 written top row first (the usual "rd" orientation) shows
 *   its top edge at v = 0, i.e. upside down compared with texture(); either encode it
 *   with a y-flip or sample with 1 - v.
 */
export function createAssetLoader(): EngineAssetLoader {
  let resolveRenderer: (r: WebGPURenderer) => void = () => undefined;
  const rendererReady = new Promise<WebGPURenderer>((resolve) => {
    resolveRenderer = resolve;
  });
  let ktx2Loader: Promise<KTX2Loader> | null = null;
  const textureLoader = new TextureLoader();

  const getKtx2Loader = (): Promise<KTX2Loader> => {
    ktx2Loader ??= (async () => {
      // Loaded on first use so the initial bundle stays lean.
      const [{ KTX2Loader: Loader }, renderer] = await Promise.all([
        import('three/addons/loaders/KTX2Loader.js'),
        rendererReady,
      ]);
      const loader = new Loader();
      loader.setTranscoderPath(resolveAssetUrl('assets/basis/'));
      loader.detectSupport(renderer);
      return loader;
    })();
    return ktx2Loader;
  };

  const base: AssetLoader = {
    url: resolveAssetUrl,
    async ktx2(url) {
      const loader = await getKtx2Loader();
      return loader.loadAsync(resolveAssetUrl(url));
    },
    texture(url) {
      return textureLoader.loadAsync(resolveAssetUrl(url));
    },
    async json<T>(url: string) {
      const res = await fetchOk(resolveAssetUrl(url));
      return (await res.json()) as T;
    },
    async binary(url) {
      const res = await fetchOk(resolveAssetUrl(url));
      return res.arrayBuffer();
    },
  };

  return {
    ...base,
    attachRenderer(renderer) {
      resolveRenderer(renderer);
    },
    tracked(onProgress) {
      let started = 0;
      let done = 0;
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        started += 1;
        onProgress(done, started);
        return work().finally(() => {
          done += 1;
          onProgress(done, started);
        });
      };
      return {
        url: resolveAssetUrl,
        ktx2: (url) => track(() => base.ktx2(url)),
        texture: (url) => track(() => base.texture(url)),
        json: <T>(url: string) => track(() => base.json<T>(url)),
        binary: (url) => track(() => base.binary(url)),
      };
    },
    dispose() {
      void ktx2Loader?.then((loader) => {
        loader.dispose();
      });
      ktx2Loader = null;
    },
  };
}
