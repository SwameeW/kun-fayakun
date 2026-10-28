import type { Vec3 } from './elements';
import type { IntegratorSettings } from './engine';
import { accelerations, addBody, cloneState, indexOf, resolveContacts, step, timescale, type ContactEvent, type SimState } from './nbody';
import { burnStep } from './ships';

/**
 * Throwing a rock (docs/SANDBOX-ROADMAP.md W1.12): a body set off so that it strikes a target at the
 * speed and angle asked for, after a lead time, with the outcome worked out before it is let go.
 *
 * The speed at contact is Öpik's, v^2 = v_inf^2 + v_esc^2 (the speed far away plus the fall). The rock is
 * put at the contact (on the target's surface at the site given, moving in at the angle from the
 * horizontal asked for) in the system as it will stand then (the bodies run ahead by the engine's own
 * rules), and the whole system is run backwards to now (a time-reversed leapfrog under gravity alone),
 * which gives where it must start. That start is then run forwards with exactly the rules the
 * experiment itself uses (contacts, outcomes and step sizes: ./nbody), so the outcome shown is the one
 * the run will have, step for step, if the rock is added at the same step (Engine.applyAt). The rest of
 * the bodies' pulls on the way and the rock's own pull on them make the contact differ from the request
 * (a heavy rock pulls the bodies it passes off the places they have without it: a Mars passing the Moon
 * moves it by a million kilometres over a month, so a start worked out backwards among their places with
 * it can miss among their places now). So the start is then corrected forwards, by Newton's method (then
 * Broyden's updates, one run each): moved across its way and made faster or slower, from how far it passes
 * from the point it should strike and how fast it strikes, and how a small change of each moves them. It
 * is done when the speed is within 2 per cent and the angle within 2 degrees, or refused with its reason
 * (REFUSED: the panel says what to change). The work is sliced (planner: a generator the worker runs a few
 * milliseconds a tick, so the run never stalls for it); planThrow runs it at once.
 */

export interface ThrowRequest {
  id: string;
  name: string;
  target: string;
  /** The rock's GM (km^3 s^-2) and radius (km). */
  gm: number;
  radiusKm: number;
  /** Its speed far from the target (km/s), the angle at contact from the horizontal (degrees), and the time until contact (s). */
  vInfKmS: number;
  angleDeg: number;
  leadS: number;
  /** Where it strikes (a unit vector from the target's centre, scenario frame) and the way it comes in along the ground there. */
  site: Vec3;
  heading: Vec3;
}

export interface ThrowPlan {
  /** The step and time it was worked out at: the rock is added there (the run goes back to it if it has moved on). */
  step: number;
  t: number;
  /** Where it starts and how fast (scenario frame, absolute). */
  pos: Vec3;
  vel: Vec3;
  /** The contact it makes, run forwards with the experiment's rules: with what, how soon, how fast, at what angle; the event's kind and regime and its crater; null when it makes none in time. */
  contact: { with: string; inS: number; speedKmS: number; angleDeg: number; kind: ContactEvent['kind']; regime: ContactEvent['regime']; craterKm: number | null; energy: number } | null;
  /** Its path relative to the target on the way (km, three numbers a sample), and the corrections it took. */
  path: number[];
  shots: number;
  /** Why it cannot be thrown as asked (REFUSED), or null; for a miss, how near it came (km between the surfaces). */
  refused: ThrowRefusal | null;
  missKm: number | null;
}

/** Why a throw is refused: a word for each (the panel says each in the visitor's words, with what to change). */
export const REFUSED = {
  target: 'target',
  taken: 'taken',
  invalid: 'invalid',
  gone: 'gone',
  unsolved: 'unsolved',
  touching: 'touching',
  misses: 'misses',
  tolerance: 'tolerance',
} as const;
export type ThrowRefusal = (typeof REFUSED)[keyof typeof REFUSED];

/** Corrections of the start at most, runs forwards tried at most (the seed's, each correction's and Newton's small moves), and the tolerances the contact must meet. */
const CORRECTIONS = 9;
const TRIALS = 16;
const TOLERANCE = { speed: 0.02, angleDeg: 2 } as const;
/** Steps any one integration may take; samples of the path kept for the preview; steps between the sliced planner's pauses. */
const MAX_STEPS = 400_000;
const PATH_SAMPLES = 240;
const SLICE_STEPS = 128;

const unit = (a: readonly number[]): Vec3 => {
  const l = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  return l > 0 ? [(a[0] ?? 0) / l, (a[1] ?? 0) / l, (a[2] ?? 0) / l] : [1, 0, 0];
};
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
const dot = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [(a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0), (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];

/** The engine's step for a timescale (Engine.retime). */
const stepFor = (g: IntegratorSettings, shortest: number): number => {
  const dt = g.fixedDtS ?? Math.min(g.dtMaxS, Math.max(g.dtMinS, g.eta * shortest));
  return Number.isFinite(dt) ? dt : g.dtMaxS;
};

/** Runs a copy forward to time `until` with the engine's rules (Engine.stepOnce), calling `each` after every step; stops early when `each` says so. */
function* runForward(s: SimState, dt0: number, g: IntegratorSettings, keep: (id: string) => boolean, until: number, events: ContactEvent[], each: () => boolean): Generator<void, void> {
  const acc: number[] = [];
  let dt = dt0;
  for (let n = 0; n < MAX_STEPS && s.t < until; n += 1) {
    const shortest = step(s, burnStep(s, dt), acc, events, keep);
    if (g.fixedDtS === null && (g.eta * shortest < 0.5 * dt || s.step % g.retimeSteps === 0)) dt = stepFor(g, shortest);
    if (each()) return;
    if (n % SLICE_STEPS === SLICE_STEPS - 1) yield;
  }
}

/** Runs a copy backwards by `span` seconds under gravity alone (no contacts: it starts touching): a leapfrog with negative steps. */
function* runBackward(s: SimState, g: IntegratorSettings, span: number): Generator<void, void> {
  const acc: number[] = [];
  const end = s.t - span;
  let shortest = accelerations(s, acc);
  for (let n = 0; n < MAX_STEPS && s.t > end; n += 1) {
    const dt = -Math.min(stepFor(g, shortest), s.t - end);
    const k = s.ids.length * 3;
    for (let i = 0; i < k; i += 1) s.vel[i] = (s.vel[i] ?? 0) + (acc[i] ?? 0) * dt * 0.5;
    for (let i = 0; i < k; i += 1) s.pos[i] = (s.pos[i] ?? 0) + (s.vel[i] ?? 0) * dt;
    s.t += dt;
    shortest = accelerations(s, acc);
    for (let i = 0; i < k; i += 1) s.vel[i] = (s.vel[i] ?? 0) + (acc[i] ?? 0) * dt * 0.5;
    for (const id of s.fixed) {
      const i = indexOf(s, id);
      if (i >= 0) for (let c = 0; c < 3; c += 1) s.vel[i * 3 + c] = 0;
    }
    if (n % SLICE_STEPS === SLICE_STEPS - 1) yield;
  }
}

const vecAt = (a: number[], i: number): Vec3 => [a[i * 3] ?? 0, a[i * 3 + 1] ?? 0, a[i * 3 + 2] ?? 0];
const dot4 = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, x, k) => sum + x * (b[k] ?? 0), 0);
/** A small linear system (2 or 3 unknowns) by Gaussian elimination with partial pivoting; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, k) => [...row, b[k] ?? 0]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]?.[c] ?? 0) > Math.abs(m[pivot]?.[c] ?? 0)) pivot = r;
    const rows = m;
    [rows[c], rows[pivot]] = [rows[pivot] ?? [], rows[c] ?? []];
    const lead = m[c]?.[c] ?? 0;
    if (!(Math.abs(lead) > 1e-30)) return null;
    for (let r = c + 1; r < n; r += 1) {
      const f = (m[r]?.[c] ?? 0) / lead;
      for (let k = c; k <= n; k += 1) (m[r] as number[])[k] = (m[r]?.[k] ?? 0) - f * (m[c]?.[k] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = m[r]?.[n] ?? 0;
    for (let k = r + 1; k < n; k += 1) sum -= (m[r]?.[k] ?? 0) * (x[k] ?? 0);
    x[r] = sum / (m[r]?.[r] ?? 1);
  }
  return x.every(Number.isFinite) ? x : null;
}

/** A start tried: the contact it made (or none), its path about the target, and how far it passed from the contact point asked for (the nearest point of its path, less that point, km) and from the target's surface. */
interface Trial {
  hit: ContactEvent | null;
  path: number[];
  point: Vec3;
  way: Vec3;
  closestKm: number;
}

/**
 * Works out a throw from `now` (the run's state, bodies only are used) at step size `dt`: see the module
 * comment. Deterministic: the same state and request give the same plan, however it is sliced. A
 * generator: each pause is a slice's end (SLICE_STEPS steps), its value the plan.
 */
export function* planner(now: SimState, dt: number, g: IntegratorSettings, keep: (id: string) => boolean, req: ThrowRequest): Generator<void, ThrowPlan> {
  const base = cloneState(now, false);
  const t0 = base.t;
  const plan: ThrowPlan = { step: base.step, t: t0, pos: [0, 0, 0], vel: [0, 0, 0], contact: null, path: [], shots: 0, refused: null, missKm: null };
  const ti = indexOf(base, req.target);
  if (ti < 0) return { ...plan, refused: REFUSED.target };
  if (indexOf(base, req.id) >= 0) return { ...plan, refused: REFUSED.taken };
  const mu = (base.gm[ti] ?? 0) + req.gm;
  const reach = (base.radius[ti] ?? 0) + req.radiusKm;
  if (!(mu > 0) || !(reach > 0) || !(req.leadS > 0) || !(req.vInfKmS >= 0)) return { ...plan, refused: REFUSED.invalid };
  // The bodies as they will stand at each contact time tried (run ahead once per time).
  const ahead = new Map<number, SimState>();
  function* future(lead: number): Generator<void, SimState | null> {
    const key = Math.round(lead);
    const known = ahead.get(key);
    if (known) return known;
    const s = cloneState(base, false);
    yield* runForward(s, dt, g, keep, t0 + lead - 1e-9, [], () => false);
    // The last bit exactly (a partial step under gravity alone: the bodies only drift a few seconds).
    if (s.t > t0 + lead) yield* runBackward(s, g, s.t - (t0 + lead));
    if (indexOf(s, req.target) < 0) return null;
    ahead.set(key, s);
    return s;
  }
  const site = unit(req.site);
  const along = [0, 1, 2].map((c) => (req.heading[c] ?? 0) - (site[c] ?? 0) * (req.heading[0] * site[0] + req.heading[1] * site[1] + req.heading[2] * site[2]));
  const level = Math.hypot(along[0] ?? 0, along[1] ?? 0, along[2] ?? 0) > 1e-9 ? unit(along) : unit([site[1], -site[0], 0].some((x) => x !== 0) ? [site[1], -site[0], 0] : [1, 0, 0]);
  /** The contact point asked for, from the target's centre (km). */
  const aimAt: Vec3 = [site[0] * reach, site[1] * reach, site[2] * reach];
  const wantSpeed = Math.sqrt(req.vInfKmS * req.vInfKmS + (2 * mu) / reach);
  const speed = wantSpeed;
  const angle = Math.min(90, Math.max(1, req.angleDeg));
  const lead = req.leadS;
  let trials = 0;

  /**
   * Runs a start forwards with the experiment's own rules, as the run will have it once the rock is added
   * at this step; null when it starts touching another body. `point`: where it struck (the contact's own
   * place, from the target's centre), or for a miss the nearest its path came to `aim` (along each step's
   * chord); with its velocity there, relative to the target.
   */
  function* attempt(pos: Vec3, vel: Vec3, aim: Vec3): Generator<void, Trial | null> {
    trials += 1;
    const trial = cloneState(base, false);
    addBody(trial, { id: req.id, name: req.name, gm: req.gm, radiusKm: req.radiusKm, pos, vel });
    const events: ContactEvent[] = [];
    resolveContacts(trial, 0, null, events, keep);
    if (events.length > 0) return null;
    const path: number[] = [];
    const every = (lead * 1.5) / PATH_SAMPLES;
    let next = t0;
    let hit: ContactEvent | null = null;
    let prev: Vec3 | null = null;
    let way: Vec3 = [0, 0, 0];
    let nearest = Number.POSITIVE_INFINITY;
    let point: Vec3 = [0, 0, 0];
    let closestKm = Number.POSITIVE_INFINITY;
    yield* runForward(trial, stepFor(g, timescale(trial)), g, keep, t0 + lead * 1.5, events, () => {
      hit = events.find((e) => e.survivor === req.id || e.absorbed === req.id) ?? null;
      if (hit) return true;
      const r = indexOf(trial, req.id);
      const t = indexOf(trial, req.target);
      if (r < 0 || t < 0) return false;
      const rel = sub(vecAt(trial.pos, r), vecAt(trial.pos, t));
      way = sub(vecAt(trial.vel, r), vecAt(trial.vel, t));
      closestKm = Math.min(closestKm, Math.hypot(...rel) - reach);
      if (prev) {
        const d = sub(rel, prev);
        const u = Math.min(1, Math.max(0, dot(sub(aim, prev), d) / Math.max(dot(d, d), 1e-30)));
        const q: Vec3 = [prev[0] + d[0] * u, prev[1] + d[1] * u, prev[2] + d[2] * u];
        const n = Math.hypot(...sub(q, aim));
        if (n < nearest) {
          nearest = n;
          point = q;
        }
      }
      prev = rel;
      if (trial.t >= next) {
        path.push(...rel);
        next += every;
      }
      // Past the contact time and on its way out, well clear: a miss (nothing nearer to come on this pass).
      return trial.t > t0 + lead && dot(rel, way) > 0 && Math.hypot(...rel) > 4 * reach + nearest;
    });
    const e = hit as ContactEvent | null;
    // Struck: where it touched (the site is from the survivor's centre; the rock's, should it be the heavier).
    if (e) {
      const sign = e.survivor === req.id ? -1 : 1;
      point = [e.site[0] * reach * sign, e.site[1] * reach * sign, e.site[2] * reach * sign];
    }
    return { hit: e, path, point, way, closestKm };
  }

  // The seed: put at the contact asked for, in the system as it will stand, and run backwards to now.
  plan.shots = 1;
  const fut = yield* future(lead);
  if (!fut) return { ...plan, refused: REFUSED.gone };
  const tf = indexOf(fut, req.target);
  // At contact: on the surface at the site, moving in at the angle from the horizontal.
  const a = (angle * Math.PI) / 180;
  const back = cloneState(fut, false);
  const pt = vecAt(back.pos, tf);
  const vt = vecAt(back.vel, tf);
  addBody(back, {
    id: req.id,
    name: req.name,
    gm: req.gm,
    radiusKm: req.radiusKm,
    pos: [0, 1, 2].map((c) => (pt[c] ?? 0) + (site[c] ?? 0) * reach),
    vel: [0, 1, 2].map((c) => (vt[c] ?? 0) + speed * (-Math.sin(a) * (site[c] ?? 0) + Math.cos(a) * (level[c] ?? 0))),
  });
  yield* runBackward(back, g, lead);
  const rb = indexOf(back, req.id);
  const tb = indexOf(back, req.target);
  // Its start relative to the target there, set by the target as it is now.
  const p0 = vecAt(base.pos, ti);
  const v0 = vecAt(base.vel, ti);
  let pos = [0, 1, 2].map((c) => (p0[c] ?? 0) + (back.pos[rb * 3 + c] ?? 0) - (back.pos[tb * 3 + c] ?? 0)) as Vec3;
  let vel = [0, 1, 2].map((c) => (v0[c] ?? 0) + (back.vel[rb * 3 + c] ?? 0) - (back.vel[tb * 3 + c] ?? 0)) as Vec3;
  if (![...pos, ...vel].every(Number.isFinite)) return { ...plan, refused: REFUSED.unsolved };
  let aim: Vec3 = aimAt;
  let tried = yield* attempt(pos, vel, aim);
  if (!tried) return { ...plan, pos, vel, refused: REFUSED.touching };

  /**
   * Corrections on the start itself, by Newton's method (then Broyden's updates, one run each): moved
   * across its way (u1, u2, square to its velocity relative to the target) and, once it strikes, made
   * faster or slower (a faster start begins further back along its way, so it comes at the same time),
   * so that it passes through a point on the target and strikes at the speed asked for. While it misses,
   * the point is the one asked for; once it strikes, it is the point it touched turned in the plane of
   * that point and the way it came until the angle is the one asked for (the engine reads the angle from
   * the pair's angular momentum: cos(angle) = |site x way|). A move that makes things worse is halved
   * (twice at most), then Newton's method begins afresh where it is; when that does no better, this is
   * as near as the throw comes.
   */
  const ahead0 = unit(sub(vel, v0));
  const u1 = unit(cross(ahead0, Math.abs(ahead0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const u2 = cross(ahead0, u1);
  /** A speed off by the tolerance weighs as a point off by the tolerance's angle on the sphere. */
  const speedWeight = (TOLERANCE.angleDeg * Math.PI) / 180 / TOLERANCE.speed;
  /** What is still to correct (point off, in the target's radius; speed off, weighted; none for the speed of a miss). */
  const residual = (x: Trial, at: Vec3): number[] => {
    const off = sub(x.point, at).map((v) => v / reach);
    return x.hit ? [...off, (x.hit.speedKmS / wantSpeed - 1) * speedWeight] : [...off, 0];
  };
  /** How far a trial is from what was asked (in tolerances; a miss always further than a strike). */
  const error = (x: Trial, at: Vec3): number => {
    const h = x.hit;
    if (!h) return 1e3 + Math.hypot(...sub(x.point, at)) / reach;
    const off = (Math.acos(Math.min(1, Math.max(0, h.b))) * 180) / Math.PI - req.angleDeg;
    return Math.max(Math.abs(off) / TOLERANCE.angleDeg, Math.abs(h.speedKmS / wantSpeed - 1) / TOLERANCE.speed);
  };
  /** A start moved by `p` (km across, km across, km/s faster). */
  const moved = (p: readonly number[]): { pos: Vec3; vel: Vec3 } => {
    const rel = sub(vel, v0);
    const u = Math.max(Math.hypot(...rel), 1e-9);
    const k = 1 + (p[2] ?? 0) / u;
    const back = (k - 1) * Math.max(0, -dot(sub(pos, p0), rel) / u);
    const r = rel.map((x) => x / u);
    return {
      pos: [0, 1, 2].map((c) => (pos[c] ?? 0) + (u1[c] ?? 0) * (p[0] ?? 0) + (u2[c] ?? 0) * (p[1] ?? 0) - (r[c] ?? 0) * back) as Vec3,
      vel: [0, 1, 2].map((c) => (v0[c] ?? 0) + (rel[c] ?? 0) * k) as Vec3,
    };
  };
  let J: { columns: number[][]; struck: boolean; fresh: boolean } | null = null;
  for (let shot = 1; ; shot += 1) {
    plan.pos = pos;
    plan.vel = vel;
    plan.path = tried.path;
    const e = tried.hit;
    if (e) {
      const other = e.survivor === req.id ? e.absorbed : e.survivor;
      const got = { speed: e.speedKmS, angle: (Math.acos(Math.min(1, Math.max(0, e.b))) * 180) / Math.PI, inS: e.t - t0 };
      plan.contact = { with: other, inS: got.inS, speedKmS: got.speed, angleDeg: got.angle, kind: e.kind, regime: e.regime, craterKm: e.crater?.diameterKm ?? null, energy: e.energy };
      plan.missKm = null;
      // Another body in the way: that is the outcome (no aim can say otherwise).
      if (other !== req.target) return plan;
      if (Math.abs((wantSpeed - got.speed) / wantSpeed) <= TOLERANCE.speed && Math.abs(req.angleDeg - got.angle) <= TOLERANCE.angleDeg) return plan;
      const w = unit(tried.way);
      const c = unit(tried.point);
      const n = unit(sub(c, w.map((x) => x * dot(c, w))));
      const want = (req.angleDeg * Math.PI) / 180;
      aim = [0, 1, 2].map((k) => reach * (-Math.sin(want) * (w[k] ?? 0) + Math.cos(want) * (n[k] ?? 0))) as Vec3;
    } else {
      plan.contact = null;
      plan.missKm = tried.closestKm;
      aim = aimAt;
    }
    if (shot > CORRECTIONS || trials >= TRIALS) break;
    plan.shots = shot + 1;
    const struck = e !== null;
    const r0 = residual(tried, aim);
    const dims = struck ? 3 : 2;
    if (!J || J.struck !== struck) {
      // Newton's: each parameter moved a little, its effect on what is to correct.
      const h = [Math.max(0.5, 0.02 * Math.min(Math.hypot(...sub(tried.point, aim)), 50 * reach)), 0, 0.005 * Math.hypot(...sub(vel, v0))];
      h[1] = h[0] ?? 0.5;
      const columns: number[][] = [];
      for (let d = 0; d < dims; d += 1) {
        const p = [0, 0, 0];
        p[d] = h[d] ?? 0;
        const m = moved(p);
        const x = yield* attempt(m.pos, m.vel, aim);
        if (!x) break;
        const r = residual(x, aim);
        columns.push(r.map((v, k) => (v - (r0[k] ?? 0)) / (h[d] ?? 1)));
      }
      if (columns.length < dims) break;
      J = { columns, struck, fresh: true };
    }
    // Least squares: (J^T J) p = -J^T r.
    const cols: number[][] = J.columns;
    const A = cols.map((a) => cols.map((b) => dot4(a, b)));
    const b = cols.map((a) => -dot4(a, r0));
    let p = solve(A, b);
    if (!p) break;
    let next: Trial | null = null;
    let at = moved(p);
    for (let halve = 0; halve < 3 && trials < TRIALS; halve += 1) {
      at = moved(p);
      next = yield* attempt(at.pos, at.vel, aim);
      if (!next) return { ...plan, pos: at.pos, vel: at.vel, refused: REFUSED.touching };
      if (error(next, aim) < error(tried, aim)) break;
      p = p.map((x) => x / 2);
    }
    if (!next) break;
    if (error(next, aim) >= error(tried, aim)) {
      // No better: Newton's afresh here (if it already was, this is as near as it comes).
      if (J.fresh) break;
      J = null;
      continue;
    }
    // Broyden's update: the change the move made, less the one expected, spread over the move.
    const r1 = residual(next, aim);
    const pp = p.reduce((sum, x) => sum + x * x, 0);
    if (pp > 0 && (next.hit !== null) === struck) {
      const dp = p;
      const expected = r0.map((_, k) => cols.reduce((sum, col, d) => sum + (col[k] ?? 0) * (dp[d] ?? 0), 0));
      const diff = r1.map((v, k) => v - (r0[k] ?? 0) - (expected[k] ?? 0));
      J = { columns: cols.map((col, d) => col.map((v, k) => v + ((diff[k] ?? 0) * (dp[d] ?? 0)) / pp)), struck, fresh: false };
    }
    pos = at.pos;
    vel = at.vel;
    tried = next;
  }
  if (!plan.contact) return { ...plan, refused: REFUSED.misses };
  return { ...plan, refused: REFUSED.tolerance };
}

/** The planner run at once (the tests, and anything that can wait for it). */
export function planThrow(now: SimState, dt: number, g: IntegratorSettings, keep: (id: string) => boolean, req: ThrowRequest): ThrowPlan {
  const work = planner(now, dt, g, keep, req);
  for (;;) {
    const r = work.next();
    if (r.done) return r.value;
  }
}
