/**
 * The astrolabe's geometry (src/explore/islamic/astrolabe.ts; ledger IA-11), checked against the
 * plate's classic constructions rather than the code's own formulas:
 *
 * - a circle of equal altitude a at latitude phi is the circle centred cos(phi) / (sin(phi) + sin(a))
 *   from the pole along the meridian, of radius cos(a) / (sin(phi) + sin(a)) (the equator's radius 1;
 *   docs/ISLAMIC-ASTRONOMY.md derives both from the projection's meridian points); the horizon's
 *   centre is cot(phi) away, its radius 1 / sin(phi), and it crosses the equator at the east and west
 *   points;
 * - a star lies on the circle of its own altitude, the altitude found by the textbook relation
 *   sin(a) = sin(phi) sin(d) + cos(phi) cos(d) cos(H);
 * - the tropics' radii are tan(45 -+ e / 2), and the ecliptic touches both;
 * - east is on the left and the rete turns clockwise north of the equator, the reverse south of it;
 * - the IAU's mean obliquity at J2000 is 23 degrees 26 minutes 21.448 seconds.
 */
import { expect, test } from '@playwright/test';
import { altitudeOf, foldHour, fromEquator, fromHorizon, meanObliquityDeg, plate, project, rete, type Hemisphere } from '../../src/explore/islamic/astrolabe';

const DEG = Math.PI / 180;
const OBLIQUITY = 23.4392911;
const LATITUDES = [21.4225, 51.4769, 5, 64.1, -33.87];

/**
 * The classic circle of equal altitude (its centre on the meridian line, its radius) for |latitude|.
 * Below the altitude -phi the circle encloses the pole the plate is projected from: the expressions
 * turn negative, the centre on the far side of the plate's pole, the radius their magnitude.
 */
const circleOf = (latDeg: number, altDeg: number): { y: number; r: number } => {
  const f = Math.abs(latDeg) * DEG;
  const a = altDeg * DEG;
  return { y: Math.cos(f) / (Math.sin(f) + Math.sin(a)), r: Math.abs(Math.cos(a) / (Math.sin(f) + Math.sin(a))) };
};

test('circles of equal altitude are the classic ones; the horizon crosses the equator at the east and west points', () => {
  for (const lat of LATITUDES) {
    const h: Hemisphere = lat < 0 ? -1 : 1;
    for (const alt of [0, 10, 30, 60, -18]) {
      const c = circleOf(lat, alt);
      for (let az = 0; az < 360; az += 17) {
        const p = project(fromHorizon(alt, az, lat), h);
        if (!p) continue;
        expect(Math.hypot(p.x, p.y - c.y) / c.r).toBeCloseTo(1, 9);
      }
    }
    const p = plate(lat, OBLIQUITY);
    // The horizon: centre cot(phi), radius 1 / sin(phi), through the east and west points of the equator.
    const f = Math.abs(lat) * DEG;
    for (const run of p.horizon) for (const q of run) expect(Math.hypot(q.x, q.y - 1 / Math.tan(f)) * Math.sin(f)).toBeCloseTo(1, 9);
    expect(p.east.x).toBeCloseTo(-h, 9);
    expect(p.west.x).toBeCloseTo(h, 9);
    expect(p.east.y).toBeCloseTo(0, 9);
    // The zenith on the meridian, tan(45 - phi / 2) from the pole.
    expect(p.zenith.x).toBeCloseTo(0, 9);
    expect(p.zenith.y).toBeCloseTo(Math.tan((45 - Math.abs(lat) / 2) * DEG), 9);
  }
});

test('a star lies on the circle of its own altitude (the textbook relation), wherever the rete is turned', () => {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let k = 0; k < 400; k += 1) {
    const lat = LATITUDES[k % LATITUDES.length] ?? 0;
    const dec = -23 + 113 * rand() * (lat < 0 ? -1 : 1);
    const hour = 360 * rand() - 180;
    const f = lat * DEG;
    const d = dec * DEG;
    const alt = Math.asin(Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(hour * DEG)) / DEG;
    expect(altitudeOf(dec, hour, lat)).toBeCloseTo(alt, 9);
    const p = project(fromEquator(dec, hour), lat < 0 ? -1 : 1);
    const c = circleOf(lat, alt);
    if (!p || !Number.isFinite(c.r) || c.r > 1e6) continue;
    expect(Math.hypot(p.x, p.y - c.y) / c.r).toBeCloseTo(1, 7);
  }
});

test('the tropics and the ecliptic: the radii tan(45 -+ e / 2), the ecliptic touching both', () => {
  const north = plate(30, OBLIQUITY);
  // The Tropic of Capricorn is the plate's edge in the north, 1.5235 times the equator; Cancer 0.6564.
  expect(north.edge).toBeCloseTo(Math.tan((45 + OBLIQUITY / 2) * DEG), 12);
  expect(north.edge).toBeCloseTo(1.5235, 4);
  expect(north.tropic).toBeCloseTo(0.6564, 4);
  const south = plate(-30, OBLIQUITY);
  expect(south.edge).toBeCloseTo(north.edge, 12);
  expect(south.tropic).toBeCloseTo(north.tropic, 12);
  for (const [lat, p] of [[30, north], [-30, south]] as const) {
    const r = rete(lat, 123, OBLIQUITY, { raDeg: 0, decDeg: 0 }, []);
    const radii = r.ecliptic.flat().map((q) => Math.hypot(q.x, q.y));
    expect(Math.min(...radii)).toBeCloseTo(p.tropic, 3);
    expect(Math.max(...radii)).toBeCloseTo(p.edge, 3);
  }
});

test('east on the left and turning clockwise in the north, the reverse in the south; stars beyond the edge left off', () => {
  const star = { name: 'test', raDeg: 100, decDeg: 10, vmag: 1 };
  // Two hours before it crosses the meridian (hour angle -30) and two after (+30).
  const before = (lat: number) => rete(lat, 70, OBLIQUITY, { raDeg: 0, decDeg: 0 }, [star]).stars[0]?.at;
  const after = (lat: number) => rete(lat, 130, OBLIQUITY, { raDeg: 0, decDeg: 0 }, [star]).stars[0]?.at;
  expect(before(40)?.x ?? 0).toBeLessThan(0);
  expect(after(40)?.x ?? 0).toBeGreaterThan(0);
  // Over the top from left to right: clockwise.
  expect(before(40)?.y ?? 0).toBeGreaterThan(0);
  expect(before(-40)?.x ?? 0).toBeGreaterThan(0);
  expect(after(-40)?.x ?? 0).toBeLessThan(0);
  // A star south of the Tropic of Capricorn is off a northern plate, on a southern one.
  const deep = { name: 'deep', raDeg: 0, decDeg: -50, vmag: 1 };
  expect(rete(40, 0, OBLIQUITY, { raDeg: 0, decDeg: 0 }, [deep]).stars).toHaveLength(0);
  expect(rete(-40, 0, OBLIQUITY, { raDeg: 0, decDeg: 0 }, [deep]).stars).toHaveLength(1);
  expect(foldHour(190)).toBeCloseTo(-170, 12);
  expect(foldHour(-190)).toBeCloseTo(170, 12);
});

test('the mean obliquity of the ecliptic: 23 degrees 26 minutes 21.448 seconds at J2000, less 46.8 seconds a century', () => {
  expect(meanObliquityDeg(2451545)).toBeCloseTo(23 + 26 / 60 + 21.448 / 3600, 12);
  expect((meanObliquityDeg(2451545 + 36525) - meanObliquityDeg(2451545)) * 3600).toBeCloseTo(-46.815 - 0.00059 + 0.001813, 6);
});
