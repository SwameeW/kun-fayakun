import type { ScriptedOptions, ScriptedReply } from '../ai/engine/scripted';
import type { Intelligence } from '../ai/types';
import type { FrameStats } from './perf';
import type { App, ChapterContent, ChapterId, UniversePose, UniverseView } from './types';

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
  };
  /**
   * The assistant (src/ai/boot.ts). start() loads it and resolves to the page's one Intelligence;
   * from then on the assistant's own chunk has replaced this part with one that also has
   * useScripted(), which switches the running assistant to the scripted test engine
   * (src/ai/engine/scripted.ts) with the given replies, labelled "scripted".
   */
  ai?: KfAiHandle | Pick<KfAiHandle, 'start'>;
  /** The solar-system explorer: its state (null when it is not on screen) and an instant camera placement. */
  universe: {
    state(): UniverseView | null;
    /** Throws when the explorer is not on screen. */
    place(pose: UniversePose): void;
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
  useScripted(script: readonly ScriptedReply[], options?: ScriptedOptions): Promise<void>;
}

/** A part of the interface made after the app (the film's sound, the assistant) adds itself to the handle. */
export function extendTestHandle(part: Partial<Pick<KfTestHandle, 'filmSound' | 'ai'>>): void {
  if (window.__kf) Object.assign(window.__kf, part);
}
