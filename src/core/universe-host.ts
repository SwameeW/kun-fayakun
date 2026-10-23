import { setHook } from './hooks';
import type { EngineExposure } from './post';
import type { QualityGovernor } from './quality';
import type { ResolutionGovernor } from './resolution';
import type { AppEvents, BodyId, ChapterContext, EventBus, ExperienceModule, QualityProfile, UniverseModule } from './types';

/**
 * Hosts the solar-system explorer ("universe"), the one experience that is not a chapter.
 *
 * It runs the same sequence as the engine's chapter navigation: a navigation token (a newer
 * navigation cancels an older one), the tier governor suspended, the film stopped and faded to
 * black, the explorer's chunk imported (only now: it is its own lazy chunk), its pipelines
 * compiled before the first frame, the governors held off, then the exposure faded up. Leaving
 * is the reverse: fade to black, exit, and give the chapters back their lens.
 *
 * The explorer is kept after the first visit (like a prefetched chapter), so a round trip from
 * a chapter and back reuses its GPU resources instead of building them again.
 */

/** Longest wait for the screen to fade to black before the explorer hands back anyway (as for chapters). */
const FADE_WAIT_SECONDS = 4;

export interface UniverseGraphics {
  readonly governor: QualityGovernor;
  readonly resolution: ResolutionGovernor;
}

export interface UniverseHostDeps {
  readonly events: EventBus<AppEvents>;
  readonly exposure: EngineExposure;
  /** The chapters' lens defaults (near, far, up), restored when the explorer hands back. */
  resetLens(): void;
  /** The context the explorer is built with: the same services a chapter gets. */
  makeContext(): ChapterContext;
  /** Stops the film; resolves once its last frame has faded to black (or straight away if none is showing). */
  stopFilm(): Promise<void>;
  graphics(): Promise<UniverseGraphics | null>;
  /** Compiles the scene's pipelines before the first frame (frames neither render nor advance meanwhile). */
  warmUp(): Promise<void>;
  /** Navigation tokens shared with chapter navigation. */
  nextToken(): number;
  isCurrent(token: number): boolean;
  onError(err: unknown): void;
}

export interface UniverseOpenOptions {
  body: BodyId | null;
  /** A pinned UTC Julian date, or null for now. */
  jdUtc: number | null;
  reducedMotion: boolean;
}

type HostState = 'idle' | 'loading' | 'active' | 'leaving';

interface Loaded {
  module: UniverseModule;
  /** The context passed to load(); the same object is passed to enter(). */
  ctx: ChapterContext;
}

export class UniverseHost {
  private stateValue: HostState = 'idle';
  private loaded: Loaded | null = null;
  private loading: Promise<Loaded> | null = null;
  private leaving: Promise<void> | null = null;
  private darkWaiter: { resolve: () => void; left: number } | null = null;
  private readyPending = false;
  /** A tier the governor dropped to while the explorer was away: it catches up on its next entry. */
  private pendingQuality: QualityProfile | null = null;

  constructor(private readonly deps: UniverseHostDeps) {}

  /** True from the moment the explorer is asked for until it has handed the screen back. */
  get requested(): boolean {
    return this.stateValue !== 'idle';
  }

  /** True while the explorer's scene is in the frame loop: entered, or fading out to leave. */
  get owns(): boolean {
    return this.stateValue === 'active' || this.stateValue === 'leaving';
  }

  /** The explorer while it is entered and not leaving. */
  get active(): UniverseModule | null {
    return this.stateValue === 'active' ? (this.loaded?.module ?? null) : null;
  }

  /** The experience whose HUD tags and scale the engine shows, or null for the film's. */
  get hudSource(): ExperienceModule | null {
    return this.owns ? (this.loaded?.module ?? null) : null;
  }

  /** Opens the explorer, or, when it is already on screen, applies the new route to it. */
  async open(options: UniverseOpenOptions): Promise<void> {
    const current = this.active;
    if (current) {
      current.configure(options);
      return;
    }
    const token = this.deps.nextToken();
    if (this.stateValue === 'leaving' && this.leaving) await this.leaving;
    if (!this.deps.isCurrent(token)) return;
    this.setState('loading');
    // Every await below may let another navigation in: go on only while this one is current.
    const still = (state: HostState): boolean => this.deps.isCurrent(token) && this.is(state);
    const gfx = await this.deps.graphics();
    if (!still('loading')) return;
    if (!gfx) {
      this.setState('idle');
      return;
    }
    gfx.governor.suspend();
    try {
      const [{ module, ctx }] = await Promise.all([this.load(), this.deps.stopFilm()]);
      if (!still('loading')) return;
      if (this.pendingQuality) {
        module.setQuality?.(this.pendingQuality);
        this.pendingQuality = null;
      }
      module.configure(options);
      module.enter(ctx);
      this.setState('active');
      await this.deps.warmUp();
      if (!still('active')) return;
      gfx.governor.holdOff();
      gfx.resolution.holdOff();
      this.deps.exposure.setFade(1);
      this.readyPending = true;
    } catch (err) {
      if (!this.deps.isCurrent(token)) return;
      if (this.is('active')) this.loaded?.module.exit();
      this.setState('idle');
      this.deps.onError(err);
    }
  }

  private is(state: HostState): boolean {
    return this.stateValue === state;
  }

  /** Fades the explorer out and removes it. Resolves once the chapters may have the screen. */
  leave(): Promise<void> {
    switch (this.stateValue) {
      case 'idle':
        return Promise.resolve();
      case 'loading':
        // The open() in flight sees the state change and stops before entering.
        this.setState('idle');
        return Promise.resolve();
      case 'leaving':
        return this.leaving ?? Promise.resolve();
      case 'active': {
        this.setState('leaving');
        this.readyPending = false;
        this.deps.exposure.setFade(0);
        this.leaving = new Promise<void>((resolve) => {
          this.darkWaiter = { resolve, left: FADE_WAIT_SECONDS };
        }).then(() => {
          this.loaded?.module.exit();
          this.deps.resetLens();
          this.leaving = null;
          this.setState('idle');
        });
        return this.leaving;
      }
    }
  }

  /** Called every frame instead of the film's update while the explorer owns the screen. */
  update(dt: number): void {
    if (!this.owns) return;
    this.loaded?.module.update(dt);
    const waiter = this.darkWaiter;
    if (!waiter) return;
    waiter.left -= dt;
    if (this.deps.exposure.dark || waiter.left <= 0) {
      this.darkWaiter = null;
      waiter.resolve();
    }
  }

  /** Called after each rendered frame: the first one after the warm-up marks the explorer ready. */
  afterFrame(): void {
    if (!this.readyPending || this.stateValue !== 'active') return;
    this.readyPending = false;
    setHook('data-universe-ready', 'true');
    this.deps.events.emit('universe', { ready: true });
  }

  setQuality(profile: QualityProfile): void {
    if (!this.loaded) return;
    if (this.owns) this.loaded.module.setQuality?.(profile);
    else this.pendingQuality = profile;
  }

  dispose(): void {
    this.darkWaiter = null;
    this.loaded?.module.dispose();
    this.loaded = null;
    this.loading = null;
    this.stateValue = 'idle';
  }

  private load(): Promise<Loaded> {
    if (this.loaded) return Promise.resolve(this.loaded);
    this.loading ??= (async () => {
      // The explorer is its own chunk: none of it is in the shell until a visitor asks for it.
      const { default: create } = await import('../explore/index');
      const module = create();
      const ctx = this.deps.makeContext();
      await module.load(ctx);
      const loaded: Loaded = { module, ctx };
      this.loaded = loaded;
      return loaded;
    })();
    const pending = this.loading;
    pending.catch(() => {
      // Forget a failure so the next visit can retry.
      if (this.loading === pending) this.loading = null;
    });
    return pending;
  }

  private setState(next: HostState): void {
    const before = this.requested;
    const wasActive = this.stateValue === 'active';
    this.stateValue = next;
    if (next !== 'active') setHook('data-universe-ready', null);
    if (wasActive && next !== 'active') this.deps.events.emit('universe', { ready: false });
    if (this.requested !== before) {
      const experience = this.requested ? 'universe' : 'film';
      setHook('data-experience', experience);
      this.deps.events.emit('experience', { experience });
    }
  }
}
