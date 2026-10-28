/**
 * The GPU's own answer for the asteroids' places, read back (the tests' window.__kf.worlds.probe): the
 * belt's vertex stage (./belt: the float32 decode, the split date, Kepler's equation in TSL) run for the
 * first `count` points into a float target, one pixel each, its colour the point's place from the Sun
 * (au, render frame) as sizes, their signs and its index in the fourth channel (a colour's negative
 * parts do not survive the way out). Its own small chunk, loaded only when a test asks: nothing a
 * visitor runs builds it.
 */

import { Color, FloatType, NearestFilter, NoBlending, OrthographicCamera, PointsNodeMaterial, RenderTarget, RGBAFormat, Scene, Sprite, type WebGPURenderer } from 'three/webgpu';
import { abs, float, instanceIndex, screenDPR, step, varying, vec3, vec4 } from 'three/tsl';
import type { Belt } from './belt';

/** Points a row of the target. */
const WIDTH = 256;

/** Each point's place (x, y, z au, render frame: on its orbit, or `drawn` as drawn) and its index, in index order. */
export async function probeBelt(renderer: WebGPURenderer, belt: Belt, count: number, drawn = false): Promise<Float32Array> {
  const n = Math.max(1, Math.min(count, belt.loaded));
  const rows = Math.ceil(n / WIDTH);
  const target = new RenderTarget(WIDTH, rows, { type: FloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
  const k = float(instanceIndex);
  const material = new PointsNodeMaterial({ blending: NoBlending, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false });
  // Point k at the middle of pixel (k mod WIDTH, k / WIDTH), one pixel across; its index plus one (a pixel left clear reads 0).
  // (The node's own methods: the shell re-exports only the functions some chunk imports.)
  const row = k.div(WIDTH).floor();
  material.positionNode = vec3(k.sub(row.mul(WIDTH)).add(0.5), row.add(0.5), 0);
  material.sizeNode = float(1).div(screenDPR);
  const at = varying(drawn ? belt.drawn : belt.heliocentric);
  // The fourth channel: (index x 8 + the three signs as bits) + 1, exact in float32 below 2^21 points.
  const signs = step(0, at.x.negate()).mul(4).add(step(0, at.y.negate()).mul(2)).add(step(0, at.z.negate()));
  material.colorNode = vec4(abs(at), k.mul(8).add(signs).add(1));
  const sprite = new Sprite(material);
  sprite.geometry = belt.geometry;
  sprite.count = n;
  sprite.frustumCulled = false;
  const scene = new Scene();
  scene.add(sprite);
  const camera = new OrthographicCamera(0, WIDTH, rows, 0, -1, 1);
  const was = renderer.getRenderTarget();
  const clear = renderer.getClearColor(new Color());
  const clearAlpha = renderer.getClearAlpha();
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, WIDTH, rows)) as Float32Array;
    // In index order, whichever way up the backend reads the rows.
    const out = new Float32Array(n * 4);
    for (let p = 0; p + 3 < pixels.length; p += 4) {
      const code = Math.round(pixels[p + 3] ?? 0) - 1;
      const index = Math.floor(code / 8);
      if (code < 0 || index >= n) continue;
      const sign = (bit: number): number => ((code & bit) !== 0 ? -1 : 1);
      out.set([sign(4) * (pixels[p] ?? 0), sign(2) * (pixels[p + 1] ?? 0), sign(1) * (pixels[p + 2] ?? 0), index], index * 4);
    }
    return out;
  } finally {
    renderer.setClearColor(clear, clearAlpha);
    renderer.setRenderTarget(was);
    target.dispose();
    material.dispose();
  }
}
