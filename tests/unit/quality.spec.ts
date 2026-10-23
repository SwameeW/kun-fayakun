/**
 * The tier governor (src/core/quality.ts) on synthetic frame-time traces, without a browser.
 * The engine creates it suspended and calls holdOff() once a chapter is entered; so do these.
 */
import { expect, test } from '@playwright/test';
import { createQualityGovernor, type QualityGovernor } from '../../src/core/quality';
import { QUALITY_PROFILES, type QualityTier } from '../../src/core/types';
import { constant, play, steady, type Trace } from '../support/frames';

function entered(tier: QualityTier = 'high'): QualityGovernor {
  const governor = createQualityGovernor(QUALITY_PROFILES[tier], { enabled: true });
  governor.suspend();
  governor.holdOff();
  return governor;
}

/** Plays a trace and returns each tier drop with the time it happened. */
function run(governor: QualityGovernor, seconds: number, trace: Trace): Array<{ tier: QualityTier; at: number }> {
  const drops: Array<{ tier: QualityTier; at: number }> = [];
  let elapsed = 0;
  play(seconds, trace, (dt) => {
    elapsed += dt;
    const lower = governor.sample(dt);
    if (lower) drops.push({ tier: lower.tier, at: elapsed });
  });
  return drops;
}

test('a steady 60 Hz display keeps its tier', () => {
  expect(run(entered(), 60, steady(60, 1))).toEqual([]);
});

test('a 30 Hz-capped rAF is not read as load and keeps its tier', () => {
  const governor = createQualityGovernor(QUALITY_PROFILES.high, { enabled: true });
  governor.suspend();
  // Loading frames on the capped display are 33 ms too.
  run(governor, 2, steady(30, 1.5));
  governor.holdOff();
  expect(run(governor, 60, steady(30, 1.5))).toEqual([]);
});

test('a single 400 ms hitch does not drop a tier', () => {
  const governor = entered();
  run(governor, 10, steady(60, 1));
  governor.sample(0.4);
  expect(run(governor, 20, steady(60, 1))).toEqual([]);
});

test('sustained 25 ms frames drop one tier at a time, then stop at low', () => {
  const drops = run(entered(), 30, constant(25));
  expect(drops.map((d) => d.tier)).toEqual(['mid', 'low']);
  // 3 s of grace, then 2 s of slow buckets; the drop restarts the grace.
  expect(drops[0]?.at ?? Infinity).toBeLessThan(6);
  expect(drops[1]?.at ?? Infinity).toBeLessThan(11);
});

test('a GPU that slows to 30 fps on a 60 Hz display still drops a tier', () => {
  const governor = entered();
  run(governor, 5, steady(60, 1));
  expect(run(governor, 5, steady(30, 1)).map((d) => d.tier)).toEqual(['mid']);
});

test('nothing drops while suspended (loading); holdOff resumes after a grace period', () => {
  const governor = entered();
  governor.suspend();
  expect(run(governor, 20, constant(25))).toEqual([]);
  governor.holdOff();
  expect(run(governor, 2.9, constant(25))).toEqual([]);
  expect(run(governor, 5, constant(25)).map((d) => d.tier)).toEqual(['mid']);
});

test('a disabled governor (?tier) never drops', () => {
  const governor = createQualityGovernor(QUALITY_PROFILES.high, { enabled: false });
  governor.holdOff();
  expect(run(governor, 30, constant(40))).toEqual([]);
});
