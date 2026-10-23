import type { ExploreTier } from '../explore/detail';
import { setHook } from './hooks';
import type { EngineExposure } from './post';
import type { QualityGovernor } from './quality';
import type { ResolutionGovernor } from './resolution';
import type {
  AppEvents,
  BodyId,
  EventBus,
  ExperienceModule,
  QualityProfile,
  UniverseContext,
  UniverseExposure,
  UniverseModule,
  UniverseSteer,
  UniverseView,
  ViewInsets,
} from './types';

/**
 * Hosts the solar-system explorer ("universe"), the one experience that is not a chapter.
 *
 * It runs the same sequence as the engine's chapter navigation: a navigation token (a newer
 * navigation cancels an older one), the tier governor suspended, the film stopped and faded to
 * black, the explorer's chunk imported (only now: it is its own lazy chunk), its pipelines
 * compiled before the first frame, the governors held off, then the picture brought up. Leaving
 * is the reverse: down to black, exit, and give the chapters back their lens.
 *
 * The explorer's light spans seven stops (Saturn gets about 1.1% of the Earth's sunlight), more
 * than the exposure's slew limit can cross quickly from black, so the host brings the picture up
 * and down with a veil instead: the exposure jumps to its target while the screen is black and
 * the veil eases the picture in (and, leaving, out) over a fixed time, whatever the exposure.
 * The explorer's own reduced-motion cuts use the same veil.
 *
 * The explorer is kept after the first visit (like a prefetched chapter), so a round trip from
 * a chapter and back reuses its GPU resources instead of building them again.
 */

/** Longest wait for the screen to fade to black before the explorer hands back anyway (as for chapters). */
const FADE_WAIT_SECONDS = 4;
/** The veil's ease in after the warm-up and out on leaving, seconds (rule 6: eased over at least 0.5 s). */
const ENTER_SECONDS = 2.2;
const LEAVE_SECONDS = 0.9;
/** The exposure may jump only while the picture is at most this bright (the cut's dim is 0.15). */
const JUMP_VEIL = 0.25;

const smootherstep = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

export interface UniverseGraphics {
  readonly governor: QualityGovernor;
  readonly resolution: ResolutionGovernor;
}

export interface UniverseHostDeps {
  readonly events: EventBus<AppEvents>;
  readonly exposure: EngineExposure;
  /** The chapters' lens defaults (near, far, up), restored when the explorer hands back. */
  resetLens(): void;
  /** The context the explorer is built with: the same services a chapter gets, with the given exposure. */
  makeContext(exposure: UniverseExposure): UniverseContext;
  /** Stops the film; resolves once its last frame has faded to black (or straight away if none is showing). */
  stopFilm(): Promise<void>;
  graphics(): Promise<UniverseGraphics | null>;
  /** Compiles the scene's pipelines before the first frame (frames neither render nor advance meanwhile). */
  warmUp(): Promise<void>;
  /** Navigation tokens shared with chapter navigation. */
  nextToken(): number;
  isCurrent(token: number): boolean;
  onError(err: unknown): void;
  /**
   * The explorer takes the picture over (before it enters): the canvas back to its full resolution
   * (the explorer scales its scene pass instead). restorePicture gives the film its own settings
   * back (pixel-ratio cap, canvas scale, scene scale, bloom) once the explorer has gone dark.
   */
  claimPicture(): void;
  restorePicture(): void;
}

export interface UniverseOpenOptions {
  body: BodyId | null;
  /** A pinned UTC Julian date, or null for now. */
  jdUtc: number | null;
  reducedMotion: boolean;
  /** Open on the film's compressed solar system and stretch it out to true scale (from Chapter 7; ignored under reduced motion). */
  stretch?: boolean;
}

type HostState = 'idle' | 'loading' | 'active' | 'leaving';

interface Loaded {
  module: UniverseModule;
  /** The context passed to load(); the same object is passed to enter(). */
  ctx: UniverseContext;
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
  private insets: ViewInsets = { top: 0, bottom: 0 };
  /** The explorer's own veil (its cuts) and the host's (in and out), 0 black to 1 clear. */
  private moduleVeil = 1;
  private hostVeil = 1;
  /** Where the host's veil is going: 1 after the warm-up, 0 while leaving; null holds it. */
  private veilGoal: { from: number; to: number; seconds: number; t: number } | null = null;
  /** The visitor's detail choice, kept for the explorer until (and after) it loads. */
  private detailChoice: 'auto' | ExploreTier | null = null;
  /** The explorer's code, fetched ahead of a visit (prefetch). */
  private prefetched: Promise<void> | null = null;

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

  /** How much of the picture shows through the veils (multiplies the exposure while the explorer owns the screen). */
  get veil(): number {
    return this.moduleVeil * this.hostVeil;
  }

  /** The explorer's view while it is on screen (cheap; the UI and the engine poll it per frame). */
  view(): UniverseView | null {
    return this.active?.view() ?? null;
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
      if (this.detailChoice) module.setDetailChoice(this.detailChoice);
      module.setInsets(this.insets);
      module.configure(options);
      this.deps.claimPicture();
      // Black until the warm-up is done: the veil comes up afterwards.
      this.hostVeil = 0;
      this.veilGoal = null;
      module.enter(ctx);
      this.setState('active');
      await this.deps.warmUp();
      if (!still('active')) return;
      gfx.governor.holdOff();
      gfx.resolution.holdOff();
      // The film has gone dark and the veil is down: the exposure starts where the first view wants it.
      this.deps.exposure.setFade(1);
      this.deps.exposure.jump();
      this.veilGoal = { from: 0, to: 1, seconds: ENTER_SECONDS, t: 0 };
      this.readyPending = true;
    } catch (err) {
      if (!this.deps.isCurrent(token)) return;
      if (this.is('active')) this.loaded?.module.exit();
      // Whatever the explorer had set for its picture goes back to the film's.
      this.deps.restorePicture();
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
        this.deps.restorePicture();
        return Promise.resolve();
      case 'leaving':
        return this.leaving ?? Promise.resolve();
      case 'active': {
        this.setState('leaving');
        this.readyPending = false;
        this.veilGoal = { from: this.hostVeil, to: 0, seconds: LEAVE_SECONDS * this.hostVeil, t: 0 };
        this.leaving = new Promise<void>((resolve) => {
          this.darkWaiter = { resolve, left: FADE_WAIT_SECONDS };
        }).then(() => {
          // Hand back a dark exposure, so the film rises from black as after any chapter change.
          this.deps.exposure.setFade(0);
          this.deps.exposure.jump();
          this.loaded?.module.exit();
          this.deps.resetLens();
          this.deps.restorePicture();
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
    const goal = this.veilGoal;
    if (goal && dt > 0) {
      goal.t += dt;
      const s = goal.seconds > 0 ? goal.t / goal.seconds : 1;
      this.hostVeil = goal.from + (goal.to - goal.from) * smootherstep(s);
      if (s >= 1) this.veilGoal = null;
    }
    const waiter = this.darkWaiter;
    if (!waiter) return;
    waiter.left -= dt;
    if (this.hostVeil <= 1e-3 || this.deps.exposure.dark || waiter.left <= 0) {
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
    if (!this.loaded) {
      this.pendingQuality = profile;
      return;
    }
    if (this.owns) this.loaded.module.setQuality?.(profile);
    else this.pendingQuality = profile;
  }

  setInsets(insets: ViewInsets): void {
    const clean = (v: number | undefined): number => (Number.isFinite(v) ? Math.max(0, v ?? 0) : 0);
    this.insets = { top: clean(insets.top), bottom: clean(insets.bottom), left: clean(insets.left), right: clean(insets.right) };
    this.loaded?.module.setInsets(this.insets);
  }

  /** One frame's real duration, GPU time and the display's interval, for the explorer's quality governor (while it is on screen). */
  sample(frameSeconds: number, gpuMs: number | null, intervalSeconds: number): void {
    this.active?.sampleFrame(frameSeconds, gpuMs, intervalSeconds);
  }

  /** The visitor's detail choice (from the interface's menu, or remembered from an earlier visit). */
  setDetailChoice(choice: 'auto' | ExploreTier): void {
    this.detailChoice = choice;
    this.loaded?.module.setDetailChoice(choice);
  }

  steer(command: UniverseSteer): boolean {
    return this.active?.steer(command) ?? false;
  }

  dispose(): void {
    this.darkWaiter = null;
    this.loaded?.module.dispose();
    this.loaded = null;
    this.loading = null;
    this.stateValue = 'idle';
  }

  /** The explorer's exposure: the chapters' target and reading, plus the veil and the guarded jump. */
  private exposureFor(base: { setTarget(value: number): void; readonly current: number }): UniverseExposure {
    const engine = this.deps.exposure;
    const setVeil = (value: number): void => {
      this.moduleVeil = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    };
    const jump = (): void => {
      if (this.veil <= JUMP_VEIL || engine.dark) engine.jump();
    };
    return {
      setTarget(value) {
        base.setTarget(value);
      },
      get current() {
        return base.current;
      },
      setVeil,
      jump,
    };
  }

  /**
   * Fetches the explorer's code ahead of a visit (from the chapters that offer one), so the way in
   * waits on nothing but its warm-up. Only the code: nothing is built and no texture is fetched,
   * so the film keeps its frame budget.
   */
  prefetch(): void {
    if (this.loaded || this.loading || this.prefetched) return;
    this.prefetched = import('../explore/index').then(
      () => {
        setHook('data-universe-prefetched', 'true');
      },
      () => {
        // A failed fetch is retried by the visit itself.
        this.prefetched = null;
      },
    );
  }

  private load(): Promise<Loaded> {
    if (this.loaded) return Promise.resolve(this.loaded);
    this.loading ??= (async () => {
      // The explorer is its own chunk: none of it is in the shell until a visitor asks for it.
      const { default: create } = await import('../explore/index');
      const module = create();
      const engine = this.deps.exposure;
      const ctx = this.deps.makeContext(
        this.exposureFor({
          setTarget: (value) => {
            engine.setTarget(value);
          },
          get current() {
            return engine.current;
          },
        }),
      );
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
    if (next === 'idle') {
      // The film never sees the explorer's veils.
      this.moduleVeil = 1;
      this.hostVeil = 1;
      this.veilGoal = null;
    }
    if (next !== 'active') setHook('data-universe-ready', null);
    if (next === 'idle') {
      setHook('data-travel', null);
      setHook('data-detail', null);
    }
    if (wasActive && next !== 'active') this.deps.events.emit('universe', { ready: false });
    if (this.requested !== before) {
      const experience = this.requested ? 'universe' : 'film';
      setHook('data-experience', experience);
      this.deps.events.emit('experience', { experience });
    }
  }
}
