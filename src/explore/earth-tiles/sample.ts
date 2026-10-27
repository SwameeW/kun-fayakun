import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector4, type Node, type Texture, type WebGPURenderer } from 'three/webgpu';
import { abs, asin, atan, clamp, cos, dot, float, floor, log, max, min, mix, smoothstep, tan, texture, uniform, vec2, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node, Vec4Node } from '../render/sampling';
import { createAtlas } from './atlas';
import { MERCATOR_LIMIT } from './grid';
import type { Clipmap } from './clipmap';

/**
 * Reading a clipmap (./clipmap) in a shader: for a direction in the Earth's own frame (x the prime
 * meridian, y the north pole, east longitude toward -z, as ../render/sampling's maps), each rank's
 * tile coordinates, whether the rank's window holds that tile (its index confirms it), and its
 * colour, blended coarse to fine over whatever lies beneath (the global map).
 *
 * A rank shows only where its texels are not much smaller than a screen pixel (the atlases have no
 * mip chain: a minified rank would shimmer, so it fades out and a coarser one shows instead), and it
 * fades out toward its window's edge, so the window's border never shows as a seam.
 *
 * Every rank reads the clipmap's one atlas (its own layer) and one index (its own band of rows): two
 * texture bindings a clipmap, whatever has streamed in (./clipmap says why that matters).
 */


export interface ClipmapShader {
  /** The clipmap's colour (linear) over `under` at a direction in the Earth's frame, and how much of it shows (0 to 1). */
  sample(direction: Vec3Node, footprint: FloatNode, under: Vec3Node): { colour: Vec3Node; weight: FloatNode };
  /** Copies the clipmap's ranks into the shader's inputs (each frame, after the clipmap's update). */
  sync(): void;
  dispose(): void;
}

/** Placeholders the texture nodes hold until the clipmap has its atlas: the same kinds and formats as the real ones. */
function placeholders(renderer: WebGPURenderer, colour: boolean): { atlas: Texture; index: DataTexture } {
  const atlas = createAtlas(renderer, 1, 1, 1, colour, 'earth-tiles-placeholder').texture;
  const index = new DataTexture(new Float32Array([-1, -1, -1, -1]), 1, 1, RGBAFormat, FloatType);
  index.magFilter = NearestFilter;
  index.minFilter = NearestFilter;
  index.generateMipmaps = false;
  index.needsUpdate = true;
  return { atlas, index };
}

export function clipmapShader(renderer: WebGPURenderer, clipmap: Clipmap): ClipmapShader {
  const { grid } = clipmap.source;
  const k = clipmap.options.k;
  const count = clipmap.ranks.length;
  const empty = placeholders(renderer, clipmap.source.colour);
  const atlas = texture(empty.atlas);
  const index = texture(empty.index);
  // One rank's shader inputs; `sync` copies the clipmap's rank state into them each frame. window:
  // originX, originY, scale, wrap. aux: originModX, originModY, texel (radians per texel at the
  // equator), zoom (negative: off). layer: its level's layer of the atlas and band of the index.
  const rankNodes = () => ({
    window: uniform(new Vector4(0, 0, 1, 0)),
    aux: uniform(new Vector4(0, 0, 1, -1)),
    layer: uniform(0),
  });
  const ranks = clipmap.ranks.map(rankNodes);

  const sample = (direction: Vec3Node, footprint: FloatNode, under: Vec3Node): { colour: Vec3Node; weight: FloatNode } => {
    const lat = asin(clamp(direction.y, -1, 1));
    const lon = atan(direction.z.negate(), direction.x);
    const latDeg = lat.mul(180 / Math.PI);
    const lonDeg = lon.mul(180 / Math.PI);
    // Mercator's y (the grid's own, before scaling by 2^z) and its texels' shrink away from the equator.
    const mercLat = clamp(lat, -MERCATOR_LIMIT, MERCATOR_LIMIT);
    const mercY = float(1).sub(log(tan(mercLat).add(float(1).div(cos(mercLat)))).div(Math.PI)).div(2);
    const shrink = grid.projection === 'mercator' ? cos(lat) : float(1);
    let colour: Vec3Node = under;
    let weight: FloatNode = float(0);
    for (const r of ranks) {
      const scale = r.window.z;
      const x = grid.projection === 'mercator' ? lon.add(Math.PI).div(2 * Math.PI).mul(scale) : lonDeg.add(180).mul(scale);
      const y = grid.projection === 'mercator' ? mercY.mul(scale) : float(90).sub(latDeg).mul(scale);
      const wrap = r.window.w;
      const rawDx = x.sub(r.window.x);
      // Into the wrap where the grid wraps (column origin + dx and origin + dx - wrap are the same tile).
      const dx = mix(rawDx, rawDx.sub(floor(rawDx.div(max(wrap, 1))).mul(wrap)), clamp(wrap, 0, 1));
      const dy = y.sub(r.window.y);
      const inside = clamp(dx.mul(1e4).add(1), 0, 1)
        .mul(clamp(float(k).sub(dx).mul(1e4), 0, 1))
        .mul(clamp(dy.mul(1e4).add(1), 0, 1))
        .mul(clamp(float(k).sub(dy).mul(1e4), 0, 1));
      // The tile this pixel is in, and the atlas slot of its (unwrapped) column and row.
      const cellX = floor(dx);
      const cellY = floor(dy);
      const slotX = r.aux.x.add(cellX).sub(floor(r.aux.x.add(cellX).div(k)).mul(k));
      const slotY = r.aux.y.add(cellY).sub(floor(r.aux.y.add(cellY).div(k)).mul(k));
      const tileXRaw = r.window.x.add(cellX);
      const tileX = mix(tileXRaw, tileXRaw.sub(floor(tileXRaw.div(max(wrap, 1))).mul(wrap)), clamp(wrap, 0, 1));
      const tileY = r.window.y.add(cellY);
      const held = index.sample(vec2(slotX.add(0.5), slotY.add(0.5).add(r.layer.mul(k))).div(vec2(k, k * count))) as unknown as Vec4Node;
      const match = smoothstep(0.5, 0.6, held.w)
        .mul(float(1).sub(smoothstep(0.25, 0.5, abs(held.x.sub(tileX)))))
        .mul(float(1).sub(smoothstep(0.25, 0.5, abs(held.y.sub(tileY)))))
        .mul(float(1).sub(smoothstep(0.25, 0.5, abs(held.z.sub(r.aux.w)))));
      // Texels no smaller than about half a pixel (no mip chain: minified, the rank gives way).
      const texel = r.aux.z.mul(shrink);
      const sharp = smoothstep(0.3, 0.6, texel.div(max(footprint, 1e-12)));
      // Fading in over the window's outer tile, so its border never shows.
      const edge = smoothstep(0.05, 0.75, min(min(dx, float(k).sub(dx)), min(dy, float(k).sub(dy))));
      const on = smoothstep(-0.5, 0, r.aux.w);
      const uv = vec2(r.aux.x.add(dx), r.aux.y.add(dy)).div(k);
      const texelColour = (atlas.sample(uv).depth(r.layer) as unknown as Vec4Node).rgb;
      // Black is "no pass imaged this" in the day's mosaic (and never real ground in the cloudless one).
      const seen = smoothstep(0.0012, 0.005, dot(texelColour, vec3(0.2126, 0.7152, 0.0722)));
      const w = inside.mul(match).mul(sharp).mul(edge).mul(on).mul(seen) as unknown as FloatNode;
      colour = mix(colour, texelColour, w);
      weight = max(weight, w);
    }
    return { colour, weight };
  };

  const sync = (): void => {
    // The atlas and index are made together, on the clipmap's first need.
    const made = clipmap.atlas;
    atlas.value = made?.texture ?? empty.atlas;
    index.value = clipmap.index ?? empty.index;
    clipmap.ranks.forEach((state, i) => {
      const r = ranks[i];
      if (!r) return;
      if (state.on && made) {
        r.window.value.set(state.originX, state.originY, state.scale, state.wrap);
        r.aux.value.set(state.originModX, state.originModY, state.texel, state.zoom);
        r.layer.value = state.layer;
      } else {
        r.aux.value.w = -1;
      }
    });
  };

  return {
    sample,
    sync,
    dispose() {
      empty.atlas.dispose();
      empty.index.dispose();
    },
  };
}

/** The exact point on the unit sphere under a fragment: where the ray from the eye through it meets the sphere (the mesh is flat between its vertices). */
export function exactSurface(eye: Vec3Node, onMesh: Vec3Node): Vec3Node {
  const d = onMesh.sub(eye).normalize();
  const b = dot(eye, d);
  const c = dot(eye, eye).sub(1);
  const disc = b.mul(b).sub(c);
  const t = b.negate().sub(max(disc, 0).sqrt());
  const hit = eye.add(d.mul(t));
  // Rays that graze past the true sphere (at the mesh's polygonal limb) keep the mesh's own direction.
  return mix(onMesh.normalize(), hit.normalize(), smoothstep(0, 1e-6, disc));
}

export type { Node };
