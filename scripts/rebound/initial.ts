/**
 * Writes the orbital laboratory's solar-system seed (src/sim/seed, at a fixed epoch) as point masses
 * for the REBOUND reference run (scripts/rebound/run.py): ids, GM (km^3 s^-2), positions (km) and
 * velocities (km/s) in the scenario's frame. Run: node --import tsx scripts/rebound/initial.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createEphemeris, type MoonFile, type PlanetsFile } from '../../src/astro/ephemeris';
import type { PhysicalFile } from '../../src/astro/physical';
import { seedSolarSystem } from '../../src/sim/seed';

const ROOT = new URL('../../', import.meta.url);
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const physical = readJson('public/assets/jpl/physical.json') as PhysicalFile;
const eph = createEphemeris(readJson('public/assets/jpl/planets.json') as PlanetsFile, readJson('public/assets/jpl/moon.json') as MoonFile, physical);
const EPOCH = 2_461_336.75;
const scenario = seedSolarSystem(eph, physical, EPOCH);
const out = { epochJdTdb: scenario.epochJdTdb, frame: scenario.frame, bodies: scenario.bodies.map((b) => ({ id: b.id, gm: b.gm, radiusKm: b.radiusKm, pos: b.pos, vel: b.vel })) };
writeFileSync(new URL('tests/fixtures/rebound/solar-initial.json', ROOT), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.bodies.length} bodies at JD ${out.epochJdTdb}`);
