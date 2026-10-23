import { AdditiveBlending, FrontSide, Mesh, MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu';
import { abs, dot, float, normalView, positionViewDirection, pow, uniform, vec3 } from 'three/tsl';

/**
 * The limit of the observable universe, seen from outside as a faint shell: almost
 * clear where we look straight through it, a soft rim of light where the line of sight
 * grazes it. Centred on us; its radius is set from the constant the panel cites.
 */

export interface Horizon {
  readonly object: Mesh;
  /** Radius in world units; opacity 0 hides it. */
  update(state: { radius: number; opacity: number }): void;
  dispose(): void;
}

const RIM_COLOR = vec3(0.86, 0.8, 0.68);

export function createHorizon(): Horizon {
  const uOpacity = uniform(0);
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: FrontSide,
    fog: false,
  });
  const facing = abs(dot(normalView, positionViewDirection));
  const rim = pow(float(1).sub(facing), 4);
  material.colorNode = RIM_COLOR.mul(rim.mul(0.8).add(0.006)).mul(uOpacity);
  material.opacityNode = float(1);
  const geometry = new SphereGeometry(1, 128, 64);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ch05-horizon';
  mesh.frustumCulled = false;
  mesh.visible = false;
  return {
    object: mesh,
    update(state) {
      mesh.scale.setScalar(state.radius);
      uOpacity.value = state.opacity;
      mesh.visible = state.opacity > 1e-3;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
