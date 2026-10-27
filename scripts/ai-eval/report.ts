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
 *
 * It reads the raw files or their compact copies (scripts/ai-eval/compact.ts, committed in
 * docs/ai-eval). Runs tagged "timing" (the speed pass on a quieter machine) get their own table.
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

interface CaseRecord {
  id: string;
  category: string;
  tag: string;
  pass: boolean;
  error?: string;
  timedOut?: boolean;
  state?: string;
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
  };
  timings?: { totalMs: number; plan: Timing | null; repair: Timing | null; answer: Timing | null };
  loadavg?: { before: number[]; after: number[] };
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
  frames: {
    idle: { n: number; p50: number | null; p95: number | null; max: number | null; loadavg: number[] };
    generating: { n: number; p50: number | null; p95: number | null; max: number | null; loadavg: number[] };
  } | null;
  unexpectedRequests: string[];
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
}

const args = process.argv.slice(2);
const details = args.includes('--details');
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const intoAt = args.indexOf('--into');
const into = intoAt >= 0 ? args[intoAt + 1] : undefined;
const inputs = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1) && (intoAt < 0 || i !== intoAt + 1));
/** The tables' headings: a section of their own, or under the document's own heading (--into). */
const H = into ? '###' : '##';
const defaultDir = resolve('.work/ai-eval/results');

function files(): string[] {
  const list = inputs.length > 0 ? inputs : [defaultDir];
  return list.flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.json')).map((f) => join(p, f)) : [p])).sort();
}

const pct = (n: number, d: number): string => (d === 0 ? '–' : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);
const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const fmt = (x: number | null | undefined, digits = 0): string => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(digits));
const ms = (x: number | null | undefined): string => (x === null || x === undefined ? '–' : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const num = (xs: readonly (number | null | undefined)[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

function runRow(r: RunFile): string[] {
  const cs = r.cases;
  const scored = cs.filter((c) => c.scored);
  const s = scored.map((c) => c.scored as NonNullable<CaseRecord['scored']>);
  const planned = s.filter((x) => x.plan.firstTryValid !== null);
  const tools = s.filter((x) => x.tool.toolCorrect !== null);
  const argsOk = s.filter((x) => x.tool.argsCorrect !== null);
  const grounded = scored.filter((c) => c.category === 'grounded');
  const groundedOk = grounded.filter((c) => c.scored?.checks.every((k) => k.pass) === true);
  const shown = s.flatMap((x) => x.citations.shown);
  const raw = s.flatMap((x) => x.citations.raw);
  const violations = s.flatMap((x) => x.integrity);
  const caught = s.filter((x) => x.guard.flags.length > 0 || x.guard.guardedNotice);
  const declines = s.filter((x) => x.decline !== null);
  const plans = cs.map((c) => c.timings?.plan ?? null).filter((t): t is Timing => t !== null);
  const answers = cs.map((c) => c.timings?.answer ?? null).filter((t): t is Timing => t !== null);
  const gens = [...plans, ...answers, ...cs.map((c) => c.timings?.repair ?? null).filter((t): t is Timing => t !== null)];
  const loads = cs.flatMap((c) => (c.loadavg ? [c.loadavg.before[0] ?? NaN] : []));
  const labels = s.reduce((a, x) => ({ m: a.m + x.labels.modelBlocks, l: a.l + x.labels.labelled }), { m: 0, l: 0 });
  const markup = s.filter((x) => x.markup.length > 0).length;
  const f = r.frames;
  return [
    `${r.name}${r.tag ? ` (${r.tag})` : ''}`,
    r.mode,
    String(cs.length),
    pct(cs.filter((c) => c.pass).length, cs.length),
    pct(planned.filter((x) => x.plan.firstTryValid).length, planned.length),
    pct(planned.filter((x) => x.plan.afterRepairValid).length, planned.length),
    pct(tools.filter((x) => x.tool.toolCorrect).length, tools.length),
    pct(argsOk.filter((x) => x.tool.argsCorrect).length, argsOk.length),
    pct(groundedOk.length, grounded.length),
    `${pct(shown.filter((x) => x.inData).length, shown.length)}; markers ${pct(raw.filter((x) => x.valid).length, raw.length)}`,
    String(violations.length),
    `${caught.length} cases`,
    pct(declines.filter((x) => x.decline).length, declines.length),
    `${ms(median(num(plans.map((t) => t.ttftMs))))} / ${ms(median(num(answers.map((t) => t.ttftMs))))}`,
    fmt(median(num(answers.map((t) => t.prefillTokensPerS)))),
    fmt(median(num(gens.map((t) => t.decodeTokensPerS))), 1),
    ms(median(num(plans.map((t) => t.grammarInitMs)))),
    r.load ? `${ms(r.load.cached.ms)} (load ${fmt(r.load.cached.loadavg[0], 1)})` : 'did not load',
    f ? `${fmt(f.idle.p50, 1)} / ${fmt(f.idle.p95, 1)}` : '–',
    f ? `${fmt(f.generating.p50, 1)} / ${fmt(f.generating.p95, 1)} (max ${fmt(f.generating.max, 0)})` : '–',
    loads.length ? `${fmt(Math.min(...loads), 1)}–${fmt(Math.max(...loads), 1)}` : '–',
    `${labels.l}/${labels.m}`,
    String(markup),
    String(cs.filter((c) => c.error || c.timedOut).length),
  ];
}

const HEAD = ['Model', 'Mode', 'Cases', 'Passed', 'Plan valid, first try', 'Plan valid after repair', 'Tool right', 'Arguments right', 'Grounded facts', 'Citations in data (shown; raw markers)', 'Integrity violations after guards', 'Guard catches before output', 'Declines right', 'Time to first token, median (plan / answer)', 'Prefill tok/s, median (answers)', 'Decode tok/s, median', 'Grammar start, median (plans)', 'Load from the Cache API', 'Frames idle p50 / p95 (ms)', 'Frames generating p50 / p95 (ms)', '1-min load average over the cases', 'Model text labelled', 'Cases with markup on screen', 'Errors or timeouts'];

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.map((c) => c.replace(/\|/gu, '\\|')).join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
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
  lines.push(`<!-- Generated by scripts/ai-eval/report.ts from ${inputs.length > 0 ? inputs.join(', ') : '.work/ai-eval/results'}; do not edit by hand. -->`);
  if (runs.length > 0) {
    const m = runs[0]?.run.machine;
    lines.push('', `Machine: ${m?.cpu ?? '?'}, ${((m?.memoryBytes ?? 0) / 2 ** 30).toFixed(0)} GB, ${m?.os ?? '?'}; WebGPU adapter ${m?.adapter?.vendor ?? '?'} ${m?.adapter?.architecture ?? ''}; ${m?.adapter?.userAgent.match(/Chrome\/[\d.]+/u)?.[0] ?? ''}.`);
    lines.push('', `Runs: ${runs.map((r) => `${basename(r.file)} (${r.run.startedAt.slice(0, 16)}Z${r.run.finishedAt ? '' : ', unfinished'})`).join('; ')}.`);
    const timing = runs.filter((r) => r.run.tag === 'timing');
    const after = runs.filter((r) => r.run.tag === 'after');
    const scored = runs.filter((r) => r.run.tag !== 'timing' && r.run.tag !== 'after');
    const failed = scored.filter((r) => r.run.loadError);
    if (failed.length > 0) {
      lines.push('', H + ' Models that did not load', '', table(['Model', 'Mode', 'Stage', 'Error code', 'Error (as WebLLM or the panel gave it)', '1-min load average'], failed.map((r) => {
        const e = r.run.loadError;
        return [r.run.name, r.run.mode, e?.stage ?? '', e?.code ?? '–', (e?.detail ?? e?.panel ?? '–').slice(0, 300), fmt(e?.loadavg[0], 1)];
      })));
    }
    runs.splice(0, runs.length, ...scored.filter((r) => !r.run.loadError));
    lines.push('', H + ' Models', '', table(HEAD, runs.map((r) => runRow(r.run))));
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
            a.name,
            a.mode,
            String(a.cases.length),
            full ? pct(before.filter((c) => c.pass).length, before.length) : '–',
            pct(a.cases.filter((c) => c.pass).length, a.cases.length),
            `${before.reduce((n, c) => n + (c.scored?.integrity.length ?? 0), 0)} → ${a.cases.reduce((n, c) => n + (c.scored?.integrity.length ?? 0), 0)}`,
            String(a.cases.filter((c) => (c.scored?.guard.flags.length ?? 0) > 0 || c.scored?.guard.guardedNotice).length),
            String(a.cases.filter((c) => (c.scored?.markup.length ?? 0) > 0).length),
            loads.length ? `${fmt(Math.min(...loads), 1)}–${fmt(Math.max(...loads), 1)}` : '–',
          ];
        }),
      ));
    }
    if (timing.length > 0) {
      lines.push('', H + ' Speed and frames, measured again on a quieter machine', '', table(
        ['Model', 'Mode', 'Generations', 'Time to first token, median (plan / answer)', 'Prefill tok/s, median (answers)', 'Decode tok/s, median (all)', 'Grammar start, median (plans)', 'Load from the Cache API', 'Frames idle p50 / p95 / max (ms)', 'Frames generating p50 / p95 / max (ms)', '1-min load average (cases; frames idle / generating)'],
        timing.map(({ run: r }) => {
          const plans = r.cases.map((c) => c.timings?.plan ?? null).filter((t): t is Timing => t !== null);
          const answers = r.cases.map((c) => c.timings?.answer ?? null).filter((t): t is Timing => t !== null);
          const gens = [...plans, ...answers, ...r.cases.map((c) => c.timings?.repair ?? null).filter((t): t is Timing => t !== null)];
          const loads = r.cases.flatMap((c) => (c.loadavg ? [c.loadavg.before[0] ?? NaN] : []));
          const f = r.frames;
          return [
            r.name,
            r.mode,
            String(gens.length),
            `${ms(median(num(plans.map((t) => t.ttftMs))))} / ${ms(median(num(answers.map((t) => t.ttftMs))))}`,
            fmt(median(num(answers.map((t) => t.prefillTokensPerS)))),
            fmt(median(num(gens.map((t) => t.decodeTokensPerS))), 1),
            ms(median(num(plans.map((t) => t.grammarInitMs)))),
            r.load ? `${ms(r.load.cached.ms)} (load ${fmt(r.load.cached.loadavg[0], 1)})` : '–',
            f ? `${fmt(f.idle.p50, 1)} / ${fmt(f.idle.p95, 1)} / ${fmt(f.idle.max, 0)}` : '–',
            f ? `${fmt(f.generating.p50, 1)} / ${fmt(f.generating.p95, 1)} / ${fmt(f.generating.max, 0)}` : '–',
            `${loads.length ? `${fmt(Math.min(...loads), 1)}–${fmt(Math.max(...loads), 1)}` : '–'}; ${f ? `${fmt(f.idle.loadavg[0], 1)} / ${fmt(f.generating.loadavg[0], 1)}` : '–'}`,
          ];
        }),
      ));
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
    const unexpected = runs.flatMap((r) => r.run.unexpectedRequests.map((u) => `${r.run.model} ${r.run.mode}: ${u}`));
    lines.push('', `Requests to a model host that were not pinned files: ${unexpected.length === 0 ? 'none' : unexpected.join('; ')}.`);
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
      ['Model', 'When', 'Model-host requests before Ask / before Download', 'Size shown first', 'Second question on an unknown connection', 'Click to ready', 'Requests (hosts)', 'Bytes from model hosts', 'Progress samples (max, monotonic)', 'Answer', 'Reload: click to ready, model-host requests', 'Delete: Cache API entries before → after, model-host requests', 'Storage usage before → after delete'],
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
      ]),
    ));
  }
  if (runs.length === 0 && network.length === 0) lines.push('', `No results found in ${inputs.join(', ') || defaultDir}.`);
  const text = `${lines.join('\n')}\n`;
  if (into) {
    const doc = readFileSync(into, 'utf8');
    const start = doc.indexOf('<!-- report:start -->');
    const end = doc.indexOf('<!-- report:end -->');
    if (start < 0 || end < start) throw new Error(`${into} has no "<!-- report:start -->" … "<!-- report:end -->"`);
    writeFileSync(into, `${doc.slice(0, start)}<!-- report:start -->\n${text}${doc.slice(end)}`);
  } else if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

main();
