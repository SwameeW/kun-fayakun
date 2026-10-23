import { ACESFilmicToneMapping, Group, MathUtils, type PerspectiveCamera } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, QualityProfile } from '../../core/types';
import contentJson from './content.json';
import { CMB_RADIUS, checkManifest, createCmbSphere, type CmbManifest, type CmbSphere } from './cmb-sphere';
import { createNoiseVolume } from '../shared/noise-volume';
import { createMediumState, createPlasmaMedium, type PlasmaMedium } from '../shared/plasma-medium';
import { createPhotons, type Photons } from './photons';
import { photonLight, readEventTimes, stateAt } from './timing';

/**
 * Chapter 2, "The first light": the camera starts inside the glowing, opaque
 * plasma of the early universe; at recombination it cools and clears into dark,
 * transparent space; then the camera draws back to see the sphere of last
 * scattering from outside, mapped with the real Planck CMB.
 */

const content = contentJson as unknown as ChapterContent;

/** Edge length of the plasma's noise volume (64³ R8 = 256 KiB). */
const NOISE_SIZE = 64;
const NOISE_SEED = 20_180_717;
/** Ambient plasma drift runs at this fraction of real time with reduced motion. */
const REDUCED_FLOW_RATE = 0.5;
/** Camera distance the map is framed at in content.json, and the share of the screen width it may fill. */
const FRAMING_DISTANCE = 41;
const MAX_WIDTH_SHARE = 0.85;
/**
 * During playback the clock advances by exactly the frame's dt; a step that differs
 * from dt by more than this is a seek (the clock jumped), not playback.
 */
const SEEK_EPSILON = 1e-4;

/**
 * The map's framing is set for landscape screens, where height limits it. On a
 * portrait phone the same view would overflow the width, so the sphere shrinks
 * just enough to fit. It depends only on the screen's shape (not on the camera's
 * distance), so zooming in explore mode still brings the map closer.
 */
function fitToWidth(camera: PerspectiveCamera): number {
  const halfWidthTan = Math.tan(MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  const sphereTan = CMB_RADIUS / Math.sqrt(FRAMING_DISTANCE ** 2 - CMB_RADIUS ** 2);
  return Math.min(1, (MAX_WIDTH_SHARE * halfWidthTan) / sphereTan);
}

interface Parts {
  plasma: PlasmaMedium;
  photons: Photons;
  sphere: CmbSphere;
  dispose(): void;
}

async function buildParts(ctx: ChapterContext, root: Group): Promise<Parts> {
  const manifest = await ctx.assets.json<CmbManifest>('assets/cmb/cmb.json');
  checkManifest(manifest);
  const file = manifest.temperature?.file;
  if (!file) throw new Error('ch02: cmb.json lists no temperature texture');
  const [map, noise] = await Promise.all([ctx.assets.ktx2(`assets/cmb/${file}`), createNoiseVolume(NOISE_SIZE, NOISE_SEED)]);

  const plasma = createPlasmaMedium(noise, ctx.quality.tier);
  const photons = createPhotons(ctx.quality.tier);
  const sphere = createCmbSphere(map, manifest, {
    maxAnisotropy: ctx.renderer.getMaxAnisotropy(),
    acesToneMapping: ctx.renderer.toneMapping === ACESFilmicToneMapping,
  });
  root.add(sphere.object, plasma.mesh, photons.field.mesh);
  return {
    plasma,
    photons,
    sphere,
    dispose() {
      root.remove(sphere.object, plasma.mesh, photons.field.mesh);
      plasma.dispose();
      photons.dispose();
      sphere.dispose();
      noise.dispose();
    },
  };
}

export default function create(): ChapterModule {
  const times = readEventTimes(content.cues);
  const root = new Group();
  root.name = 'ch02';

  let ctx: ChapterContext | null = null;
  let parts: Parts | null = null;
  /** Ambient drift added while the clock stands still but frames run (intro card, explore mode). */
  let idleFlow = 0;
  let lastT: number | null = null;
  let firstFrame = true;
  const medium = createMediumState();

  return {
    id: 'ch02',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      parts = await buildParts(c, root);
    },

    enter(c) {
      ctx = c;
      idleFlow = 0;
      lastT = null;
      // Both meshes are drawn on the first frame, so their pipelines compile while
      // the chapter fades in rather than mid-film (the map is culled while the
      // camera is inside it, and a cleared plasma draws nothing visible).
      firstFrame = true;
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t, dt) {
      if (!ctx || !parts) return;
      const reduced = ctx.reducedMotion;
      if (lastT !== null && t === lastT) {
        if (dt > 0) idleFlow += dt;
      } else if (lastT !== null && Math.abs(t - lastT - dt) > SEEK_EPSILON) {
        // The clock jumped (a seek): drop the drift gathered while it stood still, so
        // a seek to t shows exactly the frame a deep link to t does, whatever came before.
        idleFlow = 0;
      }
      lastT = t;

      const camera = ctx.camera.position;
      const state = stateAt(t, times, reduced);
      const flow = (t + idleFlow) * (reduced ? REDUCED_FLOW_RATE : 1);
      medium.clear = state.clear;
      medium.flow = flow;
      // Space keeps stretching after recombination: the clearing pattern grows a little as it fades.
      medium.scale = 1 + 0.35 * state.clear;
      medium.warmUp = firstFrame;
      parts.plasma.update(medium, camera);
      const light = photonLight(t, times, reduced);
      parts.photons.update({
        time: t,
        release: times.recombination,
        brightness: light.brightness,
        density: 1 - state.clear,
        redshift: light.redshift,
        reducedMotion: reduced,
      });
      parts.sphere.update(state.reveal, state.spin, fitToWidth(ctx.camera), camera, firstFrame);
      firstFrame = false;
    },

    onSceneEvent() {
      // The picture is a pure function of chapter time (see timing.ts), so
      // crossing an event needs no extra state; seeking stays deterministic.
    },

    setQuality(profile: QualityProfile) {
      // Fewer plasma samples and photons on lower tiers (the map texture is the same on every tier).
      parts?.plasma.setTier(profile.tier);
      parts?.photons.setTier(profile.tier);
    },

    exit() {
      ctx?.scene.remove(root);
    },

    dispose() {
      ctx?.scene.remove(root);
      parts?.dispose();
      parts = null;
    },
  };
}
