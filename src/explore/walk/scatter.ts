import type { Texture } from 'three/webgpu';
import { clamp, dot, exp, float, length, Loop, max, min, mix, select, smoothstep, sqrt, vec3 } from 'three/tsl';
import { densities, extinction, miePhase, rayleighPhase, sunTransmittance, type AirModel } from '../render/air';
import type { FloatNode, Vec3Node } from '../render/sampling';
import { GROUND_ALBEDO, MULTIPLE, NIGHT_SKY } from './light';

/**
 * The Earth's air seen from inside it, per pixel (the shaders' twin of ./light skyRadiance, which the
 * tests check): along a ray from the eye, single scattering by Rayleigh's and the aerosols' phases,
 * each sample lit by the sunlight that reaches it (the transmittance table: the planet's shadow and its
 * penumbra included), dimmed by the air between it and the eye, plus the light scattered more than
 * once as each sample's share of the light around it (half the ground's, half the sky's). The sky's
 * own pixels march to the top of the air (or the ground); the ground's march only as far as the ground
 * itself, which is the aerial perspective: the far ridges' blue, and the setting Sun's colour on the
 * haze. Steps are denser near the eye, where the air is thickest and the aerosols lie low.
 *
 * From high up (on the way down from orbit: HIGH_EYE) the march starts where the ray enters the air,
 * and its steps move to where the air is: denser toward the ground a ray ends on, and even along one
 * that passes through the air and out (its densest part, near its lowest point, mid-way). Below
 * HIGH_EYE, every height a walker stands at, nothing changes.
 *
 * `eye` is the eye's place from the world's centre and `sun` the Sun's direction, both in the render
 * frame (the integral needs only their dot products and lengths), in radii; to be called inside a Fn.
 */
/** The eye's height (the Earth's radii: 10 and 25 km) from which the steps begin to move from the eye to where the air is, and by which all of them have. */
export const HIGH_EYE = [10 / 6371, 25 / 6371] as const;

export function scatter(air: AirModel, table: Texture, eye: Vec3Node, ray: Vec3Node, sun: Vec3Node, steps: number, limit: FloatNode | null): { light: Vec3Node; transmittance: Vec3Node } {
  const b = dot(eye, ray);
  const c = dot(eye, eye);
  const shell = sqrt(max(b.mul(b).sub(c).add(air.top * air.top), 0));
  const top = shell.sub(b);
  const disc = b.mul(b).sub(c).add(1);
  const tGround = b.negate().sub(sqrt(max(disc, 0)));
  const ground = disc.greaterThan(0).and(tGround.greaterThan(0));
  const reach = select(ground, tGround, max(top, 0));
  const end = limit ? min(reach, limit) : reach;
  // Where the ray enters the air (0 from inside it), and how high the eye is: how far the steps move.
  const start = min(max(b.negate().sub(shell), 0), end);
  const span = end.sub(start);
  const high = smoothstep(HIGH_EYE[0], HIGH_EYE[1], sqrt(c).sub(1));
  // A ray ending on the ground (the ground's own pixels always do) gathers its steps toward that end.
  const toGround = limit ? float(1) : select(ground, float(1), float(0));
  const [tr, tg, tb] = air.verticalDepth;
  const tau = vec3(tr, tg, tb);
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr, rg, rb);
  const column = vec3(0, 0, 0).toVar();
  const sumR = vec3(0, 0, 0).toVar();
  const sumM = vec3(0, 0, 0).toVar();
  const sumMs = vec3(0, 0, 0).toVar();
  Loop(steps, ({ i }) => {
    // Near the eye: (k + 1/2)^2 / n^2 of the way. Toward the far end: the same, mirrored. Even: (k + 1/2) / n.
    const k = float(i);
    const u = k.add(0.5).div(steps);
    const back = float(steps - 0.5).sub(k).div(steps);
    const nearT = u.mul(u);
    const nearDt = k.mul(2).add(1).div(steps * steps);
    const farT = float(1).sub(back.mul(back));
    const farDt = float(steps * 2 - 1).sub(k.mul(2)).div(steps * steps);
    const awayT = mix(u, farT, toGround);
    const awayDt = mix(float(1 / steps), farDt, toGround);
    const t = start.add(span.mul(mix(nearT, awayT, high)));
    const dt = span.mul(mix(nearDt, awayDt, high));
    const q = eye.add(ray.mul(t));
    const r = length(q);
    const density = densities(air, r.sub(1));
    const toEye = exp(extinction(air, column.add(density.mul(dt.mul(0.5)))).negate());
    const muSun = dot(q, sun).div(r);
    const toSun = sunTransmittance(air, table, r, muSun);
    const lit = toEye.mul(toSun).mul(dt);
    sumR.addAssign(lit.mul(density.x));
    sumM.addAssign(lit.mul(density.y));
    // The light around the sample: the sky's (as on the ground: ./light earthSkyLight) and the ground's below.
    const around = float(1).sub(exp(tau.negate())).mul(0.5).mul(clamp(muSun.add(0.1), 0, 1)).add(vec3(...NIGHT_SKY));
    const field = toSun.mul(max(muSun, 0)).add(around).mul(0.5 * GROUND_ALBEDO).add(around.mul(0.5)).mul(MULTIPLE);
    sumMs.addAssign(toEye.mul(dt).mul(field).mul(rayleigh.mul(density.x).add(density.y.mul(air.mieScattering))));
    column.addAssign(density.mul(dt));
  });
  const cos = dot(ray, sun);
  const light = sumR.mul(rayleigh).mul(rayleighPhase(cos)).add(sumM.mul(air.mieScattering).mul(miePhase(air, cos))).add(sumMs);
  return { light, transmittance: exp(extinction(air, column).negate()) };
}
