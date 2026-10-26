/**
 * The laboratory's integrator against an external reference (ledger SB-36): the solar-system seed
 * (tests/fixtures/rebound/solar-initial.json) integrated one Julian year by REBOUND 5.2.2's IAS15
 * (Rein and Spiegel 2015; scripts/rebound/run.py; only its numbers are used, never its GPL code),
 * pinned by the input's SHA-256. The laboratory's kick-drift-kick leapfrog at its own settings stays
 * within the bounds measured on 2026-10-26 (about 1.4 times what it showed then: Mercury 4,368 km off
 * after a year, Venus 602, the Earth 179, the Moon 908 about the Earth, Mars 33, the giants under a
 * kilometre), and a five times finer step cuts the error about 25 times: second order, as a leapfrog is.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DEFAULT_INTEGRATOR, Engine, ENGINE_VERSION, SCHEMA_VERSION, type BodySpec, type IntegratorSettings } from '../../src/sim/engine';
import { step } from '../../src/sim/nbody';

const ROOT = new URL('../../', import.meta.url);
const raw = readFileSync(new URL('tests/fixtures/rebound/solar-initial.json', ROOT));
const initial = JSON.parse(new TextDecoder().decode(raw)) as { epochJdTdb: number; bodies: Array<{ id: string; gm: number; radiusKm: number; pos: [number, number, number]; vel: [number, number, number] }> };
const reference = JSON.parse(readFileSync(new URL('tests/fixtures/rebound/solar-1yr.json', ROOT), 'utf8')) as { rebound: string; integrator: string; inputSha256: string; tS: number; relativeEnergyError: number; bodies: Array<{ id: string; pos: [number, number, number] }> };

/** Each body's distance (km) from REBOUND's place for it after the year, with the laboratory's integrator at these settings. */
function errors(settings: IntegratorSettings): Record<string, number> {
  const bodies: BodySpec[] = initial.bodies.map((b) => ({ ...b, name: b.id, origin: 'modelled', sourceIds: [] }));
  const e = new Engine({ schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, name: 'reference', epochJdTdb: initial.epochJdTdb, frame: 'test', seedNote: 'test', integrator: { ...settings }, bodies, log: [] });
  e.advanceTo(reference.tS, 10_000_000);
  // The last part step, so both stand at the same instant.
  const rest = reference.tS - e.state.t;
  if (rest > 0) step(e.state, rest, [], []);
  const out: Record<string, number> = {};
  for (const b of reference.bodies) {
    const i = e.state.ids.indexOf(b.id);
    out[b.id] = Math.hypot((e.state.pos[i * 3] ?? 0) - b.pos[0], (e.state.pos[i * 3 + 1] ?? 0) - b.pos[1], (e.state.pos[i * 3 + 2] ?? 0) - b.pos[2]);
  }
  return out;
}

test('the reference is the one pinned: REBOUND 5.2.2, IAS15, this input, energy kept to machine precision', () => {
  expect(reference.rebound).toBe('5.2.2');
  expect(reference.integrator).toBe('ias15');
  expect(createHash('sha256').update(raw).digest('hex')).toBe(reference.inputSha256);
  expect(reference.tS).toBe(365.25 * 86_400);
  expect(reference.relativeEnergyError).toBeLessThan(1e-13);
});

test('a year of the solar system: within the measured bounds of REBOUND’s answer, converging as the step squared', () => {
  const coarse = errors(DEFAULT_INTEGRATOR);
  const bounds: Record<string, number> = { mercury: 6100, venus: 850, earth: 250, moon: 1300, mars: 46, jupiter: 0.33, saturn: 0.048, uranus: 0.0038, neptune: 0.00083, sun: 0.0017 };
  expect(Object.entries(bounds).filter(([id, km]) => !((coarse[id] ?? Infinity) < km)).map(([id]) => `${id}: ${coarse[id] ?? NaN} km`)).toEqual([]);
  const fine = errors({ ...DEFAULT_INTEGRATOR, eta: DEFAULT_INTEGRATOR.eta / 5 });
  // Second order: five times finer, about 25 times closer (where the error is well above rounding).
  expect(['mercury', 'venus', 'earth', 'moon', 'mars'].filter((id) => !((coarse[id] ?? 0) / (fine[id] ?? 1) > 15))).toEqual([]);
});
