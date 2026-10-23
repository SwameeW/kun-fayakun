import { AdditiveBlending, Color, Group, Mesh, NoColorSpace, Sprite, SpriteNodeMaterial, type Texture } from 'three/webgpu';
import { exp, float, max, uniform, uv, vec3 } from 'three/tsl';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel } from '../../core/types';
import { clusteredField, createGalaxySprites, type GalaxySprites } from '../shared/galaxy-sprites';
import { createMsdfQuad, parseMsdfAtlasMeta } from '../shared/msdf-atlas';
import { createMsdfGlowField } from '../shared/msdf-glow';
import { createMsdfTextMaterial, type MsdfTextMaterial } from '../shared/msdf-material';
import contentJson from './content.json';

/**
 * Chapter 10, "The folding of the heavens": the cosmos as it is today; three possible
 * futures, each shown briefly and labelled a hypothesis (constant dark energy and a cold,
 * dark universe; a strengthening one and a Big Rip; a weakening one and a possible
 * collapse); calm galaxies while the verses are read; then, labelled as an artistic image
 * and not a depiction of the Last Day, the heavens gently roll inward and everything
 * resolves into calm light, in which the calligraphy of 21:104 appears ("as We began the
 * first creation, We will repeat it", from the verified Tanzil text); then silence.
 * Every brightening is slow; nothing is timed to a verse.
 */

const content = contentJson as unknown as ChapterContent;

const FIELD_RADIUS = 40;
const COUNT: Readonly<Record<QualityTier, number>> = { high: 80_000, mid: 40_000, low: 16_000 };
const ATLAS_DIR = 'assets/calligraphy/';
const ATLAS_META = `${ATLAS_DIR}kama-badana.json`;
/** World height of the full atlas: the phrase spans a little under half the screen width. */
const ATLAS_HEIGHT = 2.5;
const GLOW_MARGIN_PX = 200;
const GLOW_FIELD = { downsample: 4, nearSigmaPx: 10, farSigmaPx: 34, widestSigmaPx: 80, rays: { samples: 40, reach: 0.4, decay: 0.95 } } as const;
const CORE_COLOR = new Color(1, 0.93, 0.8);
const GLOW_COLOR = new Color(1, 0.76, 0.46);
/** Raised above the centre so it never meets the verse card in the lower third. */
const CALLIGRAPHY_Y = 1.25;

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (a: number, b: number, c: number, d: number, t: number): number => smootherstep(a, b, t) * (1 - smootherstep(c, d, t));

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

export default function create(): ChapterModule {
  const times = {
    heat: eventTime(content.cues, 'heat-death', 24),
    rip: eventTime(content.cues, 'big-rip', 36),
    crunch: eventTime(content.cues, 'big-crunch', 48),
    still: eventTime(content.cues, 'still', 60),
    fold: eventTime(content.cues, 'fold', 147),
    light: eventTime(content.cues, 'light', 156),
    calligraphy: eventTime(content.cues, 'calligraphy', 160),
    silence: eventTime(content.cues, 'silence', 190),
  };
  const root = new Group();
  root.name = 'ch10';
  let ctx: ChapterContext | null = null;
  let galaxies: GalaxySprites | null = null;
  let words: { mesh: Mesh; light: MsdfTextMaterial; atlas: Texture; glowField: Texture } | null = null;
  let now = 0;
  let exposure = 1;
  // The calm light everything resolves into: a broad soft glow, eased up and down.
  const uLight = uniform(0);
  const lightMaterial = new SpriteNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  const lc = uv().sub(0.5).mul(2);
  const lr = lc.length();
  lightMaterial.colorNode = vec3(1.0, 0.9, 0.74).mul(exp(lr.mul(-3)).mul(max(float(1).sub(lr), 0))).mul(uLight);
  lightMaterial.opacityNode = float(1);
  const light = new Sprite(lightMaterial);
  light.scale.setScalar(34);
  light.name = 'ch10-light';
  root.add(light);

  /** Each possible future runs for its own shot from today's field: [scale, brightness, redshift, tint]. */
  const futureAt = (t: number): { scale: number; light: number; redshift: number; tint: [number, number, number] } => {
    const dip = (at: number): number => 1 - 0.75 * span(at - 0.9, at - 0.2, at + 0.2, at + 0.9, t);
    if (t >= times.heat && t < times.rip) {
      const u = smootherstep(times.heat, times.rip - 1, t);
      return { scale: 1 + 2.6 * u, light: (1 - 0.8 * u) * dip(times.heat), redshift: 0.03 * u, tint: [1, 1, 1] };
    }
    if (t >= times.rip && t < times.crunch) {
      const u = smootherstep(times.rip, times.crunch - 1, t);
      return { scale: 1 + 6 * u * u, light: (1 - 0.95 * smootherstep(0.5, 1, u)) * dip(times.rip), redshift: 0.02 * u, tint: [1, 1, 1] };
    }
    if (t >= times.crunch && t < times.still) {
      const u = smootherstep(times.crunch, times.still - 1, t);
      // Collapsing: galaxies fall together, their light bluer; each dimmer as they crowd, so it never glares.
      return { scale: 1 - 0.8 * u, light: (1 - 0.8 * u) ** 1.8 * dip(times.crunch), redshift: 0, tint: [1 - 0.25 * u, 1 - 0.1 * u, 1 + 0.15 * u] };
    }
    return { scale: 1, light: t < times.still + 1 ? dip(times.still) : 1, redshift: 0, tint: [1, 1, 1] };
  };

  return {
    id: 'ch10',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!galaxies) {
        galaxies = createGalaxySprites({ name: 'ch10-galaxies', positions: clusteredField(COUNT.high, FIELD_RADIUS, 21_104) });
        root.add(galaxies.object);
        const meta = parseMsdfAtlasMeta(await c.assets.json<unknown>(ATLAS_META), ATLAS_META);
        const atlas = await c.assets.texture(`${ATLAS_DIR}${meta.atlas}`);
        atlas.colorSpace = NoColorSpace;
        const quad = createMsdfQuad(meta, ATLAS_HEIGHT, GLOW_MARGIN_PX, GLOW_FIELD.downsample * 2);
        const glowField = createMsdfGlowField(atlas, meta, quad.region, GLOW_FIELD);
        const text = createMsdfTextMaterial(atlas, meta, { coreColor: CORE_COLOR, glowColor: GLOW_COLOR, glowField, raysWeight: 0.18, maxLuminance: 0.75 });
        const mesh = new Mesh(quad.geometry, text.material);
        mesh.name = 'ch10-calligraphy';
        mesh.position.y = CALLIGRAPHY_Y;
        mesh.frustumCulled = false;
        root.add(mesh);
        words = { mesh, light: text, atlas, glowField };
      }
      galaxies.setCount(COUNT[c.quality.tier]);
    },

    enter(c) {
      ctx = c;
      exposure = 1;
      galaxies?.setCount(COUNT[c.quality.tier]);
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !galaxies || !words) return;
      now = t;
      const future = futureAt(t);
      const fold = smootherstep(times.fold, times.light + 2, t);
      const fade = 1 - smootherstep(times.light - 2, times.calligraphy + 1, t);
      galaxies.update({
        scale: future.scale,
        brightness: smootherstep(0, 3, t) * 2.2 * future.light * fade,
        redshiftPerUnit: future.redshift,
        sizePx: 4.6,
        referenceDistance: 22,
        tint: future.tint,
        fold,
      });
      // Calm light, then the calligraphy in it, then silence.
      const glow = span(times.light - 1, times.light + 5, times.calligraphy + 2, times.calligraphy + 9, t) * 0.55 + span(times.calligraphy + 2, times.calligraphy + 9, times.silence, times.silence + 4, t) * 0.18;
      uLight.value = glow;
      light.visible = glow > 1e-3;
      const word = span(times.calligraphy, times.calligraphy + 5, times.silence - 2, times.silence + 3, t);
      words.light.brightness.value = word;
      words.light.coreIntensity.value = 1;
      words.light.glowIntensity.value = 1;
      words.light.focus.value = 0.4 + 0.6 * smootherstep(times.calligraphy, times.calligraphy + 6, t);
      words.mesh.visible = word > 1e-3;
      // A little less exposure while the light is up, so it stays soft (the engine eases it).
      const target = 1 - 0.25 * span(times.light - 1, times.light + 4, times.silence, times.silence + 4, t);
      if (Math.abs(target - exposure) > 0.005) {
        exposure = target;
        ctx.exposure.setTarget(exposure);
      }
    },

    labels(): readonly SceneLabel[] {
      const t = now;
      const labels: SceneLabel[] = [];
      const at: [number, number, number] = [-9, 6.5, 0];
      const tag = (id: string, key: string, a: number, b: number): void => {
        const opacity = span(a + 0.8, a + 2, b - 1.5, b - 0.5, t);
        if (opacity > 0) labels.push({ id, textKey: key, position: at, opacity });
      };
      tag('heat', 'ui.hud.possibility.heatDeath', times.heat, times.rip);
      tag('rip', 'ui.hud.possibility.bigRip', times.rip, times.crunch);
      tag('crunch', 'ui.hud.possibility.bigCrunch', times.crunch, times.still);
      const art = span(times.fold + 0.5, times.fold + 2, times.light + 1, times.light + 3, t);
      if (art > 0) labels.push({ id: 'artistic', textKey: 'ui.hud.artistic', position: [0, 4.2, 0], opacity: art });
      return labels;
    },

    scale() {
      // The futures are schematic and the fold is art: no true scale to show.
      return null;
    },

    setQuality(profile) {
      galaxies?.setCount(COUNT[profile.tier]);
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      galaxies?.dispose();
      if (words) {
        words.mesh.geometry.dispose();
        words.light.dispose();
        words.atlas.dispose();
        words.glowField.dispose();
      }
      lightMaterial.dispose();
      galaxies = null;
      words = null;
      ctx = null;
    },
  };
}
