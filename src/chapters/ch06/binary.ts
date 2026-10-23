import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PointsNodeMaterial,
  SphereGeometry,
  Sprite,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import {
  abs,
  cos,
  dot,
  exp,
  float,
  fract,
  hash,
  instanceIndex,
  max,
  min,
  mix,
  normalView,
  normalize,
  positionLocal,
  positionViewDirection,
  pow,
  sin,
  texture3D,
  uniform,
  uv,
  varying,
  vec3,
} from 'three/tsl';
import { HOT } from './layers';

/**
 * A white dwarf drawing gas from a close companion star: the companion fills its share of
 * the space between them and is pulled into a teardrop; a stream of its gas pours from the
 * tip, curving as the pair turns, into a disc that whirls around the white dwarf, hottest
 * nearest it. The white dwarf itself is tiny and intensely hot. The system turns slowly.
 */

export interface BinaryState {
  time: number;
  /** Turn of the pair about the white dwarf, radians (0 puts the companion to the dwarf's -x side). */
  turn: number;
  /** Fade of the whole system. */
  light: number;
  /** The stream and disc (blown away when the white dwarf explodes). */
  flow: number;
  /** The white dwarf's own light (gone when it explodes). */
  dwarf: number;
}

export interface Binary {
  readonly object: Group;
  update(state: BinaryState): void;
  /** World positions of the white dwarf and of the top of the companion. */
  dwarfPosition(out: Vector3): Vector3;
  companionTop(out: Vector3): Vector3;
  dispose(): void;
}

const COMPANION = { centre: new Vector3(-2.3, 0, 0.4), radius: 0.95 } as const;
const DWARF_RADIUS = 0.07;
const DISC = { inner: 0.12, outer: 0.74, count: 26_000 } as const;
const STREAM_COUNT = 6_000;
const COMPANION_COLOR = vec3(1.0, 0.6, 0.26);
/** A star's face: yellow-white at the centre, deepening to orange at the limb (limb darkening). */
const COMPANION_CENTRE = vec3(1.0, 0.68, 0.32);
const COMPANION_LIMB = vec3(1.0, 0.36, 0.08);
const DISC_HOT = vec3(0.72, 0.8, 1.0);
const DISC_COOL = vec3(1.0, 0.6, 0.3);

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

function softDisc(): Node<'float'> {
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  return exp(r2.mul(-4.5)).mul(max(float(1).sub(r2), 0));
}

function points(name: string, count: number): { sprite: Sprite; material: PointsNodeMaterial; geometry: BufferGeometry } {
  const material = new PointsNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,
    fog: false,
  });
  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = count;
  sprite.name = name;
  sprite.frustumCulled = false;
  return { sprite, material, geometry };
}

export function createBinary(noise: Data3DTexture, centre: readonly [number, number, number]): Binary {
  const object = new Group();
  object.name = 'ch06-binary';
  object.position.set(...centre);
  const uTime = uniform(0);
  const uLight = uniform(0);
  const uFlow = uniform(0);
  const uDwarf = uniform(0);
  const toDwarf = COMPANION.centre.clone().negate().normalize();

  // The companion, drawn out toward the white dwarf.
  const companionMaterial = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  const towards = vec3(toDwarf.x, toDwarf.y, toDwarf.z);
  const pull = pow(max(dot(normalize(positionLocal), towards), 0), 5).mul(0.42).add(1);
  companionMaterial.positionNode = positionLocal.mul(pull);
  const cells = texture3D(noise, positionLocal.mul(1.6).add(vec3(0, uTime.mul(0.01), 0))).r;
  const mu = abs(dot(normalView, positionViewDirection));
  // Bright enough to glow (a star, not a lit ball): yellow-white face, orange limb.
  companionMaterial.colorNode = mix(COMPANION_LIMB, COMPANION_CENTRE, pow(mu, 0.7))
    .mul(float(0.4).add(pow(mu, 0.8).mul(1.2)))
    .mul(cells.mul(0.3).add(0.85))
    .mul(uLight);
  const companionGeometry = new SphereGeometry(COMPANION.radius, 96, 64);
  const companion = new Mesh(companionGeometry, companionMaterial);
  companion.position.copy(COMPANION.centre);
  companion.name = 'ch06-companion';

  // The white dwarf: a tiny, white-hot sphere with a glow around it.
  const dwarfMaterial = new MeshBasicNodeMaterial({ fog: false });
  dwarfMaterial.colorNode = vec3(...HOT).mul(3).mul(uLight).mul(uDwarf);
  const dwarfGeometry = new SphereGeometry(DWARF_RADIUS, 32, 24);
  const dwarf = new Mesh(dwarfGeometry, dwarfMaterial);
  dwarf.name = 'ch06-white-dwarf';
  const glow = points('ch06-white-dwarf-glow', 1);
  glow.material.positionNode = vec3(0, 0, 0);
  glow.material.sizeNode = float(46);
  glow.material.colorNode = vec3(...HOT).mul(softDisc().mul(0.6)).mul(uLight).mul(uDwarf);
  glow.material.opacityNode = float(1);

  // The accretion disc: points on circles, inner ones turning fastest (capped, so nothing strobes).
  const disc = points('ch06-disc', DISC.count);
  const ring = hash(instanceIndex.mul(4));
  const radius = mix(float(DISC.inner), float(DISC.outer), pow(ring, 0.8));
  const spin = min(pow(radius.div(DISC.outer), -1.5).mul(0.8), 6);
  const angle = hash(instanceIndex.mul(4).add(1)).mul(Math.PI * 2).sub(spin.mul(uTime));
  const height = hash(instanceIndex.mul(4).add(2)).sub(0.5).mul(radius.mul(0.05));
  disc.material.positionNode = vec3(cos(angle).mul(radius), height, sin(angle).mul(radius));
  const inner = float(1).sub(ring);
  const discLight = uLight.mul(uFlow).mul(inner.mul(0.9).add(0.25)).mul(hash(instanceIndex.mul(4).add(3)).mul(0.6).add(0.6)).mul(0.07);
  disc.material.sizeNode = float(1.8);
  disc.material.colorNode = varying(mix(DISC_COOL, DISC_HOT, pow(inner, 1.5)).mul(discLight)).mul(softDisc());
  disc.material.opacityNode = float(1);

  // The stream: gas flowing from the companion's tip along a curve into the disc's rim.
  const tip = COMPANION.centre.clone().addScaledVector(toDwarf, COMPANION.radius * 1.42);
  const control = new Vector3(-0.55, 0.02, 0.78);
  const landing = new Vector3(0.12, 0, DISC.outer * 0.97);
  const stream = points('ch06-stream', STREAM_COUNT);
  const s = fract(hash(instanceIndex.mul(5)).add(uTime.mul(0.22)));
  const a = vec3(tip.x, tip.y, tip.z);
  const b = vec3(control.x, control.y, control.z);
  const c = vec3(landing.x, landing.y, landing.z);
  const along = a.mul(float(1).sub(s).pow(2)).add(b.mul(s.mul(float(1).sub(s)).mul(2))).add(c.mul(s.mul(s)));
  const jitter = vec3(hash(instanceIndex.mul(5).add(1)), hash(instanceIndex.mul(5).add(2)), hash(instanceIndex.mul(5).add(3)))
    .sub(0.5)
    .mul(s.mul(0.06).add(0.025));
  stream.material.positionNode = along.add(jitter);
  stream.material.sizeNode = float(2);
  const streamLight = uLight.mul(uFlow).mul(0.12).mul(hash(instanceIndex.mul(5).add(4)).mul(0.6).add(0.6));
  stream.material.colorNode = varying(mix(COMPANION_COLOR, DISC_HOT, s).mul(streamLight)).mul(softDisc());
  stream.material.opacityNode = float(1);

  // A soft glow around the companion, so it reads as a star rather than a lit ball.
  const halo = points('ch06-companion-glow', 1);
  halo.material.positionNode = vec3(COMPANION.centre.x, COMPANION.centre.y, COMPANION.centre.z);
  halo.material.sizeNode = float(150);
  const h = uv().sub(0.5).mul(2);
  const h2 = dot(h, h);
  halo.material.colorNode = COMPANION_COLOR.mul(exp(h2.mul(-5)).mul(max(float(1).sub(h2), 0)).mul(0.12)).mul(uLight);
  halo.material.opacityNode = float(1);

  object.add(halo.sprite, companion, dwarf, glow.sprite, disc.sprite, stream.sprite);
  const local = new Vector3();

  return {
    object,
    update(state) {
      uTime.value = state.time;
      uLight.value = state.light;
      uFlow.value = state.flow;
      uDwarf.value = state.dwarf;
      object.rotation.y = state.turn;
      object.visible = state.light > 1e-3;
      disc.sprite.visible = state.flow > 1e-3;
      stream.sprite.visible = state.flow > 1e-3;
      dwarf.visible = state.dwarf > 1e-3;
      glow.sprite.visible = state.dwarf > 1e-3;
    },
    dwarfPosition(out) {
      object.updateMatrixWorld();
      return out.set(0, 0, 0).applyMatrix4(object.matrixWorld);
    },
    companionTop(out) {
      object.updateMatrixWorld();
      local.copy(COMPANION.centre).add(new Vector3(0, COMPANION.radius, 0));
      return out.copy(local).applyMatrix4(object.matrixWorld);
    },
    dispose() {
      companionGeometry.dispose();
      companionMaterial.dispose();
      dwarfGeometry.dispose();
      dwarfMaterial.dispose();
      for (const part of [glow, halo, disc, stream]) {
        part.geometry.dispose();
        part.material.dispose();
      }
    },
  };
}
