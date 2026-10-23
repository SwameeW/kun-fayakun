import { Group } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier } from '../../core/types';
import { clusteredField, createGalaxySprites, type GalaxySprites } from '../shared/galaxy-sprites';
import contentJson from './content.json';

/**
 * Chapter 4, "A vast heaven": the camera stands among the galaxies as space stretches.
 * Every galaxy recedes from the viewer, the farther the faster (Hubble's law), and its
 * light reddens with distance from wherever the camera is, so there is no special centre:
 * this is not an explosion into empty space but space itself growing. The panel's
 * "stretch space" slider takes over the scale factor (onInteract); "back to the film"
 * returns it.
 */

const content = contentJson as unknown as ChapterContent;

/** Comoving radius of the field of galaxies, and galaxies drawn per tier. */
const FIELD_RADIUS = 40;
const COUNT: Readonly<Record<QualityTier, number>> = { high: 120_000, mid: 50_000, low: 20_000 };
const FIELD_SEED = 51_047;
/** Scale factor: 1 until `stretch`, then up to STRETCH.formed over STRETCH.seconds, then onward slowly. */
const STRETCH = { formed: 1.8, final: 2.1, seconds: 30 } as const;
/** Reddening once `redshift` arrives: redshift per world unit of distance (about z = 1 at 60 units). */
const REDSHIFT_PER_UNIT = 0.017;
const REDSHIFT_SECONDS = 6;
/** The slider's scale factor is followed with this time constant (seconds), so it never jumps. */
const FOLLOW_SECONDS = 0.25;

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

export default function create(): ChapterModule {
  const times = {
    stretch: eventTime(content.cues, 'stretch', 13),
    redshift: eventTime(content.cues, 'redshift', 50),
  };
  const root = new Group();
  root.name = 'ch04';
  let ctx: ChapterContext | null = null;
  let galaxies: GalaxySprites | null = null;
  /** Scale factor asked for by the slider (null: the film drives it), and the eased value shown. */
  let manual: number | null = null;
  let shown = 1;

  const filmScale = (t: number, reduced: boolean): number => {
    const pace = reduced ? 1.2 : 1;
    const formed = smootherstep(times.stretch, times.stretch + STRETCH.seconds * pace, t);
    const tail = Math.max(0, (t - times.stretch - STRETCH.seconds) / Math.max(1, content.duration - times.stretch - STRETCH.seconds));
    return 1 + (STRETCH.formed - 1) * formed + (STRETCH.final - STRETCH.formed) * Math.min(1, tail);
  };

  return {
    id: 'ch04',
    content,
    cues: content.cues,

    load(c) {
      ctx = c;
      if (!galaxies) {
        galaxies = createGalaxySprites({ name: 'ch04-galaxies', positions: clusteredField(COUNT.high, FIELD_RADIUS, FIELD_SEED) });
        root.add(galaxies.object);
      }
      galaxies.setCount(COUNT[c.quality.tier]);
      return Promise.resolve();
    },

    enter(c) {
      ctx = c;
      manual = null;
      galaxies?.setCount(COUNT[c.quality.tier]);
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t, dt) {
      if (!ctx || !galaxies) return;
      const reduced = ctx.reducedMotion;
      const goal = manual ?? filmScale(t, reduced);
      // Follow the slider smoothly; the film's own curve is already smooth, so it is used as is.
      shown = manual === null ? goal : shown + (goal - shown) * (1 - Math.exp(-Math.max(dt, 1 / 120) / FOLLOW_SECONDS));
      const reddening = manual === null ? smootherstep(times.redshift, times.redshift + REDSHIFT_SECONDS, t) : Math.min(1, (shown - 1) / 1.2);
      galaxies.update({
        scale: shown,
        brightness: smootherstep(0, 3, t) * 2.4,
        redshiftPerUnit: REDSHIFT_PER_UNIT * reddening,
        sizePx: 5,
        referenceDistance: 24,
      });
    },

    onInteract(id, value) {
      if (id === 'stretch') manual = value;
    },

    setQuality(profile) {
      galaxies?.setCount(COUNT[profile.tier]);
    },

    exit() {
      root.removeFromParent();
      manual = null;
    },

    dispose() {
      root.removeFromParent();
      if (galaxies) {
        root.remove(galaxies.object);
        galaxies.dispose();
        galaxies = null;
      }
      ctx = null;
    },
  };
}
