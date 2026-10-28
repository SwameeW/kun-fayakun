/**
 * How bright and what colour hot rock glows (docs/SANDBOX-ROADMAP.md W1.14): a blackbody's luminance and
 * colour at temperatures from 700 to 12,000 K, from Planck's law weighed by the eye's response.
 *
 * The eye's response is the CIE 1931 standard observer's colour matching functions (y-bar is the
 * photopic V(lambda)) as Wyman, Sloan and Shirley's multi-lobe fits give them (Journal of Computer
 * Graphics Techniques 2(2), 2013): a formula, so no table of the CIE's is copied. Luminance is
 * L_v = 683 lm/W times the integral of y-bar(lambda) B_lambda(T) from 360 to 830 nm, and the colour the
 * same integral of x-bar, y-bar, z-bar turned to linear sRGB (D65) with its largest channel 1.
 *
 * The luminance is given as a share of the explorer's sunlit ground: a white (albedo 1) surface facing
 * the Sun at 1 au, whose luminance is the sunlight there, S = L_sun / (4 pi au^2) (the IAU's nominal
 * luminosity), times the luminous efficacy of the Sun's light taken as a 5,772 K blackbody's, over pi.
 * Rock at 1,400 K is then about half as bright as sunlit ground of the Moon's albedo; at 1,000 K a
 * twenty-thousandth of it, which is why molten rock's glow is seen on a night side and gone from a day
 * side, and why it fades from sight as a crust forms.
 */

/** Planck's constant times c, over Boltzmann's (m K); and 2 h c^2 (W m^2 / sr). */
const HC_K = 1.438776877e-2;
const TWO_HC2 = 1.191042972e-16;
const SIGMA = 5.670374419e-8;
/** The IAU's nominal solar luminosity (W, Resolution B3, 2015) and effective temperature (K); the astronomical unit (m, Resolution B2, 2012). */
const SUN_W = 3.828e26;
const SUN_K = 5772;
const AU_M = 1.495978707e11;
/** The span tabulated (K) and its entries (evenly in log T). */
export const INCANDESCENCE = { fromK: 700, toK: 12_000, entries: 64 } as const;

const lobe = (x: number, mu: number, below: number, above: number): number => {
  const t = (x - mu) / (x < mu ? below : above);
  return Math.exp(-0.5 * t * t);
};

/** The CIE 1931 colour matching functions at a wavelength (nm), by Wyman, Sloan and Shirley's multi-lobe fit. */
export function cmf(nm: number): [number, number, number] {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1),
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8),
  ];
}

/** Planck's law: spectral radiance at a wavelength (nm) and temperature (K), W m^-2 sr^-1 per metre of wavelength. */
export function planck(nm: number, kelvin: number): number {
  const m = nm * 1e-9;
  return TWO_HC2 / (m ** 5 * Math.expm1(HC_K / (m * kelvin)));
}

/** A blackbody's tristimulus values (X, Y, Z, each W m^-2 sr^-1 weighed by the matching functions), integrated 360 to 830 nm at `stepNm`. */
export function tristimulus(kelvin: number, stepNm = 1): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let nm = 360; nm <= 830; nm += stepNm) {
    const w = (nm === 360 || nm === 830 ? 0.5 : 1) * stepNm * 1e-9;
    const b = planck(nm, kelvin) * w;
    const [cx, cy, cz] = cmf(nm);
    x += cx * b;
    y += cy * b;
    z += cz * b;
  }
  return [x, y, z];
}

/** Luminance (cd/m^2) of a white surface lit by the Sun at 1 au: the sunlight there times its luminous efficacy (a 5,772 K blackbody's), over pi. */
export const SUNLIT_WHITE_CD_M2 = ((SUN_W / (4 * Math.PI * AU_M * AU_M)) * ((683 * tristimulus(SUN_K)[1] * Math.PI) / (SIGMA * SUN_K ** 4))) / Math.PI;

/** Linear sRGB (D65) from XYZ, its largest channel 1. */
function rgbOf([x, y, z]: readonly [number, number, number]): [number, number, number] {
  const r = Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z);
  const g = Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z);
  const b = Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z);
  const top = Math.max(r, g, b, 1e-30);
  return [r / top, g / top, b / top];
}

/** The table: each entry's temperature, the natural log of its luminance as a share of sunlit white ground, and its colour. */
const table = (() => {
  const n = INCANDESCENCE.entries;
  const kelvin = new Float64Array(n);
  const lnLuminance = new Float64Array(n);
  const rgb = new Float64Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const t = INCANDESCENCE.fromK * (INCANDESCENCE.toK / INCANDESCENCE.fromK) ** (i / (n - 1));
    const xyz = tristimulus(t);
    kelvin[i] = t;
    lnLuminance[i] = Math.log((683 * xyz[1]) / SUNLIT_WHITE_CD_M2);
    const c = rgbOf(xyz);
    rgb.set(c, i * 3);
  }
  return { kelvin, lnLuminance, rgb };
})();

/**
 * A blackbody at `kelvin`: its luminance as a share of sunlit white ground (interpolated in the table, in
 * log luminance and log temperature: within a fraction of a per cent), and its colour (linear, largest
 * channel 1). Below the table's span it is too faint to matter (0, the colour of its first entry).
 */
export function incandescence(kelvin: number, out: { luminance: number; rgb: [number, number, number] } = { luminance: 0, rgb: [0, 0, 0] }): { luminance: number; rgb: [number, number, number] } {
  const n = INCANDESCENCE.entries;
  if (!(kelvin >= INCANDESCENCE.fromK)) {
    out.luminance = 0;
    out.rgb[0] = table.rgb[0] ?? 1;
    out.rgb[1] = table.rgb[1] ?? 0;
    out.rgb[2] = table.rgb[2] ?? 0;
    return out;
  }
  const u = Math.min(n - 1, (Math.log(kelvin / INCANDESCENCE.fromK) / Math.log(INCANDESCENCE.toK / INCANDESCENCE.fromK)) * (n - 1));
  const i = Math.min(n - 2, Math.floor(u));
  const f = u - i;
  out.luminance = Math.exp((table.lnLuminance[i] ?? 0) * (1 - f) + (table.lnLuminance[i + 1] ?? 0) * f);
  for (let c = 0; c < 3; c += 1) out.rgb[c] = (table.rgb[i * 3 + c] ?? 0) * (1 - f) + (table.rgb[(i + 1) * 3 + c] ?? 0) * f;
  return out;
}

/** The table's entries (for the tests). */
export const incandescenceTable = (): { kelvin: Float64Array; lnLuminance: Float64Array } => ({ kelvin: table.kelvin, lnLuminance: table.lnLuminance });
