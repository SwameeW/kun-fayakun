/**
 * Shared contracts for Kun Fayakun.
 *
 * Every module (core, ui, chapters, scripts) builds against these types.
 * Change them only with care: data files, content.json files and the
 * validator all depend on the exact shapes below.
 */
import type { PerspectiveCamera, Scene, Texture, WebGPURenderer } from 'three/webgpu';

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

export type FigureId = 'bbn-abundances' | 'cmb-legend';

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
  /** Easing used to arrive at this keyframe from the previous one. */
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
  /** Preferred CMB texture width (4096 or 2048). */
  cmbWidth: 4096 | 2048;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: { tier: 'high', particles: 2_000_000, dprCap: 2, bloom: true, cmbWidth: 4096 },
  mid: { tier: 'mid', particles: 300_000, dprCap: 1.5, bloom: true, cmbWidth: 4096 },
  low: { tier: 'low', particles: 80_000, dprCap: 1.5, bloom: false, cmbWidth: 2048 },
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
  /** Remove from scene; keep GPU resources for a possible re-enter. */
  exit(): void;
  /** Free all GPU resources. */
  dispose(): void;
}

export type ChapterFactory = () => ChapterModule;

/* ------------------------------------------------------------------ */
/* App events and commands (core ⇄ ui)                                   */
/* ------------------------------------------------------------------ */

export type TimelineState = 'idle' | 'loading' | 'intro' | 'playing' | 'explore' | 'outro';

export type Route =
  | { name: 'home' }
  | { name: 'chapter'; chapter: ChapterId; t: number | null }
  | { name: 'sources' };

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
  mode: { mode: 'cinematic' | 'explore' };
  quality: { profile: QualityProfile; reason: 'initial' | 'governor' | 'override' };
  renderer: { backend: 'webgpu' | 'webgl2' };
  loading: { chapter: ChapterId; progress: number };
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
  readonly mode: 'cinematic' | 'explore';
  readonly quality: QualityProfile;
  readonly backend: 'webgpu' | 'webgl2';
  readonly reducedMotion: boolean;
  readonly assets: AssetLoader;
}
