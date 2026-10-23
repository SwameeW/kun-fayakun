import {
  AdditiveBlending,
  CircleGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import {
  abs,
  Discard,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  mix,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  smoothstep,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl';
import { HOT, STAR_LAYERS } from './layers';

/**
 * A massive star cut open: three quarters of its glowing surface, and two flat faces
 * where a wedge has been removed, banded by element from the hydrogen envelope down to
 * the iron core (schematic, not to scale). Each band turns over slowly (the shells
 * convect). Then the collapse: the iron core falls in, a shock wave rebounds and runs out
 * through the layers (a bright ring on the faces, a glowing shell inside the cut), heating
 * all it passes; when it reaches the surface the star is torn apart and the debris takes
 * over. The cut faces the camera's side of the star.
 */

export interface StarState {
  /** Chapter seconds (the shells' slow turning). */
  time: number;
  /** Iron core's radius relative to its size before collapse (1 → small). */
  core: number;
  /** Shock radius as a fraction of the star's radius (0 before the bounce). */
  shock: number;
  /** Brightness of the shock and the heat behind it, 0 to 1. */
  shockLight: number;
  /** Overall light (fades the star in, and out as it is torn apart). */
  light: number;
}

export interface MassiveStar {
  readonly object: Group;
  readonly radius: number;
  update(state: StarState): void;
  /** World position at radius fraction r on the right-hand cut face, `angle` radians above its horizontal. */
  facePoint(r: number, angle: number, out: Vector3): Vector3;
  dispose(): void;
}

const SURFACE = vec3(1.0, 0.4, 0.16).mul(0.62);
const HOT_NODE = vec3(...HOT);
/** Turned so the removed wedge faces the camera, a little more of the right-hand face showing. */
const TURN = -Math.PI / 4 + 0.22;

function bandColor(r: Node<'float'>, core: Node<'float'>): Node<'vec3'> {
  // Innermost first; the iron core shrinks as it collapses and the silicon above it follows it in.
  const first = STAR_LAYERS[0];
  let color: Node<'vec3'> = vec3(...(first?.color ?? HOT));
  let separators: Node<'float'> = float(0);
  STAR_LAYERS.forEach((layer, i) => {
    const next = STAR_LAYERS[i + 1];
    if (!next) return;
    const edge = i === 0 ? float(layer.outer).mul(core) : float(layer.outer);
    color = mix(color, vec3(...next.color), smoothstep(edge.sub(0.006), edge.add(0.006), r));
    separators = separators.add(exp(r.sub(edge).div(0.006).pow(2).negate()));
  });
  return color.mul(float(1).sub(separators.mul(0.45)));
}

export function createMassiveStar(noise: Data3DTexture, radius: number): MassiveStar {
  const object = new Group();
  object.name = 'ch06-star';
  object.rotation.y = TURN;
  object.scale.setScalar(radius);

  const uTime = uniform(0);
  const uCore = uniform(1);
  const uShock = uniform(0);
  const uShockLight = uniform(0);
  const uLight = uniform(0);

  // The surface: a red supergiant's large convection cells, darker toward the limb.
  const surface = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  surface.colorNode = Fn(() => {
    const p = positionLocal;
    If(p.x.greaterThan(0).and(p.z.greaterThan(0)), () => {
      Discard();
    });
    const cells = texture3D(noise, p.mul(0.85).add(vec3(0, uTime.mul(0.006), 0))).r;
    const fine = texture3D(noise, p.mul(2.6).add(vec3(uTime.mul(0.01), 0, 0))).r;
    const mu = abs(dot(normalView, positionViewDirection));
    const limb = float(0.35).add(pow(mu, 0.55).mul(0.75));
    const grain = cells.mul(0.9).add(fine.mul(0.45)).sub(0.35);
    return SURFACE.mul(limb).mul(grain.mul(1.1).add(0.55)).mul(uLight);
  })();
  const sphere = new SphereGeometry(1, 128, 96);
  const shell = new Mesh(sphere, surface);
  shell.name = 'ch06-star-surface';

  // The two cut faces: half-discs in the planes x = 0 and z = 0 that bound the removed wedge.
  const faceGeometry = new CircleGeometry(1, 160, -Math.PI / 2, Math.PI);
  /** `shade` sets the face apart from its neighbour, as if turned a little from the light, so the cut reads as a corner. */
  const faceMaterial = (offset: number, shade: number): MeshBasicNodeMaterial => {
    const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
    const q = positionLocal.xy;
    const r = length(q);
    const turning = texture3D(noise, vec3(q.mul(1.5), uTime.mul(0.025).add(offset))).r.sub(0.5);
    // Hotter inward: the envelope glows dull, the core white.
    const heat = mix(float(1.15), float(0.62), smoothstep(0, 1, r));
    const banded = bandColor(r, uCore).mul(heat).mul(turning.mul(0.7).add(1));
    // Behind the shock everything is heated toward white; at the shock, a bright thin ring.
    const behind = smoothstep(uShock.add(0.012), uShock.sub(0.04), r).mul(uShockLight);
    const ring = exp(r.sub(uShock).div(0.016).pow(2).negate()).mul(uShockLight);
    const shocked = mix(banded, HOT_NODE.mul(0.95), behind.mul(0.45)).add(HOT_NODE.mul(ring.mul(1.6)));
    // The collapsed core: a tiny, intensely hot remnant at the centre.
    const remnant = exp(r.div(0.018).pow(2).negate()).mul(float(1).sub(uCore).mul(3));
    material.colorNode = shocked.mul(shade).add(HOT_NODE.mul(remnant)).mul(uLight);
    return material;
  };
  const faceRight = new Mesh(faceGeometry, faceMaterial(0, 1));
  faceRight.name = 'ch06-star-face';
  const faceLeft = new Mesh(faceGeometry, faceMaterial(0.37, 0.74));
  faceLeft.rotation.y = -Math.PI / 2;
  faceLeft.name = 'ch06-star-face';

  // The shock as a glowing shell, seen through the cut (and outside the star once it breaks out).
  const shockMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: FrontSide,
    fog: false,
  });
  const facing = abs(dot(normalView, positionViewDirection));
  shockMaterial.colorNode = HOT_NODE.mul(pow(float(1).sub(facing), 2.5).mul(1.0).add(0.04)).mul(uShockLight).mul(uLight);
  shockMaterial.opacityNode = float(1);
  const shockGeometry = new SphereGeometry(1, 64, 48);
  const shockShell = new Mesh(shockGeometry, shockMaterial);
  shockShell.name = 'ch06-shock';
  shockShell.visible = false;

  object.add(shell, faceRight, faceLeft, shockShell);
  const local = new Vector3();

  return {
    object,
    radius,
    update(state) {
      uTime.value = state.time;
      uCore.value = state.core;
      uShock.value = state.shock;
      uShockLight.value = state.shockLight;
      uLight.value = state.light;
      object.visible = state.light > 1e-3;
      shockShell.visible = state.shockLight > 1e-3 && state.shock > 0.01;
      shockShell.scale.setScalar(Math.max(state.shock, 1e-3));
    },
    facePoint(r, angle, out) {
      local.set(r * Math.cos(angle), r * Math.sin(angle), 0);
      object.updateMatrixWorld();
      return out.copy(local).applyMatrix4(object.matrixWorld);
    },
    dispose() {
      sphere.dispose();
      surface.dispose();
      faceGeometry.dispose();
      faceRight.material.dispose();
      faceLeft.material.dispose();
      shockGeometry.dispose();
      shockMaterial.dispose();
    },
  };
}
