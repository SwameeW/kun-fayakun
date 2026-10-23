/**
 * The explorer's bodies: its own instances of the chapters' shared factories (never the chapters'
 * objects), built on its own noise volume, at unit radius. The explorer scales each one to its true
 * radius (times the scaled-space factor) every frame and turns it as the body really stands.
 *
 * Surfaces are procedural and illustrative until the mission maps arrive (Stage 7): the Earth's
 * continents are not the real ones, and the giants' belts and zones, the Great Red Spot and the
 * rings' structure are drawn after the real ones' general look, not measured. Sizes, shapes
 * (flattening), tilts, spins, phases and lighting are real.
 */

import { Vector3, type Data3DTexture, type Group, type Node } from 'three/webgpu';
import { abs, dot, float, fwidth, max, mix, sin, smoothstep, texture3D, vec3 } from 'three/tsl';
import { createEarth, createSimpleBody, EARTH_TODAY, type Earth, type EarthEpoch, type RingProfile, type SimpleBody } from '../../chapters/shared/planet';
import { createLivingStar, type LivingStar } from '../../chapters/shared/sun';
import type { BodyId } from '../../core/types';
import { EARTH_AIR_SCALE, type BodySpec } from '../system';

/** The Sun's effective temperature, as Chapter 7 uses it (its colour, from the blackbody law). */
export const SUN_KELVIN = 5772;
/** Today's Earth, with a little less cloud than the chapters' (seen whole and close, more of the surface shows). */
const EARTH_NOW: EarthEpoch = { ...EARTH_TODAY, clouds: 0.6 };

export interface BodyFrame {
  /** Seconds since the explorer opened (cloud drift, granulation). */
  time: number;
  /** Unit direction from the body to the Sun, render frame. */
  sun: { x: number; y: number; z: number };
  /** Sunlight on the body (1 at 1 au), or the Sun's own brightness. */
  light: number;
  /** The Sun only: the colour of the solar filter it is seen through (white for none). */
  filter?: readonly [number, number, number];
}

export interface BodyVisual {
  readonly id: BodyId;
  readonly object: Group;
  /** Set the object's position, scale and orientation first. */
  update(frame: BodyFrame): void;
  dispose(): void;
}

type Vec3Node = Node<'vec3'>;
type FloatNode = Node<'float'>;

/** 1 between a and b (on the same axis), with soft edges `soft` wide. */
const band = (x: FloatNode, a: number, b: number, soft: number): FloatNode =>
  smoothstep(a - soft, a + soft, x).mul(float(1).sub(smoothstep(b - soft, b + soft, x)));

/** A sine ripple of x that fades out as its period nears a pixel, so fine banding never shimmers. */
const ripple = (x: FloatNode, frequency: number, phase: FloatNode | number = 0): FloatNode => {
  const perPixel = fwidth(x).mul(frequency / (2 * Math.PI));
  return sin(x.mul(frequency).add(phase)).mul(float(1).sub(smoothstep(0.25, 0.6, perPixel)));
};

/**
 * Jupiter: cream zones and rust-brown belts at about their real latitudes (as sines of latitude),
 * a pale equatorial zone, grey-brown polar regions, east-west streaks, and an oval storm in the
 * south tropics after the Great Red Spot. Illustrative, not a map.
 */
function jupiterSurface(noise: Data3DTexture): (n: Vec3Node) => Vec3Node {
  return (n) => {
    // Turbulence stretched east-west, as the zonal winds draw it out, at three scales.
    const big = texture3D(noise, vec3(n.x.mul(1.6), n.y.mul(6), n.z.mul(1.6)).add(0.37)).r;
    const mid = texture3D(noise, vec3(n.x.mul(3.6), n.y.mul(17), n.z.mul(3.6)).add(0.11)).r;
    const fine = texture3D(noise, vec3(n.x.mul(7.5), n.y.mul(46), n.z.mul(7.5)).add(0.71)).r;
    const y = n.y.add(big.sub(0.5).mul(0.05)).add(mid.sub(0.5).mul(0.024)).add(fine.sub(0.5).mul(0.006));
    const zone = vec3(0.96, 0.91, 0.81);
    const equator = vec3(0.97, 0.88, 0.71);
    const belt = vec3(0.62, 0.4, 0.25);
    const darkBelt = vec3(0.52, 0.31, 0.19);
    const temperate = vec3(0.7, 0.56, 0.43);
    const polar = vec3(0.52, 0.5, 0.5);
    let c: Vec3Node = zone;
    c = mix(c, equator, band(y, -0.122, 0.122, 0.015));
    c = mix(c, belt, band(y, 0.122, 0.292, 0.018).mul(mid.mul(0.45).add(0.7)));
    c = mix(c, darkBelt, band(y, -0.342, -0.122, 0.02).mul(big.mul(0.5).add(0.6)));
    c = mix(c, temperate, band(y, 0.407, 0.515, 0.014).mul(0.9));
    c = mix(c, temperate, band(y, -0.53, -0.438, 0.014).mul(0.85));
    c = mix(c, temperate, band(y, 0.574, 0.629, 0.012).mul(0.65));
    c = mix(c, temperate, band(y, -0.656, -0.602, 0.012).mul(0.6));
    c = mix(c, polar.mul(mid.mul(0.45).add(0.78)), smoothstep(0.68, 0.8, abs(y)));
    // Thin streaks within the bands, drawn out by the winds.
    c = c.mul(ripple(y, 240, big.mul(6)).mul(0.05).add(1));
    // The oval storm: about 14 by 9 degrees at 22.5 degrees south, at longitude 0 of the body frame.
    const lat = -22.5 * (Math.PI / 180);
    const centre = vec3(0, Math.sin(lat), Math.cos(lat));
    const east = vec3(1, 0, 0);
    const north = vec3(0, Math.cos(lat), -Math.sin(lat));
    const ex = dot(n, east).div(0.125);
    const ny = dot(n, north).div(0.078);
    const r2 = ex.mul(ex).add(ny.mul(ny)).add(mid.sub(0.5).mul(0.3));
    const facing = smoothstep(0.5, 0.7, dot(n, centre));
    const spot = float(1).sub(smoothstep(0.35, 1.05, r2)).mul(facing);
    const collar = smoothstep(0.85, 1.25, r2).mul(float(1).sub(smoothstep(1.35, 2.4, r2))).mul(facing);
    c = mix(c, zone, collar.mul(0.7));
    c = mix(c, vec3(0.8, 0.43, 0.28).mul(fine.mul(0.3).add(0.85)), spot);
    return c.mul(fine.mul(0.12).add(0.94));
  };
}

/**
 * The Moon: dark, smooth maria with fairly sharp shores, gathered on the near side (local +x,
 * which the IAU rotation model turns toward the Earth), bright rough highlands, and a speckle of
 * small brighter and darker spots for the craters. A grey world of low albedo. Illustrative.
 */
function moonSurface(noise: Data3DTexture): (n: Vec3Node) => Vec3Node {
  return (n) => {
    // Basins: large, rounded, filled where the near side's bias lifts them over the threshold.
    const basins = texture3D(noise, n.mul(1.1).add(0.83)).r.mul(0.75).add(texture3D(noise, n.mul(2.3).add(0.4)).r.mul(0.25));
    const nearSide = smoothstep(-0.2, 0.7, n.x);
    const mare = smoothstep(0.58, 0.7, basins.add(nearSide.mul(0.2)).sub(0.06));
    const rough = texture3D(noise, n.mul(4.4).add(0.21)).r;
    const speck = texture3D(noise, n.mul(15).add(0.57)).r;
    const grain = texture3D(noise, n.mul(41).add(0.33)).r;
    const highland = vec3(0.4, 0.39, 0.37).mul(rough.mul(0.3).add(0.84));
    const sea = vec3(0.19, 0.185, 0.18).mul(rough.mul(0.18).add(0.9));
    let c: Vec3Node = mix(highland, sea, mare);
    // Craters at two sizes: bright young rims and darker floors as a fine speckle.
    c = c.mul(smoothstep(0.62, 0.8, speck).mul(0.35).add(smoothstep(0.4, 0.2, speck).mul(-0.12)).add(0.95));
    return c.mul(smoothstep(0.55, 0.85, grain).mul(0.22).add(grain.mul(0.08)).add(0.92));
  };
}

/** Saturn: pale butterscotch, softly banded, a brighter equatorial zone, greyer toward the poles. Illustrative. */
function saturnSurface(noise: Data3DTexture): (n: Vec3Node) => Vec3Node {
  return (n) => {
    const big = texture3D(noise, vec3(n.x.mul(1.2), n.y.mul(7), n.z.mul(1.2)).add(0.13)).r;
    const fine = texture3D(noise, vec3(n.x.mul(4), n.y.mul(40), n.z.mul(4)).add(0.52)).r;
    const y = n.y.add(big.sub(0.5).mul(0.025));
    const ay = abs(y);
    const base = vec3(0.9, 0.81, 0.62);
    const belt = vec3(0.79, 0.66, 0.46);
    let c: Vec3Node = base;
    c = mix(c, vec3(0.95, 0.88, 0.7), band(y, -0.14, 0.14, 0.035));
    c = mix(c, belt, band(ay, 0.2, 0.34, 0.035).mul(0.75));
    c = mix(c, belt, band(ay, 0.44, 0.54, 0.025).mul(0.5));
    c = mix(c, belt, band(ay, 0.62, 0.68, 0.02).mul(0.4));
    c = mix(c, vec3(0.66, 0.66, 0.6), smoothstep(0.76, 0.9, ay));
    c = c.mul(ripple(y, 160, fine.mul(2)).mul(0.035).add(1));
    return c.mul(fine.mul(0.08).add(0.96));
  };
}

/**
 * Saturn's rings, between physical.json's span (72,770 to 144,987.5 km, the Cassini RSS profile's
 * range), drawn after their real look: the faint C ring, the bright, nearly opaque B ring, the
 * Cassini Division, the A ring with the Encke gap, and the thin F ring. Illustrative: Stage 8 will
 * draw the measured RSS optical depth instead. Fine ringlets fade out where they would be smaller
 * than a pixel, so the rings never shimmer.
 */
function saturnRings(innerKm: number, outerKm: number): RingProfile {
  const at = (rKm: number): number => (rKm - innerKm) / (outerKm - innerKm);
  const C = [at(74_500), at(92_000)] as const;
  const B = [at(92_000), at(117_500)] as const;
  const CD = [at(117_500), at(122_000)] as const;
  const A = [at(122_000), at(136_800)] as const;
  const ENCKE = [at(133_400), at(133_750)] as const;
  const F = [at(140_100), at(140_350)] as const;
  const detail = (radial: FloatNode, frequency: number): FloatNode => {
    // Fade a ripple as its period nears a pixel (two periods per pixel: gone).
    const fw = fwidth(radial).mul(frequency);
    return sin(radial.mul(frequency)).mul(float(1).sub(smoothstep(0.6, 2.5, fw)));
  };
  return {
    opacity(radial) {
      const c = band(radial, C[0], C[1], 0.004).mul(detail(radial, 900).mul(0.05).add(0.2));
      const b = band(radial, B[0], B[1], 0.003).mul(detail(radial, 420).mul(0.05).add(detail(radial, 1300).mul(0.04)).add(0.88));
      const cd = band(radial, CD[0], CD[1], 0.002).mul(0.08);
      const a = band(radial, A[0], A[1], 0.002).mul(detail(radial, 650).mul(0.05).add(0.58));
      const encke = band(radial, ENCKE[0], ENCKE[1], 0.0007).mul(0.5);
      const f = band(radial, F[0], F[1], 0.0008).mul(0.35);
      return max(c.add(b).add(cd).add(a).sub(encke).add(f), 0);
    },
    color(radial) {
      const cRing = vec3(0.62, 0.55, 0.47);
      const bRing = vec3(0.97, 0.87, 0.68);
      const aRing = vec3(0.86, 0.8, 0.69);
      let col: Vec3Node = cRing;
      col = mix(col, bRing, smoothstep(B[0] - 0.01, B[0] + 0.05, radial));
      // The B ring's outer half is the brightest part of the rings.
      col = col.mul(float(1).add(band(radial, (B[0] + B[1]) / 2, B[1], 0.03).mul(0.12)));
      col = mix(col, vec3(0.55, 0.52, 0.48), band(radial, CD[0], CD[1], 0.002));
      col = mix(col, aRing, smoothstep(A[0] - 0.002, A[0] + 0.01, radial));
      return col.mul(detail(radial, 2300).mul(0.05).add(1.06));
    },
  };
}

const SEGMENTS: readonly [number, number] = [160, 120];

export function createBodies(noise: Data3DTexture, specs: Readonly<Record<BodyId, BodySpec>>, rings: { innerKm: number; outerKm: number }): Record<BodyId, BodyVisual> {
  const flattening = (spec: BodySpec): number => 1 - spec.polarKm / spec.radiusKm;
  const sun: LivingStar = createLivingStar(noise, 1, 0.31, { fine: 0.35, filter: true });
  const earth: Earth = createEarth(noise, 1, { atmosphereScale: EARTH_AIR_SCALE, segments: [256, 160], lava: false });
  const moon: SimpleBody = createSimpleBody(noise, 1, {
    name: 'explore-moon',
    color: [0.42, 0.41, 0.39],
    lighting: 'lunar',
    surface: moonSurface(noise),
    segments: SEGMENTS,
  });
  const jupiter: SimpleBody = createSimpleBody(noise, 1, {
    name: 'explore-jupiter',
    color: [0.86, 0.74, 0.6],
    flattening: flattening(specs.jupiter),
    tilt: 0,
    lighting: 'giant',
    surface: jupiterSurface(noise),
    segments: SEGMENTS,
  });
  const radius = specs.saturn.radiusKm;
  const saturn: SimpleBody = createSimpleBody(noise, 1, {
    name: 'explore-saturn',
    color: [0.9, 0.82, 0.62],
    flattening: flattening(specs.saturn),
    tilt: 0,
    lighting: 'giant',
    surface: saturnSurface(noise),
    rings: [rings.innerKm / radius, rings.outerKm / radius],
    ringProfile: saturnRings(rings.innerKm, rings.outerKm),
    ringShadows: true,
    segments: SEGMENTS,
  });
  sun.object.name = 'explore-sun';
  earth.object.name = 'explore-earth';
  return {
    sun: {
      id: 'sun',
      object: sun.object,
      update(frame) {
        sun.update({ time: frame.time, kelvin: SUN_KELVIN, light: frame.light, ...(frame.filter ? { filter: frame.filter } : {}) });
      },
      dispose: () => {
        sun.dispose();
      },
    },
    earth: {
      id: 'earth',
      object: earth.object,
      update(frame) {
        // Clouds drift slowly; the planet's own turn comes from its real orientation, not from spin.
        earth.update({ time: frame.time * 0.1, sun: toVector3(frame.sun), spin: 0, light: frame.light, epoch: EARTH_NOW });
      },
      dispose: () => {
        earth.dispose();
      },
    },
    moon: wrap('moon', moon),
    jupiter: wrap('jupiter', jupiter),
    saturn: wrap('saturn', saturn),
  };
}

const scratchSun = new Vector3();
function toVector3(v: { x: number; y: number; z: number }): Vector3 {
  return scratchSun.set(v.x, v.y, v.z);
}

function wrap(id: BodyId, body: SimpleBody): BodyVisual {
  return {
    id,
    object: body.object,
    update(frame) {
      body.update({ time: frame.time, sun: toVector3(frame.sun), spin: 0, light: frame.light });
    },
    dispose: () => {
      body.dispose();
    },
  };
}
