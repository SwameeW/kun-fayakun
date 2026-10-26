/**
 * The laboratory's climates on the worlds drawn (ledger WR-6): each latitude band's temperature from
 * the climate model (src/sim/climate) as the world's colour, when the temperature view is on, and the
 * Earth's ice where its bands are below the model's ice line, always in the laboratory (the world
 * responding: freeze it and it turns white). The bands are interpolated smoothly across latitude.
 * Outside the laboratory nothing changes.
 *
 * The temperature scale (a colour per kelvin, the same on every world), finest where water freezes
 * and the Earth's climates lie: violet at 150 K and below, blue at 220 K, pale blue at 250 K, white at
 * 273 K (water freezes), yellow at 290 K, orange at 305 K, red at 350 K, dark red from 500 K. Each world is lit as usual, and a fifth of the colour shows on the night side, so the map
 * reads all round.
 */

import { Fn, int, min, mix, smoothstep, uniform, uniformArray, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { FloatNode, Vec3Node } from './shading';

const BANDS = 18;
/** The ice's colour (fresh snow and sea ice, linear) and the model's ice line (K). */
const ICE = { colour: [0.82, 0.86, 0.9], lineK: 263.15 } as const;
/** The temperature scale's stops: kelvin, and colour (linear). */
const SCALE: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [150, [0.08, 0.02, 0.3]],
  [220, [0.1, 0.3, 0.9]],
  [250, [0.4, 0.75, 1]],
  [273, [0.95, 0.97, 1]],
  [290, [1, 0.85, 0.2]],
  [305, [1, 0.5, 0.05]],
  [350, [0.8, 0.08, 0.05]],
  [500, [0.4, 0.02, 0.02]],
];

export interface ClimateView {
  /** 1 while the temperature view shows, else 0 (for layers that should step aside, as the Earth's clouds do). */
  readonly mapShare: FloatNode;
  /** The bands' temperatures (K, south to north), whether to show the temperature map, and whether the world's model has ice; null: none (outside the laboratory). */
  set(bandsK: readonly number[] | null, temperature: boolean, ice: boolean): void;
  /** The shader part: at sin(latitude) `y`, the surface's colour with the climate's ice, and how much of the temperature map to show (with its colour). */
  apply(y: FloatNode, albedo: Vec3Node): { albedo: Vec3Node; map: Vec3Node; mapShare: FloatNode };
}

export function createClimateView(): ClimateView {
  const bands = uniformArray(new Array<number>(BANDS).fill(0), 'float');
  const values = bands.array as number[];
  const uTemperature = uniform(0);
  const uIce = uniform(0);
  const at = (i: Node<'int'>): FloatNode => bands.element(i) as unknown as FloatNode;
  return {
    mapShare: uTemperature,
    set(bandsK, temperature, ice) {
      for (let i = 0; i < BANDS; i += 1) values[i] = bandsK?.[i] ?? 0;
      uTemperature.value = bandsK && temperature ? 1 : 0;
      uIce.value = bandsK && ice ? 1 : 0;
    },
    apply(y, albedo) {
      const kelvin = Fn(() => {
        // The band's place at this latitude, interpolated between neighbouring bands.
        const lat = y.clamp(-1, 1).asin().mul(180 / Math.PI);
        const f = lat.add(90).div(180 / BANDS).sub(0.5).clamp(0, BANDS - 1);
        const i0 = int(f.floor());
        const i1 = int(min(f.floor().add(1), BANDS - 1));
        return mix(at(i0), at(i1), f.fract());
      })();
      // Ice, eased over 2 K about the line.
      const ice = smoothstep(ICE.lineK + 1, ICE.lineK - 1, kelvin).mul(uIce);
      const iced = mix(albedo, vec3(...ICE.colour), ice);
      // Each stop's colour taken on between the stop before it and itself.
      let map: Vec3Node = vec3(...(SCALE[0]?.[1] ?? [0, 0, 0]));
      SCALE.forEach(([kelvinAt, colour], k) => {
        if (k > 0) map = mix(map, vec3(...colour), smoothstep(SCALE[k - 1]?.[0] ?? 0, kelvinAt, kelvin));
      });
      return { albedo: iced, map, mapShare: uTemperature };
    },
  };
}
