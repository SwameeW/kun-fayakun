import { Group, MathUtils, Vector3 } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel, SceneScale, Vec3 } from '../../core/types';
import { createGalaxySprites, type GalaxySprites } from '../shared/galaxy-sprites';
import contentJson from './content.json';
import { createHorizon, type Horizon } from './horizon';
import { createMilkyWay, type MilkyWay } from './milky-way';

/**
 * Chapter 5, "Seven heavens and the galaxies": from an artist's model of our own galaxy
 * the view draws back through five powers of ten, until the Milky Way is one point of
 * light among the real galaxies of the Sloan Digital Sky Survey, each at its measured
 * position and reddened by its measured redshift. It then closes in on the nearer part
 * of the map and brightens one slice along the celestial equator, where the cosmic web
 * shows plainest (the Sloan Great Wall runs across it); at the end the whole survey is set
 * inside the limit of the observable universe. Scale changes by resizing the world (a
 * logarithmic zoom), so the camera never travels far and the HUD scale bar stays true.
 * With reduced motion the first, fastest pull-back becomes a dissolve. Nothing here
 * depicts or identifies the seven heavens.
 */

const content = contentJson as unknown as ChapterContent;

const KPC_IN_METRES = 3.085677581491367e19;
const KPC_PER_MPC = 1000;
const LIGHT_YEAR_IN_METRES = 9.4607304725808e15;
/** Kiloparsecs per world unit: our galaxy, the whole survey, its nearer part, the observable universe. */
const KPC_PER_UNIT = { galaxy: 5, survey: 8e5, web: 1e5, horizon: 3.9e6 } as const;
const LOG = {
  galaxy: Math.log10(KPC_PER_UNIT.galaxy),
  survey: Math.log10(KPC_PER_UNIT.survey),
  web: Math.log10(KPC_PER_UNIT.web),
  horizon: Math.log10(KPC_PER_UNIT.horizon),
} as const;
const PULL_SECONDS = 24;
/** Reduced motion: the galaxy fades out and the survey fades in at its own scale, this long after `pull-back`. */
const DISSOLVE_SECONDS = 5;
/** Closing in on the nearer survey, the slice brightening, and the last pull-back to the horizon. */
const WEB = { start: 40, seconds: 16 } as const;
/** The slice is picked out first (everything else dims), then the near part's light comes up inside it. */
const SLICE = { in: 40, full: 48, out: 90, gone: 94 } as const;
const WEB_LIGHT_TIMES = { in: 45, full: 54 } as const;
const HORIZON = { start: 93, seconds: 10 } as const;
/**
 * The slice: galaxies within SLICE_HALF_MPC of the celestial equator's plane (normal = the
 * north celestial pole in this galactic frame), the classic SDSS equatorial slice.
 */
const CELESTIAL_POLE: Vec3 = [-0.4838, 0.456, -0.747];
const SLICE_HALF_MPC = 25;
/** The densest stretch of the Sloan Great Wall in this sample (comoving Mpc), for its tag. */
const GREAT_WALL_MPC: Vec3 = [126, 306.9, 105.7];
/** The Sun is about 8.2 kpc from the Galactic centre (GRAVITY Collaboration 2019); used only to place its tag. */
const SUN_KPC = 8.2;
const SURVEY_COUNT: Readonly<Record<QualityTier, number>> = { high: 420_000, mid: 200_000, low: 90_000 };
const STAR_COUNT: Readonly<Record<QualityTier, number>> = { high: 320_000, mid: 160_000, low: 70_000 };
/**
 * Light per survey galaxy in the whole-survey view: SURVEY_LIGHT when the survey's outline
 * has a radius of SURVEY_REFERENCE_PX CSS pixels, in proportion to its apparent area
 * otherwise, so its surface brightness holds at any size and on any screen; capped while
 * it is larger than the view and each galaxy is seen on its own. In the slice view the same
 * rule with the near part's outline: WEB_LIGHT at a radius of WEB_REFERENCE_PX.
 */
const SURVEY_LIGHT = 0.14;
const SURVEY_REFERENCE_PX = 216;
const SURVEY_LIGHT_MAX = 1.4;
const WEB_LIGHT = 0.5;
const WEB_REFERENCE_PX = 255;
/**
 * The near part (every galaxy below z = nearLimit) is far denser than the far part (one in
 * nine); its light is held down in the whole-survey view so it does not glare.
 */
const NEAR_LIGHT = { survey: 0.03, web: 1 } as const;
const FAR_LIGHT = { survey: 1, web: 0.45 } as const;
/** Distance bins (Mpc) for each part's mean density, the smoothing (bins), and how fully brightness is evened out. */
const DENSITY_BIN_MPC = 25;
const DENSITY_SMOOTH_BINS = 2;
const DENSITY_EVENING = 0.6;

interface SurveyManifest {
  file: string;
  count: number;
  scaleMpc: number;
  redshiftScale: number;
  nearLimit: number;
}

interface Survey {
  positions: Float32Array;
  redshifts: Float32Array;
  nearLimit: number;
}

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

/** The survey sample: int16 positions (Mpc, galactic frame, centred on the Sun) and redshifts. */
async function loadSurvey(ctx: ChapterContext): Promise<Survey> {
  const manifest = await ctx.assets.json<SurveyManifest>('assets/sdss/galaxies.json');
  const buffer = await ctx.assets.binary(`assets/sdss/${manifest.file}`);
  const { count } = manifest;
  if (buffer.byteLength !== count * 8) throw new Error(`SDSS sample: ${buffer.byteLength} bytes, expected ${count * 8}`);
  const view = new DataView(buffer);
  const positions = new Float32Array(count * 3);
  const redshifts = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * 8;
    positions[i * 3] = view.getInt16(o, true) * manifest.scaleMpc;
    positions[i * 3 + 1] = view.getInt16(o + 2, true) * manifest.scaleMpc;
    positions[i * 3 + 2] = view.getInt16(o + 4, true) * manifest.scaleMpc;
    redshifts[i] = view.getInt16(o + 6, true) / manifest.redshiftScale;
  }
  return { positions, redshifts, nearLimit: manifest.nearLimit };
}

/**
 * Brightness weights that even out each part's selection: a flux-limited survey holds
 * far more nearby galaxies per volume than distant ones, so each galaxy is weighted by a
 * power of the inverse of its part's mean density at its distance (smoothed, and
 * interpolated between bins, so no shells show). Then the web, not the selection, sets
 * where the light gathers. Mean weight 1 within each part.
 */
function densityWeights(survey: Survey): Float32Array {
  const { positions, redshifts, nearLimit } = survey;
  const count = redshifts.length;
  const radii = new Float32Array(count);
  let maxRadius = 0;
  for (let i = 0; i < count; i += 1) {
    const r = Math.hypot(positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0);
    radii[i] = r;
    maxRadius = Math.max(maxRadius, r);
  }
  const bins = Math.ceil(maxRadius / DENSITY_BIN_MPC) + 1;
  const weights = new Float32Array(count);
  for (const near of [true, false]) {
    const member = (i: number): boolean => (redshifts[i] ?? 0) < nearLimit === near;
    const counts = new Float64Array(bins);
    let first = bins;
    let last = -1;
    for (let i = 0; i < count; i += 1) {
      if (!member(i)) continue;
      const b = Math.min(bins - 1, Math.floor((radii[i] ?? 0) / DENSITY_BIN_MPC));
      counts[b] = (counts[b] ?? 0) + 1;
      first = Math.min(first, b);
      last = Math.max(last, b);
    }
    if (last < 0) continue;
    // Gaussian smoothing within the part's own range (renormalised at its edges), then per shell volume, in log.
    const logDensity = new Float64Array(bins);
    for (let b = first; b <= last; b += 1) {
      let sum = 0;
      let norm = 0;
      for (let k = -3 * DENSITY_SMOOTH_BINS; k <= 3 * DENSITY_SMOOTH_BINS; k += 1) {
        const j = b + k;
        if (j < first || j > last) continue;
        const g = Math.exp(-0.5 * (k / DENSITY_SMOOTH_BINS) ** 2);
        sum += g * (counts[j] ?? 0);
        norm += g;
      }
      logDensity[b] = Math.log(Math.max(sum / norm, 0.5) / ((b + 0.5) * (b + 0.5)));
    }
    let total = 0;
    let members = 0;
    for (let i = 0; i < count; i += 1) {
      if (!member(i)) continue;
      const x = Math.min(last, Math.max(first, (radii[i] ?? 0) / DENSITY_BIN_MPC - 0.5));
      const b = Math.min(last - 1, Math.floor(x));
      const f = last > b ? Math.min(1, x - b) : 0;
      const log = (logDensity[Math.max(first, b)] ?? 0) * (1 - f) + (logDensity[Math.min(last, b + 1)] ?? 0) * f;
      const w = Math.exp(-DENSITY_EVENING * log);
      weights[i] = w;
      total += w;
      members += 1;
    }
    const mean = total / Math.max(1, members);
    for (let i = 0; i < count; i += 1) if (member(i)) weights[i] = Math.min(4, Math.max(0.15, (weights[i] ?? 0) / mean));
  }
  return weights;
}

export default function create(): ChapterModule {
  const times = {
    pullBack: eventTime(content.cues, 'pull-back', 12),
    survey: eventTime(content.cues, 'survey', 24),
  };
  const root = new Group();
  root.name = 'ch05';
  let ctx: ChapterContext | null = null;
  let milkyWay: MilkyWay | null = null;
  let survey: GalaxySprites | null = null;
  let home: GalaxySprites | null = null;
  let horizon: Horizon | null = null;
  /** Observable radius in kiloparsecs, from the cited constant (billions of light-years). */
  let horizonKpc = 0;
  let surveyGain = 1;
  let surveyRadiusMpc = 1;
  let nearRadiusMpc = 1;
  let nearLimit = 0.1;
  const pole = new Vector3(...CELESTIAL_POLE).normalize();
  const slicePole: Vec3 = [pole.x, pole.y, pole.z];
  // The state the HUD reads, refreshed every update.
  let now = 0;
  let kpc: number = KPC_PER_UNIT.galaxy;
  const silhouette = new Vector3();
  const up = new Vector3();
  const right = new Vector3();
  const toCamera = new Vector3();

  const kpcPerUnit = (t: number, reduced: boolean): number => {
    let u = reduced
      ? t < times.pullBack + DISSOLVE_SECONDS
        ? LOG.galaxy
        : LOG.survey
      : LOG.galaxy + (LOG.survey - LOG.galaxy) * smootherstep(times.pullBack, times.pullBack + PULL_SECONDS, t);
    u += (LOG.web - LOG.survey) * smootherstep(WEB.start, WEB.start + WEB.seconds, t);
    u += (LOG.horizon - LOG.web) * smootherstep(HORIZON.start, HORIZON.start + HORIZON.seconds, t);
    return 10 ** u;
  };

  const setCounts = (tier: QualityTier): void => {
    survey?.setCount(SURVEY_COUNT[tier]);
    milkyWay?.setBudget(STAR_COUNT[tier]);
    if (survey) surveyGain = (survey.total / Math.min(survey.total, SURVEY_COUNT[tier])) ** 0.5;
  };

  return {
    id: 'ch05',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!survey) {
        const [galaxy, sample] = await Promise.all([createMilkyWay(), loadSurvey(c)]);
        milkyWay = galaxy;
        nearLimit = sample.nearLimit;
        surveyRadiusMpc = 0;
        nearRadiusMpc = 0;
        for (let i = 0; i < sample.redshifts.length; i += 1) {
          const r = Math.hypot(sample.positions[i * 3] ?? 0, sample.positions[i * 3 + 1] ?? 0, sample.positions[i * 3 + 2] ?? 0);
          surveyRadiusMpc = Math.max(surveyRadiusMpc, r);
          if ((sample.redshifts[i] ?? 0) < nearLimit) nearRadiusMpc = Math.max(nearRadiusMpc, r);
        }
        survey = createGalaxySprites({ name: 'ch05-survey', positions: sample.positions, redshifts: sample.redshifts, weights: densityWeights(sample) });
        home = createGalaxySprites({ name: 'ch05-home', positions: new Float32Array(3) });
        horizon = createHorizon();
        root.add(milkyWay.object, survey.object, home.object, horizon.object);
        const radius = c.data.constant('universe.observable.radius').value;
        horizonKpc = (radius * 1e9 * LIGHT_YEAR_IN_METRES) / KPC_IN_METRES;
      }
      setCounts(c.quality.tier);
    },

    enter(c) {
      ctx = c;
      setCounts(c.quality.tier);
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !milkyWay || !survey || !home || !horizon) return;
      const reduced = ctx.reducedMotion;
      now = t;
      kpc = kpcPerUnit(t, reduced);
      const distance = Math.max(ctx.camera.position.length(), 1e-3);
      const viewportPx = ctx.renderer.domElement.clientHeight;
      const pxPerUnit = viewportPx / (2 * Math.tan(MathUtils.degToRad(ctx.camera.fov / 2)) * distance);
      const radiusPx = (milkyWay.radiusKpc / kpc) * pxPerUnit;

      const dissolve = reduced ? 1 - smootherstep(times.pullBack, times.pullBack + DISSOLVE_SECONDS * 0.9, t) : 1;
      milkyWay.update({ kpcPerUnit: kpc, brightness: smootherstep(0, 2.5, t) * dissolve, radiusPx, viewportPx });

      // The slice view's share: 0 for the whole survey, 1 while the slice is brightened.
      const leaving = 1 - smootherstep(SLICE.out, SLICE.gone, t);
      const slice = smootherstep(SLICE.in, SLICE.full, t) * leaving;
      const web = smootherstep(WEB_LIGHT_TIMES.in, WEB_LIGHT_TIMES.full, t) * leaving;
      const surveyRadiusPx = ((surveyRadiusMpc * KPC_PER_MPC) / kpc) * pxPerUnit;
      const wholeLight = Math.min(SURVEY_LIGHT_MAX, SURVEY_LIGHT * (surveyRadiusPx / SURVEY_REFERENCE_PX) ** 2);
      const nearRadiusPx = ((nearRadiusMpc * KPC_PER_MPC) / kpc) * pxPerUnit;
      const webLight = Math.min(SURVEY_LIGHT_MAX, WEB_LIGHT * (nearRadiusPx / WEB_REFERENCE_PX) ** 2);
      const perGalaxy = wholeLight + (webLight - wholeLight) * web;

      // Our galaxy as a single point once it is too small to see as a disc; bright while tagged.
      const homeLight = reduced
        ? smootherstep(times.pullBack + DISSOLVE_SECONDS, times.pullBack + DISSOLVE_SECONDS + 2, t)
        : 1 - smootherstep(6, 30, radiusPx);
      const homeBrightness = 2.2 + (perGalaxy - 2.2) * smootherstep(29, 33, t);
      home.update({ scale: 1, brightness: homeLight * homeBrightness, redshiftPerUnit: 0, sizePx: 3.4, referenceDistance: distance });

      const surveyLight = reduced
        ? smootherstep(times.pullBack + DISSOLVE_SECONDS, times.survey + 2, t)
        : smootherstep(times.pullBack + 1, times.pullBack + 9, t);
      survey.update({
        scale: KPC_PER_MPC / kpc,
        brightness: surveyLight * perGalaxy * surveyGain,
        redshiftPerUnit: 0,
        measuredRedshift: 1,
        sizePx: 2.1,
        referenceDistance: distance,
        // Galaxies streaming past the camera grow only a little: hundreds of thousands of large sprites cost too much.
        maxGrowth: 2.5,
        bands: {
          limit: nearLimit,
          below: NEAR_LIGHT.survey + (NEAR_LIGHT.web - NEAR_LIGHT.survey) * web,
          above: FAR_LIGHT.survey + (FAR_LIGHT.web - FAR_LIGHT.survey) * web,
          // While the dense near part is faint (the whole-survey view) a quarter of it carries its light.
          belowKeep: 0.25 + 0.75 * web,
        },
        slab: { normal: slicePole, halfThickness: SLICE_HALF_MPC, outside: 0.05, amount: slice },
      });

      horizon.update({
        radius: horizonKpc / kpc,
        opacity: smootherstep(HORIZON.start + 2, HORIZON.start + 7, t) * 0.9,
      });
    },

    labels(): readonly SceneLabel[] {
      if (!ctx || !milkyWay) return [];
      const camera = ctx.camera;
      const labels: SceneLabel[] = [];
      const sun = smootherstep(4, 6, now) * (1 - smootherstep(10.5, 12.5, now));
      if (sun > 0) labels.push({ id: 'sun', textKey: 'ui.hud.sun', position: [-SUN_KPC / kpc, 0, 0], opacity: sun });
      const start = ctx.reducedMotion ? times.pullBack + DISSOLVE_SECONDS + 0.5 : 15.5;
      const galaxy = smootherstep(start, start + 2, now) * (1 - smootherstep(29, 31.5, now));
      if (galaxy > 0) labels.push({ id: 'milky-way', textKey: 'ui.hud.milkyWay', position: [0, 0, 0], opacity: galaxy });
      const wall = smootherstep(56, 59, now) * (1 - smootherstep(68, 71, now));
      if (wall > 0) {
        const s = KPC_PER_MPC / kpc;
        labels.push({
          id: 'great-wall',
          textKey: 'ui.hud.greatWall',
          position: [GREAT_WALL_MPC[0] * s, GREAT_WALL_MPC[1] * s, GREAT_WALL_MPC[2] * s],
          opacity: wall,
        });
      }
      const edge = smootherstep(HORIZON.start + 5, HORIZON.start + 7, now);
      if (edge > 0) {
        // A point on the shell's outline, up and to the right as seen from the camera (clear of the header).
        const radius = horizonKpc / kpc;
        const d = camera.position.length();
        if (d > radius) {
          toCamera.copy(camera.position).normalize();
          up.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(0.55);
          right.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(0.84);
          up.add(right);
          up.addScaledVector(toCamera, -up.dot(toCamera)).normalize();
          silhouette
            .copy(toCamera)
            .multiplyScalar((radius * radius) / d)
            .addScaledVector(up, radius * Math.sqrt(1 - (radius * radius) / (d * d)));
          labels.push({ id: 'horizon', textKey: 'ui.hud.observable', position: [silhouette.x, silhouette.y, silhouette.z], opacity: edge });
        }
      }
      return labels;
    },

    scale(): SceneScale | null {
      if (!ctx) return null;
      return { metresPerUnit: kpc * KPC_IN_METRES, distance: ctx.camera.position.length() };
    },

    setQuality(profile) {
      setCounts(profile.tier);
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      for (const part of [milkyWay, survey, home, horizon]) {
        if (part) {
          root.remove(part.object);
          part.dispose();
        }
      }
      milkyWay = null;
      survey = null;
      home = null;
      horizon = null;
      ctx = null;
    },
  };
}
