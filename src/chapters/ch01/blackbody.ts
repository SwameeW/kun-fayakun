/**
 * Colour of a blackbody at a given temperature, as linear sRGB with its
 * largest channel scaled to 1 (hue only; brightness is set by the scene).
 *
 * Planck's law is integrated against the CIE 1931 2° colour-matching
 * functions, using the multi-lobe Gaussian fit of Wyman, Sloan and Shirley
 * (JCGT 2013), then converted XYZ → linear sRGB (D65). This lands on the
 * Planckian locus to within ~0.003 in xy from 1000 K to 25000 K, so 6500 K is
 * close to white, hotter is blue-white and cooler runs through yellow and
 * orange to deep red. Values are tabulated once and interpolated in log T.
 */

export type Rgb = [number, number, number];

const MIN_KELVIN = 500;
const MAX_KELVIN = 40_000;
const TABLE_SIZE = 128;
/** Second radiation constant hc/k in metre-kelvin. */
const C2 = 1.4387769e-2;

function lobe(x: number, mean: number, below: number, above: number): number {
  const d = (x - mean) / (x < mean ? below : above);
  return Math.exp(-0.5 * d * d);
}

function cieX(nm: number): number {
  return 1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2);
}
function cieY(nm: number): number {
  return 0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1);
}
function cieZ(nm: number): number {
  return 1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8);
}

/** Spectral radiance up to a constant factor (the result is normalised anyway). */
function planck(nm: number, kelvin: number): number {
  const m = nm * 1e-9;
  return 1 / (m ** 5 * Math.expm1(C2 / (m * kelvin)));
}

function computeRgb(kelvin: number): Rgb {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const b = planck(nm, kelvin);
    x += b * cieX(nm);
    y += b * cieY(nm);
    z += b * cieZ(nm);
  }
  const r = Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z);
  const g = Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z);
  const bl = Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z);
  const peak = Math.max(r, g, bl, Number.MIN_VALUE);
  return [r / peak, g / peak, bl / peak];
}

const LOG_MIN = Math.log(MIN_KELVIN);
const LOG_SPAN = Math.log(MAX_KELVIN) - LOG_MIN;
const TABLE: readonly Rgb[] = Array.from({ length: TABLE_SIZE }, (_, i) =>
  computeRgb(Math.exp(LOG_MIN + (LOG_SPAN * i) / (TABLE_SIZE - 1))),
);

/** Writes the blackbody hue for `kelvin` (clamped to 500–40000 K) into `out`. */
export function blackbodyRgb(kelvin: number, out: Rgb): Rgb {
  const clamped = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, kelvin));
  const f = ((Math.log(clamped) - LOG_MIN) / LOG_SPAN) * (TABLE_SIZE - 1);
  const i = Math.min(TABLE_SIZE - 2, Math.floor(f));
  const s = f - i;
  const a = TABLE[i];
  const b = TABLE[i + 1];
  if (!a || !b) return out;
  out[0] = a[0] + (b[0] - a[0]) * s;
  out[1] = a[1] + (b[1] - a[1]) * s;
  out[2] = a[2] + (b[2] - a[2]) * s;
  return out;
}
