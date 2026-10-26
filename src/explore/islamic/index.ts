import { Vector3, type Object3D } from 'three/webgpu';
import type { CrescentCriterion, CrescentZoneName, SceneLabel, UniverseCrescent, UniverseIslamic, UniverseIslamicCommand } from '../../core/types';
import { bodyFrame } from '../living/quakes';
import {
  compassPoint,
  crescentAt,
  eveningSpan,
  GOLDEN_RATIO,
  goldenLatitude,
  KAABA,
  kaabaSuns,
  meridianArcKm,
  meridianRatio,
  newMoons,
  qiblaBearing,
  qiblaDistanceKm,
  qiblaPath,
  skyTrack,
  YALLOP_MAX_LAT,
  type CrescentAt,
  type KaabaSun,
  type OdehZone,
  type SkyFrame,
  type SkyTrack,
} from './astronomy';
import { createIslamicLayer, type MarkSet } from './layer';

/**
 * The qibla and the new moon in the explorer (its own chunk, loaded when their section first opens):
 * the qibla from the point beneath the camera or a chosen place, drawn as a great circle on the
 * globe; the golden latitude beside the Kaaba's; the next times the Sun stands over the Kaaba or the
 * point opposite it; the new moons; and the new crescent's map for the evenings after one, by Yallop's
 * test or Odeh's (both are worked out for every place; choosing between them recolours the map). All of it
 * comes from ./astronomy and the explorer's ephemeris; the map is computed a few milliseconds a frame,
 * so the view never stalls. Nothing here shows the Kaaba itself: it is a point the lines end at.
 */

export interface IslamicFrame {
  /** The date shown (UTC Julian date). */
  jdUtc: number;
  earth: { x: number; y: number; z: number };
  basis: readonly number[];
  earthRadiusKm: number;
  /** Near the real Earth (not in an experiment): the marks are drawn. */
  visible: boolean;
  /** The point on the Earth beneath the camera (degrees), or null with the Earth out of view. */
  below: { lat: number; lon: number } | null;
}

export interface Islamic {
  readonly objects: readonly Object3D[];
  command(c: UniverseIslamicCommand): void;
  update(frame: IslamicFrame): void;
  view(): UniverseIslamic;
  labels(out: SceneLabel[]): void;
  dispose(): void;
}

const UNIX_EPOCH_JD = 2440587.5;
const msOf = (jd: number): number => (jd - UNIX_EPOCH_JD) * 86_400_000;
/** The map's grid step and how far from the equator it reaches (degrees). */
const MAP_STEP_DEG = 2;
/** The map's dots (px). */
const MAP_DOT_PX = 3.5;
/** Milliseconds of map a frame may compute. */
const MAP_BUDGET_MS = 4;
/** A new moon older than this (days) gives way to the next as the one shown by default. */
const LATEST_FOR_DAYS = 3;
/** A new moon the visitor stepped to stays chosen while the date shown is within this many days of it. */
const PINNED_FOR_DAYS = 120;
/** Zone colours (display terms, legible over day and night): A green through E red; F grey. */
const ZONE_RGB: Readonly<Record<CrescentZoneName, readonly [number, number, number]>> = {
  A: [0.36, 0.86, 0.5],
  B: [0.74, 0.88, 0.36],
  C: [0.98, 0.82, 0.32],
  D: [0.98, 0.58, 0.26],
  E: [0.93, 0.34, 0.32],
  F: [0.56, 0.57, 0.63],
};
/** Odeh's zones in the colours of Yallop's nearest in meaning: A and B as Yallop's; C (optical aid only) as D; D (not even with it) as E. */
const ODEH_RGB: Readonly<Record<OdehZone, readonly [number, number, number]>> = { A: ZONE_RGB.A, B: ZONE_RGB.B, C: ZONE_RGB.D, D: ZONE_RGB.E };
const QIBLA_RGB = [0.98, 0.82, 0.48] as const;
const GOLDEN_RGB = [1, 0.78, 0.22] as const;
const KAABA_LAT_RGB = [0.78, 0.9, 1] as const;
/** Points along each mark (gathered where the view may close in). */
const PATH_POINTS = 1400;
const LINE_POINTS = 2001;
/** The labels on the two latitudes show only this near (km from the camera): far out they would sit on each other. */
const LATITUDE_LABELS_WITHIN_KM = 4000;
/** How far east of the Kaaba (degrees of longitude) the two latitudes are named. */
const LATITUDE_LABEL_EAST_DEG = 0.15;

const zero = (): Record<CrescentZoneName | 'none', number> => ({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, none: 0 });

/** A circle of latitude as points, gathered toward the Kaaba's longitude (where the view comes close). */
function latitudeLine(lat: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < LINE_POINTS; k += 1) {
    const u = (2 * k) / (LINE_POINTS - 1) - 1;
    out.push(lat, KAABA.lon + 180 * u * u * u);
  }
  return out;
}

export function createIslamic(sky: SkyFrame, meanRadiusKm: number): Islamic {
  const layer = createIslamicLayer();
  const golden = goldenLatitude();
  const goldenView = { latDeg: golden, kaabaLatDeg: KAABA.lat, kaabaLonDeg: KAABA.lon, kaabaRatio: meridianRatio(KAABA.lat), kaabaNorthKm: meridianArcKm(KAABA.lat) - meridianArcKm(golden), ratio: GOLDEN_RATIO };

  let chosen: { lat: number; lon: number; name: string } | null = null;
  let below: { lat: number; lon: number } | null = null;
  let line = false;
  let goldenOn = false;
  let jdNow = 0;
  let frameNow: IslamicFrame | null = null;

  // The qibla (and its drawn path) for the place it is reckoned from, recomputed when that moves.
  let qiblaFor: { lat: number; lon: number } | null = null;
  let qibla: UniverseIslamic['qibla'] = null;

  // The Sun over the Kaaba: events found over a span, refound when the date leaves it.
  let suns: KaabaSun[] = [];
  let sunsSpan: [number, number] = [0, 0];

  // New moons around the date shown (for the Moon's age now); the list browsed (it starts as that one),
  // and the new moon chosen in it (pinned once the visitor steps to another).
  let around: number[] = [];
  let aroundSpan: [number, number] = [0, 0];
  let moons: number[] = [];
  let moonIndex = -1;
  let moonPinned = false;

  // The crescent map: an evening after the chosen new moon, its track, the job filling it, and the result.
  let evening: 0 | 1 | 2 | null = null;
  let track: SkyTrack | null = null;
  let mapFor = '';
  let criterion: CrescentCriterion = 'yallop';
  /** The places with a crescent (lat, lon pairs) and their zones by each test; the counts by each. */
  interface MapResult {
    points: number[];
    yallop: CrescentZoneName[];
    odeh: OdehZone[];
    counts: Record<CrescentCriterion, ReturnType<typeof zero>>;
  }
  let job: (MapResult & { row: number; col: number }) | null = null;
  // The finished map, kept so a change of test only recolours it.
  let result: MapResult | null = null;
  let crescent: UniverseCrescent | null = null;
  let hereFor = '';

  const place = (): { lat: number; lon: number; name: string | null } | null => chosen ?? (below ? { ...below, name: null } : null);

  const refreshQibla = (): void => {
    const p = place();
    if (!p) {
      qibla = null;
      qiblaFor = null;
      layer.set('path', null);
      return;
    }
    if (!qibla || !qiblaFor || Math.abs(qiblaFor.lat - p.lat) > 0.01 || Math.abs(qiblaFor.lon - p.lon) > 0.01 || qibla.from.name !== p.name) {
      qiblaFor = { lat: p.lat, lon: p.lon };
      const bearing = qiblaBearing(p.lat, p.lon);
      qibla = { from: { lat: p.lat, lon: p.lon, name: p.name }, bearingDeg: bearing, compass: compassPoint(bearing), distanceKm: qiblaDistanceKm(p.lat, p.lon, meanRadiusKm), line };
      layer.set('path', line ? { points: qiblaPath(p.lat, p.lon, PATH_POINTS, true), colors: QIBLA_RGB, sizePx: 3 } : null);
    }
    qibla.line = line;
  };

  const refreshSuns = (): void => {
    if (jdNow >= sunsSpan[0] && jdNow <= sunsSpan[1] - 200) return;
    sunsSpan = [jdNow - 1, jdNow + 400];
    suns = kaabaSuns(sky, sunsSpan[0], sunsSpan[1]);
  };

  const refreshMoons = (): void => {
    // New moons around the date shown, found again when it leaves the span searched.
    if (!(jdNow > aroundSpan[0] + 35 && jdNow < aroundSpan[1] - 35)) {
      aroundSpan = [jdNow - 70, jdNow + 70];
      around = newMoons(sky, aroundSpan[0], aroundSpan[1]);
    }
    // One the visitor stepped to stays chosen until the date shown moves far from it.
    const pinned = moons[moonIndex];
    if (moonPinned && pinned !== undefined && Math.abs(pinned - jdNow) <= PINNED_FOR_DAYS) return;
    moonPinned = false;
    moons = around;
    // By default the latest new moon, or the next once the latest is more than a few days old.
    let latest = -1;
    moons.forEach((m, i) => {
      if (m <= jdNow) latest = i;
    });
    moonIndex = Math.min(moons.length - 1, latest >= 0 && jdNow - (moons[latest] ?? 0) <= LATEST_FOR_DAYS ? latest : latest + 1);
    startMap();
  };

  const dateJd0 = (): number | null => {
    const conj = moons[moonIndex];
    if (conj === undefined || evening === null) return null;
    return Math.floor(conj - 0.5) + 0.5 + evening;
  };

  const startMap = (): void => {
    const d0 = dateJd0();
    const conj = moons[moonIndex];
    if (d0 === null || conj === undefined) {
      job = null;
      result = null;
      crescent = null;
      mapFor = '';
      layer.set('map', null);
      return;
    }
    const key = `${conj}:${d0}`;
    if (key === mapFor) return;
    mapFor = key;
    hereFor = '';
    const [from, to] = eveningSpan(d0);
    track = skyTrack(sky, from, to);
    job = { row: 0, col: 0, points: [], yallop: [], odeh: [], counts: { yallop: zero(), odeh: zero() } };
    crescent = { evening: evening ?? 0, dateMs: msOf(d0), progress: 0, counts: zero(), here: null };
    result = null;
    layer.set('map', null);
  };

  const showMap = (): void => {
    if (!result || !crescent) return;
    const colors: number[] = [];
    if (criterion === 'odeh') for (const zone of result.odeh) colors.push(...ODEH_RGB[zone]);
    else for (const zone of result.yallop) colors.push(...ZONE_RGB[zone]);
    crescent.counts = { ...result.counts[criterion] };
    // Small enough that the land shows between them.
    const marks: MarkSet = { points: result.points, colors, sizePx: MAP_DOT_PX };
    layer.set('map', marks);
  };

  const rows = Math.floor((2 * 60) / MAP_STEP_DEG) + 1;
  const cols = Math.floor(360 / MAP_STEP_DEG);

  const work = (): void => {
    const d0 = dateJd0();
    const conj = moons[moonIndex];
    if (!job || !track || d0 === null || conj === undefined || !crescent) return;
    const started = performance.now();
    while (job.row < rows && performance.now() - started < MAP_BUDGET_MS) {
      const lat = -60 + job.row * MAP_STEP_DEG;
      const lon = -180 + job.col * MAP_STEP_DEG;
      const r = crescentAt(track, lat, lon, d0, conj);
      if ((r.zone === 'A' || r.zone === 'B' || r.zone === 'C' || r.zone === 'D' || r.zone === 'E' || r.zone === 'F') && r.odeh !== null) {
        job.counts.yallop[r.zone] += 1;
        job.counts.odeh[r.odeh] += 1;
        job.points.push(lat, lon);
        job.yallop.push(r.zone);
        job.odeh.push(r.odeh);
      } else {
        job.counts.yallop.none += 1;
        job.counts.odeh.none += 1;
      }
      job.col += 1;
      if (job.col >= cols) {
        job.col = 0;
        job.row += 1;
      }
    }
    crescent.progress = Math.min(1, (job.row * cols + job.col) / (rows * cols));
    if (job.row >= rows) {
      result = { points: job.points, yallop: job.yallop, odeh: job.odeh, counts: job.counts };
      job = null;
      showMap();
    }
  };

  const refreshHere = (): void => {
    const d0 = dateJd0();
    const conj = moons[moonIndex];
    const p = place();
    if (!crescent || !track || d0 === null || conj === undefined || !p) {
      if (crescent) crescent.here = null;
      return;
    }
    const key = `${mapFor}:${criterion}:${p.lat.toFixed(2)}:${p.lon.toFixed(2)}`;
    if (key === hereFor) return;
    hereFor = key;
    const r: CrescentAt = crescentAt(track, p.lat, p.lon, d0, conj);
    crescent.here = {
      zone: criterion === 'odeh' && r.odeh !== null ? r.odeh : r.zone,
      q: r.q,
      v: r.v,
      sunsetMs: r.sunsetJd === null ? null : msOf(r.sunsetJd),
      bestMs: r.bestJd === null ? null : msOf(r.bestJd),
      moonsetMs: r.moonsetJd === null ? null : msOf(r.moonsetJd),
      ageHours: r.ageHours,
    };
  };

  const setLines = (): void => {
    layer.set(
      'lines',
      goldenOn
        ? (() => {
            const g = latitudeLine(golden);
            const k = latitudeLine(KAABA.lat);
            const colors: number[] = [];
            for (let i = 0; i < g.length / 2; i += 1) colors.push(...GOLDEN_RGB);
            for (let i = 0; i < k.length / 2; i += 1) colors.push(...KAABA_LAT_RGB);
            return { points: [...g, ...k], colors, sizePx: 3 };
          })()
        : null,
    );
  };

  const toWorld = (lat: number, lon: number, frame: IslamicFrame, out: Vector3): Vector3 => {
    bodyFrame(lat, lon, frame.earthRadiusKm * 1.0008, out);
    const m = frame.basis;
    return out.set(
      frame.earth.x + out.x * (m[0] ?? 1) + out.y * (m[3] ?? 0) + out.z * (m[6] ?? 0),
      frame.earth.y + out.x * (m[1] ?? 0) + out.y * (m[4] ?? 1) + out.z * (m[7] ?? 0),
      frame.earth.z + out.x * (m[2] ?? 0) + out.y * (m[5] ?? 0) + out.z * (m[8] ?? 1),
    );
  };
  /** Faces the camera (at the origin): never a label through the planet. */
  const facing = (v: Vector3, frame: IslamicFrame): boolean => (v.x - frame.earth.x) * v.x + (v.y - frame.earth.y) * v.y + (v.z - frame.earth.z) * v.z < 0;

  return {
    objects: layer.objects,
    command(c) {
      switch (c.kind) {
        case 'open':
          break;
        case 'qiblaFrom':
          if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) chosen = { lat: c.lat, lon: c.lon, name: c.name.slice(0, 80) };
          break;
        case 'qiblaFromBelow':
          chosen = null;
          break;
        case 'qiblaLine':
          line = c.on;
          qiblaFor = null;
          break;
        case 'golden':
          goldenOn = c.on;
          setLines();
          break;
        case 'newMoon': {
          const target = moons[moonIndex + c.step];
          if (target === undefined) break;
          moonPinned = true;
          // Near the ends of the list found, find again around the one chosen.
          if (moonIndex + c.step <= 0 || moonIndex + c.step >= moons.length - 1) moons = newMoons(sky, target - 70, target + 70);
          moonIndex = moons.findIndex((m) => Math.abs(m - target) < 0.01);
          startMap();
          break;
        }
        case 'evening':
          evening = c.evening;
          startMap();
          break;
        case 'criterion':
          criterion = c.criterion === 'odeh' ? 'odeh' : 'yallop';
          showMap();
          break;
      }
      refreshQibla();
    },
    update(frame) {
      frameNow = frame;
      jdNow = frame.jdUtc;
      below = frame.below;
      refreshQibla();
      refreshSuns();
      refreshMoons();
      work();
      refreshHere();
      layer.update({ earth: frame.earth, basis: frame.basis, earthRadiusKm: frame.earthRadiusKm, visible: frame.visible });
    },
    view() {
      const latest = [...around].reverse().find((m) => m <= jdNow);
      const conj = moons[moonIndex];
      return {
        qibla,
        golden: { on: goldenOn, ...goldenView },
        kaabaSun: suns
          .filter((s) => s.jdUtc >= jdNow - 1 / 1440)
          .slice(0, 4)
          .map((s) => ({ kind: s.kind, unixMs: msOf(s.jdUtc), lat: s.kind === 'over' ? KAABA.lat : -KAABA.lat, lon: s.kind === 'over' ? KAABA.lon : KAABA.lon - 180, zenithDeg: s.zenithDeg })),
        newMoon:
          conj === undefined
            ? null
            : {
                unixMs: msOf(conj),
                previousMs: moons[moonIndex - 1] === undefined ? null : msOf(moons[moonIndex - 1] ?? 0),
                nextMs: moons[moonIndex + 1] === undefined ? null : msOf(moons[moonIndex + 1] ?? 0),
                ageHours: latest === undefined ? null : (jdNow - latest) * 24,
              },
        criterion,
        crescent: crescent ? { ...crescent, counts: { ...crescent.counts } } : null,
        marks: layer.counts(),
      };
    },
    labels(out) {
      const frame = frameNow;
      if (!frame?.visible) return;
      const v = new Vector3();
      const p = place();
      if (line && p && qibla) {
        toWorld(p.lat, p.lon, frame, v);
        if (facing(v, frame)) out.push({ id: 'qibla-from', textKey: 'ui.universe.islamic.qiblaLabel', position: [v.x, v.y, v.z], opacity: 0.95, offset: [12, -12] });
      }
      if (goldenOn) {
        for (const [id, lat, key] of [
          ['golden-latitude', golden, 'ui.universe.islamic.goldenLabel'],
          ['kaaba-latitude', KAABA.lat, 'ui.universe.islamic.kaabaLatLabel'],
        ] as const) {
          // East of the Kaaba, where the view's middle is (the readout and panel take the sides).
          toWorld(lat, KAABA.lon + LATITUDE_LABEL_EAST_DEG, frame, v);
          if (facing(v, frame) && v.length() < LATITUDE_LABELS_WITHIN_KM) out.push({ id, textKey: key, position: [v.x, v.y, v.z], opacity: 0.9, offset: [8, lat === golden ? 12 : -12] });
        }
      }
    },
    dispose() {
      layer.dispose();
    },
  };
}

/** Whether a latitude is one the crescent map covers (for the interface's note). */
export const mapCovers = (lat: number): boolean => Math.abs(lat) <= Math.min(60, YALLOP_MAX_LAT);
