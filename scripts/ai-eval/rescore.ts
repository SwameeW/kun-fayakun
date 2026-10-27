/*
 * Scores the real-model evaluation's raw results again with the current case set and scorer
 * (tests/ai-eval/cases.ts, score.ts), without running a model: each case's record keeps the turn, the
 * generations and what else the scorer read (eval.spec.ts writes them). For a scorer fixed after a
 * long run. The score the run itself made is kept beside the new one as scoredAtRun. A record that was
 * redacted when it was written (the trap naming the narration data/hadith.json excludes) keeps its
 * run-time score, since what that score read is no longer in the file.
 *
 *   node --import tsx scripts/ai-eval/rescore.ts .work/ai-eval/results/<model>-<mode>.json [...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { GenerationRecord } from '../../src/ai/types';
import { CASES } from '../../tests/ai-eval/cases';
import { score, type Observation, type TurnData } from '../../tests/ai-eval/score';

const mind = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;

interface Record_ {
  id: string;
  pass: boolean;
  timedOut?: boolean;
  scored?: unknown;
  scoredAtRun?: unknown;
  turn?: TurnData;
  generations?: GenerationRecord[];
  observed?: Pick<Observation, 'kinds' | 'dom' | 'lab' | 'walking' | 'modelName'>;
}

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, 'utf8')) as { cases: Record_[] };
  let changed = 0;
  let skipped = 0;
  for (const r of run.cases) {
    const c = CASES.find((x) => x.id === r.id);
    // A redacted record (the excluded narration's trap) no longer holds what its run-time score read: it keeps that score.
    if (!c || c.redact || !r.turn || !r.generations || !r.observed) {
      skipped += 1;
      continue;
    }
    const s = score(c, { turn: r.turn, generations: r.generations, ...r.observed, clarifyText: mind['ai.mind.clarify.convention'] ?? '', declineText: mind['ai.mind.guide.decline'] ?? '' });
    r.scoredAtRun ??= r.scored;
    if (JSON.stringify(s) !== JSON.stringify(r.scored)) changed += 1;
    r.scored = s;
    r.pass = s.pass && r.timedOut !== true;
  }
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(`${file}: ${run.cases.length} cases, ${changed} scored differently, ${skipped} without the data to score again\n`);
}
