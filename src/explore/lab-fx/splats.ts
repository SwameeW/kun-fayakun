import { BufferAttribute, BufferGeometry, InstancedBufferAttribute, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { exp, float, instancedDynamicBufferAttribute, length, max, uv } from 'three/tsl';
import { blendAdditive } from '../render/blending';

/**
 * Soft points of light (docs/SANDBOX-ROADMAP.md W1.8): the laboratory's dust, rings and belts, its
 * impacts' decorative plumes, and its fireballs. Not the explorer's star-like points (a bright core and
 * a narrow halo, ./bodies/impostor): a dust cloud is a haze, so each particle is a soft round splat,
 * exp(-3 g^2) with no core, as wide as the spacing between particles on screen (2.5 to 36 CSS px) and
 * as much dimmer as it is wider, (2.5 / size)^2, so the light a swarm sends is the same at every size
 * (splatGain). A fireball's splat has a core (it is a glowing ball, not a haze). Colours are linear,
 * in the scene's terms (lit as the worlds are, through the explorer's exposure). One draw call each.
 */

export interface Splat {
  /** Where (camera-relative, scaled space, km), its size (CSS px across) and colour (linear, the splat's peak). */
  x: number;
  y: number;
  z: number;
  sizePx: number;
  r: number;
  g: number;
  b: number;
}

export interface Splats {
  readonly object: Sprite;
  /** Draws the first `count` splats. */
  update(list: readonly Splat[], count: number): void;
  dispose(): void;
}

/** The size (CSS px) a splat's colour is given at: wider ones are dimmer by (SPLAT_REF_PX / size)^2. */
export const SPLAT_REF_PX = 2.5;
export const SPLAT_SIZE = { min: 2.5, max: 36 } as const;

/** The soft splat's profile at g (the distance from its centre over half its size). */
export const splatProfile = (g: number): number => Math.exp(-3 * g * g);
/** What a splat `sizePx` across is dimmed by so its light is the same at every size. */
export const splatGain = (sizePx: number): number => (SPLAT_REF_PX / Math.max(sizePx, 1e-6)) ** 2;

/** The sprite is drawn this much wider than the splat's size, so its tail is not cut. */
const MARGIN = { soft: 1.6, fire: 2.4 } as const;

export function createSplats(capacity: number, kind: 'soft' | 'fire', depthTest = true): Splats {
  const at = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const place = instancedDynamicBufferAttribute(at) as unknown as Node<'vec4'>;
  const colour = instancedDynamicBufferAttribute(tint) as unknown as Node<'vec4'>;
  const material = blendAdditive(new PointsNodeMaterial({ transparent: true, depthWrite: false, depthTest, sizeAttenuation: false, fog: false }));
  const margin = MARGIN[kind];
  material.positionNode = place.xyz;
  material.sizeNode = place.w.mul(margin);
  // g: the distance from the centre over half the splat's size.
  const g = length(uv().sub(0.5)).mul(2 * margin);
  const g2 = g.mul(g);
  const profile = kind === 'soft' ? exp(g2.mul(-3)) : exp(g2.mul(-4)).add(exp(g2.mul(-0.9)).mul(0.3));
  material.colorNode = colour.xyz.mul(profile.mul(max(float(1).sub(g2.div(margin * margin)), 0)));
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.frustumCulled = false;
  sprite.name = `lab-splats-${kind}`;
  sprite.renderOrder = -1;
  sprite.visible = false;
  const a = at.array as Float32Array;
  const c = tint.array as Float32Array;
  return {
    object: sprite,
    update(list, count) {
      let n = 0;
      for (let i = 0; i < count && n < capacity; i += 1) {
        const s = list[i];
        if (!s || s.r + s.g + s.b <= 1e-7) continue;
        a[n * 4] = s.x;
        a[n * 4 + 1] = s.y;
        a[n * 4 + 2] = s.z;
        a[n * 4 + 3] = s.sizePx;
        c[n * 4] = s.r;
        c[n * 4 + 1] = s.g;
        c[n * 4 + 2] = s.b;
        n += 1;
      }
      sprite.count = Math.max(1, n);
      sprite.visible = n > 0;
      if (n > 0) {
        at.needsUpdate = true;
        tint.needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
