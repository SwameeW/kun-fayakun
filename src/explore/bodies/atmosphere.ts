/**
 * The Earth's air as seen from space: a shell at the top of the atmosphere, drawn over the ground
 * and the clouds (and over whatever lies behind the limb).
 *
 * 'scatter' (Medium and up): each pixel's ray through the air is marched in `steps` steps, placed by
 * height where the air is (STEP_CROWDING); at each, the sunlight that reaches it (the transmittance
 * table, the planet's shadow and its penumbra included) scatters toward the eye by Rayleigh's phase and
 * Mie's forward lobe, with the light scattered more than once (../render/air's multiple-scattering
 * table: the sunlit air all round and the ground below), and is dimmed by the air between it and the
 * eye. Two draws of the shell: the first multiplies what is
 * behind by the ray's transmittance (per colour: the ground reddens toward the limb, stars dim
 * behind it), the second adds the scattered light. A cloud deck drawn between the two (CloudDeck) is
 * dimmed only by the air in front of it and hides the light scattered behind it, so the cloud tops
 * meet the sky at the horizon without a seam. Blue limb glow and blue haze over the oceans by
 * day, a warm band where the light grazes the terminator (sunlight that crossed the most air), the
 * air lit above the night side at twilight, and from low orbit the haze that thickens toward the
 * horizon all come out of the same integral.
 *
 * 'chord' (Low): one draw, analytic. The column of air along the ray (Chapman's grazing column over
 * the limb, 1/mu down to the ground), the sunlight reaching its lowest point reddened by its own
 * slant path, scattered by the same phase functions; the green transmittance dims what is behind.
 *
 * Seen from afar the lit air is thinner than a pixel: a pixel's ray would land on one height of it or
 * another and the limb would break into dashes of red and blue. Where a pixel spans more than a
 * fraction of the air's scale height, its light is averaged over a band two pixels high (several rays
 * through the band, or the column's exact average in 'chord'), so the limb is a smooth line of light
 * whose colours blend across it, and never thinner than about two pixels.
 *
 * The night side's airglow: atomic oxygen's green line, from a thin layer at its measured height
 * (data/constants.json earth.airglow.greenLine.height), strongest where the eye looks along the layer:
 * a faint green band above the night limb, so the dark disc has an edge. Its true radiance is far
 * below anything an exposure set for the day side records, so it shows only as the eye adapts to the
 * dark (the Earth's own measure, AirUniforms.airglow: while the night fills the view) and only where
 * the layer itself is in darkness, the Sun some degrees below its horizon; it is then shown as long
 * exposures from orbit show it (illustrative strength and width).
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
import { clamp, dot, exp, float, Fn, fwidth, int, length, Loop, max, min, mix, normalize, positionLocal, select, smoothstep, sqrt, vec3, vec4 } from 'three/tsl';
import { densities, extinction, miePhase, multipleScattering, rayleighPhase, sunTransmittance, transmittanceToTop, type AirModel } from '../render/air';
import type { FloatNode, Vec3Node } from '../render/sampling';

export interface AirUniforms {
  /** The eye in the Earth's frame, planet radii. */
  readonly eye: UniformNode<'vec3', Vector3>;
  /** Unit direction to the Sun, Earth's frame. */
  readonly sun: UniformNode<'vec3', Vector3>;
  /** Sunlight (1 at 1 au). */
  readonly light: UniformNode<'float', number>;
  /** How far the eye is adapted to the dark, 0 to 1: the airglow's share (without it, all of it). */
  readonly airglow?: UniformNode<'float', number>;
}

/**
 * A deck of cloud under the air (the explorer's Earth), drawn between the shell's two draws: the shell
 * first dims what lies behind it, then the cloud tops cover that with their own light, dimmed only by
 * the air between them and the eye, then the shell adds its scattered light, all of it in front of a
 * cloud top and, behind one, as much as the cloud lets through. So a cloud top keeps only the air
 * between it and the eye, wherever it is, and nothing flips at the horizon.
 */
export interface CloudDeck {
  /** The deck's radius (1 is the ground). */
  readonly radius: number;
  /**
   * How much of what lies behind it the deck hides where the pixel's ray meets it (0 to 1): unit
   * direction there, and the cosine between the ray toward the eye and the vertical there.
   */
  opacity(direction: Vec3Node, up: FloatNode): FloatNode;
}

/**
 * Where a ray from `eye` (outside it) along unit `ray` meets a sphere of `radius`: the unit direction of
 * the point, the cosine between the ray toward the eye and the vertical there, and how much of the
 * pixel the sphere covers (its outline smoothed over a pixel). The cloud deck's mesh and the air's shell
 * both find the deck this way, so they agree on it to the pixel, its outline included (a mesh's own is
 * a polygon, inside the sphere by up to a few kilometres between its vertices).
 */
export function deckCrossing(eye: Vec3Node, ray: Vec3Node, radius: number): { direction: Vec3Node; up: FloatNode; coverage: FloatNode } {
  const b = dot(eye, ray);
  const disc = b.mul(b).sub(dot(eye, eye)).add(radius * radius);
  const direction = normalize(eye.add(ray.mul(b.negate().sub(sqrt(max(disc, 0))))));
  const coverage = clamp(disc.div(max(fwidth(disc), 1e-12)).add(0.5), 0, 1);
  return { direction, up: max(dot(direction, ray).negate(), 0), coverage };
}

/** Where a ray from `eye` along `ray` enters and leaves the air, and whether it meets the ground. */
function shellSegment(air: AirModel, eye: Vec3Node, ray: Vec3Node): { start: FloatNode; end: FloatNode; hits: Node<'bool'>; tGround: FloatNode } {
  const b = dot(eye, ray);
  const c = dot(eye, eye);
  const discTop = b.mul(b).sub(c).add(air.top * air.top);
  const rootTop = sqrt(max(discTop, 0));
  const start = max(b.negate().sub(rootTop), 0);
  const far = b.negate().add(rootTop);
  const discGround = b.mul(b).sub(c).add(1);
  const tGround = b.negate().sub(sqrt(max(discGround, 0)));
  const hits = discGround.greaterThan(0).and(tGround.greaterThan(0));
  const end = select(hits, tGround, max(far, start));
  return { start, end, hits, tGround };
}

/** The ray from the eye through this fragment of the shell, with its segment through the air. */
function rayThroughShell(air: AirModel, eye: Vec3Node): { ray: Vec3Node; start: FloatNode; end: FloatNode; hits: Node<'bool'>; ground: Vec3Node } {
  const ray = normalize(positionLocal.sub(eye));
  const { start, end, hits, tGround } = shellSegment(air, eye, ray);
  return { ray, start, end, hits, ground: eye.add(ray.mul(tGround)) };
}

/**
 * The pixel's ray at the limb: its closest approach to the centre (the tangent radius), how much
 * that changes from one pixel to the next, and the outward direction at the tangent point.
 */
function limbOf(eye: Vec3Node, ray: Vec3Node): { tangent: FloatNode; perPixel: FloatNode; outward: Vec3Node; toTangent: FloatNode } {
  const b = dot(eye, ray);
  const closest = eye.sub(ray.mul(b));
  const tangent = length(closest);
  return { tangent, perPixel: fwidth(tangent), outward: closest.div(max(tangent, 1e-6)), toTangent: max(b.negate(), 1e-4) };
}

/** A pixel spanning more of the air's height than this share of its Rayleigh scale height is filtered across. */
const COARSE = 0.3;
/** The limb's band, in pixels, its light is spread over where the air is thinner than a pixel. */
const LIMB_PIXELS = 2;
/** Rays through that band. */
const LIMB_RAYS = 4;

/** Share of the march's steps a ray that reaches the ground takes. */
const GROUND_STEP_SHARE = 0.6;
/**
 * Where the march's steps fall: by height, not evenly along the ray. A ray's height falls to its lowest
 * point (the ground it meets, or where it grazes past the limb) and rises after it; the steps' bounds
 * are spread over each side's span of heights as the cube of an even measure, so they crowd where the
 * air is densest and thin out toward the top. Evenly spaced, 12 steps through the 60 km of air are 5
 * km apart (7.5 km for a ray to the ground), and the aerosols, whose scale height is 1.2 km, fell
 * between them: a ray to the ground caught a third of their light or less. Placed by height, the
 * lowest steps are a hundred metres to a kilometre apart and catch nine tenths of it.
 */
const STEP_CROWDING = 3;
/**
 * The airglow as drawn: the layer's half-width (radii, about 4 km: illustrative), its colour (the green
 * line, linear RGB) and the light it adds per radius of layer the eye looks through (illustrative: a
 * long exposure's view of it, not its true radiance).
 */
const AIRGLOW = { width: 4 / 6371, colour: [0.42, 1, 0.48], strength: 0.9 } as const;

/**
 * The airglow the eye sees along `ray`: the layer's column, two crossings for a ray grazing below it,
 * one for a ray that meets the ground, strongest along the layer; only where the layer is in real
 * darkness (sunlit, about 95 km up, until the Sun is some 10 degrees below the horizon there, and the
 * day's sky swamps it).
 */
function airglow(air: AirModel, eye: Vec3Node, ray: Vec3Node, sun: Vec3Node, hits: Node<'bool'>): Vec3Node {
  const rL = air.airglow;
  const s = AIRGLOW.width;
  const b = dot(eye, ray);
  const closest = eye.sub(ray.mul(b));
  const t2 = dot(closest, closest);
  const t = sqrt(t2);
  const ahead = smoothstep(0, 0.01, b.negate());
  // Per crossing: the layer's vertical column over the cosine of the ray at it, capped at the grazing value.
  const crossing = float(Math.sqrt(2 * Math.PI) * s * rL).div(sqrt(max(float(rL * rL).sub(t2), 0).add(2.5 * rL * s)));
  const above = exp(max(t.sub(rL), 0).div(s).pow(2).mul(-0.5));
  const column = crossing.mul(select(hits, float(1), float(2))).mul(above).mul(ahead);
  const night = smoothstep(-0.05, -0.2, dot(closest.div(max(t, 1e-6)), sun));
  return vec3(...AIRGLOW.colour).mul(column.mul(night).mul(AIRGLOW.strength));
}

/** The cloud deck as one ray sees it: the deck's radius and how much it hides there (0 where the ray misses it). */
interface DeckOnRay {
  readonly radius: number;
  readonly hides: FloatNode;
}

/** Single scattering along one ray, `steps` steps: the light scattered toward the eye (before the sunlight's strength). */
function march(air: AirModel, table: Texture, u: AirUniforms, ray: Vec3Node, steps: number, deck: DeckOnRay | null): Vec3Node {
  const { start, end, hits } = shellSegment(air, u.eye, ray);
  // Rays down to the ground cross a short, smoothly varying column: fewer steps hold it.
  const groundSteps = Math.max(4, Math.ceil(steps * GROUND_STEP_SHARE));
  const countF = select(hits, float(groundSteps), float(steps));
  const count = int(countF);
  const sun = u.sun;
  const [rr, rg, rb] = air.rayleigh;
  const rayleigh = vec3(rr, rg, rb);
  // The ray's lowest point in the air (STEP_CROWDING): its tangent, or its end at the ground. Distances
  // along the ray are taken from the tangent (tc), heights from the tangent's radius, so neither loses
  // precision far from the planet.
  const b = dot(u.eye, ray);
  const tc = b.negate();
  const closest = u.eye.sub(ray.mul(b));
  const tangent2 = dot(closest, closest);
  const hc = sqrt(tangent2).sub(1);
  const heightAt = (t: FloatNode): FloatNode => {
    const along = t.sub(tc);
    return sqrt(along.mul(along).add(tangent2)).sub(1);
  };
  // Where the ray meets the cloud deck, as a signed distance from the tangent like the steps' bounds
  // (the deck's share of the pixel is in deck.hides: deckCrossing).
  const cut = deck ? sqrt(max(b.mul(b).sub(dot(u.eye, u.eye)).add(deck.radius * deck.radius), 0)).negate() : float(0);
  const hides = deck ? deck.hides : float(0);
  const lowest = heightAt(min(max(tc, start), end));
  const down = max(heightAt(start).sub(lowest), 0);
  const up = max(heightAt(end).sub(lowest), 0);
  // The share of the steps on the way down: all of them for a ray to the ground, about half across the limb.
  const split = select(hits, float(1), down.div(max(down.add(up), 1e-9)));
  /** The bound `v` of the way along the steps (0 the start, 1 the end), as a signed distance from the tangent. */
  const bound = (v: FloatNode): FloatNode => {
    const falling = hits.or(v.lessThan(split));
    const x = clamp(select(falling, split.sub(v).div(max(split, 1e-6)), v.sub(split).div(max(float(1).sub(split), 1e-6))), 0, 1);
    const h = lowest.add(select(falling, down, up).mul(x.pow(STEP_CROWDING)));
    const s = sqrt(max(h.sub(hc).mul(h.add(hc).add(2)), 0));
    return select(falling, s.negate(), s);
  };
  const before = bound(float(0)).toVar();
  const column = vec3(0, 0, 0).toVar();
  const sumR = vec3(0, 0, 0).toVar();
  const sumM = vec3(0, 0, 0).toVar();
  const sumMs = vec3(0, 0, 0).toVar();
  Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }) => {
    // (Held in variables: the bound carried to the next step is replaced at the end of this one.)
    const after = bound(float(i).add(1).div(countF)).toVar();
    const dt = after.sub(before).toVar();
    const t = tc.add(before.add(after).mul(0.5));
    const q = u.eye.add(ray.mul(t)).toVar();
    const r = length(q);
    const density = densities(air, r.sub(1));
    // Air between the eye and this sample: the column so far and half of this step's.
    const toEye = exp(extinction(air, column.add(density.mul(dt.mul(0.5)))).negate());
    const muSun = dot(q, sun).div(r);
    const toSun = sunTransmittance(air, table, r, muSun);
    // Air between the eye and this step, as far of it as lies in front of the cloud deck, and what of
    // the rest the deck lets through.
    const seen = deck ? dt.mul(float(1).sub(clamp(after.sub(cut).div(max(dt, 1e-9)), 0, 1).mul(hides))) : dt;
    const lit = toEye.mul(toSun).mul(seen);
    sumR.addAssign(lit.mul(density.x));
    sumM.addAssign(lit.mul(density.y));
    // The light scattered more than once about this sample (the sunlit air all round it and the
    // ground below: ../render/air's table), scattered toward the eye by both kinds of air.
    const scattering = rayleigh.mul(density.x).add(density.y.mul(air.mieScattering));
    sumMs.addAssign(toEye.mul(seen).mul(scattering).mul(multipleScattering(air, table, r, muSun)));
    column.addAssign(density.mul(dt));
    before.assign(after);
  });
  const cosTheta = dot(ray, sun);
  const single = sumR.mul(rayleigh).mul(rayleighPhase(cosTheta)).add(sumM.mul(air.mieScattering).mul(miePhase(air, cosTheta)));
  return single.add(sumMs);
}

/**
 * Single scattering for this pixel: one ray, or where the limb is thinner than the pixel, several
 * rays spread across a band LIMB_PIXELS high, averaged. Plus the airglow (its own light, not the Sun's).
 */
function scatter(air: AirModel, table: Texture, u: AirUniforms, steps: number, deck: CloudDeck | null): Vec3Node {
  const { ray } = rayThroughShell(air, u.eye);
  const light = Fn(() => {
    // Built here, before any branch or loop: the pixel's span comes from screen-space derivatives
    // (and so does the cloud deck's map, read where this pixel's ray meets it: its sub-rays share it).
    let onRay: DeckOnRay | null = null;
    if (deck) {
      const at = deckCrossing(u.eye, ray, deck.radius);
      onRay = { radius: deck.radius, hides: deck.opacity(at.direction, at.up).mul(at.coverage).toVar() };
    }
    const limb = limbOf(u.eye, ray);
    const perPixel = limb.perPixel.toVar();
    const tangent = limb.tangent.toVar();
    const coarse = perPixel
      .greaterThan(air.rayleighScale * COARSE)
      .and(tangent.lessThan(float(air.top).add(perPixel.mul(LIMB_PIXELS))))
      .and(tangent.greaterThan(float(1).sub(perPixel.mul(LIMB_PIXELS * 2))));
    const rays = select(coarse, int(LIMB_RAYS), int(1)).toVar();
    // The band the rays spread across (none when the limb is resolved: the one ray goes straight).
    const band = select(coarse, perPixel.mul(LIMB_PIXELS), float(0)).toVar();
    const outward = limb.outward.toVar();
    const toTangent = limb.toTangent.toVar();
    const total = vec3(0, 0, 0).toVar();
    Loop({ start: int(0), end: rays, type: 'int', condition: '<' }, ({ i }) => {
      const offset = float(i).add(0.5).div(LIMB_RAYS).sub(0.5).mul(band);
      const sub = normalize(ray.add(outward.mul(offset.div(toTangent))));
      total.addAssign(march(air, table, u, sub, steps, onRay));
    });
    return vec4(total.div(float(rays)), 1);
  })().rgb;
  return light.mul(u.light);
}

/**
 * What the shell lets through along a ray from `eye` (unit `ray`, the Earth's frame in radii), from the
 * table alone (no march): down to the ground, or across the limb. The shell multiplies whatever lies
 * behind it by this (the ground, the sky behind the limb; a cloud deck is drawn after it: CloudDeck).
 */
function airThrough(air: AirModel, table: Texture, eye: Vec3Node, ray: Vec3Node): Vec3Node {
  const { tGround } = shellSegment(air, eye, ray);
  // Down to the ground: the way back up from the ground point to the top along the reversed ray.
  const up = dot(normalize(eye.add(ray.mul(tGround))), ray).negate();
  const toGround = transmittanceToTop(air, table, float(1), max(up, 0));
  // Over the limb: twice the horizontal ray from the lowest point to the top.
  const b = dot(eye, ray);
  const tangent = sqrt(max(dot(eye, eye).sub(b.mul(b)), 0));
  const half = transmittanceToTop(air, table, min(max(tangent, 1), air.top), float(0));
  // From one to the other across the horizon over a pixel: a ray just over it crosses twice the air
  // of one just short of it (a hard step would alias into a dashed line).
  const pixel = max(fwidth(tangent), 1e-7);
  return mix(toGround, half.mul(half), smoothstep(pixel.negate(), pixel, tangent.sub(1)));
}

/** The shell's own pixel's transmittance (airThrough). */
function shellTransmittance(air: AirModel, table: Texture, u: AirUniforms): Vec3Node {
  const { ray } = rayThroughShell(air, u.eye);
  return airThrough(air, table, u.eye, ray);
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
  const exact = select(hits, min(float(1).div(max(surfaceCos, 1e-3)), grazing), exp(max(tangent.sub(1), 0).div(-H)).mul(grazing));
  // Where the limb is thinner than the pixel, the column's average over a band LIMB_PIXELS high
  // (the part of the band below the ground counted at the grazing column).
  const perPixel = fwidth(tangent);
  const band = max(perPixel.mul(LIMB_PIXELS), 1e-6);
  const lo = tangent.sub(band.mul(0.5));
  const hi = tangent.add(band.mul(0.5));
  const below = min(max(float(1).sub(lo), 0), band);
  const aloft = exp(max(lo, 1).sub(1).div(-H)).sub(exp(max(hi, 1).sub(1).div(-H))).mul(H);
  const averaged = below.add(aloft).mul(grazing).div(band);
  // Only at the limb: a ray well inside the disc meets the ground, where the exact column holds.
  const atLimb = smoothstep(float(1).sub(band.mul(2)), float(1).sub(band), tangent);
  const column = mix(exact, averaged, smoothstep(H * COARSE * 0.5, H * COARSE * 1.5, perPixel).mul(atLimb));
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
  const light = reaching.mul(scattered).mul(phase).mul(u.light);
  return { light, opacity: float(1).sub(exp(column.mul(-tg))) };
}

/** The shell's draws in order: what is behind dimmed, then (a cloud deck between) the scattered light added. */
export const AIR_ORDER = { through: 2, glow: 3 } as const;

export interface ExploreAir {
  /** The shell's meshes, children of the Earth's group (drawn after its ground and clouds). */
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/**
 * Builds the air for a model: 'scatter' with a baked table and `steps`, or 'chord'. With a cloud deck
 * ('scatter' only) the deck's mesh is to be drawn between the shell's two draws (renderOrder between
 * AIR_ORDER.through and AIR_ORDER.glow), its tops dimmed by the air between them and the eye alone.
 */
export function createAir(air: AirModel, model: 'scatter' | 'chord', steps: number, table: Texture | null, u: AirUniforms, segments: number, deck: CloudDeck | null = null): ExploreAir {
  const geometry = new SphereGeometry(air.top, segments, Math.round(segments / 2));
  // The airglow's own shell, out to just above its layer (above the scattering air's top). From the
  // lowest orbit its nearest part is inside the depth range's near plane; there the eye looks
  // straight through the layer, whose light is then negligible.
  const glowGeometry = new SphereGeometry(air.airglow + 4 * AIRGLOW.width, segments, Math.round(segments / 2));
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
    glow.colorNode = scatter(air, table, u, steps, deck);
    glow.opacityNode = float(1);
    const a = new Mesh(geometry, through);
    a.name = 'explore-earth-air-through';
    a.renderOrder = AIR_ORDER.through;
    const b = new Mesh(geometry, glow);
    b.name = 'explore-earth-air-glow';
    b.renderOrder = AIR_ORDER.glow;
    meshes.push(a, b);
  } else {
    const m = shellMaterial();
    // Premultiplied: what is behind times (1 - opacity), plus the air's own light.
    m.blendSrc = OneFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    const c = chord(air, u);
    m.colorNode = c.light;
    m.opacityNode = c.opacity;
    const mesh = new Mesh(geometry, m);
    mesh.name = 'explore-earth-air-chord';
    mesh.renderOrder = 2;
    meshes.push(mesh);
  }
  const night = shellMaterial();
  night.blendSrc = OneFactor;
  night.blendDst = OneFactor;
  const { ray, hits } = rayThroughShell(air, u.eye);
  const glow = airglow(air, u.eye, ray, u.sun, hits);
  night.colorNode = u.airglow ? glow.mul(u.airglow) : glow;
  night.opacityNode = float(1);
  const glowMesh = new Mesh(glowGeometry, night);
  glowMesh.name = 'explore-earth-airglow';
  glowMesh.renderOrder = 4;
  meshes.push(glowMesh);
  return {
    meshes,
    dispose() {
      geometry.dispose();
      glowGeometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
