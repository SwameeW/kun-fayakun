import { Data3DTexture, LinearFilter, RedFormat, RepeatWrapping, UnsignedByteType } from 'three/webgpu';

/**
 * A small tileable 3D noise volume for the plasma. Sampling one R8 texel with
 * hardware trilinear filtering is far cheaper per pixel than evaluating 3D
 * noise in the shader, which matters for a layer that fills the screen.
 */

/** Gradient-noise octaves: lattice cells across the tile, and weight. */
const OCTAVES: ReadonlyArray<{ period: number; weight: number }> = [
  { period: 4, weight: 1 },
  { period: 8, weight: 0.5 },
  { period: 16, weight: 0.25 },
];

/** Longest stretch of work between yields, so building the volume never stalls a frame (it may run during a prefetch). */
const BUDGET_MS = 4;
/** Standard deviations either side of the mean that span the 0..255 range. */
const SPREAD = 2.5;

/** Small seeded PRNG (mulberry32) so the plasma looks the same on every visit. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random unit vectors on a period³ lattice, flattened xyz. */
function gradients(period: number, random: () => number): Float32Array {
  const out = new Float32Array(period * period * period * 3);
  for (let i = 0; i < out.length; i += 3) {
    const z = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    out[i] = r * Math.cos(phi);
    out[i + 1] = r * Math.sin(phi);
    out[i + 2] = z;
  }
  return out;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Per-axis lattice lookups for one octave: lower/upper cell, offset into the cell, and its fade. */
interface Axis {
  lo: Int32Array;
  hi: Int32Array;
  f: Float32Array;
  s: Float32Array;
}

function axis(size: number, period: number): Axis {
  const out: Axis = { lo: new Int32Array(size), hi: new Int32Array(size), f: new Float32Array(size), s: new Float32Array(size) };
  for (let c = 0; c < size; c += 1) {
    const x = ((c + 0.5) * period) / size;
    const cell = Math.floor(x);
    out.lo[c] = cell % period;
    out.hi[c] = (cell + 1) % period;
    out.f[c] = x - cell;
    out.s[c] = fade(x - cell);
  }
  return out;
}

const at = (a: Int32Array | Float32Array, i: number): number => a[i] ?? 0;

/** Adds `weight` × tileable gradient noise for slice z of a size³ volume into `slice` (size² values). */
function addOctaveSlice(slice: Float32Array, size: number, z: number, octave: { period: number; weight: number; grad: Float32Array; axis: Axis }): void {
  const { period: p, weight, grad, axis: ax } = octave;
  const g = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): number => {
    const i = ((cz * p + cy) * p + cx) * 3;
    return at(grad, i) * dx + at(grad, i + 1) * dy + at(grad, i + 2) * dz;
  };
  const z0 = at(ax.lo, z);
  const z1 = at(ax.hi, z);
  const fz = at(ax.f, z);
  const w = at(ax.s, z);
  for (let y = 0; y < size; y += 1) {
    const y0 = at(ax.lo, y);
    const y1 = at(ax.hi, y);
    const fy = at(ax.f, y);
    const v = at(ax.s, y);
    for (let x = 0; x < size; x += 1) {
      const x0 = at(ax.lo, x);
      const x1 = at(ax.hi, x);
      const fx = at(ax.f, x);
      const u = at(ax.s, x);
      const a = g(x0, y0, z0, fx, fy, fz);
      const b = g(x1, y0, z0, fx - 1, fy, fz);
      const c = g(x0, y1, z0, fx, fy - 1, fz);
      const d = g(x1, y1, z0, fx - 1, fy - 1, fz);
      const e = g(x0, y0, z1, fx, fy, fz - 1);
      const f = g(x1, y0, z1, fx - 1, fy, fz - 1);
      const h = g(x0, y1, z1, fx, fy - 1, fz - 1);
      const k = g(x1, y1, z1, fx - 1, fy - 1, fz - 1);
      const ab = a + (b - a) * u;
      const cd = c + (d - c) * u;
      const ef = e + (f - e) * u;
      const hk = h + (k - h) * u;
      const lower = ab + (cd - ab) * v;
      const upper = ef + (hk - ef) * v;
      const i = y * size + x;
      slice[i] = at(slice, i) + weight * (lower + (upper - lower) * w);
    }
  }
}

const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Builds a size³ tileable fBm volume (values 0..255, mean near 128) as an R8
 * Data3DTexture with repeat wrapping and trilinear filtering on both backends.
 */
export async function createNoiseVolume(size: number, seed: number): Promise<Data3DTexture> {
  const random = prng(seed);
  const octaves = OCTAVES.map((o) => ({ ...o, grad: gradients(o.period, random), axis: axis(size, o.period) }));
  const values = new Float32Array(size * size * size);
  let sum = 0;
  let sumSq = 0;

  let sliceStart = performance.now();
  for (let z = 0; z < size; z += 1) {
    if (performance.now() - sliceStart > BUDGET_MS) {
      await nextTask();
      sliceStart = performance.now();
    }
    const slice = values.subarray(z * size * size, (z + 1) * size * size);
    for (const octave of octaves) addOctaveSlice(slice, size, z, octave);
    for (const v of slice) {
      sum += v;
      sumSq += v * v;
    }
  }

  // fBm is roughly Gaussian: map mean ± SPREAD standard deviations onto 0..255 so
  // the 8 bits are spent where the values are, clamping the rare extremes.
  const mean = sum / values.length;
  const std = Math.sqrt(Math.max(1e-12, sumSq / values.length - mean * mean));
  const data = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const n = ((values[i] ?? mean) - mean) / (SPREAD * std);
    data[i] = Math.round(Math.min(1, Math.max(0, 0.5 + 0.5 * n)) * 255);
  }

  const texture = new Data3DTexture(data, size, size, size);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}
