import type { Ephemeris } from '../../astro/ephemeris';
import { utcToTdb, type TimeConstants } from '../../astro/time';

/**
 * The astronomy of the qibla and the new moon, from the explorer's own ephemeris (JPL's approximate
 * elements for the Sun, the Horizons table for the Moon). No DOM, no three.js: the explorer's layer
 * and panel use it, and tests/unit/islamic.spec.ts checks it against published values.
 *
 * - The qibla: the great circle from a place to the Kaaba (Wikidata Q29466's coordinates), its
 *   bearing from true north and its length, on a sphere of the Earth's mean radius.
 * - The Sun over the Kaaba: the two days a year the Sun's declination meets the Kaaba's latitude at
 *   its transit there, when every shadow in daylight points away from the qibla; and the two when it
 *   stands over the opposite point of the Earth, when shadows on the far hemisphere point toward it.
 * - New moons: the instants the Moon's geocentric ecliptic longitude meets the Sun's apparent one.
 * - The golden latitude: where the meridian from pole to pole divides in the golden ratio, beside the
 *   Kaaba's own latitude, both measured on the WGS 84 ellipsoid (a closeness of numbers, shown with
 *   its actual size, not a claim).
 * - The new crescent: Yallop's q-test (B. D. Yallop, NAO Technical Note 69, 1997), evaluated at
 *   each place's "best time" (sunset plus four ninths of the time from sunset to moonset): the
 *   geocentric, airless difference in altitude of the Moon and the Sun (ARCV) against a cubic in the
 *   topocentric width of the crescent (W'), sorted into Yallop's zones A to F.
 *
 * Positions are geocentric, on the equator and equinox of date (IAU 1976 precession from J2000). The
 * Sun is shifted back along the ecliptic by the annual aberration and its light-time (20.5" at 1 au);
 * the Moon is geometric (its light-time is 1.3 s). Nutation is left out (at most 1.2 s of sidereal
 * time and 17" of longitude), and UT1 is taken as UTC (within 0.9 s): seconds, where the results are
 * shown to the minute.
 */

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const TAU = 2 * Math.PI;

/** The Kaaba: Wikidata Q29466, coordinate location (P625), retrieved 2026-10-26 (CC0). */
export const KAABA = { qid: 'Q29466', lat: 21.4225, lon: 39.826166666667 } as const;

/** The Earth's equatorial radius (km) and flattening, for an observer's place (WGS 84). */
const EARTH_A_KM = 6378.137;
const EARTH_F = 1 / 298.257223563;
/** The Sun's apparent altitude at sunset: its centre 50' below the horizon (34' of refraction, 16' of semi-diameter). */
const SUNSET_ALT_DEG = -50 / 60;
/** The Moon's refraction at the horizon (34'), for its setting. */
const MOON_REFRACTION_DEG = 34 / 60;
/** The annual aberration's constant with the Sun's light-time: its apparent longitude is this much behind its true one at 1 au. */
const SUN_ABERRATION = 20.4898 * ARCSEC;
/** The Moon's semi-diameter as a fraction of its horizontal parallax (k = 0.2725 of the Earth's equatorial radius). */
const MOON_SD_PER_PARALLAX = 0.27245;
/** Yallop's test is not used beyond these latitudes (degrees; its observations and the maps that use it stop near 63). */
export const YALLOP_MAX_LAT = 63;
/** Yallop's zone boundaries for q, highest first. */
export const YALLOP_ZONES = [
  ['A', 0.216],
  ['B', -0.014],
  ['C', -0.16],
  ['D', -0.232],
  ['E', -0.293],
] as const;

export type CrescentZone = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
/** Why a place has no zone: the Moon sets first, the evening is before the new moon, the Sun does not set, or the place is beyond the latitudes Yallop's test was made for. */
export type CrescentNone = 'moon-sets-first' | 'before-new-moon' | 'no-sunset' | 'high-latitude';

export interface SkyFrame {
  ephemeris: Ephemeris;
  time: TimeConstants;
  /** The obliquity of the ecliptic at J2000, radians. */
  obliquityRad: number;
}

/** A body's geocentric place: right ascension and declination of date (radians), distance (km). */
export interface Place {
  ra: number;
  dec: number;
  distKm: number;
}

// ----- The qibla -------------------------------------------------------------------------------

const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Initial bearing (degrees from true north, clockwise) of the great circle from (lat, lon) to the Kaaba. */
export function qiblaBearing(lat: number, lon: number): number {
  const p1 = lat * DEG;
  const p2 = KAABA.lat * DEG;
  const dl = (KAABA.lon - lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) / DEG);
}

/** Great-circle distance (km) from (lat, lon) to the Kaaba on a sphere of radius `radiusKm`. */
export function qiblaDistanceKm(lat: number, lon: number, radiusKm: number): number {
  return centralAngleDeg(lat, lon, KAABA.lat, KAABA.lon) * DEG * radiusKm;
}

/** The angle at the Earth's centre between two places, degrees (haversine: steady for small angles). */
export function centralAngleDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const s = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(s)))) / DEG;
}

/**
 * `count` points (lat, lon pairs, degrees) along the great circle from (lat, lon) to the Kaaba, both
 * ends included: evenly spaced, or (`ends`) gathered toward both ends, so the path stays continuous
 * when the view closes in on either.
 */
export function qiblaPath(lat: number, lon: number, count: number, ends = false): number[] {
  const a = unit(lat, lon);
  const b = unit(KAABA.lat, KAABA.lon);
  const omega = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const out: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const u = count > 1 ? k / (count - 1) : 0;
    const f = ends ? (1 - Math.cos(Math.PI * u)) / 2 : u;
    // Spherical interpolation (at the Kaaba itself, or opposite it, the path is a point).
    const s = Math.sin(omega);
    const wa = s > 1e-12 ? Math.sin((1 - f) * omega) / s : 1 - f;
    const wb = s > 1e-12 ? Math.sin(f * omega) / s : f;
    const x = wa * a[0] + wb * b[0];
    const y = wa * a[1] + wb * b[1];
    const z = wa * a[2] + wb * b[2];
    out.push(Math.atan2(z, Math.hypot(x, y)) / DEG, Math.atan2(y, x) / DEG);
  }
  return out;
}

const unit = (lat: number, lon: number): [number, number, number] => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];

/** Of 16 compass points, the one a bearing is nearest (0 north, 1 north-northeast, ... 15 north-northwest). */
export const compassPoint = (bearingDeg: number): number => Math.round(wrap360(bearingDeg) / 22.5) % 16;

// ----- The golden latitude ---------------------------------------------------------------------

/** The golden ratio, (1 + sqrt 5) / 2. */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** WGS 84's third flattening n = f / (2 - f), for the meridian's length. */
const N3 = EARTH_F / (2 - EARTH_F);

/**
 * The length of the meridian from the equator to a latitude (km) on the WGS 84 ellipsoid (Helmert's
 * series in the third flattening; good to well under a millimetre).
 */
export function meridianArcKm(latDeg: number): number {
  const n = N3;
  const p = latDeg * DEG;
  const scale = (EARTH_A_KM / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  return (
    scale *
    (p -
      ((3 / 2) * n - (9 / 16) * n ** 3) * Math.sin(2 * p) +
      ((15 / 16) * n * n - (15 / 32) * n ** 4) * Math.sin(4 * p) -
      ((35 / 48) * n ** 3) * Math.sin(6 * p) +
      ((315 / 512) * n ** 4) * Math.sin(8 * p))
  );
}

/** The meridian from the equator to a pole, km (WGS 84). */
export const QUARTER_MERIDIAN_KM = meridianArcKm(90);

/** Along its meridian, a place's distance to the South Pole over its distance to the North Pole. */
export const meridianRatio = (latDeg: number): number => (QUARTER_MERIDIAN_KM + meridianArcKm(latDeg)) / (QUARTER_MERIDIAN_KM - meridianArcKm(latDeg));

/**
 * The northern latitude that divides the meridian from pole to pole in the golden ratio (degrees):
 * where the distance to the South Pole is the golden ratio times the distance to the North Pole.
 * On a sphere it would be 90 (phi - 1) / (phi + 1) degrees; on the ellipsoid it is found by bisection.
 */
export function goldenLatitude(): number {
  const target = QUARTER_MERIDIAN_KM / GOLDEN_RATIO ** 3;
  let lo = 0;
  let hi = 45;
  for (let k = 0; k < 60; k += 1) {
    const m = (lo + hi) / 2;
    if (meridianArcKm(m) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// ----- The Sun and the Moon --------------------------------------------------------------------

/** Greenwich mean sidereal time (radians) at a UT Julian date (IAU 1982; UT1 taken as UTC). */
export function gmst(jdUt: number): number {
  const d = jdUt - 2451545;
  const t = d / 36525;
  return wrap360(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000) * DEG;
}

/** A J2000 ecliptic vector (km) as right ascension and declination of date (radians) and distance. */
function ofDate(x: number, y: number, z: number, eps: number, jdTt: number, out: Place): Place {
  // Ecliptic to equator, J2000.
  const xe = x;
  const ye = y * Math.cos(eps) - z * Math.sin(eps);
  const ze = y * Math.sin(eps) + z * Math.cos(eps);
  const r = Math.hypot(xe, ye, ze);
  const a0 = Math.atan2(ye, xe);
  const d0 = Math.asin(ze / r);
  // Precession to the date (Lieske et al. 1977, as in Meeus, Astronomical Algorithms, ch. 21).
  const t = (jdTt - 2451545) / 36525;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * ARCSEC;
  const zz = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * ARCSEC;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * ARCSEC;
  const A = Math.cos(d0) * Math.sin(a0 + zeta);
  const B = Math.cos(theta) * Math.cos(d0) * Math.cos(a0 + zeta) - Math.sin(theta) * Math.sin(d0);
  const C = Math.sin(theta) * Math.cos(d0) * Math.cos(a0 + zeta) + Math.cos(theta) * Math.sin(d0);
  out.ra = wrapTau(Math.atan2(A, B) + zz);
  out.dec = Math.asin(Math.max(-1, Math.min(1, C)));
  out.distKm = r;
  return out;
}

const wrapTau = (a: number): number => ((a % TAU) + TAU) % TAU;
/** An angle folded into (-pi, pi]. */
const wrapPi = (a: number): number => a - TAU * Math.floor((a + Math.PI) / TAU);

const scratch = { x: 0, y: 0, z: 0 };

/** The Sun's apparent geocentric ecliptic longitude (J2000 ecliptic, radians) and its J2000 vector, km. */
function sunEcliptic(sky: SkyFrame, jdTdb: number, out: { x: number; y: number; z: number }): number {
  sky.ephemeris.earthKm(jdTdb, scratch);
  const x = -scratch.x;
  const y = -scratch.y;
  const z = -scratch.z;
  const r = Math.hypot(x, y, z);
  // Back along the ecliptic by the aberration and light-time (scaled by the distance in au).
  const lon = Math.atan2(y, x) - SUN_ABERRATION / (r / sky.ephemeris.constants.auKm);
  const rho = Math.hypot(x, y);
  out.x = rho * Math.cos(lon);
  out.y = rho * Math.sin(lon);
  out.z = z;
  return lon;
}

/** The Sun's apparent geocentric place of date at a UTC Julian date. */
export function sunPlace(sky: SkyFrame, jdUtc: number, out: Place = { ra: 0, dec: 0, distKm: 0 }): Place {
  const jdTdb = utcToTdb(jdUtc, sky.time);
  const v = { x: 0, y: 0, z: 0 };
  sunEcliptic(sky, jdTdb, v);
  return ofDate(v.x, v.y, v.z, sky.obliquityRad, jdTdb, out);
}

/** The Moon's geocentric place of date at a UTC Julian date. */
export function moonPlace(sky: SkyFrame, jdUtc: number, out: Place = { ra: 0, dec: 0, distKm: 0 }): Place {
  const jdTdb = utcToTdb(jdUtc, sky.time);
  sky.ephemeris.moonKm(jdTdb, scratch);
  return ofDate(scratch.x, scratch.y, scratch.z, sky.obliquityRad, jdTdb, out);
}

/** Altitude and azimuth (degrees; azimuth from true north, clockwise) of a place on the sky for an observer. */
export function horizontal(p: Place, lat: number, lon: number, jdUtc: number): { alt: number; az: number } {
  const h = gmst(jdUtc) + lon * DEG - p.ra;
  const phi = lat * DEG;
  const sinAlt = Math.sin(phi) * Math.sin(p.dec) + Math.cos(phi) * Math.cos(p.dec) * Math.cos(h);
  const az = Math.atan2(-Math.sin(h) * Math.cos(p.dec), Math.cos(phi) * Math.sin(p.dec) - Math.sin(phi) * Math.cos(p.dec) * Math.cos(h));
  return { alt: Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG, az: wrap360(az / DEG) };
}

/** The Moon's horizontal parallax (radians) at a distance (km). */
export const moonParallax = (distKm: number): number => Math.asin(Math.min(1, EARTH_A_KM / distKm));

/** The Moon's place seen from a point on the Earth's surface (topocentric), from its geocentric place. */
export function topocentric(p: Place, lat: number, lon: number, jdUtc: number): Place {
  // The observer's geocentric position (km, equator of date) on the WGS 84 ellipsoid, at sea level.
  const phi = lat * DEG;
  const u = Math.atan((1 - EARTH_F) * Math.tan(phi));
  const rhoCos = Math.cos(u);
  const rhoSin = (1 - EARTH_F) * Math.sin(u);
  const lst = gmst(jdUtc) + lon * DEG;
  const ox = EARTH_A_KM * rhoCos * Math.cos(lst);
  const oy = EARTH_A_KM * rhoCos * Math.sin(lst);
  const oz = EARTH_A_KM * rhoSin;
  const x = p.distKm * Math.cos(p.dec) * Math.cos(p.ra) - ox;
  const y = p.distKm * Math.cos(p.dec) * Math.sin(p.ra) - oy;
  const z = p.distKm * Math.sin(p.dec) - oz;
  const r = Math.hypot(x, y, z);
  return { ra: wrapTau(Math.atan2(y, x)), dec: Math.asin(z / r), distKm: r };
}

/** The angle between two places on the sky, degrees. */
export function separationDeg(a: Place, b: Place): number {
  const c = Math.sin(a.dec) * Math.sin(b.dec) + Math.cos(a.dec) * Math.cos(b.dec) * Math.cos(a.ra - b.ra);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

// ----- New moons -------------------------------------------------------------------------------

/** The Moon's geocentric ecliptic longitude less the Sun's apparent one (radians, folded into (-pi, pi]). */
function elongationLon(sky: SkyFrame, jdUtc: number): number {
  const jdTdb = utcToTdb(jdUtc, sky.time);
  const sun = { x: 0, y: 0, z: 0 };
  const lonSun = sunEcliptic(sky, jdTdb, sun);
  sky.ephemeris.moonKm(jdTdb, scratch);
  return wrapPi(Math.atan2(scratch.y, scratch.x) - lonSun);
}

/** New moons (UTC Julian dates of geocentric conjunction in ecliptic longitude) from `fromJd` to `toJd`, in order. */
export function newMoons(sky: SkyFrame, fromJd: number, toJd: number): number[] {
  const out: number[] = [];
  const stepDays = 0.5;
  let t0 = fromJd;
  let f0 = elongationLon(sky, t0);
  while (t0 < toJd) {
    const t1 = Math.min(toJd, t0 + stepDays);
    const f1 = elongationLon(sky, t1);
    // The Moon passes the Sun: the difference rises through zero (not the jump at full moon).
    if (f0 < 0 && f1 >= 0 && f1 - f0 < Math.PI) {
      let a = t0;
      let b = t1;
      for (let k = 0; k < 40 && b - a > 1e-6; k += 1) {
        const m = (a + b) / 2;
        if (elongationLon(sky, m) < 0) a = m;
        else b = m;
      }
      out.push((a + b) / 2);
    }
    t0 = t1;
    f0 = f1;
  }
  return out;
}

// ----- The Sun over the Kaaba ------------------------------------------------------------------

export interface KaabaSun {
  /** 'over': the Sun at the Kaaba's zenith; 'opposite': at the zenith of the point opposite it on the Earth. */
  kind: 'over' | 'opposite';
  /** The transit (UTC Julian date) on the day it comes nearest the zenith, and how near (degrees). */
  jdUtc: number;
  zenithDeg: number;
}

/** When the Sun crosses the meridian of a longitude near a UTC Julian date (hour angle zero), by iteration. */
function transit(sky: SkyFrame, lon: number, guess: number): number {
  let t = guess;
  const p: Place = { ra: 0, dec: 0, distKm: 0 };
  for (let k = 0; k < 6; k += 1) {
    sunPlace(sky, t, p);
    const h = wrapPi(gmst(t) + lon * DEG - p.ra);
    t -= h / (TAU * 1.00273790935);
  }
  return t;
}

/**
 * The Sun over the Kaaba and over its opposite point between two UTC Julian dates: for each, the
 * day whose transit comes nearest the zenith, kept where that is within a degree (twice a year each).
 */
export function kaabaSuns(sky: SkyFrame, fromJd: number, toJd: number): KaabaSun[] {
  const out: KaabaSun[] = [];
  const spots = [
    { kind: 'over' as const, lat: KAABA.lat, lon: KAABA.lon },
    { kind: 'opposite' as const, lat: -KAABA.lat, lon: KAABA.lon - 180 },
  ];
  const p: Place = { ra: 0, dec: 0, distKm: 0 };
  for (const spot of spots) {
    // Daily transits, the zenith distance at each; a day nearer than both neighbours is an event.
    const first = Math.floor(fromJd - 0.5) + 0.5 - spot.lon / 360;
    const days: Array<{ jd: number; z: number }> = [];
    for (let d = first - 1; d <= toJd + 1; d += 1) {
      const jd = transit(sky, spot.lon, d + 0.5);
      sunPlace(sky, jd, p);
      days.push({ jd, z: Math.abs(spot.lat - p.dec / DEG) });
    }
    for (let k = 1; k + 1 < days.length; k += 1) {
      const d = days[k];
      const before = days[k - 1];
      const after = days[k + 1];
      if (!d || !before || !after) continue;
      if (d.z < 1 && d.z <= before.z && d.z < after.z && d.jd >= fromJd && d.jd <= toJd) out.push({ kind: spot.kind, jdUtc: d.jd, zenithDeg: d.z });
    }
  }
  return out.sort((a, b) => a.jdUtc - b.jdUtc);
}

// ----- The new crescent (Yallop) ---------------------------------------------------------------

/** Yallop's zone for a value of q. */
export function yallopZone(q: number): CrescentZone {
  for (const [zone, above] of YALLOP_ZONES) if (q > above) return zone;
  return 'F';
}

/** Yallop's q from the geocentric, airless altitude difference (degrees) and the topocentric crescent width (arcminutes). */
export function yallopQ(arcvDeg: number, widthArcmin: number): number {
  const w = widthArcmin;
  return (arcvDeg - (11.8371 - 6.3226 * w + 0.7319 * w * w - 0.1018 * w * w * w)) / 10;
}

export interface CrescentAt {
  zone: CrescentZone | CrescentNone;
  /** Yallop's q (null without a zone) and its inputs at the best time. */
  q: number | null;
  sunsetJd: number | null;
  moonsetJd: number | null;
  bestJd: number | null;
  /** Geocentric altitude difference and elongation (degrees), topocentric crescent width (arcminutes), the Moon's age at sunset (hours). */
  arcvDeg: number;
  arclDeg: number;
  widthArcmin: number;
  ageHours: number;
}

/**
 * The Sun and the Moon over a span of UTC Julian dates, sampled every `stepDays` and interpolated
 * between: the map's thousands of places then cost a little arithmetic each, not an ephemeris each.
 */
export interface SkyTrack {
  sun(jdUtc: number, out: Place): Place;
  moon(jdUtc: number, out: Place): Place;
}

export function skyTrack(sky: SkyFrame, fromJd: number, toJd: number, stepDays = 1 / 144): SkyTrack {
  const n = Math.ceil((toJd - fromJd) / stepDays) + 1;
  const sunRows = new Float64Array(n * 3);
  const moonRows = new Float64Array(n * 3);
  const p: Place = { ra: 0, dec: 0, distKm: 0 };
  for (let k = 0; k < n; k += 1) {
    const jd = fromJd + k * stepDays;
    sunPlace(sky, jd, p);
    sunRows.set([p.ra, p.dec, p.distKm], k * 3);
    moonPlace(sky, jd, p);
    moonRows.set([p.ra, p.dec, p.distKm], k * 3);
  }
  const at = (rows: Float64Array, jd: number, out: Place): Place => {
    const f = Math.min(n - 1.000001, Math.max(0, (jd - fromJd) / stepDays));
    const i = Math.floor(f);
    const w = f - i;
    const ra0 = rows[i * 3] ?? 0;
    // Right ascension wraps at 2 pi: step across it the short way.
    const ra1 = ra0 + wrapPi((rows[i * 3 + 3] ?? 0) - ra0);
    out.ra = wrapTau(ra0 + (ra1 - ra0) * w);
    out.dec = (rows[i * 3 + 1] ?? 0) + ((rows[i * 3 + 4] ?? 0) - (rows[i * 3 + 1] ?? 0)) * w;
    out.distKm = (rows[i * 3 + 2] ?? 0) + ((rows[i * 3 + 5] ?? 0) - (rows[i * 3 + 2] ?? 0)) * w;
    return out;
  };
  return { sun: (jd, out) => at(sunRows, jd, out), moon: (jd, out) => at(moonRows, jd, out) };
}

/** The UTC span a map of the evening of a date needs (every longitude's sunset and moonset that evening). */
export const eveningSpan = (dateJd0: number): [number, number] => [dateJd0 - 0.25, dateJd0 + 1.75];

/**
 * When a body sets to an altitude (degrees, geocentric) nearest a guess: its hour angle at that
 * altitude, the clock moved to meet it, a few times over (Meeus, ch. 15, iterated). Null where it
 * never comes that low, or never that high, on that day.
 */
function setting(place: (jd: number) => Place, altitudeDeg: (p: Place) => number, lat: number, lon: number, guess: number): number | null {
  const phi = lat * DEG;
  let t = guess;
  for (let k = 0; k < 6; k += 1) {
    const p = place(t);
    const c = (Math.sin(altitudeDeg(p) * DEG) - Math.sin(phi) * Math.sin(p.dec)) / (Math.cos(phi) * Math.cos(p.dec));
    if (c < -1 || c > 1) return null;
    const hourAngle = wrapPi(gmst(t) + lon * DEG - p.ra);
    t += wrapPi(Math.acos(c) - hourAngle) / (TAU * 1.00273790935);
  }
  return t;
}

/** The altitude of the Moon's centre (geocentric, degrees) when it sets: 0.7275 of its horizontal parallax, less the refraction. */
const moonSetAltitude = (p: Place): number => ((1 - MOON_SD_PER_PARALLAX) * moonParallax(p.distKm)) / DEG - MOON_REFRACTION_DEG;

/**
 * The new crescent's visibility for a place on the local evening of a date (`dateJd0`: that date's
 * 0h UTC as a Julian date), by Yallop's test, after the conjunction at `conjunctionJd`.
 */
export function crescentAt(track: SkyTrack, lat: number, lon: number, dateJd0: number, conjunctionJd: number): CrescentAt {
  const none = (zone: CrescentNone, sunsetJd: number | null, moonsetJd: number | null, ageHours: number): CrescentAt => ({ zone, q: null, sunsetJd, moonsetJd, bestJd: null, arcvDeg: 0, arclDeg: 0, widthArcmin: 0, ageHours });
  if (Math.abs(lat) > YALLOP_MAX_LAT) return none('high-latitude', null, null, 0);
  const sun: Place = { ra: 0, dec: 0, distKm: 0 };
  const moon: Place = { ra: 0, dec: 0, distKm: 0 };
  // That date's sunset, nearest six in the evening local mean time.
  const sunset = setting((jd) => track.sun(jd, sun), () => SUNSET_ALT_DEG, lat, lon, dateJd0 + 0.75 - lon / 360);
  if (sunset === null) return none('no-sunset', null, null, 0);
  const ageHours = (sunset - conjunctionJd) * 24;
  if (ageHours < 0) return none('before-new-moon', sunset, null, ageHours);
  // The moonset nearest the sunset: before it, the crescent is already down.
  const moonset = setting((jd) => track.moon(jd, moon), moonSetAltitude, lat, lon, sunset);
  if (moonset === null || moonset <= sunset) return none('moon-sets-first', sunset, moonset, ageHours);
  const best = sunset + (4 / 9) * (moonset - sunset);
  track.sun(best, sun);
  track.moon(best, moon);
  const s = horizontal(sun, lat, lon, best);
  const m = horizontal(moon, lat, lon, best);
  const arcv = m.alt - s.alt;
  const arcl = separationDeg(sun, moon);
  // The topocentric semi-diameter (arcminutes): the geocentric one enlarged by the Moon's nearness to the observer.
  const parallax = moonParallax(moon.distKm);
  const sd = (MOON_SD_PER_PARALLAX * parallax * 60) / DEG;
  const sdTopo = sd * (1 + Math.sin(m.alt * DEG) * Math.sin(parallax));
  const width = sdTopo * (1 - Math.cos(arcl * DEG));
  const q = yallopQ(arcv, width);
  return { zone: yallopZone(q), q, sunsetJd: sunset, moonsetJd: moonset, bestJd: best, arcvDeg: arcv, arclDeg: arcl, widthArcmin: width, ageHours };
}
