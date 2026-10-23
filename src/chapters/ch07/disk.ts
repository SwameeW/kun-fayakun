import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
  PointsNodeMaterial,
  Sprite,
  type Node,
} from 'three/webgpu';
import { cos, dot, exp, float, hash, instanceIndex, instancedBufferAttribute, max, mix, pow, select, sin, smoothstep, uniform, uv, varying, vec3 } from 'three/tsl';

/**
 * The protoplanetary disk: a flat, slightly flared disk of dust and gas around the young
 * Sun, lit by it (warm and bright inside, dusky outside), turning faster near the centre
 * (Kepler: angular speed falls as r^-1.5). Dark rings of dust and gaps, deepest where
 * forming planets sweep their orbits clear, each with a growing protoplanet in it. When the
 * disk clears, it goes from the inside out, as the young Sun's light drives the gas away.
 * Positions are computed in the vertex stage from chapter time. Illustrative, not to scale.
 */

export interface DiskOptions {
  count: number;
  inner: number;
  outer: number;
  /** Gaps (radius, width, depth 0 to 1), each holding a protoplanet. */
  gaps: ReadonlyArray<{ radius: number; width: number; depth: number }>;
  seed: number;
}

export interface DiskState {
  time: number;
  light: number;
  /** 0 = full disk, 1 = cleared (the front moves from the inside out). */
  clearing: number;
}

export interface Disk {
  readonly object: Group;
  update(state: DiskState): void;
  setCount(count: number): void;
  dispose(): void;
}

/** Angular speed at radius 1, radians per chapter second (a turn at the Earth's radius takes about 16 s). */
const OMEGA = 0.55;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

export function createDisk(options: DiskOptions): Disk {
  const random = prng(options.seed);
  const density = (r: number): number => {
    let d = 1;
    for (const g of options.gaps) d *= 1 - g.depth * Math.exp(-(((r - g.radius) / g.width) ** 2));
    // Fainter dust rings between, as seen in young disks.
    d *= 0.78 + 0.22 * Math.cos((2 * Math.PI * r) / 0.55);
    return d;
  };
  const { count } = options;
  const orbit = new Float32Array(count * 4); // r, theta0, height, light
  let filled = 0;
  while (filled < count) {
    const r = options.inner + (options.outer - options.inner) * random() ** 0.85;
    if (random() > density(r)) continue;
    const theta = random() * Math.PI * 2;
    const gaussian = Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
    const height = gaussian * r * 0.035;
    const light = (0.55 + random() * 0.6) * r ** -0.6;
    orbit.set([r, theta, height, light], filled * 4);
    filled += 1;
  }
  const attribute = instancedBufferAttribute(new InstancedBufferAttribute(orbit, 4)) as unknown as Node<'vec4'>;
  const uTime = uniform(0);
  const uLight = uniform(0);
  const uFront = uniform(-1);
  const uGain = uniform(1);

  const r = attribute.x;
  const angle = attribute.y.add(pow(r, -1.5).mul(OMEGA).mul(uTime));
  const position = vec3(cos(angle).mul(r), attribute.z, sin(angle).mul(r));
  // Inside the clearing front the gas is gone.
  const kept = smoothstep(uFront.sub(0.15), uFront.add(0.5), r);
  const warm = vec3(1.0, 0.84, 0.6);
  const dusky = vec3(0.98, 0.56, 0.3);
  const color = mix(warm, dusky, smoothstep(0.5, 6, r));
  const brightness = attribute.w.mul(uLight).mul(uGain).mul(kept).mul(hash(instanceIndex.mul(3)).mul(0.5).add(0.75)).mul(0.17);
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = position;
  material.sizeNode = select(brightness.greaterThan(1e-4), float(2.3), float(0));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  material.colorNode = varying(color.mul(brightness)).mul(exp(r2.mul(-4)).mul(max(float(1).sub(r2), 0)));
  material.opacityNode = float(1);
  const geometry = createQuad();
  const dust = new Sprite(material);
  dust.geometry = geometry;
  dust.count = count;
  dust.frustumCulled = false;
  dust.name = 'ch07-disk-dust';

  // A soft glow of unresolved dust and gas, lying flat in the disk.
  const glowCount = 900;
  const glowGeometry = new PlaneGeometry(1, 1);
  glowGeometry.rotateX(-Math.PI / 2);
  const glowLight = new Float32Array(glowCount * 4);
  const glowMaterial = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, side: DoubleSide, fog: false });
  const glowAttr = instancedBufferAttribute(new InstancedBufferAttribute(glowLight, 4)) as unknown as Node<'vec4'>;
  const g = uv().sub(0.5).mul(2);
  const g2 = dot(g, g);
  const glowKept = smoothstep(uFront.sub(0.15), uFront.add(0.5), glowAttr.w);
  glowMaterial.colorNode = glowAttr.xyz.mul(exp(g2.mul(-3)).mul(max(float(1).sub(g2), 0))).mul(uLight).mul(glowKept);
  glowMaterial.opacityNode = float(1);
  const glow = new InstancedMesh(glowGeometry, glowMaterial, glowCount);
  glow.frustumCulled = false;
  glow.name = 'ch07-disk-glow';
  const placer = new Object3D();
  for (let i = 0; i < glowCount; i += 1) {
    let rr: number;
    do {
      rr = options.inner + (options.outer - options.inner) * random() ** 0.7;
    } while (random() > density(rr));
    const theta = random() * Math.PI * 2;
    placer.position.set(Math.cos(theta) * rr, 0, Math.sin(theta) * rr);
    placer.rotation.set(0, random() * Math.PI, 0);
    const size = 0.3 + rr * 0.11;
    placer.scale.set(size, 1, size * (0.6 + 0.4 * random()));
    placer.updateMatrix();
    glow.setMatrixAt(i, placer.matrix);
    const light = 0.06 * rr ** -0.5 * density(rr);
    const t = Math.min(1, rr / 6);
    glowLight.set([light, light * (0.8 - 0.25 * t), light * (0.58 - 0.28 * t), rr], i * 4);
  }
  glow.instanceMatrix.needsUpdate = true;

  // Protoplanets: a growing body in each gap, on its own Keplerian orbit.
  const planetCount = options.gaps.length;
  const planetOrbit = new Float32Array(planetCount * 4);
  options.gaps.forEach((gap, i) => {
    planetOrbit.set([gap.radius, random() * Math.PI * 2, 0, gap.depth], i * 4);
  });
  const planetAttr = instancedBufferAttribute(new InstancedBufferAttribute(planetOrbit, 4)) as unknown as Node<'vec4'>;
  const uGrowth = uniform(0);
  const planetMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const pAngle = planetAttr.y.add(pow(planetAttr.x, -1.5).mul(OMEGA).mul(uTime));
  planetMaterial.positionNode = vec3(cos(pAngle).mul(planetAttr.x), 0, sin(pAngle).mul(planetAttr.x));
  planetMaterial.sizeNode = float(5).add(planetAttr.w.mul(9)).mul(uGrowth.mul(0.7).add(0.3));
  const pc = uv().sub(0.5).mul(2);
  const p2 = dot(pc, pc);
  planetMaterial.colorNode = vec3(1.0, 0.86, 0.66).mul(exp(p2.mul(-7)).mul(1.6).add(exp(p2.mul(-2)).mul(0.25)).mul(max(float(1).sub(p2), 0))).mul(uGrowth).mul(uLight);
  planetMaterial.opacityNode = float(1);
  const planetGeometry = createQuad();
  const protoplanets = new Sprite(planetMaterial);
  protoplanets.geometry = planetGeometry;
  protoplanets.count = planetCount;
  protoplanets.frustumCulled = false;
  protoplanets.name = 'ch07-protoplanets';

  const object = new Group();
  object.name = 'ch07-disk';
  object.add(glow, dust, protoplanets);
  return {
    object,
    update(state) {
      uTime.value = state.time;
      uLight.value = state.light;
      uFront.value = state.clearing <= 0 ? -1 : state.clearing * (options.outer + 1);
      uGrowth.value = Math.min(1, state.time / 30);
      object.visible = state.light > 1e-3 && state.clearing < 1;
    },
    setCount(n) {
      dust.count = Math.max(1, Math.min(count, Math.floor(n)));
      uGain.value = (count / dust.count) ** 0.6;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      glow.dispose();
      planetGeometry.dispose();
      planetMaterial.dispose();
    },
  };
}
