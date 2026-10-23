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
 * stay a touch dimmer, as they should. A reduced-motion cut dims the picture with the host's veil
 * (eased, never held back by the exposure's own limits) and the exposure jumps to the new body
 * while the picture is dim, so it comes back already adapted. Guides drawn on top (orbit lines,
 * points and rings marking distant bodies, the Sun's glare) keep their brightness on screen
 * whatever the exposure. The Sun's disc is held at a fixed brightness on screen: brilliant when
 * small, and as through a solar filter when it fills the view.
 */

import { DepthTexture, Group, MathUtils, Matrix4, Mesh, Quaternion, RenderTarget, Vector3, type Data3DTexture, type Object3D } from 'three/webgpu';
import { validRange, type MoonFile, type PlanetsFile } from '../astro/ephemeris';
import { PHYSICAL_URL, ringTransmission, type PhysicalFile } from '../astro/physical';
import { julianDateUtc, utcToTdb } from '../astro/time';
import { createNoiseVolume } from '../chapters/shared/noise-volume';
import { blackbodyRgb } from '../chapters/shared/blackbody';
import { createStarfield, type Starfield } from '../chapters/shared/starfield';
import { DEFAULT_FOV } from '../core/camera';
import { createExposureControl, type EngineExposure } from '../core/post';
import {
  BODY_IDS,
  type BodyId,
  type QualityTier,
  type SceneLabel,
  type UniverseContext,
  type UniverseIllustration,
  type UniverseModule,
  type UniversePose,
  type UniverseView,
  type ViewInsets,
} from '../core/types';
import { PLANETS_MANIFEST_URL, findPlanetTexture, type PlanetsManifest } from './assets/planets';
import { createPlanetTextures } from './assets/streaming';
import { createRawDecoder, type RawDecoder } from './assets/raw-ktx2';
import { createUploader } from './assets/upload';
import { createBodies, SUN_KELVIN, type Bodies } from './bodies';
import { fineDetailShown } from './bodies/earth';
import { craterDetailShown } from './bodies/moon';
import { createSunGlare, visibleShare, type SunGlare } from './bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { DETAIL, type ExploreDetail } from './detail';
import { createTransmittanceTable, earthAir, limbTransmittance, type AirModel, type TransmittanceTable } from './render/air';
import { createInput, type ExploreInput } from './input';
import { Navigator, type NavBody, type NavOutput, type NavWorld } from './navigation';
import { createOrbits, moonOrbit, planetOrbit, type Orbits, type OrbitPath } from './orbits';
import { lensFor, LENS, nearestAltitude, type Lens, type Sphere } from './space/lens';
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
 * colour, limb darkening and granulation rather than a white blank: the filter comes in as its
 * radius grows between these sizes (CSS px), taking the disc from brilliant white to the filter's
 * amber at a moderate brightness (display terms). The readout says so while the filter is on.
 */
const SUN_FILTER = { fromPx: 12, toPx: 110, color: [1, 0.5, 0.12], white: 5, filtered: 0.5 } as const;
/**
 * The Moon is dark (it reflects about an eighth of its light, less than half the Earth's share), so
 * with the Moon in view the exposure opens a little further, as a camera's would; beside the Earth
 * it still looks the darker of the two, as it is.
 */
const MOON_EXPOSURE = 1.1;
/** The starfield's light, and how much of the exposure's adaptation it shows (0 none, 1 all of it). */
const STARS = { light: 0.85, follow: 0.2 } as const;
/** Stars drawn per quality tier (a prefix of the same random field: a fair subsample). */
const STAR_COUNT: Readonly<Record<QualityTier, number>> = { high: 7000, mid: 5000, low: 3000 };

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
/**
 * Labels: easing (and the quicker easing of a tag whose body has gone behind another), when a body's
 * tag gives way (its disc is big enough to need none; the focus's as soon as it reads as a disc, the
 * readout naming it), how close two may sit, below what disc radius (px) a tag is anchored at the
 * body's centre beside its ring marker rather than at its limb, how far a tag (about its own width)
 * must clear a nearer body's disc, and the band below the header kept clear for the hint.
 */
const LABEL = { seconds: 0.35, hideSeconds: 0.12, maxDiscPx: 70, focusDiscPx: 12, clearX: 90, clearY: 22, markerPx: 4, widthPx: 80, hintPx: 52 } as const;
/**
 * Up close only the focus's own orbit is drawn (and the Moon's around the Earth); the others come
 * in as the view widens, between these distances in bounding radii of the focus. Changes ease.
 */
const ORBITS_WIDE = { from: 40, to: 4000, seconds: 0.6 } as const;
const SUN_ORBITS_WIDE = { from: 8, to: 300 } as const;
/**
 * An orbit only reads as an orbit from far enough away: its line fades out as the camera comes
 * within these shares of the orbit's size of the body on it (seen from beside a planet its orbit is
 * a straight line through it), and of the orbit's centre (from inside, a loop is a line across the sky).
 */
const ORBIT_NEAR_BODY = { from: 0.05, to: 0.25 } as const;
const ORBIT_INSIDE = { from: 0.35, to: 0.7 } as const;
/** How quickly the view follows a change in what the interface covers, seconds. */
const INSET_SECONDS = 0.4;
/** A planet this large on screen (radius, CSS px) streams the detail's maps as the focus does. */
const LARGE_PX = 200;

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

/** The explorer's detail for a film tier, until the explorer's own quality governance picks one (setDetail). */
const DETAIL_FOR_TIER: Readonly<Record<QualityTier, ExploreDetail>> = { high: DETAIL.high, mid: DETAIL.medium, low: DETAIL.low };

/** The explorer as its quality governance drives it: the module plus its detail ladder (./detail). */
export interface ExplorerModule extends UniverseModule {
  /** The detail level drawn now. */
  readonly detail: ExploreDetail;
  /** Changes what the bodies draw and which textures stream (new materials compile first; no hitch). */
  setDetail(detail: ExploreDetail): void;
}

const unit = (out: Km, from: Km, to: Km): Km => {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  const l = Math.hypot(x, y, z) || 1;
  out.x = x / l;
  out.y = y / l;
  out.z = z / l;
  return out;
};

export default function create(): ExplorerModule {
  const root = new Group();
  root.name = 'universe';
  let ctx: UniverseContext | null = null;
  let system: SolarSystem | null = null;
  let bodies: Bodies | null = null;
  /** The Earth's transmittance table: baked on the first frame (it needs the renderer). */
  let airTable: TransmittanceTable | null = null;
  /**
   * The render target the frames draw the explorer into (the post pipeline's scene pass, seen while the
   * stars draw), and a stand-in shaped like it for before the first frame (compileForFrames).
   */
  let frameTarget: RenderTarget | null = null;
  let compileTarget: RenderTarget | null = null;
  /** The worker that inflates the raw planet files. */
  let rawDecoder: RawDecoder | null = null;
  /** A detail asked for before the bodies exist. */
  let wantDetail: ExploreDetail | null = null;
  let stars: Starfield | null = null;
  let orbits: Orbits | null = null;
  let orbitPaths: OrbitPath[] = [];
  const orbitWeights: number[] = [];
  /** The first frame after enter() or place(): eased values start where they belong. */
  let entering = true;
  /**
   * Updates left before frustum culling comes back on after the warm-up: it stays off for the first
   * frame drawn, so every body, in view or not, builds its pipelines for the target the frames draw
   * into while the picture is still black (a body first drawn later would compile them then, a stall).
   */
  let warming = 0;
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
  let tier: QualityTier = 'high';
  let insets: ViewInsets = { top: 0, bottom: 0 };
  /** The clear part's offset from the middle of the view, CSS px, eased so a readout growing a line never jolts the view. */
  let offsetPx = 0;

  const nav = new Navigator(DEFAULT_BODY);
  const navOut: NavOutput = { position: km(), target: km(), dim: 1, cut: false, progress: 1, from: null };
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
  /** Seconds of the bodies' own illustrative motion (drifting clouds and bands, the Sun's surface): still with reduced motion. */
  let ambient = 0;
  /** The camera's height above the nearest surface (rings included), km: the depth range and the turn rate follow it. */
  let nearestKm = Infinity;
  /** The Earth's air model (its limb reddens the Sun seen through it). */
  let earthAirModel: AirModel | null = null;

  const placed = Object.fromEntries(BODY_IDS.map((id) => [id, { rel: km(), drawn: km(), distance: 0, k: 1, radiusPx: 0 }])) as Record<BodyId, Placed>;
  const labelOpacity = new Map<BodyId, number>(BODY_IDS.map((id) => [id, 0]));
  let labels: SceneLabel[] = [];
  const dotList: ImpostorDot[] = BODY_IDS.map(() => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: 6, marker: 0 }));
  /** Saturn's rings' span and pole, for the lens (set from physical.json on load, the pole each frame). */
  const ringSphere = { pole: km(0, 1, 0), innerKm: 0, outerKm: 0 };
  const spheres: Sphere[] = BODY_IDS.map((id) => (id === 'saturn' ? { centre: km(), radius: 0, ring: ringSphere } : { centre: km(), radius: 0 }));

  const look = new Matrix4();
  const eye = new Vector3();
  const target = new Vector3();
  const up = new Vector3(0, 1, 0);
  const basis = new Matrix4();
  const right = new Vector3();
  const projected = new Vector3();
  const origin3 = new Vector3();
  const sunDir = km();
  const toEarth = km();
  const scratch = km();
  const forward = km();
  const camRight = new Vector3();
  const camUp = new Vector3();
  const sunView = new Vector3();
  const viewTurn = new Quaternion();
  const ringCamera = km();
  const sunRing = km();
  const toMoon = km();
  const focusBodies: BodyId[] = [];
  const sunTint: [number, number, number] = [1, 1, 1];

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

  /**
   * The view's exposure: the focus's, and during a flight the log blend of where it left and where
   * it goes. A reduced-motion cut keeps the old body's until it cuts (then the exposure jumps).
   */
  const exposureTarget = (): number => {
    const to = exposureFor(nav.focus);
    if (!navOut.from) return to;
    const from = exposureFor(navOut.from);
    if (nav.reducedMotion) return navOut.progress < 0.5 ? from : to;
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
      from: navOut.from,
      moving: nav.moving,
      distanceKm,
      altitudeKm: distanceKm - (spec?.radiusKm ?? 0),
      sunlight: (auKm / fromSun) ** 2,
      solarFilter: filterAmount > 0.5,
      jdTdb,
      unixMs: (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000,
      illustrative: illustrations(),
    };
  };

  /** Frustum culling off for every body's meshes (the warm-up then compiles them all, in view or not), or back on. */
  const setCulling = (on: boolean): void => {
    if (!bodies) return;
    for (const id of BODY_IDS) {
      bodies.objects[id].traverse((o: Object3D) => {
        if (o instanceof Mesh) o.frustumCulled = on;
      });
    }
  };

  const frame = (dt: number): void => {
    const c = ctx;
    if (!c || !system || !bodies || !stars || !orbits || !dots || !glare || !world) return;
    const sys = system;
    nav.reducedMotion = c.reducedMotion;
    adaptation.setReducedMotion(c.reducedMotion);
    ambient += c.reducedMotion ? 0 : dt;
    jdTdb = Math.min(range.endJd, jdTdb + dt / SECONDS_PER_DAY);
    jdUtc += dt / SECONDS_PER_DAY;
    sys.update(jdTdb);
    for (const path of orbitPaths) path.setDate(jdTdb);

    // The view the bodies are framed in: the camera's lens and what the interface covers.
    const camera = c.camera;
    const viewportPx = c.renderer.domElement.clientHeight || 1;
    const widthPx = c.renderer.domElement.clientWidth || 1;
    const tanHalf = Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2));
    nav.setView({ tanHalfFov: tanHalf, aspect: widthPx / viewportPx, top: insets.top / viewportPx, bottom: insets.bottom / viewportPx });

    // The camera, in doubles; then everything relative to it (held keys turn at the altitude's rate).
    input?.update();
    nav.update(world, dt, navOut);
    origin.setCamera(navOut.position);
    BODY_IDS.forEach((id, i) => {
      const p = placed[id];
      origin.relative(sys.bodies[id].position, p.rel);
      p.distance = Math.hypot(p.rel.x, p.rel.y, p.rel.z);
      const sphere = spheres[i];
      if (sphere) {
        sphere.centre = p.rel;
        sphere.radius = sys.specs[id].radiusKm;
      }
    });
    // Saturn's rings, in its equator: beside them they are the nearest surface.
    const pole = sys.bodies.saturn.basis;
    ringSphere.pole.x = pole[3] ?? 0;
    ringSphere.pole.y = pole[4] ?? 1;
    ringSphere.pole.z = pole[5] ?? 0;
    nearestKm = nearestAltitude(spheres);
    lensFor(nearestKm, lens);

    // The camera: at the origin, looking where the navigator looks, tilted so the body sits in the
    // middle of the part of the view the interface leaves clear, with this frame's depth range.
    camera.position.set(0, 0, 0);
    eye.set(0, 0, 0);
    target.set(navOut.target.x - navOut.position.x, navOut.target.y - navOut.position.y, navOut.target.z - navOut.position.z);
    if (target.lengthSq() > 0) {
      // Matrix4.lookAt from the eye toward the target is a camera's orientation (it looks down -z).
      look.lookAt(eye, target.normalize(), up);
      camera.quaternion.setFromRotationMatrix(look);
    }
    const pxPerTan = viewportPx / (2 * tanHalf);
    const wantOffset = (insets.bottom - insets.top) / 2;
    offsetPx = entering ? wantOffset : offsetPx + (wantOffset - offsetPx) * (1 - Math.exp(-Math.max(0, dt) / INSET_SECONDS));
    camera.rotateX(-Math.atan(offsetPx / pxPerTan));
    camera.up.copy(up);
    camera.near = lens.near;
    camera.far = lens.far;
    camera.fov = DEFAULT_FOV;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    projected.set(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.x = projected.x;
    forward.y = projected.y;
    forward.z = projected.z;

    // Exposure: adapt to the body in view (the engine slews it); the mirror says how far it has got.
    // A reduced-motion cut dims through the veil, and the exposure jumps while it is dim.
    const exposure = exposureTarget();
    c.exposure.setTarget(exposure);
    c.exposure.setVeil(navOut.dim);
    adaptation.setTarget(exposure);
    if (navOut.cut) {
      c.exposure.jump();
      adaptation.jump();
    }
    adaptation.update(dt);
    const adapted = Math.max(adaptation.current, 1e-4);

    // Bodies: true size and place, scaled space beyond the depth range, real orientation and light.
    const sun = sys.bodies.sun.position;
    for (const id of BODY_IDS) {
      const spec = sys.specs[id];
      const p = placed[id];
      p.k = placeScaled(p.rel, spec.boundKm, lens.far, p.drawn);
      p.radiusPx = pxPerTan * Math.tan(Math.asin(Math.min(1, spec.radiusKm / Math.max(p.distance, spec.radiusKm))));
      const object = bodies.objects[id];
      object.position.set(p.drawn.x, p.drawn.y, p.drawn.z);
      object.scale.setScalar(spec.radiusKm * p.k);
      const b = sys.bodies[id].basis;
      basis.set(b[0] ?? 1, b[3] ?? 0, b[6] ?? 0, 0, b[1] ?? 0, b[4] ?? 1, b[7] ?? 0, 0, b[2] ?? 0, b[5] ?? 0, b[8] ?? 1, 0, 0, 0, 0, 1);
      object.quaternion.setFromRotationMatrix(basis);
      object.updateMatrixWorld();
    }
    const lightAt = (id: BodyId): number => {
      const q = sys.bodies[id].position;
      return (sys.auKm / Math.max(Math.hypot(q.x - sun.x, q.y - sun.y, q.z - sun.z), 1)) ** 2;
    };
    // The Sun: brilliant and white when small, through its filter (amber, moderate) when it fills the view.
    filterAmount = smoothstep(SUN_FILTER.fromPx, SUN_FILTER.toPx, placed.sun.radiusPx);
    const [fr, fg, fb] = SUN_FILTER.color;
    filterColor[0] = 1 + (fr - 1) * filterAmount;
    filterColor[1] = 1 + (fg - 1) * filterAmount;
    filterColor[2] = 1 + (fb - 1) * filterAmount;
    const sunDisplay = Math.exp(Math.log(SUN_FILTER.white) + (Math.log(SUN_FILTER.filtered) - Math.log(SUN_FILTER.white)) * filterAmount);
    // The Earth's air table is baked once, on the first frame (it needs the renderer).
    if (airTable && !airTable.baked) airTable.bake(c.renderer);
    camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    bodies.sun.update({
      time: ambient,
      kelvin: SUN_KELVIN,
      light: sunDisplay / adapted,
      exposure: adapted,
      filter: filterColor,
      filtered: filterAmount,
      radiusPx: placed.sun.radiusPx,
      right: camRight,
      up: camUp,
    });
    // The Moon: sunlight, and earthshine from as much of the Earth's face toward it as is lit.
    const moonAt = sys.bodies.moon.position;
    unit(sunDir, moonAt, sun);
    unit(toEarth, moonAt, sys.bodies.earth.position);
    unit(scratch, sys.bodies.earth.position, sun);
    const earthLit = (1 - (scratch.x * toEarth.x + scratch.y * toEarth.y + scratch.z * toEarth.z)) / 2;
    // ...and its own lit share of the face it turns to the Earth (its phase), for the Earth's moonlight.
    const moonLit = (1 + (sunDir.x * toEarth.x + sunDir.y * toEarth.y + sunDir.z * toEarth.z)) / 2;
    bodies.moon.update({ time: ambient, sun: sunDir, light: lightAt('moon'), earth: toEarth, earthLit }, origin3);
    unit(sunDir, sys.bodies.earth.position, sun);
    unit(toMoon, sys.bodies.earth.position, moonAt);
    bodies.earth.update({ time: ambient, sun: sunDir, light: lightAt('earth'), moon: toMoon, moonLit }, origin3);
    unit(sunDir, sys.bodies.jupiter.position, sun);
    bodies.jupiter.update({ time: ambient, sun: sunDir, light: lightAt('jupiter') }, origin3);
    unit(sunDir, sys.bodies.saturn.position, sun);
    bodies.saturn.update({ time: ambient, sun: sunDir, light: lightAt('saturn') }, origin3);
    // Saturn's ring particles: the camera in the rings' frame (km, doubles), the Sun in the view's.
    const particles = bodies.saturn.rings?.particles;
    if (particles?.enabled) {
      const sb = sys.bodies.saturn.basis;
      const rel = placed.saturn.rel;
      const column = (i: number): number => -(rel.x * (sb[3 * i] ?? 0) + rel.y * (sb[3 * i + 1] ?? 0) + rel.z * (sb[3 * i + 2] ?? 0));
      ringCamera.x = column(0);
      ringCamera.y = column(1);
      ringCamera.z = column(2);
      sunView.set(sunDir.x, sunDir.y, sunDir.z).applyQuaternion(viewTurn.copy(camera.quaternion).invert());
      const along = (i: number): number => sunDir.x * (sb[3 * i] ?? 0) + sunDir.y * (sb[3 * i + 1] ?? 0) + sunDir.z * (sb[3 * i + 2] ?? 0);
      sunRing.x = along(0);
      sunRing.y = along(1);
      sunRing.z = along(2);
      particles.update({
        camera: ringCamera,
        basis: sb,
        sunView,
        sunRing,
        view: camera.quaternion,
        light: lightAt('saturn'),
        pxPerRadian: pxPerTan,
        radiusKm: sys.specs.saturn.radiusKm,
        nearKm: lens.near,
      });
    }
    // Texture streaming: the focus (during a flight, the destination) and any planet large in view get the detail's maps.
    focusBodies.length = 0;
    for (const id of BODY_IDS) if (id === nav.focus || placed[id].radiusPx > LARGE_PX) focusBodies.push(id);
    bodies.setFocus(focusBodies);
    bodies.update(dt);

    // Stars at the back of the depth range, hidden by the bodies in front of them.
    stars.setRadius(lens.far * LENS.starShare);
    stars.setLight(STARS.light * adapted ** (STARS.follow - 1));

    // Orbit lines: the focus's own (and the Moon's around the Earth) up close, the rest as the view
    // widens; each only from where it reads as an orbit; none over the Sun seen through its filter.
    const focus = placed[nav.focus];
    const wide = nav.focus === 'sun' ? SUN_ORBITS_WIDE : ORBITS_WIDE;
    const bound = sys.specs[nav.focus].boundKm;
    const wideness = smoothstep(Math.log(wide.from * bound), Math.log(wide.to * bound), Math.log(Math.max(focus.distance, 1)));
    const settle = dt > 0 ? 1 - Math.exp(-dt / ORBITS_WIDE.seconds) : 0;
    orbitPaths.forEach((path, i) => {
      const own = path.body === nav.focus || (path.body === 'moon' && nav.focus === 'earth');
      const size = path.sizeKm;
      const nearBody = smoothstep(ORBIT_NEAR_BODY.from * size, ORBIT_NEAR_BODY.to * size, placed[path.body].distance);
      const fromCentre = Math.hypot(path.centre.x - origin.camera.x, path.centre.y - origin.camera.y, path.centre.z - origin.camera.z);
      const outside = smoothstep(ORBIT_INSIDE.from * size, ORBIT_INSIDE.to * size, fromCentre);
      const want = (own ? 1 : wideness) * nearBody * outside * (1 - filterAmount);
      const current = orbitWeights[i] ?? 0;
      orbitWeights[i] = current + (want - current) * (entering ? 1 : settle);
    });
    orbits.update({
      weights: orbitWeights,
      camera: origin.camera,
      forward,
      near: lens.near,
      far: lens.far,
      focus: sys.bodies[nav.focus].position,
      focusRadius: sys.specs[nav.focus].radiusKm,
      focusDistance: focus.distance,
      compensation: adapted,
      light: 1,
    });

    // Labels first: the ring markers of small bodies come and go with their tags.
    updateLabels(dt, viewportPx, widthPx);

    // Points of light for bodies under about 2 px, and rings marking them where they are named.
    BODY_IDS.forEach((id, i) => {
      const p = placed[id];
      const dot = dotList[i];
      if (!dot) return;
      const spec = sys.specs[id];
      const drawnRadius = spec.radiusKm * p.k;
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
        const body = sys.bodies[id].position;
        const sx = sun.x - body.x;
        const sy = sun.y - body.y;
        const sz = sun.z - body.z;
        const cos = (sx * -p.rel.x + sy * -p.rel.y + sz * -p.rel.z) / Math.max(1e-9, Math.hypot(sx, sy, sz) * p.distance);
        const phase = lambertPhase(Math.acos(Math.min(1, Math.max(-1, cos))));
        // A floor keeps a body seen against its night side findable, faintly.
        const brightness = 0.22 + 2.1 * style.albedo * phase;
        dot.color = [style.tint[0] * brightness, style.tint[1] * brightness, style.tint[2] * brightness];
      }
      dot.opacity = smoothstep(2.8, 1.2, p.radiusPx);
      dot.sizePx = style.sizePx;
      dot.marker = id === 'sun' ? 0 : (labelOpacity.get(id) ?? 0) * smoothstep(LABEL.markerPx, LABEL.markerPx / 2, p.radiusPx) * (1 - filterAmount);
    });
    dots.update(dotList, adapted);

    const sunPlaced = placed.sun;
    sunThroughEarth(sunTint);
    glare.update({
      position: sunPlaced.drawn,
      drawnRadius: sys.specs.sun.radiusKm * sunPlaced.k,
      radiusPx: sunPlaced.radiusPx,
      viewportPx,
      visible: sunVisible(),
      compensation: adapted,
      filtered: filterAmount,
      tint: sunTint,
    });
    entering = false;
  };

  /**
   * The colour of the Sun's light reaching the camera when the line to it grazes the Earth (a sunrise
   * seen from orbit): white above the air, reddening and dimming as the line sinks into it.
   */
  const sunThroughEarth = (out: [number, number, number]): void => {
    out[0] = 1;
    out[1] = 1;
    out[2] = 1;
    if (!system || !earthAirModel) return;
    const s = placed.sun;
    const e = placed.earth;
    if (e.distance >= s.distance) return;
    const along = (s.rel.x * e.rel.x + s.rel.y * e.rel.y + s.rel.z * e.rel.z) / Math.max(s.distance, 1e-9);
    if (along <= 0) return;
    const ux = s.rel.x / s.distance;
    const uy = s.rel.y / s.distance;
    const uz = s.rel.z / s.distance;
    const closest = Math.hypot(e.rel.x - ux * along, e.rel.y - uy * along, e.rel.z - uz * along);
    const radius = system.specs.earth.radiusKm;
    const [r, g, b] = limbTransmittance(earthAirModel, (closest - radius) / radius);
    out[0] = r;
    out[1] = g;
    out[2] = b;
  };

  /**
   * Compiles objects' pipelines for the target the frames really draw into: the post pipeline's scene
   * pass. three keys what it builds by render target, so pipelines compiled against the canvas (a
   * plain compileAsync) are built again, synchronously, the first frame each object is drawn: a stall
   * of a few hundred milliseconds for the Earth's shaders. compileAsync reads the target when it is
   * called, so it is bound only for the call, never across a frame. Before the first frame a stand-in
   * of the same formats is used.
   */
  const compileForFrames = async (objects: Object3D[]): Promise<void> => {
    const c = ctx;
    if (!c) return;
    const renderer = c.renderer;
    if (!frameTarget && !compileTarget) {
      compileTarget = new RenderTarget(1, 1, { type: renderer.getOutputBufferType(), depthBuffer: true });
      compileTarget.samples = renderer.samples;
      compileTarget.depthTexture = new DepthTexture(1, 1);
      compileTarget.texture.name = 'explore-compile-target';
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(frameTarget ?? compileTarget);
    const compiling = (): Array<Promise<void>> => {
      try {
        return objects.map((o) => renderer.compileAsync(o, c.camera, c.scene));
      } finally {
        renderer.setRenderTarget(previous);
      }
    };
    const pending = compiling();
    try {
      await Promise.all(pending);
    } catch (err) {
      console.warn('explore: could not compile ahead', err);
    }
  };

  /** What the view draws now that is illustrative, for the readout to say. */
  const illustrations = (): UniverseIllustration[] => {
    if (!system || !bodies) return [];
    const altitude = Math.max(0, placed[nav.focus].distance - system.specs[nav.focus].radiusKm);
    switch (nav.focus) {
      case 'sun':
        return ['sun-surface'];
      case 'earth': {
        const notes: UniverseIllustration[] = [];
        const viewportPx = (ctx?.renderer.domElement.clientHeight ?? 800) * (ctx?.renderer.getPixelRatio() ?? 1);
        const pxPerRadian = viewportPx / (2 * Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2)));
        if (fineDetailShown(bodies.detail, altitude / system.specs.earth.radiusKm, pxPerRadian)) notes.push('fine-detail');
        notes.push('cloud-drift');
        // The night side only when some of it is in view (the camera not straight over the noon side).
        const e = placed.earth;
        const s = placed.sun;
        const toCamera = -(e.rel.x * (s.rel.x - e.rel.x) + e.rel.y * (s.rel.y - e.rel.y) + e.rel.z * (s.rel.z - e.rel.z));
        const cos = toCamera / Math.max(1e-9, e.distance * Math.hypot(s.rel.x - e.rel.x, s.rel.y - e.rel.y, s.rel.z - e.rel.z));
        if (cos < 0.85) notes.push('night-side');
        return notes;
      }
      case 'moon': {
        const viewportPx = (ctx?.renderer.domElement.clientHeight ?? 800) * (ctx?.renderer.getPixelRatio() ?? 1);
        const pxPerRadian = viewportPx / (2 * Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2)));
        return craterDetailShown(bodies.detail, altitude / system.specs.moon.radiusKm, pxPerRadian) ? ['fine-detail', 'earthshine'] : ['earthshine'];
      }
      case 'jupiter':
        return ['band-drift'];
      case 'saturn':
        return bodies.saturn.rings?.particles?.object.visible ? ['ring-particles'] : [];
    }
  };

  /**
   * Turning slows near a surface: the height above the nearest one (Saturn's rings count, so a drag
   * among them glides instead of sweeping thousands of km a frame) over the focus's radius, at most 1.
   */
  const turnScale = (): number => {
    if (!system) return 1;
    const altitude = Math.min(placed[nav.focus].distance - system.specs[nav.focus].radiusKm, nearestKm);
    return Math.min(1, Math.max(0.005, altitude / system.specs[nav.focus].radiusKm));
  };

  /** Screen position of each body's centre this frame (CSS px), and whether it lies in front of the camera. */
  const screen = BODY_IDS.map(() => ({ x: 0, y: 0, front: false }));

  /**
   * Names beside the bodies: eased, hidden behind other bodies (a tag that would touch a nearer
   * body's disc goes, quickly), kept out of the band under the header where the hint sits and off the
   * interface below, never on top of each other, and the focus's own tag gone once it reads as a disc.
   */
  const updateLabels = (dt: number, viewportPx: number, widthPx: number): void => {
    const c = ctx;
    if (!c || !system) return;
    const camera = c.camera;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    BODY_IDS.forEach((id, i) => {
      const p = placed[id];
      const at = projected.set(p.drawn.x, p.drawn.y, p.drawn.z).project(camera);
      const out = screen[i];
      if (!out) return;
      out.x = ((at.x + 1) / 2) * widthPx;
      out.y = ((1 - at.y) / 2) * viewportPx;
      out.front = at.z < 1 && at.z > -1;
    });
    const order = [...BODY_IDS].sort((a, b) => (a === nav.focus ? -1 : b === nav.focus ? 1 : placed[b].radiusPx - placed[a].radiusPx));
    const taken: Array<{ x: number; y: number }> = [];
    const next: SceneLabel[] = [];
    const ease = 1 - Math.exp(-Math.max(0, dt) / LABEL.seconds);
    const hide = 1 - Math.exp(-Math.max(0, dt) / LABEL.hideSeconds);
    const top = insets.top + LABEL.hintPx;
    const bottom = viewportPx - insets.bottom;
    for (const id of order) {
      const spec = system.specs[id];
      const p = placed[id];
      // At the limb of a visible disc; at the centre of a point, beside its ring marker.
      const drawnRadius = spec.radiusKm * p.k * 1.08 * smoothstep(LABEL.markerPx, LABEL.markerPx * 3, p.radiusPx);
      const anchor = projected.set(p.drawn.x, p.drawn.y, p.drawn.z).addScaledVector(right, drawnRadius);
      const position: [number, number, number] = [anchor.x, anchor.y, anchor.z];
      anchor.project(camera);
      const sx = ((anchor.x + 1) / 2) * widthPx;
      const sy = ((1 - anchor.y) / 2) * viewportPx;
      let want = anchor.z < 1 && anchor.z > -1 && p.radiusPx < LABEL.maxDiscPx ? 0.92 : 0;
      // The focus is named by the readout: its tag goes once it is more than a point.
      if (id === nav.focus && !nav.travelling && p.radiusPx > LABEL.focusDiscPx) want = 0;
      if (want > 0 && (sy < top || sy > bottom || sx < 0 || sx > widthPx)) want = 0;
      const hidden = want > 0 && occluded(id, sx, sy);
      if (hidden) want = 0;
      if (want > 0 && taken.some((t) => Math.abs(t.x - sx) < LABEL.clearX && Math.abs(t.y - sy) < LABEL.clearY)) want = 0;
      if (want > 0) taken.push({ x: sx, y: sy });
      const was = labelOpacity.get(id) ?? 0;
      const now = was + (want - was) * (entering ? 1 : want < was && (hidden || id === nav.focus) ? hide : ease);
      labelOpacity.set(id, now < 1e-3 && want === 0 ? 0 : now);
      if (now > 1e-3) next.push({ id: `body-${id}`, textKey: spec.nameKey, position, opacity: now });
    }
    labels = next;
  };

  /**
   * True when a nearer body covers this body's centre, or its disc on screen reaches the tag (its
   * anchor at (sx, sy) and about LABEL.widthPx of text to the right of it).
   */
  const occluded = (id: BodyId, sx: number, sy: number): boolean => {
    if (!system) return false;
    const p = placed[id];
    for (const [j, other] of BODY_IDS.entries()) {
      if (other === id) continue;
      const q = placed[other];
      if (q.distance >= p.distance) continue;
      const cosSep = (p.rel.x * q.rel.x + p.rel.y * q.rel.y + p.rel.z * q.rel.z) / Math.max(1e-9, p.distance * q.distance);
      const angularRadius = Math.asin(Math.min(1, system.specs[other].radiusKm / Math.max(q.distance, 1e-9)));
      if (Math.acos(Math.min(1, Math.max(-1, cosSep))) < angularRadius) return true;
      const disc = screen[j];
      if (!disc?.front || q.radiusPx < 2) continue;
      // The tag's nearest point to the disc's centre, against the disc (and a few px of margin).
      const nx = Math.min(Math.max(disc.x, sx), sx + LABEL.widthPx);
      if (Math.hypot(nx - disc.x, sy - disc.y) < q.radiusPx + 6) return true;
    }
    return false;
  };

  const navBodies = (sys: SolarSystem): NavWorld => {
    const list: NavBody[] = BODY_IDS.map((id) => {
      const spec = sys.specs[id];
      const b = sys.bodies[id].basis;
      const pole = km(b[3] ?? 0, b[4] ?? 1, b[5] ?? 0);
      return {
        id,
        radiusKm: spec.radiusKm,
        boundKm: spec.boundKm,
        minAltitudeKm: spec.minAltitudeKm,
        fill: spec.fill,
        view: spec.view,
        position: sys.bodies[id].position,
        // The pole moves only over centuries; its direction is read live all the same.
        get pole() {
          pole.x = b[3] ?? 0;
          pole.y = b[4] ?? 1;
          pole.z = b[5] ?? 0;
          return pole;
        },
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
      tier = c.quality.tier;
      const [planets, moon, physical, volume, manifest] = await Promise.all([
        c.assets.json<PlanetsFile>('assets/jpl/planets.json'),
        c.assets.json<MoonFile>('assets/jpl/moon.json'),
        c.assets.json<PhysicalFile>(PHYSICAL_URL),
        createNoiseVolume(NOISE.size, NOISE.seed),
        c.assets.json<PlanetsManifest>(PLANETS_MANIFEST_URL),
        c.data.ready,
      ]);
      noise = volume;
      timeConstants = physical.time;
      const valid = validRange(moon);
      range = { startJd: Math.max(valid.planets.startJd, valid.moon.startJd), endJd: Math.min(valid.planets.endJd, valid.moon.endJd) };
      system = createSolarSystem(planets, moon, physical);
      world = navBodies(system);
      ringSphere.innerKm = physical.saturnRings.innerKm;
      ringSphere.outerKm = physical.saturnRings.outerKm;
      // The mission maps stream by detail (Low on entry, the focus raised after); the Earth's air from the cited model.
      const detail = wantDetail ?? DETAIL_FOR_TIER[tier];
      wantDetail = null;
      const renderer = c.renderer;
      rawDecoder = createRawDecoder();
      const textures = createPlanetTextures({ assets: c.assets, manifest, detail, upload: createUploader(renderer), raw: rawDecoder });
      textures.setRingPlaceholder(ringTransmission(physical.saturnRings), physical.saturnRings.innerKm, physical.saturnRings.outerKm);
      const sunKm = system.specs.sun.radiusKm;
      const air = earthAir(c.data, system.specs.earth.radiusKm, Math.asin(sunKm / physical.auKm));
      earthAirModel = air;
      airTable = createTransmittanceTable(air);
      const strip = findPlanetTexture(manifest, 'saturn', 'rings', 'low')?.radiusKm ?? [physical.saturnRings.innerKm, physical.saturnRings.outerKm];
      bodies = createBodies({
        noise: volume,
        specs: system.specs,
        ringSpanKm: strip,
        textures,
        air,
        table: airTable,
        sunLimb: { a1: c.data.constant('sun.limbDarkening.a1').value, a2: c.data.constant('sun.limbDarkening.a2').value },
        sunAngularRadius: Math.asin(sunKm / physical.auKm),
        detail,
        compile: (objects) => compileForFrames(objects),
      });
      stars = createStarfield(STAR_COUNT.high, 400, 7_101, { depthTest: true, dynamicRadius: true });
      stars.object.count = STAR_COUNT[tier];
      // The stars are drawn every frame inside the post pipeline's scene pass: the target bound then is
      // the one the explorer's pipelines must be compiled for (compileForFrames).
      stars.object.onBeforeRender = (r: unknown) => {
        const target = (r as { getRenderTarget(): RenderTarget | null }).getRenderTarget();
        if (target && target !== compileTarget) frameTarget = target;
      };
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
      root.add(stars.object, orbits.mesh, dots.object, glare.object, ...BODY_IDS.map((id) => bodies?.objects[id]).filter((o): o is Group => o !== undefined), ...bodies.extras);
      input = createInput(c.renderer.domElement, nav, turnScale);
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
      ambient = 0;
      setDate(pinnedUtc);
      system.update(jdTdb);
      nav.reducedMotion = c.reducedMotion;
      // Framing needs the view before the first pose is chosen.
      const viewportPx = c.renderer.domElement.clientHeight || 1;
      nav.setView({
        tanHalfFov: Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2)),
        aspect: (c.renderer.domElement.clientWidth || 1) / viewportPx,
        top: insets.top / viewportPx,
        bottom: insets.bottom / viewportPx,
      });
      nav.begin(world, wantBody ?? DEFAULT_BODY, true);
      wantBody = null;
      // A fresh mirror of the limiter, already adapted, so guides are steady from the first frame.
      adaptation = createExposureControl({ reducedMotion: c.reducedMotion });
      adaptation.setFade(1);
      adaptation.setTarget(exposureFor(nav.focus));
      adaptation.jump();
      for (const id of BODY_IDS) labelOpacity.set(id, 0);
      input?.attach();
      // Place everything once, then let the warm-up compile every material, in view or not (for the
      // target the frames draw into, so no body compiles again when it first comes into view).
      entering = true;
      frame(0);
      setCulling(false);
      if (glare) glare.object.visible = true;
      if (dots) dots.object.visible = true;
      warming = 2;
    },

    update(dt) {
      if (warming > 0) {
        warming -= 1;
        if (warming === 0) setCulling(true);
      }
      frame(dt);
    },

    setQuality(profile) {
      tier = profile.tier;
      if (bodies) void bodies.setDetail(DETAIL_FOR_TIER[tier]);
      else wantDetail = DETAIL_FOR_TIER[tier];
      if (stars) stars.object.count = STAR_COUNT[tier];
    },

    get detail() {
      return bodies?.detail ?? wantDetail ?? DETAIL_FOR_TIER[tier];
    },

    setDetail(detail) {
      if (bodies) void bodies.setDetail(detail);
      else wantDetail = detail;
    },

    focus(body) {
      if (!world || !entered) {
        wantBody = body;
        return;
      }
      nav.flyTo(world, body);
    },

    view,

    setInsets(next) {
      insets = { top: next.top, bottom: next.bottom };
    },

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
      // Placed at once, everything eased starts where it belongs, the exposure too (the engine's jumps with it).
      entering = true;
      frame(0);
      adaptation.jump();
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
      // Only the Low maps stay while the film plays; the focus's are fetched again on the next visit.
      bodies?.suspend();
      entered = false;
      labels = [];
      ctx?.exposure.setVeil(1);
    },

    dispose() {
      root.removeFromParent();
      input?.detach();
      bodies?.dispose();
      stars?.dispose();
      orbits?.dispose();
      dots?.dispose();
      glare?.dispose();
      noise?.dispose();
      airTable = null;
      compileTarget?.dispose();
      compileTarget = null;
      frameTarget = null;
      rawDecoder?.dispose();
      rawDecoder = null;
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
