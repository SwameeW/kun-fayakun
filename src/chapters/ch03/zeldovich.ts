import { Data3DTexture, HalfFloatType, LinearFilter, RepeatWrapping, RGBAFormat, DataUtils, NoColorSpace } from 'three/webgpu';

/**
 * Initial conditions for the cosmic web by the Zel'dovich approximation (first-order
 * Lagrangian perturbation theory, the standard way cosmological simulations are started).
 *
 * A Gaussian random density field delta(q) is drawn on a periodic grid with a power-law
 * spectrum (more power on large scales, smoothed at a couple of cells). Each particle then
 * moves as x = q + D(t) psi(q), where the displacement psi solves div psi = -delta, i.e.
 * psi_k = i k delta_k / k^2 in Fourier space, and D(t) is the growth factor. Overdense
 * regions draw matter in, collapsing first into sheets, then filaments and knots: the web.
 *
 * Everything here runs once at load, on the CPU, yielding to the browser between passes.
 */

export interface WebField {
  /** RGB = displacement psi (world units at D = 1), A = smoothed linear density delta / sigma. */
  readonly texture: Data3DTexture;
  /** Peaks of the density (first-star sites): Lagrangian position (world units) and height in sigma. */
  readonly peaks: ReadonlyArray<{ q: readonly [number, number, number]; height: number }>;
  /** Side of the periodic box in world units. */
  readonly box: number;
  /** RMS displacement at D = 1, in world units. */
  readonly rmsDisplacement: number;
}

interface Options {
  /** Grid cells per side (power of two). */
  size: number;
  /** Box side in world units. */
  box: number;
  /** Spectral index n of P(k) ∝ k^n (n < 0: more power on large scales, a web of big voids). */
  index: number;
  /** Gaussian smoothing radius in cells (removes grid-scale noise). */
  smoothCells: number;
  /** RMS displacement wanted at D = 1, in world units. */
  rmsDisplacement: number;
  /** Minimum peak height (in sigma) for a first-star site, and the most sites kept. */
  peakSigma: number;
  maxPeaks: number;
  seed: number;
}

/** Small seeded PRNG (mulberry32), so the web is the same on every visit. */
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

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** In-place radix-2 complex FFT of one line (stride `step`) of interleaved re/im arrays. */
function fftLine(re: Float64Array, im: Float64Array, offset: number, step: number, n: number, inverse: boolean): void {
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * step;
      const b = offset + j * step;
      const tr = re[a] ?? 0;
      const ti = im[a] ?? 0;
      re[a] = re[b] ?? 0;
      im[a] = im[b] ?? 0;
      re[b] = tr;
      im[b] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = offset + (i + k) * step;
        const b = offset + (i + k + len / 2) * step;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const xr = br * cr - bi * ci;
        const xi = br * ci + bi * cr;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        re[a] = ar + xr;
        im[a] = ai + xi;
        re[b] = ar - xr;
        im[b] = ai - xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** 3D FFT on an n^3 grid (x fastest), normalised on the inverse. */
async function fft3(re: Float64Array, im: Float64Array, n: number, inverse: boolean): Promise<void> {
  const n2 = n * n;
  for (let z = 0; z < n; z += 1) for (let y = 0; y < n; y += 1) fftLine(re, im, z * n2 + y * n, 1, n, inverse);
  await yieldToBrowser();
  for (let z = 0; z < n; z += 1) for (let x = 0; x < n; x += 1) fftLine(re, im, z * n2 + x, n, n, inverse);
  await yieldToBrowser();
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) fftLine(re, im, y * n + x, n2, n, inverse);
  if (inverse) {
    const scale = 1 / (n2 * n);
    for (let i = 0; i < re.length; i += 1) {
      re[i] = (re[i] ?? 0) * scale;
      im[i] = (im[i] ?? 0) * scale;
    }
  }
  await yieldToBrowser();
}

/** Signed wavenumber index for FFT bin i of n. */
const freq = (i: number, n: number): number => (i <= n / 2 ? i : i - n);

export async function createWebField(options: Options): Promise<WebField> {
  const { size: n, box } = options;
  const n3 = n * n * n;
  const random = prng(options.seed);

  // White Gaussian noise (Box-Muller), then into Fourier space.
  const re = new Float64Array(n3);
  const im = new Float64Array(n3);
  for (let i = 0; i < n3; i += 2) {
    const u = Math.max(random(), 1e-12);
    const v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    re[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n3) re[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  await fft3(re, im, n, false);

  // Shape the spectrum: amplitude sqrt(P(k)) = k^(n/2) with Gaussian smoothing; no k = 0 mode.
  const smooth2 = options.smoothCells * options.smoothCells;
  const kx = new Float64Array(n);
  for (let i = 0; i < n; i += 1) kx[i] = (2 * Math.PI * freq(i, n)) / n;
  for (let z = 0; z < n; z += 1) {
    const kz = kx[z] ?? 0;
    for (let y = 0; y < n; y += 1) {
      const ky = kx[y] ?? 0;
      for (let x = 0; x < n; x += 1) {
        const i = (z * n + y) * n + x;
        const k2 = (kx[x] ?? 0) ** 2 + ky * ky + kz * kz;
        // k in radians per cell, so the Gaussian window is exp(-k^2 R^2 / 2) with R in cells.
        const amplitude = k2 === 0 ? 0 : k2 ** (options.index / 4) * Math.exp(-0.5 * k2 * smooth2);
        re[i] = (re[i] ?? 0) * amplitude;
        im[i] = (im[i] ?? 0) * amplitude;
      }
    }
  }

  // Density (for peaks) and the three displacement components, each by an inverse FFT.
  const fields: Float64Array[] = [];
  for (let axis = -1; axis < 3; axis += 1) {
    const fr = new Float64Array(n3);
    const fi = new Float64Array(n3);
    for (let z = 0; z < n; z += 1) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const i = (z * n + y) * n + x;
          const k = [kx[x] ?? 0, kx[y] ?? 0, kx[z] ?? 0];
          const k2 = (k[0] ?? 0) ** 2 + (k[1] ?? 0) ** 2 + (k[2] ?? 0) ** 2;
          if (axis < 0) {
            fr[i] = re[i] ?? 0;
            fi[i] = im[i] ?? 0;
          } else if (k2 > 0) {
            // psi_k = i k delta_k / k^2: multiply (re + i im) by i * (k_axis / k2).
            const f = (k[axis] ?? 0) / k2;
            fr[i] = -(im[i] ?? 0) * f;
            fi[i] = (re[i] ?? 0) * f;
          }
        }
      }
    }
    await fft3(fr, fi, n, true);
    fields.push(fr);
  }
  const [delta, psiX, psiY, psiZ] = fields as [Float64Array, Float64Array, Float64Array, Float64Array];

  // Normalise: displacement to the wanted RMS (world units), density to sigma units.
  let sumPsi = 0;
  let sumDelta = 0;
  for (let i = 0; i < n3; i += 1) {
    sumPsi += (psiX[i] ?? 0) ** 2 + (psiY[i] ?? 0) ** 2 + (psiZ[i] ?? 0) ** 2;
    sumDelta += (delta[i] ?? 0) ** 2;
  }
  const psiScale = options.rmsDisplacement / Math.sqrt(sumPsi / n3);
  const sigma = Math.sqrt(sumDelta / n3);

  const data = new Uint16Array(n3 * 4);
  for (let i = 0; i < n3; i += 1) {
    data[i * 4] = DataUtils.toHalfFloat((psiX[i] ?? 0) * psiScale);
    data[i * 4 + 1] = DataUtils.toHalfFloat((psiY[i] ?? 0) * psiScale);
    data[i * 4 + 2] = DataUtils.toHalfFloat((psiZ[i] ?? 0) * psiScale);
    data[i * 4 + 3] = DataUtils.toHalfFloat((delta[i] ?? 0) / sigma);
  }
  const texture = new Data3DTexture(data, n, n, n);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  // Local maxima of the density above the threshold: where the first stars form.
  const at = (x: number, y: number, z: number): number => delta[((((z + n) % n) * n + ((y + n) % n)) * n + ((x + n) % n))] ?? 0;
  const peaks: Array<{ q: [number, number, number]; height: number }> = [];
  const cell = box / n;
  for (let z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const value = at(x, y, z);
        const height = value / sigma;
        if (height < options.peakSigma) continue;
        let isPeak = true;
        for (let dz = -1; dz <= 1 && isPeak; dz += 1)
          for (let dy = -1; dy <= 1 && isPeak; dy += 1)
            for (let dx = -1; dx <= 1; dx += 1) {
              if ((dx || dy || dz) && at(x + dx, y + dy, z + dz) > value) {
                isPeak = false;
                break;
              }
            }
        if (isPeak) peaks.push({ q: [(x + 0.5) * cell - box / 2, (y + 0.5) * cell - box / 2, (z + 0.5) * cell - box / 2], height });
      }
    }
  }
  peaks.sort((a, b) => b.height - a.height);
  return { texture, peaks: peaks.slice(0, options.maxPeaks), box, rmsDisplacement: options.rmsDisplacement };
}
