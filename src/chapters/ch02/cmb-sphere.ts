import {
  ClampToEdgeWrapping,
  FrontSide,
  Mesh,
  MeshBasicNodeMaterial,
  RepeatWrapping,
  SphereGeometry,
  type Texture,
} from 'three/webgpu';
import { Fn, texture, uniform, uv, vec2 } from 'three/tsl';
import { buildColourScale, mapToScale } from './cmb-colour';

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
}

/** Radius of the sphere of last scattering in world units (docs/CONTRACTS.md). */
export const CMB_RADIUS = 10;
/**
 * Without ACES compensation (another tone mapper), the colour-mapped texture is
 * scaled by this: its lightest colour (linear luminance ≈ 0.87) then stays under
 * the bloom threshold (0.75), so the map keeps its fine detail instead of glowing.
 */
const MAP_GAIN = 0.84;

export function checkManifest(manifest: CmbManifest): void {
  if (manifest.projection !== 'equirectangular' || manifest.frame !== 'galactic') {
    throw new Error(`ch02: cmb.json describes a ${manifest.projection} ${manifest.frame} map; expected equirectangular galactic`);
  }
  if (manifest.lonIncreases !== 'left' && manifest.lonIncreases !== 'right') {
    throw new Error('ch02: cmb.json lonIncreases must be "left" or "right"');
  }
}

export interface CmbSphere {
  readonly mesh: Mesh;
  /** fade 0..1 (eased by the caller), spin in radians about the galactic poles, uniform scale (1 = radius CMB_RADIUS). */
  update(fade: number, spin: number, scale: number): void;
  dispose(): void;
}

/** Rotation that turns the Galactic centre (placed on +x below) toward a camera on +z. */
const FACE_GALACTIC_CENTRE = -Math.PI / 2;

export interface CmbSphereOptions {
  maxAnisotropy: number;
  /** The engine tone-maps with three's ACES filmic curve (see cmb-colour.ts). */
  acesToneMapping: boolean;
}

export function createCmbSphere(map: Texture, manifest: CmbManifest, options: CmbSphereOptions): CmbSphere {
  // Longitude wraps; latitude stops at the poles. The KTX2 rows are stored bottom-up
  // and compressed textures are never flipped on upload, so uv.y = 0 samples the
  // south galactic pole and uv.y = 1 the north one, matching SphereGeometry's uv.y.
  map.wrapS = RepeatWrapping;
  map.wrapT = ClampToEdgeWrapping;
  map.anisotropy = Math.min(8, options.maxAnisotropy);

  /*
   * Which way round the map goes on the sphere.
   *
   * three's SphereGeometry puts uv.x = 0.5 on +x and uv.x = 0.75 on -z, with +y up.
   * We place each texel in its TRUE direction in a right-handed galactic frame:
   * longitude l = 360 * uv.x - 180, so the Galactic centre (l = 0) is on +x,
   * l = 90 on -z and the north galactic pole on +y. That is a proper rotation of
   * the real sky (no reflection), so from the centre of the sphere it would look
   * exactly as the sky does from Earth, with l increasing to the left as in the
   * published Planck maps.
   *
   * The film shows the sphere from OUTSIDE. Seen from beyond, the same surface is
   * the mirror image of the inside view (as a celestial globe is the mirror image
   * of the sky): longitude increases to the RIGHT. That mirroring is correct and
   * intended; drawing the published map unmirrored on the outside would place every
   * feature at its reflected position (the Cold Spot at l = 209 would appear at l = 151).
   *
   * In texture terms (cmb.json): u = uAtLon0 - l/360 when longitude increases to
   * the left as stored, u = uAtLon0 + l/360 when to the right. Substituting
   * l = 360 * uv.x - 180 gives u = uAtLon0 -/+ (uv.x - 0.5); for this map
   * (uAtLon0 = 0.5, "left") that is u = 1 - uv.x.
   */
  const lonSign = manifest.lonIncreases === 'left' ? -1 : 1;
  const mapUv = vec2(uv().x.sub(0.5).mul(lonSign).add(manifest.uAtLon0), uv().y);

  const scale = buildColourScale(
    manifest.colormap.stops.map(([, hex]) => hex),
    options.acesToneMapping,
    MAP_GAIN,
  );
  const uFade = uniform(0);
  const material = new MeshBasicNodeMaterial();
  // Unlit: the colours are data (temperature), so no lighting or shading touches them.
  material.colorNode = Fn(() => mapToScale(texture(map, mapUv).rgb, scale).mul(uFade))();
  material.side = FrontSide;
  material.fog = false;

  const geometry = new SphereGeometry(CMB_RADIUS, 160, 80);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'ch02-cmb-sphere';

  return {
    mesh,
    update(fade, spin, scale) {
      uFade.value = fade;
      mesh.rotation.y = FACE_GALACTIC_CENTRE + spin;
      mesh.scale.setScalar(scale);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
