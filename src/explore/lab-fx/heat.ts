/**
 * How long an impact's melt glows (ledger IM-3; docs/IMPACTS.md, "Heat that fades"): its surface's
 * temperature as a crust grows over it. Molten rock exposed to space radiates from its surface, and the
 * heat reaching the surface must come up through the solid crust forming on it, so the surface cools
 * to the temperature at which what it radiates equals what conducts through the crust:
 *
 *   emissivity sigma T_s^4 = k (T_m - T_s) / sqrt(pi kappa t)
 *
 * the conductive half-space solution for a cooling lava lake's surface (Turcotte and Schubert 2014,
 * Geodynamics, chapter 4), with rock's conductivity k = 2 W/m/K, diffusivity kappa = 1e-6 m^2/s and
 * emissivity 0.9. Its surface falls below the visible glow (about 1,100 K) within minutes of simulated
 * time (about three for melt at 2,000 K, fourteen at 3,000 K), however large the melt: the glow is seen only while
 * the clock runs slowly over the impact. The melt's own temperature is illustrative: impact melt at
 * about 2,000 K, and for a giant impact the energy per kilogram over rock's heat capacity, at least
 * 1,500 K, at most 3,000 K (near where silicate rock boils). The glow's brightness follows from the temperature by Planck's law
 * (./incandescence); beneath the crust the interior stays molten far longer, which is not drawn.
 */

const SIGMA = 5.670374419e-8;
/** Rock's conductivity (W/m/K), thermal diffusivity (m^2/s) and emissivity (Turcotte and Schubert's values for rock). */
export const CRUST = { conductivity: 2, diffusivity: 1e-6, emissivity: 0.9 } as const;
/** Melt temperatures (K): a crater's impact melt; a giant impact's least and most (illustrative, see above); rock's heat capacity (J/kg/K). */
export const MELT = { craterK: 2000, minK: 1500, maxK: 3000, heatCapacity: 1200 } as const;

/** The melt's temperature for an impact whose energy per kilogram of the bodies is `specificJkg` (J/kg): a giant impact's (illustrative). */
export function giantMeltK(specificJkg: number): number {
  return Math.min(MELT.maxK, Math.max(MELT.minK, specificJkg / MELT.heatCapacity));
}

/** The surface's temperature (K) `seconds` after melt at `meltK` was exposed (its crust growing as above); the melt's own at the start. */
export function crustK(meltK: number, seconds: number): number {
  if (!(seconds > 0) || !(meltK > 0)) return Math.max(0, meltK);
  const conduct = CRUST.conductivity / Math.sqrt(Math.PI * CRUST.diffusivity * seconds);
  // Radiated minus conducted rises with T_s: bisection between 0 and the melt's temperature.
  let lo = 0;
  let hi = meltK;
  for (let k = 0; k < 48; k += 1) {
    const t = (lo + hi) / 2;
    if (CRUST.emissivity * SIGMA * t ** 4 > conduct * (meltK - t)) hi = t;
    else lo = t;
  }
  return (lo + hi) / 2;
}
