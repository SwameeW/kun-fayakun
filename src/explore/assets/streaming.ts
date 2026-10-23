/**
 * Streams the planet textures (assets/planets/planets.json) by detail, never in the way of a frame.
 *
 * - Every map starts on a placeholder: one texel of the map's mean value, so the first frames need
 *   nothing from the network. Each body's Low file (1024 wide) is fetched straight away and is the
 *   floor it never drops below; the body in focus (during a flight, the one being flown to) is then
 *   raised to the detail's texture tier (textureTier), and a body that leaves the focus falls back to
 *   its floor a few seconds later, its larger textures disposed. Leaving the explorer drops every
 *   upgrade. Maps a detail level does not use (relief and night lights at Low) are never fetched.
 * - Fetching and transcoding run off the main thread (the engine's KTX2 loader and its workers).
 *   Uploading is the one main-thread cost: at most one texture is uploaded per frame, the frame
 *   before it is first drawn, so no frame pays for two and none uploads in the middle of drawing.
 * - Nothing changes in a flash: a texture that replaces another is first sampled as blurred as the
 *   one it replaces (a mip bias of log2 of their widths' ratio) and sharpens over about a second; a
 *   map's first file also fades in from the placeholder's mean over half a second.
 * - The detail tier's memory budget (synthesis section 3) is never exceeded: an upgrade is fetched
 *   only if what is resident, in flight and its estimated size fit (other bodies' upgrades make room
 *   first); every arrival corrects the estimate by what the device really holds (a device that has
 *   to unpack compressed textures holds four times as much).
 *
 * A swap only changes which texture a node samples, never a material, so nothing recompiles.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  Vector4,
  type Texture,
  type TextureNode,
  type UniformNode,
} from 'three/webgpu';
import { texture as textureNode, uniform } from 'three/tsl';
import type { AssetLoader } from '../../core/types';
import { textureTier, type ExploreDetail, type ExploreTier } from '../detail';
import { findPlanetTexture, loadPlanetTexture, type PlanetBody, type PlanetMap, type PlanetsManifest, type PlanetTexture } from './planets';

export type MapKey = `${PlanetBody}/${PlanetMap}`;

const MIB = 1024 * 1024;
/** Resident planet textures per detail tier, bytes (synthesis section 3, "Resident textures"). */
export const TEXTURE_BUDGET_BYTES: Readonly<Record<ExploreTier, number>> = { ultra: 512 * MIB, high: 320 * MIB, medium: 160 * MIB, low: 96 * MIB };

/**
 * Each map's mean value in its file's own encoding (sRGB for colour), read from the pipeline's 16 x 8
 * mip levels: what a map shows before its file arrives, so the first file fades in from its own
 * average. Normal maps are flat (x in green, y in alpha, both zero). Unlisted maps are black.
 */
const PLACEHOLDER: Readonly<Partial<Record<MapKey, readonly [number, number, number, number]>>> = {
  'earth/day': [64, 64, 61, 255],
  'earth/night': [0, 0, 0, 255],
  'earth/clouds': [75, 75, 75, 255],
  'earth/water': [171, 171, 171, 255],
  'earth/normal': [128, 128, 128, 128],
  'moon/colour': [154, 152, 146, 255],
  'moon/normal': [128, 128, 128, 128],
  'jupiter/colour': [171, 148, 123, 255],
  'saturn/colour': [173, 174, 156, 255],
  'saturn/rings': [188, 161, 134, 123],
};
const isColour = (map: PlanetMap): boolean => map === 'day' || map === 'colour' || map === 'rings';

/** Seconds a replacing texture takes to sharpen from its predecessor's blur, and a map's first file to fade in. */
const SHARPEN_SECONDS = 1.1;
const ARRIVE_SECONDS = 0.6;
/** A body out of focus keeps its upgrade this long (flying past and back costs no refetch). */
const HOLD_SECONDS = 8;
/** Files fetched at once. */
const MAX_FETCHES = 4;
/** Anisotropic filtering for every map (the giants' bands and the Earth's coasts seen obliquely from low orbit). */
const ANISOTROPY = 8;

/** One map of one body as the shaders see it: sample `node` (its texture is swapped as files arrive). */
export interface MapSlot {
  readonly key: MapKey;
  readonly node: TextureNode;
  /** Mip levels (log2) the bound texture is blurred by, easing to 0 after each arrival: scale gradients by 2^blur. */
  readonly blur: UniformNode<'float', number>;
  /** How far the bound file has replaced the placeholder's mean (0 to 1). */
  readonly arrive: UniformNode<'float', number>;
  /** The placeholder's value as the shader reads the texture (linear light for colour maps). */
  readonly mean: UniformNode<'vec4', Vector4>;
}

interface Resident {
  file: PlanetTexture;
  texture: Texture;
  bytes: number;
}

interface SlotState {
  readonly slot: MapSlot;
  readonly body: PlanetBody;
  readonly map: PlanetMap;
  placeholder: Texture;
  /** Uploaded files by path (the Low file stays as the floor). */
  readonly resident: Map<string, Resident>;
  /** The file bound now (null: the placeholder). */
  bound: Resident | null;
  /** Width of what is bound (1 for a one-texel placeholder). */
  boundWidth: number;
  /** Paths in flight. */
  readonly fetching: Set<string>;
  /** The blur at the last arrival (it falls from there to 0 in SHARPEN_SECONDS). */
  sharpenFrom: number;
}

/** Bytes per texel as published, before mips (block-compressed formats hold one byte per texel). */
const TEXEL_BYTES: Readonly<Record<PlanetTexture['codec'], number>> = { etc1s: 1, uastc: 1, r8: 1, rgba8: 4 };

/** What a file will hold once uploaded, by its size and codec (mips add a third). */
export function estimateBytes(file: Pick<PlanetTexture, 'width' | 'height' | 'codec'>): number {
  return Math.ceil((file.width * file.height * TEXEL_BYTES[file.codec] * 4) / 3);
}

/** What a loaded texture holds: its mip levels as they are uploaded. */
export function textureBytes(texture: Texture): number {
  const mipmaps = (texture as { mipmaps?: Array<{ data?: ArrayBufferView }> }).mipmaps;
  if (mipmaps && mipmaps.length > 0) return mipmaps.reduce((sum, m) => sum + (m.data?.byteLength ?? 0), 0);
  const data = (texture.image as { data?: ArrayBufferView } | null)?.data;
  return data?.byteLength ?? 0;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface PlanetTextures {
  readonly manifest: PlanetsManifest;
  /** The slot of a body's map (created on first use; its placeholder is uploaded at once). */
  slot(body: PlanetBody, map: PlanetMap): MapSlot;
  /**
   * The ring strip's placeholder is the radio-occultation profile itself (physical.json) in the strip's
   * encoding, so the rings are right from the first frame and the strip only sharpens them.
   */
  setRingPlaceholder(transmission: readonly number[], innerKm: number, outerKm: number): void;
  /** Which maps the detail level uses (others are not fetched, or are dropped) and the tier the focus is raised to. */
  setDetail(detail: ExploreDetail): void;
  /** Bodies to raise to the detail's tier now (the focus, a flight's destination); the rest fall back to Low after a while. */
  setWanted(bodies: readonly PlanetBody[]): void;
  /** Per frame: binds last frame's upload, uploads at most one texture, starts fetches, eases, drops what is not wanted. */
  update(dt: number): void;
  /** Leaving the explorer: every upgrade is dropped (floors and placeholders stay for the next visit). */
  suspend(): void;
  /** Bytes of uploaded files now. */
  residentBytes(): number;
  /** The files bound for a body now (for its credits). */
  boundFiles(body: PlanetBody): PlanetTexture[];
  /** True while anything is fetching or waiting to be uploaded or bound. */
  busy(): boolean;
  dispose(): void;
}

export interface StreamerOptions {
  assets: AssetLoader;
  manifest: PlanetsManifest;
  /** Uploads a texture to the GPU now (renderer.initTexture). */
  upload: (texture: Texture) => void;
  detail: ExploreDetail;
}

/** The maps each body's shaders use at a detail level. */
export function mapsFor(body: PlanetBody, detail: ExploreDetail): PlanetMap[] {
  switch (body) {
    case 'earth': {
      const maps: PlanetMap[] = ['day', 'water'];
      if (detail.clouds) maps.push('clouds');
      if (detail.normalMaps) maps.push('normal');
      if (detail.nightLights) maps.push('night');
      return maps;
    }
    case 'moon':
      return detail.normalMaps ? ['colour', 'normal'] : ['colour'];
    case 'jupiter':
      return ['colour'];
    case 'saturn':
      return ['colour', 'rings'];
  }
}

const BODIES: readonly PlanetBody[] = ['earth', 'moon', 'jupiter', 'saturn'];

export function createPlanetTextures(options: StreamerOptions): PlanetTextures {
  const { assets, manifest, upload } = options;
  let detail = options.detail;
  const slots = new Map<MapKey, SlotState>();
  /** When each body was last wanted (the streamer's own clock, seconds), and which are wanted now. */
  const wantedAt = new Map<PlanetBody, number>();
  let wantedNow = new Set<PlanetBody>();
  let clock = 0;
  /** Loaded files waiting for their upload, in arrival order. */
  const uploads: Array<{ state: SlotState; file: PlanetTexture; texture: Texture }> = [];
  /** Uploaded last frame, bound this one (an upload is never in the same frame as its first draw). */
  let toBind: { state: SlotState; resident: Resident } | null = null;
  /** Unbound last frame, disposed this one. */
  let toDispose: Texture[] = [];
  /** Real bytes over the estimate, as measured (1 until a file arrives). */
  let inflation = 1;
  const failed = new Set<string>();
  let disposed = false;

  const floorOf = (state: SlotState): PlanetTexture | undefined => findPlanetTexture(manifest, state.body, state.map, 'low');

  const placeholderTexture = (body: PlanetBody, map: PlanetMap): Texture => {
    const [r, g, b, a] = PLACEHOLDER[`${body}/${map}`] ?? [0, 0, 0, 255];
    const t = new DataTexture(new Uint8Array([r, g, b, a]), 1, 1, RGBAFormat, UnsignedByteType);
    t.colorSpace = isColour(map) ? SRGBColorSpace : NoColorSpace;
    t.wrapS = RepeatWrapping;
    t.wrapT = ClampToEdgeWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    t.name = `placeholder-${body}-${map}`;
    return t;
  };

  const meanOf = (body: PlanetBody, map: PlanetMap): Vector4 => {
    const [r, g, b, a] = (PLACEHOLDER[`${body}/${map}`] ?? [0, 0, 0, 255]).map((v) => v / 255) as [number, number, number, number];
    return isColour(map) ? new Vector4(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a) : new Vector4(r, g, b, a);
  };

  const stateOf = (body: PlanetBody, map: PlanetMap): SlotState => {
    const key: MapKey = `${body}/${map}`;
    const existing = slots.get(key);
    if (existing) return existing;
    const placeholder = placeholderTexture(body, map);
    // Each slot gets its own placeholder: texture bindings are keyed by the texture first bound.
    upload(placeholder);
    const state: SlotState = {
      slot: { key, node: textureNode(placeholder), blur: uniform(0), arrive: uniform(0), mean: uniform(meanOf(body, map)) },
      body,
      map,
      placeholder,
      resident: new Map(),
      bound: null,
      boundWidth: 1,
      fetching: new Set(),
      sharpenFrom: 0,
    };
    slots.set(key, state);
    return state;
  };

  const needed = (state: SlotState): boolean => mapsFor(state.body, detail).includes(state.map);

  /** The file a slot should show now: its tier's while the body is wanted (or held), else its floor. */
  const wantedFile = (state: SlotState): PlanetTexture | undefined => {
    const floor = floorOf(state);
    const held = wantedNow.has(state.body) || clock - (wantedAt.get(state.body) ?? -Infinity) < HOLD_SECONDS;
    if (!held) return floor;
    return findPlanetTexture(manifest, state.body, state.map, textureTier(detail)) ?? floor;
  };

  const residentBytes = (): number => {
    let sum = 0;
    for (const s of slots.values()) for (const r of s.resident.values()) sum += r.bytes;
    return sum;
  };
  const inflightBytes = (): number => {
    let sum = 0;
    for (const s of slots.values()) {
      for (const path of s.fetching) {
        const file = manifest.files.find((f) => f.path === path);
        if (file) sum += estimateBytes(file) * inflation;
      }
    }
    for (const u of uploads) sum += textureBytes(u.texture);
    return sum;
  };
  const fetchCount = (): number => {
    let n = 0;
    for (const s of slots.values()) n += s.fetching.size;
    return n;
  };

  /** Back to the slot's floor, or its placeholder while the floor is not resident. */
  const bindFloor = (state: SlotState): void => {
    const floorPath = floorOf(state)?.path;
    const floor = floorPath ? state.resident.get(floorPath) : undefined;
    if (floor) {
      state.slot.node.value = floor.texture;
      state.bound = floor;
      state.boundWidth = floor.file.width;
      return;
    }
    state.slot.node.value = state.placeholder;
    state.bound = null;
    state.boundWidth = (state.placeholder.image as { width?: number } | null)?.width ?? 1;
    if (state.map !== 'rings') state.slot.arrive.value = 0;
  };

  /** Removes a resident file (unbinding it first); it is disposed next frame, once no frame draws with it. */
  const drop = (state: SlotState, path: string): void => {
    const r = state.resident.get(path);
    if (!r) return;
    state.resident.delete(path);
    if (state.bound === r) bindFloor(state);
    toDispose.push(r.texture);
  };

  const bind = (state: SlotState, resident: Resident): void => {
    const previousWidth = state.boundWidth;
    state.slot.node.value = resident.texture;
    state.bound = resident;
    state.boundWidth = resident.file.width;
    // Sampled as blurred as what it replaces, then sharpening (a map's first file starts from its coarsest level).
    const start = Math.max(0, Math.log2(resident.file.width / Math.max(1, previousWidth)));
    state.slot.blur.value = Math.max(state.slot.blur.value, start);
    state.sharpenFrom = state.slot.blur.value;
  };

  /** Frees other bodies' upgrades (the longest unwanted first) until `bytes` more fit the budget. */
  const makeRoom = (bytes: number): boolean => {
    const budget = TEXTURE_BUDGET_BYTES[detail.tier];
    const fits = (): boolean => residentBytes() + inflightBytes() + bytes <= budget;
    if (fits()) return true;
    const candidates = [...slots.values()]
      .filter((s) => !wantedNow.has(s.body))
      .sort((a, b) => (wantedAt.get(a.body) ?? -Infinity) - (wantedAt.get(b.body) ?? -Infinity));
    for (const s of candidates) {
      const floorPath = floorOf(s)?.path;
      for (const path of [...s.resident.keys()]) {
        if (path === floorPath) continue;
        drop(s, path);
        if (fits()) return true;
      }
    }
    return fits();
  };

  const startFetch = (state: SlotState, file: PlanetTexture): void => {
    state.fetching.add(file.path);
    loadPlanetTexture(assets, file).then(
      (texture) => {
        state.fetching.delete(file.path);
        if (disposed) {
          texture.dispose();
          return;
        }
        texture.anisotropy = ANISOTROPY;
        inflation = Math.max(inflation, textureBytes(texture) / Math.max(1, estimateBytes(file)));
        uploads.push({ state, file, texture });
      },
      (err: unknown) => {
        state.fetching.delete(file.path);
        // A missing file is not fatal: the body keeps what it shows. Not retried.
        failed.add(file.path);
        console.warn(`explore: could not load ${file.path}`, err);
      },
    );
  };

  const schedule = (): void => {
    if (fetchCount() >= MAX_FETCHES) return;
    // Floors first (the focus's first), then upgrades (the focus's first).
    const order = [...slots.values()].filter(needed).sort((a, b) => Number(wantedNow.has(b.body)) - Number(wantedNow.has(a.body)));
    const queue: Array<[SlotState, PlanetTexture | undefined, boolean]> = [
      ...order.map((s): [SlotState, PlanetTexture | undefined, boolean] => [s, floorOf(s), true]),
      ...order.map((s): [SlotState, PlanetTexture | undefined, boolean] => [s, wantedFile(s), false]),
    ];
    for (const [state, file, floor] of queue) {
      if (fetchCount() >= MAX_FETCHES) return;
      if (!file || failed.has(file.path) || state.resident.has(file.path) || state.fetching.has(file.path)) continue;
      if (uploads.some((u) => u.state === state && u.file.path === file.path)) continue;
      if (!floor && file.path !== floorOf(state)?.path && !makeRoom(estimateBytes(file) * inflation)) continue;
      startFetch(state, file);
    }
  };

  /** Drops what is not wanted (upgrades past their hold, maps this detail level does not use) and binds what is. */
  const prune = (): void => {
    for (const state of slots.values()) {
      const use = needed(state);
      const floorPath = floorOf(state)?.path;
      const want = use ? wantedFile(state) : undefined;
      for (const path of [...state.resident.keys()]) {
        if (use && (path === floorPath || path === want?.path)) continue;
        drop(state, path);
      }
      if (want && state.bound?.file.path !== want.path) {
        const ready = state.resident.get(want.path);
        if (ready) bind(state, ready);
      }
    }
  };

  return {
    manifest,
    slot(body, map) {
      return stateOf(body, map).slot;
    },
    setRingPlaceholder(transmission, innerKm, outerKm) {
      const state = stateOf('saturn', 'rings');
      const [from, to] = findPlanetTexture(manifest, 'saturn', 'rings', 'low')?.radiusKm ?? [innerKm, outerKm];
      const width = 2048;
      const data = new Uint8Array(width * 4);
      const [r, g, b] = PLACEHOLDER['saturn/rings'] ?? [188, 161, 134, 123];
      for (let i = 0; i < width; i += 1) {
        // The profile's bins span innerKm..outerKm; resampled onto the strip's span.
        const s = (from + ((i + 0.5) / width) * (to - from) - innerKm) / (outerKm - innerKm);
        const t = s < 0 || s >= 1 ? 1 : Math.min(1, Math.max(0, transmission[Math.floor(s * transmission.length)] ?? 1));
        data.set([r, g, b, Math.round((1 - t) * 255)], i * 4);
      }
      const texture = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      texture.name = 'placeholder-saturn-rings-profile';
      const old = state.placeholder;
      state.placeholder = texture;
      upload(texture);
      if (state.bound === null) {
        state.slot.node.value = texture;
        state.boundWidth = width;
      }
      // The profile is the strip's own measurement: no fade from a mean, only the sharpening.
      state.slot.arrive.value = 1;
      toDispose.push(old);
    },
    setDetail(next) {
      detail = next;
    },
    setWanted(bodies) {
      wantedNow = new Set(bodies);
      for (const b of bodies) wantedAt.set(b, clock);
    },
    update(dt) {
      if (disposed) return;
      const step = Math.max(0, dt);
      clock += step;
      for (const t of toDispose) t.dispose();
      toDispose = [];
      for (const b of wantedNow) wantedAt.set(b, clock);
      for (const body of BODIES) for (const map of mapsFor(body, detail)) stateOf(body, map);
      if (toBind) {
        const { state, resident } = toBind;
        toBind = null;
        // Bound if it is what is wanted now, or, being the floor, while nothing better is bound.
        const want = needed(state) ? wantedFile(state) : undefined;
        const floorPath = floorOf(state)?.path;
        if (state.resident.get(resident.file.path) === resident) {
          if (resident.file.path === want?.path) bind(state, resident);
          else if (resident.file.path === floorPath && (state.bound === null || state.bound.file.path === floorPath)) bind(state, resident);
        }
      }
      let next = uploads.shift();
      // A file that arrived after it stopped being wanted is not uploaded at all.
      while (next && !(needed(next.state) && (next.file.path === floorOf(next.state)?.path || next.file.path === wantedFile(next.state)?.path))) {
        next.texture.dispose();
        next = uploads.shift();
      }
      if (next) {
        upload(next.texture);
        const resident: Resident = { file: next.file, texture: next.texture, bytes: textureBytes(next.texture) };
        const replaced = next.state.resident.get(next.file.path);
        next.state.resident.set(next.file.path, resident);
        if (replaced && replaced !== resident) {
          if (next.state.bound === replaced) bind(next.state, resident);
          toDispose.push(replaced.texture);
        }
        toBind = { state: next.state, resident };
      }
      prune();
      schedule();
      for (const state of slots.values()) {
        const s = state.slot;
        if (s.blur.value > 0) s.blur.value = Math.max(0, s.blur.value - (step * Math.max(1, state.sharpenFrom)) / SHARPEN_SECONDS);
        if (state.bound && s.arrive.value < 1) s.arrive.value = Math.min(1, s.arrive.value + step / ARRIVE_SECONDS);
      }
    },
    suspend() {
      wantedNow = new Set();
      wantedAt.clear();
      for (const state of slots.values()) {
        const floorPath = floorOf(state)?.path;
        for (const path of [...state.resident.keys()]) if (path !== floorPath || !needed(state)) drop(state, path);
        state.slot.blur.value = 0;
      }
      for (const t of toDispose) t.dispose();
      toDispose = [];
    },
    residentBytes,
    boundFiles(body) {
      const files: PlanetTexture[] = [];
      for (const s of slots.values()) if (s.body === body && s.bound && needed(s)) files.push(s.bound.file);
      return files;
    },
    busy() {
      return fetchCount() > 0 || uploads.length > 0 || toBind !== null;
    },
    dispose() {
      disposed = true;
      for (const s of slots.values()) {
        for (const r of s.resident.values()) r.texture.dispose();
        s.resident.clear();
        s.placeholder.dispose();
      }
      for (const u of uploads) u.texture.dispose();
      uploads.length = 0;
      for (const t of toDispose) t.dispose();
      toDispose = [];
      slots.clear();
    },
  };
}
