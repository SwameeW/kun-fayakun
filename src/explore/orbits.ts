/**
 * Orbits as hairlines of light: the analytic ellipses of the planets' JPL elements on the date
 * (the Earth's is the Earth-Moon barycentre's) and the Moon's real path from Horizons, drawn with
 * the chapters' streak renderer in one draw call.
 *
 * Every point is computed on the CPU in doubles, relative to the camera, then put through the
 * same scaled-space remap as the bodies, so a line passing a few thousand km from the camera is
 * as steady as one 30 au away. Points crowd toward the part of each orbit nearest the camera,
 * where perspective makes segments longest on screen, and each line is cut exactly at the near
 * plane (never left to end where a segment happens to). Brightness changes smoothly along a line:
 * it fades near the body in focus (an orbit through a planet seen up close would slice it) and
 * where it passes close beside the camera. It is held in display terms: a guide, not lit matter,
 * so it does not brighten as the exposure adapts.
 */

import { InstancedBufferAttribute, type Mesh, type Node } from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, uniform } from 'three/tsl';
import { elementsAt, moonHermiteKm, type MoonFile, type PlanetBody } from '../astro/ephemeris';
import { createStreakField, type StreakField } from '../chapters/shared/streaks';
import type { BodyId } from '../core/types';
import { eclipticToRender, km, type Km } from './space/origin';
import { scaledFactor } from './space/scaled-space';

/**
 * Segments per orbit, and how strongly they crowd toward the camera (1 = evenly). Enough that an
 * orbit seen from inside it (the Moon's, from beside the Earth) still curves smoothly across the view.
 */
const SEGMENTS = 320;
const CROWD = 2;
/** Line width as a share of the screen height. */
const WIDTH = 0.0013;

export interface OrbitPath {
  readonly body: BodyId;
  /** The body it goes around (render frame, km, kept current): the Sun, or the Earth for the Moon. */
  readonly centre: Km;
  /** Linear colour of the line at full strength (display terms). */
  readonly color: readonly [number, number, number];
  /** The orbit's size (its semi-major axis, or the Moon's distance on the date), km. */
  readonly sizeKm: number;
  /** Recomputes the path for a date (TDB Julian date); cheap enough to call every frame. */
  setDate(jd: number): void;
  /** The point at parameter u (periodic, period 1), render frame, km. */
  point(u: number, out: Km): Km;
  /** The parameter of (about) the point nearest to a position. */
  nearest(position: Km): number;
}

const DEG = Math.PI / 180;
const TURN = 2 * Math.PI;

/** A planet's Kepler ellipse from its elements on the date, around the Sun (at `sun`). */
export function planetOrbit(body: BodyId, planet: PlanetBody, sun: Km, auKm: number, color: readonly [number, number, number]): OrbitPath {
  const el = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0 };
  // Orbit-plane axes in the ecliptic: P toward perihelion, Q 90 degrees on; and the semi-axes (km).
  const P = km();
  const Q = km();
  let a = 0;
  let b = 0;
  let e = 0;
  const ecl = km();
  return {
    body,
    centre: sun,
    color,
    get sizeKm() {
      return a;
    },
    setDate(jd) {
      elementsAt(planet, jd, el);
      const I = el.I * DEG;
      const Omega = el.Omega * DEG;
      const omega = el.varpi * DEG - Omega;
      const [cw, sw, cO, sO, cI, sI] = [Math.cos(omega), Math.sin(omega), Math.cos(Omega), Math.sin(Omega), Math.cos(I), Math.sin(I)];
      // The same rotation as astro/ephemeris positionFromElements, so the line passes through the planet.
      P.x = cw * cO - sw * sO * cI;
      P.y = cw * sO + sw * cO * cI;
      P.z = sw * sI;
      Q.x = -sw * cO - cw * sO * cI;
      Q.y = -sw * sO + cw * cO * cI;
      Q.z = cw * sI;
      a = el.a * auKm;
      e = el.e;
      b = a * Math.sqrt(1 - e * e);
    },
    point(u, out) {
      const E = u * TURN;
      const x = a * (Math.cos(E) - e);
      const y = b * Math.sin(E);
      ecl.x = P.x * x + Q.x * y;
      ecl.y = P.y * x + Q.y * y;
      ecl.z = P.z * x + Q.z * y;
      return eclipticToRender(ecl, out);
    },
    nearest(position) {
      // The position in the orbit plane (render to ecliptic: x, -z, y), then its eccentric anomaly.
      const ex = position.x;
      const ey = -position.z;
      const ez = position.y;
      const x = ex * P.x + ey * P.y + ez * P.z;
      const y = ex * Q.x + ey * Q.y + ez * Q.z;
      const E = Math.atan2(y / b, x / a + e);
      return (((E / TURN) % 1) + 1) % 1;
    },
  };
}

/**
 * The Moon's real path around the Earth for one turn centred on the date (Horizons, Hermite), drawn
 * around the Earth's present position. The path does not quite close (the orbit turns and stretches
 * over a month), so the small mismatch is spread evenly along it; the Moon's own point is exact.
 */
export function moonOrbit(moon: MoonFile, earth: Km, color: readonly [number, number, number]): OrbitPath {
  const geo = km();
  const mismatch = km();
  let jd0 = 0;
  /** Days back and ahead to cover one full turn either side of the date. */
  let back = 13.66;
  let ahead = 13.66;
  const sample = km();

  /** Days until the Moon's direction has swept half a turn (sign = direction in time). */
  const halfTurn = (sign: 1 | -1): number => {
    const start = moonHermiteKm(moon, jd0, km());
    const normal = km();
    const next = moonHermiteKm(moon, jd0 + 0.1, km());
    normal.x = start.y * next.z - start.z * next.y;
    normal.y = start.z * next.x - start.x * next.z;
    normal.z = start.x * next.y - start.y * next.x;
    let swept = 0;
    let prev = start;
    for (let day = 0.5; day <= 20; day += 0.5) {
      const p = moonHermiteKm(moon, jd0 + sign * day, km());
      const cross = (prev.y * p.z - prev.z * p.y) * normal.x + (prev.z * p.x - prev.x * p.z) * normal.y + (prev.x * p.y - prev.y * p.x) * normal.z;
      const dot = prev.x * p.x + prev.y * p.y + prev.z * p.z;
      const step = Math.abs(Math.atan2(Math.abs(cross) / Math.hypot(normal.x, normal.y, normal.z), dot));
      if (swept + step >= Math.PI) return day - 0.5 + (0.5 * (Math.PI - swept)) / step;
      swept += step;
      prev = p;
    }
    return 13.66;
  };

  const raw = (u: number, out: Km): Km => {
    moonHermiteKm(moon, jd0 - back + u * (back + ahead), geo);
    return eclipticToRender(geo, out);
  };

  const point = (u: number, out: Km): Km => {
    const wrapped = ((u % 1) + 1) % 1;
    raw(wrapped, out);
    // Spread the closing mismatch so the ends meet; zero at the Moon's own point.
    const share = wrapped - back / (back + ahead);
    out.x += earth.x - mismatch.x * share;
    out.y += earth.y - mismatch.y * share;
    out.z += earth.z - mismatch.z * share;
    return out;
  };

  let size = 384_400;
  return {
    body: 'moon',
    centre: earth,
    color,
    get sizeKm() {
      return size;
    },
    setDate(jd) {
      // The sweep is measured again only when the date has moved by an hour or more.
      if (Math.abs(jd - jd0) < 1 / 24 && jd0 !== 0) {
        jd0 = jd;
        return;
      }
      jd0 = jd;
      const now = moonHermiteKm(moon, jd0, km());
      size = Math.hypot(now.x, now.y, now.z);
      back = halfTurn(-1);
      ahead = halfTurn(1);
      const first = raw(0, km());
      const last = raw(1, km());
      mismatch.x = last.x - first.x;
      mismatch.y = last.y - first.y;
      mismatch.z = last.z - first.z;
    },
    point,
    nearest(position) {
      let best = 0;
      let bestDistance = Infinity;
      const steps = 96;
      for (let i = 0; i < steps; i += 1) {
        const u = i / steps;
        point(u, sample);
        const d = Math.hypot(sample.x - position.x, sample.y - position.y, sample.z - position.z);
        if (d < bestDistance) {
          bestDistance = d;
          best = u;
        }
      }
      return best;
    },
  };
}

export interface OrbitFrame {
  camera: Km;
  /** The view's forward direction (unit, render frame) and near plane (km): lines are cut there. */
  forward: Km;
  near: number;
  far: number;
  /** The body in focus and the distance from the camera to it (km): lines fade within about that of it. */
  focus: Km;
  focusRadius: number;
  focusDistance: number;
  /** Divides the lines' colour by the exposure's adaptation, so they keep their brightness on screen. */
  compensation: number;
  /** Overall strength, 0 to 1. */
  light: number;
  /** Strength of each path (in the order given to createOrbits), 0 to 1. */
  weights: readonly number[];
}

export interface Orbits {
  readonly mesh: Mesh;
  update(frame: OrbitFrame): void;
  dispose(): void;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Points closer than this share beyond the near plane are cut (the depth buffer's own clip is not relied on). */
const NEAR_MARGIN = 1.02;

export function createOrbits(paths: readonly OrbitPath[]): Orbits {
  const count = paths.length * SEGMENTS;
  const tails = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const heads = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const tailColors = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const headColors = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const uCompensation = uniform(1);
  const field: StreakField = createStreakField({
    name: 'explore-orbits',
    maxCount: count,
    tail: instancedDynamicBufferAttribute(tails) as unknown as Node<'vec3'>,
    head: instancedDynamicBufferAttribute(heads) as unknown as Node<'vec3'>,
    color: (instancedDynamicBufferAttribute(headColors) as unknown as Node<'vec3'>).mul(uCompensation),
    tailColor: (instancedDynamicBufferAttribute(tailColors) as unknown as Node<'vec3'>).mul(uCompensation),
    width: float(WIDTH),
    profile: 'line',
  });
  field.mesh.renderOrder = -5;

  const point = km();
  const rel = km();
  /** Remapped points of one orbit, flat xyz, their depth along the view, and their fade. */
  const placed = new Float64Array((SEGMENTS + 1) * 3);
  const depth = new Float64Array(SEGMENTS + 1);
  const fade = new Float64Array(SEGMENTS + 1);

  const write = (o: number, array: InstancedBufferAttribute['array'], x: number, y: number, z: number): void => {
    array[o] = x;
    array[o + 1] = y;
    array[o + 2] = z;
  };

  return {
    mesh: field.mesh,
    update(frame) {
      uCompensation.value = frame.light / Math.max(frame.compensation, 1e-6);
      const fadeNear = Math.max(frame.focusRadius * 2, Math.min(frame.focusDistance, frame.focusRadius * 60));
      const cut = frame.near * NEAR_MARGIN;
      const { forward } = frame;
      paths.forEach((path, p) => {
        const weight = frame.weights[p] ?? 1;
        if (weight <= 1e-3) {
          // Hidden: collapse its segments rather than computing them.
          tailColors.array.fill(0, p * SEGMENTS * 3, (p + 1) * SEGMENTS * 3);
          headColors.array.fill(0, p * SEGMENTS * 3, (p + 1) * SEGMENTS * 3);
          return;
        }
        // How far the orbit's own centre is from the camera: the scale of "close beside the camera".
        const scale = Math.max(1, Math.hypot(path.centre.x - frame.camera.x, path.centre.y - frame.camera.y, path.centre.z - frame.camera.z));
        const centre = path.nearest(frame.camera);
        for (let i = 0; i <= SEGMENTS; i += 1) {
          const v = -1 + (2 * i) / SEGMENTS;
          const u = centre + 0.5 * Math.sign(v) * Math.abs(v) ** CROWD;
          path.point(u, point);
          rel.x = point.x - frame.camera.x;
          rel.y = point.y - frame.camera.y;
          rel.z = point.z - frame.camera.z;
          const k = scaledFactor(Math.hypot(rel.x, rel.y, rel.z), 0, frame.far);
          placed[3 * i] = rel.x * k;
          placed[3 * i + 1] = rel.y * k;
          placed[3 * i + 2] = rel.z * k;
          depth[i] = (rel.x * forward.x + rel.y * forward.y + rel.z * forward.z) * k;
          // Faded near the body in focus, and where the line passes close beside the camera compared
          // with the size of the orbit: seen there in steep perspective it would be a stroke bent
          // across the view, not a curve around its centre.
          const near = Math.hypot(point.x - frame.focus.x, point.y - frame.focus.y, point.z - frame.focus.z);
          const beside = Math.hypot(rel.x, rel.y, rel.z) / scale;
          fade[i] = smoothstep(0.6 * fadeNear, 1.8 * fadeNear, near) * smoothstep(0.004, 0.03, beside) * weight;
        }
        const [r, g, b] = path.color;
        for (let i = 0; i < SEGMENTS; i += 1) {
          const o = (p * SEGMENTS + i) * 3;
          const a = 3 * i;
          const da = depth[i] ?? 0;
          const db = depth[i + 1] ?? 0;
          let fa = fade[i] ?? 0;
          let fb = fade[i + 1] ?? 0;
          let ta = 0;
          let tb = 1;
          if (da < cut && db < cut) {
            fa = 0;
            fb = 0;
          } else if (da < cut || db < cut) {
            // Cut where the segment crosses the near plane; its colour is carried to the cut point.
            const t = (cut - da) / (db - da);
            if (da < cut) ta = t;
            else tb = t;
            const f0 = fa;
            const f1 = fb;
            fa = f0 + (f1 - f0) * ta;
            fb = f0 + (f1 - f0) * tb;
          }
          const ax = placed[a] ?? 0;
          const ay = placed[a + 1] ?? 0;
          const az = placed[a + 2] ?? 0;
          const bx = placed[a + 3] ?? 0;
          const by = placed[a + 4] ?? 0;
          const bz = placed[a + 5] ?? 0;
          write(o, tails.array, ax + (bx - ax) * ta, ay + (by - ay) * ta, az + (bz - az) * ta);
          write(o, heads.array, ax + (bx - ax) * tb, ay + (by - ay) * tb, az + (bz - az) * tb);
          write(o, tailColors.array, r * fa, g * fa, b * fa);
          write(o, headColors.array, r * fb, g * fb, b * fb);
        }
      });
      tails.needsUpdate = true;
      heads.needsUpdate = true;
      tailColors.needsUpdate = true;
      headColors.needsUpdate = true;
      field.mesh.visible = frame.light > 1e-3;
    },
    dispose() {
      field.dispose();
    },
  };
}
