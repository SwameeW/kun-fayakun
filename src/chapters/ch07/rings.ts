import { InstancedBufferAttribute, Vector3, type Node } from 'three/webgpu';
import { float, instancedBufferAttribute, uniform, vec3 } from 'three/tsl';
import { createStreakField, type StreakField } from '../shared/streaks';

/**
 * Orbits drawn as fine engraved rings of warm light, graduated like the limb of an
 * astrolabe: a tick every 10 degrees around the Sun, a longer one every 30. Each ring is
 * the planet's real orbit for today (from the JPL elements), compressed for display. One
 * draw call of screen-space hairlines (constant pixel width at any distance).
 */

export interface Rings {
  readonly field: StreakField;
  update(state: { light: number; offset: Vector3; scale: number }): void;
  dispose(): void;
}

const SEGMENTS = 240;
const RING_COLOR = vec3(0.96, 0.74, 0.44);

/** `orbits`: one closed loop of points per planet (scene units), in order around the Sun. */
export function createRings(orbits: ReadonlyArray<readonly Vector3[]>): Rings {
  const heads: number[] = [];
  const tails: number[] = [];
  const weights: number[] = [];
  const push = (a: Vector3, b: Vector3, weight: number): void => {
    heads.push(a.x, a.y, a.z);
    tails.push(b.x, b.y, b.z);
    weights.push(weight);
  };
  const inner = new Vector3();
  const outer = new Vector3();
  for (const loop of orbits) {
    const n = loop.length;
    for (let i = 0; i < n; i += 1) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      if (a && b) push(a, b, 1);
    }
    // Graduations: the loop point nearest each 10-degree direction from the Sun.
    for (let deg = 0; deg < 360; deg += 10) {
      const angle = (deg * Math.PI) / 180;
      let best: Vector3 | undefined;
      let bestDot = -Infinity;
      for (const p of loop) {
        const d = (p.x * Math.cos(angle) + p.z * Math.sin(angle)) / Math.max(1e-6, Math.hypot(p.x, p.z));
        if (d > bestDot) {
          bestDot = d;
          best = p;
        }
      }
      if (!best) continue;
      const long = deg % 30 === 0;
      const reach = long ? 0.035 : 0.018;
      inner.copy(best).multiplyScalar(1 - reach);
      outer.copy(best).multiplyScalar(1 + reach);
      push(outer, inner, long ? 1.5 : 1.15);
    }
  }
  const count = weights.length;
  const head = instancedBufferAttribute(new InstancedBufferAttribute(new Float32Array(heads), 3)) as unknown as Node<'vec3'>;
  const tail = instancedBufferAttribute(new InstancedBufferAttribute(new Float32Array(tails), 3)) as unknown as Node<'vec3'>;
  const weight = instancedBufferAttribute(new InstancedBufferAttribute(new Float32Array(weights), 1)) as unknown as Node<'float'>;
  const uOffset = uniform(new Vector3());
  const uScale = uniform(1);
  const uLight = uniform(0);
  const field = createStreakField({
    name: 'ch07-orbit-rings',
    maxCount: count,
    head: head.mul(uScale).add(uOffset),
    tail: tail.mul(uScale).add(uOffset),
    color: RING_COLOR.mul(weight).mul(uLight).mul(0.42),
    width: float(0.0011),
  });
  field.mesh.visible = false;
  return {
    field,
    update(state) {
      uLight.value = state.light;
      uOffset.value.copy(state.offset);
      uScale.value = state.scale;
      field.mesh.visible = state.light > 1e-3;
    },
    dispose() {
      field.dispose();
    },
  };
}

export { SEGMENTS as RING_SEGMENTS };
