import type { ScriptedEngine, ScriptedOptions, ScriptedReply } from '../ai/engine/scripted';
import type { CapabilityReport, EvaluationOptions, GenerationRecord, Intelligence } from '../ai/types';
import type { FrameStats } from './perf';
import type { App, ChapterContent, ChapterId, LabCommand, LabEditResult, UniversePose, UniverseView } from './types';

/** <html> attributes that tests wait on (docs/CONTRACTS.md, "Test hooks"). */
export type HookAttribute =
  | 'data-backend'
  | 'data-tier'
  | 'data-state'
  | 'data-chapter'
  | 'data-ready'
  | 'data-chapter-ready'
  | 'data-reduced-motion'
  /** "film" or "universe": which experience owns the screen (set as soon as a switch starts). */
  | 'data-experience'
  /** "true" once the explorer has rendered a frame after loading; removed while it is not on screen. */
  | 'data-universe-ready'
  /** The explorer's trips: "flying" while one is under way, then "arrived" (or "stopped" by Esc); removed when it leaves. */
  | 'data-travel'
  /** The explorer's detail tier running (ultra, high, medium, low); removed when it leaves. */
  | 'data-detail'
  /** "true" once the explorer's code has been fetched ahead of a visit (from a chapter that offers it). */
  | 'data-universe-prefetched'
  /** The assistant's engine once it has started (src/ai/boot.ts): "guide", "local", "browser" or "scripted". */
  | 'data-ai-engine'
  /** The state of the assistant's latest turn (src/ai/types.ts TaskState: "planning", "done", "cancelled"…). */
  | 'data-ai-turn';

export function setHook(name: HookAttribute, value: string | null): void {
  const root = document.documentElement;
  if (value === null) root.removeAttribute(name);
  else root.setAttribute(name, value);
}

export interface KfTestHandle {
  app: App;
  frameStats(): FrameStats;
  resetFrameStats(): void;
  /**
   * Deterministic stepping: advances `frames` frames (default 1) of `dt` seconds (default
   * 1/60, at most 0.1) and renders. The first call switches the app to a manual clock for
   * the rest of the page's life: frames keep rendering, but time (film, fades, exposure)
   * moves only through step(), and the tier and render scale stop adapting.
   */
  step(frames?: number, dt?: number): void;
  /** The camera as it is now: where it stands and its field of view (degrees). */
  camera(): { position: [number, number, number]; fov: number };
  /** The film's sound (src/ui/film-sound.ts), once the interface has made it. */
  filmSound?: {
    state(): unknown;
    render(chapter: ChapterId, content: ChapterContent, from: number, to: number): Promise<{ rms: number[]; peak: number[] }>;
    recordings(): Promise<unknown[]>;
  };
  /**
   * The assistant (src/ai/boot.ts). start() loads it and resolves to the page's one Intelligence;
   * from then on the assistant's own chunk has replaced this part with one that also has
   * useScripted(), which switches the running assistant to the scripted test engine
   * (src/ai/engine/scripted.ts) with the given replies, labelled "scripted", and useReport(), which
   * makes the engine host's detection answer with a canned device from then on; evaluate() and
   * generations() are the real-model evaluation's (tests/ai-eval).
   */
  ai?: KfAiHandle | Pick<KfAiHandle, 'start'>;
  /**
   * The explorer's more worlds (src/explore/worlds), once they have come (they add this themselves,
   * not through extendTestHandle, which only the shell's own parts use): the GPU's own places of the
   * first `count` asteroids (x, y, z au from the Sun in the render frame, and the index, four numbers
   * each: on their orbits, or `drawn` as drawn, arranged by orbit size or not) and the date they are
   * for (days after the files' epoch, TDB).
   */
  worlds?: {
    probe(count: number, drawn?: boolean): Promise<{ days: number; places: number[] }>;
  };
  /** The solar-system explorer: its state (null when it is not on screen) and an instant camera placement. */
  universe: {
    state(): UniverseView | null;
    /** Throws when the explorer is not on screen. */
    place(pose: UniversePose): void;
    /**
     * Added by the orbital laboratory's chunk once it has loaded (src/explore/lab): a command with its
     * answer (an edit applied or refused, with the reason: a tool can confirm what it did), and what its
     * effects drew in the last frame (src/explore/lab-fx FxReport, read-only).
     */
    lab?(command: LabCommand): Promise<LabEditResult>;
    labDraw?(): unknown;
    /** The laboratory's effects switched on or off for an A/B measurement (src/explore/lab-fx FxParts); null before they have loaded. */
    labEffects?(parts: Partial<Record<'rocks' | 'dust' | 'fire' | 'bands', boolean>>): Record<'rocks' | 'dust' | 'fire' | 'bands', boolean> | null;
  };
}

declare global {
  interface Window {
    __kf?: KfTestHandle;
  }
}

export function exposeTestHandle(handle: KfTestHandle): void {
  window.__kf = handle;
}

/** The assistant's part of the test handle (KfTestHandle.ai). */
export interface KfAiHandle {
  start(): Promise<Intelligence>;
  /** Resolves to the scripted engine's counts: its generations under way now, and the most at once. */
  useScripted(script: readonly ScriptedReply[], options?: ScriptedOptions): Promise<Pick<ScriptedEngine, 'running' | 'mostAtOnce'>>;
  useReport(report: CapabilityReport): Promise<void>;
  /**
   * The real-model evaluation's alone (tests/ai-eval): from now on every generation is recorded (its
   * messages, raw reply, finish, tokens and the engine's own figures), and with router 'skip' a
   * loaded model plans every question, the router bypassed; null puts the shipping order back and
   * stops recording. Clears what was recorded.
   */
  evaluate(options: EvaluationOptions | null): Promise<void>;
  /** The generations recorded since the last call (taken: the next call starts empty). */
  generations(): readonly GenerationRecord[];
}

/** A part of the interface made after the app (the film's sound, the assistant) adds itself to the handle. */
export function extendTestHandle(part: Partial<Pick<KfTestHandle, 'filmSound' | 'ai'>>): void {
  if (window.__kf) Object.assign(window.__kf, part);
}
