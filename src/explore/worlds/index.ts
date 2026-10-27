/**
 * More worlds for the explorer (docs/EXPLORER-MECHANICS.md, "More worlds"), its own chunk, loaded a
 * few seconds after the explorer opens (or when first asked for): the small bodies and moons, the
 * rings of Uranus and Neptune, and shadows of one body on another.
 *
 * - The asteroids (./belt): up to half a million from JPL's Small-Body Database, brightest first, as
 *   many as the detail level draws (ExploreDetail.smallBodies), each on its own orbit on the GPU.
 * - The periodic comets (./comets), with their tails near the Sun.
 * - Worlds to fly to (./bodies): the major moons, the dwarf planets, notable asteroids and comets.
 * - Uranus's and Neptune's rings (./rings), and eclipses (./eclipses).
 *
 * The explorer calls advance() after placing its ten bodies on the date and before moving the camera
 * (a world flown to is orbited like a body: ../navigation sees it through nav()), nearestKm() for the
 * depth range, and update() with the frame's camera and lens; labels() adds the worlds' names, which
 * the explorer then lays out as it does the laboratory's (clear of the interface, of each other and of
 * its own names), each name's fits() keeping it off every disc on screen. Nothing here touches the
 * explorer's own bodies: they are read, never changed.
 *
 * The worlds show only with the real sky at true scale: not in an experiment, on foot, on the way down,
 * among the stars (the explorer draws none of the solar system there), nor while the film's compressed
 * system stretches out (its planets are not where the worlds' orbits are); they fade in as they come.
 */

import { Group, Matrix4, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { BodyId, FocusId, SceneLabel, UniverseContext, UniverseIllustration, UniverseWorlds, WorldId } from '../../core/types';
import type { ExploreDetail } from '../detail';
import type { NavBody } from '../navigation';
import type { Km } from '../space/origin';
import type { SolarSystem } from '../system';
import { createBelt, type Belt } from './belt';
import { createWorldBodies, type PlacedWorld, type WorldMap, type WorldRecord } from './bodies';
import { createComets, type CometRow, type Comets } from './comets';
import { createEclipses, type Eclipse, type Eclipses, type ShadowCaster, type ShadowReceiver } from './eclipses';
import { BELT_GROUPS, GROUP_OF, type BeltGroup, type BeltManifest } from './orbits';
import { createSkyGlow, glowLight, type SkyGlow } from './glow';
import { createIceRings, type IceRings, type RingRow } from './rings';
import { boxMeetsCircle, boxMeetsConvex } from './screen';

export const SMALL_BODIES_URL = 'assets/smallbodies/';

/** What the explorer hands over each frame. */
export interface WorldsFrame {
  jdTdb: number;
  /** The camera, render frame, km from the Sun (doubles), and three's camera (for the names' places on screen). */
  camera: Km;
  view: PerspectiveCamera;
  far: number;
  pxPerTan: number;
  widthPx: number;
  heightPx: number;
  /** The exposure's adaptation (points and guides are held in display terms), and how far the solar filter is in (0 to 1). */
  compensation: number;
  filter: number;
  /** Not in an experiment, on foot or on the way down, nor during the film's stretch (the real sky's worlds at true scale only). */
  shown: boolean;
  focus: FocusId;
  /** The camera's distance from what it orbits (km): how wide the view is (the marked light comes in as it widens). */
  span: number;
  /** The frame's real seconds; the days the clock moved (0 for a jump), whether it runs on its own (not paused, not a trip), and reduced motion: for the hold of the worlds' turn. */
  dt: number;
  days: number;
  running: boolean;
  reduced: boolean;
  /** The canvas's pixel ratio, and how much of the night sky shows (on foot by day, none). */
  dpr: number;
  sky: number;
  /** The ten bodies as placed this frame (camera-relative and scaled), for shadows, rings and names. */
  placed: Readonly<Record<BodyId, { drawn: Km; k: number; radiusPx: number; distance: number; screenX: number; screenY: number; inView: boolean }>>;
}

export interface Worlds {
  readonly object: Group;
  /** Moves every world to the date (TDB Julian date). */
  advance(jdTdb: number): void;
  /** The camera's height above the nearest world's surface (km). */
  nearestKm(camera: Km): number;
  update(frame: WorldsFrame): void;
  /** The worlds' names, for the explorer to lay out (each with its rank and fits()). */
  labels(out: SceneLabel[]): void;
  /** A world as the navigator orbits it (null: none by that id), and every world (the camera keeps out of them all). */
  nav(id: FocusId): NavBody | null;
  navList(): NavBody[];
  /** The body a world belongs to: its planet (a moon), else the Sun (Pluto's moons too). */
  host(id: FocusId): BodyId;
  /** A world by its name or designation, any case ("ceres", "1", "Halley", "67P"), or null. */
  find(name: string): WorldId | null;
  /** The world under a point of the canvas (CSS px) nearer than `nearerKm` (a body whose disc holds the point), or null. */
  pick(x: number, y: number, nearerKm?: number): WorldId | null;
  /** Whether a world's turn is held now (null: not a world). */
  held(id: FocusId): boolean | null;
  setDetail(detail: ExploreDetail): void;
  setLayer(on: boolean): void;
  setGrouped(on: boolean): void;
  /** The asteroids drawn at their orbits' sizes (a diagram of the Kirkwood gaps) or where they are. */
  setArranged(on: boolean): void;
  /** The view's part (UniverseView.worlds), rewritten in place. */
  view(focus: FocusId): UniverseWorlds;
  /** What is drawn now that is illustrative (for the readout). */
  illustrative(out: UniverseIllustration[]): void;
  dispose(): void;
}

interface WorldsFile {
  worlds: WorldRecord[];
  rings: Record<'uranus' | 'neptune', RingRow[]>;
}

/**
 * The layer's fade (s); the camera's distance from what it orbits over which the marked light comes in
 * (km: about a third of an au to 5 au: nearer, the points would be spread over the whole sky as a
 * grain like a sensor's noise, the belt's shape not yet able to read); and beyond about 6 au the marked
 * light a point gets falls as the points crowd closer on screen (as the distance to the power 1.1), so
 * the belt seen from far out is a faint band, not a glare (the power 1.1 keeps the Trojans' sparser
 * clouds in sight from the Kuiper belt).
 */
const FADE_SECONDS = 0.5;
const MARKED_SPAN_KM = [5e7, 7.5e8] as const;
const CROWD = { fromKm: 9e8, power: 1.1 } as const;
/** Asteroids decoded a frame (each slice a few milliseconds' work). */
const DECODE_SLICE = 12_000;
/** The glows' sphere, as a share of the far plane (just inside the stars' 0.98), and the stars' light as ../index gives it (STARS). */
const GLOW_SHARE = 0.97;
const STAR_LIGHT = { light: 0.85, follow: 0.2 } as const;
/**
 * Names: how many at most, their opacity, how far a picked point may be (CSS px), how far a name keeps
 * off any disc (px), the least disc a point of light is reckoned (px), and the disc below which a name
 * is anchored at the centre rather than at the limb (px: as the explorer's own).
 */
const NAMES = { max: 14, opacity: 0.92, pickPx: 18, clearPx: 4, dotPx: 3, limbPx: [4, 12] } as const;
/** Saturn's rings, out to the F ring (km), which a name keeps off as it does the disc; a ring's outline on screen is a polygon of this many corners. */
const SATURN_RINGS_KM = 140_180;
const RING_CORNERS = 32;
/** A moon is named while the camera is within this many of its orbits' sizes of its planet. */
const MOON_NAMES_WITHIN = 40;
/** Small bodies are named within this distance of the camera (km), and the dwarf planets in wide views too. */
const SMALL_NAMES_KM = 3e7;
/** The moons whose shadows fall on their planets (receiver: casters). The Earth and the Moon take each other's. */
const SHADOWS: ReadonlyArray<{ on: BodyId; by: ReadonlyArray<BodyId | WorldId> }> = [
  { on: 'earth', by: ['moon'] },
  { on: 'moon', by: ['earth'] },
  { on: 'jupiter', by: ['w:Io', 'w:Europa', 'w:Ganymede', 'w:Callisto'] },
  { on: 'saturn', by: ['w:Titan', 'w:Rhea', 'w:Dione', 'w:Tethys'] },
  { on: 'uranus', by: ['w:Titania', 'w:Oberon', 'w:Umbriel', 'w:Ariel'] },
  { on: 'neptune', by: ['w:Triton'] },
  { on: 'mars', by: ['w:Phobos', 'w:Deimos'] },
];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Loads the data and builds the worlds; the asteroid files beyond the first arrive afterwards.
 * `detail` gives the detail level as it is when the data has come (the governor may have changed it
 * since they were asked for); `hold` is called as a map goes up to the GPU (the explorer's governor
 * judges no frame for a while).
 */
export async function createWorlds(ctx: UniverseContext, system: SolarSystem, obliquity: number, detail: () => ExploreDetail, hold: () => void = () => undefined): Promise<Worlds> {
  const [manifest, worldsFile, cometFile, mapsFile] = await Promise.all([
    ctx.assets.json<BeltManifest>(`${SMALL_BODIES_URL}manifest.json`),
    ctx.assets.json<WorldsFile>(`${SMALL_BODIES_URL}worlds.json`),
    ctx.assets.json<{ comets: CometRow[] }>(`${SMALL_BODIES_URL}comets.json`),
    // The surface maps' list (the maps themselves come when their worlds are first drawn up close).
    ctx.assets.json<{ maps: Record<string, WorldMap> }>(`${SMALL_BODIES_URL}maps.json`).catch((): { maps: Record<string, WorldMap> } => ({ maps: {} })),
  ]);
  const object = new Group();
  object.name = 'explore-small-worlds';
  const auKm = system.auKm;
  const bodies = createWorldBodies(
    worldsFile.worlds,
    system,
    obliquity,
    mapsFile.maps,
    (file) => ctx.assets.texture(`${SMALL_BODIES_URL}${file}`),
    (map) => {
      hold();
      ctx.renderer.initTexture(map);
    },
  );
  object.add(bodies.object);
  const comets: Comets = createComets(cometFile.comets, auKm);
  object.add(comets.object);
  const iceRings: Record<'uranus' | 'neptune', IceRings> = {
    uranus: createIceRings('explore-uranus-rings', worldsFile.rings.uranus, system.specs.uranus.radiusKm),
    neptune: createIceRings('explore-neptune-rings', worldsFile.rings.neptune, system.specs.neptune.radiusKm),
  };
  object.add(iceRings.uranus.object, iceRings.neptune.object);
  const glow: SkyGlow = createSkyGlow(obliquity);
  object.add(glow.object);
  const eclipses: Eclipses = createEclipses(SHADOWS.length);
  for (const mesh of eclipses.objects) object.add(mesh);
  const eclipseList: Eclipse[] = [];

  // The asteroid files: cumulative, brightest first. Only as many as the detail level draws are fetched;
  // a level that wants more than the buffers hold gets a new set, filled again from the files (cached).
  let belt: Belt | null = null;
  let beltCapacity = 0;
  let beltFiles = 0;
  let loading = false;
  const groups = new Uint8Array(manifest.tiers.reduce((n, t) => n + t.count, 0));
  const groupCounts = Object.fromEntries(BELT_GROUPS.map((g) => [g, 0])) as Record<BeltGroup, number>;
  let wantCount = detail().smallBodies;
  const filesFor = (count: number): number => {
    const i = manifest.tiers.findIndex((t) => t.cumulative >= count);
    return i < 0 ? manifest.tiers.length : i + 1;
  };
  const ensureBelt = async (): Promise<void> => {
    if (loading) return;
    const files = filesFor(wantCount);
    const capacity = manifest.tiers[files - 1]?.cumulative ?? 0;
    if (!belt || capacity > beltCapacity) {
      belt?.object.removeFromParent();
      belt?.dispose();
      belt = createBelt(capacity, manifest.classes);
      beltCapacity = capacity;
      beltFiles = 0;
      object.add(belt.object);
    }
    const b = belt;
    loading = true;
    try {
      while (beltFiles < files) {
        const tier = manifest.tiers[beltFiles];
        if (!tier) break;
        const buffer = await ctx.assets.binary(`${SMALL_BODIES_URL}${tier.file}`);
        // Decoded in slices, a frame apart, so no frame is held up long.
        for (let from = 0; from < tier.count; from += DECODE_SLICE) {
          const n = Math.min(DECODE_SLICE, tier.count - from);
          const view = new DataView(buffer, from * 16, n * 16);
          const start = b.loaded;
          b.append(view, n);
          for (let j = 0; j < n; j += 1) groups[start + j] = BELT_GROUPS.indexOf(GROUP_OF[manifest.classes[view.getUint16(j * 16 + 14, true) & 15] ?? 'AST']);
          b.setCount(wantCount);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        beltFiles += 1;
      }
    } finally {
      loading = false;
    }
    b.setCount(wantCount);
    // The level may have been raised while the files came.
    if (belt === b && filesFor(wantCount) > beltFiles) await ensureBelt();
  };
  await ensureBelt().catch(() => undefined);

  const countGroups = (): void => {
    for (const g of BELT_GROUPS) groupCounts[g] = 0;
    const n = belt?.count ?? 0;
    for (let j = 0; j < n; j += 1) {
      const g = BELT_GROUPS[groups[j] ?? 6] ?? 'other';
      groupCounts[g] += 1;
    }
  };
  let countedFor = -1;

  let layerOn = true;
  let layer = 1;
  let seen = 0;
  let grouped = false;
  let groupedFade = 0;
  let arranged = false;
  let arrangedFade = 0;
  let marked = 0;
  let lastDays = 0;
  let lastView: PerspectiveCamera | null = null;
  let disposed = false;
  /** Each name: its label (the explorer eases its opacity and sets its corner), whether it is wanted, and where it goes (camera-relative, as drawn). */
  const names = new Map<WorldId, { label: SceneLabel; want: boolean; at: [number, number, number] }>();
  const labelList: Array<{ label: SceneLabel; want: boolean; at: [number, number, number] }> = [];
  /** The discs a name keeps off this frame: centre and radius (CSS px) and whose (a world's index in the list, or -1), four numbers each; and Saturn's rings' outline. */
  const discs: number[] = [];
  const outlines: number[][] = [];
  const sunLocal = new Vector3();
  const eyeLocal = new Vector3();
  const rotation = new Matrix4();
  const projected = new Vector3();
  const right = new Vector3();

  const list: UniverseWorlds['list'] = bodies.list.map((w) => ({ id: w.record.id, name: w.record.name, kind: w.record.kind, host: w.record.host === 'sun' ? 'sun' : (w.record.host as FocusId) }));
  const view: UniverseWorlds = {
    layer: true,
    grouped: false,
    arranged: false,
    shown: 0,
    asteroids: 0,
    asteroidsLoaded: 0,
    groups: groupCounts,
    comets: 0,
    tails: 0,
    list,
    focus: null,
    eclipses: eclipseList,
    epochJdTdb: manifest.epochJdTdb,
    gpu: { maps: 0, asteroidSlots: 0 },
  };
  const hostOf = (id: FocusId): BodyId => {
    if (!id.startsWith('w:')) return id as BodyId;
    let host = bodies.byId(id as WorldId)?.record.host ?? 'sun';
    // Pluto's moons belong to Pluto, which goes round the Sun.
    while (host.startsWith('w:')) host = bodies.byId(host as WorldId)?.record.host ?? 'sun';
    return host as BodyId;
  };
  const casterOf = (id: BodyId | WorldId): ShadowCaster | null => {
    if (id.startsWith('w:')) {
      const w = bodies.byId(id as WorldId);
      return w ? { position: w.position, radiusKm: w.radiusKm } : null;
    }
    return { position: system.bodies[id as BodyId].position, radiusKm: system.specs[id as BodyId].radiusKm };
  };
  const receivers: ShadowReceiver[] = SHADOWS.map(({ on }) => ({ id: on, position: system.bodies[on].position, radiusKm: system.specs[on].radiusKm, drawn: { x: 0, y: 0, z: 0 }, k: 1, radiusPx: 0, visible: true }));
  const pairs = SHADOWS.map(({ on, by }, i) => ({
    receiver: receivers[i] as ShadowReceiver,
    casters: by.flatMap((id) => {
      const caster = casterOf(id);
      return caster ? [{ id: id, caster }] : [];
    }),
    red: on === 'moon',
    scale: 1,
  }));

  /** The discs on screen this frame, the ten bodies' and the worlds' drawn, and Saturn's rings' outline: what names keep off. */
  const gatherDiscs = (frame: WorldsFrame): void => {
    discs.length = 0;
    let rings = 0;
    const pad = NAMES.clearPx;
    for (const id of Object.keys(frame.placed) as BodyId[]) {
      const p = frame.placed[id];
      if (!p.inView || p.radiusPx < 1.5) continue;
      discs.push(p.screenX, p.screenY, p.radiusPx + pad, -1);
      // Saturn's broad rings (Uranus's and Neptune's are a few faint threads a name may cross).
      if (id !== 'saturn') continue;
      // The outer ring in the plane of the body's x and z, projected point by point (a near ring's
      // far side is drawn smaller: no ellipse about its centre fits it), a little out from its centre.
      const b = system.bodies[id].basis;
      const k = SATURN_RINGS_KM * p.k;
      const outline = (outlines[rings] ??= []);
      outline.length = 0;
      let front = true;
      for (let c = 0; c < RING_CORNERS && front; c += 1) {
        const a = (c / RING_CORNERS) * 2 * Math.PI;
        const u = Math.cos(a) * k;
        const v = Math.sin(a) * k;
        projected.set(p.drawn.x + (b[0] ?? 0) * u + (b[6] ?? 0) * v, p.drawn.y + (b[1] ?? 0) * u + (b[7] ?? 0) * v, p.drawn.z + (b[2] ?? 0) * u + (b[8] ?? 0) * v).project(frame.view);
        front = projected.z > -1 && projected.z < 1;
        const sx = ((projected.x + 1) / 2) * frame.widthPx;
        const sy = ((1 - projected.y) / 2) * frame.heightPx;
        const l = Math.hypot(sx - p.screenX, sy - p.screenY) || 1;
        outline.push(sx + ((sx - p.screenX) / l) * pad, sy + ((sy - p.screenY) / l) * pad);
      }
      // (One reaching behind the camera surrounds the view: none is kept, the names keep off the disc only.)
      if (front) rings += 1;
    }
    outlines.length = rings;
    bodies.list.forEach((w, i) => {
      if (!w.inView || !(w.record.kind === 'moon' || layer > 0.5 || w.record.id === frame.focus)) return;
      discs.push(w.screenX, w.screenY, Math.max(w.radiusPx, NAMES.dotPx) + pad, i);
    });
  };
  /** Whether world `i`'s name, in a box (CSS px), keeps off every disc but its own world's, and off the rings. */
  const clearOfDiscs = (i: number, x: number, y: number, w: number, h: number): boolean => {
    for (let d = 0; d + 3 < discs.length; d += 4) if (discs[d + 3] !== i && boxMeetsCircle(x, y, w, h, discs[d] ?? 0, discs[d + 1] ?? 0, discs[d + 2] ?? 0)) return false;
    for (const outline of outlines) if (boxMeetsConvex(x, y, w, h, outline)) return false;
    return true;
  };
  /** Whether a world is behind a nearer disc (one of the ten, or a world drawn). */
  const hidden = (frame: WorldsFrame, w: PlacedWorld): boolean => {
    for (const id of Object.keys(frame.placed) as BodyId[]) {
      const p = frame.placed[id];
      if (p.inView && p.distance < w.distance && Math.hypot(p.screenX - w.screenX, p.screenY - w.screenY) < p.radiusPx) return true;
    }
    for (const o of bodies.list) if (o !== w && o.inView && o.radiusPx > 1 && o.distance < w.distance && Math.hypot(o.screenX - w.screenX, o.screenY - w.screenY) < o.radiusPx) return true;
    return false;
  };

  /** Which worlds are named (the most important first, none behind a nearer disc), each at its limb (or its point), for the explorer to lay out. */
  const placeNames = (frame: WorldsFrame): void => {
    for (const n of names.values()) n.want = false;
    if (frame.shown && seen > 0.5) {
      gatherDiscs(frame);
      const candidates: Array<{ w: PlacedWorld; rank: number }> = [];
      for (const w of bodies.list) {
        if (!w.inView || w.radiusPx > 70) continue;
        const r = w.record;
        let rank = -1;
        if (r.id === frame.focus) rank = 1e9;
        else if (r.kind === 'moon') {
          const host = r.host.startsWith('w:') ? bodies.byId(r.host as WorldId) : null;
          const hostPos = host ? host.position : system.bodies[r.host as BodyId].position;
          const orbit = r.elements.aKm ?? 1;
          const hostDistance = Math.hypot(hostPos.x - frame.camera.x, hostPos.y - frame.camera.y, hostPos.z - frame.camera.z);
          if (hostDistance < orbit * MOON_NAMES_WITHIN) rank = 1e6 + w.radiusKm;
        } else if (layer > 0.5 && (w.distance < SMALL_NAMES_KM || (r.kind === 'dwarf' && marked > 0.5))) rank = 1e3 + w.radiusKm;
        if (rank >= 0 && !hidden(frame, w)) candidates.push({ w, rank });
      }
      candidates.sort((a, b) => b.rank - a.rank);
      right.set(1, 0, 0).applyQuaternion(frame.view.quaternion);
      for (const { w, rank } of candidates.slice(0, NAMES.max)) {
        let n = names.get(w.record.id);
        if (!n) {
          const i = bodies.list.indexOf(w);
          n = { label: { id: `world-${w.record.name}`, textKey: '', text: w.record.name, position: [0, 0, 0], opacity: 0, offset: [10, -10], fits: (x, y, bw, bh) => clearOfDiscs(i, x, y, bw, bh) }, want: false, at: [0, 0, 0] };
          names.set(w.record.id, n);
        }
        n.want = true;
        n.label.rank = rank;
      }
    }
    // (The labels themselves are written only as they are handed over, in labels(): the explorer lays
    // them out and draws them between this frame's update and the next.)
    labelList.length = 0;
    for (const [id, n] of names) {
      // Shown, or still fading out (the explorer eases it: its opacity is what it drew last frame).
      if (!n.want && n.label.opacity < 1e-3) continue;
      const w = bodies.byId(id);
      if (!w) continue;
      // At the limb of a disc, at the centre of a point (as the explorer's own names).
      const limb = w.radiusKm * w.k * 1.08 * smooth(NAMES.limbPx[0], NAMES.limbPx[1], w.radiusPx);
      n.at[0] = w.drawn.x + right.x * limb;
      n.at[1] = w.drawn.y + right.y * limb;
      n.at[2] = w.drawn.z + right.z * limb;
      labelList.push(n);
    }
  };

  const worlds: Worlds = {
    object,
    advance(jd) {
      bodies.advance(jd);
    },
    nearestKm(camera) {
      let lowest = Infinity;
      for (const w of bodies.list) {
        const d = Math.hypot(w.position.x - camera.x, w.position.y - camera.y, w.position.z - camera.z) - w.radiusKm;
        if (d < lowest) lowest = d;
      }
      return lowest;
    },
    update(frame) {
      const dt = frame.dt;
      const ease = dt > 0 ? 1 - Math.exp(-dt / FADE_SECONDS) : 1;
      lastView = frame.view;
      seen += ((frame.shown ? 1 : 0) - seen) * ease;
      if (seen < 1e-3 && !frame.shown) seen = 0;
      layer += ((layerOn && frame.shown ? 1 : 0) - layer) * ease;
      groupedFade += ((grouped ? 1 : 0) - groupedFade) * ease;
      arrangedFade += ((arranged ? 1 : 0) - arrangedFade) * ease;
      // (Arranged, exactly: the diagram's points at their orbits' sizes once the change has eased out.)
      if (Math.abs(arrangedFade - (arranged ? 1 : 0)) < 1e-3) arrangedFade = arranged ? 1 : 0;
      marked = smooth(Math.log(MARKED_SPAN_KM[0]), Math.log(MARKED_SPAN_KM[1]), Math.log(Math.max(frame.span, 1)));
      const days = frame.jdTdb - manifest.epochJdTdb;
      lastDays = days;
      const crowd = Math.min(1, (CROWD.fromKm / Math.max(frame.span, 1)) ** CROWD.power);
      belt?.update({ days, cameraKm: frame.camera, auKm, far: frame.far, compensation: frame.compensation, marked: marked * crowd, grouped: groupedFade, arranged: arrangedFade, fade: layer });
      bodies.update({
        camera: frame.camera,
        view: frame.view,
        far: frame.far,
        pxPerTan: frame.pxPerTan,
        widthPx: frame.widthPx,
        heightPx: frame.heightPx,
        compensation: frame.compensation,
        layer,
        marked,
        shown: seen > 1e-3,
        fade: seen,
        focus: frame.focus,
        dt,
        days: frame.days,
        running: frame.running,
        reduced: frame.reduced,
      });
      const focusWorld = frame.focus.startsWith('w:') ? bodies.byId(frame.focus as WorldId) : undefined;
      comets.update({ jd: frame.jdTdb, focus: focusWorld?.record.kind === 'comet' ? focusWorld.record.name : null, camera: frame.camera, far: frame.far, compensation: frame.compensation, fade: layer, marked: marked * crowd });
      // Uranus's and Neptune's rings, in their planets' equators, where their discs are more than a few pixels.
      for (const id of ['uranus', 'neptune'] as const) {
        const rings = iceRings[id];
        const p = frame.placed[id];
        const mesh = rings.object;
        mesh.visible = seen > 1e-3 && p.radiusPx > 2;
        if (!mesh.visible) continue;
        const b = system.bodies[id].basis;
        mesh.position.set(p.drawn.x, p.drawn.y, p.drawn.z);
        mesh.scale.setScalar(system.specs[id].radiusKm * p.k);
        mesh.quaternion.setFromRotationMatrix(rotation.set(b[0] ?? 1, b[3] ?? 0, b[6] ?? 0, 0, b[1] ?? 0, b[4] ?? 1, b[7] ?? 0, 0, b[2] ?? 0, b[5] ?? 0, b[8] ?? 1, 0, 0, 0, 0, 1));
        mesh.updateMatrixWorld();
        const pos = system.bodies[id].position;
        const d = Math.hypot(pos.x, pos.y, pos.z) || 1;
        const local = (x: number, y: number, z: number, out: Vector3): Vector3 => out.set(x * (b[0] ?? 0) + y * (b[1] ?? 0) + z * (b[2] ?? 0), x * (b[3] ?? 0) + y * (b[4] ?? 0) + z * (b[5] ?? 0), x * (b[6] ?? 0) + y * (b[7] ?? 0) + z * (b[8] ?? 0));
        local(-pos.x / d, -pos.y / d, -pos.z / d, sunLocal);
        const r = system.specs[id].radiusKm * p.k;
        local(-p.drawn.x / r, -p.drawn.y / r, -p.drawn.z / r, eyeLocal);
        rings.update(sunLocal, eyeLocal, (auKm / d) ** 2 * seen);
      }
      // Shadows: each receiver as drawn, its casters where they are.
      SHADOWS.forEach(({ on }, i) => {
        const r = receivers[i];
        const p = frame.placed[on];
        if (!r) return;
        r.drawn.x = p.drawn.x;
        r.drawn.y = p.drawn.y;
        r.drawn.z = p.drawn.z;
        r.k = p.k;
        r.radiusPx = p.radiusPx;
        r.visible = seen > 1e-3;
      });
      eclipses.update(pairs, system.specs.sun.radiusKm, eclipseList, dt, seen);
      // The Milky Way and the zodiacal light, behind the stars: held with them as the exposure opens,
      // never lifted as it closes; none through the solar filter.
      const pixelDeg = 180 / Math.PI / Math.max(frame.pxPerTan * frame.dpr, 1);
      glow.update({
        radius: frame.far * GLOW_SHARE,
        cameraKm: frame.camera,
        au: Math.hypot(frame.camera.x, frame.camera.y, frame.camera.z) / auKm,
        pixelDeg2: pixelDeg * pixelDeg,
        light: glowLight(frame.compensation, STAR_LIGHT.light, STAR_LIGHT.follow),
        compensation: frame.compensation,
        shown: frame.sky * seen * (1 - frame.filter),
        dt,
      });
      placeNames(frame);
    },
    labels(out) {
      for (const n of labelList) {
        n.label.position = [n.at[0], n.at[1], n.at[2]];
        n.label.opacity = n.want ? NAMES.opacity : 0;
        out.push(n.label);
      }
    },
    nav(id) {
      return id.startsWith('w:') ? (bodies.byId(id as WorldId)?.nav ?? null) : null;
    },
    navList: () => bodies.list.map((w) => w.nav),
    host: hostOf,
    find(name) {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const match = (w: PlacedWorld): boolean => {
        const n = w.record.name.toLowerCase();
        return n === q || w.record.designation.toLowerCase() === q || n.split('/')[0] === q || n.split('/')[1]?.toLowerCase() === q;
      };
      const found = bodies.list.find(match) ?? bodies.list.find((w) => w.record.name.toLowerCase().includes(q));
      return found ? found.record.id : null;
    },
    pick(x, y, nearerKm = Infinity) {
      let best: PlacedWorld | null = null;
      for (const w of bodies.list) {
        if (!w.inView || seen < 0.5 || w.distance >= nearerKm || (w.record.kind !== 'moon' && layer < 0.5)) continue;
        if (Math.hypot(w.screenX - x, w.screenY - y) > Math.max(NAMES.pickPx, w.radiusPx * 1.04)) continue;
        if (!best || w.distance < best.distance) best = w;
      }
      return best ? best.record.id : null;
    },
    held(id) {
      return id.startsWith('w:') ? bodies.held(id as WorldId) : null;
    },
    setDetail(next) {
      wantCount = next.smallBodies;
      // At Low: no sky glow (a pass over the whole view), and the smaller maps.
      glow.setEnabled(next.tier !== 'low');
      bodies.setSmallMaps(next.maxTexture <= 1024);
      void ensureBelt().catch(() => undefined);
    },
    setLayer(on) {
      layerOn = on;
    },
    setGrouped(on) {
      grouped = on;
    },
    setArranged(on) {
      arranged = on;
    },
    view(focus) {
      view.layer = layerOn;
      view.grouped = grouped;
      view.arranged = arranged;
      view.shown = seen;
      view.asteroids = layerOn ? (belt?.count ?? 0) : 0;
      view.asteroidsLoaded = belt?.loaded ?? 0;
      view.gpu.maps = bodies.maps;
      view.gpu.asteroidSlots = beltCapacity;
      if (countedFor !== (belt?.count ?? 0)) {
        countedFor = belt?.count ?? 0;
        countGroups();
      }
      view.comets = layerOn ? comets.shown : 0;
      view.tails = layerOn ? comets.tails : 0;
      const w = focus.startsWith('w:') ? bodies.byId(focus as WorldId) : undefined;
      if (w) {
        const r = w.record;
        // Its own host (Charon's is Pluto), for what it is and the face it keeps.
        const host: FocusId = r.host;
        const f =
          view.focus && view.focus.id === r.id
            ? view.focus
            : (view.focus = { id: r.id, name: r.name, kind: r.kind, host, radiusKm: w.radiusKm, axesKm: [...w.axes], shaped: Array.isArray(r.axesKm) && r.axesKm.length === 3, albedo: r.albedo ?? null, rotationHours: r.rotationHours ?? null, sizeFromH: r.sizeFromH === true, sunAu: 0, eclipsed: 0, unimaged: mapsFile.maps[r.name]?.unimaged ?? 0, map: mapsFile.maps[r.name]?.credit ?? null, screen: { x: 0, y: 0, radiusPx: 0, inView: false } });
        f.sunAu = Math.hypot(w.position.x, w.position.y, w.position.z) / auKm;
        f.eclipsed = 1 - w.share;
        f.screen.x = w.screenX;
        f.screen.y = w.screenY;
        f.screen.radiusPx = w.radiusPx;
        f.screen.inView = w.inView;
      } else view.focus = null;
      return view;
    },
    illustrative(out) {
      if (seen < 0.5) return;
      if (layer > 0.5 && marked > 0.05 && (belt?.count ?? 0) > 0) out.push('small-body-light');
      if (layer > 0.5 && arrangedFade > 0.05 && (belt?.count ?? 0) > 0) out.push('small-body-orbits');
      if (layer > 0.5 && comets.tails > 0) out.push('comet-tails');
      if (iceRings.uranus.object.visible || iceRings.neptune.object.visible) out.push('ring-light');
      if (bodies.meshed > bodies.mapped) out.push('world-shape');
      if (bodies.unimaged > 0) out.push('unimaged');
      if (lastView && glow.seen(lastView)) out.push('sky-glow');
      if (eclipseList.some((e) => e.on === 'moon' && e.depth > 0.6)) out.push('eclipse-red');
    },
    dispose() {
      disposed = true;
      bodies.dispose();
      comets.dispose();
      belt?.dispose();
      iceRings.uranus.dispose();
      iceRings.neptune.dispose();
      eclipses.dispose();
      glow.dispose();
    },
  };
  worlds.setDetail(detail());
  // For the tests (window.__kf, where the app made it): the GPU's own places of the first asteroids,
  // and the date they are for (days after the files' epoch).
  if (window.__kf)
    window.__kf.worlds = {
      probe: async (count, drawn) => {
        const b = belt;
        if (!b || disposed) return { days: 0, places: [] };
        const { probeBelt } = await import('./probe');
        // (The date the uniforms hold now: the probe draws at once, before its first wait.)
        const days = lastDays;
        return { days, places: Array.from(await probeBelt(ctx.renderer, b, count, drawn)) };
      },
    };
  return worlds;
}
