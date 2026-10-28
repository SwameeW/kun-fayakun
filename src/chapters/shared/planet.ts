import {
  AdditiveBlending,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Data3DTexture,
  type Node,
  type Texture,
} from 'three/webgpu';
import {
  abs,
  asin,
  clamp,
  cos,
  dot,
  exp,
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
  sqrt,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl';
import type { AirUniforms, createAir, ExploreAir } from '../../explore/bodies/atmosphere';
import { litCosine, sunlit } from '../../explore/bodies/shading';
import type { AirModel, sunTransmittance, transmittanceToTop } from '../../explore/render/air';
import { blendPremultiplied } from '../../explore/render/blending';

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
 *
 * Given the Earth's air (./film-air: the explorer's model), the planet is lit as the explorer's
 * Earth is: sunlight that has crossed the air (white at noon, reddening toward the terminator) and
 * the sky's blue fill, no other light, so the night side is dark but for glowing lava; the air's
 * own shell over it (../../explore/bodies/atmosphere: the limb glow growing out of the planet, haze
 * thickening toward the limb, the ground and stars dimmed behind it); the glint as GGX on a
 * wind-roughened sea with Fresnel, held below the bloom threshold; and the clouds on a shell of
 * their own, casting shadows. The clouds are illustrative weather: systems drawn out along the
 * latitudes, thickest in a band at the equator and in the storm tracks near 55 degrees, thinnest
 * in the subtropics, as today's cloud climatology has them (their height above the ground is
 * exaggerated so their shadows read). How a hazier early air looked is a hypothesis; its warmer
 * tint here is illustrative. Without the air (the orrery's small Earth) the simpler shading below
 * stands, with the atmosphere as a glow at the limb.
 *
 * This file only names the air's types: its builders come from ./film-air (provideAirBuilders),
 * so a chapter that draws the Earth without the air, Chapter 7, loads without them.
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

/** The explorer's air's builders (../../explore/render/air, ../../explore/bodies/atmosphere), handed over by ./film-air. */
export interface AirBuilders {
  readonly createAir: typeof createAir;
  readonly sunTransmittance: typeof sunTransmittance;
  readonly transmittanceToTop: typeof transmittanceToTop;
}

let airBuilders: AirBuilders | null = null;

/** Called by ./film-air as it makes the air, before any Earth is drawn under it. */
export function provideAirBuilders(builders: AirBuilders): void {
  airBuilders = builders;
}

function givenBuilders(): AirBuilders {
  if (!airBuilders) throw new Error('createEarth: the air comes from ./film-air (createFilmAir), which hands over its builders');
  return airBuilders;
}

/** The Earth's air for createEarth (./film-air). */
export interface EarthAir {
  readonly model: AirModel;
  /** The transmittance table (baked before the first frame that draws it). */
  readonly table: { readonly texture: Texture };
  /** View-ray steps of the air's shell; 0 draws the analytic 'chord' model. */
  readonly steps: number;
}

export interface Earth {
  readonly object: Group;
  /** `eye`: the camera's world position (the air's shell is drawn from it). */
  update(state: PlanetState & { epoch: EarthEpoch; eye?: Vector3 }): void;
  /** The air's shell for a quality tier: its view-ray steps, 0 for the analytic model (no-op without the air). */
  setAirSteps(steps: number): void;
  dispose(): void;
}

const rotateY = (v: Node<'vec3'>, angle: Node<'float'>): Node<'vec3'> =>
  vec3(v.x.mul(cos(angle)).sub(v.z.mul(sin(angle))), v.y, v.x.mul(sin(angle)).add(v.z.mul(cos(angle))));

const LAVA = vec3(1.0, 0.32, 0.06);
const BASALT = vec3(0.07, 0.06, 0.055);
const ROCK = vec3(0.27, 0.19, 0.13);
const HIGHLAND = vec3(0.42, 0.37, 0.32);
const GREEN = vec3(0.09, 0.21, 0.07);
/**
 * Under the air, the land once life has spread over it, as the Earth's land looks from space (NASA's
 * Blue Marble, DSCOVR EPIC): forest and grassland a dark olive, over the lowlands and up the lower
 * slopes, the subtropics' deserts thinner. A little darker than GREEN and much more saturated: the
 * air's own haze lightens and greys it on the way to the eye, so from space it ends a muted olive.
 */
const VEGETATION = vec3(0.06, 0.2, 0.024);
const EARLY_SEA = vec3(0.03, 0.08, 0.05);
const SEA = vec3(0.008, 0.045, 0.14);
const SHALLOW = vec3(0.04, 0.19, 0.24);
const STEAM = vec3(0.5, 0.46, 0.42);
const HAZY_SKY = vec3(0.9, 0.62, 0.36);
const BLUE_SKY = vec3(0.32, 0.58, 1.0);

/** The clouds' shell above the ground, radii (about 25 km: exaggerated so their shadows read at the film's scale; illustrative). */
const CLOUD_HEIGHT = 0.004;
/** Cloud tops' reflectance, how dark their shadows are on the ground, and their slow turn against the ground (rad/s). */
const CLOUD = { albedo: 0.86, shadow: 0.6, drift: 0.012 } as const;
/**
 * The glint (the explorer's Earth's): GGX roughness of a wind-roughened sea, and the ceiling of its
 * radiance, below the bloom threshold so it never blooms into a blob.
 */
const GLINT = { alpha: 0.2, ceiling: 0.62 } as const;
/** The young air's scattered light while oxygen is low: a hazier, warmer sky (hypothesised; the tint is illustrative). */
const EARLY_AIR_TINT = [1, 0.8, 0.6] as const;
const DEGREES = 180 / Math.PI;

export function createEarth(noise: Data3DTexture, radius: number, air?: EarthAir): Earth {
  // The air with its builders, which ./film-air hands over as it makes the air.
  const withAir = air ? { ...air, ...givenBuilders() } : null;
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
  // Lava glows only while there is molten rock (the crust's noise would otherwise leave sparks on a cooled world).
  const emissive = lava.mul(float(1).sub(u.steam.mul(0.4))).mul(smoothstep(0, 0.04, u.molten));

  // Day-side colour: crust, land rising out of it, seas in the low ground.
  const latitude = abs(n.y);
  const moist = smoothstep(0.35, 0.7, c2).mul(float(1).sub(smoothstep(0.55, 0.85, latitude)));
  const bare = ROCK.mul(c3.mul(0.5).add(0.75));
  let landColor: Node<'vec3'>;
  if (air) {
    // Wetter ground wider than without the air, thinner in the desert belts near 25 degrees (sin = 0.42).
    const desert = exp(latitude.sub(0.42).div(0.12).pow(2).negate()).mul(smoothstep(0.3, 0.6, c3));
    const green = smoothstep(0.12, 0.42, c2).mul(float(1).sub(smoothstep(0.62, 0.86, latitude))).mul(float(1).sub(desert.mul(0.6)));
    const cover = u.life.mul(green);
    // Life climbs the slopes: only the highest ground stays bare once it has spread.
    const highland = max(smoothstep(0.06, 0.16, elevation).mul(float(1).sub(cover.mul(0.75))), smoothstep(0.2, 0.32, elevation));
    landColor = mix(mix(bare, VEGETATION.mul(c3.mul(0.4).add(0.8)), cover), HIGHLAND, highland);
  } else {
    landColor = mix(mix(bare, GREEN, u.life.mul(moist)), HIGHLAND, smoothstep(0.06, 0.16, elevation));
  }
  // With the air the ice's edge is broken by the noise, as real ice edges are.
  const iceLatitude = air ? latitude.add(c3.sub(0.5).mul(0.09)) : latitude;
  const ice = smoothstep(0.86, 0.93, iceLatitude).mul(u.land).mul(float(1).sub(u.molten));
  let surface: Node<'vec3'> = mix(BASALT.mul(c3.mul(0.6).add(0.7)), landColor, landMask.mul(smoothstep(0, 0.35, u.land)));
  const water = float(1).sub(landMask).mul(smoothstep(0, 0.15, u.ocean));
  const seaColor = mix(mix(EARLY_SEA, SEA, u.oxygen), SHALLOW, smoothstep(-0.05, 0, elevation).mul(0.6));
  surface = mix(surface, seaColor, water);
  surface = mix(surface, vec3(0.85, 0.88, 0.92), ice);
  const geometry = new SphereGeometry(1, 192, 128);
  const spinner = new Group();
  const disposables: Array<{ dispose(): void }> = [geometry];

  // The air's uniforms (the Earth's frame, planet radii), and the Sun in the turning globe's frame (the clouds' shadows).
  const uEye = uniform(new Vector3(0, 0, 4));
  const uAirSun = uniform(new Vector3(1, 0, 0));
  const uSpinSun = uniform(new Vector3(1, 0, 0));
  const uAirTint = uniform(new Vector3(1, 1, 1));
  /** 1 while the air's shell is the marched one (it dims what lies behind by the whole column down to the ground). */
  const uMarched = uniform(1);
  /** The globe's centre and radius in the world. */
  const uCentre = uniform(new Vector3());
  const uRadius = uniform(radius);

  if (!withAir) {
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
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    material.colorNode = surface.mul(lit).add(vec3(glint)).mul(uLight).add(emissive.mul(uLight));
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
    const glow = new Mesh(geometry, airMaterial);
    glow.scale.setScalar(1.035);
    glow.name = 'earth-atmosphere';
    spinner.add(body);
    object.add(spinner, glow);
    disposables.push(material, airMaterial);
  } else {
    const { model, table, sunTransmittance, transmittanceToTop } = withAir;
    const [tr, tg, tb] = model.verticalDepth;
    const tau = vec3(tr, tg, tb);
    /** The sky's diffuse light on a surface (half the air's scattered sunlight comes down), bluish: the explorer's Earth's. */
    const skyFill = (mu: Node<'float'>): Node<'vec3'> => float(1).sub(exp(tau.negate())).mul(0.5).mul(clamp(mu.add(0.1), 0, 1));

    /**
     * Cloud cover toward a direction of the turning globe: large systems drawn out along the
     * latitudes (the noise squeezed 2.5 times north to south) and swirled by a warp, a finer octave
     * only breaking up their edges, over a climatology by latitude: a band at the equator, clear
     * subtropics near 25 degrees, the storm tracks near 55 degrees. Illustrative.
     */
    const cloudCover = (d: Node<'vec3'>): Node<'float'> => {
      const q = rotateY(d, uTime.mul(CLOUD.drift));
      // Large, slow eddies curl the systems into swirls and fronts.
      const eddy = vec3(texture3D(noise, q.mul(0.8).add(0.52)).r, texture3D(noise, q.mul(0.8).add(0.18)).r, texture3D(noise, q.mul(0.8).add(0.77)).r).sub(0.5);
      const p = q.add(eddy.mul(0.35));
      const systems = texture3D(noise, vec3(p.x, p.y.mul(2.8), p.z).mul(1.2).add(0.9)).r;
      // A finer octave breaks the systems into clusters and ragged edges.
      const clusters = texture3D(noise, p.mul(4.6).add(0.4)).r;
      const lat = abs(asin(clamp(d.y, -1, 1))).mul(DEGREES);
      const gauss = (centre: number, width: number): Node<'float'> => exp(lat.sub(centre).div(width).pow(2).negate());
      const climate = float(0.55).add(gauss(0, 8).add(gauss(55, 12)).mul(0.45)).sub(gauss(25, 8).mul(0.35));
      const value = systems.mul(0.7).add(clusters.mul(0.3)).add(climate.sub(0.75).mul(0.45));
      // A wide ramp: thin, translucent cloud around denser cores.
      const threshold = mix(float(0.62), float(0.42), u.clouds);
      return smoothstep(threshold.sub(0.04), threshold.add(0.3), value).mul(smoothstep(0, 0.2, u.clouds));
    };

    surface = mix(surface, STEAM, u.steam.mul(0.55));
    // Sunlight after the air (white at noon, reddening toward the terminator) and the sky's fill: no other light.
    const nDotL = dot(normalWorld, uSun);
    const sunColour = sunTransmittance(model, table.texture, float(1), nDotL).mul(sunlit(nDotL, 0.004));
    // Cloud shadows: the cloud the sunlight crossed on its way down, CLOUD_HEIGHT up toward the Sun.
    const towardSun = normalize(raw.add(uSpinSun.mul(float(CLOUD_HEIGHT).div(max(dot(raw, uSpinSun), 0.08)))));
    const shade = float(1).sub(cloudCover(towardSun).mul(CLOUD.shadow));
    // The glint: GGX on open water (the sphere's normal), Fresnel toward the limb, capped.
    const view = normalize(cameraPosition.sub(positionWorld));
    const half = normalize(view.add(uSun));
    const nh = max(dot(normalWorld, half), 0);
    const nv = max(dot(normalWorld, view), 1e-3);
    const nl = max(nDotL, 0);
    const a2 = GLINT.alpha * GLINT.alpha;
    const denom = nh.mul(nh).mul(a2 - 1).add(1);
    const distribution = float(a2).div(denom.mul(denom).mul(Math.PI));
    const fresnel = float(0.02).add(pow(float(1).sub(max(dot(view, half), 0)), 5).mul(0.98));
    const k = GLINT.alpha / 2;
    const visibility = nv.div(nv.mul(1 - k).add(k)).mul(nl.div(nl.mul(1 - k).add(k)));
    const specular = distribution.mul(fresnel).mul(visibility).div(nv.mul(4)).mul(nl).mul(Math.PI);
    const glint = min(specular, GLINT.ceiling).mul(water).mul(float(1).sub(ice)).mul(shade);
    const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
    const lit = sunColour.mul(litCosine(nDotL)).mul(shade).add(skyFill(nDotL));
    material.colorNode = surface.mul(lit).add(sunColour.mul(glint)).mul(uLight).add(emissive.mul(uLight));
    const body = new Mesh(geometry, material);
    body.name = 'earth-surface';

    // The clouds' shell: thicker toward the limb, where the eye looks through more of them, lit by
    // the sunlight that reaches their height and by the sky's fill.
    const cover = cloudCover(normalize(positionLocal));
    const toEye = normalize(cameraPosition.sub(positionWorld));
    const up = max(dot(normalWorld, toEye), 0.02);
    // Where this pixel's ray meets the ground, and the cosine it meets it at (0 where it passes clear).
    const eye = cameraPosition.sub(uCentre).div(uRadius);
    const ray = toEye.negate();
    const b = dot(eye, ray);
    const disc = b.mul(b).sub(dot(eye, eye)).add(1);
    const ground = normalize(eye.add(ray.mul(b.negate().sub(sqrt(max(disc, 0))))));
    const steep = select(disc.greaterThan(0), max(dot(ground, ray).negate(), 0), float(0));
    // Only over the ground, fading out across its outermost sliver: the exaggerated height would
    // stand the clouds out of the limb, and there the air's haze hides real clouds anyway.
    const kept = smoothstep(0.03, 0.12, steep);
    const opacity = float(1).sub(pow(float(1).sub(min(cover.mul(0.97), 0.999)), min(float(1).div(up), 3))).mul(kept);
    const cDotL = dot(normalWorld, uSun);
    const cloudSun = sunTransmittance(model, table.texture, float(1 + CLOUD_HEIGHT), cDotL).mul(sunlit(cDotL.add(0.02), 0.006));
    const cloudLit = clamp(cDotL.add(0.12).div(1.12), 0, 1);
    // The marched air dims everything behind it by the column down to the ground where this pixel's
    // ray meets it; a cloud top sits above most of that air, so it is brightened back to what the
    // air above the cloud lets through.
    const through = transmittanceToTop(model, table.texture, float(1), steep);
    const aboveCloud = transmittanceToTop(model, table.texture, float(1 + CLOUD_HEIGHT), up);
    const back = mix(vec3(1, 1, 1), min(aboveCloud.div(max(through, 1e-4)), 100), uMarched);
    const cloudColour = cloudSun.mul(cloudLit).add(skyFill(cDotL).mul(0.6)).mul(CLOUD.albedo).mul(back).mul(uLight);
    const cloudMaterial = blendPremultiplied(new MeshBasicNodeMaterial({ side: FrontSide, transparent: true, depthWrite: false, fog: false }));
    cloudMaterial.colorNode = cloudColour.mul(opacity);
    cloudMaterial.opacityNode = opacity;
    const clouds = new Mesh(geometry, cloudMaterial);
    clouds.scale.setScalar(1 + CLOUD_HEIGHT);
    clouds.renderOrder = 1;
    clouds.name = 'earth-clouds';
    spinner.add(body, clouds);
    object.add(spinner);
    disposables.push(material, cloudMaterial);
  }

  // The air's shell, built once per number of steps; its airglow is left out (these Earths are seen by day).
  const airs = new Map<number, ExploreAir>();
  let shell: ExploreAir | null = null;
  let shellSteps = -1;
  const setAirSteps = (steps: number): void => {
    if (!withAir || steps === shellSteps) return;
    shellSteps = steps;
    let next = airs.get(steps);
    if (!next) {
      const airUniforms: AirUniforms = { eye: uEye, sun: uAirSun, light: uLight };
      next = withAir.createAir(withAir.model, steps > 0 ? 'scatter' : 'chord', steps, withAir.table.texture, airUniforms, 128);
      for (const mesh of next.meshes) {
        // Its scattered light tinted while the air is young and dimmed over a molten world.
        if (mesh.name === 'explore-earth-air-glow' || mesh.name === 'explore-earth-air-chord') {
          const m = mesh.material as MeshBasicNodeMaterial;
          if (m.colorNode) m.colorNode = (m.colorNode as Node<'vec3'>).mul(uAirTint);
        }
      }
      airs.set(steps, next);
    }
    if (shell) object.remove(...shell.meshes);
    shell = next;
    object.add(...next.meshes.filter((m) => m.name !== 'explore-earth-airglow'));
    uMarched.value = steps > 0 ? 1 : 0;
  };
  setAirSteps(air?.steps ?? 0);
  object.scale.setScalar(radius);
  const inverse = new Matrix4();
  const [er, eg, eb] = EARLY_AIR_TINT;

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
      if (!air) return;
      object.updateMatrixWorld();
      uCentre.value.setFromMatrixPosition(object.matrixWorld);
      uRadius.value = object.matrixWorld.getMaxScaleOnAxis();
      inverse.copy(object.matrixWorld).invert();
      if (state.eye) uEye.value.copy(state.eye).applyMatrix4(inverse);
      uAirSun.value.copy(uSun.value).transformDirection(inverse);
      inverse.copy(spinner.matrixWorld).invert();
      uSpinSun.value.copy(uSun.value).transformDirection(inverse);
      const dim = 1 - 0.6 * e.molten;
      const young = 1 - e.oxygen;
      uAirTint.value.set((1 + (er - 1) * young) * dim, (1 + (eg - 1) * young) * dim, (1 + (eb - 1) * young) * dim);
    },
    setAirSteps,
    dispose() {
      for (const d of disposables) d.dispose();
      for (const a of airs.values()) a.dispose();
      airs.clear();
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
