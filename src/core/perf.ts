export interface FrameStats {
  frames: number;
  seconds: number;
  medianFps: number;
  /** Mean fps of the slowest 1% of frames. */
  onePercentLowFps: number;
  p99FrameMs: number;
}

export interface PerfMonitor {
  record(frameMs: number): void;
  /** The next frame's duration includes time the tab was hidden; leave it out. */
  skipNext(): void;
  stats(): FrameStats;
  reset(): void;
  dispose(): void;
}

/** About 18 minutes at 60 fps; older frames are overwritten. */
const CAPACITY = 1 << 16;

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] ?? 0;
}

function round(value: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/** Frame timing for window.__kf.frameStats() (the UI's ?fps=1 readout and perf tests read it). */
export function createPerfMonitor(): PerfMonitor {
  const samples = new Float64Array(CAPACITY);
  let count = 0;
  let total = 0;
  let skip = false;

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') skip = true;
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    record(frameMs) {
      if (skip) {
        skip = false;
        return;
      }
      if (!(frameMs > 0)) return;
      samples[count % CAPACITY] = frameMs;
      count += 1;
      total += frameMs;
    },
    skipNext() {
      skip = true;
    },
    stats() {
      const n = Math.min(count, CAPACITY);
      const sorted = samples.slice(0, n).sort();
      const slowest = sorted.subarray(Math.floor(n * 0.99));
      const slowMean = slowest.length > 0 ? slowest.reduce((a, b) => a + b, 0) / slowest.length : 0;
      const median = percentile(sorted, 0.5);
      return {
        frames: count,
        seconds: round(total / 1000, 3),
        medianFps: median > 0 ? round(1000 / median) : 0,
        onePercentLowFps: slowMean > 0 ? round(1000 / slowMean) : 0,
        p99FrameMs: round(percentile(sorted, 0.99)),
      };
    },
    reset() {
      count = 0;
      total = 0;
      skip = true;
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
