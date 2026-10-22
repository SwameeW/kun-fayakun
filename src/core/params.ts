import type { QualityTier } from './types';

/** Query parameters that change how the app starts (see docs/CONTRACTS.md). */
export interface LaunchParams {
  /** ?forceWebGL=1: use the WebGL2 backend even when WebGPU is available. */
  forceWebGL: boolean;
  /** ?tier=high|mid|low: fixed quality tier; also disables the governor. */
  tier: QualityTier | null;
  /** ?reducedMotion=1|0: overrides prefers-reduced-motion; null follows the OS setting. */
  reducedMotion: boolean | null;
  /** ?autoplay=1: skip the intro overlay and start playing. */
  autoplay: boolean;
  /** ?fps=1: show a small fps readout. */
  showFps: boolean;
}

const TIERS: readonly QualityTier[] = ['high', 'mid', 'low'];

function flag(value: string | null): boolean | null {
  if (value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === '') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return null;
}

function tier(value: string | null): QualityTier | null {
  const v = value?.trim().toLowerCase();
  return TIERS.find((t) => t === v) ?? null;
}

export function readLaunchParams(search: string = window.location.search): LaunchParams {
  const q = new URLSearchParams(search);
  return {
    forceWebGL: flag(q.get('forceWebGL')) ?? false,
    tier: tier(q.get('tier')),
    reducedMotion: flag(q.get('reducedMotion')),
    autoplay: flag(q.get('autoplay')) ?? false,
    showFps: flag(q.get('fps')) ?? false,
  };
}
