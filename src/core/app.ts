import { MathUtils, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { CHAPTERS, isPlayable } from '../chapters/index';
import { createAudioEngine } from './audio';
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
import { chooseInitialTier, createQualityGovernor, type QualityGovernor } from './quality';
import { createResolutionGovernor, type ResolutionGovernor } from './resolution';
import { createRenderer, RENDERER_UNAVAILABLE_MESSAGE, type BackendName, type RendererHandle } from './renderer';
import { createRouter, type Router } from './router';
import { Timeline } from './timeline';
import type {
  App,
  AppEvents,
  AssetLoader,
  ChapterContent,
  ChapterContext,
  ChapterId,
  ExposureControl,
  I18n,
  QualityProfile,
  Route,
  TimelineState,
  HudState,
  ScreenLabel,
} from './types';

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
}

/** Frame steps longer than this are clamped so a hitch never skips content. */
const MAX_FRAME_DT = 0.1;
/** Upper bound for one __kf.step call (an hour of film at 60 fps), so a typo cannot hang the page. */
const MAX_STEP_FRAMES = 216_000;
const EMPTY_HUD: HudState = { labels: [], metresPerPixel: null };
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
  private readonly timeline: Timeline;
  private readonly loader: ChapterLoader;
  private readonly router: Router;

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

    this.events.on('state', ({ state, chapter }) => {
      setHook('data-state', state);
      setHook('data-chapter', chapter);
    });
    setHook('data-state', 'idle');
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
  get mode(): 'cinematic' | 'explore' {
    return this.timeline.mode;
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
    const handle = await createRenderer(this.canvas, { forceWebGL: this.params.forceWebGL, trackTimestamp: this.params.profile });
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

  private makeContext(assets: AssetLoader): ChapterContext {
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
      exposure: this.chapterExposure,
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
          const scale = gfx.resolution.sample(raw);
          if (scale !== null) gfx.handle.setResolutionScale(scale);
          const lower = gfx.governor.sample(raw);
          if (lower) this.applyQuality(lower, 'governor');
        }
      }
      this.advance(gfx, this.manualClock ? 0 : Math.min(raw, MAX_FRAME_DT));
      gfx.post.render();
      this.measure(gfx);
    } catch (err) {
      this.logOnce('[frame]', err);
      return;
    }
    if (!this.firstFrameRendered) {
      this.firstFrameRendered = true;
      setHook('data-ready', 'true');
    }
    const pending = this.chapterReadyPending;
    if (pending !== null && this.timeline.chapter === pending && this.timeline.content) {
      this.chapterReadyPending = null;
      setHook('data-chapter-ready', pending);
      this.afterChapterReady(pending);
    }
  };

  /** Moves the film clock, the exposure and the grain on by dt seconds. */
  private advance(gfx: Graphics, dt: number): void {
    this.timeline.update(dt);
    this.exposure.update(dt);
    gfx.handle.renderer.toneMappingExposure = this.exposure.current;
    // Grain moves only while the film plays (WCAG 2.2.2) and never with reduced motion.
    if (dt > 0 && !this.timeline.paused && !this.reduced) gfx.post.advanceGrain();
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

  /** Renderer facts for frameStats(); with ?profile=1 also the frame's GPU time. */
  private measure(gfx: Graphics): void {
    const renderer = gfx.handle.renderer;
    this.perf.note({ pixelRatio: gfx.handle.pixelRatio, drawCalls: renderer.info.render.drawCalls });
    if (!this.params.profile) return;
    renderer
      .resolveTimestampsAsync('render')
      .then((ms) => {
        if (typeof ms === 'number') this.perf.recordGpu(ms);
      })
      .catch(() => undefined);
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
    if (reason === 'governor') this.timeline.module?.setQuality?.(profile);
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

  /** After a chapter has rendered: keep it and the next one, dispose the rest, prefetch the next. */
  private afterChapterReady(id: ChapterId): void {
    const next = this.neighbour(id, 1);
    this.loader.retain(next ? [id, next] : [id]);
    if (!next) return;
    this.prefetchTimer = window.setTimeout(() => {
      if (this.timeline.chapter === id) this.loader.prefetch(next);
    }, PREFETCH_DELAY_MS);
  }

  private onChapterEnd(id: ChapterId): void {
    const next = this.sequence ? this.neighbour(id, 1) : null;
    if (next) void this.navigate(next, { skipIntro: false, sequence: true, history: 'replace' });
    else this.home();
  }

  /** User navigation: typed URL, back/forward, links. Deep links skip the intro card. */
  private onRoute(route: Route): void {
    if (route.name === 'home') {
      if (this.timeline.state !== 'idle') this.leaveChapter();
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
    window.clearTimeout(this.prefetchTimer);
    this.chapterReadyPending = null;
    setHook('data-chapter-ready', null);
    this.timeline.stop();
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

  hud(): HudState {
    const module = this.timeline.module;
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
