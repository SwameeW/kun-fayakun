/**
 * The explorer's floating origin (src/explore/space/origin.ts): positions are float64 km from the
 * barycentre, and every frame they are made relative to the camera before anything becomes float32.
 */
import { expect, test } from '@playwright/test';
import { eclipticToRender, FloatingOrigin, km, length, renderToEcliptic, type Km } from '../../src/explore/space/origin';
import { placeScaled } from '../../src/explore/space/scaled-space';

const AU_KM = 149_597_870.7;

test('the rebase keeps relative positions within 1 mm at 30 au', () => {
  const origin = new FloatingOrigin();
  // A camera 30 au out, off every axis, and bodies a few km to a few thousand km from it.
  const camera = km(30 * AU_KM, 0.37 * AU_KM, -0.11 * AU_KM);
  origin.setCamera(camera);
  const offsets: Km[] = [km(1, 0, 0), km(12_345.6789, -2_345.6789, 987.654321), km(-0.25, 0.5, -0.125), km(4_000_000, 1_000, -77)];
  for (const offset of offsets) {
    const world = km(camera.x + offset.x, camera.y + offset.y, camera.z + offset.z);
    const rel = origin.relative(world, km());
    const errorKm = Math.hypot(rel.x - offset.x, rel.y - offset.y, rel.z - offset.z);
    expect(errorKm, `offset ${JSON.stringify(offset)}`).toBeLessThan(1e-6);
  }
  // Two bodies 1 km apart out there keep their separation to the millimetre after the rebase.
  const a = origin.relative(km(camera.x + 5000, camera.y, camera.z), km());
  const b = origin.relative(km(camera.x + 5001, camera.y, camera.z), km());
  expect(Math.abs(b.x - a.x - 1)).toBeLessThan(1e-6);
});

test('what the GPU gets (float32) is fine relative to the camera, and would not be absolute', () => {
  const origin = new FloatingOrigin();
  const camera = km(30 * AU_KM, 0, 0);
  origin.setCamera(camera);
  const offset = km(20_000, 3_000, -1_000);
  const rel = origin.relative(km(camera.x + offset.x, camera.y + offset.y, camera.z + offset.z), km());
  const f32 = km(Math.fround(rel.x), Math.fround(rel.y), Math.fround(rel.z));
  // 20,000 km from the camera, float32 is good to about a metre.
  expect(Math.hypot(f32.x - offset.x, f32.y - offset.y, f32.z - offset.z)).toBeLessThan(0.002);
  // The same body in absolute float32 coordinates would be off by hundreds of km.
  expect(Math.abs(Math.fround(camera.x + offset.x) - (camera.x + offset.x))).toBeGreaterThan(10);
});

test('camera-relative coordinates stay inside the far plane once scaled space has placed them', () => {
  const far = 2e6;
  const cases: Array<[Km, number]> = [
    [km(1.5e8, 0, 0), 695_700],
    [km(-4e8, 2e8, 5e8), 71_492],
    [km(3, -4, 1e9), 144_987.5],
    [km(1e12, 0, 0), 60_000],
    [km(5e5, 0, 0), 6_378],
  ];
  for (const [rel, bound] of cases) {
    const drawn = km();
    const k = placeScaled(rel, bound, far, drawn);
    expect(length(drawn) + bound * k, JSON.stringify(rel)).toBeLessThanOrEqual(0.95 * far + 1e-6);
  }
});

test('the render frame is a proper rotation of the ecliptic, ecliptic north up', () => {
  const north = eclipticToRender(km(0, 0, 1), km());
  expect(north).toEqual({ x: 0, y: 1, z: -0 });
  const v = km(1.25, -2.5, 3.75);
  const back = renderToEcliptic(eclipticToRender(v, km()), km());
  expect(back).toEqual(v);
  // Right-handed: x cross y = z holds in both frames.
  const x = eclipticToRender(km(1, 0, 0), km());
  const y = eclipticToRender(km(0, 1, 0), km());
  const z = eclipticToRender(km(0, 0, 1), km());
  expect(x.y * y.z - x.z * y.y).toBeCloseTo(z.x, 12);
  expect(x.z * y.x - x.x * y.z).toBeCloseTo(z.y, 12);
  expect(x.x * y.y - x.y * y.x).toBeCloseTo(z.z, 12);
});
