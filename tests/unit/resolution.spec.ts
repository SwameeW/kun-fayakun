/**
 * The dynamic-resolution governor (src/core/resolution.ts) on synthetic frame-time traces.
 * The governor is pure, so these run without a browser; the traces are what rAF reports.
 */
import { expect, test } from '@playwright/test';
import { createResolutionGovernor, MIN_RESOLUTION_SCALE, type ResolutionGovernor } from '../../src/core/resolution';
import { constant, play, steady, type Trace } from '../support/frames';

/** Plays a trace and returns the lowest scale reached and when the floor was first hit. */
function run(governor: ResolutionGovernor, seconds: number, trace: Trace): { lowest: number; floorAt: number | null } {
  let lowest = governor.scale;
  let floorAt: number | null = null;
  play(
    seconds,
    trace,
    (dt) => governor.sample(dt),
    (elapsed) => {
      lowest = Math.min(lowest, governor.scale);
      if (floorAt === null && governor.scale <= MIN_RESOLUTION_SCALE) floorAt = elapsed;
    },
  );
  return { lowest, floorAt };
}

test('a steady 60 Hz display keeps full resolution', () => {
  const governor = createResolutionGovernor({ enabled: true });
  expect(run(governor, 60, steady(60, 1)).lowest).toBe(1);
});

test('a 30 Hz-capped rAF is not read as load and keeps full resolution', () => {
  // Low Power Mode or a battery saver: steady 33 ms frames, whatever the scene costs.
  const governor = createResolutionGovernor({ enabled: true });
  expect(run(governor, 60, steady(30, 1.5)).lowest).toBe(1);
});

test('a single 400 ms hitch costs no resolution', () => {
  const governor = createResolutionGovernor({ enabled: true });
  run(governor, 10, steady(60, 1));
  governor.sample(0.4);
  expect(run(governor, 20, steady(60, 1)).lowest).toBe(1);
});

test('hitches shorter than a stall, spaced out, cost no resolution', () => {
  const governor = createResolutionGovernor({ enabled: true });
  run(governor, 10, steady(60, 1));
  for (let i = 0; i < 5; i++) {
    governor.sample(0.26);
    run(governor, 5, steady(60, 1));
  }
  expect(governor.scale).toBe(1);
});

test('sustained 25 ms frames step down to the floor and stop there', () => {
  const governor = createResolutionGovernor({ enabled: true });
  // 3 s hold-off, then a 0.88 step each 1.5 s: four steps reach 0.6.
  const { lowest, floorAt } = run(governor, 30, constant(25));
  expect(floorAt).not.toBeNull();
  expect(floorAt ?? Infinity).toBeLessThan(10);
  expect(lowest).toBeCloseTo(MIN_RESOLUTION_SCALE, 6);
});

test('a GPU that slows to 30 fps on a 60 Hz display still steps down', () => {
  // The display showed 60 Hz first (home screen, loading), so 33 ms frames are load, not a cap.
  const governor = createResolutionGovernor({ enabled: true });
  run(governor, 5, steady(60, 1));
  expect(run(governor, 10, steady(30, 1)).lowest).toBeLessThan(1);
});

test('after a slow spell, comfortable frames bring the scale back up', () => {
  const governor = createResolutionGovernor({ enabled: true });
  run(governor, 3, constant(25));
  const dropped = run(governor, 3, constant(25)).lowest;
  expect(dropped).toBeLessThan(1);
  run(governor, 60, steady(60, 0.5));
  expect(governor.scale).toBeGreaterThan(dropped);
});

test('holdOff ignores slow frames for the next few seconds', () => {
  const governor = createResolutionGovernor({ enabled: true });
  run(governor, 10, steady(60, 1));
  governor.holdOff();
  expect(run(governor, 2.9, constant(25)).lowest).toBe(1);
  expect(run(governor, 5, constant(25)).lowest).toBeLessThan(1);
});

test('a disabled governor (?tier or ?profile) never changes the scale', () => {
  const governor = createResolutionGovernor({ enabled: false });
  expect(run(governor, 30, constant(40)).lowest).toBe(1);
});

test('the floor is 0.6, which the renderer clamps to as well', () => {
  expect(MIN_RESOLUTION_SCALE).toBe(0.6);
});
