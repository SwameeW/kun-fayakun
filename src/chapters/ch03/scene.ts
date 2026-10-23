import { Group } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, Cue } from '../../core/types';
import contentJson from './content.json';
import { createFirstStars, createWebParticles, type FirstStars, type WebParticles } from './web';
import { createWebField } from './zeldovich';

/**
 * Chapter 3, "The dark ages and the first stars": darkness after the first light;
 * dark matter (shown in false colour) draws together into a web of sheets, filaments
 * and knots, grown by the Zel'dovich approximation; the first stars ignite in the
 * densest knots, highest peaks first, each swelling softly (never a flash); then the
 * first galaxies gather around them. Every picture is a function of chapter time.
 */

const content = contentJson as unknown as ChapterContent;

/** Periodic box of the web, world units (the camera starts inside it). */
const BOX = 48;
const FIELD = { size: 64, box: BOX, index: -1.8, smoothCells: 1.6, rmsDisplacement: 2.0, peakSigma: 2.4, maxPeaks: 380, seed: 20_260_301 } as const;
/** Growth factor: nearly uniform in the dark ages, the web by about 24 s after `web`, then slowly onward. */
const GROWTH = { dark: 0.04, formed: 1.25, final: 1.45, formSeconds: 24 } as const;
/** Web brightness: barely there in the dark ages, full once it has formed. */
const BRIGHTNESS = { dark: 0.12, formed: 1 } as const;
/** First stars ignite over this many seconds after `stars`; the galaxies' glow gathers over GALAXY_SECONDS. */
const STAR_SPREAD = 18;
const GALAXY_SECONDS = 10;
const EVENTS = ['dark', 'web', 'stars', 'galaxies'] as const;
type SceneEvent = (typeof EVENTS)[number];

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

function eventTimes(cues: readonly Cue[]): Record<SceneEvent, number> {
  const find = (event: SceneEvent, fallback: number): number =>
    cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
  return { dark: find('dark', 0), web: find('web', 11), stars: find('stars', 36), galaxies: find('galaxies', 60) };
}

interface Parts {
  web: WebParticles;
  stars: FirstStars;
  dispose(): void;
}

export default function create(): ChapterModule {
  const times = eventTimes(content.cues);
  const root = new Group();
  root.name = 'ch03';
  let ctx: ChapterContext | null = null;
  let parts: Parts | null = null;

  return {
    id: 'ch03',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (parts) return;
      const field = await createWebField(FIELD);
      const web = createWebParticles(field.texture, BOX);
      const stars = createFirstStars(field.texture, BOX, field.peaks);
      web.setBudget(c.quality.particles);
      root.add(web.object, stars.object);
      parts = {
        web,
        stars,
        dispose() {
          root.remove(web.object, stars.object);
          web.dispose();
          stars.dispose();
          field.texture.dispose();
        },
      };
    },

    enter(c) {
      ctx = c;
      parts?.web.setBudget(c.quality.particles);
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !parts) return;
      const reduced = ctx.reducedMotion;
      const pace = reduced ? 1.25 : 1;
      const formed = smootherstep(times.web, times.web + GROWTH.formSeconds * pace, t);
      const later = Math.max(0, (t - times.web - GROWTH.formSeconds) / Math.max(1, content.duration - times.web - GROWTH.formSeconds));
      const growth = GROWTH.dark + (GROWTH.formed - GROWTH.dark) * formed + (GROWTH.final - GROWTH.formed) * Math.min(1, later);
      // A gentle swell from black at the chapter's start, then up as the web forms.
      const opening = smootherstep(0, 3, t);
      const brightness = opening * (BRIGHTNESS.dark + (BRIGHTNESS.formed - BRIGHTNESS.dark) * formed);
      parts.web.update({ growth, brightness });
      parts.stars.update({
        growth,
        time: t,
        start: times.stars,
        spread: STAR_SPREAD * pace,
        galaxies: smootherstep(times.galaxies, times.galaxies + GALAXY_SECONDS * pace, t),
        reducedMotion: reduced,
      });
    },

    onSceneEvent(event) {
      // The picture is derived from t in update(); events only need to be ones this scene knows.
      if (!(EVENTS as readonly string[]).includes(event)) console.warn(`[ch03] Unknown scene event "${event}"`);
    },

    setQuality(profile) {
      parts?.web.setBudget(profile.particles);
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      parts?.dispose();
      parts = null;
      ctx = null;
    },
  };
}
