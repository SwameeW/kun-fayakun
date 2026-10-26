/**
 * Places of astronomy and geometry in the Islamic world, for the qibla and new moon's panel to fly
 * to: each coordinate is Wikidata's coordinate location (P625) for the item named beside it, retrieved
 * 2026-10-26 (data/sources.json "wikidata-coordinates", CC0); none is typed from memory. Names and
 * notes are in src/i18n/en.explore.json (ui.universe.islamic.heritage.*), with their sources there and
 * in docs/ISLAMIC-ASTRONOMY.md. `viewKm` is how much ground to frame on arrival, a choice of view.
 */

export interface HeritagePlace {
  id: string;
  /** The Wikidata item the coordinates come from. */
  qid: string;
  lat: number;
  lon: number;
  viewKm: number;
}

/** In the order of their dates. */
export const HERITAGE: readonly HeritagePlace[] = [
  { id: 'raqqa', qid: 'Q283368', lat: 35.95, lon: 39.01, viewKm: 40 },
  { id: 'isfahan', qid: 'Q42053', lat: 32.6525, lon: 51.67472222222222, viewKm: 40 },
  { id: 'maragheh', qid: 'Q2461462', lat: 37.39586111111111, lon: 46.20927777777778, viewKm: 25 },
  { id: 'samarkand', qid: 'Q608580', lat: 39.674722222222, lon: 67.005555555556, viewKm: 25 },
  { id: 'darb-i-imam', qid: 'Q1165662', lat: 32.66888888888889, lon: 51.677166666666665, viewKm: 20 },
  { id: 'istanbul', qid: 'Q3348357', lat: 41.03006, lon: 28.98281, viewKm: 25 },
];
