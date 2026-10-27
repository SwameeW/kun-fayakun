import { skyDirection } from '../sky';
import { schwarzschildPc } from './lens';

/**
 * The black holes one can fly to (public/assets/stars/black-holes.json, from
 * scripts/stars/black_holes.py): each where SIMBAD places it on the sky at its cited distance, with
 * its mass and the papers they come from, and the light model it is drawn with (./lens-view): a thin
 * disc of hot gas (TON 618, a quasar; Cygnus X-1, fed by its companion), a hot ring of thin gas round
 * the shadow (Sagittarius A* and M87*, as the Event Horizon Telescope's images show), or none
 * (Gaia BH1, BH2 and BH3, dormant). Pure.
 *
 * The disc's axis: tilted from the line of sight to the Sun by the inclination the file gives (the
 * explorer's messages say whether each is measured or illustrative, and how each mass and distance
 * was measured), so arriving from the Sun's side shows it as it is seen from the Earth; which way it
 * tilts on the sky is not measured: toward the sky's north, or, for a stellar hole in the galaxy's
 * disc, along the galaxy's plane, so the view of its disc from a little above has the Milky Way
 * behind it.
 */

type V3 = [number, number, number];

/** The galaxy's north pole (ICRS degrees; Hipparcos's definition, as ./beyond's). */
const GALACTIC_POLE = { raDeg: 192.85948, decDeg: 27.12825 } as const;

export interface BlackHoleFile {
  blackHoles: Array<{
    id: string;
    name: string;
    kind: 'supermassive' | 'stellar';
    model: 'thin-disc' | 'hot-ring' | 'dormant';
    raDeg: number;
    decDeg: number;
    mass: { value: number; minus: number; plus: number; source: string; alsoSource?: string; low?: number };
    distance: { pc: number; minus: number | null; plus: number | null; source: string };
    redshift?: number;
    lookbackGyr?: number;
    observation?: { ringMicroArcsec: number; error: number; source: string };
    companion?: { periodDays: number };
    inclinationDeg?: number;
    schwarzschildKm: number;
  }>;
}

export interface BlackHole {
  id: string;
  name: string;
  kind: 'supermassive' | 'stellar';
  model: 'thin-disc' | 'hot-ring' | 'dormant';
  /** Its place (pc from the Sun, render frame) and distance. */
  position: V3;
  distPc: number;
  mass: BlackHoleFile['blackHoles'][number]['mass'];
  distance: BlackHoleFile['blackHoles'][number]['distance'];
  redshift: number | null;
  /** Its light's travel time to us (billions of years), for a redshift. */
  lookbackGyr: number | null;
  observation: BlackHoleFile['blackHoles'][number]['observation'] | null;
  companion: BlackHoleFile['blackHoles'][number]['companion'] | null;
  inclinationDeg: number | null;
  /** The Schwarzschild radius of the mass drawn (pc, km). */
  rsPc: number;
  rsKm: number;
  /** Its disc's axis (render frame), for the models that have gas. */
  axis: V3;
}

export function readBlackHoles(file: BlackHoleFile, obliquity: number): BlackHole[] {
  const north = skyDirection(0, 90, obliquity, [0, 0, 0]) as V3;
  const pole = skyDirection(GALACTIC_POLE.raDeg, GALACTIC_POLE.decDeg, obliquity, [0, 0, 0]) as V3;
  return file.blackHoles.map((h) => {
    const dir = skyDirection(h.raDeg, h.decDeg, obliquity, [0, 0, 0]) as V3;
    const position: V3 = [dir[0] * h.distance.pc, dir[1] * h.distance.pc, dir[2] * h.distance.pc];
    // Toward the Sun from it, and square to that the sky's north (a stellar one's: along the galaxy's plane, its pole's cross with it).
    const los: V3 = [-dir[0], -dir[1], -dir[2]];
    const toward: V3 = h.kind === 'stellar' ? [pole[1] * los[2] - pole[2] * los[1], pole[2] * los[0] - pole[0] * los[2], pole[0] * los[1] - pole[1] * los[0]] : north;
    const k = toward[0] * los[0] + toward[1] * los[1] + toward[2] * los[2];
    const up: V3 = [toward[0] - k * los[0], toward[1] - k * los[1], toward[2] - k * los[2]];
    const l = Math.hypot(...up) || 1;
    const i = ((h.inclinationDeg ?? 60) * Math.PI) / 180;
    const axis: V3 = [Math.cos(i) * los[0] + (Math.sin(i) * up[0]) / l, Math.cos(i) * los[1] + (Math.sin(i) * up[1]) / l, Math.cos(i) * los[2] + (Math.sin(i) * up[2]) / l];
    return {
      id: h.id,
      name: h.name,
      kind: h.kind,
      model: h.model,
      position,
      distPc: h.distance.pc,
      mass: h.mass,
      distance: h.distance,
      redshift: h.redshift ?? null,
      lookbackGyr: h.lookbackGyr ?? null,
      observation: h.observation ?? null,
      companion: h.companion ?? null,
      inclinationDeg: h.inclinationDeg ?? null,
      rsPc: schwarzschildPc(h.mass.value),
      rsKm: h.schwarzschildKm,
      axis,
    };
  });
}
