import { BODY_IDS, type BodyId, type I18n, type I18nKey, type UniverseView } from '../../core/types';
import messages from '../../i18n/en.ai.tools.json' with { type: 'json' };
import type { Fact, JsonSchema, KnowledgeKind, ToolEnv, ToolOutcome, ToolProblem } from '../types';

/**
 * What every tool shares: its messages (src/i18n/en.ai.tools.json, added to the catalogue the first
 * time a tool speaks), problems and outcomes, typed readers for arguments the schema has already
 * checked, the explorer's state, waiting on it, and facts.
 */

export const MESSAGE_FILE = 'en.ai.tools.json';

/** Adds the tools' messages to the catalogue (the same file again is ignored). */
export function ensureMessages(i18n: I18n): void {
  i18n.extend(MESSAGE_FILE, messages);
}

/** A tool's message, its file added first. */
export function say(i18n: I18n, key: I18nKey, values?: Record<string, string | number>): string {
  ensureMessages(i18n);
  return i18n.t(key, values);
}

export const problem = (path: string, messageKey: I18nKey, values?: Record<string, string | number>): ToolProblem => (values ? { path, messageKey, values } : { path, messageKey });

export const refused = (p: ToolProblem): ToolOutcome => ({ status: 'refused', problem: p });

export const failed = (err: unknown): ToolOutcome => ({ status: 'failed', problem: problem('', 'ai.tool.problem.failed', { detail: err instanceof Error ? err.message : String(err) }) });

export const done = (observedKey: I18nKey, observedValues: Record<string, string | number> = {}, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ status: 'done', observedKey, observedValues, ...extra });

export const notConfirmed = (observedKey: I18nKey, observedValues: Record<string, string | number> = {}, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ status: 'not-confirmed', observedKey, observedValues, ...extra });

/* ----- Arguments (already checked against the tool's schema) ----- */

export function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}

export function num(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(args: Record<string, unknown>, name: string): boolean | undefined {
  const v = args[name];
  return typeof v === 'boolean' ? v : undefined;
}

export const isBodyId = (v: unknown): v is BodyId => typeof v === 'string' && (BODY_IDS as readonly string[]).includes(v);

/* ----- Schemas used by several tools ----- */

export const BODY: JsonSchema = { type: 'string', enum: BODY_IDS, description: 'One of the ten worlds' };
export const LAT: JsonSchema = { type: 'number', minimum: -90, maximum: 90, description: 'Latitude, degrees north' };
export const LON: JsonSchema = { type: 'number', minimum: -180, maximum: 180, description: 'Longitude, degrees east' };
/** A date and time in UTC: 2030-05-01, 2030-05-01T18:30 or 2030-05-01T18:30:00Z. */
export const DATE: JsonSchema = { type: 'string', maxLength: 24, pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}(:\\d{2})?Z?)?$', description: 'UTC date, YYYY-MM-DD or YYYY-MM-DDTHH:MM' };
/** A body of the laboratory: its id (or its name, matched without regard to case). */
export const LAB_BODY: JsonSchema = { type: 'string', maxLength: 60, pattern: '^[\\p{L}\\p{N} ._()\'-]{1,60}$', description: 'A laboratory body id or name' };
export const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const satisfies JsonSchema;

/** A UTC date as Unix ms (a date alone is its midnight); null when it is not one. */
export function parseUtc(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/u.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? 0 : Number(x)));
  const ms = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
  const back = new Date(ms);
  // 2030-02-30 is not a date (Date.UTC would roll it into March).
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== (mo ?? 1) - 1 || back.getUTCDate() !== d || (h ?? 0) > 23 || (mi ?? 0) > 59 || (s ?? 0) > 59) return null;
  return ms;
}

/** Unix ms as an ISO date (UTC), to the minute or the day. */
export function isoUtc(ms: number, withTime = true): string {
  const iso = new Date(ms).toISOString();
  return withTime ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : iso.slice(0, 10);
}

/* ----- The app's state ----- */

/** The explorer's view now, or null while it is not on screen. */
export const view = (env: ToolEnv): UniverseView | null => env.app.universe();

/** Waits on the app's state; a predicate that throws counts as not holding yet. */
export function waitFor(env: ToolEnv, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return env.until(() => {
    try {
      return predicate();
    } catch {
      return false;
    }
  }, timeoutMs);
}

/** How long the explorer may take to come on screen (its code, its data, the first frame). */
export const OPEN_MS = 30_000;

/**
 * The explorer on screen, opening it on `body` if it is not: a command sent before then would be
 * dropped. Resolves to whether it is there.
 */
export async function ensureExplorer(env: ToolEnv, body: BodyId | null = null): Promise<boolean> {
  if (env.app.universe()) return true;
  env.app.openUniverse(body);
  return waitFor(env, () => env.app.universe() !== null, OPEN_MS);
}

/** A built-in world's name for a sentence ("the Earth", "Mars"). */
export const bodyName = (i18n: I18n, id: string): string => (isBodyId(id) ? say(i18n, `ai.tool.body.${id}`) : id);

/* ----- Facts ----- */

export function fact(i18n: I18n, id: string, labelKey: I18nKey, labelValues: Record<string, string | number>, value: number | string, unit: string | undefined, knowledge: KnowledgeKind, sourceIds?: readonly string[]): Fact {
  return {
    id,
    label: say(i18n, labelKey, labelValues),
    value,
    ...(unit !== undefined ? { unit } : {}),
    knowledge,
    ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
  };
}

/** A number kept to a sensible precision for a fact (significant digits), never rounded to zero. */
export function sig(x: number, digits = 4): number {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(digits));
}

/** Degrees per radian. */
export const DEG = 180 / Math.PI;
