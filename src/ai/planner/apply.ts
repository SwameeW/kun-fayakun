import type { LabCommand } from '../../core/types';
import { airlessRock } from '../../sim/climate';
import { SOLID_MAX_GM } from '../../sim/craters';
import { orbitalFrame, stateFromElements, type Vec3 } from '../../sim/elements';
import type { BodySpec, Engine } from '../../sim/engine';
import { circularOrbit, primaryOf, type SimState } from '../../sim/nbody';

/**
 * The laboratory's commands applied to a headless engine (src/sim/engine.ts) the way src/explore/lab.ts
 * turns them into the engine's edits, for the commands the planner makes: a mass (the radius kept), a
 * body removed, a kick about its primary, new orbital elements, a body added on a circular orbit or at
 * a state. Kilograms go through the same one G the laboratory uses. A new solid body is given an
 * airless rock's climate, as the laboratory gives it. Each goes through Engine.apply, so it is logged,
 * checkpointed and undoable like the visitor's own edits.
 */

const DEG = Math.PI / 180;

const at = (a: readonly number[], k: number): Vec3 => [a[k * 3] ?? 0, a[k * 3 + 1] ?? 0, a[k * 3 + 2] ?? 0];
const add3 = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] ?? 0) + (b[0] ?? 0), (a[1] ?? 0) + (b[1] ?? 0), (a[2] ?? 0) + (b[2] ?? 0)];
const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
const scale3 = (a: readonly number[], f: number): Vec3 => [(a[0] ?? 0) * f, (a[1] ?? 0) * f, (a[2] ?? 0) * f];
const norm3 = (a: readonly number[]): number => Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);

/** Body i relative to its primary: the primary's index, position and velocity, and the pair's GM; null without one. */
function relativeTo(s: SimState, i: number): { p: number; r: Vec3; v: Vec3; mu: number } | null {
  const p = primaryOf(s.gm, s.pos, i);
  if (p < 0) return null;
  return { p, r: sub3(at(s.pos, i), at(s.pos, p)), v: sub3(at(s.vel, i), at(s.vel, p)), mu: (s.gm[p] ?? 0) + (s.gm[i] ?? 0) };
}

/** The pole of a body's orbit about its primary (or the reference plane's). */
function poleOf(s: SimState, i: number): Vec3 {
  const rel = relativeTo(s, i);
  if (!rel) return [0, 0, 1];
  const n: Vec3 = [rel.r[1] * rel.v[2] - rel.r[2] * rel.v[1], rel.r[2] * rel.v[0] - rel.r[0] * rel.v[2], rel.r[0] * rel.v[1] - rel.r[1] * rel.v[0]];
  return norm3(n) > 0 ? n : [0, 0, 1];
}

/** A fresh id, never used before in this scenario (its start, its state, its log). */
function freshId(engine: Engine, base: string): string {
  const used = new Set([...engine.scenario.bodies.map((b) => b.id), ...engine.state.ids, ...engine.scenario.log.map((e) => (e.command.kind === 'add' ? e.command.body.id : ''))]);
  let k = 1;
  while (used.has(`${base}-${k}`)) k += 1;
  return `${base}-${k}`;
}

/** A new body as the laboratory adds it (a solid one with an airless rock's climate). */
function added(engine: Engine, name: string, gm: number, radiusKm: number, pos: Vec3, vel: Vec3): string {
  const id = freshId(engine, 'body');
  const body: BodySpec = { id, name: name.slice(0, 60) || id, gm, radiusKm, pos, vel, origin: 'user-edited', sourceIds: [] };
  if (gm > 0 && gm <= SOLID_MAX_GM) body.climate = airlessRock();
  engine.apply({ kind: 'add', body });
  return id;
}

export type Applied = { ok: true; id: string } | { ok: false; reason: string };

/** Applies one laboratory command to the engine; the body it concerns (a new one's id), or why it was not applied. */
export function applyLabCommand(engine: Engine, c: LabCommand, gPerKg: number): Applied {
  const s = engine.state;
  const index = (id: string): number => s.ids.indexOf(id);
  switch (c.kind) {
    case 'mass': {
      if (index(c.id) < 0 || !(Number.isFinite(c.massKg) && c.massKg >= 0)) return { ok: false, reason: 'no such body, or not a mass' };
      engine.apply({ kind: 'setMass', id: c.id, gm: c.massKg * gPerKg });
      return { ok: true, id: c.id };
    }
    case 'remove':
      if (index(c.id) < 0 || engine.keep(c.id)) return { ok: false, reason: 'no such body, or one the scenario keeps' };
      engine.apply({ kind: 'remove', id: c.id });
      return { ok: true, id: c.id };
    case 'impulse': {
      const i = index(c.id);
      if (i < 0 || ![c.progradeMs, c.normalMs, c.radialMs].every(Number.isFinite)) return { ok: false, reason: 'no such body, or not a kick' };
      const rel = relativeTo(s, i);
      const v = at(s.vel, i);
      const f = rel ? orbitalFrame(rel.r, rel.v) : orbitalFrame(at(s.pos, i), v);
      const dv = add3(add3(scale3(f.prograde, c.progradeMs / 1000), scale3(f.normal, c.normalMs / 1000)), scale3(f.radial, c.radialMs / 1000));
      engine.apply({ kind: 'setVelocity', id: c.id, vel: add3(v, dv) });
      return { ok: true, id: c.id };
    }
    case 'elements': {
      const i = index(c.id);
      const rel = i >= 0 ? relativeTo(s, i) : null;
      if (!rel || ![c.aKm, c.e, c.iDeg, c.nodeDeg, c.periapsisArgDeg, c.trueAnomalyDeg].every(Number.isFinite)) return { ok: false, reason: 'no orbit to change' };
      if (c.e < 0 || Math.abs(c.e - 1) < 1e-9 || (c.e < 1 && !(c.aKm > 0)) || (c.e > 1 && !(c.aKm < 0))) return { ok: false, reason: 'not an orbit' };
      const st = stateFromElements({ a: c.aKm, e: c.e, i: c.iDeg * DEG, node: c.nodeDeg * DEG, periapsisArg: c.periapsisArgDeg * DEG, trueAnomaly: c.trueAnomalyDeg * DEG }, rel.mu);
      if (![...st.r, ...st.v].every(Number.isFinite) || norm3(st.r) <= (s.radius[rel.p] ?? 0)) return { ok: false, reason: 'inside its primary' };
      engine.apply({ kind: 'setState', id: c.id, pos: add3(at(s.pos, rel.p), st.r), vel: add3(at(s.vel, rel.p), st.v) });
      return { ok: true, id: c.id };
    }
    case 'addOrbit': {
      const p = index(c.primary);
      if (p < 0 || !(c.distanceKm > (s.radius[p] ?? 0)) || !(c.massKg >= 0) || !(c.radiusKm > 0)) return { ok: false, reason: 'no such primary, or inside it' };
      const gm = c.massKg * gPerKg;
      // In the plane of the primary's own orbit, starting on its far side from its own primary.
      const pp = primaryOf(s.gm, s.pos, p);
      const along = pp >= 0 ? sub3(at(s.pos, p), at(s.pos, pp)) : ([1, 0, 0] as Vec3);
      const placed = circularOrbit(s, p, c.distanceKm, gm, poleOf(s, p), along);
      return { ok: true, id: added(engine, c.name, gm, c.radiusKm, placed.pos as Vec3, placed.vel as Vec3) };
    }
    case 'addState': {
      const p = index(c.relativeTo);
      if (p < 0 || ![...c.posKm, ...c.velKmS].every(Number.isFinite) || !(c.massKg >= 0) || !(c.radiusKm > 0)) return { ok: false, reason: 'no such body, or not a state' };
      return { ok: true, id: added(engine, c.name, c.massKg * gPerKg, c.radiusKm, add3(at(s.pos, p), c.posKm), add3(at(s.vel, p), c.velKmS)) };
    }
    default:
      return { ok: false, reason: `${c.kind} is not run headless` };
  }
}
