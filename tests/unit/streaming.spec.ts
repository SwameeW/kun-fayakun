/**
 * The explorer's texture streaming (src/explore/assets/streaming.ts) against the real planets.json,
 * with a stand-in loader that hands back textures of each file's size without a GPU: every body's
 * Low files first, then only the focus raised to the detail's tier; maps a detail level does not
 * use are never fetched; at most one texture is uploaded per frame and bound the frame after; an
 * upgrade the focus no longer wants is dropped after its hold, and leaving drops them all; nothing
 * resident ever exceeds the tier's budget.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DataTexture, RGBAFormat, UnsignedByteType, type Texture } from 'three/webgpu';
import type { AssetLoader } from '../../src/core/types';
import { DETAIL, type ExploreDetail } from '../../src/explore/detail';
import type { PlanetsManifest } from '../../src/explore/assets/planets';
import { createPlanetTextures, estimateBytes, mapsFor, TEXTURE_BUDGET_BYTES, type PlanetTextures } from '../../src/explore/assets/streaming';

const manifest = JSON.parse(readFileSync(new URL('../../public/assets/planets/planets.json', import.meta.url), 'utf8')) as PlanetsManifest;

interface Harness {
  textures: PlanetTextures;
  requested: string[];
  uploaded: Texture[];
  /** Resolves every request made so far. */
  deliver(): Promise<void>;
}

function harness(detail: ExploreDetail): Harness {
  const requested: string[] = [];
  const pending: Array<() => void> = [];
  const uploaded: Texture[] = [];
  const assets: AssetLoader = {
    ktx2(url) {
      requested.push(url);
      const file = manifest.files.find((f) => f.path === url);
      if (!file) return Promise.reject(new Error(`unknown ${url}`));
      // A texture holding one mip level of the file's estimated size (enough for the byte count).
      const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
      (texture as unknown as { mipmaps: Array<{ data: Uint8Array }> }).mipmaps = [{ data: new Uint8Array(estimateBytes(file)) }];
      return new Promise((resolve) => pending.push(() => { resolve(texture); }));
    },
    texture: () => Promise.reject(new Error('unused')),
    json: () => Promise.reject(new Error('unused')),
    binary: () => Promise.reject(new Error('unused')),
    url: (p) => p,
  };
  const textures = createPlanetTextures({ assets, manifest, detail, upload: (t) => uploaded.push(t) });
  return {
    textures,
    requested,
    uploaded,
    async deliver() {
      for (const resolve of pending.splice(0)) resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** Runs frames until nothing is in flight or waiting (delivering every request as it is made). */
async function settle(h: Harness, dt = 1 / 60, maxFrames = 400): Promise<number> {
  let frames = 0;
  for (; frames < maxFrames; frames += 1) {
    h.textures.update(dt);
    await h.deliver();
    if (!h.textures.busy()) break;
  }
  h.textures.update(dt);
  return frames;
}

const tierOf = (path: string): string | undefined => manifest.files.find((f) => f.path === path)?.tier;

test('on entry only the Low files of the maps the detail uses are fetched', async () => {
  const h = harness(DETAIL.high);
  await settle(h);
  const wanted = (['earth', 'moon', 'jupiter', 'saturn'] as const).flatMap((b) => mapsFor(b, DETAIL.high).map((m) => `${b}/${m}`));
  expect(h.requested).toHaveLength(wanted.length);
  for (const path of h.requested) expect(tierOf(path)).toBe('low');
  for (const body of ['earth', 'moon', 'jupiter', 'saturn'] as const) {
    for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('low');
  }
});

test('Low detail never fetches the relief or the night lights', async () => {
  const h = harness(DETAIL.low);
  h.textures.setWanted(['earth', 'moon']);
  await settle(h);
  expect(h.requested.some((p) => /normal|night/.test(p))).toBe(false);
  // Low detail streams the Low tier for the focus too.
  for (const path of h.requested) expect(tierOf(path)).toBe('low');
});

test('the focus is raised to the detail tier; others stay at Low', async () => {
  const h = harness(DETAIL.high);
  await settle(h);
  h.textures.setWanted(['earth']);
  await settle(h);
  for (const file of h.textures.boundFiles('earth')) expect(file.tier).toBe('high');
  for (const file of h.textures.boundFiles('jupiter')) expect(file.tier).toBe('low');
  expect(h.textures.residentBytes()).toBeLessThanOrEqual(TEXTURE_BUDGET_BYTES.high);
});

test('at most one texture is uploaded per frame', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['earth', 'moon']);
  for (let frame = 0; frame < 200; frame += 1) {
    const before = h.uploaded.length;
    h.textures.update(1 / 60);
    // Every request resolves at once: uploads still come one frame at a time.
    await h.deliver();
    // Placeholders are uploaded as their slots are made (a few bytes each); files one per frame.
    const files = h.uploaded.slice(before).filter((t) => !t.name.startsWith('placeholder'));
    expect(files.length).toBeLessThanOrEqual(1);
  }
});

test('an upgrade is dropped a while after the focus moves on, and leaving drops them all', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['jupiter']);
  await settle(h);
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
  h.textures.setWanted(['saturn']);
  await settle(h);
  // Still held a moment after leaving the focus...
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('high');
  // ...then back to its floor.
  for (let i = 0; i < 10; i += 1) h.textures.update(1);
  expect(h.textures.boundFiles('jupiter')[0]?.tier).toBe('low');
  h.textures.suspend();
  for (const body of ['earth', 'moon', 'jupiter', 'saturn'] as const) {
    for (const file of h.textures.boundFiles(body)) expect(file.tier).toBe('low');
  }
});

test('a detail change drops the maps the new level does not use', async () => {
  const h = harness(DETAIL.high);
  h.textures.setWanted(['earth']);
  await settle(h);
  expect(h.textures.boundFiles('earth').some((f) => f.map === 'normal')).toBe(true);
  h.textures.setDetail(DETAIL.low);
  await settle(h);
  expect(h.textures.boundFiles('earth').some((f) => f.map === 'normal' || f.map === 'night')).toBe(false);
  for (const file of h.textures.boundFiles('earth')) expect(file.tier).toBe('low');
});

test('the tiers’ budgets hold every body raised at once', async () => {
  for (const tier of ['high', 'medium', 'low'] as const) {
    const h = harness(DETAIL[tier]);
    h.textures.setWanted(['earth', 'moon', 'jupiter', 'saturn']);
    await settle(h);
    expect(h.textures.residentBytes(), tier).toBeLessThanOrEqual(TEXTURE_BUDGET_BYTES[tier]);
  }
});
