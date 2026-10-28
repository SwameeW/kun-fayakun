import { julianDateUtc } from '../../astro/time';
import { fasterRate, slowerRate, TIME_RATES } from '../../explore/time';
import type { AiContext, ToolDefinition, ToolEnv } from '../types';
import { DATE, done, ensureExplorer, ensureMessages, isoUtc, notConfirmed, num, parseUtc, problem, refused, say, str, view, waitFor } from './shared';

/**
 * The time machine (src/explore/time.ts): pause and play, a rung faster or slower on its ladder of
 * rates, backwards, back to now, a date, an exact rate. In the laboratory pause, play, faster, slower
 * and a forward rate drive the experiment's clock; backwards, now and a date are the explorer's alone.
 * Each is confirmed by the view's clock and undone by putting back the date, the rate and the pause
 * as they were.
 */

const QUICK_MS = 3000;
const ACTIONS = ['pause', 'play', 'faster', 'slower', 'reverse', 'now'] as const;
type TimeAction = (typeof ACTIONS)[number];
const EXPLORER_ONLY: readonly TimeAction[] = ['reverse', 'now'];

const inExplorerOrLab = (ctx: AiContext): boolean => ctx.where === 'explorer' || ctx.where === 'lab';

interface Clock {
  rate: number;
  paused: boolean;
  unixMs: number;
}

function clock(env: ToolEnv): Clock | null {
  const v = view(env);
  return v ? { rate: v.time.rate, paused: v.time.paused, unixMs: v.unixMs } : null;
}

/** The clock as it was: its date (the explorer's only), then its rate, then its pause. */
function restore(env: ToolEnv, c: Clock, withDate: boolean): void {
  if (withDate && !view(env)?.lab) env.app.universeTime({ kind: 'date', jdUtc: julianDateUtc(c.unixMs) });
  env.app.universeTime({ kind: 'rate', rate: c.rate });
  if (c.paused) env.app.universeTime({ kind: 'rate', rate: 0 });
}

export const timeControl: ToolDefinition = {
  name: 'time.control',
  kind: 'view',
  summary: "Pause or play the explorer's clock, one step faster or slower, run it backwards, or back to now.",
  keywords: ['pause', 'play', 'faster', 'slower', 'speed up', 'slow down', 'backwards', 'reverse', 'now', 'today', 'present', 'clock', 'time'],
  args: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
  available: inExplorerOrLab,
  check(args, ctx) {
    return ctx.where === 'lab' && EXPLORER_ONLY.includes(args.action as TimeAction) ? [problem('action', 'ai.tool.time.notInLab')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.time.control.preview', { action: str(args, 'action') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const action = str(args, 'action') as TimeAction;
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const before = clock(env);
    if (!before) return notConfirmed('ai.tool.explorer.open.notSeen');
    let holds: (c: Clock) => boolean;
    switch (action) {
      case 'pause':
        if (!before.paused) env.app.universeTime({ kind: 'toggle' });
        holds = (c) => c.paused;
        break;
      case 'play':
        if (before.paused) env.app.universeTime({ kind: 'toggle' });
        holds = (c) => !c.paused;
        break;
      case 'faster': {
        const want = view(env)?.lab ? Math.abs(fasterRate(before.rate)) : fasterRate(before.rate);
        env.app.universeTime({ kind: 'faster' });
        holds = (c) => c.rate === want && !c.paused;
        break;
      }
      case 'slower': {
        const want = view(env)?.lab ? Math.abs(slowerRate(before.rate)) : slowerRate(before.rate);
        env.app.universeTime({ kind: 'slower' });
        holds = (c) => c.rate === want && !c.paused;
        break;
      }
      case 'reverse':
        env.app.universeTime({ kind: 'reverse' });
        holds = (c) => c.rate === -before.rate && !c.paused;
        break;
      case 'now':
        env.app.universeTime({ kind: 'now' });
        holds = (c) => c.rate === 1 && !c.paused;
        break;
    }
    const seen = await waitFor(env, () => {
      const c = clock(env);
      return c !== null && holds(c);
    }, QUICK_MS);
    const after = clock(env);
    const values = { action, rate: after?.rate ?? 0, paused: after?.paused ? 1 : 0, date: after ? isoUtc(after.unixMs) : '' };
    const undo = (): void => {
      restore(env, before, action === 'now');
    };
    return seen ? done('ai.tool.time.control.observed', values, { undo }) : notConfirmed('ai.tool.time.control.notSeen', values, { undo });
  },
};

export const timeDate: ToolDefinition = {
  name: 'time.date',
  kind: 'view',
  summary: "Set the explorer's date and time (UTC), within the span its data covers.",
  keywords: ['date', 'year', 'day', 'when', 'eclipse', 'set the date', 'go to the year', 'on', 'month'],
  args: { type: 'object', properties: { date: DATE }, required: ['date'], additionalProperties: false },
  available: (ctx) => ctx.where === 'explorer',
  check(args) {
    return parseUtc(str(args, 'date') ?? '') === null ? [problem('date', 'ai.tool.time.date.invalid')] : [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.time.date.preview', { date: str(args, 'date') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const ms = parseUtc(str(args, 'date') ?? '');
    if (ms === null) return refused(problem('date', 'ai.tool.time.date.invalid'));
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const v = view(env);
    const before = clock(env);
    if (!v || !before) return notConfirmed('ai.tool.explorer.open.notSeen');
    const { startMs, endMs } = v.time;
    if (ms < startMs || ms > endMs) return refused(problem('date', 'ai.tool.time.date.outside', { start: isoUtc(startMs, false), end: isoUtc(endMs, false) }));
    env.app.universeTime({ kind: 'date', jdUtc: julianDateUtc(ms) });
    // A running clock moves on while we look: allow what it covers in a few seconds.
    const toleranceMs = (120 + Math.abs(before.rate) * 4) * 1000;
    const seen = await waitFor(env, () => {
      const c = clock(env);
      return c !== null && Math.abs(c.unixMs - ms) <= toleranceMs;
    }, QUICK_MS);
    const undo = (): void => {
      restore(env, before, true);
    };
    const values = { date: isoUtc(view(env)?.unixMs ?? ms) };
    return seen ? done('ai.tool.time.date.observed', values, { undo }) : notConfirmed('ai.tool.time.date.notSeen', values, { undo });
  },
};

const MAX_RATE = TIME_RATES[TIME_RATES.length - 1] ?? 2_592_000;

export const timeRate: ToolDefinition = {
  name: 'time.rate',
  kind: 'view',
  // What the steps mean, in words: Qwen3 4B set 1 for "one day pass every second".
  summary: "Set the clock's rate exactly: explorer seconds per real second, one of 1, 10, 60, 600, 3600 (an hour a second), 21600, 86400 (a day a second), 604800 (a week), 2592000 (30 days); negative runs backwards.",
  keywords: ['rate', 'speed', 'per second', 'a day a second', 'a week a second', 'real time', 'time lapse', 'fast forward'],
  args: { type: 'object', properties: { rate: { type: 'integer', minimum: -MAX_RATE, maximum: MAX_RATE, description: 'Seconds per real second' } }, required: ['rate'], additionalProperties: false },
  available: inExplorerOrLab,
  check(args, ctx) {
    const rate = num(args, 'rate') ?? 0;
    if (!(TIME_RATES as readonly number[]).includes(Math.abs(rate))) return [problem('rate', 'ai.tool.time.rate.ladder', { allowed: TIME_RATES.join(', ') })];
    if (ctx.where === 'lab' && rate < 0) return [problem('rate', 'ai.tool.time.notInLab')];
    return [];
  },
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.time.rate.preview', { rate: num(args, 'rate') ?? 1 }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const rate = num(args, 'rate') ?? 1;
    if (!(await ensureExplorer(env))) return notConfirmed('ai.tool.explorer.open.notSeen');
    const before = clock(env);
    if (!before) return notConfirmed('ai.tool.explorer.open.notSeen');
    env.app.universeTime({ kind: 'rate', rate });
    const seen = await waitFor(env, () => {
      const c = clock(env);
      return c !== null && c.rate === rate && !c.paused;
    }, QUICK_MS);
    const undo = (): void => {
      restore(env, before, false);
    };
    return seen ? done('ai.tool.time.rate.observed', { rate }, { undo }) : notConfirmed('ai.tool.time.rate.notSeen', { rate }, { undo });
  },
};

export const TIME_TOOLS: readonly ToolDefinition[] = [timeControl, timeDate, timeRate];
