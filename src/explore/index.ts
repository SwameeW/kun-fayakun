/**
 * The solar-system explorer ("universe"): the Sun, the Earth of today, the Moon, Jupiter and
 * Saturn at true scale, where NASA JPL's data puts them on the date, turned as they really stand.
 * Loaded on demand as its own chunk and hosted by src/core/universe-host.ts.
 *
 * Each frame: the date moves on in real time; the bodies are placed from the ephemeris (float64
 * km); the camera orbits, flies or travels (./navigation); then everything is rebased so the camera
 * sits at the origin (./space/origin), the depth range follows the altitude (./space/lens), and
 * bodies beyond it are drawn in scaled space at their exact angular size (./space/scaled-space).
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
 *
 * Detail (./detail, ./quality): the explorer runs one rung of the Ultra/High/Medium/Low ladder,
 * chosen from what the device says about itself (or by the visitor), and its governor trades the
 * scene's internal resolution, then whole rungs, for smooth frames. The rung reaches the bodies
 * through one call (applyDetail, bodies.setDetail) along with the stars, bloom and the canvas's
 * pixel-ratio cap. Notes about what the camera is near come from ./discoveries.
 */

import { Group, MathUtils, Matrix4, Mesh, Vector3, type Data3DTexture, type Object3D } from 'three/webgpu';
import { validRange, type MoonFile, type PlanetsFile } from '../astro/ephemeris';
import { PHYSICAL_URL, ringTransmission, type PhysicalFile } from '../astro/physical';
import { julianDateUtc, utcToTdb } from '../astro/time';
import { createNoiseVolume } from '../chapters/shared/noise-volume';
import { blackbodyRgb } from '../chapters/shared/blackbody';
import { createStarfield, type Starfield } from '../chapters/shared/starfield';
import { DEFAULT_FOV } from '../core/camera';
import { setHook } from '../core/hooks';
import { createExposureControl, type EngineExposure } from '../core/post';
import {
  BODY_IDS,
  type BodyId,
  type SceneLabel,
  type UniverseBodyView,
  type UniverseContext,
  type UniverseModule,
  type UniversePose,
  type UniverseSteer,
  type UniverseView,
  type ViewInsets,
} from '../core/types';
import { createBodies, SUN_KELVIN, type Bodies } from './bodies';
import { createSunGlare, visibleShare, type SunGlare } from './bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { DETAIL, EXPLORE_TIERS, FILM_TIER, type ExploreDetail, type ExploreTier } from './detail';
import { deriveFacts, Discoveries, type Discovery, type DiscoveryInput } from './discoveries';
import { createInput, type ExploreInput } from './input';
import { Navigator, navOutput, type NavBody, type NavWorld } from './navigation';
import { createOrbits, moonOrbit, planetOrbit, type Orbits, type OrbitPath } from './orbits';
import { availableTiers, createDetailGovernor, initialTier, type DetailChoice, type DetailGovernor, type GovernorDecision } from './quality';
import { lensFor, LENS, nearestAltitude, type Lens, type Sphere } from './space/lens';
import { FloatingOrigin, km, renderToEcliptic, type Km } from './space/origin';
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
const SUN_FILTER = { fromPx: 12, toPx: 110, color: [1, 0.5, 0.12], white: 5, filtered: 1 } as const;
/**
 * The Moon is dark (it reflects about an eighth of its light, less than half the Earth's share), so
 * with the Moon in view the exposure opens a little further, as a camera's would; beside the Earth
 * it still looks the darker of the two, as it is.
 */
const MOON_EXPOSURE = 1.1;
/** The starfield's light, and how much of the exposure's adaptation it shows (0 none, 1 all of it). */
const STARS = { light: 0.85, follow: 0.2 } as const;
/** The starfield holds the most stars any rung draws; each rung draws a prefix (a fair subsample of one random field). */
const STAR_MAX = Math.max(...EXPLORE_TIERS.map((t) => DETAIL[t].starCount));

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
 * Labels: easing, when a body's tag gives way (its disc is big enough to need none), how close two
 * may sit, and below what disc radius (px) a tag is anchored at the body's centre beside its ring
 * marker rather than at its limb.
 */
const LABEL = { seconds: 0.35, maxDiscPx: 70, clearX: 90, clearY: 22, markerPx: 4 } as const;
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
/** A tap within this many CSS px of a body's disc (or its point) picks it. */
const PICK_PX = 22;
/** How much brighter the orbit lines are during a trip (eased in and out with the lines' own weights). */
const TRIP_ORBIT_GLOW = 0.8;

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
  /** Where its centre falls on the canvas (CSS px from its top left), and whether it is in front of the camera. */
  screenX: number;
  screenY: number;
  inView: boolean;
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
const dot3 = (a: Km, b: Km): number => a.x * b.x + a.y * b.y + a.z * b.z;

export default function create(): UniverseModule {
  const root = new Group();
  root.name = 'universe';
  let ctx: UniverseContext | null = null;
  let system: SolarSystem | null = null;
  let bodies: Bodies | null = null;
  let stars: Starfield | null = null;
  let orbits: Orbits | null = null;
  let orbitPaths: OrbitPath[] = [];
  const orbitWeights: number[] = [];
  /** The first frame after enter() or place(): eased values start where they belong. */
  let entering = true;
  /** The first update after the warm-up: frustum culling comes back on (it was off so every pipeline compiled). */
  let warming = false;
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
  let insets: Required<ViewInsets> = { top: 0, bottom: 0, left: 0, right: 0 };
  /** The clear part's offset from the middle of the view, CSS px, eased so a readout growing a line never jolts the view. */
  let offsetPx = 0;
  let offsetXPx = 0;

  /* Detail: the rung running, the governor, what the device allows, and the visitor's wish. */
  let detail: ExploreDetail = DETAIL.high;
  let governor: DetailGovernor | null = null;
  let available: readonly ExploreTier[] = EXPLORE_TIERS;
  let fixed = false;
  let pendingChoice: DetailChoice | null = null;
  let renderScale = 1;

  /* Discoveries: facts from cited data, the note now, and the log. */
  let discoveries: Discoveries | null = null;
  let discovery: Discovery | null = null;
  let lightKmS = 0;

  /* Trips, for the data-travel hook: whether one was under way, and whether Esc stopped it; and the orbits' glow. */
  let tripGlow = 0;
  let wasTravelling = false;
  let stopped = false;
  let tripStartKm = 0;

  const nav = new Navigator(DEFAULT_BODY);
  const navOut = navOutput();
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

  const placed = Object.fromEntries(
    BODY_IDS.map((id) => [id, { rel: km(), drawn: km(), distance: 0, k: 1, radiusPx: 0, screenX: 0, screenY: 0, inView: false }]),
  ) as Record<BodyId, Placed>;
  const labelOpacity = new Map<BodyId, number>(BODY_IDS.map((id) => [id, 0]));
  let labels: SceneLabel[] = [];
  const dotList: ImpostorDot[] = BODY_IDS.map(() => ({ position: km(), color: [0, 0, 0], opacity: 0, sizePx: 6, marker: 0 }));
  /** Saturn's rings' span and pole, for the lens (set from physical.json on load, the pole each frame). */
  const ringSphere = { pole: km(0, 1, 0), innerKm: 0, outerKm: 0 };
  const spheres: Sphere[] = BODY_IDS.map((id) => (id === 'saturn' ? { centre: km(), radius: 0, ring: ringSphere } : { centre: km(), radius: 0 }));
  /** Each body as the camera sees it (for the navigator), refreshed every frame. */
  const bodyViews: UniverseBodyView[] = BODY_IDS.map((id) => ({
    id,
    distanceKm: 0,
    lightSeconds: 0,
    lit: 1,
    limbAngle: 0,
    ringOpening: 0,
    screen: { x: 0, y: 0, radiusPx: 0, inView: false },
    ecliptic: { x: 0, y: 0, z: 0 },
  }));
  const phaseAngles = Object.fromEntries(BODY_IDS.map((id) => [id, 0])) as Record<BodyId, number>;
  const cameraEcliptic = { x: 0, y: 0, z: 0, heading: 0 };

  const look = new Matrix4();
  const target = new Vector3();
  const up = new Vector3(0, 1, 0);
  const eye = new Vector3();
  const basis = new Matrix4();
  const right = new Vector3();
  const camUp = new Vector3();
  const projected = new Vector3();
  const origin3 = new Vector3();
  const sunDir = km();
  const toEarth = km();
  const scratch = km();
  const scratch2 = km();
  const forward = km();

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
   * The view's exposure: the focus's, and during a trip the log blend of where it left and where
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

  const detailState = (): UniverseView['detail'] => ({
    tier: detail.tier,
    choice: governor?.choice ?? 'auto',
    available,
    renderScale,
    fixed,
  });

  const view = (): UniverseView => {
    const cam = origin.camera;
    const focus = nav.focus;
    const spec = system?.specs[focus];
    const p = system?.bodies[focus].position ?? km();
    const distanceKm = Math.hypot(cam.x - p.x, cam.y - p.y, cam.z - p.z);
    const auKm = system?.auKm ?? 1;
    const fromSun = Math.max(1, Math.hypot(cam.x, cam.y, cam.z));
    const altitudeKm = distanceKm - (spec?.radiusKm ?? 0);
    const trip = nav.tripState;
    return {
      focus,
      travelling: nav.travelling,
      from: navOut.from,
      moving: nav.moving,
      distanceKm,
      altitudeKm,
      sunlight: (auKm / fromSun) ** 2,
      solarFilter: filterAmount > 0.5,
      jdTdb,
      unixMs: (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000,
      mode: navOut.mode,
      speedKmS: navOut.speedKmS,
      trip: trip ? { progress: trip.progress, remainingKm: Math.max(0, altitudeKm), startKm: tripStartKm, endKm: trip.endKm } : null,
      bodies: bodyViews,
      camera: cameraEcliptic,
      discovery: discovery ? { id: discovery.id, values: discovery.values } : null,
      witnessed: discoveries?.witnessed ?? [],
      detail: detailState(),
      auKm,
      lightKmS,
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

  /**
   * The one place a detail rung reaches the scene: the bodies (what they draw and stream), the
   * stars, bloom and the canvas's pixel-ratio cap. The governor, the visitor's menu and tests all
   * come through here.
   */
  const applyDetail = (next: ExploreDetail): void => {
    detail = next;
    if (bodies) {
      bodies.setDetail(detail);
    }
    if (stars) stars.object.count = Math.min(STAR_MAX, detail.starCount);
    if (entered && ctx) {
      ctx.graphics.setBloom(detail.bloom);
      ctx.graphics.setDprCap(detail.dprCap);
    }
    setHook('data-detail', entered ? detail.tier : null);
  };

  const applyDecision = (decision: GovernorDecision | null): void => {
    if (!decision) return;
    if (decision.tier && decision.tier !== detail.tier) applyDetail(DETAIL[decision.tier]);
    if (decision.scale !== undefined) {
      renderScale = decision.scale;
      if (entered) ctx?.graphics.setRenderScale(renderScale);
    }
  };

  /** The body under a point of the canvas (client px), nearest the camera when discs overlap. */
  const pick = (clientX: number, clientY: number): BodyId | null => {
    const c = ctx;
    if (!c) return null;
    const rect = c.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: BodyId | null = null;
    let bestDistance = Infinity;
    for (const id of BODY_IDS) {
      const p = placed[id];
      if (!p.inView) continue;
      const reach = Math.max(PICK_PX, p.radiusPx * 1.04);
      if (Math.hypot(p.screenX - x, p.screenY - y) > reach) continue;
      if (p.distance < bestDistance) {
        bestDistance = p.distance;
        best = id;
      }
    }
    return best;
  };

  const frame = (dt: number): void => {
    const c = ctx;
    if (!c || !system || !bodies || !stars || !orbits || !dots || !glare || !world) return;
    const sys = system;
    nav.reducedMotion = c.reducedMotion;
    adaptation.setReducedMotion(c.reducedMotion);
    elapsed += dt;
    jdTdb = Math.min(range.endJd, jdTdb + dt / SECONDS_PER_DAY);
    jdUtc += dt / SECONDS_PER_DAY;
    sys.update(jdTdb);
    for (const path of orbitPaths) path.setDate(jdTdb);

    // The view the bodies are framed in: the camera's resting lens and what the interface covers.
    const camera = c.camera;
    const viewportPx = c.renderer.domElement.clientHeight || 1;
    const widthPx = c.renderer.domElement.clientWidth || 1;
    nav.viewportPx = viewportPx;
    nav.setView(
      {
        tanHalfFov: Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2)),
        aspect: widthPx / viewportPx,
        top: insets.top / viewportPx,
        bottom: insets.bottom / viewportPx,
        left: insets.left / widthPx,
        right: insets.right / widthPx,
      },
      DEFAULT_FOV,
    );

    // The camera, in doubles; then everything relative to it.
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
    lensFor(nearestAltitude(spheres), lens);

    // The camera: at the origin, along the navigator's gaze and "up" (its bank included), turned so
    // the body sits in the middle of the part of the view the interface leaves clear, with this
    // frame's lens and depth range.
    camera.position.set(0, 0, 0);
    target.set(navOut.forward.x, navOut.forward.y, navOut.forward.z);
    up.set(navOut.up.x, navOut.up.y, navOut.up.z);
    if (target.lengthSq() > 0) {
      // Matrix4.lookAt from the eye toward the target is a camera's orientation (it looks down -z).
      look.lookAt(eye, target, up);
      camera.quaternion.setFromRotationMatrix(look);
    }
    const fov = navOut.fov;
    const tanHalf = Math.tan(MathUtils.degToRad(fov / 2));
    const pxPerTan = viewportPx / (2 * tanHalf);
    const settle = entering ? 1 : 1 - Math.exp(-Math.max(0, dt) / INSET_SECONDS);
    offsetPx += ((insets.bottom - insets.top) / 2 - offsetPx) * settle;
    offsetXPx += ((insets.right - insets.left) / 2 - offsetXPx) * settle;
    camera.rotateX(-Math.atan(offsetPx / pxPerTan));
    camera.rotateY(-Math.atan(offsetXPx / pxPerTan));
    camera.up.copy(up);
    camera.near = lens.near;
    camera.far = lens.far;
    camera.fov = fov;
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
      // On screen: where its centre falls, for picking and the navigator.
      projected.set(p.drawn.x, p.drawn.y, p.drawn.z).project(camera);
      p.inView = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1;
      p.screenX = ((projected.x + 1) / 2) * widthPx;
      p.screenY = ((1 - projected.y) / 2) * viewportPx;
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
    bodies.sun.update({ time: elapsed, kelvin: SUN_KELVIN, light: sunDisplay / adapted, filter: filterColor });
    unit(sunDir, sys.bodies.earth.position, sun);
    bodies.earth.update({ time: elapsed * 0.1, sun: sunDir, light: lightAt('earth'), radius: sys.specs.earth.radiusKm * placed.earth.k });
    // The Moon: sunlight, and earthshine from as much of the Earth's face toward it as is lit.
    const moonAt = sys.bodies.moon.position;
    unit(sunDir, moonAt, sun);
    unit(toEarth, moonAt, sys.bodies.earth.position);
    unit(scratch, sys.bodies.earth.position, sun);
    const earthLit = (1 - (scratch.x * toEarth.x + scratch.y * toEarth.y + scratch.z * toEarth.z)) / 2;
    bodies.moon.update({ time: elapsed, sun: sunDir, light: lightAt('moon'), earth: toEarth, earthLit }, origin3);
    unit(sunDir, sys.bodies.jupiter.position, sun);
    bodies.jupiter.update({ sun: sunDir, light: lightAt('jupiter') }, origin3);
    unit(sunDir, sys.bodies.saturn.position, sun);
    bodies.saturn.update({ sun: sunDir, light: lightAt('saturn') }, origin3);

    // Stars at the back of the depth range, hidden by the bodies in front of them.
    stars.setRadius(lens.far * LENS.starShare);
    stars.setLight(STARS.light * adapted ** (STARS.follow - 1));

    // Orbit lines: the focus's own (and the Moon's around the Earth) up close, the rest as the view
    // widens; each only from where it reads as an orbit; none over the Sun seen through its filter.
    const focus = placed[nav.focus];
    const wide = nav.focus === 'sun' ? SUN_ORBITS_WIDE : ORBITS_WIDE;
    const bound = sys.specs[nav.focus].boundKm;
    const wideness = smoothstep(Math.log(wide.from * bound), Math.log(wide.to * bound), Math.log(Math.max(focus.distance, 1)));
    const orbitSettle = dt > 0 ? 1 - Math.exp(-dt / ORBITS_WIDE.seconds) : 0;
    orbitPaths.forEach((path, i) => {
      const own = path.body === nav.focus || (path.body === 'moon' && nav.focus === 'earth');
      const size = path.sizeKm;
      const nearBody = smoothstep(ORBIT_NEAR_BODY.from * size, ORBIT_NEAR_BODY.to * size, placed[path.body].distance);
      const fromCentre = Math.hypot(path.centre.x - origin.camera.x, path.centre.y - origin.camera.y, path.centre.z - origin.camera.z);
      const outside = smoothstep(ORBIT_INSIDE.from * size, ORBIT_INSIDE.to * size, fromCentre);
      const want = (own ? 1 : wideness) * nearBody * outside * (1 - filterAmount);
      const current = orbitWeights[i] ?? 0;
      orbitWeights[i] = current + (want - current) * (entering ? 1 : orbitSettle);
    });
    // On a trip the orbit lines come up a little (eased): sweeping past, they are what shows the motion.
    tripGlow += ((nav.travelling && !c.reducedMotion ? 1 : 0) - tripGlow) * (entering ? 1 : orbitSettle);
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
      light: 1 + TRIP_ORBIT_GLOW * tripGlow,
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
    glare.update({
      position: sunPlaced.drawn,
      drawnRadius: sys.specs.sun.radiusKm * sunPlaced.k,
      radiusPx: sunPlaced.radiusPx,
      viewportPx,
      visible: sunVisible(),
      compensation: adapted,
      filtered: filterAmount,
    });

    describe(camera);
    trackTrips();
    entering = false;
  };

  /**
   * Every body as the camera sees it, for the navigator (distance, light-time, phase and the bright
   * limb's direction, Saturn's ring opening, place in the ecliptic), and the note and log of discoveries.
   */
  const describe = (camera: UniverseContext['camera']): void => {
    if (!system) return;
    const sys = system;
    const sun = sys.bodies.sun.position;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    BODY_IDS.forEach((id, i) => {
      const v = bodyViews[i];
      if (!v) return;
      const p = placed[id];
      const body = sys.bodies[id].position;
      v.distanceKm = Math.max(0, p.distance - sys.specs[id].radiusKm);
      v.lightSeconds = lightKmS > 0 ? p.distance / lightKmS : 0;
      v.screen.x = p.screenX;
      v.screen.y = p.screenY;
      v.screen.radiusPx = p.radiusPx;
      v.screen.inView = p.inView;
      renderToEcliptic({ x: body.x - sun.x, y: body.y - sun.y, z: body.z - sun.z }, v.ecliptic);
      if (id === 'sun') {
        v.lit = 1;
        v.limbAngle = 0;
        phaseAngles[id] = 0;
        return;
      }
      // Phase angle at the body between the Sun and the camera; the Sun's direction on screen.
      unit(sunDir, body, sun);
      const toCamera = scratch2;
      toCamera.x = -p.rel.x / Math.max(1e-9, p.distance);
      toCamera.y = -p.rel.y / Math.max(1e-9, p.distance);
      toCamera.z = -p.rel.z / Math.max(1e-9, p.distance);
      const cos = Math.min(1, Math.max(-1, dot3(sunDir, toCamera)));
      phaseAngles[id] = Math.acos(cos);
      v.lit = (1 + cos) / 2;
      v.limbAngle = Math.atan2(sunDir.x * camUp.x + sunDir.y * camUp.y + sunDir.z * camUp.z, sunDir.x * right.x + sunDir.y * right.y + sunDir.z * right.z);
      if (id === 'saturn') {
        const b = sys.bodies.saturn.basis;
        v.ringOpening = Math.asin(Math.min(1, Math.max(-1, (b[3] ?? 0) * toCamera.x + (b[4] ?? 1) * toCamera.y + (b[5] ?? 0) * toCamera.z)));
      }
    });
    renderToEcliptic(origin.camera, cameraEcliptic);
    renderToEcliptic(forward, scratch);
    cameraEcliptic.heading = Math.atan2(scratch.y, scratch.x);

    if (!discoveries) return;
    const earth = sys.bodies.earth.position;
    const moon = sys.bodies.moon.position;
    // The Moon from the Earth: lit share, and waxing while it is east of the Sun (counterclockwise seen from ecliptic north).
    unit(sunDir, moon, sun);
    unit(toEarth, moon, earth);
    const moonCos = dot3(sunDir, toEarth);
    const geoSun = { x: sun.x - earth.x, y: sun.y - earth.y, z: sun.z - earth.z };
    const geoMoon = { x: moon.x - earth.x, y: moon.y - earth.y, z: moon.z - earth.z };
    // Ecliptic north is +y in the render frame.
    const waxing = geoSun.z * geoMoon.x - geoSun.x * geoMoon.z > 0;
    unit(scratch, earth, sun);
    unit(scratch2, earth, moon);
    const earthFromMoon = (1 + dot3(scratch, scratch2)) / 2;
    const saturnBasis = sys.bodies.saturn.basis;
    unit(scratch, sys.bodies.saturn.position, sun);
    const ringTilt = Math.asin(Math.min(1, Math.max(-1, (saturnBasis[3] ?? 0) * scratch.x + (saturnBasis[4] ?? 1) * scratch.y + (saturnBasis[5] ?? 0) * scratch.z)));
    const v = view();
    const input: DiscoveryInput = {
      focus: nav.focus,
      travelling: nav.travelling,
      altitudeKm: v.altitudeKm,
      radiusKm: sys.specs[nav.focus].radiusKm,
      framedAltitudeKm: world ? nav.framingKm(world.body(nav.focus)) - sys.specs[nav.focus].radiusKm : 0,
      phaseAngle: phaseAngles,
      discPx: Object.fromEntries(BODY_IDS.map((id) => [id, placed[id].radiusPx])) as Record<BodyId, number>,
      inView: Object.fromEntries(BODY_IDS.map((id) => [id, placed[id].inView])) as Record<BodyId, boolean>,
      moonLit: (1 + moonCos) / 2,
      moonWaxing: waxing,
      earthLitFromMoon: earthFromMoon,
      ringTiltDeg: (ringTilt * 180) / Math.PI,
      sunEarthKm: Math.hypot(earth.x - sun.x, earth.y - sun.y, earth.z - sun.z),
      sunCameraKm: Math.hypot(origin.camera.x - sun.x, origin.camera.y - sun.y, origin.camera.z - sun.z),
      sunlight: v.sunlight,
      solarFilter: v.solarFilter,
    };
    discovery = discoveries.update(input);
  };

  /** The data-travel hook: "flying" while a trip is under way, then "arrived" or "stopped". */
  const trackTrips = (): void => {
    const travelling = nav.travelling;
    if (travelling && !wasTravelling) {
      stopped = false;
      const to = system?.specs[nav.focus];
      const p = system?.bodies[nav.focus].position;
      tripStartKm = to && p ? Math.max(0, Math.hypot(origin.camera.x - p.x, origin.camera.y - p.y, origin.camera.z - p.z) - to.radiusKm) : 0;
      setHook('data-travel', 'flying');
    } else if (!travelling && wasTravelling) {
      setHook('data-travel', stopped ? 'stopped' : 'arrived');
    }
    wasTravelling = travelling;
  };

  /** Names beside the bodies: eased, hidden behind other bodies, and never on top of each other. */
  const updateLabels = (dt: number, viewportPx: number, widthPx: number): void => {
    const c = ctx;
    if (!c || !system) return;
    const camera = c.camera;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const order = [...BODY_IDS].sort((a, b) => (a === nav.focus ? -1 : b === nav.focus ? 1 : placed[b].radiusPx - placed[a].radiusPx));
    const taken: Array<{ x: number; y: number }> = [];
    const next: SceneLabel[] = [];
    const ease = 1 - Math.exp(-Math.max(0, dt) / LABEL.seconds);
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
      if (want > 0 && occluded(id)) want = 0;
      if (want > 0 && taken.some((t) => Math.abs(t.x - sx) < LABEL.clearX && Math.abs(t.y - sy) < LABEL.clearY)) want = 0;
      if (want > 0) taken.push({ x: sx, y: sy });
      const was = labelOpacity.get(id) ?? 0;
      const now = was + (want - was) * (entering ? 1 : ease);
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

  const steer = (command: UniverseSteer): boolean => {
    if (!world || !entered) return false;
    if (command === 'stop') {
      const did = nav.cancelTravel(world);
      if (did) stopped = true;
      return did;
    }
    const was = nav.mode;
    nav.orbitNearest(world);
    return was === 'flight';
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
      ringSphere.innerKm = physical.saturnRings.innerKm;
      ringSphere.outerKm = physical.saturnRings.outerKm;

      // The rung to start on: the address's, else the device's own (never Ultra on its own).
      const device = c.graphics.device;
      available = availableTiers(device);
      const fixedDetail = c.graphics.fixedDetail;
      fixed = !c.graphics.adaptive;
      const start: ExploreTier = fixedDetail ? (available.includes(fixedDetail) ? fixedDetail : 'high') : initialTier(device);
      const minScale = Object.fromEntries(EXPLORE_TIERS.map((t) => [t, DETAIL[t].minRenderScale])) as Record<ExploreTier, number>;
      governor = createDetailGovernor({ tier: start, choice: 'auto', enabled: c.graphics.adaptive, available, minScale, mobile: device.mobile });
      detail = DETAIL[start];
      if (pendingChoice) {
        const choice = pendingChoice;
        pendingChoice = null;
        if (!fixedDetail) {
          const decision = governor.choose(choice);
          if (decision?.tier) detail = DETAIL[decision.tier];
        }
      }

      const rings = { innerKm: ringSphere.innerKm, outerKm: ringSphere.outerKm, transmission: ringTransmission(physical.saturnRings) };
      bodies = createBodies(volume, system.specs, rings, FILM_TIER[detail.tier]);
      stars = createStarfield(STAR_MAX, 400, 7_101, { depthTest: true, dynamicRadius: true });
      applyDetail(detail);
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
      root.add(stars.object, orbits.mesh, dots.object, glare.object, ...BODY_IDS.map((id) => bodies?.objects[id]).filter((o): o is Group => o !== undefined));

      // Notes from cited data: without the constants file they are left out, never guessed.
      try {
        await c.data.ready;
        const facts = deriveFacts(physical, planets, (id) => c.data.constant(id).value);
        lightKmS = facts.lightKmS;
        discoveries = new Discoveries(facts);
      } catch (err) {
        console.warn('[explore] Notes and light-times are unavailable: data/constants.json did not load', err);
      }

      const w = world;
      input = createInput(c.renderer.domElement, {
        drag: (dx, dy) => {
          nav.drag(w, dx, dy);
        },
        pan: (dx, dy) => {
          nav.pan(w, dx, dy);
        },
        zoom: (dLn) => {
          nav.zoom(w, dLn);
        },
        orbitKeys: (azimuth, elevation, zoom) => {
          nav.setOrbitKeys(azimuth, elevation, zoom);
        },
        flightKeys: (move, roll, boost) => {
          nav.setFlightKeys(w, move, roll, boost);
        },
        stop: () => steer('stop'),
        orbit: () => {
          steer('orbit');
        },
        pick,
        travel: (id) => {
          nav.flyTo(w, id);
          // The interface keeps the address in step (app.focusBody), as for a choice from its list.
          c.renderer.domElement.dispatchEvent(new CustomEvent('kf-universe-focus', { detail: id, bubbles: true }));
        },
      });
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
      // Framing needs the view before the first pose is chosen.
      const viewportPx = c.renderer.domElement.clientHeight || 1;
      const widthPx = c.renderer.domElement.clientWidth || 1;
      nav.setView(
        {
          tanHalfFov: Math.tan(MathUtils.degToRad(DEFAULT_FOV / 2)),
          aspect: widthPx / viewportPx,
          top: insets.top / viewportPx,
          bottom: insets.bottom / viewportPx,
          left: insets.left / widthPx,
          right: insets.right / widthPx,
        },
        DEFAULT_FOV,
      );
      nav.begin(world, wantBody ?? DEFAULT_BODY, true);
      wantBody = null;
      // A fresh mirror of the limiter, already adapted, so guides are steady from the first frame.
      adaptation = createExposureControl({ reducedMotion: c.reducedMotion });
      adaptation.setFade(1);
      adaptation.setTarget(exposureFor(nav.focus));
      adaptation.jump();
      for (const id of BODY_IDS) labelOpacity.set(id, 0);
      // The rung's picture settings (bloom, pixel ratio), the full internal resolution, and a hold-off while it all settles.
      applyDetail(detail);
      renderScale = governor?.scale ?? 1;
      c.graphics.setRenderScale(renderScale);
      governor?.holdOff();
      wasTravelling = false;
      // The log of what was seen lasts the whole visit to the page; the note starts afresh.
      discovery = null;
      input?.attach();
      // Place everything once, then let the warm-up compile every material, in view or not.
      entering = true;
      frame(0);
      setCulling(false);
      if (glare) glare.object.visible = true;
      if (dots) dots.object.visible = true;
      warming = true;
    },

    update(dt) {
      if (warming) {
        warming = false;
        setCulling(true);
      }
      frame(dt);
    },

    setQuality() {
      // The film's tiers do not reach the explorer: it runs its own ladder (./detail) and governor.
    },

    setDetail(next) {
      applyDetail(next);
      governor?.holdOff();
    },

    setDetailChoice(choice) {
      if (!governor) {
        pendingChoice = choice;
        return;
      }
      // A tier fixed by the address holds until the visitor chooses in the explorer itself.
      if (fixed && !entered) return;
      applyDecision(governor.choose(choice));
    },

    sampleFrame(frameSeconds, gpuMs, intervalSeconds) {
      if (!entered || !governor) return;
      applyDecision(governor.sample(frameSeconds, gpuMs, intervalSeconds));
    },

    steer,

    focus(body) {
      if (!world || !entered) {
        wantBody = body;
        return;
      }
      nav.flyTo(world, body);
    },

    view,

    setInsets(next) {
      insets = { top: next.top, bottom: next.bottom, left: next.left ?? 0, right: next.right ?? 0 };
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
