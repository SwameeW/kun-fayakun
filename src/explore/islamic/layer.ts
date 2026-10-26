import { BufferAttribute, BufferGeometry, InstancedBufferAttribute, Matrix3, NormalBlending, PointsNodeMaterial, Sprite, Vector3, type Node } from 'three/webgpu';
import { dot, float, instancedBufferAttribute, normalize, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { bodyFrame } from '../living/quakes';

/**
 * Marks on the Earth for the qibla and the new moon: dots along the great circle to the Kaaba, along
 * the golden latitude and the Kaaba's own, and the new crescent's map (a dot for each place, coloured
 * by Yallop's zone). Each set is one instanced sprite placed in the Earth's own frame (so it turns
 * with the Earth) just above the ground, fading where the ground turns away over the horizon. Sizes
 * are in screen pixels.
 */

export interface MarkSet {
  /** Places, degrees (lat, lon pairs). */
  points: readonly number[];
  /** A colour for each place (r, g, b, 0 to 1), or one for all. */
  colors: readonly number[] | readonly [number, number, number];
  sizePx: number;
}

export interface IslamicLayerFrame {
  earth: { x: number; y: number; z: number };
  basis: readonly number[];
  earthRadiusKm: number;
  visible: boolean;
}

export interface IslamicLayer {
  readonly objects: readonly Sprite[];
  /** Replaces a set of marks (null clears it). */
  set(which: 'path' | 'lines' | 'map', marks: MarkSet | null): void;
  update(frame: IslamicLayerFrame): void;
  /** How many marks each set holds now (for the view and the tests). */
  counts(): { path: number; lines: number; map: number };
  dispose(): void;
}

/** Just above the ground (a few km), as the earthquake rings stand. */
const LIFT = 1.0008;

interface MarkSprite {
  readonly sprite: Sprite;
  fill(marks: MarkSet | null, radiusKm: number): void;
  /** Eases toward shown or hidden and places it with the Earth; false while it is not drawn. */
  frame(show: boolean, frame: IslamicLayerFrame): boolean;
  dispose(): void;
}

function markSprite(name: string, order: number): MarkSprite {
  const uEarth = uniform(new Vector3());
  const uBasis = uniform(new Matrix3());
  const uFade = uniform(0);
  const uSize = uniform(4);
  let positions = new InstancedBufferAttribute(new Float32Array(3), 3);
  let colors = new InstancedBufferAttribute(new Float32Array(3), 3);
  const material = new PointsNodeMaterial({ transparent: true, blending: NormalBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = 0;
  sprite.frustumCulled = false;
  sprite.visible = false;
  sprite.name = name;
  sprite.renderOrder = order;

  const bind = (): void => {
    const p = instancedBufferAttribute(positions) as unknown as Node<'vec3'>;
    const c = instancedBufferAttribute(colors) as unknown as Node<'vec3'>;
    const world = uEarth.add(uBasis.mul(p));
    material.positionNode = world;
    material.sizeNode = uSize;
    // Turned away over the horizon: the place's normal faces away from the camera (at the origin).
    const facing = smoothstep(-0.02, 0.08, dot(normalize(uBasis.mul(p)), normalize(world.negate())));
    const r = uv().sub(0.5).mul(2).length();
    const disc = float(1).sub(smoothstep(0.55, 1, r));
    material.colorNode = vec3(c);
    material.opacityNode = disc.mul(facing).mul(uFade);
    material.needsUpdate = true;
  };
  bind();

  return {
    sprite,
    frame(show, frame) {
      uFade.value += ((show ? 1 : 0) - uFade.value) * 0.15;
      if (uFade.value < 0.002 && !show) uFade.value = 0;
      sprite.visible = uFade.value > 0 && sprite.count > 0;
      if (!sprite.visible) return false;
      uEarth.value.set(frame.earth.x, frame.earth.y, frame.earth.z);
      const m = frame.basis;
      uBasis.value.set(m[0] ?? 1, m[3] ?? 0, m[6] ?? 0, m[1] ?? 0, m[4] ?? 1, m[7] ?? 0, m[2] ?? 0, m[5] ?? 0, m[8] ?? 1);
      return true;
    },
    fill(marks, radiusKm) {
      const n = marks ? marks.points.length / 2 : 0;
      positions = new InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      colors = new InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      const v = new Vector3();
      const each = marks !== null && marks.colors.length === n * 3;
      for (let k = 0; k < n && marks; k += 1) {
        bodyFrame(marks.points[k * 2] ?? 0, marks.points[k * 2 + 1] ?? 0, radiusKm * LIFT, v);
        positions.array.set([v.x, v.y, v.z], k * 3);
        const at = each ? k * 3 : 0;
        colors.array.set([marks.colors[at] ?? 1, marks.colors[at + 1] ?? 1, marks.colors[at + 2] ?? 1], k * 3);
      }
      uSize.value = marks?.sizePx ?? 4;
      sprite.count = n;
      bind();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createIslamicLayer(): IslamicLayer {
  const sets = {
    path: markSprite('explore-qibla-path', 4),
    lines: markSprite('explore-qibla-lines', 4),
    map: markSprite('explore-crescent-map', 3),
  };
  const pending = new Map<keyof typeof sets, MarkSet | null>();
  const counts = { path: 0, lines: 0, map: 0 };
  return {
    objects: [sets.map.sprite, sets.lines.sprite, sets.path.sprite],
    set(which, marks) {
      pending.set(which, marks);
      counts[which] = marks ? marks.points.length / 2 : 0;
    },
    update(frame) {
      for (const [which, marks] of pending) sets[which].fill(marks, frame.earthRadiusKm);
      pending.clear();
      for (const s of Object.values(sets)) s.frame(frame.visible && s.sprite.count > 0, frame);
    },
    counts() {
      return { ...counts };
    },
    dispose() {
      for (const s of Object.values(sets)) s.dispose();
    },
  };
}
