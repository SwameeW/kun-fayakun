import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Texture } from 'three/webgpu';
import { acos, cameraPosition, clamp, dot, exp, float, Fn, max, mix, normalize, positionWorld, pow, select, uniform, vec3, vec4 } from 'three/tsl';
import type { AirModel } from '../render/air';
import type { FloatNode, Vec3Node } from '../render/sampling';
import { starlight } from './daylight';
import { SKY_KNEE } from './light';
import { scatter } from './scatter';

/**
 * The sky seen from the ground, drawn as a sphere around the camera inside the far plane: by day it
 * hides the stars behind it; through twilight it thins, and at night the explorer's real stars (../sky)
 * show through. The Sun itself is the explorer's own (its disc, at its true size, and its glare).
 *
 * - **The Earth**: the explorer's own air (../render/air, the reference atmosphere with a clear day's
 *   aerosols, clearDayAir, as the globe is drawn with), scattered along each pixel's ray from the
 *   walker's eye (./scatter): blue overhead, paler to the horizon, a glow round the Sun from the
 *   aerosols, and at sunset the long path's reds under the Sun and the Earth's shadow rising opposite,
 *   then twilight as only the upper air is still lit. In the explorer's light units, so the sky and the
 *   sunlight on the ground (the same table) agree.
 * - **Mars** and **Venus**: illustrative (no radiative transfer of their dust and clouds).
 * - **The Moon and Mercury**: none.
 *
 * Every sky is held under the bloom's threshold on screen (./light skyCompression): only the Sun's disc
 * and its glare bloom, and the sky round the Sun is never a blown-out white.
 */

export interface WalkSkyFrame {
  /** The local vertical and the Sun's direction (render frame, unit), the sphere's radius (km). */
  up: { x: number; y: number; z: number };
  sun: { x: number; y: number; z: number };
  radiusKm: number;
  /** The sunlight's strength (1 at 1 au), the picture's exposure now, and the eye's distance from the world's centre (its radii). */
  light: number;
  exposure: number;
  eyeRadii: number;
}

export interface WalkSky {
  readonly mesh: Mesh;
  update(frame: WalkSkyFrame): void;
  /** The Sun's height (degrees) the sky was last drawn for. */
  readonly sunDeg: number;
  dispose(): void;
}

/** Whose sky: the Earth's, none (airless: the black sky and the explorer's stars), Mars's dusty one, or Venus's overcast (both illustrative). */
export type SkyKind = 'earth' | 'airless' | 'mars' | 'venus';

/** Steps along each sky pixel's ray. */
const SKY_STEPS = 16;

/**
 * Mars's sky (illustrative: no radiative transfer of its dust): butterscotch by day, warmer toward the
 * horizon, with a blue glow about the Sun that strengthens as it sets (its dust scatters blue light
 * forward, as the rovers' cameras show), dimming through twilight; lit by Mars's sunlight, its horizon
 * a little brighter than the sunlit ground below it, as the rovers' pictures show it. The ground's
 * haze fades into the horizon's colour (./ground MARS_AIR).
 */
export const MARS_SKY = { zenith: [0.5, 0.36, 0.24], horizon: [0.78, 0.58, 0.38], glow: [0.42, 0.58, 0.95], glowWidth: 0.35, scale: 0.1 } as const;
/**
 * Venus's sky from the ground (illustrative): the underside of a cloud deck that no Sun or star shows
 * through, its light dim and orange (the deep air takes the blue out of what the clouds let down, as
 * the Venera landers' pictures show it), brightest overhead by day, dark by night.
 */
export const VENUS_SKY = { zenith: [0.95, 0.68, 0.36], horizon: [0.78, 0.5, 0.24], scale: 0.12 } as const;

/** The Sun's height (degrees) above the horizon of a local vertical. */
function elevation(up: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number }): number {
  const sin = (up.x * sun.x + up.y * sun.y + up.z * sun.z) / (Math.hypot(up.x, up.y, up.z) * Math.hypot(sun.x, sun.y, sun.z) || 1);
  return (Math.asin(Math.max(-1, Math.min(1, sin))) * 180) / Math.PI;
}

/** A sky's colour held under the bloom (./light skyCompression, on its luminance after the exposure; hue kept). */
export function heldUnderBloom(colour: Vec3Node, exposure: FloatNode): Vec3Node {
  const l = dot(colour.mul(exposure), vec3(0.2126, 0.7152, 0.0722));
  const span = SKY_KNEE.ceiling - SKY_KNEE.knee;
  const held = float(SKY_KNEE.knee).add(float(span).mul(float(1).sub(pow(l.sub(SKY_KNEE.knee).div(SKY_KNEE.tail * span).add(1), -SKY_KNEE.tail)))).div(max(l, 1e-6));
  return colour.mul(select(l.greaterThan(SKY_KNEE.knee), held, float(1)));
}

export function createWalkSky(kind: SkyKind = 'earth', air: { model: AirModel; table: Texture } | null = null): WalkSky {
  if (kind === 'airless') return airlessSky();
  if (kind === 'mars') return marsSky();
  if (kind === 'venus') return venusSky();
  return air ? earthSky(air.model, air.table) : airlessSky();
}

/** A sphere around the camera for a sky (drawn first, behind everything). */
function skyMesh(material: MeshBasicNodeMaterial, order: number): Mesh {
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.name = 'explore-walk-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.visible = false;
  return mesh;
}

/** Venus's overcast: a dome brighter overhead, lit by the Sun's light at Venus as the day is, never letting a star through. */
function venusSky(): WalkSky {
  const uUp = uniform(new Vector3(0, 1, 0));
  const uLight = uniform(1);
  const uDay = uniform(1);
  const uExposure = uniform(1);
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const direction = normalize(positionWorld.sub(cameraPosition));
    const height = max(dot(direction, normalize(uUp)), 0);
    return vec4(heldUnderBloom(mix(vec3(...VENUS_SKY.horizon), vec3(...VENUS_SKY.zenith), pow(height, 0.6)).mul(uDay.mul(uLight).mul(VENUS_SKY.scale)), uExposure), 1);
  })();
  const mesh = skyMesh(material, -2);
  let sunDeg = 0;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(frame) {
      uUp.value.set(frame.up.x, frame.up.y, frame.up.z);
      uLight.value = frame.light;
      uExposure.value = frame.exposure;
      sunDeg = elevation(frame.up, frame.sun);
      // The day's light through the clouds, from the Sun's height: full from 6 degrees up, gone 12 degrees down.
      uDay.value = Math.min(1, Math.max(0, (sunDeg + 12) / 18));
      mesh.scale.setScalar(frame.radiusKm);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

/** No sky: the mesh is never shown; the Sun's height is still kept, for the readout and the stars. */
function airlessSky(): WalkSky {
  const mesh = new Mesh(new SphereGeometry(1, 8, 4), new MeshBasicNodeMaterial());
  mesh.visible = false;
  let sunDeg = 0;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(frame) {
      sunDeg = elevation(frame.up, frame.sun);
      mesh.visible = false;
    },
    dispose() {
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

function marsSky(): WalkSky {
  const uUp = uniform(new Vector3(0, 1, 0));
  const uSun = uniform(new Vector3(0, 1, 0));
  const uLight = uniform(1);
  const uDay = uniform(1);
  const uLow = uniform(0);
  const uOpacity = uniform(1);
  const uExposure = uniform(1);
  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const up = normalize(uUp);
    const direction = normalize(positionWorld.sub(cameraPosition));
    const height = max(dot(direction, up), 0);
    const base = mix(vec3(...MARS_SKY.horizon), vec3(...MARS_SKY.zenith), pow(height, 0.5));
    const toSun = acos(clamp(dot(direction, normalize(uSun)), -1, 1));
    const glow = vec3(...MARS_SKY.glow).mul(exp(toSun.div(MARS_SKY.glowWidth).negate())).mul(uLow.mul(0.7).add(0.3));
    return vec4(heldUnderBloom(base.mul(uDay).add(glow.mul(max(uDay, uLow.mul(0.5)))).mul(uLight.mul(MARS_SKY.scale)), uExposure), uOpacity);
  })();
  const mesh = skyMesh(material, -1);
  let sunDeg = 0;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(frame) {
      uUp.value.set(frame.up.x, frame.up.y, frame.up.z);
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z);
      uLight.value = frame.light;
      uExposure.value = frame.exposure;
      sunDeg = elevation(frame.up, frame.sun);
      // Full day from 6 degrees up; gone 12 degrees down; the low-Sun glow strongest at the horizon.
      uDay.value = Math.min(1, Math.max(0, (sunDeg + 12) / 18));
      uLow.value = Math.max(0, 1 - Math.abs(sunDeg) / 25);
      uOpacity.value = 1 - starlight(sunDeg);
      mesh.scale.setScalar(frame.radiusKm);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

function earthSky(air: AirModel, table: Texture): WalkSky {
  const uUp = uniform(new Vector3(0, 1, 0));
  const uSun = uniform(new Vector3(0, 1, 0));
  const uEye = uniform(1);
  const uLight = uniform(1);
  const uExposure = uniform(1);
  const uOpacity = uniform(1);
  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const direction = normalize(positionWorld.sub(cameraPosition));
    const { light } = scatter(air, table, normalize(uUp).mul(uEye), direction, normalize(uSun), SKY_STEPS, null);
    // As the night comes on, it gives way to the stars behind it.
    return vec4(heldUnderBloom(light.mul(uLight), uExposure), uOpacity);
  })();
  const mesh = skyMesh(material, -2);
  let sunDeg = 90;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(frame) {
      uUp.value.set(frame.up.x, frame.up.y, frame.up.z);
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z);
      uEye.value = frame.eyeRadii;
      uLight.value = frame.light;
      uExposure.value = frame.exposure;
      sunDeg = elevation(frame.up, frame.sun);
      uOpacity.value = 1 - starlight(sunDeg);
      mesh.scale.setScalar(frame.radiusKm);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
