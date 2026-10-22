import type { Node } from 'three/webgpu';
import { clamp, dot, float, mix, sRGBTransferOETF, select, vec3 } from 'three/tsl';

/**
 * Keeps the map's colours true to its colour scale on screen.
 *
 * The engine tone-maps the whole frame with three's ACES filmic curve, which
 * would turn the map's cream into grey and its cyan into lavender (about 37/255
 * mean error per channel against the legend). The texture holds only colours on
 * the Planck colour scale, so each texel is snapped to the nearest point of that
 * scale and replaced by a scene colour chosen so that, after ACES at exposure 1,
 * it shows as close to the legend's colour as ACES allows (about 23/255 mean,
 * the rest is outside what ACES can display). The scene colours stay below the
 * bloom threshold, so the map never glows.
 */

type Rgb = readonly [number, number, number];

/** Luminance cap for scene colours: the engine's bloom starts at 0.75. */
const MAX_SCENE_LUMINANCE = 0.72;

const ACES_IN: readonly Rgb[] = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUT: readonly Rgb[] = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const mul = (m: readonly Rgb[], v: Rgb): Rgb => {
  const row = (i: number): number => {
    const r = m[i] ?? [0, 0, 0];
    return r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  };
  return [row(0), row(1), row(2)];
};
const rrtOdt = (x: number): number => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** three's acesFilmicToneMapping (ToneMappingFunctions.js) on the CPU, exposure 1. */
function aces(c: Rgb): Rgb {
  const a = mul(ACES_IN, [c[0] / 0.6, c[1] / 0.6, c[2] / 0.6]);
  const b = mul(ACES_OUT, [rrtOdt(a[0]), rrtOdt(a[1]), rrtOdt(a[2])]);
  return [clamp01(b[0]), clamp01(b[1]), clamp01(b[2])];
}

const srgbToLinear = (s: number): number => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (l: number): number => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
const luminance = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function hexToSrgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`ch02: bad colour "${hex}" in cmb.json`);
  return [parseInt(m[1] ?? '0', 16) / 255, parseInt(m[2] ?? '0', 16) / 255, parseInt(m[3] ?? '0', 16) / 255];
}

/**
 * The scene colour that best shows as `target` (sRGB, 0..1) after ACES, by
 * coordinate descent in linear light with the bloom cap as a penalty.
 */
function solveForAces(target: Rgb): Rgb {
  const cost = (c: Rgb): number => {
    const shown = aces(c);
    let e = 0;
    for (let i = 0; i < 3; i += 1) e += (linearToSrgb(shown[i] ?? 0) - (target[i] ?? 0)) ** 2;
    return e + 100 * Math.max(0, luminance(c) - MAX_SCENE_LUMINANCE);
  };
  let c: [number, number, number] = [srgbToLinear(target[0]) * 0.8, srgbToLinear(target[1]) * 0.8, srgbToLinear(target[2]) * 0.8];
  let best = cost(c);
  for (let step = 0.25; step > 1e-4; step *= 0.5) {
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < 3; i += 1) {
        for (const sign of [1, -1]) {
          const next: [number, number, number] = [c[0], c[1], c[2]];
          next[i] = Math.max(0, (next[i] ?? 0) + sign * step);
          const value = cost(next);
          if (value < best) {
            best = value;
            c = next;
            improved = true;
          }
        }
      }
    }
  }
  return c;
}

export interface ColourScale {
  /** sRGB-encoded colour (0..1) of each stop, the space in which the scale is defined. */
  readonly srgb: readonly Rgb[];
  /** Scene colour to draw for each stop. */
  readonly display: readonly Rgb[];
}

/** Precomputes the colour scale; with no ACES (another tone mapper) it falls back to a plain gain. */
export function buildColourScale(stopsHex: readonly string[], acesToneMapping: boolean, plainGain: number): ColourScale {
  const srgb = stopsHex.map(hexToSrgb);
  const linear = srgb.map((c): Rgb => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])]);
  const display = acesToneMapping ? srgb.map(solveForAces) : linear.map((c): Rgb => [c[0] * plainGain, c[1] * plainGain, c[2] * plainGain]);
  return { srgb, display };
}

const v3 = (c: Rgb) => vec3(c[0], c[1], c[2]);

/**
 * Shader: snaps a sampled map colour to the nearest point on the colour scale's
 * polyline and returns the matching display colour.
 *
 * The distance is measured in sRGB, where the scale is piecewise linear between
 * its stops. Measuring it in linear light instead squeezes all dark colours
 * together: ETC1S often darkens a saturated blue texel (e.g. #0086ff decodes as
 * #007eaf), and in linear light that colour lies nearer the scale's dark-red end
 * (#640000, +300 uK) than any blue, so about 1% of texels, mostly cold ones,
 * showed as the hottest colour (dark-red speckles). In sRGB the same texels snap
 * back to their blues (0.004% are misplaced that far).
 */
export function mapToScale(sample: Node<'vec3'>, scale: ColourScale): Node<'vec3'> {
  // sRGBTransferOETF is typed as returning an untyped Node; it returns a vec3.
  const encoded = (sRGBTransferOETF(clamp(sample, 0, 1)) as Node<'vec3'>).toVar();
  const bestDistance = float(1e9).toVar();
  const best = vec3(0).toVar();
  for (let i = 0; i + 1 < scale.srgb.length; i += 1) {
    const a = scale.srgb[i];
    const b = scale.srgb[i + 1];
    const da = scale.display[i];
    const db = scale.display[i + 1];
    if (!a || !b || !da || !db) continue;
    const ab: Rgb = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const lengthSq = Math.max(1e-12, ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
    const fromA = encoded.sub(v3(a));
    const u = clamp(dot(fromA, v3(ab)).mul(1 / lengthSq), 0, 1);
    const offset = fromA.sub(v3(ab).mul(u));
    const distance = dot(offset, offset);
    const closer = distance.lessThan(bestDistance);
    best.assign(select(closer, mix(v3(da), v3(db), u), best));
    bestDistance.assign(select(closer, distance, bestDistance));
  }
  return best;
}
