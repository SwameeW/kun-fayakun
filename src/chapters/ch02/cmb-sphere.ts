import {
  AdditiveBlending,
  BackSide,
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  FrontSide,
  Group,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three/webgpu';
import {
  Fn,
  abs,
  acos,
  asin,
  atan,
  cameraPosition,
  clamp,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  fract,
  fwidth,
  length,
  max,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  select,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { buildColourScale, type ColourScale } from './cmb-colour';

/** The fields of assets/cmb/cmb.json this scene relies on (written by scripts/cmb). */
export interface CmbManifest {
  width: number;
  height: number;
  files: Readonly<Record<string, string>>;
  projection: string;
  frame: string;
  /** Texture u at galactic longitude 0. */
  uAtLon0: number;
  /** Which way longitude runs across the texture as stored: "left" or "right" (checked at load). */
  lonIncreases: string;
  colormap: { stops: ReadonlyArray<readonly [number, string]> };
  credit: string;
  /** The temperature map itself (lossless R8, rows bottom-up), coloured in the shader. */
  temperature: { file: string; width: number; height: number; range: readonly [number, number] } | null;
}

/** Radius of the sphere of last scattering in world units (docs/CONTRACTS.md). */
export const CMB_RADIUS = 10;

/**
 * Without ACES compensation (another tone mapper), the colour scale is scaled by
 * this: its lightest colour (linear luminance ≈ 0.87) then stays under the bloom
 * threshold (0.75), so the map keeps its fine detail instead of glowing.
 */
const MAP_GAIN = 0.84;
/** Entries in the colour lookup table (the scale is defined at 33 stops; 256 is ample). */
const LUT_SIZE = 256;
/** From inside, the map is the whole sky: a touch dimmer than the globe, so it reads as sky, not wall. */
const INSIDE_GAIN = 0.82;
/** Seen from outside: gentle limb darkening for depth, and a warm rim of light at the edge. */
const LIMB = { edge: 0.8, exponent: 0.6 } as const;
const RIM = { strength: 0.22, exponent: 3.5, color: [1.0, 0.86, 0.66] as const } as const;
/** A soft halo just beyond the limb, so the globe reads as a shell of light, not a painted ball. */
const HALO = { radius: 1.7, near: 0.16, nearFalloff: 7, far: 0.04, farFalloff: 2.6, color: [1.0, 0.8, 0.6] as const } as const;
/**
 * Where the shell comes within these world distances of the camera it fades away, so the
 * camera passes out through a soft opening (seeing the sky on the far side) instead of
 * through a magnified close-up of the map racing across the screen.
 */
const NEAR_FADE = { from: 0.8, to: 5 } as const;
/** Camera distances (in sphere radii) over which the view turns from "sky" (inside) to "globe" (outside). */
const OUTSIDE_BLEND = { from: 1.0, to: 1.35 } as const;

export function checkManifest(manifest: CmbManifest): void {
  if (manifest.projection !== 'equirectangular' || manifest.frame !== 'galactic') {
    throw new Error(`ch02: cmb.json describes a ${manifest.projection} ${manifest.frame} map; expected equirectangular galactic`);
  }
  if (manifest.lonIncreases !== 'left' && manifest.lonIncreases !== 'right') {
    throw new Error('ch02: cmb.json lonIncreases must be "left" or "right"');
  }
  if (!manifest.temperature) throw new Error('ch02: cmb.json has no temperature texture (run npm run preprocess:cmb)');
}

export interface CmbSphere {
  /** The sphere and its halo. */
  readonly object: Group;
  /**
   * fade 0..1 (eased by the caller), spin in radians about the galactic poles,
   * uniform scale (1 = radius CMB_RADIUS), and the camera's world position. With
   * warmUp it is drawn (black) even at fade 0, so its pipelines compile up front.
   */
  update(fade: number, spin: number, scale: number, camera: Vector3, warmUp: boolean): void;
  dispose(): void;
}

/** Rotation that turns the Galactic centre (placed on +x below) toward a camera on +z. */
const FACE_GALACTIC_CENTRE = -Math.PI / 2;

export interface CmbSphereOptions {
  maxAnisotropy: number;
  /** The engine tone-maps with three's ACES filmic curve (see cmb-colour.ts). */
  acesToneMapping: boolean;
}

/**
 * The colour scale as a half-float lookup table: position 0 = the cold end
 * (-300 uK), 1 = the hot end (+300 uK), linear between the scale's stops, holding
 * the ACES-compensated scene colours from cmb-colour.ts.
 */
function buildLut(stops: ReadonlyArray<readonly [number, string]>, scale: ColourScale): DataTexture {
  const data = new Uint16Array(LUT_SIZE * 4);
  const positions = stops.map(([p]) => p);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const x = i / (LUT_SIZE - 1);
    let j = 0;
    while (j < positions.length - 2 && x > (positions[j + 1] ?? 1)) j += 1;
    const p0 = positions[j] ?? 0;
    const p1 = positions[j + 1] ?? 1;
    const f = p1 > p0 ? Math.min(1, Math.max(0, (x - p0) / (p1 - p0))) : 0;
    const a = scale.display[j] ?? [0, 0, 0];
    const b = scale.display[j + 1] ?? a;
    for (let c = 0; c < 3; c += 1) data[i * 4 + c] = DataUtils.toHalfFloat((a[c] ?? 0) + ((b[c] ?? 0) - (a[c] ?? 0)) * f);
    data[i * 4 + 3] = DataUtils.toHalfFloat(1);
  }
  const lut = new DataTexture(data, LUT_SIZE, 1, RGBAFormat, HalfFloatType);
  lut.minFilter = LinearFilter;
  lut.magFilter = LinearFilter;
  lut.wrapS = ClampToEdgeWrapping;
  lut.wrapT = ClampToEdgeWrapping;
  lut.generateMipmaps = false;
  lut.colorSpace = NoColorSpace;
  lut.needsUpdate = true;
  return lut;
}

export function createCmbSphere(map: Texture, manifest: CmbManifest, options: CmbSphereOptions): CmbSphere {
  // Longitude wraps; latitude stops at the poles. Rows are stored bottom-up and KTX2
  // textures are never flipped on upload, so v = 0 samples the south galactic pole.
  map.wrapS = RepeatWrapping;
  map.wrapT = ClampToEdgeWrapping;
  map.minFilter = LinearMipmapLinearFilter;
  map.magFilter = LinearFilter;
  map.anisotropy = Math.min(8, options.maxAnisotropy);
  map.needsUpdate = true;

  const scale = buildColourScale(
    manifest.colormap.stops.map(([, hex]) => hex),
    options.acesToneMapping,
    MAP_GAIN,
  );
  const lut = buildLut(manifest.colormap.stops, scale);

  const uFade = uniform(0);
  const uOutside = uniform(1);
  const uCentre = uniform(new Vector3());
  const uRadius = uniform(CMB_RADIUS);

  /*
   * Which way round the map goes on the sphere.
   *
   * Each point's texture coordinates come from its direction (per pixel, so the
   * poles do not pinch the way interpolated UVs do). We use three's SphereGeometry
   * convention, u = atan2(z, -x) / 2π and v = asin(y) / π + 0.5, and place each texel
   * in its TRUE direction in a right-handed galactic frame: longitude l = 360u - 180,
   * so the Galactic centre (l = 0) is on +x, l = 90 on -z and the north galactic
   * pole on +y. That is a proper rotation of the real sky (no reflection): from
   * inside, the sphere looks exactly as the sky does from Earth, with l increasing
   * to the left as in the published Planck maps. Seen from OUTSIDE, the same surface
   * is the mirror image (as a celestial globe is the mirror image of the sky):
   * correct and intended.
   *
   * In texture terms (cmb.json): u_tex = uAtLon0 - l/360 when longitude increases to
   * the left as stored, uAtLon0 + l/360 when to the right; with l = 360u - 180 that is
   * u_tex = uAtLon0 -/+ (u - 0.5).
   */
  const lonSign = manifest.lonIncreases === 'left' ? -1 : 1;
  const colour = Fn(() => {
    const dir = normalize(positionLocal);
    const turns = atan(dir.z, dir.x.negate()).div(2 * Math.PI);
    // Two parameterisations of longitude, each continuous where the other wraps;
    // derivatives come from whichever is continuous here, so the seam leaves no line.
    const uA = fract(turns);
    const uB = fract(turns.add(0.5)).sub(0.5);
    const useA = fwidth(uA).lessThan(fwidth(uB));
    const dudx = select(useA, dFdx(uA), dFdx(uB)).mul(lonSign);
    const dudy = select(useA, dFdy(uA), dFdy(uB)).mul(lonSign);
    const v = asin(clamp(dir.y, -1, 1)).div(Math.PI).add(0.5);
    const uTex = uA.sub(0.5).mul(lonSign).add(manifest.uAtLon0);
    const value = texture(map, vec2(uTex, v)).grad(vec2(dudx, dFdx(v)), vec2(dudy, dFdy(v))).r;
    // Centre of each LUT texel: 0 → first texel, 1 → last.
    const lutU = value.mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
    const mapped = texture(lut, vec2(lutU, 0.5)).rgb;

    // Outside: limb darkening and a warm rim. Inside: a slightly dimmer sky.
    const normal = normalize(positionWorld.sub(uCentre));
    const view = normalize(cameraPosition.sub(positionWorld));
    const mu = abs(dot(normal, view));
    const limb = mix(float(1), mix(float(LIMB.edge), float(1), pow(mu, LIMB.exponent)), uOutside);
    const rim = pow(float(1).sub(mu), RIM.exponent).mul(RIM.strength).mul(uOutside);
    const gain = mix(float(INSIDE_GAIN), float(1), uOutside);
    return mapped.mul(limb).mul(gain).add(vec3(...RIM.color).mul(rim)).mul(uFade);
  });

  const nearFade = smoothstep(NEAR_FADE.from, NEAR_FADE.to, length(positionWorld.sub(cameraPosition)));
  const surface = (side: typeof BackSide | typeof FrontSide): MeshBasicNodeMaterial => {
    const m = new MeshBasicNodeMaterial();
    // Unlit: the colours are data (temperature); only the gentle limb and rim shade them.
    m.colorNode = colour();
    m.opacityNode = nearFade;
    m.side = side;
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    return m;
  };
  // Inside (the sky) and outside (the globe) as two surfaces drawn in a fixed order, so the
  // soft opening near the camera blends correctly whichever side the camera is on.
  const innerMaterial = surface(BackSide);
  const outerMaterial = surface(FrontSide);
  // The globe still writes depth (as an opaque sphere would), so the halo shell's far side stays hidden behind it.
  outerMaterial.depthWrite = true;
  const geometry = new SphereGeometry(CMB_RADIUS, 128, 64);
  const inner = new Mesh(geometry, innerMaterial);
  inner.name = 'ch02-cmb-sky';
  inner.renderOrder = 0;
  const mesh = new Mesh(geometry, outerMaterial);
  mesh.name = 'ch02-cmb-sphere';
  mesh.renderOrder = 1;

  /* Halo: a back-facing shell; brightness falls off with angle beyond the limb. */
  const haloColour = Fn(() => {
    const ray = normalize(positionWorld.sub(cameraPosition));
    const toCentre = uCentre.sub(cameraPosition);
    const distance = length(toCentre);
    const theta = acos(clamp(dot(ray, toCentre.div(distance)), -1, 1));
    const limbAngle = asin(clamp(uRadius.div(distance), 0, 1));
    const beyond = max(theta.sub(limbAngle), 0).div(max(limbAngle, 1e-3));
    const glow = exp(beyond.mul(-HALO.nearFalloff)).mul(HALO.near).add(exp(beyond.mul(-HALO.farFalloff)).mul(HALO.far));
    // Fade out well inside the shell's own edge, so the halo never ends in a visible circle.
    const shellAngle = asin(clamp(uRadius.mul(HALO.radius).div(distance), 0, 1));
    const edge = float(1).sub(smoothstep(shellAngle.mul(0.7), shellAngle.mul(0.97), theta));
    return vec3(...HALO.color).mul(glow).mul(edge).mul(uFade).mul(uOutside);
  });
  const haloMaterial = new MeshBasicNodeMaterial();
  haloMaterial.colorNode = haloColour();
  haloMaterial.side = BackSide;
  haloMaterial.transparent = true;
  haloMaterial.blending = AdditiveBlending;
  haloMaterial.depthWrite = false;
  haloMaterial.fog = false;
  const haloGeometry = new SphereGeometry(CMB_RADIUS * HALO.radius, 64, 32);
  const halo = new Mesh(haloGeometry, haloMaterial);
  halo.name = 'ch02-cmb-halo';
  halo.renderOrder = 2;

  const object = new Group();
  object.name = 'ch02-cmb';
  object.add(inner, mesh, halo);

  return {
    object,
    update(fade, spin, scaleFactor, camera, warmUp) {
      uFade.value = fade;
      mesh.rotation.y = FACE_GALACTIC_CENTRE + spin;
      inner.rotation.y = mesh.rotation.y;
      object.scale.setScalar(scaleFactor);
      object.getWorldPosition(uCentre.value);
      uRadius.value = CMB_RADIUS * scaleFactor;
      const radii = camera.distanceTo(uCentre.value) / (CMB_RADIUS * scaleFactor);
      const s = Math.min(1, Math.max(0, (radii - OUTSIDE_BLEND.from) / (OUTSIDE_BLEND.to - OUTSIDE_BLEND.from)));
      uOutside.value = s * s * (3 - 2 * s);
      // Hidden while dark: from inside it would otherwise hide the freed photons beyond it.
      object.visible = fade > 0 || warmUp;
    },
    dispose() {
      geometry.dispose();
      innerMaterial.dispose();
      outerMaterial.dispose();
      haloGeometry.dispose();
      haloMaterial.dispose();
      lut.dispose();
      map.dispose();
    },
  };
}
