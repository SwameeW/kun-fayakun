import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Line,
  LineBasicNodeMaterial,
  Matrix3,
  PointsNodeMaterial,
  Sprite,
  Vector3,
  type Node,
} from 'three/webgpu';
import { attribute, clamp, dot, exp, float, instancedBufferAttribute, length, max, mix, select, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import type { SceneLabel } from '../../core/types';
import { subPoint } from '../field-notes/bulletin';
import { KIND_COLOURS, SATELLITE_KINDS, SatelliteKind, STATION_IDS, type SatelliteKindName, type StationId } from './satellite-kinds';
import type { SatelliteReply, SatelliteRequest } from './satellites.worker';

/**
 * Every active satellite, live: CelesTrak's catalogue of active objects (about sixteen thousand)
 * propagated by SGP4 in a worker (./satellites.worker) and drawn as points of light around the Earth,
 * bright where the Sun lights them and faint in the Earth's shadow, coloured by kind
 * (./satellite-kinds). The crewed stations are named; any point can be chosen (pick), which names it,
 * draws its orbit (one revolution, Earth-fixed) and gives its height and period.
 *
 * The catalogue is fetched at most once per browser per FRESH_HOURS (CelesTrak updates its elements
 * a few times a day, asks not to be fetched more often, and refuses a repeat download from the same
 * address within its update window), kept in Cache Storage. When CelesTrak declines or cannot be
 * reached, the snapshot each deploy of the site fetches (assets/live/active.tle, its first line
 * "#fetched <ISO time>") serves instead, then any stale cached copy. Positions are for the explorer's own instant, so they are shown only
 * within DAYS_VALID of the catalogue's fetch (elements a week old drift by many kilometres).
 */

const CATALOGUE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const CACHE_NAME = 'kf-celestrak';
const FRESH_HOURS = 6;
const DAYS_VALID = 3;
/**
 * A state further than this from the explorer's instant (ms of explorer time: after a jump in time,
 * or with time racing ahead of the worker) is not drawn until a fresh one arrives; and the chosen
 * satellite's orbit line is drawn again each time the clock moves this share of its period.
 */
const STALE_MS = 120_000;
const PATH_REFRESH_SHARE = 1 / 24;
/** Seconds between the worker's fresh states (the GPU extrapolates between them). */
const TICK_SECONDS = 1;
/** Screen sizes (px) of a station and of everything else, and the most a point is brightened. */
const SIZE = { station: 7, other: 2.4 } as const;
/** Samples along a chosen satellite's orbit line. */
const PATH_SAMPLES = 181;
/**
 * Seen from afar the low orbits crowd into a few pixels around the Earth, and sixteen thousand points
 * of light added together would glow like a halo: beyond this many Earth radii each point (but a
 * station's) dims with distance, to no less than FAR_DIM_FLOOR of its brightness.
 */
const FAR_DIM_FROM_RADII = 4;
const FAR_DIM_FLOOR = 0.15;

export interface SatelliteFrame {
  /** The explorer's instant (Unix ms). */
  unixMs: number;
  /** The Earth's centre relative to the camera (render frame, km) and its frame's axes (9 numbers: columns x, y, z). */
  earth: { x: number; y: number; z: number };
  basis: readonly number[];
  /** Unit direction from the Earth to the Sun (render frame). */
  sun: { x: number; y: number; z: number };
  earthRadiusKm: number;
  /** Show the layer (on, and the Earth near enough to see it). */
  visible: boolean;
}

export interface SatelliteInfo {
  index: number;
  /** The catalogue's name, and for a crewed station its id (the interface names it plainly). */
  name: string;
  station: StationId | null;
  norad: number;
  kind: SatelliteKindName;
  /** The point beneath it (degrees), and its height above a sphere of the Earth's mean radius. */
  lat: number;
  lon: number;
  altitudeKm: number;
  periodMin: number;
  sunlit: boolean;
}

export interface SatelliteStatus {
  state: 'off' | 'loading' | 'ready' | 'failed' | 'out-of-range';
  count: number;
  byKind: Record<SatelliteKindName, number>;
  /** How many are in sunlight now (outside the Earth's shadow), as of the latest state. */
  sunlit: number;
  /** When the catalogue was fetched (Unix ms; 0 before). */
  fetchedMs: number;
}

export interface SatelliteLayer {
  readonly objects: readonly (Sprite | Line)[];
  /** Turns the layer on (loading the catalogue the first time) or off. */
  setOn(on: boolean): void;
  update(frame: SatelliteFrame): void;
  /** The satellite nearest a screen point within `radiusPx`, given a projection to CSS px (null: none). */
  pick(x: number, y: number, radiusPx: number, project: (p: Vector3) => { x: number; y: number; front: boolean }): number | null;
  select(index: number | null): void;
  readonly selected: SatelliteInfo | null;
  /** The International Space Station, while it is in the catalogue. */
  readonly station: SatelliteInfo | null;
  readonly status: SatelliteStatus;
  /** Labels for the stations and the chosen satellite (camera-relative positions). */
  labels(): SceneLabel[];
  /** The Earth's rotation rate (rad/s, from the rotation model) before the first load. */
  setEarthRotation(omega: number): void;
  dispose(): void;
}

/** The site's own snapshot of the catalogue (fetched when the site was deployed), or null without one. */
async function fetchSnapshot(url: string): Promise<{ text: string; fetchedMs: number } | null> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const text = await response.text();
    const stamp = /^#fetched (\S+)/u.exec(text);
    const fetchedMs = stamp?.[1] ? Date.parse(stamp[1]) : Number.NaN;
    return Number.isFinite(fetchedMs) && text.includes('\n1 ') ? { text, fetchedMs } : null;
  } catch {
    return null;
  }
}

async function fetchCatalogue(snapshotUrl: string): Promise<{ text: string; fetchedMs: number }> {
  let stale: { text: string; fetchedMs: number } | null = null;
  let cache: Cache | null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(CATALOGUE_URL);
    if (hit) {
      const fetchedMs = Number(hit.headers.get('x-kf-fetched') ?? 0);
      const text = await hit.text();
      if (Date.now() - fetchedMs < FRESH_HOURS * 3_600_000) return { text, fetchedMs };
      stale = { text, fetchedMs };
    }
  } catch {
    cache = null;
  }
  try {
    const response = await fetch(CATALOGUE_URL, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const fetchedMs = Date.now();
    await cache?.put(CATALOGUE_URL, new Response(text, { headers: { 'x-kf-fetched': String(fetchedMs), 'content-type': 'text/plain' } })).catch(() => undefined);
    return { text, fetchedMs };
  } catch (err) {
    const snapshot = await fetchSnapshot(snapshotUrl);
    // The fresher of the site's snapshot and the stale cached copy.
    if (snapshot && (!stale || snapshot.fetchedMs > stale.fetchedMs)) return snapshot;
    if (stale) return stale;
    throw err;
  }
}

/** `snapshotUrl`: the site's snapshot of the catalogue (resolved against the deployed base). */
export function createSatelliteLayer(snapshotUrl: string): SatelliteLayer {
  let worker: Worker | null = null;
  let on = false;
  let count = 0;
  let names: string[] = [];
  let ids: Int32Array = new Int32Array(0);
  let kinds: Uint8Array = new Uint8Array(0);
  let periods: Float32Array = new Float32Array(0);
  /** The latest state (Earth-fixed km and km/s, 6 per object) and its instant. */
  let latest: Float32Array = new Float32Array(0);
  let latestMs = 0;
  let pendingTick = false;
  let lastAsked = -Infinity;
  let omega = 0;
  let selectedIndex: number | null = null;
  /** When the chosen satellite's orbit line was asked for (explorer ms), and whether it is on its way. */
  let pathAt = 0;
  let pathPending = false;
  /** The crewed stations' indices (by id) once the catalogue is read. */
  let stationIndex: Partial<Record<StationId, number>> = {};
  let frameNow: SatelliteFrame | null = null;
  const status: SatelliteStatus = {
    state: 'off',
    count: 0,
    byKind: Object.fromEntries(SATELLITE_KINDS.map((k) => [k, 0])) as Record<SatelliteKindName, number>,
    sunlit: 0,
    fetchedMs: 0,
  };

  // The points: a quad per object, placed by the GPU from its Earth-fixed state and the Earth's frame.
  const uDt = uniform(0);
  const uEarth = uniform(new Vector3());
  const uBasis = uniform(new Matrix3());
  const uSun = uniform(new Vector3(1, 0, 0));
  const uRadius = uniform(6371);
  const uFade = uniform(0);
  let positions = new InstancedBufferAttribute(new Float32Array(3), 3);
  let velocities = new InstancedBufferAttribute(new Float32Array(3), 3);
  let kindAttr = new InstancedBufferAttribute(new Float32Array(1), 1);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, sizeAttenuation: false, fog: false });
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const points = new Sprite(material);
  points.geometry = geometry;
  points.count = 0;
  points.frustumCulled = false;
  points.name = 'explore-satellites';
  points.visible = false;
  points.renderOrder = 2;

  const colourOf = (k: Node<'float'>): Node<'vec3'> => {
    let c: Node<'vec3'> = vec3(...KIND_COLOURS.other);
    SATELLITE_KINDS.forEach((name, i) => {
      c = select(k.equal(i), vec3(...KIND_COLOURS[name]), c);
    });
    return c;
  };
  const bindMaterial = (): void => {
    const p = instancedBufferAttribute(positions) as unknown as Node<'vec3'>;
    const v = instancedBufferAttribute(velocities) as unknown as Node<'vec3'>;
    const k = instancedBufferAttribute(kindAttr) as unknown as Node<'float'>;
    const e = p.add(v.mul(uDt));
    // Earth-fixed (x Greenwich, y 90 E, z north) to the Earth's frame (x Greenwich, y north, z toward 90 W), then to render.
    const fromCentre = uBasis.mul(vec3(e.x, e.z, e.y.negate()));
    material.positionNode = uEarth.add(fromCentre);
    const hidden = k.greaterThan(SATELLITE_KINDS.length - 0.5);
    material.sizeNode = select(hidden, float(0), select(k.equal(SatelliteKind.station), float(SIZE.station), float(SIZE.other)));
    // In the Earth's shadow (a cylinder behind it, softened at its edge): faint, not gone, so the orbits still read.
    const along = dot(fromCentre, uSun);
    const off = length(fromCentre.sub(uSun.mul(along)));
    const shadowed = smoothstep(0, -50, along).mul(float(1).sub(smoothstep(uRadius.mul(0.995), uRadius.mul(1.01), off)));
    const far = clamp(uRadius.mul(FAR_DIM_FROM_RADII).div(max(length(uEarth), 1)), FAR_DIM_FLOOR, 1);
    const light = mix(float(1), float(0.12), shadowed).mul(select(k.equal(SatelliteKind.station), float(1), far));
    const c = uv().sub(0.5).mul(2);
    const r2 = dot(c, c);
    const glow = exp(r2.mul(-4)).mul(max(float(1).sub(r2), 0));
    material.colorNode = colourOf(k).mul(glow).mul(light).mul(uFade);
    material.opacityNode = float(1);
    material.needsUpdate = true;
  };
  bindMaterial();

  // The chosen satellite's orbit: Earth-fixed samples, placed the same way.
  const pathPositions = new Float32Array(PATH_SAMPLES * 3);
  const pathGeometry = new BufferGeometry();
  pathGeometry.setAttribute('position', new BufferAttribute(pathPositions, 3));
  const pathMaterial = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, fog: false });
  const local = attribute('position', 'vec3') as unknown as Node<'vec3'>;
  pathMaterial.positionNode = uEarth.add(uBasis.mul(vec3(local.x, local.z, local.y.negate())));
  pathMaterial.colorNode = vec3(1, 0.85, 0.5).mul(0.55).mul(uFade);
  const path = new Line(pathGeometry, pathMaterial);
  path.frustumCulled = false;
  path.visible = false;
  path.name = 'explore-satellite-path';

  const ask = (msg: SatelliteRequest, transfer: Transferable[] = []): void => {
    worker?.postMessage(msg, transfer);
  };

  const start = (): void => {
    if (worker || status.state === 'loading') return;
    status.state = 'loading';
    fetchCatalogue(snapshotUrl)
      .then(({ text, fetchedMs }) => {
        status.fetchedMs = fetchedMs;
        worker = new Worker(new URL('./satellites.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<SatelliteReply>) => {
          const msg = event.data;
          if (msg.type === 'ready') {
            count = msg.count;
            names = msg.names;
            ids = msg.ids;
            kinds = msg.kinds;
            periods = msg.periodsMin;
            positions = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
            velocities = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
            kindAttr = new InstancedBufferAttribute(new Float32Array(count), 1);
            positions.setUsage(DynamicDrawUsage);
            velocities.setUsage(DynamicDrawUsage);
            bindMaterial();
            points.count = count;
            status.count = count;
            stationIndex = {};
            names.forEach((n, i) => {
              const id = STATION_IDS[n.toUpperCase()];
              if (id && stationIndex[id] === undefined) stationIndex[id] = i;
            });
            for (const k of SATELLITE_KINDS) status.byKind[k] = 0;
            for (const k of kinds) {
              const name = SATELLITE_KINDS[k];
              if (name) status.byKind[name] += 1;
            }
            status.state = 'ready';
            lastAsked = -Infinity;
          } else if (msg.type === 'state') {
            pendingTick = false;
            latest = msg.data;
            latestMs = msg.unixMs;
            const p = positions.array as Float32Array;
            const v = velocities.array as Float32Array;
            const k = kindAttr.array as Float32Array;
            for (let i = 0; i < count; i += 1) {
              const o = i * 6;
              const x = latest[o] ?? Number.NaN;
              if (Number.isFinite(x)) {
                p[i * 3] = x;
                p[i * 3 + 1] = latest[o + 1] ?? 0;
                p[i * 3 + 2] = latest[o + 2] ?? 0;
                v[i * 3] = latest[o + 3] ?? 0;
                v[i * 3 + 1] = latest[o + 4] ?? 0;
                v[i * 3 + 2] = latest[o + 5] ?? 0;
                k[i] = kinds[i] ?? SatelliteKind.other;
              } else {
                k[i] = 255;
              }
            }
            positions.needsUpdate = true;
            velocities.needsUpdate = true;
            kindAttr.needsUpdate = true;
            status.sunlit = countSunlit();
          } else if (msg.type === 'path') {
            pathPending = false;
            if (msg.index !== selectedIndex) return;
            pathPositions.set(msg.data.subarray(0, pathPositions.length));
            (pathGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
            path.visible = true;
          } else {
            console.warn('explore: satellite propagation failed', msg.message);
          }
        };
        ask({ type: 'init', tle: text, omega });
      })
      .catch((err: unknown) => {
        status.state = 'failed';
        console.warn('explore: the satellite catalogue could not be loaded', err);
      });
  };

  /** A satellite's camera-relative position now (render frame), from the latest state carried along. */
  const placeOf = (index: number, frame: SatelliteFrame, out: Vector3): Vector3 | null => {
    const o = index * 6;
    const x0 = latest[o];
    if (x0 === undefined || !Number.isFinite(x0)) return null;
    const dt = (frame.unixMs - latestMs) / 1000;
    const x = x0 + (latest[o + 3] ?? 0) * dt;
    const y = (latest[o + 1] ?? 0) + (latest[o + 4] ?? 0) * dt;
    const z = (latest[o + 2] ?? 0) + (latest[o + 5] ?? 0) * dt;
    const m = frame.basis;
    // Earth-fixed to the Earth's frame (x, z, -y), then by its axes.
    const bx = x;
    const by = z;
    const bz = -y;
    out.set(
      frame.earth.x + bx * (m[0] ?? 1) + by * (m[3] ?? 0) + bz * (m[6] ?? 0),
      frame.earth.y + bx * (m[1] ?? 0) + by * (m[4] ?? 1) + bz * (m[7] ?? 0),
      frame.earth.z + bx * (m[2] ?? 0) + by * (m[5] ?? 0) + bz * (m[8] ?? 1),
    );
    return out;
  };

  const scratch = new Vector3();
  const label = (index: number, frame: SatelliteFrame, id: string): SceneLabel | null => {
    const p = placeOf(index, frame, scratch);
    if (!p) return null;
    const name = names[index] ?? '';
    // A crewed station by its plain name (the catalogue's names the module that carries its elements).
    const station = STATION_IDS[name.toUpperCase()];
    const base = { id, position: [p.x, p.y, p.z] as [number, number, number], opacity: 0.92 * uFade.value, offset: [10, -10] as [number, number] };
    return station ? { ...base, textKey: `ui.universe.station.${station}` } : { ...base, textKey: 'ui.universe.satellite', text: name };
  };

  /** The Sun's direction in the Earth-fixed frame (x Greenwich, y 90 E, z north), from the frame's. */
  const sunFixed = (frame: SatelliteFrame): [number, number, number] => {
    const m = frame.basis;
    const s = frame.sun;
    const bx = (m[0] ?? 1) * s.x + (m[1] ?? 0) * s.y + (m[2] ?? 0) * s.z;
    const by = (m[3] ?? 0) * s.x + (m[4] ?? 1) * s.y + (m[5] ?? 0) * s.z;
    const bz = (m[6] ?? 0) * s.x + (m[7] ?? 0) * s.y + (m[8] ?? 1) * s.z;
    return [bx, -bz, by];
  };

  /** How many objects of the latest state are outside the Earth's shadow cylinder (the points' test). */
  const countSunlit = (): number => {
    const frame = frameNow;
    if (!frame) return 0;
    const [sx, sy, sz] = sunFixed(frame);
    const r = frame.earthRadiusKm;
    let lit = 0;
    for (let i = 0; i < count; i += 1) {
      const o = i * 6;
      const x = latest[o] ?? Number.NaN;
      if (!Number.isFinite(x)) continue;
      const y = latest[o + 1] ?? 0;
      const z = latest[o + 2] ?? 0;
      const along = x * sx + y * sy + z * sz;
      if (along >= 0 || Math.hypot(x - sx * along, y - sy * along, z - sz * along) >= r) lit += 1;
    }
    return lit;
  };

  const info = (index: number | null): SatelliteInfo | null => {
    const frame = frameNow;
    if (index === null || !frame) return null;
    const o = index * 6;
    const x = latest[o];
    if (x === undefined || !Number.isFinite(x)) return null;
    const dt = (frame.unixMs - latestMs) / 1000;
    const px = x + (latest[o + 3] ?? 0) * dt;
    const py = (latest[o + 1] ?? 0) + (latest[o + 4] ?? 0) * dt;
    const pz = (latest[o + 2] ?? 0) + (latest[o + 5] ?? 0) * dt;
    const r = Math.hypot(px, py, pz);
    // Sunlit unless inside the Earth's shadow cylinder (the same test as the points').
    const p = placeOf(index, frame, scratch);
    let sunlit = true;
    if (p) {
      const cx = p.x - frame.earth.x;
      const cy = p.y - frame.earth.y;
      const cz = p.z - frame.earth.z;
      const along = cx * frame.sun.x + cy * frame.sun.y + cz * frame.sun.z;
      const off = Math.hypot(cx - frame.sun.x * along, cy - frame.sun.y * along, cz - frame.sun.z * along);
      sunlit = !(along < 0 && off < frame.earthRadiusKm);
    }
    const name = names[index] ?? '';
    const under = subPoint(px, py, pz);
    return {
      index,
      name,
      station: STATION_IDS[name.toUpperCase()] ?? null,
      norad: ids[index] ?? 0,
      kind: SATELLITE_KINDS[kinds[index] ?? SatelliteKind.other] ?? 'other',
      lat: under.lat,
      lon: under.lon,
      altitudeKm: r - frame.earthRadiusKm,
      periodMin: periods[index] ?? 0,
      sunlit,
    };
  };

  return {
    objects: [points, path],
    setOn(next) {
      on = next;
      if (on) start();
    },
    setEarthRotation(next) {
      omega = next;
    },
    update(frame) {
      frameNow = frame;
      const fresh = status.fetchedMs > 0 && Math.abs(frame.unixMs - status.fetchedMs) < DAYS_VALID * 86_400_000;
      if (status.state === 'ready' || status.state === 'out-of-range') status.state = fresh ? 'ready' : 'out-of-range';
      const live = on && frame.visible && status.state === 'ready';
      // Fresh states as fast as the worker gives them (about once a second at real time; every reply when time runs fast).
      if (live && worker && !pendingTick && Math.abs(frame.unixMs - lastAsked) >= TICK_SECONDS * 1000) {
        pendingTick = true;
        lastAsked = frame.unixMs;
        ask({ type: 'tick', unixMs: frame.unixMs });
      }
      const period = selectedIndex === null ? 0 : (periods[selectedIndex] ?? 0) * 60_000;
      if (live && selectedIndex !== null && !pathPending && period > 0 && Math.abs(frame.unixMs - pathAt) > period * PATH_REFRESH_SHARE) {
        pathPending = true;
        pathAt = frame.unixMs;
        ask({ type: 'path', index: selectedIndex, unixMs: frame.unixMs, samples: PATH_SAMPLES });
      }
      const show = live && Math.abs(frame.unixMs - latestMs) <= STALE_MS;
      // Faded in and out (never a pop of sixteen thousand points).
      uFade.value += ((show ? 1 : 0) - uFade.value) * 0.12;
      if (uFade.value < 0.002 && !show) uFade.value = 0;
      points.visible = uFade.value > 0;
      path.visible = points.visible && selectedIndex !== null && path.visible;
      if (!points.visible) return;
      uEarth.value.set(frame.earth.x, frame.earth.y, frame.earth.z);
      const m = frame.basis;
      uBasis.value.set(m[0] ?? 1, m[3] ?? 0, m[6] ?? 0, m[1] ?? 0, m[4] ?? 1, m[7] ?? 0, m[2] ?? 0, m[5] ?? 0, m[8] ?? 1);
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z);
      uRadius.value = frame.earthRadiusKm;
      uDt.value = (frame.unixMs - latestMs) / 1000;
    },
    pick(x, y, radiusPx, project) {
      const frame = frameNow;
      if (!frame || !points.visible || count === 0) return null;
      let best: number | null = null;
      let bestD = radiusPx;
      const p = new Vector3();
      for (let i = 0; i < count; i += 1) {
        if (!placeOf(i, frame, p)) continue;
        const s = project(p);
        if (!s.front) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    },
    select(index) {
      selectedIndex = index;
      path.visible = false;
      if (index !== null && frameNow) {
        pathPending = true;
        pathAt = frameNow.unixMs;
        ask({ type: 'path', index, unixMs: frameNow.unixMs, samples: PATH_SAMPLES });
      }
    },
    get selected() {
      return info(selectedIndex);
    },
    get station() {
      return info(stationIndex.iss ?? null);
    },
    status,
    labels() {
      const frame = frameNow;
      if (!frame || !points.visible) return [];
      const out: SceneLabel[] = [];
      kinds.forEach((k, i) => {
        if (k !== SatelliteKind.station || i === selectedIndex) return;
        const l = label(i, frame, `satellite-${i}`);
        if (l) out.push(l);
      });
      if (selectedIndex !== null) {
        const l = label(selectedIndex, frame, `satellite-${selectedIndex}`);
        if (l) out.push(l);
      }
      return out;
    },
    dispose() {
      worker?.terminate();
      worker = null;
      geometry.dispose();
      material.dispose();
      pathGeometry.dispose();
      pathMaterial.dispose();
    },
  };
}
