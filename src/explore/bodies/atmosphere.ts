/**
 * The Earth's air as seen from space: a shell at the top of the atmosphere, drawn over the ground
 * and the clouds (and over whatever lies behind the limb).
 *
 * 'scatter' (Medium and up): single scattering. Each pixel's ray through the air is marched in
 * `steps` steps; at each, the sunlight that reaches it (the transmittance table, the planet's shadow
 * and its penumbra included) scatters toward the eye by Rayleigh's phase and Mie's forward lobe, and
 * is dimmed by the air between it and the eye. Two draws of the shell: the first multiplies what is
 * behind by the ray's transmittance (per colour: the ground reddens toward the limb, stars dim
 * behind it), the second adds the scattered light. Blue limb glow and blue haze over the oceans by
 * day, a warm band where the light grazes the terminator (sunlight that crossed the most air), the
 * air lit above the night side at twilight, and from low orbit the haze that thickens toward the
 * horizon all come out of the same integral.
 *
 * 'chord' (Low): one draw, analytic. The column of air along the ray (Chapman's grazing column over
 * the limb, 1/mu down to the ground), the sunlight reaching its lowest point reddened by its own
 * slant path, scattered by the same phase functions; the green transmittance dims what is behind.
 *
 * Everything is in the Earth's frame in planet radii, so the shell is right at any distance and in
 * scaled space. Sizes and coefficients are the cited reference atmosphere (../render/air).
 */

import {
  AddEquation,
  type Node,
  CustomBlending,
  DstColorFactor,
  FrontSide,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SphereGeometry,
  Vector3,
  ZeroFactor,
  type Texture,
  type UniformNode,
} from 'three/webgpu';
import { dot, exp, float, Fn, int, length, Loop, max, min, normalize, positionLocal, select, smoothstep, sqrt, vec3, vec4 } from 'three/tsl';
import { densities, extinction, miePhase, rayleighPhase, sunTransmittance, transmittanceToTop, type AirModel } from '../render/air';
import type { FloatNode, Vec3Node } from '../render/sampling';

export interface AirUniforms {
  /** The eye in the Earth's frame, planet radii. */
  readonly eye: UniformNode<'vec3', Vector3>;
  /** Unit direction to the Sun, Earth's frame. */
  readonly sun: UniformNode<'vec3', Vector3>;
  /** Sunlight (1 at 1 au). */
  readonly light: UniformNode<'float', number>;
}

/** Ray from the eye through this fragment of the shell: its direction and where it enters and leaves the air. */
function rayThroughShell(air: AirModel, eye: Vec3Node): { ray: Vec3Node; start: FloatNode; end: FloatNode; hits: Node<'bool'>; ground: Vec3Node } {
  const ray = normalize(positionLocal.sub(eye));
  const b = dot(eye, ray);
  const c = dot(eye, eye);
  const discTop = b.mul(b).sub(c).add(air.top * air.top);
  const rootTop = sqrt(max(discTop, 0));
  const start = max(b.negate().sub(rootTop), 0);
  const far = b.negate().add(rootTop);
  const discGround = b.mul(b).sub(c).add(1);
  const tGround = b.negate().sub(sqrt(max(discGround, 0)));
  const hits = discGround.greaterThan(0).and(tGround.greaterThan(0));
  const end = select(hits, tGround, far);
  const ground = eye.add(ray.mul(tGround));
  return { ray, start, end, hits, ground };
}

/**
 * Light scattered more than once, approximated: every sample is also lit by the sky around it, as a
 * uniform glow of the share of sunlight the air's vertical column scatters (bluest where the air is
 * most), fading through twilight. An approximation of the higher orders (not the cited model's own
 * multiple-scattering integral), so the haze is brighter and less saturated than single scattering
 * alone makes it, as real haze is. Isotropic.
 */
const MULTIPLE_SCATTERING = 0.6;
/** Share of the march's steps a ray that reaches the ground takes. */
const GROUND_STEP_SHARE = 0.6;

/** Single scattering along the ray, `steps` steps: the light scattered toward the eye (before the sunlight's strength). */
function scatter(air: AirModel, table: Texture, u: AirUniforms, steps: number): Vec3Node {
  const { ray, start, end, hits } = rayThroughShell(air, u.eye);
  // Rays down to the ground cross a short, smoothly varying column: fewer steps hold it.
  const groundSteps = Math.max(4, Math.ceil(steps * GROUND_STEP_SHARE));
  const countF = select(hits, float(groundSteps), float(steps));
  const count = int(countF);
  const sun = u.sun;
  const [tr, tg, tb] = air.verticalDepth;
  const skyGlow = float(1).sub(exp(vec3(tr, tg, tb).negate())).mul(MULTIPLE_SCATTERING);
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr, rg, rb);
  const result = Fn(() => {
    const dt = max(end.sub(start), 0).div(countF);
    const column = vec3(0, 0, 0).toVar();
    const sumR = vec3(0, 0, 0).toVar();
    const sumM = vec3(0, 0, 0).toVar();
    const sumMs = vec3(0, 0, 0).toVar();
    Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
      const t = start.add(float(i).add(0.5).mul(dt));
      const q = u.eye.add(ray.mul(t));
      const r = length(q);
      const density = densities(air, r.sub(1));
      // Air between the eye and this sample: the column so far and half of this step's.
      const toEye = exp(extinction(air, column.add(density.mul(dt.mul(0.5)))).negate());
      const muSun = dot(q, sun).div(r);
      const toSun = sunTransmittance(air, table, r, muSun);
      const lit = toEye.mul(toSun).mul(dt);
      sumR.addAssign(lit.mul(density.x));
      sumM.addAssign(lit.mul(density.y));
      // The sky's own glow around this sample, scattered toward the eye by both kinds of air.
      const scattering = rayleigh.mul(density.x).add(density.y.mul(air.mieScattering));
      sumMs.addAssign(toEye.mul(dt).mul(smoothstep(-0.25, 0.3, muSun)).mul(scattering));
      column.addAssign(density.mul(dt));
    });
    const cosTheta = dot(ray, sun);
    const single = sumR.mul(rayleigh).mul(rayleighPhase(cosTheta)).add(sumM.mul(air.mieScattering).mul(miePhase(air, cosTheta)));
    // Isotropic phase times pi is 1/4.
    const multiple = sumMs.mul(skyGlow).mul(0.25);
    return vec4(single.add(multiple), 1);
  })();
  return result.rgb;
}

/** The ray's transmittance from the table alone (no march): through to the ground, or across the limb. */
function shellTransmittance(air: AirModel, table: Texture, u: AirUniforms): Vec3Node {
  const { ray, hits, ground } = rayThroughShell(air, u.eye);
  // Down to the ground: the way back up from the ground point to the top along the reversed ray.
  const up = dot(normalize(ground), ray).negate();
  const toGround = transmittanceToTop(air, table, float(1), max(up, 0));
  // Over the limb: twice the horizontal ray from the lowest point to the top.
  const b = dot(u.eye, ray);
  const lowest = sqrt(max(dot(u.eye, u.eye).sub(b.mul(b)), 1));
  const half = transmittanceToTop(air, table, min(lowest, air.top), float(0));
  return select(hits, toGround, half.mul(half));
}

/** The analytic 'chord' air: (in-scattered light, the green share of what it lets through). */
function chord(air: AirModel, u: AirUniforms): { light: Vec3Node; opacity: FloatNode } {
  const { ray, hits } = rayThroughShell(air, u.eye);
  const eye = u.eye;
  const b = dot(eye, ray);
  const closest = eye.sub(ray.mul(b));
  const tangent = length(closest);
  const H = air.rayleighScale;
  // Column in vertical columns: Chapman's grazing column over the limb (sqrt(2 pi R / H), R = 1),
  // 1 / mu where the ray reaches the ground (capped at the grazing value).
  const grazing = Math.sqrt((2 * Math.PI) / H);
  const surfaceCos = sqrt(max(float(1).sub(tangent.mul(tangent)), 0));
  const column = select(hits, min(float(1).div(max(surfaceCos, 1e-3)), grazing), exp(max(tangent.sub(1), 0).div(-H)).mul(grazing));
  const lowest = select(hits, normalize(eye.add(ray.mul(b.negate().sub(surfaceCos)))), closest.div(max(tangent, 1e-6)));
  const [tr, tg, tb] = air.verticalDepth;
  const tau = vec3(tr, tg, tb);
  // Sunlight reaching the lowest point, reddened by its slant path; none in the planet's shadow.
  const muSun = dot(lowest, u.sun);
  const airmass = float(1).div(max(muSun.add(0.12), 0.035));
  const reaching = exp(tau.mul(airmass).negate()).mul(smoothstep(-0.1, 0.02, muSun));
  const scattered = float(1).sub(exp(tau.mul(column).negate()));
  const cosTheta = dot(ray, u.sun);
  // Share of the scattering that is Rayleigh's at each wavelength (the rest is the aerosols').
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr * H, rg * H, rb * H).div(tau);
  const phase = rayleigh.mul(rayleighPhase(cosTheta)).add(float(1).sub(rayleigh).mul(miePhase(air, cosTheta)).mul(0.9));
  return { light: reaching.mul(scattered).mul(phase), opacity: float(1).sub(exp(column.mul(-tg))) };
}

export interface ExploreAir {
  /** The shell's meshes, children of the Earth's group (drawn after its ground and clouds). */
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/** Builds the air for a model: 'scatter' with a baked table and `steps`, or 'chord'. */
export function createAir(air: AirModel, model: 'scatter' | 'chord', steps: number, table: Texture | null, u: AirUniforms, segments: number): ExploreAir {
  const geometry = new SphereGeometry(air.top, segments, Math.round(segments / 2));
  const meshes: Mesh[] = [];
  const materials: MeshBasicNodeMaterial[] = [];
  const shellMaterial = (): MeshBasicNodeMaterial => {
    const m = new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false });
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrcAlpha = ZeroFactor;
    m.blendDstAlpha = OneFactor;
    materials.push(m);
    return m;
  };
  if (model === 'scatter' && table) {
    const through = shellMaterial();
    through.blendSrc = DstColorFactor;
    through.blendDst = ZeroFactor;
    through.colorNode = shellTransmittance(air, table, u);
    through.opacityNode = float(1);
    const glow = shellMaterial();
    glow.blendSrc = OneFactor;
    glow.blendDst = OneFactor;
    glow.colorNode = scatter(air, table, u, steps).mul(u.light);
    glow.opacityNode = float(1);
    const a = new Mesh(geometry, through);
    a.name = 'explore-earth-air-through';
    a.renderOrder = 2;
    const b = new Mesh(geometry, glow);
    b.name = 'explore-earth-air-glow';
    b.renderOrder = 3;
    meshes.push(a, b);
  } else {
    const m = shellMaterial();
    // Premultiplied: what is behind times (1 - opacity), plus the air's own light.
    m.blendSrc = OneFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    const c = chord(air, u);
    m.colorNode = c.light.mul(u.light);
    m.opacityNode = c.opacity;
    const mesh = new Mesh(geometry, m);
    mesh.name = 'explore-earth-air-chord';
    mesh.renderOrder = 2;
    meshes.push(mesh);
  }
  return {
    meshes,
    dispose() {
      geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
