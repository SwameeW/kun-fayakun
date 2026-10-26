import type { WebGPURenderer } from 'three/webgpu';
import { max, mix, uniform } from 'three/tsl';
import type { ExploreDetail } from '../detail';
import type { FloatNode, Vec3Node } from '../render/sampling';
import { createClipmap, type Clipmap, type ClipmapStats } from './clipmap';
import { clipmapShader, exactSurface, type ClipmapShader } from './sample';
import { CLEAR, TODAY } from './sources';

export { exactSurface };

/**
 * The Earth's streamed imagery ("zoom anywhere"): what the explorer's Earth shows in place of its
 * global maps wherever the view needs more detail than they hold.
 *
 * - Clear: Sentinel-2 cloudless 2016 (about 10 m per pixel), cloud-free, streamed around the place the
 *   view is aimed at once the needed detail passes the global day map's. The global cloud shell fades
 *   out as the view closes in, so the ground under it shows (the readout says so).
 * - Today: NASA's VIIRS mosaic for the last whole day: the whole globe at once (its 512 px tiles at z2,
 *   about 15 km per pixel) and, around the aim, finer levels down to 250 m. Its clouds are the day's
 *   real clouds, so the cloud shell is off while it shows.
 *
 * The modes cross-fade (an eased blend, never a step), and the readout credits whichever is on screen.
 */

export type ImageryMode = 'clear' | 'today';

export interface EarthImageryStats {
  mode: ImageryMode;
  date: string;
  clear: ClipmapStats;
  today: ClipmapStats;
  /** Share of the cloud shell still shown (it fades as the view closes in, and is off for today's mosaic). */
  clouds: number;
  /** True while streamed imagery covers part of the view (the readout credits it). */
  showing: { clear: boolean; today: boolean };
}

export interface EarthTiles {
  /** Streamed colour over `under` at the exact surface direction, and how much of it shows. */
  imagery(direction: Vec3Node, footprint: FloatNode, under: Vec3Node): { colour: Vec3Node; weight: FloatNode };
  /** The cloud shell's opacity factor (0 to 1). */
  readonly clouds: FloatNode;
  /** Aims the layers (null: the Earth is not close enough to need them) and eases the modes; once a frame. */
  update(aim: { lat: number; lon: number; footprint: number } | null, dt: number, reducedMotion: boolean): void;
  setMode(mode: ImageryMode): void;
  readonly mode: ImageryMode;
  /** The day the today mosaic shows (YYYY-MM-DD). */
  setDate(date: string): void;
  readonly stats: EarthImageryStats;
  suspend(): void;
  dispose(): void;
}

/** The finest zoom of the cloudless layer at which the cloud shell is gone, and where it starts to fade. */
const CLOUDS_FADE = { from: 6, to: 9 } as const;
/** Seconds of the cross-fade between the modes. */
const MODE_SECONDS = 1.2;

export function createEarthTiles(renderer: WebGPURenderer, detail: ExploreDetail): EarthTiles {
  const small = detail.tier === 'low' || detail.tier === 'medium';
  const levels = small ? 3 : 4;
  const k = small ? 6 : 8;
  const clear: Clipmap = createClipmap(renderer, CLEAR, { levels, k, cacheTiles: small ? 96 : 220, writesPerFrame: small ? 2 : 4, concurrency: 6, fromZoom: 5 });
  // Today's finer levels (512 px tiles: half as many across for the same atlas size).
  const today: Clipmap = createClipmap(renderer, TODAY, { levels: small ? 2 : 3, k: small ? 3 : 4, cacheTiles: small ? 24 : 48, writesPerFrame: 1, concurrency: 4, fromZoom: 3 });
  // The whole globe for today: one level at z2 (5 x 3 tiles of 72 degrees) held by a fixed aim.
  const todayGlobal: Clipmap = createClipmap(renderer, TODAY, { levels: 1, k: 5, cacheTiles: 15, writesPerFrame: 1, concurrency: 4, fromZoom: 0 });
  const shaders: ClipmapShader[] = [clipmapShader(renderer, clear), clipmapShader(renderer, todayGlobal), clipmapShader(renderer, today)];
  const [clearShader, globalShader, todayShader] = shaders as [ClipmapShader, ClipmapShader, ClipmapShader];
  const uToday = uniform(0);
  const uClouds = uniform(1);
  let mode: ImageryMode = 'clear';
  let date = '';
  let todayBlend = 0;
  const showing = { clear: false, today: false };
  const stats: EarthImageryStats = { mode, date, clear: clear.stats, today: today.stats, clouds: 1, showing };
  // GIBS z2: 72 degrees a tile; the fixed aim and footprint that select exactly that level.
  const GLOBAL_AIM = { lat: 0, lon: 0, footprint: (72 / 512) * (Math.PI / 180) };

  return {
    imagery(direction, footprint, under) {
      const c = clearShader.sample(direction, footprint, under);
      const g = globalShader.sample(direction, footprint, under);
      const t = todayShader.sample(direction, footprint, g.colour);
      return {
        colour: mix(c.colour, t.colour, uToday),
        weight: mix(c.weight, max(g.weight, t.weight), uToday),
      };
    },
    clouds: uClouds,
    update(aim, dt, reducedMotion) {
      const goal = mode === 'today' ? 1 : 0;
      todayBlend = reducedMotion ? goal : todayBlend + Math.sign(goal - todayBlend) * Math.min(Math.abs(goal - todayBlend), dt / MODE_SECONDS);
      const eased = todayBlend * todayBlend * (3 - 2 * todayBlend);
      uToday.value = eased;
      // Each layer streams only while it can show.
      clear.update(todayBlend < 1 ? aim : null);
      today.update(todayBlend > 0 && date ? aim : null);
      todayGlobal.update(todayBlend > 0 && date ? GLOBAL_AIM : null);
      for (const s of shaders) s.sync();
      const z = clear.stats.zoom;
      const t = Math.max(0, Math.min(1, (z - CLOUDS_FADE.from) / (CLOUDS_FADE.to - CLOUDS_FADE.from)));
      const fade = aim ? t * t * (3 - 2 * t) : 0;
      uClouds.value = (1 - eased) * (1 - fade);
      stats.mode = mode;
      stats.date = date;
      stats.clouds = uClouds.value;
      showing.clear = eased < 1 && clear.ranks.some((r) => r.on);
      showing.today = eased > 0;
    },
    setMode(next) {
      mode = next;
    },
    get mode() {
      return mode;
    },
    setDate(next) {
      if (next === date) return;
      date = next;
      today.setDate(next);
      todayGlobal.setDate(next);
    },
    stats,
    suspend() {
      clear.suspend();
      today.suspend();
      todayGlobal.suspend();
    },
    dispose() {
      for (const s of shaders) s.dispose();
      clear.dispose();
      today.dispose();
      todayGlobal.dispose();
    },
  };
}

