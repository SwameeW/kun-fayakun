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

import { DepthTexture, Group, MathUtils, Matrix4, Mesh, Quaternion, RenderTarget, Vector3, type Data3DTexture, type Object3D } from 'three/webgpu';
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
  type UniverseIllustration,
  type UniverseModule,
  type UniversePose,
  type UniverseSteer,
  type UniverseView,
  type UniverseLiving,
  type ViewInsets,
} from '../core/types';
import { PLANETS_MANIFEST_URL, findPlanetTexture, type PlanetsManifest } from './assets/planets';
import { createPlanetTextures } from './assets/streaming';
import { createRawDecoder, type RawDecoder } from './assets/raw-ktx2';
import { createUploader } from './assets/upload';
import { createBodies, SUN_KELVIN, type Bodies } from './bodies';
import { createEarthTiles, type EarthTiles } from './earth-tiles';
import { lastWholeDay } from './earth-tiles/sources';
import { createQuakeLayer, type QuakeLayer } from './living/quakes';
import { createSatelliteLayer, type SatelliteLayer } from './living/satellites';
import { fineDetailShown } from './bodies/earth';
import { craterDetailShown } from './bodies/moon';
import { createSunGlare, visibleShare, type SunGlare } from './bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import { DETAIL, EXPLORE_TIERS, type ExploreDetail, type ExploreTier } from './detail';
import { deriveFacts, Discoveries, type Discovery, type DiscoveryInput } from './discoveries';
import { createTransmittanceTable, earthAir, limbTransmittance, type AirModel, type TransmittanceTable } from './render/air';
import { createInput, type ExploreInput } from './input';
import { LENS as ZOOM_LENS, Navigator, navOutput, type NavBody, type NavWorld } from './navigation';
import { createOrbits, moonOrbit, planetOrbit, type Orbits, type OrbitPath } from './orbits';
import { availableTiers, createDetailGovernor, initialTier, type DetailChoice, type DetailGovernor, type GovernorDecision } from './quality';
import { lensFor, LENS, nearestAltitude, type Lens, type Sphere } from './space/lens';
import { FloatingOrigin, km, renderToEcliptic, type Km } from './space/origin';
import { placeScaled } from './space/scaled-space';
import { filmUnitKm, moonOffsetFactor, sizeFactor, STRETCH, stretchEase, stretchedDistance, stretchedLight } from './stretch';
import { createSolarSystem, type SolarSystem } from './system';

const DEFAULT_BODY: BodyId = 'earth';
const NOISE = { size: 64, seed: 31_415 } as const;
const SECONDS_PER_DAY = 86_400;
/** Above this height (km) with the lens at rest, the view stops turning with the Earth (it is no longer held over a place). */
const PLACE_LOCK_KM = 3000;
/** How near (CSS px) a double click must be to a satellite to choose it. */
const SATELLITE_PICK_PX = 9;
/** The live layers show within this distance of the Earth (km): about ten times the Moon's distance. */
const LIVING_RANGE_KM = 4e6;
/** The narrowest lens over the day's mosaic (its 250 m pixels at about four screen pixels each from the lowest orbit). */
const TODAY_LENS_MIN_DEG = 6;
const UNIX_EPOCH_JD = 2440587.5;

/** Exposure adapts to sunlight as r^EXPOSURE_POWER (2 would be full adaptation), r in au. */
const EXPOSURE_POWER = 1.8;
/**
 * With the Sun large in view it is shown as photographed through a solar filter, so its disc shows
 * colour, limb darkening and granulation rather than a white blank: the filter comes in as its
 * radius grows between these sizes (CSS px on a view whose narrower side is `refPx`; in proportion
 * on any other, so a phone, which frames the Sun from further out, shows the same filtered disc as a
 * wide screen), taking the disc from brilliant white to the filter's amber at a moderate brightness
 * (display terms, the same on every detail level). The readout says so while the filter is on.
 */
const SUN_FILTER = { fromPx: 12, toPx: 110, refPx: 800, color: [1, 0.5, 0.12], white: 5, filtered: 0.5 } as const;
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
  mercury: { tint: [0.8, 0.78, 0.75], albedo: 0.4, sizePx: 7 },
  venus: { tint: [1, 0.96, 0.84], albedo: 0.4, sizePx: 7 },
  mars: { tint: [1, 0.6, 0.4], albedo: 0.4, sizePx: 7 },
  uranus: { tint: [0.65, 0.86, 0.84], albedo: 0.4, sizePx: 7 },
  neptune: { tint: [0.6, 0.8, 0.86], albedo: 0.4, sizePx: 7 },
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
const LABEL = {
  seconds: 0.35,
  /** A tag that gives way to another fades out this quickly (no ghost of one over the other). */
  hideSeconds: 0.1,
  maxDiscPx: 70,
  markerPx: 4,
  opacity: 0.92,
  /** A tag's box (CSS px): its width (the longest name), its height above its point, and its gap from it. */
  widthPx: 86,
  tagPx: 26,
  gapPx: 10,
  /** Kept this far inside the clear view; an edge pointer's length; how far past a line a form holds. */
  marginPx: 10,
  pointerPx: 18,
  holdPx: 14,
  /** A tag that gave way comes back only with this much more room than it needs (no flicker at the edge). */
  clearAgain: 1.3,
  /** A form (tag or edge pointer) taking over from the other waits until that one is below this opacity. */
  handover: 0.08,
} as const;
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
  /** Where its centre falls on the canvas (CSS px from its top left), and whether it is in front of the camera. */
  screenX: number;
  screenY: number;
  inView: boolean;
}

/** A tag beside a body, and its pointer at the edge of the view when it is just out of frame. */
type MutableLabel = SceneLabel & { position: [number, number, number]; textKey: string };
/** Where a body's name goes: to its right (the tag), to its left, at the edge of the view, or nowhere. */
type LabelForm = 'right' | 'left' | 'edge' | 'none';
interface BodyLabels {
  tag: number;
  edge: number;
  /** The form it took last (its choice holds until the body is a margin past the line). */
  form: LabelForm;
  /** It gave way to another tag (and needs more room to come back). */
  blocked: boolean;
  tagLabel: MutableLabel;
  edgeLabel: MutableLabel;
  edgeAt: [number, number, number];
  edgeOffset: [number, number];
}

function bodyLabels(id: BodyId): BodyLabels {
  // The text is the body's name: its key comes from the system's specs on the first frame.
  const edgeOffset: [number, number] = [0, 0];
  const tagLabel: MutableLabel = { id: `body-${id}`, textKey: '', position: [0, 0, 0], opacity: 0 };
  const edgeLabel: MutableLabel = { id: `edge-${id}`, textKey: '', position: [0, 0, 0], opacity: 0, offset: edgeOffset };
  return { tag: 0, edge: 0, form: 'none', blocked: false, tagLabel, edgeLabel, edgeAt: [0, 0, 0], edgeOffset };
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
  /** The Earth's streamed imagery (zoom anywhere), made with the bodies. */
  let earthTiles: EarthTiles | null = null;
  /** The UTC day (days since 1970) the today mosaic was last set for. */
  let tilesDay = -1;
  /**
   * Held over a place: while the lens is narrowed, a glide runs or a place was flown to, the view
   * turns with the Earth (its axis and prime meridian last frame), so the ground keeps still.
   */
  let placeLock = false;
  let pendingPlace: { lat: number; lon: number; viewKm: number } | null = null;
  const earthMeridianBefore = km();
  const earthPole = km();
  let earthMeridianKnown = false;
  /** The Living Earth's live layers (made with the bodies, loaded when first turned on). */
  let satellites: SatelliteLayer | null = null;
  let quakes: QuakeLayer | null = null;
  const living = { earth: { x: 0, y: 0, z: 0 }, sun: { x: 1, y: 0, z: 0 } };
  /** The Earth's transmittance table: baked on the first frame (it needs the renderer). */
  let airTable: TransmittanceTable | null = null;
  /**
   * The render target the frames draw the explorer into (the post pipeline's scene pass, seen while the
   * stars draw), and a stand-in shaped like it for before the first frame (compileForFrames).
   */
  let frameTarget: RenderTarget | null = null;
  let compileTarget: RenderTarget | null = null;
  /** compileForFrames calls still waiting on their pipelines. */
  let compilesPending = 0;
  /** The worker that inflates the raw planet files. */
  let rawDecoder: RawDecoder | null = null;
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
  /**
   * The stretch from the film's scale (./stretch), asked for by the route on the way in from Chapter 7:
   * its clock (s), how far it has got (0 the film's scale, 1 true), whether a trip hurries it, whether
   * the visitor has taken the controls (then where to go next is theirs), and the body flown to after.
   */
  let wantStretch = false;
  const stretch = { active: false, t: 0, amount: 1, rush: false, steered: false, then: DEFAULT_BODY };
  /** Each body's drawn size over its true one this frame, and its true distance from the Sun (for its light). */
  const grow = Object.fromEntries(BODY_IDS.map((id) => [id, 1])) as Record<BodyId, number>;
  const trueSunKm = Object.fromEntries(BODY_IDS.map((id) => [id, 0])) as Record<BodyId, number>;
  const earthTrue = km();
  /** The film's scene unit, km (set on the way in). */
  let filmUnit = 0;
  /** The date shown: TDB Julian date, and UTC for display. */
  let jdTdb = 0;
  let jdUtc = 0;
  /** Seconds of the bodies' own illustrative motion (drifting clouds and bands, the Sun's surface): still with reduced motion. */
  let ambient = 0;
  /** The camera's height above the nearest surface (rings included), km: the depth range and the turn rate follow it. */
  let nearestKm = Infinity;
  /** The Earth's air model (its limb reddens the Sun seen through it). */
  let earthAirModel: AirModel | null = null;

  const placed = Object.fromEntries(
    BODY_IDS.map((id) => [id, { rel: km(), drawn: km(), distance: 0, k: 1, radiusPx: 0, screenX: 0, screenY: 0, inView: false }]),
  ) as Record<BodyId, Placed>;
  const labelOpacity = new Map<BodyId, number>(BODY_IDS.map((id) => [id, 0]));
  /** Each body's tag and edge pointer (their labels reused frame to frame), and the boxes taken this frame. */
  const labelState = Object.fromEntries(BODY_IDS.map((id) => [id, bodyLabels(id)])) as Record<BodyId, BodyLabels>;
  const labelOrder: BodyId[] = [...BODY_IDS];
  const taken = BODY_IDS.map(() => ({ x: 0, y: 0 }));
  let takenCount = 0;
  const labels: SceneLabel[] = [];
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
  /** What discoveries are judged from, rewritten each frame (its records too): no garbage per frame. */
  const discPx = Object.fromEntries(BODY_IDS.map((id) => [id, 0])) as Record<BodyId, number>;
  const inView = Object.fromEntries(BODY_IDS.map((id) => [id, false])) as Record<BodyId, boolean>;
  const discoveryInput: DiscoveryInput = {
    focus: DEFAULT_BODY,
    travelling: false,
    altitudeKm: 0,
    radiusKm: 1,
    framedAltitudeKm: 0,
    phaseAngle: phaseAngles,
    discPx,
    inView,
    moonLit: 0,
    moonWaxing: false,
    earthLitFromMoon: 0,
    ringTiltDeg: 0,
    sunEarthKm: 0,
    sunCameraKm: 0,
    sunlight: 1,
    solarFilter: false,
  };
  const helio = km();
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
  const camRight = new Vector3();
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

  /*
   * The view the interface, the engine and tests read: one object (and its parts), rewritten once a
   * frame by refreshView() and handed out as it is, so reading it several times a frame costs nothing
   * and a trip makes no garbage. Readers copy what they keep (page.evaluate serialises it).
   */
  const detailView: UniverseView['detail'] = { tier: detail.tier, choice: 'auto', available, renderScale, fixed };
  const tripView: NonNullable<UniverseView['trip']> = { progress: 0, remainingKm: 0, startKm: 0, endKm: 0 };
  const livingView: UniverseLiving = {
    satellites: { state: 'off', count: 0, byKind: { station: 0, starlink: 0, oneweb: 0, navigation: 0, geostationary: 0, other: 0 }, fetchedMs: 0, selected: null },
    quakes: { state: 'off', fetchedMs: 0, list: [] },
  };
  const lensView = { deg: 50, metresPerPixel: 0 };
  const viewState: UniverseView = {
    focus: DEFAULT_BODY,
    travelling: false,
    from: null,
    moving: false,
    distanceKm: 0,
    altitudeKm: 0,
    sunlight: 1,
    solarFilter: false,
    jdTdb: 0,
    unixMs: 0,
    mode: 'orbit',
    speedKmS: 0,
    trip: null,
    bodies: bodyViews,
    camera: cameraEcliptic,
    discovery: null,
    witnessed: [],
    detail: detailView,
    auKm: 1,
    lightKmS: 0,
    trueScale: 1,
    imagery: null,
    living: null,
    lens: null,
  };

  const refreshView = (): void => {
    const cam = origin.camera;
    const focus = nav.focus;
    const spec = system?.specs[focus];
    const p = system?.bodies[focus].position;
    const distanceKm = p ? Math.hypot(cam.x - p.x, cam.y - p.y, cam.z - p.z) : 0;
    const auKm = system?.auKm ?? 1;
    const fromSun = Math.max(1, Math.hypot(cam.x, cam.y, cam.z));
    const altitudeKm = distanceKm - (spec?.radiusKm ?? 0);
    const v = viewState;
    v.focus = focus;
    v.travelling = nav.travelling;
    v.from = navOut.from;
    v.moving = nav.moving;
    v.distanceKm = distanceKm;
    v.altitudeKm = altitudeKm;
    v.sunlight = (auKm / fromSun) ** 2;
    v.solarFilter = filterAmount > 0.5;
    v.jdTdb = jdTdb;
    v.unixMs = (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000;
    v.mode = navOut.mode;
    v.speedKmS = navOut.speedKmS;
    const trip = nav.tripState;
    if (trip) {
      tripView.progress = trip.progress;
      tripView.remainingKm = Math.max(0, altitudeKm);
      tripView.startKm = tripStartKm;
      tripView.endKm = trip.endKm;
    }
    v.trip = trip ? tripView : null;
    v.discovery = discovery;
    v.witnessed = discoveries?.witnessed ?? v.witnessed;
    syncDetailView();
    v.auKm = auKm;
    v.trueScale = stretch.amount;
    v.imagery = earthTiles ? earthTiles.stats : null;
    livingView.satellites = satellites ? { ...satellites.status, selected: satellites.selected } : livingView.satellites;
    livingView.quakes = quakes ? { state: quakes.status.state, fetchedMs: quakes.status.fetchedMs, list: quakes.quakes } : livingView.quakes;
    v.living = satellites || quakes ? livingView : null;
    if (nav.lensActive && placed.earth.distance > 0) {
      lensView.deg = nav.lens;
      // Ground per CSS pixel straight down at the view's centre: the height over the view's height in px, through the lens.
      const altitudeM = (placed.earth.distance - (system?.specs.earth.radiusKm ?? 0)) * 1000;
      lensView.metresPerPixel = (2 * altitudeM * Math.tan(MathUtils.degToRad(nav.lens / 2))) / Math.max(1, ctx?.renderer.domElement.clientHeight ?? 1);
      v.lens = lensView;
    } else {
      v.lens = null;
    }
    v.illustrative = illustrations();
    v.lightKmS = lightKmS;
  };

  /** The detail part of the view (also right after a choice or a governor's decision, between frames). */
  const syncDetailView = (): void => {
    detailView.tier = detail.tier;
    detailView.choice = governor?.choice ?? 'auto';
    detailView.available = available;
    detailView.renderScale = renderScale;
    detailView.fixed = fixed;
  };

  /** Rewritten in place on every read too (no garbage), so a read right after a command (a trip asked for) is current. */
  const view = (): UniverseView => {
    refreshView();
    return viewState;
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
      // New materials compile ahead and swap in when ready; the governor judges nothing for a while after.
      void bodies.setDetail(detail).then(() => {
        governor?.holdOff();
      });
    }
    if (stars) stars.object.count = Math.min(STAR_MAX, detail.starCount);
    if (entered && ctx) {
      ctx.graphics.setBloom(detail.bloom);
      ctx.graphics.setDprCap(detail.dprCap);
    }
    setHook('data-detail', entered ? detail.tier : null);
    syncDetailView();
  };

  const applyDecision = (decision: GovernorDecision | null): void => {
    if (!decision) return;
    if (decision.tier && decision.tier !== detail.tier) applyDetail(DETAIL[decision.tier]);
    if (decision.scale !== undefined) {
      renderScale = decision.scale;
      if (entered) ctx?.graphics.setRenderScale(renderScale);
    }
    syncDetailView();
  };

  /** The body under a point of the canvas (client px), nearest the camera when discs overlap. */
  const pick = (clientX: number, clientY: number): BodyId | null => {
    const c = ctx;
    if (!c) return null;
    const rect = c.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // A satellite under the pointer is chosen instead (its name, orbit and height show).
    const camera = c.camera;
    const hit = satellites?.pick(x, y, SATELLITE_PICK_PX, (v) => {
      const s = projected.copy(v).project(camera);
      return { x: ((s.x + 1) / 2) * rect.width, y: ((1 - s.y) / 2) * rect.height, front: s.z > -1 && s.z < 1 };
    });
    if (hit !== undefined && hit !== null) {
      satellites?.select(hit);
      return null;
    }
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

  /** The stretch's clock: it holds the film's view, eases to true scale, rests, then flies on (unless the visitor has steered). */
  const advanceStretch = (dt: number): void => {
    if (!stretch.active) return;
    // A trip asked for meanwhile finishes it quickly, from wherever it has got to.
    if (nav.travelling && !stretch.rush) {
      stretch.rush = true;
      stretch.steered = true;
      stretch.t = Math.max(stretch.t, STRETCH.hold);
    }
    stretch.t += stretch.rush ? dt * (STRETCH.seconds / STRETCH.rush) : dt;
    stretch.amount = stretchEase((stretch.t - STRETCH.hold) / STRETCH.seconds);
    if (stretch.t >= STRETCH.hold + STRETCH.seconds + STRETCH.settle) {
      stretch.active = false;
      stretch.amount = 1;
      if (!stretch.steered && world) nav.flyTo(world, stretch.then);
    }
  };

  /** The worlds where the film's scale, part way to true, puts them: moved in place after the system's update. */
  const warpSystem = (sys: SolarSystem): void => {
    const s = stretch.amount;
    const sun = sys.bodies.sun.position;
    const earth = sys.bodies.earth.position;
    earthTrue.x = earth.x;
    earthTrue.y = earth.y;
    earthTrue.z = earth.z;
    for (const id of BODY_IDS) {
      const p = sys.bodies[id].position;
      trueSunKm[id] = Math.hypot(p.x - sun.x, p.y - sun.y, p.z - sun.z);
      grow[id] = s < 1 ? sizeFactor(id, sys.specs[id].radiusKm, s, filmUnit) : 1;
    }
    if (s >= 1) return;
    for (const id of ['earth', 'jupiter', 'saturn'] as const) {
      const p = sys.bodies[id].position;
      const r = trueSunKm[id];
      if (r <= 0) continue;
      const f = stretchedDistance(r, s, filmUnit, sys.auKm) / r;
      p.x = sun.x + (p.x - sun.x) * f;
      p.y = sun.y + (p.y - sun.y) * f;
      p.z = sun.z + (p.z - sun.z) * f;
    }
    // The Moon keeps its side of the Earth, at the film's distance from it part way to the true one.
    const m = sys.bodies.moon.position;
    const ox = m.x - earthTrue.x;
    const oy = m.y - earthTrue.y;
    const oz = m.z - earthTrue.z;
    const mf = moonOffsetFactor(Math.hypot(ox, oy, oz), s, filmUnit);
    m.x = earth.x + ox * mf;
    m.y = earth.y + oy * mf;
    m.z = earth.z + oz * mf;
  };

  /** The orbit lines follow the worlds through the stretch (the Moon's is drawn around the Earth already moved). */
  const warpOrbitPoint = (point: Km, path: OrbitPath): void => {
    if (!system) return;
    const s = stretch.amount;
    if (path.body === 'moon') {
      const ox = point.x - path.centre.x;
      const oy = point.y - path.centre.y;
      const oz = point.z - path.centre.z;
      const mf = moonOffsetFactor(Math.hypot(ox, oy, oz), s, filmUnit);
      point.x = path.centre.x + ox * mf;
      point.y = path.centre.y + oy * mf;
      point.z = path.centre.z + oz * mf;
      return;
    }
    const sun = system.bodies.sun.position;
    const r = Math.hypot(point.x - sun.x, point.y - sun.y, point.z - sun.z);
    if (r <= 0) return;
    const f = stretchedDistance(r, s, filmUnit, system.auKm) / r;
    point.x = sun.x + (point.x - sun.x) * f;
    point.y = sun.y + (point.y - sun.y) * f;
    point.z = sun.z + (point.z - sun.z) * f;
  };

  /** A place on the Earth (degrees) as a unit direction from its centre, render frame. */
  const placeDirection = (sys: SolarSystem, latDeg: number, lonDeg: number, out: Km): Km => {
    const lat = MathUtils.degToRad(latDeg);
    const lon = MathUtils.degToRad(lonDeg);
    // The Earth's frame: x the prime meridian, y the north pole, east longitude toward -z.
    const bx = Math.cos(lat) * Math.cos(lon);
    const by = Math.sin(lat);
    const bz = -Math.cos(lat) * Math.sin(lon);
    const m = sys.bodies.earth.basis;
    out.x = bx * (m[0] ?? 1) + by * (m[3] ?? 0) + bz * (m[6] ?? 0);
    out.y = bx * (m[1] ?? 0) + by * (m[4] ?? 1) + bz * (m[7] ?? 0);
    out.z = bx * (m[2] ?? 0) + by * (m[5] ?? 0) + bz * (m[8] ?? 1);
    const l = Math.hypot(out.x, out.y, out.z) || 1;
    out.x /= l;
    out.y /= l;
    out.z /= l;
    return out;
  };

  /**
   * How to frame `viewKm` of ground straight down: from the lowest orbit through a narrowed lens when
   * it is narrower than that orbit's view, otherwise from the height that fits it at the base lens.
   */
  const framing = (viewKm: number): { altitudeKm: number; lensDeg: number } => {
    const floor = world ? world.body('earth').minAltitudeKm : 150;
    const half = MathUtils.degToRad(DEFAULT_FOV / 2);
    if (viewKm >= 2 * floor * Math.tan(half)) return { altitudeKm: viewKm / 2 / Math.tan(half), lensDeg: DEFAULT_FOV };
    return { altitudeKm: floor, lensDeg: MathUtils.radToDeg(2 * Math.atan(viewKm / 2 / floor)) };
  };

  /** Flies to a place on the Earth (degrees) framing `viewKm` of ground: to the Earth first if elsewhere. */
  const goToPlace = (lat: number, lon: number, viewKm: number): void => {
    if (!world || !system || !entered) return;
    placeLock = true;
    if (nav.focus !== 'earth' || nav.busy) {
      if (nav.focus !== 'earth') nav.flyTo(world, 'earth');
      pendingPlace = { lat, lon, viewKm };
      return;
    }
    const { altitudeKm, lensDeg } = framing(viewKm);
    nav.glideTo(world, placeDirection(system, lat, lon, km()), altitudeKm, lensDeg);
  };

  /**
   * Where the view is aimed on the Earth, for its streamed imagery: the point the view's centre ray
   * meets (or, when it misses but the Earth is in view, the point under the camera), as latitude and
   * longitude in the Earth's own frame, and the ground radians one scene pixel spans there. Null when
   * the Earth is out of view.
   */
  const earthAim = (sys: SolarSystem, pxPerTan: number): { lat: number; lon: number; footprint: number } | null => {
    const p = placed.earth;
    const radius = sys.specs.earth.radiusKm;
    const cx = p.rel.x;
    const cy = p.rel.y;
    const cz = p.rel.z;
    const b = forward.x * cx + forward.y * cy + forward.z * cz;
    const c = cx * cx + cy * cy + cz * cz - radius * radius;
    const disc = b * b - c;
    let px: number;
    let py: number;
    let pz: number;
    let range: number;
    if (disc >= 0 && b - Math.sqrt(disc) > 0) {
      range = b - Math.sqrt(disc);
      px = forward.x * range - cx;
      py = forward.y * range - cy;
      pz = forward.z * range - cz;
    } else if (p.inView) {
      const d = Math.max(Math.hypot(cx, cy, cz), 1e-9);
      range = d - radius;
      px = (-cx / d) * radius;
      py = (-cy / d) * radius;
      pz = (-cz / d) * radius;
    } else {
      return null;
    }
    // Into the Earth's frame: the basis's columns are its axes in the render frame.
    const m = sys.bodies.earth.basis;
    const bx = px * (m[0] ?? 1) + py * (m[1] ?? 0) + pz * (m[2] ?? 0);
    const by = px * (m[3] ?? 0) + py * (m[4] ?? 1) + pz * (m[5] ?? 0);
    const bz = px * (m[6] ?? 0) + py * (m[7] ?? 0) + pz * (m[8] ?? 1);
    const r = Math.max(Math.hypot(bx, by, bz), 1e-9);
    return { lat: Math.asin(Math.max(-1, Math.min(1, by / r))), lon: Math.atan2(-bz, bx), footprint: range / Math.max(pxPerTan, 1) / radius };
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
    advanceStretch(dt);
    warpSystem(sys);
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

    // Held over a place, the view turns with the Earth (its spin since the last frame, about its pole).
    const eb = sys.bodies.earth.basis;
    earthPole.x = eb[3] ?? 0;
    earthPole.y = eb[4] ?? 1;
    earthPole.z = eb[5] ?? 0;
    const mx = eb[0] ?? 1;
    const my = eb[1] ?? 0;
    const mz = eb[2] ?? 0;
    if (earthMeridianKnown && nav.focus === 'earth' && (placeLock || nav.lensActive || nav.gliding)) {
      const b = earthMeridianBefore;
      const crossDotPole = (b.y * mz - b.z * my) * earthPole.x + (b.z * mx - b.x * mz) * earthPole.y + (b.x * my - b.y * mx) * earthPole.z;
      nav.spinWithEarth(earthPole, Math.atan2(crossDotPole, b.x * mx + b.y * my + b.z * mz));
    }
    earthMeridianBefore.x = mx;
    earthMeridianBefore.y = my;
    earthMeridianBefore.z = mz;
    earthMeridianKnown = true;
    if (pendingPlace && nav.focus === 'earth' && !nav.busy) {
      const p = pendingPlace;
      pendingPlace = null;
      goToPlace(p.lat, p.lon, p.viewKm);
    }
    if (placeLock && (nav.focus !== 'earth' || (!nav.lensActive && !nav.gliding && placed.earth.distance - sys.specs.earth.radiusKm > PLACE_LOCK_KM))) placeLock = false;
    nav.placeView = placeLock;

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
        sphere.radius = sys.specs[id].radiusKm * grow[id];
      }
    });
    // Saturn's rings, in its equator: beside them they are the nearest surface.
    const pole = sys.bodies.saturn.basis;
    ringSphere.pole.x = pole[3] ?? 0;
    ringSphere.pole.y = pole[4] ?? 1;
    ringSphere.pole.z = pole[5] ?? 0;
    nearestKm = nearestAltitude(spheres);
    lensFor(nearestKm, lens);

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
      const radiusKm = spec.radiusKm * grow[id];
      p.radiusPx = pxPerTan * Math.tan(Math.asin(Math.min(1, radiusKm / Math.max(p.distance, radiusKm))));
      const object = bodies.objects[id];
      object.position.set(p.drawn.x, p.drawn.y, p.drawn.z);
      object.scale.setScalar(radiusKm * p.k);
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
      if (stretch.amount < 1) return stretchedLight((sys.auKm / Math.max(trueSunKm[id], 1)) ** 2, stretch.amount);
      const q = sys.bodies[id].position;
      return (sys.auKm / Math.max(Math.hypot(q.x - sun.x, q.y - sun.y, q.z - sun.z), 1)) ** 2;
    };
    // The Sun: brilliant and white when small, through its filter (amber, moderate) when it fills the view.
    const filterScale = Math.min(widthPx, viewportPx) / SUN_FILTER.refPx;
    filterAmount = smoothstep(SUN_FILTER.fromPx * filterScale, SUN_FILTER.toPx * filterScale, placed.sun.radiusPx);
    const [fr, fg, fb] = SUN_FILTER.color;
    filterColor[0] = 1 + (fr - 1) * filterAmount;
    filterColor[1] = 1 + (fg - 1) * filterAmount;
    filterColor[2] = 1 + (fb - 1) * filterAmount;
    // The film's enlarged Sun is a drawn disc, not a blinding point: through the stretch it keeps the
    // filtered brightness without glare or spikes (in its own colour), brightening only as it shrinks to true size.
    const subdued = Math.max(filterAmount, 1 - stretch.amount);
    const sunDisplay = Math.exp(Math.log(SUN_FILTER.white) + (Math.log(SUN_FILTER.filtered) - Math.log(SUN_FILTER.white)) * subdued);
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
    if (earthTiles) {
      // The day mosaic of the last whole day before the date shown (never one still being imaged).
      const unixMs = (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000;
      const day = Math.floor(Math.min(unixMs, Date.now()) / 86_400_000);
      if (day !== tilesDay) {
        tilesDay = day;
        earthTiles.setDate(lastWholeDay(day * 86_400_000 + 43_200_000));
      }
      // Scene pixels: the canvas's, at the internal render scale.
      const scenePxPerTan = (c.renderer.domElement.height * renderScale) / (2 * tanHalf);
      earthTiles.update(entering || stretch.amount < 1 ? null : earthAim(sys, scenePxPerTan), dt, c.reducedMotion);
    }
    unit(sunDir, sys.bodies.mercury.position, sun);
    bodies.mercury.update({ time: ambient, sun: sunDir, light: lightAt('mercury'), earth: toEarth, earthLit: 0 }, origin3);
    unit(sunDir, sys.bodies.venus.position, sun);
    bodies.venus.update({ time: ambient, sun: sunDir, light: lightAt('venus') }, origin3);
    unit(sunDir, sys.bodies.mars.position, sun);
    bodies.mars.update({ time: ambient, sun: sunDir, light: lightAt('mars'), earth: toEarth, earthLit: 0 }, origin3);
    unit(sunDir, sys.bodies.uranus.position, sun);
    bodies.uranus.update({ time: ambient, sun: sunDir, light: lightAt('uranus') }, origin3);
    unit(sunDir, sys.bodies.neptune.position, sun);
    bodies.neptune.update({ time: ambient, sun: sunDir, light: lightAt('neptune') }, origin3);
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
      ...(stretch.amount < 1 ? { warp: warpOrbitPoint } : {}),
    });

    // Labels first: the ring markers of small bodies come and go with their tags.
    updateLabels(dt, viewportPx, widthPx);

    // The Living Earth's live layers, placed with the Earth (only near it: drawn at true scale).
    if (satellites || quakes) {
      const pe = placed.earth;
      const near = pe.k > 0.999 && pe.distance < LIVING_RANGE_KM;
      living.earth.x = pe.drawn.x;
      living.earth.y = pe.drawn.y;
      living.earth.z = pe.drawn.z;
      unit(scratch, sun, sys.bodies.earth.position);
      living.sun.x = scratch.x;
      living.sun.y = scratch.y;
      living.sun.z = scratch.z;
      const unixMs = (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000;
      satellites?.update({ unixMs, earth: living.earth, basis: sys.bodies.earth.basis, sun: living.sun, earthRadiusKm: sys.specs.earth.radiusKm, visible: near });
      quakes?.update({ unixMs, earth: living.earth, basis: sys.bodies.earth.basis, earthRadiusKm: sys.specs.earth.radiusKm, visible: near, time: ambient, reducedMotion: c.reducedMotion });
      if (satellites) for (const l of satellites.labels()) labels.push(l);
      if (quakes) for (const l of quakes.labels()) labels.push(l);
    }

    // Points of light for bodies under about 2 px, and rings marking them where they are named.
    BODY_IDS.forEach((id, i) => {
      const p = placed[id];
      const dot = dotList[i];
      if (!dot) return;
      const spec = sys.specs[id];
      const drawnRadius = spec.radiusKm * grow[id] * p.k;
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
      drawnRadius: sys.specs.sun.radiusKm * grow.sun * sunPlaced.k,
      radiusPx: sunPlaced.radiusPx,
      viewportPx,
      visible: sunVisible(),
      compensation: adapted,
      filtered: subdued,
      tint: sunTint,
    });

    trackTrips();
    refreshView();
    describe(camera);
    viewState.discovery = discovery;
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
   * of the same formats is used, and released (two GPU textures) once the frames' own target is
   * known and no compile still uses it.
   */
  const releaseStandIn = (): void => {
    if (!frameTarget || !compileTarget || compilesPending > 0) return;
    compileTarget.dispose();
    compileTarget = null;
  };
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
    compilesPending += 1;
    try {
      await Promise.all(pending);
    } catch (err) {
      console.warn('explore: could not compile ahead', err);
    } finally {
      compilesPending -= 1;
      releaseStandIn();
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
      case 'mercury':
        return ['monochrome', 'map-gaps'];
      case 'mars':
        return ['dust-haze', 'colour-balance'];
      case 'venus':
        return ['colour-model', 'cloud-structure'];
      case 'uranus':
      case 'neptune':
        return ['colour-model'];
      case 'saturn':
        return bodies.saturn.rings?.particles?.object.visible ? ['ring-particles'] : [];
    }
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
      // The light-time of the distance shown beside it (to the surface), so the two always agree.
      v.lightSeconds = lightKmS > 0 ? v.distanceKm / lightKmS : 0;
      v.screen.x = p.screenX;
      v.screen.y = p.screenY;
      v.screen.radiusPx = p.radiusPx;
      v.screen.inView = p.inView;
      helio.x = body.x - sun.x;
      helio.y = body.y - sun.y;
      helio.z = body.z - sun.z;
      renderToEcliptic(helio, v.ecliptic);
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

    // No notes while the film's scale stretches: its places and sizes are not the real ones yet.
    if (!discoveries || stretch.amount < 1) return;
    const earth = sys.bodies.earth.position;
    const moon = sys.bodies.moon.position;
    // The Moon from the Earth: lit share, and waxing while it is east of the Sun (counterclockwise seen from ecliptic north).
    unit(sunDir, moon, sun);
    unit(toEarth, moon, earth);
    const moonCos = dot3(sunDir, toEarth);
    // Ecliptic north is +y in the render frame: waxing while the Moon is east of the Sun, seen from the Earth.
    const waxing = (sun.z - earth.z) * (moon.x - earth.x) - (sun.x - earth.x) * (moon.z - earth.z) > 0;
    unit(scratch, earth, sun);
    unit(scratch2, earth, moon);
    const earthFromMoon = (1 + dot3(scratch, scratch2)) / 2;
    const saturnBasis = sys.bodies.saturn.basis;
    unit(scratch, sys.bodies.saturn.position, sun);
    const ringTilt = Math.asin(Math.min(1, Math.max(-1, (saturnBasis[3] ?? 0) * scratch.x + (saturnBasis[4] ?? 1) * scratch.y + (saturnBasis[5] ?? 0) * scratch.z)));
    const v = viewState;
    const input = discoveryInput;
    input.focus = nav.focus;
    input.travelling = nav.travelling;
    input.altitudeKm = v.altitudeKm;
    input.radiusKm = sys.specs[nav.focus].radiusKm;
    input.framedAltitudeKm = world ? nav.framingKm(world.body(nav.focus)) - sys.specs[nav.focus].radiusKm : 0;
    for (const id of BODY_IDS) {
      discPx[id] = placed[id].radiusPx;
      inView[id] = placed[id].inView;
    }
    input.moonLit = (1 + moonCos) / 2;
    input.moonWaxing = waxing;
    input.earthLitFromMoon = earthFromMoon;
    input.ringTiltDeg = (ringTilt * 180) / Math.PI;
    input.sunEarthKm = Math.hypot(earth.x - sun.x, earth.y - sun.y, earth.z - sun.z);
    input.sunCameraKm = Math.hypot(origin.camera.x - sun.x, origin.camera.y - sun.y, origin.camera.z - sun.z);
    input.sunlight = v.sunlight;
    input.solarFilter = v.solarFilter;
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

  /**
   * Names beside the bodies: eased, hidden behind other bodies, never on top of each other and
   * never cut off by the edge of the view or tucked under the interface. A tag sits to the right of
   * its body; one that would run past the right of the clear view goes to its left instead (a short
   * line to its left limb); a body just out of frame (in front of the camera) gets a small pointer at
   * the edge, on its side, with its name. Each choice holds until the body is clearly past the line
   * (no flicker between two). Where two would collide the lesser one gives way quickly (no ghost of
   * one over the other) and comes back only once there is clear room. Everything here is rewritten
   * in place each frame (no garbage per frame).
   */
  const updateLabels = (dt: number, viewportPx: number, widthPx: number): void => {
    const c = ctx;
    if (!c || !system) return;
    const camera = c.camera;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    labelOrder.sort((a, b) => (a === nav.focus ? -1 : b === nav.focus ? 1 : placed[b].radiusPx - placed[a].radiusPx));
    takenCount = 0;
    labels.length = 0;
    const show = 1 - Math.exp(-Math.max(0, dt) / LABEL.seconds);
    const hide = 1 - Math.exp(-Math.max(0, dt) / LABEL.hideSeconds);
    // The clear part of the view, in CSS px (inside what the interface covers, with a margin).
    const left = insets.left + LABEL.marginPx;
    const rightEdge = widthPx - insets.right - LABEL.marginPx;
    const top = insets.top + LABEL.tagPx;
    const bottom = viewportPx - insets.bottom - LABEL.marginPx;
    for (const id of labelOrder) {
      const spec = system.specs[id];
      const p = placed[id];
      const state = labelState[id];
      state.tagLabel.textKey = spec.nameKey;
      state.edgeLabel.textKey = spec.nameKey;
      // At the limb of a visible disc; at the centre of a point, beside its ring marker.
      const drawnRadius = spec.radiusKm * grow[id] * p.k * 1.08 * smoothstep(LABEL.markerPx, LABEL.markerPx * 3, p.radiusPx);
      const anchor = projected.set(p.drawn.x, p.drawn.y, p.drawn.z).addScaledVector(right, drawnRadius);
      const ax = anchor.x;
      const ay = anchor.y;
      const az = anchor.z;
      anchor.project(camera);
      const inFront = anchor.z < 1 && anchor.z > -1;
      const sx = ((anchor.x + 1) / 2) * widthPx;
      const sy = ((1 - anchor.y) / 2) * viewportPx;
      const wanted = inFront && p.radiusPx < LABEL.maxDiscPx && !occluded(id);
      // Which form: the tag at its right; at its left (no room on the right); or a pointer at the edge
      // (its point is out of the clear view). Each holds until the body is a margin past the line.
      const hold = (form: LabelForm): number => (state.form === form ? LABEL.holdPx : -LABEL.holdPx);
      const outside = sx < left + hold('edge') || sx > rightEdge - hold('edge') || sy < top + hold('edge') || sy > bottom - hold('edge');
      const noRoom = sx + LABEL.gapPx + LABEL.widthPx > rightEdge - hold('left');
      const form: LabelForm = !wanted ? 'none' : outside ? 'edge' : noRoom ? 'left' : 'right';
      if (form !== 'none') state.form = form;
      const offView = form === 'edge' || form === 'left';
      let x = sx;
      let y = sy;
      let edgeDx = 0;
      let edgeDy = 0;
      if (form === 'edge') {
        x = Math.min(rightEdge, Math.max(left, sx));
        y = Math.min(bottom, Math.max(top, sy));
        if (sx < left) edgeDx = LABEL.pointerPx;
        else if (sx > rightEdge) edgeDx = -LABEL.pointerPx;
        if (sy < top) edgeDy = LABEL.pointerPx * 0.7;
        else if (sy > bottom) edgeDy = -LABEL.pointerPx * 0.7;
        if (edgeDx === 0) edgeDx = sx < widthPx / 2 ? LABEL.pointerPx : -LABEL.pointerPx;
      } else if (form === 'left') {
        // At the left limb, the tag ending a short line to its left.
        projected.set(p.drawn.x, p.drawn.y, p.drawn.z).addScaledVector(right, -drawnRadius).project(camera);
        x = ((projected.x + 1) / 2) * widthPx;
        y = ((1 - projected.y) / 2) * viewportPx;
        edgeDx = -LABEL.gapPx;
        edgeDy = -LABEL.tagPx / 2;
      }
      // Its box, for collisions: the tag extends right of its point (or left, for a pointer at the right edge).
      const boxX = offView && edgeDx < 0 ? x + edgeDx - LABEL.widthPx : x + (offView ? edgeDx : LABEL.gapPx);
      const boxY = y + (offView ? edgeDy : 0) - LABEL.tagPx;
      const room = state.blocked ? LABEL.clearAgain : 1;
      let blocked = false;
      for (let t = 0; t < takenCount; t++) {
        const other = taken[t];
        if (!other) continue;
        if (Math.abs(other.x - boxX) < LABEL.widthPx * room && Math.abs(other.y - boxY) < LABEL.tagPx * room) blocked = true;
      }
      state.blocked = wanted && blocked;
      const showTag = wanted && !blocked && !offView;
      const showEdge = wanted && !blocked && offView;
      if (showTag || showEdge) {
        const slot = taken[takenCount];
        if (slot) {
          slot.x = boxX;
          slot.y = boxY;
          takenCount += 1;
        }
      }
      // Easing: in at the usual pace, out quickly when it gave way to another tag or to its own other
      // form (the tag beside the body and the pointer at the edge); a form taking over waits until the
      // other has nearly gone, so a name never shows twice.
      const settleTo = (was: number, want: number, other: number, otherWanted: boolean): number => {
        if (!entering && want > was && other > LABEL.handover) return was;
        const k = entering ? 1 : want > was ? show : blocked || otherWanted ? hide : show;
        const now = was + (want - was) * k;
        return now < 1e-3 && want === 0 ? 0 : now;
      };
      const tagWant = showTag ? LABEL.opacity : 0;
      const edgeWant = showEdge ? LABEL.opacity : 0;
      const tagWas = state.tag;
      state.tag = settleTo(tagWas, tagWant, state.edge, edgeWant > 0);
      state.edge = settleTo(state.edge, edgeWant, tagWas, tagWant > 0);
      labelOpacity.set(id, state.tag);
      if (state.tag > 1e-3) {
        const label = state.tagLabel;
        label.position[0] = ax;
        label.position[1] = ay;
        label.position[2] = az;
        label.opacity = state.tag;
        labels.push(label);
      }
      if (state.edge > 1e-3) {
        // The pointer's point (at the edge of the clear view, or the left limb), back in the scene's frame at the anchor's depth.
        if (offView) {
          projected.set((x / widthPx) * 2 - 1, 1 - (y / viewportPx) * 2, anchor.z).unproject(camera);
          state.edgeAt[0] = projected.x;
          state.edgeAt[1] = projected.y;
          state.edgeAt[2] = projected.z;
          state.edgeOffset[0] = edgeDx;
          state.edgeOffset[1] = edgeDy;
        }
        const label = state.edgeLabel;
        label.position[0] = state.edgeAt[0];
        label.position[1] = state.edgeAt[1];
        label.position[2] = state.edgeAt[2];
        label.offset = state.edgeOffset;
        label.opacity = state.edge;
        labels.push(label);
      }
    }
  };

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
      // A cut that had already moved the camera finishes (it "arrives"); anything else stopped where it was.
      if (did && !nav.travelling) stopped = true;
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

      // The mission maps stream by detail (Low on entry, the focus raised after); the Earth's air from the cited model.
      const renderer = c.renderer;
      rawDecoder = createRawDecoder();
      const uploader = createUploader(renderer);
      const textures = createPlanetTextures({
        assets: c.assets,
        manifest,
        detail,
        upload: (t) => {
          // An upload costs main-thread time over a frame or a few: nothing is judged for a while after one starts.
          governor?.holdOff();
          return uploader(t);
        },
        raw: rawDecoder,
      });
      textures.setRingPlaceholder(ringTransmission(physical.saturnRings), physical.saturnRings.innerKm, physical.saturnRings.outerKm);
      const sunKm = system.specs.sun.radiusKm;
      const air = earthAir(c.data, system.specs.earth.radiusKm, Math.asin(sunKm / physical.auKm));
      earthAirModel = air;
      airTable = createTransmittanceTable(air);
      const strip = findPlanetTexture(manifest, 'saturn', 'rings', 'low')?.radiusKm ?? [physical.saturnRings.innerKm, physical.saturnRings.outerKm];
      earthTiles = createEarthTiles(c.renderer, detail);
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
        tiles: earthTiles,
        compile: (objects) => compileForFrames(objects),
      });
      stars = createStarfield(STAR_MAX, 400, 7_101, { depthTest: true, dynamicRadius: true });
      applyDetail(detail);
      // The stars are drawn every frame inside the post pipeline's scene pass: the target bound then is
      // the one the explorer's pipelines must be compiled for (compileForFrames).
      stars.object.onBeforeRender = (r: unknown) => {
        const target = (r as { getRenderTarget(): RenderTarget | null }).getRenderTarget();
        if (target && target !== compileTarget) {
          frameTarget = target;
          releaseStandIn();
        }
      };
      const body = (name: string): PlanetsFile['bodies'][number] => {
        const found = planets.bodies.find((b) => b.name === name);
        if (!found) throw new Error(`planets.json has no ${name}`);
        return found;
      };
      const sunAt = system.bodies.sun.position;
      orbitPaths = [
        planetOrbit('mercury', body('Mercury'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('venus', body('Venus'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('mars', body('Mars'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('uranus', body('Uranus'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('neptune', body('Neptune'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('earth', body('Earth'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('jupiter', body('Jupiter'), sunAt, physical.auKm, ORBIT_COLOR),
        planetOrbit('saturn', body('Saturn'), sunAt, physical.auKm, ORBIT_COLOR),
        moonOrbit(moon, system.bodies.earth.position, MOON_ORBIT_COLOR),
      ];
      orbits = createOrbits(orbitPaths);
      dots = createImpostors(BODY_IDS.length);
      glare = createSunGlare(blackbodyRgb(SUN_KELVIN));
      root.add(stars.object, orbits.mesh, dots.object, glare.object, ...BODY_IDS.map((id) => bodies?.objects[id]).filter((o): o is Group => o !== undefined), ...bodies.extras);
      satellites = createSatelliteLayer(c.assets.url('assets/live/active.tle'));
      // The Earth's turn (rad/s) from its rotation model: the prime meridian's rate, degrees per day.
      satellites.setEarthRotation((physical.bodies.Earth.pm[1] * Math.PI) / 180 / SECONDS_PER_DAY);
      quakes = createQuakeLayer();
      root.add(...satellites.objects, quakes.object);

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
          stretch.steered = true;
          nav.drag(w, dx, dy);
        },
        pan: (dx, dy) => {
          stretch.steered = true;
          nav.pan(w, dx, dy);
        },
        zoom: (dLn) => {
          stretch.steered = true;
          nav.zoom(w, dLn);
        },
        orbitKeys: (azimuth, elevation, zoom) => {
          if (azimuth !== 0 || elevation !== 0 || zoom !== 0) stretch.steered = true;
          nav.setOrbitKeys(azimuth, elevation, zoom);
        },
        flightKeys: (move, roll, boost) => {
          if (move.x !== 0 || move.y !== 0 || move.z !== 0 || roll !== 0) stretch.steered = true;
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
      if (!entered) wantStretch = options.stretch === true;
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
      // From Chapter 7 the film's compressed system first stretches out to true scale (./stretch), seen
      // from above with the Sun in the middle; otherwise the explorer opens on the body at true scale.
      for (const path of orbitPaths) path.setDate(jdTdb);
      const neptuneOrbitKm = orbitPaths.find((path) => path.body === 'neptune')?.sizeKm ?? 0;
      const saturnOrbitKm = orbitPaths.find((path) => path.body === 'saturn')?.sizeKm ?? 0;
      const then = wantBody ?? DEFAULT_BODY;
      Object.assign(stretch, { active: false, t: 0, amount: 1, rush: false, steered: false, then });
      if (wantStretch && !c.reducedMotion && saturnOrbitKm > 0) {
        filmUnit = filmUnitKm(saturnOrbitKm, system.auKm);
        Object.assign(stretch, { active: true, amount: 0 });
        const e = system.bodies.earth.position;
        const azimuth = Math.atan2(e.x, e.z) + MathUtils.degToRad(STRETCH.azimuthDeg);
        const elevation = MathUtils.degToRad(STRETCH.elevationDeg);
        const cosE = Math.cos(elevation);
        nav.place('sun', km(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth)), STRETCH.framing * stretchedDistance(neptuneOrbitKm, 0, filmUnit, system.auKm), world);
      } else {
        nav.begin(world, then, true);
      }
      wantBody = null;
      wantStretch = false;
      // A fresh mirror of the limiter, already adapted, so guides are steady from the first frame.
      adaptation = createExposureControl({ reducedMotion: c.reducedMotion });
      adaptation.setFade(1);
      adaptation.setTarget(exposureFor(nav.focus));
      adaptation.jump();
      for (const id of BODY_IDS) {
        labelOpacity.set(id, 0);
        labelState[id].tag = 0;
        labelState[id].edge = 0;
        labelState[id].form = 'none';
        labelState[id].blocked = false;
      }
      // The rung's picture settings (bloom, pixel ratio), the full internal resolution, and a hold-off while it all settles.
      applyDetail(detail);
      renderScale = governor?.scale ?? 1;
      c.graphics.setRenderScale(renderScale);
      governor?.holdOff();
      wasTravelling = false;
      // The log of what was seen lasts the whole visit to the page; the note starts afresh.
      discovery = null;
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

    earth(command) {
      switch (command.kind) {
        case 'goto':
          goToPlace(command.lat, command.lon, command.viewKm);
          return;
        case 'imagery':
          earthTiles?.setMode(command.mode);
          // The day mosaic stops at 250 m per pixel: its lens stops wider.
          nav.setLensMin(command.mode === 'today' ? TODAY_LENS_MIN_DEG : ZOOM_LENS.minDeg);
          return;
        case 'layer':
          if (command.layer === 'satellites') satellites?.setOn(command.on);
          else quakes?.setOn(command.on);
          return;
        case 'select':
          satellites?.select(command.id === null ? null : Number(command.id));
          return;
      }
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
      insets = { top: next.top, bottom: next.bottom, left: next.left ?? 0, right: next.right ?? 0 };
    },

    place(pose: UniversePose) {
      if (!world || !system) return;
      // A placed camera is at true scale.
      Object.assign(stretch, { active: false, amount: 1 });
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
      earthTiles?.suspend();
      entered = false;
      Object.assign(stretch, { active: false, amount: 1 });
      labels.length = 0;
      ctx?.exposure.setVeil(1);
    },

    dispose() {
      root.removeFromParent();
      input?.detach();
      bodies?.dispose();
      earthTiles?.dispose();
      earthTiles = null;
      satellites?.dispose();
      satellites = null;
      quakes?.dispose();
      quakes = null;
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
