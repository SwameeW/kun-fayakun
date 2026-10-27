/**
 * The render budget's holds (AppCommands.requestRenderBudget, docs/AI-INTELLIGENCE.md §6) on the
 * governors themselves, without a browser: while a budget is held (the assistant's model shares the
 * GPU), the film's tier and resolution governors and the explorer's detail governor ignore every
 * frame, so the model's load never drops a tier, fails a try upward, locks one or counts a failure;
 * once released they judge frames as before. (The scale cap itself is checked on the real page in
 * tests/ai-engine.spec.ts.)
 */
import { expect, test } from '@playwright/test';
import { createQualityGovernor } from '../../src/core/quality';
import { createResolutionGovernor } from '../../src/core/resolution';
import { QUALITY_PROFILES } from '../../src/core/types';
import { DETAIL, EXPLORE_TIERS, type ExploreTier } from '../../src/explore/detail';
import { availableTiers, createDetailGovernor, GOVERNOR, type DetailGovernor, type DeviceInfo, type GovernorDecision } from '../../src/explore/quality';
import { constant, play, steady, type Trace } from '../support/frames';

/** A budget as the engine holds it: the governors read it through their `held` option. */
function budget(): { held: () => boolean; take(): void; release(): void } {
  let n = 0;
  return {
    held: () => n > 0,
    take() {
      n += 1;
    },
    release() {
      n = Math.max(0, n - 1);
    },
  };
}

test('the film: no tier drops while a budget is held, and judging resumes once it is released', () => {
  const b = budget();
  const governor = createQualityGovernor(QUALITY_PROFILES.high, { enabled: true, held: b.held });
  governor.suspend();
  governor.holdOff();
  play(5, steady(60, 1), (dt) => governor.sample(dt));
  b.take();
  const drops: string[] = [];
  play(60, constant(40), (dt) => {
    const lower = governor.sample(dt);
    if (lower) drops.push(lower.tier);
  });
  expect(drops).toEqual([]);
  b.release();
  play(10, constant(40), (dt) => {
    const lower = governor.sample(dt);
    if (lower) drops.push(lower.tier);
  });
  expect(drops[0]).toBe('mid');
});

test('the film: the resolution keeps its scale while a budget is held', () => {
  const b = budget();
  const resolution = createResolutionGovernor({ enabled: true, held: b.held });
  play(3.5, steady(60, 1), (dt) => resolution.sample(dt));
  b.take();
  play(30, constant(40), (dt) => resolution.sample(dt));
  expect(resolution.scale).toBe(1);
  b.release();
  play(5, constant(40), (dt) => resolution.sample(dt));
  expect(resolution.scale).toBeLessThan(1);
});

const MIN_SCALE = Object.fromEntries(EXPLORE_TIERS.map((t) => [t, DETAIL[t].minRenderScale])) as Record<ExploreTier, number>;
const DESKTOP: DeviceInfo = { backend: 'webgpu', description: 'apple metal-3 apple m5 pro', software: false, mobile: false, maxTextureSize: 16_384 };

function detail(held: () => boolean, tier: ExploreTier = 'high'): DetailGovernor {
  return createDetailGovernor({ tier, choice: 'auto', enabled: true, available: availableTiers(DESKTOP), minScale: MIN_SCALE, mobile: false, held });
}

function run(g: DetailGovernor, seconds: number, trace: Trace): GovernorDecision[] {
  const decisions: GovernorDecision[] = [];
  play(seconds, trace, (dt) => {
    const d = g.sample(dt, null, 1 / 60);
    if (d) decisions.push(d);
  });
  return decisions;
}

test('the explorer: nothing changes while a budget is held, whatever the frames', () => {
  const b = budget();
  const g = detail(b.held);
  run(g, 3, steady(60, 0.5));
  b.take();
  expect(run(g, 120, constant(45))).toEqual([]);
  expect(g.tier).toBe('high');
  expect(g.scale).toBe(1);
  b.release();
  // Released, slow frames are judged again: the scale comes down first.
  const after = run(g, 3, constant(45));
  expect(after.length).toBeGreaterThan(0);
  expect(after[0]?.reason).toBe('slow');
});

test('the explorer: a try upward in flight when the budget is taken is neither failed nor locked by the model’s load', () => {
  const b = budget();
  const g = detail(b.held, 'medium');
  // Comfortable until it tries High; the budget is taken in the very next frame.
  const frame = steady(60, 0.5);
  let elapsed = 0;
  let tried = false;
  while (!tried && elapsed < GOVERNOR.tierUpAfter * 3) {
    const dt = frame(elapsed);
    elapsed += dt;
    tried = g.sample(dt, null, 1 / 60)?.reason === 'probe';
  }
  expect(tried).toBe(true);
  expect(g.tier).toBe('high');
  b.take();
  // The model's load makes every frame slow; held, none of it counts against the try.
  expect(run(g, 60, constant(45))).toEqual([]);
  b.release();
  // Frames are comfortable again: the try holds and High stays, with no failure recorded.
  const after = run(g, 30, steady(60, 0.5));
  expect(after.filter((d) => d.reason === 'probe-failed')).toEqual([]);
  expect(g.tier).toBe('high');
});

test('two budgets: the governors stay held until the last is released', () => {
  const b = budget();
  const governor = createQualityGovernor(QUALITY_PROFILES.high, { enabled: true, held: b.held });
  governor.suspend();
  governor.holdOff();
  play(5, steady(60, 1), (dt) => governor.sample(dt));
  b.take();
  b.take();
  b.release();
  let drops = 0;
  play(30, constant(40), (dt) => {
    if (governor.sample(dt)) drops += 1;
  });
  expect(drops).toBe(0);
  b.release();
  play(10, constant(40), (dt) => {
    if (governor.sample(dt)) drops += 1;
  });
  expect(drops).toBeGreaterThan(0);
});
