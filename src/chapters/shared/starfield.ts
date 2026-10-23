import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { cameraPosition, dot, exp, float, instancedBufferAttribute, max, uniform, uv } from 'three/tsl';
import { blackbodyRgb } from './blackbody';

/**
 * Distant stars as a backdrop: points on a large sphere that moves with the camera, so they
 * sit at infinity (no parallax) whatever the scene's scale. Colours are blackbody colours
 * for temperatures drawn from a rough mix of real stars (mostly cool, a few hot); none are
 * labelled or meant as real stars. One draw call.
 */

export interface Starfield {
  readonly object: Sprite;
  setLight(light: number): void;
  /** Moves the sphere of stars (only with options.dynamicRadius; otherwise a no-op). */
  setRadius(radius: number): void;
  dispose(): void;
}

/** Optional extras for views other than the chapters' (left out, the stars are the chapters' exactly). */
export interface StarfieldOptions {
  /** Test against the depth buffer, so planets hide the stars behind them. Default false (drawn over everything). */
  depthTest?: boolean;
  /** The sphere's radius is a uniform that setRadius() moves (a view whose far plane changes every frame). */
  dynamicRadius?: boolean;
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

export function createStarfield(count = 7000, radius = 400, seed = 7_101, options?: StarfieldOptions): Starfield {
  const random = prng(seed);
  const directions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const z = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    directions.set([s * Math.cos(phi), z, s * Math.sin(phi)], i * 3);
    // Mostly cool stars, a few hot ones; brightness falls steeply (many faint, few bright).
    const kelvin = random() < 0.12 ? 9000 + random() * 16_000 : 3200 + random() * 3800;
    const rgb = blackbodyRgb(kelvin);
    const light = 0.05 + 0.6 * random() ** 6;
    colors.set([rgb[0] * light, rgb[1] * light, rgb[2] * light], i * 3);
  }
  const direction = instancedBufferAttribute(new InstancedBufferAttribute(directions, 3)) as unknown as Node<'vec3'>;
  const color = instancedBufferAttribute(new InstancedBufferAttribute(colors, 3)) as unknown as Node<'vec3'>;
  const uLight = uniform(1);
  const uRadius = options?.dynamicRadius ? uniform(radius) : null;
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: options?.depthTest ?? false,
    sizeAttenuation: false,
    fog: false,
  });
  material.positionNode = cameraPosition.add(direction.mul(uRadius ?? radius));
  material.sizeNode = float(2.2);
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  material.colorNode = color.mul(exp(r2.mul(-6)).mul(max(float(1).sub(r2), 0))).mul(uLight);
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.name = 'starfield';
  sprite.renderOrder = -10;
  return {
    object: sprite,
    setLight(light) {
      uLight.value = light;
      sprite.visible = light > 1e-3;
    },
    setRadius(next) {
      if (uRadius) uRadius.value = next;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
