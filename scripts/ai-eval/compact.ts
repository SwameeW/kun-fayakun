/*
 * The compact copy of a real-model evaluation run that is committed (docs/ai-eval/), so the numbers in
 * docs/AI-EVALUATION.md can be generated again from the repository by scripts/ai-eval/report.ts. The raw
 * files (.work/ai-eval/results, gitignored) keep every prompt and every reply as the model wrote it;
 * the compact copy keeps what the report reads and what a reader needs to check a case:
 * - the run: model, mode, machine, loads, frame statistics (not the raw intervals), load averages;
 * - each case: its result, its checks, the plan's tools and arguments, the guards' flags, the types of
 *   any violation, citations, labels, timings and load averages; and the answer as it was shown, after
 *   the guards, only when the scorer found nothing wrong in it.
 *
 * No model's own words go in before the guards (a raw reply can hold Arabic, wording presented as
 * scripture or a narration the data excludes), and no question (cases.ts holds them; one trap's
 * question is built at run time and never written down).
 *
 *   node --import tsx scripts/ai-eval/compact.ts <raw run.json> [...] --out docs/ai-eval
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDF9\uFDFB-\uFDFF\uFE70-\uFEFF]/u;
const SHOWN_CHARS = 400;

interface RawCase {
  id: string;
  category: string;
  tag: string;
  pass: boolean;
  error?: string;
  timedOut?: boolean;
  state?: string;
  engine?: unknown;
  scored?: {
    pass: boolean;
    checks: { kind: string; pass: boolean; optional?: boolean; detail: string }[];
    tool: unknown;
    plan: { source: string | null; intent: string | null; calls: unknown; firstTryValid: boolean | null; afterRepairValid: boolean | null; problems: readonly string[] };
    answer: { text: string; blockTypes: readonly string[] };
    citations: unknown;
    guard: unknown;
    integrity: readonly { type: string; detail: string }[];
    labels: unknown;
    decline: boolean | null;
    markup: readonly string[];
  };
  timings?: unknown;
  loadavg?: unknown;
}

interface RawRun {
  model: string;
  name: string;
  mode: string;
  tag: string | null;
  startedAt: string;
  finishedAt: string | null;
  machine: unknown;
  catalogue: unknown;
  load: unknown;
  gpuMemory: unknown;
  loadavgStart: unknown;
  cases: RawCase[];
  frames: { where: string; idle: Record<string, unknown>; generating: Record<string, unknown> } | null;
  unexpectedRequests: string[];
  pageErrors: string[];
  loadError?: unknown;
}

/** A model's own arguments may be in Arabic script (asked to answer in it): never copied into a committed file. */
const ARABIC_RUN = new RegExp(ARABIC.source.replace(']', ']+'), 'gu');
const scrub = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(ARABIC_RUN, '[Arabic script, not copied]')) as T;

function compactCase(c: RawCase): Record<string, unknown> {
  const s = c.scored;
  const clean = s ? s.integrity.length === 0 && !ARABIC.test(s.answer.text) : false;
  return {
    id: c.id,
    category: c.category,
    tag: c.tag,
    pass: c.pass,
    ...(c.error !== undefined ? { error: c.error.split('\n')[0]?.slice(0, 300) } : {}),
    ...(c.timedOut ? { timedOut: true } : {}),
    ...(c.state !== undefined ? { state: c.state } : {}),
    ...(c.engine !== undefined ? { engine: c.engine } : {}),
    ...(s
      ? {
          scored: {
            pass: s.pass,
            // A check's detail can quote the answer: kept only when the answer itself is.
            checks: s.checks.map((k) => ({ kind: k.kind, pass: k.pass, ...(k.optional ? { optional: true } : {}), ...(clean ? { detail: k.detail.slice(0, 300) } : {}) })),
            tool: s.tool,
            plan: { source: s.plan.source, intent: s.plan.intent, calls: scrub(s.plan.calls), firstTryValid: s.plan.firstTryValid, afterRepairValid: s.plan.afterRepairValid, problems: scrub(s.plan.problems.map((p) => p.slice(0, 200))) },
            answer: { blockTypes: s.answer.blockTypes, ...(clean ? { shown: s.answer.text.slice(0, SHOWN_CHARS) } : { shown: null, withheld: 'not copied: the scorer found a violation in it (see the raw file)' }) },
            citations: s.citations,
            guard: s.guard,
            integrity: s.integrity.map((v) => ({ type: v.type })),
            labels: s.labels,
            decline: s.decline,
            markup: s.markup,
          },
        }
      : {}),
    ...(c.timings !== undefined ? { timings: c.timings } : {}),
    ...(c.loadavg !== undefined ? { loadavg: c.loadavg } : {}),
  };
}

function compact(run: RawRun, file: string): Record<string, unknown> {
  return {
    compactOf: relative(process.cwd(), file),
    model: run.model,
    name: run.name,
    mode: run.mode,
    tag: run.tag,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    machine: run.machine,
    catalogue: run.catalogue,
    load: run.load,
    gpuMemory: run.gpuMemory,
    loadavgStart: run.loadavgStart,
    ...(run.loadError !== undefined ? { loadError: run.loadError } : {}),
    frames: run.frames ? { where: run.frames.where, idle: run.frames.idle, generating: run.frames.generating } : null,
    unexpectedRequests: run.unexpectedRequests,
    pageErrors: run.pageErrors.map((e) => e.slice(0, 300)),
    cases: run.cases.map(compactCase),
  };
}

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args[outAt + 1] : undefined;
const inputs = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!outDir || inputs.length === 0) {
  process.stderr.write('usage: node --import tsx scripts/ai-eval/compact.ts <raw run.json> [...] --out <dir>\n');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
for (const file of inputs) {
  const run = JSON.parse(readFileSync(file, 'utf8')) as RawRun;
  const target = join(outDir, basename(file));
  // One line for the run, one for each case: small, and a change to a case is one line of a diff.
  const { cases, ...head } = compact(run, file) as { cases: unknown[] } & Record<string, unknown>;
  const text = `${JSON.stringify(head).slice(0, -1)},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}\n`;
  JSON.parse(text);
  if (ARABIC.test(text)) throw new Error(`${file}: the compact copy would hold Arabic script`);
  writeFileSync(target, text);
  process.stdout.write(`${target}: ${run.cases.length} cases, ${(text.length / 1024).toFixed(0)} KB\n`);
}
