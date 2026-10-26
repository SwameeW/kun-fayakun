/**
 * The two-body problem solved exactly: a position and velocity carried `dt` seconds along their
 * conic about a point mass `mu` (km^3 s^-2), with universal variables (Danby 1992; Vallado, the
 * KEPLER algorithm), so one routine serves ellipses, parabolas and hyperbolas, forward and back.
 * Newton's method on the universal anomaly from the standard first guesses; an ellipse's time is
 * taken modulo its period first, so a step of many orbits converges as fast as one of a few.
 */

/** Stumpff's functions c2 and c3 of psi. */
function stumpff(psi: number): [number, number] {
  if (psi > 1e-6) {
    const s = Math.sqrt(psi);
    return [(1 - Math.cos(s)) / psi, (s - Math.sin(s)) / (psi * s)];
  }
  if (psi < -1e-6) {
    const s = Math.sqrt(-psi);
    return [(1 - Math.cosh(s)) / psi, (Math.sinh(s) - s) / (-psi * s)];
  }
  // The series about 0, to the terms that matter at |psi| < 1e-6.
  return [0.5 - psi / 24, 1 / 6 - psi / 120];
}

/**
 * Carries a relative state (`r`, km; `v`, km/s; three each, from `at`) `dt` seconds along its
 * two-body orbit about `mu`, writing the result into `out` (six numbers: position, then velocity).
 * Returns false (out untouched) where it cannot: no gravity, a body at the centre, or no convergence.
 */
export function keplerDrift(r: ArrayLike<number>, v: ArrayLike<number>, at: number, mu: number, dt: number, out: number[], outAt = 0): boolean {
  const rx = r[at] ?? 0;
  const ry = r[at + 1] ?? 0;
  const rz = r[at + 2] ?? 0;
  const vx = v[at] ?? 0;
  const vy = v[at + 1] ?? 0;
  const vz = v[at + 2] ?? 0;
  const r0 = Math.hypot(rx, ry, rz);
  if (!(mu > 0) || !(r0 > 0) || !Number.isFinite(dt)) return false;
  const sqrtMu = Math.sqrt(mu);
  const rv = rx * vx + ry * vy + rz * vz;
  const v2 = vx * vx + vy * vy + vz * vz;
  // alpha = 1 / a: positive for an ellipse, 0 for a parabola, negative for a hyperbola.
  const alpha = 2 / r0 - v2 / mu;
  let t = dt;
  let chi: number;
  if (alpha > 1e-12) {
    const period = (2 * Math.PI) / (sqrtMu * alpha ** 1.5);
    t = dt - period * Math.trunc(dt / period);
    chi = sqrtMu * t * alpha;
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    const sign = t >= 0 ? 1 : -1;
    const arg = (-2 * mu * alpha * t) / (rv + sign * Math.sqrt(-mu * a) * (1 - r0 * alpha));
    chi = arg > 0 ? sign * Math.sqrt(-a) * Math.log(arg) : sqrtMu * t / r0;
  } else {
    chi = (sqrtMu * t) / r0;
  }
  if (t === 0) chi = 0;
  let c2: number;
  let c3: number;
  let psi: number;
  let rn: number;
  let converged = t === 0;
  for (let k = 0; k < 60 && !converged; k += 1) {
    psi = chi * chi * alpha;
    [c2, c3] = stumpff(psi);
    rn = chi * chi * c2 + (rv / sqrtMu) * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
    const f = (rv / sqrtMu) * chi * chi * c2 + (1 - r0 * alpha) * chi * chi * chi * c3 + r0 * chi - sqrtMu * t;
    const step = f / rn;
    chi -= step;
    if (Math.abs(step) <= 1e-12 * Math.max(1, Math.abs(chi))) converged = true;
  }
  if (!converged || !Number.isFinite(chi)) return false;
  psi = chi * chi * alpha;
  [c2, c3] = stumpff(psi);
  rn = chi * chi * c2 + (rv / sqrtMu) * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
  const f = 1 - ((chi * chi) / r0) * c2;
  const g = t - ((chi * chi * chi) / sqrtMu) * c3;
  const fdot = (sqrtMu / (rn * r0)) * chi * (psi * c3 - 1);
  const gdot = 1 - ((chi * chi) / rn) * c2;
  out[outAt] = f * rx + g * vx;
  out[outAt + 1] = f * ry + g * vy;
  out[outAt + 2] = f * rz + g * vz;
  out[outAt + 3] = fdot * rx + gdot * vx;
  out[outAt + 4] = fdot * ry + gdot * vy;
  out[outAt + 5] = fdot * rz + gdot * vz;
  return [0, 1, 2, 3, 4, 5].every((k) => Number.isFinite(out[outAt + k]));
}
