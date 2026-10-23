import {
  AdditiveBlending,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import {
  abs,
  cos,
  dot,
  float,
  max,
  mix,
  normalize,
  normalView,
  normalWorld,
  positionLocal,
  positionViewDirection,
  positionWorld,
  cameraPosition,
  pow,
  sin,
  smoothstep,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl';

/**
 * Planets drawn from a few lookups of a shared 3D noise volume, lit by the Sun.
 *
 * The Earth is one shader across its whole history, steered by an "epoch": molten rock
 * glowing through cracks in a darkening crust; steam; oceans filling the low ground;
 * continents rising and drifting (the plates' motion, shown by slowly turning the
 * continents' noise); clouds; and, as oxygen rises, seas and sky shifting from a hazy,
 * greenish early world to blue, and the land turning green. Sunlight sets the terminator;
 * the sea glints; an atmosphere glows at the limb. Not to scale, and the continents are
 * illustrative, not a reconstruction of any real past geography.
 */

export interface EarthEpoch {
  /** 1 = a sea of lava, 0 = solid crust. */
  molten: number;
  /** Veil of steam over the young surface, 0 to 1. */
  steam: number;
  /** How far the oceans have filled, 0 to 1. */
  ocean: number;
  /** How far continents have risen, 0 to 1. */
  land: number;
  /** Plate drift: turns the continents' pattern slowly (radians). */
  drift: number;
  /** 0 = hazy, greenish early world; 1 = blue seas and sky. */
  oxygen: number;
  /** Green of life on land, 0 to 1. */
  life: number;
  /** Cloud cover, 0 to 1. */
  clouds: number;
}

export const EARTH_TODAY: EarthEpoch = { molten: 0, steam: 0, ocean: 1, land: 1, drift: 0, oxygen: 1, life: 1, clouds: 0.75 };

export interface PlanetState {
  time: number;
  /** Direction from the planet to the Sun, world space (normalised). */
  sun: Vector3;
  /** Spin angle about the planet's axis, radians. */
  spin: number;
  light: number;
}

export interface Earth {
  readonly object: Group;
  update(state: PlanetState & { epoch: EarthEpoch }): void;
  dispose(): void;
}

const rotateY = (v: Node<'vec3'>, angle: Node<'float'>): Node<'vec3'> =>
  vec3(v.x.mul(cos(angle)).sub(v.z.mul(sin(angle))), v.y, v.x.mul(sin(angle)).add(v.z.mul(cos(angle))));

const LAVA = vec3(1.0, 0.32, 0.06);
const BASALT = vec3(0.07, 0.06, 0.055);
const ROCK = vec3(0.27, 0.19, 0.13);
const HIGHLAND = vec3(0.42, 0.37, 0.32);
const GREEN = vec3(0.09, 0.21, 0.07);
const EARLY_SEA = vec3(0.03, 0.08, 0.05);
const SEA = vec3(0.008, 0.045, 0.14);
const SHALLOW = vec3(0.04, 0.19, 0.24);
const STEAM = vec3(0.5, 0.46, 0.42);
const HAZY_SKY = vec3(0.9, 0.62, 0.36);
const BLUE_SKY = vec3(0.32, 0.58, 1.0);

export function createEarth(noise: Data3DTexture, radius: number): Earth {
  const object = new Group();
  object.name = 'earth';
  const uTime = uniform(0);
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  const u = {
    molten: uniform(0),
    steam: uniform(0),
    ocean: uniform(1),
    land: uniform(1),
    drift: uniform(0),
    oxygen: uniform(1),
    life: uniform(1),
    clouds: uniform(0.7),
  };

  const raw = normalize(positionLocal);
  // Domain warp: coastlines and cloud bands bend instead of forming round blobs.
  const warp = vec3(texture3D(noise, raw.mul(1.1).add(0.61)).r, texture3D(noise, raw.mul(1.1).add(0.27)).r, texture3D(noise, raw.mul(1.1).add(0.93)).r).sub(0.5);
  const n = normalize(raw.add(warp.mul(0.45)));
  const c1 = texture3D(noise, rotateY(n, u.drift.mul(0.5)).mul(0.55).add(0.17)).r;
  const c2 = texture3D(noise, rotateY(n, u.drift.mul(-0.3)).mul(1.3).add(0.41)).r;
  const c3 = texture3D(noise, n.mul(3.4).add(0.73)).r;
  const h = c1.mul(0.6).add(c2.mul(0.3)).add(c3.mul(0.1));
  const sea = mix(float(0.3), float(0.64), u.ocean).sub(u.land.mul(0.085));
  const landMask = smoothstep(sea, sea.add(0.012), h);
  const elevation = h.sub(sea);

  // Molten world: lava under a crust that spreads as it cools, glowing through thin cracks.
  const crustNoise = texture3D(noise, n.mul(2.6).add(vec3(0, uTime.mul(0.01), 0.3))).r;
  const crust = smoothstep(u.molten.sub(0.08), u.molten.add(0.08), crustNoise);
  const cracks = float(1).sub(smoothstep(0, 0.035, abs(texture3D(noise, n.mul(5.3).add(0.11)).r.sub(0.5))));
  const lava = LAVA.mul(float(1).sub(crust).mul(0.55).add(crust.mul(cracks).mul(u.molten).mul(1.4))).mul(1.15);

  // Day-side colour: crust, land rising out of it, seas in the low ground.
  const latitude = abs(n.y);
  const moist = smoothstep(0.35, 0.7, c2).mul(float(1).sub(smoothstep(0.55, 0.85, latitude)));
  const landColor = mix(mix(ROCK.mul(c3.mul(0.5).add(0.75)), GREEN, u.life.mul(moist)), HIGHLAND, smoothstep(0.06, 0.16, elevation));
  const ice = smoothstep(0.86, 0.93, latitude).mul(u.land).mul(float(1).sub(u.molten));
  let surface: Node<'vec3'> = mix(BASALT.mul(c3.mul(0.6).add(0.7)), landColor, landMask.mul(smoothstep(0, 0.35, u.land)));
  const water = float(1).sub(landMask).mul(smoothstep(0, 0.15, u.ocean));
  const seaColor = mix(mix(EARLY_SEA, SEA, u.oxygen), SHALLOW, smoothstep(-0.05, 0, elevation).mul(0.6));
  surface = mix(surface, seaColor, water);
  surface = mix(surface, vec3(0.85, 0.88, 0.92), ice);

  // Clouds: swirled bands, thicker at mid-latitudes and the equator, with soft edges.
  const swirl = rotateY(raw.add(warp.mul(0.8)), uTime.mul(0.012));
  const cloudNoise = texture3D(noise, swirl.mul(2.4).add(0.9)).r.mul(0.7).add(texture3D(noise, swirl.mul(6.1).add(0.4)).r.mul(0.3));
  const bands = float(0.75).add(abs(sin(raw.y.mul(Math.PI * 2.2))).mul(0.25));
  const cloud = smoothstep(float(0.68).sub(u.clouds.mul(0.24)), float(0.9).sub(u.clouds.mul(0.24)), cloudNoise.mul(bands)).mul(smoothstep(0, 0.2, u.clouds)).mul(0.85);
  surface = mix(surface, vec3(0.93, 0.94, 0.95), cloud);
  surface = mix(surface, STEAM, u.steam.mul(0.55));

  // Sunlight: a soft terminator, a glint on open water.
  const nDotL = dot(normalWorld, uSun);
  const lit = smoothstep(-0.12, 0.3, nDotL).mul(max(nDotL, 0).mul(0.75).add(0.25)).add(0.012);
  const view = normalize(cameraPosition.sub(positionWorld));
  const half = normalize(view.add(uSun));
  const glint = pow(max(dot(normalWorld, half), 0), 90).mul(water).mul(float(1).sub(cloud)).mul(smoothstep(0, 0.2, nDotL)).mul(0.9);
  const emissive = lava.mul(float(1).sub(u.steam.mul(0.4)));
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  material.colorNode = surface.mul(lit).add(vec3(glint)).mul(uLight).add(emissive.mul(uLight));
  const geometry = new SphereGeometry(1, 192, 128);
  const body = new Mesh(geometry, material);
  body.name = 'earth-surface';

  // Atmosphere: light scattered at the limb on the day side, hazy early, blue once oxygen has risen.
  const airMaterial = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, side: FrontSide, fog: false });
  const facing = abs(dot(normalView, positionViewDirection));
  const rim = pow(float(1).sub(facing), 2.6);
  const day = smoothstep(-0.3, 0.45, dot(normalWorld, uSun));
  const sky = mix(HAZY_SKY, BLUE_SKY, u.oxygen);
  airMaterial.colorNode = sky.mul(rim.mul(1.1).add(0.03)).mul(day).mul(float(1).sub(u.molten.mul(0.6))).mul(uLight);
  airMaterial.opacityNode = float(1);
  const air = new Mesh(geometry, airMaterial);
  air.scale.setScalar(1.035);
  air.name = 'earth-atmosphere';

  const spinner = new Group();
  spinner.add(body);
  object.add(spinner, air);
  object.scale.setScalar(radius);

  return {
    object,
    update(state) {
      uTime.value = state.time;
      uLight.value = state.light;
      uSun.value.copy(state.sun).normalize();
      spinner.rotation.y = state.spin;
      const e = state.epoch;
      u.molten.value = e.molten;
      u.steam.value = e.steam;
      u.ocean.value = e.ocean;
      u.land.value = e.land;
      u.drift.value = e.drift;
      u.oxygen.value = e.oxygen;
      u.life.value = e.life;
      u.clouds.value = e.clouds;
      object.visible = state.light > 1e-3;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      airMaterial.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Other bodies                                                         */
/* ------------------------------------------------------------------ */

export interface SimpleBodyOptions {
  name: string;
  color: readonly [number, number, number];
  /** Latitude bands (gas giants), 0 for none. */
  bands?: number;
  /** Surface mottling from the noise (rocky bodies, the Moon's maria), 0 to 1. */
  mottle?: number;
  /** Saturn's rings: inner and outer radius in planet radii. */
  rings?: readonly [number, number];
  seed?: number;
}

export interface SimpleBody {
  readonly object: Group;
  update(state: PlanetState): void;
  dispose(): void;
}

/** A sunlit sphere: rocky bodies mottled, gas giants banded, optionally with rings. */
export function createSimpleBody(noise: Data3DTexture, radius: number, options: SimpleBodyOptions): SimpleBody {
  const object = new Group();
  object.name = options.name;
  const uLight = uniform(1);
  const uSun = uniform(new Vector3(1, 0, 0));
  const base = vec3(...options.color);
  const n = normalize(positionLocal);
  const seed = options.seed ?? 0.5;
  let albedo: Node<'vec3'> = base;
  if (options.mottle) {
    const m = texture3D(noise, n.mul(1.8).add(seed)).r.mul(0.6).add(texture3D(noise, n.mul(5).add(seed + 0.2)).r.mul(0.4));
    albedo = base.mul(float(1 - options.mottle).add(m.mul(options.mottle * 1.6)));
  }
  if (options.bands) {
    const wobble = texture3D(noise, n.mul(2).add(seed)).r.sub(0.5).mul(0.25);
    const band = sin(n.y.add(wobble).mul(options.bands * Math.PI)).mul(0.5).add(0.5);
    albedo = base.mul(band.mul(0.35).add(0.75));
  }
  const nDotL = dot(normalWorld, uSun);
  const lit = smoothstep(-0.08, 0.25, nDotL).mul(max(nDotL, 0).mul(0.8).add(0.2)).add(0.01);
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  material.colorNode = albedo.mul(lit).mul(uLight);
  const geometry = new SphereGeometry(1, 64, 48);
  const body = new Mesh(geometry, material);
  const spinner = new Group();
  spinner.add(body);
  object.add(spinner);
  let ringGeometry: RingGeometry | null = null;
  let ringMaterial: MeshBasicNodeMaterial | null = null;
  if (options.rings) {
    const [inner, outer] = options.rings;
    ringGeometry = new RingGeometry(inner, outer, 128, 1);
    ringGeometry.rotateX(-Math.PI / 2);
    ringMaterial = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide, depthWrite: false, fog: false });
    const radial = positionLocal.length().sub(inner).div(outer - inner);
    const ringlets = sin(radial.mul(80)).mul(0.15).add(0.85).mul(smoothstep(0, 0.08, radial)).mul(float(1).sub(smoothstep(0.9, 1, radial)));
    const gap = float(1).sub(smoothstep(0.55, 0.57, radial).mul(float(1).sub(smoothstep(0.6, 0.62, radial))).mul(0.85));
    ringMaterial.colorNode = base.mul(1.1).mul(uLight).mul(max(dot(vec3(0, 1, 0), uSun).mul(0.5).add(0.6), 0.25));
    ringMaterial.opacityNode = ringlets.mul(gap).mul(0.75);
    const ring = new Mesh(ringGeometry, ringMaterial);
    ring.rotation.z = 0.47;
    object.add(ring);
  }
  object.scale.setScalar(radius);
  return {
    object,
    update(state) {
      uLight.value = state.light;
      uSun.value.copy(state.sun).normalize();
      spinner.rotation.y = state.spin;
      object.visible = state.light > 1e-3;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      ringGeometry?.dispose();
      ringMaterial?.dispose();
    },
  };
}
