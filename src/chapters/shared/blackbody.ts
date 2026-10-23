/**
 * The colour of a blackbody at a given temperature, from physics rather than by eye: the
 * chromaticity of the Planckian locus (Kang et al. 2002 cubic fits to CIE 1931, valid
 * 1667 K to 25,000 K), converted to linear sRGB and scaled so its largest channel is 1.
 * Stars are close enough to blackbodies for their colour; brightness is set separately.
 */

export type Rgb = readonly [number, number, number];

export function blackbodyRgb(kelvin: number): Rgb {
  const t = Math.min(25_000, Math.max(1667, kelvin));
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  // CIE XYZ with Y = 1, then linear sRGB (D65).
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z);
  const g = Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z);
  const b = Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z);
  const top = Math.max(r, g, b, 1e-6);
  return [r / top, g / top, b / top];
}
