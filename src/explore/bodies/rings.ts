/**
 * Saturn's rings from the Cassini ring strip (assets/planets saturn/rings: 8192 texels across the
 * radio-occultation profile's span, opacity from the RSS optical depth and the lit face's colour from
 * the PIA11142 mosaic, straight alpha). Until it arrives they show the same occultation profile at
 * 2,048 bins (physical.json) in the strip's encoding, so they are right from the first frame and
 * only sharpen. The strip is mipmapped: ringlets finer than a pixel average out instead of shimmering.
 *
 * Light: a thin layer of icy particles, single scattering, with the ring plane's own normal. The lit
 * face reflects w P / 4 * mu0 / (mu0 + mu) * (1 - exp(-tau (1/mu0 + 1/mu))); seen from the unlit side
 * the light comes through the layer, w P / 4 * mu0 / (mu - mu0) * (exp(-tau/mu) - exp(-tau/mu0)), bright
 * where the ring is thin and dark where it is opaque. The particles scatter mostly back toward the Sun;
 * the dusty, thin rings (the C ring, the Cassini Division, the ringlets) also scatter forward, so a
 * backlit ring brightens where it is thinnest. The strip's colour is a thick ring's lit face as the
 * PIA11142 mosaic recorded it, so the law is divided by its value in the mosaic's geometry: the rings
 * look as the mosaic shows them where they are lit as it was, dimmer as the Sun lowers toward their
 * plane (late 2026, just after the 2025 equinox, they are dim, as they should be) and brighter as it
 * rises (2032). The globe's shadow falls on them, and theirs on the globe (ringShadow).
 *
 * Up close, with 'particles' detail, a sparse field of particles (./ring-particles) fades in.
 */

import { DoubleSide, Group, Mesh, MeshBasicNodeMaterial, RingGeometry, Vector3, type Object3D } from 'three/webgpu';
import { abs, dFdx, dFdy, dot, exp, float, fwidth, length, log, max, min, mix, normalize, positionLocal, pow, select, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { MapSlot } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import { blendPremultiplied } from '../render/blending';
import type { FloatNode, Vec3Node, Vec4Node } from '../render/sampling';
import { createRingParticles, type RingParticles } from './ring-particles';

/** The strip's radial span in planet radii (from radiusKm[0] at u = 0 to radiusKm[1] at u = 1). */
export interface RingSpan {
  inner: number;
  outer: number;
}

const SEGMENTS: Readonly<Record<ExploreDetail['tier'], number>> = { ultra: 512, high: 512, medium: 384, low: 256 };
/** Opacity of the strip's most opaque texels (the B ring's cores) reads as this optical depth at most. */
const MAX_TAU = 5;
/** The phase function's lobes: back-scattering regolith, forward-scattering dust (asymmetries, illustrative). */
const LOBES = { back: -0.35, forward: 0.6, forwardShare: [0.12, 0.5] } as const;

/** The same phase function in plain numbers (for the normalisation). */
function phaseJs(cosScatter: number, dusty: number): number {
  const hg = (g: number): number => (1 - g * g) / (1 + g * g - 2 * g * cosScatter) ** 1.5;
  const forward = LOBES.forwardShare[0] + (LOBES.forwardShare[1] - LOBES.forwardShare[0]) * dusty;
  return hg(LOBES.back) * (1 - forward) + hg(LOBES.forward) * forward;
}

/** The strip at radial share s, with gradients from s itself: (colour as linear rgb, normal opacity). */
function strip(slot: MapSlot, s: FloatNode): Vec4Node {
  const scale = slot.blur.exp2();
  const value = slot.node.sample(vec2(s, 0.5)).grad(vec2(dFdx(s), 0).mul(scale), vec2(dFdy(s), 0).mul(scale)) as unknown as Vec4Node;
  return mix(slot.mean, value, slot.arrive);
}

/** Normal optical depth from the strip's normal opacity a = 1 - exp(-tau). */
function depthOf(opacity: FloatNode): FloatNode {
  return min(log(max(float(1).sub(opacity), 1e-4)).negate(), MAX_TAU);
}

/**
 * The particles' phase function of the scattering angle (cos 1: light going on as it came, -1:
 * straight back toward the Sun), mean 1: mostly back toward the Sun as icy regolith scatters, with a
 * forward lobe from dust that is strongest where the ring is thin.
 */
function phase(cosScatter: FloatNode, dusty: FloatNode): FloatNode {
  const hg = (g: number): FloatNode => float(1 - g * g).div(pow(float(1 + g * g).sub(cosScatter.mul(2 * g)), 1.5));
  const forward = mix(float(LOBES.forwardShare[0]), float(LOBES.forwardShare[1]), dusty);
  return hg(LOBES.back).mul(float(1).sub(forward)).add(hg(LOBES.forward).mul(forward));
}

export interface ExploreRings {
  readonly object: Group;
  /** Sun direction and the eye in the rings' (the planet's) own frame, planet radii; sunlight; seconds. */
  update(sunLocal: Vector3, eyeLocal: Vector3, light: number, time: number): void;
  /** Fills the particle field's camera-dependent state (call after update, with the planet's radius in km and its world matrix). */
  readonly particles: RingParticles | null;
  prepare(detail: ExploreDetail): Object3D[];
  apply(detail: ExploreDetail): void;
  dispose(): void;
}

/**
 * The rings as a disc in the planet's equator (local y up), radii in planet radii. `polar` is the
 * globe's polar radius (for its shadow on the rings).
 */
export function createRings(slot: MapSlot, span: RingSpan, polar: number, mosaic: { mu0: number; mu: number; phaseRad: number }, initial: ExploreDetail): ExploreRings {
  const object = new Group();
  object.name = 'explore-saturn-ring-system';
  const uSun = uniform(new Vector3(0, 1, 0));
  const uEye = uniform(new Vector3(0, 1, 3));
  const uLight = uniform(1);
  const radius = length(positionLocal.xz);
  const s = radius.sub(span.inner).div(span.outer - span.inner);
  const texel = strip(slot, s);
  const inside = smoothstep(-0.001, 0, s).mul(float(1).sub(smoothstep(1, 1.001, s)));
  const tau = depthOf(texel.w).mul(inside);
  const view = normalize(uEye.sub(positionLocal));
  const mu = max(abs(view.y), 1e-3);
  const mu0 = max(abs(uSun.y), 1e-3);
  const dusty = float(1).sub(smoothstep(0.05, 0.8, tau));
  // The strip's colour is a thick ring's lit face in the mosaic's geometry, so the law is divided by
  // its value there: the rings show as the mosaic shows them where they are lit as it was.
  const atMosaic = phaseJs(-Math.cos(mosaic.phaseRad), 0) * (mosaic.mu0 / (mosaic.mu0 + mosaic.mu));
  // Sunlight travels along -sun and leaves toward the eye along view.
  const p = phase(dot(view, uSun).negate(), dusty).div(atMosaic);
  const reflected = p.mul(mu0.div(mu0.add(mu))).mul(float(1).sub(exp(tau.mul(float(1).div(mu0).add(float(1).div(mu))).negate())));
  const near = abs(mu.sub(mu0)).lessThan(1e-3);
  const throughFar = mu0.div(mu.sub(mu0)).mul(exp(tau.div(mu).negate()).sub(exp(tau.div(mu0).negate())));
  const throughNear = tau.mul(mu0).div(mu.mul(mu)).mul(exp(tau.div(mu).negate()));
  const transmitted = p.mul(select(near, throughNear, throughFar));
  // The lit face is the one on the Sun's side of the ring plane, softened over a pixel at a crossing.
  const sameSide = view.y.mul(uSun.y);
  const lit = smoothstep(max(fwidth(sameSide), 1e-6).negate(), max(fwidth(sameSide), 1e-6), sameSide);
  let light: FloatNode = mix(transmitted, reflected, lit);
  // The globe's shadow: does the ray from here toward the Sun meet the (flattened) globe?
  const q = vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z);
  const l = normalize(vec3(uSun.x, uSun.y.div(polar), uSun.z));
  const b = dot(q, l);
  const miss = dot(q, q).sub(b.mul(b));
  const edge = max(fwidth(miss), 1e-4);
  const shadow = float(1).sub(smoothstep(float(1).sub(edge), float(1).add(edge), miss)).mul(smoothstep(0, 0.02, b.negate()));
  light = light.mul(float(1).sub(shadow.mul(0.97)));
  const colour: Vec3Node = texel.xyz.mul(light);
  const material = blendPremultiplied(new MeshBasicNodeMaterial({ side: DoubleSide, transparent: true, depthWrite: false, fog: false }));
  material.colorNode = colour.mul(uLight);
  // What the rings let through of what is behind them, along this line of sight.
  material.opacityNode = float(1).sub(exp(tau.div(mu).negate()));
  const geometries = new Map<number, RingGeometry>();
  const ringGeometry = (segments: number): RingGeometry => {
    let g = geometries.get(segments);
    if (!g) {
      g = new RingGeometry(span.inner, span.outer, segments, 1);
      g.rotateX(-Math.PI / 2);
      geometries.set(segments, g);
    }
    return g;
  };
  const mesh = new Mesh(ringGeometry(SEGMENTS[initial.tier]), material);
  mesh.name = 'explore-saturn-rings';
  object.add(mesh);
  // The particles are placed in the render frame itself (camera-relative), not in the planet's: the
  // explorer adds them to its root (Bodies.extras).
  const particles = createRingParticles(slot, span);
  particles.setEnabled(initial.ringDetail === 'particles');

  return {
    object,
    particles,
    update(sunLocal, eyeLocal, light) {
      uSun.value.copy(sunLocal);
      uEye.value.copy(eyeLocal);
      uLight.value = light;
    },
    prepare(detail) {
      return detail.ringDetail === 'particles' && !particles.enabled ? particles.warmUp() : [];
    },
    apply(detail) {
      mesh.geometry = ringGeometry(SEGMENTS[detail.tier]);
      particles.setEnabled(detail.ringDetail === 'particles');
    },
    dispose() {
      for (const g of geometries.values()) g.dispose();
      material.dispose();
      particles.dispose();
    },
  };
}

/** The rings' transmission of sunlight onto a point of the globe (1 where no ring is in the way). */
export function ringShadow(slot: MapSlot, point: Vec3Node, sun: Vec3Node, span: RingSpan): FloatNode {
  const sy = select(sun.y.greaterThanEqual(0), max(sun.y, 1e-4), min(sun.y, -1e-4));
  const along = point.y.negate().div(sy);
  const hit = point.add(sun.mul(along));
  const s = length(hit.xz).sub(span.inner).div(span.outer - span.inner);
  const inside = smoothstep(-0.001, 0, s).mul(float(1).sub(smoothstep(1, 1.001, s)));
  const tau = depthOf(strip(slot, s).w).mul(inside);
  const through = exp(tau.div(max(abs(sun.y), 1e-3)).negate());
  const ahead = smoothstep(0, max(fwidth(along), 1e-5), along);
  return mix(float(1), through, ahead);
}
