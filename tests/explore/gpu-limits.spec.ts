/**
 * The GPU's per-stage limits (src/explore; three.js's WebGPURenderer): no pipeline the explorer builds
 * binds more than 16 sampled textures, or 16 samplers, in any one stage, the most WebGPU's default
 * limits allow (maxSampledTexturesPerShaderStage, maxSamplersPerShaderStage) and all many phones and
 * integrated GPUs offer. Past it the pipeline fails and its mesh is not drawn for the visitor (the Earth
 * did: its surface came to 19 once its imagery had streamed in). The page is held to the default limits
 * whatever the renderer asks for, and each pipeline's bindings are counted where the browser is asked for
 * them, stage by stage over every bind group of its layout.
 *
 * A material is counted at its largest: three.js gives texture nodes that hold the same texture when a
 * material is built one binding, so a material built over less streamed in can show fewer than it will
 * later need. So the tour streams first and builds after: the Earth close in with each imagery
 * streamed in turn (src/explore/earth-tiles), every detail level built afresh over each; then on foot on
 * all five worlds, and out among the stars to a black hole. On WebGL2 (16 texture units on many GPUs,
 * this one's too) the same tour must log no error: a program past them fails to link there.
 */
import type { Page } from '@playwright/test';
import { expect, test, type KfHook } from '../support/fixtures';
import { NEEDS_GPU, NO_GPU, SLOW } from '../support/env';
import { JD, place, view, waitForUniverse } from '../support/universe';
import type { WalkableWorld } from '../../src/core/types';

const LIVE = { timeout: 90_000 * SLOW };
/** WebGPU's default limit on sampled textures, and on samplers, in one stage of a pipeline. */
const LIMIT = 16;

/** A pipeline's sampled textures and samplers per stage: vertex, fragment, compute. */
interface Built {
  label: string;
  textures: number[];
  samplers: number[];
}
interface GpuRecord {
  pipelines: Built[];
  limits: { textures: number; samplers: number } | null;
}

/** Runs before the page's scripts: the device held to WebGPU's default limits, and every pipeline's bindings recorded. */
function record(): void {
  const g = globalThis as unknown as { __kfLimits: GpuRecord; GPUAdapter?: typeof GPUAdapter; GPUDevice?: typeof GPUDevice };
  const out: GpuRecord = { pipelines: [], limits: null };
  g.__kfLimits = out;
  if (!g.GPUAdapter || !g.GPUDevice) return;
  // The prototypes' methods, typed as the functions of `this` they are (replaced below, each calling its original).
  type Adapter = { requestDevice: (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) => Promise<GPUDevice> };
  type Device = {
    createBindGroupLayout: (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) => GPUBindGroupLayout;
    createPipelineLayout: (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) => GPUPipelineLayout;
  };
  const adapter = g.GPUAdapter.prototype as unknown as Adapter;
  const requestDevice = adapter.requestDevice;
  adapter.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
    const limits: Record<string, number | undefined> = { ...descriptor?.requiredLimits };
    delete limits['maxSampledTexturesPerShaderStage'];
    delete limits['maxSamplersPerShaderStage'];
    const device = await requestDevice.call(this, { ...descriptor, requiredLimits: limits });
    out.limits = { textures: device.limits.maxSampledTexturesPerShaderStage, samplers: device.limits.maxSamplersPerShaderStage };
    return device;
  };
  type Counts = { textures: number[]; samplers: number[] };
  const groups = new WeakMap<object, Counts>();
  const layouts = new WeakMap<object, Counts>();
  const device = g.GPUDevice.prototype as unknown as Device;
  const createBindGroupLayout = device.createBindGroupLayout;
  device.createBindGroupLayout = function (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) {
    const c: Counts = { textures: [0, 0, 0], samplers: [0, 0, 0] };
    for (const e of descriptor.entries) {
      // An external texture counts as four sampled textures and a sampler (the WebGPU specification's binding limits).
      const textures = e.texture ? 1 : e.externalTexture ? 4 : 0;
      const samplers = e.sampler || e.externalTexture ? 1 : 0;
      for (let stage = 0; stage < 3; stage += 1) {
        if ((e.visibility & (1 << stage)) === 0) continue;
        c.textures[stage] = (c.textures[stage] ?? 0) + textures;
        c.samplers[stage] = (c.samplers[stage] ?? 0) + samplers;
      }
    }
    const layout = createBindGroupLayout.call(this, descriptor);
    groups.set(layout, c);
    return layout;
  };
  const createPipelineLayout = device.createPipelineLayout;
  device.createPipelineLayout = function (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) {
    const c: Counts = { textures: [0, 0, 0], samplers: [0, 0, 0] };
    for (const group of descriptor.bindGroupLayouts) {
      const counts = group ? groups.get(group) : undefined;
      for (let stage = 0; stage < 3; stage += 1) {
        c.textures[stage] = (c.textures[stage] ?? 0) + (counts?.textures[stage] ?? 0);
        c.samplers[stage] = (c.samplers[stage] ?? 0) + (counts?.samplers[stage] ?? 0);
      }
    }
    const layout = createPipelineLayout.call(this, descriptor);
    layouts.set(layout, c);
    return layout;
  };
  // Pipelines with an 'auto' layout (three's own mipmap passes) bind one texture each: not counted.
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync'] as const) {
    const methods = device as unknown as Record<string, (this: GPUDevice, d: { label?: string; layout: object | 'auto' }) => unknown>;
    const original = methods[name];
    if (!original) continue;
    methods[name] = function (this: GPUDevice, d: { label?: string; layout: object | 'auto' }) {
      const c = d.layout === 'auto' ? undefined : layouts.get(d.layout);
      if (c) out.pipelines.push({ label: d.label ?? '', ...c });
      return original.call(this, d);
    };
  }
}

const recorded = (page: Page): Promise<GpuRecord> => page.evaluate(() => (globalThis as unknown as { __kfLimits: GpuRecord }).__kfLimits);

/** Both of a layer's imagery streamed in close up: some tiles written, none still asked for. */
async function streamed(page: Page, layer: 'clear' | 'today'): Promise<void> {
  await expect
    .poll(async () => {
      const s = (await view(page))?.imagery?.[layer];
      return s ? s.loaded > 0 && s.pending === 0 : false;
    }, LIVE)
    .toBe(true);
}

/** On foot somewhere, landed. */
async function walk(page: Page, world: WalkableWorld, lat: number, lon: number): Promise<void> {
  if (world !== 'earth') {
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walkEnd' });
    });
    await expect.poll(async () => (await view(page))?.walk ?? null, LIVE).toBeNull();
    await place(page, { body: world, distanceKm: 7000, azimuthDeg: 40, elevationDeg: 15 });
    await expect.poll(async () => (await view(page))?.walkHere?.world ?? null, LIVE).toBe(world);
  }
  await page.evaluate((a) => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walk', ...a });
  }, { world, lat, lon, headingDeg: 0, pitchDeg: -5 });
  await expect.poll(async () => (await view(page))?.walk?.state, LIVE).toBe('walking');
  // A few frames on the ground, so whatever it draws is built.
  await page.waitForTimeout(1500);
}

test.use({ reducedMotion: 'reduce' });

test('every pipeline within 16 sampled textures and 16 samplers a stage, each material at its largest, on WebGPU’s default limits', async ({ page, kf, pageErrors }) => {
  test.skip(NO_GPU, NEEDS_GPU);
  test.setTimeout(360_000 * SLOW);
  await page.addInitScript(record);
  await kf.open('/universe/earth', { query: { jd: JD } });
  await waitForUniverse(page);
  // Close over Makkah, each imagery streamed in turn (every level of its clipmap made and written), and
  // over each every detail level built afresh (each builds its own Earth, clouds and air), back to the first.
  const start = (await view(page))?.detail;
  const tiers = [...(start?.available ?? []).filter((t) => t !== start?.tier), start?.tier ?? 'high'];
  const everyLevel = async (): Promise<void> => {
    for (const tier of tiers) {
      await page.evaluate((t) => {
        (window as unknown as KfHook).__kf.app.setUniverseDetail(t);
      }, tier);
      await expect(page.locator('html')).toHaveAttribute('data-detail', tier, LIVE);
      await page.waitForTimeout(2000);
    }
  };
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'goto', lat: 21.4225, lon: 39.8261, viewKm: 30 });
  });
  await streamed(page, 'clear');
  await everyLevel();
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'imagery', mode: 'today' });
  });
  await streamed(page, 'today');
  await everyLevel();
  // On foot on all five worlds (on the Earth outside the 25 km about the Kaaba where walks are not begun).
  await walk(page, 'earth', 21.4225 + 25.3 / 111.32, 39.8261);
  await walk(page, 'moon', 0.67416, 23.47314);
  await walk(page, 'mars', 18.4447, 77.4508);
  await walk(page, 'mercury', 27.6, 57.6);
  await walk(page, 'venus', -7.55, -56.31);
  // Out among the stars, and to a black hole (its lensed sky).
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.earthCommand({ kind: 'walkEnd' });
  });
  await expect.poll(async () => (await view(page))?.walk ?? null, LIVE).toBeNull();
  await page.getByTestId('stars-open').click();
  await expect.poll(async () => (await view(page))?.neighbourhood?.blackHoles.length ?? 0, LIVE).toBeGreaterThan(0);
  await page.getByTestId('stars-bh-sgr-a').click();
  await expect.poll(async () => (await view(page))?.neighbourhood?.blackHole?.id ?? null, LIVE).toBe('sgr-a');
  await expect.poll(async () => (await view(page))?.neighbourhood?.travelling, LIVE).toBe(false);
  await page.waitForTimeout(1500);

  const backend = await kf.htmlData('backend');
  if (backend === 'webgpu') {
    const { pipelines, limits } = await recorded(page);
    // The page ran on the default limits, and the tour built the Earth's surface at every level.
    expect(limits).toEqual({ textures: LIMIT, samplers: LIMIT });
    expect(pipelines.length).toBeGreaterThan(50);
    const worst = [...pipelines].sort((a, b) => Math.max(...b.textures) - Math.max(...a.textures)).slice(0, 5);
    test.info().annotations.push({ type: 'most sampled textures a stage', description: worst.map((p) => `${p.label}: ${p.textures.join('/')}`).join(', ') });
    for (const p of pipelines) {
      expect(Math.max(...p.textures), `${p.label} sampled textures (vertex/fragment/compute ${p.textures.join('/')})`).toBeLessThanOrEqual(LIMIT);
      expect(Math.max(...p.samplers), `${p.label} samplers (vertex/fragment/compute ${p.samplers.join('/')})`).toBeLessThanOrEqual(LIMIT);
    }
  }
  expect(pageErrors).toEqual([]);
});
