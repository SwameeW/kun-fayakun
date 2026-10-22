import type { ChapterMeta } from '../core/types';

/**
 * Placement of timeline stops. True positions are logarithmic in seconds
 * after the beginning; 'before' and 'end' sit at the two ends. Because most
 * of cosmic history crowds into the last few decades of the log scale, the
 * clickable stops are spread to a minimum gap while a tick keeps each true
 * position visible on the axis.
 */

/** Fraction of the track given to the log range; the ends hold "before" and "end". */
const LOG_START = 0.1;
const LOG_END = 0.9;

export interface LogRange {
  minLog: number;
  maxLog: number;
}

export function logRange(epochs: readonly ChapterMeta['epoch'][], nowSeconds: number): LogRange {
  const logs = epochs.filter((e): e is number => typeof e === 'number' && e > 0).map(Math.log10);
  logs.push(Math.log10(nowSeconds));
  return { minLog: Math.min(...logs), maxLog: Math.max(...logs) };
}

/** True position of an epoch on the track, 0 (before time) to 1 (the end). */
export function truePosition(epoch: ChapterMeta['epoch'], range: LogRange): number {
  if (epoch === 'before') return 0;
  if (epoch === 'end') return 1;
  const span = range.maxLog - range.minLog;
  const f = span > 0 ? (Math.log10(epoch) - range.minLog) / span : 0.5;
  return LOG_START + Math.min(1, Math.max(0, f)) * (LOG_END - LOG_START);
}

/** Pool-adjacent-violators: the closest non-decreasing sequence in least squares. */
function isotonic(values: readonly number[]): number[] {
  const blocks: Array<{ mean: number; count: number }> = [];
  for (const value of values) {
    let block = { mean: value, count: 1 };
    for (let prev = blocks.pop(); prev; prev = blocks.pop()) {
      if (prev.mean <= block.mean) {
        blocks.push(prev);
        break;
      }
      const count = prev.count + block.count;
      block = { mean: (prev.mean * prev.count + block.mean * block.count) / count, count };
    }
    blocks.push(block);
  }
  return blocks.flatMap((b) => Array<number>(b.count).fill(b.mean));
}

/**
 * Spreads sorted positions in [0, 1] so neighbours are at least `minGap` apart,
 * moving them as little as possible (least squares). Clusters spread around
 * their centre; clusters at an end are pushed inwards.
 */
export function spreadPositions(positions: readonly number[], minGap: number): number[] {
  const n = positions.length;
  if (n < 2) return [...positions];
  const gap = Math.min(minGap, 1 / (n - 1));
  // Substituting r_i = q_i - i*gap turns "q_{i+1} - q_i >= gap" into "r non-decreasing".
  const shifted = isotonic(positions.map((p, i) => p - i * gap));
  const hi = 1 - (n - 1) * gap;
  return shifted.map((r, i) => Math.min(hi, Math.max(0, r)) + i * gap);
}
