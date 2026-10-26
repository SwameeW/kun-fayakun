import { AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, LineBasicNodeMaterial, LineSegments, Matrix3, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, SphereGeometry, Sprite, Vector3, PointsNodeMaterial, type Node, type Object3D } from 'three/webgpu';
import { cameraPosition, dot, exp, float, Fn, instancedBufferAttribute, max, normalize, positionWorld, uniform, uv, vec3, vec4 } from 'three/tsl';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { SceneLabel, UniverseNeighbourhood } from '../../core/types';
import { bvKelvin, skyDirection } from '../sky';
import { createBeyond, galacticAxes, type Beyond, type BeyondPlace, type LocalGalaxy, type LocalGroupFile, type WebManifest } from './beyond';
import { KM_PER_PC, LY_PER_PC, readNeighbours, type Neighbours, type NeighbourhoodFile, type Star, type SunFigures } from './data';

/**
 * The stars around the Sun (ledger IS-2 to IS-4, IS-7; its own chunk, docs/NEIGHBOURHOOD.md): every
 * star within 25 parsecs and the bright stars beyond, each where its Hipparcos parallax puts it, as
 * bright and in the colour it would look from wherever the camera is (its absolute magnitude moved to
 * the camera's distance from it); the Sun among them; the known planets about the stars that have
 * them (the NASA Exoplanet Archive's), drawn round their star when the camera comes close; a faint
 * band along the galaxy's plane for bearings (illustrative). Stars whose distance is not known to a
 * fifth stay directions on the sky, as bright as from the Sun.
 *
 * The camera orbits the star in view (a drag turns it, the wheel moves in or out, from a hundredth of
 * an au to ten billion parsecs); choosing another star flies there, along the line between them, rising to see both and
 * coming down again; a pick on the screen chooses the nearest star to the pointer. Farther out, ./beyond
 * draws the Milky Way as a model, the Local Group's galaxies and the survey's (ledger IS-6), and the
 * camera can fly to places there too. Everything is drawn camera-relative, in parsecs, from
 * double-precision places.
 */

type V3 = [number, number, number];

export interface Neighbourhood {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  readonly travelling: boolean;
  readonly data: Neighbours;
  /** Starts round the Sun, from `distancePc`. */
  enter(distancePc: number): void;
  exit(): void;
  drag(dxPx: number, dyPx: number): void;
  zoom(dLn: number): void;
  /** Flies to a star (the Sun included). */
  goTo(star: Star): void;
  /** Flies to a place beyond the stars (./beyond's), or a galaxy of the Local Group by its catalogue name. */
  goToPlace(id: BeyondPlace['id'] | `galaxy:${string}`): void;
  /** Finds stars by a name or catalogue number, for the view's results. */
  search(text: string): void;
  stop(): void;
  /** The star nearest a point on the screen (CSS px), within a few pixels of its drawn point, or null. */
  pick(xPx: number, yPx: number, widthPx: number, heightPx: number): Star | null;
  /** Steps the camera and places everything about it (`focalPx`: the screen's height in device pixels over twice the tangent of half the field of view); the camera's gaze and up (render frame) and depth range (parsecs). */
  update(dt: number, days: number, camera: PerspectiveCamera, focalPx?: number): { forward: V3; up: V3; near: number; far: number };
  labels(out: SceneLabel[]): void;
  view(): UniverseNeighbourhood | null;
  dispose(): void;
}

/** Magnitude to light and size, as the explorer's sky maps them (V = 6.5 faint; brighter grows), capped for the nearest stars. */
const SPRITE = { faintMag: 6.5, faintLight: 0.05, fluxPower: 0.45, baseSize: 2, sizeFrom: 3.5, sizePerMag: 0.45, maxSize: 16, maxLight: 6 } as const;
/** The camera's reach (pc): from a hundredth of an au (the closest planets' orbits) to ten billion parsecs (the survey's farthest galaxies are under three: room to see it whole). */
const REACH = { minPc: 0.01 / 206_264.806, maxPc: 1e10 } as const;
/** Where the stars not placed in space are drawn (pc): a sphere standing for the sky, past everything near. */
const SKY_PC = 4000;
/** Planets are drawn round a star the camera is nearer than this (pc), their orbits in au. */
const SYSTEM_PC = 0.01;
/** Radians per CSS pixel dragged. */
const DRAG = 0.005;
const AU_PER_PC = 206_264.806;

/** An angle folded into (-pi, pi]. */
const wrapPi = (a: number): number => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

const smootherstep = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** What lies beyond the stars (./beyond): the Local Group's file, the survey's loader, and the detail. */
export interface BeyondInputs {
  localGroup: LocalGroupFile;
  loadWeb: () => Promise<{ manifest: WebManifest; data: ArrayBuffer }>;
  detail: 'full' | 'basic';
}

export function createNeighbourhood(file: NeighbourhoodFile, obliquity: number, sunFigures: SunFigures, beyondInputs: BeyondInputs | null = null): Neighbourhood {
  const data = readNeighbours(file, obliquity, sunFigures);
  const all: Star[] = [data.sun, ...data.stars];
  const count = all.length;
  let active = false;
  let focus: Star = data.sun;
  let distance = 3;
  let azimuth = 0.6;
  let elevation = 0.35;
  let trip: { from: V3; to: Star; fromLn: number; toLn: number; lift: number; t: number; seconds: number; turn: { az0: number; el0: number; az1: number; el1: number } | null } | null = null;
  /** The place beyond the stars in view (with `focus` its stand-in), or null for a star. */
  let place: BeyondPlace | null = null;
  const camera: V3 = [0, 0, 0];
  const centre: V3 = [0, 0, 0];

  // Stars: one sprite each, camera-relative, their light and size set each frame from the camera's distance.
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tint = all.map((s) => blackbodyRgb(s.bv === null ? 6000 : bvKelvin(s.bv)));
  const positionAttr = new InstancedBufferAttribute(positions, 3);
  const colourAttr = new InstancedBufferAttribute(colours, 3);
  const sizeAttr = new InstancedBufferAttribute(sizes, 1);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  material.positionNode = instancedBufferAttribute(positionAttr);
  material.sizeNode = instancedBufferAttribute(sizeAttr);
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  material.colorNode = (instancedBufferAttribute(colourAttr) as unknown as Node<'vec3'>).mul(exp(r2.mul(-6)).mul(max(float(1).sub(r2), 0)));
  material.opacityNode = float(1);
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const sprites = new Sprite(material);
  sprites.geometry = geometry;
  sprites.count = count;
  sprites.frustumCulled = false;
  sprites.name = 'explore-neighbourhood-stars';
  sprites.renderOrder = 1;

  // The galaxy's band (illustrative): brightest along its plane, more so toward its centre, on a sphere at infinity.
  const toGalactic = galacticMatrix(obliquity);
  const uGalaxy = uniform(new Matrix3().copy(toGalactic));
  const uBand = uniform(1);
  const bandMaterial = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false, fog: false });
  bandMaterial.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const g = uGalaxy.mul(d);
    const b = g.z.asin();
    const towardCentre = max(g.x, 0);
    const band = exp(b.mul(b).mul(-30)).mul(towardCentre.mul(towardCentre).mul(2).add(0.6));
    return vec4(vec3(0.07, 0.065, 0.06).mul(band).mul(uBand), 1);
  })();
  const band = new Mesh(new SphereGeometry(1, 64, 32), bandMaterial);
  band.frustumCulled = false;
  band.renderOrder = -3;
  band.name = 'explore-neighbourhood-galaxy';

  // A system's planets: orbits as lines and planets as points, round the star in view when near.
  const orbitMaterial = new LineBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  const uOrbit = uniform(new Vector3(0.35, 0.45, 0.6));
  orbitMaterial.colorNode = uOrbit;
  const orbitGeometry = new BufferGeometry();
  const orbitLines = new LineSegments(orbitGeometry, orbitMaterial);
  orbitLines.frustumCulled = false;
  orbitLines.name = 'explore-neighbourhood-orbits';
  const planetMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const PLANET_SLOTS = 12;
  const planetPos = new Float32Array(PLANET_SLOTS * 3);
  const planetPosAttr = new InstancedBufferAttribute(planetPos, 3);
  planetMaterial.positionNode = instancedBufferAttribute(planetPosAttr);
  planetMaterial.sizeNode = float(6);
  planetMaterial.colorNode = vec3(0.9, 0.85, 0.75).mul(exp(r2.mul(-4)).mul(max(float(1).sub(r2), 0)));
  planetMaterial.opacityNode = float(1);
  const planetSprites = new Sprite(planetMaterial);
  planetSprites.geometry = geometry;
  planetSprites.count = 0;
  planetSprites.frustumCulled = false;
  planetSprites.name = 'explore-neighbourhood-planets';
  const group = new Group();
  group.name = 'explore-neighbourhood';
  group.add(band, sprites, orbitLines, planetSprites);
  group.visible = false;
  const beyond: Beyond | null = beyondInputs
    ? createBeyond(beyondInputs.localGroup, obliquity, beyondInputs.loadWeb, beyondInputs.detail, (s) => {
        group.add(s);
      })
    : null;
  /** A stand-in star for a place beyond the stars, so the camera's orbit and flights treat it as one. */
  const standIn = (at: V3, name: string): Star => ({ index: -2, hip: null, hr: null, name, raDeg: 0, decDeg: 0, plxMas: Number.POSITIVE_INFINITY, ePlxMas: 0, vmag: Number.NaN, bv: null, spType: null, distPc: Math.hypot(...at), position: at, absoluteV: null, system: null });
  /** Flies to a star, arriving `toDistance` (pc) from it, turning to look from `toward` when given. */
  const fly = (star: Star, toDistance: number, toward: V3 | null): void => {
    const from: V3 = [...centre];
    const sep = Math.hypot(posOf(star)[0] - from[0], posOf(star)[1] - from[1], posOf(star)[2] - from[2]);
    if (sep < 1e-12 && Math.abs(Math.log(distance / toDistance)) < 1e-6 && !toward) return;
    const lift = Math.max(0, Math.log(sep / Math.max(distance, toDistance)));
    const turn = toward ? { az0: azimuth, el0: elevation, az1: azimuth + wrapPi(Math.atan2(toward[0], toward[2]) - azimuth), el1: Math.asin(Math.max(-0.999, Math.min(0.999, toward[1]))) } : null;
    trip = { from, to: star, fromLn: Math.log(distance), toLn: Math.log(toDistance), lift: lift * 0.6, t: 0, seconds: Math.min(8, 3 + 0.7 * Math.log1p(sep)), turn };
    focus = star;
  };
  /** This frame's planets (for the labels): name and camera-relative place. */
  let planetsDrawn: Array<{ name: string; at: V3 }> = [];
  let systemShownFor: string | null = null;
  let results: Star[] = [];
  let galaxyResults: LocalGalaxy[] = [];

  const posOf = (s: Star): V3 => s.position ?? [0, 0, 0];
  const dirOf = (az: number, el: number): V3 => [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];

  /** The orbits of a system, as line segments relative to its star (pc): each in the plane face-on to the Sun, tilted by its inclination where measured. */
  const buildOrbits = (s: Star): void => {
    const planets = s.system?.planets ?? [];
    const pts: number[] = [];
    const [n0, n1, n2] = normalised(posOf(s));
    // Axes in the plane of the sky seen from the Sun (u, v), with the line of sight n.
    const u = normalised(cross([n0, n1, n2], Math.abs(n1) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const v = cross([n0, n1, n2], u);
    for (const p of planets) {
      if (p.aAu === null) continue;
      const a = p.aAu / AU_PER_PC;
      const e = Math.min(0.95, p.eccentricity ?? 0);
      const inc = ((p.inclinationDeg ?? 0) * Math.PI) / 180;
      const steps = 96;
      for (let k = 0; k < steps; k += 1) {
        for (const kk of [k, k + 1]) {
          const E = (kk / steps) * 2 * Math.PI;
          const x = a * (Math.cos(E) - e);
          const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
          // Tilted about u by the inclination: y shares itself between v and the line of sight.
          pts.push(x * u[0] + y * (Math.cos(inc) * v[0] + Math.sin(inc) * n0), x * u[1] + y * (Math.cos(inc) * v[1] + Math.sin(inc) * n1), x * u[2] + y * (Math.cos(inc) * v[2] + Math.sin(inc) * n2));
        }
      }
    }
    orbitGeometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    orbitGeometry.computeBoundingSphere();
    systemShownFor = s.name;
  };

  const project = new Vector3();
  let lastCamera: PerspectiveCamera | null = null;

  return {
    objects: [group],
    get active() {
      return active;
    },
    get travelling() {
      return trip !== null;
    },
    data,
    enter(distancePc) {
      active = true;
      group.visible = true;
      focus = data.sun;
      place = null;
      distance = Math.max(REACH.minPc, Math.min(REACH.maxPc, distancePc));
      trip = null;
    },
    exit() {
      active = false;
      group.visible = false;
      trip = null;
    },
    drag(dx, dy) {
      azimuth -= dx * DRAG;
      elevation = Math.max(-1.45, Math.min(1.45, elevation + dy * DRAG));
    },
    zoom(dLn) {
      distance = Math.max(REACH.minPc, Math.min(REACH.maxPc, distance * Math.exp(dLn)));
    },
    goTo(star) {
      if (!star.position || star === focus) return;
      // Arrive close enough to see the star's planets when it has any (three times its widest orbit), else at a hundredth of a parsec.
      const widest = Math.max(0, ...(star.system?.planets.map((p) => p.aAu ?? 0) ?? []));
      place = null;
      fly(star, widest > 0 ? (3 * widest) / AU_PER_PC : 0.01, null);
    },
    goToPlace(id) {
      if (!beyond) return;
      let to: BeyondPlace | undefined;
      if (id.startsWith('galaxy:')) {
        const g = beyond.galaxies.find((x) => x.name === id.slice(7));
        const known = beyond.places.find((p) => p.galaxy === g);
        // Any other galaxy of the catalogue: arrived at ten times its half-light radius, three kiloparsecs at least.
        to = known ?? (g ? { id: 'local-group', position: g.position, arrivePc: Math.max(3000, 10 * (g.radiusKpc ?? 0.3) * 1000), from: null, galaxy: g } : undefined);
      } else to = beyond.places.find((p) => p.id === id);
      if (!to) return;
      place = to;
      fly(standIn(to.position, to.galaxy?.name ?? to.id), to.arrivePc, to.from);
    },
    search(text) {
      results = data.search(text);
      galaxyResults = beyond?.search(text) ?? [];
    },
    stop() {
      if (!trip) return;
      // Stopped where it is: the camera orbits the point it was looking at, at its distance there.
      trip = null;
    },
    pick(x, y, w, h) {
      if (!lastCamera) return null;
      let best: Star | null = null;
      let bestD = 14;
      for (let i = 0; i < count; i += 1) {
        const s = all[i];
        if (!s?.position || (sizes[i] ?? 0) < 2.2) continue;
        project.set(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0).project(lastCamera);
        if (project.z > 1 || project.z < -1) continue;
        const px = ((project.x + 1) / 2) * w;
        const py = ((1 - project.y) / 2) * h;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      return best;
    },
    update(dt, days, cam, focalPx = 800) {
      lastCamera = cam;
      // Where the camera looks (the star in view, or along a trip's line) and how far from it.
      const f = posOf(focus);
      if (trip) {
        trip.t += Math.min(dt, 0.1);
        const s = smootherstep(trip.t / trip.seconds);
        const to = posOf(trip.to);
        for (let k = 0; k < 3; k += 1) centre[k] = (trip.from[k] ?? 0) + ((to[k] ?? 0) - (trip.from[k] ?? 0)) * s;
        distance = Math.exp(trip.fromLn + (trip.toLn - trip.fromLn) * s + trip.lift * Math.sin(Math.PI * s));
        if (trip.turn) {
          azimuth = trip.turn.az0 + (trip.turn.az1 - trip.turn.az0) * s;
          elevation = trip.turn.el0 + (trip.turn.el1 - trip.turn.el0) * s;
        }
        if (trip.t >= trip.seconds) trip = null;
      } else {
        centre[0] = f[0];
        centre[1] = f[1];
        centre[2] = f[2];
      }
      const d = dirOf(azimuth, elevation);
      for (let k = 0; k < 3; k += 1) camera[k] = (centre[k] ?? 0) + (d[k] ?? 0) * distance;
      const fromSun = Math.hypot(camera[0], camera[1], camera[2]);
      // Out past the stars: the catalogue's stars and the band from within the galaxy give way to its model.
      const starsShown = beyond ? beyond.starsShown(fromSun) : 1;
      uBand.value = beyond ? beyond.bandShown(fromSun) : 1;
      beyond?.update(camera, fromSun, focalPx);
      sprites.visible = starsShown > 0.001;
      // Every star from here: its place relative to the camera, its light as its absolute magnitude moved to this distance.
      for (let i = 0; i < count; i += 1) {
        const s = all[i];
        if (!s) continue;
        let rx: number;
        let ry: number;
        let rz: number;
        let m: number;
        if (s.position) {
          rx = s.position[0] - camera[0];
          ry = s.position[1] - camera[1];
          rz = s.position[2] - camera[2];
          const r = Math.max(Math.hypot(rx, ry, rz), 1e-9);
          m = (s.absoluteV ?? s.vmag) + 5 * Math.log10(r / 10);
        } else {
          // Not placed: a direction, on a sphere past the stars near the Sun, as bright as from the Sun.
          const dir = [0, 0, 0];
          skyDirection(s.raDeg, s.decDeg, obliquity, dir);
          rx = (dir[0] ?? 0) * SKY_PC;
          ry = (dir[1] ?? 0) * SKY_PC;
          rz = (dir[2] ?? 0) * SKY_PC;
          m = s.vmag;
        }
        positions[i * 3] = rx;
        positions[i * 3 + 1] = ry;
        positions[i * 3 + 2] = rz;
        const light = starsShown * Math.min(SPRITE.maxLight, SPRITE.faintLight * 10 ** (-0.4 * (m - SPRITE.faintMag) * SPRITE.fluxPower));
        const t = tint[i] ?? [1, 1, 1];
        colours[i * 3] = t[0] * light;
        colours[i * 3 + 1] = t[1] * light;
        colours[i * 3 + 2] = t[2] * light;
        sizes[i] = Math.min(SPRITE.maxSize, SPRITE.baseSize + SPRITE.sizePerMag * Math.max(0, SPRITE.sizeFrom - m));
      }
      positionAttr.needsUpdate = true;
      colourAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      band.scale.setScalar(REACH.maxPc * 8);
      // The system round the star in view, when near: its orbits, and its planets where their periods put them (their phases illustrative).
      planetsDrawn = [];
      const system = !trip && distance < SYSTEM_PC ? focus.system : null;
      orbitLines.visible = system !== null;
      planetSprites.visible = system !== null;
      if (system) {
        if (systemShownFor !== focus.name) buildOrbits(focus);
        orbitLines.position.set(f[0] - camera[0], f[1] - camera[1], f[2] - camera[2]);
        const [n0, n1, n2] = normalised(f);
        const u = normalised(cross([n0, n1, n2], Math.abs(n1) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const v = cross([n0, n1, n2], u);
        let k = 0;
        for (const p of system.planets) {
          if (p.aAu === null || k >= PLANET_SLOTS) continue;
          const a = p.aAu / AU_PER_PC;
          const e = Math.min(0.95, p.eccentricity ?? 0);
          const inc = ((p.inclinationDeg ?? 0) * Math.PI) / 180;
          const M = p.periodDays ? (2 * Math.PI * (days / p.periodDays + k * 0.37)) % (2 * Math.PI) : k;
          let E = M;
          for (let it = 0; it < 6; it += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
          const x = a * (Math.cos(E) - e);
          const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
          const at: V3 = [
            f[0] - camera[0] + x * u[0] + y * (Math.cos(inc) * v[0] + Math.sin(inc) * n0),
            f[1] - camera[1] + x * u[1] + y * (Math.cos(inc) * v[1] + Math.sin(inc) * n1),
            f[2] - camera[2] + x * u[2] + y * (Math.cos(inc) * v[2] + Math.sin(inc) * n2),
          ];
          planetPos.set(at, k * 3);
          planetsDrawn.push({ name: p.name, at });
          k += 1;
        }
        planetSprites.count = k;
        planetPosAttr.needsUpdate = true;
      }
      const forward: V3 = [-d[0], -d[1], -d[2]];
      return { forward, up: [0, 1, 0], near: Math.max(distance * 1e-3, 1e-9), far: REACH.maxPc * 16 };
    },
    labels(out) {
      if (!active) return;
      const fromSun = Math.hypot(camera[0], camera[1], camera[2]);
      beyond?.labels(out, camera, fromSun);
      if (beyond && beyond.starsShown(fromSun) < 0.5) return;
      // The star in view, the Sun, and the brightest-looking named stars from here (at most a dozen).
      const ranked = all
        .map((s, i) => ({ s, i, size: sizes[i] ?? 0 }))
        .filter((x) => x.s.position && x.s.name && (x.s === focus || x.s === data.sun || x.size > 4.2))
        .sort((a, b) => (a.s === focus ? -1 : b.s === focus ? 1 : b.size - a.size))
        .slice(0, 12);
      for (const { s, i } of ranked)
        out.push({ id: `star-${String(s.hip ?? 'sun')}`, textKey: '', text: s.name ?? '', position: [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0], opacity: 1 });
      for (const p of planetsDrawn) out.push({ id: `planet-${p.name}`, textKey: '', text: p.name, position: [p.at[0], p.at[1], p.at[2]], opacity: 0.85 });
    },
    view() {
      if (!active) return null;
      const f = posOf(focus);
      const fromSunPc = Math.hypot(camera[0], camera[1], camera[2]);
      const s = focus;
      const g: LocalGalaxy | null = place?.galaxy ?? null;
      const kelvin = s.bv === null ? null : bvKelvin(s.bv);
      return {
        focus: {
          name: s.name,
          hip: s.hip,
          hr: s.hr,
          distPc: s === data.sun ? 0 : s.distPc,
          distLy: s === data.sun ? 0 : s.distPc === null ? null : s.distPc * LY_PER_PC,
          relativeError: s === data.sun || !Number.isFinite(s.plxMas) ? 0 : s.ePlxMas / s.plxMas,
          vmag: s === data.sun ? null : s.vmag,
          absoluteV: s.absoluteV,
          temperatureK: s.system?.teffK ?? kelvin,
          spType: s.system?.spType ?? s.spType,
          planets: (s.system?.planets ?? []).map((p) => ({ ...p })),
          host: s.system?.host ?? null,
          starsInSystem: s.system?.stars ?? 1,
        },
        cameraPc: distance,
        cameraKm: distance * KM_PER_PC,
        fromSunPc,
        fromSunLy: fromSunPc * LY_PER_PC,
        travelling: trip !== null,
        systemShown: !trip && distance < SYSTEM_PC && (s.system?.planets.length ?? 0) > 0,
        scale: beyond ? beyond.scale(fromSunPc) : 'stars',
        place: place
          ? {
              id: place.id,
              galaxy: g?.name ?? null,
              group: g?.group ?? null,
              type: g?.type ?? null,
              distKpc: Math.hypot(...place.position) / 1000,
              radiusKpc: g?.radiusKpc ?? null,
              diameterKpc: g?.diameterKpc ?? null,
              absV: g?.absV ?? null,
              absVDerived: g?.absVDerived ?? false,
              massMsun: g?.massMsun ?? null,
            }
          : null,
        webGalaxies: beyond?.webCount ?? 0,
        places: (beyond?.places ?? []).map((x) => ({ id: x.id, distKpc: Math.hypot(...x.position) / 1000 })),
        results: [
          ...galaxyResults.map((x) => ({ name: x.name, hip: null, distPc: x.distKpc * 1000, planets: 0, galaxy: x.name })),
          ...results.map((x) => ({ name: x.name ?? (x.hip ? `HIP ${String(x.hip)}` : ''), hip: x.hip, distPc: x === data.sun ? 0 : x.distPc, planets: x.system?.planets.length ?? 0, galaxy: null })),
        ],
        nearest: data
          .nearest(f, 9)
          .filter((x) => x !== s)
          .map((x) => ({ name: x.name ?? (x.hip ? `HIP ${String(x.hip)}` : ''), hip: x.hip, distPc: Math.hypot(posOf(x)[0] - f[0], posOf(x)[1] - f[1], posOf(x)[2] - f[2]), planets: x.system?.planets.length ?? 0 })),
      };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      band.geometry.dispose();
      bandMaterial.dispose();
      orbitGeometry.dispose();
      orbitMaterial.dispose();
      planetMaterial.dispose();
      beyond?.dispose();
    },
  };
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalised(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The rotation from the render frame to the galactic frame (x to the galaxy's centre, z to its north pole). */
function galacticMatrix(obliquity: number): Matrix3 {
  const { x, y, z } = galacticAxes(obliquity);
  // Rows: the galactic axes in the render frame.
  return new Matrix3().set(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]);
}
