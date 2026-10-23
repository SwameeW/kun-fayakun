/**
 * TSL material for MSDF / MTSDF calligraphy drawn as light: a crisp emissive
 * core plus a soft glow from the distance field. Runs unchanged on WebGPU and
 * the WebGL2 backend (plain texture samples and derivatives; no compute).
 *
 * - Core: median of RGB, converted to screen pixels with fwidth(uv), so edges
 *   stay about one pixel wide at any zoom.
 * - Glow: the true distance in alpha (MTSDF; the median for plain MSDF) gives a
 *   thin rim just outside the ink. The wide halo comes from a precomputed glow
 *   field (msdf-glow.ts) when given, else from blurred mip levels of the atlas.
 * - Focus: blends the core toward a blurred mip, so light can gather softly
 *   before the letterforms resolve. The word is always drawn whole.
 * - Luminance ceiling (optional): a soft knee keeps every pixel below a limit,
 *   e.g. under the engine bloom threshold, whose hard knee would otherwise make
 *   the bloom pop on or off while the light fades.
 *
 * Blending is additive with alpha 1: at brightness 0 the quad adds exactly
 * nothing, so a black scene stays black.
 */
import { AdditiveBlending, Color, FrontSide, MeshBasicNodeMaterial, type Node, type Texture, type UniformNode } from 'three/webgpu';
import { clamp, exp, float, fwidth, luminance, max, min, mix, smoothstep, texture, uniform, uv, vec2 } from 'three/tsl';
import type { MsdfAtlasMeta } from './msdf-atlas';

type FloatUniform = UniformNode<'float', number>;
type ColorUniform = UniformNode<'color', Color>;
type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

export interface MsdfLightOptions {
  /** Linear RGB of the letter core. */
  coreColor: Color;
  /** Linear RGB of the rim and halo. */
  glowColor: Color;
  coreIntensity?: number;
  glowIntensity?: number;
  /** Glow field from createMsdfGlowField (R near, G far, B widest, A rays), addressed by the quad's 'uv1'. */
  glowField?: Texture;
  /** Weight of the light rays in the glow field's alpha (0 or absent: none). */
  raysWeight?: number;
  /** Highest luminance any pixel may reach (soft knee from 65% of it). Omit for no limit. */
  maxLuminance?: number;
}

export interface MsdfTextMaterial {
  readonly material: MeshBasicNodeMaterial;
  /** Master light, 0 (adds nothing) to 1. Callers ease it; it is never stepped. */
  readonly brightness: FloatUniform;
  /** Multiplier of the core colour. */
  readonly coreIntensity: FloatUniform;
  /** Multiplier of the rim and halo. */
  readonly glowIntensity: FloatUniform;
  /** 0 = soft, out-of-focus letterforms; 1 = crisp edges. */
  readonly focus: FloatUniform;
  readonly coreColor: ColorUniform;
  readonly glowColor: ColorUniform;
  dispose(): void;
}

/** Mip level of the soft (unfocused) letterforms: roughly 10 atlas pixels of blur. */
const SOFT_LEVEL = 3.5;
/** Mip levels of the fallback halo (no glow field). */
const HALO_NEAR_LEVEL = 3;
const HALO_FAR_LEVEL = 5;
/** Relative weights of the glow parts. */
const RIM_WEIGHT = 0.35;
const NEAR_WEIGHT = 0.42;
const FAR_WEIGHT = 0.45;
const WIDEST_WEIGHT = 0.32;
/** How much of the halo is removed inside the ink. */
const INSIDE_GLOW_CUT = 0.8;
/** Share of the quad, from each edge, over which the glow field fades to zero (no visible quad border). */
const EDGE_FADE = 0.12;
/** Fraction of maxLuminance where the soft knee begins. */
const KNEE = 0.65;

const median = (r: FloatNode, g: FloatNode, b: FloatNode): FloatNode => max(min(r, g), min(max(r, g), b));

/**
 * Highest mip level whose edge texels hold only empty border: a texel at level
 * L averages 2^L atlas pixels, and the field reaches pxRange / 2 beyond the ink.
 * Sampling past the atlas then clamps to empty texels and never smears ink.
 */
function safeMipLevel(meta: MsdfAtlasMeta): number {
  const { bounds, width, height } = meta;
  const ink = Math.min(bounds.left * width, (1 - bounds.right) * width, bounds.bottom * height, (1 - bounds.top) * height);
  const empty = ink - meta.pxRange / 2;
  return Math.max(0, Math.floor(Math.log2(Math.max(1, empty))));
}

/**
 * Scales colour so its luminance approaches `ceiling` smoothly: unchanged up to
 * the knee, then an exponential shoulder that never reaches the ceiling.
 */
function limitLuminance(rgb: Vec3Node, ceiling: number): Vec3Node {
  const knee = ceiling * KNEE;
  const span = ceiling - knee;
  const lum = luminance(rgb);
  const over = max(lum.sub(knee), 0);
  const limited = min(lum, knee).add(float(1).sub(exp(over.div(-span))).mul(span));
  return rgb.mul(limited.div(max(lum, 1e-5)));
}

/**
 * Builds the material for one atlas. The atlas texture must keep its mipmaps
 * (TextureLoader's default) for the soft focus and the fallback halo.
 */
export function createMsdfTextMaterial(atlas: Texture, meta: MsdfAtlasMeta, options: MsdfLightOptions): MsdfTextMaterial {
  const brightness = uniform(0);
  const coreIntensity = uniform(options.coreIntensity ?? 1);
  const glowIntensity = uniform(options.glowIntensity ?? 1);
  const focus = uniform(1);
  const coreColor = uniform(options.coreColor.clone());
  const glowColor = uniform(options.glowColor.clone());

  const safeLevel = safeMipLevel(meta);
  const atlasUv = uv();
  /** The field used for glow and focus, at a mip level. */
  const blurredField = (level: number): FloatNode => {
    const s = texture(atlas, atlasUv, float(Math.min(level, safeLevel)));
    return meta.type === 'mtsdf' ? s.a : median(s.r, s.g, s.b);
  };

  // Crisp core: signed distance in screen pixels, edge at 0.5.
  const sharp = texture(atlas, atlasUv);
  const sd = median(sharp.r, sharp.g, sharp.b);
  const unitRange = vec2(meta.pxRange / meta.width, meta.pxRange / meta.height);
  const screenTexSize = vec2(1, 1).div(fwidth(atlasUv));
  const screenPxRange = max(unitRange.dot(screenTexSize).mul(0.5), 1);
  const crisp = clamp(screenPxRange.mul(sd.sub(0.5)).add(0.5), 0, 1);
  const soft = smoothstep(0.2, 0.8, blurredField(SOFT_LEVEL));
  const coverage = mix(soft, crisp, focus);

  // Glow: a thin rim from the true distance outside the ink, plus the wide halo.
  const trueField = meta.type === 'mtsdf' ? sharp.a : sd;
  const rim = smoothstep(0, 0.5, trueField).mul(float(1).sub(crisp)).mul(RIM_WEIGHT);
  let halo: FloatNode;
  if (options.glowField) {
    const quadUv = uv(1);
    const g = texture(options.glowField, quadUv);
    const edge = smoothstep(0, EDGE_FADE, quadUv.x)
      .mul(smoothstep(0, EDGE_FADE, float(1).sub(quadUv.x)))
      .mul(smoothstep(0, EDGE_FADE, quadUv.y))
      .mul(smoothstep(0, EDGE_FADE, float(1).sub(quadUv.y)));
    // Rays (alpha) only when the field carries them (options.raysWeight > 0).
    const rays = g.a.mul(options.raysWeight ?? 0);
    halo = g.r.mul(NEAR_WEIGHT).add(g.g.mul(FAR_WEIGHT)).add(g.b.mul(WIDEST_WEIGHT)).add(rays).mul(edge);
  } else {
    halo = blurredField(HALO_NEAR_LEVEL).mul(NEAR_WEIGHT).add(blurredField(HALO_FAR_LEVEL).mul(FAR_WEIGHT));
  }

  // The halo mostly yields inside the ink, so the core stays the brightest, clearest part.
  const glow = rim.add(halo.mul(float(1).sub(coverage.mul(INSIDE_GLOW_CUT))));
  const light: Vec3Node = coreColor.mul(coreIntensity).mul(coverage).add(glowColor.mul(glowIntensity).mul(glow)).mul(brightness);

  const material = new MeshBasicNodeMaterial();
  material.colorNode = options.maxLuminance === undefined ? light : limitLuminance(light, options.maxLuminance);
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  // Seen from behind the word would be mirrored, so it is simply not drawn.
  material.side = FrontSide;
  material.fog = false;
  material.name = `msdf-light:${meta.id}`;

  return {
    material,
    brightness,
    coreIntensity,
    glowIntensity,
    focus,
    coreColor,
    glowColor,
    dispose() {
      material.dispose();
    },
  };
}
