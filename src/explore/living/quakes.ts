import { AdditiveBlending, BufferAttribute, BufferGeometry, InstancedBufferAttribute, Matrix3, PointsNodeMaterial, Sprite, Vector3, type Node } from 'three/webgpu';
import { dot, float, instancedBufferAttribute, max, mix, normalize, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import type { SceneLabel } from '../../core/types';

/**
 * The Earth's earthquakes of the past day, live from the U.S. Geological Survey (public domain): every
 * event of magnitude 2.5 and above in the USGS summary feed, refreshed every REFRESH_MINUTES while
 * the layer is on. Each is a ring at its epicentre, sized by magnitude, warm for shallow events and
 * cool for deep ones, fading with age through the day. Events in the last hour breathe slowly (a gentle
 * swell, never a flash; still with reduced motion). The rings stand just above the ground and hide
 * when the epicentre turns away over the horizon.
 */

const FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const REFRESH_MINUTES = 5;
/** Ring sizes (px): at the feed's threshold and for each magnitude above it. */
const RING = { basePx: 7, perMagnitudePx: 5, maxPx: 46 } as const;
/** Depth (km) that reads as deep (the colour's far end), the swell's period (s) and how much it grows. */
const DEPTH_DEEP_KM = 300;
const SWELL = { seconds: 3.2, amount: 0.22 } as const;

export interface Quake {
  id: string;
  magnitude: number;
  lat: number;
  lon: number;
  depthKm: number;
  timeMs: number;
  /** The USGS's own description of where (e.g. "12 km SW of ..."). */
  place: string;
  url: string;
}

export interface QuakeFrame {
  unixMs: number;
  earth: { x: number; y: number; z: number };
  basis: readonly number[];
  earthRadiusKm: number;
  visible: boolean;
  /** Seconds of the swell's clock (stops with reduced motion). */
  time: number;
  reducedMotion: boolean;
}

export interface QuakeLayer {
  readonly object: Sprite;
  setOn(on: boolean): void;
  update(frame: QuakeFrame): void;
  readonly quakes: readonly Quake[];
  readonly status: { state: 'off' | 'loading' | 'ready' | 'failed'; fetchedMs: number };
  /** A label on the strongest event of the day. */
  labels(): SceneLabel[];
  dispose(): void;
}

interface GeoJson {
  features?: Array<{ id?: string; properties?: { mag?: number; time?: number; place?: string; url?: string }; geometry?: { coordinates?: number[] } }>;
}

export function parseQuakes(json: GeoJson): Quake[] {
  const out: Quake[] = [];
  for (const f of json.features ?? []) {
    const [lon, lat, depth] = f.geometry?.coordinates ?? [];
    const mag = f.properties?.mag;
    if (typeof lon !== 'number' || typeof lat !== 'number' || typeof mag !== 'number') continue;
    out.push({
      id: f.id ?? `${lat},${lon},${f.properties?.time ?? 0}`,
      magnitude: mag,
      lat,
      lon,
      depthKm: typeof depth === 'number' ? depth : 0,
      timeMs: f.properties?.time ?? 0,
      place: f.properties?.place ?? '',
      url: f.properties?.url ?? '',
    });
  }
  return out.sort((a, b) => b.magnitude - a.magnitude);
}

/** A place on the Earth (degrees) in its own frame (x Greenwich, y north, z toward 90 W), radius `r`. */
export function bodyFrame(latDeg: number, lonDeg: number, r: number, out: Vector3): Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return out.set(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lon));
}

export function createQuakeLayer(): QuakeLayer {
  let on = false;
  let quakes: Quake[] = [];
  let timer = 0;
  const status: QuakeLayer['status'] = { state: 'off', fetchedMs: 0 };
  const uEarth = uniform(new Vector3());
  const uBasis = uniform(new Matrix3());
  const uTime = uniform(0);
  const uFade = uniform(0);
  const uSwell = uniform(1);
  let positions = new InstancedBufferAttribute(new Float32Array(3), 3);
  // magnitude, depth (km), age (hours)
  let props = new InstancedBufferAttribute(new Float32Array(3), 3);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const rings = new Sprite(material);
  rings.geometry = geometry;
  rings.count = 0;
  rings.frustumCulled = false;
  rings.visible = false;
  rings.name = 'explore-quakes';
  rings.renderOrder = 3;

  const bind = (): void => {
    const p = instancedBufferAttribute(positions) as unknown as Node<'vec3'>;
    const q = instancedBufferAttribute(props) as unknown as Node<'vec3'>;
    const world = uEarth.add(uBasis.mul(p));
    material.positionNode = world;
    const recent = float(1).sub(smoothstep(0.5, 1, q.z));
    const swell = sin(uTime.mul((2 * Math.PI) / SWELL.seconds)).mul(0.5).add(0.5).mul(SWELL.amount).mul(recent).mul(uSwell).add(1);
    const size = q.x.sub(2.5).max(0).mul(RING.perMagnitudePx).add(RING.basePx).min(RING.maxPx);
    // Turned away over the horizon: the epicentre's normal faces away from the camera (at the origin).
    const facing = smoothstep(-0.02, 0.06, dot(normalize(uBasis.mul(p)), normalize(world.negate())));
    material.sizeNode = size.mul(swell);
    const c = uv().sub(0.5).mul(2);
    const r = c.length();
    const ring = smoothstep(0.62, 0.8, r).mul(float(1).sub(smoothstep(0.86, 1, r))).add(smoothstep(0.22, 0, r).mul(0.6));
    const deep = smoothstep(0, DEPTH_DEEP_KM, q.y);
    const colour = mix(vec3(1, 0.55, 0.25), vec3(0.6, 0.55, 1), deep);
    const age = mix(float(1), float(0.35), smoothstep(0, 24, q.z));
    material.colorNode = colour.mul(ring).mul(age).mul(facing).mul(uFade).mul(max(recent, 0.6));
    material.opacityNode = float(1);
    material.needsUpdate = true;
  };
  bind();

  const fill = (unixMs: number, radiusKm: number): void => {
    positions = new InstancedBufferAttribute(new Float32Array(Math.max(1, quakes.length) * 3), 3);
    props = new InstancedBufferAttribute(new Float32Array(Math.max(1, quakes.length) * 3), 3);
    const v = new Vector3();
    quakes.forEach((q, i) => {
      // Just above the ground (a few km), so the ring never sinks into it.
      bodyFrame(q.lat, q.lon, radiusKm * 1.0008, v);
      positions.array.set([v.x, v.y, v.z], i * 3);
      props.array.set([q.magnitude, q.depthKm, Math.max(0, (unixMs - q.timeMs) / 3_600_000)], i * 3);
    });
    rings.count = quakes.length;
    bind();
  };

  let pendingFill = false;
  const load = (): void => {
    if (status.state !== 'ready') status.state = 'loading';
    fetch(FEED_URL, { mode: 'cors', credentials: 'omit' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as GeoJson;
      })
      .then((json) => {
        quakes = parseQuakes(json);
        status.state = 'ready';
        status.fetchedMs = Date.now();
        pendingFill = true;
      })
      .catch((err: unknown) => {
        if (status.state !== 'ready') status.state = 'failed';
        console.warn('explore: the earthquake feed could not be loaded', err);
      });
  };

  let frameNow: QuakeFrame | null = null;
  return {
    object: rings,
    setOn(next) {
      on = next;
      window.clearInterval(timer);
      if (on) {
        load();
        timer = window.setInterval(load, REFRESH_MINUTES * 60_000);
      }
    },
    update(frame) {
      frameNow = frame;
      if (pendingFill) {
        pendingFill = false;
        fill(Date.now(), frame.earthRadiusKm);
      }
      const show = on && frame.visible && status.state === 'ready';
      uFade.value += ((show ? 1 : 0) - uFade.value) * 0.12;
      if (uFade.value < 0.002 && !show) uFade.value = 0;
      rings.visible = uFade.value > 0 && quakes.length > 0;
      if (!rings.visible) return;
      uEarth.value.set(frame.earth.x, frame.earth.y, frame.earth.z);
      const m = frame.basis;
      uBasis.value.set(m[0] ?? 1, m[3] ?? 0, m[6] ?? 0, m[1] ?? 0, m[4] ?? 1, m[7] ?? 0, m[2] ?? 0, m[5] ?? 0, m[8] ?? 1);
      uTime.value = frame.time;
      uSwell.value = frame.reducedMotion ? 0 : 1;
    },
    get quakes() {
      return quakes;
    },
    status,
    labels() {
      const frame = frameNow;
      const top = quakes[0];
      if (!frame || !rings.visible || !top) return [];
      const v = bodyFrame(top.lat, top.lon, frame.earthRadiusKm * 1.0008, new Vector3());
      const m = frame.basis;
      const x = frame.earth.x + v.x * (m[0] ?? 1) + v.y * (m[3] ?? 0) + v.z * (m[6] ?? 0);
      const y = frame.earth.y + v.x * (m[1] ?? 0) + v.y * (m[4] ?? 1) + v.z * (m[7] ?? 0);
      const z = frame.earth.z + v.x * (m[2] ?? 0) + v.y * (m[5] ?? 0) + v.z * (m[8] ?? 1);
      return [{ id: `quake-${top.id}`, textKey: 'ui.universe.quake', text: `M${top.magnitude.toFixed(1)}`, position: [x, y, z], opacity: 0.9 * uFade.value, offset: [14, -14] }];
    },
    dispose() {
      window.clearInterval(timer);
      geometry.dispose();
      material.dispose();
    },
  };
}
