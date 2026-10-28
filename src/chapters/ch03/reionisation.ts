import { Data3DTexture, DataUtils, HalfFloatType, LinearFilter, NoColorSpace, RepeatWrapping, RGBAFormat } from 'three/webgpu';
import { STAR_EDGE, WEB_EDGE } from './web';
import { prng, type WebField } from './zeldovich';

/**
 * Reionisation, as an illustration. The first stars' ultraviolet light strips the electrons from the
 * neutral hydrogen around them, and each star blows a bubble of ionised gas (a Strömgren sphere:
 * Strömgren 1939, ApJ 89, 526) that grows, meets its neighbours' and merges with them. The stars sit in
 * the knots, so the dense regions are ionised first and the voids last ("inside-out": Furlanetto,
 * Zaldarriaga & Hernquist 2004, ApJ 613, 1).
 *
 * It is worked out once at load, on the CPU, in the web's Lagrangian coordinates (where each piece of
 * matter started), as the web field is: every web particle reads when its own gas is reached with one
 * more texture fetch beside the field's, so a bubble sits exactly round its star wherever gravity has
 * carried them both. A bubble counts gas, not space (a star's light can ionise so many atoms), and in
 * these coordinates equal volumes hold equal mass. On these scales the gas follows the dark matter, so
 * the web's particles carry it, in the gas's own rose (never the dark matter's false colour), and its
 * own tag says so.
 *
 * Illustrative: each star's output (from its peak's height, rising as its galaxy gathers), the colours,
 * and the time (hundreds of millions of years in under a minute). The film stops at partial overlap,
 * about 40% of the gas ionised with neutral islands left: reionisation was about half done near
 * redshift 7.8 and finished only by about 5.3, around a billion years after the beginning
 * (data/constants.json), well after this chapter's era.
 */

/** Seconds of scatter added to each star's ignition, so no two light together. */
const IGNITION_SCATTER = 1.5;
/** Seconds after its star lights that a bubble starts to grow (the star has swelled about halfway, web.ts). */
const BUBBLE_LAG = 1.5;
/** A star's output rises steeply with its peak's height (rarer peaks, bigger haloes): volume as height^POWER. */
const POWER = 4.5;
/**
 * A bubble's radius grows as its age^GROWTH_EXPONENT: its volume counts the light emitted so far, and
 * a young galaxy's light keeps rising as matter gathers into it, so the volume grows a little faster
 * than steadily (as age^1.5).
 */
const GROWTH_EXPONENT = 0.5;
/** The front's speed is held under this (world units a second) right at a star, where it is unbounded. */
const MAX_SPEED = 3;
/**
 * How the gas's light per particle falls where particles crowd (0: not at all; 1: even light per
 * volume, as a glowing gas would be). Partway, so the front shows where it crosses the filaments and
 * stays soft in the knots, where hundreds of particles overlap (web.ts weighs it further).
 */
const CROWDING = 0.4;
const WEIGHT = { min: 0.12, max: 1.8 } as const;
/** The moments (shares of the final growth) at which the crowding is judged; each particle keeps its most crowded. */
const CROWD_MOMENTS = [0.75, 0.85, 0.93, 1] as const;
/** Gas never reached in the film is given a time this long after the chapter's end. */
const NEVER_AFTER = 12;
/** Times are worked out exactly to this many times the chapter's span after `stars` (so the front's leading edge is right at the end too). */
const MARGIN = 1.25;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * (3 - 2 * u);
};

const yieldToBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * When each first star lights: its delay after the `stars` cue, in seconds at the film's normal pace.
 * Worked out once here, so the stars (web.ts) and their bubbles light from the same instant.
 */
export function ignitionDelays(peaks: ReadonlyArray<{ height: number }>, spread: number, seed: number): Float32Array {
  const count = Math.max(1, peaks.length);
  const delays = new Float32Array(count);
  const top = peaks[0]?.height ?? 1;
  const bottom = peaks[peaks.length - 1]?.height ?? 0;
  const random = prng(seed);
  for (let i = 0; i < count; i += 1) {
    const height = peaks[i]?.height ?? bottom;
    // Highest peaks collapse (and light up) first: 0 = first, 1 = last.
    const order = top > bottom ? 1 - (height - bottom) / (top - bottom) : i / count;
    delays[i] = order ** 1.3 * spread + random() * IGNITION_SCATTER;
  }
  return delays;
}

export interface IonisationField {
  /**
   * Lagrangian, as the web field. R: when the gas there is reached, seconds after `stars` at the film's
   * normal pace (gas never reached in the film: later than its end). G: the front's speed as it passes
   * there (world units a second), so its skin can keep one thickness. B: the front's light per
   * particle, less where particles crowd.
   */
  readonly texture: Data3DTexture;
  /** The star whose bubble the tag points at (Lagrangian position, displacement at D = 1), or null. */
  readonly anchor: { readonly q: readonly [number, number, number]; readonly psi: readonly [number, number, number] } | null;
  /** Share of the gas inside the web's visible sphere that is ionised `clock` seconds after `stars` (normal pace). */
  ionisedFraction(clock: number): number;
}

interface Options {
  /** Seconds after `stars` (normal pace) at which the chapter ends. */
  end: number;
  /** Share of the visible gas ionised by then. */
  fraction: number;
  /** Growth factor at the end: where the web stands then sets what is visible and how crowded it is. */
  growth: number;
  /** Where the camera stands at the end, looking at the middle: the tag's bubble is one up in its picture. */
  view: readonly [number, number, number];
  /** Seconds after `stars` (normal pace) the tag comes in: its bubble's star has lit by then. */
  tagFrom: number;
}

interface Source {
  /** Cell of the star's peak. */
  x: number;
  y: number;
  z: number;
  /** Seconds after `stars` its bubble starts. */
  start: number;
  /** Radius per age^GROWTH_EXPONENT, per unit of the calibrated rate. */
  reach: number;
}

export async function createIonisationField(field: WebField, delays: Float32Array, options: Options): Promise<IonisationField> {
  const { box, size: n, displacement: psi, peaks } = field;
  if ((n & (n - 1)) !== 0) throw new Error(`[ch03] The web field's size ${n} is not a power of two`);
  const n2 = n * n;
  const n3 = n2 * n;
  const mask = n - 1;
  const cell = box / n;
  const half = box / 2;
  const wrap = (v: number): number => v - Math.floor(v / box + 0.5) * box;
  const cellOf = (q: readonly number[]): [number, number, number] => q.map((c) => Math.round((c + half) / cell - 0.5) & mask) as [number, number, number];

  // Where every cell's matter stands at the end, and how much of it is inside the web's visible sphere.
  const visible = new Float32Array(n3);
  let visibleSum = 0;
  for (let v = 0, z = 0; z < n; z += 1) {
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1, v += 1) {
        const ex = wrap((x + 0.5) * cell - half + options.growth * (psi[v * 3] ?? 0));
        const ey = wrap((y + 0.5) * cell - half + options.growth * (psi[v * 3 + 1] ?? 0));
        const ez = wrap((z + 0.5) * cell - half + options.growth * (psi[v * 3 + 2] ?? 0));
        const shown = 1 - smoothstep(WEB_EDGE[0], WEB_EDGE[1], Math.sqrt(ex * ex + ey * ey + ez * ez) / half);
        visible[v] = shown;
        visibleSum += shown;
      }
    }
  }
  await yieldToBrowser();

  // How crowded each cell's matter gets while the bubbles grow: one particle per cell deposited
  // cloud-in-cell where it stands, smoothed once, read back where it stands (1 = the mean), the most of
  // a few moments (the web's knots are passing crowds: in the Zel'dovich approximation matter streams
  // through them).
  // Positions in cells (a Lagrangian cell's centre is at its own index); the periodic wrap is the mask.
  const corner = new Int32Array(8);
  const weight = new Float32Array(8);
  const cloud = (gx: number, gy: number, gz: number): void => {
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fy = gy - iy;
    const fz = gz - iz;
    for (let c = 0; c < 8; c += 1) {
      const dx = c & 1;
      const dy = (c >> 1) & 1;
      const dz = c >> 2;
      weight[c] = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
      corner[c] = (((iz + dz) & mask) * n + ((iy + dy) & mask)) * n + ((ix + dx) & mask);
    }
  };
  const crowdest = new Float32Array(n3);
  let crowd = new Float32Array(n3);
  let next = new Float32Array(n3);
  for (const share of CROWD_MOMENTS) {
    const scale = (share * options.growth) / cell;
    crowd.fill(0);
    for (let v = 0, z = 0; z < n; z += 1) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1, v += 1) {
          cloud(x + scale * (psi[v * 3] ?? 0), y + scale * (psi[v * 3 + 1] ?? 0), z + scale * (psi[v * 3 + 2] ?? 0));
          for (let c = 0; c < 8; c += 1) {
            const index = corner[c] ?? 0;
            crowd[index] = (crowd[index] ?? 0) + (weight[c] ?? 0);
          }
        }
      }
    }
    await yieldToBrowser();
    for (let axis = 0; axis < 3; axis += 1) {
      const stride = axis === 0 ? 1 : axis === 1 ? n : n2;
      for (let v = 0; v < n3; v += 1) {
        const along = Math.floor(v / stride) % n;
        const before = v + (((along - 1) & mask) - along) * stride;
        const after = v + (((along + 1) & mask) - along) * stride;
        next[v] = 0.25 * (crowd[before] ?? 0) + 0.5 * (crowd[v] ?? 0) + 0.25 * (crowd[after] ?? 0);
      }
      [crowd, next] = [next, crowd];
    }
    await yieldToBrowser();
    for (let v = 0, z = 0; z < n; z += 1) {
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1, v += 1) {
          cloud(x + scale * (psi[v * 3] ?? 0), y + scale * (psi[v * 3 + 1] ?? 0), z + scale * (psi[v * 3 + 2] ?? 0));
          let c = 0;
          for (let k = 0; k < 8; k += 1) c += (weight[k] ?? 0) * (crowd[corner[k] ?? 0] ?? 0);
          if (c > (crowdest[v] ?? 0)) crowdest[v] = c;
        }
      }
    }
    await yieldToBrowser();
  }
  const lightWeight = new Float32Array(n3);
  for (let v = 0; v < n3; v += 1) lightWeight[v] = Math.min(WEIGHT.max, Math.max(WEIGHT.min, Math.max(crowdest[v] ?? 0, 1e-3) ** -CROWDING));

  // The camera's picture at the end: its right and up directions, looking at the middle.
  const [vx, vy, vz] = options.view;
  const distance = Math.hypot(vx, vy, vz) || 1;
  const forward = [-vx / distance, -vy / distance, -vz / distance] as const;
  const rightRaw = [-forward[2], 0, forward[0]] as const; // forward × world up
  const rightLength = Math.hypot(...rightRaw) || 1;
  const right = rightRaw.map((c) => c / rightLength) as [number, number, number];
  const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]] as const;
  const dot = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

  // The sources: every first star that shows (the stars fade out toward the sphere's edge, and their bubbles with them).
  const sources: Source[] = [];
  const bottom = peaks.reduce((low, p) => Math.min(low, p.height), Infinity);
  const candidates: Array<{ index: number; score: number; framed: boolean }> = [];
  peaks.forEach((peak, i) => {
    const [x, y, z] = cellOf(peak.q);
    const v = (z * n + y) * n + x;
    const end = peak.q.map((c, axis) => wrap(c + options.growth * (psi[v * 3 + axis] ?? 0)));
    const radius = Math.hypot(...end) / half;
    const shown = 1 - smoothstep(STAR_EDGE[0], STAR_EDGE[1], radius);
    if (shown < 0.02) return;
    const reach = Math.cbrt(shown * (peak.height / bottom) ** POWER);
    const start = (delays[i] ?? 0) + BUBBLE_LAG;
    sources.push({ x, y, z, start, reach });
    // The tag's bubble: a big one lit before the tag comes in, near the middle and up in the picture
    // (clear of the captions below).
    if (radius > 0.6 || start > options.tagFrom - 1) return;
    const upward = dot(end, up) / half;
    const across = Math.abs(dot(end, right)) / half;
    candidates.push({ index: i, score: reach * Math.max(0, options.end - start) ** GROWTH_EXPONENT, framed: upward > 0.06 && upward < 0.5 && across < 0.45 });
  });

  const times = new Float32Array(n3);
  const speeds = new Float32Array(n3);
  /** Each cell's time, the earliest any front reaches it, worked out up to `until` (later: `never`), and the front's speed there then. */
  const fill = (rate: number, until: number, never: number): void => {
    times.fill(never);
    speeds.fill(0);
    for (const s of sources) {
      const k = rate * s.reach;
      const radius = k * Math.max(0, until - s.start) ** GROWTH_EXPONENT;
      const m = Math.min(n >> 1, Math.ceil(radius / cell));
      const r2 = (radius / cell) ** 2;
      for (let dz = -m; dz <= m; dz += 1) {
        const zz = dz * dz;
        if (zz > r2) continue;
        const zRow = ((s.z + dz) & mask) * n2;
        for (let dy = -m; dy <= m; dy += 1) {
          const yy = zz + dy * dy;
          if (yy > r2) continue;
          const yRow = zRow + ((s.y + dy) & mask) * n;
          for (let dx = -m; dx <= m; dx += 1) {
            const d2 = yy + dx * dx;
            if (d2 > r2) continue;
            const index = yRow + ((s.x + dx) & mask);
            const r = Math.sqrt(d2) * cell;
            const age = (r / k) ** (1 / GROWTH_EXPONENT);
            const t = s.start + age;
            if (t < (times[index] ?? never)) {
              times[index] = t;
              speeds[index] = age > 0 ? Math.min(MAX_SPEED, (GROWTH_EXPONENT * r) / age) : MAX_SPEED;
            }
          }
        }
      }
    }
  };
  const fractionNow = (clock: number): number => {
    let sum = 0;
    for (let v = 0; v < n3; v += 1) if ((times[v] ?? Infinity) <= clock) sum += visible[v] ?? 0;
    return visibleSum > 0 ? sum / visibleSum : 0;
  };

  // The rate that leaves `fraction` of the visible gas ionised at the end: a first guess from the
  // bubbles' volumes (with some overlap), then bisection (the share only grows with the rate).
  const target = options.fraction;
  const spheres = sources.reduce((sum, s) => sum + (4 / 3) * Math.PI * (s.reach * Math.max(0, options.end - s.start) ** GROWTH_EXPONENT) ** 3, 0);
  const guess = spheres > 0 ? Math.cbrt((1.4 * target * visibleSum * cell ** 3) / spheres) : 1;
  // Each trial yields to the browser after it, so a chapter loading ahead never holds up the one playing.
  const at = async (rate: number): Promise<number> => {
    fill(rate, options.end, Infinity);
    const share = fractionNow(options.end);
    await yieldToBrowser();
    return share;
  };
  let low = guess / 2;
  let high = guess * 2;
  for (let i = 0; i < 8 && (await at(high)) < target; i += 1) high *= 1.6;
  for (let i = 0; i < 8 && (await at(low)) > target; i += 1) low /= 1.6;
  for (let i = 0; i < 14; i += 1) {
    const mid = Math.sqrt(low * high);
    if ((await at(mid)) < target) low = mid;
    else high = mid;
  }
  const rate = Math.sqrt(low * high);
  const until = options.end * MARGIN;
  fill(rate, until, until + NEVER_AFTER);
  await yieldToBrowser();

  // The share ionised against time, tabulated a quarter-second apart (bins[k]: reached before k steps).
  const STEP = 0.25;
  const bins = new Float64Array(Math.ceil(until / STEP) + 2);
  for (let v = 0; v < n3; v += 1) {
    const t = times[v] ?? Infinity;
    if (t > until) continue;
    const bin = Math.min(bins.length - 1, Math.max(0, Math.floor(t / STEP) + 1));
    bins[bin] = (bins[bin] ?? 0) + (visible[v] ?? 0);
  }
  for (let i = 1; i < bins.length; i += 1) bins[i] = (bins[i] ?? 0) + (bins[i - 1] ?? 0);

  // Gas never reached keeps a typical speed, so it reads as far ahead of every front (never as on one).
  const reached = Array.from(speeds.filter((s) => s > 0)).sort((a, b) => a - b);
  const typical = reached[reached.length >> 1] ?? 0.5;
  const data = new Uint16Array(n3 * 4);
  for (let v = 0; v < n3; v += 1) {
    const speed = speeds[v] ?? 0;
    data[v * 4] = DataUtils.toHalfFloat(times[v] ?? until + NEVER_AFTER);
    data[v * 4 + 1] = DataUtils.toHalfFloat(speed > 0 ? speed : typical);
    data[v * 4 + 2] = DataUtils.toHalfFloat(lightWeight[v] ?? 1);
    data[v * 4 + 3] = DataUtils.toHalfFloat(1);
  }
  const texture = new Data3DTexture(data, n, n, n);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const best = (list: typeof candidates): (typeof candidates)[number] | undefined => list.reduce<(typeof candidates)[number] | undefined>((a, b) => (!a || b.score > a.score ? b : a), undefined);
  const chosen = best(candidates.filter((c) => c.framed)) ?? best(candidates);
  const anchorPeak = chosen ? peaks[chosen.index] : undefined;
  let anchor: IonisationField['anchor'] = null;
  if (anchorPeak) {
    const [x, y, z] = cellOf(anchorPeak.q);
    const v = (z * n + y) * n + x;
    anchor = { q: anchorPeak.q, psi: [psi[v * 3] ?? 0, psi[v * 3 + 1] ?? 0, psi[v * 3 + 2] ?? 0] };
  }

  return {
    texture,
    anchor,
    ionisedFraction(clock) {
      if (!(clock >= 0) || visibleSum <= 0) return 0;
      const position = Math.min(bins.length - 1, clock / STEP);
      const i = Math.floor(position);
      const f = position - i;
      return ((bins[i] ?? 0) * (1 - f) + (bins[Math.min(bins.length - 1, i + 1)] ?? 0) * f) / visibleSum;
    },
  };
}
