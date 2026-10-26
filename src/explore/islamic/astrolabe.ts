/**
 * An astrolabe for the place in view (ledger IA-11, docs/ISLAMIC-ASTRONOMY.md, "The astrolabe"): the
 * sky drawn flat the way the instrument draws it, by stereographic projection from the celestial pole
 * below the horizon onto the plane of the equator, seen from outside the sky's sphere. In the polar
 * aspect (Snyder 1987, Map Projections: A Working Manual, USGS Professional Paper 1395, eq. 21-33) a
 * declination d lies tan(45 - d / 2) from the centre, the equator's radius taken as 1.
 *
 * The plate holds what is fixed for the observer: the tropics and the equator, the horizon, circles
 * of equal altitude every 10 degrees above it (the almucantars), the circle 18 degrees below it, and
 * lines of equal azimuth every 30 degrees from the horizon to the zenith. The rete holds the sky: the
 * ecliptic and the stars, turned by the local sidereal time, with the Sun on the ecliptic; the rule,
 * from the centre through the Sun, reads its hour. North of the equator east is on the left and the
 * rete turns clockwise, as on the instrument. South of it the plate is drawn about the south pole,
 * projected from the north and seen from outside the sphere: east on the right, turning anticlockwise.
 *
 * Pure: points on the plate (x to the right, y up toward the meridian's southern half; the equator's
 * radius 1), for src/ui/explore/islamic-panel.ts and the tests.
 */

export type Vec3 = readonly [number, number, number];

export interface PlatePoint {
  x: number;
  y: number;
}

/** The pole the plate is drawn about: 1 the north (projected from the south), -1 the south. */
export type Hemisphere = 1 | -1;

const DEG = Math.PI / 180;
/** Points along each circle drawn. */
const SAMPLES = 240;
/** Parts of a line farther out than this many plate radii are left off (the plate is clipped to its edge anyway). */
const FAR = 4;

export const hemisphereOf = (latDeg: number): Hemisphere => (latDeg < 0 ? -1 : 1);

/**
 * A direction on the sky in the observer's equatorial frame (x toward the meridian on the equator, y
 * toward the east point, z toward the north celestial pole) from a declination and an hour angle
 * (degrees, growing westward).
 */
export function fromEquator(decDeg: number, hourDeg: number): Vec3 {
  const d = decDeg * DEG;
  const h = hourDeg * DEG;
  return [Math.cos(d) * Math.cos(h), -Math.cos(d) * Math.sin(h), Math.sin(d)];
}

/** The same direction from an altitude and an azimuth (degrees; azimuth from north toward east) at a latitude. */
export function fromHorizon(altDeg: number, azDeg: number, latDeg: number): Vec3 {
  const a = altDeg * DEG;
  const az = azDeg * DEG;
  const f = latDeg * DEG;
  const east = Math.cos(a) * Math.sin(az);
  const north = Math.cos(a) * Math.cos(az);
  const up = Math.sin(a);
  return [up * Math.cos(f) - north * Math.sin(f), east, north * Math.cos(f) + up * Math.sin(f)];
}

/** A direction's point on the plate; null at the pole it is projected from. */
export function project(v: Vec3, hemisphere: Hemisphere): PlatePoint | null {
  const w = 1 + hemisphere * v[2];
  if (w < 1e-12) return null;
  return { x: (-hemisphere * v[1]) / w, y: v[0] / w };
}

/** The radius of a circle of declination on the plate. */
export const declinationRadius = (decDeg: number, hemisphere: Hemisphere): number => Math.tan((45 - (hemisphere * decDeg) / 2) * DEG);

/**
 * The mean obliquity of the ecliptic of date (degrees) at a TT Julian date: the IAU's 1976 expression
 * (Meeus, Astronomical Algorithms, 2nd ed., eq. 22.2).
 */
export function meanObliquityDeg(jdTt: number): number {
  const t = (jdTt - 2451545) / 36525;
  return 23 + 26 / 60 + (21.448 - 46.815 * t - 0.00059 * t * t + 0.001813 * t * t * t) / 3600;
}

/** Points broken into runs where they leave the plate's neighbourhood (or reach the pole projected from). */
function runs(points: ReadonlyArray<PlatePoint | null>, limit: number): PlatePoint[][] {
  const out: PlatePoint[][] = [];
  let run: PlatePoint[] = [];
  for (const p of points) {
    if (p && Math.hypot(p.x, p.y) <= limit) run.push(p);
    else {
      if (run.length > 1) out.push(run);
      run = [];
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

export interface Plate {
  hemisphere: Hemisphere;
  /** Radii: the plate's edge (the tropic farther from the pole), the equator, the nearer tropic. */
  edge: number;
  equator: number;
  tropic: number;
  /** The horizon; circles of equal altitude every 10 degrees above it; the circle 18 degrees below it. */
  horizon: PlatePoint[][];
  almucantars: PlatePoint[][];
  twilight: PlatePoint[][];
  /** Lines of equal azimuth every 30 degrees, from the horizon up to the zenith. */
  azimuths: PlatePoint[][];
  zenith: PlatePoint;
  east: PlatePoint;
  west: PlatePoint;
}

/** The plate for a latitude (degrees) and an obliquity of the ecliptic (degrees). */
export function plate(latDeg: number, obliquityDeg: number): Plate {
  const hemisphere = hemisphereOf(latDeg);
  const edge = declinationRadius(-hemisphere * obliquityDeg, hemisphere);
  const limit = edge * FAR;
  const almucantar = (alt: number): PlatePoint[][] => runs(Array.from({ length: SAMPLES + 1 }, (_, k) => project(fromHorizon(alt, (360 * k) / SAMPLES, latDeg), hemisphere)), limit);
  const at = (alt: number, az: number): PlatePoint => project(fromHorizon(alt, az, latDeg), hemisphere) ?? { x: 0, y: 0 };
  const azimuths: PlatePoint[][] = [];
  for (let az = 0; az < 360; az += 30) azimuths.push(...runs(Array.from({ length: 91 }, (_, k) => project(fromHorizon(k, az, latDeg), hemisphere)), limit));
  return {
    hemisphere,
    edge,
    equator: 1,
    tropic: declinationRadius(hemisphere * obliquityDeg, hemisphere),
    horizon: almucantar(0),
    almucantars: [10, 20, 30, 40, 50, 60, 70, 80].flatMap(almucantar),
    twilight: almucantar(-18),
    azimuths,
    zenith: at(90, 0),
    east: at(0, 90),
    west: at(0, 270),
  };
}

export interface ReteStar {
  name: string;
  vmag: number;
  at: PlatePoint;
}

export interface Rete {
  ecliptic: PlatePoint[][];
  stars: ReteStar[];
  /** The Sun on the plate (null beyond its edge: never, between the tropics). */
  sun: PlatePoint | null;
}

/** Right ascension and declination (degrees) of a point of the ecliptic (longitude, degrees; latitude 0). */
export function eclipticToEquator(lonDeg: number, obliquityDeg: number): { raDeg: number; decDeg: number } {
  const l = lonDeg * DEG;
  const e = obliquityDeg * DEG;
  return { raDeg: Math.atan2(Math.sin(l) * Math.cos(e), Math.cos(l)) / DEG, decDeg: Math.asin(Math.sin(e) * Math.sin(l)) / DEG };
}

/**
 * The rete turned to a local sidereal time (degrees): the ecliptic, the stars on the plate (those
 * within its edge) and the Sun, each at its hour angle (the sidereal time less its right ascension).
 */
export function rete(latDeg: number, lstDeg: number, obliquityDeg: number, sun: { raDeg: number; decDeg: number }, stars: ReadonlyArray<{ name: string; raDeg: number; decDeg: number; vmag: number }>): Rete {
  const hemisphere = hemisphereOf(latDeg);
  const edge = declinationRadius(-hemisphere * obliquityDeg, hemisphere);
  const place = (raDeg: number, decDeg: number): PlatePoint | null => project(fromEquator(decDeg, lstDeg - raDeg), hemisphere);
  const ecliptic = runs(
    Array.from({ length: SAMPLES + 1 }, (_, k) => {
      const q = eclipticToEquator((360 * k) / SAMPLES, obliquityDeg);
      return place(q.raDeg, q.decDeg);
    }),
    edge * FAR,
  );
  const shown: ReteStar[] = [];
  for (const s of stars) {
    const at = place(s.raDeg, s.decDeg);
    if (at && Math.hypot(at.x, at.y) <= edge) shown.push({ name: s.name, vmag: s.vmag, at });
  }
  return { ecliptic, stars: shown, sun: place(sun.raDeg, sun.decDeg) };
}

/** Altitude (degrees) of a declination and hour angle at a latitude. */
export function altitudeOf(decDeg: number, hourDeg: number, latDeg: number): number {
  const d = decDeg * DEG;
  const f = latDeg * DEG;
  return Math.asin(Math.max(-1, Math.min(1, Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(hourDeg * DEG)))) / DEG;
}

/** An hour angle folded into [-180, 180) degrees. */
export const foldHour = (hourDeg: number): number => ((((hourDeg + 180) % 360) + 360) % 360) - 180;
