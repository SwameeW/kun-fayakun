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
  /** ?profile=1: measure GPU time with timestamp queries (where supported) and hold the render scale at 1. */
  profile: boolean;
  /**
   * ?jd=<Julian date>: pins "now" for the sky, so tests and screenshots of astronomy
   * views do not depend on the day they run. Null (the default) follows the real clock.
   * The solar-system explorer reads it (as UTC) unless its own route pins a date.
   */
  jd: number | null;
}

const TIERS: readonly QualityTier[] = ['high', 'mid', 'low'];

/**
 * Accepted Julian dates: 1 January 1 CE to the end of 9999 CE. Anything outside is
 * almost certainly a typo (a Unix time, a year), and is ignored rather than trusted.
 */
const JD_RANGE = { min: 1_721_423.5, max: 5_373_484.5 } as const;

/** A plain-decimal Julian date from 1 CE to 9999 CE, or null (also used by the universe route's ?jd=). */
export function parseJulianDate(value: string | null): number | null {
  const v = value?.trim() ?? '';
  // Number('') is 0 and Number('0x10') is 16: accept plain decimals only.
  if (!/^\d+(?:\.\d+)?$/.test(v)) return null;
  const jd = Number(v);
  return jd >= JD_RANGE.min && jd <= JD_RANGE.max ? jd : null;
}

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
    profile: flag(q.get('profile')) ?? false,
    jd: parseJulianDate(q.get('jd')),
  };
}
