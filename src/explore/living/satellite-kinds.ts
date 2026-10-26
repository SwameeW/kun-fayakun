/**
 * Kinds of satellite the explorer tells apart, by CelesTrak's names and the orbit's period: crewed
 * stations, the two broadband constellations, the navigation constellations, the geostationary ring
 * (a period of about a sidereal day) and everything else. The kind sets each point's colour and the
 * counts the interface gives; it is a reading of the catalogue's names, not of what each object does.
 */

export const SatelliteKind = { station: 0, starlink: 1, oneweb: 2, navigation: 3, geostationary: 4, other: 5 } as const;
export type SatelliteKind = (typeof SatelliteKind)[keyof typeof SatelliteKind];

export const SATELLITE_KINDS = ['station', 'starlink', 'oneweb', 'navigation', 'geostationary', 'other'] as const;
export type SatelliteKindName = (typeof SATELLITE_KINDS)[number];

/** The crewed stations' catalogue names (the modules that carry the station's elements) and their ids. */
export const STATION_IDS: Readonly<Record<string, StationId>> = { 'ISS (ZARYA)': 'iss', 'CSS (TIANHE)': 'css' };
export type StationId = 'iss' | 'css';
const STATIONS = Object.keys(STATION_IDS);
const NAVIGATION = /^(NAVSTAR|GPS |COSMOS \d+ \(GLONASS|GSAT0|GALILEO|BEIDOU|QZS|IRNSS|NAVIC)/u;
/** Periods within this many minutes of a sidereal day are the geostationary (and geosynchronous) ring. */
const GEO_WITHIN_MINUTES = 30;

/** The kind of a catalogue entry, from its name and period; `siderealMinutes` is the Earth's turn (from its rotation model). */
export function classifySatellite(name: string, periodMinutes: number, siderealMinutes: number): SatelliteKind {
  const n = name.toUpperCase();
  if (STATIONS.includes(n)) return SatelliteKind.station;
  if (n.startsWith('STARLINK')) return SatelliteKind.starlink;
  if (n.startsWith('ONEWEB')) return SatelliteKind.oneweb;
  if (NAVIGATION.test(n)) return SatelliteKind.navigation;
  if (Math.abs(periodMinutes - siderealMinutes) < GEO_WITHIN_MINUTES) return SatelliteKind.geostationary;
  return SatelliteKind.other;
}

/** Display colours (linear, illustrative: satellites are points of reflected sunlight, these only tell kinds apart). */
export const KIND_COLOURS: Readonly<Record<SatelliteKindName, readonly [number, number, number]>> = {
  station: [1, 0.78, 0.38],
  starlink: [0.62, 0.78, 1],
  oneweb: [0.45, 0.95, 0.85],
  navigation: [0.55, 1, 0.55],
  geostationary: [1, 0.66, 0.3],
  other: [0.92, 0.92, 0.95],
};
