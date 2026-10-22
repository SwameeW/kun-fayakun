import { ACESFilmicToneMapping, Group, MathUtils, type PerspectiveCamera } from 'three/webgpu';
import type { ChapterContent, ChapterContext, ChapterModule, QualityProfile } from '../../core/types';
import contentJson from './content.json';
import { CMB_RADIUS, checkManifest, createCmbSphere, type CmbManifest, type CmbSphere } from './cmb-sphere';
import { createNoiseVolume } from './noise-volume';
import { createPlasma, type Plasma } from './plasma';
import { readEventTimes, stateAt } from './timing';

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
  plasma: Plasma;
  sphere: CmbSphere;
  dispose(): void;
}

async function buildParts(ctx: ChapterContext, root: Group): Promise<Parts> {
  const manifest = await ctx.assets.json<CmbManifest>('assets/cmb/cmb.json');
  checkManifest(manifest);
  const file = manifest.files[String(ctx.quality.cmbWidth)] ?? manifest.files[String(manifest.width)];
  if (!file) throw new Error('ch02: cmb.json lists no texture file');
  const [map, noise] = await Promise.all([ctx.assets.ktx2(`assets/cmb/${file}`), createNoiseVolume(NOISE_SIZE, NOISE_SEED)]);

  const plasma = createPlasma(noise);
  const sphere = createCmbSphere(map, manifest, {
    maxAnisotropy: ctx.renderer.getMaxAnisotropy(),
    acesToneMapping: ctx.renderer.toneMapping === ACESFilmicToneMapping,
  });
  root.add(sphere.mesh, plasma.mesh);
  return {
    plasma,
    sphere,
    dispose() {
      root.remove(sphere.mesh, plasma.mesh);
      plasma.dispose();
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
      const state = stateAt(t, times, camera.length(), reduced);
      const flow = (t + idleFlow) * (reduced ? REDUCED_FLOW_RATE : 1);
      parts.plasma.update({ clear: state.clear, flow, warmUp: firstFrame }, camera);
      parts.sphere.update(state.reveal, state.spin, fitToWidth(ctx.camera));
      firstFrame = false;
    },

    onSceneEvent() {
      // The picture is a pure function of chapter time (see timing.ts), so
      // crossing an event needs no extra state; seeking stays deterministic.
    },

    setQuality(_profile: QualityProfile) {
      // No particle system here, so the particle budget does not apply. The plasma
      // costs a fixed 12 texture reads per pixel on every tier (the tier's DPR cap
      // scales the pixel count), and the map texture chosen at load (cmbWidth)
      // costs bandwidth rather than frame time, so nothing changes mid-scene.
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
