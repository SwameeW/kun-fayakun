import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  PointsNodeMaterial,
  Sprite,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import { dot, exp, float, Fn, hash, If, instancedBufferAttribute, instanceIndex, length, max, mix, select, smoothstep, texture3D, uniform, uv, varying, vec3 } from 'three/tsl';
import { HOT, layerAt, type Layer, type Rgb } from './layers';

/**
 * The debris of a supernova: a few hundred thousand points of light, each starting where
 * its matter lay in the star (so the layers' colours are kept) and flying straight out
 * at a speed that grows with its starting radius (homologous expansion: the outer layers
 * fastest). Rayleigh-Taylor fingers carry clumps out ahead, and some inner matter is mixed
 * out among the outer layers, as in real remnants. White-hot at first, it cools into its
 * elements' false colours; later the outer shell glows brightest, where the debris meets
 * the gas around it. Positions are computed in the vertex stage from chapter-driven
 * uniforms, so the picture is a function of time.
 *
 * A core-collapse remnant can also be given the structure seen in young remnants such as
 * Cassiopeia A (`structure`): the iron mixed out from the core travels in a few plumes that
 * overtake the silicon outside it, much of the silicon mixed out runs in a pair of narrow
 * opposite jets, and cavities open in the inner debris. The plumes and jets are only where
 * those points are sent at the start, so they cost nothing to draw; the cavities are a few
 * spheres the vertex stage pushes points out of, as they inflate.
 */

/** A clumpy plume of the innermost layer (iron), launched faster than the layer outside it. */
export interface Plume {
  /** Its direction from the centre (normalised here). */
  dir: readonly [number, number, number];
  /** Its share of the inner matter mixed outward (the plumes' shares sum to at most 1). */
  share: number;
  /** Speed of its head, as a fraction of the fastest debris' (1). */
  speed: number;
  /** Angular spread of its knots, radians. */
  spread: number;
}

export interface RemnantStructure {
  plumes: readonly Plume[];
  /** A pair of narrow jets of the second layer (silicon), opposite each other along `axis`. */
  jets: { axis: readonly [number, number, number]; share: number; speed: number; spread: number };
  /** Cavities in the inner debris: the direction and distance of each centre, and its radius, as fractions of the debris' extent. */
  bubbles: ReadonlyArray<{ dir: readonly [number, number, number]; at: number; radius: number }>;
  /**
   * Each cooled point of iron's light relative to the rest's: iron's false colour is the palest, and
   * the plumes are dense, so at full light they would add up to plain white, as the hot debris is.
   */
  ironLight: number;
}

export interface EjectaOptions {
  name: string;
  count: number;
  layers: readonly Layer[];
  /** Where the explosion is, world units. */
  centre: readonly [number, number, number];
  /** Rayleigh-Taylor fingers: how many, and the share of debris drawn into them. */
  fingers: number;
  fingerShare: number;
  /** Chance that a point of inner matter is carried out among the outer layers. */
  mixing: number;
  seed: number;
  structure?: RemnantStructure;
}

export interface EjectaState {
  /** Radius (world units) the debris starts from: the star's. */
  start: number;
  /** How far the fastest debris has travelled beyond `start`, world units. */
  travel: number;
  /** 1 = white-hot, 0 = the elements' colours. */
  heat: number;
  /** 0 = lit throughout, 1 = only the outer shell glows. */
  shell: number;
  light: number;
  sizePx: number;
  /** How far the cavities have opened, 0 to 1 (with `structure`; 0 skips them). */
  cavities?: number;
}

export interface Ejecta {
  readonly object: Sprite;
  readonly total: number;
  update(state: EjectaState): void;
  setCount(count: number): void;
  /** World position at radius fraction `fraction` of the debris' current extent, along `direction`. */
  pointAt(direction: Vector3, fraction: number, out: Vector3): Vector3;
  dispose(): void;
}

/** Knots per plume. */
const PLUME_KNOTS = 12;

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

export function createEjecta(noise: Data3DTexture, options: EjectaOptions): Ejecta {
  const { count, layers } = options;
  const random = prng(options.seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  const onSphere = (out: Vector3): Vector3 => {
    const z = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return out.set(s * Math.cos(phi), z, s * Math.sin(phi));
  };
  const fingers = Array.from({ length: options.fingers }, () => ({
    dir: onSphere(new Vector3()),
    spread: 0.04 + random() * 0.07,
    reach: 0.12 + random() * 0.3,
  }));
  /** `out` set to `axis` (times `sign`) turned by a random angle of about `spread` radians. */
  const scatter = (out: Vector3, axis: Vector3, spread: number, sign = 1): Vector3 =>
    out.set(axis.x * sign + gauss() * spread, axis.y * sign + gauss() * spread, axis.z * sign + gauss() * spread).normalize();

  const { structure } = options;
  const innerOuter = layers[0]?.outer ?? 0.1;
  const secondOuter = layers[1]?.outer ?? 0.3;
  // Each plume is a cluster of knots about its axis: clumpy, as real ones are.
  const plumes = (structure?.plumes ?? []).map((plume) => {
    const axis = new Vector3(...plume.dir).normalize();
    return { plume, knots: Array.from({ length: PLUME_KNOTS }, () => scatter(new Vector3(), axis, plume.spread)) };
  });
  const jetAxis = structure ? new Vector3(...structure.jets.axis).normalize() : null;

  const motion = new Float32Array(count * 4);
  const look = new Float32Array(count * 4);
  const dir = new Vector3();
  for (let i = 0; i < count; i += 1) {
    const finger = fingers.length > 0 && random() < options.fingerShare ? fingers[Math.floor(random() * fingers.length)] : undefined;
    if (finger) {
      dir.copy(finger.dir);
      dir.x += gauss() * finger.spread;
      dir.y += gauss() * finger.spread;
      dir.z += gauss() * finger.spread;
      dir.normalize();
    } else {
      onSphere(dir);
    }
    // More of the matter (and the light) lies in the outer layers.
    let r0 = Math.pow(random(), 0.75);
    let layer = layerAt(layers, r0);
    let speed = 0.1 + 0.9 * r0;
    if (finger) speed *= 1 + finger.reach * (0.4 + 0.6 * random());
    if (random() < options.mixing) {
      // Inner matter carried out among the outer layers.
      layer = layerAt(layers, random() * secondOuter);
      speed = 0.55 + 0.5 * random();
      if (structure) {
        const pick = random();
        if (layer === 0) {
          // Iron overturned: most of it rides out in the plumes, from the core past the silicon.
          let sum = 0;
          const chosen = plumes.find((p) => (sum += p.plume.share) > pick);
          const knot = chosen?.knots[Math.floor(random() * PLUME_KNOTS)];
          if (chosen && knot) {
            scatter(dir, knot, chosen.plume.spread * 0.4);
            r0 = random() * innerOuter;
            // A lobe out past the silicon, densest toward its head.
            speed = chosen.plume.speed * (0.5 + 0.5 * Math.sqrt(random()));
          }
        } else if (jetAxis && pick < structure.jets.share) {
          // Silicon in the two jets, fanning out a little toward their tips.
          const along = Math.pow(random(), 0.6);
          scatter(dir, jetAxis, structure.jets.spread * (0.5 + along), random() < 0.5 ? 1 : -1);
          r0 = innerOuter + random() * (secondOuter - innerOuter);
          speed = structure.jets.speed * (0.35 + 0.65 * along);
        }
      }
    }
    speed *= 1 + 0.05 * gauss();
    const color: Rgb = layers[layer]?.color ?? HOT;
    const tone = structure && layer === 0 ? structure.ironLight : 1;
    motion.set([dir.x, dir.y, dir.z, speed], i * 4);
    look.set([color[0] * tone, color[1] * tone, color[2] * tone, r0], i * 4);
  }

  const motionNode = instancedBufferAttribute(new InstancedBufferAttribute(motion, 4)) as unknown as Node<'vec4'>;
  const lookNode = instancedBufferAttribute(new InstancedBufferAttribute(look, 4)) as unknown as Node<'vec4'>;
  const uStart = uniform(1);
  const uTravel = uniform(0);
  const uHeat = uniform(1);
  const uShell = uniform(0);
  const uLight = uniform(0);
  const uSize = uniform(2);
  const uGain = uniform(1);
  const centre = vec3(...options.centre);

  const direction = motionNode.xyz;
  // A lumpy outline: the speed varies smoothly with direction (vertex stage: explicit level 0).
  const lumps = texture3D(noise, direction.mul(0.21).add((options.seed % 7) * 0.13)).level(float(0)).r;
  const speed = motionNode.w.mul(lumps.sub(0.5).mul(0.5).add(1));
  const flown = direction.mul(lookNode.w.mul(uStart).add(speed.mul(uTravel)));
  const uCavities = uniform(0);
  const uExtent = uniform(1);
  const bubbles = structure?.bubbles ?? [];
  // The cavities: a point inside one is pushed out onto its wall (each point to its own radius within
  // the wall's thickness), so the matter they cleared lies heaped round them. Skipped while closed.
  const shaped =
    bubbles.length > 0
      ? Fn(() => {
          const p = flown.toVar();
          If(uCavities.greaterThan(1e-3), () => {
            const wall = hash(instanceIndex.mul(3).add(2)).mul(0.14).add(0.86);
            for (const bubble of bubbles) {
              const at = new Vector3(...bubble.dir).normalize().multiplyScalar(bubble.at);
              const c = vec3(at.x, at.y, at.z).mul(uExtent);
              const v = p.sub(c);
              const d = max(length(v), 1e-4);
              const r = uExtent.mul(bubble.radius).mul(uCavities).mul(wall);
              p.assign(select(d.lessThan(r), c.add(v.mul(r.div(d))), p));
            }
          });
          return p;
        })()
      : flown;
  const position = centre.add(shaped);
  const luck = hash(instanceIndex.mul(3));
  const knot = hash(instanceIndex.mul(3).add(1)).greaterThan(0.985);
  const outer = mix(float(1), smoothstep(0.45, 1.05, speed).mul(1.6), uShell);
  const brightness = uLight.mul(uGain).mul(luck.mul(0.8).add(0.45)).mul(outer);
  const size = uSize.mul(luck.mul(0.9).add(0.6)).mul(select(knot, float(2.4), float(1)));

  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = position;
  material.sizeNode = select(brightness.greaterThan(1e-4), size, float(0));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  const profile = exp(r2.mul(-4.5)).mul(max(float(1).sub(r2), 0));
  const color = mix(lookNode.xyz, vec3(...HOT), uHeat);
  material.colorNode = varying(color.mul(brightness)).mul(profile);
  material.opacityNode = float(1);

  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = count;
  sprite.name = options.name;
  sprite.frustumCulled = false;
  sprite.visible = false;
  const centreVector = new Vector3(...options.centre);
  let extent = 0;

  return {
    object: sprite,
    total: count,
    update(state) {
      uStart.value = state.start;
      uTravel.value = state.travel;
      uHeat.value = state.heat;
      uShell.value = state.shell;
      uLight.value = state.light;
      uSize.value = state.sizePx;
      extent = state.start + state.travel;
      uExtent.value = extent;
      uCavities.value = state.cavities ?? 0;
      sprite.visible = state.light > 1e-3;
    },
    setCount(n) {
      sprite.count = Math.max(1, Math.min(count, Math.floor(n)));
      uGain.value = (count / sprite.count) ** 0.5;
    },
    pointAt(direction3, fraction, out) {
      return out.copy(direction3).normalize().multiplyScalar(extent * fraction).add(centreVector);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
