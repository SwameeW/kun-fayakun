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
import { dot, exp, float, hash, instancedBufferAttribute, instanceIndex, max, mix, select, smoothstep, texture3D, uniform, uv, varying, vec3 } from 'three/tsl';
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
 */

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
    const r0 = Math.pow(random(), 0.75);
    let layer = layerAt(layers, r0);
    let speed = 0.1 + 0.9 * r0;
    if (finger) speed *= 1 + finger.reach * (0.4 + 0.6 * random());
    if (random() < options.mixing) {
      // Inner matter carried out among the outer layers.
      layer = layerAt(layers, random() * (layers[1]?.outer ?? 0.3));
      speed = 0.55 + 0.5 * random();
    }
    speed *= 1 + 0.05 * gauss();
    const color: Rgb = layers[layer]?.color ?? HOT;
    motion.set([dir.x, dir.y, dir.z, speed], i * 4);
    look.set([color[0], color[1], color[2], r0], i * 4);
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
  const position = centre.add(direction.mul(lookNode.w.mul(uStart).add(speed.mul(uTravel))));
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
