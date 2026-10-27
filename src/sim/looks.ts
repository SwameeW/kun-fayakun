import type { ClimateState, StarLight } from './climate';
import { STAR_MIN_GM } from './climate';
import { bulkDensity, SOLID_MAX_GM } from './craters';

/**
 * What a body looks like, and where it came from (ledger IM-4; docs/LAB.md, "How experiments are
 * drawn"). Drawing only: nothing here changes a body's motion, so a run's state hashes are the same
 * with it or without it, and it is carried by the state's copies and replayed with the log (never
 * saved in a scenario file).
 *
 * The material is the preset's kind where there is one, otherwise read from the bulk density by the
 * classes of Carry (2012, Planetary and Space Science 73, 98): below 2,000 kg/m^3 ice and rock, 2,500 to
 * 4,000 rock, above 5,000 metal (for small bodies: the large worlds are dense because they are squeezed,
 * so a world with a climate in the model is rock). The albedo is a world's own (the fact sheet's Bond
 * albedo its climate reads) where its surface is what reflects (an airless world's, or Mars's thin
 * air); under a thick atmosphere the surface is rock, and so are its pieces. The rest, and the tints,
 * are illustrative: a grey near the Moon's for rock, a pale one for ice, a darker one for metal (the
 * M-type asteroids reflect 10 to 20 per cent).
 *
 * Pieces carry their parents' looks: a torn body's pieces and dust its own, a breakup's remnant and
 * debris the blend of the two bodies by mass (an Earth struck by a Mars sheds grey-brown rock).
 */

export type Material = 'rock' | 'ice' | 'metal' | 'gas' | 'star';

export interface Look {
  /** The share of light it reflects (0 to 1), its colour's tint (linear, its largest channel 1), and what it is made of. */
  albedo: number;
  tint: [number, number, number];
  material: Material;
}

/** Where a body made during a run came from: the body it came from, the event (`step:absorbed:kind`), what it is, and its look. */
export interface BodyOrigin {
  parent: string;
  event: string;
  kind: 'piece' | 'remnant' | 'debris';
  look: Look;
}

/** The looks by material (illustrative, see above). */
const MATERIAL_LOOK: Readonly<Record<Material, Look>> = {
  rock: { albedo: 0.12, tint: [1, 0.96, 0.9], material: 'rock' },
  ice: { albedo: 0.5, tint: [0.9, 0.96, 1], material: 'ice' },
  metal: { albedo: 0.15, tint: [0.93, 0.93, 0.95], material: 'metal' },
  gas: { albedo: 0.5, tint: [1, 0.93, 0.82], material: 'gas' },
  star: { albedo: 0, tint: [1, 1, 1], material: 'star' },
};
/** The worlds' rock as it shows (illustrative tints): the Moon's grey, Mars's rust, Mercury's warm grey, the Earth's and Venus's basalt. */
const WORLD_TINT: Readonly<Record<string, [number, number, number]>> = {
  moon: [1, 0.97, 0.93],
  mars: [1, 0.7, 0.5],
  mercury: [1, 0.95, 0.88],
  earth: [0.95, 0.92, 0.88],
  venus: [1, 0.93, 0.84],
};
/** Air above this (Pa) hides the surface: the albedo measured is the air's, not the rock's (Mars, at about 600 Pa, shows its ground). */
const THICK_AIR_PA = 1000;
/** Carry (2012)'s density classes (kg/m^3). */
const ICE_BELOW = 2000;
const METAL_ABOVE = 5000;

/** What the state needs to give a look. */
interface Bodies {
  ids: string[];
  gm: number[];
  radius: number[];
  climate: Record<string, ClimateState>;
  stars: Record<string, StarLight>;
  origins: Record<string, BodyOrigin>;
}

/** Body `i`'s look: its origin's, else from what it is (see the module comment). */
export function lookOf(s: Bodies, i: number): Look {
  const id = s.ids[i] ?? '';
  const origin = s.origins[id];
  if (origin) return origin.look;
  const gm = s.gm[i] ?? 0;
  if (gm >= STAR_MIN_GM || Object.hasOwn(s.stars, id)) return MATERIAL_LOOK.star;
  if (gm > SOLID_MAX_GM) return MATERIAL_LOOK.gas;
  const tint = WORLD_TINT[id];
  const climate = s.climate[id];
  if (climate) {
    const airless = climate.spec.pressurePa < THICK_AIR_PA;
    return { albedo: airless ? climate.spec.albedo : MATERIAL_LOOK.rock.albedo, tint: tint ?? MATERIAL_LOOK.rock.tint, material: 'rock' };
  }
  const density = gm > 0 ? bulkDensity(gm, s.radius[i] ?? 1) : 3000;
  const look = density < ICE_BELOW ? MATERIAL_LOOK.ice : density > METAL_ABOVE ? MATERIAL_LOOK.metal : MATERIAL_LOOK.rock;
  return tint ? { ...look, tint } : look;
}

/** Two looks mixed by mass (`share` of the second): the albedo and tint in proportion, the material the larger part's. */
export function blendLooks(a: Look, b: Look, share: number): Look {
  const w = Math.min(1, Math.max(0, share));
  const mix = (x: number, y: number): number => x + (y - x) * w;
  return { albedo: mix(a.albedo, b.albedo), tint: [mix(a.tint[0], b.tint[0]), mix(a.tint[1], b.tint[1]), mix(a.tint[2], b.tint[2])], material: w > 0.5 ? b.material : a.material };
}

/** The event key a body made by an event carries (the page keys craters and dust by it too). */
export const eventKey = (e: { step: number; absorbed: string; kind: string }): string => `${e.step}:${e.absorbed}:${e.kind}`;
