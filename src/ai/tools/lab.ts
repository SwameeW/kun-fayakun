import { BODY_IDS, type LabCommand, type UniverseLab } from '../../core/types';
import type { Baseline } from '../planner/compare';
import { EXPERIMENT_IDS, EXPERIMENT_PARAMS, experimentPreview, experimentProblems, HORIZON_DAYS, isPlan, planExperiment, resolveBody, worldFromContext, worldFromLab, type PlanNames, type PlanWorld } from '../planner/experiments';
import type { OptimiseSearch } from '../planner/optimise';
import type { AiContext, ExperimentId, Fact, JsonSchema, ToolDefinition, ToolEnv, ToolOutcome, UndoOutcome } from '../types';
import { dateJdTdb, jplData } from './data';
import { done, ensureExplorer, ensureMessages, fact, failed, LAB_BODY, notConfirmed, num, OPEN_MS, problem, refused, say, settle, sig, str, view, waitFor } from './shared';

/**
 * The orbital laboratory (src/explore/lab.ts): open it, read it, change it with an experiment (shown
 * first as a card the visitor confirms), undo, measure; and, in the background without changing
 * anything on screen, compare an experiment with the laboratory as it is, or search one of its numbers
 * for a goal. The laboratory acknowledges nothing and ignores what it cannot do without a word, so
 * every input is checked first (./planner/experiments.ts) and every edit confirmed by reading the
 * laboratory back: a mass changed, a body gone, a new body found by name, an orbit as asked.
 *
 * An experiment stops sending at once when its turn is stopped, and reports what it did send. Its
 * Undo is its own edits, not whatever edit is newest: it is refused while a later edit sits on top
 * (or once the laboratory no longer shows the experiment), and it reports done only when the
 * laboratory reads back as it was before.
 */

const QUICK_MS = 5000;

const inLab = (ctx: AiContext): boolean => ctx.where === 'lab';
const labView = (env: ToolEnv): UniverseLab | null => view(env)?.lab ?? null;

/** Names the planner gives new bodies, in the visitor's language. */
const planNames = (env: ToolEnv): PlanNames => ({ moon: say(env.i18n, 'ai.tool.experiment.name.moon'), star: say(env.i18n, 'ai.tool.experiment.name.star'), impactor: say(env.i18n, 'ai.tool.experiment.name.impactor') });

/* ----- An experiment's arguments: its id and its parameters, flat ----- */

const paramSchema = (): Record<string, JsonSchema> => {
  const out: Record<string, JsonSchema> = { experiment: { type: 'string', enum: EXPERIMENT_IDS } };
  for (const spec of Object.values(EXPERIMENT_PARAMS)) {
    for (const [name, p] of Object.entries(spec)) {
      if (p.kind === 'body') out[name] = LAB_BODY;
      else if (p.kind === 'number') out[name] = { type: 'number', minimum: p.min, maximum: p.max };
      else out[name] = { type: 'string', enum: p.of };
    }
  }
  out.horizonDays = { type: 'number', minimum: HORIZON_DAYS.min, maximum: HORIZON_DAYS.max, description: 'Days to integrate ahead' };
  return out;
};

const EXPERIMENT_ARGS = { type: 'object', properties: paramSchema(), required: ['experiment'], additionalProperties: false } as const satisfies JsonSchema;

/*
 * What a model is offered (ToolDefinition.argsFor). A laboratory body's own schema is a pattern over
 * Unicode letters, which XGrammar cannot read: Qwen3 4B, held to it, wrote "N" and "L" for every body
 * (docs/AI-EVALUATION.md). So a model is given the bodies by id (the laboratory's own, or the solar
 * system's ten worlds outside it), and each experiment as a form of its own, its parameters all
 * required, so the grammar holds a plan to the parameters of the experiment it names.
 */
const labBodyIds = (ctx: AiContext): string[] => (ctx.lab ? ctx.lab.bodies.map((b) => b.id) : [...BODY_IDS]);
const labBody = (ctx: AiContext): JsonSchema => ({ type: 'string', enum: labBodyIds(ctx), description: 'A laboratory body, by id' });

/**
 * What each number means, shown beside it in the plan's prompt. Without them three models made "the
 * Sun 10% heavier" an orbit 1.1 times as wide (change-orbit's aFactor, not scale-mass's factor).
 */
const PARAM_NOTES: Readonly<Record<string, string>> = {
  factor: "multiply the body's mass by this",
  dvKmS: 'km/s added to its speed',
  diameterKm: "the impactor's size, km",
  speedKmS: 'km/s',
  angleDeg: 'degrees above the horizon',
  distanceKm: 'km from the host',
  massKg: 'kg; a large number as a power of ten: 1e22',
  massSun: 'solar masses',
  distanceAu: 'au from the Sun',
  aFactor: "multiply the orbit's size by this",
  e: 'eccentricity: 0 a circle',
};

function experimentForms(ctx: AiContext): JsonSchema {
  return {
    anyOf: EXPERIMENT_IDS.map((id): JsonSchema => {
      const spec = EXPERIMENT_PARAMS[id];
      const properties: Record<string, JsonSchema> = { experiment: { type: 'string', const: id } };
      for (const [name, p] of Object.entries(spec)) properties[name] = p.kind === 'body' ? labBody(ctx) : p.kind === 'number' ? { type: 'number', minimum: p.min, maximum: p.max, ...(PARAM_NOTES[name] ? { description: PARAM_NOTES[name] } : {}) } : { type: 'string', enum: p.of };
      properties.horizonDays = { type: 'number', minimum: HORIZON_DAYS.min, maximum: HORIZON_DAYS.max, description: 'Days to integrate ahead' };
      return { type: 'object', properties, required: ['experiment', ...Object.keys(spec)], additionalProperties: false };
    }),
  };
}

const experimentOf = (args: Record<string, unknown>): ExperimentId => str(args, 'experiment') as ExperimentId;
const paramsOf = (args: Record<string, unknown>): Record<string, number | string> => {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(args)) if (k !== 'experiment' && (typeof v === 'number' || typeof v === 'string')) out[k] = v;
  return out;
};

const previewText = (args: Record<string, unknown>, ctx: AiContext, i18n: ToolEnv['i18n']): string => {
  const id = experimentOf(args);
  if (!EXPERIMENT_IDS.includes(id)) return say(i18n, 'ai.tool.lab.experiment.previewAny');
  const p = experimentPreview(id, paramsOf(args), worldFromContext(ctx));
  return say(i18n, p.key, p.values);
};

/* ----- Reading edits back ----- */

/** Whether the laboratory shows a command's effect, against how it was before. */
function shows(c: LabCommand, before: UniverseLab, now: UniverseLab): boolean {
  const body = (lab: UniverseLab, id: string) => lab.bodies.find((b) => b.id === id);
  switch (c.kind) {
    case 'mass': {
      const b = body(now, c.id);
      return b !== undefined && Math.abs(b.massKg - c.massKg) <= 1e-6 * Math.max(c.massKg, 1);
    }
    case 'remove':
      return body(now, c.id) === undefined;
    case 'impulse': {
      const a = body(before, c.id);
      const b = body(now, c.id);
      if (!a || !b) return false;
      const dv = Math.hypot(...[0, 1, 2].map((k) => (b.relativeVelKmS[k] ?? 0) - (a.relativeVelKmS[k] ?? 0)));
      return b.edited && dv >= 0.5 * (Math.hypot(c.progradeMs, c.normalMs, c.radialMs) / 1000);
    }
    case 'elements': {
      const o = body(now, c.id)?.orbit;
      return o !== null && o !== undefined && Math.abs(o.aKm - c.aKm) <= 0.02 * c.aKm && Math.abs(o.e - c.e) <= 0.02;
    }
    case 'addOrbit':
    case 'addState':
      // A new body by its name, even one already merged away (its name is kept).
      return Object.entries(now.names).some(([id, name]) => name === c.name && before.names[id] === undefined && !before.bodies.some((b) => b.id === id));
    default:
      return now.undoable > before.undoable;
  }
}

/** Whether an applied edit still shows (what can be told of it: a velocity or an orbit moves on with the run). */
function stillShows(c: LabCommand, prior: UniverseLab, now: UniverseLab): boolean {
  switch (c.kind) {
    case 'mass':
    case 'remove':
    case 'addOrbit':
    case 'addState':
      return shows(c, prior, now);
    default:
      return true;
  }
}

/** Whether the laboratory shows an edit put back: the mass as it was, the body back, the new body gone. */
function putBack(c: LabCommand, prior: UniverseLab, now: UniverseLab): boolean {
  const body = (lab: UniverseLab, id: string) => lab.bodies.find((b) => b.id === id);
  switch (c.kind) {
    case 'mass': {
      const was = body(prior, c.id)?.massKg;
      const is = body(now, c.id)?.massKg;
      return was !== undefined && is !== undefined && Math.abs(is - was) <= 1e-6 * Math.max(was, 1);
    }
    case 'remove':
      return body(now, c.id) !== undefined;
    case 'addOrbit':
    case 'addState':
      return !now.bodies.some((b) => b.name === c.name && !prior.bodies.some((p) => p.id === b.id));
    default:
      return true;
  }
}

/** An edit an experiment sent: the laboratory just before it (a copy), and its undo list's length with it applied. */
interface Sent {
  command: LabCommand;
  prior: UniverseLab;
  depth: number;
}

/**
 * Undoes exactly the edits an experiment made, or says why not. Its waits are its own, not its
 * turn's: Undo may be pressed after that turn was stopped.
 */
async function undoSent(env: ToolEnv, sent: readonly Sent[]): Promise<UndoOutcome> {
  const first = sent[0];
  const last = sent.at(-1);
  const lab = labView(env);
  if (!first || !last) return { status: 'done' };
  if (!lab) return { status: 'refused', problem: problem('', 'ai.tool.experiment.noLab') };
  if (lab.undoable > last.depth) return { status: 'refused', problem: problem('', 'ai.tool.lab.experiment.undoLater') };
  if (lab.undoable < last.depth || !sent.every((s) => stillShows(s.command, s.prior, lab))) return { status: 'refused', problem: problem('', 'ai.tool.lab.experiment.undoGone') };
  for (let k = 0; k < sent.length; k += 1) {
    const n = labView(env)?.undoable ?? 0;
    env.app.universeLab({ kind: 'undo' });
    if (!(await settle(() => (labView(env)?.undoable ?? n) < n, QUICK_MS))) return { status: 'not-confirmed' };
  }
  const back = await settle(() => {
    const now = labView(env);
    return now !== null && now.undoable === first.prior.undoable && sent.every((s) => putBack(s.command, s.prior, now));
  }, QUICK_MS);
  return { status: back ? 'done' : 'not-confirmed' };
}

/* ----- Tools ----- */

export const labOpen: ToolDefinition = {
  name: 'lab.open',
  kind: 'view',
  summary: 'Open the orbital laboratory: a copy of the solar system (solar) or a clean two- or three-body laboratory.',
  keywords: ['laboratory', 'lab', 'sandbox', 'experiment', 'simulate', 'simulation', 'what if', 'thought experiment'],
  args: { type: 'object', properties: { seed: { type: 'string', enum: ['solar', 'two', 'three'] } }, additionalProperties: false },
  available: (ctx) => ctx.where !== 'lab',
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.lab.open.preview', { seed: str(args, 'seed') ?? 'solar' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const seed = str(args, 'seed') ?? 'solar';
    // The laboratory opens from the explorer (a copy of the system it shows).
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    env.app.openLab();
    const open = await waitFor(env, () => labView(env) !== null, OPEN_MS);
    const undo = (): void => {
      env.app.closeLab();
    };
    if (!open) return notConfirmed('ai.tool.lab.open.notSeen', {}, { undo });
    if (seed !== 'solar') {
      env.app.universeLab({ kind: 'start', seed: seed === 'three' ? 'three' : 'two' });
      const name = seed === 'three' ? 'three-body-laboratory' : 'two-body-laboratory';
      if (!(await waitFor(env, () => labView(env)?.name === name, QUICK_MS))) return notConfirmed('ai.tool.lab.open.notSeen', {}, { undo });
    }
    return done('ai.tool.lab.open.observed', { seed, bodies: labView(env)?.bodies.length ?? 0 }, { undo });
  },
};

export const labState: ToolDefinition = {
  name: 'lab.state',
  kind: 'read',
  summary: "Read the laboratory: its bodies' masses, orbits and distances, the time integrated and the energy drift.",
  keywords: ['state', 'what is happening', 'how far', 'orbit now', 'status', 'bodies', 'drift', 'energy'],
  args: { type: 'object', properties: {}, additionalProperties: false },
  available: inLab,
  preview: (_args, _ctx, i18n) => say(i18n, 'ai.tool.lab.state.preview'),
  run(_args, env) {
    ensureMessages(env.i18n);
    const lab = labView(env);
    if (!lab) return Promise.resolve(refused(problem('', 'ai.tool.experiment.noLab')));
    const i18n = env.i18n;
    const facts: Fact[] = [
      fact(i18n, 'lab.days', 'ai.tool.lab.state.days', {}, sig(lab.elapsedS / 86_400, 5), 'd', 'simulation'),
      fact(i18n, 'lab.drift', 'ai.tool.lab.state.drift', {}, sig(lab.drift.energy, 2), '', 'simulation'),
    ];
    for (const b of lab.bodies.slice(0, 16)) {
      facts.push(fact(i18n, `lab.${b.id}.mass`, 'ai.tool.lab.state.mass', { body: b.name }, sig(b.massKg, 4), 'kg', 'simulation'));
      if (b.distanceKm !== null && b.primary !== null) facts.push(fact(i18n, `lab.${b.id}.distance`, 'ai.tool.lab.state.distance', { body: b.name, primary: lab.names[b.primary] ?? b.primary }, sig(b.distanceKm, 5), 'km', 'simulation'));
      if (b.orbit?.bound) {
        facts.push(fact(i18n, `lab.${b.id}.a`, 'ai.tool.lab.state.a', { body: b.name }, sig(b.orbit.aKm, 5), 'km', 'simulation'));
        facts.push(fact(i18n, `lab.${b.id}.e`, 'ai.tool.lab.state.e', { body: b.name }, sig(b.orbit.e, 3), '', 'simulation'));
        if (b.orbit.periodS !== null) facts.push(fact(i18n, `lab.${b.id}.period`, 'ai.tool.lab.state.period', { body: b.name }, sig(b.orbit.periodS / 86_400, 5), 'd', 'simulation'));
      }
    }
    return Promise.resolve(done('ai.tool.lab.state.observed', { bodies: lab.bodies.length, days: sig(lab.elapsedS / 86_400, 4) }, { facts, blocks: [{ type: 'facts', facts }] }));
  },
};

export const labExperiment: ToolDefinition = {
  name: 'lab.experiment',
  kind: 'experiment',
  summary: 'Change the laboratory: scale-mass, remove-body, kick-body, impact, add-moon, second-star or change-orbit, with its numbers (shown first for the visitor to confirm).',
  keywords: ['what if', 'double', 'mass', 'remove', 'delete', 'kick', 'push', 'impact', 'asteroid', 'moon', 'add a moon', 'second sun', 'binary star', 'change orbit', 'heavier', 'lighter', 'without'],
  args: EXPERIMENT_ARGS,
  argsFor: experimentForms,
  available: inLab,
  check(args, ctx) {
    const id = experimentOf(args);
    return experimentProblems(id, paramsOf(args), worldFromContext(ctx));
  },
  preview: previewText,
  async run(args, env) {
    ensureMessages(env.i18n);
    const before = labView(env);
    if (!before) return refused(problem('', 'ai.tool.experiment.noLab'));
    const id = experimentOf(args);
    const plan = planExperiment(id, paramsOf(args), env.context(), { world: worldFromLab(before), names: planNames(env) });
    if (!isPlan(plan)) return refused(plan[0] ?? problem('', 'ai.tool.experiment.invalid'));
    const sent: Sent[] = [];
    let confirmed = true;
    for (const c of plan.commands) {
      // Stopped: nothing more is sent (what was sent is reported, with its undo).
      if (env.signal.aborted) {
        confirmed = false;
        break;
      }
      // A copy: the view may be the same object, changed in place, from one frame to the next.
      const prior = structuredClone(labView(env) ?? before);
      env.app.universeLab(c);
      const seen = (): boolean => {
        const now = labView(env);
        return now !== null && now.undoable > prior.undoable && shows(c, prior, now);
      };
      const ok = await waitFor(env, seen, QUICK_MS);
      sent.push({ command: c, prior, depth: ok ? (labView(env)?.undoable ?? prior.undoable + 1) : prior.undoable + 1 });
      if (!ok) {
        confirmed = false;
        break;
      }
    }
    const values = { ...plan.previewValues, sentence: say(env.i18n, plan.previewKey, plan.previewValues) };
    if (sent.length === 0) return refused(problem('', 'ai.tool.problem.cancelled'));
    const undo = (): Promise<UndoOutcome> => undoSent(env, sent);
    return confirmed ? done('ai.tool.lab.experiment.observed', values, { undo }) : notConfirmed('ai.tool.lab.experiment.notSeen', values, { undo });
  },
};

export const labUndo: ToolDefinition = {
  name: 'lab.undo',
  kind: 'view',
  summary: "Undo the laboratory's last edit (the run goes back to the moment it was made).",
  keywords: ['undo', 'go back', 'revert', 'put it back', 'cancel the change'],
  args: { type: 'object', properties: {}, additionalProperties: false },
  available: inLab,
  preview: (_args, _ctx, i18n) => say(i18n, 'ai.tool.lab.undo.preview'),
  async run(_args, env) {
    ensureMessages(env.i18n);
    const n = labView(env)?.undoable ?? 0;
    if (n === 0) return refused(problem('', 'ai.tool.lab.undo.nothing'));
    env.app.universeLab({ kind: 'undo' });
    const seen = await waitFor(env, () => (labView(env)?.undoable ?? n) === n - 1, QUICK_MS);
    const undo = (): void => {
      env.app.universeLab({ kind: 'redo' });
    };
    return seen ? done('ai.tool.lab.undo.observed', { left: n - 1 }, { undo }) : notConfirmed('ai.tool.lab.undo.notSeen', {}, { undo });
  },
};

export const labMeasure: ToolDefinition = {
  name: 'lab.measure',
  kind: 'view',
  summary: 'Measure in the laboratory: the distance, light time and angular size between two bodies (and the angle between them seen from a third).',
  keywords: ['measure', 'distance between', 'how far apart', 'angle', 'light time', 'separation', 'angular size'],
  args: { type: 'object', properties: { from: LAB_BODY, to: LAB_BODY, via: LAB_BODY }, required: ['from', 'to'], additionalProperties: false },
  argsFor: (ctx) => ({ type: 'object', properties: { from: labBody(ctx), to: labBody(ctx), via: labBody(ctx) }, required: ['from', 'to'], additionalProperties: false }),
  available: inLab,
  check(args, ctx) {
    const world = worldFromContext(ctx);
    if (!world) return [];
    return (['from', 'to', 'via'] as const).filter((k) => args[k] !== undefined && !resolveBody(world, str(args, k) ?? '')).map((k) => problem(k, 'ai.tool.experiment.noBody', { body: str(args, k) ?? '', allowed: world.bodies.map((b) => b.id).join(', ') }));
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.lab.measure.preview', { from: str(args, 'from') ?? '', to: str(args, 'to') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const lab = labView(env);
    if (!lab) return refused(problem('', 'ai.tool.experiment.noLab'));
    const world = worldFromLab(lab);
    const id = (k: string): string | null => {
      const ref = str(args, k);
      return ref === undefined ? null : (resolveBody(world, ref)?.id ?? null);
    };
    const from = id('from');
    const to = id('to');
    const via = id('via');
    if (!from || !to || from === to) return refused(problem('to', 'ai.tool.experiment.noBody', { body: str(args, 'to') ?? '', allowed: world.bodies.map((b) => b.id).join(', ') }));
    const prior = lab.measure ? { from: lab.measure.from, to: lab.measure.to, via: lab.measure.via } : null;
    env.app.universeLab({ kind: 'measure', from, to, via });
    const seen = await waitFor(env, () => {
      const m = labView(env)?.measure;
      return m !== null && m !== undefined && m.from === from && m.to === to && m.via === via;
    }, QUICK_MS);
    const undo = (): void => {
      env.app.universeLab(prior ? { kind: 'measure', ...prior } : { kind: 'measure', from: null, to: null });
    };
    const m = labView(env)?.measure;
    if (!seen || !m) return notConfirmed('ai.tool.lab.measure.notSeen', {}, { undo });
    const i18n = env.i18n;
    const names = { from: lab.names[from] ?? from, to: lab.names[to] ?? to };
    const facts: Fact[] = [
      fact(i18n, 'measure.distance', 'ai.tool.lab.measure.distance', names, sig(m.distanceKm, 6), 'km', 'simulation'),
      fact(i18n, 'measure.light', 'ai.tool.lab.measure.light', {}, sig(m.lightS, 5), 's', 'simulation', ['light.speed']),
      fact(i18n, 'measure.size', 'ai.tool.lab.measure.size', { body: names.to }, sig(m.angularSizeDeg, 4), '°', 'simulation'),
      ...(m.separationDeg !== null && via ? [fact(i18n, 'measure.separation', 'ai.tool.lab.measure.separation', { via: lab.names[via] ?? via }, sig(m.separationDeg, 4), '°', 'simulation')] : []),
    ];
    return done('ai.tool.lab.measure.observed', { ...names, km: sig(m.distanceKm, 5) }, { facts, blocks: [{ type: 'facts', facts }], undo });
  },
};

/* ----- In the background ----- */

/**
 * The laboratory as it stands, as a baseline: its scenario from a copy it is asked for (never shown:
 * no share link appears and its status line does not change), at the step it had reached; or,
 * outside the laboratory, the solar system seeded at the explorer's date (or now) as the laboratory
 * seeds it. Changes nothing on screen.
 */
async function baseline(env: ToolEnv): Promise<{ baseline: Baseline; world: PlanWorld } | { problem: ReturnType<typeof problem> }> {
  // The engine's side of the planner, loaded only when a comparison or a search is asked for.
  const { sharedBaseline, solarBaseline, worldAtStart } = await import('../planner/compare');
  const lab = labView(env);
  if (lab) {
    // A new copy is a new object (the laboratory replaces it each time it is asked).
    const prior = lab.copy;
    env.app.universeLab({ kind: 'copy' });
    const made = await waitFor(env, () => {
      const c = labView(env)?.copy ?? null;
      return c !== null && c !== prior;
    }, QUICK_MS);
    const now = labView(env);
    const copy = now?.copy ?? null;
    if (!made || !now || !copy) return { problem: problem('', 'ai.tool.lab.compare.noShare') };
    if ('error' in copy) return { problem: problem('', 'ai.tool.lab.compare.unreadable', { detail: copy.error }) };
    const world = worldFromLab(now);
    if (world.gPerKg === null) return { problem: problem('', 'ai.tool.experiment.needsState') };
    const got = await sharedBaseline(copy.data, now.step, world.gPerKg, now.auKm);
    if (!got.ok) return { problem: problem('', 'ai.tool.lab.compare.unreadable', { detail: got.errors.slice(0, 3).join('; ') }) };
    return { baseline: got.baseline, world };
  }
  const data = await jplData(env.app);
  const figure = (id: string): number | null => {
    try {
      return env.app.data.constant(id).value;
    } catch {
      return null;
    }
  };
  const base = solarBaseline(data.physical, data.planets, data.moon, dateJdTdb(env.app, data, Date.now()), figure);
  // The world at the fork: the seed's own state (an engine made, not run).
  return { baseline: base, world: worldAtStart(base) };
}

const aborted = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

export const labCompare: ToolDefinition = {
  name: 'lab.compare',
  kind: 'read',
  summary: 'Compare an experiment with the laboratory as it is (or the solar system), integrated ahead in the background; nothing on screen changes.',
  keywords: ['compare', 'what would happen', 'what if', 'difference', 'side by side', 'simulate', 'integrate ahead', 'in ten years', 'effect'],
  args: EXPERIMENT_ARGS,
  argsFor: experimentForms,
  available: () => true,
  check(args, ctx) {
    return experimentProblems(experimentOf(args), paramsOf(args), worldFromContext(ctx));
  },
  preview: (args, ctx, i18n) => {
    const id = experimentOf(args);
    const days = EXPERIMENT_IDS.includes(id) ? experimentPreview(id, paramsOf(args), worldFromContext(ctx)).values.days : (num(args, 'horizonDays') ?? 0);
    return say(i18n, 'ai.tool.lab.compare.preview', { sentence: previewText(args, ctx, i18n), days: days ?? 0 });
  },
  async run(args, env) {
    ensureMessages(env.i18n);
    try {
      const got = await baseline(env);
      if ('problem' in got) return refused(got.problem);
      const id = experimentOf(args);
      const params = paramsOf(args);
      // The numbers checked against the laboratory now; the worker plans again exactly at the fork.
      const first = planExperiment(id, params, null, { world: got.world, names: planNames(env) });
      if (!isPlan(first)) return refused(first[0] ?? problem('', 'ai.tool.experiment.invalid'));
      const [{ runInBackground }, { toComparison }] = await Promise.all([import('../planner/client'), import('../planner/compare')]);
      const result = await runInBackground({ type: 'compare-experiment', baseline: got.baseline, experiment: id, params, names: planNames(env) }, () => undefined, env.signal);
      if (result.type === 'problems') return refused(result.problems[0] ?? problem('', 'ai.tool.experiment.invalid'));
      if (result.type !== 'compare') return failed(new Error('unexpected result'));
      const raw = result.comparison;
      const comparison = toComparison(raw, got.baseline.auKm, (key, values) => say(env.i18n, key, values));
      const i18n = env.i18n;
      const facts: Fact[] = [
        fact(i18n, 'compare.days', 'ai.tool.lab.compare.days', {}, sig(raw.reachedDays.variant, 5), 'd', 'simulation'),
        fact(i18n, 'compare.energyBaseline', 'ai.tool.lab.compare.energyBaseline', {}, sig(raw.energyError.baseline, 2), '', 'simulation'),
        fact(i18n, 'compare.energyVariant', 'ai.tool.lab.compare.energyVariant', {}, sig(raw.energyError.variant, 2), '', 'simulation'),
      ];
      const sentence = say(i18n, first.previewKey, first.previewValues);
      // A comparison that ran out of time (COMPARE_BUDGET_MS) says how far it reached.
      const short = raw.reachedDays.variant < raw.horizonDays - 0.5 ? [{ type: 'notice' as const, key: 'ai.tool.lab.compare.short', values: { days: sig(raw.reachedDays.variant, 4), horizon: raw.horizonDays } }] : [];
      return done('ai.tool.lab.compare.observed', { sentence, events: raw.events.length }, { facts, blocks: [{ type: 'comparison', comparison }, ...short, { type: 'notice', key: 'ai.tool.lab.compare.note' }] });
    } catch (err) {
      if (aborted(err)) return { status: 'failed', problem: problem('', 'ai.tool.problem.cancelled') };
      return failed(err);
    }
  },
};

const GOALS = ['escape', 'year'] as const;

export const labOptimise: ToolDefinition = {
  name: 'lab.optimise',
  kind: 'read',
  summary: "Search in the background: the smallest prograde kick for a body to escape what it orbits within days (escape), or the mass factor of its primary that makes its year targetDays (year).",
  keywords: ['smallest', 'minimum', 'how much', 'how fast', 'what speed', 'escape', 'find the', 'year becomes', 'optimise', 'optimize', 'threshold', 'how heavy would'],
  args: {
    type: 'object',
    properties: {
      goal: { type: 'string', enum: GOALS },
      body: LAB_BODY,
      days: { type: 'number', minimum: 1, maximum: 3650, description: 'escape: within this many days' },
      targetDays: { type: 'number', minimum: 1, maximum: 100_000, description: 'year: the year wanted, days' },
    },
    required: ['goal'],
    additionalProperties: false,
  },
  // One form per goal, so a plan cannot give escape's days to year or year's target to escape.
  argsFor: (ctx): JsonSchema => {
    const escape: JsonSchema = { type: 'object', properties: { goal: { type: 'string', const: 'escape' }, body: labBody(ctx), days: { type: 'number', minimum: 1, maximum: 3650, description: 'within this many days (a year is 365.25)' } }, required: ['goal', 'body', 'days'], additionalProperties: false };
    const year: JsonSchema = { type: 'object', properties: { goal: { type: 'string', const: 'year' }, body: labBody(ctx), targetDays: { type: 'number', minimum: 1, maximum: 100_000, description: 'the year wanted, days' } }, required: ['goal', 'body', 'targetDays'], additionalProperties: false };
    return { anyOf: [escape, year] };
  },
  available: () => true,
  check(args) {
    if (args.goal === 'year' && args.targetDays === undefined) return [problem('targetDays', 'ai.tool.problem.required')];
    if (args.goal === 'escape' && args.targetDays !== undefined) return [problem('targetDays', 'ai.tool.experiment.notFor', { experiment: 'escape' })];
    if (args.goal === 'year' && args.days !== undefined) return [problem('days', 'ai.tool.experiment.notFor', { experiment: 'year' })];
    return [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.lab.optimise.preview', { goal: str(args, 'goal') ?? '', body: str(args, 'body') ?? '', days: num(args, 'days') ?? 30, targetDays: num(args, 'targetDays') ?? 0 }),
  async run(args, env) {
    ensureMessages(env.i18n);
    try {
      const got = await baseline(env);
      if ('problem' in got) return refused(got.problem);
      const goal = str(args, 'goal') as (typeof GOALS)[number];
      const ref = str(args, 'body') ?? (goal === 'escape' ? 'moon' : 'earth');
      const body = resolveBody(got.world, ref);
      if (!body) return refused(problem('body', 'ai.tool.experiment.noBody', { body: ref, allowed: got.world.bodies.map((b) => b.id).join(', ') }));
      const primary = body.primary === null ? null : resolveBody(got.world, body.primary);
      if (!primary || !body.orbit) return refused(problem('body', 'ai.tool.experiment.noOrbit', { body: body.name }));
      const g = got.world.gPerKg ?? got.baseline.gPerKg;
      let search: OptimiseSearch;
      if (goal === 'escape') {
        // Up to twice the speed that escapes the primary from where the body is (and never more than the experiment allows).
        const escape = Math.sqrt((2 * (primary.massKg + body.massKg) * g) / body.orbit.aKm);
        search = { experiment: 'kick-body', params: { body: body.id, direction: 'prograde' }, parameter: 'dvKmS', lo: 0.001, hi: Math.min(50, 2 * escape), scale: 'linear', goal: { kind: 'escape', body: body.id }, horizonDays: num(args, 'days') ?? 30, tolerance: 1e-4 };
      } else {
        search = { experiment: 'scale-mass', params: { body: primary.id }, parameter: 'factor', lo: 0.01, hi: 100, scale: 'log', goal: { kind: 'period', body: body.id, targetDays: num(args, 'targetDays') ?? 365 }, horizonDays: 1, tolerance: 1e-5 };
      }
      const { runInBackground } = await import('../planner/client');
      const result = await runInBackground({ type: 'optimise', baseline: got.baseline, search }, () => undefined, env.signal);
      if (result.type !== 'optimise') return failed(new Error('unexpected result'));
      const r = result.result;
      const i18n = env.i18n;
      const unit = goal === 'escape' ? 'km/s' : '';
      if (r.value === null) return done('ai.tool.lab.optimise.none', { runs: r.runs, outcome: r.outcome }, { facts: [fact(i18n, 'optimise.runs', 'ai.tool.lab.optimise.runs', {}, r.runs, '', 'simulation')] });
      const facts: Fact[] = [
        fact(i18n, 'optimise.value', `ai.tool.lab.optimise.${goal}`, { body: body.name, primary: primary.name, days: search.horizonDays, targetDays: num(args, 'targetDays') ?? 0 }, sig(r.value, 5), unit, 'simulation'),
        fact(i18n, 'optimise.bracket', 'ai.tool.lab.optimise.bracket', {}, `${sig(r.bracket[0], 6)} – ${sig(r.bracket[1], 6)}`, unit, 'simulation'),
        fact(i18n, 'optimise.runs', 'ai.tool.lab.optimise.runs', {}, r.runs, '', 'simulation'),
      ];
      return done('ai.tool.lab.optimise.observed', { value: sig(r.value, 5), runs: r.runs }, { facts, blocks: [{ type: 'facts', facts }, { type: 'notice', key: 'ai.tool.lab.compare.note' }] });
    } catch (err) {
      if (aborted(err)) return { status: 'failed', problem: problem('', 'ai.tool.problem.cancelled') } satisfies ToolOutcome;
      return failed(err);
    }
  },
};

export const LAB_TOOLS: readonly ToolDefinition[] = [labOpen, labState, labExperiment, labUndo, labMeasure, labCompare, labOptimise];
