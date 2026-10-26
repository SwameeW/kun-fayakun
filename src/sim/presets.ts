import type { PhysicalFile } from '../astro/physical';

/**
 * The laboratory's palette of bodies to add (ledger SB-20), by kind, each with its mass (as GM),
 * mean radius and, where measured, its rotation, from a named source:
 *
 * - The Sun, the planets and the Moon: the explorer's own physical.json (GM from DE440; NAIF's mean
 *   radii; rotation from the IAU models, as the seed has them).
 * - Moons: JPL's Planetary Satellite Physical Parameters (ssd.jpl.nasa.gov/sats/phys_par/, read
 *   2026-10-26), GM with its satellite ephemeris (MAR097, JUP365, SAT441, URA111, NEP097, PLU060)
 *   and mean radius.
 * - Dwarf planets, asteroids and a comet: JPL's Small-Body Database (read 2026-10-26), GM and
 *   diameter from the references it names; Pluto from JPL's Planetary Physical Parameters.
 * - Stars: the Sun's GM times the mass in solar masses, and the IAU nominal solar radius (2015
 *   Resolution B3, 695,700 km) times the radius in solar radii: alpha Centauri A and B from Akeson
 *   et al. (2021, AJ 162, 14), Proxima Centauri from Kervella, Thevenin and Lovis (2017, A&A 598, L7).
 *
 * Stars added here pull as stars do; they do not shine (the laboratory has one light, ledger ST-2).
 */

export type PresetKind = 'star' | 'giant' | 'rocky' | 'moon' | 'dwarf' | 'asteroid' | 'comet';

export interface Preset {
  id: string;
  kind: PresetKind;
  /** GM (km^3 s^-2) and mean radius (km). */
  gm: number;
  radiusKm: number;
  /** Sidereal rotation period (h; negative: retrograde), where measured. */
  rotationH: number | null;
  /** Where the numbers come from, in short. */
  source: string;
}

/** The IAU 2015 nominal solar radius (Resolution B3), km. */
export const SOLAR_RADIUS_KM = 695_700;

const JPL_SATS = 'JPL Planetary Satellite Physical Parameters';
const SBDB = 'JPL Small-Body Database';

/** Every preset, the explorer's own worlds from physical.json first. */
export function presets(physical: PhysicalFile): Preset[] {
  const mean = (r: readonly number[]): number => ((r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0)) / 3;
  const own = (id: string, key: keyof PhysicalFile['bodies'], kind: PresetKind): Preset => {
    const rate = physical.bodies[key].pm[1];
    return { id, kind, gm: physical.gmKm3S2[key], radiusKm: mean(physical.bodies[key].radiiKm), rotationH: (Math.sign(rate) * 360 * 24) / Math.abs(rate), source: 'JPL DE440 (GM), NAIF pck00011 (radius, rotation)' };
  };
  const sunGm = physical.gmKm3S2.Sun;
  const star = (id: string, mass: number, radius: number, source: string): Preset => ({ id, kind: 'star', gm: mass * sunGm, radiusKm: radius * SOLAR_RADIUS_KM, rotationH: null, source });
  const moon = (id: string, gm: number, radiusKm: number, ephemeris: string): Preset => ({ id, kind: 'moon', gm, radiusKm, rotationH: null, source: `${JPL_SATS} (${ephemeris})` });
  return [
    own('sun', 'Sun', 'star'),
    star('alpha-cen-a', 1.0788, 1.2175, 'Akeson et al. 2021, AJ 162, 14'),
    star('alpha-cen-b', 0.9092, 0.8591, 'Akeson et al. 2021, AJ 162, 14'),
    star('proxima', 0.1221, 0.1542, 'Kervella, Thevenin and Lovis 2017, A&A 598, L7'),
    own('jupiter', 'Jupiter', 'giant'),
    own('saturn', 'Saturn', 'giant'),
    own('uranus', 'Uranus', 'giant'),
    own('neptune', 'Neptune', 'giant'),
    own('mercury', 'Mercury', 'rocky'),
    own('venus', 'Venus', 'rocky'),
    own('earth', 'Earth', 'rocky'),
    own('mars', 'Mars', 'rocky'),
    own('moon', 'Moon', 'moon'),
    moon('phobos', 0.0007087, 11.08, 'MAR097'),
    moon('deimos', 0.0000962, 6.2, 'MAR097'),
    moon('io', 5959.91547, 1821.49, 'JUP365'),
    moon('europa', 3202.7121, 1560.8, 'JUP365'),
    moon('ganymede', 9887.83275, 2631.2, 'JUP365'),
    moon('callisto', 7179.2834, 2410.3, 'JUP365'),
    moon('mimas', 2.50349, 198.2, 'SAT441'),
    moon('enceladus', 7.21037, 252.1, 'SAT441'),
    moon('rhea', 153.94175, 763.5, 'SAT441'),
    moon('titan', 8978.1371, 2574.76, 'SAT441'),
    moon('iapetus', 120.51511, 734.3, 'SAT441'),
    moon('miranda', 4.3, 235.8, 'URA111'),
    moon('titania', 226.9, 788.9, 'URA111'),
    moon('oberon', 205.3, 761.4, 'URA111'),
    moon('triton', 1428.49546, 1352.6, 'NEP097'),
    moon('charon', 106.1, 606.0, 'PLU060'),
    { id: 'pluto', kind: 'dwarf', gm: 13024.6e18 * 6.6743e-20, radiusKm: 1188.3, rotationH: -6.3872 * 24, source: 'JPL Planetary Physical Parameters (mass 13,024.6 x 10^18 kg, mean radius 1,188.3 km)' },
    { id: 'ceres', kind: 'dwarf', gm: 62.6284, radiusKm: 939.4 / 2, rotationH: 9.07417, source: `${SBDB} (Park et al. 2016, Nature 537, 515)` },
    { id: 'vesta', kind: 'asteroid', gm: 17.2882844, radiusKm: 522.77 / 2, rotationH: 5.3421276322, source: `${SBDB} (Park et al. 2025, Nat Astron)` },
    { id: 'bennu', kind: 'asteroid', gm: 4.8904e-9, radiusKm: 0.48444 / 2, rotationH: 4.296061, source: `${SBDB} (Chesley et al. 2020; Daly et al. 2020)` },
    { id: 'comet-67p', kind: 'comet', gm: 662.2e-9, radiusKm: 3.4 / 2, rotationH: 12.76129, source: `${SBDB} (Patzold et al. 2016, Nature 530, 63; Sierks et al. 2015)` },
  ];
}

/** The order the palette lists kinds in. */
export const PRESET_KINDS: readonly PresetKind[] = ['star', 'giant', 'rocky', 'moon', 'dwarf', 'asteroid', 'comet'];
