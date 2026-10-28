import { BODY_IDS, type BodyId } from '../core/types';
import type { SolarSystem } from './system';

export { theories } from '../astro/analytic';

/**
 * The time machine beyond the everyday, in its own chunk (./index loads it as the clock heads past
 * JPL's tables or runs fast, or a few seconds in): the published theories for dates beyond the tables
 * (src/astro/analytic), and the hold of a world's turn when time runs too fast to show it.
 *
 * Past SPIN_HOLD a frame a world's turn cannot be shown: it would strobe, even seem to turn backwards
 * (at a week a second the Earth turns 42 degrees a frame). So it is drawn at one hour of its own day,
 * the Sun held at the longitude it had there (its seasons still go on). How far it turns is measured
 * from the clock's own change each frame, not the rate set, so a laboratory's goto or a burst from a
 * worker short of its budget counts as much as a fast rate; a jump of the clock (a date, a seek) is a
 * cut, which neither holds nor lets go. It lets go only once the clock has run below SPIN_FREE for
 * SPIN_CALM_S, never while it is stopped or held to real time by a trip. The turn held back is then
 * caught up in the direction time runs (backwards in time, the world turns back), at most
 * SPIN_CATCH_UP_MAX a frame, so no frame turns more than SPIN_HOLD; with reduced motion, at once.
 */

/** A world's turn is held past this many degrees a frame, free under the second (radians), and let go after this long free (s). */
const SPIN_HOLD = (30 * Math.PI) / 180;
const SPIN_FREE = (20 * Math.PI) / 180;
const SPIN_CALM_S = 0.5;
/** The turn held back is caught up at this rate (per second), and at most this much a frame (radians). */
const SPIN_CATCH_UP = 4;
const SPIN_CATCH_UP_MAX = (8 * Math.PI) / 180;

export interface SpinHold {
  /**
   * One frame: `days` the clock moved (signed; 0 for a cut or none), `dt` real seconds, `running`
   * whether it runs on its own (not paused, not held to real time by a trip), and reduced motion.
   * Turns each held world's basis to the hour it is held at, or to the turn still to catch up.
   */
  update(sys: SolarSystem, days: number, dt: number, running: boolean, reduced: boolean): void;
  /** Whether world `id` is held now. */
  held(id: BodyId): boolean;
}

/** `spinDegPerDay`: each world's IAU spin (degrees a day, negative retrograde). */
export function createSpinHold(spinDegPerDay: Readonly<Record<BodyId, number>>): SpinHold {
  /** Each held world: the Sun's longitude held (null once let go), the turn still to catch up (radians), and how long the clock has run free. */
  const holds = new Map<BodyId, { lon: number | null; turn: number; calm: number }>();
  /** The way the clock last ran (1 forwards, -1 backwards). */
  let travel = 1;
  const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
  /** A world's basis turned about its pole by `a` (radians, eastward: the Sun's longitude on it falls by a). */
  const turnBasis = (m: number[], a: number): void => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let k = 0; k < 3; k += 1) {
      const x = m[k] ?? 0;
      const z = m[6 + k] ?? 0;
      m[k] = x * c - z * s;
      m[6 + k] = z * c + x * s;
    }
  };
  /** The Sun's longitude on a world (radians, east positive). */
  const sunLongitude = (sys: SolarSystem, id: BodyId): number => {
    const m = sys.bodies[id].basis;
    const p = sys.bodies[id].position;
    const sun = sys.bodies.sun.position;
    const d = [sun.x - p.x, sun.y - p.y, sun.z - p.z];
    const dot = (o: number): number => (d[0] ?? 0) * (m[o] ?? 0) + (d[1] ?? 0) * (m[o + 1] ?? 0) + (d[2] ?? 0) * (m[o + 2] ?? 0);
    return Math.atan2(-dot(6), dot(0));
  };
  return {
    update(sys, days, dt, running, reduced) {
      if (days !== 0) travel = days > 0 ? 1 : -1;
      for (const id of BODY_IDS) {
        if (id === 'sun') continue;
        const perFrame = Math.abs(days * spinDegPerDay[id]) * (Math.PI / 180);
        let h = holds.get(id);
        // Held where it was drawn the frame before (this frame's turn undone; catching up or not): no jump.
        if (dt > 0 && perFrame > SPIN_HOLD && h?.lon == null) holds.set(id, (h = { lon: sunLongitude(sys, id) + spinDegPerDay[id] * days * (Math.PI / 180) - (h?.turn ?? 0), turn: h?.turn ?? 0, calm: 0 }));
        if (!h) continue;
        if (h.lon !== null) {
          // Free only while the clock runs on its own below SPIN_FREE; stopped, or held to real time by a trip, it stays held.
          if (perFrame >= SPIN_FREE) h.calm = 0;
          else if (dt > 0 && running) h.calm += dt;
          if (h.calm >= SPIN_CALM_S) {
            // Let go: the turn held back, to be caught up the way time runs (a whole turn at most, shrinking); with reduced motion, at once.
            const behind = wrap(sunLongitude(sys, id) - h.lon);
            const sign = Math.sign(spinDegPerDay[id] * travel) || 1;
            h.turn = sign > 0 ? (behind > 0 ? behind - 2 * Math.PI : behind) : behind < 0 ? behind + 2 * Math.PI : behind;
            h.lon = null;
          } else h.turn = wrap(sunLongitude(sys, id) - h.lon);
        }
        if (h.lon === null) {
          if (reduced) h.turn = 0;
          else if (dt > 0 && running) {
            const step = Math.min(Math.abs(h.turn) * (1 - Math.exp(-SPIN_CATCH_UP * Math.min(0.1, dt))), SPIN_CATCH_UP_MAX);
            h.turn -= Math.sign(h.turn) * step;
          }
          if (Math.abs(h.turn) < 1e-3) {
            holds.delete(id);
            continue;
          }
        }
        turnBasis(sys.bodies[id].basis, h.turn);
      }
    },
    held(id) {
      return holds.get(id)?.lon != null;
    },
  };
}
