import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector4, type Node, type Texture, type WebGPURenderer } from 'three/webgpu';
import { abs, atan, clamp, cos, dot, float, floor, length, log, max, min, mix, smoothstep, tan, texture, uniform, vec2, vec3 } from 'three/tsl';
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
 *
 * A pixel is placed by its angles from the place the clipmap is aimed at, never by its own latitude
 * and longitude: the direction is turned about the pole to the aim's meridian, then in that
 * meridian's plane to the aim's latitude, and its longitude and latitude from the aim (small angles
 * near the aim, so exact in single precision) are read off with atan2 and added to where the aim
 * falls in each window, worked out on the CPU in double precision. Formed the plain way, from
 * (longitude + 180) times tiles per degree, the tile coordinate at zoom 13 is a number in the
 * thousands, which single precision held only to a quarter or half of a texel (2 to 3 m on the
 * ground far from the prime meridian): on foot, with each texel across many pixels, the ground's
 * colour stepped in terraces with sawtooth edges. Now the placement is as fine as the direction
 * itself (about half a metre).
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
  // equator), zoom (negative: off). aim: aimX, aimY (the aim in the window, tiles), around (tiles
  // once round the globe). layer: its level's layer of the atlas and band of the index.
  const rankNodes = () => ({
    window: uniform(new Vector4(0, 0, 1, 0)),
    aux: uniform(new Vector4(0, 0, 1, -1)),
    aim: uniform(new Vector4(0, 0, 1, 0)),
    layer: uniform(0),
  });
  const ranks = clipmap.ranks.map(rankNodes);
  // The aim's turn: cos and sin of its longitude, then of its latitude.
  const turn = uniform(new Vector4(1, 0, 1, 0));

  const sample = (direction: Vec3Node, footprint: FloatNode, under: Vec3Node): { colour: Vec3Node; weight: FloatNode } => {
    // The longitude from the aim's meridian (east positive), and the latitude from the aim's: the
    // direction turned about the pole by the aim's longitude, then in its meridian's plane by its latitude.
    const east = direction.z.negate();
    const along = direction.x.mul(turn.x).add(east.mul(turn.y));
    const across = east.mul(turn.x).sub(direction.x.mul(turn.y));
    const dLon = atan(across, along);
    const level = length(vec2(direction.x, direction.z));
    const dLat = atan(direction.y.mul(turn.z).sub(level.mul(turn.w)), level.mul(turn.z).add(direction.y.mul(turn.w)));
    // Mercator's y (the grid's own, before scaling by 2^z, from the latitude itself: no clipmap reads
    // a Mercator layer in a shader, the walk's heights are read on the CPU) and its texels' shrink away
    // from the equator.
    const lat = atan(direction.y, level);
    const mercLat = clamp(lat, -MERCATOR_LIMIT, MERCATOR_LIMIT);
    const mercY = float(1).sub(log(tan(mercLat).add(float(1).div(cos(mercLat)))).div(Math.PI)).div(2);
    const shrink = grid.projection === 'mercator' ? level : float(1);
    let colour: Vec3Node = under;
    let weight: FloatNode = float(0);
    for (const r of ranks) {
      const scale = r.window.z;
      const wrap = r.window.w;
      const around = r.aim.z;
      // From the aim's place in the window (dLon within half a turn either way of it).
      const fromAim = grid.projection === 'mercator' ? r.aim.x.add(dLon.mul(scale.div(2 * Math.PI))) : r.aim.x.add(dLon.mul(scale.mul(180 / Math.PI)));
      // Into the wrap where the grid wraps (column origin + dx and origin + dx - wrap are the same
      // tile); where it does not, onto the grid's one turn of the globe, as its columns are counted.
      const turns = floor(mix(fromAim.add(r.window.x), fromAim, clamp(wrap, 0, 1)).div(max(around, 1e-6)));
      const dx = fromAim.sub(turns.mul(around));
      const dy = grid.projection === 'mercator' ? mercY.mul(scale).sub(r.window.y) : r.aim.y.sub(dLat.mul(scale.mul(180 / Math.PI)));
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
    const { lat, lon } = clipmap.aim;
    turn.value.set(Math.cos(lon), Math.sin(lon), Math.cos(lat), Math.sin(lat));
    clipmap.ranks.forEach((state, i) => {
      const r = ranks[i];
      if (!r) return;
      if (state.on && made) {
        r.window.value.set(state.originX, state.originY, state.scale, state.wrap);
        r.aux.value.set(state.originModX, state.originModY, state.texel, state.zoom);
        r.aim.value.set(state.aimX, state.aimY, state.around, 0);
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
