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
  /** The local vertical and the Sun's direction (render frame, unit), and the sphere's radius (km). */
  update(up: { x: number; y: number; z: number }, sun: { x: number; y: number; z: number }, radiusKm: number): void;
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

export function createWalkSky(): WalkSky {
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
