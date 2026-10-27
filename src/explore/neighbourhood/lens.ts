/**
 * Light bending round a black hole (docs/NEIGHBOURHOOD.md, "Black holes"): pure, in units of the
 * Schwarzschild radius r_s = 2GM/c^2, so the same code serves Gaia BH1's 28 km and TON 618's 1,300
 * au. The lens shader (./black-holes) runs the same steps on the GPU, its constants these.
 *
 * - A light ray in a non-rotating black hole's field stays in one plane through the hole, and its
 *   u = r_s / r follows u'' + u = (3/2) u^2 with the angle round the hole, phi, as the variable
 *   (Binet's form of the geodesic), its slope fixed by the impact parameter b: u'^2 = 1/b^2 - u^2 + u^3.
 * - A camera hanging still at r_o sees a ray arrive from an angle psi off the line to the hole; in
 *   its own frame, b = r_o sin(psi) / sqrt(1 - r_s / r_o).
 * - Traced back from the camera by fourth-order Runge-Kutta steps in phi: through the horizon (u = 1:
 *   captured, the shadow), or out to infinity (u = 0: the direction its light came from is the one
 *   at that phi). The steps do not depend on how far the camera is, and a ray winding near the photon
 *   sphere (1.5 r_s) is followed round twice before it is taken as lost to it.
 * - Checked against the weak field's bending, 4GM/(c^2 b) = 2 r_s / b (plus 15 pi r_s^2 / (16 b^2)),
 *   and the shadow's edge, a ray of impact parameter sqrt(27)/2 r_s (Synge 1966).
 *
 * A disc in the hole's equatorial plane is crossed where the ray's plane meets it, at phi_c + k pi;
 * its light reaches the camera shifted by g = sqrt(1 - 3/(2r)) / (1 - Omega lambda) / sqrt(1 - 1/r_o)
 * (the gas on a circular orbit at r, Omega = sqrt(1/(2 r^3)), lambda the light's angular momentum about
 * the disc's axis; Cunningham 1975), its intensity by g^4.
 */

export type V3 = [number, number, number];

/** The photon sphere's radius and the critical impact parameter (r_s); the innermost stable circular orbit. */
export const PHOTON_SPHERE = 1.5;
export const CRITICAL_B = Math.sqrt(27) / 2;
export const ISCO = 3;
/** Speed of light (km/s), the Sun's GM (km^3/s^2, IAU 2015 B3), km per au. */
const C_KM_S = 299_792.458;
const GM_SUN = 1.32712440018e11;
const AU_KM = 149_597_870.7;
const PC_KM = (648_000 / Math.PI) * AU_KM;

/** The tracer's constants (the shader's too): the step in phi (fine enough that its phase error over a ray is a microradian), and the most steps (two turns and a half). */
export const TRACE = { dPhi: Math.PI / 40, steps: 200 } as const;

/** The Schwarzschild radius of a mass (Suns), km. */
export const schwarzschildKm = (massSun: number): number => (2 * GM_SUN * massSun) / (C_KM_S * C_KM_S);
export const schwarzschildPc = (massSun: number): number => schwarzschildKm(massSun) / PC_KM;

/** The shadow's angular radius (rad) seen by a camera hanging still `r` (r_s) from the hole (Synge 1966); more than half the sky inside the photon sphere. */
export function shadowAngle(r: number): number {
  if (r <= 1) return Math.PI;
  const s = Math.min(1, (CRITICAL_B / r) * Math.sqrt(1 - 1 / r));
  return r >= PHOTON_SPHERE ? Math.asin(s) : Math.PI - Math.asin(s);
}

/** The shadow's angular diameter seen from afar (microarcseconds) for a mass (Suns) and distance (pc): 2 (sqrt(27)/2) r_s / D. */
export const shadowMicroArcsec = (massSun: number, distPc: number): number => ((2 * CRITICAL_B * schwarzschildPc(massSun)) / distPc) * (180 / Math.PI) * 3600e6;

/** The weak field's bending of a ray passing at impact parameter b (r_s): 2/b, and its second order. */
export const weakBending = (b: number): number => 2 / b + (15 * Math.PI) / (16 * b * b);

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

/** The impact parameter (r_s) of the ray a camera hanging still at `camera` sees along `dir` (unit). */
export function impact(camera: V3, dir: V3): number {
  const r = len(camera);
  // r sin(psi), as |camera x dir| (exact for the smallest angles).
  return len(cross(camera, dir)) / Math.sqrt(Math.max(1e-12, 1 - 1 / r));
}

export interface Crossing {
  /** Where the ray crossed the disc's plane (r_s from the hole). */
  at: V3;
  r: number;
}

export interface Traced {
  captured: boolean;
  /** Where the ray's light comes from (unit: the direction it leaves the hole's field in, traced back). */
  direction: V3;
  crossings: Crossing[];
  /** The ray's plane: the hole-to-camera axis and the direction phi grows in, and its impact parameter. */
  er: V3;
  et: V3;
  b: number;
  /** How far round the hole it went (rad), and the steps taken. */
  phi: number;
  steps: number;
}

/** u'' = -u + 1.5 u^2. */
const curve = (u: number): number => -u + 1.5 * u * u;

/** Four-point Gauss-Legendre nodes and weights on [0, 1]. */
export const GAUSS = { nodes: [0.0694318442, 0.3300094782, 0.6699905218, 0.9305681558], weights: [0.1739274226, 0.3260725774, 0.3260725774, 0.1739274226] } as const;

/** The angle an outgoing ray still turns through from u out to infinity: the integral of du / sqrt(1/b^2 - u^2 + u^3) from 0 to u. */
export function tailAngle(u: number, b: number): number {
  let sum = 0;
  for (let k = 0; k < 4; k += 1) {
    const x = u * (GAUSS.nodes[k] ?? 0);
    sum += (GAUSS.weights[k] ?? 0) / Math.sqrt(Math.max(1e-12, 1 / (b * b) - x * x + x * x * x));
  }
  return sum * u;
}

/**
 * Traces the ray a camera hanging still at `camera` (r_s, from the hole) sees along `dir` (unit, its
 * own frame) back to where its light came from, noting where it crosses the plane square to
 * `normal` (a disc's), at most `maxCrossings` times.
 */
export function trace(camera: V3, dir: V3, normal: V3 | null = null, maxCrossings = 3): Traced {
  const r0 = len(camera);
  const er = scale(camera, 1 / r0);
  const radial = dot(dir, er);
  const across = add(dir, scale(er, -radial));
  const b = impact(camera, dir);
  const crossings: Crossing[] = [];
  // Straight in or straight out along the line to the hole.
  if (len(across) < 1e-12) {
    const captured = radial < 0;
    return { captured, direction: captured ? [0, 0, 0] : er, crossings, er, et: [0, 0, 0], b: 0, phi: 0, steps: 0 };
  }
  const et = unit(across);
  const at = (phi: number, u: number): V3 => scale(add(scale(er, Math.cos(phi)), scale(et, Math.sin(phi))), 1 / u);
  let u = 1 / r0;
  // In toward the hole: u grows.
  let du = Math.sign(-radial || 1) * Math.sqrt(Math.max(0, 1 / (b * b) - u * u + u * u * u));
  let phi = 0;
  // Where the ray's plane meets the disc's: f(phi) = A cos(phi) + B sin(phi) = 0, at phiC + k pi.
  const A = normal ? dot(er, normal) : 0;
  const B = normal ? dot(et, normal) : 0;
  let nextCross = normal && Math.hypot(A, B) > 1e-12 ? Math.atan2(-A, B) : Number.POSITIVE_INFINITY;
  while (nextCross <= 1e-12) nextCross += Math.PI;
  const h = TRACE.dPhi;
  for (let steps = 0; steps < TRACE.steps; steps += 1) {
    // Fourth-order Runge-Kutta on (u, u').
    const k1u = du;
    const k1v = curve(u);
    const k2u = du + (h / 2) * k1v;
    const k2v = curve(u + (h / 2) * k1u);
    const k3u = du + (h / 2) * k2v;
    const k3v = curve(u + (h / 2) * k2u);
    const k4u = du + h * k3v;
    const k4v = curve(u + h * k3u);
    const nu = u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
    const ndu = du + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    // A crossing of the disc's plane within this step: u there by a cubic through the step's ends.
    while (nextCross <= phi + h && crossings.length < maxCrossings) {
      const s = (nextCross - phi) / h;
      const s2 = s * s;
      const s3 = s2 * s;
      const uc = (2 * s3 - 3 * s2 + 1) * u + (s3 - 2 * s2 + s) * h * du + (-2 * s3 + 3 * s2) * nu + (s3 - s2) * h * ndu;
      if (uc > 0 && uc < 1) crossings.push({ at: at(nextCross, uc), r: 1 / uc });
      nextCross += Math.PI;
    }
    if (nu >= 1) return { captured: true, direction: [0, 0, 0], crossings, er, et, b, phi: phi + h, steps };
    if (nu <= 0) {
      // Out: the angle where u reaches 0, the rest of the way from this step's start by its integral.
      const end = phi + tailAngle(u, b);
      return { captured: false, direction: add(scale(er, Math.cos(end)), scale(et, Math.sin(end))), crossings, er, et, b, phi: end, steps };
    }
    u = nu;
    du = ndu;
    phi += h;
  }
  // Round the photon sphere twice and more: its light is lost to it.
  return { captured: true, direction: [0, 0, 0], crossings, er, et, b, phi, steps: TRACE.steps };
}

/**
 * The shift of light from gas on a circular orbit in the disc (prograde about `normal`) at radius
 * `r` (r_s), seen by a camera hanging still at `cameraR` along a ray whose plane is (er, et) and
 * impact parameter b: g = nu_seen / nu_sent.
 */
export function discShift(r: number, er: V3, et: V3, b: number, normal: V3, cameraR: number): number {
  if (r <= PHOTON_SPHERE) return 0;
  const omega = Math.sqrt(1 / (2 * r * r * r));
  // The light travels against the traced direction: its angular momentum about the disc's axis, per unit energy.
  const lambda = -b * dot(cross(er, et), normal);
  return Math.sqrt(1 - 1.5 / r) / (1 - omega * lambda) / Math.sqrt(Math.max(1e-9, 1 - 1 / cameraR));
}

/** A thin disc's temperature across it (Shakura and Sunyaev 1973, no torque at its inner edge), as a share of its hottest. */
export function discTemperature(r: number, inner = ISCO): number {
  if (r <= inner) return 0;
  const t = (r ** -3 * (1 - Math.sqrt(inner / r))) ** 0.25;
  // Hottest at r = (49/36) inner.
  const hot = (inner * 49) / 36;
  const peak = (hot ** -3 * (1 - Math.sqrt(inner / hot))) ** 0.25;
  return t / peak;
}
