/**
 * The explorer's field notes, by Samee: an atlas of places on the Earth worth flying to, and the
 * places tradition associates with the prophets, peace be upon them.
 *
 * Every coordinate is Wikidata's coordinate location (P625) for the item named beside it, retrieved
 * 2026-10-25 (data/sources.json "wikidata-coordinates", CC0); none is typed from memory. `viewKm` is
 * how much ground the explorer frames on arrival: a choice of how to look, not a measurement. Names
 * and notes are in src/i18n (ui.universe.field.*), so the interface can be translated; a test checks
 * every id here has them.
 *
 * The prophets: the 25 the Quran names, in the order they are usually listed. Where most of them
 * lived is known only through later tradition, which often differs. A place is listed only where a
 * tradition is widely held, and each note says so ("by tradition") and states the doubt; for the
 * prophets whose lands traditions place far apart (or not at all), none is. A coordinate places a
 * site; it is not evidence that an event happened there. Nothing here depicts a prophet: the
 * explorer shows only the places, as names on the ground. This list awaits a qualified scholar's
 * review (REVIEW.md).
 */

export interface FieldPlace {
  id: string;
  /** The Wikidata item the coordinates come from. */
  qid: string;
  lat: number;
  lon: number;
  /** Ground framed on arrival, km. */
  viewKm: number;
}

/** Natural wonders, in the order the atlas tour visits them (a path around the world, west to east and back). */
export const ATLAS: readonly FieldPlace[] = [
  { id: 'richat', qid: 'Q744591', lat: 21.124, lon: -11.402, viewKm: 60 },
  { id: 'gibraltar', qid: 'Q36124', lat: 35.9739, lon: -5.5161, viewKm: 60 },
  { id: 'nile-delta', qid: 'Q179528', lat: 30.9, lon: 31.1167, viewKm: 300 },
  { id: 'dallol', qid: 'Q590742', lat: 14.2417, lon: 40.3, viewKm: 15 },
  { id: 'rub-al-khali', qid: 'Q229269', lat: 20.0, lon: 50.0, viewKm: 300 },
  { id: 'palm-jumeirah', qid: 'Q277294', lat: 25.1172, lon: 55.1344, viewKm: 14 },
  { id: 'natron', qid: 'Q838080', lat: -2.4167, lon: 36.0, viewKm: 60 },
  { id: 'kilimanjaro', qid: 'Q7296', lat: -3.0667, lon: 37.3592, viewKm: 40 },
  { id: 'okavango', qid: 'Q650872', lat: -19.4, lon: 22.9, viewKm: 150 },
  { id: 'sossusvlei', qid: 'Q1932730', lat: -24.7398, lon: 15.2876, viewKm: 25 },
  { id: 'everest', qid: 'Q513', lat: 27.9881, lon: 86.925, viewKm: 25 },
  { id: 'sundarbans', qid: 'Q4526', lat: 21.75, lon: 88.75, viewKm: 150 },
  { id: 'baikal', qid: 'Q5513', lat: 53.3028, lon: 108.0047, viewKm: 700 },
  { id: 'lena-delta', qid: 'Q2298744', lat: 72.9648, lon: 126.1853, viewKm: 250 },
  { id: 'fuji', qid: 'Q39231', lat: 35.3606, lon: 138.7275, viewKm: 40 },
  { id: 'uluru', qid: 'Q33910', lat: -25.345, lon: 131.0361, viewKm: 12 },
  { id: 'whitehaven', qid: 'Q2123432', lat: -20.2827, lon: 149.0349, viewKm: 10 },
  { id: 'grand-prismatic', qid: 'Q1422831', lat: 44.525, lon: -110.8381, viewKm: 4 },
  { id: 'grand-canyon', qid: 'Q118841', lat: 36.0975, lon: -112.0953, viewKm: 40 },
  { id: 'exuma', qid: 'Q21713942', lat: 24.25, lon: -76.5, viewKm: 60 },
  { id: 'meeting-of-waters', qid: 'Q656597', lat: -3.1367, lon: -59.9047, viewKm: 30 },
  { id: 'uyuni', qid: 'Q76122', lat: -20.3333, lon: -67.7, viewKm: 150 },
  { id: 'vatnajokull', qid: 'Q179734', lat: 64.4, lon: -16.8, viewKm: 180 },
];

/**
 * The sites the prophets' notes name, in the order their names claim space on the globe (where they
 * crowd, the later give way until the view comes closer). Makkah is framed as its valley among the
 * mountains, never closer.
 */
export const SITES: readonly FieldPlace[] = [
  { id: 'mecca', qid: 'Q5806', lat: 21.4225, lon: 39.8261, viewKm: 60 },
  { id: 'medina', qid: 'Q35484', lat: 24.47, lon: 39.61, viewKm: 40 },
  { id: 'jerusalem', qid: 'Q1218', lat: 31.7767, lon: 35.2342, viewKm: 30 },
  { id: 'judi', qid: 'Q1143135', lat: 37.3775, lon: 42.4543, viewKm: 40 },
  { id: 'shib-hud', qid: 'Q107018348', lat: 16.1035, lon: 49.5682, viewKm: 30 },
  { id: 'hegra', qid: 'Q27356', lat: 26.8142, lon: 37.9475, viewKm: 25 },
  { id: 'harran', qid: 'Q199547', lat: 36.8708, lon: 39.025, viewKm: 30 },
  { id: 'hebron', qid: 'Q204200', lat: 31.5247, lon: 35.1108, viewKm: 25 },
  { id: 'dead-sea', qid: 'Q23883', lat: 31.5207, lon: 35.4845, viewKm: 120 },
  { id: 'bahr-yussef', qid: 'Q803626', lat: 29.2415, lon: 30.9167, viewKm: 60 },
  { id: 'al-bad', qid: 'Q22935639', lat: 28.4947, lon: 35.0122, viewKm: 40 },
  { id: 'sinai', qid: 'Q377485', lat: 28.5384, lon: 33.9752, viewKm: 40 },
  { id: 'jabal-harun', qid: 'Q2900633', lat: 30.317, lon: 35.407, viewKm: 25 },
  { id: 'nineveh', qid: 'Q5680', lat: 36.3667, lon: 43.15, viewKm: 30 },
  { id: 'umayyad-mosque', qid: 'Q183562', lat: 33.5114, lon: 36.3067, viewKm: 25 },
  { id: 'nazareth', qid: 'Q430776', lat: 32.7021, lon: 35.2978, viewKm: 25 },
  { id: 'adams-peak', qid: 'Q60789', lat: 6.8094, lon: 80.4997, viewKm: 30 },
];

export interface Prophet {
  id: string;
  /** SITES ids, in the order the note tells them (empty where traditions differ too widely to mark one). */
  sites: readonly string[];
}

/** The 25 prophets named in the Quran, in their usual order. */
export const PROPHETS: readonly Prophet[] = [
  { id: 'adam', sites: ['adams-peak'] },
  { id: 'idris', sites: [] },
  { id: 'nuh', sites: ['judi'] },
  { id: 'hud', sites: ['shib-hud'] },
  { id: 'salih', sites: ['hegra'] },
  { id: 'ibrahim', sites: ['harran', 'hebron', 'mecca'] },
  { id: 'lut', sites: ['dead-sea'] },
  { id: 'ismail', sites: ['mecca'] },
  { id: 'ishaq', sites: ['hebron'] },
  { id: 'yaqub', sites: ['hebron'] },
  { id: 'yusuf', sites: ['bahr-yussef'] },
  { id: 'ayyub', sites: [] },
  { id: 'shuayb', sites: ['al-bad'] },
  { id: 'musa', sites: ['sinai'] },
  { id: 'harun', sites: ['jabal-harun'] },
  { id: 'dhul-kifl', sites: [] },
  { id: 'dawud', sites: ['jerusalem'] },
  { id: 'sulayman', sites: ['jerusalem'] },
  { id: 'ilyas', sites: [] },
  { id: 'al-yasa', sites: [] },
  { id: 'yunus', sites: ['nineveh'] },
  { id: 'zakariyya', sites: ['jerusalem'] },
  { id: 'yahya', sites: ['umayyad-mosque'] },
  { id: 'isa', sites: ['nazareth', 'jerusalem'] },
  { id: 'muhammad', sites: ['mecca', 'medina'] },
];

/**
 * Around Makkah the explorer never frames the ground closer than this (spec principle 4: the Kaaba
 * is never shown): within `radiusKm` of the city's centre (its Wikidata coordinates, above), a view
 * is at least `minWidthKm` across, so the city is seen as a city in its valley.
 */
export const MAKKAH_FRAME = { radiusKm: 25, minWidthKm: 30 } as const;

export const site = (id: string): FieldPlace | undefined => SITES.find((s) => s.id === id);
