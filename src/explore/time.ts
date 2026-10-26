import type { UniverseTimeCommand } from '../core/types';

/**
 * The explorer's time machine: how fast its clock runs (explorer seconds for each real second),
 * forwards or backwards, paused or running, stepped along a ladder of rates from real time to thirty
 * days a second. Everything the explorer shows follows the clock: the worlds along their orbits, the
 * Moon's phase, each world's turn, day and night, eclipses, the day's imagery of the Earth.
 *
 * The clock stays inside the dates the explorer can show (src/astro/ephemeris: JPL's tables where
 * they reach, the published theories beyond them): it stops at either end, and a press of play,
 * faster or slower there turns it round, so no press is ever lost. During a trip it runs at real
 * time, so the destination does not race away from the camera; on foot or on the way down through
 * an air it runs at most FOOT_MAX_RATE, because there the light of the whole view follows the Sun's
 * height (flash safety, docs/CONTRACTS.md). The laboratory's clock (./lab) takes the same commands
 * through the same reducer.
 */

/** Explorer seconds per real second, smallest first: real time, then ten seconds, a minute, ten minutes, an hour, six hours, a day, a week, thirty days. */
export const TIME_RATES = [1, 10, 60, 600, 3600, 21_600, 86_400, 604_800, 2_592_000] as const;
/** The fastest rung: no command runs the clock faster (a rate asked for beyond it is held to it). */
export const MAX_RATE = 2_592_000;
/**
 * On foot, or on the way down through an atmosphere, the clock runs at most an hour a second: a day
 * passes in 24 seconds, so the sky and the ground darken and brighten once in that time, never
 * more than 3 times a second (at a week a second the Sun would cross the horizon 14 times a second).
 */
export const FOOT_MAX_RATE = 3600;
/**
 * In an experiment (./lab) a date can be gone to from its fork to this long after it (s: a century).
 * Before the fork it has no history; after, the worker integrates there within its budget.
 */
export const LAB_DATE_SPAN_S = 100 * 365.25 * 86_400;

export type TimeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week';
export type TimeEdge = 'start' | 'end' | null;

/** The clock's state as a command finds and leaves it: the rate set (negative backwards), whether paused, and the end it stopped at. */
export interface ClockState {
  rate: number;
  paused: boolean;
  edge: TimeEdge;
}

const direction = (rate: number): number => (rate < 0 ? -1 : 1);
/** Rungs compared with a little slack, so a rate that is a rung (or a rounding of one) counts as on it. */
const SAME = 1 + 1e-9;

/** The next rung up from a rate's size, in the same direction (the fastest stays fastest). */
export function fasterRate(rate: number): number {
  const size = Math.abs(rate);
  return direction(rate) * (TIME_RATES.find((r) => r > size * SAME) ?? MAX_RATE);
}

/** The next rung down from a rate's size, in the same direction (never slower than real time). */
export function slowerRate(rate: number): number {
  const size = Math.abs(rate);
  let next = 1;
  for (const r of TIME_RATES) if (r * SAME < size) next = r;
  return direction(rate) * next;
}

/** A rate in words' parts: how many of which unit pass each real second (1 second is real time). */
export function rateParts(rate: number): { count: number; unit: TimeUnit } {
  const size = Math.abs(rate);
  if (size >= 604_800 && size % 604_800 === 0) return { count: size / 604_800, unit: 'week' };
  if (size >= 86_400 && size % 86_400 === 0) return { count: size / 86_400, unit: 'day' };
  if (size >= 3600 && size % 3600 === 0) return { count: size / 3600, unit: 'hour' };
  if (size >= 60 && size % 60 === 0) return { count: size / 60, unit: 'minute' };
  return { count: size, unit: 'second' };
}

/**
 * A command as the clock may take it, or null: a rate or a date that is not a finite number is
 * refused (from an interface, a lesson or an assistant alike), and a rate's size is held to
 * [1, MAX_RATE] (0, or -0, pauses).
 */
export function validTimeCommand(command: UniverseTimeCommand): UniverseTimeCommand | null {
  if (command.kind === 'rate') {
    if (typeof command.rate !== 'number' || !Number.isFinite(command.rate)) return null;
    if (command.rate === 0) return { kind: 'rate', rate: 0 };
    return { kind: 'rate', rate: direction(command.rate) * Math.min(MAX_RATE, Math.max(1, Math.abs(command.rate))) };
  }
  if (command.kind === 'date') return typeof command.jdUtc === 'number' && Number.isFinite(command.jdUtc) ? command : null;
  return command;
}

/** Whether the rate points into the end the clock stopped at (so running would stop it again at once). */
export const intoEdge = (s: ClockState): boolean => (s.edge === 'start' && s.rate < 0) || (s.edge === 'end' && s.rate > 0);

/**
 * One command applied to the clock (a pure reducer, shared by the explorer and the laboratory).
 * Faster and slower step to the next rung (never past `cap`, the most the clock may run at now), keep
 * the direction and set the clock running; reverse turns it round and runs; now runs at real time; a
 * rate of 0 pauses. At an end, with the rate pointing into it, play, faster and slower first turn the
 * clock round (`turned`), so every press moves it; a rate set into that end leaves it paused there. A
 * date leaves the end (the caller sets it again if the date was out of range).
 */
export function applyTimeCommand(state: ClockState, command: UniverseTimeCommand, cap = MAX_RATE): { state: ClockState; turned: boolean } {
  let { rate, paused } = state;
  const { edge } = state;
  const turned = intoEdge(state) && (command.kind === 'toggle' || command.kind === 'faster' || command.kind === 'slower');
  if (turned) rate = -rate;
  // The rate as the clock runs it now (held to the cap): faster and slower step from what is seen.
  const shown = direction(rate) * Math.min(Math.abs(rate), cap);
  switch (command.kind) {
    case 'toggle':
      paused = turned ? false : !paused;
      break;
    case 'faster':
      if (Math.abs(rate) < cap) rate = direction(rate) * Math.min(cap, Math.abs(fasterRate(shown)));
      paused = false;
      break;
    case 'slower':
      rate = slowerRate(shown);
      paused = false;
      break;
    case 'reverse':
      rate = -rate;
      paused = false;
      break;
    case 'now':
      rate = 1;
      paused = false;
      break;
    case 'date':
      break;
    case 'rate':
      if (command.rate === 0) paused = true;
      else {
        rate = command.rate;
        paused = false;
      }
      break;
  }
  const next: ClockState = { rate, paused, edge: command.kind === 'date' || command.kind === 'now' ? null : edge };
  // Still pointing into the end it stopped at: it stays there, paused. Otherwise it has left it.
  if (intoEdge(next)) next.paused = true;
  else next.edge = null;
  return { state: next, turned };
}

/** The rate the clock runs at: real time during a trip, at most FOOT_MAX_RATE on foot or on the way down. */
export function heldRate(rate: number, held: 'trip' | 'foot' | null): number {
  if (held === 'trip') return direction(rate);
  if (held === 'foot') return direction(rate) * Math.min(Math.abs(rate), FOOT_MAX_RATE);
  return rate;
}

/**
 * The clock's next date (Julian days) after `dtSeconds` of real time at `rate`, kept in [start, end],
 * and which end it stopped at (null if neither). A step that is not a finite number leaves the date
 * where it was.
 */
export function advanceClock(jd: number, dtSeconds: number, rate: number, start: number, end: number): { jd: number; edge: TimeEdge } {
  const next = jd + (dtSeconds * rate) / 86_400;
  if (!Number.isFinite(next)) return { jd, edge: null };
  if (next >= end) return { jd: end, edge: rate > 0 ? 'end' : null };
  if (next <= start) return { jd: start, edge: rate < 0 ? 'start' : null };
  return { jd: next, edge: null };
}
