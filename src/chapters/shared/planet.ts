import {
  AdditiveBlending,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
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
  faceDirection,
  float,
  max,
  min,
  mix,
  normalize,
  normalView,
  normalWorld,
  positionLocal,
  positionViewDirection,
  positionWorld,
  cameraPosition,
  pow,
  select,
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

/** Optional extras for views other than the chapters' (the defaults are the chapters' Earth exactly). */
export interface EarthOptions {
  /** Sphere segments, width and height. Default [192, 128]. */
  segments?: readonly [number, number];
  /** Radius of the atmosphere shell in planet radii. Default 1.035 (a thinner shell lets a camera skim lower). */
  atmosphereScale?: number;
  /**
   * Draws the young world's lava glow. Default true. Today's Earth seen up close needs false: the
   * glow is built from the lowest noise values, so even with `molten` 0 a few faint specks remain,
   * too small to see at the chapters' sizes but plain on a night side filling the screen.
   */
  lava?: boolean;
}

export function createEarth(noise: Data3DTexture, radius: number, options?: EarthOptions): Earth {
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
  material.colorNode =
    options?.lava === false ? surface.mul(lit).add(vec3(glint)).mul(uLight) : surface.mul(lit).add(vec3(glint)).mul(uLight).add(emissive.mul(uLight));
  const [widthSegments, heightSegments] = options?.segments ?? [192, 128];
  const geometry = new SphereGeometry(1, widthSegments, heightSegments);
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
  air.scale.setScalar(options?.atmosphereScale ?? 1.035);
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

/** A ring system's radial structure; `radial` runs from 0 at the inner edge to 1 at the outer. */
export interface RingProfile {
  /** Share of light the ring blocks, 0 to 1 (0 outside the ring). */
  opacity(radial: Node<'float'>): Node<'float'>;
  /** Albedo colour. Default: the body's colour, as the chapters' rings. */
  color?(radial: Node<'float'>): Node<'vec3'>;
}

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
  /*
   * Optional extras for the true-scale explorer. Left out, the body is exactly the chapters' body.
   */
  /** Sphere segments, width and height. Default [64, 48]. */
  segments?: readonly [number, number];
  /** Polar flattening, 1 - polar / equatorial radius (the pole is the body's local y). Default 0. */
  flattening?: number;
  /**
   * Puts the globe and its rings under one group tilted by this angle (radians, about z), the rings in
   * the equator and lit by the Sun's height above their own plane. Undefined keeps the chapters' look
   * (an upright globe, rings tilted 0.47 rad and lit as if level). With a tilt, set the object's
   * orientation before update(): the rings' lighting and shadows work in the body's own frame.
   */
  tilt?: number;
  /**
   * 'wrap' (default): a soft wrapped terminator. 'lunar': Lommel-Seeliger, as airless regolith reflects
   * (no darkening at the limb of a full moon, a sharp terminator). 'giant': Minnaert limb darkening, as
   * cloud decks show.
   */
  lighting?: 'wrap' | 'lunar' | 'giant';
  /** The albedo as a function of the unit surface direction (the pole is y), replacing color, mottle and bands. */
  surface?: (direction: Node<'vec3'>) => Node<'vec3'>;
  /** The rings' radial structure (with a tilt). Default: the chapters' ringlets. */
  ringProfile?: RingProfile;
  /** With a tilt: the globe's shadow on the rings and the rings' shadow on the globe, both analytic. */
  ringShadows?: boolean;
}

export interface SimpleBody {
  readonly object: Group;
  update(state: PlanetState): void;
  dispose(): void;
}

/** The chapters' ringlets: fine sine ringlets, soft edges and one dark division. */
function chapterRingOpacity(radial: Node<'float'>): Node<'float'> {
  const ringlets = sin(radial.mul(80)).mul(0.15).add(0.85).mul(smoothstep(0, 0.08, radial)).mul(float(1).sub(smoothstep(0.9, 1, radial)));
  const gap = float(1).sub(smoothstep(0.55, 0.57, radial).mul(float(1).sub(smoothstep(0.6, 0.62, radial))).mul(0.85));
  return ringlets.mul(gap).mul(0.75);
}

/** Minnaert's exponent for the giants' limb darkening (1 would be Lambert); illustrative, not fitted. */
const MINNAERT_K = 0.85;

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
  if (options.surface) albedo = options.surface(n);
  const nDotL = dot(normalWorld, uSun);
  const lighting = options.lighting ?? 'wrap';
  let lit: Node<'float'>;
  if (lighting === 'lunar') {
    // Lommel-Seeliger: mu0 / (mu0 + mu), scaled to 1 where the Sun and the eye are both overhead.
    const mu0 = max(nDotL, 0);
    const mu = max(dot(normalView, positionViewDirection), 0);
    lit = mu0.mul(2).div(mu0.add(mu).add(1e-4)).mul(0.9).add(0.004);
  } else if (lighting === 'giant') {
    // Minnaert: mu0^k mu^(k-1), so the limb darkens; a little twilight past the terminator from the haze.
    const mu0 = max(nDotL.add(0.03).div(1.03), 0);
    const mu = max(dot(normalView, positionViewDirection), 0.05);
    lit = pow(mu0, MINNAERT_K).mul(pow(mu, MINNAERT_K - 1)).add(0.004);
  } else {
    lit = smoothstep(-0.08, 0.25, nDotL).mul(max(nDotL, 0).mul(0.8).add(0.2)).add(0.01);
  }
  const fullRadius = 1;
  const polar = fullRadius - (options.flattening ?? 0);
  // With a tilt, the Sun's direction in the rings' frame and in the globe's own frame (set on the CPU).
  const tilted = options.tilt === undefined ? null : new Group();
  const uSunRings = uniform(new Vector3(0, 1, 0));
  const uSunGlobe = uniform(new Vector3(0, 1, 0));
  const ringProfile: RingProfile = options.ringProfile ?? { opacity: chapterRingOpacity };
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  if (tilted && options.rings && options.ringShadows) {
    // The rings' shadow on the globe: from this point toward the Sun, where does the ray cross the ring plane?
    const [inner, outer] = options.rings;
    const point = vec3(positionLocal.x, positionLocal.y.mul(polar), positionLocal.z);
    const sy = select(uSunGlobe.y.greaterThanEqual(0), max(uSunGlobe.y, 1e-4), min(uSunGlobe.y, -1e-4));
    const along = point.y.negate().div(sy);
    const hit = point.add(uSunGlobe.mul(along));
    const radial = hit.xz.length().sub(inner).div(outer - inner);
    const blocked = ringProfile.opacity(radial).mul(step01(along));
    material.colorNode = albedo.mul(lit).mul(float(1).sub(blocked.mul(0.92))).mul(uLight);
  } else {
    material.colorNode = albedo.mul(lit).mul(uLight);
  }
  const [widthSegments, heightSegments] = options.segments ?? [64, 48];
  const geometry = new SphereGeometry(1, widthSegments, heightSegments);
  const body = new Mesh(geometry, material);
  if (polar !== fullRadius) body.scale.y = polar;
  const spinner = new Group();
  spinner.add(body);
  if (tilted) {
    tilted.rotation.z = options.tilt ?? 0;
    tilted.add(spinner);
    object.add(tilted);
  } else {
    object.add(spinner);
  }
  let ringGeometry: RingGeometry | null = null;
  let ringMaterial: MeshBasicNodeMaterial | null = null;
  if (options.rings) {
    const [inner, outer] = options.rings;
    ringGeometry = new RingGeometry(inner, outer, tilted ? 512 : 128, 1);
    ringGeometry.rotateX(-Math.PI / 2);
    ringMaterial = new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide, depthWrite: false, fog: false });
    const radial = positionLocal.length().sub(inner).div(outer - inner);
    if (tilted) {
      const opacity = ringProfile.opacity(radial);
      const color = ringProfile.color ? ringProfile.color(radial) : base.mul(1.1);
      // The face the Sun lights, or the far face, seen by light that filters through (bright where the ring is thin).
      // The geometry's normal is the rings' local +y, so the front face is the one toward +y.
      const litFace = smoothstep(-1e-3, 1e-3, faceDirection.mul(uSunRings.y));
      // A thick ring of icy particles stays fairly bright even with the Sun low over it.
      const reflected = float(0.5).add(pow(abs(uSunRings.y), 0.3).mul(0.5));
      const transmitted = float(1).sub(opacity).mul(opacity).mul(1.8).mul(reflected);
      let light: Node<'float'> = mix(transmitted, reflected, litFace);
      if (options.ringShadows) {
        // The globe's shadow on the rings: does the ray toward the Sun meet the (flattened) globe?
        const p = vec3(positionLocal.x, positionLocal.y.div(polar), positionLocal.z);
        const l = vec3(uSunRings.x, uSunRings.y.div(polar), uSunRings.z);
        const b = dot(p, l);
        const closest = dot(p, p).sub(b.mul(b).div(dot(l, l)));
        const shadow = float(1).sub(smoothstep(0.985, 1.015, closest)).mul(step01(b.negate()));
        light = light.mul(float(1).sub(shadow.mul(0.97)));
      }
      ringMaterial.colorNode = color.mul(light).mul(uLight);
      ringMaterial.opacityNode = opacity;
    } else {
      ringMaterial.colorNode = base.mul(1.1).mul(uLight).mul(max(dot(vec3(0, 1, 0), uSun).mul(0.5).add(0.6), 0.25));
      ringMaterial.opacityNode = chapterRingOpacity(radial);
    }
    const ring = new Mesh(ringGeometry, ringMaterial);
    if (tilted) {
      tilted.add(ring);
    } else {
      ring.rotation.z = 0.47;
      object.add(ring);
    }
  }
  object.scale.setScalar(radius);
  const frame = new Quaternion();
  return {
    object,
    update(state) {
      uLight.value = state.light;
      uSun.value.copy(state.sun).normalize();
      spinner.rotation.y = state.spin;
      object.visible = state.light > 1e-3;
      if (tilted) {
        frame.copy(object.quaternion).multiply(tilted.quaternion).invert();
        uSunRings.value.copy(uSun.value).applyQuaternion(frame);
        frame.copy(object.quaternion).multiply(tilted.quaternion).multiply(spinner.quaternion).invert();
        uSunGlobe.value.copy(uSun.value).applyQuaternion(frame);
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      ringGeometry?.dispose();
      ringMaterial?.dispose();
    },
  };
}

/** 1 where x > 0, else 0 (a hard step: only used where both sides already agree). */
function step01(x: Node<'float'>): Node<'float'> {
  return select(x.greaterThan(0), float(1), float(0));
}
