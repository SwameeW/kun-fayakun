/**
 * The deep catalogue's packs (public/assets/stars/catalogue.json and its .bin files, from
 * scripts/stars/catalogue.py): pure decoding, run in a worker (./catalogue.worker) as each pack
 * arrives, and in the tests.
 *
 * - Hipparcos's other stars: each placed in space where its parallax is at least five times its
 *   error (x, y, z in parsecs from the Sun, render frame, and its absolute V), else a direction; those
 *   the neighbourhood's own file already has (by HIP number) left out, so none is drawn twice.
 * - Tycho-2's: directions, as they come (two 16-bit numbers each), with their colour and magnitude.
 * Colours come from a table of the 256 B-V codes (the caller's: blackbody colours by Ballesteros's
 * temperature), as bytes.
 */

export interface CataloguePack {
  file: string;
  kind: 'hipparcos' | 'tycho2';
  count: number;
  record: number;
  vmag: [number, number];
  sha256: string;
}

export interface CatalogueManifest {
  packs: CataloguePack[];
  band: { file: string; width: number; height: number; perSquareDegree: { floor: number; max: number } };
  counts: Record<string, number>;
}

/** A parallax this many times its error places a star (as the neighbourhood's own stars). */
const PLACED_SIGNIFICANCE = 5;

/** The octahedral packing's inverse (as the shader's, ./field): the ICRS unit vector from the two 16-bit numbers. */
export function unpackDirection(a: number, b: number): [number, number, number] {
  const ex = (a / 65535) * 2 - 1;
  const ey = (b / 65535) * 2 - 1;
  const z = 1 - Math.abs(ex) - Math.abs(ey);
  const t = Math.max(-z, 0);
  const x = ex + (ex >= 0 ? -t : t);
  const y = ey + (ey >= 0 ? -t : t);
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** The render frame's direction from an ICRS one (as ../sky's skyDirection turns right ascension and declination). */
export function renderDirection(icrs: readonly [number, number, number], obliquity: number): [number, number, number] {
  const s = Math.sin(obliquity);
  const c = Math.cos(obliquity);
  return [icrs[0], -icrs[1] * s + icrs[2] * c, -icrs[1] * c - icrs[2] * s];
}

/** V and B-V from their bytes. */
export const vOf = (code: number): number => code / 16 - 1.5;
export const bvOf = (code: number): number | null => (code === 255 ? null : code / 64 - 0.5);

export interface DecodedPack {
  /** Placed stars: x, y, z (pc from the Sun) and absolute V each; their colours (r, g, b, 255); their HIP numbers. */
  placed: Float32Array;
  placedColour: Uint8Array;
  placedHip: Uint32Array;
  /** Directions (two 16-bit numbers each), their colours with the V byte last, and (Hipparcos's) their HIP numbers. */
  far: Uint16Array;
  farColour: Uint8Array;
  farHip: Uint32Array;
}

/** Decodes a pack: `lut` the colours of the 256 B-V codes (r, g, b bytes each); `exclude` HIP numbers drawn elsewhere. */
export function decodePack(kind: CataloguePack['kind'], buffer: ArrayBuffer, count: number, obliquity: number, lut: Uint8Array, exclude: ReadonlySet<number>): DecodedPack {
  const view = new DataView(buffer);
  if (kind === 'tycho2') {
    const n = Math.min(count, Math.floor(buffer.byteLength / 6));
    const far = new Uint16Array(n * 2);
    const farColour = new Uint8Array(n * 4);
    for (let i = 0; i < n; i += 1) {
      const o = i * 6;
      far[i * 2] = view.getUint16(o, true);
      far[i * 2 + 1] = view.getUint16(o + 2, true);
      const bv = view.getUint8(o + 5);
      farColour[i * 4] = lut[bv * 3] ?? 255;
      farColour[i * 4 + 1] = lut[bv * 3 + 1] ?? 255;
      farColour[i * 4 + 2] = lut[bv * 3 + 2] ?? 255;
      farColour[i * 4 + 3] = view.getUint8(o + 4);
    }
    return { placed: new Float32Array(0), placedColour: new Uint8Array(0), placedHip: new Uint32Array(0), far, farColour, farHip: new Uint32Array(0) };
  }
  const n = Math.min(count, Math.floor(buffer.byteLength / 16));
  const placedIdx: number[] = [];
  const farIdx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const o = i * 16;
    if (exclude.has(view.getUint32(o, true))) continue;
    const plx = view.getFloat32(o + 8, true);
    const ePlx = view.getUint16(o + 12, true) / 100;
    (plx > 0 && plx / Math.max(ePlx, 1e-9) >= PLACED_SIGNIFICANCE ? placedIdx : farIdx).push(i);
  }
  const placed = new Float32Array(placedIdx.length * 4);
  const placedColour = new Uint8Array(placedIdx.length * 4);
  const placedHip = new Uint32Array(placedIdx.length);
  placedIdx.forEach((i, k) => {
    const o = i * 16;
    const dist = 1000 / view.getFloat32(o + 8, true);
    const d = renderDirection(unpackDirection(view.getUint16(o + 4, true), view.getUint16(o + 6, true)), obliquity);
    const v = vOf(view.getUint8(o + 14));
    placed[k * 4] = d[0] * dist;
    placed[k * 4 + 1] = d[1] * dist;
    placed[k * 4 + 2] = d[2] * dist;
    placed[k * 4 + 3] = v - 5 * Math.log10(dist / 10);
    const bv = view.getUint8(o + 15);
    placedColour.set([lut[bv * 3] ?? 255, lut[bv * 3 + 1] ?? 255, lut[bv * 3 + 2] ?? 255, 255], k * 4);
    placedHip[k] = view.getUint32(o, true);
  });
  const far = new Uint16Array(farIdx.length * 2);
  const farColour = new Uint8Array(farIdx.length * 4);
  const farHip = new Uint32Array(farIdx.length);
  farIdx.forEach((i, k) => {
    const o = i * 16;
    far[k * 2] = view.getUint16(o + 4, true);
    far[k * 2 + 1] = view.getUint16(o + 6, true);
    const bv = view.getUint8(o + 15);
    farColour.set([lut[bv * 3] ?? 255, lut[bv * 3 + 1] ?? 255, lut[bv * 3 + 2] ?? 255, view.getUint8(o + 14)], k * 4);
    farHip[k] = view.getUint32(o, true);
  });
  return { placed, placedColour, placedHip, far, farColour, farHip };
}

/** A request to the worker, and its reply. */
export interface PackRequest {
  id: number;
  url: string;
  kind: CataloguePack['kind'];
  count: number;
  obliquity: number;
  lut: Uint8Array;
  exclude: Uint32Array;
}

export type PackReply = { id: number; ok: true; pack: DecodedPack } | { id: number; ok: false; error: string };

/** The packs' transferable buffers. */
export const transferables = (p: DecodedPack): ArrayBuffer[] => [p.placed, p.placedColour, p.placedHip, p.far, p.farColour, p.farHip].map((a) => a.buffer as ArrayBuffer);
