/**
 * Each fireball's light frame by frame, as the laboratory's browser specs read it back (tests/explore/lab-flash):
 * how far it changed between two samples, as a share of what the effects allow, a thirtieth of its peak a
 * 60th of a second (src/explore/lab-fx/fireball: a rise of 0.8 s, never more than that a frame), by the time
 * the effects were advanced between the two samples (their own clock: a sample a frame late or early is not
 * a frame of change).
 *
 * A fireball's peak is the most it is drawn in its life, known only where the whole of its light was
 * watched: not yet drawn on the first frame and gone by the last. One still drawn when the watch ended may
 * have been cut off in its rise, the most it was seen to reach then a small part of its peak (a fireball
 * begun three frames before the end has reached a hundredth of it), and every eased step of its rise would
 * read as many times a thirtieth of that. The watch therefore goes on past its window until every fireball
 * begun in the window has gone (its frames after are `extra`), and a fireball begun only in that extra time
 * and still drawn at the end is not judged.
 *
 * Its light is its own (src/explore/lab-fx FxReport `emitted`), before its body's limb hides any of it: how
 * much shows past the limb (`seen`) follows the geometry (the body turning, the camera moving) and is eased on
 * its own, from all of it to none over half a second at most (fireball.ts seenToward), checked apart. Judged
 * together, a fireball mostly behind the limb would be judged on a peak the limb made small, and the limb's
 * own change no fireball can know ahead would read as its light stepping. What the screen shows, each tile's
 * light whatever made it, is the flash guard's, which the spec checks on the canvas read back.
 */

/** A sample: when (s, the page's frame time), the effects' clock (s), each fireball drawn (its key, its own light and, where read, how much shows past the limb), past the window asked for. */
export interface LightFrame {
  t: number;
  fx: number;
  fire: ReadonlyArray<readonly [string, number, number?]>;
  extra?: boolean;
}

/**
 * One fireball's light: its peak, whether its whole life was watched, begun past the window, and its largest
 * step as a share of what is allowed (where, from what to what); and the largest change in how much of it
 * shows past the limb, as a share of what its ease allows (all of it over half a second), and where.
 */
export interface LightSteps {
  key: string;
  peak: number;
  whole: boolean;
  extra: boolean;
  worst: number;
  t: number;
  before: number;
  now: number;
  seenWorst: number;
  seenT: number;
}

const lightOf = (f: LightFrame, key: string): number | undefined => f.fire.find((x) => x[0] === key)?.[1];
const seenOf = (f: LightFrame, key: string): number | undefined => f.fire.find((x) => x[0] === key)?.[2];

/** Every fireball's light through `frames` (see the module comment); a step is judged against the peak only for a fireball watched whole. */
export function fireballSteps(frames: readonly LightFrame[]): LightSteps[] {
  const first = frames[0];
  const last = frames.at(-1);
  const out = new Map<string, LightSteps>();
  for (const f of frames)
    for (const [key, lum] of f.fire) {
      let s = out.get(key);
      if (!s) {
        s = { key, peak: 0, whole: false, extra: f.extra === true, worst: 0, t: f.t, before: 0, now: 0, seenWorst: 0, seenT: f.t };
        out.set(key, s);
      }
      s.peak = Math.max(s.peak, lum);
    }
  for (const s of out.values()) s.whole = first !== undefined && last !== undefined && lightOf(first, s.key) === undefined && lightOf(last, s.key) === undefined;
  for (let k = 1; k < frames.length; k += 1) {
    const a = frames[k - 1];
    const b = frames[k];
    if (!a || !b || b.fx === a.fx) continue;
    const dt = Math.max(b.fx - a.fx, 1 / 60);
    for (const s of out.values()) {
      // How much shows past the limb, between two frames it was drawn in (on its first it is as it is).
      const seenA = seenOf(a, s.key);
      const seenB = seenOf(b, s.key);
      if (seenA !== undefined && seenB !== undefined) {
        const share = Math.abs(seenB - seenA) / (dt * 2);
        if (share > s.seenWorst) Object.assign(s, { seenWorst: share, seenT: b.t });
      }
      if (!(s.peak > 0)) continue;
      const before = lightOf(a, s.key) ?? 0;
      const now = lightOf(b, s.key) ?? 0;
      const share = Math.abs(now - before) / (s.peak * dt * 2);
      if (share > s.worst) Object.assign(s, { worst: share, t: b.t, before, now });
    }
  }
  return [...out.values()];
}
