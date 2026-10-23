/**
 * Blending for the explorer's translucent layers (clouds, air, rings, particles, the Sun's limb),
 * set explicitly so their shaders' outputs mean exactly one thing on both backends.
 *
 * Their colours are already premultiplied (light scattered toward the eye by what covers the pixel),
 * so the material's own premultipliedAlpha stays off: three would multiply by alpha a second time.
 */

import { AddEquation, CustomBlending, OneFactor, OneMinusSrcAlphaFactor, ZeroFactor, type Material } from 'three/webgpu';

/** result = colour + behind * (1 - alpha), for a colour already multiplied by its coverage. */
export function blendPremultiplied<T extends Material>(m: T): T {
  m.premultipliedAlpha = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
  return m;
}

/** result = colour + behind: light that covers nothing (glows). */
export function blendAdditive<T extends Material>(m: T): T {
  m.premultipliedAlpha = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = OneFactor;
  m.blendDst = OneFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = ZeroFactor;
  m.blendDstAlpha = OneFactor;
  return m;
}
