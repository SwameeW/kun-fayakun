import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import { cameraPosition, dot, exp, float, Fn, max, mix, normalize, positionWorld, pow, select, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import type { UniverseDescent } from '../../core/types';
import { localFrame } from '../walk/walker';
import { createProfile, type DescentFile, type DescentProfile, type DescentWorld } from './profile';

/**
 * Down through an atmosphere in the suit (ledger GR-6; its own chunk, docs/ATMOSPHERES.md), through
 * the column a probe measured (Venus's Pioneer Venus Large Probe, Jupiter's Galileo probe), falling as
 * the probe fell, with what it measured at every height (./profile): pressure, temperature, density,
 * the clouds its nephelometer saw and (Jupiter's) the winds. The descent is over the place below the
 * camera (most often in daylight), the readings the probe's from where and when it went down (the
 * explorer's clock cannot reach 1978 or 1995); the readout says both. The fall goes on by itself, gently; S hurries it, W
 * climbs, and the look turns with a drag. On Venus it ends on the ground (the explorer then lands the
 * walk there); on Jupiter where the probe's signal stopped, at 22 bar.
 *
 * What is drawn is a sphere round the eye (no globe): looking up, the cloud the nephelometer saw
 * between the eye and the top of the column, over the clear sky above it; looking down, the cloud
 * below over the deep. The haze's opacity is the nephelometer's reading times an illustrative factor
 * (it measured scattering, not visibility), the light reaching each height dims with the cloud and
 * the air above it, and the colours (Venus's yellow-white cloud tops and orange depths; Jupiter's
 * cream clouds and brown dark) are illustrative. The Sun and the stars show only through what cloud
 * is above.
 */

type V3 = { x: number; y: number; z: number };

export interface Descent {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  readonly world: DescentWorld;
  readonly profile: DescentProfile;
  /** Starts at the top of the probe's column over a place (degrees), looking out a little down. */
  start(latDeg: number, lonDeg: number): void;
  stop(): void;
  look(dxPx: number, dyPx: number): void;
  /** Holds or lets the fall go on. */
  setHeld(held: boolean): void;
  /** Straight to the height where the pressure is `pressureBar` (within the probe's column). */
  goTo(pressureBar: number): void;
  /** Steps the fall: `climb` -1 hurries it down, 1 climbs, 0 lets it fall (or hold); its eye's pose in the world's frame (km from the centre). */
  step(dt: number, climb: number, fast: boolean): { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] } | null;
  /** Places the sky about the camera: the world's frame axes (render frame), the Sun's direction (render frame) and its light (1 at 1 au). */
  place(frame: { basis: readonly number[]; sun: V3; light: number; far: number }): void;
  /** How much of the Sun's light comes straight through (0 to 1), and of the stars'. */
  sunSeen(): number;
  starlight(): number;
  view(): UniverseDescent | null;
  dispose(): void;
}

/** How fast the fall goes (natural log of the pressure per second): gently by itself, five times faster hurried, climbing at twice. */
const FALL = { lnPerS: 0.12, hurry: 5, climb: 2 } as const;
/** The look: radians per CSS pixel, and the furthest it tips. */
const LOOK = { perPx: 0.0032, maxPitch: 1.45 } as const;
/**
 * Each world's look (illustrative): the clouds' colour by day, the sky above them, the deep below,
 * the haze's opacity per unit of the nephelometer's reading per km, how the light dims with the
 * cloud and the air above (per unit of cloud-km, and per bar), and the least light that reaches.
 */
const LOOKS: Record<DescentWorld, { cloud: [number, number, number]; deepCloud: [number, number, number]; sky: [number, number, number]; deep: [number, number, number]; opacity: number; dimCloud: number; dimAir: number; floor: number }> = {
  // Venus: a few hundredths of the light above reach the ground (the readout gives the probe's numbers, not these).
  venus: { cloud: [1, 0.94, 0.78], deepCloud: [0.95, 0.6, 0.28], sky: [0.05, 0.07, 0.14], deep: [0.16, 0.08, 0.035], opacity: 0.9, dimCloud: 0.06, dimAir: 0.035, floor: 0.02 },
  jupiter: { cloud: [0.96, 0.9, 0.8], deepCloud: [0.55, 0.38, 0.24], sky: [0.06, 0.08, 0.13], deep: [0.026, 0.022, 0.02], opacity: 0.25, dimCloud: 0.05, dimAir: 0.08, floor: 0 },
};

export function createDescent(file: DescentFile, baseRadiusKm: number): Descent {
  const profile = createProfile(file);
  const world = file.world;
  const looks = LOOKS[world];
  const site = file.site;
  let here = { latDeg: site.latDeg, lonDeg: site.lonDeg };
  let frame = localFrame(site.latDeg, site.lonDeg);
  let active = false;
  let held = false;
  let z = profile.topKm;
  let heading = 0;
  let pitch = -0.25;
  let sunSeen = 1;
  let starsSeen = 1;

  const uUp = uniform(new Vector3(0, 1, 0));
  const uSun = uniform(new Vector3(0, 1, 0));
  const uAbove = uniform(0);
  const uBelow = uniform(0);
  const uLight = uniform(1);
  const uLightTop = uniform(1);
  const uNight = uniform(0);
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const up = normalize(uUp);
    const e = dot(d, up);
    const slant = max(e.abs(), 0.04);
    // The cloud along the view: the column above (looking up) or below (looking down), through the slant.
    const tauUp = uAbove.mul(looks.opacity).div(slant);
    const tauDown = uBelow.mul(looks.opacity).div(slant);
    const fogUp = float(1).sub(exp(tauUp.negate()));
    const fogDown = float(1).sub(exp(tauDown.negate()));
    // The cloud's colour deepens toward orange (Venus) or brown (Jupiter) as the light passing down through it dims.
    const cloudHere = mix(vec3(...looks.deepCloud), vec3(...looks.cloud), smoothstep(0.05, 0.6, uLight.div(max(uLightTop, 1e-4))));
    // Up: the clear sky over the clouds (bright toward the Sun by day), behind the cloud above lit as the light at the top is.
    const sunward = max(dot(d, normalize(uSun)), 0);
    const skyUp = vec3(...looks.sky).mul(uLightTop).mul(pow(sunward, 4).mul(2).add(1)).mul(float(1).sub(uNight));
    const cloudAbove = cloudHere.mul(mix(uLightTop, uLight, 0.5));
    const up_ = mix(skyUp, cloudAbove, fogUp);
    // Down: the deep (dim, as the light at the bottom of the column is), behind the cloud below lit by the light here.
    const deep = vec3(...looks.deep).mul(uLight);
    const cloudBelow = cloudHere.mul(uLight).mul(1.1);
    const down = mix(deep, cloudBelow, fogDown);
    const colour = select(e.greaterThan(0), up_, down);
    // A soft horizon between the two.
    const blend = smoothstep(-0.04, 0.04, e);
    return vec4(mix(down, colour, blend).mul(0.6), 1);
  })();
  const mesh = new Mesh(new SphereGeometry(1, 48, 24), material);
  mesh.name = 'explore-descent-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  mesh.visible = false;

  /** The light reaching an altitude (0 to 1 of the light above the atmosphere): dimmed by the cloud and the air above, never below the floor. */
  const lightAt = (altitude: number): number => {
    const r = profile.at(altitude);
    return Math.max(looks.floor, Math.exp(-looks.dimCloud * profile.cloudAbove(altitude) - looks.dimAir * r.pressureBar));
  };

  const pose = (): { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] } => {
    const { up, east, north } = frame;
    const r = baseRadiusKm + z;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const level = [0, 1, 2].map((k) => ch * (north[k] ?? 0) + sh * (east[k] ?? 0));
    return {
      position: [up[0] * r, up[1] * r, up[2] * r],
      forward: [0, 1, 2].map((k) => cp * (level[k] ?? 0) + sp * (up[k] ?? 0)) as [number, number, number],
      up: [0, 1, 2].map((k) => -sp * (level[k] ?? 0) + cp * (up[k] ?? 0)) as [number, number, number],
    };
  };

  return {
    objects: [mesh],
    get active() {
      return active;
    },
    world,
    profile,
    start(latDeg, lonDeg) {
      active = true;
      held = false;
      here = { latDeg, lonDeg };
      frame = localFrame(latDeg, lonDeg);
      z = profile.topKm;
      heading = 0;
      pitch = -0.25;
    },
    stop() {
      active = false;
      mesh.visible = false;
    },
    look(dx, dy) {
      heading = (((heading - dx * LOOK.perPx) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      pitch = Math.max(-LOOK.maxPitch, Math.min(LOOK.maxPitch, pitch + dy * LOOK.perPx));
    },
    setHeld(h) {
      held = h;
    },
    goTo(p) {
      z = profile.altitudeAtPressure(p);
    },
    step(dt, climb, fast) {
      if (!active) return null;
      // Down at the gentle rate (hurried, or held), or up; evenly in the logarithm of the pressure, as a probe's fall slows.
      const rate = climb > 0 ? -FALL.lnPerS * FALL.climb * climb : climb < 0 ? FALL.lnPerS * FALL.hurry * -climb : held ? 0 : FALL.lnPerS;
      const step = rate * Math.min(dt, 0.2) * (fast ? 4 : 1);
      if (step !== 0) z = profile.altitudeAtPressure(profile.at(z).pressureBar * Math.exp(step));
      return pose();
    },
    place(f) {
      mesh.visible = active;
      if (!active) return;
      const m = f.basis;
      const { up } = frame;
      uUp.value.set(up[0] * (m[0] ?? 1) + up[1] * (m[3] ?? 0) + up[2] * (m[6] ?? 0), up[0] * (m[1] ?? 0) + up[1] * (m[4] ?? 1) + up[2] * (m[7] ?? 0), up[0] * (m[2] ?? 0) + up[1] * (m[5] ?? 0) + up[2] * (m[8] ?? 1));
      uSun.value.set(f.sun.x, f.sun.y, f.sun.z);
      // The Sun's height here, and the day's light at the top of the column.
      const sinSun = uUp.value.dot(uSun.value) / Math.max(1e-9, uUp.value.length() * uSun.value.length());
      const day = Math.min(1, Math.max(0, (sinSun + 0.1) / 0.3));
      uNight.value = 1 - day;
      uLightTop.value = day * Math.min(f.light, 2);
      uLight.value = uLightTop.value * lightAt(z);
      uAbove.value = profile.cloudAbove(z);
      uBelow.value = profile.cloudBelow(z);
      // The Sun's own light straight through the cloud above it, and the stars' (only by night) through all of it.
      sunSeen = sinSun > 0 ? Math.exp((-looks.opacity * uAbove.value) / Math.max(sinSun, 0.04)) : 0;
      starsSeen = (1 - day) * Math.exp(-looks.opacity * uAbove.value);
      mesh.scale.setScalar(f.far * 0.9);
    },
    sunSeen() {
      return active ? sunSeen : 1;
    },
    starlight() {
      return active ? starsSeen : 1;
    },
    view() {
      if (!active) return null;
      const r = profile.at(z);
      return {
        world,
        probe: file.probe,
        date: file.date,
        latDeg: site.latDeg,
        lonDeg: site.lonDeg,
        hereLatDeg: here.latDeg,
        hereLonDeg: here.lonDeg,
        altitudeKm: r.altitudeKm,
        reference: world === 'venus' ? 'radius' : 'one-bar',
        pressureBar: r.pressureBar,
        temperatureK: r.temperatureK,
        densityKgM3: r.densityKgM3,
        cloud: r.cloud,
        windMs: r.windMs,
        between: r.between,
        held,
        atBottom: z <= profile.bottomKm + 1e-6,
        light: uLight.value,
        topBar: profile.at(profile.topKm).pressureBar,
        bottomBar: profile.at(profile.bottomKm).pressureBar,
      };
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
