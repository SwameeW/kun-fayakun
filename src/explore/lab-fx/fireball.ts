import { incandescence } from './incandescence';

/**
 * An impact's fireball (docs/SANDBOX-ROADMAP.md W1.14; docs/IMPACTS.md): on every merger or breakup (not
 * a graze, nor the tides), a glowing ball at the contact, as big as the impact's energy makes it and
 * coloured by Planck's law (./incandescence).
 *
 * - Size: the fireball's radius in air scales as the cube root of the energy, R = 0.002 E^(1/3) m with E
 *   in joules (Collins, Melosh and Marcus 2005, the Earth Impact Effects Program), at least the
 *   impactor's radius and at most half the target's (a giant impact's glow is the target's whole face).
 * - Heat: it starts at the temperature the impact's energy per kilogram could raise rock to, v^2 / 2c
 *   (c = 1,200 J/kg/K), at most 4,000 K (silicate vapour) and at least 1,800 K, and cools as it fades.
 * - Brightness: Planck's law's, held to a ceiling: no brighter than sunlit white ground (a real one is
 *   hundreds of times brighter, for a moment).
 * - Time: slowed for safety, the same at every rate. A real crater-scale flash lasts a fraction of a
 *   second; this rises over 0.8 s (never more than a thirtieth of its peak a frame at 60 frames a
 *   second), holds, and fades over 2.5 s. Impacts within a third of a second of the last make no new
 *   fireball (the larger is kept), and never more than three rise in a second (flash safety: a fourth
 *   joins the newest). With reduced motion it does not grow, and fades in and out more slowly.
 */

export interface FireballEvent {
  key: string;
  /** The body struck (it keeps the fireball as it moves) and where (a unit vector from its centre, scenario frame). */
  body: string;
  site: [number, number, number];
  /** The impact's energy (J), speed (km/s), the impactor's and the target's radii (km). */
  energyJ: number;
  speedKmS: number;
  impactorKm: number;
  targetKm: number;
}

export interface Fireball extends FireballEvent {
  /** When it began (s, the wall clock), its radius (km), its first temperature (K). */
  born: number;
  radiusKm: number;
  startK: number;
  /** As drawn now: its strength (0 to 1 of its peak), temperature (K), luminance (a share of sunlit white ground, under the ceiling), colour (linear, largest channel 1) and how much of its radius shows. */
  strength: number;
  kelvin: number;
  luminance: number;
  rgb: [number, number, number];
  grown: number;
}

export const FIREBALL = {
  riseS: 0.8,
  holdS: 0.25,
  fadeS: 2.5,
  /** Reduced motion: slower in and out, no growth. */
  reducedRiseS: 1.5,
  reducedFadeS: 3.5,
  mergeS: 0.33,
  risesPerS: 3,
  maxLive: 4,
  /** The brightest it is drawn: sunlit white ground. */
  ceiling: 1,
  heatCapacity: 1200,
  minK: 1800,
  maxK: 4000,
  /** Its temperature at the end of its fade, as a share of its first. */
  coolTo: 0.45,
} as const;

const smoothstep = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};

/** The fireball's radius (km) for an impact's energy (J): Collins and others' 0.002 E^(1/3) m, between the impactor's radius and half the target's. */
export function fireballRadiusKm(energyJ: number, impactorKm: number, targetKm: number): number {
  const r = (0.002 * Math.cbrt(Math.max(0, energyJ))) / 1000;
  return Math.min(Math.max(r, impactorKm), Math.max(impactorKm, 0.5 * targetKm));
}

/** Its first temperature (K) for an impact at `speedKmS`. */
export function fireballK(speedKmS: number): number {
  const v = speedKmS * 1000;
  return Math.min(FIREBALL.maxK, Math.max(FIREBALL.minK, (v * v) / (2 * FIREBALL.heatCapacity)));
}

export class Fireballs {
  readonly live: Fireball[] = [];
  private rises: number[] = [];

  /** An impact at wall time `nowS`: a new fireball, or merged into the latest (see the module comment). */
  add(e: FireballEvent, nowS: number): void {
    this.rises = this.rises.filter((t) => nowS - t < 1);
    const latest = this.live[this.live.length - 1];
    const radiusKm = fireballRadiusKm(e.energyJ, e.impactorKm, e.targetKm);
    if (latest && (nowS - latest.born < FIREBALL.mergeS || this.rises.length >= FIREBALL.risesPerS)) {
      // Joined to the newest: the larger kept (where it is, so nothing jumps).
      if (e.energyJ > latest.energyJ) {
        latest.energyJ = e.energyJ;
        latest.radiusKm = Math.max(latest.radiusKm, radiusKm);
        latest.startK = Math.max(latest.startK, fireballK(e.speedKmS));
      }
      return;
    }
    // At most maxLive: the oldest is not cut off, it is left to fade (the newest waits its turn by joining it).
    if (this.live.length >= FIREBALL.maxLive && latest) {
      if (e.energyJ > latest.energyJ) latest.energyJ = e.energyJ;
      return;
    }
    this.rises.push(nowS);
    this.live.push({ ...e, site: [e.site[0], e.site[1], e.site[2]], born: nowS, radiusKm, startK: fireballK(e.speedKmS), strength: 0, kelvin: 0, luminance: 0, rgb: [1, 0.5, 0.2], grown: 0 });
  }

  /** Each fireball as it is at `nowS`, its strength rising no faster than `dtS` times the most a rise allows. */
  update(nowS: number, dtS: number, reduced: boolean): void {
    const rise = reduced ? FIREBALL.reducedRiseS : FIREBALL.riseS;
    const fade = reduced ? FIREBALL.reducedFadeS : FIREBALL.fadeS;
    // A smoothstep's steepest is 1.5 over its span: the most a frame may add.
    const most = (1.5 / rise) * Math.max(0, dtS);
    for (let k = this.live.length - 1; k >= 0; k -= 1) {
      const f = this.live[k];
      if (!f) continue;
      const age = nowS - f.born;
      const up = smoothstep(age / rise);
      const down = 1 - smoothstep((age - rise - FIREBALL.holdS) / fade);
      const target = Math.min(up, down);
      f.strength = target > f.strength ? Math.min(target, f.strength + most) : target;
      f.grown = reduced ? 1 : 0.55 + 0.45 * up;
      const cooled = smoothstep((age - rise) / (FIREBALL.holdS + fade));
      f.kelvin = f.startK * (1 - (1 - FIREBALL.coolTo) * cooled);
      const glow = incandescence(f.kelvin, { luminance: 0, rgb: f.rgb });
      f.luminance = Math.min(FIREBALL.ceiling, glow.luminance) * f.strength;
      if (age > rise + FIREBALL.holdS + fade) this.live.splice(k, 1);
    }
  }

  clear(): void {
    this.live.length = 0;
    this.rises = [];
  }
}
