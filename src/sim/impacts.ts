/**
 * What a collision between two gravity-dominated bodies does: the outcome regimes and scaling laws
 * of Leinhardt and Stewart (2012), "Collisions between gravity-dominated bodies. I. Outcome regimes
 * and scaling laws", ApJ 745, 79 (arXiv:1106.6084), following their Appendix procedure. The
 * laboratory's first impact model (Phase 2); docs/IMPACTS.md says how it is used and what it leaves
 * out.
 *
 * Units are the engine's: GM (km^3 s^-2), km, km/s, so a "mass" here is a GM and specific energies are
 * km^2 s^-2. G enters only through the paper's reference density rho1 = 1000 kg m^-3 (the radius
 * R_C1 at which the disruption criterion is normalised), as G rho1.
 *
 * - Q_R = 0.5 mu V_i^2 / M_tot (eq. 1), mu the reduced mass.
 * - The equal-mass catastrophic disruption criterion Q*_RD = c* (4/5) pi rho1 G R_C1^2 (eq. 28), with
 *   c* = 1.9 and mu-bar = 0.36 for strengthless planet-size bodies (their section III.1.4).
 * - For unequal masses, Q*_RD times [(gamma + 1)^2 / (4 gamma)]^(2 / (3 mu-bar) - 1) (eq. 23).
 * - For oblique impacts, only the interacting part of the projectile counts: alpha (eq. 11) from the
 *   overlap l = (R + r)(1 - b) (eq. 7), mu_alpha (eq. 12), Q'*_RD = (mu / mu_alpha)^(2 - 3 mu-bar / 2) Q*_RD (eq. 15).
 * - Perfect merging below V'_esc, the escape speed of the target plus the interacting mass (eq. 53).
 * - The largest remnant: the universal law M_lr / M_tot = -0.5 (Q_R / Q'*_RD - 1) + 0.5 (eq. 5) up to
 *   Q_R / Q'*_RD = 1.8, beyond it (0.1 / 1.8^eta) (Q_R / Q'*_RD)^eta with eta = -1.5 (eq. 44).
 * - The second largest: M_slr / M_tot = (3 - beta)(1 - N_lr M_lr / M_tot) / (N_slr beta) (eq. 37),
 *   beta = 2.85, N_lr = 1, N_slr = 2, never more than the largest.
 * - Grazing impacts (b > b_crit = R / (R + r), eq. 6) below the erosion speed are hit-and-run: the
 *   target keeps its mass. The projectile's own erosion (their reverse impact) is not modelled here.
 */

/** The paper's fit for strengthless, planet-size bodies (section III.1.4). */
export const LS2012 = { cStar: 1.9, muBar: 0.36, eta: -1.5, beta: 2.85, nLargest: 1, nSecond: 2, superCatastrophic: 1.8 } as const;
/** G (CODATA 2018, 6.67430e-11 m^3 kg^-1 s^-2) times the paper's reference density rho1 = 1000 kg m^-3, s^-2. */
const G_RHO1 = 6.6743e-11 * 1000;

export type ImpactRegime = 'merge' | 'partial-accretion' | 'hit-and-run' | 'erosion' | 'super-catastrophic';

export interface ImpactBody {
  /** GM, km^3 s^-2. */
  gm: number;
  radiusKm: number;
}

export interface ImpactOutcome {
  regime: ImpactRegime;
  /** b > b_crit: the projectile's centre passes outside the target's disc. */
  grazing: boolean;
  /** The impact parameter (sin of the angle from head-on) and its critical value. */
  b: number;
  bCrit: number;
  /** Share of the projectile's mass in the collision's path (1 head-on). */
  alpha: number;
  /** Specific impact energy and the (angle- and mass-ratio-corrected) disruption criterion, km^2 s^-2. */
  qR: number;
  qRdPrime: number;
  /** Speeds bounding the regimes, km/s: merging below vEscPrime, erosion of the target from vErosion, super-catastrophic from vSuperCat. */
  vEscPrime: number;
  vErosion: number;
  vSuperCat: number;
  /** GM of the largest remnant (the target's, in hit-and-run), the second largest, and what remains as debris (all GM, summing to the total). */
  largest: number;
  second: number;
  debris: number;
  /** In hit-and-run, the projectile carries on whole (its erosion is not modelled). */
  projectile: number;
}

/** The radius (km) a mass would have at a density, from G rho (s^-2): (3 GM / (4 pi G rho))^(1/3). */
const radiusAt = (gm: number, gRho: number): number => Math.cbrt((3 * gm) / (4 * Math.PI * gRho));

/**
 * The outcome of `projectile` striking `target` (the more massive of the two) at speed `vKmS` (relative,
 * at contact) and impact parameter `b` (0 head-on, toward 1 grazing).
 */
export function impactOutcome(target: ImpactBody, projectile: ImpactBody, vKmS: number, b: number): ImpactOutcome {
  const mt = target.gm;
  const mp = projectile.gm;
  const total = mt + mp;
  const R = target.radiusKm;
  const r = projectile.radiusKm;
  const mu = (mp * mt) / total;
  const gamma = mp / mt;
  const bb = Math.min(1, Math.max(0, b));
  const bCrit = R / (R + r);
  const grazing = bb > bCrit;
  // The projectile's overlap with the target along its path (eq. 7), and the share of its mass in it (eq. 11).
  const l = (R + r) * (1 - bb);
  const alpha = l >= 2 * r ? 1 : (3 * r * l * l - l * l * l) / (4 * r * r * r);
  const interacting = alpha * mp;
  const muAlpha = (interacting * mt) / (interacting + mt);
  // Merging: slower than the escape speed of the target and the interacting mass, at the bodies' bulk density (eq. 53).
  const gRho = (3 * total) / (4 * Math.PI * (R * R * R + r * r * r));
  const mPrime = mt + interacting;
  const vEscPrime = Math.sqrt((2 * mPrime) / radiusAt(mPrime, gRho));
  // The disruption criterion: equal masses at R_C1 (eq. 28), the mass ratio (eq. 23), the angle (eq. 15).
  const rC1 = radiusAt(total, G_RHO1);
  const qRdEqual = LS2012.cStar * (4 / 5) * Math.PI * G_RHO1 * rC1 * rC1;
  const qRd = qRdEqual * (((gamma + 1) ** 2 / (4 * gamma)) ** (2 / (3 * LS2012.muBar) - 1));
  const qRdPrime = muAlpha > 0 ? (mu / muAlpha) ** (2 - (3 * LS2012.muBar) / 2) * qRd : Number.POSITIVE_INFINITY;
  const qR = (0.5 * mu * vKmS * vKmS) / total;
  // Speeds where the largest remnant falls to the target's mass (erosion begins) and to a tenth of the total (eqs. 5, 1).
  const speedFor = (q: number): number => Math.sqrt((2 * q * total) / mu);
  const vErosion = speedFor(2 * qRdPrime * (mp / total));
  const vSuperCat = speedFor(LS2012.superCatastrophic * qRdPrime);
  const ratio = qR / qRdPrime;
  const universal = (): number => total * Math.min(1, -0.5 * (ratio - 1) + 0.5);
  const superCat = (): number => total * (0.1 / LS2012.superCatastrophic ** LS2012.eta) * ratio ** LS2012.eta;
  // Eq. 37 is fitted in the disruption regime; far beyond it (a tiny largest remnant) it would give a
  // second remnant larger than the largest, so it is held to the largest (the rest stays debris).
  const second = (largest: number): number => Math.max(0, Math.min(total - largest, largest, (total * (3 - LS2012.beta) * (1 - (LS2012.nLargest * largest) / total)) / (LS2012.nSecond * LS2012.beta)));
  const result = (regime: ImpactRegime, largest: number, projectileLeft = 0): ImpactOutcome => {
    const s = regime === 'merge' || regime === 'hit-and-run' ? 0 : second(largest);
    return { regime, grazing, b: bb, bCrit, alpha, qR, qRdPrime, vEscPrime, vErosion, vSuperCat, largest, second: s, debris: Math.max(0, total - largest - s - projectileLeft), projectile: projectileLeft };
  };
  if (vKmS < vEscPrime) return result('merge', total);
  if (vKmS >= vSuperCat) return result('super-catastrophic', superCat());
  if (vKmS >= vErosion) return result('erosion', universal());
  // Below erosion: a grazing projectile passes on (the target keeps its mass); head-on, the target gains part of it.
  if (grazing) return result('hit-and-run', mt, mp);
  return result('partial-accretion', Math.max(mt, universal()));
}

/** The impact parameter of two bodies at contact: the sine of the angle between their separation and their relative velocity. */
export function impactParameter(dx: number, dy: number, dz: number, dvx: number, dvy: number, dvz: number): number {
  const cx = dy * dvz - dz * dvy;
  const cy = dz * dvx - dx * dvz;
  const cz = dx * dvy - dy * dvx;
  const d = Math.hypot(dx, dy, dz) * Math.hypot(dvx, dvy, dvz);
  return d > 0 ? Math.min(1, Math.hypot(cx, cy, cz) / d) : 0;
}
