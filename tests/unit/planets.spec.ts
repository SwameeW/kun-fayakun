/**
 * The planet textures (scripts/planets) as a runtime will see them: planets.json lists every map
 * at every published tier, each file's KTX2 header agrees with its entry (size, mip chain, colour
 * space, rows stored bottom-up), and src/explore/assets/planets.ts turns places into the texture
 * coordinates the manifest documents. Whether those coordinates hold the right texels is checked
 * on decoded files by tests/explore/planet-textures.spec.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { readKtx2Header, TRANSFER } from '../../scripts/lib/ktx2';
import { findPlanetTexture, planetCredits, planetUv, ringU, type PlanetMap, type PlanetsManifest, type PlanetTexture } from '../../src/explore/assets/planets';

const PUBLIC = new URL('../../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('assets/planets/planets.json', PUBLIC), 'utf8')) as PlanetsManifest & {
  facts: { jupiter: { greatRedSpot: { westLongitudeSystemIII: number; latitudePlanetographic: number } } };
  bodies: { saturn: { maps: { rings: { alpha?: string; channels: Record<string, string> } } } };
};
const TIERS = ['low', 'medium', 'high'] as const;
const MAPS: Record<string, PlanetMap[]> = {
  earth: ['day', 'night', 'clouds', 'water', 'normal'],
  moon: ['colour', 'normal'],
  jupiter: ['colour'],
  saturn: ['colour', 'rings'],
};

const texture = (body: keyof typeof MAPS, map: PlanetMap, tier: (typeof TIERS)[number]): PlanetTexture => {
  const found = findPlanetTexture(manifest, body as PlanetTexture['body'], map, tier);
  if (!found) throw new Error(`no ${body}/${map} at ${tier}`);
  return found;
};

test('every map is published at Low, Medium and High, and nothing else', () => {
  for (const [body, maps] of Object.entries(MAPS)) {
    for (const map of maps) for (const tier of TIERS) expect(texture(body, map, tier).path).toMatch(new RegExp(`^assets/planets/${body}/${map}-\\d+-\\w+\\.ktx2$`));
  }
  expect(manifest.files).toHaveLength(Object.values(MAPS).flat().length * TIERS.length);
  expect(manifest.tiers.ultra.published).toBe(false);
});

test('tiers never shrink and stay within the WebGPU default limit', () => {
  for (const [body, maps] of Object.entries(MAPS)) {
    for (const map of maps) {
      const widths = TIERS.map((t) => texture(body, map, t).width);
      expect(widths[0], `${body}/${map}`).toBeLessThanOrEqual(widths[1] ?? 0);
      expect(widths[1], `${body}/${map}`).toBeLessThanOrEqual(widths[2] ?? 0);
      expect(Math.max(...widths)).toBeLessThanOrEqual(8192);
    }
  }
  expect(texture('earth', 'day', 'low').width).toBe(1024);
  expect(texture('earth', 'day', 'medium').width).toBe(2048);
  expect(texture('earth', 'day', 'high').width).toBe(4096);
  // Every map whose source reaches 4096 ships it at High, the Moon's relief included.
  for (const [body, map] of [['earth', 'normal'], ['moon', 'colour'], ['moon', 'normal'], ['jupiter', 'colour']] as const) {
    expect(texture(body, map, 'high').width, `${body}/${map}`).toBe(4096);
  }
});

test('the ring strip declares straight alpha, as it is built', () => {
  const rings = manifest.bodies.saturn.maps.rings;
  expect(rings.alpha).toBe('straight');
  expect(rings.channels.rgb).toMatch(/^straight alpha \(not premultiplied\)/);
  expect(rings.channels.rgb).not.toMatch(/treat as premultiplied/);
});

test('each file header matches its entry: size, full mip chain, colour space, bottom-up rows', () => {
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const url = new URL(entry.path, PUBLIC);
    expect(existsSync(url), entry.path).toBe(true);
    const bytes = readFileSync(url);
    expect(bytes.byteLength, entry.path).toBe(entry.bytes);
    const header = readKtx2Header(bytes);
    if (typeof header === 'string') throw new Error(`${entry.path}: ${header}`);
    expect([header.pixelWidth, header.pixelHeight], entry.path).toEqual([entry.width, entry.height]);
    expect(header.levelCount, entry.path).toBe(Math.log2(Math.max(entry.width, entry.height)) + 1);
    expect(header.transferFunction, entry.path).toBe(entry.colorSpace === 'srgb' ? TRANSFER.srgb : TRANSFER.linear);
    expect(header.orientation, entry.path).toBe('ru');
    expect(entry.rowsBottomUp).toBe(true);
  }
});

test('planetUv and ringU apply the manifest longitude, latitude and radius conventions', () => {
  const day = texture('earth', 'day', 'low');
  // Greenwich and the equator are the middle of an Earth map; 180 E is its edge.
  expect(planetUv(day, 0, 0)).toEqual([0.5, 0.5]);
  expect(planetUv(day, 180, 90)[0]).toBeCloseTo(0, 9);
  expect(planetUv(day, -90, -90)).toEqual([0.25, 0]);
  // Jupiter's map starts at System III 0 W on the left and west longitude falls to the right.
  const jupiter = texture('jupiter', 'colour', 'high');
  const grs = manifest.facts.jupiter.greatRedSpot;
  const [u, v] = planetUv(jupiter, 360 - grs.westLongitudeSystemIII, grs.latitudePlanetographic);
  expect(u).toBeCloseTo((360 - grs.westLongitudeSystemIII) / 360, 9);
  expect(v).toBeGreaterThan(0.3);
  expect(v).toBeLessThan(0.5);
  // The B ring's core sits about halfway across the strip, the Encke Gap near its outer end.
  const rings = texture('saturn', 'rings', 'low');
  expect(ringU(rings, 107_500)).toBeGreaterThan(0.45);
  expect(ringU(rings, 107_500)).toBeLessThan(0.5);
  expect(ringU(rings, 133_589)).toBeGreaterThan(0.8);
});

test('credits come from the sources and are listed once', () => {
  const credits = planetCredits(manifest.files);
  expect(new Set(credits).size).toBe(credits.length);
  expect(credits).toContain('Made with Natural Earth');
  expect(credits).toContain('NASA/JPL/Space Science Institute');
  const sources = JSON.parse(readFileSync(new URL('../../data/sources.json', import.meta.url), 'utf8')) as { sources: { id: string; credit: string }[] };
  const byId = new Map(sources.sources.map((s) => [s.id, s.credit]));
  for (const entry of manifest.files) {
    expect(byId.get(entry.sourceId), entry.path).toBe(entry.credit);
    for (const extra of entry.alsoFrom ?? []) expect(byId.get(extra.sourceId), entry.path).toBe(extra.credit);
  }
});
