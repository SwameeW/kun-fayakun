import { DAYS_PER_CENTURY, J2000, PLANET_TABLE, positionFromElements, tableRange, type Elements, type JdRange, type MoonFile, type PlanetBody, type Theories, type Vec3 } from './ephemeris';

/**
 * The published analytic theories the explorer uses beyond JPL's tables (./ephemeris): its own lazy
 * chunk, loaded the first time the clock heads for dates outside them. Pure: no three.js, no DOM.
 *
 * The Moon: the truncated ELP-2000/82 of Jean Meeus, "Astronomical Algorithms" (2nd ed., Willmann-
 * Bell, 1998), chapter 47: the fundamental arguments (47.1 to 47.6), the 60 periodic terms of
 * longitude and distance (table 47.A) and 60 of latitude (table 47.B), with the additive terms. They
 * give the geocentric Moon referred to the mean ecliptic and equinox of the date, good to about 10" in
 * longitude and 4" in latitude near the present (a few tens of km); it is turned to the ecliptic and
 * equinox of J2000 (the frame of JPL's files) by the rigorous ecliptic precession of chapter 21
 * (21.5 to 21.7). Time is TDB (Meeus's TD, the same to two milliseconds).
 *
 * The planets: E. M. Standish and J. G. Williams, "Approximate Positions of the Planets" (JPL), Table 2a
 * (Keplerian elements and their rates for 3000 BC to 3000 AD, mean ecliptic and equinox of J2000) with
 * Table 2b's extra terms in the mean anomaly of Jupiter to Neptune (M = L - varpi + b T^2 + c cos(f T)
 * + s sin(f T)), copied number for number from https://ssd.jpl.nasa.gov/planets/approx_pos.html. Its
 * errors are larger than Table 1's (up to a few arcminutes for the outer planets), so Table 1
 * (planets.json) is kept for 1800 to 2050 and blended into Table 2 over its last BLEND_DAYS.
 *
 * Checked against Meeus's worked example 47.a, against the Horizons table where they overlap, and
 * against Horizons vectors from 1600 to 2400 (tests/unit/analytic.spec.ts).
 */

/** The span the explorer shows with these theories (TDB Julian dates): 1600-01-01 to 2400-01-01. */
export const THEORY_RANGE: JdRange = { startJd: 2_305_447.5, endJd: 2_597_641.5 };
/** Days over which the Moon's table hands over to its theory at its ends (five rows), and Table 1 to Table 2 (two years): no jump at either seam. */
export const BLEND_DAYS = 5;
const PLANET_BLEND_DAYS = 730.5;

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;

/** Table 47.A: D, M, M', F, then the coefficients of longitude (1e-6 degree, sine) and distance (1e-3 km, cosine). */
// prettier-ignore
const LR = [
  0, 0, 1, 0, 6288774, -20905355, 2, 0, -1, 0, 1274027, -3699111, 2, 0, 0, 0, 658314, -2955968, 0, 0, 2, 0, 213618, -569925,
  0, 1, 0, 0, -185116, 48888, 0, 0, 0, 2, -114332, -3149, 2, 0, -2, 0, 58793, 246158, 2, -1, -1, 0, 57066, -152138,
  2, 0, 1, 0, 53322, -170733, 2, -1, 0, 0, 45758, -204586, 0, 1, -1, 0, -40923, -129620, 1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755, 2, 0, 0, -2, 15327, 10321, 0, 0, 1, 2, -12528, 0, 0, 0, 1, -2, 10980, 79661,
  4, 0, -1, 0, 10675, -34782, 0, 0, 3, 0, 10034, -23210, 4, 0, -2, 0, 8548, -21636, 2, 1, -1, 0, -7888, 24208,
  2, 1, 0, 0, -6766, 30824, 1, 0, -1, 0, -5163, -8379, 1, 1, 0, 0, 4987, -16675, 2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445, 4, 0, 0, 0, 3861, -11650, 2, 0, -3, 0, 3665, 14403, 0, 1, -2, 0, -2689, -7003,
  2, 0, -1, 2, -2602, 0, 2, -1, -2, 0, 2390, 10056, 1, 0, 1, 0, -2348, 6322, 2, -2, 0, 0, 2236, -9884,
  0, 1, 2, 0, -2120, 5751, 0, 2, 0, 0, -2069, 0, 2, -2, -1, 0, 2048, -4950, 2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0, 4, -1, -1, 0, 1215, -3958, 0, 0, 2, 2, -1110, 0, 3, 0, -1, 0, -892, 3258,
  2, 1, 1, 0, -810, 2616, 4, -1, -2, 0, 759, -1897, 0, 2, -1, 0, -713, -2117, 2, 2, -1, 0, -700, 2354,
  2, 1, -2, 0, 691, 0, 2, -1, 0, -2, 596, 0, 4, 0, 1, 0, 549, -1423, 0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571, 1, 0, -2, 0, -487, -1739, 2, 1, 0, -2, -399, 0, 0, 0, 2, -2, -381, -4421,
  1, 1, 1, 0, 351, 0, 3, 0, -2, 0, -340, 0, 4, 0, -3, 0, 330, 0, 2, -1, 2, 0, 327, 0,
  0, 2, 1, 0, -323, 1165, 1, 1, -1, 0, 299, 0, 2, 0, 3, 0, 294, 0, 2, 0, -1, -2, 0, 8752,
];
/** Table 47.B: D, M, M', F, then the coefficient of latitude (1e-6 degree, sine). */
// prettier-ignore
const B = [
  0, 0, 0, 1, 5128122, 0, 0, 1, 1, 280602, 0, 0, 1, -1, 277693, 2, 0, 0, -1, 173237, 2, 0, -1, 1, 55413,
  2, 0, -1, -1, 46271, 2, 0, 0, 1, 32573, 0, 0, 2, 1, 17198, 2, 0, 1, -1, 9266, 0, 0, 2, -1, 8822,
  2, -1, 0, -1, 8216, 2, 0, -2, -1, 4324, 2, 0, 1, 1, 4200, 2, 1, 0, -1, -3359, 2, -1, -1, 1, 2463,
  2, -1, 0, 1, 2211, 2, -1, -1, -1, 2065, 0, 1, -1, -1, -1870, 4, 0, -1, -1, 1828, 0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749, 0, 1, -1, 1, -1565, 1, 0, 0, 1, -1491, 0, 1, 1, 1, -1475, 0, 1, 1, -1, -1410,
  0, 1, 0, -1, -1344, 1, 0, 0, -1, -1335, 0, 0, 3, 1, 1107, 4, 0, 0, -1, 1021, 4, 0, -1, 1, 833,
  0, 0, 1, -3, 777, 4, 0, -2, 1, 671, 2, 0, 0, -3, 607, 2, 0, 2, -1, 596, 2, -1, 1, -1, 491,
  2, 0, -2, 1, -451, 0, 0, 3, -1, 439, 2, 0, 2, 1, 422, 2, 0, -3, -1, 421, 2, 1, -1, 1, -366,
  2, 1, 0, 1, -351, 4, 0, 0, 1, 331, 2, -1, 1, 1, 315, 2, -2, 0, -1, 302, 0, 0, 1, 3, -283,
  2, 1, 1, -1, -229, 1, 1, 0, -1, 223, 1, 1, 0, 1, 223, 0, 1, -2, -1, -220, 2, 1, -1, -1, -220,
  1, 0, 1, 1, -185, 2, -1, -2, -1, 181, 0, 1, 2, 1, -177, 4, 0, -2, -1, 176, 4, -1, -1, -1, 166,
  1, 0, 1, -1, -164, 4, 0, 1, -1, 132, 1, 0, -1, -1, -119, 4, -1, 0, -1, 115, 2, -2, 0, 1, 107,
];

/** An angle in degrees as radians, reduced to one turn. */
const rad = (deg: number): number => (deg % 360) * DEG;

/**
 * The geocentric Moon referred to the mean ecliptic and equinox of the date (Meeus 47): longitude and
 * latitude (radians) and distance (km).
 */
export function moonOfDate(jdTdb: number): { lon: number; lat: number; distanceKm: number } {
  const T = (jdTdb - J2000) / DAYS_PER_CENTURY;
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000;
  const D = rad(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = rad(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = rad(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = rad(93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = rad(119.75 + 131.849 * T);
  const A2 = rad(53.09 + 479264.29 * T);
  const A3 = rad(313.45 + 481266.484 * T);
  // The Earth's orbit's eccentricity decreasing: terms in M scale by E, in 2M by E^2.
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  let sl = 0;
  let sr = 0;
  let sb = 0;
  for (let k = 0; k < LR.length; k += 6) {
    const m = LR[k + 1] ?? 0;
    const arg = (LR[k] ?? 0) * D + m * M + (LR[k + 2] ?? 0) * Mp + (LR[k + 3] ?? 0) * F;
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sl += (LR[k + 4] ?? 0) * e * Math.sin(arg);
    sr += (LR[k + 5] ?? 0) * e * Math.cos(arg);
  }
  for (let k = 0; k < B.length; k += 5) {
    const m = B[k + 1] ?? 0;
    const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sb += (B[k + 4] ?? 0) * e * Math.sin((B[k] ?? 0) * D + m * M + (B[k + 2] ?? 0) * Mp + (B[k + 3] ?? 0) * F);
  }
  const L = rad(Lp);
  // Venus's action (A1), Jupiter's (A2) and the Earth's flattening (L' - F).
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(L - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(L) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F) + 127 * Math.sin(L - Mp) - 115 * Math.sin(L + Mp);
  return { lon: L + sl * 1e-6 * DEG, lat: sb * 1e-6 * DEG, distanceKm: 385000.56 + sr / 1000 };
}

/**
 * Ecliptic coordinates of the date `jdTdb` turned to the ecliptic and equinox of J2000 (Meeus 21.5 to
 * 21.7, the rigorous reduction, with the date as the starting epoch and J2000 as the final one).
 */
export function eclipticToJ2000(jdTdb: number, lon: number, lat: number): { lon: number; lat: number } {
  const T = (jdTdb - J2000) / DAYS_PER_CENTURY;
  const t = -T;
  const eta = ((47.0029 - 0.06603 * T + 0.000598 * T * T) * t + (-0.03302 + 0.000598 * T) * t * t + 0.00006 * t * t * t) * ARCSEC;
  const Pi = 174.876384 * DEG + (3289.4789 * T + 0.60622 * T * T - (869.8089 + 0.50491 * T) * t + 0.03536 * t * t) * ARCSEC;
  const p = ((5029.0966 + 2.22226 * T - 0.000042 * T * T) * t + (1.11113 - 0.000042 * T) * t * t - 0.000006 * t * t * t) * ARCSEC;
  const a = Math.cos(eta) * Math.cos(lat) * Math.sin(Pi - lon) - Math.sin(eta) * Math.sin(lat);
  const b = Math.cos(lat) * Math.cos(Pi - lon);
  const c = Math.cos(eta) * Math.sin(lat) + Math.sin(eta) * Math.cos(lat) * Math.sin(Pi - lon);
  return { lon: p + Pi - Math.atan2(a, b), lat: Math.asin(Math.max(-1, Math.min(1, c))) };
}

/** The geocentric Moon (km) in the ecliptic and equinox of J2000, from Meeus 47 and 21. */
export function moonMeeusKm<T extends Vec3>(jdTdb: number, out: T): T {
  const date = moonOfDate(jdTdb);
  const { lon, lat } = eclipticToJ2000(jdTdb, date.lon, date.lat);
  const r = date.distanceKm;
  out.x = r * Math.cos(lat) * Math.cos(lon);
  out.y = r * Math.cos(lat) * Math.sin(lon);
  out.z = r * Math.sin(lat);
  return out;
}

/**
 * Table 2a by planet (as planets.json names them): a (au), e, I, L, varpi, Omega (degrees) and their
 * rates per Julian century; then Table 2b's b, c, s, f for Jupiter to Neptune.
 */
// prettier-ignore
const TABLE2: Record<string, readonly number[]> = {
  Mercury: [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819, 0, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182],
  Venus: [0.72332102, 0.00676399, 3.39777545, 181.9797085, 131.76755713, 76.67261496, -0.00000026, -0.00005107, 0.00043494, 58517.8156026, 0.05679648, -0.27274174],
  Earth: [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389, -0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.3179526, -0.24123856],
  Mars: [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984, 0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431],
  Jupiter: [5.20248019, 0.0485359, 1.29861416, 34.33479152, 14.27495244, 100.29282654, -0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619, -0.00012452, 0.0606406, -0.35635438, 38.35125],
  Saturn: [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702, -0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002, 0.00025899, -0.13434469, 0.87320147, 38.35125],
  Uranus: [19.18797948, 0.0468574, 0.77298127, 314.20276625, 172.43404441, 73.96250215, -0.00020455, -0.0000155, -0.00180155, 428.49512595, 0.09266985, 0.05739699, 0.00058331, -0.97731848, 0.17689245, 7.67025],
  Neptune: [30.06952752, 0.00895439, 1.7700552, 304.22289287, 46.68158724, 131.78635853, 0.00006447, 0.00000818, 0.000224, 218.46515314, 0.01009938, -0.00606302, -0.00041348, 0.68346318, -0.10162547, 7.67025],
};

/** A planet's Table 2 elements on a date (a in au, angles in degrees), its mean longitude carrying Table 2b's terms. */
export function table2Elements(name: string, jdTdb: number, out: Elements = { a: 0, e: 0, I: 0, L: 0, varpi: 0, Omega: 0 }): Elements | null {
  const r = TABLE2[name];
  if (!r) return null;
  const T = (jdTdb - J2000) / DAYS_PER_CENTURY;
  const at = (k: number): number => (r[k] ?? 0) + (r[k + 6] ?? 0) * T;
  out.a = at(0);
  out.e = at(1);
  out.I = at(2);
  const f = (r[15] ?? 0) * T * DEG;
  out.L = at(3) + (r[12] ?? 0) * T * T + (r[13] ?? 0) * Math.cos(f) + (r[14] ?? 0) * Math.sin(f);
  out.varpi = at(4);
  out.Omega = at(5);
  return out;
}

/** A planet's heliocentric position (au, ecliptic J2000) from Table 2, or false for a name it does not have. */
export function table2Au(body: PlanetBody, jdTdb: number, out: Vec3): boolean {
  const el = table2Elements(body.name, jdTdb);
  if (!el) return false;
  positionFromElements(el, out);
  return true;
}

/** How far into a table's last stretch a date is: 0 well inside, 1 outside it (where its theory takes over). */
const handover = (jd: number, start: number, end: number, days: number): number => Math.min(1, Math.max(0, 1 - (jd - start) / days, 1 - (end - jd) / days));
const within = (jd: number): number => Math.min(THEORY_RANGE.endJd, Math.max(THEORY_RANGE.startJd, jd));

/** The theories as the ephemeris takes them (installTheories): each table handed over to its theory over its last stretch. */
export const theories: Theories = {
  range: THEORY_RANGE,
  moon(moon: MoonFile, jd: number, out: Vec3, table: (moon: MoonFile, jd: number, out: Vec3) => Vec3): Vec3 {
    const own = tableRange(moon).moon;
    const w = handover(jd, own.startJd, own.endJd, BLEND_DAYS);
    if (w === 0) return table(moon, jd, out);
    const x = moonMeeusKm(within(jd), { x: 0, y: 0, z: 0 });
    if (w < 1) table(moon, jd, out);
    out.x += (x.x - out.x) * w;
    out.y += (x.y - out.y) * w;
    out.z += (x.z - out.z) * w;
    return out;
  },
  elements(body: PlanetBody, jd: number, out: Elements): Elements {
    const w = handover(jd, PLANET_TABLE.startJd, PLANET_TABLE.endJd, PLANET_BLEND_DAYS);
    const far = w > 0 ? table2Elements(body.name, within(jd)) : null;
    // Angles the short way round (the two tables count a planet's mean longitude from different turns).
    if (far) for (const k of ['a', 'e', 'I', 'L', 'varpi', 'Omega'] as const) out[k] += (k === 'a' || k === 'e' ? far[k] - out[k] : ((((far[k] - out[k] + 180) % 360) + 360) % 360) - 180) * w;
    return out;
  },
};
