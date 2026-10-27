/**
 * The stars around the Sun (public/assets/stars/neighbourhood.json, from scripts/stars/neighbourhood.py):
 * their places in space from Hipparcos parallaxes, their brightness and colour, names, and the known
 * planets around them. Pure: parse the file, place the stars, find one by name.
 *
 * A star is placed (given a point in space) only where its parallax is known to within a fifth
 * (parallax over its error at least 5); the others stay directions on the sky. Distances are 1000 /
 * parallax (mas) parsecs, with the parallax's own uncertainty carried for the readout.
 */

import { skyDirection } from '../sky';

/** km per parsec (IAU 2015 Resolution B2: 648000 / pi au of 149,597,870.7 km). */
export const KM_PER_PC = (648_000 / Math.PI) * 149_597_870.7;
/** Light years per parsec (Julian years of 365.25 days). */
export const LY_PER_PC = KM_PER_PC / (299_792.458 * 86_400 * 365.25);
/** A parallax this many times its error places a star in space. */
const PLACED_SIGNIFICANCE = 5;

export interface NeighbourhoodFile {
  fields: string[];
  /** The last field: where the parallax is from when it is not the star's own (a close companion's, "HIP n", or a cited source's id), else null. */
  stars: Array<[number, number | null, string | null, number, number, number, number, number, number | null, string | null, string | null]>;
  systems: PlanetSystem[];
}

export interface Planet {
  name: string;
  aAu: number | null;
  aCalculated: boolean;
  periodDays: number | null;
  eccentricity: number | null;
  inclinationDeg: number | null;
  radiusEarth: number | null;
  radiusCalculated: boolean;
  massEarth: number | null;
  massCalculated: boolean;
  /** "Mass", "Msini" (a lower limit) or "Msin(i)/sin(i)". */
  massKind: string | null;
  eqTempK: number | null;
  method: string | null;
  year: number | null;
}

export interface PlanetSystem {
  host: string;
  hip: number | null;
  raDeg: number | null;
  decDeg: number | null;
  distPc: number | null;
  stars: number;
  spType: string | null;
  teffK: number | null;
  radiusSun: number | null;
  massSun: number | null;
  logLumSun: number | null;
  planets: Planet[];
}

export interface Star {
  /** Index in the list; -1 for the Sun. */
  index: number;
  hip: number | null;
  hr: number | null;
  /** The IAU's name, else the planet host's catalogue name, else null. */
  name: string | null;
  raDeg: number;
  decDeg: number;
  plxMas: number;
  ePlxMas: number;
  /** Where the parallax is from when not the star's own Hipparcos one (a close companion's, "HIP n", or a cited source's id). */
  plxFrom: string | null;
  vmag: number;
  bv: number | null;
  spType: string | null;
  /** Distance (pc) and its place (render frame, pc from the Sun), or null where not placed. */
  distPc: number | null;
  position: [number, number, number] | null;
  absoluteV: number | null;
  system: PlanetSystem | null;
}

export interface Neighbours {
  readonly stars: readonly Star[];
  readonly sun: Star;
  /** Stars and hosts by a name, HIP or HR number, case and spaces ignored (at most `limit`). */
  search(text: string, limit?: number): Star[];
  /** The placed stars nearest a point (render frame, pc), nearest first. */
  nearest(point: readonly [number, number, number], count: number): Star[];
}

const normalise = (text: string): string => text.toLowerCase().replace(/[\s'’.-]/gu, '');

/** The Sun as a star: its absolute visual magnitude and B-V colour (data/constants.json). */
export interface SunFigures {
  absoluteV: number;
  bv: number;
}

export function readNeighbours(file: NeighbourhoodFile, obliquity: number, sunFigures: SunFigures): Neighbours {
  const byHip = new Map<number, PlanetSystem>();
  for (const s of file.systems) if (s.hip !== null) byHip.set(s.hip, s);
  const direction = [0, 0, 0];
  const stars: Star[] = file.stars.map(([hip, hr, name, raDeg, decDeg, plxMas, ePlxMas, vmag, bv, spType, plxFrom], index) => {
    const placed = plxMas > 0 && plxMas / Math.max(ePlxMas, 1e-9) >= PLACED_SIGNIFICANCE;
    const distPc = placed ? 1000 / plxMas : null;
    skyDirection(raDeg, decDeg, obliquity, direction);
    const system = byHip.get(hip) ?? null;
    return {
      index,
      hip,
      hr,
      name: name ?? system?.host ?? null,
      raDeg,
      decDeg,
      plxMas,
      ePlxMas,
      plxFrom: plxFrom ?? null,
      vmag,
      bv,
      spType,
      distPc,
      position: distPc === null ? null : [(direction[0] ?? 0) * distPc, (direction[1] ?? 0) * distPc, (direction[2] ?? 0) * distPc],
      absoluteV: distPc === null ? null : vmag - 5 * Math.log10(distPc / 10),
      system,
    };
  });
  const sun: Star = { index: -1, hip: null, hr: null, name: 'Sun', raDeg: 0, decDeg: 0, plxMas: Number.POSITIVE_INFINITY, ePlxMas: 0, plxFrom: null, vmag: sunFigures.absoluteV, bv: sunFigures.bv, spType: 'G2V', distPc: 0, position: [0, 0, 0], absoluteV: sunFigures.absoluteV, system: null };
  const keyed = stars.map((s) => ({ s, keys: [s.name, s.system?.host, s.hip === null ? null : `hip${s.hip}`, s.hr === null ? null : `hr${s.hr}`].filter((k): k is string => k !== null && k !== undefined).map(normalise) }));
  return {
    stars,
    sun,
    search(text, limit = 12) {
      const q = normalise(text);
      if (q === '') return [];
      if ('sun'.startsWith(q)) return [sun];
      const starts = keyed.filter((k) => k.keys.some((key) => key.startsWith(q))).map((k) => k.s);
      const within = keyed.filter((k) => !starts.includes(k.s) && k.keys.some((key) => key.includes(q))).map((k) => k.s);
      // Placed (and nearer) first: the places one can go.
      const order = (a: Star, b: Star): number => (a.distPc ?? Infinity) - (b.distPc ?? Infinity);
      return [...starts.sort(order), ...within.sort(order)].slice(0, limit);
    },
    nearest(point, count) {
      const d = (s: Star): number => (s.position ? Math.hypot(s.position[0] - point[0], s.position[1] - point[1], s.position[2] - point[2]) : Infinity);
      return [sun, ...stars].filter((s) => s.position).sort((a, b) => d(a) - d(b)).slice(0, count);
    },
  };
}
