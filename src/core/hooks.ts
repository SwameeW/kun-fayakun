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
  | 'data-universe-prefetched';

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

/** A part of the interface made after the app (the film's sound) adds itself to the handle. */
export function extendTestHandle(part: Pick<KfTestHandle, 'filmSound'>): void {
  if (window.__kf) Object.assign(window.__kf, part);
}
