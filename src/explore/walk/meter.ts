import { Color, FloatType, RenderTarget, RGBAFormat, Scene, type Camera, type Object3D, type WebGPURenderer } from 'three/webgpu';

/**
 * The walker's eye's meter (./light METER), as a camera's: the ground in view drawn now and then into a
 * small picture of its own (before the exposure, the sky left out), read back from the GPU without
 * waiting for it, as the mean of its luminance's logarithm. So the eye meters what the walker looks at
 * (the ground's own colour there, its light and its shadows), not its world's average: Apollo 11's dark
 * mare and Jezero's floor are seen, not lost in shadow.
 */

/** The picture's size (px), and how often it is drawn (ms of the page's clock, so a stepped clock still reads). */
const SPOT = { width: 32, height: 18, everyMs: 250 } as const;
/** A reading counts once this share of the picture is ground. */
const LEAST_GROUND = 0.05;

export interface Meter {
  /** The ground in view's luminance (its geometric mean, scene units) at the last reading; null before one, or after reset. */
  readonly luminance: number | null;
  /** Readings so far. */
  readonly readings: number;
  /** Draws the ground (as `camera` sees it) and reads it back, when it is time and no reading is waiting. */
  read(renderer: WebGPURenderer, camera: Camera): void;
  /** Forgets the last reading (a walk elsewhere): one under way is dropped. */
  reset(): void;
  dispose(): void;
}

/** `ground`: the ground's own meshes again (their geometry and materials shared), placed as the ground is. */
export function createMeter(ground: Object3D): Meter {
  const target = new RenderTarget(SPOT.width, SPOT.height, { type: FloatType, format: RGBAFormat, generateMipmaps: false });
  target.texture.name = 'explore-walk-meter';
  const scene = new Scene();
  scene.add(ground);
  const clear = new Color();
  let luminance: number | null = null;
  let readings = 0;
  let waiting = false;
  let last = -Infinity;
  let epoch = 0;
  return {
    get luminance() {
      return luminance;
    },
    get readings() {
      return readings;
    },
    read(renderer, camera) {
      const now = performance.now();
      if (waiting || now - last < SPOT.everyMs) return;
      last = now;
      waiting = true;
      const previous = renderer.getRenderTarget();
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      // Cleared transparent: what the ground does not cover is sky, and not counted.
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clear, alpha);
      const asked = epoch;
      renderer
        .readRenderTargetPixelsAsync(target, 0, 0, SPOT.width, SPOT.height)
        .then((pixels) => {
          waiting = false;
          if (asked !== epoch) return;
          let sum = 0;
          let n = 0;
          for (let i = 0; i + 3 < pixels.length; i += 4) {
            if (Number(pixels[i + 3]) < 0.5) continue;
            const l = 0.2126 * Number(pixels[i]) + 0.7152 * Number(pixels[i + 1]) + 0.0722 * Number(pixels[i + 2]);
            if (!Number.isFinite(l)) continue;
            sum += Math.log(Math.max(l, 1e-7));
            n += 1;
          }
          readings += 1;
          if (n >= LEAST_GROUND * SPOT.width * SPOT.height) luminance = Math.exp(sum / n);
        })
        .catch(() => {
          waiting = false;
        });
    },
    reset() {
      luminance = null;
      epoch += 1;
      last = -Infinity;
    },
    dispose() {
      target.dispose();
    },
  };
}
