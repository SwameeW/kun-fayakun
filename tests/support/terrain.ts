/**
 * Terrain for the walk's tests (src/explore/walk/terrain, png): PNGs of 8-bit RGB rows made with Node's
 * zlib (any of the five row filters), and terrarium tiles (height = R x 256 + G + B / 256 - 32768 m)
 * made on request from a height field over the world (latitude, longitude), the same at every zoom, so a
 * ridge or a cliff stands where it is whichever tiles the ground reads.
 */
import type { Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

/** A PNG of 8-bit RGB rows, each row filtered with the given filter type (PNG section 9), from Node's zlib. */
export function pngOf(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filters: readonly number[]): Uint8Array {
  const bpp = 3;
  const stride = width * bpp;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * stride + x * bpp);
  const out = new Uint8Array(height * (stride + 1));
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const type = filters[y % filters.length] ?? 0;
    out[y * (stride + 1)] = type;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * stride + x] ?? 0;
      const a = x >= bpp ? (raw[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (raw[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (raw[(y - 1) * stride + x - bpp] ?? 0) : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type] ?? 0;
      out[y * (stride + 1) + 1 + x] = (v - predicted) & 0xff;
    }
  }
  const chunk = (name: string, body: Uint8Array): Uint8Array => {
    const c = new Uint8Array(12 + body.length);
    const view = new DataView(c.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i += 1) c[4 + i] = name.charCodeAt(i);
    c.set(body, 8);
    return c;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(out))), chunk('IEND', new Uint8Array(0))];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    file.set(p, at);
    at += p.length;
  }
  return file;
}

/** A 256 px terrarium tile (Web Mercator z, x, y) of a height field (m) over latitude and longitude (degrees). */
export function terrariumTile(z: number, x: number, y: number, height: (lat: number, lon: number) => number): Uint8Array {
  const n = 2 ** z;
  return pngOf(
    256,
    256,
    (px, py) => {
      const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / 256)) / n))) * 180) / Math.PI;
      const v = Math.max(0, Math.min(65535.99, height(lat, lon) + 32768));
      return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v % 1) * 256)];
    },
    [0],
  );
}

/** Answers the page's terrain tiles (the AWS Terrain Tiles' host) from a height field, made per tile. */
export async function routeTerrain(page: Page, height: (lat: number, lon: number) => number): Promise<void> {
  await page.route(/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/u, async (route) => {
    const [, z, x, y] = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/u.exec(route.request().url()) ?? [];
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: Buffer.from(terrariumTile(Number(z), Number(x), Number(y), height)) as Buffer });
  });
}
