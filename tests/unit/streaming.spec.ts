/**
 * The explorer's texture streaming (src/explore/assets/streaming.ts) against the real planets.json,
 * with a stand-in loader that hands back textures of each file's size and a stand-in uploader that
 * writes them in bands, without a GPU: every body's Low files first, then only the focus raised to
 * the detail's tier; maps a detail level does not use are never fetched; no frame uploads more than
 * its byte budget (plus one band); a texture is never bound in the update its upload finished in; an
 * upgrade the focus no longer wants is kept while it fits and dropped when room is needed, and leaving
 * drops them all, uploads under way included; what is resident and in flight never exceeds the tier's
 * budget on any frame, also on a device that unpacks compressed files to four times their size.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DataTexture, RGBAFormat, UnsignedByteType, type Texture } from 'three/webgpu';
import type { AssetLoader } from '../../src/core/types';
import { DETAIL, type ExploreDetail, type ExploreTier } from '../../src/explore/detail';
import type { PlanetBody, PlanetMap, PlanetsManifest } from '../../src/explore/assets/planets';
import {
  createPlanetTextures,
  estimateBytes,
  mapsFor,
  TEXTURE_BUDGET_BYTES,
  UPLOAD_BYTES_PER_FRAME,
  type PlanetTextures,
} from '../../src/explore/assets/streaming';
import { levelBytes, type Uploader } from '../../src/explore/assets/upload';

const manifest = JSON.parse(readFileSync(new URL('../../public/assets/planets/planets.json', import.meta.url), 'utf8')) as PlanetsManifest;
const BODIES = ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
/** The stand-in uploader's smallest write (a band of rows). */
const BAND = 64 * 1024;

interface Harness {
  textures: PlanetTextures;
  requested: string[];
  /** Bytes written by uploads in each update (placeholders aside), by update number. */
  bytesPerFrame: number[];
  /** The update each file texture's upload finished in. */
  completedAt: Map<Texture, number>;
  /** File textures handed out by the loader, and which of them were disposed. */
  loaded: Texture[];
  disposed: Set<Texture>;
  /** Calls update() (numbering it) and resolves every request made so far. */
  frame(dt?: number): Promise<void>;
  /** The current update number. */
  readonly now: number;
}

interface HarnessOptions {
  /** Device bytes over the estimate for compressed codecs (4: an uncompressed fallback). */
  inflate?: number;
  budgetBytes?: Readonly<Record<ExploreTier, number>>;
  /** Requests stay pending until release() (default: resolved every frame). */
  hold?: boolean;
}

function harness(detail: ExploreDetail, options: HarnessOptions = {}): Harness & { release(): Promise<void> } {
  const requested: string[] = [];
  const pending: Array<() => void> = [];
  const loaded: Texture[] = [];
  const disposed = new Set<Texture>();
  const completedAt = new Map<Texture, number>();
  const bytesPerFrame: number[] = [0];
  let now = 0;
  const assets: AssetLoader = {
    ktx2(url) {
      requested.push(url);
      const file = manifest.files.find((f) => f.path === url);
      if (!file) return Promise.reject(new Error(`unknown ${url}`));
      // One level of the file's estimated size (times the inflation for compressed codecs).
      const inflate = file.codec === 'etc1s' || file.codec === 'uastc' ? (options.inflate ?? 1) : 1;
      const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
      (texture as unknown as { mipmaps: Array<{ data: Uint8Array; width: number; height: number }> }).mipmaps = [
        { data: new Uint8Array(estimateBytes(file) * inflate), width: file.width, height: file.height },
      ];
      texture.addEventListener('dispose', () => disposed.add(texture));
      loaded.push(texture);
      return new Promise((resolve) => pending.push(() => { resolve(texture); }));
    },
    texture: () => Promise.reject(new Error('unused')),
    json: () => Promise.reject(new Error('unused')),
    binary: () => Promise.reject(new Error('unused')),
    url: (p) => p,
  };
  const upload: Uploader = (texture) => {
    const bytes = levelBytes(texture);
    const placeholder = texture.name.startsWith('placeholder');
    let sent = 0;
    return {
      bytes,
      get done() {
        return sent >= bytes;
      },
      step(budget) {
        if (sent >= bytes) return 0;
        const n = Math.min(bytes - sent, Math.max(BAND, Math.min(budget, bytes)));
        sent += n;
        if (!placeholder) bytesPerFrame[now] = (bytesPerFrame[now] ?? 0) + n;
        if (sent >= bytes && !placeholder) completedAt.set(texture, now);
        return n;
      },
    };
  };
  const textures = createPlanetTextures({ assets, manifest, detail, upload, budgetBytes: options.budgetBytes });
  const release = async (): Promise<void> => {
    for (const resolve of pending.splice(0)) resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    textures,
    requested,
    bytesPerFrame,
    completedAt,
    loaded,
    disposed,
    get now() {
      return now;
    },
    async frame(dt = 1 / 60) {
      now += 1;
      bytesPerFrame[now] = 0;
      textures.update(dt);
      if (!options.hold) await release();
    },
    release,
  };
}

/** The maps each body has a slot for. */
const SLOTS: ReadonlyArray<[PlanetBody, PlanetMap]> = [
  ['earth', 'day'], ['earth', 'night'], ['earth', 'clouds'], ['earth', 'water'], ['earth', 'normal'],
  ['moon', 'colour'], ['moon', 'normal'], ['jupiter', 'colour'], ['saturn', 'colour'], ['saturn', 'rings'],
];

/** Every slot's bound texture was uploaded in an update before this one. */
function expectBoundAfterUpload(h: Harness): void {
  for (const [body, map] of SLOTS) {
    const value = h.textures.slot(body, map).node.value;
    const finished = h.completedAt.get(value);
    if (finished !== undefined) expect(finished, `${body}/${map} bound in update ${h.now}, uploaded in ${finished}`).toBeLessThan(h.now);
  }
}

/** Runs frames until nothing is in flight or waiting, checking the budget and the bind rule on every one. */
async function settle(h: Harness, tier: ExploreTier, options: { dt?: number; maxFrames?: number; budget?: number } = {}): Promise<number> {
  const budget = options.budget ?? TEXTURE_BUDGET_BYTES[tier];
  let frames = 0;
  for (; frames < (options.maxFrames ?? 2000); frames += 1) {
    await h.frame(options.dt);
    expect(h.textures.residentBytes() + h.textures.inflightBytes(), `frame ${h.now}: resident and in flight`).toBeLessThanOrEqual(budget);
    expectBoundAfterUpload(h);
    if (!h.textures.busy()) break;
  }
  await h.frame(options.dt);
  return frames;
}

const tierOf = (path: string): string | undefined => manifest.files.find((f) => f.path === path)?.tier;

test('on entry only the Low files of the maps the detail uses are fetched', async () => {
  const h = harness(DETAIL.high);
  await settle(h, 'high');
  const wanted = BODIES.flatMap((b) => mapsFor(b, DETAIL.high).map((m) => `${b}/${m}`));
  expect(h.requested).toHaveLength(wanted.length);
  for (const path of h.requested) expect(tierOf(path)).toBe('low');
  for (const body of BODIES) {
    for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('low');
  }
});

test('maps a detail level does not use are never fetched; Low keeps the night lights and relief', async () => {
  const bare: ExploreDetail = { ...DETAIL.low, nightLights: false, normalMaps: false };
  const h = harness(bare);
  h.textures.setWanted(['earth', 'moon']);
  await settle(h, 'low');
  expect(h.requested.some((p) => /normal|night/.test(p))).toBe(false);
  // Low detail streams the Low tier for the focus too, the night lights and relief among them.
  const low = harness(DETAIL.low);
  low.textures.setWanted(['earth', 'moon']);
  await settle(low, 'low');
  for (const path of low.requested) expect(tierOf(path)).toBe('low');
  expect(low.requested.some((p) => p.includes('earth/night'))).toBe(true);
  expect(low.requested.some((p) => p.includes('moon/normal'))).toBe(true);
});

test('the focus is raised to the detail tier; others stay at Low', async () => {
  const h = harness(DETAIL.high);
  await settle(h, 'high');
  h.textures.setWanted(['earth']);
  await settle(h, 'high');
  for (const file of h.textures.boundFiles('earth')) expect(file.tier).toBe('high');
  for (const file of h.textures.boundFiles('jupiter')) expect(file.tier).toBe('low');
});

test('no frame uploads more than its byte budget, and a large file goes up over several frames', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['earth', 'moon']);
  await settle(h, 'high');
  const worst = Math.max(...h.bytesPerFrame);
  expect(worst).toBeGreaterThan(0);
  expect(worst).toBeLessThanOrEqual(UPLOAD_BYTES_PER_FRAME + BAND);
  // The 4096 day map alone is several frames' worth.
  const day = manifest.files.find((f) => f.body === 'earth' && f.map === 'day' && f.tier === 'high');
  expect(estimateBytes(day ?? { width: 0, height: 0, codec: 'uastc' })).toBeGreaterThan(3 * UPLOAD_BYTES_PER_FRAME);
  for (const body of ['earth', 'moon'] as const) for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('high');
});

test('a texture is bound only in an update after the one its upload finished in', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['jupiter']);
  let boundOnCompletion = 0;
  for (let i = 0; i < 400; i += 1) {
    await h.frame();
    const value = h.textures.slot('jupiter', 'colour').node.value;
    if (h.completedAt.get(value) === h.now) boundOnCompletion += 1;
    expectBoundAfterUpload(h);
  }
  expect(boundOnCompletion).toBe(0);
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
});

test('an upgrade the focus moves on from is kept while it fits, and going back costs no refetch', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['jupiter']);
  await settle(h, 'high');
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
  h.textures.setWanted(['saturn']);
  await settle(h, 'high');
  for (let i = 0; i < 30; i += 1) await h.frame(1);
  // Long after its hold, still bound: the High budget has room for it.
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
  const requests = h.requested.length;
  h.textures.setWanted(['jupiter']);
  await settle(h, 'high');
  expect(h.requested.length).toBe(requests);
  // Leaving drops every upgrade.
  h.textures.suspend();
  for (const body of BODIES) {
    for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('low');
  }
});

test('when room is needed the longest-unwanted upgrade goes first', async () => {
  // Room for the floors (about 6 MiB) and the Moon's two 4096 maps (22 MiB), not Jupiter's (11 MiB) besides.
  const narrow = { ...TEXTURE_BUDGET_BYTES, high: 30 * 1024 * 1024 };
  const h = harness(DETAIL.high, { budgetBytes: narrow });
  h.textures.setWanted(['jupiter']);
  await settle(h, 'high', { budget: narrow.high });
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
  h.textures.setWanted(['moon']);
  await settle(h, 'high', { budget: narrow.high, dt: 0.5 });
  for (let i = 0; i < 40; i += 1) await h.frame(0.5);
  await settle(h, 'high', { budget: narrow.high, dt: 0.5 });
  expect(h.textures.boundFiles('moon').some((f) => f.tier === 'high')).toBe(true);
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('low');
});

test('a detail change drops the maps the new level does not use, and keeps a bound upgrade until its replacement', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['earth']);
  await settle(h, 'high');
  expect(h.textures.boundFiles('earth').some((f) => f.map === 'normal')).toBe(true);
  h.textures.setDetail({ ...DETAIL.medium, normalMaps: false });
  // The next frame still shows the 4096 day map (no dip to the floor while the 2048 one comes).
  await h.frame();
  expect(h.textures.boundFiles('earth').find((f) => f.map === 'day')?.tier).toBe('high');
  await settle(h, 'medium');
  expect(h.textures.boundFiles('earth').some((f) => f.map === 'normal')).toBe(false);
  for (const file of h.textures.boundFiles('earth')) expect(file.tier).toBe('medium');
});

test('the tiers’ budgets hold on every frame with every body raised, also when files unpack to four times their size', async () => {
  for (const inflate of [1, 4]) {
    for (const tier of ['high', 'medium', 'low'] as const) {
      const h = harness(DETAIL[tier], { inflate });
      h.textures.setWanted(['earth', 'moon', 'jupiter', 'saturn']);
      await settle(h, tier);
      expect(h.textures.residentBytes(), `${tier} x${inflate}`).toBeLessThanOrEqual(TEXTURE_BUDGET_BYTES[tier]);
    }
  }
});

test('leaving disposes uploads under way, and files that land after it are not kept', async () => {
  const h = harness(DETAIL.high, { hold: true });
  for (let i = 0; i < 300; i += 1) {
    await h.frame();
    await h.release();
    if (!h.textures.busy()) break;
  }
  const floors = h.loaded.length;
  h.textures.setWanted(['earth']);
  // Four upgrade requests go out and land; one starts uploading and the fifth request goes out.
  await h.frame();
  await h.release();
  await h.frame();
  expect(h.textures.inflightBytes()).toBeGreaterThan(0);
  h.textures.suspend();
  // The fifth lands with the explorer closed.
  await h.release();
  const upgrades = h.loaded.slice(floors);
  expect(upgrades).toHaveLength(mapsFor('earth', DETAIL.high).length);
  for (const texture of upgrades) expect(h.disposed.has(texture), 'an upgrade kept after leaving').toBe(true);
  expect(h.textures.inflightBytes()).toBe(0);
  for (const body of BODIES) for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('low');
});
