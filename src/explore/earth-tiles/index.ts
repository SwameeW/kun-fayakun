import { Vector3, type WebGPURenderer } from 'three/webgpu';
import { float, length, max, mix, normalize, smoothstep, uniform } from 'three/tsl';
import type { ExploreDetail } from '../detail';
import type { FloatNode, Vec3Node } from '../render/sampling';
import { createClipmap, type Clipmap, type ClipmapStats, type RankState } from './clipmap';
import { clipmapShader, exactSurface, type ClipmapShader } from './sample';
import { CLEAR, TODAY } from './sources';

export { exactSurface };

/**
 * The Earth's streamed imagery ("zoom anywhere"): what the explorer's Earth shows in place of its
 * global maps wherever the view needs more detail than they hold.
 *
 * - Clear: Sentinel-2 cloudless 2016 (about 10 m per pixel), cloud-free, streamed around the place the
 *   view is aimed at once the needed detail passes the global day map's. As the view closes in the
 *   global cloud shell fades out around that place (a clear patch about the size of the finest
 *   imagery's window, feathered into the cloud around it) and wherever its map is magnified past what
 *   it can show (the near cloud from low orbit), so the ground there shows (the readout says so); it
 *   stays over the rest of the globe, as far as the horizon.
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
  /** The cloud shell's opacity factor where it is faded most (0 to 1): at the place the view is aimed at. */
  readonly clouds: FloatNode;
  /**
   * The cloud shell's opacity factor at a direction in the Earth's frame (0 to 1): as the view closes
   * in, faded around the aim and wherever `crowded` (0 to 1: the cloud map there magnified past what
   * it can show, as the shell's own material measures it), so the far cloud stays.
   */
  cloudsAt(direction: Vec3Node, crowded: FloatNode): FloatNode;
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

/** The finest zoom of the cloudless layer at which the cloud shell is gone around the aim, and where it starts to fade. */
const CLOUDS_FADE = { from: 6, to: 9 } as const;
/**
 * The clear patch around the aim: its radius as a share of the finest imagery window's half-width,
 * and how much further out (times the radius) the cloud is whole again.
 */
const CLEAR_PATCH = { radius: 0.6, feather: 2.5 } as const;
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
  /**
   * How far the shell is faded at the aim (0 to 1), the aim's direction (the Earth's frame), and the
   * clear patch's edge and where the cloud is whole again, as chords of the unit sphere (a chord, not
   * an angle: exact in single precision however small the patch).
   */
  const uFade = uniform(0);
  const uAimDir = uniform(new Vector3(1, 0, 0));
  const uClearFrom = uniform(0.1);
  const uClearTo = uniform(0.16);
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
    cloudsAt(direction, crowded) {
      const inside = float(1).sub(smoothstep(uClearFrom, uClearTo, length(normalize(direction).sub(uAimDir))));
      return float(1).sub(uToday).mul(float(1).sub(uFade.mul(max(inside, crowded))));
    },
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
      uFade.value = fade;
      if (aim) {
        // The aim as a direction in the Earth's frame (x the prime meridian, y the pole, east toward -z).
        const c = Math.cos(aim.lat);
        uAimDir.value.set(c * Math.cos(aim.lon), Math.sin(aim.lat), -c * Math.sin(aim.lon));
        // The finest window on now (ranks run coarse to fine): k tiles of tilePx texels, each texel `texel` radians.
        let finest: RankState | null = null;
        for (const r of clear.ranks) if (r.on) finest = r;
        if (finest) {
          const radius = CLEAR_PATCH.radius * ((finest.texel * clear.source.grid.tilePx * k) / 2);
          uClearFrom.value = 2 * Math.sin(Math.min(radius, Math.PI) / 2);
          uClearTo.value = 2 * Math.sin(Math.min(radius * CLEAR_PATCH.feather, Math.PI) / 2);
        }
      }
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

