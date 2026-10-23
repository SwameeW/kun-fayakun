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
export type BodyId = 'sun' | 'earth' | 'moon' | 'jupiter' | 'saturn';

export const BODY_IDS: readonly BodyId[] = ['sun', 'earth', 'moon', 'jupiter', 'saturn'];

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
export type UniverseIllustration = 'sun-surface' | 'fine-detail' | 'cloud-drift' | 'night-side' | 'earthshine' | 'band-drift' | 'ring-particles';

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

/** The explorer as the engine hosts it: the experience plus what its UI and route need. */
export interface UniverseModule extends ExperienceModule {
  readonly id: 'universe';
  load(ctx: UniverseContext): Promise<void>;
  enter(ctx: UniverseContext): void;
  /** Applies a route: a body to show (null: the explorer's default) and a pinned UTC Julian date (null: now). */
  configure(options: { body: BodyId | null; jdUtc: number | null; reducedMotion: boolean }): void;
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
  /** The solar-system explorer, optionally on a body and at a pinned UTC Julian date. */
  | { name: 'universe'; body: BodyId | null; jd: number | null };

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
