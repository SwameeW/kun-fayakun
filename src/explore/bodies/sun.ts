/**
 * The Sun's disc, for the explorer. Seen small it is a brilliant white point that the glare
 * (./glare) surrounds; seen large it is shown as through a solar filter, the way the Sun is
 * photographed: amber, its limb strongly darkened and reddened (there we see higher, cooler layers),
 * its surface mottled by supergranulation and, up close, granulation, with bright faculae toward the
 * limb, and a crisp edge. The mottling is illustrative; its scales and the limb darkening's form are
 * the real Sun's. The colour is the blackbody colour of its temperature, never picked by eye.
 */

import { FrontSide, Group, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Data3DTexture } from 'three/webgpu';
import { abs, dot, float, mix, normalize, normalView, positionLocal, positionViewDirection, pow, smoothstep, texture3D, uniform, vec3 } from 'three/tsl';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import { keepOnSphere, noiseIfKept, sphereFootprint, type FloatNode, type Tier, type Vec3Node } from './shading';

const SEGMENTS: Readonly<Record<Tier, readonly [number, number]>> = { high: [128, 96], mid: [96, 72], low: [64, 48] };
/** The limb's light comes from layers about this much cooler (its reddening). */
const LIMB_COOLING = 0.66;
/** Limb darkening, I(mu) / I(1) = a + b mu + c mu^2: the usual quadratic form, about as strong as in visible light. */
const LIMB = { a: 0.16, b: 1.05, c: -0.21 } as const;

export interface SunFrame {
  time: number;
  kelvin: number;
  /** The disc's brightness (scene units). */
  light: number;
  /** The filter's colour (white for none). */
  filter: readonly [number, number, number];
}

export interface ExploreSun {
  readonly object: Group;
  update(frame: SunFrame): void;
  setTier(tier: Tier): void;
  dispose(): void;
}

export function createSun(noise: Data3DTexture, tier: Tier): ExploreSun {
  const object = new Group();
  object.name = 'explore-sun';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uCentre = uniform(new Vector3(1, 1, 1));
  const uLimb = uniform(new Vector3(1, 0.7, 0.4));
  const uFilter = uniform(new Vector3(1, 1, 1));

  const build = (level: Tier): MeshBasicNodeMaterial => {
    const n = normalize(positionLocal);
    const footprint = sphereFootprint(n);
    const T = (p: Vec3Node): FloatNode => texture3D(noise, p).r;
    const mu = abs(dot(normalView, positionViewDirection));
    const darkening = float(LIMB.a).add(mu.mul(LIMB.b)).add(mu.mul(mu).mul(LIMB.c));
    // Large, slow cells (the chapters' boiling), then supergranulation and granulation as the disc grows.
    const cells = T(n.mul(2.2).add(vec3(uTime.mul(0.006), 0.31, uTime.mul(-0.004)))).sub(0.5);
    // Supergranulation (cells about a twentieth of the radius), then granulation once the disc is large.
    const network = T(n.mul(7).add(vec3(uTime.mul(0.002), 0.81, 0))).sub(0.5).mul(keepOnSphere(footprint, 56));
    const granulesKept = keepOnSphere(footprint, 320);
    const finerKept = keepOnSphere(footprint, 1200);
    const granules = level === 'low' ? float(0) : noiseIfKept(noise, n.mul(40).add(vec3(0, uTime.mul(0.01), 0.27)), granulesKept).sub(0.5).mul(granulesKept);
    const finer = level === 'high' ? noiseIfKept(noise, n.mul(150).add(vec3(0.53, 0, uTime.mul(0.015))), finerKept).sub(0.5).mul(finerKept) : float(0);
    const mottle = cells.mul(0.12).add(network.mul(0.22)).add(granules.mul(0.28)).add(finer.mul(0.22)).add(1);
    // Faculae: bright patches of the network, seen best toward the limb.
    const faculae = smoothstep(0.1, 0.28, network).mul(float(1).sub(smoothstep(0.06, 0.45, mu))).mul(0.5);
    const tint = mix(uLimb, uCentre, pow(mu, 0.45));
    const disc: Vec3Node = tint.mul(darkening).mul(mottle.add(faculae)).mul(uFilter).mul(uLight);
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = disc;
    return material;
  };

  const materials = new Map<Tier, MeshBasicNodeMaterial>();
  const materialFor = (level: Tier): MeshBasicNodeMaterial => {
    let m = materials.get(level);
    if (!m) {
      m = build(level);
      materials.set(level, m);
    }
    return m;
  };
  let geometry = new SphereGeometry(1, ...SEGMENTS[tier]);
  const mesh = new Mesh(geometry, materialFor(tier));
  mesh.name = 'explore-sun-disc';
  object.add(mesh);
  let current = tier;
  let kelvin = 0;

  return {
    object,
    update(frame) {
      uTime.value = frame.time;
      uLight.value = frame.light;
      uFilter.value.set(frame.filter[0], frame.filter[1], frame.filter[2]);
      if (frame.kelvin !== kelvin) {
        kelvin = frame.kelvin;
        const centre = blackbodyRgb(kelvin);
        const limb = blackbodyRgb(kelvin * LIMB_COOLING);
        uCentre.value.set(centre[0], centre[1], centre[2]);
        uLimb.value.set(limb[0], limb[1], limb[2]);
      }
      object.visible = frame.light > 1e-4;
    },
    setTier(next) {
      if (next === current) return;
      current = next;
      const old = geometry;
      geometry = new SphereGeometry(1, ...SEGMENTS[next]);
      mesh.geometry = geometry;
      old.dispose();
      mesh.material = materialFor(next);
    },
    dispose() {
      geometry.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}
