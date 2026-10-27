/*
 * GPU sharing between the scene and the language model (docs/AI-INTELLIGENCE.md §6). The model
 * runs in its own worker on its own GPUDevice, but the page pulls each streamed piece, so the pace
 * of decoding is decided here:
 * - while the visitor drags or flies, at most one piece per animation frame, and one frame more
 *   after any frame longer than 22 ms;
 * - at full speed when the scene is idle;
 * - nothing at all while the tab is hidden.
 * And for the whole of a generation (its prefill too) the render budget holds the picture at a
 * lower scale and keeps the quality governors from reading the model's load as the scene's.
 */
import type { App } from '../../core/types';

/** A frame longer than this (ms) is followed by one waited frame. */
export const SLOW_FRAME_MS = 22;
/** Pointer activity this recent (ms) counts as the scene moving. */
export const POINTER_RECENT_MS = 500;
/** The render scale while the model works (§6: at most 0.75 for prefill). */
export const BUDGET_SCALE = 0.75;

export interface Pacer {
  /** Resolves when the next piece may be pulled. */
  gate(): Promise<void>;
  /** Resolves once the tab is visible (at once if it is). */
  visible(): Promise<void>;
  /** Takes the render budget for a generation (prefill included) or a model's upload and compilation; returns its release (idempotent). */
  hold(): () => void;
  /** Removes the listeners (the pacer is not used after). */
  dispose(): void;
}

const nextFrame = (): Promise<number> =>
  new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });

export function createPacer(app: App): Pacer {
  let lastPointer = -Infinity;
  /** The duration of the last frame seen while a generation holds the budget, ms. */
  let lastFrameMs = 0;
  let holds = 0;
  let release: (() => void) | null = null;
  let watching = false;

  const onPointer = (): void => {
    lastPointer = performance.now();
  };
  const pointerEvents = ['pointerdown', 'pointermove', 'wheel', 'touchmove'] as const;
  for (const type of pointerEvents) window.addEventListener(type, onPointer, { passive: true, capture: true });

  /** Watches frame durations while a generation runs (one rAF callback a frame, nothing else). */
  const watch = (): void => {
    if (watching) return;
    watching = true;
    let previous: number | null = null;
    const tick = (t: number): void => {
      if (holds === 0) {
        watching = false;
        return;
      }
      if (previous !== null) lastFrameMs = t - previous;
      previous = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const moving = (): boolean => app.universe()?.moving === true || performance.now() - lastPointer < POINTER_RECENT_MS;

  const visible = (): Promise<void> =>
    document.hidden
      ? new Promise((resolve) => {
          const onChange = (): void => {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', onChange);
            resolve();
          };
          document.addEventListener('visibilitychange', onChange);
        })
      : Promise.resolve();

  return {
    async gate() {
      await visible();
      if (!moving()) return;
      await nextFrame();
      if (lastFrameMs > SLOW_FRAME_MS) await nextFrame();
    },
    visible,
    hold() {
      holds += 1;
      if (holds === 1) {
        release = app.requestRenderBudget('assistant', { maxScale: BUDGET_SCALE });
        lastFrameMs = 0;
        watch();
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        holds -= 1;
        if (holds === 0) {
          release?.();
          release = null;
        }
      };
    },
    dispose() {
      for (const type of pointerEvents) window.removeEventListener(type, onPointer, { capture: true });
      holds = 0;
      release?.();
      release = null;
    },
  };
}
