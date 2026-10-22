import type { App } from '../core/types';
import { h } from './dom';

interface FrameStats {
  medianFps: number;
  onePercentLowFps: number;
  p99FrameMs: number;
}

const POLL_MS = 1000;

function isFrameStats(value: unknown): value is FrameStats {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.medianFps === 'number' && typeof v.onePercentLowFps === 'number' && typeof v.p99FrameMs === 'number';
}

/** Reads the engine's test hook without assuming its global type declaration. */
function readFrameStats(): FrameStats | null {
  const hook: unknown = Reflect.get(window, '__kf');
  if (typeof hook !== 'object' || hook === null) return null;
  const frameStats: unknown = Reflect.get(hook, 'frameStats');
  if (typeof frameStats !== 'function') return null;
  const stats: unknown = frameStats.call(hook);
  return isFrameStats(stats) ? stats : null;
}

/** The ?fps=1 readout: median fps, 1% low and p99 frame time, plus backend and tier. */
export function createFpsReadout(app: App): HTMLElement {
  const { i18n } = app;
  const element = h('p', { class: 'kf-fps', 'aria-hidden': 'true' });
  window.setInterval(() => {
    const stats = readFrameStats();
    if (!stats) return;
    const readout = i18n.t('ui.fps.readout', {
      median: i18n.number(stats.medianFps, 0),
      low: i18n.number(stats.onePercentLowFps, 0),
      p99: i18n.number(stats.p99FrameMs, 1),
    });
    element.textContent = `${readout} · ${app.backend} · ${app.quality.tier}`;
  }, POLL_MS);
  return element;
}
