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
 * depth range, and update() with the frame's camera and lens; labels() adds the worlds' names. Nothing
 * here touches the explorer's own bodies: they are read, never changed.
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
import { createSkyGlow, type SkyGlow } from './glow';
import { createIceRings, type IceRings, type RingRow } from './rings';

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
  /** The exposure's adaptation (points and guides are held in display terms). */
  compensation: number;
  /** Not in an experiment, on foot or on the way down (the real sky's worlds only). */
  shown: boolean;
  focus: FocusId;
  /** The camera's distance from what it orbits (km): how wide the view is (the marked light comes in as it widens). */
  span: number;
  dt: number;
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
  /** The worlds' names on screen. */
  labels(out: SceneLabel[]): void;
  /** A world as the navigator orbits it (null: none by that id), and every world (the camera keeps out of them all). */
  nav(id: FocusId): NavBody | null;
  navList(): NavBody[];
  /** The body a world belongs to: its planet (a moon), else the Sun (Pluto's moons too). */
  host(id: FocusId): BodyId;
  /** A world by its name or designation, any case ("ceres", "1", "Halley", "67P"), or null. */
  find(name: string): WorldId | null;
  /** The world under a point of the canvas (CSS px), or null. */
  pick(x: number, y: number): WorldId | null;
  setDetail(detail: ExploreDetail): void;
  setLayer(on: boolean): void;
  setGrouped(on: boolean): void;
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
 * (km: about 0.03 to 1 au); and beyond about 6 au the marked light a point gets falls as the points
 * crowd closer on screen (as the distance to the power 1.1), so the belt seen from far out is a faint
 * band, not a glare (the power 1.1 keeps the Trojans' sparser clouds in sight from the Kuiper belt).
 */
const FADE_SECONDS = 0.4;
const MARKED_SPAN_KM = [4.5e6, 1.5e8] as const;
const CROWD = { fromKm: 9e8, power: 1.1 } as const;
/** The glows' sphere, as a share of the far plane (just inside the stars' 0.98), and the stars' light as ../index gives it (STARS). */
const GLOW_SHARE = 0.97;
const STAR_LIGHT = { light: 0.85, follow: 0.2 } as const;
/** Names: how many at most, how far apart (CSS px), their tag's size, and how close a moon's name may come to its planet's disc. */
const NAMES = { max: 14, widthPx: 84, heightPx: 22, clearOfDiscPx: 10, pickPx: 18 } as const;
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

/** Loads the data and builds the worlds; the asteroid files beyond the first arrive afterwards. */
export async function createWorlds(ctx: UniverseContext, system: SolarSystem, obliquity: number, detail: ExploreDetail): Promise<Worlds> {
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
  const bodies = createWorldBodies(worldsFile.worlds, system, obliquity, mapsFile.maps, (file) => ctx.assets.texture(`${SMALL_BODIES_URL}${file}`));
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
  let wantCount = detail.smallBodies;
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
        const view = new DataView(await ctx.assets.binary(`${SMALL_BODIES_URL}${tier.file}`));
        const start = b.loaded;
        b.append(view, tier.count);
        for (let j = 0; j < tier.count; j += 1) groups[start + j] = BELT_GROUPS.indexOf(GROUP_OF[manifest.classes[view.getUint16(j * 16 + 14, true) & 15] ?? 'AST']);
        beltFiles += 1;
        b.setCount(wantCount);
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
  let grouped = false;
  let groupedFade = 0;
  let marked = 0;
  const names = new Map<WorldId, { label: SceneLabel; opacity: number; want: number }>();
  const labelList: SceneLabel[] = [];
  const taken: Array<{ x: number; y: number }> = [];
  const sunLocal = new Vector3();
  const eyeLocal = new Vector3();
  const rotation = new Matrix4();

  const list: UniverseWorlds['list'] = bodies.list.map((w) => ({ id: w.record.id, name: w.record.name, kind: w.record.kind, host: w.record.host === 'sun' ? 'sun' : (w.record.host as FocusId) }));
  const view: UniverseWorlds = {
    layer: true,
    grouped: false,
    asteroids: 0,
    asteroidsLoaded: 0,
    groups: groupCounts,
    comets: 0,
    tails: 0,
    list,
    focus: null,
    eclipses: eclipseList,
    epochJdTdb: manifest.epochJdTdb,
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

  /** Each world's name: chosen, eased, kept apart from the others and off the ten bodies' discs. */
  const placeNames = (frame: WorldsFrame, dt: number): void => {
    const ease = dt > 0 ? 1 - Math.exp(-dt / 0.3) : 1;
    for (const n of names.values()) n.want = 0;
    taken.length = 0;
    if (frame.shown) {
      const candidates: Array<{ w: PlacedWorld; rank: number }> = [];
      for (const w of bodies.list) {
        if (!w.inView || w.radiusPx > 70) continue;
        const r = w.record;
        const focus = r.id === frame.focus;
        let rank = -1;
        if (focus) rank = 1e9;
        else if (r.kind === 'moon') {
          const host = r.host.startsWith('w:') ? bodies.byId(r.host as WorldId) : null;
          const hostPos = host ? host.position : system.bodies[r.host as BodyId].position;
          const orbit = r.elements.aKm ?? 1;
          const hostDistance = Math.hypot(hostPos.x - frame.camera.x, hostPos.y - frame.camera.y, hostPos.z - frame.camera.z);
          if (hostDistance < orbit * MOON_NAMES_WITHIN) rank = 1e6 + w.radiusKm;
        } else if (layer > 0.5 && (w.distance < SMALL_NAMES_KM || (r.kind === 'dwarf' && marked > 0.5))) rank = 1e3 + w.radiusKm;
        if (rank >= 0) candidates.push({ w, rank });
      }
      candidates.sort((a, b) => b.rank - a.rank);
      for (const { w } of candidates) {
        if (taken.length >= NAMES.max) break;
        const x = w.screenX + 10;
        const y = w.screenY - 10;
        if (x < 0 || y < NAMES.heightPx || x + NAMES.widthPx > frame.widthPx || y > frame.heightPx) continue;
        if (taken.some((t) => Math.abs(t.x - x) < NAMES.widthPx && Math.abs(t.y - y) < NAMES.heightPx)) continue;
        // Never over one of the ten bodies' discs (a moon's name beside its planet, not on it).
        let clear = true;
        for (const id of Object.keys(frame.placed) as BodyId[]) {
          const p = frame.placed[id];
          if (!p.inView || p.distance > w.distance * 4 || p.radiusPx < 2) continue;
          if (Math.hypot(p.screenX - w.screenX, p.screenY - w.screenY) < p.radiusPx + NAMES.clearOfDiscPx) clear = false;
        }
        if (!clear) continue;
        taken.push({ x, y });
        let n = names.get(w.record.id);
        if (!n) {
          n = { label: { id: `world-${w.record.name}`, textKey: '', text: w.record.name, position: [0, 0, 0], opacity: 0, offset: [10, -10] }, opacity: 0, want: 0 };
          names.set(w.record.id, n);
        }
        n.want = 1;
      }
    }
    labelList.length = 0;
    for (const [id, n] of names) {
      n.opacity += (n.want - n.opacity) * (n.want > n.opacity ? ease : Math.min(1, ease * 3));
      if (n.opacity < 0.01 && n.want === 0) continue;
      const w = bodies.byId(id);
      if (!w) continue;
      n.label.position = [w.drawn.x, w.drawn.y, w.drawn.z];
      n.label.opacity = n.opacity * 0.92;
      labelList.push(n.label);
    }
  };

  return {
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
      layer += ((layerOn && frame.shown ? 1 : 0) - layer) * ease;
      groupedFade += ((grouped ? 1 : 0) - groupedFade) * ease;
      marked = smooth(Math.log(MARKED_SPAN_KM[0]), Math.log(MARKED_SPAN_KM[1]), Math.log(Math.max(frame.span, 1)));
      const days = frame.jdTdb - manifest.epochJdTdb;
      const crowd = Math.min(1, (CROWD.fromKm / Math.max(frame.span, 1)) ** CROWD.power);
      belt?.update({ days, cameraKm: frame.camera, auKm, far: frame.far, compensation: frame.compensation, marked: marked * crowd, grouped: groupedFade, fade: layer });
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
        shown: frame.shown,
        focus: frame.focus,
      });
      comets.update({ jd: frame.jdTdb, camera: frame.camera, far: frame.far, compensation: frame.compensation, fade: layer, marked: marked * crowd });
      // Uranus's and Neptune's rings, in their planets' equators, where their discs are more than a few pixels.
      for (const id of ['uranus', 'neptune'] as const) {
        const rings = iceRings[id];
        const p = frame.placed[id];
        const mesh = rings.object;
        mesh.visible = frame.shown && p.radiusPx > 2;
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
        rings.update(sunLocal, eyeLocal, (auKm / d) ** 2);
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
        r.visible = frame.shown;
      });
      eclipses.update(pairs, system.specs.sun.radiusKm, eclipseList);
      // The Milky Way and the zodiacal light, behind the stars, held in display terms with them (../index STARS).
      const pixelDeg = 180 / Math.PI / Math.max(frame.pxPerTan * frame.dpr, 1);
      const fromSunAu = Math.hypot(frame.camera.x, frame.camera.y, frame.camera.z) / auKm;
      glow.update(frame.far * GLOW_SHARE, frame.camera, fromSunAu, pixelDeg * pixelDeg, STAR_LIGHT.light * Math.max(frame.compensation, 1e-4) ** (STAR_LIGHT.follow - 1), frame.sky);
      placeNames(frame, dt);
    },
    labels(out) {
      for (const l of labelList) out.push(l);
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
    pick(x, y) {
      let best: PlacedWorld | null = null;
      for (const w of bodies.list) {
        if (!w.inView || (w.record.kind !== 'moon' && layer < 0.5)) continue;
        if (Math.hypot(w.screenX - x, w.screenY - y) > Math.max(NAMES.pickPx, w.radiusPx * 1.04)) continue;
        if (!best || w.distance < best.distance) best = w;
      }
      return best ? best.record.id : null;
    },
    setDetail(next) {
      wantCount = next.smallBodies;
      void ensureBelt().catch(() => undefined);
    },
    setLayer(on) {
      layerOn = on;
    },
    setGrouped(on) {
      grouped = on;
    },
    view(focus) {
      view.layer = layerOn;
      view.grouped = grouped;
      view.asteroids = layerOn ? (belt?.count ?? 0) : 0;
      view.asteroidsLoaded = belt?.loaded ?? 0;
      if (countedFor !== (belt?.count ?? 0)) {
        countedFor = belt?.count ?? 0;
        countGroups();
      }
      view.comets = layerOn ? comets.shown : 0;
      view.tails = layerOn ? comets.tails : 0;
      const w = focus.startsWith('w:') ? bodies.byId(focus as WorldId) : undefined;
      if (w) {
        const r = w.record;
        const f = view.focus && view.focus.id === r.id ? view.focus : (view.focus = { id: r.id, name: r.name, kind: r.kind, host: hostOf(r.id), radiusKm: w.radiusKm, axesKm: [...w.axes], albedo: r.albedo ?? null, rotationHours: r.rotationHours ?? null, sizeFromH: r.sizeFromH === true, sunAu: 0, eclipsed: 0, map: mapsFile.maps[r.name]?.credit ?? null });
        f.sunAu = Math.hypot(w.position.x, w.position.y, w.position.z) / auKm;
        f.eclipsed = 1 - w.share;
      } else view.focus = null;
      return view;
    },
    illustrative(out) {
      if (layer > 0.5 && marked > 0.05 && (belt?.count ?? 0) > 0) out.push('small-body-light');
      if (layer > 0.5 && comets.tails > 0) out.push('comet-tails');
      if (iceRings.uranus.object.visible || iceRings.neptune.object.visible) out.push('ring-light');
      if (bodies.meshed > bodies.mapped) out.push('world-shape');
      if (glow.object.visible) out.push('sky-glow');
      if (eclipseList.some((e) => e.on === 'moon' && e.depth > 0.6)) out.push('eclipse-red');
    },
    dispose() {
      bodies.dispose();
      comets.dispose();
      belt?.dispose();
      iceRings.uranus.dispose();
      iceRings.neptune.dispose();
      eclipses.dispose();
      glow.dispose();
    },
  };
}
