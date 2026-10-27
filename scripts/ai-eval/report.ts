/*
 * Turns the real-model evaluation's raw results (tests/ai-eval/eval.spec.ts and network.spec.ts write
 * them to .work/ai-eval/results/) into Markdown tables, so docs/AI-EVALUATION.md is generated from
 * data, never typed. Every figure printed is read from those files; nothing is estimated here.
 *
 *   node --import tsx scripts/ai-eval/report.ts                  every results file, to stdout
 *   node --import tsx scripts/ai-eval/report.ts <dir or files>   those
 *   node --import tsx scripts/ai-eval/report.ts --details        also each case's result by model and mode
 *   node --import tsx scripts/ai-eval/report.ts --out docs/AI-EVALUATION.md
 *   node --import tsx scripts/ai-eval/report.ts docs/ai-eval --details --into docs/AI-EVALUATION.md
 *       (replaces only what lies between "<!-- report:start -->" and "<!-- report:end -->")
 *   node --import tsx scripts/ai-eval/report.ts <rescored copies> --rescored-from <the same runs as scored at run time>
 *       --block rescored --into docs/AI-EVALUATION.md
 *       (runs scored again by a later scorer, beside their run-time score; between "<!-- report:rescored:start -->" and
 *       "<!-- report:rescored:end -->")
 *
 * It reads the raw files or their compact copies (scripts/ai-eval/compact.ts, committed in
 * docs/ai-eval). Runs tagged "timing…" (the speed passes, several of them, the models in alternating
 * order) get tables of their own: each figure is the median of the passes, with their range.
 *
 * Decode speed is given twice: WebLLM's own figure (its decode steps alone) and the rate the app
 * delivers (output tokens after the first, over the time from the first token to the last, as the
 * engine's end-to-end time gives it), which includes the page asking for each piece.
 *
 * Questions are never printed (one trap names a narration data/hadith.json excludes, redacted in the
 * raw file already); cases are named by their ids.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

interface Timing {
  ttftMs: number | null;
  prefillTokensPerS: number | null;
  decodeTokensPerS: number | null;
  grammarInitMs: number | null;
  e2eMs: number | null;
  promptTokens: number;
  outputTokens: number;
  wallMs: number;
}

interface GpuClients {
  others: number;
  othersCpu: number;
  ownCpu: number | null;
}

interface CaseRecord {
  id: string;
  category: string;
  tag: string;
  pass: boolean;
  error?: string;
  timedOut?: boolean;
  state?: string;
  reloaded?: unknown;
  scored?: {
    pass: boolean;
    checks: { kind: string; pass: boolean; optional?: boolean }[];
    tool: { toolCorrect: boolean | null; argsCorrect: boolean | null };
    plan: { source: string | null; firstTryValid: boolean | null; afterRepairValid: boolean | null };
    citations: { shown: { inData: boolean }[]; raw: { valid: boolean }[] };
    guard: { flags: string[]; guardedNotice: boolean };
    integrity: { type: string }[];
    labels: { modelBlocks: number; labelled: number };
    decline: boolean | null;
    markup: string[];
    engine?: boolean | null;
  };
  timings?: { totalMs: number; plan: Timing | null; repair: Timing | null; answer: Timing | null };
  loadavg?: { before: number[]; after: number[]; gpuClients?: GpuClients };
}

interface FrameWindow {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  loadavg: number[];
  gpuClients?: GpuClients;
  long?: { ms: number; at: number; phase: string }[];
}

interface RunFile {
  model: string;
  name: string;
  mode: string;
  tag: string | null;
  startedAt: string;
  finishedAt: string | null;
  machine: { cpu: string | null; memoryBytes: number; os: string; adapter: { vendor: string; architecture: string; userAgent: string } | null };
  load: { routed: { ms: number; requests: number; bytes: number } | null; cached: { ms: number; routeRequests: number; loadavg: number[] } } | null;
  loadError?: { stage: string; code: string | null; detail: string | null; panel: string | null; loadavg: number[] };
  gpuMemory: { reported: number | null };
  catalogue: { vramMBEstimate: number };
  loadavgStart: number[];
  cases: CaseRecord[];
  frames: { idle: FrameWindow; generating: FrameWindow } | null;
  unexpectedRequests: string[];
  unservedModelHosts?: string[];
  externalHosts?: Record<string, number>;
}

interface NetworkFile {
  model: string;
  startedAt: string;
  beforeAsk: { modelHostRequests: number; workerScripts: number };
  beforeDownload: { sizeText: string; modelHostRequests: number; workerScripts: number };
  download: { msClickToReady: number; requests: number; hosts: string[]; bytesFromModelHosts: number; progressSamples: number; progressMax: number | null; progressMonotonic: boolean; meteredAsked: boolean; loadavg: { before: number[] } };
  answer?: { ms: number; label: string | null };
  reload?: { msClickToReady: number; modelHostRequests: number; storedText: string | null };
  delete?: { cacheBefore: Record<string, number>; cacheAfter: Record<string, number>; usageBytesBefore: number | null; usageBytesAfter: number | null; modelHostRequests: number };
  loadavgEnd?: number[];
}

const args = process.argv.slice(2);
const details = args.includes('--details');
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const intoAt = args.indexOf('--into');
const into = intoAt >= 0 ? args[intoAt + 1] : undefined;
const blockAt = args.indexOf('--block');
const block = blockAt >= 0 ? args[blockAt + 1] : undefined;
const fromAt = args.indexOf('--rescored-from');
const rescoredFrom = fromAt >= 0 ? args[fromAt + 1] : undefined;
const valued = new Set([outAt, intoAt, blockAt, fromAt].filter((i) => i >= 0).map((i) => i + 1));
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(i));
/** The tables' headings: a section of their own, or under the document's own heading (--into). */
const H = into ? '###' : '##';
const defaultDir = resolve('.work/ai-eval/results');

function files(): string[] {
  const list = inputs.length > 0 ? inputs : [defaultDir];
  return list.flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)) : [p])).sort();
}

const pct = (n: number, d: number): string => (d === 0 ? '–' : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);
const frac = (n: number, d: number): string => (d === 0 ? '–' : `${n}/${d}`);
const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const fmt = (x: number | null | undefined, digits = 0): string => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(digits));
const ms = (x: number | null | undefined): string => (x === null || x === undefined ? '–' : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const num = (xs: readonly (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
const range = (xs: readonly number[], digits = 1): string => (xs.length ? `${fmt(Math.min(...xs), digits)}–${fmt(Math.max(...xs), digits)}` : '–');

/** The rate the app delivers: output tokens after the first, over the time from the first token to the last. */
const delivered = (t: Timing): number | null => (t.e2eMs !== null && t.ttftMs !== null && t.outputTokens > 10 && t.e2eMs > t.ttftMs ? (t.outputTokens - 1) / ((t.e2eMs - t.ttftMs) / 1000) : null);

function timingsOf(cs: readonly CaseRecord[]): { plans: Timing[]; answers: Timing[]; gens: Timing[] } {
  const plans = cs.map((c) => c.timings?.plan ?? null).filter((t): t is Timing => t !== null);
  const answers = cs.map((c) => c.timings?.answer ?? null).filter((t): t is Timing => t !== null);
  const gens = [...plans, ...answers, ...cs.map((c) => c.timings?.repair ?? null).filter((t): t is Timing => t !== null)];
  return { plans, answers, gens };
}

/** The frames over 50 ms while the model wrote: how many, their total, the longest, and how many fell in a prefill. */
function longFrames(f: FrameWindow | undefined): string {
  if (!f?.long) return '–';
  const l = f.long;
  if (l.length === 0) return 'none';
  return `${l.length}, ${Math.round(l.reduce((a, x) => a + x.ms, 0))} ms in all, longest ${Math.max(...l.map((x) => x.ms))} ms; ${l.filter((x) => x.phase.endsWith('prefill')).length} in a prefill`;
}

function accuracyRow(r: RunFile): string[] {
  const cs = r.cases;
  const scored = cs.filter((c) => c.scored);
  const s = scored.map((c) => c.scored as NonNullable<CaseRecord['scored']>);
  const planned = s.filter((x) => x.plan.firstTryValid !== null);
  const tools = s.filter((x) => x.tool.toolCorrect !== null);
  const own = tools.filter((x) => x.plan.source === 'model');
  const argsOk = s.filter((x) => x.tool.argsCorrect !== null);
  const ownArgs = argsOk.filter((x) => x.plan.source === 'model');
  const grounded = scored.filter((c) => c.category === 'grounded');
  const groundedOk = grounded.filter((c) => c.scored?.checks.every((k) => k.pass) === true);
  const shown = s.flatMap((x) => x.citations.shown);
  const raw = s.flatMap((x) => x.citations.raw);
  const violations = s.flatMap((x) => x.integrity);
  const caught = s.filter((x) => x.guard.flags.length > 0 || x.guard.guardedNotice);
  const declines = s.filter((x) => x.decline !== null);
  const noModel = cs.filter((c) => c.timings && !c.timings.plan && !c.timings.answer && !c.timings.repair);
  const loads = cs.flatMap((c) => (c.loadavg ? [c.loadavg.before[0] ?? NaN] : []));
  const labels = s.reduce((a, x) => ({ m: a.m + x.labels.modelBlocks, l: a.l + x.labels.labelled }), { m: 0, l: 0 });
  return [
    `${r.name}${r.tag ? ` (${r.tag})` : ''}`,
    r.mode,
    String(cs.length),
    pct(cs.filter((c) => c.pass).length, cs.length),
    `${noModel.length} (${pct(noModel.filter((c) => c.pass).length, noModel.length)} passed)`,
    `${pct(planned.filter((x) => x.plan.firstTryValid).length, planned.length)}; ${pct(planned.filter((x) => x.plan.afterRepairValid).length, planned.length)}`,
    `${pct(tools.filter((x) => x.tool.toolCorrect).length, tools.length)}; model's own plans ${frac(own.filter((x) => x.tool.toolCorrect).length, own.length)}`,
    `${pct(argsOk.filter((x) => x.tool.argsCorrect).length, argsOk.length)}; model's own plans ${frac(ownArgs.filter((x) => x.tool.argsCorrect).length, ownArgs.length)}`,
    pct(groundedOk.length, grounded.length),
    `${pct(shown.filter((x) => x.inData).length, shown.length)}; markers ${pct(raw.filter((x) => x.valid).length, raw.length)}`,
    String(violations.length),
    `${caught.length} cases`,
    pct(declines.filter((x) => x.decline).length, declines.length),
    `${labels.l}/${labels.m}`,
    String(s.filter((x) => x.markup.length > 0).length),
    String(s.filter((x) => x.engine === false).length + cs.filter((c) => c.reloaded !== undefined).length),
    String(cs.filter((c) => c.error || c.timedOut).length),
    loads.length ? range(loads) : '–',
  ];
}

const ACCURACY = [
  'Model', 'Mode', 'Cases', 'Passed', 'Answered with no model generation (passed)', 'Plan valid: first try; after repair', 'Tool right (all; the model’s own plans)', 'Arguments right (all; the model’s own plans)', 'Grounded facts', 'Citations in data (shown; raw markers)', 'Integrity violations after guards', 'Guard catches before output', 'Declines right', 'Model text labelled', 'Cases with markup on screen', 'Cases not answered by the model under test (or reloaded)', 'Errors or timeouts', '1-min load average over the cases',
];

function speedRow(r: RunFile): string[] {
  const { plans, answers, gens } = timingsOf(r.cases);
  const f = r.frames;
  const gpus = r.cases.flatMap((c) => (c.loadavg?.gpuClients && c.loadavg.gpuClients.others >= 0 ? [c.loadavg.gpuClients.others] : []));
  return [
    `${r.name}${r.tag ? ` (${r.tag})` : ''}`,
    r.mode,
    String(gens.length),
    `${ms(median(num(plans.map((t) => t.ttftMs))))} / ${ms(median(num(answers.map((t) => t.ttftMs))))}`,
    fmt(median(num(answers.map((t) => t.prefillTokensPerS)))),
    fmt(median(num(gens.map((t) => t.decodeTokensPerS))), 1),
    fmt(median(num(gens.map(delivered))), 1),
    ms(median(num(plans.map((t) => t.grammarInitMs)))),
    r.load ? `${ms(r.load.cached.ms)} (load ${fmt(r.load.cached.loadavg[0], 1)})` : 'did not load',
    f ? `${fmt(f.idle.p50, 1)} / ${fmt(f.idle.p95, 1)} / ${fmt(f.idle.max, 0)} (load ${fmt(f.idle.loadavg[0], 1)})` : '–',
    f ? `${fmt(f.generating.p50, 1)} / ${fmt(f.generating.p95, 1)} / ${fmt(f.generating.max, 0)} (load ${fmt(f.generating.loadavg[0], 1)})` : '–',
    longFrames(f?.generating),
    gpus.length ? `${Math.min(...gpus)}–${Math.max(...gpus)}` : '–',
  ];
}

const SPEED = [
  'Model', 'Mode', 'Generations', 'Time to first token, median (plan / answer)', 'Prefill tok/s, median (answers)', 'Decode tok/s, median: WebLLM’s decode steps', 'Decode tok/s, median: as the app delivers it', 'Grammar start, median (plans)', 'Load from the Cache API', 'Frames idle p50 / p95 / max, ms', 'Frames while it writes p50 / p95 / max, ms', 'Frames over 50 ms while it writes one turn (plan and answer)', 'Other browsers’ GPU processes over the cases',
];

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map((c) => c.replace(/\|/gu, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

/** The speed passes of one model, together: each figure the median of the passes, with the passes' range. */
function passesRow(name: string, runs: readonly RunFile[]): string[] {
  const per = runs.map((r) => {
    const { plans, answers, gens } = timingsOf(r.cases);
    return {
      planTtft: median(num(plans.map((t) => t.ttftMs))),
      answerTtft: median(num(answers.map((t) => t.ttftMs))),
      webllm: median(num(gens.map((t) => t.decodeTokensPerS))),
      app: median(num(gens.map(delivered))),
      cache: r.load?.cached.ms ?? null,
      longest: r.frames?.generating.max ?? null,
      longCount: r.frames?.generating.long?.length ?? null,
      longTotal: r.frames?.generating.long ? r.frames.generating.long.reduce((a, x) => a + x.ms, 0) : null,
      loads: r.cases.flatMap((c) => (c.loadavg ? [c.loadavg.before[0] ?? NaN] : [])),
      gpus: r.cases.flatMap((c) => (c.loadavg?.gpuClients && c.loadavg.gpuClients.others >= 0 ? [c.loadavg.gpuClients.others] : [])),
      gpuCpu: r.cases.flatMap((c) => (c.loadavg?.gpuClients && c.loadavg.gpuClients.othersCpu >= 0 ? [c.loadavg.gpuClients.othersCpu] : [])),
    };
  });
  const both = (xs: (number | null)[], f: (x: number | null) => string): string => {
    const v = num(xs);
    return v.length ? `${f(median(v))} (${f(Math.min(...v))}–${f(Math.max(...v))})` : '–';
  };
  const one = (x: number | null): string => fmt(x, 1);
  return [
    name,
    String(runs.length),
    both(per.map((p) => p.webllm), one),
    both(per.map((p) => p.app), one),
    `${both(per.map((p) => p.planTtft), ms)} / ${both(per.map((p) => p.answerTtft), ms)}`,
    both(per.map((p) => p.cache), ms),
    both(per.map((p) => p.longest), (x) => fmt(x, 0)),
    `${both(per.map((p) => p.longCount), (x) => fmt(x, 0))}; ${both(per.map((p) => p.longTotal), (x) => fmt(x, 0))} ms`,
    range(per.flatMap((p) => p.loads)),
    `${range(per.flatMap((p) => p.gpus), 0)} (${range(per.flatMap((p) => p.gpuCpu), 0)}% CPU)`,
  ];
}

/** Runs scored again (rescore.ts) beside the same runs as scored when they ran: what a later scorer found that the first did not. */
function rescoredTable(runs: readonly { file: string; run: RunFile }[], from: string): string {
  const rows = runs.map(({ file, run }) => {
    const original = join(from, basename(file));
    const was = existsSync(original) ? (JSON.parse(readFileSync(original, 'utf8')) as RunFile) : null;
    const types: Record<string, number> = {};
    for (const c of run.cases) for (const v of c.scored?.integrity ?? []) types[v.type] = (types[v.type] ?? 0) + 1;
    const wasViolations = was ? was.cases.reduce((n, c) => n + (c.scored?.integrity.length ?? 0), 0) : null;
    return [
      run.name,
      run.mode,
      was ? pct(was.cases.filter((c) => c.pass).length, was.cases.length) : '–',
      pct(run.cases.filter((c) => c.pass).length, run.cases.length),
      wasViolations === null ? '–' : String(wasViolations),
      `${((n) => `${n} ${n === 1 ? "case" : "cases"}`)(run.cases.filter((c) => (c.scored?.integrity.length ?? 0) > 0).length)}: ${Object.entries(types).sort().map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`,
      String(run.cases.filter((c) => (c.scored?.markup.length ?? 0) > 0).length),
    ];
  });
  return table(['Model', 'Mode', 'Passed, as scored when it ran', 'Passed, scored again', 'Integrity violations, as scored when it ran', 'Integrity violations, scored again', 'Cases with markup on screen, scored again'], rows);
}

function main(): void {
  const runs: { file: string; run: RunFile }[] = [];
  const network: { file: string; run: NetworkFile }[] = [];
  for (const file of files()) {
    const data = JSON.parse(readFileSync(file, 'utf8')) as RunFile | NetworkFile;
    if (basename(file).startsWith('network-')) network.push({ file, run: data as NetworkFile });
    else if ('cases' in data) runs.push({ file, run: data });
  }
  const lines: string[] = [];
  lines.push(`<!-- Generated by scripts/ai-eval/report.ts from ${inputs.length > 0 ? inputs.join(', ') : '.work/ai-eval/results'}${rescoredFrom ? ` beside ${rescoredFrom}` : ''}; do not edit by hand. -->`);
  if (rescoredFrom) {
    lines.push('', rescoredTable(runs, rescoredFrom));
    runs.splice(0, runs.length);
    network.splice(0, network.length);
  }
  if (runs.length > 0) {
    const m = runs[0]?.run.machine;
    lines.push('', `Machine: ${m?.cpu ?? '?'}, ${((m?.memoryBytes ?? 0) / 2 ** 30).toFixed(0)} GB, ${m?.os ?? '?'}; WebGPU adapter ${m?.adapter?.vendor ?? '?'} ${m?.adapter?.architecture ?? ''}; ${m?.adapter?.userAgent.match(/Chrome\/[\d.]+/u)?.[0] ?? ''}.`);
    lines.push('', `Runs: ${runs.map((r) => `${basename(r.file)} (${r.run.startedAt.slice(0, 16)}Z${r.run.finishedAt ? '' : ', unfinished'})`).join('; ')}.`);
    const timing = runs.filter((r) => r.run.tag?.startsWith('timing') === true);
    // Runs tagged "after…" ran some cases again after a fix: each beside the same cases of its full run.
    const after = runs.filter((r) => r.run.tag?.startsWith('after') === true);
    const scored = runs.filter((r) => !(r.run.tag?.startsWith('timing') === true) && !(r.run.tag?.startsWith('after') === true));
    const failed = scored.filter((r) => r.run.loadError);
    if (failed.length > 0) {
      lines.push('', H + ' Models that did not load', '', table(['Model', 'Mode', 'Stage', 'Error code', 'Error (as WebLLM or the panel gave it)', '1-min load average'], failed.map((r) => {
        const e = r.run.loadError;
        return [r.run.name, r.run.mode, e?.stage ?? '', e?.code ?? '–', (e?.detail ?? e?.panel ?? '–').slice(0, 300), fmt(e?.loadavg[0], 1)];
      })));
    }
    runs.splice(0, runs.length, ...scored.filter((r) => !r.run.loadError));
    lines.push('', H + ' Models: what they got right', '', table(ACCURACY, runs.map((r) => accuracyRow(r.run))));
    lines.push('', H + ' Models: speed and frames in the full runs', '', table(SPEED, runs.map((r) => speedRow(r.run))));
    if (after.length > 0) {
      // The same cases in the full run of that model and mode, beside the run after the last fixes.
      lines.push('', H + ' The cases the last fixes touched, run again afterwards', '', table(
        ['Model', 'Mode', 'Cases', 'Passed in the full run', 'Passed afterwards', 'Integrity violations, full run → afterwards', 'Guard catches afterwards (cases)', 'Cases with markup on screen afterwards', '1-min load average'],
        after.map(({ run: a }) => {
          const ids = new Set(a.cases.map((c) => c.id));
          const full = scored.find((r) => r.run.model === a.model && r.run.mode === a.mode)?.run;
          const before = full ? full.cases.filter((c) => ids.has(c.id)) : [];
          const loads = a.cases.flatMap((c) => (c.loadavg ? [c.loadavg.before[0] ?? NaN] : []));
          return [
            `${a.name}${a.tag && a.tag !== 'after' ? ` (${a.tag})` : ''}`,
            a.mode,
            String(a.cases.length),
            full ? pct(before.filter((c) => c.pass).length, before.length) : '–',
            pct(a.cases.filter((c) => c.pass).length, a.cases.length),
            `${before.reduce((n, c) => n + (c.scored?.integrity.length ?? 0), 0)} → ${a.cases.reduce((n, c) => n + (c.scored?.integrity.length ?? 0), 0)}`,
            String(a.cases.filter((c) => (c.scored?.guard.flags.length ?? 0) > 0 || c.scored?.guard.guardedNotice).length),
            String(a.cases.filter((c) => (c.scored?.markup.length ?? 0) > 0).length),
            loads.length ? range(loads) : '–',
          ];
        }),
      ));
    }
    if (timing.length > 0) {
      const names = [...new Set(timing.map((t) => t.run.name))];
      lines.push('', H + ' Speed passes (the same 10 cases, model mode, the models in alternating order)', '', table(
        ['Model', 'Passes', 'Decode tok/s, WebLLM’s decode steps: median of the passes (range)', 'Decode tok/s, as the app delivers it: median (range)', 'Time to first token, plan / answer: median (range)', 'Load from the Cache API: median (range)', 'Longest frame while it writes, ms: median (range)', 'Frames over 50 ms while it writes one turn: count; total', '1-min load average over the passes’ cases', 'Other browsers’ GPU processes (their CPU)'],
        names.map((n) => passesRow(n, timing.filter((t) => t.run.name === n).map((t) => t.run))),
      ));
      lines.push('', H + ' Each speed pass', '', table(SPEED, timing.map((r) => speedRow(r.run))));
    }
    // By category.
    const cats = [...new Set(runs.flatMap((r) => r.run.cases.map((c) => c.category)))];
    lines.push('', H + ' Passed, by category', '', table(['Model', 'Mode', ...cats], runs.map((r) => [`${r.run.name}${r.run.tag ? ` (${r.run.tag})` : ''}`, r.run.mode, ...cats.map((cat) => {
      const cs = r.run.cases.filter((c) => c.category === cat);
      return pct(cs.filter((c) => c.pass).length, cs.length);
    })])));
    // Violations and guard flags by type.
    const types = [...new Set(runs.flatMap((r) => r.run.cases.flatMap((c) => [...(c.scored?.integrity.map((v) => `violation: ${v.type}`) ?? []), ...(c.scored?.guard.flags.map((g) => `guard: ${g}`) ?? [])])))].sort();
    if (types.length > 0) {
      lines.push('', H + ' Integrity after the guards, and what the guards caught (cases)', '', table(['Model', 'Mode', ...types], runs.map((r) => [`${r.run.name}${r.run.tag ? ` (${r.run.tag})` : ''}`, r.run.mode, ...types.map((t) => String(r.run.cases.filter((c) => [...(c.scored?.integrity.map((v) => `violation: ${v.type}`) ?? []), ...(c.scored?.guard.flags.map((g) => `guard: ${g}`) ?? [])].includes(t)).length))])));
    }
    const unexpected = runs.flatMap((r) => [...r.run.unexpectedRequests, ...(r.run.unservedModelHosts ?? [])].map((u) => `${r.run.model} ${r.run.mode}: ${u}`));
    lines.push('', `Requests to a model host that were not pinned files: ${unexpected.length === 0 ? 'none' : unexpected.join('; ')}.`);
    const hosts: Record<string, number> = {};
    for (const r of runs) for (const [h, n] of Object.entries(r.run.externalHosts ?? {})) hosts[h] = (hosts[h] ?? 0) + n;
    const logged = runs.filter((r) => r.run.externalHosts !== undefined).length;
    if (logged > 0) lines.push('', `Other hosts the browser asked (${logged} of ${runs.length} runs logged every request): ${Object.keys(hosts).length === 0 ? 'none' : Object.entries(hosts).map(([h, n]) => `${h} ${n}`).join(', ')}.`);
    lines.push('', `GPU memory: ${runs.every((r) => r.run.gpuMemory.reported === null) ? 'WebLLM reports none at run time; the catalogue estimates are ' + runs.map((r) => `${r.run.name} ${fmt(r.run.catalogue.vramMBEstimate)} MB`).filter((v, i, a) => a.indexOf(v) === i).join(', ') : 'see the raw files'}.`);
    if (details) {
      const ids = [...new Set(runs.flatMap((r) => r.run.cases.map((c) => c.id)))];
      lines.push('', H + ' Each case', '', table(['Case', 'Category', ...runs.map((r) => `${r.run.name} ${r.run.mode}${r.run.tag ? ` ${r.run.tag}` : ''}`)], ids.map((id) => {
        const cat = runs.flatMap((r) => r.run.cases).find((c) => c.id === id)?.category ?? '';
        return [id, cat, ...runs.map((r) => {
          const c = r.run.cases.find((x) => x.id === id);
          if (!c) return '';
          if (c.error) return 'error';
          if (c.timedOut) return 'timeout';
          return `${c.pass ? 'pass' : 'fail'}${c.scored?.integrity.length ? ` (${c.scored.integrity.length} violations)` : ''}`;
        })];
      })));
    }
  }
  if (network.length > 0) {
    lines.push('', H + ' A real download (Hugging Face and jsDelivr, unrouted)', '', table(
      ['Model', 'When', 'Model-host requests before Ask / before Download', 'Size shown first', 'Second question on an unknown connection', 'Click to ready', 'Requests (hosts)', 'Bytes from model hosts', 'Progress samples (max, monotonic)', 'Answer', 'Reload: click to ready, model-host requests', 'Delete: Cache API entries before → after, model-host requests', 'Storage usage before → after delete', '1-min load average at Download → at the end'],
      network.map(({ run: n }) => [
        n.model,
        n.startedAt.slice(0, 16),
        `${n.beforeAsk.modelHostRequests} / ${n.beforeDownload.modelHostRequests}`,
        n.beforeDownload.sizeText,
        n.download.meteredAsked ? 'yes' : 'no',
        ms(n.download.msClickToReady),
        `${n.download.requests} (${n.download.hosts.join(', ')})`,
        String(n.download.bytesFromModelHosts),
        `${n.download.progressSamples} (${n.download.progressMax ?? '–'}, ${n.download.progressMonotonic ? 'yes' : 'no'})`,
        n.answer ? `${ms(n.answer.ms)}, labelled “${n.answer.label ?? ''}”` : '–',
        n.reload ? `${ms(n.reload.msClickToReady)}, ${n.reload.modelHostRequests}` : '–',
        n.delete ? `${Object.values(n.delete.cacheBefore).reduce((a, b) => a + b, 0)} → ${Object.values(n.delete.cacheAfter).reduce((a, b) => a + b, 0)}, ${n.delete.modelHostRequests}` : '–',
        n.delete ? `${n.delete.usageBytesBefore ?? '–'} → ${n.delete.usageBytesAfter ?? '–'}` : '–',
        `${fmt(n.download.loadavg.before[0], 1)} → ${fmt(n.loadavgEnd?.[0], 1)}`,
      ]),
    ));
  }
  if (runs.length === 0 && network.length === 0 && !rescoredFrom) lines.push('', `No results found in ${inputs.join(', ') || defaultDir}.`);
  const text = `${lines.join('\n')}\n`;
  if (into) {
    const doc = readFileSync(into, 'utf8');
    const open = `<!-- report${block ? `:${block}` : ''}:start -->`;
    const close = `<!-- report${block ? `:${block}` : ''}:end -->`;
    const start = doc.indexOf(open);
    const end = doc.indexOf(close);
    if (start < 0 || end < start) throw new Error(`${into} has no "${open}" … "${close}"`);
    writeFileSync(into, `${doc.slice(0, start)}${open}\n${text}${doc.slice(end)}`);
  } else if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

main();
