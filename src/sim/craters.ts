/**
 * The crater a small body leaves in a large one (a cratering impact, not a giant one), by the scaling
 * Collins, Melosh and Marcus (2005) use in the Earth Impact Effects Program ("Earth Impact Effects
 * Program: A Web-based computer program for calculating the regional environmental consequences of a
 * meteoroid impact on Earth", Meteoritics & Planetary Science 40, 817):
 *
 * - The transient crater, pi-group scaling for rock (after Schmidt and Housen 1987):
 *   D_tc = 1.161 (rho_i / rho_t)^(1/3) L^0.78 v^0.44 g^-0.22 sin^(1/3) theta, SI units, with L the
 *   projectile's diameter, v its speed, g the target's surface gravity and theta the impact angle
 *   from the horizontal.
 * - The final crater: simple, 1.25 D_tc, up to the simple-to-complex transition; complex beyond it,
 *   1.17 D_tc^1.13 / D_c^0.13 (McKinnon and Schenk 1985), with D_c the transient diameter at the
 *   transition. On the Earth the transition is a final diameter of 3.2 km (so D_c = 3.2 / 1.25 =
 *   2.56 km); elsewhere it is scaled inversely with surface gravity, as the transition is observed
 *   to scale (about 19 km on the Moon, 8.5 km on Mars).
 * - The depth, rim crest to floor: a simple crater's from its breccia lens (eqs. 23 to 26: the
 *   transient crater D_tc / (2 sqrt 2) deep, a lens of 0.032 D^3 filling it back), a complex one's
 *   from Herrick et al.'s fit to the fresh craters of Venus, 0.4 D^0.3 km (eq. 28), which the paper
 *   takes for the Earth's too, as their gravities are alike. Fresh complex craters are deeper on
 *   lighter worlds (the Moon's, 1.044 D^0.301 km: Pike 1977), so on other worlds it is scaled by
 *   (g_Earth / g)^0.533, the power that carries the Earth's law onto the Moon's: an interpolation
 *   between the two fits by surface gravity, not a law of its own.
 * - The rim's height above the ground around: the ejecta's thickness at the final rim, 0.07 D_tc^4 /
 *   D^3 (eq. 48), which falls off as the cube of the distance beyond it (eq. 47).
 *
 * These are fits for rock struck by rock or iron at kilometres a second. Beyond a crater about the
 * target's own radius, the target is reshaped, not cratered: `crater` returns null, and the impact
 * is a giant one (./impacts). In the laboratory (`contactCrater`), a target is taken to have a solid
 * surface up to ten Earth masses (beyond that, the worlds known are giants of gas and ice, and stars),
 * with a crust of crystalline rock (2,750 kg/m^3, or the body's own density where that is lower); the
 * projectile has its own bulk density, from its mass and radius.
 */

/** The fits' constants, and the Earth's transition (a final diameter, m, at its surface gravity, m/s^2). */
export const CRATER = { coefficient: 1.161, simple: 1.25, complexCoefficient: 1.17, complexExponent: 0.13, earthTransitionM: 3200, earthGravity: 9.81 } as const;
/** A complex crater's depth (km, for D in km): Herrick et al.'s fit at the Earth's gravity, and the power of g_Earth / g that gives Pike's (1977) lunar fit at the Moon's (1.62 m/s^2). */
export const COMPLEX_DEPTH = { coefficient: 0.4, exponent: 0.3, gravityExponent: Math.log(1.044 / 0.4) / Math.log(9.81 / 1.62) } as const;

export interface CraterInput {
  /** The projectile's diameter (m) and density (kg/m^3). */
  impactorM: number;
  impactorDensity: number;
  /** The target's density (kg/m^3), surface gravity (m/s^2) and radius (m). */
  targetDensity: number;
  gravity: number;
  targetRadiusM: number;
  /** Speed at contact (m/s), and the angle from the horizontal (radians; pi / 2 straight down). */
  speedMs: number;
  angle: number;
}

export interface Crater {
  /** The transient crater's diameter and the final crater's, rim to rim (m). */
  transientM: number;
  finalM: number;
  /** Past the simple-to-complex transition (central peaks, terraces), on this world's gravity. */
  complex: boolean;
  /** Rim crest to floor (m), and the rim's height above the ground around (m). */
  depthM: number;
  rimM: number;
}

/** G (CODATA 2018), m^3 kg^-1 s^-2. */
const G_SI = 6.6743e-11;
/** The most massive world (GM, km^3 s^-2: ten times the Earth's) taken to have a solid surface to crater. */
export const SOLID_MAX_GM = 10 * 398_600.435;
/** The crust a solid world is taken to have (kg/m^3): crystalline rock. */
export const CRUST_DENSITY = 2750;

/** A body's bulk density (kg/m^3) from its GM (km^3 s^-2) and radius (km). */
export function bulkDensity(gm: number, radiusKm: number): number {
  return (gm * 1e9) / G_SI / ((4 / 3) * Math.PI * (radiusKm * 1000) ** 3);
}

/** An energy in the engine's units (masses as GM, km^3 s^-2, times speeds squared, km^2 s^-2) in joules: GM to kg (m^3, over G), km^2 to m^2. */
export function joules(energyG: number): number {
  return (energyG * 1e9 * 1e6) / G_SI;
}

/** The final diameter (m) at which craters turn complex on a world of this surface gravity. */
export function transitionM(gravity: number): number {
  return (CRATER.earthTransitionM * CRATER.earthGravity) / gravity;
}

/** The crater an impact leaves, or null where the scaling does not apply (no speed, a grazing miss, or a giant impact). */
export function crater(input: CraterInput): Crater | null {
  const { impactorM, impactorDensity, targetDensity, gravity, targetRadiusM, speedMs, angle } = input;
  if (![impactorM, impactorDensity, targetDensity, gravity, targetRadiusM, speedMs, angle].every(Number.isFinite)) return null;
  const sine = Math.sin(angle);
  if (impactorM <= 0 || impactorDensity <= 0 || targetDensity <= 0 || gravity <= 0 || speedMs <= 0 || sine <= 0) return null;
  const transientM = CRATER.coefficient * Math.cbrt(impactorDensity / targetDensity) * impactorM ** 0.78 * speedMs ** 0.44 * gravity ** -0.22 * Math.cbrt(sine);
  const simpleM = CRATER.simple * transientM;
  const transitionFinalM = transitionM(gravity);
  const complex = simpleM > transitionFinalM;
  const transientAtTransition = transitionFinalM / CRATER.simple;
  const finalM = complex ? (CRATER.complexCoefficient * transientM ** (1 + CRATER.complexExponent)) / transientAtTransition ** CRATER.complexExponent : simpleM;
  if (finalM > targetRadiusM) return null;
  const rimM = (0.07 * transientM ** 4) / finalM ** 3;
  let depthM: number;
  if (complex) depthM = COMPLEX_DEPTH.coefficient * (finalM / 1000) ** COMPLEX_DEPTH.exponent * (CRATER.earthGravity / gravity) ** COMPLEX_DEPTH.gravityExponent * 1000;
  else {
    // The transient crater's depth, and the breccia lens that falls back into it (bulked 10%, parabolic on top).
    const transientDepthM = transientM / (2 * Math.SQRT2);
    const lensM = (2.8 * 0.032 * finalM ** 3 * (transientDepthM + rimM)) / (transientDepthM * finalM ** 2);
    depthM = transientDepthM + rimM - lensM;
  }
  return { transientM, finalM, complex, depthM, rimM };
}

/**
 * The crater of a contact in the laboratory's units (GM in km^3 s^-2, km, km/s; b the impact
 * parameter, 0 head-on): the final diameter, depth and rim height (km) and whether it is complex, or
 * null where no crater is drawn (a giant, a star, a test particle, a giant impact).
 */
export function contactCrater(target: { gm: number; radiusKm: number }, projectile: { gm: number; radiusKm: number }, speedKmS: number, b: number): { diameterKm: number; complex: boolean; depthKm: number; rimKm: number } | null {
  if (!(target.gm > 0 && projectile.gm > 0 && target.radiusKm > 0 && projectile.radiusKm > 0) || target.gm > SOLID_MAX_GM) return null;
  const c = crater({
    impactorM: 2 * projectile.radiusKm * 1000,
    impactorDensity: bulkDensity(projectile.gm, projectile.radiusKm),
    targetDensity: Math.min(CRUST_DENSITY, bulkDensity(target.gm, target.radiusKm)),
    gravity: (target.gm / (target.radiusKm * target.radiusKm)) * 1000,
    targetRadiusM: target.radiusKm * 1000,
    speedMs: speedKmS * 1000,
    // From the horizontal: b is the sine of the angle from the line of centres.
    angle: Math.acos(Math.min(1, Math.max(0, b))),
  });
  return c ? { diameterKm: c.finalM / 1000, complex: c.complex, depthKm: c.depthM / 1000, rimKm: c.rimM / 1000 } : null;
}
