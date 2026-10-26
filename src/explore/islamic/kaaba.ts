/**
 * The Kaaba's position and the qibla's great-circle bearing (docs/ISLAMIC-ASTRONOMY.md), in a module
 * of their own so the walk can give the qibla on foot without the rest of ./astronomy.
 */

const DEG = Math.PI / 180;
const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** The Kaaba: Wikidata Q29466, coordinate location (P625), retrieved 2026-10-26 (CC0). */
export const KAABA = { qid: 'Q29466', lat: 21.4225, lon: 39.826166666667 } as const;

/** Initial bearing (degrees from true north, clockwise) of the great circle from (lat, lon) to the Kaaba. */
export function qiblaBearing(lat: number, lon: number): number {
  const p1 = lat * DEG;
  const p2 = KAABA.lat * DEG;
  const dl = (KAABA.lon - lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) / DEG);
}
