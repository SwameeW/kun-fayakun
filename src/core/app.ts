import { MathUtils, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { CHAPTERS, isPlayable } from '../chapters/index';
import { createAudioEngine } from './audio';
import { createFrameCadence } from './cadence';
import { CameraDirector, DEFAULT_FOV, FAR, NEAR } from './camera';
import { createChapterLoader, type ChapterLoader } from './chapter-loader';
import { createDataStore } from './data';
import { createEventBus } from './events';
import { createExploreController, type ExploreController } from './explore';
import { exposeTestHandle, setHook } from './hooks';
import { createAssetLoader } from './loader';
import type { LaunchParams } from './params';
import { createPerfMonitor, type PerfMonitor } from './perf';
import { createExposureControl, createPostPipeline, type EngineExposure, type PostPipeline } from './post';
import { chooseInitialTier, createQualityGovernor, isMobileDevice, type QualityGovernor } from './quality';
import { createResolutionGovernor, type ResolutionGovernor } from './resolution';
import { createRenderer, RENDERER_UNAVAILABLE_MESSAGE, type BackendName, type RendererHandle } from './renderer';
import { createRouter, type Router } from './router';
import { Timeline } from './timeline';
import { UniverseHost } from './universe-host';
import type {
  App,
  AppEvents,
  AssetLoader,
  BodyId,
  ChapterContent,
  ChapterContext,
  ChapterId,
  ExperienceId,
  ExposureControl,
  I18n,
  QualityProfile,
  Route,
  TimelineState,
  HudState,
  ScreenLabel,
  UniverseGraphics,
  UniverseSteer,
  EarthCommand,
  UniverseTimeCommand,
  UniverseIslamicCommand,
  UniverseSkyCommand,
  LabCommand,
  UniverseView,
  ViewInsets,
} from './types';
import type { ExploreTier } from '../explore/detail';

export interface AppOptions {
  canvas: HTMLCanvasElement;
  i18n: I18n;
  params: LaunchParams;
}

export interface KunFayakunApp extends App {
  /** Initialises the renderer (data is already loading), starts the frame loop and follows the URL. */
  start(options?: { autoplay?: boolean }): Promise<void>;
  dispose(): void;
}

interface Graphics {
  handle: RendererHandle;
  post: PostPipeline;
  governor: QualityGovernor;
  resolution: ResolutionGovernor;
}

interface NavOptions {
  t?: number;
  skipIntro: boolean;
  /** After the outro, continue with the next playable chapter (else return to the timeline). */
  sequence: boolean;
  history: 'push' | 'replace' | 'none';
  /** Start paused (returning from the explorer to a film the reader had paused). */
  paused?: boolean;
}

/** Where the film was when the visitor opened the explorer from it, so closing it goes back there. */
interface FilmOrigin {
  chapter: ChapterId;
  t: number;
  paused: boolean;
  sequence: boolean;
}

/** Frame steps longer than this are clamped so a hitch never skips content. */
const MAX_FRAME_DT = 0.1;
/** ?tier= read on the explorer's detail ladder (a fixed film tier fixes the explorer's too). */
const DETAIL_FOR_TIER: Readonly<Record<QualityProfile['tier'], ExploreTier>> = { high: 'high', mid: 'medium', low: 'low' };
/** Upper bound for one __kf.step call (an hour of film at 60 fps), so a typo cannot hang the page. */
const MAX_STEP_FRAMES = 216_000;
const EMPTY_HUD: HudState = { labels: [], metresPerPixel: null };

/** A video being recorded: the canvas it is drawn into (the view, and its credits below it), the lines and when they were last asked for, and the recorder. */
interface Recording {
  out: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  height: number;
  rows: number;
  lines: () => readonly string[];
  linesAt: number;
  wrapped: string[];
  recorder: MediaRecorder;
  done: Promise<Blob | null>;
}

/** A picture's or a recording's credits: the type's size for its width, its lines wrapped to it, and the band's height. */
function creditLayout(g: CanvasRenderingContext2D, width: number, lines: readonly string[]): { band: number; rows: number; wrapped: string[] } {
  const scale = Math.max(1, width / 1600);
  const fontPx = Math.round(15 * scale);
  const lineH = Math.round(fontPx * 1.45);
  const pad = Math.round(14 * scale);
  g.font = `${String(fontPx)}px system-ui, sans-serif`;
  const wrapped: string[] = [];
  for (const line of lines) {
    let current = '';
    for (const word of line.split(/\s+/u)) {
      const next = current === '' ? word : `${current} ${word}`;
      if (g.measureText(next).width > width - 2 * pad && current !== '') {
        wrapped.push(current);
        current = word;
      } else current = next;
    }
    if (current !== '') wrapped.push(current);
  }
  return { band: wrapped.length > 0 ? pad * 2 + wrapped.length * lineH : 0, rows: wrapped.length, wrapped };
}

/** The credits band below a picture: white on near-black, a line each. */
function drawCredits(g: CanvasRenderingContext2D, width: number, top: number, band: number, wrapped: readonly string[]): void {
  if (band <= 0) return;
  const scale = Math.max(1, width / 1600);
  const fontPx = Math.round(15 * scale);
  const lineH = Math.round(fontPx * 1.45);
  const pad = Math.round(14 * scale);
  g.fillStyle = '#07080c';
  g.fillRect(0, top, width, band);
  g.fillStyle = 'rgba(255,255,255,0.86)';
  g.font = `${String(fontPx)}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  wrapped.forEach((line, i) => {
    g.fillText(line, pad, top + pad + i * lineH);
  });
}
const projected = new Vector3();

/** Longest a chapter waits for its GPU pipelines to compile before playing anyway. */
const WARM_UP_TIMEOUT_MS = 4000;
/** Wait before prefetching the next chapter, so it does not compete with the intro. */
const PREFETCH_DELAY_MS = 1500;

/** Non-scripture error text; ui.error.* keys win when the UI defines them. */
const ERRORS = {
  renderer: ['ui.error.renderer', RENDERER_UNAVAILABLE_MESSAGE],
  chapter: ['ui.error.chapter', 'This chapter could not be loaded. Please try again.'],
  data: ['ui.error.data', 'Some reference data could not be loaded, so parts of the panel may be missing.'],
  deviceLost: ['ui.error.deviceLost', 'The graphics device was lost. Please reload the page to continue.'],
  universe: ['ui.error.universe', 'The solar system explorer could not be loaded. Please try again.'],
} as const;

class Engine implements KunFayakunApp {
  readonly events = createEventBus<AppEvents>();
  readonly chapters = CHAPTERS;
  readonly assets = createAssetLoader();
  readonly data = createDataStore(this.assets);
  readonly i18n: I18n;

  private readonly canvas: HTMLCanvasElement;
  private readonly params: LaunchParams;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(DEFAULT_FOV, 1, NEAR, FAR);
  private readonly audio = createAudioEngine();
  private readonly motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly exposure: EngineExposure;
  private readonly chapterExposure: ExposureControl;
  private readonly perf: PerfMonitor;
  private readonly explore: ExploreController;
  private readonly director: CameraDirector;
  private readonly timeline: Timeline;
  private readonly loader: ChapterLoader;
  private readonly router: Router;
  private readonly universeHost: UniverseHost;
  /** Set when the explorer was opened from a chapter; closing the explorer returns there. */
  private origin: FilmOrigin | null = null;
  /**
   * The explorer's history entry sits directly on top of an entry of ours (it was opened from a
   * page here, or reached again with Forward), so closing it is a step back in the history.
   */
  private universeBack = false;
  /** The laboratory's address sits right on top of the explorer's (Back returns to it). */
  private labBack = false;
  /** The router reports the initial address first; anything after that is navigation within the app. */
  private routed = false;

  private reduced: boolean;
  private backendName: BackendName;
  private profile: QualityProfile;
  private gfx: Graphics | null = null;
  private resolveGraphics: (gfx: Graphics | null) => void = () => undefined;
  private readonly graphicsReady = new Promise<Graphics | null>((resolve) => {
    this.resolveGraphics = resolve;
  });
  private navToken = 0;
  private sequence = false;
  /** The chapter was paused by opening the Sources page (not by the reader). */
  private pausedForSources = false;
  private lastFrame: number | null = null;
  private firstFrameRendered = false;
  private chapterReadyPending: ChapterId | null = null;
  private prefetchTimer = 0;
  /** True while a newly entered chapter compiles its pipelines; frames neither render nor advance the clock. */
  private warming = false;
  /** Set by the __kf.step test hook: frames still render, but only step() advances time. */
  private manualClock = false;
  /** A picture asked for (capturePicture): taken right after the next frame is drawn, while its pixels are there to copy. */
  private pendingCapture: { lines: readonly string[]; resolve: (blob: Blob | null) => void } | null = null;
  /** A video being recorded (startRecording): its canvas, credits and recorder. */
  private recording: Recording | null = null;
  /** The last GPU time measured (timestamp queries under ?profile=1 or ?gpuTime=1), ms. */
  private lastGpuMs: number | null = null;
  /** The display's frame interval, for the explorer's governor (the film's governors keep their own). */
  private readonly cadence = createFrameCadence();
  private universeGraphics: UniverseGraphics | null = null;
  private readonly loggedErrors = new Set<string>();

  constructor(options: AppOptions) {
    this.canvas = options.canvas;
    this.i18n = options.i18n;
    this.params = options.params;
    this.reduced = this.params.reducedMotion ?? this.motionQuery.matches;
    this.backendName = this.params.forceWebGL || !('gpu' in navigator) ? 'webgl2' : 'webgpu';
    this.profile = chooseInitialTier({
      backend: this.backendName,
      gpu: { description: '', software: false },
      override: this.params.tier,
    }).profile;

    this.exposure = createExposureControl({ reducedMotion: this.reduced });
    const exposure = this.exposure;
    // Chapters may only set a target; fades stay with the engine.
    this.chapterExposure = {
      setTarget: (value) => {
        exposure.setTarget(value);
      },
      get current() {
        return exposure.current;
      },
    };
    this.perf = createPerfMonitor();
    this.explore = createExploreController(this.camera, this.canvas, { gentle: () => this.reduced });
    const director = new CameraDirector(this.camera, this.explore, () => this.reduced);
    this.director = director;
    this.timeline = new Timeline({
      events: this.events,
      camera: director,
      audio: this.audio,
      exposure: this.exposure,
      onChapterEnd: (id) => {
        this.onChapterEnd(id);
      },
      continuesAfter: (id) => {
        const next = this.sequence ? this.neighbour(id, 1) : null;
        return next !== null && this.chapters.find((c) => c.id === next)?.continuesFrom === id;
      },
    });
    this.loader = createChapterLoader({
      makeContext: (assets) => this.makeContext(assets),
      assets: this.assets,
      currentTier: () => this.profile.tier,
    });
    this.router = createRouter(this.events, (route) => {
      this.onRoute(route);
    });
    this.universeHost = new UniverseHost({
      events: this.events,
      exposure: this.exposure,
      resetLens: () => {
        this.director.resetLens();
      },
      makeContext: (exposure) => Object.assign(this.makeContext(this.assets, exposure), { graphics: this.pictureControl() }),
      claimPicture: () => {
        // The explorer scales its scene pass instead of the canvas.
        this.gfx?.handle.setResolutionScale(1);
      },
      restorePicture: () => {
        const gfx = this.gfx;
        if (!gfx) return;
        gfx.post.setSceneScale(1);
        gfx.post.setBloom(this.profile.bloom);
        gfx.handle.setDprCap(this.profile.dprCap);
        gfx.handle.setResolutionScale(gfx.resolution.scale);
      },
      stopFilm: () => {
        this.timeline.stop();
        return this.timeline.whenDark();
      },
      graphics: () => this.graphicsReady,
      warmUp: async () => {
        if (this.gfx) await this.warmUp(this.gfx);
      },
      nextToken: () => ++this.navToken,
      isCurrent: (token) => token === this.navToken,
      onError: (err) => {
        console.error('[app] Loading the solar system explorer failed', err);
        this.emitError('universe');
        // Back to where the visitor came from, replacing the explorer's address (as a failed chapter does).
        const origin = this.origin;
        if (origin) {
          this.returnToOrigin(origin, 'replace');
        } else {
          this.router.navigate({ name: 'home' }, { replace: true });
          this.leaveChapter();
        }
      },
    });

    this.events.on('state', ({ state, chapter }) => {
      setHook('data-state', state);
      setHook('data-chapter', chapter);
    });
    setHook('data-state', 'idle');
    setHook('data-experience', 'film');
    setHook('data-reduced-motion', String(this.reduced));
    this.motionQuery.addEventListener('change', this.onMotionPreference);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.data.ready.catch((err: unknown) => {
      console.error('[data] Loading data/*.json failed', err);
      this.emitError('data');
    });
    exposeTestHandle({
      app: this,
      frameStats: () => this.perf.stats(),
      resetFrameStats: () => {
        this.perf.reset();
      },
      step: (frames = 1, dt = 1 / 60) => {
        this.step(frames, dt);
      },
      universe: {
        state: () => this.universe(),
        place: (pose) => {
          const module = this.universeHost.active;
          if (!module) throw new Error('__kf.universe.place: the explorer is not on screen');
          module.place(pose);
          // A test hook moves the camera at once; the exposure goes with it rather than slewing for seconds.
          this.exposure.jump();
        },
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* App state                                                         */
  /* ---------------------------------------------------------------- */

  get state(): TimelineState {
    return this.timeline.state;
  }
  get chapter(): ChapterId | null {
    return this.timeline.chapter;
  }
  get content(): ChapterContent | null {
    return this.timeline.content;
  }
  get time(): number {
    return this.timeline.time;
  }
  get paused(): boolean {
    return this.timeline.paused;
  }
  get held(): boolean {
    return this.timeline.held;
  }
  get mode(): 'cinematic' | 'explore' {
    return this.timeline.mode;
  }
  get experience(): ExperienceId {
    return this.universeHost.requested ? 'universe' : 'film';
  }
  get quality(): QualityProfile {
    return this.profile;
  }
  get backend(): BackendName {
    return this.backendName;
  }
  get reducedMotion(): boolean {
    return this.reduced;
  }

  /* ---------------------------------------------------------------- */
  /* Startup                                                           */
  /* ---------------------------------------------------------------- */

  async start(options?: { autoplay?: boolean }): Promise<void> {
    let gfx: Graphics | null = null;
    try {
      gfx = await this.initGraphics();
    } catch (err) {
      console.error('[renderer]', err);
      this.emitError('renderer');
    }
    this.resolveGraphics(gfx);
    this.router.start();
    if (options?.autoplay && this.router.current.name === 'home') this.play();
  }

  private async initGraphics(): Promise<Graphics> {
    const handle = await createRenderer(this.canvas, { forceWebGL: this.params.forceWebGL, trackTimestamp: this.timesGpu });
    this.backendName = handle.backend;
    const { profile, reason } = chooseInitialTier({ backend: handle.backend, gpu: handle.gpu, override: this.params.tier });
    this.profile = profile;
    handle.setDprCap(profile.dprCap);
    handle.onResize((width, height) => {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    });
    handle.renderer.onDeviceLost = (info) => {
      console.error('[renderer] Device lost', info);
      this.emitError('deviceLost');
    };
    const post = createPostPipeline(handle.renderer, this.scene, this.camera, { bloom: profile.bloom });
    const governor = createQualityGovernor(profile, { enabled: this.params.tier === null });
    governor.suspend();
    // A fixed tier (tests, benchmarks) or profiling also holds the render scale at 1.
    const resolution = createResolutionGovernor({ enabled: this.params.tier === null && !this.params.profile });
    this.assets.attachRenderer(handle.renderer);
    const gfx: Graphics = { handle, post, governor, resolution };
    this.gfx = gfx;

    setHook('data-backend', handle.backend);
    setHook('data-tier', profile.tier);
    this.events.emit('renderer', { backend: handle.backend });
    this.events.emit('quality', { profile, reason });
    void handle.renderer.setAnimationLoop(this.frame);
    return gfx;
  }

  /** The services a chapter gets; the explorer passes its own exposure (with its veil). */
  private makeContext(assets: AssetLoader): ChapterContext;
  private makeContext<E extends ExposureControl>(assets: AssetLoader, exposure: E): ChapterContext & { exposure: E };
  private makeContext(assets: AssetLoader, exposure?: ExposureControl): ChapterContext {
    const renderer = (): RendererHandle['renderer'] => {
      if (!this.gfx) throw new Error('Renderer not initialised');
      return this.gfx.handle.renderer;
    };
    const backend = (): BackendName => this.backendName;
    const quality = (): QualityProfile => this.profile;
    const reduced = (): boolean => this.reduced;
    return {
      get renderer() {
        return renderer();
      },
      get backend() {
        return backend();
      },
      get quality() {
        return quality();
      },
      get reducedMotion() {
        return reduced();
      },
      scene: this.scene,
      camera: this.camera,
      assets,
      data: this.data,
      exposure: exposure ?? this.chapterExposure,
      audio: this.audio,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Frame loop                                                        */
  /* ---------------------------------------------------------------- */

  private readonly frame = (now: number): void => {
    const gfx = this.gfx;
    if (!gfx) return;
    if (this.warming) {
      this.lastFrame = null;
      return;
    }
    const raw = this.lastFrame === null ? 0 : (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    try {
      if (raw > 0) {
        this.perf.record(raw * 1000);
        // Under a manual clock the tier and render scale stay fixed, so stepped frames are reproducible.
        if (!this.manualClock) {
          // The display's own rate, learned from every frame since the page opened (light ones included).
          this.cadence.sample(raw);
          if (this.universeHost.owns) {
            // The explorer governs its own detail ladder and render scale; the film's governors rest.
            this.universeHost.sample(raw, this.timesGpu ? this.lastGpuMs : null, this.cadence.interval);
          } else {
            const scale = gfx.resolution.sample(raw);
            if (scale !== null) gfx.handle.setResolutionScale(scale);
            const lower = gfx.governor.sample(raw);
            if (lower) this.applyQuality(lower, 'governor');
          }
        }
      }
      this.advance(gfx, this.manualClock ? 0 : Math.min(raw, MAX_FRAME_DT));
      gfx.post.render();
      if (this.pendingCapture) this.takePicture(this.pendingCapture);
      if (this.recording) this.recordFrame(this.recording);
      this.measure(gfx);
    } catch (err) {
      this.logOnce('[frame]', err);
      return;
    }
    if (!this.firstFrameRendered) {
      this.firstFrameRendered = true;
      setHook('data-ready', 'true');
    }
    this.universeHost.afterFrame();
    const pending = this.chapterReadyPending;
    if (pending !== null && this.timeline.chapter === pending && this.timeline.content) {
      this.chapterReadyPending = null;
      setHook('data-chapter-ready', pending);
      this.afterChapterReady(pending);
    }
  };

  setExposureBias(stops: number): void {
    this.exposure.setBias(stops);
  }

  get exposureBiasStops(): number {
    return this.exposure.biasStops;
  }

  capturePicture(lines: readonly string[]): Promise<Blob | null> {
    this.pendingCapture?.resolve(null);
    return new Promise((resolve) => {
      this.pendingCapture = { lines, resolve };
    });
  }

  /**
   * Starts recording the view as a video (ledger CR-3), with its credits in a band below it (the lines
   * asked for again each second, so a flight's place stays right): each frame copied as it is drawn,
   * into a canvas the browser records. False where the browser cannot record a canvas.
   */
  startRecording(lines: () => readonly string[]): boolean {
    if (this.recording || typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const width = this.canvas.width;
    const height = this.canvas.height;
    const out = document.createElement('canvas');
    const g = out.getContext('2d');
    if (!type || !g || width === 0 || height === 0) return false;
    const layout = creditLayout(g, width, lines());
    out.width = width;
    out.height = height + layout.band;
    const recorder = new MediaRecorder(out.captureStream(30), { mimeType: type });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const done = new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        resolve(chunks.length > 0 ? new Blob(chunks, { type: type.split(';')[0] }) : null);
      };
    });
    this.recording = { out, g, height, rows: layout.rows, lines, linesAt: 0, wrapped: layout.wrapped, recorder, done };
    recorder.start(1000);
    return true;
  }

  /** Stops the recording; the video, or null when nothing was recorded. */
  stopRecording(): Promise<Blob | null> {
    const r = this.recording;
    if (!r) return Promise.resolve(null);
    this.recording = null;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    return r.done;
  }

  /** Copies the frame just drawn into the recording, and its credits below (their lines refreshed each second). */
  private recordFrame(r: Recording): void {
    const now = performance.now();
    if (now - r.linesAt > 1000) {
      r.linesAt = now;
      r.wrapped = creditLayout(r.g, r.out.width, r.lines()).wrapped.slice(0, r.rows);
    }
    try {
      r.g.drawImage(this.canvas, 0, 0);
    } catch {
      return;
    }
    drawCredits(r.g, r.out.width, r.height, r.out.height - r.height, r.wrapped);
  }

  /**
   * Copies the frame just drawn (still the canvas's current image in this task) into a picture, and
   * sets its credits in a band below it: white on near-black, a line each, wrapped to the width.
   */
  private takePicture(capture: { lines: readonly string[]; resolve: (blob: Blob | null) => void }): void {
    this.pendingCapture = null;
    const source = this.canvas;
    const width = source.width;
    const height = source.height;
    const out = document.createElement('canvas');
    const g = out.getContext('2d');
    if (!g || width === 0 || height === 0) {
      capture.resolve(null);
      return;
    }
    const layout = creditLayout(g, width, capture.lines);
    out.width = width;
    out.height = height + layout.band;
    try {
      g.drawImage(source, 0, 0);
    } catch {
      capture.resolve(null);
      return;
    }
    drawCredits(g, width, height, layout.band, layout.wrapped);
    out.toBlob((blob) => {
      capture.resolve(blob);
    }, 'image/png');
  }

  /** Moves the active experience (the film clock, or the explorer), the exposure and the grain on by dt seconds. */
  private advance(gfx: Graphics, dt: number): void {
    // The explorer takes the frame only once the film has faded out and been removed, and gives
    // it back only after its own fade, so exactly one experience moves the scene at a time.
    const universe = this.universeHost.owns;
    if (universe) this.universeHost.update(dt);
    else this.timeline.update(dt);
    this.exposure.update(dt);
    // The explorer's veil (its fade in and out, its reduced-motion cuts) dims after the exposure.
    gfx.handle.renderer.toneMappingExposure = this.exposure.current * (universe ? this.universeHost.veil : 1);
    // The explorer's exposure spans seven stops: its bloom is judged by what is bright on screen.
    gfx.post.setBloomExposure(universe ? this.exposure.current : 1);
    // Grain moves only while something on screen moves (WCAG 2.2.2): the film playing, or the
    // explorer's camera turning, zooming or flying. Never with reduced motion.
    const moving = universe ? (this.universeHost.view()?.moving ?? false) : !this.timeline.paused;
    if (dt > 0 && moving && !this.reduced) gfx.post.advanceGrain();
  }

  /**
   * Test hook (__kf.step): switches to a manual clock, then advances `frames` frames of
   * `dt` seconds each and renders the result. From then on the frame loop keeps drawing
   * but only step() moves time, so a test sees the same picture however fast it runs.
   */
  private step(frames: number, dt: number): void {
    const gfx = this.gfx;
    if (!gfx) throw new Error('__kf.step: the renderer is not ready');
    if (!Number.isInteger(frames) || frames < 0 || frames > MAX_STEP_FRAMES) {
      throw new RangeError(`__kf.step: frames must be an integer from 0 to ${MAX_STEP_FRAMES}`);
    }
    if (!(dt > 0 && dt <= MAX_FRAME_DT)) throw new RangeError(`__kf.step: dt must be in (0, ${MAX_FRAME_DT}] seconds`);
    this.manualClock = true;
    for (let i = 0; i < frames; i++) this.advance(gfx, dt);
    // While a chapter compiles, the frame loop skips rendering too; the next frame draws it.
    if (!this.warming) gfx.post.render();
  }

  /** GPU time is measured (timestamp queries) with ?profile=1, or ?gpuTime=1 (which holds nothing still). */
  private get timesGpu(): boolean {
    return this.params.profile || this.params.gpuTime;
  }

  /** Renderer facts for frameStats(); with ?profile=1 or ?gpuTime=1 also the frame's GPU time. */
  private measure(gfx: Graphics): void {
    const renderer = gfx.handle.renderer;
    const { geometries, textures } = renderer.info.memory;
    this.perf.note({ pixelRatio: gfx.handle.pixelRatio, drawCalls: renderer.info.render.drawCalls, geometries, textures, experience: this.experience });
    if (!this.timesGpu) return;
    renderer
      .resolveTimestampsAsync('render')
      .then((ms) => {
        if (typeof ms !== 'number') return;
        this.perf.recordGpu(ms);
        this.lastGpuMs = ms;
      })
      .catch(() => undefined);
  }

  /** What the explorer may change about the picture (made once the renderer exists). */
  private pictureControl(): UniverseGraphics {
    if (this.universeGraphics) return this.universeGraphics;
    const gfx = this.gfx;
    if (!gfx) throw new Error('Renderer not initialised');
    const { gpu } = gfx.handle;
    const params = this.params;
    const fixedDetail = params.detail ?? (params.tier ? DETAIL_FOR_TIER[params.tier] : null);
    this.universeGraphics = {
      device: { backend: gfx.handle.backend, description: gpu.description, software: gpu.software, mobile: isMobileDevice(), maxTextureSize: gpu.maxTextureSize },
      fixedDetail,
      adaptive: fixedDetail === null && !params.profile,
      // Only while the explorer has the screen (or is taking it): the film never sees these.
      setRenderScale: (scale) => {
        if (this.universeHost.requested) this.gfx?.post.setSceneScale(scale);
      },
      setDprCap: (cap) => {
        if (this.universeHost.requested) this.gfx?.handle.setDprCap(cap);
      },
      setBloom: (on) => {
        if (this.universeHost.requested) this.gfx?.post.setBloom(on);
      },
    };
    return this.universeGraphics;
  }

  private readonly onVisibility = (): void => {
    // The first frame after the tab returns would otherwise carry the hidden time.
    if (document.visibilityState === 'hidden') this.lastFrame = null;
  };

  private readonly onMotionPreference = (): void => {
    if (this.params.reducedMotion !== null) return;
    this.reduced = this.motionQuery.matches;
    this.exposure.setReducedMotion(this.reduced);
    setHook('data-reduced-motion', String(this.reduced));
  };

  private applyQuality(profile: QualityProfile, reason: AppEvents['quality']['reason']): void {
    this.profile = profile;
    if (this.gfx) {
      this.gfx.handle.setDprCap(profile.dprCap);
      this.gfx.post.setBloom(profile.bloom);
      // The new tier resizes targets and rebuilds the bloom pass; those frames are not a reason to drop resolution.
      this.gfx.resolution.holdOff();
    }
    setHook('data-tier', profile.tier);
    this.events.emit('quality', { profile, reason });
    if (reason !== 'governor') return;
    this.timeline.module?.setQuality?.(profile);
    this.universeHost.setQuality(profile);
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  private async navigate(id: ChapterId, options: NavOptions): Promise<void> {
    const meta = this.chapters.find((c) => c.id === id);
    if (!meta || !isPlayable(meta)) {
      console.warn(`[app] ${id} is not playable yet.`);
      return;
    }
    const token = ++this.navToken;
    this.sequence = options.sequence;
    this.pausedForSources = false;
    if (options.history !== 'none') {
      this.router.navigate({ name: 'chapter', chapter: id, t: null }, { replace: options.history === 'replace' });
    }
    const gfx = await this.graphicsReady;
    if (!gfx || token !== this.navToken) return;
    if (this.universeHost.requested) {
      // The explorer fades out and hands the screen back before the chapter loads.
      await this.universeHost.leave();
      if (token !== this.navToken) return;
    }
    this.origin = null;
    this.universeBack = false;

    if (this.timeline.chapter === id && this.timeline.content) {
      // Already showing this chapter: jump within it.
      this.timeline.setMode('cinematic');
      this.timeline.seek(options.t ?? 0);
      this.timeline.setPaused(false);
      return;
    }

    window.clearTimeout(this.prefetchTimer);
    this.chapterReadyPending = null;
    setHook('data-chapter-ready', null);
    gfx.governor.suspend();
    // In sequence, a chapter that continues the one on screen takes over without a fade.
    const previous = this.timeline.chapter;
    const continuous = options.sequence && previous !== null && meta.continuesFrom === previous;
    this.timeline.beginLoading(id, continuous);
    try {
      const [loaded] = await Promise.all([
        this.loader.load(id, (progress) => {
          if (token === this.navToken) this.events.emit('loading', { chapter: id, progress });
        }),
        continuous ? Promise.resolve() : this.timeline.whenDark(),
        // The panel reads data on the 'chapter' event; a data failure is reported separately.
        this.data.ready.catch(() => undefined),
      ]);
      if (token !== this.navToken) return;
      if (loaded.tier !== this.profile.tier) loaded.module.setQuality?.(this.profile);
      this.timeline.start(loaded, { t: options.t, skipIntro: options.skipIntro });
      if (options.paused) this.timeline.setPaused(true);
      await this.warmUp(gfx);
      if (token !== this.navToken) return;
      this.chapterReadyPending = id;
      gfx.governor.holdOff();
      gfx.resolution.holdOff();
    } catch (err) {
      if (token !== this.navToken) return;
      console.error(`[app] Loading ${id} failed`, err);
      this.emitError('chapter');
      this.timeline.stop();
      this.router.navigate({ name: 'home' }, { replace: true });
    }
  }

  /**
   * Compiles the entered chapter's pipelines asynchronously before its first frame, so the
   * cinematic never starts with shader-compile stalls (measured at 200-450 ms in Brave).
   */
  private async warmUp(gfx: Graphics): Promise<void> {
    this.warming = true;
    try {
      await Promise.race([
        gfx.handle.renderer.compileAsync(this.scene, this.camera),
        new Promise<void>((resolve) => window.setTimeout(resolve, WARM_UP_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('[app] Pipeline warm-up failed; compiling on first render instead', err);
    } finally {
      this.warming = false;
    }
  }

  /**
   * After a chapter has rendered: keep it and the next one, dispose the rest, prefetch the next (and
   * the explorer's code, from a chapter that offers the explorer, so the way in has nothing to fetch).
   */
  private afterChapterReady(id: ChapterId): void {
    const next = this.neighbour(id, 1);
    this.loader.retain(next ? [id, next] : [id]);
    const opensUniverse = this.chapters.find((c) => c.id === id)?.opensUniverse === true;
    if (!next && !opensUniverse) return;
    this.prefetchTimer = window.setTimeout(() => {
      if (this.timeline.chapter !== id) return;
      if (next) this.loader.prefetch(next);
      if (opensUniverse) this.universeHost.prefetch();
    }, PREFETCH_DELAY_MS);
  }

  private onChapterEnd(id: ChapterId): void {
    const next = this.sequence ? this.neighbour(id, 1) : null;
    if (next) void this.navigate(next, { skipIntro: false, sequence: true, history: 'replace' });
    else this.home();
  }

  /** User navigation: typed URL, back/forward, links. Deep links skip the intro card. */
  private onRoute(route: Route): void {
    const initial = !this.routed;
    this.routed = true;
    if (route.name === 'home') {
      if (this.timeline.state !== 'idle' || this.universeHost.requested) this.leaveChapter();
      return;
    }
    if (route.name === 'universe') {
      // Reached from one of our pages (Forward, or an address typed over one): back is that page.
      // On the first address (a deep link) there is nothing of ours behind it.
      this.universeBack = !initial && !this.universeHost.requested;
      if (!route.lab) this.labBack = false;
      this.enterUniverse(route.body, route.jd, route.lab === true, route.share);
      return;
    }
    if (route.name === 'sources') {
      // Pause for the Sources page, remembering that we did so a reader's own pause survives the round trip.
      if (this.timeline.chapter && !this.timeline.paused) {
        this.timeline.setPaused(true);
        this.pausedForSources = true;
      }
      return;
    }
    const meta = this.chapters.find((c) => c.id === route.chapter);
    if (!meta || !isPlayable(meta)) {
      this.router.navigate({ name: 'home' }, { replace: true });
      if (this.timeline.state !== 'idle') this.leaveChapter();
      return;
    }
    if (route.chapter === this.timeline.chapter && route.t === null) {
      if (this.pausedForSources) this.timeline.setPaused(false);
      this.pausedForSources = false;
      return;
    }
    const origin = this.origin;
    if (this.universeHost.requested && origin?.chapter === route.chapter && route.t === null) {
      // Back from the explorer to the chapter it was opened from: resume where the film was.
      this.returnToOrigin(origin, 'none');
      return;
    }
    void this.navigate(route.chapter, {
      t: route.t ?? undefined,
      skipIntro: true,
      sequence: route.t === null,
      // A ?t= deep link is used once: the history entry becomes the plain chapter route, so
      // coming back to it (e.g. Back from the Sources page) does not jump to t again.
      history: route.t === null ? 'none' : 'replace',
    });
  }

  private leaveChapter(): void {
    this.navToken += 1;
    this.sequence = false;
    this.pausedForSources = false;
    this.origin = null;
    this.universeBack = false;
    window.clearTimeout(this.prefetchTimer);
    this.chapterReadyPending = null;
    setHook('data-chapter-ready', null);
    this.timeline.stop();
    void this.universeHost.leave();
  }

  /**
   * Opens the explorer for a route (or applies the route to it when it is already open). The
   * film's position is remembered the first time, so closing the explorer can return to it.
   */
  private enterUniverse(body: BodyId | null, jd: number | null, lab = false, labShare?: string): void {
    const fresh = !this.universeHost.requested;
    if (fresh) {
      const chapter = this.timeline.chapter;
      this.origin =
        chapter !== null && this.timeline.content
          ? { chapter, t: this.timeline.time, paused: this.timeline.paused, sequence: this.sequence }
          : null;
    }
    this.sequence = false;
    this.pausedForSources = false;
    window.clearTimeout(this.prefetchTimer);
    this.chapterReadyPending = null;
    setHook('data-chapter-ready', null);
    // From Chapter 7's compressed solar system, with no body or date asked for, the explorer opens on
    // that view and stretches it out to true scale.
    const stretch = fresh && this.origin?.chapter === 'ch07' && body === null && jd === null;
    void this.universeHost.open({ body, jdUtc: jd ?? this.params.jd, reducedMotion: this.reduced, stretch: stretch && !lab, lab, ...(labShare ? { labShare } : {}) });
  }

  private returnToOrigin(origin: FilmOrigin, history: NavOptions['history']): void {
    void this.navigate(origin.chapter, {
      t: origin.t,
      skipIntro: true,
      sequence: origin.sequence,
      history,
      paused: origin.paused,
    });
  }

  /** The playable chapter `step` stops away (1 = next, -1 = previous), or null. */
  private neighbour(id: ChapterId, step: 1 | -1): ChapterId | null {
    const i = this.chapters.findIndex((c) => c.id === id);
    for (let j = i + step; j >= 0 && j < this.chapters.length; j += step) {
      const c = this.chapters[j];
      if (c && isPlayable(c)) return c.id;
    }
    return null;
  }

  private firstPlayable(): ChapterId | null {
    return this.chapters.find(isPlayable)?.id ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* Commands                                                          */
  /* ---------------------------------------------------------------- */

  /** Jumps to a chapter and plays on through the following ones; t > 0 starts mid-chapter without the intro card. */
  goTo(chapter: ChapterId, t?: number): Promise<void> {
    return this.navigate(chapter, { t, skipIntro: t !== undefined && t > 0, sequence: true, history: 'push' });
  }

  home(): void {
    this.router.navigate({ name: 'home' });
    this.leaveChapter();
  }

  play(): void {
    if (this.timeline.state === 'idle') {
      const first = this.firstPlayable();
      if (first) void this.navigate(first, { skipIntro: false, sequence: true, history: 'push' });
      return;
    }
    this.timeline.setPaused(false);
  }

  pause(): void {
    if (this.timeline.state !== 'idle') this.timeline.setPaused(true);
  }

  togglePause(): void {
    if (this.timeline.state === 'idle' || this.timeline.paused) this.play();
    else this.pause();
  }

  seek(t: number): void {
    this.timeline.seek(t);
  }

  next(): void {
    const current = this.timeline.chapter;
    const target = current ? this.neighbour(current, 1) : this.firstPlayable();
    if (target) void this.navigate(target, { skipIntro: false, sequence: true, history: 'push' });
    else this.home();
  }

  prev(): void {
    const current = this.timeline.chapter;
    if (!current) return;
    const target = this.neighbour(current, -1);
    if (target) void this.navigate(target, { skipIntro: false, sequence: true, history: 'push' });
    else this.timeline.seek(0);
  }

  setMode(mode: 'cinematic' | 'explore'): void {
    this.timeline.setMode(mode);
  }

  interact(id: string, value: number | null): void {
    this.timeline.module?.onInteract?.(id, value);
  }

  holdFilm(reason: string): () => void {
    return this.timeline.hold(reason);
  }

  openUniverse(body: BodyId | null = null): void {
    const before = window.location.hash;
    const fresh = !this.universeHost.requested;
    this.router.navigate({ name: 'universe', body, jd: null });
    // Its entry now sits right on top of the page it was opened from (unless it was open already).
    this.universeBack = fresh && window.location.hash !== before;
    this.enterUniverse(body, null);
  }

  closeUniverse(): void {
    if (!this.universeHost.requested) return;
    if (this.universeBack) {
      // Going back to that entry leaves the history as it was before the visit: Back afterwards
      // goes where it would have gone, and leaving again and again stacks nothing.
      this.universeBack = false;
      history.back();
      return;
    }
    // Nothing of ours behind the explorer's entry (a deep link): replace it, so Back does not lead into it again.
    const origin = this.origin;
    if (origin) {
      this.returnToOrigin(origin, 'replace');
    } else {
      this.router.navigate({ name: 'home' }, { replace: true });
      this.leaveChapter();
    }
  }

  focusBody(body: BodyId): void {
    const module = this.universeHost.active;
    if (!module) return;
    module.focus(body);
    // The address follows the focus without filling the history with every hop.
    const current = this.router.current;
    this.router.navigate({ name: 'universe', body, jd: current.name === 'universe' ? current.jd : null }, { replace: true });
  }

  setViewInsets(insets: ViewInsets): void {
    this.universeHost.setInsets(insets);
  }

  setUniverseDetail(choice: 'auto' | ExploreTier): void {
    this.universeHost.setDetailChoice(choice);
  }

  steerUniverse(command: UniverseSteer): boolean {
    return this.universeHost.steer(command);
  }

  earthCommand(command: EarthCommand): void {
    this.universeHost.earth(command);
  }

  universeTime(command: UniverseTimeCommand): void {
    this.universeHost.time(command);
  }

  universeIslamic(command: UniverseIslamicCommand): void {
    this.universeHost.islamic(command);
  }

  universeSky(command: UniverseSkyCommand): void {
    this.universeHost.sky(command);
  }

  universeLab(command: LabCommand): void {
    this.universeHost.lab(command);
  }

  openLab(): void {
    if (!this.universeHost.requested) return;
    const before = window.location.hash;
    this.router.navigate({ name: 'universe', body: null, jd: null, lab: true });
    this.labBack = window.location.hash !== before;
    void this.universeHost.open({ body: null, jdUtc: null, reducedMotion: this.reduced, lab: true });
  }

  closeLab(): void {
    if (this.labBack) {
      // Back to the explorer's own entry: the history as it was before the experiment.
      this.labBack = false;
      history.back();
      return;
    }
    this.router.navigate({ name: 'universe', body: null, jd: null }, { replace: true });
    void this.universeHost.open({ body: null, jdUtc: null, reducedMotion: this.reduced, lab: false });
  }

  universe(): UniverseView | null {
    return this.universeHost.view();
  }

  hud(): HudState {
    const module = this.universeHost.hudSource ?? this.timeline.module;
    if (!module || (!module.labels && !module.scale)) return EMPTY_HUD;
    const rect = this.canvas.getBoundingClientRect();
    const labels: ScreenLabel[] = [];
    for (const label of module.labels?.() ?? []) {
      if (label.opacity <= 0.001) continue;
      projected.set(...label.position).project(this.camera);
      // Behind the camera or beyond the far plane: not shown.
      if (projected.z < -1 || projected.z > 1) continue;
      labels.push({
        id: label.id,
        textKey: label.textKey,
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
        opacity: label.opacity,
        ...(label.offset ? { offset: label.offset } : {}),
        ...(label.text !== undefined ? { text: label.text } : {}),
      });
    }
    const scale = module.scale?.() ?? null;
    const metresPerPixel =
      scale && rect.height > 0
        ? (scale.metresPerUnit * 2 * scale.distance * Math.tan(MathUtils.degToRad(this.camera.fov / 2))) / rect.height
        : null;
    return { labels, metresPerPixel };
  }

  /* ---------------------------------------------------------------- */
  /* Errors and teardown                                               */
  /* ---------------------------------------------------------------- */

  private emitError(kind: keyof typeof ERRORS): void {
    const [key, english] = ERRORS[kind];
    const message = this.i18n.has(key) ? this.i18n.t(key) : english;
    this.events.emit('error', { message });
  }

  private logOnce(scope: string, err: unknown): void {
    const text = err instanceof Error ? err.message : String(err);
    if (this.loggedErrors.has(text)) return;
    this.loggedErrors.add(text);
    console.error(scope, err);
  }

  dispose(): void {
    this.navToken += 1;
    window.clearTimeout(this.prefetchTimer);
    this.motionQuery.removeEventListener('change', this.onMotionPreference);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.router.dispose();
    this.timeline.stop();
    this.universeHost.dispose();
    this.loader.disposeAll();
    this.explore.dispose();
    this.audio.dispose();
    this.perf.dispose();
    this.assets.dispose();
    if (this.gfx) {
      void this.gfx.handle.renderer.setAnimationLoop(null);
      this.gfx.post.dispose();
      this.gfx.handle.dispose();
      this.gfx = null;
    }
  }
}

export function createApp(options: AppOptions): KunFayakunApp {
  return new Engine(options);
}
