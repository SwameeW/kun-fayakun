import { BackSide, DataTexture, LinearFilter, Matrix3, Mesh, MeshBasicNodeMaterial, RGFormat, SphereGeometry, UnsignedByteType } from 'three/webgpu';
import { atan, cameraPosition, exp, float, Fn, max, mix, normalize, positionWorld, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';

/**
 * The Milky Way's glow from star counts (docs/NEIGHBOURHOOD.md, "The Milky Way's glow"): Tycho-2's
 * stars fainter than V = 9 counted across the sky (public/assets/stars/band.bin, from
 * scripts/stars/catalogue.py), their density above the sky's thinnest as a faint glow at infinity,
 * tinted by their mean colour. It stands for the light of the many stars too faint to catalogue, so
 * its shape (the band, its dark rifts of dust) is the data's and its brightness illustrative. Seen
 * from the Sun's neighbourhood; it fades as the camera leaves it.
 */

export interface Band {
  readonly mesh: Mesh;
  setLight(light: number): void;
  dispose(): void;
}

/** Display terms: the glow's light at the densest, and the density (a share of the densest) below which there is none. */
const GLOW = { light: 0.05, floor: 0.12 } as const;

/** `bytes`: the map's density then colour (width by height each); `toGalactic`: render frame to galactic (rows the galactic axes); `scale`: the file's per-square-degree floor and maximum. */
export function createBand(bytes: Uint8Array, width: number, height: number, toGalactic: Matrix3, scale: { floor: number; max: number }): Band {
  const data = new Uint8Array(width * height * 2);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 2] = bytes[i] ?? 0;
    data[i * 2 + 1] = bytes[width * height + i] ?? 0;
  }
  const map = new DataTexture(data, width, height, RGFormat, UnsignedByteType);
  map.magFilter = LinearFilter;
  map.minFilter = LinearFilter;
  map.needsUpdate = true;
  const uGalaxy = uniform(new Matrix3().copy(toGalactic));
  const uLight = uniform(1);
  const span = Math.log1p(scale.max / scale.floor);
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, depthTest: false, fog: false });
  material.colorNode = Fn(() => {
    const g = uGalaxy.mul(normalize(positionWorld.sub(cameraPosition)));
    const l = atan(g.y, g.x).div(2 * Math.PI).fract();
    const b = g.z.asin().div(Math.PI).add(0.5);
    const texel = texture(map, vec2(l, b));
    // The density from its logarithmic code, as a share of the densest; above the floor, the glow.
    const density = exp(texel.r.mul(span)).sub(1).div(scale.max / scale.floor);
    const glow = max(density.sub(GLOW.floor), 0).div(1 - GLOW.floor).pow(0.8);
    // Mean B-V (its code / 64 - 0.5) from bluish to warm.
    const warm = texel.g.mul(255 / 64).sub(0.5).clamp(0, 1.4).div(1.4);
    const tint = mix(vec3(0.75, 0.82, 1), vec3(1, 0.86, 0.66), warm);
    return vec4(tint.mul(glow).mul(GLOW.light).mul(uLight), float(1));
  })();
  const mesh = new Mesh(new SphereGeometry(1, 96, 48), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  mesh.name = 'explore-neighbourhood-galaxy';
  return {
    mesh,
    setLight(light) {
      uLight.value = light;
      mesh.visible = light > 0.002;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
