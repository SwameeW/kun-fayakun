import type { ExperimentId, ExperimentPlan, ToolProblem } from '../types';
import { compareRuns, PlanProblems, type Baseline, type RawComparison, type RunOptions } from './compare';
import { planExperiment, type PlanNames } from './experiments';
import { optimise, type OptimiseResult, type OptimiseSearch } from './optimise';

/**
 * The background jobs and their messages: a comparison of two runs, or a search over one parameter.
 * The same `runBatch` serves the dedicated worker (./batch-worker.ts) and, where there is no worker
 * (Node, tests), the page itself.
 */

export type BatchRequest =
  /** A comparison of a plan already made. */
  | { type: 'compare'; baseline: Baseline; plan: Pick<ExperimentPlan, 'id' | 'commands' | 'horizonDays'> }
  /** A comparison of an experiment planned against the laboratory as it stands at the fork. */
  | { type: 'compare-experiment'; baseline: Baseline; experiment: ExperimentId; params: Readonly<Record<string, number | string>>; names: PlanNames }
  | { type: 'optimise'; baseline: Baseline; search: OptimiseSearch };

export type BatchResult = { type: 'compare'; comparison: RawComparison } | { type: 'problems'; problems: ToolProblem[] } | { type: 'optimise'; result: OptimiseResult };

/** Page to worker. */
export type ToWorker = { type: 'run'; id: number; request: BatchRequest } | { type: 'abort'; id: number };

/** Worker to page. */
export type FromWorker = { type: 'progress'; id: number; fraction: number; phase: 'replay' | 'run' } | { type: 'done'; id: number; result: BatchResult } | { type: 'error'; id: number; message: string; aborted: boolean };

export async function runBatch(request: BatchRequest, options: RunOptions = {}): Promise<BatchResult> {
  switch (request.type) {
    case 'compare':
      return { type: 'compare', comparison: await compareRuns(request.baseline, request.plan, options) };
    case 'compare-experiment':
      try {
        const comparison = await compareRuns(request.baseline, (world) => planExperiment(request.experiment, request.params, null, { world, names: request.names }), options);
        return { type: 'compare', comparison };
      } catch (err) {
        if (err instanceof PlanProblems) return { type: 'problems', problems: err.problems };
        throw err;
      }
    case 'optimise':
      return { type: 'optimise', result: await optimise(request.baseline, request.search, options) };
  }
}
