/**
 * Chapter 0: Before creation.
 *
 * Total darkness and silence, then the word kun in light, from the MTSDF atlas
 * built from the Tanzil text in the Amiri Quran font (never drawn by hand).
 * Nothing else is in the scene: no stars, no particles, no figures or symbols.
 * The word is never broken apart and never flown through; it fades in and out
 * whole. All visual state is a function of chapter time (see light.ts).
 */
import { Color, Group, Mesh, NoColorSpace, Vector2, Vector3, type Texture } from 'three/webgpu';
import { EASINGS } from '../../core/camera';
import type { ChapterContent, ChapterContext, ChapterModule } from '../../core/types';
import { createMsdfQuad, parseMsdfAtlasMeta } from '../shared/msdf-atlas';
import { createMsdfGlowField } from '../shared/msdf-glow';
import { createMsdfTextMaterial, type MsdfTextMaterial } from '../shared/msdf-material';
import contentJson from './content.json';
import { kunLightAt, kunSchedule } from './light';

// JSON imports widen tuples and string unions; the validator checks the real shape.
const content = contentJson as unknown as ChapterContent;

const ATLAS_DIR = 'assets/calligraphy/';
const ATLAS_META = `${ATLAS_DIR}kun.json`;
const SCENE_EVENTS: readonly string[] = ['kun-reveal', 'kun-hold', 'kun-fade'];

/** World height of the whole atlas (the contract's aspect x 1 quad, scaled); the ink is about 0.875 of it. */
const ATLAS_HEIGHT = 2.7;
/** Atlas pixels kept around the ink for the halo (about 3 widest sigmas, so it fades out inside the quad). */
const GLOW_MARGIN_PX = 280;
/**
 * Glow field: one texel per 4 atlas pixels; three Gaussian widths (sigmas in atlas pixels),
 * and light rays streaming outward from the strokes, as light through still air.
 */
const GLOW_FIELD = {
  downsample: 4,
  nearSigmaPx: 12,
  farSigmaPx: 40,
  widestSigmaPx: 96,
  rays: { samples: 48, reach: 0.55, decay: 0.95 },
} as const;
/** How strongly the rays show in the halo (they share the word's breathing and fades). */
const RAYS_WEIGHT = 0.22;
/** The almost imperceptible push-in, as a fraction of the word's size over its whole presence. */
const DRIFT_SCALE = 0.03;
/**
 * Narrow (portrait) screens: below this aspect the word is scaled down with the
 * aspect (never below MIN_FIT) and lifted by up to PORTRAIT_LIFT world units,
 * so it keeps clear margins and sits above the cards and the bottom sheet.
 */
const FULL_SIZE_ASPECT = 0.62;
const MIN_FIT = 0.6;
const PORTRAIT_LIFT = 0.8;

/** Warm white-gold core and a deeper gold glow, in linear RGB. */
const CORE_COLOR = new Color(1, 0.88, 0.68);
const GLOW_COLOR = new Color(1, 0.62, 0.28);
const CORE_INTENSITY = 1.2;
const GLOW_INTENSITY = 0.6;
/**
 * The engine bloom (src/core/post.ts, threshold 0.75) has a hard knee: a light
 * fading through the threshold would make its bloom pop on or off at once. The
 * word therefore stays just below it on every tier and carries its own glow,
 * so it looks the same with and without bloom and every change stays eased.
 */
const MAX_LUMINANCE = 0.7;

/**
 * Explore guard: the word fades out as the camera comes within GUARD_FAR of its
 * ink and is fully dark by GUARD_NEAR, before the camera can reach its plane, so
 * it is never flown through while lit; it is not drawn from behind (it would
 * read mirrored). A front-facing orbit at explore.minDistance stays outside
 * GUARD_FAR; only walking or panning in, or grazing views, dim it.
 * Dimming follows the camera's distance directly: a lagging ease left the word
 * lit when a camera walking in at full WASD speed crossed the plane, where the
 * back-face cull then cut it to black in one frame. Brightening again is
 * slew-limited over real time (the explore camera moves while the cinematic
 * clock is paused), never faster than 0 to 1 in GUARD_RISE_SECONDS.
 */
const GUARD_NEAR = 0.15;
const GUARD_FAR = 3.6;
const GUARD_RISE_SECONDS = 1;
/**
 * The reduced-motion preference can change mid-chapter: breathing and drift
 * then ease out (or back in) over this many seconds of playback instead of
 * stepping in one frame. While paused nothing changes until play resumes.
 */
const MOTION_EASE_SECONDS = 1.5;

interface Word {
  mesh: Mesh;
  light: MsdfTextMaterial;
  atlas: Texture;
  glowField: Texture;
  /** Half the ink size in the root's local units (the ink is centred on the origin). */
  inkHalf: Vector2;
}

export default function create(): ChapterModule {
  const root = new Group();
  root.name = 'ch00';
  const schedule = kunSchedule(content.cues, content.duration);
  let ctx: ChapterContext | null = null;
  let word: Word | null = null;
  let guard = 1;
  let guardClock: number | null = null;
  /** Linear 0..1 progress toward full motion; the light uses it eased. */
  let motionRamp = 1;
  const warned = new Set<string>();
  const eye = new Vector3();

  /** 1 normally; 0 when the explore camera is at the ink, or behind the word's plane. */
  const updateGuard = (camera: ChapterContext['camera'], inkHalf: Vector2): number => {
    root.worldToLocal(eye.copy(camera.position));
    let goal = 0;
    if (eye.z > 0) {
      const dx = Math.max(0, Math.abs(eye.x) - inkHalf.x);
      const dy = Math.max(0, Math.abs(eye.y) - inkHalf.y);
      // Quadratic in distance: it offsets the word's on-screen growth (about 1/d^2) as the camera nears.
      const ramp = Math.min(1, Math.max(0, (Math.hypot(dx, dy, eye.z) * root.scale.x - GUARD_NEAR) / (GUARD_FAR - GUARD_NEAR)));
      goal = ramp * ramp;
    }
    const now = performance.now();
    const elapsed = guardClock === null ? Infinity : (now - guardClock) / 1000;
    guardClock = now;
    guard = goal <= guard ? goal : Math.min(goal, guard + elapsed / GUARD_RISE_SECONDS);
    return guard;
  };

  /** Eased 0..1 weight of breathing and drift (0 with reduced motion). */
  const updateMotion = (reducedMotion: boolean, dt: number): number => {
    const target = reducedMotion ? 0 : 1;
    const step = Math.max(0, dt) / MOTION_EASE_SECONDS;
    motionRamp = target > motionRamp ? Math.min(target, motionRamp + step) : Math.max(target, motionRamp - step);
    return EASINGS.inOutSine(motionRamp);
  };

  return {
    id: 'ch00',
    content,
    cues: content.cues,

    async load(c) {
      const meta = parseMsdfAtlasMeta(await c.assets.json<unknown>(ATLAS_META), ATLAS_META);
      const atlas = await c.assets.texture(`${ATLAS_DIR}${meta.atlas}`);
      // A distance field is data, not colour: no sRGB decode.
      atlas.colorSpace = NoColorSpace;
      const quad = createMsdfQuad(meta, ATLAS_HEIGHT, GLOW_MARGIN_PX, GLOW_FIELD.downsample * 2);
      const glowField = createMsdfGlowField(atlas, meta, quad.region, GLOW_FIELD);
      const light = createMsdfTextMaterial(atlas, meta, {
        coreColor: CORE_COLOR,
        glowColor: GLOW_COLOR,
        glowField,
        raysWeight: RAYS_WEIGHT,
        maxLuminance: MAX_LUMINANCE,
      });
      const mesh = new Mesh(quad.geometry, light.material);
      mesh.name = 'kun';
      // One quad; it is always in view in the cinematic, and culling would only cost a test.
      mesh.frustumCulled = false;
      root.add(mesh);
      word = { mesh, light, atlas, glowField, inkHalf: new Vector2(quad.inkWidth / 2, quad.inkHeight / 2) };
    },

    enter(c) {
      ctx = c;
      guard = 1;
      guardClock = null;
      // Entering (or a seek that rebuilds the scene) starts settled: no ease to watch.
      motionRamp = c.reducedMotion ? 0 : 1;
      root.scale.setScalar(1);
      if (word) {
        word.light.coreIntensity.value = 0;
        word.light.glowIntensity.value = 0;
      }
      c.scene.add(root);
    },

    update(t, dt) {
      if (!word || !ctx) return;
      const light = kunLightAt(t, schedule, updateMotion(ctx.reducedMotion, dt));
      const u = word.light;
      const fit = Math.min(1, Math.max(MIN_FIT, ctx.camera.aspect / FULL_SIZE_ASPECT));
      root.position.y = (PORTRAIT_LIFT * (1 - fit)) / (1 - MIN_FIT);
      root.scale.setScalar(fit * (1 + DRIFT_SCALE * light.drift));
      root.updateMatrixWorld();
      u.brightness.value = updateGuard(ctx.camera, word.inkHalf);
      u.coreIntensity.value = CORE_INTENSITY * light.core;
      u.glowIntensity.value = GLOW_INTENSITY * light.glow;
      u.focus.value = light.focus;
    },

    onSceneEvent(event) {
      // Visual state comes from t alone; this only reports content that names an unknown event.
      if (SCENE_EVENTS.includes(event) || warned.has(event)) return;
      warned.add(event);
      console.warn(`[ch00] Unknown scene event "${event}"`);
    },

    setQuality() {
      // One quad and no particles: the same on every tier, and it never relies on bloom.
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      if (word) {
        root.remove(word.mesh);
        word.mesh.geometry.dispose();
        word.light.dispose();
        word.atlas.dispose();
        word.glowField.dispose();
        word = null;
      }
      ctx = null;
    },
  };
}
