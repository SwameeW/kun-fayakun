import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicNodeMaterial, Vector3, Vector4, type Node } from 'three/webgpu';
import { abs, attribute, clamp, cos, cross, dot, exp, float, floor, int, length, max, min, mix, normalize, select, sin, smoothstep, uniform, uniformArray, varying } from 'three/tsl';
import { blendPremultiplied } from '../render/blending';

/**
 * A ring seen as a ring (docs/SANDBOX-ROADMAP.md W1.8): once a swarm's particles have spread round
 * their body (no gap wider than 30 degrees where fewer than a quarter of their mean share lie:
 * ringCoverage at least 330 degrees), a band fades in
 * where they are, in the plane of their mean orbit, its radial profile a 64-bin histogram of their
 * distances (updated with every snapshot). It is lit as a thin layer of grains scattering once
 * (Chandrasekhar's single-scattering law, as Saturn's rings are: ./bodies/rings), in the swarm's own
 * colour and albedo, and the body's shadow falls across it. Its optical depth is illustrative: the
 * dust's mass is not modelled (the tracers are massless), so only its shape is the model's. The
 * particles stay drawn over it, fainter. A belt about a star is not drawn as a band (its real optical
 * depth is far too small to see). One draw call each.
 */

/** Bins of the radial profile, angular and radial segments of the band. */
export const PROFILE_BINS = 64;
const SEGMENTS = 192;
const RINGS = 6;
/** The arc (degrees) a swarm's particles must cover for it to count as a ring, and the share of their mean density a five-degree stretch must hold to count as covered. */
export const RING_FORMED = { arcDeg: 330, density: 0.25 } as const;
/** The band's greatest optical depth (illustrative, see above). */
const TAU_MAX = 0.8;
/** The single-scattering law is normalised as the rocks' Lommel-Seeliger law is (incidence 30 degrees, emission 0): an opaque band is as bright as ground of its albedo. */
const LS_STANDARD = (2 * Math.cos(Math.PI / 6)) / (Math.cos(Math.PI / 6) + 1);

export interface AnnulusFrame {
  /** The primary's centre as drawn (camera-relative, scaled space), the scale factor of that space there, and the primary's radius (km, true). */
  centre: [number, number, number];
  k: number;
  primaryKm: number;
  /** The band's plane (two unit vectors in it, render frame), radii (km, true) and profile (PROFILE_BINS values, 0 to 1). */
  e1: [number, number, number];
  e2: [number, number, number];
  innerKm: number;
  outerKm: number;
  profile: Float32Array;
  /** The light: direction to the star (unit, render frame) and its strength; albedo, tint, and how much of the band shows (0 to 1). */
  light: [number, number, number, number];
  albedo: number;
  tint: [number, number, number];
  weight: number;
}

export interface Annulus {
  readonly object: Mesh;
  update(frame: AnnulusFrame | null): void;
  dispose(): void;
}

/**
 * How many degrees round their primary a swarm's particles cover (`rel`: places relative to it, three a
 * particle, in a plane with pole `normal`): the five-degree stretches (of 72) holding at least
 * `density` of the mean share, times five. A ring spread evenly covers about 360, a clump its arc.
 */
export function ringCoverage(rel: ArrayLike<number>, normal: readonly number[], density: number = RING_FORMED.density, bins = 72): number {
  const n = Math.floor(rel.length / 3);
  if (n === 0) return 0;
  const [nx, ny, nz] = [normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 1];
  // Two axes in the plane.
  const hx = Math.abs(nz) < 0.9 ? 0 : 1;
  const hz = Math.abs(nz) < 0.9 ? 1 : 0;
  // n x h, h a helper away from n.
  let ax = ny * hz;
  let ay = nz * hx - nx * hz;
  let az = -ny * hx;
  const la = Math.hypot(ax, ay, az) || 1;
  ax /= la;
  ay /= la;
  az /= la;
  const bx = ny * az - nz * ay;
  const by = nz * ax - nx * az;
  const bz = nx * ay - ny * ax;
  const counts = new Uint32Array(bins);
  for (let i = 0; i < n; i += 1) {
    const x = rel[i * 3] ?? 0;
    const y = rel[i * 3 + 1] ?? 0;
    const z = rel[i * 3 + 2] ?? 0;
    const angle = Math.atan2(x * bx + y * by + z * bz, x * ax + y * ay + z * az);
    const k = Math.min(bins - 1, Math.floor(((angle + Math.PI) / (2 * Math.PI)) * bins));
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const least = (density * n) / bins;
  let covered = 0;
  for (let k = 0; k < bins; k += 1) if ((counts[k] ?? 0) >= least) covered += 1;
  return (covered / bins) * 360;
}

/** The radial profile (PROFILE_BINS values, the densest 1) of particles between `innerKm` and `outerKm`: counts per bin over the bin's area. */
export function radialProfile(rel: ArrayLike<number>, innerKm: number, outerKm: number, out: Float32Array): Float32Array {
  out.fill(0);
  const n = Math.floor(rel.length / 3);
  const span = Math.max(outerKm - innerKm, 1e-9);
  for (let i = 0; i < n; i += 1) {
    const r = Math.hypot(rel[i * 3] ?? 0, rel[i * 3 + 1] ?? 0, rel[i * 3 + 2] ?? 0);
    const k = Math.floor(((r - innerKm) / span) * PROFILE_BINS);
    if (k >= 0 && k < PROFILE_BINS) out[k] = (out[k] ?? 0) + 1;
  }
  let top = 0;
  for (let k = 0; k < PROFILE_BINS; k += 1) {
    const r0 = innerKm + (span * k) / PROFILE_BINS;
    const r1 = r0 + span / PROFILE_BINS;
    out[k] = (out[k] ?? 0) / Math.max(r1 * r1 - r0 * r0, 1e-9);
    top = Math.max(top, out[k] ?? 0);
  }
  if (top > 0) for (let k = 0; k < PROFILE_BINS; k += 1) out[k] = (out[k] ?? 0) / top;
  return out;
}

export function createAnnulus(): Annulus {
  // A flat strip: u across the band (0 inner, 1 outer), v round it (0 to 1).
  const positions = new Float32Array((SEGMENTS + 1) * (RINGS + 1) * 3);
  const index: number[] = [];
  for (let j = 0; j <= RINGS; j += 1) {
    for (let i = 0; i <= SEGMENTS; i += 1) positions.set([j / RINGS, i / SEGMENTS, 0], (j * (SEGMENTS + 1) + i) * 3);
  }
  for (let j = 0; j < RINGS; j += 1) {
    for (let i = 0; i < SEGMENTS; i += 1) {
      const a = j * (SEGMENTS + 1) + i;
      const b = a + SEGMENTS + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const uCentre = uniform(new Vector3());
  const uE1 = uniform(new Vector3(1, 0, 0));
  const uE2 = uniform(new Vector3(0, 0, 1));
  /** Inner and outer radii as drawn (scaled space), the primary's radius as drawn, and the band's weight. */
  const uShape = uniform(new Vector4());
  const uLight = uniform(new Vector4(1, 0, 0, 1));
  const uLook = uniform(new Vector4(0.12, 0.12, 0.12, 1));
  const uProfile = uniformArray(new Array<number>(PROFILE_BINS).fill(0), 'float');
  const profileValues = uProfile.array as number[];
  const uv0 = attribute('position', 'vec3') as unknown as Node<'vec3'>;
  const radius = mix(uShape.x, uShape.y, uv0.x);
  const angle = uv0.y.mul(2 * Math.PI);
  const world = uCentre.add(uE1.mul(cos(angle).mul(radius))).add(uE2.mul(sin(angle).mul(radius)));
  const material = blendPremultiplied(new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: false }));
  material.positionNode = world;
  const vWorld = varying(world);
  const vAcross = varying(uv0.x);
  // The profile at this radius, read between its bins.
  const at = vAcross.mul(PROFILE_BINS - 1);
  const i0 = clamp(floor(at), 0, PROFILE_BINS - 1);
  const f = at.sub(i0);
  const p0 = uProfile.element(int(i0)) as unknown as Node<'float'>;
  const p1 = uProfile.element(int(min(i0.add(1), PROFILE_BINS - 1))) as unknown as Node<'float'>;
  const tau = mix(p0, p1, f).mul(TAU_MAX).mul(uShape.w).max(0);
  const normal = normalize(cross(uE1, uE2));
  const view = normalize(vWorld.negate());
  const mu = max(abs(dot(normal, view)), 0.02);
  const mu0 = max(abs(dot(normal, uLight.xyz)), 0.02);
  // Lit face: the viewer on the star's side of the plane; else the light comes through the layer.
  const sameSide = dot(normal, view).mul(dot(normal, uLight.xyz)).greaterThan(0);
  const front = mu0.mul(2).div(mu0.add(mu)).mul(float(1).sub(exp(tau.negate().mul(float(1).div(mu0).add(float(1).div(mu))))));
  const back = mu0.mul(2).div(max(abs(mu.sub(mu0)), 1e-3)).mul(abs(exp(tau.negate().div(mu)).sub(exp(tau.negate().div(mu0)))));
  const scatter = select(sameSide, front, back).div(LS_STANDARD).mul(uLook.w);
  // The primary's shadow: behind it from the star, within its radius (softened over a hundredth of it).
  const s = vWorld.sub(uCentre);
  const along = dot(s, uLight.xyz);
  const off = length(s.sub(uLight.xyz.mul(along)));
  const shadow = select(along.lessThan(0), smoothstep(uShape.z.mul(0.99), uShape.z.mul(1.01), off), float(1));
  const lit = scatter.mul(shadow).mul(uLight.w);
  const alpha = float(1).sub(exp(tau.negate().div(mu)));
  material.colorNode = uLook.xyz.mul(lit);
  material.opacityNode = alpha;
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.name = 'lab-annulus';
  mesh.renderOrder = -1;
  return {
    object: mesh,
    update(frame) {
      if (!frame || frame.weight <= 1e-3) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      uCentre.value.set(frame.centre[0], frame.centre[1], frame.centre[2]);
      uE1.value.set(frame.e1[0], frame.e1[1], frame.e1[2]);
      uE2.value.set(frame.e2[0], frame.e2[1], frame.e2[2]);
      uShape.value.set(frame.innerKm * frame.k, frame.outerKm * frame.k, frame.primaryKm * frame.k, frame.weight);
      uLight.value.set(frame.light[0], frame.light[1], frame.light[2], frame.light[3]);
      uLook.value.set(frame.tint[0] * frame.albedo, frame.tint[1] * frame.albedo, frame.tint[2] * frame.albedo, frame.albedo > 0 ? 1 : 0);
      for (let k = 0; k < PROFILE_BINS; k += 1) profileValues[k] = frame.profile[k] ?? 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
