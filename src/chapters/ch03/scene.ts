import { Group } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, SceneLabel } from '../../core/types';
import messages from '../../i18n/en.ch03.json';
import contentJson from './content.json';
import { createIonisationField, ignitionDelays, type IonisationField } from './reionisation';
import { BOX, FIELD, GROWTH, IGNITION_SEED, IONISED_AT_END, STAR_SPREAD, TAG_FROM } from './settings';
import { createFirstStars, createWebParticles, VEIL_MAX, type FirstStars, type WebParticles } from './web';
import { createWebField } from './zeldovich';

/**
 * Chapter 3, "The dark ages and the first stars": darkness after the first light;
 * dark matter (shown in false colour) draws together into a web of sheets, filaments
 * and knots, grown by the Zel'dovich approximation; the first stars ignite in the
 * densest knots, highest peaks first, each swelling softly (never a flash), and each
 * blows a bubble of ionised gas that grows and merges with its neighbours' (an
 * illustration, tagged as one); then the first galaxies gather around them. Every
 * picture is a function of chapter time.
 */

const content = contentJson as unknown as ChapterContent;

/** Web brightness: barely there in the dark ages, full once it has formed. */
const BRIGHTNESS = { dark: 0.12, formed: 1 } as const;
/** The first galaxies' glow gathers over this many seconds after `galaxies`. */
const GALAXY_SECONDS = 10;
/**
 * The gas's tag: in from TAG_FROM seconds after `stars` (at the film's pace), out over the chapter's
 * last seconds, called out to the right of its bubble's star. The neutral gas's veil comes in
 * only after the galaxies' caption has gone, so the web is never dimmed while the captions speak of it.
 */
const TAG = { from: TAG_FROM, fade: 2.5, offset: [56, 30] as const } as const;
const VEIL_SECONDS = 3.5;
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

/** When the last caption about the web or the galaxies has gone (the veil waits for it). */
function captionsEnd(cues: readonly Cue[]): number {
  const spoken = cues.filter((c): c is Extract<Cue, { type: 'caption' }> => c.type === 'caption' && (c.key === 'ch03.caption.webb' || c.key === 'ch03.caption.galaxies'));
  return spoken.reduce((end, c) => Math.max(end, c.t + c.duration), 0);
}

interface Parts {
  web: WebParticles;
  stars: FirstStars;
  gas: IonisationField;
  dispose(): void;
}

export default function create(): ChapterModule {
  const times = eventTimes(content.cues);
  const veilFrom = captionsEnd(content.cues) + 1;
  const root = new Group();
  root.name = 'ch03';
  let ctx: ChapterContext | null = null;
  let parts: Parts | null = null;
  let now = 0;
  let growthNow = 0;

  const pace = (): number => (ctx?.reducedMotion ? 1.25 : 1);

  return {
    id: 'ch03',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      // The tag's words come with this chunk, not the shell.
      c.i18n?.extend('en.ch03.json', messages);
      if (parts) return;
      const field = await createWebField(FIELD);
      const delays = ignitionDelays(field.peaks, STAR_SPREAD, IGNITION_SEED);
      const gas = await createIonisationField(field, delays, {
        end: content.duration - times.stars,
        fraction: IONISED_AT_END,
        growth: GROWTH.final,
        view: content.camera[content.camera.length - 1]?.position ?? [0, 0, 1],
        tagFrom: TAG.from,
      });
      const web = createWebParticles(field.texture, BOX, gas);
      const stars = createFirstStars(field.texture, BOX, field.peaks, delays);
      web.setBudget(c.quality.particles);
      root.add(web.object, stars.object);
      parts = {
        web,
        stars,
        gas,
        dispose() {
          root.remove(web.object, stars.object);
          web.dispose();
          stars.dispose();
          field.texture.dispose();
          gas.texture.dispose();
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
      now = t;
      const reduced = ctx.reducedMotion;
      const p = pace();
      const formed = smootherstep(times.web, times.web + GROWTH.formSeconds * p, t);
      const later = Math.max(0, (t - times.web - GROWTH.formSeconds) / Math.max(1, content.duration - times.web - GROWTH.formSeconds));
      const growth = GROWTH.dark + (GROWTH.formed - GROWTH.dark) * formed + (GROWTH.final - GROWTH.formed) * Math.min(1, later);
      growthNow = growth;
      // A gentle swell from black at the chapter's start, then up as the web forms.
      const opening = smootherstep(0, 3, t);
      const brightness = opening * (BRIGHTNESS.dark + (BRIGHTNESS.formed - BRIGHTNESS.dark) * formed);
      parts.web.update({
        growth,
        brightness,
        // The gas's own clock: seconds since `stars` at the film's normal pace, as its field is worked out.
        clock: (t - times.stars) / p,
        gas: smootherstep(times.stars - 1, times.stars, t),
        veil: VEIL_MAX * smootherstep(veilFrom, veilFrom + VEIL_SECONDS * p, t),
      });
      parts.stars.update({
        growth,
        time: t,
        start: times.stars,
        pace: p,
        galaxies: smootherstep(times.galaxies, times.galaxies + GALAXY_SECONDS * p, t),
        reducedMotion: reduced,
      });
    },

    onSceneEvent(event) {
      // The picture is derived from t in update(); events only need to be ones this scene knows.
      if (!(EVENTS as readonly string[]).includes(event)) console.warn(`[ch03] Unknown scene event "${event}"`);
    },

    labels(): readonly SceneLabel[] {
      const anchor = parts?.gas.anchor;
      if (!ctx || !anchor) return [];
      // The gas's tag, on one of the larger bubbles near the middle, called out from its star.
      const clock = (now - times.stars) / pace();
      const opacity = smootherstep(TAG.from, TAG.from + TAG.fade, clock) * (1 - smootherstep(content.duration - TAG.fade - 0.5, content.duration - 0.5, now));
      if (opacity <= 0) return [];
      const at = anchor.q.map((q, axis) => {
        const x = q + growthNow * (anchor.psi[axis] ?? 0);
        return x - Math.floor(x / BOX + 0.5) * BOX;
      }) as [number, number, number];
      return [{ id: 'ionised-gas', textKey: 'ch03.hud.ionisedGas', position: at, opacity, offset: TAG.offset }];
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
