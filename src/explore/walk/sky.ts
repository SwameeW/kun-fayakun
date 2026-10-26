import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3 } from 'three/webgpu';
import { acos, add, cameraPosition, clamp, cos, dot, exp, float, Fn, length, max, mix, normalize, pow, positionWorld, uniform, vec3, vec4 } from 'three/tsl';
import { skyGain, starlight, twilight } from './daylight';

/**
 * The sky seen from the ground: Preetham, Shirley and Smits's analytic daylight model ("A Practical
 * Analytic Model for Daylight", 1999), as three.js's SkyMesh implements it (MIT licence; its
 * constants and phase functions are kept), with the local vertical as an input (the walker's "up" on
 * a globe is anywhere in the explorer's frame) instead of the world's +y, and no clouds; brightened
 * as the Sun sinks, as the eye adapts, with twilight's own gradient where the model's light ends
 * (./daylight). It is drawn as a sphere around the camera inside the far plane: by day it hides the
 * stars behind it; through twilight it thins, and at night the explorer's real stars (../sky) show
 * through. The Sun itself is the explorer's own (its disc and glare), so the model's disc is left out.
 * Illustrative, not a radiative-transfer model of the day's real air.
 */

export interface WalkSky {
  readonly mesh: Mesh;
  /** The local vertical and the Sun's direction (render frame, unit), the sphere's radius (km), and the sunlight's strength (1 at 1 au: Mars's sky is lit by its own, 0.43 of the Earth's). */
  update(up: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number }, radiusKm: number, light?: number): void;
  /** The Sun's height (degrees) the sky was last drawn for. */
  readonly sunDeg: number;
  dispose(): void;
}

/**
 * Brings the model's output (made for a tone-mapped exposure of about 0.5) to the explorer's scale,
 * where sunlit white is about 1: a clear zenith is then about a fifth as bright as sunlit white (its
 * blue at the Sun's 42 degrees about 0.19), as a clear sky's zenith is to a sunlit white surface.
 */
const SKY_SCALE = 0.18;

/** Whose sky: the Earth's (Preetham), none (airless: the black sky and the explorer's stars), Mars's dusty one, or Venus's overcast (both illustrative). */
export type SkyKind = 'earth' | 'airless' | 'mars' | 'venus';

/**
 * Mars's sky (illustrative: no radiative transfer of its dust): butterscotch by day, warmer toward the
 * horizon, with a blue glow about the Sun that strengthens as it sets (its dust scatters blue light
 * forward, as the rovers' cameras show), dimming through twilight; lit by Mars's sunlight, its horizon
 * a little brighter than the sunlit ground below it, as the rovers' pictures show it. The ground's
 * haze fades into the horizon's colour (./ground MARS_AIR).
 */
export const MARS_SKY = { zenith: [0.5, 0.36, 0.24], horizon: [0.78, 0.58, 0.38], glow: [0.42, 0.58, 0.95], glowWidth: 0.35, scale: 0.22 } as const;
/** Sunlight on Mars's ground, a little reddened by the dust it comes through (illustrative). */
export const MARS_SUN_TINT = [1, 0.93, 0.85] as const;
/**
 * Venus's sky from the ground (illustrative): the underside of a cloud deck that no Sun or star shows
 * through, its light dim and orange (the deep air takes the blue out of what the clouds let down, as
 * the Venera landers' pictures show it), brightest overhead by day, dark by night.
 */
export const VENUS_SKY = { zenith: [0.95, 0.68, 0.36], horizon: [0.78, 0.5, 0.24], scale: 0.12 } as const;

export function createWalkSky(kind: SkyKind = 'earth'): WalkSky {
  if (kind === 'airless') return airlessSky();
  if (kind === 'mars') return marsSky();
  if (kind === 'venus') return venusSky();
  return earthSky();
}

/** Venus's overcast: a dome brighter overhead, lit by the Sun's light at Venus as the day is, never letting a star through. */
function venusSky(): WalkSky {
  const uUp = uniform(new Vector3(0, 1, 0));
  const uLight = uniform(1);
  const uDay = uniform(1);
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const direction = normalize(positionWorld.sub(cameraPosition));
    const height = max(dot(direction, normalize(uUp)), 0);
    return vec4(mix(vec3(...VENUS_SKY.horizon), vec3(...VENUS_SKY.zenith), pow(height, 0.6)).mul(uDay.mul(uLight).mul(VENUS_SKY.scale)), 1);
  })();
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.name = 'explore-walk-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  mesh.visible = false;
  let sunDeg = 0;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(up, sun, radiusKm, light = 1) {
      uUp.value.set(up.x, up.y, up.z);
      uLight.value = light;
      const sin = (up.x * sun.x + up.y * sun.y + up.z * sun.z) / (Math.hypot(up.x, up.y, up.z) * Math.hypot(sun.x, sun.y, sun.z) || 1);
      sunDeg = (Math.asin(Math.max(-1, Math.min(1, sin))) * 180) / Math.PI;
      // The day's light through the clouds, from the Sun's height: full from 6 degrees up, gone 12 degrees down.
      uDay.value = Math.min(1, Math.max(0, (sunDeg + 12) / 18));
      mesh.scale.setScalar(radiusKm);
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
    update(up, sun) {
      const sin = (up.x * sun.x + up.y * sun.y + up.z * sun.z) / (Math.hypot(up.x, up.y, up.z) * Math.hypot(sun.x, sun.y, sun.z) || 1);
      sunDeg = (Math.asin(Math.max(-1, Math.min(1, sin))) * 180) / Math.PI;
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
  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const up = normalize(uUp);
    const direction = normalize(positionWorld.sub(cameraPosition));
    const height = max(dot(direction, up), 0);
    const base = mix(vec3(...MARS_SKY.horizon), vec3(...MARS_SKY.zenith), pow(height, 0.5));
    const toSun = acos(clamp(dot(direction, normalize(uSun)), -1, 1));
    const glow = vec3(...MARS_SKY.glow).mul(exp(toSun.div(MARS_SKY.glowWidth).negate())).mul(uLow.mul(0.7).add(0.3));
    return vec4(base.mul(uDay).add(glow.mul(max(uDay, uLow.mul(0.5)))).mul(uLight.mul(MARS_SKY.scale)), uOpacity);
  })();
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.name = 'explore-walk-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.visible = false;
  let sunDeg = 0;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(up, sun, radiusKm, light = 1) {
      uUp.value.set(up.x, up.y, up.z);
      uSun.value.set(sun.x, sun.y, sun.z);
      uLight.value = light;
      const sin = (up.x * sun.x + up.y * sun.y + up.z * sun.z) / (Math.hypot(up.x, up.y, up.z) * Math.hypot(sun.x, sun.y, sun.z) || 1);
      sunDeg = (Math.asin(Math.max(-1, Math.min(1, sin))) * 180) / Math.PI;
      // Full day from 6 degrees up; gone 12 degrees down; the low-Sun glow strongest at the horizon.
      uDay.value = Math.min(1, Math.max(0, (sunDeg + 12) / 18));
      uLow.value = Math.max(0, 1 - Math.abs(sunDeg) / 25);
      uOpacity.value = 1 - starlight(sunDeg);
      mesh.scale.setScalar(radiusKm);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

function earthSky(): WalkSky {
  const uUp = uniform(new Vector3(0, 1, 0));
  const uSun = uniform(new Vector3(0, 1, 0));
  const uGain = uniform(1);
  const uOpacity = uniform(1);
  const uZenith = uniform(new Vector3());
  const uHorizon = uniform(new Vector3());
  const uGlow = uniform(new Vector3());
  const turbidity = 2;
  const rayleigh = 1;
  const mieCoefficient = 0.005;
  const mieG = 0.8;

  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    // Extinction coefficients (Preetham's primaries) and the Sun's intensity, with the Earth's shadow below the horizon.
    const totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
    const mieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
    const sunDirection = normalize(uSun);
    const up = normalize(uUp);
    const sunCos = clamp(dot(sunDirection, up), -1, 1);
    const sunE = float(1000).mul(max(0, float(1).sub(exp(float(1.6110731556870734).sub(acos(sunCos)).div(1.5).negate()))));
    const betaR = totalRayleigh.mul(rayleigh);
    const betaM = mieConst.mul(0.434 * 0.2 * turbidity * 10e-18).mul(mieCoefficient);
    // Optical lengths along the view, from its angle to the zenith.
    const direction = normalize(positionWorld.sub(cameraPosition));
    const zenith = acos(max(0, dot(direction, up)));
    const inverse = float(1).div(cos(zenith).add(float(0.15).mul(pow(float(93.885).sub(zenith.mul(180 / Math.PI)), -1.253))));
    const fex = exp(betaR.mul(float(8.4e3).mul(inverse)).add(betaM.mul(float(1.25e3).mul(inverse))).negate());
    // In-scattering: Rayleigh and Henyey-Greenstein phases.
    const cosTheta = dot(direction, sunDirection);
    const rPhase = float(3 / (16 * Math.PI)).mul(float(1).add(pow(cosTheta.mul(0.5).add(0.5), 2)));
    const g2 = mieG * mieG;
    const mPhase = float((1 / (4 * Math.PI)) * (1 - g2)).mul(float(1).div(pow(float(1 + g2).sub(cosTheta.mul(2 * mieG)), 1.5)));
    const ratio = add(betaR.mul(rPhase), betaM.mul(mPhase)).div(add(betaR, betaM));
    const lin = pow(sunE.mul(ratio).mul(float(1).sub(fex)), vec3(1.5)).mul(mix(vec3(1), pow(sunE.mul(ratio).mul(fex), vec3(0.5)), clamp(pow(float(1).sub(sunCos), 5), 0, 1)));
    const colour = add(lin, vec3(0.1).mul(fex)).mul(0.04).add(vec3(0, 0.0003, 0.00075)).mul(SKY_SCALE).mul(uGain);
    // Twilight: overhead to the horizon, and the glow on the horizon under the Sun.
    const height = dot(direction, up);
    const level = direction.sub(up.mul(height));
    const sunLevel = sunDirection.sub(up.mul(sunCos));
    const toward = dot(level, sunLevel).div(max(length(level).mul(length(sunLevel)), 1e-5)).mul(0.5).add(0.5);
    const low = pow(float(1).sub(max(height, 0)), 3);
    const dusk = mix(uZenith, uHorizon, low).add(uGlow.mul(low).mul(pow(toward, 4)));
    // As the night comes on, it gives way to the stars behind it.
    return vec4(colour.add(dusk), uOpacity);
  })();
  let sunDeg = 90;
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.name = 'explore-walk-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  mesh.visible = false;
  return {
    mesh,
    get sunDeg() {
      return sunDeg;
    },
    update(up, sun, radiusKm) {
      uUp.value.set(up.x, up.y, up.z);
      uSun.value.set(sun.x, sun.y, sun.z);
      const sin = (up.x * sun.x + up.y * sun.y + up.z * sun.z) / (Math.hypot(up.x, up.y, up.z) * Math.hypot(sun.x, sun.y, sun.z) || 1);
      sunDeg = (Math.asin(Math.max(-1, Math.min(1, sin))) * 180) / Math.PI;
      uGain.value = skyGain(sunDeg);
      uOpacity.value = 1 - starlight(sunDeg);
      const t = twilight(sunDeg);
      uZenith.value.set(...t.zenith);
      uHorizon.value.set(...t.horizon);
      uGlow.value.set(...t.glow);
      mesh.position.set(0, 0, 0);
      mesh.scale.setScalar(radiusKm);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
