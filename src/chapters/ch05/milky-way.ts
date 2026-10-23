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
import { dot, exp, float, instancedBufferAttribute, max, select, uniform, uv } from 'three/tsl';

/**
 * An artist's model of the Milky Way (no one has seen it from outside): a barred spiral
 * of a few hundred thousand points of light over a soft diffuse glow. Old stars of the
 * bulge and bar are golden; the arms carry young blue-white stars and rose-pink glowing
 * nebulae, with dark dust lanes along their inner edges. Laid out in kiloparsecs in the
 * galactic frame the survey uses (the disc is the x-z plane, the north galactic pole is
 * +y, the Sun is on the -x side of the centre), following published structure loosely:
 * a bar about 27 degrees from the Sun-centre line with its near end at positive galactic
 * longitude, two major arms from the bar's ends and two minor ones, all trailing as the
 * galaxy turns (clockwise seen from the north). The group is scaled to world units by
 * the scene; stars are sized in pixels, the glow lies flat in the disc.
 */

export interface MilkyWayState {
  /** Kiloparsecs per world unit. */
  kpcPerUnit: number;
  /** Overall brightness, 0 to 1. */
  brightness: number;
  /** Apparent radius of the disc in CSS pixels, and the viewport height in CSS pixels. */
  radiusPx: number;
  viewportPx: number;
}

export interface MilkyWay {
  readonly object: Group;
  /** Radius of the visible disc, kiloparsecs. */
  readonly radiusKpc: number;
  update(state: MilkyWayState): void;
  setBudget(stars: number): void;
  dispose(): void;
}

const DEG = Math.PI / 180;
const LAYOUT = {
  radius: 15,
  discScale: 2.6,
  discHeight: 0.16,
  bulgeScale: 0.34,
  barHalfLength: 4.4,
  /** Angle of the bar's far end in the disc plane (x = cos, z = sin); its near end is opposite. */
  barAngle: 27 * DEG,
  pitch: 12.5 * DEG,
  armStart: 4.4,
} as const;
/** Major arms leave the bar's ends; minor arms lie between them. */
const ARMS = [
  { start: LAYOUT.barAngle, weight: 0.36 },
  { start: LAYOUT.barAngle + Math.PI, weight: 0.36 },
  { start: LAYOUT.barAngle + Math.PI / 2, weight: 0.14 },
  { start: LAYOUT.barAngle + (3 * Math.PI) / 2, weight: 0.14 },
] as const;
const TAN_PITCH = Math.tan(LAYOUT.pitch);

type Rgb = readonly [number, number, number];
const OLD: Rgb = [1.0, 0.78, 0.5];
const DISC: Rgb = [1.0, 0.91, 0.78];
const YOUNG: Rgb = [0.6, 0.73, 1.0];
const NEBULA: Rgb = [1.0, 0.36, 0.56];
/** Starlight through a dust lane: dimmer and redder. */
const DUSTED: Rgb = [1.0, 0.66, 0.44];

const STARS_HIGH = 320_000;
/** Light per star and per glow disc: enough to build the galaxy's light without washing its colours to white. */
const STAR_LIGHT = 0.5;
const GLOW_LIGHT = 0.55;
/** Below this apparent size (fraction of the viewport height) the stars stop shrinking and fade instead. */
const STAR_FLOOR = 0.3;

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

interface Point {
  x: number;
  y: number;
  z: number;
}

class Sampler {
  readonly random: () => number;
  constructor(seed: number) {
    this.random = prng(seed);
  }
  gauss(): number {
    return Math.sqrt(-2 * Math.log(Math.max(this.random(), 1e-9))) * Math.cos(2 * Math.PI * this.random());
  }
  /** Laplace (two-sided exponential) with the given scale: a thin disc's vertical profile. */
  laplace(scale: number): number {
    const u = this.random() - 0.5;
    return -scale * Math.sign(u) * Math.log(Math.max(1 - 2 * Math.abs(u), 1e-9));
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.random();
  }
  pickArm(): (typeof ARMS)[number] {
    let u = this.random();
    for (const arm of ARMS) {
      u -= arm.weight;
      if (u <= 0) return arm;
    }
    return ARMS[0];
  }
  bulge(out: Point): Point {
    // Gamma(3) radius: an exponential sphere, flattened toward the disc.
    const r = -LAYOUT.bulgeScale * Math.log(Math.max(this.random() * this.random() * this.random(), 1e-12));
    const cz = this.range(-1, 1);
    const phi = this.range(0, 2 * Math.PI);
    const s = Math.sqrt(1 - cz * cz);
    out.x = r * s * Math.cos(phi);
    out.y = r * cz * 0.55;
    out.z = r * s * Math.sin(phi);
    return out;
  }
  bar(out: Point): Point {
    const along = Math.max(-1.25, Math.min(1.25, this.gauss() * 0.5)) * LAYOUT.barHalfLength;
    const across = this.gauss() * 0.42;
    const c = Math.cos(LAYOUT.barAngle);
    const s = Math.sin(LAYOUT.barAngle);
    out.x = along * c - across * s;
    out.y = this.gauss() * 0.22;
    out.z = along * s + across * c;
    return out;
  }
  disc(out: Point): Point {
    let r: number;
    do {
      r = -LAYOUT.discScale * Math.log(Math.max(this.random() * this.random(), 1e-12));
    } while (r > LAYOUT.radius);
    const phi = this.range(0, 2 * Math.PI);
    out.x = r * Math.cos(phi);
    out.y = this.laplace(LAYOUT.discHeight * (0.8 + r / LAYOUT.radius));
    out.z = r * Math.sin(phi);
    return out;
  }
  /** A point along a logarithmic arm, scattered about it by `spread` (times the arm's width). */
  arm(out: Point, spread: number): Point {
    const arm = this.pickArm();
    const span = LAYOUT.radius - LAYOUT.armStart;
    // Truncated exponential along the arm: denser inside, thinning outward.
    const u = this.random();
    const r0 = LAYOUT.armStart + -5 * Math.log(1 - u * (1 - Math.exp(-span / 5)));
    const theta = arm.start - Math.log(r0 / LAYOUT.armStart) / TAN_PITCH;
    const width = (0.13 + 0.022 * r0) * spread;
    const r = Math.max(0.5, r0 + this.gauss() * width);
    const phi = theta + (this.gauss() * width * 0.6) / r;
    out.x = r * Math.cos(phi);
    out.y = this.laplace(0.1 + 0.01 * r);
    out.z = r * Math.sin(phi);
    return out;
  }
}

/** How much a dust lane dims light at this point: 1 = clear. Lanes hug the inner edges of the arms. */
function dustAt(p: Point): number {
  const r = Math.hypot(p.x, p.z);
  if (r < LAYOUT.armStart * 0.9) return 1;
  const theta = Math.atan2(p.z, p.x);
  let lane = 0;
  for (const [index, arm] of ARMS.entries()) {
    const offset = theta - arm.start + Math.log(r / LAYOUT.armStart) / TAN_PITCH;
    const wrapped = offset - 2 * Math.PI * Math.round(offset / (2 * Math.PI));
    // Log-radial distance from the arm; negative = inside it.
    const d = wrapped * TAN_PITCH;
    const strength = index < 2 ? 0.9 : 0.55;
    lane = Math.max(lane, strength * Math.exp(-(((d + 0.06) / 0.03) ** 2)));
  }
  return 1 - lane;
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Built in slices, yielding between them, so building it never stalls a frame for long. */
async function createStars(count: number, seed: number) {
  const s = new Sampler(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const p: Point = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < count; i += 1) {
    if (i % 40_000 === 39_999) await yieldToBrowser();
    const kind = s.random();
    let color: Rgb;
    let light: number;
    let size: number;
    if (kind < 0.09) {
      s.bulge(p);
      color = mixRgb(OLD, DISC, s.random() * 0.3);
      light = s.range(0.1, 0.26);
      size = s.range(1.3, 2.2);
    } else if (kind < 0.22) {
      s.bar(p);
      color = mixRgb(OLD, DISC, s.random() * 0.45);
      light = s.range(0.1, 0.24);
      size = s.range(1.3, 2.2);
    } else if (kind < 0.55) {
      s.disc(p);
      const outer = Math.min(1, Math.hypot(p.x, p.z) / LAYOUT.radius);
      color = mixRgb(DISC, YOUNG, outer * 0.5 + s.random() * 0.2);
      light = s.range(0.06, 0.17);
      size = s.range(1.2, 2.1);
    } else if (kind < 0.975) {
      s.arm(p, 1);
      const bright = s.random() < 0.12;
      color = mixRgb(YOUNG, DISC, s.random() * (bright ? 0.1 : 0.4));
      light = bright ? s.range(0.35, 0.8) : s.range(0.1, 0.28);
      size = bright ? s.range(2.2, 3.6) : s.range(1.3, 2.4);
    } else {
      // Glowing nebulae where stars are being born, in tight knots along the arms.
      s.arm(p, 0.45);
      color = NEBULA;
      light = s.range(0.4, 0.9);
      size = s.range(2.2, 4.2);
    }
    const dust = dustAt(p);
    if (dust < 1) color = mixRgb(color, DUSTED, (1 - dust) * 0.8);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    const shown = light * dust * STAR_LIGHT;
    colors[i * 3] = color[0] * shown;
    colors[i * 3 + 1] = color[1] * shown;
    colors[i * 3 + 2] = color[2] * shown;
    sizes[i] = size;
  }
  return { positions, colors, sizes };
}

/** Diffuse light: soft discs lying flat in the plane (a glow of unresolved stars and lit gas). */
function createGlow(seed: number) {
  const s = new Sampler(seed);
  const p: Point = { x: 0, y: 0, z: 0 };
  const items: Array<{ p: Point; size: number; color: Rgb; light: number }> = [];
  const add = (size: number, color: Rgb, light: number): void => {
    const dust = dustAt(p);
    items.push({ p: { ...p }, size, color: dust < 1 ? mixRgb(color, DUSTED, (1 - dust) * 0.8) : color, light: light * (0.35 + 0.65 * dust) });
  };
  // The bulge's broad golden glow, brightest at the centre.
  p.x = 0;
  p.y = 0;
  p.z = 0;
  add(7.5, OLD, 0.55);
  add(3.2, mixRgb(OLD, DISC, 0.4), 0.6);
  for (let i = 0; i < 320; i += 1) add((s.bulge(p), s.range(1.2, 2.6)), OLD, 0.05);
  for (let i = 0; i < 360; i += 1) add((s.bar(p), s.range(1.2, 2.4)), mixRgb(OLD, DISC, 0.3), 0.05);
  for (let i = 0; i < 700; i += 1) add((s.disc(p), s.range(2, 3.8)), DISC, 0.016);
  for (let i = 0; i < 2200; i += 1) add((s.arm(p, 1.1), s.range(0.9, 2)), mixRgb(YOUNG, DISC, s.random() * 0.5), 0.03);
  for (let i = 0; i < 380; i += 1) add((s.arm(p, 0.5), s.range(0.35, 0.8)), NEBULA, 0.07);
  return items;
}

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

export async function createMilkyWay(seed = 1_420): Promise<MilkyWay> {
  const object = new Group();
  object.name = 'ch05-milky-way';
  const uLight = uniform(1);
  const uStarSize = uniform(1);
  const uStarFade = uniform(1);

  // Stars: pixel-sized sprites, one draw.
  const stars = await createStars(STARS_HIGH, seed);
  /** Fewer stars on lower tiers: each a little brighter, so the galaxy looks the same. */
  let gain = 1;
  const position = instancedBufferAttribute(new InstancedBufferAttribute(stars.positions, 3)) as unknown as Node<'vec3'>;
  const color = instancedBufferAttribute(new InstancedBufferAttribute(stars.colors, 3)) as unknown as Node<'vec3'>;
  const size = instancedBufferAttribute(new InstancedBufferAttribute(stars.sizes, 1)) as unknown as Node<'float'>;
  const starMaterial = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  starMaterial.positionNode = position;
  starMaterial.sizeNode = select(uLight.greaterThan(1e-4), size.mul(uStarSize), float(0));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  starMaterial.colorNode = color.mul(exp(r2.mul(-5)).mul(max(float(1).sub(r2), 0))).mul(uLight.mul(uStarFade));
  starMaterial.opacityNode = float(1);
  const starGeometry = createQuad();
  const starSprite = new Sprite(starMaterial);
  starSprite.geometry = starGeometry;
  starSprite.count = STARS_HIGH;
  starSprite.frustumCulled = false;
  starSprite.name = 'ch05-milky-way-stars';

  // Glow: flat soft discs in the plane, so the disc looks thin when seen at a slant.
  const glow = createGlow(seed + 1);
  const glowGeometry = new PlaneGeometry(1, 1);
  glowGeometry.rotateX(-Math.PI / 2);
  const glowColors = new Float32Array(glow.length * 3);
  const glowMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    fog: false,
  });
  const glowColor = instancedBufferAttribute(new InstancedBufferAttribute(glowColors, 3)) as unknown as Node<'vec3'>;
  const g = uv().sub(0.5).mul(2);
  const g2 = dot(g, g);
  glowMaterial.colorNode = glowColor.mul(exp(g2.mul(-3.2)).mul(max(float(1).sub(g2), 0))).mul(uLight);
  glowMaterial.opacityNode = float(1);
  const glowMesh = new InstancedMesh(glowGeometry, glowMaterial, glow.length);
  glowMesh.frustumCulled = false;
  glowMesh.name = 'ch05-milky-way-glow';
  const placer = new Object3D();
  const random = prng(seed + 2);
  glow.forEach((item, i) => {
    placer.position.set(item.p.x, item.p.y, item.p.z);
    placer.rotation.set(0, random() * Math.PI, 0);
    placer.scale.set(item.size, 1, item.size * (0.6 + 0.4 * random()));
    placer.updateMatrix();
    glowMesh.setMatrixAt(i, placer.matrix);
    glowColors.set(
      [item.color[0] * item.light * GLOW_LIGHT, item.color[1] * item.light * GLOW_LIGHT, item.color[2] * item.light * GLOW_LIGHT],
      i * 3,
    );
  });
  glowMesh.instanceMatrix.needsUpdate = true;

  object.add(glowMesh, starSprite);

  return {
    object,
    radiusKpc: LAYOUT.radius,
    update(state) {
      object.scale.setScalar(1 / state.kpcPerUnit);
      // Stars shrink with the galaxy down to a floor, then fade so its surface brightness holds.
      const relative = state.viewportPx > 0 ? state.radiusPx / (0.45 * state.viewportPx) : 1;
      uStarSize.value = Math.max(STAR_FLOOR, Math.min(1, relative));
      const fade = Math.min(1, (relative / STAR_FLOOR) ** 2);
      uLight.value = state.brightness;
      uStarFade.value = fade * gain;
      starSprite.visible = state.brightness * fade > 1e-3;
      object.visible = state.brightness > 1e-3;
    },
    setBudget(count) {
      starSprite.count = Math.max(1, Math.min(STARS_HIGH, Math.floor(count)));
      gain = (STARS_HIGH / starSprite.count) ** 0.6;
    },
    dispose() {
      starGeometry.dispose();
      starMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      glowMesh.dispose();
    },
  };
}
