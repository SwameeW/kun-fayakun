/**
 * Node's process, reached through globalThis so the browser-typed tsconfig
 * does not need @types/node (see node-fs.d.ts for why).
 */
interface NodeProcess {
  env: Record<string, string | undefined>;
  platform: string;
}

const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process;

export function env(name: string): string | undefined {
  return nodeProcess?.env[name];
}

/** True when the variable is set to "1". */
export function flag(name: string): boolean {
  return env(name) === '1';
}

export const platform: string = nodeProcess?.platform ?? 'unknown';

/**
 * How many times longer waits are on CI, which has no GPU: every frame is drawn in software
 * (SwiftShader). Only limits grow; what a test checks does not change.
 */
export const SLOW: number = env('CI') ? 3 : 1;

/**
 * CI has no GPU. A few tests measure what only real frame rates show (an animation's steps, an ease
 * sampled frame by frame, the governor's response to slow frames, a double tap's timing); at the
 * frame or two a second of software rendering they cannot pass or fail meaningfully, so they run
 * only on machines with a GPU (every local run) and are skipped on CI with this reason.
 */
export const NO_GPU: boolean = Boolean(env('CI'));
export const NEEDS_REAL_FRAMES = 'measures frame-by-frame timing, which CI (software rendering, no GPU) cannot reproduce; runs on GPU machines';
/**
 * Others draw GPU-heavy views (the laboratory, walks, the small worlds, the stars) long enough that in
 * software rendering they run out of time: on CI (2026-10-28) a frame there took seconds and a
 * screenshot about 20 s. They also run only on machines with a GPU, before every release; the spec
 * files that are GPU-heavy throughout are left out of CI whole (GPU_SPECS in playwright.config.ts).
 */
export const NEEDS_GPU = 'draws GPU-heavy views that run out of time in software rendering (CI, no GPU); runs on GPU machines before every release';
