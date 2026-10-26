/**
 * Shared contracts for Kun Fayakun.
 *
 * Every module (core, ui, chapters, scripts) builds against these types.
 * Change them only with care: data files, content.json files and the
 * validator all depend on the exact shapes below.
 */
import type { PerspectiveCamera, Scene, Texture, WebGPURenderer } from 'three/webgpu';
import type { ExploreDetail, ExploreTier } from '../explore/detail';

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

export type ChapterId =
  | 'ch00' | 'ch01' | 'ch02' | 'ch03' | 'ch04' | 'ch05'
  | 'ch06' | 'ch07' | 'ch08' | 'ch09' | 'ch10';

/** "surah:ayah", e.g. "21:30". */
export type VerseKey = `${number}:${number}`;

/** Stable hadith id, e.g. "bukhari-3191". See data/hadith.json. */
export type HadithId = string;

/** Stable science constant id, e.g. "universe.age". See data/constants.json. */
export type ConstantId = string;

/** Flat ICU message key, e.g. "ch01.science.age". See src/i18n/en.json. */
export type I18nKey = string;

/** Source id in data/sources.json, e.g. "tanzil-uthmani". */
export type SourceId = string;

export type Vec3 = readonly [number, number, number];

/* ------------------------------------------------------------------ */
/* Frozen data files (data/*.json) — read-only at runtime               */
/* ------------------------------------------------------------------ */

/** One ayah in data/quran.json. Arabic is Tanzil Uthmani, verbatim, NFC. */
export interface QuranEntry {
  key: VerseKey;
  surah: number;
  ayah: number;
  /** Tanzil Uthmani text exactly as in the pinned file (NFC-normalised). */
  arabic: string;
  /** Latin transliteration from the pinned transliteration source. */
  translit: string;
  /** English translation from the pinned translation source. */
  translation: string;
  /** e.g. "en.pickthall" (Tanzil translation id). */
  translationId: string;
  /** Human-readable licence summary for this entry's three texts. */
  license: string;
  /** Source ids (data/sources.json) for arabic, translit, translation. */
  source: { arabic: SourceId; translit: SourceId; translation: SourceId };
  /** Version string of the pinned Tanzil text, e.g. "Tanzil Quran Text (Uthmani, Version 1.1)". */
  sourceVersion: string;
  /** sha256 (hex) of the NFC arabic string, UTF-8 encoded. */
  sha256: string;
  /** ISO timestamp of the fetch that produced this entry. */
  fetchedAt: string;
}

export interface QuranFile {
  meta: {
    /** Tanzil copyright block, verbatim, as it appears in the pinned file. */
    tanzilCopyright: string;
    tanzilUrl: string;
    /** sha256 of each pinned raw file that was downloaded. */
    files: Array<{ sourceId: SourceId; url: string; sha256: string; bytes: number }>;
    generatedAt: string;
  };
  ayat: QuranEntry[];
}

/** One hadith in data/hadith.json. Entered by a person, never generated. */
export interface HadithEntry {
  id: HadithId;
  /** e.g. "Sahih al-Bukhari". */
  collection: string;
  /** Number as cited, e.g. "3191". */
  number: string;
  /** sunnah.com key, e.g. "bukhari:3191" or "muslim:2653b". */
  sunnahKey: string;
  /** Parallel narrations as sunnah.com keys, e.g. ["bukhari:7418"]. */
  parallels: string[];
  /** Narrator in English with honorific, e.g. "Imran ibn Husain (may Allah be pleased with him)". */
  narrator: string;
  /** e.g. "Sahih", "Gharib (by this chain)". */
  grading: string;
  /** Who graded it, e.g. "al-Albani". */
  grader: string;
  /** Any dispute or nuance about the grading; null if none. */
  disputedNote: string | null;
  /** Name of the person who entered/verified this record against sunnah.com; null until done. */
  reviewer: string | null;
  reviewedAt: string | null;
  /**
   * Verified wording, entered by a person from sunnah.com. Null until entered.
   * The UI shows only the reference, grading and a link while these are null.
   */
  text: { en: string | null; ar: string | null; source: string | null };
}

export interface HadithFile {
  hadith: HadithEntry[];
  /** Narrations deliberately excluded, with the reason. The validator fails if any is referenced. */
  excluded: Array<{ sunnahKey: string; reason: string }>;
}

/** One number in data/constants.json. */
export interface ScienceConstant {
  id: ConstantId;
  /** Short English description (not shown verbatim; for maintainers and the Sources page). */
  description: string;
  value: number;
  /** Symmetric (number) or asymmetric uncertainty; null when the value is approximate/qualitative. */
  uncertainty: number | { plus: number; minus: number } | null;
  /** e.g. "Gyr", "K", "km/s/Mpc", "" for dimensionless. */
  unit: string;
  /** Free-form qualifier shown with the number, e.g. "assuming ΛCDM", "approximate". */
  qualifier: string | null;
  citation: {
    text: string;      // e.g. "Planck Collaboration 2020, A&A 641, A6, Table 2"
    url: string;       // DOI or arXiv URL
    accessed: string;  // ISO date the citation was checked
  };
}

export interface ConstantsFile {
  constants: ScienceConstant[];
}

export type SourceKind =
  | 'scripture-text' | 'translation' | 'transliteration' | 'hadith-collection'
  | 'font' | 'dataset' | 'paper' | 'software' | 'api';

/** One entry in data/sources.json. The Sources page is generated from this file. */
export interface SourceEntry {
  id: SourceId;
  kind: SourceKind;
  title: string;
  author: string | null;
  url: string;
  version: string | null;
  license: string;
  licenseUrl: string | null;
  /** Exact credit line that must be shown. */
  credit: string;
  /** For scripture sources: every verse key this source supplies text for. */
  verseKeys?: VerseKey[];
  /** For hadith sources: every hadith id from this collection used anywhere. */
  hadithIds?: HadithId[];
  notes: string | null;
  review: { reviewer: string | null; role: string | null; date: string | null };
}

export interface SourcesFile {
  disclaimer: string;
  sources: SourceEntry[];
  /** Mirrors REVIEW.md. Empty arrays until reviews happen. */
  reviews: Array<{ area: 'scripture' | 'tafsir' | 'hadith' | 'science' | 'accessibility'; reviewer: string; role: string; date: string; notes: string | null }>;
}

/* ------------------------------------------------------------------ */
/* Chapter content (src/chapters/chNN/content.json)                    */
/* ------------------------------------------------------------------ */

/** A value fed into an ICU message, resolved from data/constants.json. */
export interface ConstantValueRef {
  constant: ConstantId;
  /** Which field to inject. "uncertainty" uses the symmetric value or the larger side. */
  field: 'value' | 'uncertainty' | 'plus' | 'minus';
  /** Divide the value by this before formatting (e.g. 1e9 to show years as billions). Default 1. */
  scale?: number;
  /** Intl.NumberFormat maximumFractionDigits. Default 3. */
  digits?: number;
}

/** A paragraph of English prose: an ICU message key plus optional injected values. */
export interface ProseBlock {
  key: I18nKey;
  values?: Record<string, ConstantValueRef>;
  /** Source ids (SourceId) or constant ids (ConstantId) cited by this paragraph, shown as references. */
  cite?: string[];
}

/** Layer 1: what the text says. */
export type TextBlock =
  | { type: 'verse'; key: VerseKey; noteKey?: I18nKey }
  | { type: 'hadith'; id: HadithId; summaryKey?: I18nKey; noteKey?: I18nKey };

export type FigureId = 'bbn-abundances' | 'cmb-legend' | 'hubble-tension' | 'decay-chain' | 'expansion' | 'cosmic-futures';

export interface ScienceBlock extends ProseBlock {
  figure?: FigureId;
}

export interface PanelContent {
  /** Layer 1 — Arabic, transliteration, translation, reference. */
  text: TextBlock[];
  /** Layer 2 — classical reading first, then "Some modern writers read this as…". */
  scholarly: { classical: ProseBlock[]; modern: ProseBlock[] };
  /** Layer 3 — what science measures today, with uncertainties. */
  science: ScienceBlock[];
  /** Layer 3 (continued) — open questions. */
  openQuestions: ProseBlock[];
  /**
   * A short note shown at the top of a layer. Used when a chapter pairs no text (the
   * science stands alone): the layers stay in their order and say so plainly, rather than
   * forcing a pairing the sources do not make.
   */
  notes?: Partial<Record<'text' | 'scholarly', I18nKey>>;
  /**
   * A visitor-led letter analysis offered at the end of the scholarly layer (docs/SPEC.md,
   * Chapter 7): the id of its generated asset, public/assets/analysis/<id>.json.
   */
  discovery?: string;
}

/**
 * Timeline cues. `t` is seconds from the start of the chapter's cinematic.
 * Verse and hadith cues fade in and out whole; `duration` must be long enough
 * to read the whole ayah. Scene events must never fall inside a verse cue's
 * window or the 2 s before it (validator rule: no reveal timed to a verse).
 */
export type Cue =
  | { t: number; type: 'verse'; key: VerseKey; duration: number }
  | { t: number; type: 'hadith'; id: HadithId; duration: number }
  | { t: number; type: 'caption'; key: I18nKey; duration: number }
  | { t: number; type: 'panel'; section: 'text' | 'scholarly' | 'science' }
  | { t: number; type: 'overlay'; id: FigureId; visible: boolean }
  | { t: number; type: 'audio'; action: 'duck' | 'restore' }
  | { t: number; type: 'scene'; event: string };

export type Ease = 'linear' | 'inOutSine' | 'inOutCubic' | 'outCubic';

export interface CameraKeyframe {
  t: number;
  position: Vec3;
  target: Vec3;
  fov?: number;
  /**
   * Legacy and ignored: the camera now follows a monotone cubic spline through all
   * keys (velocity stays continuous through intermediate keys; moves ease into and
   * out of holds). Kept so older content.json files still validate.
   */
  ease?: Ease;
}

export interface ChapterContent {
  id: ChapterId;
  /** Cinematic length in seconds. */
  duration: number;
  /** Chapter title card shown in the "intro" state. */
  intro: { titleKey: I18nKey; subtitleKey?: I18nKey; seconds: number };
  panel: PanelContent;
  cues: Cue[];
  camera: CameraKeyframe[];
  /** Free-explore orbit limits. */
  explore: { target: Vec3; minDistance: number; maxDistance: number };
  /** Narration captions are shown from cues; this lists WebVTT files if audio narration exists. */
  captions?: Array<{ lang: string; src: string }>;
}

/* ------------------------------------------------------------------ */
/* Quality tiers                                                        */
/* ------------------------------------------------------------------ */

export type QualityTier = 'high' | 'mid' | 'low';

export interface QualityProfile {
  tier: QualityTier;
  /** Particle budget for the heaviest system in a scene. */
  particles: number;
  /** Device-pixel-ratio cap. */
  dprCap: number;
  bloom: boolean;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: { tier: 'high', particles: 2_000_000, dprCap: 2, bloom: true },
  mid: { tier: 'mid', particles: 300_000, dprCap: 1.5, bloom: true },
  low: { tier: 'low', particles: 80_000, dprCap: 1.5, bloom: false },
};

/* ------------------------------------------------------------------ */
/* Runtime services handed to chapters                                  */
/* ------------------------------------------------------------------ */

export interface DataStore {
  /** Resolves once data/*.json are loaded. */
  ready: Promise<void>;
  verse(key: VerseKey): QuranEntry;
  hadith(id: HadithId): HadithEntry;
  constant(id: ConstantId): ScienceConstant;
  sources(): SourcesFile;
  quranMeta(): QuranFile['meta'];
}

export interface AssetLoader {
  /** KTX2 (Basis) texture via KTX2Loader; works on WebGPU and WebGL2. */
  ktx2(url: string): Promise<Texture>;
  /** PNG/WebP texture (for MSDF atlases, which must stay lossless). */
  texture(url: string): Promise<Texture>;
  json<T>(url: string): Promise<T>;
  binary(url: string): Promise<ArrayBuffer>;
  /** Resolves a path under public/ against the deployed base URL. */
  url(path: string): string;
}

/**
 * Global exposure, slew-limited by the engine so no scene can produce more
 * than 3 flashes per second (and none with reduced motion). Chapters set a
 * target; the engine eases toward it.
 */
export interface ExposureControl {
  /** Target exposure multiplier (1 = neutral). */
  setTarget(value: number): void;
  readonly current: number;
}

export interface ChapterContext {
  renderer: WebGPURenderer;
  /** 'webgpu' or 'webgl2' — chapters must work on both. */
  backend: 'webgpu' | 'webgl2';
  /** Shared scene: chapters add their root group in enter() and remove it in exit(). */
  scene: Scene;
  camera: PerspectiveCamera;
  quality: QualityProfile;
  reducedMotion: boolean;
  assets: AssetLoader;
  data: DataStore;
  exposure: ExposureControl;
}

/**
 * Every chapter's scene.ts default-exports a factory returning this.
 * Lifecycle: load → enter → update* → exit → (enter again …) → dispose.
 */
export interface ChapterModule {
  id: ChapterId;
  content: ChapterContent;
  /** Same array as content.cues; exposed per the spec's chapter contract. */
  cues: readonly Cue[];
  /** Fetch assets and build GPU resources. Must not add anything to the scene. */
  load(ctx: ChapterContext): Promise<void>;
  /** Add the chapter's root object to ctx.scene and reset state. */
  enter(ctx: ChapterContext): void;
  /** t = chapter time in seconds (cinematic clock, paused in explore mode); dt = real seconds since last frame. */
  update(t: number, dt: number): void;
  /** Called for every 'scene' cue as the timeline crosses it (also when seeking past it). */
  onSceneEvent?(event: string, t: number): void;
  /** Quality tier dropped by the governor while this chapter is active. */
  setQuality?(profile: QualityProfile): void;
  /** A panel control changed (e.g. the expansion slider); null hands control back to the film. */
  onInteract?(id: string, value: number | null): void;
  /** World-anchored HUD tags (DOM text, positioned by the engine each frame). */
  labels?(): readonly SceneLabel[];
  /** True physical scale of the view, for the HUD scale bar; null when it has none. */
  scale?(): SceneScale | null;
  /** Remove from scene; keep GPU resources for a possible re-enter. */
  exit(): void;
  /** Free all GPU resources. */
  dispose(): void;
}

export type ChapterFactory = () => ChapterModule;

/** A HUD tag anchored to a point in the scene (e.g. an element in a supernova remnant). */
export interface SceneLabel {
  id: string;
  /** ICU message key of the tag's text. */
  textKey: I18nKey;
  /** Literal text instead (names from data: satellites, places); textKey is then unused. */
  text?: string;
  position: Vec3;
  /** 0..1, eased by the chapter (tags fade, they never pop). */
  opacity: number;
  /**
   * Optional callout: the tag sits this far from its point (CSS pixels, x right, y down),
   * joined to it by a thin leader line, so tags on crowded small features never overlap.
   */
  offset?: readonly [number, number];
}

/** How big the view really is: world units in metres, at a depth of interest. */
export interface SceneScale {
  metresPerUnit: number;
  /** Distance (world units) from the camera to the plane the scale bar describes. */
  distance: number;
}

/** A SceneLabel projected to the viewport (CSS pixels). */
export interface ScreenLabel {
  id: string;
  textKey: I18nKey;
  /** Literal text (see SceneLabel.text). */
  text?: string;
  x: number;
  y: number;
  opacity: number;
  offset?: readonly [number, number];
}

export interface HudState {
  labels: readonly ScreenLabel[];
  /** Metres covered by one CSS pixel at the chapter's depth of interest. */
  metresPerPixel: number | null;
}

/* ------------------------------------------------------------------ */
/* App events and commands (core ⇄ ui)                                   */
/* ------------------------------------------------------------------ */

export type TimelineState = 'idle' | 'loading' | 'intro' | 'playing' | 'explore' | 'outro';

/* ------------------------------------------------------------------ */
/* Experiences: the film, and the solar-system explorer ("universe")    */
/* ------------------------------------------------------------------ */

/**
 * What the engine is showing. The film is the timeline of chapters; the universe is the
 * true-scale solar-system explorer, a separate experience loaded on demand. (The chapters'
 * own free-look stays the TimelineState 'explore' and the E key; it is not the universe.)
 */
export type ExperienceId = 'film' | 'universe';

/** Bodies the explorer can focus, in the order its body list shows them. */
export type BodyId = 'sun' | 'mercury' | 'venus' | 'earth' | 'moon' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune';

export const BODY_IDS: readonly BodyId[] = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/**
 * A non-chapter experience: the chapter lifecycle minus content and cues (no film clock).
 * Lifecycle: load → enter → update* → exit → (enter again …) → dispose.
 */
export interface ExperienceModule {
  readonly id: Exclude<ExperienceId, 'film'>;
  /** Fetch assets and build GPU resources. Must not add anything to the scene. */
  load(ctx: ChapterContext): Promise<void>;
  /** Add the root object to ctx.scene and reset state. */
  enter(ctx: ChapterContext): void;
  /** dt = real seconds since the last frame (0 while the page is on a manual test clock between steps). */
  update(dt: number): void;
  /** Quality tier dropped by the governor while this experience is active. */
  setQuality?(profile: QualityProfile): void;
  /** World-anchored HUD tags, as for chapters. */
  labels?(): readonly SceneLabel[];
  /** True physical scale for the HUD scale bar; null when a single bar would mislead. */
  scale?(): SceneScale | null;
  /** Remove from the scene; keep GPU resources for a possible re-enter. */
  exit(): void;
  /** Free all GPU resources. */
  dispose(): void;
}

/** Where the explorer's camera is and what it is doing, for its UI and the tests. */
export interface UniverseView {
  /** The body the camera orbits (during a flight: the body it is flying to). */
  focus: BodyId;
  /** True while the camera flies from one body to another. */
  travelling: boolean;
  /** During a flight, the body it left (else null). */
  from: BodyId | null;
  /** The camera moved this frame (a drag, a zoom, a flight); at rest nothing on screen moves but the sky's slow turn. */
  moving: boolean;
  /** Distance from the camera to the focus's centre and to its surface (cloud tops, photosphere), km. */
  distanceKm: number;
  altitudeKm: number;
  /** Sunlight at the camera as a share of the Sun's light at 1 au (1 at the Earth). */
  sunlight: number;
  /** The Sun is large in view and shown as photographed through a solar filter (gold, dimmed). */
  solarFilter: boolean;
  /** The date shown: TDB Julian date, and the same instant as a Unix time (ms) for display. */
  jdTdb: number;
  unixMs: number;
  /** The time machine (src/explore/time): its clock's rate and state, and the span of dates it can show. */
  time: UniverseTime;
  /** The sky (src/explore/sky): which of its layers are shown, and how many stars are drawn. */
  sky: { layers: Record<SkyLayerName, boolean>; stars: number };
  /** The orbital laboratory (src/explore/lab, src/sim) while an experiment runs; null in the real explorer. */
  lab: UniverseLab | null;
  /** The qibla and the new moon (src/explore/islamic) once their section has been opened; null in the laboratory. */
  islamic: UniverseIslamic | null;
  /** On foot on the Earth (src/explore/walk) while a walk is on; else null. Also null when a walk was refused: see walkRefused. */
  walk: UniverseWalk | null;
  /** The last walk asked for was refused (a forbidden place: Makkah, by its framing rule), until another starts. */
  walkRefused: boolean;
  /**
   * What the view draws now that is illustrative rather than measured, for the readout to name
   * (optional: an explorer that leaves it out shows no such note).
   */
  illustrative?: readonly UniverseIllustration[];
  /** 'orbit': circling the focus; 'flight': flying freely near it (carried along with it). */
  mode: 'orbit' | 'flight';
  /** Camera speed, km/s (free flight and trips; 0 while orbiting). */
  speedKmS: number;
  /** During a trip: its progress (0 to 1), and the camera's height above the destination's surface now, at the start and on arrival, km. */
  trip: { progress: number; remainingKm: number; startKm: number; endKm: number } | null;
  /** Every body, in BODY_IDS order: where it is and how the camera sees it. */
  bodies: readonly UniverseBodyView[];
  /** The camera's heliocentric ecliptic position, km, and its heading in the ecliptic (radians from +x toward +y). */
  camera: { x: number; y: number; z: number; heading: number };
  /** A note about what the camera is near (science only, every number from cited data), or null. */
  discovery: { id: string; values: Readonly<Record<string, number>> } | null;
  /** Phenomena seen on this visit, in the order first seen (no scores or counts). */
  witnessed: readonly string[];
  /** The detail tier running, how it was chosen, and what may be chosen. */
  detail: UniverseDetail;
  /** km per astronomical unit, from the explorer's data (DE440), for displaying distances. */
  auKm: number;
  /** The speed of light, km/s (data/constants.json; 0 if it did not load), for light-times and speeds. */
  lightKmS: number;
  /** 1 at true scale; below 1 while the film's compressed view stretches out to it (the way in from Chapter 7). */
  trueScale: number;
  /** The Earth's streamed imagery (zoom anywhere): mode, the today mosaic's date, each layer's finest zoom and tile counts. */
  imagery: UniverseImagery | null;
  /** The Living Earth's live layers: satellites and earthquakes. */
  living: UniverseLiving | null;
  /** The lens over the Earth (degrees) and the ground one CSS pixel spans at the view's centre (m), when zoomed in. */
  lens: { deg: number; metresPerPixel: number } | null;
}

/** The Living Earth's live layers as the view's state reports them. */
/** One satellite as the explorer reports it: the point beneath it (degrees), its height (km) and period (min). */
export interface UniverseSatellite {
  index: number;
  name: string;
  /** A crewed station's id ('iss', 'css'), which the interface names plainly; null for the rest. */
  station: string | null;
  norad: number;
  kind: string;
  lat: number;
  lon: number;
  altitudeKm: number;
  periodMin: number;
  sunlit: boolean;
}

/** A place named in the field notes' bulletin, and how far it is from the point it is named for (km over the ground). */
export interface UniverseNearPlace {
  name: string;
  lat: number;
  lon: number;
  km: number;
}

/** "Today on Earth" (src/explore/field-notes/bulletin): live facts with places to fly to. */
export interface UniverseBulletin {
  sun: { lat: number; lon: number; near: UniverseNearPlace | null };
  dawn: { name: string; lat: number; lon: number } | null;
  dusk: { name: string; lat: number; lon: number } | null;
  station: (UniverseSatellite & { near: UniverseNearPlace | null }) | null;
  satellites: { count: number; sunlit: number } | null;
  quakes: { count: number; strongest: { id: string; magnitude: number; lat: number; lon: number; place: string; timeMs: number; depthKm: number } | null } | null;
}

export interface UniverseLiving {
  satellites: {
    state: 'off' | 'loading' | 'ready' | 'failed' | 'out-of-range';
    count: number;
    byKind: Record<'station' | 'starlink' | 'oneweb' | 'navigation' | 'geostationary' | 'other', number>;
    sunlit: number;
    fetchedMs: number;
    selected: UniverseSatellite | null;
  };
  quakes: {
    state: 'off' | 'loading' | 'ready' | 'failed';
    fetchedMs: number;
    /** Events of the past day, strongest first. */
    list: ReadonlyArray<{ id: string; magnitude: number; lat: number; lon: number; depthKm: number; timeMs: number; place: string; url: string }>;
  };
  /** The International Space Station, while the catalogue has it. */
  station: UniverseSatellite | null;
  /** The field notes' "Today on Earth", refreshed about once a second (null until the places have loaded). */
  bulletin: UniverseBulletin | null;
}

/** The Earth's streamed imagery as the view's state reports it. */
export interface UniverseImagery {
  mode: 'clear' | 'today';
  date: string;
  clear: { zoom: number; requested: number; loaded: number; failed: number; pending: number };
  today: { zoom: number; requested: number; loaded: number; failed: number; pending: number };
  /** Share of the cloud shell still shown (it fades as the view closes in). */
  clouds: number;
  /** Which streamed imagery is on screen now (its credit is shown while it is). */
  showing: { clear: boolean; today: boolean };
}

/** One body as the explorer's camera sees it (live from the ephemeris). */
export interface UniverseBodyView {
  id: BodyId;
  /** From the camera to the surface (cloud tops, photosphere), km. */
  distanceKm: number;
  /** Light-time over distanceKm (from its surface to the camera), s: the two always agree. */
  lightSeconds: number;
  /** As the camera sees it: lit share of the disc (0 to 1) and the bright limb's direction on screen (radians from screen right, counterclockwise). */
  lit: number;
  limbAngle: number;
  /** Saturn: its rings' opening as the camera sees them (radians, signed; 0 edge-on); 0 for the rest. */
  ringOpening: number;
  /** Where its centre is on the canvas (CSS px from its top left), its disc's radius there, and whether it is in view. */
  screen: { x: number; y: number; radiusPx: number; inView: boolean };
  /** Heliocentric ecliptic position, km (x to the vernal equinox, z to ecliptic north). */
  ecliptic: { x: number; y: number; z: number };
}

/** The explorer's detail: the tier running and the visitor's choice (src/explore/detail.ts is the ladder). */
export interface UniverseDetail {
  tier: ExploreTier;
  choice: 'auto' | ExploreTier;
  /** Tiers this device may run, highest first (Ultra only where it is allowed). */
  available: readonly ExploreTier[];
  /** The scene's internal render scale now (dynamic resolution; the canvas keeps its size). */
  renderScale: number;
  /** Held still by the address (?detail=, ?tier=, ?profile=1): nothing adapts on its own. */
  fixed: boolean;
}

/** What the device says about itself, for the explorer's starting detail. */
export interface UniverseDevice {
  backend: 'webgpu' | 'webgl2';
  /** Lower-case adapter description; '' when the browser hides it. */
  description: string;
  software: boolean;
  mobile: boolean;
  /** Largest 2D texture, px (0 when unknown). */
  maxTextureSize: number;
}

/**
 * What the explorer may change about the picture while it owns the screen. The host gives the film
 * its own settings back when the explorer leaves, so none of this ever reaches a chapter.
 */
export interface UniverseGraphics {
  readonly device: UniverseDevice;
  /** A tier fixed by the address (?detail=, or ?tier= mapped onto the ladder), or null. */
  readonly fixedDetail: ExploreTier | null;
  /** False when the address holds the picture still (?detail=, ?tier=, ?profile=1). */
  readonly adaptive: boolean;
  /** The scene's internal render scale (dynamic resolution; post-processing and the canvas keep full size), 0.5 to 1. */
  setRenderScale(scale: number): void;
  /** The canvas's device-pixel-ratio ceiling. */
  setDprCap(cap: number): void;
  setBloom(on: boolean): void;
}

/**
 * Illustrative elements the explorer can draw: the Sun's surface detail, prominences and corona; the
 * Earth's fine detail below its maps' texels up close, the clouds' drift, and its night side (city
 * lights, moonlight, airglow) shown brighter than it is; the Moon's earthshine shown brighter; Jupiter's
 * bands drifting at schematic, sped-up speeds; Saturn's ring particles, enlarged and still.
 */
export type UniverseIllustration = 'map-gaps' | 'monochrome' | 'dust-haze' | 'colour-balance' | 'cloud-structure' | 'colour-model' | 'sun-surface' | 'fine-detail' | 'cloud-drift' | 'night-side' | 'earthshine' | 'band-drift' | 'ring-particles';

/**
 * The explorer's exposure: a chapter's, plus a veil the explorer eases itself (its fade-in and its
 * reduced-motion cuts) and a jump of the exposure while that veil hides the picture, so a cut
 * from the Earth to Saturn lands already adapted instead of seconds of black.
 */
export interface UniverseExposure extends ExposureControl {
  /**
   * Dims the whole picture after the exposure (1 none, 0 black). The caller eases it (rule 6): the
   * engine neither slews it nor holds it, so a reduced-motion dip is a dip whatever the exposure does.
   */
  setVeil(value: number): void;
  /** Moves the exposure straight to its target. Ignored unless the veil (or a fade) has the screen nearly black. */
  jump(): void;
}

/** The services the explorer is built with: a chapter's, with its own exposure and control of the picture. */
export interface UniverseContext extends ChapterContext {
  exposure: UniverseExposure;
  graphics: UniverseGraphics;
}

/** CSS pixels at the edges of the view that the interface covers (left and right: a side panel). */
export interface ViewInsets {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}

/** The explorer's steering commands from its interface: stop a trip, or orbit the body the camera is near. */
export type UniverseSteer = 'stop' | 'orbit';

/**
 * The time machine's commands: pause or resume; one step faster or slower on the ladder of rates
 * (src/explore/time TIME_RATES); run backwards or forwards; back to the present at real time; jump
 * to a date (UTC Julian date, kept in the data's span); or an exact rate (explorer seconds per real
 * second; negative runs backwards).
 */
export type UniverseTimeCommand =
  | { kind: 'toggle' }
  | { kind: 'faster' }
  | { kind: 'slower' }
  | { kind: 'reverse' }
  | { kind: 'now' }
  | { kind: 'date'; jdUtc: number }
  | { kind: 'rate'; rate: number };

/** The sky's layers: the constellation figures (and their names), their boundaries, the grid (with the equator and the ecliptic), and star names. */
export type SkyLayerName = 'constellations' | 'boundaries' | 'grid' | 'names';
export type UniverseSkyCommand = { kind: 'layer'; layer: SkyLayerName; on: boolean };

/** A zone of Yallop's test for the new crescent: A easily seen by eye ... F below the Danjon limit. */
export type CrescentZoneName = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** The new crescent's map for an evening after a new moon (src/explore/islamic). */
export interface UniverseCrescent {
  /** 0: the evening of the new moon's own day (UTC), 1 and 2 the evenings after. */
  evening: 0 | 1 | 2;
  /** That evening's date, 0h UTC (ms). */
  dateMs: number;
  /** Share of the map computed (it fills over a few frames). */
  progress: number;
  /** Places of the map (every 2 degrees between 60 S and 60 N) in each zone; `none` where the Moon sets first or the evening is before the new moon. */
  counts: Record<CrescentZoneName | 'none', number>;
  /** The place the qibla is reckoned from, that evening: its zone (or why none), q, sunset, best time and moonset (ms), and the Moon's age at sunset (hours). */
  here: {
    zone: CrescentZoneName | 'moon-sets-first' | 'before-new-moon' | 'no-sunset' | 'high-latitude';
    q: number | null;
    sunsetMs: number | null;
    bestMs: number | null;
    moonsetMs: number | null;
    ageHours: number;
  } | null;
}

/** The qibla and the new moon as the view reports them (src/explore/islamic). */
export interface UniverseIslamic {
  /**
   * The qibla from a place (the point beneath the camera unless one was chosen; `name` null for that
   * point): its bearing from true north (degrees), the nearest of 16 compass points (0 north, 4 east),
   * the great-circle distance to the Kaaba (km), and whether its path is drawn. Null with no place.
   */
  qibla: { from: { lat: number; lon: number; name: string | null }; bearingDeg: number; compass: number; distanceKm: number; line: boolean } | null;
  /** The golden latitude (degrees) beside the Kaaba's: the Kaaba's ratio of its distances to the South and North Poles along its meridian, how far north of the golden latitude it is (km), the golden ratio, and whether both are drawn. */
  golden: { on: boolean; latDeg: number; kaabaLatDeg: number; kaabaLonDeg: number; kaabaRatio: number; kaabaNorthKm: number; ratio: number };
  /** The next times the Sun stands over the Kaaba ('over') or the point of the Earth opposite it ('opposite'), from the date shown: that point (degrees) and how near the zenith the Sun comes (degrees). */
  kaabaSun: ReadonlyArray<{ kind: 'over' | 'opposite'; unixMs: number; lat: number; lon: number; zenithDeg: number }>;
  /** The new moon chosen (the latest, or the next once the latest is three days old, unless the visitor stepped), its neighbours, and the Moon's age at the date shown (hours since the latest new moon). */
  newMoon: { unixMs: number; previousMs: number | null; nextMs: number | null; ageHours: number | null } | null;
  /** The new crescent's map while one is shown. */
  crescent: UniverseCrescent | null;
  /** Marks drawn on the globe: the qibla's path, the two latitudes, the map's places. */
  marks: { path: number; lines: number; map: number };
}

/** On foot on the Earth (src/explore/walk) as the view reports it. */
export interface UniverseWalk {
  /** 'landing' while the ground under the walker loads (the camera waits in orbit), then 'walking'. */
  state: 'landing' | 'walking';
  world: string;
  lat: number;
  lon: number;
  /** The ground and the feet, metres above sea level; heading and look (degrees: heading clockwise from north, look up positive). */
  groundM: number;
  feetM: number;
  headingDeg: number;
  pitchDeg: number;
  airborne: boolean;
  /** The last step was refused (a place the walker may not enter: Makkah, by its framing rule). */
  blocked: boolean;
  walkedM: number;
  /** Surface gravity (m/s^2), the air's pressure at the feet (kPa) and the world's mean surface temperature (degrees C), null where not known. */
  gravity: number;
  pressureKpa: number | null;
  meanTempC: number | null;
  /** The Sun's elevation (degrees) and the local apparent solar time (hours). */
  sunElevationDeg: number;
  solarTimeH: number;
  /** The terrain zoom the ground under the feet comes from, the tiles' counts, and the rings of ground filled. */
  groundZoom: number | null;
  tiles: { ready: number; loading: number; failed: number };
  rings: number;
}

/** Commands for the qibla and the new moon. */
export type UniverseIslamicCommand =
  | { kind: 'open' }
  | { kind: 'qiblaFrom'; lat: number; lon: number; name: string }
  | { kind: 'qiblaFromBelow' }
  | { kind: 'qiblaLine'; on: boolean }
  | { kind: 'golden'; on: boolean }
  | { kind: 'newMoon'; step: -1 | 1 }
  | { kind: 'evening'; evening: 0 | 1 | 2 | null };

/** One body of an experiment as the view reports it (masses in kg by one G: the Earth's GM over its mass). */
export interface UniverseLabBody {
  id: string;
  name: string;
  /** Which of the explorer's ten worlds it is, if any. */
  builtIn: BodyId | null;
  gm: number;
  massKg: number;
  radiusKm: number;
  /** Speed in the scenario's frame, and relative to the body it moves about (its primary), and the distance to it. */
  speedKmS: number;
  primary: string | null;
  relativeSpeedKmS: number | null;
  distanceKm: number | null;
  /** Its velocity relative to the primary (with none, in the scenario's frame), x, y, z: what the velocity fields edit. */
  relativeVelKmS: [number, number, number];
  escapeKmS: number;
  /** Changed or made by the visitor in this experiment. */
  edited: boolean;
  /** Keeps its identity in mergers and cannot be removed (the scene's light). */
  persistent: boolean;
  /** Its bulk density (kg/m^3). */
  densityKgM3: number;
  /** Its osculating orbit about its primary (src/sim/elements): a description of the moment, not a forecast; null with no primary. */
  orbit: { aKm: number; e: number; iDeg: number; nodeDeg: number; periapsisArgDeg: number; trueAnomalyDeg: number; periodS: number | null; periapsisKm: number; apoapsisKm: number | null; bound: boolean; hillKm: number | null } | null;
  /** Its rotation (period, s; null when it does not turn) and the tilt of its pole from its orbit's (degrees; null with no primary), and the fastest it could turn held by its own gravity (s). */
  rotation: { periodS: number | null; tiltDeg: number | null; breakupPeriodS: number };
  /** Its primary's Roche limits for it (km): inside the fluid one a fluid body is torn apart, inside the rigid one a rigid one too. */
  roche: { rigidKm: number; fluidKm: number } | null;
  /** Held in place by the visitor (an external constraint). */
  fixed: boolean;
  /** Named by the visitor (a world's own name gives way to it). */
  renamed: boolean;
  /** Its J2 (0: spherical). */
  j2: number;
}

/** A quantity the laboratory can follow over time. */
export type LabQuantity = 'distance' | 'speed' | 'eccentricity' | 'energyDrift';
/** The laboratory's palette of bodies to add (src/sim/presets): its id, kind, mass and size, and where they come from. */
export interface LabPreset {
  id: string;
  kind: 'star' | 'giant' | 'rocky' | 'moon' | 'dwarf' | 'asteroid' | 'comet';
  massKg: number;
  radiusKm: number;
  rotationH: number | null;
  source: string;
}

/** The orbital laboratory as the view reports it. */
export interface UniverseLab {
  name: string;
  seedNote: string;
  frame: string;
  epochJdTdb: number;
  /** Simulated seconds since the epoch, steps taken and the current step (s). */
  elapsedS: number;
  step: number;
  dtS: number;
  /** Requested and achieved simulated seconds per real second. */
  requestedRate: number;
  achievedRate: number;
  paused: boolean;
  failure: string | null;
  bodies: UniverseLabBody[];
  selected: string | null;
  /** Relative drift since the last intervention. */
  drift: { energy: number; momentum: number; angularMomentum: number };
  interventions: ReadonlyArray<{ step: number; t: number; kind: string; id: string }>;
  /** Collisions (src/sim/nbody, src/sim/impacts): a merger, a breakup (the target keeping its id, `created` bodies made, debris returned to the remnant for want of room) or a graze both carried on from; Leinhardt and Stewart's regime and the speed at contact; a merger's crater on a solid world (src/sim/craters: its final diameter, km, and whether complex); the impact's energy (J). */
  events: ReadonlyArray<{ t: number; kind: 'merge' | 'fragment' | 'graze'; regime: 'merge' | 'partial-accretion' | 'hit-and-run' | 'erosion' | 'super-catastrophic'; survivor: string; absorbed: string; speedKmS: number; created: number; unresolved: boolean; craterKm: number | null; craterComplex: boolean; energyJ: number }>;
  checkpoints: ReadonlyArray<{ step: number; t: number }>;
  logLength: number;
  discarded: number;
  prediction: { id: string; horizonS: number; merged: { t: number; with: string } | null; encounters: ReadonlyArray<{ with: string; t: number; distanceKm: number }> } | null;
  horizonS: number;
  /** The prediction's step against the live run's: four times coarser, the same, or four times finer. */
  accuracy: 'fast' | 'normal' | 'precise';
  /** Edits that can be undone and redone. */
  undoable: number;
  redoable: number;
  /** A body is held in place: momentum and energy are not conserved while it is. */
  constrained: boolean;
  /** How paths are drawn: each about its primary, in the scenario's frame, turning with a pair (the chosen body's primary and its partner), or turning with the chosen body's primary's own rotation (body-fixed: a satellite's path over the ground). */
  view: 'primary' | 'inertial' | 'corotating' | 'bodyfixed';
  /** The pair the turning frame turns with. */
  corotatingPair: { a: string; b: string } | null;
  /** The Lagrange points drawn: those of the chosen body and its primary. */
  lagrange: { primary: string; secondary: string } | null;
  /** The measurement asked for: distance, light time and angular size between two bodies, and the angle between two others seen from a third. */
  measure: { from: string; to: string; distanceKm: number; lightS: number; angularSizeDeg: number; via: string | null; separationDeg: number | null } | null;
  /** The quantity being followed: its body (the survivor, after a merger), samples (s, value), and what it merged into. */
  graph: { id: string; quantity: LabQuantity; points: ReadonlyArray<readonly [number, number]>; mergedInto: string | null } | null;
  /** The palette of bodies to add. */
  presets: readonly LabPreset[];
  /** Scenarios saved in this browser's library, by name. */
  library: readonly string[];
  /** A link to this scenario, or why there is none (too large). */
  share: { url: string } | { tooLarge: true; chars: number } | null;
  /** Placing a body with the pointer: about which body, and where it would go now (km from it, or null off the plane). */
  placing: { primary: string; name: string; offsetKm: number | null } | null;
  /** The chosen body's velocity arrow's tip on the canvas (client px; drag it to change the velocity), or null. */
  handle: { x: number; y: number } | null;
  /** The last save, load, export or reset, or a refusal with its reasons. */
  status: { kind: 'saved' | 'loaded' | 'exported' | 'reset' | 'error' | 'shared' | 'deleted'; detail: string[] } | null;
  /** Every body's name seen in this scenario (by id), kept after it merges or is removed. */
  names: Readonly<Record<string, string>>;
}

/** What the laboratory's interface asks of it. Masses in kg, distances km, velocities km/s relative to a body. */
export type LabCommand =
  | { kind: 'start'; seed: 'solar' | 'two' | 'three' }
  | { kind: 'select'; id: string | null }
  | { kind: 'mass'; id: string; massKg: number; keep?: 'radius' | 'density' }
  | { kind: 'radius'; id: string; radiusKm: number; keep: 'mass' | 'density' }
  | { kind: 'density'; id: string; densityKgM3: number; keep: 'mass' | 'radius' }
  | { kind: 'spin'; id: string; periodS: number; tiltDeg: number }
  | { kind: 'fixed'; id: string; fixed: boolean }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'impulse'; id: string; progradeMs: number; normalMs: number; radialMs: number }
  | { kind: 'elements'; id: string; aKm: number; e: number; iDeg: number; nodeDeg: number; periapsisArgDeg: number; trueAnomalyDeg: number }
  | { kind: 'addPreset'; preset: string; primary: string; distanceKm: number; name: string }
  | { kind: 'addLagrange'; point: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; massKg: number; radiusKm: number; name: string }
  | { kind: 'place'; on: boolean; primary?: string; name?: string; massKg?: number; radiusKm?: number; preset?: string | null }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'accuracy'; level: 'fast' | 'normal' | 'precise' }
  | { kind: 'view'; view: 'primary' | 'inertial' | 'corotating' | 'bodyfixed' }
  | { kind: 'lagrange'; on: boolean }
  | { kind: 'measure'; from: string | null; to: string | null; via?: string | null }
  | { kind: 'track'; id: string | null; quantity: LabQuantity }
  | { kind: 'saveAs'; name: string }
  | { kind: 'loadSaved'; name: string }
  | { kind: 'deleteSaved'; name: string }
  | { kind: 'share' }
  | { kind: 'importShared'; data: string }
  | { kind: 'removeMany'; ids: string[] }
  | { kind: 'duplicateMany'; ids: string[] }
  | { kind: 'velocity'; id: string; relativeKmS: [number, number, number] }
  | { kind: 'addOrbit'; primary: string; distanceKm: number; massKg: number; radiusKm: number; name: string }
  | { kind: 'addState'; relativeTo: string; posKm: [number, number, number]; velKmS: [number, number, number]; massKg: number; radiusKm: number; name: string }
  | { kind: 'duplicate'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'seek'; step: number }
  | { kind: 'replay' }
  | { kind: 'reset' }
  | { kind: 'horizon'; seconds: number }
  | { kind: 'save' }
  | { kind: 'restoreSaved' }
  | { kind: 'export' }
  | { kind: 'import'; text: string };

/** The time machine as the view reports it. */
export interface UniverseTime {
  /** Explorer seconds per real second, as set (negative: backwards); the clock runs at it unless paused (at real time during a trip). */
  rate: number;
  paused: boolean;
  /** The clock stopped at an end of the data's span, or null. */
  edge: 'start' | 'end' | null;
  /** The span of dates the explorer can show (Unix ms). */
  startMs: number;
  endMs: number;
  /** The date shown in the Umm al-Qura calendar (its civil day, from midnight UTC); null in the laboratory or where the browser lacks that calendar. */
  hijri: { day: number; month: number; year: number } | null;
}

/**
 * Commands for the explorer's Living Earth: fly to a place on the Earth (degrees, and the width of
 * ground to frame, km), choose the imagery (cloud-free, or the last whole day's), and turn its live
 * layers on or off. The interface sends them; the explorer ignores what it cannot do.
 */
export type EarthCommand =
  | { kind: 'goto'; lat: number; lon: number; viewKm: number }
  | { kind: 'imagery'; mode: 'clear' | 'today' }
  | { kind: 'layer'; layer: EarthLayer; on: boolean }
  | { kind: 'select'; id: string | null }
  /** Names on the ground for a set of the field notes' places (src/explore/field-notes), or none. */
  | { kind: 'markers'; set: 'atlas' | 'prophets' | null }
  /** On foot: a walk at a place (degrees), or at the point beneath the camera; and back to the view from above. */
  | { kind: 'walk'; lat?: number; lon?: number }
  | { kind: 'walkEnd' }
  /** On-screen walking (touch): Forward or Back held (1, -1, or 0), Jump held. */
  | { kind: 'walkPad'; forward: number; jump: boolean };

/** The Living Earth's live layers. */
export type EarthLayer = 'satellites' | 'quakes';

/** The explorer as the engine hosts it: the experience plus what its UI and route need. */
export interface UniverseModule extends ExperienceModule {
  readonly id: 'universe';
  load(ctx: UniverseContext): Promise<void>;
  enter(ctx: UniverseContext): void;
  /** Applies a route: a body to show (null: the explorer's default) and a pinned UTC Julian date (null: now). */
  configure(options: { body: BodyId | null; jdUtc: number | null; reducedMotion: boolean; stretch?: boolean; lab?: boolean; labShare?: string }): void;
  /** Flies to a body: an eased flight in log distance, never a jump (a dimmed cut with reduced motion). */
  focus(body: BodyId): void;
  view(): UniverseView;
  /** Bodies are framed in the part of the view the interface leaves clear. */
  setInsets(insets: ViewInsets): void;
  /** Test and capture hook: puts the camera at a pose at once, with no flight (and the exposure adapted). */
  place(pose: UniversePose): void;
  /** Applies a detail level: what the bodies draw and stream, the stars, bloom and the canvas's pixel ratio. */
  setDetail(detail: ExploreDetail): void;
  /** The visitor's detail choice: 'auto' (the governor decides) or a tier to keep. */
  setDetailChoice(choice: 'auto' | ExploreTier): void;
  /**
   * One frame's real duration (s), its GPU time (ms) when the renderer measures it, and the
   * display's frame interval (s) as the engine has learned it since the page opened: the quality
   * governor's input.
   */
  sampleFrame(frameSeconds: number, gpuMs: number | null, intervalSeconds: number): void;
  /** Stops a trip (the camera coasts to rest in free flight) or orbits the body the camera is near; false when there was nothing to do. */
  steer(command: UniverseSteer): boolean;
  /** Living Earth commands (src/explore/earth-tiles and src/explore/living). */
  earth(command: EarthCommand): void;
  /** Time machine commands (src/explore/time). */
  time(command: UniverseTimeCommand): void;
  /** The sky's layers (src/explore/sky). */
  sky(command: UniverseSkyCommand): void;
  /** The orbital laboratory (src/explore/lab). */
  lab(command: LabCommand): void;
  /** The qibla and the new moon (src/explore/islamic). */
  islamic(command: UniverseIslamicCommand): void;
}

/** A camera pose around a body, for tests and frame captures. */
export interface UniversePose {
  body: BodyId;
  /** From the body's centre, km. */
  distanceKm: number;
  /** Degrees around and above the direction the camera is placed in (see `from`). */
  azimuthDeg?: number;
  elevationDeg?: number;
  /**
   * 'sun' (default): start from the body-to-Sun direction, so azimuth 0 looks at the lit face.
   * A body id: start from the far side of the focus from that body, so it shows behind the focus.
   */
  from?: 'sun' | BodyId;
}

export type Route =
  | { name: 'home' }
  | { name: 'chapter'; chapter: ChapterId; t: number | null }
  | { name: 'sources' }
  /** The solar-system explorer, optionally on a body and at a pinned UTC Julian date; or its orbital laboratory. */
  | { name: 'universe'; body: BodyId | null; jd: number | null; lab?: boolean; share?: string };

export interface AppEvents {
  route: { route: Route };
  state: { state: TimelineState; chapter: ChapterId | null };
  /** Emitted at most ~10×/s while a chapter is active. */
  time: { chapter: ChapterId; t: number; duration: number };
  /** A cue became active (true) or inactive (false). Verse/hadith/caption cues use this to fade whole. */
  cue: { chapter: ChapterId; cue: Cue; active: boolean };
  /** A chapter was entered; the panel renders its content. */
  chapter: { chapter: ChapterId; content: ChapterContent };
  paused: { paused: boolean };
  /** The film clock was held or let go, or the set of holds changed (see AppCommands.holdFilm). */
  held: { held: boolean; reasons: readonly string[] };
  /** An explicit jump within the active chapter (the slider, a shortcut, a deep link to the same chapter). */
  seek: { chapter: ChapterId; t: number };
  mode: { mode: 'cinematic' | 'explore' };
  quality: { profile: QualityProfile; reason: 'initial' | 'governor' | 'override' };
  renderer: { backend: 'webgpu' | 'webgl2' };
  loading: { chapter: ChapterId; progress: number };
  /** The engine switched between the film and the universe (emitted when the switch starts). */
  experience: { experience: ExperienceId };
  /** The universe finished loading and is on screen (true), or it left the screen (false). */
  universe: { ready: boolean };
  /** Non-scripture error text only. */
  error: { message: string };
}

export interface AppCommands {
  goTo(chapter: ChapterId, t?: number): Promise<void>;
  home(): void;
  play(): void;
  pause(): void;
  togglePause(): void;
  seek(t: number): void;
  next(): void;
  prev(): void;
  setMode(mode: 'cinematic' | 'explore'): void;
  /** Forwards a panel control to the active chapter (null: give control back to the film). */
  interact(id: string, value: number | null): void;
  /**
   * Holds the film clock (intro, chapter time and outro) while a reader is busy with something
   * the film must not run past, e.g. the letter analysis. The scene keeps moving and a pause stays
   * a pause; no cue fires and the chapter cannot end until every hold is released. Holds belong to
   * the chapter: leaving it drops them. The returned function releases this hold (idempotent).
   */
  holdFilm(reason: string): () => void;
  /**
   * Opens the solar-system explorer (true scale), optionally on a body. From a chapter, the
   * explorer remembers where the film was, so closeUniverse() returns there.
   */
  openUniverse(body?: BodyId | null): void;
  /** Leaves the explorer for the film where the visitor came from (the home screen after a deep link). */
  closeUniverse(): void;
  /** In the explorer: flies to a body. */
  focusBody(body: BodyId): void;
  /** The explorer's interface reports what it covers, so bodies are framed in the clear part of the view. */
  setViewInsets(insets: ViewInsets): void;
  /** The explorer's detail: 'auto', or a tier the visitor chose (kept until they choose again). */
  setUniverseDetail(choice: 'auto' | ExploreTier): void;
  /** In the explorer: stop a trip, or orbit the body the camera is near. False when there was nothing to do. */
  steerUniverse(command: UniverseSteer): boolean;
  /** In the explorer: a Living Earth command (fly to a place, imagery, live layers). */
  earthCommand(command: EarthCommand): void;
  /** In the explorer: a time machine command (pause, faster, slower, backwards, now, a date). */
  universeTime(command: UniverseTimeCommand): void;
  /** In the explorer: show or hide a layer of the sky. */
  universeSky(command: UniverseSkyCommand): void;
  /** In the laboratory: an edit, a seek, a save (src/explore/lab). */
  universeLab(command: LabCommand): void;
  /** In the explorer: the qibla and the new moon (src/explore/islamic). */
  universeIslamic(command: UniverseIslamicCommand): void;
  /** Opens the orbital laboratory on a copy of the system the explorer shows; closes it back to the explorer. */
  openLab(): void;
  closeLab(): void;
}

/* ------------------------------------------------------------------ */
/* App surface handed to the UI (src/ui/index.ts → mountUI(app, root))  */
/* ------------------------------------------------------------------ */

export interface EventBus<E> {
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void;
  emit<K extends keyof E>(type: K, payload: E[K]): void;
}

export interface I18n {
  readonly locale: 'en' | 'ar';
  readonly dir: 'ltr' | 'rtl';
  /** Formats an ICU message. Missing keys return the key itself and log once in dev. */
  t(key: I18nKey, values?: Record<string, string | number>): string;
  has(key: I18nKey): boolean;
  /** Locale-aware number formatting used for science values. */
  number(value: number, maximumFractionDigits?: number): string;
  /**
   * Adds a message file loaded with a lazy chunk (the explorer's, src/i18n/en.explore.json, with its
   * interface). A key it shares with what is loaded is an error; the same file added again is ignored.
   */
  extend(name: string, messages: unknown): void;
}

/** Static chapter registry entry (src/chapters/index.ts). */
export interface ChapterMeta {
  id: ChapterId;
  number: number;
  titleKey: I18nKey;
  /** Short label for the timeline stop. */
  stopKey: I18nKey;
  /** Human label for the epoch, e.g. "≈ 380,000 years". */
  epochKey: I18nKey;
  /**
   * Seconds after the beginning, for log-scale placement.
   * 'before' = before time (far left), 'end' = the end (far right).
   */
  epoch: number | 'before' | 'end';
  milestone: 'M1' | 'M2' | 'M3';
  /**
   * When played in sequence straight after this chapter, the film continues without
   * fading to black: that chapter ends exactly in this one's opening state.
   */
  continuesFrom?: ChapterId;
  /**
   * The chapter's era has the solar system in it, so its outro and free-look offer the
   * solar-system explorer (Chapters 7 to 10; earlier eras came before the Sun formed).
   */
  opensUniverse?: boolean;
  /** Lazy loader; absent for chapters not yet built. */
  load?: () => Promise<{ default: ChapterFactory }>;
}

export interface App extends AppCommands {
  readonly events: EventBus<AppEvents>;
  readonly data: DataStore;
  readonly i18n: I18n;
  readonly chapters: readonly ChapterMeta[];
  readonly state: TimelineState;
  readonly chapter: ChapterId | null;
  /** Chapter content of the active chapter, once loaded. */
  readonly content: ChapterContent | null;
  readonly time: number;
  readonly paused: boolean;
  /** True while any holdFilm() hold is in place. */
  readonly held: boolean;
  readonly mode: 'cinematic' | 'explore';
  /** The film, or the universe (from the moment it is asked for until it has handed back). */
  readonly experience: ExperienceId;
  readonly quality: QualityProfile;
  readonly backend: 'webgpu' | 'webgl2';
  readonly reducedMotion: boolean;
  readonly assets: AssetLoader;
  /** HUD tags and scale for this frame from the active experience (cheap; the UI polls it once per animation frame). */
  hud(): HudState;
  /** The explorer's camera and focus while it is on screen, else null (cheap; polled per frame by its UI). */
  universe(): UniverseView | null;
}
