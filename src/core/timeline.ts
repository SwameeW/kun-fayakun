import type { AudioEngine } from './audio';
import type { CameraDirector } from './camera';
import { CueScheduler, type CueEffect } from './cues';
import type { EngineExposure } from './post';
import type { AppEvents, ChapterContent, ChapterContext, ChapterId, ChapterModule, EventBus, TimelineState } from './types';

/**
 * Quiet darkness after a chapter ends (the UI offers continue/replay/explore),
 * before the next chapter or the timeline takes over. Pausing holds it.
 */
const OUTRO_SECONDS = 5;
/** 'time' events at most ~10 per second. */
const TIME_EVENT_INTERVAL = 0.1;
/**
 * Longest wait for the screen to fade to black before chapters are swapped anyway.
 * Typically about 1 s; with reduced motion up to about 2.4 s (slower fall plus the
 * 1 s hold before exposure may turn from brightening to darkening).
 */
const FADE_WAIT_SECONDS = 4;

export interface TimelineHost {
  readonly events: EventBus<AppEvents>;
  readonly camera: CameraDirector;
  readonly audio: AudioEngine;
  readonly exposure: EngineExposure;
  /** Called once when a chapter's outro has finished. */
  onChapterEnd(chapter: ChapterId): void;
  /** True when the film will continue straight into a chapter that opens where this one ends. */
  continuesAfter(chapter: ChapterId): boolean;
}

export interface TimelineChapter {
  id: ChapterId;
  module: ChapterModule;
  ctx: ChapterContext;
}

interface Active extends TimelineChapter {
  content: ChapterContent;
  cues: CueScheduler;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The single state machine: idle → loading → intro → playing ⇄ explore → outro,
 * plus a paused flag and film holds. Owns the cinematic clock, cue scheduling,
 * scene events and camera keyframes for the active chapter.
 */
export class Timeline {
  private stateValue: TimelineState = 'idle';
  /** The chapter the timeline is on, including one still loading. */
  private chapterValue: ChapterId | null = null;
  private emittedChapter: ChapterId | null = null;
  /** The chapter whose scene is in ctx.scene. */
  private active: Active | null = null;
  /** The active scene is fading out and will be exited once dark. */
  private retiring = false;
  /** Chapter time the retiring chapter keeps showing (it must not jump back to 0 while it stays lit). */
  private retiringT = 0;
  private t = 0;
  /** Explore Mode's model time: the scene shown at another moment while the film's clock stays put. */
  private exploreT: number | null = null;
  private pausedValue = false;
  private introLeft = 0;
  private outroLeft = 0;
  private sinceTimeEvent = 0;
  /** Open holds (token → reason). While any exists the film clock stands still; the scene does not. */
  private readonly holds = new Map<symbol, string>();
  private darkWaiters: Array<{ resolve: () => void; left: number }> = [];

  constructor(private readonly host: TimelineHost) {}

  get state(): TimelineState {
    return this.stateValue;
  }
  get chapter(): ChapterId | null {
    return this.chapterValue;
  }
  get content(): ChapterContent | null {
    const a = this.active;
    return a && !this.retiring && a.id === this.chapterValue ? a.content : null;
  }
  get time(): number {
    return this.t;
  }
  get paused(): boolean {
    return this.pausedValue;
  }
  get held(): boolean {
    return this.holds.size > 0;
  }
  get mode(): 'cinematic' | 'explore' {
    return this.stateValue === 'explore' ? 'explore' : 'cinematic';
  }
  /** The chapter currently showing (not retiring), for quality changes. */
  get module(): ChapterModule | null {
    return this.active && !this.retiring ? this.active.module : null;
  }

  /**
   * Leaves the current chapter for another: its cues end and it fades to black, unless
   * the next chapter continues it (`keepLit`): then it stays on screen, frozen at its
   * last moment, until the next one starts on top of it in the same frame.
   */
  beginLoading(id: ChapterId, keepLit = false): void {
    this.clearHolds();
    this.retire(keepLit);
    this.chapterValue = id;
    this.t = 0;
    this.setState('loading');
  }

  /** Resolves once the screen is dark (or after a timeout), so chapters swap unseen. */
  whenDark(): Promise<void> {
    if (!this.active || this.host.exposure.dark) return Promise.resolve();
    return new Promise((resolve) => {
      this.darkWaiters.push({ resolve, left: FADE_WAIT_SECONDS });
    });
  }

  /** Enters a loaded chapter. Deep links skip the intro card and start at t. */
  start(chapter: TimelineChapter, options: { t?: number; skipIntro: boolean }): void {
    this.exitActive();
    const content = chapter.module.content;
    this.chapterValue = chapter.id;
    this.t = clamp(options.t ?? 0, 0, content.duration);
    this.setPaused(false);
    this.host.exposure.resetTarget();
    this.host.camera.setPath(content.camera, this.t);
    chapter.module.enter(chapter.ctx);
    const active: Active = { ...chapter, content, cues: new CueScheduler(chapter.module.cues) };
    this.active = active;
    this.exploreT = null;
    this.host.exposure.setFade(1);
    this.host.events.emit('chapter', { chapter: chapter.id, content });
    if (options.skipIntro) {
      this.setState('playing');
      this.apply(active, active.cues.seek(this.t, true));
    } else {
      this.introLeft = content.intro.seconds;
      this.setState('intro');
    }
    this.emitTime();
  }

  /** Back to no chapter (the timeline/home). The scene fades out before it is removed. */
  stop(): void {
    this.clearHolds();
    this.retire();
    this.chapterValue = null;
    this.t = 0;
    this.setState('idle');
  }

  seek(t: number): void {
    const a = this.active;
    if (!a || this.retiring) return;
    const target = clamp(t, 0, a.content.duration);
    const reset = a.cues.needsSceneReset(target);
    if (reset) {
      // Un-crossing a scene event: rebuild the scene, then replay events up to target.
      a.module.exit();
      this.host.exposure.resetTarget();
      this.host.camera.resetLens();
      a.module.enter(a.ctx);
    }
    this.t = target;
    if (this.stateValue === 'intro' || this.stateValue === 'outro') {
      this.host.exposure.setFade(1);
      this.setState('playing');
    }
    this.apply(a, a.cues.seek(target, reset));
    this.host.events.emit('seek', { chapter: a.id, t: target });
    this.emitTime();
  }

  /**
   * Stops the film clock until the returned function is called. Separate from pause: the
   * scene keeps moving (the reader is looking at it), and a pause the reader made stays theirs.
   */
  hold(reason: string): () => void {
    const token = Symbol(reason);
    this.holds.set(token, reason);
    this.emitHeld();
    return () => {
      if (this.holds.delete(token)) this.emitHeld();
    };
  }

  setPaused(paused: boolean): void {
    if (paused === this.pausedValue) return;
    this.pausedValue = paused;
    this.host.audio.setPaused(paused);
    this.host.events.emit('paused', { paused });
  }

  setMode(mode: 'cinematic' | 'explore'): void {
    const a = this.active;
    if (!a || this.retiring || mode === this.mode) return;
    if (mode === 'explore') {
      if (this.stateValue !== 'intro' && this.stateValue !== 'playing' && this.stateValue !== 'outro') return;
      this.host.exposure.setFade(1);
      this.host.camera.enterExplore(a.content.explore);
      this.setState('explore');
    } else {
      this.exploreT = null;
      this.host.camera.leaveExplore();
      this.setState('playing');
    }
  }

  get exploreTime(): number | null {
    return this.exploreT;
  }

  /** In Explore Mode only: the scene at another moment of its chapter (null: the film's moment). */
  setExploreTime(t: number | null): void {
    const a = this.active;
    if (!a || this.stateValue !== 'explore') return;
    this.exploreT = t === null ? null : clamp(t, 0, a.content.duration);
  }

  /** Called every frame with real seconds since the last frame. */
  update(dt: number): void {
    this.tickDarkWaiters(dt);
    const a = this.active;
    if (!a) return;
    // WCAG 2.2.2: while paused, nothing moves on its own.
    const motionDt = this.pausedValue ? 0 : dt;
    // A hold stops only the film's clock: no cue fires and the chapter cannot end, but the scene keeps motionDt.
    const filmDt = this.holds.size > 0 ? 0 : motionDt;

    if (this.retiring) {
      a.module.update(this.retiringT, motionDt);
      if (this.host.exposure.dark) this.exitActive();
      return;
    }

    if (this.stateValue === 'intro') {
      this.introLeft -= filmDt;
      if (this.introLeft <= 0) this.setState('playing');
    } else if (this.stateValue === 'playing') {
      this.t = Math.min(a.content.duration, this.t + filmDt);
    } else if (this.stateValue === 'outro') {
      this.outroLeft -= filmDt;
    }

    // Cue times count from the end of the intro card.
    if (this.stateValue !== 'intro') this.apply(a, a.cues.advance(this.t));
    this.host.camera.update(this.t, dt);
    a.module.update(this.stateValue === 'explore' ? (this.exploreT ?? this.t) : this.t, motionDt);

    const ending = this.stateValue === 'playing' && this.t >= a.content.duration && this.holds.size === 0;
    if (ending && this.host.continuesAfter(a.id)) {
      // The next chapter opens exactly where this one ends: hand over at once, with no fade.
      this.outroLeft = Infinity;
      this.setState('outro');
      this.host.onChapterEnd(a.id);
    } else if (ending) {
      this.outroLeft = OUTRO_SECONDS;
      this.host.exposure.setFade(0);
      this.setState('outro');
    } else if (this.stateValue === 'outro' && this.outroLeft <= 0 && this.holds.size === 0) {
      this.outroLeft = Infinity;
      this.host.onChapterEnd(a.id);
    }

    this.sinceTimeEvent += dt;
    if (this.sinceTimeEvent >= TIME_EVENT_INTERVAL) this.emitTime();
  }

  private apply(a: Active, effects: readonly CueEffect[]): void {
    for (const effect of effects) {
      if (effect.kind === 'scene') {
        a.module.onSceneEvent?.(effect.cue.event, effect.cue.t);
        continue;
      }
      const { cue, active } = effect;
      if (cue.type === 'audio' && active) {
        if (cue.action === 'duck') this.host.audio.duck();
        else this.host.audio.restore();
      }
      this.host.events.emit('cue', { chapter: a.id, cue, active });
    }
  }

  /** Ends the active chapter's cues and starts fading it out (or, with keepLit, holds it on screen). */
  private retire(keepLit = false): void {
    const a = this.active;
    if (!a || this.retiring) return;
    this.apply(a, a.cues.clear());
    if (this.host.camera.exploring) this.host.camera.leaveExplore();
    if (!keepLit) this.host.exposure.setFade(0);
    this.retiringT = this.t;
    this.retiring = true;
  }

  private exitActive(): void {
    const a = this.active;
    if (!a) return;
    this.exploreT = null;
    if (!this.retiring) this.apply(a, a.cues.clear());
    a.module.exit();
    this.active = null;
    this.retiring = false;
  }

  /** Holds belong to the chapter they were taken in; their owners close on the 'chapter' event. */
  private clearHolds(): void {
    if (this.holds.size === 0) return;
    this.holds.clear();
    this.emitHeld();
  }

  private emitHeld(): void {
    this.host.events.emit('held', { held: this.holds.size > 0, reasons: [...new Set(this.holds.values())] });
  }

  private tickDarkWaiters(dt: number): void {
    if (this.darkWaiters.length === 0) return;
    const dark = this.host.exposure.dark || !this.active;
    this.darkWaiters = this.darkWaiters.filter((w) => {
      w.left -= dt;
      if (!dark && w.left > 0) return true;
      w.resolve();
      return false;
    });
  }

  private setState(state: TimelineState): void {
    // Loading one chapter and then another is still a change worth reporting.
    if (state === this.stateValue && this.chapterValue === this.emittedChapter) return;
    const modeBefore = this.mode;
    this.stateValue = state;
    this.emittedChapter = this.chapterValue;
    this.host.events.emit('state', { state, chapter: this.chapterValue });
    if (this.mode !== modeBefore) this.host.events.emit('mode', { mode: this.mode });
  }

  private emitTime(): void {
    this.sinceTimeEvent = 0;
    const a = this.active;
    if (!a || this.retiring) return;
    this.host.events.emit('time', { chapter: a.id, t: this.t, duration: a.content.duration });
  }
}
