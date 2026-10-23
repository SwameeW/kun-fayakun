/**
 * The solar-system explorer ("universe"): the Sun, the Earth of today, the Moon, Jupiter and
 * Saturn at true scale, where NASA JPL's data puts them on the date, turned as they really stand.
 * Loaded on demand as its own chunk and hosted by src/core/universe-host.ts.
 *
 * Each frame: the date moves on in real time; the bodies are placed from the ephemeris (float64
 * km); the camera orbits or flies (./navigation); then everything is rebased so the camera sits at
 * the origin (./space/origin), the depth range follows the altitude (./space/lens), and bodies
 * beyond it are drawn in scaled space at their exact angular size (./space/scaled-space).
 *
 * Light is physical in its falloff: a body's sunlight goes as 1/r^2, so Saturn's clouds get about
 * 1.1% of the Earth's. The exposure adapts to the body in view, slowly and slew-limited by the
 * engine like every brightness change (flash safety), and not quite fully, so the outer planets
 * stay a touch dimmer, as they should. Guides drawn on top (orbit lines, points for distant bodies)
 * keep their brightness on screen whatever the exposure. The Sun's disc is held below a ceiling on
 * screen, so no view of it is blinding.
 */

import { Group, MathUtils, Matrix4, Vector3, type Data3DTexture } from 'three/webgpu';
import { validRange, type MoonFile, type PlanetsFile } from '../astro/ephemeris';
import { PHYSICAL_URL, type PhysicalFile } from '../astro/physical';
import { julianDateUtc, utcToTdb } from '../astro/time';
import { createNoiseVolume } from '../chapters/shared/noise-volume';
import { blackbodyRgb } from '../chapters/shared/blackbody';
import { createStarfield, type Starfield } from '../chapters/shared/starfield';
import { DEFAULT_FOV } from '../core/camera';
import { createExposureControl, type EngineExposure } from '../core/post';
import { BODY_IDS, type BodyId, type ChapterContext, type SceneLabel, type UniverseModule, type UniversePose, type UniverseView } from '../core/types';
import { createBodies, SUN_KELVIN, type BodyVisual } from './bodies';
import { createSunGlare, visibleShare, type SunGlare } from './bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { createInput, type ExploreInput } from './input';
import { Navigator, type NavBody, type NavOutput, type NavWorld } from './navigation';
import { createOrbits, moonOrbit, planetOrbit, type Orbits, type OrbitPath } from './orbits';
import { lensFor, LENS, nearestAltitude, type Lens } from './space/lens';
import { FloatingOrigin, km, type Km } from './space/origin';
import { placeScaled } from './space/scaled-space';
import { createSolarSystem, type SolarSystem } from './system';

const DEFAULT_BODY: BodyId = 'earth';
const NOISE = { size: 64, seed: 31_415 } as const;
const SECONDS_PER_DAY = 86_400;
const UNIX_EPOCH_JD = 2440587.5;

/** Exposure adapts to sunlight as r^EXPOSURE_POWER (2 would be full adaptation), r in au. */
const EXPOSURE_POWER = 1.8;
/**
 * With the Sun large in view it is shown as photographed through a solar filter, so its disc shows
 * colour, limb darkening and granulation rather than a white blank: its light comes down by up to
 * `share` and takes the filter's gold, as its radius grows between these sizes (CSS px). The
 * readout says so while the filter is on.
 */
const SUN_FILTER = { share: 0.1, fromPx: 20, toPx: 260, color: [1, 0.6, 0.24] } as const;
/**
 * The Moon is dark (it reflects about an eighth of its light, less than half the Earth's share), so
 * with the Moon in view the exposure opens a little further, as a camera's would; beside the Earth
 * it still looks the darker of the two, as it is.
 */
const MOON_EXPOSURE = 1.25;
/** The Sun's disc on screen stays below this (linear, before tone mapping). */
const SUN_DISPLAY_MAX = 6;
/** The starfield's light, and how much of the exposure's adaptation it shows (0 none, 1 all of it). */
const STARS = { light: 0.85, follow: 0.2 } as const;

/** Points of light for distant bodies: colour (display terms) and size. Visual constants, not measurements. */
const DOT: Readonly<Record<BodyId, { tint: readonly [number, number, number]; albedo: number; sizePx: number }>> = {
  sun: { tint: [1, 1, 1], albedo: 1, sizePx: 15 },
  earth: { tint: [0.62, 0.78, 1], albedo: 0.42, sizePx: 7 },
  moon: { tint: [0.86, 0.84, 0.8], albedo: 0.16, sizePx: 6 },
  jupiter: { tint: [1, 0.93, 0.82], albedo: 0.52, sizePx: 8 },
  saturn: { tint: [1, 0.9, 0.72], albedo: 0.47, sizePx: 8 },
};
/** The Sun as a point: its blackbody colour, brilliant (display terms). */
const SUN_DOT = blackbodyRgb(SUN_KELVIN).map((v) => v * 3.2) as unknown as readonly [number, number, number];
/** Orbit line colours (display terms): a soft gold, the Moon's a little cooler. */
const ORBIT_COLOR = [0.42, 0.34, 0.21] as const;
const MOON_ORBIT_COLOR = [0.26, 0.29, 0.34] as const;
/** Label easing, and when a body's tag gives way (its disc is big enough to need none). */
const LABEL = { seconds: 0.35, maxDiscPx: 70, clearX: 90, clearY: 22 } as const;
/**
 * Up close only the focus's own orbit is drawn (and the Moon's around the Earth); the others come
 * in as the view widens, between these distances in bounding radii of the focus. Changes ease.
 */
const ORBITS_WIDE = { from: 40, to: 4000, seconds: 0.6 } as const;
const SUN_ORBITS_WIDE = { from: 8, to: 300 } as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const smootherstep = (a: number, b: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/** Lambert sphere's phase function: the share of light a sphere sends back at phase angle alpha. */
function lambertPhase(alpha: number): number {
  return (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
}

interface Placed {
  /** Camera-relative centre (doubles), and as drawn (scaled space). */
  rel: Km;
  drawn: Km;
  /** Distance to the centre, km; scale factor; disc radius on screen, CSS px. */
  distance: number;
  k: number;
  radiusPx: number;
}

export default function create(): UniverseModule {
  const root = new Group();
  root.name = 'universe';
  let ctx: ChapterContext | null = null;
  let system: SolarSystem | null = null;
  let bodies: Record<BodyId, BodyVisual> | null = null;
  let stars: Starfield | null = null;
  let orbits: Orbits | null = null;
  let orbitPaths: OrbitPath[] = [];
  const orbitWeights: number[] = [];
  /** The first frame after enter() or place(): eased values start where they belong. */
  let entering = true;
  /** How far the Sun is shown through its solar filter (0 none, 1 fully), and the filter's colour now. */
  let filterAmount = 0;
  const filterColor: [number, number, number] = [1, 1, 1];
  let dots: Impostors | null = null;
  let glare: SunGlare | null = null;
  let input: ExploreInput | null = null;
  let world: NavWorld | null = null;
  let range = { startJd: 0, endJd: Infinity };
  let timeConstants: PhysicalFile['time'] | null = null;
  let noise: Data3DTexture | null = null;

  const nav = new Navigator(DEFAULT_BODY);
  const navOut: NavOutput = { position: km(), target: km(), dim: 1, progress: 1, from: null };
  const origin = new FloatingOrigin();
  const lens: Lens = { near: 1, far: 2e4 };
  /** The engine's limiter, mirrored without the fade: how far the exposure has adapted right now. */
  let adaptation: EngineExposure = createExposureControl({ reducedMotion: false });

  /** The route's wishes, applied on enter (or at once while entered). */
  let wantBody: BodyId | null = null;
  let pinnedUtc: number | null = null;
  let entered = false;
  /** The date shown: TDB Julian date, and UTC for display. */
  let jdTdb = 0;
  let jdUtc = 0;
  let elapsed = 0;

  const placed = Object.fromEntries(BODY_IDS.map((id) => [id, { rel: km(), drawn: km(), distance: 0, k: 1, radiusPx: 0 }])) as Record<BodyId, Placed>;
  const labelOpacity = new Map<BodyId, number>(BODY_IDS.map((id) => [id, 0]));
  let labels: SceneLabel[] = [];
  const dotList: ImpostorDot[] = BODY_IDS.map(() => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: 6 }));

  const look = new Matrix4();
  const eye = new Vector3();
  const target = new Vector3();
  const up = new Vector3(0, 1, 0);
  const basis = new Matrix4();
  const right = new Vector3();
  const projected = new Vector3();
  const sunDir = { x: 0, y: 0, z: 0 };

  const setDate = (utc: number | null): void => {
    if (!timeConstants) return;
    const wanted = utc ?? julianDateUtc(Date.now());
    const tdb = utcToTdb(wanted, timeConstants);
    // The Moon's table spans 2026 to 2035: dates outside are shown at its nearest edge.
    jdTdb = Math.min(range.endJd, Math.max(range.startJd, tdb));
    jdUtc = wanted + (jdTdb - tdb);
  };

  const exposureFor = (id: BodyId): number => {
    if (!system || id === 'sun') return 1;
    const p = system.bodies[id].position;
    const au = Math.hypot(p.x, p.y, p.z) / system.auKm;
    return Math.max(0.05, au) ** EXPOSURE_POWER * (id === 'moon' ? MOON_EXPOSURE : 1);
  };

  /** How much of the Sun's disc no nearer body covers, 0 to 1. */
  const sunVisible = (): number => {
    if (!system) return 1;
    const s = placed.sun;
    const a = Math.asin(Math.min(1, system.specs.sun.radiusKm / Math.max(s.distance, 1)));
    let share = 1;
    for (const id of BODY_IDS) {
      if (id === 'sun') continue;
      const p = placed[id];
      if (p.distance >= s.distance) continue;
      const b = Math.asin(Math.min(1, system.specs[id].radiusKm / Math.max(p.distance, 1)));
      const cos = (s.rel.x * p.rel.x + s.rel.y * p.rel.y + s.rel.z * p.rel.z) / Math.max(1e-9, s.distance * p.distance);
      share *= visibleShare(a, b, Math.acos(Math.min(1, Math.max(-1, cos))));
    }
    return share;
  };

  /** The view's exposure: the focus's, and during a flight the log blend of where it left and where it goes. */
  const exposureTarget = (): number => {
    const to = exposureFor(nav.focus);
    if (!navOut.from) return to;
    const from = exposureFor(navOut.from);
    const w = smootherstep(0.12, 0.88, navOut.progress);
    return Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * w);
  };

  const view = (): UniverseView => {
    const cam = origin.camera;
    const focus = nav.focus;
    const spec = system?.specs[focus];
    const p = system?.bodies[focus].position ?? km();
    const distanceKm = Math.hypot(cam.x - p.x, cam.y - p.y, cam.z - p.z);
    const auKm = system?.auKm ?? 1;
    const fromSun = Math.max(1, Math.hypot(cam.x, cam.y, cam.z));
    return {
      focus,
      travelling: nav.travelling,
      distanceKm,
      altitudeKm: distanceKm - (spec?.radiusKm ?? 0),
      sunlight: (auKm / fromSun) ** 2,
      solarFilter: filterAmount > 0.5,
      jdTdb,
      unixMs: (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000,
    };
  };

  const frame = (dt: number): void => {
    const c = ctx;
    if (!c || !system || !bodies || !stars || !orbits || !dots || !glare || !world) return;
    nav.reducedMotion = c.reducedMotion;
    adaptation.setReducedMotion(c.reducedMotion);
    elapsed += dt;
    jdTdb = Math.min(range.endJd, jdTdb + dt / SECONDS_PER_DAY);
    jdUtc += dt / SECONDS_PER_DAY;
    system.update(jdTdb);
    for (const path of orbitPaths) path.setDate(jdTdb);

    // The camera, in doubles; then everything relative to it.
    nav.update(world, dt, navOut);
    origin.setCamera(navOut.position);
    for (const id of BODY_IDS) {
      const p = placed[id];
      origin.relative(system.bodies[id].position, p.rel);
      p.distance = Math.hypot(p.rel.x, p.rel.y, p.rel.z);
    }
    const sys = system;
    lensFor(
      nearestAltitude(BODY_IDS.map((id) => ({ centre: placed[id].rel, radius: sys.specs[id].radiusKm }))),
      lens,
    );

    // The camera: at the origin, looking where the navigator looks, with this frame's depth range.
    const camera = c.camera;
    camera.position.set(0, 0, 0);
    eye.set(0, 0, 0);
    target.set(navOut.target.x - navOut.position.x, navOut.target.y - navOut.position.y, navOut.target.z - navOut.position.z);
    if (target.lengthSq() > 0) {
      // Matrix4.lookAt from the eye toward the target is a camera's orientation (it looks down -z).
      look.lookAt(eye, target.normalize(), up);
      camera.quaternion.setFromRotationMatrix(look);
    }
    camera.up.copy(up);
    camera.near = lens.near;
    camera.far = lens.far;
    camera.fov = DEFAULT_FOV;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // Exposure: adapt to the body in view (the engine slews it); the mirror says how far it has got.
    const exposure = exposureTarget();
    c.exposure.setTarget(exposure * navOut.dim);
    adaptation.setTarget(exposure);
    adaptation.update(dt);
    const adapted = Math.max(adaptation.current, 1e-4);

    // Bodies: true size and place, scaled space beyond the depth range, real orientation and light.
    const viewportPx = c.renderer.domElement.clientHeight || 1;
    const pxPerTan = viewportPx / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
    const sun = system.bodies.sun.position;
    for (const id of BODY_IDS) {
      const spec = system.specs[id];
      const p = placed[id];
      p.k = placeScaled(p.rel, spec.boundKm, lens.far, p.drawn);
      p.radiusPx = pxPerTan * Math.tan(Math.asin(Math.min(1, spec.radiusKm / Math.max(p.distance, spec.radiusKm))));
      const visual = bodies[id];
      const object = visual.object;
      object.position.set(p.drawn.x, p.drawn.y, p.drawn.z);
      object.scale.setScalar(spec.radiusKm * p.k);
      const b = system.bodies[id].basis;
      basis.set(b[0] ?? 1, b[3] ?? 0, b[6] ?? 0, 0, b[1] ?? 0, b[4] ?? 1, b[7] ?? 0, 0, b[2] ?? 0, b[5] ?? 0, b[8] ?? 1, 0, 0, 0, 0, 1);
      object.quaternion.setFromRotationMatrix(basis);
      const toSun = system.bodies[id].position;
      sunDir.x = sun.x - toSun.x;
      sunDir.y = sun.y - toSun.y;
      sunDir.z = sun.z - toSun.z;
      const r = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
      if (r > 0) {
        sunDir.x /= r;
        sunDir.y /= r;
        sunDir.z /= r;
      } else {
        sunDir.x = 0;
        sunDir.y = 1;
        sunDir.z = 0;
      }
      if (id === 'sun') {
        filterAmount = smoothstep(SUN_FILTER.fromPx, SUN_FILTER.toPx, p.radiusPx);
        const [fr, fg, fb] = SUN_FILTER.color;
        filterColor[0] = 1 + (fr - 1) * filterAmount;
        filterColor[1] = 1 + (fg - 1) * filterAmount;
        filterColor[2] = 1 + (fb - 1) * filterAmount;
        const light = Math.min(1, SUN_DISPLAY_MAX / adapted) * (1 - SUN_FILTER.share * filterAmount);
        visual.update({ time: elapsed, sun: sunDir, light, filter: filterColor });
      } else {
        visual.update({ time: elapsed, sun: sunDir, light: (system.auKm / Math.max(r, 1)) ** 2 });
      }
    }

    // Stars at the back of the depth range, hidden by the bodies in front of them.
    stars.setRadius(lens.far * LENS.starShare);
    stars.setLight(STARS.light * adapted ** (STARS.follow - 1));

    // Orbit lines, fading near the body in focus; others than its own only in a wide view.
    const focus = placed[nav.focus];
    const wide = nav.focus === 'sun' ? SUN_ORBITS_WIDE : ORBITS_WIDE;
    const bound = system.specs[nav.focus].boundKm;
    const wideness = smoothstep(Math.log(wide.from * bound), Math.log(wide.to * bound), Math.log(Math.max(focus.distance, 1)));
    const settle = dt > 0 ? 1 - Math.exp(-dt / ORBITS_WIDE.seconds) : 0;
    orbitPaths.forEach((path, i) => {
      const own = path.body === nav.focus || (path.body === 'moon' && (nav.focus === 'earth' || nav.focus === 'moon'));
      const current = orbitWeights[i] ?? 0;
      orbitWeights[i] = current + ((own ? 1 : wideness) - current) * (entering ? 1 : settle);
    });
    entering = false;
    orbits.update({
      weights: orbitWeights,
      camera: origin.camera,
      far: lens.far,
      focus: system.bodies[nav.focus].position,
      focusRadius: system.specs[nav.focus].radiusKm,
      focusDistance: focus.distance,
      compensation: adapted,
      light: 1,
    });

    // Points of light for bodies under about 2 px.
    BODY_IDS.forEach((id, i) => {
      const p = placed[id];
      const dot = dotList[i];
      if (!dot) return;
      const spec = system?.specs[id];
      const drawnRadius = (spec?.radiusKm ?? 0) * p.k;
      // In front of the body's own sphere, by at least 1% of the distance: far out, one step of the
      // depth buffer spans hundreds of thousands of km, more than the planet itself.
      const toward = Math.max(0, Math.min(0.99, 1 - (1.03 * drawnRadius) / Math.max(Math.hypot(p.drawn.x, p.drawn.y, p.drawn.z), 1e-9)));
      dot.position.x = p.drawn.x * toward;
      dot.position.y = p.drawn.y * toward;
      dot.position.z = p.drawn.z * toward;
      const style = DOT[id];
      if (id === 'sun') {
        dot.color = [SUN_DOT[0], SUN_DOT[1], SUN_DOT[2]];
      } else {
        // Phase angle at the body, between the Sun and the camera.
        const body = system?.bodies[id].position ?? km();
        const sx = sun.x - body.x;
        const sy = sun.y - body.y;
        const sz = sun.z - body.z;
        const cx = -p.rel.x;
        const cy = -p.rel.y;
        const cz = -p.rel.z;
        const cos = (sx * cx + sy * cy + sz * cz) / Math.max(1e-9, Math.hypot(sx, sy, sz) * Math.hypot(cx, cy, cz));
        const phase = lambertPhase(Math.acos(Math.min(1, Math.max(-1, cos))));
        // A floor keeps a body seen against its night side findable, faintly.
        const brightness = 0.22 + 2.1 * style.albedo * phase;
        dot.color = [style.tint[0] * brightness, style.tint[1] * brightness, style.tint[2] * brightness];
      }
      dot.opacity = smoothstep(2.8, 1.2, p.radiusPx);
      dot.sizePx = style.sizePx;
    });
    dots.update(dotList, adapted);

    const sunPlaced = placed.sun;
    glare.update({
      position: sunPlaced.drawn,
      drawnRadius: system.specs.sun.radiusKm * sunPlaced.k,
      radiusPx: sunPlaced.radiusPx,
      viewportPx,
      visible: sunVisible(),
      compensation: adapted,
      filter: filterColor,
    });

    updateLabels(dt, viewportPx);
  };

  /** Names beside the bodies: eased, hidden behind other bodies, and never on top of each other. */
  const updateLabels = (dt: number, viewportPx: number): void => {
    const c = ctx;
    if (!c || !system) return;
    const camera = c.camera;
    const widthPx = c.renderer.domElement.clientWidth || 1;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const order = [...BODY_IDS].sort((a, b) => (a === nav.focus ? -1 : b === nav.focus ? 1 : placed[b].radiusPx - placed[a].radiusPx));
    const taken: Array<{ x: number; y: number }> = [];
    const next: SceneLabel[] = [];
    const ease = 1 - Math.exp(-Math.max(0, dt) / LABEL.seconds);
    for (const id of order) {
      const spec = system.specs[id];
      const p = placed[id];
      const drawnRadius = spec.radiusKm * p.k;
      const anchor = projected.set(p.drawn.x, p.drawn.y, p.drawn.z).addScaledVector(right, drawnRadius * 1.08);
      const position: [number, number, number] = [anchor.x, anchor.y, anchor.z];
      anchor.project(camera);
      const sx = ((anchor.x + 1) / 2) * widthPx;
      const sy = ((1 - anchor.y) / 2) * viewportPx;
      let want = anchor.z < 1 && anchor.z > -1 && p.radiusPx < LABEL.maxDiscPx ? 0.92 : 0;
      if (want > 0 && occluded(id)) want = 0;
      if (want > 0 && taken.some((t) => Math.abs(t.x - sx) < LABEL.clearX && Math.abs(t.y - sy) < LABEL.clearY)) want = 0;
      if (want > 0) taken.push({ x: sx, y: sy });
      const now = (labelOpacity.get(id) ?? 0) + (want - (labelOpacity.get(id) ?? 0)) * ease;
      labelOpacity.set(id, now < 1e-3 && want === 0 ? 0 : now);
      if (now > 1e-3) next.push({ id: `body-${id}`, textKey: spec.nameKey, position, opacity: now });
    }
    labels = next;
  };

  /** True when another body's disc covers this body's centre and is nearer. */
  const occluded = (id: BodyId): boolean => {
    if (!system) return false;
    const p = placed[id];
    for (const other of BODY_IDS) {
      if (other === id) continue;
      const q = placed[other];
      if (q.distance >= p.distance) continue;
      const cosSep = (p.rel.x * q.rel.x + p.rel.y * q.rel.y + p.rel.z * q.rel.z) / Math.max(1e-9, p.distance * q.distance);
      const angularRadius = Math.asin(Math.min(1, system.specs[other].radiusKm / Math.max(q.distance, 1e-9)));
      if (Math.acos(Math.min(1, Math.max(-1, cosSep))) < angularRadius) return true;
    }
    return false;
  };

  const navBodies = (sys: SolarSystem): NavWorld => {
    const list: NavBody[] = BODY_IDS.map((id) => {
      const spec = sys.specs[id];
      return {
        id,
        radiusKm: spec.radiusKm,
        boundKm: spec.boundKm,
        minAltitudeKm: spec.minAltitudeKm,
        framing: spec.framing,
        position: sys.bodies[id].position,
      };
    });
    const byId = new Map(list.map((b) => [b.id, b]));
    return {
      all: list,
      sun: sys.bodies.sun.position,
      body(id) {
        const found = byId.get(id);
        if (!found) throw new Error(`no body ${id}`);
        return found;
      },
    };
  };

  return {
    id: 'universe',

    async load(c) {
      ctx = c;
      if (system) return;
      const [planets, moon, physical, volume] = await Promise.all([
        c.assets.json<PlanetsFile>('assets/jpl/planets.json'),
        c.assets.json<MoonFile>('assets/jpl/moon.json'),
        c.assets.json<PhysicalFile>(PHYSICAL_URL),
        createNoiseVolume(NOISE.size, NOISE.seed),
      ]);
      noise = volume;
      timeConstants = physical.time;
      const valid = validRange(moon);
      range = { startJd: Math.max(valid.planets.startJd, valid.moon.startJd), endJd: Math.min(valid.planets.endJd, valid.moon.endJd) };
      system = createSolarSystem(planets, moon, physical);
      world = navBodies(system);
      bodies = createBodies(volume, system.specs, physical.saturnRings);
      stars = createStarfield(7000, 400, 7_101, { depthTest: true, dynamicRadius: true });
      const body = (name: string): PlanetsFile['bodies'][number] => {
        const found = planets.bodies.find((b) => b.name === name);
        if (!found) throw new Error(`planets.json has no ${name}`);
        return found;
      };
      const sunAt = system.bodies.sun.position;
      orbitPaths = [
        planetOrbit('earth', body('Earth'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('jupiter', body('Jupiter'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('saturn', body('Saturn'), sunAt, physical.auKm, ORBIT_COLOR),
        moonOrbit(moon, system.bodies.earth.position, MOON_ORBIT_COLOR),
      ];
      orbits = createOrbits(orbitPaths);
      dots = createImpostors(BODY_IDS.length);
      glare = createSunGlare(blackbodyRgb(SUN_KELVIN));
      root.add(
        stars.object,
        orbits.mesh,
        dots.object,
        glare.object,
        ...BODY_IDS.map((id) => bodies?.[id].object).filter((o): o is Group => o !== undefined),
      );
      input = createInput(c.renderer.domElement, nav);
    },

    configure(options) {
      if (options.jdUtc !== null || !entered) pinnedUtc = options.jdUtc;
      if (entered && options.jdUtc !== null) setDate(options.jdUtc);
      nav.reducedMotion = options.reducedMotion;
      if (entered && options.body && world) nav.flyTo(world, options.body);
      else wantBody = options.body;
    },

    enter(c) {
      ctx = c;
      if (!system || !world) return;
      c.scene.add(root);
      entered = true;
      elapsed = 0;
      setDate(pinnedUtc);
      system.update(jdTdb);
      nav.reducedMotion = c.reducedMotion;
      nav.begin(world, wantBody ?? DEFAULT_BODY, true);
      wantBody = null;
      // A fresh mirror of the limiter, already adapted, so guides are steady from the first frame.
      adaptation = createExposureControl({ reducedMotion: c.reducedMotion });
      adaptation.setFade(1);
      adaptation.setTarget(exposureFor(nav.focus));
      for (let i = 0; i < 200; i += 1) adaptation.update(0.1);
      for (const id of BODY_IDS) labelOpacity.set(id, 0);
      input?.attach();
      // Place everything once, so the warm-up compiles every material in view.
      entering = true;
      frame(0);
    },

    update(dt) {
      frame(dt);
    },

    focus(body) {
      if (!world || !entered) {
        wantBody = body;
        return;
      }
      nav.flyTo(world, body);
    },

    view,

    place(pose: UniversePose) {
      if (!world || !system) return;
      const body = system.bodies[pose.body].position;
      const from = pose.from ?? 'sun';
      const other = from === 'sun' ? (pose.body === 'sun' ? system.bodies.earth.position : system.bodies.sun.position) : system.bodies[from].position;
      // 'sun': toward the Sun (the lit face). A body: from the far side of the focus, so that body shows behind it.
      const sign = from === 'sun' ? 1 : -1;
      const base = km(sign * (other.x - body.x), sign * (other.y - body.y), sign * (other.z - body.z));
      const len = Math.hypot(base.x, base.y, base.z) || 1;
      const azimuth = Math.atan2(base.x / len, base.z / len) + MathUtils.degToRad(pose.azimuthDeg ?? 0);
      const elevation = Math.asin(Math.min(1, Math.max(-1, base.y / len))) + MathUtils.degToRad(pose.elevationDeg ?? 0);
      const cosE = Math.cos(elevation);
      nav.place(pose.body, km(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth)), pose.distanceKm, world);
      entering = true;
    },

    labels() {
      return labels;
    },

    scale() {
      // One metres-per-pixel bar would mislead in a view where distant bodies are drawn in scaled space:
      // the explorer's readout gives true distances instead.
      return null;
    },

    exit() {
      root.removeFromParent();
      input?.detach();
      entered = false;
      labels = [];
    },

    dispose() {
      root.removeFromParent();
      input?.detach();
      if (bodies) for (const id of BODY_IDS) bodies[id].dispose();
      stars?.dispose();
      orbits?.dispose();
      dots?.dispose();
      glare?.dispose();
      noise?.dispose();
      bodies = null;
      stars = null;
      orbits = null;
      dots = null;
      glare = null;
      noise = null;
      system = null;
      world = null;
      ctx = null;
      entered = false;
    },
  };
}
