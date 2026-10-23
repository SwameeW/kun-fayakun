/**
 * Element layers shared by the star, its debris and the HUD tags. Colours are false
 * colours, one distinct hue per element, running from the cooler outside (red-orange) to
 * the hottest inside (blue-white); the tags name each one.
 */

export type Rgb = readonly [number, number, number];

export interface Layer {
  id: string;
  textKey: string;
  /** Outer edge of the layer as a fraction of the radius; layers are listed innermost first. */
  outer: number;
  color: Rgb;
}

const COLORS = {
  h: [1.0, 0.3, 0.12],
  he: [1.0, 0.56, 0.14],
  c: [0.96, 0.84, 0.24],
  o: [0.18, 0.8, 0.7],
  si: [0.56, 0.4, 1.0],
  fe: [0.72, 0.82, 1.0],
} as const satisfies Record<string, Rgb>;

/**
 * A massive star just before its core collapses: an iron core inside shells of silicon,
 * oxygen, carbon, helium and a hydrogen envelope. Schematic: the real core is about the
 * size of the Earth and the envelope hundreds of times the Sun's radius, which no picture
 * can show to scale (the scene says so in a tag).
 */
export const STAR_LAYERS: readonly Layer[] = [
  { id: 'fe', textKey: 'ui.element.fe', outer: 0.11, color: COLORS.fe },
  { id: 'si', textKey: 'ui.element.si', outer: 0.2, color: COLORS.si },
  { id: 'o', textKey: 'ui.element.o', outer: 0.31, color: COLORS.o },
  { id: 'c', textKey: 'ui.element.c', outer: 0.44, color: COLORS.c },
  { id: 'he', textKey: 'ui.element.he', outer: 0.62, color: COLORS.he },
  { id: 'h', textKey: 'ui.element.h', outer: 1, color: COLORS.h },
];

/**
 * A Type Ia supernova's debris: iron-group elements inside (made as nickel-56), then
 * silicon, then unburnt oxygen and carbon outside. No hydrogen or helium.
 */
export const TYPE_IA_LAYERS: readonly Layer[] = [
  { id: 'ni', textKey: 'ui.element.ni', outer: 0.45, color: COLORS.fe },
  { id: 'si', textKey: 'ui.element.si', outer: 0.8, color: COLORS.si },
  { id: 'o', textKey: 'ui.element.o', outer: 1, color: COLORS.o },
];

/** White-hot: freshly shocked or exploded matter, before it cools into its elements' colours. */
export const HOT: Rgb = [0.92, 0.95, 1.0];

/** Index of the layer holding radius fraction r (innermost first). */
export function layerAt(layers: readonly Layer[], r: number): number {
  const index = layers.findIndex((layer) => r <= layer.outer);
  return index < 0 ? layers.length - 1 : index;
}
