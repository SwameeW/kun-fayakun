/**
 * Discoveries: quiet notes about what the visitor is near, and a log of the phenomena they have
 * seen on this visit. Science only (no scripture here: exploration is the science layer), and
 * every number is derived from cited data, never typed in:
 *
 * - rotation periods from the IAU WGCCRE rotation rates in public/assets/jpl/physical.json (NAIF
 *   pck00011); the Earth's tilt from the J2000 obliquity there; radii and flattening from its IAU radii;
 * - the year, the synodic month and Saturn's period from the mean motions of JPL's Keplerian
 *   elements (Standish and Williams, Table 1) in planets.json;
 * - the extent of Saturn's main rings from the Cassini radio-occultation profile in physical.json
 *   (where its normal optical depth exceeds 0.02);
 * - the speed of light, the Earth's atmospheric scale height and the Sun's effective temperature
 *   from data/constants.json (BIPM, NASA's Earth Fact Sheet, IAU 2015 Resolution B3);
 * - and everything that changes (phases, the rings' tilt to the Sun, light-times) from the
 *   ephemeris on the date shown.
 *
 * There are no scores, counts or achievements: the log is a plain list of what was seen, in order.
 * Pure (no DOM, no three.js).
 */

import type { PlanetsFile } from '../astro/ephemeris';
import { ringTransmission, type PhysicalFile } from '../astro/physical';
import type { BodyId } from '../core/types';

/** Constants from data/constants.json the notes use. */
export const DISCOVERY_CONSTANTS = {
  lightSpeed: 'light.speed',
  scaleHeight: 'earth.atmosphere.scaleHeight',
  sunTemperature: 'sun.effectiveTemperature',
} as const;

export interface Facts {
  /** Speed of light, km/s. */
  lightKmS: number;
  earth: { siderealDayHours: number; solarDayHours: number; tiltDeg: number; scaleHeightKm: number; radiusKm: number };
  moon: { rotationDays: number; synodicDays: number; terminatorKmH: number };
  sun: { rotationDays: number; temperatureK: number; radiusKm: number };
  jupiter: { dayHours: number; flatteningPercent: number };
  saturn: { dayHours: number; ringInnerKm: number; ringOuterKm: number; edgeOnYears: number };
}

/** A main ring's edge: where the profile's mean normal transmission falls below this (optical depth above about 0.02). */
const RING_EDGE_TRANSMISSION = 250 / 255;
const DAYS_PER_CENTURY = 36_525;
const DAYS_PER_YEAR = 365.25;

/** Rotation period (days) from an IAU prime-meridian rate (degrees per day). */
const periodDays = (degreesPerDay: number): number => 360 / Math.abs(degreesPerDay);

/** Everything fixed the notes say, from the explorer's data files and three cited constants. */
export function deriveFacts(physical: PhysicalFile, planets: PlanetsFile, constant: (id: string) => number): Facts {
  const rate = (body: keyof PhysicalFile['bodies']): number => physical.bodies[body].pm[1];
  const radii = (body: keyof PhysicalFile['bodies']): readonly number[] => physical.bodies[body].radiiKm;
  const orbitDays = (name: string): number => {
    const body = planets.bodies.find((b) => b.name === name);
    if (!body) throw new Error(`planets.json has no ${name}`);
    return (360 / body.ratesPerCentury.L) * DAYS_PER_CENTURY;
  };
  const year = orbitDays('Earth');
  const earthDay = periodDays(rate('Earth'));
  const moonDays = periodDays(rate('Moon'));
  const synodic = 1 / (1 / moonDays - 1 / year);
  const moonRadius = radii('Moon')[0] ?? 0;
  const [ja = 1, , jc = 1] = radii('Jupiter');
  const profile = ringTransmission(physical.saturnRings);
  const binKm = (physical.saturnRings.outerKm - physical.saturnRings.innerKm) / profile.length;
  const first = profile.findIndex((t) => t < RING_EDGE_TRANSMISSION);
  const last = profile.length - 1 - [...profile].reverse().findIndex((t) => t < RING_EDGE_TRANSMISSION);
  return {
    lightKmS: constant(DISCOVERY_CONSTANTS.lightSpeed) / 1000,
    earth: {
      siderealDayHours: earthDay * 24,
      solarDayHours: (1 / (1 / earthDay - 1 / year)) * 24,
      tiltDeg: physical.obliquityJ2000Arcsec / 3600,
      scaleHeightKm: constant(DISCOVERY_CONSTANTS.scaleHeight),
      radiusKm: radii('Earth')[0] ?? 0,
    },
    moon: { rotationDays: moonDays, synodicDays: synodic, terminatorKmH: (2 * Math.PI * moonRadius) / (synodic * 24) },
    sun: { rotationDays: periodDays(rate('Sun')), temperatureK: constant(DISCOVERY_CONSTANTS.sunTemperature), radiusKm: radii('Sun')[0] ?? 0 },
    jupiter: { dayHours: periodDays(rate('Jupiter')) * 24, flatteningPercent: ((ja - jc) / ja) * 100 },
    saturn: {
      dayHours: periodDays(rate('Saturn')) * 24,
      ringInnerKm: physical.saturnRings.innerKm + Math.max(0, first) * binKm,
      ringOuterKm: physical.saturnRings.innerKm + (last + 1) * binKm,
      edgeOnYears: orbitDays('Saturn') / 2 / DAYS_PER_YEAR,
    },
  };
}

/** What the explorer knows about the view this frame (all from the ephemeris and the camera). */
export interface DiscoveryInput {
  focus: BodyId;
  travelling: boolean;
  /** Height above the focus's surface, km, and its radius. */
  altitudeKm: number;
  radiusKm: number;
  /** The height the focus is framed from in this view, km (a phone held upright frames from further out). */
  framedAltitudeKm: number;
  /** Phase angle at each body between the Sun and the camera, radians (0 full, pi new); and disc radius on screen, px; and whether its centre is in view. */
  phaseAngle: Readonly<Record<BodyId, number>>;
  discPx: Readonly<Record<BodyId, number>>;
  inView: Readonly<Record<BodyId, boolean>>;
  /** The Moon seen from the Earth: lit share (0 to 1) and whether it is waxing. */
  moonLit: number;
  moonWaxing: boolean;
  /** The Earth seen from the Moon: lit share. */
  earthLitFromMoon: number;
  /** Saturn's rings' tilt toward the Sun, degrees (their plane to the Sun's direction). */
  ringTiltDeg: number;
  /** Distance from the Sun's centre to the Earth's and to the camera, km. */
  sunEarthKm: number;
  sunCameraKm: number;
  /** Sunlight at the camera as a share of the Earth's. */
  sunlight: number;
  solarFilter: boolean;
}

export type DiscoveryId = 'earth' | 'earth-air' | 'moon' | 'sun' | 'jupiter' | 'saturn';

/** A note to show now: which, and its numbers (formatted by the interface). */
export interface Discovery {
  id: DiscoveryId;
  values: Record<string, number>;
}

/** Phenomena the log records, in no particular order (the log keeps the order they were seen). */
export const PHENOMENA = [
  'earth-air',
  'earth-night',
  'earth-and-moon',
  'moon-terminator',
  'earthshine',
  'jupiter-oblate',
  'saturn-rings',
  'sun-filter',
  'faint-sunlight',
] as const;
export type Phenomenon = (typeof PHENOMENA)[number];

/** A note shows within this many radii of the focus's surface, and goes beyond the second (no flicker at the edge). */
const NOTE_RADII: Readonly<Partial<Record<BodyId, readonly [number, number]>>> = {
  sun: [25, 30],
  earth: [10, 12],
  moon: [12, 14],
  jupiter: [12, 14],
  saturn: [10, 12],
};
/** A note also shows within these multiples of the height the view frames the world from (shows, goes). */
const FRAMED_NOTE: readonly [number, number] = [1.4, 1.7];
/** Low over the Earth (in radii), the note turns to its air. */
const AIR_RADII: readonly [number, number] = [1.2, 1.4];
const DEG = 180 / Math.PI;

/**
 * Tracks the note to show and the log of phenomena seen. The note changes only with the focus or
 * the height band (with some slack), so it never flickers; while travelling there is none.
 */
export class Discoveries {
  private shown: DiscoveryId | null = null;
  private readonly seen: Phenomenon[] = [];
  /** One note object per id, its values rewritten in place each frame (no garbage per frame). */
  private readonly notes = new Map<DiscoveryId, Discovery>();

  constructor(private readonly facts: Facts) {}

  get witnessed(): readonly Phenomenon[] {
    return this.seen;
  }

  get factsOf(): Facts {
    return this.facts;
  }

  /** Clears the log (a new visit). */
  reset(): void {
    this.seen.length = 0;
    this.shown = null;
  }

  /** The note to show now (the same object for the same note, its numbers current), or null. */
  update(input: DiscoveryInput): Discovery | null {
    this.observe(input);
    const id = this.noteFor(input);
    this.shown = id;
    if (!id) return null;
    let note = this.notes.get(id);
    if (!note) {
      note = { id, values: {} };
      this.notes.set(id, note);
    }
    this.fill(id, input, note.values);
    return note;
  }

  private noteFor(input: DiscoveryInput): DiscoveryId | null {
    if (input.travelling) return null;
    const radii = input.altitudeKm / Math.max(1, input.radiusKm);
    // Within so many radii, or not far beyond the height the view frames the world from.
    const framed = input.framedAltitudeKm / Math.max(1, input.radiusKm);
    if (input.focus === 'mercury' || input.focus === 'venus' || input.focus === 'mars' || input.focus === 'uranus' || input.focus === 'neptune') return null;
    const [show, hide] = NOTE_RADII[input.focus] ?? [0, 0];
    const current = this.shown;
    const showing = current !== null && (current === input.focus || (current === 'earth-air' && input.focus === 'earth'));
    if (radii > (showing ? Math.max(hide, FRAMED_NOTE[1] * framed) : Math.max(show, FRAMED_NOTE[0] * framed))) return null;
    if (input.focus !== 'earth') return input.focus;
    const low = current === 'earth-air' ? radii < AIR_RADII[1] : radii < AIR_RADII[0];
    return low ? 'earth-air' : 'earth';
  }

  /** Writes a note's numbers into `out` (its keys are fixed per note). */
  private fill(id: DiscoveryId, input: DiscoveryInput, out: Record<string, number>): void {
    const f = this.facts;
    switch (id) {
      case 'earth':
        out.sidereal = f.earth.siderealDayHours;
        out.solar = f.earth.solarDayHours;
        out.tilt = f.earth.tiltDeg;
        return;
      case 'earth-air': {
        // An exponential atmosphere keeps exp(-h / H) of its air above height h.
        const depth = 6 * f.earth.scaleHeightKm;
        out.scaleHeight = f.earth.scaleHeightKm;
        out.depth = depth;
        out.below = (1 - Math.exp(-6)) * 100;
        out.share = (depth / f.earth.radiusKm) * 100;
        return;
      }
      case 'moon':
        out.lit = input.moonLit * 100;
        out.waxing = input.moonWaxing ? 1 : 0;
        out.terminator = f.moon.terminatorKmH;
        out.rotation = f.moon.rotationDays;
        return;
      case 'sun':
        out.lightSeconds = Math.max(0, input.sunEarthKm - f.sun.radiusKm) / f.lightKmS;
        out.temperature = f.sun.temperatureK;
        out.rotation = f.sun.rotationDays;
        return;
      case 'jupiter':
        out.day = f.jupiter.dayHours;
        out.flattening = f.jupiter.flatteningPercent;
        out.lightSeconds = input.sunCameraKm / f.lightKmS;
        return;
      case 'saturn':
        out.inner = f.saturn.ringInnerKm;
        out.outer = f.saturn.ringOuterKm;
        out.tilt = Math.abs(input.ringTiltDeg);
        out.edgeOn = f.saturn.edgeOnYears;
        out.day = f.saturn.dayHours;
        return;
    }
  }

  private observe(input: DiscoveryInput): void {
    if (input.travelling) return;
    const near = (id: BodyId, within: number): boolean => input.focus === id && input.altitudeKm / Math.max(1, input.radiusKm) < within;
    const phase = (id: BodyId): number => input.phaseAngle[id] * DEG;
    const visible = (id: BodyId, px: number): boolean => input.inView[id] && input.discPx[id] > px;
    if (near('earth', AIR_RADII[0])) this.note('earth-air');
    if (near('earth', 12) && phase('earth') > 110 && visible('earth', 20)) this.note('earth-night');
    if (visible('earth', 3) && visible('moon', 3)) this.note('earth-and-moon');
    if (near('moon', 4) && phase('moon') > 25 && phase('moon') < 155 && visible('moon', 40)) this.note('moon-terminator');
    if (input.focus === 'moon' && phase('moon') > 120 && input.earthLitFromMoon > 0.5 && visible('moon', 20)) this.note('earthshine');
    if (near('jupiter', 6) && visible('jupiter', 60)) this.note('jupiter-oblate');
    if (near('saturn', 10) && visible('saturn', 30)) this.note('saturn-rings');
    if (input.solarFilter) this.note('sun-filter');
    if (input.sunlight < 0.02) this.note('faint-sunlight');
  }

  private note(p: Phenomenon): void {
    if (!this.seen.includes(p)) this.seen.push(p);
  }
}
