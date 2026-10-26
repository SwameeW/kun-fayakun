/**
 * The Milky Way as a model (ledger IS-6, docs/NEIGHBOURHOOD.md): its shape from measured parameters,
 * drawn as a cloud of points, its stars not individually known (illustrative). Pure: the parameters,
 * the arms' geometry and a seeded sampler, for src/explore/neighbourhood/beyond.ts and the tests.
 *
 * Kiloparsecs in the galactic frame (x toward the centre as seen from the Sun, y toward galactic
 * longitude 90 degrees, the way the galaxy turns at the Sun, z to the north galactic pole), with the
 * centre at the origin and the Sun at (-R0, 0, 0).
 *
 * - The spiral arms: Reid et al. (2019, ApJ 885, 131), table 2: log-periodic spirals,
 *   ln(R / R_kink) = -(beta - beta_kink) tan psi, with a pitch angle psi either side of each kink,
 *   fitted to the parallaxes of masers in high-mass star-forming regions over the azimuths given
 *   (beta zero toward the Sun, growing with the galaxy's rotation; R0 = 8.15 kpc). Beyond those
 *   azimuths the same spirals are continued, fainter: an extrapolation (the far side of the galaxy is
 *   hidden behind its centre), which passes the arms' tangents seen in the fourth quadrant.
 * - The disc: exponential, scale length 2.6 kpc and scale height 0.3 kpc; the long bar: half-length
 *   5.0 kpc, 28 to 33 degrees from the line from the Sun to the centre, its near end at positive
 *   longitudes (Bland-Hawthorn and Gerhard 2016, ARA&A 54, 529). The bar's thickness and the bulge's
 *   size are illustrative.
 */

export interface SpiralArm {
  id: 'three-kpc' | 'norma' | 'scutum-centaurus' | 'sagittarius-carina' | 'local' | 'perseus' | 'outer';
  /** Azimuths traced by the parallaxes (degrees). */
  betaFromDeg: number;
  betaToDeg: number;
  betaKinkDeg: number;
  rKinkKpc: number;
  /** Pitch angles below and above the kink (degrees). */
  psiBelowDeg: number;
  psiAboveDeg: number;
  /** The arm's width at its kink (kpc). */
  widthKpc: number;
}

export const MILKY_WAY = {
  /** The Sun's distance from the centre assumed by the arms' fits (kpc). */
  r0Kpc: 8.15,
  disc: { scaleLengthKpc: 2.6, scaleHeightKpc: 0.3, outerKpc: 17 },
  bar: { halfLengthKpc: 5, angleDeg: 30 },
  arms: [
    { id: 'three-kpc', betaFromDeg: 15, betaToDeg: 18, betaKinkDeg: 15, rKinkKpc: 3.52, psiBelowDeg: -4.2, psiAboveDeg: -4.2, widthKpc: 0.18 },
    { id: 'norma', betaFromDeg: 5, betaToDeg: 54, betaKinkDeg: 18, rKinkKpc: 4.46, psiBelowDeg: -1, psiAboveDeg: 19.5, widthKpc: 0.14 },
    { id: 'scutum-centaurus', betaFromDeg: 0, betaToDeg: 104, betaKinkDeg: 23, rKinkKpc: 4.91, psiBelowDeg: 14.1, psiAboveDeg: 12.1, widthKpc: 0.23 },
    { id: 'sagittarius-carina', betaFromDeg: 2, betaToDeg: 97, betaKinkDeg: 24, rKinkKpc: 6.04, psiBelowDeg: 17.1, psiAboveDeg: 1, widthKpc: 0.27 },
    { id: 'local', betaFromDeg: -8, betaToDeg: 34, betaKinkDeg: 9, rKinkKpc: 8.26, psiBelowDeg: 11.4, psiAboveDeg: 11.4, widthKpc: 0.31 },
    { id: 'perseus', betaFromDeg: -23, betaToDeg: 115, betaKinkDeg: 40, rKinkKpc: 8.87, psiBelowDeg: 10.3, psiAboveDeg: 8.7, widthKpc: 0.35 },
    { id: 'outer', betaFromDeg: -16, betaToDeg: 71, betaKinkDeg: 18, rKinkKpc: 12.24, psiBelowDeg: 3, psiAboveDeg: 9.4, widthKpc: 0.65 },
  ] as readonly SpiralArm[],
} as const;

const DEG = Math.PI / 180;
/** How far each arm is continued past its traced azimuths (degrees), and the radii it is kept within (kpc). */
const EXTEND = { beforeDeg: 150, afterDeg: 90, minKpc: 3, maxKpc: 17 } as const;

/** An arm's galactocentric radius at an azimuth (kpc). */
export function armRadius(arm: SpiralArm, betaDeg: number): number {
  const psi = (betaDeg < arm.betaKinkDeg ? arm.psiBelowDeg : arm.psiAboveDeg) * DEG;
  return arm.rKinkKpc * Math.exp(-(betaDeg - arm.betaKinkDeg) * DEG * Math.tan(psi));
}

/** A point at galactocentric radius and azimuth (kpc, degrees) in the frame above. */
export function galactocentric(rKpc: number, betaDeg: number, zKpc = 0): [number, number, number] {
  return [-rKpc * Math.cos(betaDeg * DEG), rKpc * Math.sin(betaDeg * DEG), zKpc];
}

/** Galactic longitude (degrees, 0 to 360) of a point in the frame above, as seen from the Sun. */
export function longitudeFromSun(p: readonly [number, number, number]): number {
  const l = Math.atan2(p[1], p[0] + MILKY_WAY.r0Kpc) / DEG;
  return (l + 360) % 360;
}

/** A small seeded generator (mulberry32): the same galaxy every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GalaxyCloud {
  /** Points (kpc, the frame above), their colours (linear RGB) and how bright each is relative to the others. */
  positions: Float32Array;
  colours: Float32Array;
  count: number;
}

/** Old stars of the disc, young ones and glowing gas of the arms, the bar and bulge (display colours). */
const COLOURS = { disc: [1, 0.86, 0.68], arm: [0.62, 0.74, 1], nebula: [1, 0.45, 0.55], bar: [1, 0.72, 0.48] } as const;

/**
 * The model as `count` points (shares: a third the disc, two fifths the arms, the rest the bar and
 * bulge), the arms' points thinned to a third past the azimuths their parallaxes trace.
 */
export function sampleMilkyWay(count: number, seed = 1447): GalaxyCloud {
  const rand = random(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  let n = 0;
  const put = (p: readonly [number, number, number], colour: readonly number[], light: number): void => {
    if (n >= count) return;
    positions.set(p, n * 3);
    colours[n * 3] = (colour[0] ?? 1) * light;
    colours[n * 3 + 1] = (colour[1] ?? 1) * light;
    colours[n * 3 + 2] = (colour[2] ?? 1) * light;
    n += 1;
  };
  const { disc, bar } = MILKY_WAY;
  // The disc: radii with the surface density's exponential (R e^(-R/h) in radius), heights exponential.
  const discCount = Math.floor(count / 3);
  while (n < discCount) {
    const r = -disc.scaleLengthKpc * (Math.log(Math.max(rand(), 1e-12)) + Math.log(Math.max(rand(), 1e-12)));
    if (r > disc.outerKpc) continue;
    const z = (rand() < 0.5 ? -1 : 1) * -disc.scaleHeightKpc * Math.log(Math.max(rand(), 1e-12)) * 0.5;
    put(galactocentric(r, rand() * 360, z), COLOURS.disc, 0.8 + 0.4 * rand());
  }
  // The arms: along each spiral (its length in the measure of its azimuths), spread across by its width.
  const armCount = Math.floor((count * 2) / 5);
  const spans = MILKY_WAY.arms.map((arm) => ({ arm, from: arm.betaFromDeg - EXTEND.beforeDeg, to: arm.betaToDeg + EXTEND.afterDeg }));
  const total = spans.reduce((s, x) => s + (x.to - x.from) * Math.sqrt(x.arm.rKinkKpc), 0);
  for (const { arm, from, to } of spans) {
    const share = Math.round((armCount * (to - from) * Math.sqrt(arm.rKinkKpc)) / total);
    let placed = 0;
    for (let tries = 0; placed < share && tries < share * 6; tries += 1) {
      const beta = from + rand() * (to - from);
      const traced = beta >= arm.betaFromDeg && beta <= arm.betaToDeg;
      // Past the traced azimuths, a third as many.
      if (!traced && rand() > 1 / 3) continue;
      const r0 = armRadius(arm, beta);
      if (r0 < EXTEND.minKpc || r0 > EXTEND.maxKpc) continue;
      const width = (arm.widthKpc * r0) / arm.rKinkKpc;
      const r = r0 + gauss() * width * 0.6;
      const p = galactocentric(r, beta + (gauss() * width * 0.6) / r / DEG, gauss() * 0.06);
      const nebula = rand() < 0.06;
      put(p, nebula ? COLOURS.nebula : COLOURS.arm, (traced ? 1.1 : 0.8) * (nebula ? 1.4 : 1));
      placed += 1;
    }
  }
  // The bar, along its long axis at its angle (its near end toward positive longitudes), and the bulge.
  const phi = bar.angleDeg * DEG;
  const axis: [number, number] = [-Math.cos(phi), Math.sin(phi)];
  while (n < count) {
    if (rand() < 0.55) {
      // Denser toward the middle: 1 - u^2 along the axis.
      let u = 2 * rand() - 1;
      while (rand() > 1 - u * u) u = 2 * rand() - 1;
      const along = u * bar.halfLengthKpc;
      const across = gauss() * 0.45;
      put([along * axis[0] - across * axis[1], along * axis[1] + across * axis[0], gauss() * 0.18], COLOURS.bar, 1);
    } else {
      // The bulge: a rounded centre, about a kiloparsec across.
      const r = -0.45 * Math.log(Math.max(rand(), 1e-12));
      const t = Math.acos(2 * rand() - 1);
      const f = rand() * 2 * Math.PI;
      put([r * Math.sin(t) * Math.cos(f), r * Math.sin(t) * Math.sin(f), r * Math.cos(t) * 0.7], COLOURS.bar, 1.2);
    }
  }
  return { positions, colours, count: n };
}
