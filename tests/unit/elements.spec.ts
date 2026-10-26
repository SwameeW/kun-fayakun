/**
 * Orbits as numbers (src/sim/elements): elements to state and back for every kind of orbit, the
 * textbook circular and escape cases, the Lagrange points as true equilibria of the turning frame
 * (and a Trojan at Jupiter's L4 that stays there for ten Jovian years in the engine), the Earth and
 * Moon's Roche limits, the Earth's breakup period, and the Moon seen from the Earth.
 */
import { expect, test } from '@playwright/test';
import { stateFrom, type BodySpec } from '../../src/sim/engine';
import { breakupPeriodS, elementsFromState, hillRadiusKm, lagrangePoints, LIGHT_KM_S, measure, orbitalFrame, rocheLimits, separation, stateFromElements, type Vec3 } from '../../src/sim/elements';
import { step, type ContactEvent } from '../../src/sim/nbody';

const MU_EARTH = 398_600.435;
const MU_SUN = 132_712_440_041.279;
const MU_JUPITER = 126_712_764.1;

test('elements to state and back, for ellipses at every inclination and orientation', () => {
  for (const [a, e, i, node, periapsisArg, trueAnomaly] of [
    [7000, 0.01, 0.9, 1.2, 2.1, 0.3],
    [42_164, 0.2, 0.05, 4.0, 0.5, 5.9],
    [384_400, 0.0549, 0.09, 2.2, 5.5, 3.1],
    [26_560, 0.7, 2.9, 0.1, 3.3, 1.7],
  ] as const) {
    const { r, v } = stateFromElements({ a, e, i, node, periapsisArg, trueAnomaly }, MU_EARTH);
    const back = elementsFromState(r, v, MU_EARTH);
    expect(back.a).toBeCloseTo(a, 4);
    expect(back.e).toBeCloseTo(e, 10);
    expect(back.i).toBeCloseTo(i, 10);
    expect(back.node).toBeCloseTo(node, 9);
    expect(back.periapsisArg).toBeCloseTo(periapsisArg, 8);
    expect(back.trueAnomaly).toBeCloseTo(trueAnomaly, 8);
    expect(back.periapsisKm).toBeCloseTo(a * (1 - e), 4);
    expect(back.apoapsisKm ?? 0).toBeCloseTo(a * (1 + e), 3);
    expect(back.periodS ?? 0).toBeCloseTo(2 * Math.PI * Math.sqrt(a ** 3 / MU_EARTH), 3);
  }
});

test('a circular orbit, and a body past escape speed (unbound: no period, no apoapsis)', () => {
  const r: Vec3 = [7000, 0, 0];
  const vc = Math.sqrt(MU_EARTH / 7000);
  const circ = elementsFromState(r, [0, vc, 0], MU_EARTH);
  expect(circ.e).toBeLessThan(1e-12);
  expect(circ.a).toBeCloseTo(7000, 6);
  expect(circ.i).toBe(0);
  expect(circ.bound).toBe(true);
  const fast = elementsFromState(r, [0, vc * Math.SQRT2 * 1.1, 0], MU_EARTH);
  expect(fast.bound).toBe(false);
  expect(fast.e).toBeGreaterThan(1);
  expect(fast.a).toBeLessThan(0);
  expect(fast.periodS).toBeNull();
  expect(fast.apoapsisKm).toBeNull();
  expect(fast.periapsisKm).toBeCloseTo(7000, 6);
  // Prograde, normal, radial: right-handed, prograde along the velocity, radial outward.
  const f = orbitalFrame(r, [0, vc, 0]);
  expect(f.prograde).toEqual([0, 1, 0]);
  expect(f.normal).toEqual([0, 0, 1]);
  expect(f.radial[0]).toBeCloseTo(1, 12);
});

test('the Lagrange points are equilibria of the frame turning with a circular pair (the Sun and Jupiter, the Earth and the Moon)', () => {
  for (const [m1, m2, R] of [
    [MU_SUN, MU_JUPITER, 778_479_000],
    [MU_EARTH, 4_902.8, 384_400],
  ] as const) {
    const v = Math.sqrt((m1 + m2) / R);
    // Barycentre at rest at the origin: the primary at -mu R, the secondary at (1 - mu) R.
    const mu = m2 / (m1 + m2);
    const primary = { gm: m1, pos: [-mu * R, 0, 0], vel: [0, -mu * v, 0] };
    const secondary = { gm: m2, pos: [(1 - mu) * R, 0, 0], vel: [0, (1 - mu) * v, 0] };
    const L = lagrangePoints(primary, secondary);
    const omega2 = (m1 + m2) / R ** 3;
    for (const p of [L.L1, L.L2, L.L3, L.L4, L.L5]) {
      const g = [0, 1, 2].map((k) => {
        const d1 = Math.hypot(p[0] - (primary.pos[0] ?? 0), p[1] - (primary.pos[1] ?? 0), p[2] - (primary.pos[2] ?? 0));
        const d2 = Math.hypot(p[0] - (secondary.pos[0] ?? 0), p[1] - (secondary.pos[1] ?? 0), p[2] - (secondary.pos[2] ?? 0));
        return (-m1 * ((p[k] ?? 0) - (primary.pos[k] ?? 0))) / d1 ** 3 - (m2 * ((p[k] ?? 0) - (secondary.pos[k] ?? 0))) / d2 ** 3 + omega2 * (k < 2 ? (p[k] ?? 0) : 0);
      });
      expect(Math.hypot(...g) / omega2 / R).toBeLessThan(1e-9);
    }
    // L1 and L2 straddle the secondary at about its Hill radius.
    const hill = hillRadiusKm(R, 0, m2, m1);
    expect(Math.abs((secondary.pos[0] ?? 0) - L.L1[0]) / hill).toBeCloseTo(1, 0);
    expect(Math.abs(L.L2[0] - (secondary.pos[0] ?? 0)) / hill).toBeCloseTo(1, 0);
  }
});

test('a Trojan placed at Jupiter’s L4 stays near it for ten Jovian years', () => {
  const R = 778_479_000;
  const v = Math.sqrt((MU_SUN + MU_JUPITER) / R);
  const mu = MU_JUPITER / (MU_SUN + MU_JUPITER);
  const sun = { gm: MU_SUN, pos: [-mu * R, 0, 0], vel: [0, -mu * v, 0] };
  const jupiter = { gm: MU_JUPITER, pos: [(1 - mu) * R, 0, 0], vel: [0, (1 - mu) * v, 0] };
  const L4 = lagrangePoints(sun, jupiter).L4;
  const omega = v / R;
  const spec = (id: string, gm: number, pos: readonly number[], vel: readonly number[], radiusKm: number): BodySpec => ({ id, name: id, gm, radiusKm, pos: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0], vel: [vel[0] ?? 0, vel[1] ?? 0, vel[2] ?? 0], origin: 'user-edited', sourceIds: [] });
  const s = stateFrom([spec('sun', MU_SUN, sun.pos, sun.vel, 695_700), spec('jupiter', MU_JUPITER, jupiter.pos, jupiter.vel, 69_911), spec('trojan', 0, L4, [-omega * L4[1], omega * L4[0], 0], 10)]);
  const acc: number[] = [];
  const events: ContactEvent[] = [];
  const dt = 86_400;
  const years = 10 * 11.862 * 365.25;
  let worst = 0;
  for (let k = 0; k < years; k += 1) {
    step(s, dt, acc, events);
    if (k % 30 === 0) {
      // The angle Sun-to-Trojan makes with Sun-to-Jupiter: 60 degrees at L4.
      const angle = (separation(s.pos.slice(0, 3), s.pos.slice(6, 9), s.pos.slice(3, 6)) * 180) / Math.PI;
      worst = Math.max(worst, Math.abs(angle - 60));
    }
  }
  expect(events).toEqual([]);
  expect(worst).toBeLessThan(5);
});

test('Roche limits, the breakup period and the Moon from the Earth', () => {
  // The Earth (5,514 kg/m^3) and the Moon (3,344): rigid about 9,500 km, fluid about 18,400 km.
  const roche = rocheLimits(6371, 5514, 3344);
  expect(roche.rigidKm).toBeCloseTo(9492, -2);
  expect(roche.fluidKm / 1000).toBeCloseTo(18.4, 1);
  // The Earth could spin once every 1.4 hours before its equator flew off.
  expect(breakupPeriodS(MU_EARTH, 6371) / 3600).toBeCloseTo(1.41, 2);
  // The Moon at 384,400 km: 1.28 light seconds, half a degree across.
  const m = measure([0, 0, 0], [384_400, 0, 0], 1737.4);
  expect(m.lightS).toBeCloseTo(384_400 / LIGHT_KM_S, 12);
  expect(m.lightS).toBeCloseTo(1.28, 2);
  expect((m.angularSize * 180) / Math.PI).toBeCloseTo(0.518, 3);
});
