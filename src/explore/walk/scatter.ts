import type { Texture } from 'three/webgpu';
import { clamp, dot, exp, float, length, Loop, max, min, select, sqrt, vec3 } from 'three/tsl';
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
 * `eye` is the eye's place from the world's centre and `sun` the Sun's direction, both in the render
 * frame (the integral needs only their dot products and lengths), in radii; to be called inside a Fn.
 */
export function scatter(air: AirModel, table: Texture, eye: Vec3Node, ray: Vec3Node, sun: Vec3Node, steps: number, limit: FloatNode | null): { light: Vec3Node; transmittance: Vec3Node } {
  const b = dot(eye, ray);
  const c = dot(eye, eye);
  const top = sqrt(max(b.mul(b).sub(c).add(air.top * air.top), 0)).sub(b);
  const disc = b.mul(b).sub(c).add(1);
  const tGround = b.negate().sub(sqrt(max(disc, 0)));
  const reach = select(disc.greaterThan(0).and(tGround.greaterThan(0)), tGround, max(top, 0));
  const end = limit ? min(reach, limit) : reach;
  const [tr, tg, tb] = air.verticalDepth;
  const tau = vec3(tr, tg, tb);
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr, rg, rb);
  const column = vec3(0, 0, 0).toVar();
  const sumR = vec3(0, 0, 0).toVar();
  const sumM = vec3(0, 0, 0).toVar();
  const sumMs = vec3(0, 0, 0).toVar();
  Loop(steps, ({ i }) => {
    const u = float(i).add(0.5).div(steps);
    const t = end.mul(u).mul(u);
    const dt = end.mul(float(i).mul(2).add(1)).div(steps * steps);
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
