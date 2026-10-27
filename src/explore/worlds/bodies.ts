/**
 * The worlds the explorer can fly to beyond its ten bodies (public/assets/smallbodies/worlds.json):
 * the major moons of Mars, Jupiter, Saturn, Uranus, Neptune and Pluto, the dwarf planets, and notable
 * asteroids and comets, each where its orbit puts it on the date (./orbits), at its measured size and
 * shape (an ellipsoid of its published axes), turned as it spins, and lit by the Sun.
 *
 * Positions are float64 km in the render frame, as the ten bodies' are: a moon from its planet's
 * place (Pluto's moons about the Pluto-Charon barycentre, which the Small-Body Database's orbit of
 * Pluto follows, each body offset from it by the other's share of their GM), the rest from the Sun.
 * Moons that keep one face to their planet turn so it faces them; the others spin about their
 * published poles at their periods (spin phase illustrative where none is published; about the
 * ecliptic's pole where no pole is known).
 *
 * A world is drawn as a lit ellipsoid once its disc spans more than about a pixel (a pool of meshes
 * goes to the largest on screen), and as a point of light below that (../bodies/impostor), as the ten
 * bodies are. The surfaces are plain: a world's geometric albedo in a neutral colour, Lommel-Seeliger's
 * law with a little Lambert, as rocky and icy surfaces scatter (the readout says the surface is not a
 * map: UniverseIllustration 'world-shape'). A moon in its planet's shadow darkens by the share of the
 * Sun's disc the planet covers from its centre (../bodies/glare visibleShare).
 */

import { DataTexture, FrontSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, RepeatWrapping, SphereGeometry, SRGBColorSpace, Vector3, type PerspectiveCamera, type Texture } from 'three/webgpu';
import { acos, asin, atan, clamp, dot, exp, fract, fwidth, max, mix, normalize, positionLocal, select, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { BodyId, FocusId, WorldId, WorldKind } from '../../core/types';
import { visibleShare } from '../bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from '../bodies/impostor';
import { litCosine, sunlit } from '../bodies/shading';
import type { NavBody } from '../navigation';
import { placeScaled } from '../space/scaled-space';
import { eclipticToRender, km, type Km } from '../space/origin';
import type { SolarSystem } from '../system';
import type { FloatNode } from '../render/sampling';
import { DEG, hgMagnitude, heliocentric, moonOffset, type WorldElements } from './orbits';

export interface WorldRecord {
  id: WorldId;
  name: string;
  designation: string;
  kind: WorldKind;
  /** The body it goes round: 'sun', a planet, or another world (Pluto, for its moons). */
  host: 'sun' | BodyId | WorldId;
  elements: WorldElements;
  H?: number | null;
  G?: number | null;
  M1?: number | null;
  K1?: number | null;
  radiusKm: number | null;
  axesKm?: number[] | null;
  albedo?: number | null;
  rotationHours?: number | null;
  pole?: [number, number] | null;
  gm?: number;
  synchronous?: boolean;
  sizeFromH?: boolean;
  sizeRef?: string;
  /** The IAU's rotation model: pole (ICRF, degrees) and prime meridian W = w0 + degPerDay x days since J2000. */
  spin?: { ra: number; dec: number; w0: number; degPerDay: number } | null;
}

/** A world's surface map (maps.json): its file, and its mean linear brightness (the albedo sets the level). */
export interface WorldMap {
  file: string;
  colour: boolean;
  mean: number;
  credit: string;
}

/** Each world as placed this frame. */
export interface PlacedWorld {
  readonly record: WorldRecord;
  /** Render frame, km from the Sun (float64). */
  readonly position: Km;
  readonly rel: Km;
  readonly drawn: Km;
  distance: number;
  k: number;
  radiusPx: number;
  screenX: number;
  screenY: number;
  inView: boolean;
  /** Sunlight at it (1 at 1 au), and the share of the Sun's disc its host leaves it (an eclipse). */
  light: number;
  share: number;
  /** Its semi-axes (km: along its prime meridian, its pole, and the third) and its largest. */
  readonly axes: readonly [number, number, number];
  readonly radiusKm: number;
  /** Its pole (unit, render frame) and mesh basis (columns: local x, y = pole, z), kept current. */
  readonly pole: Km;
  readonly basis: number[];
  readonly nav: NavBody;
}

export interface WorldsBodiesFrame {
  camera: Km;
  view: PerspectiveCamera;
  far: number;
  pxPerTan: number;
  widthPx: number;
  heightPx: number;
  compensation: number;
  /** Small bodies shown (dwarf planets, asteroids, comets: not the moons), and how far the marked light is in. */
  layer: number;
  marked: number;
  /** Everything shown at all (not in an experiment, on foot, on the way down). */
  shown: boolean;
  focus: FocusId;
}

export interface WorldBodies {
  readonly object: Group;
  readonly list: readonly PlacedWorld[];
  byId(id: WorldId): PlacedWorld | undefined;
  /** Moves every world to the date (TDB Julian date): after the ten bodies, before the camera. */
  advance(jd: number): void;
  update(frame: WorldsBodiesFrame): void;
  /** The worlds that cover more than a pixel this frame, drawn as meshes, and how many of them show a map. */
  readonly meshed: number;
  readonly mapped: number;
  dispose(): void;
}

/** Meshes in the pool, and the disc (px) above which a world is drawn as one. Below it, a point. */
const POOL = 10;
const MESH_FROM_PX = 0.8;
/** Points: as the asteroids' (./belt): the sky's magnitude mapping as seen, and a marked light in wide views. */
const DOT = { mag: 6.5, light: 0.05, power: 0.45, marked: 0.5, sizePx: 6, ceiling: 2.5 } as const;
/** The surface's law: Lommel-Seeliger with this share of Lambert, and a gentle darkening with phase (per radian). Illustrative shapes. */
const LAW = { lambert: 0.3, phaseDarkening: 0.5 } as const;
/** The geometric albedo assumed where none is published, by kind. */
const ALBEDO: Readonly<Record<WorldKind, number>> = { moon: 0.3, dwarf: 0.5, asteroid: 0.15, comet: 0.04 };
/** A neutral surface, very slightly warm (sunlit rock and ice); comets' dark crust a touch warmer. */
const TINT: Readonly<Record<WorldKind, readonly [number, number, number]>> = { moon: [1, 0.97, 0.93], dwarf: [1, 0.95, 0.88], asteroid: [1, 0.94, 0.86], comet: [1, 0.9, 0.8] };
/** The ICRF's pole and equinox in the render frame are turned by the obliquity of J2000. */
const ECLIPTIC_POLE: [number, number] = [270, 90 - 23.4392911];

const lommel = (mu0: FloatNode, mu: FloatNode): FloatNode => mu0.mul(2).div(mu0.add(mu).add(1e-3));
/** The maps' mean linear brightness (scripts/smallbodies/maps.py MEAN). */
const MAP_MEAN = 0.4;
/** A map eases in once it has come, by this share a frame (about two thirds of a second at 60 frames a second: no change of light faster than half a second). */
const MAP_EASE = 0.025;

/** The prime meridian's direction (render frame) for an IAU rotation model: the pole at (ra, dec), W degrees on along the equator from its node on the ICRF's. */
function spinAxis(ra: number, dec: number, w: number, obliquity: number, out: Km): Km {
  // In the ICRF: Rz(ra + 90) Rx(90 - dec) Rz(w) applied to x.
  const a = (ra + 90) * DEG;
  const i = (90 - dec) * DEG;
  const ww = w * DEG;
  const x1 = Math.cos(ww);
  const y1 = Math.sin(ww);
  const y2 = y1 * Math.cos(i);
  const z2 = y1 * Math.sin(i);
  const x3 = x1 * Math.cos(a) - y2 * Math.sin(a);
  const y3 = x1 * Math.sin(a) + y2 * Math.cos(a);
  const ecl = km(x3, y3 * Math.cos(obliquity) + z2 * Math.sin(obliquity), -y3 * Math.sin(obliquity) + z2 * Math.cos(obliquity));
  return eclipticToRender(ecl, out);
}

/** A unit direction in the render frame from ICRF right ascension and declination (degrees). */
function icrfDirection(ra: number, dec: number, obliquity: number, out: Km): Km {
  const a = ra * DEG;
  const d = dec * DEG;
  const x = Math.cos(d) * Math.cos(a);
  const y = Math.cos(d) * Math.sin(a);
  const z = Math.sin(d);
  const ecl = km(x, y * Math.cos(obliquity) + z * Math.sin(obliquity), -y * Math.sin(obliquity) + z * Math.cos(obliquity));
  return eclipticToRender(ecl, out);
}

/** A one-texel grey stand-in for a world without a map (or one still on its way). */
const BLANK = (() => {
  const t = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

function makeMaterial(): { material: MeshBasicNodeMaterial; map: { value: Texture }; mapShare: { value: number }; uniforms: { sun: Vector3; eye: Vector3; axes: Vector3; albedo: Vector3; light: { value: number } } } {
  const uSun = uniform(new Vector3(1, 0, 0));
  const uEye = uniform(new Vector3(0, 0, 3));
  const uAxes = uniform(new Vector3(1, 1, 1));
  const uAlbedo = uniform(new Vector3(0.3, 0.3, 0.3));
  const uLight = uniform(1);
  // The ellipsoid's point and its normal (the gradient of x^2/a^2 + ...), in units of its largest axis.
  const point = positionLocal.mul(uAxes);
  const n = normalize(positionLocal.div(uAxes));
  const view = normalize(uEye.sub(point));
  const nDotL = dot(n, uSun);
  const mu0 = litCosine(nDotL);
  const mu = max(dot(n, view), 0);
  const phase = acos(clamp(dot(uSun, view), -1, 1));
  const law = mix(lommel(mu0, mu), mu0.mul(2), LAW.lambert).mul(exp(phase.mul(-LAW.phaseDarkening))).mul(sunlit(nDotL));
  // The map, east longitude atan2(-z, x) from the prime meridian (local x), north up; of the two ways
  // of reading u (0..1, or offset half a turn) each pixel takes the one that does not jump at its seam,
  // so the mipmaps see no seam (Tarini 2012).
  const sphere = normalize(positionLocal);
  const u = atan(sphere.z.negate(), sphere.x).div(2 * Math.PI).add(0.5);
  const v = asin(clamp(sphere.y, -1, 1)).div(Math.PI).add(0.5);
  const u2 = fract(u.add(0.5)).sub(0.5);
  const uSeamless = select(fwidth(u).lessThanEqual(fwidth(u2).add(1e-6)), u, u2);
  const mapNode = texture(BLANK, vec2(uSeamless, v));
  const uMapShare = uniform(0);
  const surface = mix(vec3(1), mapNode.rgb.div(MAP_MEAN), uMapShare);
  const material = new MeshBasicNodeMaterial({ side: FrontSide, fog: false });
  material.colorNode = vec3(uAlbedo).mul(surface).mul(law).mul(uLight);
  material.positionNode = point;
  return { material, map: mapNode, mapShare: uMapShare, uniforms: { sun: uSun.value, eye: uEye.value, axes: uAxes.value, albedo: uAlbedo.value, light: uLight } };
}

export function createWorldBodies(records: readonly WorldRecord[], system: SolarSystem, obliquity: number, maps: Readonly<Record<string, WorldMap>> = {}, loadMap: (file: string) => Promise<Texture> = () => Promise.reject(new Error('no maps'))): WorldBodies {
  const object = new Group();
  object.name = 'explore-worlds';
  const auKm = system.auKm;
  const list: PlacedWorld[] = records.map((record) => {
    const r = record.radiusKm ?? 1;
    const ax = record.axesKm && record.axesKm.length === 3 ? record.axesKm : [r, r, r];
    // worlds.json gives the semi-axes largest first (along, across, polar for the shapes with three): x, z, y here.
    const axes: [number, number, number] = [ax[0] ?? r, ax[2] ?? r, ax[1] ?? r];
    const largest = Math.max(...axes);
    const position = km();
    const pole = km(0, 1, 0);
    const placed: PlacedWorld = {
      record,
      position,
      rel: km(),
      drawn: km(),
      distance: 0,
      k: 1,
      radiusPx: 0,
      screenX: 0,
      screenY: 0,
      inView: false,
      light: 1,
      share: 1,
      axes,
      radiusKm: largest,
      pole,
      basis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      nav: {
        id: record.id,
        radiusKm: largest,
        boundKm: largest,
        minAltitudeKm: Math.max(0.02 * largest, 0.003),
        fill: 0.6,
        view: { azimuth: 0.85, latitude: 0.12, litFace: false },
        position,
        pole,
      },
    };
    return placed;
  });
  const byName = new Map(list.map((w) => [w.record.id, w]));
  const order = [...list].sort((a, b) => (a.record.host === 'sun' ? 0 : 1) - (b.record.host === 'sun' ? 0 : 1));
  const gmOf = (id: WorldId): number => byName.get(id)?.record.gm ?? 0;

  // The pool of meshes, each with its own uniforms over one shared shape.
  const geometry = new SphereGeometry(1, 64, 32);
  const pool = Array.from({ length: POOL }, () => {
    const { material, map, mapShare, uniforms } = makeMaterial();
    const mesh = new Mesh(geometry, material);
    mesh.name = 'explore-world';
    mesh.visible = false;
    object.add(mesh);
    return { mesh, material, map, mapShare, uniforms, showing: '' };
  });
  // Maps load the first time their world is drawn as a mesh, and stay.
  const textures = new Map<string, Texture | 'loading' | 'failed'>();
  const mapFor = (name: string): Texture | null => {
    const entry = maps[name];
    if (!entry) return null;
    const got = textures.get(name);
    if (got === undefined) {
      textures.set(name, 'loading');
      loadMap(entry.file).then(
        (t) => {
          t.colorSpace = SRGBColorSpace;
          t.wrapS = RepeatWrapping;
          t.anisotropy = 8;
          t.needsUpdate = true;
          textures.set(name, t);
        },
        () => textures.set(name, 'failed'),
      );
      return null;
    }
    return typeof got === 'string' ? null : got;
  };
  let mapped = 0;
  const dots: Impostors = createImpostors(list.length);
  object.add(dots.object);
  const dotList: ImpostorDot[] = list.map(() => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: DOT.sizePx, marker: 0 }));

  const scratch = [0, 0, 0];
  const ecl = km();
  const offset = km();
  const toSun = km();
  const toHost = km();
  const projected = new Vector3();
  const basisMatrix = new Matrix4();
  const turn = new Quaternion();
  const local = new Vector3();
  const axis = new Vector3();
  const reference = km();
  let meshed = 0;

  /** Columns of the basis: x the prime meridian, y the pole, z = x cross y... as ../system's: z = -(body y). */
  const setBasis = (w: PlacedWorld, x: Km): void => {
    const p = w.pole;
    // x square to the pole, z completing a right-handed frame (x, y, z) with y the pole.
    const along = x.x * p.x + x.y * p.y + x.z * p.z;
    let mx = x.x - along * p.x;
    let my = x.y - along * p.y;
    let mz = x.z - along * p.z;
    const l = Math.hypot(mx, my, mz) || 1;
    mx /= l;
    my /= l;
    mz /= l;
    const b = w.basis;
    b[0] = mx;
    b[1] = my;
    b[2] = mz;
    b[3] = p.x;
    b[4] = p.y;
    b[5] = p.z;
    b[6] = my * p.z - mz * p.y;
    b[7] = mz * p.x - mx * p.z;
    b[8] = mx * p.y - my * p.x;
  };

  return {
    object,
    list,
    byId: (id) => byName.get(id),
    get meshed() {
      return meshed;
    },
    get mapped() {
      return mapped;
    },
    advance(jd) {
      for (const w of order) {
        const r = w.record;
        const el = r.elements;
        if (r.host === 'sun') {
          heliocentric(el, jd, scratch);
          ecl.x = (scratch[0] ?? 0) * auKm;
          ecl.y = (scratch[1] ?? 0) * auKm;
          ecl.z = (scratch[2] ?? 0) * auKm;
          eclipticToRender(ecl, w.position);
        } else {
          moonOffset(el, jd, obliquity, scratch);
          ecl.x = scratch[0] ?? 0;
          ecl.y = scratch[1] ?? 0;
          ecl.z = scratch[2] ?? 0;
          eclipticToRender(ecl, offset);
          const host = r.host.startsWith('w:') ? byName.get(r.host as WorldId)?.position : system.bodies[r.host as BodyId].position;
          if (!host) continue;
          // Pluto's moons go about the barycentre the Sun's orbit of Pluto follows: Pluto sits off it by Charon's share.
          w.position.x = host.x + offset.x;
          w.position.y = host.y + offset.y;
          w.position.z = host.z + offset.z;
        }
        // The pole: a moon's is its orbit's (it keeps one face to its planet); else the published one, or the ecliptic's.
        if (r.synchronous && r.host !== 'sun') {
          const p = r.elements.pole ?? ECLIPTIC_POLE;
          icrfDirection(p[0], p[1], obliquity, w.pole);
        } else {
          const p = r.pole ?? ECLIPTIC_POLE;
          icrfDirection(p[0], p[1], obliquity, w.pole);
        }
      }
      // Pluto and Charon about their barycentre: the orbit given is the barycentre's.
      const pluto = byName.get('w:Pluto');
      const charon = byName.get('w:Charon');
      const gmPluto = pluto?.record.gm ?? 0;
      const gmCharon = gmOf('w:Charon');
      if (pluto && charon && gmPluto > 0 && gmCharon > 0) {
        const share = gmCharon / (gmPluto + gmCharon);
        const dx = charon.position.x - pluto.position.x;
        const dy = charon.position.y - pluto.position.y;
        const dz = charon.position.z - pluto.position.z;
        pluto.position.x -= share * dx;
        pluto.position.y -= share * dy;
        pluto.position.z -= share * dz;
        for (const w of list) {
          if (w.record.host !== 'w:Pluto') continue;
          w.position.x -= share * dx;
          w.position.y -= share * dy;
          w.position.z -= share * dz;
        }
      }
      // Each world's turn: facing its planet (the moons that keep one face to it), or spinning at its period.
      for (const w of list) {
        const r = w.record;
        const host = r.host === 'sun' ? null : r.host.startsWith('w:') ? byName.get(r.host as WorldId)?.position : system.bodies[r.host as BodyId].position;
        if (r.spin) {
          // The IAU's prime meridian: W along the equator from the equator's node on the ICRF's.
          const s = r.spin;
          spinAxis(s.ra, s.dec, s.w0 + s.degPerDay * (jd - 2451545), obliquity, reference);
          setBasis(w, reference);
        } else if (r.synchronous && host) {
          toHost.x = host.x - w.position.x;
          toHost.y = host.y - w.position.y;
          toHost.z = host.z - w.position.z;
          setBasis(w, toHost);
        } else {
          // Spin phase from J2000 at the published period (its zero illustrative).
          const hours = r.rotationHours ?? 24;
          const angle = (((jd - 2451545) * 24) / hours) * 2 * Math.PI;
          // A reference square to the pole (the ecliptic's x, or z near the poles), turned by the phase.
          const near = Math.abs(w.pole.x) > 0.9;
          local.set(near ? 0 : 1, 0, near ? 1 : 0).applyQuaternion(turn.setFromAxisAngle(axis.set(w.pole.x, w.pole.y, w.pole.z), angle));
          reference.x = local.x;
          reference.y = local.y;
          reference.z = local.z;
          setBasis(w, reference);
        }
        // Sunlight and its planet's shadow: the share of the Sun's disc the host leaves it.
        const d = Math.hypot(w.position.x, w.position.y, w.position.z);
        w.light = (auKm / Math.max(d, 1)) ** 2;
        w.share = 1;
        if (host && !r.host.startsWith('w:')) {
          const hostRadius = system.specs[r.host as BodyId].radiusKm;
          toSun.x = -w.position.x / d;
          toSun.y = -w.position.y / d;
          toSun.z = -w.position.z / d;
          toHost.x = host.x - w.position.x;
          toHost.y = host.y - w.position.y;
          toHost.z = host.z - w.position.z;
          const hd = Math.hypot(toHost.x, toHost.y, toHost.z);
          const cos = (toSun.x * toHost.x + toSun.y * toHost.y + toSun.z * toHost.z) / Math.max(hd, 1e-9);
          w.share = visibleShare(Math.asin(Math.min(1, system.specs.sun.radiusKm / d)), Math.asin(Math.min(1, hostRadius / hd)), Math.acos(Math.min(1, Math.max(-1, cos))));
        }
      }
    },
    update(frame) {
      // Place each relative to the camera and in scaled space; measure its disc on screen.
      for (const w of list) {
        w.rel.x = w.position.x - frame.camera.x;
        w.rel.y = w.position.y - frame.camera.y;
        w.rel.z = w.position.z - frame.camera.z;
        w.distance = Math.hypot(w.rel.x, w.rel.y, w.rel.z);
        w.k = placeScaled(w.rel, w.radiusKm, frame.far, w.drawn);
        w.radiusPx = frame.pxPerTan * Math.tan(Math.asin(Math.min(1, w.radiusKm / Math.max(w.distance, w.radiusKm))));
        projected.set(w.drawn.x, w.drawn.y, w.drawn.z).project(frame.view);
        w.inView = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1;
        w.screenX = ((projected.x + 1) / 2) * frame.widthPx;
        w.screenY = ((1 - projected.y) / 2) * frame.heightPx;
      }
      // The largest on screen get the meshes (the focus first).
      const big = list.filter((w) => frame.shown && w.inView && w.radiusPx > MESH_FROM_PX && (w.record.kind === 'moon' || frame.layer > 0 || w.record.id === frame.focus)).sort((a, b) => (a.record.id === frame.focus ? -1 : b.record.id === frame.focus ? 1 : b.radiusPx - a.radiusPx));
      meshed = Math.min(POOL, big.length);
      mapped = 0;
      pool.forEach((slot, i) => {
        const w = big[i];
        slot.mesh.visible = w !== undefined;
        if (!w) return;
        const r = w.record;
        // Its map, easing in once it has come (a slot taking another world starts plain).
        const map = mapFor(r.name);
        if (slot.showing !== r.name) {
          slot.showing = r.name;
          slot.mapShare.value = 0;
        }
        if (map) {
          if (slot.map.value !== map) slot.map.value = map;
          slot.mapShare.value = Math.min(1, slot.mapShare.value + MAP_EASE);
          mapped += 1;
        } else {
          slot.map.value = BLANK;
          slot.mapShare.value = 0;
        }
        slot.mesh.position.set(w.drawn.x, w.drawn.y, w.drawn.z);
        slot.mesh.scale.setScalar(w.radiusKm * w.k);
        const b = w.basis;
        basisMatrix.set(b[0] ?? 1, b[3] ?? 0, b[6] ?? 0, 0, b[1] ?? 0, b[4] ?? 1, b[7] ?? 0, 0, b[2] ?? 0, b[5] ?? 0, b[8] ?? 1, 0, 0, 0, 0, 1);
        slot.mesh.quaternion.setFromRotationMatrix(basisMatrix);
        slot.mesh.updateMatrixWorld();
        const u = slot.uniforms;
        u.axes.set(w.axes[0] / w.radiusKm, w.axes[1] / w.radiusKm, w.axes[2] / w.radiusKm);
        const albedo = r.albedo ?? ALBEDO[r.kind];
        const tint = TINT[r.kind];
        u.albedo.set(albedo * tint[0], albedo * tint[1], albedo * tint[2]);
        u.light.value = w.light * w.share * Math.min(1, smooth(MESH_FROM_PX, MESH_FROM_PX * 2, w.radiusPx));
        // The Sun and the eye in the world's own frame (the mesh's local axes).
        const d = Math.max(Math.hypot(w.position.x, w.position.y, w.position.z), 1);
        const sx = -w.position.x / d;
        const sy = -w.position.y / d;
        const sz = -w.position.z / d;
        u.sun.set(sx * (b[0] ?? 0) + sy * (b[1] ?? 0) + sz * (b[2] ?? 0), sx * (b[3] ?? 0) + sy * (b[4] ?? 0) + sz * (b[5] ?? 0), sx * (b[6] ?? 0) + sy * (b[7] ?? 0) + sz * (b[8] ?? 0));
        const ex = -w.rel.x / w.radiusKm;
        const ey = -w.rel.y / w.radiusKm;
        const ez = -w.rel.z / w.radiusKm;
        u.eye.set(ex * (b[0] ?? 0) + ey * (b[1] ?? 0) + ez * (b[2] ?? 0), ex * (b[3] ?? 0) + ey * (b[4] ?? 0) + ez * (b[5] ?? 0), ex * (b[6] ?? 0) + ey * (b[7] ?? 0) + ez * (b[8] ?? 0));
      });
      // Points of light for the rest (and fading out as a world's mesh comes in).
      list.forEach((w, i) => {
        const dot = dotList[i];
        if (!dot) return;
        const r = w.record;
        const moon = r.kind === 'moon';
        const want = frame.shown && w.inView ? (moon ? 1 : Math.max(frame.layer, r.id === frame.focus ? 1 : 0)) : 0;
        const toward = Math.max(0, Math.min(0.99, 1 - (1.03 * w.radiusKm * w.k) / Math.max(Math.hypot(w.drawn.x, w.drawn.y, w.drawn.z), 1e-9)));
        dot.position.x = w.drawn.x * toward;
        dot.position.y = w.drawn.y * toward;
        dot.position.z = w.drawn.z * toward;
        const albedo = r.albedo ?? ALBEDO[r.kind];
        const h = r.H ?? 5 * Math.log10(1329 / (2 * w.radiusKm * Math.sqrt(albedo)));
        const sunAu = Math.hypot(w.position.x, w.position.y, w.position.z) / auKm;
        const camAu = Math.max(w.distance / auKm, 1e-9);
        // The phase angle: between the Sun and the camera, seen from the world.
        const cos = (w.position.x * w.rel.x + w.position.y * w.rel.y + w.position.z * w.rel.z) / Math.max(1e-9, sunAu * auKm * w.distance);
        const v = hgMagnitude(h, r.G ?? 0.15, sunAu, camAu, Math.acos(Math.min(1, Math.max(-1, cos))));
        const seen = DOT.light * 10 ** (-0.4 * DOT.power * (v - DOT.mag));
        const light = Math.min(DOT.ceiling, Math.max(seen, (moon ? 0.5 : 1) * DOT.marked * frame.marked)) * w.share;
        const tint = TINT[r.kind];
        dot.color = [tint[0] * light, tint[1] * light, tint[2] * light];
        dot.opacity = want * smooth(MESH_FROM_PX * 2.5, MESH_FROM_PX, w.radiusPx);
        dot.sizePx = DOT.sizePx;
        dot.marker = 0;
      });
      dots.update(dotList, frame.compensation);
    },
    dispose() {
      geometry.dispose();
      for (const slot of pool) slot.material.dispose();
      dots.dispose();
    },
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export type { WorldElements };
