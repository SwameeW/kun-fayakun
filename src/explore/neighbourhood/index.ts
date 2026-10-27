import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, LineBasicNodeMaterial, LineSegments, Matrix3, PointsNodeMaterial, Sprite, Vector3, type Object3D, type PerspectiveCamera, type Scene, type WebGPURenderer } from 'three/webgpu';
import { exp, float, instancedBufferAttribute, max, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import type { AssetLoader, SceneLabel, UniverseNeighbourhood, ViewInsets } from '../../core/types';
import { bvKelvin, type SkyFile } from '../sky';
import { setStarlight, spriteQuad, starlightUniforms } from '../starlight';
import { createBand, type Band } from './band';
import { createBeyond, galacticAxes, type Beyond, type BeyondPlace, type LocalGalaxy, type LocalGroupFile, type WebManifest } from './beyond';
import { bvOf, type CatalogueManifest, type PackReply, type PackRequest } from './catalogue';
import { KM_PER_PC, LY_PER_PC, readNeighbours, type Neighbours, type NeighbourhoodFile, type Star, type SunFigures } from './data';
import { farLayer, placedLayer, setCameraParts, type FarLayer, type PlacedLayer } from './field';
import { createFigures, type Figures } from './figures';
import { readBlackHoles, type BlackHole, type BlackHoleFile } from './holes';
import { placeLabels, type LabelCandidate } from './labels';
import { shadowAngle, shadowMicroArcsec } from './lens';
import type { LensView } from './lens-view';
import { cameraOf, createRig, drag as rigDrag, flyTo, forwardOf, length, pan as rigPan, reanchor, step as rigStep, stopTrip, sub, toggleMode as rigToggle, upOf, zoom as rigZoom, type Rig, type V3 } from './rig';
import { createDisc, estimatedRadius, SUN } from './surface';

/**
 * The stars around the Sun, and beyond (ledger IS-2 to IS-4, IS-6, IS-7; its own chunk,
 * docs/NEIGHBOURHOOD.md): every star of Hipparcos's new reduction where its parallax puts it (those
 * whose distance is known to a fifth; the rest, and Tycho-2's 2.4 million, as directions on the sky),
 * as bright and in the colour it would look from wherever the camera is, through the explorer's star
 * light (../starlight); the Sun among them; the known planets about the stars that have them (the
 * NASA Exoplanet Archive's), drawn round their star when the camera comes close; the star in view as a
 * disc of its size up close (./surface); the constellations' figures between their stars' places
 * (./figures); the Milky Way's glow from Tycho-2's star counts (./band); seven black holes, each drawn
 * by its light bending (./lens-view, its own chunk) with its cited mass and distance.
 *
 * The camera (./rig): free look on the way in, the Sun where it is in space, not pinned to the
 * middle of the view; orbit round a star once flown to; flight on the keys at a speed set by the
 * nearest star; the wheel toward the pointer, or to the star under it. Everything is drawn relative to
 * the camera from double-precision places. Farther out, ./beyond draws the Milky Way as a model, the
 * Local Group's galaxies and the survey's (ledger IS-6).
 */

export interface Neighbourhood {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  readonly travelling: boolean;
  readonly data: Neighbours;
  /** Starts round the Sun, from `distancePc`, free to look round. */
  enter(distancePc: number): void;
  exit(): void;
  /** A drag (CSS px): turns the camera, or goes round the star in orbit. */
  drag(dxPx: number, dyPx: number): void;
  /** A pan (CSS px): moves the camera across the view. */
  pan(dxPx: number, dyPx: number): void;
  /** The wheel or a pinch (natural-log units, positive away), at a point of the screen (client px) when it has one. */
  zoom(dLn: number, clientX?: number, clientY?: number): void;
  /** Keys held: W A S D, R F moves, Q E roll, Shift; the arrows and + and -. */
  keys(move: { x: number; y: number; z: number }, roll: number, boost: boolean): void;
  turn(azimuth: number, elevation: number, zoom: number): void;
  /** O: orbit the star in view, or look freely again. */
  toggleMode(): void;
  /** The pointer over the view (client px), for what is under it; a tap shows it too (false: not used). */
  hover(clientX: number, clientY: number): void;
  tap(clientX: number, clientY: number): boolean;
  /** Flies to a star (the Sun included), or to a black hole's stand-in from pick(). */
  goTo(star: Star): void;
  /** Flies to a place beyond the stars (./beyond's), a galaxy of the Local Group by its catalogue name, or a black hole ("bh:" and its id). */
  goToPlace(id: BeyondPlace['id'] | `galaxy:${string}` | `bh:${string}`): void;
  /** Finds stars, galaxies and black holes by a name or catalogue number, for the view's results. */
  search(text: string): void;
  /** Goes to the best match for a name (a tool's way in): false when nothing matches. */
  find(name: string): boolean;
  stop(): void;
  /** Star light, the camera's way of looking, the figures. */
  setStarlight(brightness: number, faintest: number): void;
  setMode(mode: 'look' | 'orbit'): void;
  setFigures(on: boolean): void;
  /** The detail's tier: how many stars, how fine the black holes' tracing. */
  setDetail(tier: 'ultra' | 'high' | 'medium' | 'low', starCount: number): void;
  /** The star (or black hole) nearest a point on the screen (CSS px), among those visibly drawn, or null. */
  pick(xPx: number, yPx: number, widthPx: number, heightPx: number): Star | null;
  /**
   * Steps the camera and places everything about it (`focalPx`: the screen's height in device pixels
   * over twice the tangent of half the field of view); the camera's gaze and up (render frame) and
   * depth range (parsecs). `insets`: what the interface covers (names keep clear of it).
   */
  update(dt: number, days: number, camera: PerspectiveCamera, focalPx?: number, insets?: ViewInsets): { forward: V3; up: V3; near: number; far: number };
  labels(out: SceneLabel[]): void;
  view(): UniverseNeighbourhood | null;
  dispose(): void;
}

/** The camera's reach (pc): a star's or a black hole's own minimum is nearer; ten billion parsecs out (the survey's farthest galaxies are under three: room to see it whole). */
const REACH = { minPc: 0.01 / 206_264.806, maxPc: 1e10 } as const;
/** Planets are drawn round a star the camera is nearer than this (pc), their orbits in au. */
const SYSTEM_PC = 0.01;
const AU_PER_PC = 206_264.806;
/** Arrivals: the Sun from 3 pc (as on the way in), a star at 30 of its radii, a black hole at 20 of its Schwarzschild radii (one with a disc at 55, to see the disc whole); the nearest a star or a hole lets the camera come (radii). */
const ARRIVE = { sunPc: 3, starRadii: 30, holeRs: 20, discRs: 55, starMin: 1.1, holeMin: 2 } as const;
/**
 * The directions on the sky (Tycho-2's, Hipparcos's unplaced) are the sky seen from near the Sun (most
 * of those stars lie within a few hundred parsecs): they fade out between these distances from it (pc),
 * as the Milky Way's model comes in.
 */
const FAR_FADE = [150, 3000] as const;
/** The sky's capture round a black hole: a face's focal length (px; 512 px a face, 90 degrees). */
const CAPTURE_FOCAL_PX = 256;
/** Names: at most this many, of stars brighter than this as seen from here (the star in view and the one under the pointer always). */
const NAMES = { max: 16, brighterThan: 3.2 } as const;
/** Picking: within this many CSS px (touch wider), each magnitude brighter than the faintest worth this many px. */
const PICK = { mousePx: 20, touchPx: 32, perMag: 2 } as const;
/** A black hole's lens is drawn within this many of its Schwarzschild radii (beyond, its bending is under a pixel). */
const LENS_RS = 1e7;
/** A star drawn as a disc once its radius is this many device pixels (fully at the second). */
const DISC_PX = [1.2, 4] as const;
/** How often (s) the nearest star is looked for afresh (it sets flight's speed). */
const NEAREST_EVERY = 0.2;

const smoothstepJs = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const searchKey = (text: string): string => text.toLowerCase().replace(/[\s'’.*-]/gu, '');

/** What lies beyond the stars (./beyond): the Local Group's file, the survey's loader, and the detail; and the explorer's context (assets, renderer, scene). */
export interface BeyondInputs {
  localGroup: LocalGroupFile;
  loadWeb: () => Promise<{ manifest: WebManifest; data: ArrayBuffer }>;
  detail: 'full' | 'basic';
  ctx?: { assets: AssetLoader; renderer: WebGPURenderer; scene: Scene; reducedMotion: boolean };
}

const tintBytes = (bv: number | null): number[] => blackbodyRgb(bv === null ? 6000 : bvKelvin(bv)).map((c) => Math.round(c * 255));

/** The 256 B-V codes' colours (blackbody, by Ballesteros's temperature), as bytes. */
function colourBytes(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let code = 0; code < 256; code += 1) lut.set(tintBytes(bvOf(code)), code * 3);
  return lut;
}

export function createNeighbourhood(file: NeighbourhoodFile, obliquity: number, sunFigures: SunFigures, beyondInputs: BeyondInputs | null = null): Neighbourhood {
  const data = readNeighbours(file, obliquity, sunFigures);
  const all: Star[] = [data.sun, ...data.stars];
  const ctx = beyondInputs?.ctx ?? null;
  let active = false;
  let focus: Star = data.sun;
  /** The place beyond the stars in view (with `focus` its stand-in), or null; the black hole in view, or null. */
  let place: BeyondPlace | null = null;
  let hole: BlackHole | null = null;
  const rig: Rig = createRig([0, 0, 0], [0, 0, ARRIVE.sunPc], REACH.minPc, REACH.maxPc);
  let camera: V3 = [0, 0, ARRIVE.sunPc];
  let figuresOn = true;
  let tier: 'ultra' | 'high' | 'medium' | 'low' = 'high';
  let starBudget = 2_600_000;

  // The neighbourhood's own stars (and the Sun first) on the GPU: places rounded to single precision,
  // which the CPU then uses as the stars' own, so a star's disc and its point never part.
  const slots = new Int32Array(all.length).fill(-1);
  const named: Star[] = [];
  all.forEach((s, i) => {
    if (!s.position) return;
    slots[i] = named.length;
    named.push(s);
  });
  const namedData = new Float32Array(named.length * 4);
  const namedColour = new Uint8Array(named.length * 4);
  named.forEach((s, k) => {
    const p = s.position ?? [0, 0, 0];
    namedData.set([p[0], p[1], p[2], s.absoluteV ?? 30], k * 4);
    namedColour.set([...tintBytes(s.bv), 255], k * 4);
  });
  const slotOf = (s: Star): number => (s.index >= -1 ? (slots[s.index + 1] ?? -1) : -1);
  /** A star's place as drawn (pc from the Sun): the single-precision one for the stars on the GPU. */
  const posOf = (s: Star): V3 => {
    const k = slotOf(s);
    if (k >= 0) return [namedData[k * 4] ?? 0, namedData[k * 4 + 1] ?? 0, namedData[k * 4 + 2] ?? 0];
    return s.position ?? [0, 0, 0];
  };
  const namedLayer = placedLayer(namedData, namedColour, 'explore-neighbourhood-stars');
  // The file's stars not placed (their distance not known well enough) as directions, as bright as from the Sun.
  const unplaced = all.filter((s) => !s.position && s.index >= 0);
  const unplacedDirs = new Uint16Array(unplaced.length * 2);
  const unplacedColour = new Uint8Array(unplaced.length * 4);
  unplaced.forEach((s, k) => {
    const a = (s.raDeg * Math.PI) / 180;
    const d = (s.decDeg * Math.PI) / 180;
    const v: V3 = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    const sum = Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
    let x = v[0] / sum;
    let y = v[1] / sum;
    if (v[2] < 0) [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
    unplacedDirs[k * 2] = Math.round(((x + 1) / 2) * 65535);
    unplacedDirs[k * 2 + 1] = Math.round(((y + 1) / 2) * 65535);
    unplacedColour.set([...tintBytes(s.bv), Math.max(0, Math.min(255, Math.round((s.vmag + 1.5) * 16)))], k * 4);
  });
  const fileFar = farLayer(unplacedDirs, unplacedColour, obliquity, 'explore-neighbourhood-unplaced');
  const group = new Group();
  group.name = 'explore-neighbourhood';
  group.add(fileFar.sprite, namedLayer.sprite);
  group.visible = false;

  // The deep catalogue: Hipparcos's other stars and Tycho-2's, streamed pack by pack (brightest first), decoded in a worker.
  let manifest: CatalogueManifest | null = null;
  let worker: Worker | null = null;
  const lut = colourBytes();
  const exclude = new Uint32Array(data.stars.filter((s) => s.hip !== null).map((s) => s.hip ?? 0));
  const asked = new Set<string>();
  let hipPlaced: { layer: PlacedLayer; stars: Float32Array; hips: Uint32Array } | null = null;
  const farLayers: Array<{ layer: FarLayer; count: number; file: string }> = [];
  let loaded = 0;
  const pending = new Map<number, string>();
  let nextId = 1;
  const received = (event: MessageEvent<PackReply>): void => {
    const reply = event.data;
    const name = pending.get(reply.id);
    pending.delete(reply.id);
    if (!name) return;
    if (!reply.ok || !active) {
      // Asked again when next needed.
      asked.delete(name);
      if (!reply.ok) return;
    }
    const p = reply.pack;
    if (p.placed.length > 0 && !hipPlaced) {
      const layer = placedLayer(p.placed, p.placedColour, 'explore-neighbourhood-hipparcos');
      group.add(layer.sprite);
      hipPlaced = { layer, stars: p.placed, hips: p.placedHip };
      loaded += p.placedHip.length;
    }
    if (p.far.length > 0 && !farLayers.some((f) => f.file === name)) {
      const layer = farLayer(p.far, p.farColour, obliquity, `explore-neighbourhood-${name.replace('.bin', '')}`);
      group.add(layer.sprite);
      farLayers.push({ layer, count: p.far.length / 2, file: name });
      // Brightest first across the packs: Hipparcos's directions, then Tycho-2's in order.
      farLayers.sort((a, b) => (a.file < b.file ? -1 : 1));
      loaded += p.far.length / 2;
    }
  };
  const askPack = (pack: CatalogueManifest['packs'][number]): void => {
    if (!ctx || asked.has(pack.file)) return;
    asked.add(pack.file);
    if (!worker) {
      worker = new Worker(new URL('./catalogue.worker.ts', import.meta.url), { type: 'module', name: 'explore-star-catalogue' });
      worker.onmessage = received;
    }
    const id = nextId++;
    pending.set(id, pack.file);
    const request: PackRequest = { id, url: ctx.assets.url(`assets/stars/${pack.file}`), kind: pack.kind, count: pack.count, obliquity, lut, exclude };
    worker.postMessage(request);
  };
  /** The packs the tier and the faintest magnitude call for (a pack only once something in it can be seen). */
  const askPacks = (): void => {
    if (!manifest || !active) return;
    let budget = starBudget;
    for (const pack of manifest.packs) {
      if (budget <= 0) break;
      if (pack.kind === 'hipparcos' || pack.vmag[0] < starlightUniforms.faintest.value) askPack(pack);
      budget -= pack.count;
    }
  };

  // The galaxy's glow from star counts, the figures and the black holes, as their files arrive.
  const axes = galacticAxes(obliquity);
  const toGalactic = new Matrix3().set(axes.x[0], axes.x[1], axes.x[2], axes.y[0], axes.y[1], axes.y[2], axes.z[0], axes.z[1], axes.z[2]);
  let band: Band | null = null;
  let figures: Figures | null = null;
  let holes: BlackHole[] = [];
  let lens: LensView | null = null;
  let lensLoading = false;
  let lensCaptured = false;
  if (ctx) {
    void ctx.assets
      .json<CatalogueManifest>('assets/stars/catalogue.json')
      .then((m) => {
        manifest = m;
        askPacks();
        return ctx.assets.binary(`assets/stars/${m.band.file}`).then((bytes) => {
          band = createBand(new Uint8Array(bytes), m.band.width, m.band.height, toGalactic, m.band.perSquareDegree);
          group.add(band.mesh);
        });
      })
      .catch(() => undefined);
    void ctx.assets
      .json<BlackHoleFile>('assets/stars/black-holes.json')
      .then((f) => {
        holes = readBlackHoles(f, obliquity);
      })
      .catch(() => undefined);
    void ctx.assets
      .json<SkyFile>('assets/sky/sky.json')
      .then((sky) => {
        figures = createFigures(sky, all, (s) => (s.position ? posOf(s) : null));
        group.add(figures.object);
      })
      .catch(() => undefined);
  }

  // The star in view up close, and a ring round it in orbit.
  const disc = createDisc();
  const reticleMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const ring = uv().sub(0.5).mul(2).length();
  const uReticle = uniform(0);
  reticleMaterial.sizeNode = float(34);
  reticleMaterial.colorNode = vec3(0.9, 0.75, 0.42).mul(smoothstep(0.78, 0.86, ring).mul(smoothstep(0.98, 0.9, ring))).mul(uReticle);
  reticleMaterial.opacityNode = float(1);
  const reticlePos = new Float32Array(3);
  const reticleAttr = new InstancedBufferAttribute(reticlePos, 3);
  reticleMaterial.positionNode = instancedBufferAttribute(reticleAttr);
  const reticle = new Sprite(reticleMaterial);
  reticle.geometry = spriteQuad();
  reticle.count = 1;
  reticle.frustumCulled = false;
  // After a black hole's lens (it would bend the ring round its own hole).
  reticle.renderOrder = 30;
  reticle.name = 'explore-neighbourhood-reticle';

  // A system's planets: orbits as lines and planets as points, round the star in view when near.
  const orbitMaterial = new LineBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  orbitMaterial.colorNode = vec3(0.35, 0.45, 0.6);
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
  const pc = uv().sub(0.5).mul(2);
  const pr2 = pc.dot(pc);
  planetMaterial.colorNode = vec3(0.9, 0.85, 0.75).mul(exp(pr2.mul(-4)).mul(max(float(1).sub(pr2), 0)));
  planetMaterial.opacityNode = float(1);
  const planetSprites = new Sprite(planetMaterial);
  planetSprites.geometry = spriteQuad();
  planetSprites.count = 0;
  planetSprites.frustumCulled = false;
  planetSprites.name = 'explore-neighbourhood-planets';
  group.add(disc.mesh, reticle, orbitLines, planetSprites);
  const beyond: Beyond | null = beyondInputs
    ? createBeyond(beyondInputs.localGroup, obliquity, beyondInputs.loadWeb, beyondInputs.detail, (s) => {
        group.add(s);
      })
    : null;

  /** A stand-in star for a place beyond the stars (index -2) or a black hole (-3 less its place in the list). */
  const standIn = (at: V3, name: string, index = -2): Star => ({ index, hip: null, hr: null, name, raDeg: 0, decDeg: 0, plxMas: Number.POSITIVE_INFINITY, ePlxMas: 0, plxFrom: null, vmag: Number.NaN, bv: null, spType: null, distPc: Math.hypot(...at), position: at, absoluteV: null, system: null });
  const holeOf = (s: Star): BlackHole | null => (s.index <= -3 && s.index > -3 - holes.length ? (holes[-3 - s.index] ?? null) : null);
  /** A star of Hipparcos's that is not in the neighbourhood's file, from its GPU data (k: its place there; index -1000 less it). */
  const hipStar = (k: number): Star | null => {
    if (!hipPlaced) return null;
    const s = hipPlaced.stars;
    const p: V3 = [s[k * 4] ?? 0, s[k * 4 + 1] ?? 0, s[k * 4 + 2] ?? 0];
    const d = length(p);
    const absV = s[k * 4 + 3] ?? 0;
    return { index: -1000 - k, hip: hipPlaced.hips[k] ?? null, hr: null, name: null, raDeg: 0, decDeg: 0, plxMas: 1000 / d, ePlxMas: 0, plxFrom: null, vmag: absV + 5 * Math.log10(d / 10), bv: null, spType: null, distPc: d, position: p, absoluteV: absV, system: null };
  };
  /** A star's radius (pc): the archive's, else estimated from its light and temperature (null where it has no magnitude from 10 pc, or for a stand-in). */
  const radiusOf = (s: Star): { pc: number; estimated: boolean } | null => {
    if (s === data.sun) return { pc: SUN.radiusPc, estimated: false };
    if (s.index < -1 && s.index > -1000) return null;
    if (s.system?.radiusSun) return { pc: s.system.radiusSun * SUN.radiusPc, estimated: false };
    if (s.absoluteV === null) return null;
    const teff = s.system?.teffK ?? bvKelvin(s.bv ?? 0.65);
    return { pc: estimatedRadius(s.absoluteV, teff) * SUN.radiusPc, estimated: true };
  };
  /** The nearest the camera may come to what it orbits (pc). */
  const reachOf = (s: Star): number => {
    const h = holeOf(s);
    if (h) return ARRIVE.holeMin * h.rsPc;
    const r = radiusOf(s);
    return r ? ARRIVE.starMin * r.pc : REACH.minPc;
  };

  /** Flies to a star or a stand-in, arriving `arrivePc` from it, from `toward` (a unit direction) when given. */
  const fly = (star: Star, arrivePc: number, toward: V3 | null, upTo: V3 | null = null): void => {
    focus = star;
    flyTo(rig, posOf(star), arrivePc, toward, upTo);
    rig.minPc = reachOf(star);
    lensCaptured = false;
  };
  const arrivalOf = (star: Star): number => {
    if (star === data.sun) return ARRIVE.sunPc;
    const widest = Math.max(0, ...(star.system?.planets.map((p) => p.aAu ?? 0) ?? []));
    if (widest > 0) return (3 * widest) / AU_PER_PC;
    const r = radiusOf(star);
    return r ? ARRIVE.starRadii * r.pc : 0.01;
  };
  const goToHole = (h: BlackHole): void => {
    place = null;
    hole = h;
    // From the Sun's side, as it is seen from the Earth (the Event Horizon Telescope's two); a disc from 15 degrees above its plane, farther out, to see it whole.
    const d = length(h.position);
    const toSun: V3 = d > 0 ? [-h.position[0] / d, -h.position[1] / d, -h.position[2] / d] : [0, 0, 1];
    const k = toSun[0] * h.axis[0] + toSun[1] * h.axis[1] + toSun[2] * h.axis[2];
    const side = unitOf([toSun[0] - k * h.axis[0], toSun[1] - k * h.axis[1], toSun[2] - k * h.axis[2]]);
    const tilt = (75 * Math.PI) / 180;
    const disc = h.model === 'thin-disc';
    const from: V3 = disc ? [Math.cos(tilt) * h.axis[0] + Math.sin(tilt) * side[0], Math.cos(tilt) * h.axis[1] + Math.sin(tilt) * side[1], Math.cos(tilt) * h.axis[2] + Math.sin(tilt) * side[2]] : toSun;
    fly(standIn(h.position, h.name, -3 - holes.indexOf(h)), (disc ? ARRIVE.discRs : ARRIVE.holeRs) * h.rsPc, from, h.axis);
  };

  let planetsDrawn: Array<{ name: string; at: V3 }> = [];
  let systemShownFor: string | null = null;
  let results: Star[] = [];
  let galaxyResults: LocalGalaxy[] = [];
  let holeResults: BlackHole[] = [];
  let nearestFor: string | null = null;
  let nearestList: UniverseNeighbourhood['nearest'] = [];
  let nearestPc = 1;
  let nearestAge = Infinity;
  let lastCamera: PerspectiveCamera | null = null;
  let lastInsets: Required<ViewInsets> = { top: 0, bottom: 0, left: 0, right: 0 };
  let hoverInfo: UniverseNeighbourhood['hover'] = null;
  let hoverAt: { x: number; y: number; t: number; sticky: boolean } | null = null;
  let lastHoverMs = 0;
  let zoomLockMs = 0;
  const project = new Vector3();

  /** The orbits of a system, as line segments relative to its star (pc): each in the plane face-on to the Sun, tilted by its inclination where measured. */
  const buildOrbits = (s: Star): void => {
    const planets = s.system?.planets ?? [];
    const pts: number[] = [];
    const [n0, n1, n2] = unitOf(posOf(s));
    const u = unitOf(crossOf([n0, n1, n2], Math.abs(n1) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const v = crossOf([n0, n1, n2], u);
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
          pts.push(x * u[0] + y * (Math.cos(inc) * v[0] + Math.sin(inc) * n0), x * u[1] + y * (Math.cos(inc) * v[1] + Math.sin(inc) * n1), x * u[2] + y * (Math.cos(inc) * v[2] + Math.sin(inc) * n2));
        }
      }
    }
    orbitGeometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    orbitGeometry.computeBoundingSphere();
    systemShownFor = s.name;
  };

  /** The camera's place relative to a point (pc), worked out from its anchor: exact near a star or a black hole however far it is from the Sun. */
  const relTo = (p: V3): V3 => [rig.anchor[0] - p[0] + rig.rel[0], rig.anchor[1] - p[1] + rig.rel[1], rig.anchor[2] - p[2] + rig.rel[2]];
  /** Where a point (pc from the Sun) is on the screen (CSS px), or null behind the camera. */
  const toScreen = (p: V3, w: number, h: number): { x: number; y: number } | null => {
    if (!lastCamera) return null;
    project.set(p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]).project(lastCamera);
    if (project.z > 1 || project.z < -1) return null;
    return { x: ((project.x + 1) / 2) * w, y: ((1 - project.y) / 2) * h };
  };
  const canvasRect = (): DOMRect | null => ctx?.renderer.domElement.getBoundingClientRect() ?? null;
  /** The view's angle per CSS pixel (rad). */
  const radPerPx = (): number => (lastCamera ? (2 * Math.tan((lastCamera.fov / 2) * (Math.PI / 180))) / Math.max(ctx?.renderer.domElement.clientHeight ?? 800, 1) : 0.001);

  /** The direction (render frame, unit) through a point of the screen (CSS px). */
  const rayAt = (x: number, y: number, w: number, h: number): V3 => {
    if (!lastCamera) return forwardOf(rig.q);
    project.set((x / w) * 2 - 1, 1 - (y / h) * 2, 0.5).unproject(lastCamera).normalize();
    return [project.x, project.y, project.z];
  };

  /** The nearest star (or black hole's horizon) to the camera, looked for afresh now and then (pc). */
  const findNearest = (): number => {
    let best = Infinity;
    const scan = (stars: Float32Array, skip: number): void => {
      for (let k = 0; k < stars.length; k += 4) {
        if (k / 4 === skip) continue;
        const d = Math.hypot((stars[k] ?? 0) - camera[0], (stars[k + 1] ?? 0) - camera[1], (stars[k + 2] ?? 0) - camera[2]);
        if (d < best) best = d;
      }
    };
    scan(namedData, slotOf(focus));
    if (hipPlaced) scan(hipPlaced.stars, -1);
    for (const h of holes) best = Math.min(best, Math.max(0, length(sub(h.position, camera)) - h.rsPc));
    return best;
  };

  /** The star (or hole) nearest a point of the screen (CSS px) among those visibly drawn: its pixel distance less a bonus for brightness. */
  const nearestOnScreen = (x: number, y: number, w: number, h: number, radius: number): Star | null => {
    if (!lastCamera) return null;
    const faintest = starlightUniforms.faintest.value - 0.3;
    let best: Star | null = null;
    let bestScore = radius;
    const ray = rayAt(x, y, w, h);
    // Off the pointer's ray by more than the radius (and a margin): not projected at all.
    const cos = Math.cos(radius * radPerPx() * 1.5);
    const consider = (px: number, py: number, pz: number, absV: number, make: () => Star | null): void => {
      const rx = px - camera[0];
      const ry = py - camera[1];
      const rz = pz - camera[2];
      const r = Math.hypot(rx, ry, rz);
      if ((rx * ray[0] + ry * ray[1] + rz * ray[2]) / r < cos) return;
      const m = absV + 5 * Math.log10(Math.max(r, 1e-14) / 10);
      if (!(m < faintest)) return;
      const at = toScreen([px, py, pz], w, h);
      if (!at) return;
      const d = Math.hypot(at.x - x, at.y - y);
      if (d > radius) return;
      const score = d - PICK.perMag * Math.min(6, faintest - m);
      if (score < bestScore) {
        const s = make();
        if (s) {
          bestScore = score;
          best = s;
        }
      }
    };
    for (let k = 0; k < named.length; k += 1) consider(namedData[k * 4] ?? 0, namedData[k * 4 + 1] ?? 0, namedData[k * 4 + 2] ?? 0, namedData[k * 4 + 3] ?? 30, () => named[k] ?? null);
    const hp = hipPlaced;
    if (hp) for (let k = 0; k < hp.hips.length; k += 1) consider(hp.stars[k * 4] ?? 0, hp.stars[k * 4 + 1] ?? 0, hp.stars[k * 4 + 2] ?? 0, hp.stars[k * 4 + 3] ?? 30, () => hipStar(k));
    holes.forEach((hh, k) => {
      const at = toScreen(hh.position, w, h);
      if (!at) return;
      const d = Math.hypot(at.x - x, at.y - y);
      if (d < bestScore) {
        bestScore = d;
        best = standIn(hh.position, hh.name, -3 - k);
      }
    });
    return best;
  };

  const describe = (s: Star, x: number, y: number): UniverseNeighbourhood['hover'] => {
    const h = holeOf(s);
    const p = posOf(s);
    const r = length(sub(p, camera));
    return {
      name: h?.name ?? s.name ?? (s.hip !== null ? `HIP ${String(s.hip)}` : ''),
      hip: s.hip,
      distLy: s === data.sun || s.position ? r * 3.2615638 : null,
      mag: h || s.absoluteV === null ? null : s.absoluteV + 5 * Math.log10(Math.max(r, 1e-14) / 10),
      spType: s.spType ?? s.system?.spType ?? null,
      x,
      y,
      hole: h !== null,
    };
  };

  const searchAll = (text: string): void => {
    results = data.search(text);
    galaxyResults = beyond?.search(text) ?? [];
    const q = searchKey(text);
    holeResults = q.length < 2 ? [] : holes.filter((h) => [h.name, h.id, 'black hole', h.id === 'sgr-a' ? 'sagittarius a' : ''].some((k) => k !== '' && searchKey(k).includes(q)));
  };

  const goToPlace = (id: BeyondPlace['id'] | `galaxy:${string}` | `bh:${string}`): void => {
    if (id.startsWith('bh:')) {
      const h = holes.find((x) => x.id === id.slice(3));
      if (h) goToHole(h);
      return;
    }
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
    hole = null;
    fly(standIn(to.position, to.galaxy?.name ?? to.id), to.arrivePc, to.from);
  };

  const goTo = (star: Star): void => {
    const h = holeOf(star);
    if (h) {
      goToHole(h);
      return;
    }
    if (!star.position) return;
    const arrive = arrivalOf(star);
    const same = star === focus || (star.hip !== null && star.hip === focus.hip);
    // The star already in view: back to its arrival distance (from far out, or after wandering), else nothing to do.
    if (same && place === null && hole === null && rig.mode === 'orbit' && !rig.trip && Math.abs(Math.log(Math.max(length(sub(camera, posOf(star))), 1e-300) / arrive)) < 0.01) return;
    place = null;
    hole = null;
    fly(star, arrive, null);
  };

  const toggle = (): void => {
    if (rig.trip) return;
    reanchor(rig, posOf(focus), reachOf(focus));
    rigToggle(rig);
  };

  return {
    objects: [group],
    get active() {
      return active;
    },
    get travelling() {
      return rig.trip !== null;
    },
    data,
    enter(distancePc) {
      active = true;
      group.visible = true;
      focus = data.sun;
      place = null;
      hole = null;
      const d = Math.max(REACH.minPc, Math.min(REACH.maxPc, distancePc));
      // The old default bearing (azimuth 0.6, elevation 0.35 round the Sun), looking at it, free to look round.
      const dir: V3 = [Math.cos(0.35) * Math.sin(0.6), Math.sin(0.35), Math.cos(0.35) * Math.cos(0.6)];
      Object.assign(rig, createRig([0, 0, 0], [dir[0] * d, dir[1] * d, dir[2] * d], reachOf(data.sun), REACH.maxPc));
      camera = cameraOf(rig);
      nearestAge = Infinity;
      hoverInfo = null;
      hoverAt = null;
      lensCaptured = false;
      askPacks();
    },
    exit() {
      active = false;
      group.visible = false;
      rig.trip = null;
      rig.keys = { move: [0, 0, 0], roll: 0, boost: false, turnX: 0, turnY: 0, zoom: 0 };
      hoverInfo = null;
      hoverAt = null;
    },
    drag(dx, dy) {
      rigDrag(rig, dx, dy, radPerPx());
    },
    pan(dx, dy) {
      // Across the view by the angle a pixel spans at the distance of the star in view (in free look, no farther than the nearest star).
      const at = Math.max(length(sub(camera, posOf(focus))), 1e-15);
      rigPan(rig, dx, dy, radPerPx() * (rig.mode === 'orbit' ? at : Math.min(at, nearestPc * 2)));
    },
    zoom(dLn, clientX, clientY) {
      if (!Number.isFinite(dLn) || dLn === 0) return;
      const rect = canvasRect();
      const pointer = rect && clientX !== undefined && clientY !== undefined ? { x: clientX - rect.left, y: clientY - rect.top, w: rect.width, h: rect.height } : null;
      const now = performance.now();
      // Toward a star under the pointer: in orbit it becomes the one in view (once a gesture), in free look the camera heads for it.
      const under = pointer && dLn < 0 ? nearestOnScreen(pointer.x, pointer.y, pointer.w, pointer.h, PICK.mousePx) : null;
      const other = under !== null && under !== focus && (under.hip === null || under.hip !== focus.hip);
      if (under && other && rig.mode === 'orbit') {
        if (now > zoomLockMs) goTo(under);
        zoomLockMs = now + 300;
        return;
      }
      if (rig.trip) return;
      const target = under ? posOf(under) : null;
      if (target && under) {
        rigZoom(rig, dLn, unitOf(sub(target, camera)), Math.max(0, length(sub(target, camera)) - reachOf(under)));
        return;
      }
      // Its step a share of the nearest star's distance, found afresh (a quick turn of the wheel outruns the frames); out, at least its distance from the star in view, so it draws back from it as an orbit would.
      camera = cameraOf(rig);
      nearestPc = findNearest();
      nearestAge = 0;
      const step = dLn > 0 ? Math.max(nearestPc * 2, length(relTo(posOf(focus)))) : nearestPc * 2;
      rigZoom(rig, dLn, pointer ? rayAt(pointer.x, pointer.y, pointer.w, pointer.h) : null, Math.max(step, 1e-15));
    },
    keys(move, roll, boost) {
      rig.keys.move = [Math.sign(move.x), Math.sign(move.y), Math.sign(move.z)];
      rig.keys.roll = Math.sign(roll);
      rig.keys.boost = boost;
    },
    turn(azimuth, elevation, zoom) {
      rig.keys.turnX = Math.sign(azimuth);
      rig.keys.turnY = Math.sign(elevation);
      rig.keys.zoom = Math.sign(zoom);
    },
    toggleMode: toggle,
    hover(clientX, clientY) {
      const rect = canvasRect();
      if (!rect) return;
      hoverAt = { x: clientX - rect.left, y: clientY - rect.top, t: performance.now(), sticky: false };
    },
    tap(clientX, clientY) {
      const rect = canvasRect();
      if (!rect) return false;
      // A tap shows what is there for a few seconds (and may still be the first of a double tap).
      hoverAt = { x: clientX - rect.left, y: clientY - rect.top, t: performance.now(), sticky: true };
      lastHoverMs = 0;
      return false;
    },
    goTo,
    goToPlace,
    search(text) {
      searchAll(text);
    },
    find(name) {
      searchAll(name);
      const q = searchKey(name);
      const exact = holeResults.find((h) => searchKey(h.name) === q || h.id === q);
      if (exact) {
        goToHole(exact);
        return true;
      }
      const s = results[0];
      if (s?.position) {
        goTo(s);
        return true;
      }
      const g = galaxyResults[0];
      if (g) {
        goToPlace(`galaxy:${g.name}`);
        return true;
      }
      const h = holeResults[0];
      if (h) {
        goToHole(h);
        return true;
      }
      return false;
    },
    stop() {
      if (!rig.trip) return;
      // Stopped where it is, free to look round (the star it was headed for is in view).
      stopTrip(rig);
    },
    setStarlight(brightness, faintest) {
      setStarlight(brightness, faintest);
      askPacks();
    },
    setMode(mode) {
      if (mode !== rig.mode) toggle();
    },
    setFigures(on) {
      figuresOn = on;
    },
    setDetail(t, starCount) {
      tier = t;
      starBudget = Math.max(0, starCount);
      askPacks();
    },
    pick(x, y, w, h) {
      return nearestOnScreen(x, y, w, h, PICK.touchPx);
    },
    update(dt, days, cam, focalPx = 800, insets) {
      lastCamera = cam;
      if (insets) lastInsets = { top: insets.top, bottom: insets.bottom, left: insets.left ?? 0, right: insets.right ?? 0 };
      // The nearest star now and then (it sets flight's speed and the wheel's step), the star in view's surface at once.
      nearestAge += dt;
      if (nearestAge > NEAREST_EVERY || rig.trip) {
        nearestAge = 0;
        nearestPc = findNearest();
      }
      const toSurface = Math.max(length(relTo(posOf(focus))) - reachOf(focus) / (holeOf(focus) ? ARRIVE.holeMin : ARRIVE.starMin), 0);
      rigStep(rig, dt, Math.max(Math.min(nearestPc, toSurface > 0 ? toSurface : nearestPc), 1e-16), ctx?.reducedMotion ?? false);
      // Never inside what it orbits.
      const relLength = length(rig.rel);
      if (rig.mode === 'orbit' && relLength < rig.minPc) rig.rel = rig.rel.map((x) => (x * rig.minPc) / Math.max(relLength, 1e-300)) as V3;
      camera = cameraOf(rig);
      setCameraParts(camera);
      const fp = posOf(focus);
      // The star in view from the camera, worked out from the camera's anchor (exact near a star or a hole far from the Sun).
      const toFocus = relTo(fp).map((x) => -x) as V3;
      const focusDistance = length(toFocus);
      const fromSun = length(camera);
      // Out past the stars: the catalogue's stars and the glow from within the galaxy give way to its model.
      const starsShown = beyond ? beyond.starsShown(fromSun) : 1;
      const farShown = (1 - smoothstepJs(FAR_FADE[0], FAR_FADE[1], fromSun)) * starsShown;
      beyond?.update(camera, fromSun, focalPx);
      namedLayer.light.value = starsShown;
      namedLayer.sprite.visible = starsShown > 0.001;
      if (hipPlaced) {
        hipPlaced.layer.light.value = starsShown;
        hipPlaced.layer.sprite.visible = starsShown > 0.001;
      }
      fileFar.light.value = farShown;
      fileFar.sprite.visible = farShown > 0.001;
      let budget = starBudget;
      for (const f of farLayers) {
        f.layer.light.value = farShown;
        f.layer.sprite.count = Math.max(0, Math.min(f.count, budget));
        f.layer.sprite.visible = farShown > 0.001 && f.layer.sprite.count > 0;
        budget -= f.count;
      }
      band?.setLight(beyond ? beyond.bandShown(fromSun) : 1);
      figures?.setShown(figuresOn ? 0.3 * starsShown : 0);
      // The star in view up close: a disc of its size once it is wider than a pixel or so, its point fading.
      const radius = radiusOf(focus);
      const dpr = ctx?.renderer.getPixelRatio() ?? 1;
      const radiusPx = radius ? (radius.pc / Math.max(focusDistance, 1e-300)) * focalPx : 0;
      const shown = smoothstepJs(DISC_PX[0] * dpr, DISC_PX[1] * dpr, radiusPx);
      disc.set(toFocus, radius?.pc ?? 0, blackbodyRgb(focus.system?.teffK ?? (focus.bv === null ? 5800 : bvKelvin(focus.bv))), shown);
      namedLayer.focus.value = slotOf(focus);
      namedLayer.focusLight.value = 1 - shown;
      if (hipPlaced) {
        hipPlaced.layer.focus.value = focus.index <= -1000 ? -1000 - focus.index : -1;
        hipPlaced.layer.focusLight.value = 1 - shown;
      }
      // The ring round the star in view, in orbit.
      uReticle.value = rig.mode === 'orbit' && !rig.trip ? 0.8 * (1 - shown) : 0;
      reticlePos.set(toFocus);
      reticleAttr.needsUpdate = true;
      reticle.visible = uReticle.value > 0.01;
      // A black hole's light bending, when near enough one to see it.
      const near = holes.find((h) => length(relTo(h.position)) < LENS_RS * h.rsPc) ?? null;
      if (near && ctx && !lens && !lensLoading) {
        lensLoading = true;
        void import('./lens-view')
          .then(({ createLensView }) => {
            lens = createLensView();
            group.add(lens.mesh);
          })
          .catch(() => undefined)
          .finally(() => {
            lensLoading = false;
          });
      }
      if (lens) {
        if (near) {
          lens.update(relTo(near.position).map((x) => x / near.rsPc) as V3, near.model, near.axis, 1 / Math.max(focalPx, 1), tier === 'low' ? 100 : tier === 'medium' ? 140 : 200);
          // The sky round the camera, captured once there (the lens hidden from it), again after a flight: its light
          // per pixel as on the screen (the stars' by the screen's to a face's pixel, the galaxies sized for a face).
          if (!lensCaptured && !rig.trip && ctx) {
            const brightness = starlightUniforms.brightness.value;
            const fov = cam.fov;
            starlightUniforms.brightness.value = brightness * Math.tan(((fov / 2) * Math.PI) / 180) ** 2;
            beyond?.update(camera, fromSun, CAPTURE_FOCAL_PX);
            const hidden = [figures?.object, reticle, disc.mesh, orbitLines, planetSprites].filter((o) => o?.visible);
            for (const o of hidden) if (o) o.visible = false;
            lens.capture(ctx.renderer, ctx.scene);
            for (const o of hidden) if (o) o.visible = true;
            starlightUniforms.brightness.value = brightness;
            beyond?.update(camera, fromSun, focalPx);
            lensCaptured = true;
          }
        } else {
          lens.mesh.visible = false;
          lensCaptured = false;
        }
      }
      // The system round the star in view, when near: its orbits, and its planets where their periods put them (their phases illustrative).
      planetsDrawn = [];
      const system = !rig.trip && focusDistance < SYSTEM_PC ? focus.system : null;
      orbitLines.visible = system !== null;
      planetSprites.visible = system !== null;
      if (system) {
        if (systemShownFor !== focus.name) buildOrbits(focus);
        orbitLines.position.set(...toFocus);
        const [n0, n1, n2] = unitOf(fp);
        const u = unitOf(crossOf([n0, n1, n2], Math.abs(n1) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const v = crossOf([n0, n1, n2], u);
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
            toFocus[0] + x * u[0] + y * (Math.cos(inc) * v[0] + Math.sin(inc) * n0),
            toFocus[1] + x * u[1] + y * (Math.cos(inc) * v[1] + Math.sin(inc) * n1),
            toFocus[2] + x * u[2] + y * (Math.cos(inc) * v[2] + Math.sin(inc) * n2),
          ];
          planetPos.set(at, k * 3);
          planetsDrawn.push({ name: p.name, at });
          k += 1;
        }
        planetSprites.count = k;
        planetPosAttr.needsUpdate = true;
      }
      // What is under the pointer, ten times a second (a tap's for three seconds).
      const now = performance.now();
      if (hoverAt && now - lastHoverMs > 100) {
        lastHoverMs = now;
        const rect = canvasRect();
        const s = rect ? nearestOnScreen(hoverAt.x, hoverAt.y, rect.width, rect.height, hoverAt.sticky ? PICK.touchPx : PICK.mousePx) : null;
        const at = s && rect ? toScreen(posOf(s), rect.width, rect.height) : null;
        hoverInfo = s ? describe(s, (at?.x ?? hoverAt.x) + (rect?.left ?? 0), (at?.y ?? hoverAt.y) + (rect?.top ?? 0)) : null;
        if (now - hoverAt.t > (hoverAt.sticky ? 3000 : 6000)) hoverAt = null;
      }
      if (!hoverAt) hoverInfo = null;
      // The depth range: a thousandth of the way to what is nearest (a star's surface, a black hole's horizon).
      const nearDepth = Math.max(Math.min(focusDistance, nearestPc + reachOf(focus)) * 1e-3, 1e-22);
      return { forward: forwardOf(rig.q), up: upOf(rig.q), near: nearDepth, far: REACH.maxPc * 16 };
    },
    labels(out) {
      if (!active) return;
      const fromSun = length(camera);
      beyond?.labels(out, camera, fromSun);
      const rect = canvasRect();
      const w = rect?.width ?? 1;
      const h = rect?.height ?? 1;
      const rel = (p: V3): [number, number, number] => [p[0] - camera[0], p[1] - camera[1], p[2] - camera[2]];
      // The black holes, by name: the one in view, and others within half the camera's distance from the Sun (or 100 pc).
      for (const hh of holes) {
        if (hh !== hole && length(relTo(hh.position)) > Math.max(0.5 * fromSun, 100)) continue;
        out.push({ id: `bh-${hh.id}`, textKey: '', text: hh.name, position: rel(hh.position), opacity: 0.9 });
      }
      for (const p of planetsDrawn) out.push({ id: `planet-${p.name}`, textKey: '', text: p.name, position: [p.at[0], p.at[1], p.at[2]], opacity: 0.85 });
      if (beyond && beyond.starsShown(fromSun) < 0.5) return;
      // The star in view, the one under the pointer, then the brightest named stars seen from here, where their tags fit.
      const candidates: Array<LabelCandidate & { p: V3 }> = [];
      const push = (s: Star | null | undefined): void => {
        if (!s?.name) return;
        const id = `star-${String(s.hip ?? 'sun')}`;
        if (candidates.some((c) => c.id === id)) return;
        const p = posOf(s);
        const at = toScreen(p, w, h);
        if (at) candidates.push({ id, text: s.name, x: at.x, y: at.y, p });
      };
      if (focus.index >= -1) push(focus);
      if (hoverInfo && !hoverInfo.hole) push(hoverInfo.hip === null ? (hoverInfo.name === 'Sun' ? data.sun : null) : data.stars.find((s) => s.hip === hoverInfo?.hip));
      const ranked: Array<{ s: Star; m: number }> = [];
      for (const s of named) {
        if (!s.name || s.absoluteV === null) continue;
        const m = s.absoluteV + 5 * Math.log10(Math.max(length(sub(posOf(s), camera)), 1e-14) / 10);
        if (m < NAMES.brighterThan) ranked.push({ s, m });
      }
      ranked.sort((a, b) => a.m - b.m);
      for (const { s } of ranked) {
        if (candidates.length > NAMES.max * 3) break;
        push(s);
      }
      const area = { left: lastInsets.left + 8, top: lastInsets.top + 8, right: w - lastInsets.right - 8, bottom: h - lastInsets.bottom - 8 };
      for (const id of placeLabels(candidates, area, NAMES.max)) {
        const c = candidates.find((x) => x.id === id);
        if (c) out.push({ id, textKey: '', text: c.text, position: rel(c.p), opacity: 1 });
      }
    },
    view() {
      if (!active) return null;
      const fp = posOf(focus);
      const fromSunPc = length(camera);
      const s = focus;
      const g: LocalGalaxy | null = place?.galaxy ?? null;
      const kelvin = s.bv === null ? null : bvKelvin(s.bv);
      const cameraPc = length(relTo(fp));
      // The nearest stars to the one in view: worked out once for each star in view.
      const key = `${String(s.index)}:${String(s.hip)}`;
      if (key !== nearestFor) {
        nearestFor = key;
        nearestList = data
          .nearest(fp, 9)
          .filter((x) => x !== s && (x.hip === null || x.hip !== s.hip))
          .slice(0, 8)
          .map((x) => ({ name: x.name ?? (x.hip ? `HIP ${String(x.hip)}` : ''), hip: x.hip, distPc: length(sub(posOf(x), fp)), planets: x.system?.planets.length ?? 0 }));
      }
      const radius = radiusOf(s);
      const h = hole;
      const rs = h ? cameraPc / h.rsPc : 0;
      return {
        focus: {
          name: h?.name ?? s.name,
          hip: s.hip,
          hr: s.hr,
          distPc: s === data.sun ? 0 : s.distPc,
          distLy: s === data.sun ? 0 : s.distPc === null ? null : s.distPc * LY_PER_PC,
          relativeError: s === data.sun || !Number.isFinite(s.plxMas) || s.ePlxMas === 0 ? 0 : s.ePlxMas / s.plxMas,
          vmag: s === data.sun || Number.isNaN(s.vmag) ? null : s.vmag,
          absoluteV: s.absoluteV,
          temperatureK: s.system?.teffK ?? kelvin,
          spType: s.system?.spType ?? s.spType,
          planets: (s.system?.planets ?? []).map((p) => ({ ...p })),
          host: s.system?.host ?? null,
          starsInSystem: s.system?.stars ?? 1,
          radiusSun: s.system?.radiusSun ?? null,
          massSun: s.system?.massSun ?? null,
          luminositySun: s.system?.logLumSun === null || s.system?.logLumSun === undefined ? null : 10 ** s.system.logLumSun,
          radiusEstimated: radius?.estimated ? radius.pc / SUN.radiusPc : null,
          plxFrom: s.plxFrom,
        },
        cameraPc,
        cameraKm: cameraPc * KM_PER_PC,
        fromSunPc,
        fromSunLy: fromSunPc * LY_PER_PC,
        travelling: rig.trip !== null,
        systemShown: !rig.trip && cameraPc < SYSTEM_PC && (s.system?.planets.length ?? 0) > 0,
        scale: beyond ? beyond.scale(fromSunPc) : 'stars',
        camera: { mode: rig.mode, speedPcPerS: rig.speed, forward: forwardOf(rig.q) },
        starlight: { brightness: starlightUniforms.brightness.value, faintest: starlightUniforms.faintest.value },
        stars: {
          placed: named.length + (hipPlaced ? hipPlaced.hips.length : 0),
          far: unplaced.length + farLayers.reduce((n, f) => n + f.layer.sprite.count, 0),
          loaded: named.length + unplaced.length + loaded,
          catalogue: named.length + unplaced.length + (manifest?.packs.reduce((n, p) => n + p.count, 0) ?? 0),
        },
        figures: figuresOn,
        hover: hoverInfo,
        blackHoles: holes.map((x) => ({ id: x.id, name: x.name, distPc: x.distPc, kind: x.kind })),
        blackHole: h
          ? {
              id: h.id,
              name: h.name,
              kind: h.kind,
              model: h.model,
              massMsun: h.mass.value,
              massMinus: h.mass.minus,
              massPlus: h.mass.plus,
              massLow: h.mass.low ?? null,
              massSource: h.mass.source,
              massAlsoSource: h.mass.alsoSource ?? null,
              massHow: h.mass.how,
              distPc: h.distPc,
              distMinusPc: h.distance.minus,
              distPlusPc: h.distance.plus,
              distanceSource: h.distance.source,
              distanceHow: h.distance.how,
              redshift: h.redshift,
              lookbackGyr: h.lookbackGyr,
              rsKm: h.rsKm,
              rsAu: h.rsKm / 149_597_870.7,
              cameraRs: rs,
              shadowDeg: (shadowAngle(rs) * 180) / Math.PI,
              shadowFromEarthMicroArcsec: shadowMicroArcsec(h.mass.value, h.distPc),
              observation: h.observation ? { ...h.observation } : null,
              companion: h.companion ? { ...h.companion } : null,
              inclinationDeg: h.inclinationDeg,
              inclinationNote: h.inclinationNote,
            }
          : null,
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
          ...holeResults.map((x) => ({ name: x.name, hip: null, distPc: x.distPc, planets: 0, galaxy: null, hole: x.id })),
          ...galaxyResults.map((x) => ({ name: x.name, hip: null, distPc: x.distKpc * 1000, planets: 0, galaxy: x.name, hole: null })),
          ...results.map((x) => ({ name: x.name ?? (x.hip ? `HIP ${String(x.hip)}` : ''), hip: x.hip, distPc: x === data.sun ? 0 : x.distPc, planets: x.system?.planets.length ?? 0, galaxy: null, hole: null })),
        ],
        nearest: nearestList,
      };
    },
    dispose() {
      worker?.terminate();
      worker = null;
      namedLayer.dispose();
      fileFar.dispose();
      hipPlaced?.layer.dispose();
      for (const f of farLayers) f.layer.dispose();
      band?.dispose();
      figures?.dispose();
      lens?.dispose();
      disc.dispose();
      reticle.geometry.dispose();
      reticleMaterial.dispose();
      orbitGeometry.dispose();
      orbitMaterial.dispose();
      planetSprites.geometry.dispose();
      planetMaterial.dispose();
      beyond?.dispose();
    },
  };
}

function crossOf(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unitOf(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
