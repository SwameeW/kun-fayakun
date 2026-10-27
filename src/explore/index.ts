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
import { createEphemeris, installTheories, tableRange, validRange, type MoonFile, type PlanetsFile } from '../astro/ephemeris';
import { obliquityRad, PHYSICAL_URL, ringTransmission, type PhysicalFile } from '../astro/physical';
import type { RotatingBody } from '../astro/rotation';
import { julianDateUtc, utcToTdb } from '../astro/time';
import { createNoiseVolume } from '../chapters/shared/noise-volume';
import { blackbodyRgb } from '../chapters/shared/blackbody';
import { DEFAULT_FOV } from '../core/camera';
import { setHook } from '../core/hooks';
import { createExposureControl, type EngineExposure } from '../core/post';
import {
  BODY_IDS,
  type BodyId,
  type FocusId,
  type SceneLabel,
  type UniverseBodyView,
  type UniverseContext,
  type UniverseIllustration,
  type UniverseIslamicCommand,
  type UniverseModule,
  type UniversePose,
  type UniverseSteer,
  type UniverseTime,
  type UniverseView,
  type UniverseLiving,
  type ViewInsets,
  type WalkableWorld,
} from '../core/types';
import { PLANETS_MANIFEST_URL, findPlanetTexture, type PlanetsManifest } from './assets/planets';
import { createPlanetTextures } from './assets/streaming';
import { createRawDecoder, type RawDecoder } from './assets/raw-ktx2';
import { createUploader } from './assets/upload';
import { createBodies, SUN_KELVIN, type Bodies } from './bodies';
import { createEarthTiles, type EarthTiles } from './earth-tiles';
import { lastWholeDay, RELIEF } from './earth-tiles/sources';
import type { Islamic } from './islamic';
import type { Descent } from './descent';
import type { Neighbourhood } from './neighbourhood';
import type { LocalGroupFile, WebManifest } from './neighbourhood/beyond';
import type { NeighbourhoodFile } from './neighbourhood/data';
import type { DescentFile } from './descent/profile';
import type { Walk } from './walk';
import type { Worlds } from './worlds';
import type { EquirectGrids } from './walk/equirect';
import type { WalkInput } from './walk/walker';
import { hijriDate } from './islamic/hijri';
import type { Lab, LabPointerView } from './lab';
import { composeBulletin } from './field-notes/bulletin';
import { ATLAS, MAKKAH_FRAME, site, SITES, type FieldPlace } from './field-notes/data';
import { centralAngle, loadPlaces, type Place } from './field-notes/places';
import { createQuakeLayer, type QuakeLayer } from './living/quakes';
import { createSatelliteLayer, type SatelliteLayer } from './living/satellites';
import { fineDetailShown } from './bodies/earth';
import { craterDetailShown } from './bodies/moon';
import { createSunGlare, visibleShare, type SunGlare } from './bodies/glare';
import { createImpostors, type ImpostorDot, type Impostors } from './bodies/impostor';
import type { SurfaceMark } from './bodies/marks';
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
import { createSky, SKY_LAYERS, SKY_URL, type Sky, type SkyFile } from './sky';
import { createSoundscape, type Soundscape, type SoundState } from './sound';
import { createSolarSystem, type SolarSystem } from './system';
import { advanceClock, applyTimeCommand, FOOT_MAX_RATE, heldRate, LAB_DATE_SPAN_S, validTimeCommand } from './time';
import type { SpinHold } from './time-beyond';

const DEFAULT_BODY: BodyId = 'earth';
const NOISE = { size: 64, seed: 31_415 } as const;
const SECONDS_PER_DAY = 86_400;

/**
 * Sound where there is air (./sound), in display terms: an illustrative breeze on each world with air
 * (m/s; the walks know no wind, and Venus's surface winds are slow), and how far up in pitch the wind's
 * noise reaches there (Hz): Mars's thin carbon dioxide takes high pitches first (Perseverance's
 * microphones, Maurice et al. 2022).
 */
const SOUND_BREEZE: Partial<Record<WalkableWorld, number>> = { earth: 5, mars: 5, venus: 1 };
/** Photo mode's lenses may span this field (degrees). */
const LENS_FOV = { min: 1, max: 120 } as const;
const SOUND_BRIGHT: Partial<Record<WalkableWorld | 'jupiter', number>> = { earth: 1800, mars: 500, venus: 1200, jupiter: 2000 };

/** Above this height (km) with the lens at rest, the view stops turning with the Earth (it is no longer held over a place). */
const PLACE_LOCK_KM = 3000;
/** How near (CSS px) a double click must be to a satellite to choose it. */
const SATELLITE_PICK_PX = 9;
/** The live layers show within this distance of the Earth (km): about ten times the Moon's distance. */
const LIVING_RANGE_KM = 4e6;
/** On foot: the field of view (degrees), and the depth range (km) the ground's logarithmic depth spans, past any horizon a walker sees. */
const WALK_FOV = 70;
/** On foot the wheel or a pinch narrows and widens the view, between these (degrees: binoculars to a wide lens). */
const WALK_ZOOM = { min: 20, max: 90 } as const;
const WALK_LENS = { near: 1e-4, far: 2000 } as const;
/** On foot the imagery is aimed at the walker's feet as if a pixel there spanned a metre, which asks for its finest level (km). */
const WALK_FOOTPRINT_KM = 0.001;
/** The worlds there is an atmosphere to descend through where a probe went (ledger GR-6). */
type DescentWorld = 'venus' | 'jupiter';
const DESCENT_IDS: readonly DescentWorld[] = ['venus', 'jupiter'];
/** The dip into or out of a walk: seconds to dark, and back to light. */
const WALK_DIP = { downS: 0.25, upS: 0.4 } as const;
/** The worlds there is ground to walk on. */
type WalkWorld = WalkableWorld;
const WALKABLE: readonly BodyId[] = ['earth', 'moon', 'mars', 'mercury', 'venus'];
/** Each walkable world's entry in JPL's physical file (its radii and GM). */
const WALK_KEYS: Record<WalkWorld, RotatingBody> = { earth: 'Earth', moon: 'Moon', mars: 'Mars', mercury: 'Mercury', venus: 'Venus' };
const walkable = (id: BodyId): id is WalkWorld => WALKABLE.includes(id);
const WALK_IDS: readonly WalkWorld[] = ['earth', 'moon', 'mars', 'mercury', 'venus'];
/** The worlds drawn with a solid surface the laboratory's craters mark, and no marks at all. */
const CRATERED: readonly BodyId[] = ['earth', 'moon', 'mercury', 'mars'];
const NO_MARKS: readonly SurfaceMark[] = [];
/** The narrowest lens over the day's mosaic (its 250 m pixels at about four screen pixels each from the lowest orbit). */
const TODAY_LENS_MIN_DEG = 6;
/**
 * The time machine and the live layers: satellites are shown up to this rate (explorer seconds per
 * real second: the worker's states, several a second, carry them no further) and earthquakes only
 * within this long of the present (the feed is the past day's).
 */
const SATELLITE_MAX_RATE = 600;
const QUAKES_WITHIN_MS = 86_400_000;
/**
 * The field notes' names on the ground: shown within this distance of the Earth's centre (km), kept
 * this many CSS px apart (in their list's order: the rest give way until the view comes closer), and
 * eased in and out at this share a frame.
 */
const MARKER_RANGE_KM = 60_000;
const MARKER_SPACING_PX = 64;
const MARKER_EASE = 0.12;
const UNIX_EPOCH_JD = 2440587.5;
/** The chunk beyond the everyday, when it failed to come: asked for again after this long (s), or at once for a date beyond the tables. */
const BEYOND_RETRY_S = 30;

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
/** The sky's starlight, and how much of the exposure's adaptation it shows (0 none, 1 all of it). */
const STARS = { light: 0.85, follow: 0.2 } as const;

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
/** The corners a laboratory name may take about its body (CSS px, its leader's end): up and right first, then up-left, down-right, down-left. */
const LAB_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [10, -10],
  [-10, -10],
  [10, 18],
  [-10, 18],
];
/**
 * Numbers kept per laboratory name each frame (declutterLab); a name's tag's height (CSS px); the room a
 * name showing keeps from another before it gives way; and the letters reckoned for a name given only by
 * its key (a ship's burn directions: the longest of them, "anti-normal").
 */
const LAB_GEOM = 6;
const LAB_TAG_PX = 21;
const LAB_MARGIN_PX = 8;
const LAB_KEY_LETTERS = 11;
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
  /** Where its tag's box is, and its pointer's (CSS px, top left; the pointer's stays where it was drawn last), for one coming in where either still shows. */
  tagBox: [number, number];
  edgeBox: [number, number];
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
  return { tag: 0, edge: 0, form: 'none', blocked: false, tagBox: [0, 0], edgeBox: [0, 0], tagLabel, edgeLabel, edgeAt: [0, 0, 0], edgeOffset };
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
  /** The stars around the Sun (./neighbourhood), drawn instead of the solar system while there. */
  const starsRoot = new Group();
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
  /** A saved view to glide to once the trip to its body has arrived (ledger GR-4). */
  let pendingView: { body: BodyId; lat: number; lon: number; altitudeKm: number } | null = null;
  /** The place beneath the camera on the body in view (UniverseView.place). */
  let placeBelow: { body: BodyId; lat: number; lon: number; altitudeKm: number } | null = null;
  const earthMeridianBefore = km();
  const earthPole = km();
  let earthMeridianKnown = false;
  /** The Living Earth's live layers (made with the bodies, loaded when first turned on). */
  let satellites: SatelliteLayer | null = null;
  let quakes: QuakeLayer | null = null;
  const living = { earth: { x: 0, y: 0, z: 0 }, sun: { x: 1, y: 0, z: 0 } };
  /** The field notes: the world's places (for the bulletin's "near"), the set named on the ground, and their fades. */
  let places: readonly Place[] = [];
  let markerSet: 'atlas' | 'prophets' | null = null;
  const markerFade = new Map<string, number>();
  let bulletinClock = Number.POSITIVE_INFINITY;
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
  /** The real sky (./sky): the Bright Star Catalogue's stars, and the constellations and grid when asked for. */
  let stars: Sky | null = null;
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
  /** JPL's tables' own spans (positions beyond them come from the published theories: UniverseTime.beyond). */
  let tables: ReturnType<typeof tableRange> | null = null;
  /**
   * The time machine beyond the everyday (./time-beyond, its own chunk: the published theories beyond
   * the tables, and the hold of a world's turn too fast to show): not asked for, on the way, in, or
   * failed (offline: asked for again BEYOND_RETRY_S later, not every frame).
   */
  let theoryState: 'none' | 'loading' | 'ready' | 'failed' = 'none';
  let theoryRetryAt = 0;
  let spinHold: SpinHold | null = null;
  /** A date asked for beyond the tables before the theories came (UTC), and whether the clock was paused before it. */
  let pendingDate: { utc: number; paused: boolean } | null = null;
  /**
   * The orbital laboratory (./lab): while an experiment runs it owns the worlds' positions and the
   * clock; the bodies it removed are hidden; and the explorer's own time and imagery wait, to be put
   * back exactly as they were when it ends.
   */
  let lab: Lab | null = null;
  /** What the laboratory is made from (kept from loading; the laboratory's own code loads only when one starts). */
  let labInputs: { planets: PlanetsFile; moon: MoonFile; physical: PhysicalFile } | null = null;
  /** The sky's catalogue, kept for the astrolabe's stars. */
  let skyData: SkyFile | null = null;
  let labLoading = false;
  let wantLab = false;
  /** A share link's scenario (src/sim/share), waiting for the laboratory to open. */
  let pendingShare: string | null = null;
  const hiddenBodies = new Set<BodyId>();
  /** The qibla and the new moon (./islamic, its own chunk): loaded when their section first asks; commands wait for it. */
  let islamic: Islamic | null = null;
  /** On foot (./walk, its own chunk): each world's walk made the first time it is asked for; `walk` the one in use, on `walkWorld`. */
  const walks: Partial<Record<WalkWorld, Walk | undefined>> = {};
  let walk: Walk | null = null;
  let walkWorld: WalkWorld = 'earth';
  let walkLoading = false;
  let walkAsked: { on: WalkWorld; lat: number; lon: number; headingDeg: number; pitchDeg: number } | null = null;
  /**
   * Whether the walker's view is shown (it is once the walk has landed, any glide down has ended and
   * the picture has dipped), and the dip into or out of it under way: the picture dims, the camera
   * moves while it is dark (the exposure jumping to the new light), and it comes back, as a
   * reduced-motion cut does.
   */
  let walkShown = false;
  let walkDip: { into: boolean; t: number; switched: boolean } | null = null;
  /**
   * Down through an atmosphere (./descent, its own chunk): each world's made the first time, `descent`
   * the one under way, shown once the picture has dipped into it; the on-screen pad's climb (-1 hurry
   * down, 1 climb); and this frame's eye there.
   */
  const descents: Partial<Record<DescentWorld, Descent | undefined>> = {};
  let descent: Descent | null = null;
  let descentLoading = false;
  let descentShown = false;
  let descentDip: { into: boolean; t: number; switched: boolean } | null = null;
  const descentPad = { climb: 0 };
  let descending = false;
  /**
   * Among the stars (./neighbourhood, its own chunk): made the first time, shown once the picture
   * has dipped into it (the solar system hidden), and this frame's veil from its dip.
   */
  let hood: Neighbourhood | null = null;
  let hoodLoading = false;
  /**
   * More worlds (./worlds, its own chunk: the small bodies, the moons, Uranus's and Neptune's rings,
   * eclipses): asked for 6 s into a visit, once the entry's push-in has settled and the first maps have
   * come (at once for a world asked for by name, flown to when it comes, or for the layer; again
   * BEYOND_RETRY_S after a failure), and the layer's choice meanwhile.
   */
  let worlds: Worlds | null = null;
  let worldsAt = 6;
  let worldsLoading = false;
  let worldWanted: string | null = null;
  let worldsLayer = true;
  let hoodShown = false;
  let hoodDip: { into: boolean; t: number; switched: boolean } | null = null;
  let hoodVeil = 1;
  /** The orbit a walk's descent left (its body, the direction from it, render frame, and the height), to climb back to. */
  let walkReturn: { body: BodyId; dir: Km; altitudeKm: number } | null = null;
  let walkRefused = false;
  /** This frame's walker pose, once landed (the camera is there instead of where the navigator has it). */
  let walking = false;
  /** This frame's veils from a walk's and a descent's dips (1 none), and whether the camera switched under one. */
  let walkVeil = 1;
  let descentVeil = 1;
  let walkCut = false;
  const walkInput: WalkInput = { forward: 0, right: 0, run: false, jump: false, turn: 0, tip: 0 };
  /** The on-screen pad's walk, step aside, run and jump; Q and E turning on foot; the keys and pad together as the walker gets them. */
  const walkPad = { forward: 0, right: 0, run: false, rover: false, jump: false };
  /** The field of view on foot (the wheel's and a pinch's), and whether a drag moves the scene with it (the visitor's choice) rather than the look. */
  let walkFov = WALK_FOV;
  let walkScene = false;
  let walkTurnKeys = 0;
  /**
   * Esc is the walk's (and a descent's) from the moment one is asked for until a second after the
   * climb back to orbit ends (performance.now() ms), so a repeated or held Esc never carries on out of
   * the explorer; a walk asked for during a trip waits for the arrival.
   */
  let escapeHeld = 0;
  let walkClimb = false;
  let walkAfterTrip: { on: WalkWorld; lat: number; lon: number; headingDeg: number; pitchDeg: number } | null = null;
  const walkStep: WalkInput = { ...walkInput };
  /** The point on the Earth beneath the camera when near it (degrees), for the qibla from below and walks begun there. */
  let belowEarth: { lat: number; lon: number } | null = null;
  /** The point beneath the camera on the walkable world in view (UniverseView.walkHere). */
  let walkHere: { world: WalkWorld; lat: number; lon: number } | null = null;
  /** The air's figures for the suit's readout (data/constants.json), once the constants have loaded. */
  let walkAir: { surfaceKpa: number | null; scaleHeightKm: number | null; meanTempC: number | null } = { surfaceKpa: null, scaleHeightKm: null, meanTempC: null };
  /** Every other world's figures for the suit (data/constants.json, NASA's fact sheets): air or none, mean temperature, the ground's range. */
  const walkFigures: Partial<Record<WalkWorld, { surfaceKpa: number | null; scaleHeightKm: number | null; meanTempC: number | null; dayRangeC: { min: number; max: number } | null }>> = {};
  /** Each world's J2 and moment of inertia factor (data/constants.json, NASA's fact sheets), for the laboratory's seed. */
  let labShapes: Record<string, { j2: number | null; inertia: number | null }> = {};
  /** The sourced constants, for the laboratory's climates (built in its own chunk). */
  let labFigure: (id: string) => number | null = () => null;
  /** Each walkable world's air: its mean molar mass (kg/mol) from its composition (for the air's density at the feet), null without air. */
  let airMolar: Partial<Record<WalkWorld, number>> = {};
  /** Sound where there is air (./sound): made with the context. */
  let soundscape: Soundscape | null = null;
  const soundView: UniverseView['sound'] = { on: true, playing: null };
  /** Photo mode's lens (degrees of field, top to bottom), or null for the explorer's own framing. */
  let lensFov: number | null = null;
  /** Photo mode's tracking: the body kept in its place in the frame, and its direction from the focus last frame. */
  let tracking: BodyId | null = null;
  const trackDir = km();
  let trackKnown = false;
  let islamicLoading = false;
  const islamicWaiting: UniverseIslamicCommand[] = [];
  let hijriDay = Number.NaN;
  let hijri: UniverseTime['hijri'] = null;
  let beforeLab: { rate: number; paused: boolean; jdTdb: number; jdUtc: number; imagery: 'clear' | 'today'; markers: 'atlas' | 'prophets' | null } | null = null;
  /** The time machine (./time): the rate set, whether paused, the end it stopped at, and the rate the clock ran at this frame. */
  let timeRate = 1;
  let timePaused = false;
  let timeEdge: 'start' | 'end' | null = null;
  let clockRate = 1;
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
  /** Each world's IAU spin (degrees a day), for the hold of its turn at fast time (./time-beyond). */
  const spinRate = Object.fromEntries(BODY_IDS.map((id) => [id, 0])) as Record<BodyId, number>;
  const trueSunKm = Object.fromEntries(BODY_IDS.map((id) => [id, 0])) as Record<BodyId, number>;
  const earthTrue = km();
  /** The film's scene unit, km (set on the way in). */
  let filmUnit = 0;
  /** The date shown: TDB Julian date, and UTC for display. */
  let jdTdb = 0;
  let jdUtc = 0;
  /** Seconds of the bodies' own illustrative motion (drifting clouds and bands, the Sun's surface): still with reduced motion. */
  let ambient = 0;
  /** Seconds since the explorer was entered (the theories' chunk comes a few seconds in, off the first frames). */
  let shownFor = 0;
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
  /**
   * What stands over the view inside it (the way back, the readout's card on a wide screen: CSS px), from
   * the interface ('kf-universe-avoid' on the window); names keep clear of it.
   */
  const avoid: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  const onAvoid = (event: Event): void => {
    const rects = (event as CustomEvent<unknown>).detail;
    avoid.length = 0;
    if (!Array.isArray(rects)) return;
    for (const r of rects as unknown[]) {
      const q = r as Partial<Record<'left' | 'top' | 'right' | 'bottom', unknown>>;
      if (typeof q.left === 'number' && typeof q.top === 'number' && typeof q.right === 'number' && typeof q.bottom === 'number') avoid.push({ left: q.left, top: q.top, right: q.right, bottom: q.bottom });
    }
  };
  window.addEventListener('kf-universe-avoid', onAvoid);
  /**
   * The laboratory's names (declutterLab): each one's eased opacity, the corner it sits at and the frame
   * it was last seen; this frame's order, where each is (LAB_GEOM numbers a name: its point, width,
   * whether it shows, its box at its corner) and the corners given.
   */
  const labFade = new Map<string, number>();
  const labPlace = new Map<string, number>();
  const labSeen = new Map<string, number>();
  let labFrame = 0;
  const labOrder: number[] = [];
  const labGeom: number[] = [];
  const labBoxes: Array<{ x: number; y: number; w: number }> = [];
  /**
   * The laboratory's names showing last frame, and the chosen body's name and marks given a place (showing
   * or coming in): four numbers each (a box's left, top and width, its height LAB_TAG_PX; 1 for the
   * chosen body's, which the worlds' names give way to).
   */
  const labShown: number[] = [];
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

  /** Goes to a date (UTC; null: now). A date outside the explorer's span is shown at its nearest end, which is returned (null inside it). */
  const setDate = (utc: number | null): 'start' | 'end' | null => {
    if (!timeConstants) return null;
    const wanted = utc ?? julianDateUtc(Date.now());
    const tdb = utcToTdb(wanted, timeConstants);
    jdTdb = Math.min(range.endJd, Math.max(range.startJd, tdb));
    jdUtc = wanted + (jdTdb - tdb);
    return tdb < range.startJd ? 'start' : tdb > range.endJd ? 'end' : null;
  };
  /** The span the clock keeps to: where both the planets' and the Moon's positions are good. */
  const spanOf = (moon: MoonFile): void => {
    const valid = validRange(moon);
    range = { startJd: Math.max(valid.planets.startJd, valid.moon.startJd), endJd: Math.min(valid.planets.endJd, valid.moon.endJd) };
  };
  /**
   * The chunk beyond the everyday, loaded when the clock heads beyond the tables or runs fast
   * (backwards, a day a second or more, near an end, or a date beyond asked for: `now`, which asks
   * again at once after a failure), or a few seconds in. Once in, the span widens to the theories': a
   * clock held at a table's end goes on, and a date asked for beyond is gone to. Offline, the tables'
   * span stays, the date waits no more (the note gives the span), and it is asked for again later.
   */
  const loadTheories = (now = false): void => {
    const inputs = labInputs;
    if (!inputs || theoryState === 'loading' || theoryState === 'ready' || (theoryState === 'failed' && !now && shownFor < theoryRetryAt)) return;
    theoryState = 'loading';
    import('./time-beyond').then(
      (m) => {
        installTheories(m.theories);
        spinHold = m.createSpinHold(spinRate);
        theoryState = 'ready';
        spanOf(inputs.moon);
        const asked = pendingDate;
        pendingDate = null;
        if (asked) goToDate(asked.utc, asked.paused);
        else if (timeEdge && jdTdb > range.startJd && jdTdb < range.endJd) {
          timeEdge = null;
          timePaused = false;
        }
      },
      () => {
        theoryState = 'failed';
        theoryRetryAt = shownFor + BEYOND_RETRY_S;
        pendingDate = null;
      },
    );
  };
  /** Loads more worlds (./worlds); a world asked for meanwhile is flown to when they come. */
  const loadWorlds = (): void => {
    const c = ctx;
    const sys = system;
    const inputs = labInputs;
    if (!c || !sys || !inputs) return;
    worldsLoading = true;
    import('./worlds')
      .then((m) => m.createWorlds(c, sys, obliquityRad(inputs.physical), detail))
      .then(
        (w) => {
          worlds = w;
          root.add(w.object);
          (world?.all as NavBody[] | undefined)?.push(...w.navList());
          w.setLayer(worldsLayer);
          const wanted = worldWanted;
          worldWanted = null;
          const id = wanted ? w.find(wanted) : null;
          if (id && world) nav.flyTo(world, id);
        },
        () => {
          worldsAt = shownFor + BEYOND_RETRY_S;
        },
      )
      .finally(() => {
        worldsLoading = false;
      });
  };
  /** Goes to a date (UTC), running or paused as given; beyond the span, stopped at its end (which says why), and the theories asked for. */
  const goToDate = (utc: number, paused: boolean): void => {
    const outside = setDate(utc);
    timeEdge = outside;
    timePaused = outside ? true : paused;
    if (outside && theoryState !== 'ready') {
      pendingDate = { utc, paused };
      loadTheories(true);
    }
  };
  /** A TDB Julian date as UTC (TDB runs about a minute ahead of UTC), for the span's ends as dates. */
  const tdbToUtc = (tdb: number): number => (timeConstants ? tdb - (utcToTdb(tdb, timeConstants) - tdb) : tdb);
  /** What holds the clock below the rate set: a trip (real time), or being on foot or on the way down (FOOT_MAX_RATE); null when nothing does. */
  const clockHold = (): 'trip' | 'foot' | null => (nav.travelling ? 'trip' : walk?.active || descent?.active ? 'foot' : null);

  /** The body a world belongs to (its planet; the Sun for the rest); a body is its own. */
  const host = (id: FocusId): BodyId => worlds?.host(id) ?? (id as BodyId);

  const exposureFor = (id: FocusId): number => {
    if (!world || !system || id === 'sun') return 1;
    const p = world.body(id).position;
    const au = Math.hypot(p.x, p.y, p.z) / system.auKm;
    return Math.max(0.05, au) ** EXPOSURE_POWER * (id === 'moon' ? MOON_EXPOSURE : 1);
  };

  /** How much of the Sun's disc no nearer body covers, 0 to 1. */
  const sunVisible = (): number => {
    if (!system) return 1;
    // Under Venus's clouds the Sun is never seen; descending, it shows only through the cloud above.
    if (walking && walk && !walk.skySeen) return 0;
    if (descending && descent) return descent.sunSeen();
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
    // On foot the eye adapts to the light where it stands (./walk/light), not to the distance from the Sun.
    const metered = walking ? walk?.exposure() : null;
    if (metered) return metered;
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
    satellites: { state: 'off', count: 0, byKind: { station: 0, starlink: 0, oneweb: 0, navigation: 0, geostationary: 0, other: 0 }, sunlit: 0, fetchedMs: 0, selected: null },
    quakes: { state: 'off', fetchedMs: 0, list: [] },
    station: null,
    bulletin: null,
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
    time: { rate: 1, paused: false, edge: null, held: null, beyond: { moon: false, planets: false }, spinHeld: false, pending: false, startMs: 0, endMs: 0, hijri: null },
    sky: { layers: { constellations: false, boundaries: false, grid: false, names: false }, stars: 0 },
    lab: null,
    islamic: null,
    walk: null,
    walkRefused: false,
    walkWaiting: false,
    walkHere: null,
    place: null,
    descent: null,
    neighbourhood: null,
    sound: { on: true, playing: null },
    lensFov: null,
    tracking: null,
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

  /**
   * What the air carries where the visitor is (./sound): on foot, the air's density at the feet (its
   * pressure there, the world's mean temperature and its air's molar mass, by the ideal gas law) and
   * an illustrative breeze; on the way down, the probe's own density and wind; on an airless world,
   * the suit's fans; anywhere else (space, the stars, an experiment), nothing.
   */
  const soundState = (): SoundState | null => {
    const w = viewState.walk;
    if (walkShown && w) {
      const molar = airMolar[w.world];
      if (w.pressureKpa === null || molar === undefined) return { air: null, suit: true };
      const densityKgM3 = (w.pressureKpa * 1000 * molar) / (8.314462618 * ((w.meanTempC ?? 15) + 273.15));
      return { air: { densityKgM3, windMs: SOUND_BREEZE[w.world] ?? 5, brightHz: SOUND_BRIGHT[w.world] ?? 1500 }, suit: false };
    }
    const d = viewState.descent;
    if (descentShown && d) return { air: { densityKgM3: d.densityKgM3, windMs: Math.abs(d.windMs ?? SOUND_BREEZE.venus ?? 1), brightHz: SOUND_BRIGHT[d.world] ?? 1500 }, suit: false };
    return null;
  };
  /** Browsers let sound begin only after the visitor touches the page. */
  const unlockSound = (): void => {
    soundscape?.unlock();
  };

  const refreshView = (): void => {
    const cam = origin.camera;
    const focus = nav.focus;
    const spec = world?.body(focus);
    const p = spec?.position;
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
    if (stars) for (const layer of SKY_LAYERS) v.sky.layers[layer] = stars.layers[layer];
    v.sky.stars = stars?.object.count ?? 0;
    // In the laboratory the time controls run the experiment's clock.
    v.time.rate = lab?.active ? lab.rate : timeRate;
    v.time.paused = lab?.active ? lab.paused : timePaused;
    v.time.edge = lab?.active ? lab.edge : timeEdge;
    v.time.held = lab?.active ? null : clockHold();
    v.time.spinHeld = spinHold?.held(host(focus)) ?? false;
    v.time.beyond.moon = !lab?.active && tables !== null && (jdTdb < tables.moon.startJd || jdTdb > tables.moon.endJd);
    v.time.beyond.planets = !lab?.active && tables !== null && (jdTdb < tables.planets.startJd || jdTdb > tables.planets.endJd);
    v.lab = lab?.view() ?? null;
    // The Umm al-Qura date of the day shown (looked up once a day of the clock); none over an experiment.
    const day = Math.floor(v.unixMs / 86_400_000);
    if (day !== hijriDay) {
      hijriDay = day;
      hijri = hijriDate(v.unixMs);
    }
    v.time.hijri = lab?.active ? null : hijri;
    v.islamic = lab?.active ? null : (islamic?.view() ?? null);
    const walkView = walk?.view() ?? null;
    // Landed but not yet shown (the glide down, the dip): still landing, as far as anyone looking can tell.
    if (walkView?.state === 'walking' && !walkShown) walkView.state = 'landing';
    if (walkView) {
      walkView.fovDeg = navOut.fov;
      walkView.timeCapped = !timePaused && Math.abs(timeRate) > FOOT_MAX_RATE;
    }
    v.walk = walkView;
    v.walkRefused = walkRefused;
    v.walkWaiting = walkAfterTrip !== null || walkAsked !== null;
    v.walkHere = walkHere;
    v.place = placeBelow;
    v.descent = descent?.view() ?? null;
    v.neighbourhood = hoodShown ? (hood?.view() ?? null) : null;
    v.sound = soundView;
    // The span (TDB), as the UTC dates the clock shows at its ends: the explorer's, or an experiment's (from its
    // fork to LAB_DATE_SPAN_S after it); and a date asked for beyond the tables, waiting for the theories.
    const span = v.lab ? { startJd: v.lab.epochJdTdb, endJd: v.lab.epochJdTdb + LAB_DATE_SPAN_S / SECONDS_PER_DAY } : range;
    v.time.startMs = (tdbToUtc(span.startJd) - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000;
    v.time.endMs = Number.isFinite(span.endJd) ? (tdbToUtc(span.endJd) - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000 : v.time.startMs;
    v.time.pending = !v.lab && pendingDate !== null;
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
    livingView.station = satellites?.station ?? null;
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
    const notes = illustrations();
    worlds?.illustrative(notes);
    v.illustrative = notes;
    v.worlds = worlds?.view(focus) ?? null;
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
    // The detail's share of the sky: its brightest stars (the catalogue is sorted by magnitude).
    if (stars) stars.object.count = Math.min(stars.count, detail.starCount);
    worlds?.setDetail(detail);
    // On foot, the ground's illustrative detail.
    for (const id of WALK_IDS) walks[id]?.setDetail(detail.groundDetail === 'full');
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
  /** The camera for the laboratory's pointer: points to the canvas (client px), canvas points to rays, the view's direction (render frame). */
  const labPointer: LabPointerView = {
    toScreen(rel) {
      const c = ctx;
      if (!c) return null;
      const rect = c.renderer.domElement.getBoundingClientRect();
      // Within the depth range, along the same line from the camera (the same point on the screen).
      const d = Math.hypot(rel.x, rel.y, rel.z);
      const k = d > lens.far * 0.5 ? (lens.far * 0.5) / d : 1;
      const p = projected.set(rel.x * k, rel.y * k, rel.z * k).project(c.camera);
      if (p.z < -1 || p.z > 1) return null;
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    },
    ray(x, y) {
      const c = ctx;
      if (!c) return { x: 0, y: 0, z: -1 };
      const rect = c.renderer.domElement.getBoundingClientRect();
      const v = pointerRay.set(((x - rect.left) / rect.width) * 2 - 1, 1 - ((y - rect.top) / rect.height) * 2, 0.5).unproject(c.camera).sub(c.camera.position).normalize();
      return { x: v.x, y: v.y, z: v.z };
    },
    forward() {
      const c = ctx;
      if (!c) return { x: 0, y: 0, z: -1 };
      const v = pointerRay.set(0, 0, -1).applyQuaternion(c.camera.quaternion);
      return { x: v.x, y: v.y, z: v.z };
    },
  };
  const pointerRay = new Vector3();

  const pick = (clientX: number, clientY: number): FocusId | null => {
    const c = ctx;
    if (!c) return null;
    const rect = c.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // Among the stars: a star under the pointer is flown to.
    if (hoodShown && hood) {
      const star = hood.pick(x, y, rect.width, rect.height);
      if (star) hood.goTo(star);
      return null;
    }
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
    return best ?? worlds?.pick(x, y) ?? null;
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
  const placeDirection = (sys: SolarSystem, latDeg: number, lonDeg: number, out: Km, id: BodyId = 'earth'): Km => {
    const lat = MathUtils.degToRad(latDeg);
    const lon = MathUtils.degToRad(lonDeg);
    // The body's frame: x the prime meridian, y the north pole, east longitude toward -z.
    const bx = Math.cos(lat) * Math.cos(lon);
    const by = Math.sin(lat);
    const bz = -Math.cos(lat) * Math.sin(lon);
    const m = sys.bodies[id].basis;
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

  /** Into or out of the laboratory, as the route asks: in, the explorer's time, imagery and names wait; out, they come back as they were. */
  const applyLab = (): void => {
    if (!system) return;
    if (wantLab && !lab) {
      // The laboratory's own chunk (its engine runs in a worker it starts), loaded the first time it is asked for.
      if (labLoading || !labInputs) return;
      labLoading = true;
      const { planets, moon, physical } = labInputs;
      import('./lab')
        .then(({ createLab }) => {
          labLoading = false;
          // The laboratory seeds from the explorer's ephemeris; kilograms by the Earth's GM over JPL's mass of the Earth.
          const earthMassKg = (planets.bodies.find((b) => b.name === 'Earth')?.physical.massE24Kg ?? 0) * 1e24;
          lab = createLab(createEphemeris(planets, moon, physical), physical, earthMassKg, {}, labShapes, labFigure);
          lab.setPointerView(labPointer);
          root.add(...lab.objects);
          applyLab();
        })
        .catch(() => {
          // Its code did not arrive (offline, a new deployment): asking again tries again.
          labLoading = false;
        });
      return;
    }
    if (!lab) return;
    if (wantLab && !lab.active) {
      beforeLab = { rate: timeRate, paused: timePaused, jdTdb, jdUtc, imagery: earthTiles?.mode ?? 'clear', markers: markerSet };
      // The day's imagery is a record of the real Earth's weather: an experiment's Earth shows only its cloud-free map.
      earthTiles?.setMode('clear');
      markerSet = null;
      lab.start('solar', jdTdb);
      lab.setRun(86_400, false);
      if (pendingShare) {
        lab.command({ kind: 'importShared', data: pendingShare });
        pendingShare = null;
      }
    } else if (!wantLab && lab.active) {
      lab.stop();
      hiddenBodies.clear();
      if (beforeLab) {
        timeRate = beforeLab.rate;
        timePaused = beforeLab.paused;
        jdTdb = beforeLab.jdTdb;
        jdUtc = beforeLab.jdUtc;
        earthTiles?.setMode(beforeLab.imagery);
        markerSet = beforeLab.markers;
      }
      beforeLab = null;
    }
  };

  /** Whether a point on the Earth (degrees) is near enough to Makkah that the view keeps its distance (MAKKAH_FRAME). */
  const nearMakkah = (sys: SolarSystem, lat: number, lon: number): boolean => {
    const makkah = site('mecca');
    return makkah !== undefined && centralAngle(lat, lon, makkah.lat, makkah.lon) * sys.specs.earth.radiusKm < MAKKAH_FRAME.radiusKm;
  };

  /**
   * Starts a walk at a place on a world (the Earth, the Moon or Mars): on the Earth refused within
   * Makkah's framing radius (no view comes that close, on foot least of all). Each world's walk is
   * made the first time it is asked for (the walk's own chunk, and for the Moon and Mars their heights'
   * list, public/assets/walk/heights.json); a walk under way on another world ends first.
   */
  const startWalk = (on: WalkWorld, lat: number, lon: number, headingDeg = 0, pitchDeg = 0): void => {
    const sys = system;
    const c = ctx;
    if (!sys || !c || lab?.active) return;
    walkRefused = on === 'earth' && nearMakkah(sys, lat, lon);
    if (walkRefused) return;
    // During a trip the walk waits for the arrival (a trip ends a walk under way).
    if (nav.travelling) {
      walkAfterTrip = { on, lat, lon, headingDeg, pitchDeg };
      return;
    }
    if (walk?.active && walkWorld !== on) endWalk(true);
    walkFov = WALK_FOV;
    // Asked for again while dipping out of a walk on this world, before the dark: the dip turns back in.
    if (walkDip && !walkDip.into && !walkDip.switched && walkWorld === on) walkDip.into = true;
    walkAsked = { on, lat, lon, headingDeg, pitchDeg };
    // The descent: with the world in view, the camera glides down over the place to the lowest orbit
    // while the ground loads (at once with reduced motion); the walk is dipped into once both are done.
    if (world && nav.focus === on && !walkShown && !descentShown) {
      const p = placed[on];
      if (!walkReturn && p.distance > 0) walkReturn = { body: on, dir: km(-p.rel.x / p.distance, -p.rel.y / p.distance, -p.rel.z / p.distance), altitudeKm: p.distance - sys.specs[on].radiusKm };
      nav.glideTo(world, placeDirection(sys, lat, lon, km(), on), sys.specs[on].minAltitudeKm, DEFAULT_FOV);
    }
    const ready = walks[on];
    if (ready) {
      walk = ready;
      walkWorld = on;
      ready.start(lat, lon, MathUtils.degToRad(headingDeg), MathUtils.degToRad(pitchDeg));
      walkAsked = null;
      return;
    }
    if (walkLoading || !bodies || !labInputs) return;
    walkLoading = true;
    const physical = labInputs.physical;
    const key = WALK_KEYS[on];
    const radii = physical.bodies[key].radiiKm;
    const meanRadiusKm = (radii[0] + radii[1] + radii[2]) / 3;
    // Surface gravity from the world's GM (DE440) at its mean radius (NAIF): the Earth's 9.820 m/s^2, the Moon's 1.62, Mars's 3.73, Mercury's 3.70, Venus's 8.87.
    const gravity = (physical.gmKm3S2[key] / (meanRadiusKm * meanRadiusKm)) * 1000;
    const radiusKm = sys.specs[on].radiusKm;
    const b = bodies;
    void Promise.all([import('./walk'), import('./walk/terrain'), import('./walk/equirect'), on === 'earth' ? Promise.resolve(null) : c.assets.json<{ worlds: Record<string, EquirectGrids> }>('assets/walk/heights.json')])
      .then(([{ createWalk }, { terrariumLoader }, { equirectLoader, equirectMaxZoom }, list]) => {
        walkLoading = false;
        const grids = list?.worlds[on];
        const made =
          on === 'earth'
            ? createWalk({
                groundColour: (d) => b.earth.groundColour(d),
                ...(earthAirModel ? { air: earthAirModel } : {}),
                terrain: terrariumLoader((z, x, y) => RELIEF.url(z, x, y, '')),
                forbidden: (la, lo) => nearMakkah(sys, la, lo),
                world: { name: 'earth', radiusKm, gravity, ...walkAir },
              })
            : grids
              ? createWalk({
                  // The globe's own colour (Venus has none to stand on: the walk's illustrative ground).
                  ...(on === 'venus' ? {} : { groundColour: (d: Parameters<typeof b.moon.groundColour>[0]) => (on === 'moon' ? b.moon : on === 'mars' ? b.mars : b.mercury).groundColour(d), albedo: { map: (on === 'moon' ? b.moon : on === 'mars' ? b.mars : b.mercury).albedo(), bond: labFigure(`${on}.bondAlbedo`) ?? 0.15 } }),
                  terrain: equirectLoader(grids, (path) => c.assets.url(path)),
                  maxZoom: equirectMaxZoom(grids),
                  forbidden: () => false,
                  world: { name: on, radiusKm, gravity, surfaceKpa: null, scaleHeightKm: null, meanTempC: null, dayRangeC: null, ...walkFigures[on] },
                })
              : null;
        if (!made) return;
        made.setDetail(detail.groundDetail === 'full');
        walks[on] = made;
        root.add(...made.objects);
        if (walkAsked?.on === on) {
          walk = made;
          walkWorld = on;
          made.start(walkAsked.lat, walkAsked.lon, MathUtils.degToRad(walkAsked.headingDeg), MathUtils.degToRad(walkAsked.pitchDeg));
        }
        walkAsked = null;
      })
      .catch(() => {
        walkLoading = false;
      });
  };
  /**
   * Down through an atmosphere where a probe went (ledger GR-6): the descent made the first time
   * (its chunk and the probe's profile, public/assets/descent), from the top of the probe's column;
   * the picture dips into it. Its altitudes are above Venus's 6,052.0 km radius at the probe's site,
   * or Jupiter's 1-bar level (the drawn ellipsoid's radius at the probe's latitude).
   */
  const startDescent = (on: DescentWorld): void => {
    const sys = system;
    const c = ctx;
    if (!sys || !c || lab?.active) return;
    if (walk?.active) endWalk(true);
    if (descent?.active && descent.world !== on) endDescent(true);
    // Over the place beneath the camera when the world is in view (most often in daylight), else over the probe's own site.
    const below = placeBelow?.body === on ? placeBelow : null;
    const ready = descents[on];
    if (ready) {
      descent = ready;
      ready.start(below?.lat ?? ready.profile.file.site.latDeg, below?.lon ?? ready.profile.file.site.lonDeg);
      return;
    }
    if (descentLoading) return;
    descentLoading = true;
    void Promise.all([import('./descent'), c.assets.json<DescentFile>(`assets/descent/${on}.json`)])
      .then(([{ createDescent }, file]) => {
        descentLoading = false;
        const spec = sys.specs[on];
        const lat = MathUtils.degToRad(file.site.latDeg);
        const base = file.radiusKm ?? (spec.radiusKm * spec.polarKm) / Math.hypot(spec.polarKm * Math.cos(lat), spec.radiusKm * Math.sin(lat));
        const made = createDescent(file, base);
        descents[on] = made;
        root.add(...made.objects);
        descent = made;
        made.start(below?.lat ?? file.site.latDeg, below?.lon ?? file.site.lonDeg);
      })
      .catch(() => {
        descentLoading = false;
      });
  };
  /**
   * Out among the stars (ledger IS-3): the neighbourhood made the first time (its chunk, the stars'
   * file public/assets/stars/neighbourhood.json and the Sun's magnitude and colour from the
   * constants), then the picture dips into it, round the Sun from three parsecs. Not from an
   * experiment; a walk or a descent ends first.
   */
  const startStars = (): void => {
    const c = ctx;
    if (!c || !labInputs || lab?.active || hoodShown || hoodLoading) return;
    if (walk?.active) endWalk(true);
    if (descent?.active) endDescent(true);
    const begin = (made: Neighbourhood): void => {
      made.enter(3);
      hoodDip = { into: true, t: 0, switched: false };
    };
    if (hood) {
      begin(hood);
      return;
    }
    hoodLoading = true;
    const obliquity = obliquityRad(labInputs.physical);
    // Beyond the stars: the Local Group's galaxies with them, the survey's sample (the film's) only when the camera goes that far.
    const loadWeb = async (): Promise<{ manifest: WebManifest; data: ArrayBuffer }> => {
      const manifest = await c.assets.json<WebManifest>('assets/sdss/galaxies.json');
      return { manifest, data: await c.assets.binary(`assets/sdss/${manifest.file}`) };
    };
    void Promise.all([import('./neighbourhood'), c.assets.json<NeighbourhoodFile>('assets/stars/neighbourhood.json'), c.assets.json<LocalGroupFile>('assets/stars/localgroup.json')])
      .then(([{ createNeighbourhood }, file, localGroup]) => {
        hoodLoading = false;
        const made = createNeighbourhood(file, obliquity, { absoluteV: labFigure('sun.absoluteMagnitudeV') ?? Number.NaN, bv: labFigure('sun.colourBV') ?? Number.NaN }, { localGroup, loadWeb, detail: detail.groundDetail });
        hood = made;
        starsRoot.add(...made.objects);
        begin(made);
      })
      .catch(() => {
        hoodLoading = false;
      });
  };
  /** Back to the solar system from the stars: dipped out (at once when `now`). */
  const endStars = (now = false): void => {
    if (!hoodShown) return;
    if (!now) {
      if (!hoodDip || hoodDip.into) hoodDip = { into: false, t: 0, switched: false };
      return;
    }
    hood?.exit();
    hoodShown = false;
    hoodDip = null;
    root.visible = true;
    starsRoot.visible = false;
  };

  /** Back to orbit from a descent: dipped out of one that is shown, at once otherwise (or when `now`). */
  const endDescent = (now = false): void => {
    descentPad.climb = 0;
    if (descent?.active || descentDip) escapeHeld = performance.now() + 1000;
    if (descentShown && !now) {
      if (!descentDip || descentDip.into) descentDip = { into: false, t: 0, switched: false };
      return;
    }
    descent?.stop();
    descent = null;
    descentShown = false;
    descentDip = null;
  };

  /** Back to orbit: dipped out of a walk that is shown, at once otherwise (or when `now`). */
  const endWalk = (now = false): void => {
    // Esc held a second after a walk that was asked for or under way (not after a call with none).
    if (walk?.active || walkAsked || walkDip) escapeHeld = performance.now() + 1000;
    walkAsked = null;
    walkAfterTrip = null;
    for (const k of ['forward', 'right', 'turn', 'tip'] as const) walkInput[k] = 0;
    walkInput.run = false;
    walkInput.rover = false;
    walkInput.jump = false;
    Object.assign(walkPad, { forward: 0, right: 0, run: false, rover: false, jump: false });
    if (document.pointerLockElement) document.exitPointerLock();
    // A dip into the walk not yet at its darkest turns back out there (the picture never jumps).
    if (!now && walkDip && !walkDip.switched) {
      walkDip.into = false;
      return;
    }
    if (walkShown && !now) {
      if (!walkDip || walkDip.into) walkDip = { into: false, t: 0, switched: false };
      return;
    }
    walk?.stop();
    walkShown = false;
    walkDip = null;
    walkReturn = null;
  };

  /**
   * Goes to a saved view (ledger GR-4): over a place on a body (degrees) at a height (km), gliding
   * there on the body in view, after a trip to it from elsewhere. (On the Earth no height a view can
   * have frames Makkah narrower than MAKKAH_FRAME: the lowest orbit, 150 km, already spans more.)
   */
  const goToView = (body: BodyId, lat: number, lon: number, altitudeKm: number): void => {
    if (!world || !system || !entered) return;
    if (walk?.active) endWalk(true);
    if (nav.focus !== body || nav.busy) {
      if (nav.focus !== body) nav.flyTo(world, body);
      pendingView = { body, lat, lon, altitudeKm };
      return;
    }
    nav.glideTo(world, placeDirection(system, lat, lon, km(), body), altitudeKm, DEFAULT_FOV);
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
    const { altitudeKm, lensDeg } = framing(nearMakkah(system, lat, lon) ? Math.max(viewKm, MAKKAH_FRAME.minWidthKm) : viewKm);
    nav.glideTo(world, placeDirection(system, lat, lon, km()), altitudeKm, lensDeg);
  };

  /** Where the Sun is overhead on the Earth now (degrees): its direction (living.sun) in the Earth's own frame. */
  const subSolar = (sys: SolarSystem): { lat: number; lon: number } => {
    const m = sys.bodies.earth.basis;
    const s = living.sun;
    const bx = s.x * (m[0] ?? 1) + s.y * (m[1] ?? 0) + s.z * (m[2] ?? 0);
    const by = s.x * (m[3] ?? 0) + s.y * (m[4] ?? 1) + s.z * (m[5] ?? 0);
    const bz = s.x * (m[6] ?? 0) + s.y * (m[7] ?? 0) + s.z * (m[8] ?? 1);
    const r = Math.max(Math.hypot(bx, by, bz), 1e-12);
    return { lat: MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, by / r)))), lon: MathUtils.radToDeg(Math.atan2(-bz, bx)) };
  };

  const markerAt = km();
  const markerSpots: Array<[number, number, number]> = [];
  /**
   * The field notes' places named on the ground (the set the interface chose): each on the Earth's
   * side facing the camera, and kept MARKER_SPACING_PX from those before it in its list, eased in and
   * out (a name never pops).
   */
  const pushMarkers = (sys: SolarSystem, show: boolean, pxPerTan: number): void => {
    const list: readonly FieldPlace[] = markerSet === 'atlas' ? ATLAS : markerSet === 'prophets' ? SITES : [];
    const radius = sys.specs.earth.radiusKm * 1.0005;
    const e = placed.earth.drawn;
    markerSpots.length = 0;
    const wanted = new Set<string>();
    for (const p of list) {
      if (!show) break;
      const n = placeDirection(sys, p.lat, p.lon, markerAt);
      const x = e.x + n.x * radius;
      const y = e.y + n.y * radius;
      const z = e.z + n.z * radius;
      // Facing the camera (at the origin): the ground's normal points back toward it.
      if (n.x * x + n.y * y + n.z * z > 0) continue;
      const d = Math.max(Math.hypot(x, y, z), 1e-9);
      if (markerSpots.some(([qx, qy, qz]) => (Math.hypot(qx - x, qy - y, qz - z) / d) * pxPerTan < MARKER_SPACING_PX)) continue;
      markerSpots.push([x, y, z]);
      wanted.add(p.id);
    }
    for (const p of [...ATLAS, ...SITES]) {
      const target = wanted.has(p.id) ? 1 : 0;
      const fade = (markerFade.get(p.id) ?? 0) + (target - (markerFade.get(p.id) ?? 0)) * MARKER_EASE;
      if (fade < 0.01 && target === 0) {
        markerFade.delete(p.id);
        continue;
      }
      markerFade.set(p.id, fade);
      const n = placeDirection(sys, p.lat, p.lon, markerAt);
      const textKey = ATLAS.includes(p) ? `ui.universe.field.atlas.${p.id}.name` : `ui.universe.field.site.${p.id}`;
      labels.push({ id: `field-${p.id}`, textKey, position: [e.x + n.x * radius, e.y + n.y * radius, e.z + n.z * radius], opacity: 0.92 * fade, offset: [0, -14] });
    }
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
    shownFor += dt;
    // How far the clock moves this frame (days; a jump, a cut, is not a movement), for the hold of the worlds' turn.
    let days = jdTdb;
    if (lab?.active) {
      // The experiment's clock as drawn (its epoch plus the simulated time: ./lab-clock), with no data span to keep to.
      const cut = lab.tick(performance.now());
      const jd = lab.jdTdb();
      clockRate = lab.paused ? 0 : lab.rate;
      jdUtc += jd - jdTdb;
      jdTdb = jd;
      if (cut) days = jd;
    } else {
      // The time machine: the clock at its rate, held to real time during a trip (not the arrival's glide,
      // which follows its own world) and to FOOT_MAX_RATE on foot or on the way down, kept in the span.
      clockRate = timePaused ? 0 : heldRate(timeRate, clockHold());
      const clock = advanceClock(jdTdb, dt, clockRate, range.startJd, range.endJd);
      jdUtc += clock.jd - jdTdb;
      jdTdb = clock.jd;
      if (clock.edge) {
        timePaused = true;
        timeEdge = clock.edge;
      }
    }
    days = jdTdb - days;
    if (shownFor > 3 || clockRate < 0 || clockRate >= 86_400 || Math.abs(days) > 0.02 || jdTdb - range.startJd < 120 || range.endJd - jdTdb < 120) loadTheories();
    sys.update(jdTdb);
    worlds?.advance(jdTdb);
    if (!worlds && !worldsLoading && shownFor > worldsAt) loadWorlds();
    // Among the stars: the dip into or out of them, and then their own scene and camera instead of the solar system's.
    hoodVeil = 1;
    const hdip = hoodDip;
    let hoodCut = false;
    if (hdip) {
      hdip.t += dt;
      if (!hdip.switched && hdip.t >= WALK_DIP.downS) {
        hdip.switched = true;
        hoodCut = true;
        hoodShown = hdip.into;
        if (!hdip.into) hood?.exit();
        root.visible = !hoodShown;
        starsRoot.visible = hoodShown;
      }
      hoodVeil = hdip.switched ? smoothstep(0, 1, (hdip.t - WALK_DIP.downS) / WALK_DIP.upS) : 1 - smoothstep(0, 1, hdip.t / WALK_DIP.downS);
      if (hdip.t >= WALK_DIP.downS + WALK_DIP.upS) hoodDip = null;
    }
    if (hoodShown && hood) {
      const camera = c.camera;
      // Points beyond the stars are sized in device pixels from their distance: the screen's focal length.
      const focalPx = (c.renderer.domElement.clientHeight * c.renderer.getPixelRatio()) / (2 * Math.tan(MathUtils.degToRad((lensFov ?? DEFAULT_FOV) / 2)));
      const pose = hood.update(dt, jdTdb - 2451545, camera, focalPx);
      camera.position.set(0, 0, 0);
      target.set(...pose.forward);
      up.set(...pose.up);
      look.lookAt(eye, target, up);
      camera.quaternion.setFromRotationMatrix(look);
      camera.up.copy(up);
      camera.near = pose.near;
      camera.far = pose.far;
      camera.fov = lensFov ?? DEFAULT_FOV;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      c.exposure.setTarget(1);
      c.exposure.setVeil(hoodVeil);
      adaptation.setTarget(1);
      if (hoodCut) {
        c.exposure.jump();
        adaptation.jump();
      }
      adaptation.update(dt);
      labels.length = 0;
      hood.labels(labels);
      refreshView();
      entering = false;
      return;
    }
    // In the laboratory the experiment puts the worlds where it has them (their turn still the IAU models').
    if (lab?.active) {
      lab.applyBuiltIns(sys, hiddenBodies);
      const refocus = lab.takeRefocus();
      if (refocus && !hiddenBodies.has(refocus)) nav.flyTo(world, refocus);
      // A laboratory of its own (two or three bodies, none of them the worlds): the view goes to its star, at the Sun's place, never to a world it lacks.
      else if ((hiddenBodies.has(nav.focus as BodyId) || nav.focus !== host(nav.focus)) && nav.focus !== 'sun' && !nav.busy) nav.flyTo(world, 'sun');
    }
    // Too fast to show a world turning: held at an hour of its day (./time-beyond), let go only as the clock runs on its own (not paused, not a trip).
    spinHold?.update(sys, days, dt, clockRate !== 0 && (lab?.active === true || !nav.travelling), c.reducedMotion);
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
    // Photo mode's tracking (ledger CR-2): the view turned about the focus by the body's own motion round
    // it since the last frame, so it keeps its place in the frame; while it does, the Earth's spin is not followed.
    if (tracking && tracking !== nav.focus && !nav.busy && nav.mode === 'orbit') {
      const f = world.body(nav.focus).position;
      const t = sys.bodies[tracking].position;
      const len = Math.hypot(t.x - f.x, t.y - f.y, t.z - f.z) || 1;
      const nx = (t.x - f.x) / len;
      const ny = (t.y - f.y) / len;
      const nz = (t.z - f.z) / len;
      if (trackKnown) {
        const cx = trackDir.y * nz - trackDir.z * ny;
        const cy = trackDir.z * nx - trackDir.x * nz;
        const cz = trackDir.x * ny - trackDir.y * nx;
        const sin = Math.hypot(cx, cy, cz);
        if (sin > 1e-12) nav.turnAbout(km(cx / sin, cy / sin, cz / sin), Math.atan2(sin, trackDir.x * nx + trackDir.y * ny + trackDir.z * nz));
      }
      trackDir.x = nx;
      trackDir.y = ny;
      trackDir.z = nz;
      trackKnown = true;
    } else trackKnown = false;
    if (!tracking && earthMeridianKnown && nav.focus === 'earth' && (placeLock || nav.lensActive || nav.gliding)) {
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
    if (walkAfterTrip) {
      // A walk waiting for a trip goes where the trip goes: dropped once the trip turns elsewhere
      // (another world chosen, a place flown to, a stop) or ends at another world.
      const to = nav.tripState?.to ?? nav.focus;
      const p = walkAfterTrip;
      if (to !== p.on || !nav.travelling) walkAfterTrip = null;
      if (to === p.on && !nav.travelling) startWalk(p.on, p.lat, p.lon, p.headingDeg, p.pitchDeg);
    }
    if (pendingView && nav.focus === pendingView.body && !nav.busy) {
      const p = pendingView;
      pendingView = null;
      goToView(p.body, p.lat, p.lon, p.altitudeKm);
    }
    if (placeLock && (nav.focus !== 'earth' || (!nav.lensActive && !nav.gliding && placed.earth.distance - sys.specs.earth.radiusKm > PLACE_LOCK_KM))) placeLock = false;
    nav.placeView = placeLock;

    // The camera, in doubles; then everything relative to it.
    nav.update(world, dt, navOut);
    // On foot, the walker's eye replaces the navigator's camera (which keeps its own place for the way
    // back); a trip elsewhere (a world chosen, a place flown to) ends the walk.
    if (walk?.active && nav.travelling && !walkDip) endWalk();
    if (descent?.active && nav.travelling && !descentDip) endDescent();
    walking = false;
    /** An eye's pose in a world's own frame (km from its centre) put in place of the navigator's camera. */
    const eyeAt = (pose: { position: readonly number[]; forward: readonly number[]; up: readonly number[] }, id: BodyId, fov: number): void => {
      const m = sys.bodies[id].basis;
      const e = sys.bodies[id].position;
      const toRender = (v: readonly number[], out: Km, from: Km | null): void => {
        out.x = (from?.x ?? 0) + (v[0] ?? 0) * (m[0] ?? 1) + (v[1] ?? 0) * (m[3] ?? 0) + (v[2] ?? 0) * (m[6] ?? 0);
        out.y = (from?.y ?? 0) + (v[0] ?? 0) * (m[1] ?? 0) + (v[1] ?? 0) * (m[4] ?? 1) + (v[2] ?? 0) * (m[7] ?? 0);
        out.z = (from?.z ?? 0) + (v[0] ?? 0) * (m[2] ?? 0) + (v[1] ?? 0) * (m[5] ?? 0) + (v[2] ?? 0) * (m[8] ?? 1);
      };
      toRender(pose.position, navOut.position, e);
      toRender(pose.forward, navOut.forward, null);
      toRender(pose.up, navOut.up, null);
      navOut.fov = fov;
    };
    // The dip into or out of a walk: dark, the switch while it is dark, light again.
    walkVeil = 1;
    walkCut = false;
    const dip = walkDip;
    // A dip, or the climb back after one, still holds Esc (as a descent's dip does).
    if (dip || descentDip || (walkClimb && nav.gliding)) escapeHeld = performance.now() + 1000;
    else walkClimb = false;
    if (dip) {
      dip.t += dt;
      if (!dip.switched && dip.t >= WALK_DIP.downS) {
        dip.switched = true;
        walkCut = true;
        if (dip.into) {
          walkShown = true;
          // Landed from a descent (Venus's): the descent ends as the walk shows.
          if (descent) endDescent(true);
        } else {
          walk?.stop();
          walkShown = false;
          // Back up to the orbit the descent left (unless a trip has taken the camera elsewhere).
          const back = walkReturn;
          walkReturn = null;
          if (back && nav.focus === back.body && !nav.travelling) {
            nav.glideTo(world, back.dir, back.altitudeKm, DEFAULT_FOV);
            walkClimb = true;
          }
        }
      }
      walkVeil = dip.switched ? smoothstep(0, 1, (dip.t - WALK_DIP.downS) / WALK_DIP.upS) : 1 - smoothstep(0, 1, dip.t / WALK_DIP.downS);
      if (dip.t >= WALK_DIP.downS + WALK_DIP.upS) walkDip = null;
    }
    if (walk?.active) {
      Object.assign(walkStep, walkInput);
      walkStep.forward = Math.max(-1, Math.min(1, walkInput.forward + walkPad.forward));
      walkStep.right = Math.max(-1, Math.min(1, walkInput.right + walkPad.right));
      walkStep.turn = Math.max(-1, Math.min(1, walkInput.turn + walkTurnKeys));
      walkStep.run = walkInput.run || walkPad.run;
      walkStep.rover = walkInput.rover === true || walkPad.rover;
      walkStep.jump = walkInput.jump || walkPad.jump;
      // On foot, Esc is the walk's: the climb back to orbit counts as on foot.
      escapeHeld = performance.now() + 1000;
      const pose = walk.step(dt, walkStep);
      // Landed: once any glide down has ended, the picture dips into the walk.
      if (pose && !walkShown && !walkDip && !nav.gliding) walkDip = { into: true, t: 0, switched: false };
      if (pose && walkShown) {
        walking = true;
        // Never narrower near Makkah than its framing rule allows (MAKKAH_FRAME: 30 km across, from 25 km or more).
        const at = walkWorld === 'earth' ? walk.where() : null;
        const makkah = at ? site('mecca') : undefined;
        const kaabaKm = at && makkah ? centralAngle(at.lat, at.lon, makkah.lat, makkah.lon) * sys.specs.earth.radiusKm : Infinity;
        eyeAt(pose, walkWorld, Math.max(walkFov, MathUtils.radToDeg(2 * Math.atan(MAKKAH_FRAME.minWidthKm / 2 / kaabaKm))));
      }
    }
    // Down through an atmosphere: its dip, then its eye in place of the navigator's.
    descending = false;
    descentVeil = 1;
    const ddip = descentDip;
    if (ddip) {
      ddip.t += dt;
      if (!ddip.switched && ddip.t >= WALK_DIP.downS) {
        ddip.switched = true;
        walkCut = true;
        if (ddip.into) descentShown = true;
        else {
          descent?.stop();
          descent = null;
          descentShown = false;
        }
      }
      descentVeil = ddip.switched ? smoothstep(0, 1, (ddip.t - WALK_DIP.downS) / WALK_DIP.upS) : 1 - smoothstep(0, 1, ddip.t / WALK_DIP.downS);
      if (ddip.t >= WALK_DIP.downS + WALK_DIP.upS) descentDip = null;
    }
    if (descent?.active && !walking) {
      const climb = Math.max(-1, Math.min(1, walkInput.forward + descentPad.climb));
      const pose = descent.step(dt, climb, walkInput.run);
      if (pose && !descentShown && !descentDip) descentDip = { into: true, t: 0, switched: false };
      if (pose && descentShown) {
        descending = true;
        eyeAt(pose, descent.world, WALK_FOV);
        // On Venus, at the bottom of the probe's column: the walk lands where the probe did.
        const v = descent.view();
        if (v?.atBottom && descent.world === 'venus' && !walk?.active && !walkAsked) startWalk('venus', v.hereLatDeg, v.hereLonDeg);
      }
    }
    // Mouse-look lasts only while an eye is shown on foot or on the way down.
    if (!walking && !descending && document.pointerLockElement === c.renderer.domElement) document.exitPointerLock();
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
    nearestKm = Math.min(nearestAltitude(spheres), worlds?.nearestKm(origin.camera) ?? Infinity);
    lensFor(nearestKm, lens);
    if (walking || descending) {
      lens.near = WALK_LENS.near;
      lens.far = WALK_LENS.far;
    }

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
    // Photo mode's lens, when chosen, in place of the explorer's own framing (ledger CR-2).
    const fov = lensFov ?? navOut.fov;
    const tanHalf = Math.tan(MathUtils.degToRad(fov / 2));
    const pxPerTan = viewportPx / (2 * tanHalf);
    const settle = entering || walkCut ? 1 : 1 - Math.exp(-Math.max(0, dt) / INSET_SECONDS);
    // On foot the eye looks exactly where it faces: a turn about its tipped axes would tilt the horizon.
    const eyeLevel = walking || descending;
    offsetPx += ((eyeLevel ? 0 : (insets.bottom - insets.top) / 2) - offsetPx) * settle;
    offsetXPx += ((eyeLevel ? 0 : (insets.right - insets.left) / 2) - offsetXPx) * settle;
    if (!eyeLevel) {
      camera.rotateX(-Math.atan(offsetPx / pxPerTan));
      camera.rotateY(-Math.atan(offsetXPx / pxPerTan));
    }
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
    c.exposure.setVeil(navOut.dim * walkVeil * descentVeil * hoodVeil);
    adaptation.setTarget(exposure);
    if (navOut.cut || walkCut || hoodCut) {
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
      // On foot, the ground under the walker stands in for the globe.
      object.visible = !hiddenBodies.has(id) && !(walking && id === walkWorld) && !(descending && id === descent?.world);
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
    // On foot, the Sun through the air the walker looks through (its disc and its glare).
    if (walking && walk) walk.sunColour(sunTint);
    bodies.sun.update({
      time: ambient,
      kelvin: SUN_KELVIN,
      // Under Venus's clouds no Sun is seen (no light: the disc is not drawn).
      light: (walking && walk?.skySeen === false ? 0 : sunDisplay / adapted) * (descending ? (descent?.sunSeen() ?? 1) : 1),
      exposure: adapted,
      filter: filterColor,
      tint: walking ? sunTint : undefined,
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
      // On foot, aimed where the walker stands (looking along the ground, the view's centre may miss the globe).
      const standing = walking && walkWorld === 'earth' ? (walk?.where() ?? null) : null;
      const aim =
        entering || stretch.amount < 1 || hiddenBodies.has('earth')
          ? null
          : standing
            ? { lat: MathUtils.degToRad(standing.lat), lon: MathUtils.degToRad(standing.lon), footprint: WALK_FOOTPRINT_KM / sys.specs.earth.radiusKm }
            : earthAim(sys, scenePxPerTan);
      earthTiles.update(aim, dt, c.reducedMotion);
      // How far the lens may narrow: the day mosaic stops at 250 m per pixel, and over Makkah the
      // view stays wide enough to frame the city in its valley (MAKKAH_FRAME), never closer.
      let lensMin = earthTiles.mode === 'today' ? TODAY_LENS_MIN_DEG : ZOOM_LENS.minDeg;
      if (aim && nav.focus === 'earth' && nearMakkah(sys, MathUtils.radToDeg(aim.lat), MathUtils.radToDeg(aim.lon))) {
        const above = Math.max(1, placed.earth.distance - sys.specs.earth.radiusKm);
        lensMin = Math.max(lensMin, MathUtils.radToDeg(2 * Math.atan(MAKKAH_FRAME.minWidthKm / 2 / above)));
      }
      if (lensMin !== nav.lensMinDeg) nav.setLensMin(lensMin);
    }
    // The laboratory's craters and climates on the worlds drawn solid (none outside an experiment).
    for (const id of CRATERED) {
      bodies.setMarks(id, lab?.active ? lab.marks(id) : NO_MARKS);
      bodies.setClimate(id, lab?.active ? lab.climateBands(id) : null, lab?.climateView ?? false);
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
    // A world the experiment does not have (merged, removed, or a laboratory of its own) is not drawn, lit or not.
    for (const id of hiddenBodies) bodies.objects[id].visible = false;
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
    // On foot by day, the sky hides the stars (and through twilight lets them through).
    const starlight = walking ? (walk?.starlight() ?? 1) : descending ? (descent?.starlight() ?? 1) : 1;
    stars.setLight(STARS.light * adapted ** (STARS.follow - 1) * starlight);
    stars.update(dt);

    // Orbit lines: the focus's own (and the Moon's around the Earth) up close, the rest as the view
    // widens; each only from where it reads as an orbit; none over the Sun seen through its filter.
    const focus = world.body(nav.focus);
    const focusKm = Math.hypot(focus.position.x - origin.camera.x, focus.position.y - origin.camera.y, focus.position.z - origin.camera.z);
    const wide = nav.focus === 'sun' ? SUN_ORBITS_WIDE : ORBITS_WIDE;
    const wideness = smoothstep(Math.log(wide.from * focus.boundKm), Math.log(wide.to * focus.boundKm), Math.log(Math.max(focusKm, 1)));
    const orbitSettle = dt > 0 ? 1 - Math.exp(-dt / ORBITS_WIDE.seconds) : 0;
    orbitPaths.forEach((path, i) => {
      const own = path.body === nav.focus || (path.body === 'moon' && nav.focus === 'earth');
      const size = path.sizeKm;
      const nearBody = smoothstep(ORBIT_NEAR_BODY.from * size, ORBIT_NEAR_BODY.to * size, placed[path.body].distance);
      const fromCentre = Math.hypot(path.centre.x - origin.camera.x, path.centre.y - origin.camera.y, path.centre.z - origin.camera.z);
      const outside = smoothstep(ORBIT_INSIDE.from * size, ORBIT_INSIDE.to * size, fromCentre);
      // The worlds' real orbits are the ephemeris's: not drawn over an experiment (its trails are).
      const want = lab?.active || walking || descending ? 0 : (own ? 1 : wideness) * nearBody * outside * (1 - filterAmount);
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
      focus: focus.position,
      focusRadius: focus.radiusKm,
      focusDistance: focusKm,
      compensation: adapted,
      light: 1 + TRIP_ORBIT_GLOW * tripGlow,
      ...(stretch.amount < 1 ? { warp: warpOrbitPoint } : {}),
    });

    // Labels first: the ring markers of small bodies come and go with their tags.
    updateLabels(dt, viewportPx, widthPx);

    // Names on the sky (the brightest stars', the constellations'), when shown; and the worlds'.
    stars.labels(labels);
    worlds?.labels(labels);

    // The experiment's trails, prediction and new bodies (with their names).
    if (lab?.active) {
      lab.update(
        { camera: origin.camera, forward, near: lens.near, far: lens.far, pxPerTan, focus: focus.position, focusRadius: focus.radiusKm, focusDistance: focusKm, compensation: adapted },
        (abs, out) => origin.relative(abs, out),
      );
      const from = labels.length;
      lab.labels(labels);
      declutterLab(from, dt, viewportPx, widthPx);
    } else if (labSeen.size > 0) {
      labSeen.clear();
      labFade.clear();
      labPlace.clear();
      labShown.length = 0;
    }

    // The point beneath the camera when near the Earth: the direction from its centre to the camera (at the origin), in its own frame.
    {
      const pe = placed.earth;
      const near = pe.k > 0.999 && pe.distance < LIVING_RANGE_KM && !lab?.active;
      const m = sys.bodies.earth.basis;
      const dx = -pe.drawn.x;
      const dy = -pe.drawn.y;
      const dz = -pe.drawn.z;
      const bx = dx * (m[0] ?? 1) + dy * (m[1] ?? 0) + dz * (m[2] ?? 0);
      const by = dx * (m[3] ?? 0) + dy * (m[4] ?? 1) + dz * (m[5] ?? 0);
      const bz = dx * (m[6] ?? 0) + dy * (m[7] ?? 0) + dz * (m[8] ?? 1);
      const r = Math.hypot(bx, by, bz);
      belowEarth = near && r > 0 ? { lat: MathUtils.radToDeg(Math.asin(by / r)), lon: MathUtils.radToDeg(Math.atan2(-bz, bx)) } : null;
      // The qibla and the new moon: their marks turn with the Earth (near it, at true scale, never over an experiment or on foot).
      if (islamic) {
        islamic.update({ jdUtc, earth: pe.drawn, basis: m, earthRadiusKm: sys.specs.earth.radiusKm, visible: near && !walking && !descending, below: belowEarth });
        if (!walking && !descending) islamic.labels(labels);
      }
    }
    // Where a walk would begin: beneath the camera on the world in view, when there is ground to walk
    // on there and it is drawn at its true size (the direction from its centre to the camera, at the
    // origin, in its own frame).
    {
      // (A world flown to has neither: its host's place is not beneath the camera.)
      const id = host(nav.focus);
      const p = placed[id];
      // The place beneath the camera on any body in view, at its true size (for saving the view).
      if (!lab?.active && !nav.travelling && p.k > 0.999 && grow[id] === 1 && id === nav.focus) {
        const m = sys.bodies[id].basis;
        const bx = -p.drawn.x * (m[0] ?? 1) - p.drawn.y * (m[1] ?? 0) - p.drawn.z * (m[2] ?? 0);
        const by = -p.drawn.x * (m[3] ?? 0) - p.drawn.y * (m[4] ?? 1) - p.drawn.z * (m[5] ?? 0);
        const bz = -p.drawn.x * (m[6] ?? 0) - p.drawn.y * (m[7] ?? 0) - p.drawn.z * (m[8] ?? 1);
        const r = Math.hypot(bx, by, bz);
        placeBelow = r > 0 ? { body: id, lat: MathUtils.radToDeg(Math.asin(by / r)), lon: MathUtils.radToDeg(Math.atan2(-bz, bx)), altitudeKm: r - sys.specs[id].radiusKm } : null;
      } else placeBelow = null;
      if (walkable(id) && id === nav.focus && !lab?.active && p.k > 0.999 && grow[id] === 1) {
        const m = sys.bodies[id].basis;
        const dx = -p.drawn.x;
        const dy = -p.drawn.y;
        const dz = -p.drawn.z;
        const bx = dx * (m[0] ?? 1) + dy * (m[1] ?? 0) + dz * (m[2] ?? 0);
        const by = dx * (m[3] ?? 0) + dy * (m[4] ?? 1) + dz * (m[5] ?? 0);
        const bz = dx * (m[6] ?? 0) + dy * (m[7] ?? 0) + dz * (m[8] ?? 1);
        const r = Math.hypot(bx, by, bz);
        walkHere = r > 0 ? { world: id, lat: MathUtils.radToDeg(Math.asin(by / r)), lon: MathUtils.radToDeg(Math.atan2(-bz, bx)) } : null;
      } else walkHere = null;
    }
    // On foot: the ground and the sky, placed about the camera; the Sun's direction from the world, in
    // the render frame and the world's own (the longitude beneath the Sun from it: atan2(-z, x), the
    // mesh frame's), at true scale (the walk's far plane puts the world in scaled space, which the
    // ground does not use).
    if (descent?.active) {
      unit(scratch, sys.bodies[descent.world].position, sys.bodies.sun.position);
      descent.place({ basis: sys.bodies[descent.world].basis, sun: { x: scratch.x, y: scratch.y, z: scratch.z }, light: lightAt(descent.world), far: lens.far });
    }
    if (walk?.active) {
      const m = sys.bodies[walkWorld].basis;
      unit(scratch, sys.bodies[walkWorld].position, sys.bodies.sun.position);
      const sunWorld: [number, number, number] = [scratch.x * (m[0] ?? 1) + scratch.y * (m[1] ?? 0) + scratch.z * (m[2] ?? 0), scratch.x * (m[3] ?? 0) + scratch.y * (m[4] ?? 1) + scratch.z * (m[5] ?? 0), scratch.x * (m[6] ?? 0) + scratch.y * (m[7] ?? 0) + scratch.z * (m[8] ?? 1)];
      const subSolarLon = MathUtils.radToDeg(Math.atan2(-sunWorld[2], sunWorld[0]));
      walk.place({ centre: placed[walkWorld].rel, basis: m, sun: { x: scratch.x, y: scratch.y, z: scratch.z }, sunWorld, light: lightAt(walkWorld), subSolarLon, near: lens.near, far: lens.far, exposure: adapted, renderer: c.renderer, camera, eye: walking });
    }

    // The Living Earth's live layers, placed with the Earth (only near it: drawn at true scale).
    if (satellites || quakes) {
      const pe = placed.earth;
      const near = pe.k > 0.999 && pe.distance < LIVING_RANGE_KM;
      living.earth.x = pe.drawn.x;
      living.earth.y = pe.drawn.y;
      living.earth.z = pe.drawn.z;
      // From the Earth toward the Sun (the satellites' shadow and the point beneath the Sun both read it that way).
      unit(scratch, sys.bodies.earth.position, sun);
      living.sun.x = scratch.x;
      living.sun.y = scratch.y;
      living.sun.z = scratch.z;
      const unixMs = (jdUtc - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000;
      // Observations of the real Earth are not shown around an experiment's (its Earth may not be ours).
      const real = !lab?.active && !walking;
      satellites?.update({ unixMs, earth: living.earth, basis: sys.bodies.earth.basis, sun: living.sun, earthRadiusKm: sys.specs.earth.radiusKm, visible: real && near && Math.abs(clockRate) <= SATELLITE_MAX_RATE });
      quakes?.update({ unixMs, earth: living.earth, basis: sys.bodies.earth.basis, earthRadiusKm: sys.specs.earth.radiusKm, visible: real && near && Math.abs(unixMs - Date.now()) < QUAKES_WITHIN_MS, time: ambient, reducedMotion: c.reducedMotion });
      if (satellites) for (const l of satellites.labels()) labels.push(l);
      if (quakes) for (const l of quakes.labels()) labels.push(l);
      pushMarkers(sys, near && pe.distance < MARKER_RANGE_KM && !walking, pxPerTan);
      // The field notes' bulletin, about once a second (its facts change slowly; the places it names, slower).
      bulletinClock += dt;
      if (bulletinClock >= 1 && places.length > 0) {
        bulletinClock = 0;
        livingView.bulletin = composeBulletin({
          sun: subSolar(sys),
          radiusKm: sys.specs.earth.radiusKm,
          places,
          station: satellites?.station ?? null,
          satellites: satellites?.status.state === 'ready' ? { count: satellites.status.count, sunlit: satellites.status.sunlit } : null,
          quakes: quakes?.status.state === 'ready' ? quakes.quakes : null,
        });
      }
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
      dot.opacity = hiddenBodies.has(id) ? 0 : smoothstep(2.8, 1.2, p.radiusPx) * (id === 'sun' ? (walking && walk?.skySeen === false ? 0 : 1) * (descending ? (descent?.sunSeen() ?? 1) : 1) : starlight);
      dot.sizePx = style.sizePx;
      dot.marker = id === 'sun' ? 0 : (labelOpacity.get(id) ?? 0) * smoothstep(LABEL.markerPx, LABEL.markerPx / 2, p.radiusPx) * (1 - filterAmount);
    });
    dots.update(dotList, adapted);
    worlds?.update({ jdTdb, camera: origin.camera, view: camera, far: lens.far, pxPerTan, widthPx, heightPx: viewportPx, compensation: adapted, shown: !lab?.active && !walking && !descending, focus: nav.focus, span: focusKm, dt, dpr: c.renderer.getPixelRatio(), sky: walking || descending ? 0 : 1, placed });

    const sunPlaced = placed.sun;
    // From orbit, the Sun through the Earth's limb (on foot, through the air the walker looks through).
    if (!walking) sunThroughEarth(sunTint);
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
    const id = nav.focus;
    if (!system || !bodies || id !== host(id)) return [];
    const altitude = Math.max(0, placed[host(id)].distance - system.specs[host(id)].radiusKm);
    switch (host(id)) {
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
    input.focus = host(nav.focus);
    input.travelling = nav.travelling;
    input.altitudeKm = v.altitudeKm;
    input.radiusKm = sys.specs[input.focus].radiusKm;
    input.framedAltitudeKm = world ? nav.framingKm(world.body(input.focus)) - input.radiusKm : 0;
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
    // The notes are about the real worlds: none over an experiment.
    discovery = lab?.active || input.focus !== nav.focus ? null : discoveries.update(input);
  };

  /** The data-travel hook: "flying" while a trip is under way, then "arrived" or "stopped". */
  const trackTrips = (): void => {
    const travelling = nav.travelling;
    if (travelling && !wasTravelling) {
      stopped = false;
      const to = world?.body(nav.focus);
      const p = to?.position;
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
    const onFoot = walking || descending;
    const night = walking ? (walk?.starlight() ?? 1) : descending ? (descent?.starlight() ?? 1) : 1;
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
      // On foot the names come out with the stars (none on a daylit sky), and the Sun's never.
      const wanted = inFront && p.radiusPx < LABEL.maxDiscPx && !occluded(id) && !hiddenBodies.has(id) && (!onFoot || (id !== 'sun' && night > 0.05));
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
        // (Above or below the view, it hangs toward the clear view's middle, not the window's: a sheet at the side covers the rest.)
        if (edgeDx === 0) edgeDx = sx < (left + rightEdge) / 2 ? LABEL.pointerPx : -LABEL.pointerPx;
      } else if (form === 'left') {
        // At the left limb, the tag ending a short line to its left.
        projected.set(p.drawn.x, p.drawn.y, p.drawn.z).addScaledVector(right, -drawnRadius).project(camera);
        x = ((projected.x + 1) / 2) * widthPx;
        y = ((1 - projected.y) / 2) * viewportPx;
        edgeDx = -LABEL.gapPx;
        edgeDy = -LABEL.tagPx / 2;
      }
      // A pointer's tag hangs off its line's end (centred on it up and down, to its right or left): all of it
      // inside the clear view, not only its point (where the view is too small for one, as above a phone's
      // sheet held sideways, it gives way).
      const minY = insets.top + LABEL.tagPx / 2 - edgeDy;
      const maxY = viewportPx - insets.bottom - LABEL.tagPx / 2 - edgeDy;
      const minX = insets.left - edgeDx + (edgeDx < 0 ? LABEL.widthPx : 0);
      const maxX = widthPx - insets.right - edgeDx - (edgeDx < 0 ? 0 : LABEL.widthPx);
      if (form === 'edge') {
        y = Math.min(maxY, Math.max(minY, y));
        x = Math.min(maxX, Math.max(minX, x));
      }
      // Clear of what stands over the view inside it (the way back, the readout's card): a pointer at the
      // edge slides along the edge past one; a tag beside its body that would sit under one gives way.
      let under = form === 'edge' && (minY > maxY || minX > maxX);
      if (form !== 'none') {
        const pad = state.blocked ? LABEL.marginPx : 0;
        for (const r of avoid) {
          const bx = offView ? (edgeDx < 0 ? x + edgeDx - LABEL.widthPx : x + edgeDx) : x + LABEL.gapPx;
          const by = offView ? y + edgeDy - LABEL.tagPx / 2 : y - LABEL.tagPx;
          if (bx > r.right + pad || bx + LABEL.widthPx < r.left - pad || by > r.bottom + pad || by + LABEL.tagPx < r.top - pad) continue;
          if (form !== 'edge') under = true;
          else {
            y = r.top < viewportPx / 2 ? r.bottom + LABEL.tagPx / 2 + LABEL.marginPx - edgeDy : r.top - LABEL.tagPx / 2 - LABEL.marginPx - edgeDy;
            if (y < minY || y > maxY) under = true;
          }
        }
      }
      // Its box, for collisions: the tag extends right of its point (or left, for a pointer at the right
      // edge), above its point beside the body, centred on its line's end as a pointer (as the tags are drawn).
      const boxX = offView && edgeDx < 0 ? x + edgeDx - LABEL.widthPx : x + (offView ? edgeDx : LABEL.gapPx);
      const boxY = offView ? y + edgeDy - LABEL.tagPx / 2 : y - LABEL.tagPx;
      const room = state.blocked ? LABEL.clearAgain : 1;
      let blocked = under;
      for (let t = 0; t < takenCount; t++) {
        const other = taken[t];
        if (!other) continue;
        if (Math.abs(other.x - boxX) < LABEL.widthPx * room && Math.abs(other.y - boxY) < LABEL.tagPx * room) blocked = true;
      }
      // The laboratory's chosen body's name and marks keep their place: a world's name gives way to them.
      const spare = state.blocked ? LABEL.marginPx : 0;
      for (let t = 0; t + 3 < labShown.length; t += 4) {
        const lx = labShown[t] ?? 0;
        const ly = labShown[t + 1] ?? 0;
        if (labShown[t + 3] === 1 && boxX - spare < lx + (labShown[t + 2] ?? 0) && lx < boxX + LABEL.widthPx + spare && boxY - spare < ly + LAB_TAG_PX && ly < boxY + LABEL.tagPx + spare) blocked = true;
      }
      state.blocked = wanted && blocked;
      const showTag = wanted && !blocked && !offView;
      const showEdge = wanted && !blocked && offView;
      // One coming in (not yet showing) waits until no other name still shows where it goes (one that gave
      // way, or one whose world has gone, fading out), keeping its place meanwhile: two never show at once there.
      let wait = false;
      if ((showTag || showEdge) && Math.max(state.tag, state.edge) < LABEL.handover) {
        for (const other of BODY_IDS) {
          if (other !== id && worldNameAt(other, boxX, boxY, LABEL.widthPx, LABEL.tagPx)) wait = true;
        }
        // (The laboratory's names showing last frame too.)
        for (let t = 0; t + 3 < labShown.length; t += 4) {
          const lx = labShown[t] ?? 0;
          const ly = labShown[t + 1] ?? 0;
          if (boxX < lx + (labShown[t + 2] ?? 0) && lx < boxX + LABEL.widthPx && boxY < ly + LAB_TAG_PX && ly < boxY + LABEL.tagPx) wait = true;
        }
      }
      state.tagBox[0] = sx + LABEL.gapPx;
      state.tagBox[1] = sy - LABEL.tagPx;
      if (offView) {
        state.edgeBox[0] = boxX;
        state.edgeBox[1] = boxY;
      }
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
      const tagWant = showTag && !wait ? LABEL.opacity : 0;
      const edgeWant = showEdge && !wait ? LABEL.opacity : 0;
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

  /** A world's name gives way at once (to the laboratory's chosen body's name or mark over it): gone this frame, back once it has room again. */
  const giveWay = (id: BodyId): void => {
    const s = labelState[id];
    s.tag = 0;
    s.edge = 0;
    s.blocked = true;
    s.tagLabel.opacity = 0;
    s.edgeLabel.opacity = 0;
    labelOpacity.set(id, 0);
  };

  /** A world's name (its tag or its pointer) still shows over a box (CSS px, top left, width and height). */
  const worldNameAt = (id: BodyId, x: number, y: number, w: number, h: number): boolean => {
    const s = labelState[id];
    const t = s.tagBox;
    const e = s.edgeBox;
    return (s.tag > LABEL.handover && x < t[0] + LABEL.widthPx && t[0] < x + w && y < t[1] + LABEL.tagPx && t[1] < y + h) || (s.edge > LABEL.handover && x < e[0] + LABEL.widthPx && e[0] < x + w && y < e[1] + LABEL.tagPx && e[1] < y + h);
  };

  /**
   * The laboratory's names (its new bodies, a ship's burn directions) kept apart as the worlds' are:
   * none behind a world's disc, outside the clear view or under the interface, the chosen body's own
   * name and marks (its burn directions, its Lagrange points, the encounters ahead: the names without a
   * rank) included. Where two would meet (a torn moon's pieces start strung along one line) each tries
   * the four corners about its body, keeping the one it had while it has room, and the lesser gives way
   * (the chosen body's first, then the larger): one showing gives way with a margin to spare, fading out
   * quickly, and one coming in (or moving corner) waits until nothing still shows where it goes, so two
   * never show over each other. The chosen body's name and marks come before the others and before the
   * worlds' names, which give way to them (at once where one shows over a world's); with no corner clear
   * of the interface and of each other, one waits out of sight. Nothing is allocated per frame but a
   * new name's entries.
   */
  const declutterLab = (from: number, dt: number, viewportPx: number, widthPx: number): void => {
    const c = ctx;
    const sys = system;
    if (!c || !sys) return;
    labFrame += 1;
    const show = 1 - Math.exp(-Math.max(0, dt) / LABEL.seconds);
    const hide = 1 - Math.exp(-Math.max(0, dt) / LABEL.hideSeconds);
    const left = insets.left + LABEL.marginPx;
    const rightEdge = widthPx - insets.right - LABEL.marginPx;
    const top = insets.top + LABEL.tagPx;
    const bottom = viewportPx - insets.bottom - LABEL.marginPx;
    // A tag's box at a corner (its text at 7.5 px a letter, its padding and rule; a line's height).
    const h = LAB_TAG_PX;
    const boxAt = (j: number, spot: number, out: 'x' | 'y'): number => {
      const [dx, dy] = LAB_SPOTS[spot] ?? [0, 0];
      const g = j * LAB_GEOM;
      return out === 'x' ? (dx < 0 ? (labGeom[g] ?? 0) + dx - (labGeom[g + 2] ?? 0) : (labGeom[g] ?? 0) + dx) : (labGeom[g + 1] ?? 0) + dy - h / 2;
    };
    const meets = (ax: number, ay: number, aw: number, bx: number, by: number, bw: number, pad: number): boolean => ax - pad < bx + bw && bx < ax + aw + pad && ay - pad < by + h && by < ay + h + pad;
    const rank = (label: SceneLabel | undefined): number => label?.rank ?? Number.MAX_VALUE;
    const own = (label: SceneLabel): boolean => rank(label) === Number.MAX_VALUE;
    // First where each name is now (its point on screen, whether it shows at all (2 once given a corner), its width, its box at the corner it had).
    const count = labels.length - from;
    labOrder.length = 0;
    labGeom.length = count * LAB_GEOM;
    for (let j = 0; j < count; j += 1) {
      const label = labels[from + j];
      if (!label) continue;
      labOrder.push(j);
      const [px, py, pz] = label.position;
      const d = Math.hypot(px, py, pz);
      projected.set(px, py, pz).project(c.camera);
      const sx = ((projected.x + 1) / 2) * widthPx;
      const sy = ((1 - projected.y) / 2) * viewportPx;
      const front = d > 0 && projected.z < 1 && projected.z > -1;
      let visible = front && sx >= left && sx <= rightEdge && sy >= top && sy <= bottom;
      // Behind a world: nearer than it and inside its outline as seen from here.
      for (const id of BODY_IDS) {
        if (!visible) break;
        const p = placed[id];
        const q = Math.hypot(p.drawn.x, p.drawn.y, p.drawn.z);
        if (hiddenBodies.has(id) || q <= 0 || q >= d) continue;
        const cos = (px * p.drawn.x + py * p.drawn.y + pz * p.drawn.z) / (d * q);
        if (Math.acos(Math.min(1, Math.max(-1, cos))) < Math.asin(Math.min(1, (sys.specs[id].radiusKm * grow[id] * p.k) / q))) visible = false;
      }
      const g = j * LAB_GEOM;
      labGeom[g] = sx;
      labGeom[g + 1] = sy;
      labGeom[g + 2] = (label.text?.length ?? LAB_KEY_LETTERS) * 7.5 + 20;
      labGeom[g + 3] = visible ? 1 : 0;
      const had = labPlace.get(label.id) ?? 0;
      labGeom[g + 4] = boxAt(j, had, 'x');
      labGeom[g + 5] = boxAt(j, had, 'y');
    }
    labOrder.sort((a, b) => rank(labels[from + b]) - rank(labels[from + a]) || a - b);
    // Then, the most important first, where each may go: clear of the interface, the corners already given and (but for the chosen body's) the worlds' names.
    let boxes = 0;
    /** `first`: the chosen body's name or mark, which the worlds' names give way to (theirs are not in its way). */
    const clear = (bx: number, by: number, w: number, pad: number, first: boolean): boolean => {
      if (bx < insets.left || bx + w > widthPx - insets.right || by < insets.top || by + h > viewportPx - insets.bottom) return false;
      for (let t = 0; t < takenCount && !first; t++) {
        const o = taken[t];
        if (o && bx < o.x + LABEL.widthPx && o.x < bx + w && by < o.y + LABEL.tagPx && o.y < by + h) return false;
      }
      for (const r of avoid) if (bx < r.right && r.left < bx + w && by < r.bottom && r.top < by + h) return false;
      for (let t = 0; t < boxes; t++) {
        const o = labBoxes[t];
        if (o && meets(bx, by, w, o.x, o.y, o.w, pad)) return false;
      }
      return true;
    };
    for (const j of labOrder) {
      const label = labels[from + j];
      if (!label) continue;
      const g = j * LAB_GEOM;
      const w = labGeom[g + 2] ?? 0;
      const before = labFade.get(label.id) ?? (entering ? label.opacity : 0);
      const showing = before > LABEL.handover;
      const was = labPlace.get(label.id) ?? 0;
      let spot = -1;
      for (let t = -1; labGeom[g + 3] === 1 && spot < 0 && t < LAB_SPOTS.length; t += 1) {
        if (t === was) continue;
        const k = t < 0 ? was : t;
        if (clear(boxAt(j, k, 'x'), boxAt(j, k, 'y'), w, showing ? LAB_MARGIN_PX : 0, own(label))) spot = k;
      }
      let wait = false;
      if (spot >= 0) {
        labGeom[g + 3] = 2;
        const bx = boxAt(j, spot, 'x');
        const by = boxAt(j, spot, 'y');
        let box = labBoxes[boxes];
        if (!box) {
          box = { x: 0, y: 0, w: 0 };
          labBoxes.push(box);
        }
        box.x = bx;
        box.y = by;
        box.w = w;
        boxes += 1;
        // Coming in, or to another corner: only once no other name still shows there (a world's fading out too).
        if (!showing || spot !== was) {
          for (const k of labOrder) {
            const other = labels[from + k];
            const q = k * LAB_GEOM;
            if (k !== j && other && (labFade.get(other.id) ?? 0) > LABEL.handover && meets(bx, by, w, labGeom[q + 4] ?? 0, labGeom[q + 5] ?? 0, labGeom[q + 2] ?? 0, 0)) wait = true;
          }
          for (const id of BODY_IDS) if (worldNameAt(id, bx, by, w, h)) wait = true;
        }
        if (!wait || !showing) labPlace.set(label.id, spot);
      }
      label.offset = LAB_SPOTS[labPlace.get(label.id) ?? 0];
      const want = spot >= 0 && !wait ? label.opacity : 0;
      const now = before + (want - before) * (entering ? 1 : want < before ? hide : show);
      labFade.set(label.id, now);
      labSeen.set(label.id, labFrame);
      label.opacity = now < 1e-3 ? 0 : now;
    }
    // Whatever the easing left, two never show over each other: by rank, a name whose box meets one
    // shown (or given a place) before it gives way at once (it comes back once it has room), and so does
    // a world's under the chosen body's name or marks, or over another of the laboratory's. What shows,
    // and where the chosen body's names go, is kept for the worlds' names on the next frame.
    labShown.length = 0;
    for (const j of labOrder) {
      const label = labels[from + j];
      if (!label) continue;
      const first = own(label);
      const spot = labPlace.get(label.id) ?? 0;
      const bx = boxAt(j, spot, 'x');
      const by = boxAt(j, spot, 'y');
      const w = labGeom[j * LAB_GEOM + 2] ?? 0;
      if (label.opacity <= LABEL.handover) {
        // The chosen body's name or mark coming in has its place: a world's name there gives way to it.
        if (first && labGeom[j * LAB_GEOM + 3] === 2) labShown.push(bx, by, w, 1);
        continue;
      }
      let meet = false;
      for (let t = 0; t + 3 < labShown.length; t += 4) if (meets(bx, by, w, labShown[t] ?? 0, labShown[t + 1] ?? 0, labShown[t + 2] ?? 0, 0)) meet = true;
      for (const id of BODY_IDS) {
        if (meet || !worldNameAt(id, bx, by, w, h)) continue;
        if (first) giveWay(id);
        else meet = true;
      }
      if (meet) {
        label.opacity = 0;
        labFade.set(label.id, 0);
      } else labShown.push(bx, by, w, first ? 1 : 0);
    }
    for (const [id, at] of labSeen) {
      if (at === labFrame) continue;
      labSeen.delete(id);
      labFade.delete(id);
      labPlace.delete(id);
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
        const found = byId.get(id) ?? worlds?.nav(id);
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
      const [planets, moon, physical, volume, manifest, skyFile] = await Promise.all([
        c.assets.json<PlanetsFile>('assets/jpl/planets.json'),
        c.assets.json<MoonFile>('assets/jpl/moon.json'),
        c.assets.json<PhysicalFile>(PHYSICAL_URL),
        createNoiseVolume(NOISE.size, NOISE.seed),
        c.assets.json<PlanetsManifest>(PLANETS_MANIFEST_URL),
        c.assets.json<SkyFile>(SKY_URL),
        c.data.ready,
      ]);
      noise = volume;
      timeConstants = physical.time;
      for (const id of BODY_IDS) spinRate[id] = physical.bodies[(id.charAt(0).toUpperCase() + id.slice(1)) as keyof PhysicalFile['bodies']].pm[1];
      tables = tableRange(moon);
      spanOf(moon);
      system = createSolarSystem(planets, moon, physical);
      labInputs = { planets, moon, physical };
      skyData = skyFile;
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
      stars = createSky(skyFile, obliquityRad(physical));
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
      root.add(stars.object, stars.lines, orbits.mesh, dots.object, glare.object, ...BODY_IDS.map((id) => bodies?.objects[id]).filter((o): o is Group => o !== undefined), ...bodies.extras);
      satellites = createSatelliteLayer(c.assets.url('assets/live/active.tle'));
      // The Earth's turn (rad/s) from its rotation model: the prime meridian's rate, degrees per day.
      satellites.setEarthRotation((physical.bodies.Earth.pm[1] * Math.PI) / 180 / SECONDS_PER_DAY);
      quakes = createQuakeLayer();
      root.add(...satellites.objects, quakes.object);
      void loadPlaces(c.assets).then((list) => {
        places = list;
      });

      // Notes from cited data: without the constants file they are left out, never guessed.
      try {
        await c.data.ready;
        const facts = deriveFacts(physical, planets, (id) => c.data.constant(id).value);
        const figure = (id: string): number | null => {
          try {
            return c.data.constant(id).value;
          } catch {
            return null;
          }
        };
        walkAir = { surfaceKpa: figure('earth.atmosphere.surfacePressure'), scaleHeightKm: figure('earth.atmosphere.scaleHeight'), meanTempC: figure('earth.atmosphere.averageTemperature') };
        const celsius = (id: string): number | null => {
          const k = figure(id);
          return k === null ? null : k - 273.15;
        };
        const range = (min: string, max: string): { min: number; max: number } | null => {
          const lo = celsius(min);
          const hi = celsius(max);
          return lo === null || hi === null ? null : { min: lo, max: hi };
        };
        walkFigures.moon = { surfaceKpa: null, scaleHeightKm: null, meanTempC: null, dayRangeC: range('moon.surfaceTemperature.equatorMin', 'moon.surfaceTemperature.equatorMax') };
        walkFigures.mars = { surfaceKpa: figure('mars.surfacePressure'), scaleHeightKm: figure('mars.atmosphere.scaleHeight'), meanTempC: celsius('mars.averageTemperature'), dayRangeC: null };
        walkFigures.mercury = { surfaceKpa: null, scaleHeightKm: null, meanTempC: celsius('mercury.averageTemperature'), dayRangeC: range('mercury.surfaceTemperature.sunwardMin', 'mercury.surfaceTemperature.sunwardMax') };
        walkFigures.venus = { surfaceKpa: figure('venus.surfacePressure'), scaleHeightKm: figure('venus.atmosphere.scaleHeight'), meanTempC: celsius('venus.averageTemperature'), dayRangeC: null };
        labShapes = Object.fromEntries(BODY_IDS.map((id) => [id, { j2: figure(`${id}.j2`), inertia: figure(`${id}.momentOfInertia`) }]));
        labFigure = figure;
        // The air's mean molar mass from its composition by volume (IUPAC standard atomic weights, kg/mol).
        const molar = { n2: 0.028014, o2: 0.031998, ar: 0.039948, co2: 0.044009, co: 0.02801 } as const;
        const meanMolar = (world: string, gases: ReadonlyArray<keyof typeof molar>): number | undefined => {
          let sum = 0;
          let share = 0;
          for (const g of gases) {
            const v = figure(`${world}.atmosphere.${g}`);
            if (v === null) continue;
            sum += v * molar[g];
            share += v;
          }
          return share > 0 ? sum / share : undefined;
        };
        airMolar = { earth: meanMolar('earth', ['n2', 'o2', 'ar', 'co2']), mars: meanMolar('mars', ['co2', 'n2', 'ar', 'o2', 'co']), venus: meanMolar('venus', ['co2', 'n2']) };
        lightKmS = facts.lightKmS;
        discoveries = new Discoveries(facts);
      } catch (err) {
        console.warn('[explore] Notes and light-times are unavailable: data/constants.json did not load', err);
      }

      const w = world;
      input = createInput(c.renderer.domElement, {
        // On foot, the same input walks: a drag looks round, W A S D walk (Shift runs), R jumps, the arrows turn and tip the look; Esc or O ends the walk.
        drag: (dx, dy) => {
          if (hoodShown) {
            hood?.drag(dx, dy);
            return;
          }
          if (walk?.active) {
            // A drag moves the scene with it if the visitor chose so (mouse-look never does).
            const sense = walkScene && document.pointerLockElement !== c.renderer.domElement ? -1 : 1;
            walk.look(dx * sense, dy * sense);
            return;
          }
          if (descent?.active) {
            descent.look(dx, dy);
            return;
          }
          stretch.steered = true;
          nav.drag(w, dx, dy);
        },
        pan: (dx, dy) => {
          if (hoodShown) {
            hood?.drag(dx, dy);
            return;
          }
          if (walk?.active) {
            walk.look(walkScene ? -dx : dx, walkScene ? -dy : dy);
            return;
          }
          if (descent?.active) {
            descent.look(dx, dy);
            return;
          }
          stretch.steered = true;
          nav.pan(w, dx, dy);
        },
        zoom: (dLn) => {
          if (hoodShown) {
            hood?.zoom(dLn);
            return;
          }
          // On foot the view narrows and widens (binoculars to a wide lens).
          if (walk?.active) walkFov = Math.min(WALK_ZOOM.max, Math.max(WALK_ZOOM.min, walkFov * Math.exp(Number.isFinite(dLn) ? dLn : 0)));
          if (walk?.active || descent?.active) return;
          stretch.steered = true;
          nav.zoom(w, dLn);
        },
        orbitKeys: (azimuth, elevation, zoom) => {
          // The left arrow turns the walker left (its azimuth is +1, for the orbit's own sense).
          walkInput.turn = -azimuth;
          walkInput.tip = elevation;
          if (walk?.active || descent?.active) return;
          if (azimuth !== 0 || elevation !== 0 || zoom !== 0) stretch.steered = true;
          nav.setOrbitKeys(azimuth, elevation, zoom);
        },
        flightKeys: (move, roll, boost, ride) => {
          walkInput.forward = move.z;
          walkInput.right = move.x;
          walkInput.jump = move.y > 0;
          walkInput.run = boost;
          walkInput.rover = ride === true;
          // On foot Q and E turn, as the arrows do.
          walkTurnKeys = roll;
          if (walk?.active || descent?.active) return;
          if (move.x !== 0 || move.y !== 0 || move.z !== 0 || roll !== 0) stretch.steered = true;
          nav.setFlightKeys(w, move, roll, boost);
        },
        stop: () => {
          if (hoodShown) {
            if (hood?.travelling) hood.stop();
            else endStars();
            return true;
          }
          // A walk (asked for, landing, on foot, or dipping out) or a descent takes Esc, and holds it a
          // second after (through the climb back): pressed again or held, it goes no further. A walk
          // waiting for a trip is dropped with the trip.
          if (walkAfterTrip) {
            walkAfterTrip = null;
            escapeHeld = performance.now() + 1000;
            steer('stop');
            return true;
          }
          // The climb back to orbit after a walk (from the dip's darkest on): stopped where it is.
          if (walkClimb && nav.stopGlide()) {
            walkClimb = false;
            escapeHeld = performance.now() + 1000;
            return true;
          }
          if (walkDip && !walkDip.into) return true;
          if (walk?.active || walkAsked || walkLoading || walkDip) {
            endWalk();
            return true;
          }
          if (descentDip && !descentDip.into) return true;
          if (descent?.active || descentDip) {
            endDescent();
            return true;
          }
          // Esc while placing a body leaves placing.
          if (lab?.active && lab.placing) {
            lab.command({ kind: 'place', on: false });
            return true;
          }
          if (steer('stop')) return true;
          // Held: and pressed again within the second, held a second longer (only a pause lets Esc go on).
          if (performance.now() < escapeHeld) {
            escapeHeld = performance.now() + 1000;
            return true;
          }
          return false;
        },
        // What is shown, not what is asked for: landing, the camera still waits in orbit.
        onFoot: () => (walking ? 'ground' : descending ? 'air' : null),
        orbit: () => {
          if (walk?.active) {
            endWalk();
            return;
          }
          if (descent?.active) {
            endDescent();
            return;
          }
          steer('orbit');
        },
        pick,
        // The laboratory's pointer: its velocity arrow taken by the tip, a placing preview, a tap that places.
        grab: (x, y) => (lab?.active ? lab.grab(x, y) : false),
        grabMove: (x, y) => {
          lab?.grabMove(x, y);
        },
        grabEnd: (cancelled) => {
          lab?.grabEnd(cancelled);
        },
        hover: (x, y) => {
          if (lab?.active) lab.hover(x, y);
        },
        tap: (x, y) => (lab?.active ? lab.tap(x, y) : false),
        travel: (id) => {
          nav.flyTo(w, id);
          // The interface keeps the address in step (app.focusBody), as for a choice from its list.
          c.renderer.domElement.dispatchEvent(new CustomEvent('kf-universe-focus', { detail: id, bubbles: true }));
        },
      });
    },

    configure(options) {
      wantLab = options.lab === true;
      // A scenario from a share link: loaded once the laboratory is running.
      if (options.labShare) pendingShare = options.labShare;
      if (entered) applyLab();
      if (options.jdUtc !== null || !entered) pinnedUtc = options.jdUtc;
      if (entered && options.jdUtc !== null) goToDate(options.jdUtc, timePaused);
      nav.reducedMotion = options.reducedMotion;
      if (entered && options.body && world) nav.flyTo(world, options.body);
      else wantBody = options.body;
      if (!entered) wantStretch = options.stretch === true;
    },

    enter(c) {
      ctx = c;
      if (!soundscape) {
        soundscape = createSoundscape(c.audio);
        soundscape.setEnabled(soundView.on);
        window.addEventListener('pointerdown', unlockSound);
        window.addEventListener('keydown', unlockSound);
      }
      if (!system || !world) return;
      c.scene.add(root);
      c.scene.add(starsRoot);
      starsRoot.visible = false;
      root.visible = true;
      entered = true;
      ambient = 0;
      shownFor = 0;
      if (pinnedUtc === null) setDate(null);
      else goToDate(pinnedUtc, timePaused);
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
      applyLab();
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
      soundscape?.update(soundState(), dt);
      soundView.playing = soundscape?.playing ?? null;
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
        case 'walk': {
          const at = command.lat !== undefined && command.lon !== undefined ? { world: command.world ?? 'earth', lat: command.lat, lon: command.lon } : (walkHere ?? (belowEarth ? { world: 'earth' as const, ...belowEarth } : null));
          if (at) startWalk(at.world, at.lat, at.lon, command.headingDeg ?? 0, command.pitchDeg ?? 0);
          return;
        }
        case 'view':
          goToView(command.body, command.lat, command.lon, command.altitudeKm);
          return;
        case 'descent':
          startDescent(command.world);
          return;
        case 'descentEnd':
          endDescent();
          return;
        case 'descentPad':
          descentPad.climb = Math.max(-1, Math.min(1, command.climb));
          if (command.held !== undefined) descent?.setHeld(command.held);
          return;
        case 'descentTo':
          if (Number.isFinite(command.pressureBar) && command.pressureBar > 0) descent?.goTo(command.pressureBar);
          return;
        case 'stars':
          startStars();
          return;
        case 'starsEnd':
          endStars();
          return;
        case 'starsGoTo': {
          if (!hood) return;
          const star = command.hip === null ? hood.data.sun : hood.data.stars.find((s) => s.hip === command.hip);
          if (star) hood.goTo(star);
          return;
        }
        case 'starsStop':
          hood?.stop();
          return;
        case 'starsPlace':
          hood?.goToPlace(command.place);
          return;
        case 'sound':
          soundView.on = command.on;
          soundscape?.setEnabled(command.on);
          return;
        case 'lens':
          lensFov = command.fovDeg === null || !(command.fovDeg >= LENS_FOV.min && command.fovDeg <= LENS_FOV.max) ? null : command.fovDeg;
          viewState.lensFov = lensFov;
          return;
        case 'track':
          tracking = command.body !== null && BODY_IDS.includes(command.body) ? command.body : null;
          trackKnown = false;
          viewState.tracking = tracking;
          return;
        case 'starsSearch':
          hood?.search(command.text);
          return;
        case 'walkEnd':
          endWalk();
          return;
        case 'walkPad':
          walkPad.forward = Math.max(-1, Math.min(1, command.forward || 0));
          walkPad.right = Math.max(-1, Math.min(1, command.right || 0));
          walkPad.run = command.run === true;
          walkPad.rover = command.rover === true;
          walkPad.jump = command.jump;
          return;
        case 'walkLook':
          walkScene = command.scene;
          return;
        case 'world': {
          const id = worlds?.find(command.name);
          if (id && world) nav.flyTo(world, id);
          else if (!worlds) {
            worldWanted = command.name;
            worldsAt = 0;
          }
          return;
        }
        case 'smallBodies':
          worldsLayer = command.on;
          worldsAt = 0;
          worlds?.setLayer(command.on);
          return;
        case 'smallBodiesGrouped':
          worlds?.setGrouped(command.on);
          return;
        case 'walkRetry':
          walk?.retry();
          return;
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
        case 'markers':
          markerSet = command.set;
          return;
      }
    },

    sky(command) {
      stars?.setLayer(command.layer, command.on);
    },

    islamic(command) {
      if (islamic) {
        islamic.command(command);
        return;
      }
      islamicWaiting.push(command);
      if (islamicLoading || !labInputs || !timeConstants || !system) return;
      islamicLoading = true;
      const { planets, moon, physical } = labInputs;
      const time = timeConstants;
      const radiusKm = system.specs.earth.radiusKm;
      import('./islamic')
        .then(({ createIslamic }) => {
          islamicLoading = false;
          islamic = createIslamic({ ephemeris: createEphemeris(planets, moon, physical), time, obliquityRad: obliquityRad(physical) }, radiusKm, skyData ?? undefined);
          root.add(...islamic.objects);
          for (const c of islamicWaiting.splice(0)) islamic.command(c);
        })
        .catch(() => {
          // Its code did not arrive: the next command tries again.
          islamicLoading = false;
        });
    },

    lab(command) {
      lab?.command(command);
    },

    time(asked) {
      // Checked at the boundary: a rate or a date that is not a finite number is refused, a rate's size held to the ladder's.
      const command = validTimeCommand(asked);
      if (!command) return;
      // In the laboratory the commands drive the experiment's clock (./lab: backwards by replaying its history).
      if (lab?.active) {
        lab.time(command);
        return;
      }
      // The pure reducer (./time): a change of rate or direction sets the clock running, a new date keeps it as it
      // was; at an end, play, faster and slower turn it round. On foot faster stops at FOOT_MAX_RATE.
      const next = applyTimeCommand({ rate: timeRate, paused: timePaused, edge: timeEdge }, command, clockHold() === 'foot' ? FOOT_MAX_RATE : undefined).state;
      timeRate = next.rate;
      timePaused = next.paused;
      timeEdge = next.edge;
      pendingDate = null;
      if (command.kind === 'now') setDate(null);
      // A date outside the span is shown at its nearest end, stopped there, and the end says why.
      else if (command.kind === 'date') goToDate(command.jdUtc, next.paused);
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
      const body = world.body(pose.body).position;
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
      // Leaving the explorer ends an experiment (its worker stops; the explorer's own state comes back) and a walk; its sound goes quiet.
      soundscape?.update(null, 0);
      wantLab = false;
      applyLab();
      endWalk(true);
      endDescent(true);
      endStars(true);
      // Coming back, Esc is the explorer's at once (the hold after a walk belongs to that visit).
      escapeHeld = 0;
      // Photo mode's lens and tracking end with the visit.
      lensFov = null;
      viewState.lensFov = null;
      tracking = null;
      viewState.tracking = null;
      starsRoot.removeFromParent();
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
      soundscape?.dispose();
      soundscape = null;
      window.removeEventListener('pointerdown', unlockSound);
      window.removeEventListener('keydown', unlockSound);
      window.removeEventListener('kf-universe-avoid', onAvoid);
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
      lab?.dispose();
      for (const id of WALK_IDS) {
        walks[id]?.dispose();
        walks[id] = undefined;
      }
      for (const id of DESCENT_IDS) {
        descents[id]?.dispose();
        descents[id] = undefined;
      }
      descent = null;
      hood?.dispose();
      worlds?.dispose();
      hood = null;
      starsRoot.removeFromParent();
      walk = null;
      islamic?.dispose();
      islamic = null;
      lab = null;
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
