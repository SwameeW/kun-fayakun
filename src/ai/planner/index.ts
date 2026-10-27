/**
 * The experiment planner (docs/AI-INTELLIGENCE.md, phase C): deterministic plans for the laboratory,
 * and the background comparison and search. This entry is light: the engine's side (./compare,
 * ./optimise, the worker) loads only when a comparison or a search runs (`runInBackground`).
 */
export {
  DEFAULT_HORIZON_DAYS,
  EXPERIMENT_IDS,
  EXPERIMENT_PARAMS,
  experimentPreview,
  experimentProblems,
  HORIZON_DAYS,
  isPlan,
  KICK_DIRECTIONS,
  labCommandProblems,
  planExperiment,
  resolveBody,
  worldFromContext,
  worldFromLab,
  type KickDirection,
  type PlanBody,
  type PlanNames,
  type PlanWorld,
} from './experiments';
export { runInBackground } from './client';
export type { BatchRequest, BatchResult } from './batch';
export type { Baseline, BodyMetrics, RawComparison, RawEvent } from './compare';
export type { OptimiseGoal, OptimiseResult, OptimiseSearch } from './optimise';
