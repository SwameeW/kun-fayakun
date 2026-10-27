import { AdditiveBlending, BufferAttribute, BufferGeometry, PointsNodeMaterial, Sprite, type Node } from 'three/webgpu';
import { exp, float, log, max, min, screenDPR, smoothstep, sqrt, tanh, uniform, uv, varying, viewportSize } from 'three/tsl';

/**
 * Star light, shared by the explorer's sky (./sky) and the stars around the Sun (./neighbourhood):
 * how a star's magnitude becomes light on the screen, the same at any pixel density and wherever the
 * star falls inside a pixel.
 *
 * - Light, from magnitude: a star's flux relative to a star of magnitude REFERENCE, 10^(-0.4 m),
 *   compressed by CONTRAST (a display's range is far less than the sky's: a contrast of 0.6 shows the
 *   brightest star of the night 5 magnitudes brighter as 16 times, not 100), times the visitor's
 *   brightness, and faded out over the magnitude before the faintest drawn so stars come and go
 *   smoothly as the camera moves (the faintest only adds or takes away stars: the brightness is the
 *   other control's). Its unit is linear light times CSS pixels squared: the same light on the same
 *   area of screen at any pixel density.
 * - Spread, over pixels: each star is a Gaussian of SIGMA_CSS CSS pixels (never under SIGMA_MIN
 *   device pixels), and each pixel shows the Gaussian integrated over its own square (a difference of
 *   error functions on each axis), not sampled at its centre: a star's light is the same wherever it
 *   falls, so nothing flickers as the view turns, and a faint star never drops out between pixels.
 * - Bright stars: the core holds at most CORE_MAX at its peak; the rest of the light spreads into a
 *   halo whose radius grows with it (its peak about HALO_PEAK), so the brightest stars are larger
 *   rather than clipped, and the bloom of the picture's highlights does the rest.
 *
 * A star of magnitude REFERENCE (a magnitude above the faintest drawn by default) has FAINT_LIGHT and
 * peaks at about 0.03 in linear light at worst, above where the explorer's tone curve (ACES) turns
 * to black.
 */

/** A Gaussian's width (CSS px) and its least (device px); the light per CSS pixel squared of a star of the reference magnitude; the tone curve's black (linear); the contrast's power. */
export const STARLIGHT = { sigmaCss: 0.6, sigmaMin: 0.6, faintLight: 0.15, reference: 7.5, black: 0.002, contrast: 0.6, coreMax: 1, haloPeak: 0.22, haloCssMax: 10, footprintMax: 72 } as const;
/** The visitor's defaults: brightness (a multiple of the light), and the faintest magnitude drawn. */
export const STARLIGHT_DEFAULTS = { brightness: 1, faintest: 8.5 } as const;
/** Their ranges, as the stars panel offers them. */
export const STARLIGHT_RANGE = { brightness: [0.25, 4], faintest: [4, 12.5] } as const;

const SQRT2 = Math.SQRT2;

/** The error function, as the shader approximates it: tanh(1.1283791 x + 0.1009 x^3) (within 4e-4). */
export function erf(x: number): number {
  return Math.tanh(Math.max(-9, Math.min(9, 1.1283791 * x + 0.1009 * x * x * x)));
}

/** The share of a unit Gaussian (sigma, px) that falls on the pixel whose centre is `dx` px from its centre, along one axis. */
export function pixelShare(dx: number, sigma: number): number {
  const k = 1 / (sigma * SQRT2);
  return 0.5 * (erf((dx + 0.5) * k) - erf((dx - 0.5) * k));
}

/** A star's light (linear, per CSS pixel squared) from its magnitude: the visitor's brightness and faintest magnitude. */
export function starLight(magnitude: number, faintest: number = STARLIGHT_DEFAULTS.faintest, brightness: number = STARLIGHT_DEFAULTS.brightness): number {
  if (!Number.isFinite(magnitude)) return 0;
  const t = Math.max(0, Math.min(1, faintest - magnitude));
  const fade = t * t * (3 - 2 * t);
  return brightness * STARLIGHT.faintLight * 10 ** (-0.4 * STARLIGHT.contrast * (magnitude - STARLIGHT.reference)) * fade;
}

/** The Gaussian's width in device pixels for a device-pixel ratio (render scale included). */
export function starSigma(dpr: number): number {
  return Math.max(STARLIGHT.sigmaMin, STARLIGHT.sigmaCss * dpr);
}

/**
 * Coarse pixels flatten a star's peak: its brightest pixel holds less than the Gaussian's own peak
 * density over its area (on average over where the star falls, 30% of the light, not 44%, at 0.6 px).
 * The star's light is raised by that ratio (1.49 at one device pixel per CSS pixel, 1.12 at two), so
 * its brightest pixel, and so which faint stars are seen, is the same at any density (its light per CSS
 * pixel then differs by a third: a coarse screen's stars are its pixels).
 */
export function starSharpness(dpr: number): number {
  const sigma = starSigma(dpr);
  // The brightest pixel's share on average over where the star falls: along each axis, 0.65 of the share of a star on a pixel's middle and 0.35 of one on its edge (within 1% of the average for 0.6 to 3 px).
  const mean = 0.65 * pixelShare(0, sigma) + 0.35 * pixelShare(0.5, sigma);
  return 1 / (2 * Math.PI * sigma * sigma * mean * mean);
}

/** What the pixels of a star show (device pixels, for a ratio): the brightest pixel's light, and the sum over all of them per CSS pixel squared. */
export function starPixels(light: number, dpr: number, offsetX = 0, offsetY = 0): { peak: number; perCss: number } {
  const sigma = starSigma(dpr);
  const centre = pixelShare(0, sigma) ** 2;
  const total = light * dpr * dpr * starSharpness(dpr);
  const core = Math.min(total, STARLIGHT.coreMax / centre);
  let peak = 0;
  let sum = 0;
  const reach = Math.ceil(4 * sigma) + 1;
  for (let y = -reach; y <= reach; y += 1) {
    for (let x = -reach; x <= reach; x += 1) {
      const v = core * pixelShare(x - offsetX, sigma) * pixelShare(y - offsetY, sigma);
      peak = Math.max(peak, v);
      sum += v;
    }
  }
  return { peak, perCss: sum / (dpr * dpr) };
}

/**
 * The light on a star's brightest pixel for each unit of its light (per CSS pixel squared), at a ratio:
 * a star centred on a pixel whose core is under CORE_MAX, so its peak is in proportion to its light.
 */
export function starPeakPerLight(dpr: number): number {
  return dpr * dpr * starSharpness(dpr) * pixelShare(0, starSigma(dpr)) ** 2;
}

/**
 * A multiple of the stars' light, held so that no star shows more than `peak` on its brightest pixel
 * (in the stars' own light, before any exposure). `brightest` is the light of the brightest star drawn
 * (starLight of its magnitude, per CSS pixel squared). That star is held at `peak` (or at CORE_MAX if
 * that is less, so no held star has a halo) and every other star is dimmed with it, by one multiple for
 * all so the stars keep their order. `weight` eases the hold in log terms (0 none of it, 1 all of it).
 * The light is never raised.
 */
export function heldStarLight(light: number, brightest: number, peak: number, weight: number, dpr: number): number {
  const w = Math.min(1, Math.max(0, weight));
  const most = Math.min(peak, STARLIGHT.coreMax) / (brightest * starPeakPerLight(dpr));
  if (!(w > 0) || !Number.isFinite(most) || !(light > most)) return light;
  return light * (Math.max(0, most) / light) ** w;
}

/** The visitor's brightness and faintest magnitude, shared by every star material (the stars panel sets them while among the stars; the solar system's sky keeps the defaults). */
export const starlightUniforms = { brightness: uniform(STARLIGHT_DEFAULTS.brightness), faintest: uniform(STARLIGHT_DEFAULTS.faintest) };

export function setStarlight(brightness: number, faintest: number): void {
  const [bLow, bHigh] = STARLIGHT_RANGE.brightness;
  const [fLow, fHigh] = STARLIGHT_RANGE.faintest;
  starlightUniforms.brightness.value = Number.isFinite(brightness) ? Math.max(bLow, Math.min(bHigh, brightness)) : STARLIGHT_DEFAULTS.brightness;
  starlightUniforms.faintest.value = Number.isFinite(faintest) ? Math.max(fLow, Math.min(fHigh, faintest)) : STARLIGHT_DEFAULTS.faintest;
}

/** The canvas's height in CSS pixels, for the pixels per CSS pixel of whatever is drawn into (render scale included). */
const cssHeight = uniform(1).onRenderUpdate(({ renderer }) => Math.max(1, (renderer as { domElement?: HTMLCanvasElement } | null)?.domElement?.clientHeight ?? 1));

const shaderErf = (x: Node<'float'>): Node<'float'> => tanh(x.mul(x.mul(x).mul(0.1009).add(1.1283791)).clamp(-9, 9));

/** A unit quad for sprites. */
export function spriteQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

/**
 * A material for stars as points: `position` (the vertex stage's), `magnitude` as seen from the
 * camera, `colour` (its tint, about 1), and `light`, a multiple of its light (the sky's following of
 * the exposure, a fade). Drawn additively, with or without the depth test (the sky's stars hide
 * behind the worlds).
 */
export function starMaterial(position: Node<'vec3'>, magnitude: Node<'float'>, colour: Node<'vec3'>, light: Node<'float'>, depthTest: boolean): PointsNodeMaterial {
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest, sizeAttenuation: false, fog: false });
  const { brightness, faintest } = starlightUniforms;
  const dpr = viewportSize.y.div(cssHeight);
  const sigma = max(float(STARLIGHT.sigmaMin), dpr.mul(STARLIGHT.sigmaCss));
  const fade = smoothstep(faintest, faintest.sub(1), magnitude);
  const css = brightness.mul(STARLIGHT.faintLight).mul(exp(magnitude.sub(STARLIGHT.reference).mul(-0.4 * STARLIGHT.contrast * Math.LN10))).mul(fade).mul(light);
  // The core's capacity: CORE_MAX at the peak of a star centred on a pixel; the rest to the halo. Its light raised as coarse pixels flatten it (sharpness).
  const centre = shaderErf(float(0.5).div(sigma.mul(SQRT2)));
  const centreShare = centre.mul(centre);
  const k = float(1).div(sigma.mul(SQRT2));
  const mean = centre.mul(0.65).add(shaderErf(k).mul(0.5 * 0.35));
  const total = css.mul(dpr.mul(dpr)).div(sigma.mul(sigma).mul(2 * Math.PI).mul(mean.mul(mean)));
  const core = min(total, float(STARLIGHT.coreMax).div(centreShare));
  const excess = total.sub(core);
  const haloMax = dpr.mul(STARLIGHT.haloCssMax);
  const haloSigma = sqrt(excess.div(2 * Math.PI * STARLIGHT.haloPeak)).clamp(sigma.mul(1.5), haloMax);
  const haloPeak = min(excess.div(haloSigma.mul(haloSigma).mul(2 * Math.PI)), float(STARLIGHT.haloPeak * 2));
  // The sprite: as wide as the core's Gaussian stays above the tone curve's black (so a faint star's is a few pixels), and the halo's; nothing for a star too faint to show.
  const reach = sigma.mul(sqrt(log(max(core.mul(centreShare).div(STARLIGHT.black), 8)).mul(2)));
  const footprint = max(reach.mul(2).add(1), haloSigma.mul(excess.greaterThan(0).select(5.5, 0))).ceil().min(STARLIGHT.footprintMax).mul(core.mul(centreShare).greaterThan(STARLIGHT.black / 4).select(1, 0));
  material.positionNode = position;
  // three sizes a sprite in device pixels of the canvas (its size times the screen's ratio): the footprint is in the target's own.
  material.sizeNode = footprint.div(screenDPR);
  const vCore = varying(core);
  const vK = varying(float(1).div(sigma.mul(SQRT2)));
  const vHalo = varying(haloPeak);
  const vHaloK = varying(float(-0.5).div(haloSigma.mul(haloSigma)));
  const vFoot = varying(footprint);
  const vColour = varying(colour);
  const d = uv().sub(0.5).mul(vFoot);
  const share = (x: Node<'float'>): Node<'float'> => shaderErf(x.add(0.5).mul(vK)).sub(shaderErf(x.sub(0.5).mul(vK))).mul(0.5);
  const value = vCore.mul(share(d.x)).mul(share(d.y)).add(vHalo.mul(exp(d.dot(d).mul(vHaloK))));
  material.colorNode = vColour.mul(value);
  material.opacityNode = float(1);
  return material;
}

/** Sprites for `count` stars with a star material: one draw call. */
export function starSprites(material: PointsNodeMaterial, count: number, name: string): Sprite {
  const sprite = new Sprite(material);
  sprite.geometry = spriteQuad();
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.name = name;
  return sprite;
}
