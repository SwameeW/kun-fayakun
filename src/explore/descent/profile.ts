/**
 * An atmosphere as a probe measured it on the way down (public/assets/descent, written by
 * scripts/descent/profiles.py from NASA's Planetary Data System): pressure, temperature and density
 * by altitude, the nephelometer's reading of the clouds, and (Jupiter's) the winds. Pure: read a
 * profile, ask it about any altitude in its span.
 *
 * Between rows the pressure and the density are interpolated in their logarithms (they fall
 * exponentially with height) and the temperature linearly; between Venus's two probes (64.8 to 70.5
 * km, where neither measured) the same way, and the reading says so. The clouds are the
 * nephelometer's values made relative: on Venus the backscatter above its clear-air floor (its
 * median below 45 km, where the Large Probe saw no cloud), on Jupiter the counts above zero, each over
 * its 98th percentile (clipped at 1); the explorer draws them as haze (an illustrative opacity: the nephelometers measured
 * scattering, not visibility).
 */

export type DescentWorld = 'venus' | 'jupiter';

export interface DescentFile {
  world: DescentWorld;
  probe: string;
  date: string;
  site: { latDeg: number; lonDeg: number };
  /** Venus: the radius the altitudes are above (km); Jupiter: null (they are above the 1-bar level). */
  radiusKm: number | null;
  altitude: string;
  /** Where the profile is interpolated between two probes' readings (km: from, to), or null. */
  gapKm: [number, number] | null;
  fields: string[];
  /** Rows of altitude (km), pressure (bar), temperature (K), density (kg/m^3), highest first. */
  layers: number[][];
  clouds: { quantity: string; rows: number[][] };
  winds: { quantity: string; rows: number[][] } | null;
  sourceIds: string[];
}

export interface DescentReading {
  altitudeKm: number;
  pressureBar: number;
  temperatureK: number;
  densityKgM3: number;
  /** The clouds here, 0 (clear) to 1 (the thickest the nephelometer saw). */
  cloud: number;
  /** m/s from the west (Jupiter's), or null. */
  windMs: number | null;
  /** Between two probes' readings (interpolated). */
  between: boolean;
}

export interface DescentProfile {
  readonly file: DescentFile;
  /** The highest and lowest altitudes measured (km). */
  readonly topKm: number;
  readonly bottomKm: number;
  at(altitudeKm: number): DescentReading;
  /** The altitude (km) where the pressure is `pressureBar` (within the span; clamped). */
  altitudeAtPressure(pressureBar: number): number;
  /** The clouds' column above and below an altitude (km of the thickest cloud), for the haze's look. */
  cloudAbove(altitudeKm: number): number;
  cloudBelow(altitudeKm: number): number;
}

/** Index of the row at or below `z` in a table sorted by descending altitude (rows[i][0]). */
function bracket(rows: readonly number[][], z: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.[0] ?? 0) > z) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A column (by index) of a descending table at `z`: linear, or in its logarithm. */
function sample(rows: readonly number[][], z: number, column: number, logarithmic: boolean): number {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return 0;
  if (z >= (first[0] ?? 0)) return first[column] ?? 0;
  if (z <= (last[0] ?? 0)) return last[column] ?? 0;
  const i = bracket(rows, z);
  const a = rows[i] ?? first;
  const b = rows[i + 1] ?? last;
  const za = a[0] ?? 0;
  const zb = b[0] ?? 0;
  const t = za === zb ? 0 : (za - z) / (za - zb);
  const va = a[column] ?? 0;
  const vb = b[column] ?? 0;
  if (logarithmic && va > 0 && vb > 0) return Math.exp(Math.log(va) + (Math.log(vb) - Math.log(va)) * t);
  return va + (vb - va) * t;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
};

/** The altitude below which Venus's Large Probe saw clear air (the nephelometer's floor is its median there). */
const VENUS_CLEAR_BELOW_KM = 45;

export function createProfile(file: DescentFile): DescentProfile {
  const layers = file.layers;
  const topKm = layers[0]?.[0] ?? 0;
  const bottomKm = layers[layers.length - 1]?.[0] ?? 0;
  // The clouds made relative (0 clear, 1 the thickest), on an even grid for their columns.
  const raw = file.clouds.rows;
  const floor = file.world === 'venus' ? median(raw.filter((r) => (r[0] ?? 0) < VENUS_CLEAR_BELOW_KM).map((r) => r[1] ?? 0)) : 0;
  const above = raw.map((r) => Math.max(0, (r[1] ?? 0) - floor));
  // Over the 98th percentile (not the largest reading: a lone spike would leave the deck itself faint), clipped at 1.
  const sorted = above.filter((v) => v > 0).sort((x, y) => x - y);
  const peak = Math.max(1e-30, sorted[Math.floor(sorted.length * 0.98)] ?? sorted[sorted.length - 1] ?? 0);
  const clouds = raw.map((r, i) => [r[0] ?? 0, Math.min(1, (above[i] ?? 0) / peak)]);
  const cloudTop = clouds[0]?.[0] ?? 0;
  const cloudBottom = clouds[clouds.length - 1]?.[0] ?? 0;
  const cloudAt = (z: number): number => (z > cloudTop || z < cloudBottom ? 0 : sample(clouds, z, 1, false));
  // Columns of cloud from the top of the profile down (km of the thickest cloud), every 0.1 km.
  const STEP = 0.1;
  const n = Math.max(2, Math.ceil((topKm - bottomKm) / STEP) + 1);
  const column = new Float64Array(n);
  for (let k = 1; k < n; k += 1) {
    const z0 = topKm - (k - 1) * STEP;
    const z1 = topKm - k * STEP;
    column[k] = (column[k - 1] ?? 0) + ((cloudAt(z0) + cloudAt(z1)) / 2) * STEP;
  }
  const total = column[n - 1] ?? 0;
  const columnAt = (z: number): number => {
    const f = Math.max(0, Math.min(n - 1, (topKm - z) / STEP));
    const k = Math.floor(f);
    const a = column[k] ?? 0;
    const b = column[Math.min(n - 1, k + 1)] ?? a;
    return a + (b - a) * (f - k);
  };
  const gap = file.gapKm;
  return {
    file,
    topKm,
    bottomKm,
    at(z) {
      const altitudeKm = Math.max(bottomKm, Math.min(topKm, z));
      return {
        altitudeKm,
        pressureBar: sample(layers, altitudeKm, 1, true),
        temperatureK: sample(layers, altitudeKm, 2, false),
        densityKgM3: sample(layers, altitudeKm, 3, true),
        cloud: cloudAt(altitudeKm),
        windMs: file.winds && file.winds.rows.length > 0 && altitudeKm <= (file.winds.rows[0]?.[0] ?? 0) && altitudeKm >= (file.winds.rows[file.winds.rows.length - 1]?.[0] ?? 0) ? sample(file.winds.rows, altitudeKm, 1, false) : null,
        between: gap !== null && altitudeKm > gap[0] && altitudeKm < gap[1],
      };
    },
    altitudeAtPressure(p) {
      // Pressure rises downward: search the altitude whose pressure is p.
      let hi = topKm;
      let lo = bottomKm;
      for (let k = 0; k < 60; k += 1) {
        const mid = (hi + lo) / 2;
        if (sample(layers, mid, 1, true) < p) hi = mid;
        else lo = mid;
      }
      return (hi + lo) / 2;
    },
    cloudAbove(z) {
      return columnAt(z);
    },
    cloudBelow(z) {
      return total - columnAt(z);
    },
  };
}
