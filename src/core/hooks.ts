import type { FrameStats } from './perf';
import type { App, UniversePose, UniverseView } from './types';

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
  | 'data-detail';

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
