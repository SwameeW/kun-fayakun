/**
 * Time scales. The visitor's clock is UTC, and the JPL data is in TDB. The two differ by about
 * 69 s today, which the Moon covers in about 70 km.
 *
 * TT - UTC = DELTA_T_A + (TAI - UTC). The second term is the leap-second count.
 * TDB - TT = K sin(E), E = M + EB sin(M), M = M0 + M1 t. This is NAIF's formula, good to about
 * 30 microseconds.
 * Every constant comes from NAIF's naif0012.tls, through public/assets/jpl/physical.json "time".
 * Before the first leap second (1972) the table's first value is used. After the last one the
 * last value is held, because no later leap second had been announced when the kernel was written.
 */

import { J2000 } from './ephemeris';

export interface LeapSecond {
  /** Julian date (UTC) from which taiMinusUtc applies. */
  jdUtc: number;
  taiMinusUtc: number;
}

/** physical.json "time". */
export interface TimeConstants {
  deltaTA: number;
  k: number;
  eb: number;
  m0: number;
  m1: number;
  leapSeconds: LeapSecond[];
}

export const SECONDS_PER_DAY = 86_400;
/** Unix epoch (1970-01-01 0h UTC) as a Julian date. */
const UNIX_EPOCH_JD = 2440587.5;

/** Julian date (UTC) of a Unix time in milliseconds, which counts UTC days without leap seconds. */
export const julianDateUtc = (unixMs: number): number => unixMs / 86_400_000 + UNIX_EPOCH_JD;

/** TAI - UTC in seconds on a UTC date. */
export function taiMinusUtc(jdUtc: number, time: TimeConstants): number {
  const table = time.leapSeconds;
  let value = table[0]?.taiMinusUtc ?? 0;
  for (const leap of table) {
    if (jdUtc < leap.jdUtc) break;
    value = leap.taiMinusUtc;
  }
  return value;
}

/** TT - UTC in seconds. */
export const ttMinusUtc = (jdUtc: number, time: TimeConstants): number => time.deltaTA + taiMinusUtc(jdUtc, time);

/** TDB - TT in seconds (periodic, within about 1.7 ms). */
export function tdbMinusTt(jdTt: number, time: TimeConstants): number {
  // t is in seconds past J2000. Using TT for TDB here moves M by about 1e-10 rad, which is negligible.
  const M = time.m0 + time.m1 * (jdTt - J2000) * SECONDS_PER_DAY;
  return time.k * Math.sin(M + time.eb * Math.sin(M));
}

export const utcToTt = (jdUtc: number, time: TimeConstants): number => jdUtc + ttMinusUtc(jdUtc, time) / SECONDS_PER_DAY;

export function utcToTdb(jdUtc: number, time: TimeConstants): number {
  const tt = utcToTt(jdUtc, time);
  return tt + tdbMinusTt(tt, time) / SECONDS_PER_DAY;
}
