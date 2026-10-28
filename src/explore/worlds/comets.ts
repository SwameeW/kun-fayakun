/**
 * The periodic comets (public/assets/smallbodies/comets.json): each where its orbit puts it on the
 * date (two-body from the Small-Body Database's elements, ./orbits), with a coma as bright as its
 * total-magnitude law gives (M1 + 5 log10(delta) + K1 log10(r)), and near the Sun its two tails.
 *
 * The tails point the way they do in the sky: the ion tail straight away from the Sun (the solar
 * wind carries the ions), the dust tail curving back from it along the orbit (dust released earlier,
 * pushed out by sunlight more gently than the ions, lags behind the nucleus: Finson and Probstein's
 * syndynes, drawn here as one curve). Their lengths, widths and light are illustrative: a comet's
 * activity is not in its orbital elements (the readout says so: UniverseIllustration 'comet-tails').
 *
 * Positions are float64 on the CPU (a few hundred comets, cheap); each tail is a ribbon facing the
 * camera, rebuilt each frame, in one draw call, through the scaled-space remap at its nucleus.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import { attribute, exp, float, max, pow, smoothstep, uniform, vec3 } from 'three/tsl';
import { createImpostors, type ImpostorDot, type Impostors } from '../bodies/impostor';
import { scaledFactor } from '../space/scaled-space';
import { eclipticToRender, km, type Km } from '../space/origin';
import { cometMagnitude, heliocentric, type WorldElements } from './orbits';

/** A row of comets.json: name, q (au), e, i, node, argument of perihelion (degrees), time of perihelion (TDB JD), M1, K1, class. */
export type CometRow = [string, number, number, number, number, number, number, number, number, string];

/** Comets are drawn within this distance of the Sun (au), and get tails within TAIL_AU. */
const SHOWN_AU = 8;
const TAIL_AU = 3.2;
/** At most this many comets get tails (the most active first), each tail this many segments. */
const MAX_TAILS = 16;
const SEGMENTS = 20;
/**
 * Illustrative tails: length (km) for an active comet of M1 = 10, how their size follows M1 (per
 * magnitude), widths along them (shares of the length, at the head and at the end), how far the dust
 * curves back (shares of the length), colours (linear, display terms: the ions' blue CO+ glow, the
 * dust's reflected sunlight) and light.
 */
const TAILS = {
  ionKm: 2.5e7,
  dustKm: 1.3e7,
  perMag: 0.12,
  ionWidth: [0.004, 0.035],
  dustWidth: [0.01, 0.14],
  bend: 0.35,
  ion: [0.42, 0.62, 1],
  dust: [1, 0.88, 0.7],
  light: 0.22,
  /** Tails fainter than this (display terms) are not drawn. */
  visible: 0.003,
} as const;
const STRAIGHT: Km = { x: 0, y: 0, z: 0 };
/** The comets are placed again once the clock has moved this many days (about 90 s): a few thousand km at most, out of sight. */
const MOVED_DAYS = 1e-3;
/** The coma (a point of light): the sky's magnitude mapping as seen, a marked light in wide views, its size range (CSS px) and colour (C2's green in the coma, illustrative). */
const COMA = { mag: 6.5, light: 0.05, power: 0.45, marked: 0.14, minPx: 5, maxPx: 22, colour: [0.78, 1, 0.86] } as const;

export interface CometsFrame {
  jd: number;
  /** The comet flown to (its name as the list gives it), or null: its tails come first, marked as in a wide view. */
  focus: string | null;
  camera: Km;
  far: number;
  compensation: number;
  /** Shown (the layer, faded), and how far the marked light is in. */
  fade: number;
  marked: number;
}

export interface Comets {
  readonly object: Group;
  /** Comets drawn now, and those with tails. */
  readonly shown: number;
  readonly tails: number;
  update(frame: CometsFrame): void;
  dispose(): void;
}

export function createComets(rows: readonly CometRow[], auKm: number): Comets {
  const object = new Group();
  object.name = 'explore-comets';
  const elements: WorldElements[] = rows.map(([, q, e, i, om, w, tp]) => ({ frame: 'ecliptic', epochJdTdb: tp, q, e, i, om, w, tp }));
  const heads: Impostors = createImpostors(rows.length);
  object.add(heads.object);
  const dotList: ImpostorDot[] = rows.map(() => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: COMA.minPx, marker: 0 }));

  // The tails' ribbons: two per comet, SEGMENTS + 1 pairs of vertices each.
  const ribbons = MAX_TAILS * 2;
  const perRibbon = (SEGMENTS + 1) * 2;
  const positions = new Float32Array(ribbons * perRibbon * 3);
  const colours = new Float32Array(ribbons * perRibbon * 3);
  const along = new Float32Array(ribbons * perRibbon * 2);
  const index: number[] = [];
  for (let r = 0; r < ribbons; r += 1) {
    for (let s = 0; s < SEGMENTS; s += 1) {
      const o = r * perRibbon + s * 2;
      index.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(index);
  const positionAttr = new BufferAttribute(positions, 3);
  const colourAttr = new BufferAttribute(colours, 3);
  const alongAttr = new BufferAttribute(along, 2);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('tailColour', colourAttr);
  geometry.setAttribute('tailAlong', alongAttr);
  const uCompensation = uniform(1);
  const material = new MeshBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, side: DoubleSide, fog: false });
  const st = attribute('tailAlong') as unknown as Node<'vec2'>;
  const s = st.x;
  const t = st.y;
  // Bright at the head (after a short rise out of the coma), fading along and across.
  const profile = pow(max(float(1).sub(s), 0), 1.6).mul(exp(t.mul(t).mul(-3.5))).mul(smoothstep(0, 0.04, s));
  material.colorNode = vec3(attribute('tailColour') as unknown as Node<'vec3'>).mul(profile).div(uCompensation);
  material.opacityNode = float(1);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'explore-comet-tails';
  mesh.frustumCulled = false;
  object.add(mesh);

  const helio = [0, 0, 0];
  const ecl = km();
  const placedHeads = rows.map(() => km());
  const r = new Float64Array(rows.length);
  /** Each coma's light as seen this frame (display terms), for its tails'. */
  const seenLight = new Float64Array(rows.length);
  const order: number[] = [];
  const before = [0, 0, 0];
  const after = [0, 0, 0];
  let shown = 0;
  let tails = 0;
  let placedAt = Number.NaN;

  /** Writes one ribbon: from `head` (camera-relative km) along a + b s^2 (unit-ish km directions times length), facing the camera. */
  const ribbon = (slot: number, head: Km, dir: Km, bend: Km, lengthKm: number, widths: readonly [number, number], colour: readonly number[], light: number, k: number): void => {
    const base = slot * perRibbon;
    for (let j = 0; j <= SEGMENTS; j += 1) {
      const u = j / SEGMENTS;
      const px = head.x + lengthKm * (dir.x * u + bend.x * u * u);
      const py = head.y + lengthKm * (dir.y * u + bend.y * u * u);
      const pz = head.z + lengthKm * (dir.z * u + bend.z * u * u);
      // The tangent, and the side square to it and to the line of sight (the camera at the origin).
      const tx = dir.x + 2 * bend.x * u;
      const ty = dir.y + 2 * bend.y * u;
      const tz = dir.z + 2 * bend.z * u;
      let sx = ty * pz - tz * py;
      let sy = tz * px - tx * pz;
      let sz = tx * py - ty * px;
      const l = Math.hypot(sx, sy, sz) || 1;
      const w = lengthKm * (widths[0] + (widths[1] - widths[0]) * u);
      sx = (sx / l) * w;
      sy = (sy / l) * w;
      sz = (sz / l) * w;
      for (let side = 0; side < 2; side += 1) {
        const sign = side === 0 ? -1 : 1;
        const v = base + j * 2 + side;
        positions[v * 3] = (px + sign * sx) * k;
        positions[v * 3 + 1] = (py + sign * sy) * k;
        positions[v * 3 + 2] = (pz + sign * sz) * k;
        colours[v * 3] = (colour[0] ?? 1) * light;
        colours[v * 3 + 1] = (colour[1] ?? 1) * light;
        colours[v * 3 + 2] = (colour[2] ?? 1) * light;
        along[v * 2] = u;
        along[v * 2 + 1] = sign;
      }
    }
  };
  const clear = (slot: number): void => {
    colours.fill(0, slot * perRibbon * 3, (slot + 1) * perRibbon * 3);
  };
  const toward = km();
  const bend = km();
  const velocity = km();
  const head = km();

  return {
    object,
    get shown() {
      return shown;
    },
    get tails() {
      return tails;
    },
    update(frame) {
      shown = 0;
      order.length = 0;
      // The comets move on only when the clock has (by more than MOVED_DAYS: at real time, every minute and a half).
      const moved = !(Math.abs(frame.jd - placedAt) <= MOVED_DAYS);
      if (moved) placedAt = frame.jd;
      rows.forEach((row, i) => {
        const dot = dotList[i];
        const p = placedHeads[i];
        if (!dot || !p) return;
        const el = elements[i];
        if (!el) return;
        if (moved) {
          heliocentric(el, frame.jd, helio);
          ecl.x = (helio[0] ?? 0) * auKm;
          ecl.y = (helio[1] ?? 0) * auKm;
          ecl.z = (helio[2] ?? 0) * auKm;
          eclipticToRender(ecl, p);
          r[i] = Math.hypot(p.x, p.y, p.z) / auKm;
        }
        const sunAu = r[i] ?? 0;
        dot.opacity = 0;
        if (sunAu > SHOWN_AU || frame.fade <= 1e-3) return;
        const rx = p.x - frame.camera.x;
        const ry = p.y - frame.camera.y;
        const rz = p.z - frame.camera.z;
        const d = Math.hypot(rx, ry, rz);
        const k = scaledFactor(d, 0, frame.far);
        dot.position.x = rx * k;
        dot.position.y = ry * k;
        dot.position.z = rz * k;
        const m = cometMagnitude(row[7], row[8], sunAu, Math.max(d / auKm, 1e-6));
        const seen = COMA.light * 10 ** (-0.4 * COMA.power * (m - COMA.mag));
        seenLight[i] = seen;
        const light = Math.min(2.5, Math.max(seen, COMA.marked * frame.marked * Math.min(1, 2 / sunAu)));
        dot.color = [COMA.colour[0] * light, COMA.colour[1] * light, COMA.colour[2] * light];
        dot.opacity = frame.fade;
        dot.sizePx = Math.min(COMA.maxPx, COMA.minPx + 6 * Math.max(0, Math.log10(1 + light * 4)));
        shown += 1;
        if (sunAu < TAIL_AU) order.push(i);
      });
      heads.update(dotList, frame.compensation);

      // Tails for the most active: nearest the Sun, brighter M1 first.
      const focused = frame.focus === null ? -1 : rows.findIndex((row) => row[0] === frame.focus);
      order.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : (r[a] ?? 0) - (r[b] ?? 0) + ((rows[a]?.[7] ?? 0) - (rows[b]?.[7] ?? 0)) * 0.05));
      tails = 0;
      for (let slot = 0; slot < MAX_TAILS; slot += 1) {
        const i = order[slot];
        const row = i === undefined ? undefined : rows[i];
        const el = i === undefined ? undefined : elements[i];
        const p = i === undefined ? undefined : placedHeads[i];
        if (i === undefined || !row || !el || !p) {
          clear(slot * 2);
          clear(slot * 2 + 1);
          continue;
        }
        const sunAu = r[i] ?? 1;
        const activity = Math.min(1, Math.max(0, (TAIL_AU - sunAu) / (TAIL_AU - 1))) ** 1.5;
        const size = Math.min(2.5, Math.max(0.4, 10 ** (-TAILS.perMag * (row[7] - 10))));
        // Away from the Sun, and the motion along the orbit (a day either side) for the dust's lag.
        const d = Math.hypot(p.x, p.y, p.z) || 1;
        toward.x = p.x / d;
        toward.y = p.y / d;
        toward.z = p.z / d;
        heliocentric(el, frame.jd - 1, before);
        heliocentric(el, frame.jd + 1, after);
        ecl.x = (after[0] ?? 0) - (before[0] ?? 0);
        ecl.y = (after[1] ?? 0) - (before[1] ?? 0);
        ecl.z = (after[2] ?? 0) - (before[2] ?? 0);
        eclipticToRender(ecl, velocity);
        const along = velocity.x * toward.x + velocity.y * toward.y + velocity.z * toward.z;
        bend.x = velocity.x - along * toward.x;
        bend.y = velocity.y - along * toward.y;
        bend.z = velocity.z - along * toward.z;
        const bl = Math.hypot(bend.x, bend.y, bend.z) || 1;
        bend.x = (-bend.x / bl) * TAILS.bend;
        bend.y = (-bend.y / bl) * TAILS.bend;
        bend.z = (-bend.z / bl) * TAILS.bend;
        head.x = p.x - frame.camera.x;
        head.y = p.y - frame.camera.y;
        head.z = p.z - frame.camera.z;
        const k = scaledFactor(Math.hypot(head.x, head.y, head.z), 0, frame.far);
        // As bright as the comet is (its coma's light as seen), or marked in wide views.
        const light = TAILS.light * activity * frame.fade * Math.min(1, Math.max(i === focused ? 1 : frame.marked, (seenLight[i] ?? 0) * 4));
        if (light < TAILS.visible) {
          clear(slot * 2);
          clear(slot * 2 + 1);
          continue;
        }
        ribbon(slot * 2, head, toward, STRAIGHT, TAILS.ionKm * activity * size, TAILS.ionWidth, TAILS.ion, light * 0.8, k);
        ribbon(slot * 2 + 1, head, toward, bend, TAILS.dustKm * activity * size, TAILS.dustWidth, TAILS.dust, light, k);
        tails += 1;
      }
      positionAttr.needsUpdate = true;
      colourAttr.needsUpdate = true;
      alongAttr.needsUpdate = true;
      uCompensation.value = Math.max(frame.compensation, 1e-6);
      mesh.visible = tails > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      heads.dispose();
    },
  };
}
