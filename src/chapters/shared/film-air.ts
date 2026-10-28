import type { WebGPURenderer } from 'three/webgpu';
import type { ChapterContext, QualityTier } from '../../core/types';
import { createTransmittanceTable, earthAir, type AirModel, type TransmittanceTable } from '../../explore/render/air';
import { clearDayAir } from '../../explore/walk/light';

/**
 * The Earth's air for the film's Earth chapters: the explorer's own (../../explore/render/air:
 * Bruneton's reference atmosphere, every coefficient cited in data/constants.json), on the clear
 * day's aerosols the explorer uses on foot, so the film's planet and the explorer's share one model.
 * Its transmittance table is baked once, on the first frame that draws it (it needs the renderer).
 *
 * The film's quality tiers pick the shell's model: single scattering marched in SCATTER_STEPS steps
 * on High and Mid, the analytic 'chord' column on Low (../../explore/bodies/atmosphere).
 */

/** IAU 2015 nominal values: the Earth's mean radius, the Sun's radius and the astronomical unit, km. */
const EARTH_RADIUS_KM = 6371;
const SUN_RADIUS_KM = 695_700;
const AU_KM = 149_597_870.7;
/** View-ray steps of the scattering shell on the tiers that march it (the explorer's Medium). */
const SCATTER_STEPS = 8;

export interface FilmAir {
  readonly model: AirModel;
  readonly table: TransmittanceTable;
  /** Bakes the table once (a no-op after the first call). */
  bake(renderer: WebGPURenderer): void;
  dispose(): void;
}

export function createFilmAir(ctx: Pick<ChapterContext, 'data'>): FilmAir {
  const model = clearDayAir(earthAir(ctx.data, EARTH_RADIUS_KM, Math.asin(SUN_RADIUS_KM / AU_KM)));
  const table = createTransmittanceTable(model);
  return {
    model,
    table,
    bake(renderer) {
      if (!table.baked) table.bake(renderer);
    },
    dispose() {
      table.dispose();
    },
  };
}

/** The shell's view-ray steps for a film tier: 0 is the analytic 'chord' model. */
export function airSteps(tier: QualityTier): number {
  return tier === 'low' ? 0 : SCATTER_STEPS;
}
