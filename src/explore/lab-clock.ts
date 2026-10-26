/**
 * The orbital laboratory's drawn clock (./lab): what the explorer shows of an experiment, between the
 * worker's snapshots.
 *
 * The worker (src/sim/worker) moves in whole steps (from seconds to a day each) and sends a snapshot
 * about 30 times a second, so a clock read off its snapshots runs in stairs at a slow rate and jumps
 * back and forth when one is extrapolated from the last. The drawn clock instead advances every frame
 * at the rate asked for (not the rate achieved over the last second, which lags a change), steered
 * gently (its pace within half the rate either way) toward the moment the worker has been asked for,
 * DRAW_LAG_S behind it, so it is nearly always between two snapshots. It never moves against its
 * direction: it holds rather than jump back (a step past the newest snapshot at most), and only a new
 * timeline (a load, seek, replay, undo, redo, a goto going back) sets it anywhere else.
 *
 * Bodies are drawn at the drawn time: between the two snapshots around it by cubic Hermite
 * interpolation of position and velocity (a few km over a day of the Moon's orbit), or within a step
 * of the nearest one by its velocity and acceleration (pos + vel tau + acc tau^2 / 2).
 */

/** What the clock needs of a snapshot: its time, step and time owed (s), its timeline, and when it arrived (ms, performance.now()). */
export interface ClockSnapshot {
  t: number;
  dt: number;
  owed: number;
  timeline: number;
  at: number;
}

/** What drawing needs of a snapshot: its time and step, the bodies' ids, positions, velocities and accelerations (three per body). */
export interface PlaceSnapshot {
  t: number;
  dt: number;
  ids: readonly string[];
  pos: ArrayLike<number>;
  vel: ArrayLike<number>;
  acc: ArrayLike<number>;
}

/** The drawn clock aims this long (s of real time) behind the moment asked for, so it is drawn between two snapshots (about two snapshots' interval). */
export const DRAW_LAG_S = 0.06;
/** How fast it closes on where it should be (s), how far its pace may stray from the rate (a share either way), and how far behind (s of real time) it jumps forward instead (a stall). */
const STEER_S = 0.25;
const STRAY = 0.5;
const STALL_S = 1;

export type ClockMode = 'run' | 'follow' | 'land';

export class LabClock {
  /** Simulated seconds since the epoch, as drawn. */
  shown = 0;
  private timeline = Number.NaN;

  /** A new scenario: the next snapshot sets the clock wherever it is (its timelines count from 0 again). */
  restart(): void {
    this.shown = 0;
    this.timeline = Number.NaN;
  }

  /**
   * One frame of `wallS` real seconds at `rate` (simulated seconds per real second, signed), running
   * or not, with the newest snapshot `s` (`nowMs`: performance.now()). `mode`: 'run' as above;
   * 'follow' shows the snapshot's own time (a goto under way); 'land' runs on at the rate to the
   * snapshot's time and stops there (paused, or stopped at the start: the worker a little ahead of
   * what is drawn), so what is drawn is then the run exactly as an edit will find it.
   */
  advance(wallS: number, rate: number, running: boolean, s: ClockSnapshot, nowMs: number, mode: ClockMode = 'run'): number {
    if (s.timeline !== this.timeline || mode === 'follow') {
      this.timeline = s.timeline;
      this.shown = s.t;
      return this.shown;
    }
    const speed = Math.abs(rate);
    if (!(wallS > 0) || !(speed > 0)) return this.shown;
    if (mode === 'land') {
      // On to the snapshot's moment in the direction of travel (never back), and still there.
      const d = rate > 0 ? 1 : -1;
      if (d * (s.t - this.shown) > 0) this.shown = d * (this.shown + d * speed * wallS - s.t) > 0 ? s.t : this.shown + d * speed * wallS;
      return this.shown;
    }
    if (!running) return this.shown;
    const d = rate > 0 ? 1 : -1;
    // Where it should be: the moment asked for now, a little behind; and how far behind it is (s of real time at this rate).
    const age = Math.max(0, (nowMs - s.at) / 1000);
    const aim = s.t + d * (s.owed + speed * (age - DRAW_LAG_S));
    const behind = (d * (aim - this.shown)) / speed;
    let next: number;
    if (behind > STALL_S) next = aim;
    else next = this.shown + d * speed * wallS * Math.min(1 + STRAY, Math.max(1 - STRAY, 1 + behind / STEER_S));
    // Never more than a step past the newest snapshot (drawn from it there), and never back.
    const limit = s.t + d * s.dt;
    if (d * (next - limit) > 0) next = limit;
    if (d * (next - this.shown) > 0) this.shown = next;
    return this.shown;
  }
}

/**
 * Body `id`'s place at simulated time `t` (km), from snapshots held oldest first: cubic Hermite
 * between the two around `t` that both have it, else from the nearest that has it by its velocity and
 * acceleration over at most its own step. False when none has it.
 */
export function placeAt(list: readonly PlaceSnapshot[], id: string, t: number, out: number[]): boolean {
  let a: PlaceSnapshot | null = null;
  let b: PlaceSnapshot | null = null;
  for (const s of list) {
    if (s.t <= t && (!a || s.t >= a.t)) a = s;
    if (s.t >= t && (!b || s.t < b.t)) b = s;
  }
  const ia = a ? a.ids.indexOf(id) : -1;
  const ib = b ? b.ids.indexOf(id) : -1;
  if (a && b && ia >= 0 && ib >= 0 && b.t > a.t) {
    const span = b.t - a.t;
    const u = (t - a.t) / span;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let k = 0; k < 3; k += 1) {
      out[k] = h00 * (a.pos[ia * 3 + k] ?? 0) + h10 * span * (a.vel[ia * 3 + k] ?? 0) + h01 * (b.pos[ib * 3 + k] ?? 0) + h11 * span * (b.vel[ib * 3 + k] ?? 0);
    }
    return true;
  }
  // The nearest that has it.
  let near: PlaceSnapshot | null = null;
  let index = -1;
  for (const s of list) {
    const i = s.ids.indexOf(id);
    if (i >= 0 && (!near || Math.abs(s.t - t) < Math.abs(near.t - t))) {
      near = s;
      index = i;
    }
  }
  if (!near) return false;
  const tau = Math.max(-near.dt, Math.min(near.dt, t - near.t));
  for (let k = 0; k < 3; k += 1) out[k] = (near.pos[index * 3 + k] ?? 0) + (near.vel[index * 3 + k] ?? 0) * tau + 0.5 * (near.acc[index * 3 + k] ?? 0) * tau * tau;
  return true;
}
