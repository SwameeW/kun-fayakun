/**
 * The explorer's quality governance (src/explore/quality.ts) on synthetic frame-time traces, without
 * a browser: where it starts, what Ultra needs, and how the governor trades render scale and then
 * whole tiers for smooth frames without ever swinging back and forth.
 */
import { expect, test } from '@playwright/test';
import { DETAIL, EXPLORE_TIERS, type ExploreTier } from '../../src/explore/detail';
import {
  availableTiers,
  createDetailGovernor,
  GOVERNOR,
  initialTier,
  ultraAllowed,
  type DetailChoice,
  type DetailGovernor,
  type DeviceInfo,
  type GovernorDecision,
} from '../../src/explore/quality';
import { constant, steady, type Trace } from '../support/frames';

const MIN_SCALE = Object.fromEntries(EXPLORE_TIERS.map((t) => [t, DETAIL[t].minRenderScale])) as Record<ExploreTier, number>;
const DESKTOP: DeviceInfo = { backend: 'webgpu', description: 'apple metal-3 apple m5 pro', software: false, mobile: false, maxTextureSize: 16_384 };

function governor(options: { tier?: ExploreTier; choice?: DetailChoice; mobile?: boolean; available?: readonly ExploreTier[]; enabled?: boolean } = {}): DetailGovernor {
  return createDetailGovernor({
    tier: options.tier ?? 'high',
    choice: options.choice ?? 'auto',
    enabled: options.enabled ?? true,
    available: options.available ?? availableTiers(DESKTOP),
    minScale: MIN_SCALE,
    mobile: options.mobile ?? false,
  });
}

interface Change {
  at: number;
  tier: ExploreTier;
  scale: number;
  reason: GovernorDecision['reason'];
  tierChanged: boolean;
}

/**
 * Plays `seconds` of frames. The trace gets the governor's current tier and scale, so a load can
 * depend on them (a GPU-bound scene costs less at a lower tier or scale). Returns every change.
 */
function run(
  g: DetailGovernor,
  seconds: number,
  frame: (state: { tier: ExploreTier; scale: number; t: number }) => { seconds: number; gpuMs?: number | null },
  start = 0,
): Change[] {
  const changes: Change[] = [];
  let t = start;
  while (t < start + seconds) {
    const before = g.tier;
    const f = frame({ tier: g.tier, scale: g.scale, t });
    const d = g.sample(f.seconds, f.gpuMs ?? null);
    t += f.seconds;
    if (d) changes.push({ at: t, tier: g.tier, scale: g.scale, reason: d.reason, tierChanged: g.tier !== before });
  }
  return changes;
}

const trace = (tr: Trace) => () => ({ seconds: tr(0) });

test('the starting tier follows what the device says, and is never Ultra', () => {
  const cases: Array<[Partial<DeviceInfo>, ExploreTier]> = [
    [{}, 'high'],
    [{ mobile: true, description: 'qualcomm adreno 730' }, 'low'],
    [{ mobile: true, description: 'apple apple-gpu' }, 'medium'],
    [{ mobile: true, backend: 'webgl2', description: 'apple gpu' }, 'low'],
    [{ description: '' }, 'medium'],
    [{ description: '   ' }, 'medium'],
    [{ backend: 'webgl2', description: 'angle (apple, angle metal renderer: apple m5 pro)' }, 'medium'],
    [{ description: 'intel iris xe graphics' }, 'medium'],
    [{ description: 'nvidia geforce rtx 3060 laptop gpu' }, 'high'],
    [{ software: true, description: 'google swiftshader' }, 'low'],
  ];
  for (const [patch, tier] of cases) {
    const device = { ...DESKTOP, ...patch };
    expect(initialTier(device), JSON.stringify(patch)).toBe(tier);
    expect(initialTier(device)).not.toBe('ultra');
  }
});

test('Ultra is offered only on non-software, non-mobile WebGPU with 8192 px textures', () => {
  expect(ultraAllowed(DESKTOP)).toBe(true);
  expect(availableTiers(DESKTOP)).toEqual(['ultra', 'high', 'medium', 'low']);
  for (const patch of [{ backend: 'webgl2' as const }, { software: true }, { mobile: true }, { maxTextureSize: 4096 }, { maxTextureSize: 0 }]) {
    const device = { ...DESKTOP, ...patch };
    expect(ultraAllowed(device), JSON.stringify(patch)).toBe(false);
    expect(availableTiers(device)).toEqual(['high', 'medium', 'low']);
  }
});

test('a 30 Hz-capped display is not read as load: the tier and scale stay (frame times and GPU times alike)', () => {
  const byFrames = governor();
  expect(run(byFrames, 120, trace(steady(30, 1.5)))).toEqual([]);
  expect(byFrames.scale).toBe(1);
  const byGpu = governor();
  expect(run(byGpu, 120, () => ({ seconds: 1 / 30, gpuMs: 8 }))).toEqual([]);
});

test('a single hitch costs nothing: neither a long frame nor a stall', () => {
  const g = governor();
  run(g, 10, trace(steady(60, 1)));
  expect(g.sample(0.18)).toBeNull();
  expect(run(g, 10, trace(steady(60, 1)), 10)).toEqual([]);
  expect(g.sample(0.4)).toBeNull();
  expect(run(g, 10, trace(steady(60, 1)), 20)).toEqual([]);
  // Even a burst of slow frames inside one bucket: the median is unmoved.
  for (let i = 0; i < 8; i++) g.sample(0.05);
  expect(run(g, 10, trace(steady(60, 1)), 30)).toEqual([]);
  expect(g.tier).toBe('high');
  expect(g.scale).toBe(1);
});

test('sustained 25 ms frames lower the render scale to the floor within 6 s, and only then the tier', () => {
  const g = governor();
  const changes = run(g, 30, trace(constant(25)));
  const firstTier = changes.findIndex((c) => c.tierChanged);
  expect(firstTier).toBeGreaterThan(0);
  const before = changes.slice(0, firstTier);
  // Every change before the tier drop lowered the scale, ending at High's floor, within 6 s.
  expect(before.every((c) => c.tier === 'high' && c.reason === 'slow')).toBe(true);
  const floor = before.find((c) => c.scale <= MIN_SCALE.high + 1e-9);
  expect(floor).toBeDefined();
  expect(floor?.at ?? Infinity).toBeLessThan(6);
  expect(changes[firstTier]?.tier).toBe('medium');
  // And on down, one tier at a time, never below Low.
  expect(changes.filter((c) => c.tierChanged).map((c) => c.tier)).toEqual(['medium', 'low']);
  expect(g.scale).toBeCloseTo(MIN_SCALE.low, 6);
});

test('no oscillation over 10 simulated minutes near the edge of what the GPU manages', () => {
  // A GPU-bound scene: cost grows with the pixels drawn (scale squared) and with the tier. High at
  // full resolution is a little too slow for 60 Hz, Medium fits easily: the governor must settle.
  const cost: Record<ExploreTier, number> = { ultra: 28, high: 18.5, medium: 11, low: 7 };
  const jitter = steady(60, 0.8, 7);
  const frame = ({ tier, scale }: { tier: ExploreTier; scale: number }) => {
    const gpu = cost[tier] * (0.25 + 0.75 * scale * scale);
    return { seconds: Math.max(1 / 60, gpu / 1000) + (jitter(0) - 1 / 60) };
  };
  const g = governor();
  const changes = run(g, 600, frame);
  const tierChanges = changes.filter((c) => c.tierChanged);
  // At most one drop (and no climbing back and failing again and again).
  expect(tierChanges.length).toBeLessThanOrEqual(2);
  // Failed tries upward back off: few changes at all, and almost none in the last five minutes.
  expect(changes.length).toBeLessThanOrEqual(16);
  expect(changes.filter((c) => c.at > 300).length).toBeLessThanOrEqual(3);
  // It ends somewhere that runs at the display's rate.
  const last = frame({ tier: g.tier, scale: g.scale });
  expect(last.seconds).toBeLessThan((1 / 60) * GOVERNOR.slowFrame);
});

test('the visitor’s choice is kept: the tier never changes, only the internal resolution', () => {
  const g = governor({ tier: 'high' });
  const choose = g.choose('ultra');
  expect(choose?.tier).toBe('ultra');
  const changes = run(g, 120, trace(constant(25)));
  expect(changes.every((c) => !c.tierChanged)).toBe(true);
  expect(g.tier).toBe('ultra');
  expect(g.scale).toBeCloseTo(MIN_SCALE.ultra, 6);
  // Back to Auto, the governor may act again (and starts from full resolution).
  const auto = g.choose('auto');
  expect(auto?.scale).toBe(1);
  expect(run(g, 60, trace(constant(25))).some((c) => c.tierChanged)).toBe(true);
});

test('judged against the display rate the engine learned, a GPU slow from the first explorer frame is still seen as slow', () => {
  // 40 ms frames from the start would teach a fresh cadence "30 Hz"; the engine knows the display runs at 60.
  const own = governor();
  expect(run(own, 30, trace(constant(40)))).toEqual([]);
  const told = governor();
  let t = 0;
  const changes: GovernorDecision[] = [];
  while (t < 30) {
    const d = told.sample(0.04, null, 1 / 60);
    if (d) changes.push(d);
    t += 0.04;
  }
  expect(changes.length).toBeGreaterThan(0);
  expect(told.tier).not.toBe('high');
});

test('a tier the device cannot run is refused (Ultra on a phone)', () => {
  const g = governor({ tier: 'low', mobile: true, available: ['high', 'medium', 'low'] });
  expect(g.choose('ultra')).toBeNull();
  expect(g.tier).toBe('low');
});

test('after 20 s stable it tries the tier above (never Ultra); a try that runs slow is undone and locked for at least 20 s', () => {
  const g = governor({ tier: 'medium' });
  // Comfortable at Medium, too slow at High.
  const frame = ({ tier }: { tier: ExploreTier }) => ({ seconds: tier === 'high' ? 0.024 : 1 / 60 });
  const changes = run(g, 200, frame);
  const tries = changes.filter((c) => c.reason === 'probe');
  const undone = changes.filter((c) => c.reason === 'probe-failed');
  expect(tries.length).toBeGreaterThanOrEqual(1);
  expect(tries[0]?.at ?? 0).toBeGreaterThanOrEqual(GOVERNOR.tierUpAfter);
  expect(tries.every((c) => c.tier === 'high')).toBe(true);
  expect(undone.length).toBe(tries.length);
  for (let i = 1; i < tries.length; i++) {
    const gap = (tries[i]?.at ?? 0) - (undone[i - 1]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(GOVERNOR.lockSeconds);
  }
  // Each failure doubles the wait: over 200 s only a few tries.
  expect(tries.length).toBeLessThanOrEqual(4);
  expect(g.tier).toBe('medium');

  // A device with room to spare climbs to High and stays, and Auto never reaches Ultra.
  const roomy = governor({ tier: 'medium' });
  run(roomy, 300, trace(steady(60, 0.5)));
  expect(roomy.tier).toBe('high');
});

test('with GPU timings it tries upward only where the tier above should fit', () => {
  const tight = governor({ tier: 'medium' });
  // 10 ms of GPU work in a 16.7 ms frame: comfortable, but a tier above would not fit.
  expect(run(tight, 120, () => ({ seconds: 1 / 60, gpuMs: 10 })).filter((c) => c.reason === 'probe')).toEqual([]);
  const roomy = governor({ tier: 'medium' });
  const changes = run(roomy, 120, () => ({ seconds: 1 / 60, gpuMs: 4 }));
  expect(changes.filter((c) => c.reason === 'probe').length).toBe(1);
  expect(roomy.tier).toBe('high');
});

test('nothing is judged for 2 s after a tier change or a texture upload (holdOff)', () => {
  const g = governor();
  run(g, 5, trace(steady(60, 1)));
  g.holdOff();
  expect(run(g, GOVERNOR.holdOffSeconds - 0.05, trace(constant(40)), 5)).toEqual([]);
  expect(run(g, 3, trace(constant(40)), 7).length).toBeGreaterThan(0);
});

test('a phone that slows after a long steady spell is read as heat: it steps down and does not try upward for minutes', () => {
  // Medium is this phone's best (High is not offered), so nothing interrupts a steady minute; then it heats up.
  const g = governor({ tier: 'medium', mobile: true, available: ['medium', 'low'] });
  const frame = ({ tier, scale, t }: { tier: ExploreTier; scale: number; t: number }) => {
    const base = tier === 'medium' ? 15 : 6;
    const ms = t > 60 ? base * 2.5 * (0.3 + 0.7 * scale * scale) : base;
    return { seconds: Math.max(1 / 60, ms / 1000) };
  };
  const changes = run(g, 400, frame);
  const drop = changes.find((c) => c.tierChanged && c.tier === 'low');
  expect(drop).toBeDefined();
  expect(drop?.at ?? 0).toBeGreaterThan(60);
  // Cooler at Low, it would fit Medium again at once, yet it waits out the heat lock before trying.
  const tries = changes.filter((c) => c.at > (drop?.at ?? 0) && c.reason === 'probe');
  expect(tries.every((c) => c.at - (drop?.at ?? 0) >= GOVERNOR.thermalLockSeconds)).toBe(true);

  // A desktop does the same drop but tries again after the ordinary 20 s.
  const desk = governor({ tier: 'medium', available: ['medium', 'low'] });
  const deskChanges = run(desk, 400, frame);
  const deskDrop = deskChanges.find((c) => c.tierChanged && c.tier === 'low');
  expect(deskDrop).toBeDefined();
  expect(deskChanges.some((c) => c.reason === 'probe' && c.at - (deskDrop?.at ?? 0) < GOVERNOR.thermalLockSeconds)).toBe(true);
});

test('a governor held by the address (?detail, ?tier, ?profile) never changes anything', () => {
  const g = governor({ enabled: false });
  expect(run(g, 60, trace(constant(45)))).toEqual([]);
  expect(g.tier).toBe('high');
  expect(g.scale).toBe(1);
});
