import type { FrameStats } from './perf';
import type { App } from './types';

/** <html> attributes that tests wait on (docs/CONTRACTS.md, "Test hooks"). */
export type HookAttribute =
  | 'data-backend'
  | 'data-tier'
  | 'data-state'
  | 'data-chapter'
  | 'data-ready'
  | 'data-chapter-ready'
  | 'data-reduced-motion';

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
}

declare global {
  interface Window {
    __kf?: KfTestHandle;
  }
}

export function exposeTestHandle(handle: KfTestHandle): void {
  window.__kf = handle;
}
