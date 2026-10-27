import { BufferGeometry, InstancedInterleavedBuffer, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshBasicNodeMaterial, type Node, type Object3D } from 'three/webgpu';
import { attribute, cross, dot, float, instancedDynamicBufferAttribute, max, mix, normalize, select, sin, varying } from 'three/tsl';
import { litCosine, sunlit } from '../bodies/shading';
import type { LabEffects } from './ladder';

/**
 * The laboratory's bodies drawn as what they are (docs/SANDBOX-ROADMAP.md W1.6): lit rocks and shining
 * stars, at exactly the engine's radius. One instanced mesh per level of detail (an icosphere of 1, 3 or
 * 5 subdivisions by the disc's size on screen), three draw calls for up to 64 bodies.
 *
 * Shape: a sphere, or, below the potato radius (./look), a lumpy one: a few broad dents and swells on the
 * sphere (illustrative, the same field for every rock, turned to each one's own orientation) and a
 * fragment's 2 : sqrt 2 : 1 axes, as lumpy as the rock is small. Normals follow the lumps.
 *
 * Light: airless regolith reflects by Lommel-Seeliger's law with a tenth of Lambert's (Hapke 2012),
 * normalised as the Moon's map is (incidence 30 degrees, emission 0: there the albedo is what shows),
 * from up to two stars (their sunlight at the body as a share of the Sun's at 1 au, nought in another
 * body's shadow), with the terminator softened over a pixel. A star shines by itself: its blackbody
 * colour, darkened toward its limb (a linear law of coefficient 0.6, near the Sun's in visible light).
 * Hot rock adds its own glow (./heat, ./incandescence). Positions are camera-relative and in the
 * explorer's scaled space, as its worlds' are.
 */

export interface RockInstance {
  id: string;
  /** Where it is drawn (camera-relative, scaled space, km) and its drawn radius; its disc's radius on screen (CSS px). */
  x: number;
  y: number;
  z: number;
  radius: number;
  discPx: number;
  /** Its orientation (a unit quaternion, render frame), axes (shares of its radius) and how lumpy it is (0 to 1). */
  q: [number, number, number, number];
  axes: [number, number, number];
  irregular: number;
  /** Albedo times tint (linear), and how much of it shows (fades, the crossover to a point). */
  color: [number, number, number];
  alpha: number;
  /** Two lights: unit direction to the star (render frame) and its light there (1: the Sun's at 1 au). */
  light0: [number, number, number, number];
  light1: [number, number, number, number];
  /** Its own light (linear, scene terms): a star's surface or hot rock's glow; `star` 1 for a star (no reflected light, darkened toward its limb). */
  glow: [number, number, number];
  star: number;
}

export interface Rocks {
  readonly objects: readonly Object3D[];
  /** Draws these (the first `count`); each goes to the mesh its disc's size calls for (with a margin, so none flickers between two). */
  update(list: readonly RockInstance[], count: number): void;
  /** Bodies drawn by each mesh (small, middling, large), for the tests and the effects' report. */
  readonly drawn: readonly [number, number, number];
  dispose(): void;
}

const MAX_ROCKS = 64;
/** Numbers a rock in the instanced buffer: seven fours (centre and radius, orientation, shape, look, two lights, glow). */
const STRIDE = 28;
/** The lumps: broad dents and swells on the unit sphere (direction, height, width), illustrative and fixed. */
const LUMPS = ((): Array<[number, number, number, number, number]> => {
  let a = 0x2545f491;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 9 }, () => {
    const z = 2 * next() - 1;
    const phi = 2 * Math.PI * next();
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(phi), s * Math.sin(phi), z, -0.2 + 0.32 * next(), 0.12 + 0.45 * next()];
  });
})();
const lumpy = (x: number, y: number, z: number): number => {
  let r = 1;
  for (const [cx, cy, cz, h, w] of LUMPS) r += h * Math.exp(-(1 - (x * cx + y * cy + z * cz)) / w);
  return r;
};

/**
 * A unit icosphere: an icosahedron's faces each cut into 4^detail triangles, their corners pushed out to
 * the sphere (shared corners shared: indexed). Built here rather than with three's IcosahedronGeometry,
 * which would join the first-visit bundle's three.js chunk (src/core: the shell must not grow).
 */
function icosphere(detail: number): { positions: Float32Array; index: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const points: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    points.push(x / l, y / l, z / l);
    return points.length / 3 - 1;
  };
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as const) add(x, y, z);
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let level = 0; level < detail; level += 1) {
    const middle = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 1_000_000 + b : b * 1_000_000 + a;
      let m = middle.get(key);
      if (m === undefined) {
        m = add((points[a * 3] ?? 0) + (points[b * 3] ?? 0), (points[a * 3 + 1] ?? 0) + (points[b * 3 + 1] ?? 0), (points[a * 3 + 2] ?? 0) + (points[b * 3 + 2] ?? 0));
        middle.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] ?? 0;
      const b = faces[f + 1] ?? 0;
      const c = faces[f + 2] ?? 0;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { positions: Float32Array.from(points), index: faces };
}

/** An icosphere with its lumpy twin (positions and normals) as extra attributes. */
function rockGeometry(detail: number): BufferGeometry {
  const sphere = icosphere(detail);
  const g = new BufferGeometry();
  g.setIndex(sphere.index);
  const n = sphere.positions.length / 3;
  const p = { getX: (i: number): number => sphere.positions[i * 3] ?? 0, getY: (i: number): number => sphere.positions[i * 3 + 1] ?? 0, getZ: (i: number): number => sphere.positions[i * 3 + 2] ?? 0 };
  const shaped = new Float32Array(n * 3);
  const shapedNormal = new Float32Array(n * 3);
  const at = (x: number, y: number, z: number, out: number[]): void => {
    const l = Math.hypot(x, y, z) || 1;
    const r = lumpy(x / l, y / l, z / l);
    out[0] = (x / l) * r;
    out[1] = (y / l) * r;
    out[2] = (z / l) * r;
  };
  const p0 = [0, 0, 0];
  const p1 = [0, 0, 0];
  const p2 = [0, 0, 0];
  const eps = 2e-3;
  for (let i = 0; i < n; i += 1) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    at(x, y, z, p0);
    // Two directions along the sphere, and the lumpy surface's slope along each.
    const hx = Math.abs(y) < 0.9 ? 0 : 1;
    const hy = Math.abs(y) < 0.9 ? 1 : 0;
    let t1x = y * 0 - z * hy;
    let t1y = z * hx - x * 0;
    let t1z = x * hy - y * hx;
    const l1 = Math.hypot(t1x, t1y, t1z) || 1;
    t1x /= l1;
    t1y /= l1;
    t1z /= l1;
    const t2x = y * t1z - z * t1y;
    const t2y = z * t1x - x * t1z;
    const t2z = x * t1y - y * t1x;
    at(x + eps * t1x, y + eps * t1y, z + eps * t1z, p1);
    at(x + eps * t2x, y + eps * t2y, z + eps * t2z, p2);
    const ax = (p1[0] ?? 0) - (p0[0] ?? 0);
    const ay = (p1[1] ?? 0) - (p0[1] ?? 0);
    const az = (p1[2] ?? 0) - (p0[2] ?? 0);
    const bx = (p2[0] ?? 0) - (p0[0] ?? 0);
    const by = (p2[1] ?? 0) - (p0[1] ?? 0);
    const bz = (p2[2] ?? 0) - (p0[2] ?? 0);
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    if (nx * x + ny * y + nz * z < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const ln = Math.hypot(nx, ny, nz) || 1;
    shaped.set([p0[0] ?? 0, p0[1] ?? 0, p0[2] ?? 0], i * 3);
    shapedNormal.set([nx / ln, ny / ln, nz / ln], i * 3);
  }
  // One interleaved buffer (WebGPU allows only eight vertex buffers a draw): the sphere's position and
  // normal (on a unit sphere, the position), and the lumpy twin's.
  const data = new Float32Array(n * 12);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = sphere.positions[i * 3 + c] ?? 0;
      data[i * 12 + c] = v;
      data[i * 12 + 3 + c] = v;
      data[i * 12 + 6 + c] = shaped[i * 3 + c] ?? 0;
      data[i * 12 + 9 + c] = shapedNormal[i * 3 + c] ?? 0;
    }
  }
  const buffer = new InterleavedBuffer(data, 12);
  g.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
  g.setAttribute('normal', new InterleavedBufferAttribute(buffer, 3, 3));
  g.setAttribute('shaped', new InterleavedBufferAttribute(buffer, 3, 6));
  g.setAttribute('shapedNormal', new InterleavedBufferAttribute(buffer, 3, 9));
  return g;
}

/** The standard geometry's Lommel-Seeliger value (incidence 30 degrees, emission 0) and Lambert's cosine there. */
const LS_STANDARD = (2 * Math.cos(Math.PI / 6)) / (Math.cos(Math.PI / 6) + 1);
const LAMBERT_STANDARD = Math.cos(Math.PI / 6);
/** The night side's floor, as a share of sunlit ground (a visual aid so a rock in shadow is not lost against the sky: illustrative). */
const NIGHT = 0.04;
/** Limb darkening's linear coefficient for a star in visible light (illustrative: near the Sun's). */
const LIMB = 0.6;

type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;
type F = Node<'float'>;

/** Rotates v by the unit quaternion q: v + 2 q.xyz x (q.xyz x v + q.w v). */
const turn = (q: V4, v: V3): V3 => {
  const t = cross(q.xyz, v).add(v.mul(q.w));
  return v.add(cross(q.xyz, t).mul(2));
};

interface Bucket {
  mesh: Mesh;
  /** Seven numbers' fours a rock, interleaved in one instanced buffer. */
  data: InstancedInterleavedBuffer;
  array: Float32Array;
}

function bucket(detail: number): Bucket {
  const array = new Float32Array(MAX_ROCKS * STRIDE);
  const data = new InstancedInterleavedBuffer(array, STRIDE);
  const node = (k: number): V4 => (instancedDynamicBufferAttribute(data, 'vec4', STRIDE, k * 4) as unknown as { setInstanced(on: boolean): V4 }).setInstanced(true);
  const centre = node(0);
  const q = node(1);
  const shape = node(2);
  const look = node(3);
  const l0 = node(4);
  const l1 = node(5);
  const glow = node(6);
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: true, fog: false });
  const irregular = shape.w;
  // The sphere's own position and normal (the geometry's), and the lumpy twin's.
  const sphere = attribute('position', 'vec3') as unknown as V3;
  const local = mix(sphere, attribute('shaped', 'vec3') as unknown as V3, irregular).mul(shape.xyz);
  const normal = normalize(mix(attribute('normal', 'vec3') as unknown as V3, attribute('shapedNormal', 'vec3') as unknown as V3, irregular).div(shape.xyz));
  const world = centre.xyz.add(turn(q, local).mul(centre.w));
  material.positionNode = world;
  const vWorld = varying(world);
  const vLocal = varying(local);
  const vNormal = varying(turn(q, normal));
  const n = normalize(vNormal);
  const view = normalize(vWorld.negate());
  const mu = max(dot(n, view), 0);
  const light = (l: V4): F => {
    const cosine = dot(n, l.xyz);
    const mu0 = litCosine(cosine);
    const ls = mu0.mul(2).div(mu0.add(mu).add(1e-3)).div(LS_STANDARD).mul(0.9);
    const lambert = mu0.div(LAMBERT_STANDARD).mul(0.1);
    return ls.add(lambert).mul(sunlit(cosine)).mul(l.w);
  };
  // A faint floor on the night side (a visual aid, as the explorer's worlds' night sides and points have: illustrative).
  const reflected = look.xyz.mul(light(l0).add(light(l1)).add(NIGHT));
  const limb = float(1).sub(float(LIMB).mul(float(1).sub(mu)));
  // Hot rock: brighter where it faces the camera (its crust thickest toward the limb), in patches where the crust has cracked (illustrative).
  const cracks = sin(vLocal.x.mul(13)).mul(sin(vLocal.y.mul(11))).mul(sin(vLocal.z.mul(17))).mul(0.3).add(0.85);
  const hot = glow.xyz.mul(mu.mul(0.45).add(0.55)).mul(cracks);
  material.colorNode = select(glow.w.greaterThan(0.5), glow.xyz.mul(limb), reflected.add(hot));
  material.opacityNode = look.w;
  const mesh = new Mesh(rockGeometry(detail), material);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  mesh.name = `lab-rocks-${detail}`;
  return { mesh, data, array };
}

export function createRocks(effects: LabEffects): Rocks {
  const buckets = effects.rockDetail.map((d) => bucket(d));
  const drawn: [number, number, number] = [0, 0, 0];
  /** Each body's mesh last frame (so a disc on the line between two keeps its mesh). */
  const was = new Map<string, number>();
  const seen = new Set<string>();
  return {
    objects: buckets.map((b) => b.mesh),
    drawn,
    update(list, count) {
      drawn.fill(0);
      seen.clear();
      for (let i = 0; i < count && i < MAX_ROCKS; i += 1) {
        const r = list[i];
        if (!r || r.alpha <= 1e-3) continue;
        seen.add(r.id);
        const before = was.get(r.id) ?? 0;
        // With a margin of 15 per cent either side of each line.
        const lo = effects.rockLodPx[0] * (before >= 1 ? 0.85 : 1.15);
        const hi = effects.rockLodPx[1] * (before >= 2 ? 0.85 : 1.15);
        const k = r.discPx >= hi ? 2 : r.discPx >= lo ? 1 : 0;
        was.set(r.id, k);
        const b = buckets[k];
        if (!b) continue;
        const j = drawn[k];
        drawn[k] = j + 1;
        const a = b.array;
        const o = j * STRIDE;
        a[o] = r.x;
        a[o + 1] = r.y;
        a[o + 2] = r.z;
        a[o + 3] = r.radius;
        a.set(r.q, o + 4);
        a[o + 8] = r.axes[0];
        a[o + 9] = r.axes[1];
        a[o + 10] = r.axes[2];
        a[o + 11] = r.irregular;
        a[o + 12] = r.color[0];
        a[o + 13] = r.color[1];
        a[o + 14] = r.color[2];
        a[o + 15] = Math.min(1, r.alpha);
        a.set(r.light0, o + 16);
        a.set(r.light1, o + 20);
        a[o + 24] = r.glow[0];
        a[o + 25] = r.glow[1];
        a[o + 26] = r.glow[2];
        a[o + 27] = r.star;
      }
      for (const id of was.keys()) if (!seen.has(id)) was.delete(id);
      buckets.forEach((b, k) => {
        const n = drawn[k] ?? 0;
        b.mesh.count = n;
        b.mesh.visible = n > 0;
        if (n > 0) b.data.needsUpdate = true;
      });
    },
    dispose() {
      for (const b of buckets) {
        b.mesh.geometry.dispose();
        (b.mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
