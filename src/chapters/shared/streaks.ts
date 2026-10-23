import { AdditiveBlending, BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  exp,
  float,
  length,
  max,
  mix,
  pow,
  screenSize,
  select,
  uv,
  varying,
  vec2,
  vec4,
} from 'three/tsl';

/**
 * Instanced light streaks: each instance is a camera-facing quad stretched in
 * screen space from a tail to a head position, with a width that is a fixed share
 * of the screen height. A still particle is a round spark; a moving one draws a
 * short trail of light along its motion, which reads as speed without motion blur.
 *
 * Built like a screen-space line: both ends are projected, the quad is widened
 * along the screen-space normal and capped by half a width at each end, so it
 * never thins to nothing when the trail is short. One draw call for all instances
 * (`mesh.count`); positions come from TSL functions of instanceIndex, so motion is
 * computed in the vertex stage on both WebGPU and WebGL2 (no compute pass needed).
 */

export interface StreakOptions {
  name: string;
  maxCount: number;
  /** World-space head (current position) of instance `instanceIndex`. */
  head: Node<'vec3'>;
  /** World-space tail (where the trail starts). Equal to head for a round spark. */
  tail: Node<'vec3'>;
  /** Linear radiance of the streak's brightest point (head). */
  color: Node<'vec3'>;
  /** Full width as a share of the screen height (0.003 ≈ 3 px at 1080p). */
  width: Node<'float'>;
  /**
   * 'trail' (default): a spark with a fading trail, dimmer the longer it is drawn out (motion).
   * 'line': an even hairline with no end caps, so instances laid end to end draw one steady
   * polyline (orbits).
   */
  profile?: 'trail' | 'line';
  /**
   * With 'line': the colour at the tail end, blended along the segment to `color` at the head, so a
   * polyline's brightness can change smoothly along it (a fade never steps from segment to segment).
   */
  tailColor?: Node<'vec3'>;
}

export interface StreakField {
  readonly mesh: Mesh;
  setCount(count: number): void;
  dispose(): void;
}

function createQuad(): BufferGeometry {
  // uv.x: 0 at the tail, 1 at the head; uv.y: 0..1 across.
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

export function createStreakField(options: StreakOptions): StreakField {
  const viewProjection = cameraProjectionMatrix.mul(cameraViewMatrix);
  const head = viewProjection.mul(vec4(options.head, 1));
  const tailRaw = viewProjection.mul(vec4(options.tail, 1));
  // A tail behind the camera would flip through infinity: fall back to a spark.
  const tail = select(tailRaw.w.greaterThan(0.01), tailRaw, head);
  const pixels = screenSize;
  const headPx = head.xy.div(head.w).mul(pixels).mul(0.5);
  const tailPx = tail.xy.div(tail.w).mul(pixels).mul(0.5);
  const delta = headPx.sub(tailPx);
  const span = length(delta);
  const dir = select(span.greaterThan(1e-3), delta.div(max(span, 1e-3)), vec2(1, 0));
  const normal = vec2(dir.y.negate(), dir.x);
  const along = uv().x;
  const across = uv().y.mul(2).sub(1);
  const halfWidth = options.width.mul(pixels.y).mul(0.5).max(0.75);
  const line = options.profile === 'line';
  const base = mix(tail, head, along);
  const sideways = normal.mul(across.mul(halfWidth));
  const offsetPx = line ? sideways : sideways.add(dir.mul(along.mul(2).sub(1).mul(halfWidth)));
  const offsetClip = offsetPx.div(pixels).mul(2).mul(base.w);
  const placed = vec4(base.xy.add(offsetClip), base.z, base.w);
  // Heads behind the camera are pushed outside the clip volume.
  const vertex = select(head.w.greaterThan(0.01), placed, vec4(0, 0, 2, 1));

  // Brightness along the trail (dim tail, bright head) and a soft round profile across.
  const trailShare = span.div(span.add(halfWidth.mul(2)));
  const alongFade = mix(float(1), pow(along, 1.6), varying(trailShare));
  const profile = exp(across.mul(across).mul(-3.2));

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vertex;
  // Motion blur spreads the same light along a longer trail, so it is dimmer per pixel. Fully
  // conserving energy would make fast streaks vanish; a partial falloff keeps them legible.
  const energy = pow(halfWidth.mul(2).div(span.add(halfWidth.mul(2))), 0.55);
  const lineColour = options.tailColor ? mix(varying(options.tailColor), varying(options.color), along) : varying(options.color);
  material.colorNode = line ? lineColour.mul(profile) : varying(options.color.mul(energy)).mul(alongFade.mul(profile));
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = true;
  material.fog = false;

  const geometry = createQuad();
  const mesh = new Mesh(geometry, material);
  mesh.name = options.name;
  mesh.frustumCulled = false;
  mesh.count = options.maxCount;

  return {
    mesh,
    setCount(count) {
      mesh.count = Math.max(1, Math.min(options.maxCount, Math.floor(count)));
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
