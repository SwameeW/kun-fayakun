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
 * the bodies' pulls on the way and the rock's own pull on them make the contact differ a little from
 * the request; up to SHOTS times the request is corrected by the difference (shooting) until the speed is
 * within 2 per cent and the angle within 2 degrees, or the throw is refused with its reason.
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
  /** Why it cannot be thrown as asked, or null. */
  refused: string | null;
}

/** Corrections at most, and the tolerances the contact must meet. */
const SHOTS = 5;
const TOLERANCE = { speed: 0.02, angleDeg: 2 } as const;
/** Steps any one integration may take; samples of the path kept for the preview. */
const MAX_STEPS = 400_000;
const PATH_SAMPLES = 240;

const unit = (a: readonly number[]): Vec3 => {
  const l = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  return l > 0 ? [(a[0] ?? 0) / l, (a[1] ?? 0) / l, (a[2] ?? 0) / l] : [1, 0, 0];
};

/** The engine's step for a timescale (Engine.retime). */
const stepFor = (g: IntegratorSettings, shortest: number): number => {
  const dt = g.fixedDtS ?? Math.min(g.dtMaxS, Math.max(g.dtMinS, g.eta * shortest));
  return Number.isFinite(dt) ? dt : g.dtMaxS;
};

/** Runs a copy forward to time `until` with the engine's rules (Engine.stepOnce), calling `each` after every step; stops early when `each` says so. */
function runForward(s: SimState, dt0: number, g: IntegratorSettings, keep: (id: string) => boolean, until: number, events: ContactEvent[], each: () => boolean): void {
  const acc: number[] = [];
  let dt = dt0;
  for (let n = 0; n < MAX_STEPS && s.t < until; n += 1) {
    const shortest = step(s, burnStep(s, dt), acc, events, keep);
    if (g.fixedDtS === null && (g.eta * shortest < 0.5 * dt || s.step % g.retimeSteps === 0)) dt = stepFor(g, shortest);
    if (each()) return;
  }
}

/** Runs a copy backwards by `span` seconds under gravity alone (no contacts: it starts touching): a leapfrog with negative steps. */
function runBackward(s: SimState, g: IntegratorSettings, span: number): void {
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
  }
}

const vecAt = (a: number[], i: number): Vec3 => [a[i * 3] ?? 0, a[i * 3 + 1] ?? 0, a[i * 3 + 2] ?? 0];

/**
 * Works out a throw from `now` (the run's state, bodies only are used) at step size `dt`: see the module
 * comment. Deterministic: the same state and request give the same plan.
 */
export function planThrow(now: SimState, dt: number, g: IntegratorSettings, keep: (id: string) => boolean, req: ThrowRequest): ThrowPlan {
  const base = cloneState(now, false);
  const t0 = base.t;
  const plan: ThrowPlan = { step: base.step, t: t0, pos: [0, 0, 0], vel: [0, 0, 0], contact: null, path: [], shots: 0, refused: null };
  const ti = indexOf(base, req.target);
  if (ti < 0) return { ...plan, refused: 'no such target' };
  if (indexOf(base, req.id) >= 0) return { ...plan, refused: 'that id is taken' };
  const mu = (base.gm[ti] ?? 0) + req.gm;
  const reach = (base.radius[ti] ?? 0) + req.radiusKm;
  if (!(mu > 0) || !(reach > 0) || !(req.leadS > 0) || !(req.vInfKmS >= 0)) return { ...plan, refused: 'not a throw' };
  // The bodies as they will stand at each contact time tried (run ahead once per time).
  const ahead = new Map<number, SimState>();
  const future = (lead: number): SimState | null => {
    const key = Math.round(lead);
    const known = ahead.get(key);
    if (known) return known;
    const s = cloneState(base, false);
    runForward(s, dt, g, keep, t0 + lead - 1e-9, [], () => false);
    // The last bit exactly (a partial step under gravity alone: the bodies only drift a few seconds).
    if (s.t > t0 + lead) runBackward(s, g, s.t - (t0 + lead));
    if (indexOf(s, req.target) < 0) return null;
    ahead.set(key, s);
    return s;
  };
  const site = unit(req.site);
  const along = [0, 1, 2].map((c) => (req.heading[c] ?? 0) - (site[c] ?? 0) * (req.heading[0] * site[0] + req.heading[1] * site[1] + req.heading[2] * site[2]));
  const level = Math.hypot(along[0] ?? 0, along[1] ?? 0, along[2] ?? 0) > 1e-9 ? unit(along) : unit([site[1], -site[0], 0].some((x) => x !== 0) ? [site[1], -site[0], 0] : [1, 0, 0]);
  const wantSpeed = Math.sqrt(req.vInfKmS * req.vInfKmS + (2 * mu) / reach);
  let speed = wantSpeed;
  let angle = Math.min(90, Math.max(1, req.angleDeg));
  let lead = req.leadS;
  for (let shot = 0; shot < SHOTS; shot += 1) {
    plan.shots = shot + 1;
    const fut = future(lead);
    if (!fut) return { ...plan, refused: 'the target is gone before then' };
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
    runBackward(back, g, lead);
    const rb = indexOf(back, req.id);
    const tb = indexOf(back, req.target);
    // Its start relative to the target there, set by the target as it is now.
    const p0 = vecAt(base.pos, ti);
    const v0 = vecAt(base.vel, ti);
    plan.pos = [0, 1, 2].map((c) => (p0[c] ?? 0) + (back.pos[rb * 3 + c] ?? 0) - (back.pos[tb * 3 + c] ?? 0)) as Vec3;
    plan.vel = [0, 1, 2].map((c) => (v0[c] ?? 0) + (back.vel[rb * 3 + c] ?? 0) - (back.vel[tb * 3 + c] ?? 0)) as Vec3;
    if (![...plan.pos, ...plan.vel].every(Number.isFinite)) return { ...plan, refused: 'could not be worked out' };
    // Forwards with the experiment's own rules, as the run will have it once the rock is added at this step.
    const trial = cloneState(base, false);
    addBody(trial, { id: req.id, name: req.name, gm: req.gm, radiusKm: req.radiusKm, pos: plan.pos, vel: plan.vel });
    const events: ContactEvent[] = [];
    resolveContacts(trial, 0, null, events, keep);
    if (events.length > 0) return { ...plan, refused: 'it would start touching another body' };
    const path: number[] = [];
    const every = (lead * 1.5) / PATH_SAMPLES;
    let next = t0;
    let hit: ContactEvent | null = null;
    runForward(trial, stepFor(g, timescale(trial)), g, keep, t0 + lead * 1.5, events, () => {
      const r = indexOf(trial, req.id);
      const t = indexOf(trial, req.target);
      if (r >= 0 && t >= 0 && trial.t >= next) {
        for (let c = 0; c < 3; c += 1) path.push((trial.pos[r * 3 + c] ?? 0) - (trial.pos[t * 3 + c] ?? 0));
        next += every;
      }
      hit = events.find((e) => e.survivor === req.id || e.absorbed === req.id) ?? null;
      return hit !== null;
    });
    plan.path = path;
    const e = hit as ContactEvent | null;
    if (!e) return { ...plan, contact: null, refused: 'it misses: no contact within half as long again as the lead' };
    const other = e.survivor === req.id ? e.absorbed : e.survivor;
    const got = { speed: e.speedKmS, angle: (Math.acos(Math.min(1, Math.max(0, e.b))) * 180) / Math.PI, inS: e.t - t0 };
    plan.contact = { with: other, inS: got.inS, speedKmS: got.speed, angleDeg: got.angle, kind: e.kind, regime: e.regime, craterKm: e.crater?.diameterKm ?? null, energy: e.energy };
    // Another body in the way: that is the outcome (no aim can say otherwise).
    if (other !== req.target) return plan;
    const speedOff = (wantSpeed - got.speed) / wantSpeed;
    const angleOff = req.angleDeg - got.angle;
    if (Math.abs(speedOff) <= TOLERANCE.speed && Math.abs(angleOff) <= TOLERANCE.angleDeg) return plan;
    // Shooting: ask for more (or less) of what fell short, and for the contact when it was asked for.
    speed = Math.max(0.1, speed + (wantSpeed - got.speed));
    angle = Math.min(90, Math.max(1, angle + angleOff));
    lead = Math.max(60, lead + (req.leadS - got.inS));
  }
  return { ...plan, refused: 'could not be aimed within 2 per cent and 2 degrees' };
}
