import { ACESFilmicToneMapping, SRGBColorSpace, WebGPURenderer } from 'three/webgpu';
import { MIN_RESOLUTION_SCALE } from './resolution';

export type BackendName = 'webgpu' | 'webgl2';

/** What the browser tells us about the GPU, used to pick the initial quality tier. */
export interface GpuInfo {
  /** Lower-case vendor/renderer description; '' when the browser hides it. */
  description: string;
  /** A software rasteriser (SwiftShader, llvmpipe, WARP) or WebGPU fallback adapter. */
  software: boolean;
}

export interface RendererHandle {
  readonly renderer: WebGPURenderer;
  readonly backend: BackendName;
  readonly gpu: GpuInfo;
  readonly width: number;
  readonly height: number;
  /** Applies a quality profile's device-pixel-ratio cap. */
  setDprCap(cap: number): void;
  /** Dynamic resolution: multiplies the capped device pixel ratio (0.6..1). */
  setResolutionScale(scale: number): void;
  readonly pixelRatio: number;
  onResize(fn: (width: number, height: number) => void): () => void;
  dispose(): void;
}

/** Plain UI text for when neither backend can start. */
export const RENDERER_UNAVAILABLE_MESSAGE =
  'This experience needs a browser with WebGPU or WebGL2 enabled. Try a current version of Chrome, Edge, Safari or Firefox.';

/** Thrown when neither WebGPU nor WebGL2 can be initialised. */
export class RendererUnavailableError extends Error {
  constructor(cause: unknown) {
    super(RENDERER_UNAVAILABLE_MESSAGE, { cause });
    this.name = 'RendererUnavailableError';
  }
}

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|warp/;

function describeGpu(renderer: WebGPURenderer, backend: BackendName): GpuInfo {
  let description = '';
  let software = false;
  if (backend === 'webgpu') {
    const device = (renderer.backend as { device?: GPUDevice | null }).device;
    // GPUDevice.adapterInfo is recent (Chrome 128+, Safari 26); older browsers leave it undefined.
    const info = (device as { adapterInfo?: GPUAdapterInfo } | null | undefined)?.adapterInfo;
    if (info) {
      description = [info.vendor, info.architecture, info.device, info.description].join(' ').toLowerCase();
      software = (info as { isFallbackAdapter?: boolean }).isFallbackAdapter === true;
    }
  } else {
    const gl = (renderer.backend as { gl?: WebGL2RenderingContext | null }).gl;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const raw: unknown = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      description = typeof raw === 'string' ? raw.toLowerCase() : '';
    }
  }
  return { description, software: software || SOFTWARE_GPU.test(description) };
}

/**
 * The canvas fills the viewport behind the UI; set here so the engine never depends on UI styles.
 * The UI may set --kf-scene-inset-end (e.g. beside an opaque side panel) to keep scenes centred
 * over the visible stage; the ResizeObserver then resizes the renderer.
 */
function styleCanvas(canvas: HTMLCanvasElement): void {
  const s = canvas.style;
  s.position = 'fixed';
  s.inset = '0';
  s.insetInlineEnd = 'var(--kf-scene-inset-end, 0px)';
  s.width = 'calc(100% - var(--kf-scene-inset-end, 0px))';
  s.height = '100%';
  s.display = 'block';
  s.background = '#000';
}

/**
 * True when the only WebGPU adapter on offer is a software fallback (SwiftShader and the like,
 * as on GPU-less CI machines). Those are slower than WebGL2's software path and have been seen
 * to lose their device mid-scene ("Instance dropped in popErrorScope"), so WebGL2 is used instead.
 */
async function onlySoftwareWebGPU(): Promise<boolean> {
  const gpu = (navigator as { gpu?: GPU }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    // No adapter: three.js falls back to WebGL2 on its own.
    if (!adapter) return false;
    const info = (adapter as { info?: GPUAdapterInfo & { isFallbackAdapter?: boolean } }).info;
    const legacyFlag = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
    const description = info ? [info.vendor, info.architecture, info.device, info.description].join(' ').toLowerCase() : '';
    return info?.isFallbackAdapter === true || legacyFlag === true || SOFTWARE_GPU.test(description);
  } catch {
    return false;
  }
}

/**
 * Creates the WebGPURenderer on #scene, awaiting init(). three.js falls back to
 * its WebGL2 backend by itself when WebGPU is missing; forceWebGL forces it, and so
 * does a software-only WebGPU adapter.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  options: { forceWebGL: boolean; trackTimestamp?: boolean },
): Promise<RendererHandle> {
  styleCanvas(canvas);
  const forceWebGL = options.forceWebGL || (await onlySoftwareWebGPU());
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL, trackTimestamp: options.trackTimestamp === true });
  try {
    await renderer.init();
  } catch (err) {
    void renderer.dispose();
    throw new RendererUnavailableError(err);
  }
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend: BackendName = isWebGPU ? 'webgpu' : 'webgl2';
  if (!isWebGPU && !(renderer.backend as { gl?: unknown }).gl) {
    void renderer.dispose();
    throw new RendererUnavailableError(new Error('No WebGL2 context'));
  }

  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMappingExposure = 0;
  renderer.setClearColor(0x000000, 1);

  let dprCap = 1;
  let resolutionScale = 1;
  let width = 1;
  let height = 1;
  const listeners = new Set<(w: number, h: number) => void>();

  const resize = (): void => {
    width = Math.max(1, canvas.clientWidth || window.innerWidth);
    height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap) * resolutionScale);
    renderer.setSize(width, height, false);
    for (const fn of listeners) fn(width, height);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  // ResizeObserver misses devicePixelRatio changes (browser zoom, moving between screens).
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer,
    backend,
    gpu: describeGpu(renderer, backend),
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    setDprCap(cap) {
      dprCap = cap;
      resize();
    },
    setResolutionScale(scale) {
      // Same floor as the governor, so the documented 0.6..1 range holds for any caller.
      const next = Math.min(1, Math.max(MIN_RESOLUTION_SCALE, scale));
      if (Math.abs(next - resolutionScale) < 1e-3) return;
      resolutionScale = next;
      resize();
    },
    get pixelRatio() {
      return renderer.getPixelRatio();
    },
    onResize(fn) {
      listeners.add(fn);
      fn(width, height);
      return () => listeners.delete(fn);
    },
    dispose() {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      listeners.clear();
      void renderer.dispose();
    },
  };
}
