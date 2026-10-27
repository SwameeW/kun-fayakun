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
 * The disc's axis: tilted from the line of sight to the Sun by the inclination the file gives (each
 * marked as measured or illustrative), toward the sky's north, so arriving from the Sun's side shows
 * it as it is seen from the Earth.
 */

type V3 = [number, number, number];

export interface BlackHoleFile {
  blackHoles: Array<{
    id: string;
    name: string;
    kind: 'supermassive' | 'stellar';
    model: 'thin-disc' | 'hot-ring' | 'dormant';
    raDeg: number;
    decDeg: number;
    mass: { value: number; minus: number; plus: number; source: string; how: string; alsoSource?: string; low?: number };
    distance: { pc: number; minus: number | null; plus: number | null; source: string; how: string };
    redshift?: number;
    lookbackGyr?: number;
    observation?: { ringMicroArcsec: number; error: number; source: string };
    companion?: { kind: string; periodDays: number };
    inclinationDeg?: number;
    inclinationNote?: string;
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
  inclinationNote: string | null;
  /** The Schwarzschild radius of the mass drawn (pc, km). */
  rsPc: number;
  rsKm: number;
  /** Its disc's axis (render frame), for the models that have gas. */
  axis: V3;
}

export function readBlackHoles(file: BlackHoleFile, obliquity: number): BlackHole[] {
  const north = skyDirection(0, 90, obliquity, [0, 0, 0]) as V3;
  return file.blackHoles.map((h) => {
    const dir = skyDirection(h.raDeg, h.decDeg, obliquity, [0, 0, 0]) as V3;
    const position: V3 = [dir[0] * h.distance.pc, dir[1] * h.distance.pc, dir[2] * h.distance.pc];
    // Toward the Sun from it, and the sky's north square to that.
    const los: V3 = [-dir[0], -dir[1], -dir[2]];
    const k = north[0] * los[0] + north[1] * los[1] + north[2] * los[2];
    const up: V3 = [north[0] - k * los[0], north[1] - k * los[1], north[2] - k * los[2]];
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
      inclinationNote: h.inclinationNote ?? null,
      rsPc: schwarzschildPc(h.mass.value),
      rsKm: h.schwarzschildKm,
      axis,
    };
  });
}
