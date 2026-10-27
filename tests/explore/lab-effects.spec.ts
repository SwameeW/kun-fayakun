/**
 * How the laboratory's experiments are drawn (src/explore/lab-fx; docs/SANDBOX-ROADMAP.md M1), read
 * back through window.__kf.universe.labDraw() and the canvas:
 * - a torn Moon's pieces are lit grey rocks at their engine size (a mesh, not a point, with a disc of the
 *   right size), dark in the Earth's shadow; its dust a grey haze sized by its spacing, none lit in the
 *   shadow, spreading into a ring that is then drawn as a band; one name for the eight pieces, no names
 *   meeting at any of five window sizes;
 * - a world drawn at the experiment's radius, eased (never a jump), and back on undo;
 * - a thrown Mars striking the Earth: the clock slows for it (on by default) and is back to full speed
 *   within four seconds of it; its fireball within a frame of the event, easing in no faster than a
 *   thirtieth of its peak a frame, never above its ceiling; the debris glowing and cooling; the same events
 *   with the slowing off; the event card's numbers;
 * - ten stones striking the Moon at once: never more than two fireballs rising a second, and the picture
 *   never flashing more than three times a second in any part of it.
 */
import type { Page } from '@playwright/test';
import type { LabCommand, LabEditResult, UniverseLab } from '../../src/core/types';
import { expect, test, type KfHook } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 90_000 * SLOW };
test.use({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });

interface Report {
  tier: string;
  bodies: Array<{ id: string; discPx: number; projectedPx: number; axis: number; mesh: number; point: number; lit: number; light: { x: number; y: number } | null; drawnRadiusKm: number; screen: { x: number; y: number } | null; irregular: number; star: boolean; glow: number }>;
  meshes: [number, number, number];
  dust: { drawn: number; medianSizePx: number; color: [number, number, number]; shadowed: number; brightest: number };
  annuli: Array<{ id: string; weight: number; coverageDeg: number }>;
  fireballs: Array<{ key: string; strength: number; luminance: number; kelvin: number; radiusKm: number; radiusPx: number }>;
  light: number;
  scale: Record<string, number>;
}

/** A Mars thrown at the Earth: 20 km/s far away, 80 degrees from the ground, in ten days, at a fixed place (so two runs are the same run). */
const AIM: LabCommand = { kind: 'aim', target: 'earth', impactor: 'mars', vInfKmS: 20, angleDeg: 80, leadS: 10 * 86_400, site: [0.6, -0.5, 0.62], heading: [0, 0, 1] };

const lab = async (page: Page): Promise<UniverseLab | null> => (await view(page))?.lab ?? null;
const draw = (page: Page): Promise<Report | null> => page.evaluate(() => ((window as unknown as KfHook).__kf.universe.labDraw?.() ?? null) as Report | null);
const command = (page: Page, c: LabCommand): Promise<LabEditResult> =>
  page.evaluate(async (x) => {
    const answer = await (window as unknown as KfHook).__kf.universe.lab?.(x);
    if (!answer) throw new Error('the laboratory is not loaded');
    return answer;
  }, c);

async function openLab(page: Page): Promise<void> {
  await page.getByTestId('lab-open').click();
  await expect(page.getByTestId('lab-panel')).toBeVisible(LIVE);
  await expect.poll(async () => (await lab(page))?.bodies.length ?? 0, LIVE).toBe(10);
  // The effects' own chunk, loaded with the experiment.
  await expect.poll(async () => (await draw(page))?.tier ?? null, LIVE).not.toBeNull();
}

/** Back to the fork, paused (a deterministic start). */
async function fork(page: Page): Promise<void> {
  await command(page, { kind: 'reset' });
  await expect.poll(async () => (await lab(page))?.paused, LIVE).toBe(true);
  await expect.poll(async () => (await lab(page))?.elapsedS, LIVE).toBe(0);
}

const run = (page: Page, rate: number): Promise<void> =>
  page.evaluate((r) => {
    // A rate runs the clock (paused or not).
    (window as unknown as KfHook).__kf.app.universeTime({ kind: 'rate', rate: r });
  }, rate);

/** The tags shown (opacity over a tenth): text and box. */
const tags = (page: Page): Promise<Array<{ text: string; x: number; y: number; w: number; h: number }>> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.kf-hud-tag')]
      .filter((el) => Number(getComputedStyle(el.closest('[style]') ?? el).opacity) > 0.1 && el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
      }),
  );

test.describe('the laboratory drawn as what it holds', () => {
  test('a torn Moon: lit grey rocks at their size, dark in the shadow; grey dust spreading into a ring drawn as a band; one name for the pieces, none meeting, at five window sizes', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    // The Moon on a circular orbit at 15,000 km: inside its fluid Roche limit (about 18,400 km).
    expect(await command(page, { kind: 'elements', id: 'moon', aKm: 15_000, e: 0, iDeg: 5, nodeDeg: 0, periapsisArgDeg: 0, trueAnomalyDeg: 0 })).toEqual({ ok: true, created: [] });
    await run(page, 3600);
    await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('moon-piece-')).length, LIVE).toBe(8);
    const minLit = new Map<string, number>();
    let annulus = 0;
    let checked = 0;
    for (let k = 0; k < 40; k += 1) {
      await page.waitForTimeout(400);
      const r = await draw(page);
      const l = await lab(page);
      if (!r || !l) continue;
      for (const b of r.bodies.filter((x) => x.id.startsWith('moon-piece-'))) {
        const engine = l.bodies.find((x) => x.id === b.id);
        // At the engine's radius, as a mesh once its disc is a few pixels across (no 40 px cap, no point).
        expect(b.drawnRadiusKm).toBeCloseTo(engine?.radiusKm ?? 0, 6);
        expect(b.irregular).toBe(0);
        if (b.discPx > 3) {
          expect(b.mesh).toBeGreaterThan(0.99);
          expect(b.point).toBeLessThan(0.01);
          checked += 1;
        }
        minLit.set(b.id, Math.min(minLit.get(b.id) ?? 1, b.lit));
      }
      // The dust: grey (the Moon's rock), a haze wider than the old 3.2 px points.
      if (r.dust.drawn > 0) {
        const [cr, cg, cb] = r.dust.color;
        expect(Math.abs(cr - cg)).toBeLessThan(0.04);
        expect(Math.abs(cg - cb)).toBeLessThan(0.04);
        expect(r.dust.medianSizePx).toBeGreaterThan(3.2);
        // Never brighter than the Moon's own rock in full sunlight (albedo 0.12 at the Earth's distance from the Sun, about 1.0 of the light at 1 au): a haze, not points of light.
        expect(r.dust.brightest).toBeLessThanOrEqual(0.12 * 1.04);
      }
      annulus = Math.max(annulus, r.annuli.find((a) => a.id.startsWith('dust-moon'))?.weight ?? 0);
    }
    expect(checked).toBeGreaterThan(20);
    // Each piece passes behind the Earth in its shadow: there it is unlit.
    expect([...minLit.values()].some((v) => v <= 0.02)).toBe(true);
    const r = await draw(page);
    expect(r?.dust.shadowed).toBeGreaterThan(0);
    // Spread round the Earth, the dust is drawn as a band.
    expect(annulus).toBeGreaterThan(0.9);
    // One name for the pieces; none meeting another, none under the panel, at five window sizes.
    for (const [width, height] of [[1440, 900], [1920, 1080], [1280, 800], [768, 1024], [390, 844], [844, 390]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(1500);
      const shown = await tags(page);
      expect(shown.filter((t) => /^Moon \d$/u.test(t.text)), `${width}x${height}`).toEqual([]);
      for (let i = 0; i < shown.length; i += 1)
        for (let j = i + 1; j < shown.length; j += 1) {
          const a = shown[i];
          const b = shown[j];
          if (!a || !b) continue;
          const meet = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(meet, `${width}x${height}: ${a.text} meets ${b.text}`).toBe(false);
        }
      const panel = await page.getByTestId('lab-panel').boundingBox();
      for (const t of shown) {
        if (!panel || !/pieces/u.test(t.text)) continue;
        const under = t.x < panel.x + panel.width && panel.x < t.x + t.w && t.y < panel.y + panel.height && panel.y < t.y + t.h;
        expect(under, `${width}x${height}: ${t.text} under the panel`).toBe(false);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await tags(page)).filter((t) => t.text === 'Moon: 8 pieces').length, LIVE).toBe(1);
    // The card says how the dust and its band are drawn (illustrative), and so does the rings section.
    await expect(page.getByTestId('lab-event-dust')).toBeVisible();
    await expect(page.getByTestId('lab-event-dust')).toContainText('illustrative');
    await page.getByTestId('lab-rings').locator('summary').click();
    await expect(page.getByTestId('lab-rings-drawn')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('the torn Moon’s pieces at three window sizes (2000 x 1300, 1440 x 900, 1280 x 800): meshes at their engine size, their projected size their disc’s within 5 per cent', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    expect(await command(page, { kind: 'elements', id: 'moon', aKm: 15_000, e: 0, iDeg: 5, nodeDeg: 0, periapsisArgDeg: 0, trueAnomalyDeg: 0 })).toEqual({ ok: true, created: [] });
    await run(page, 3600);
    await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('moon-piece-')).length, LIVE).toBe(8);
    for (const [width, height] of [[2000, 1300], [1440, 900], [1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      let checked = 0;
      for (let k = 0; k < 12 && checked < 4; k += 1) {
        await page.waitForTimeout(300);
        const r = await draw(page);
        for (const b of r?.bodies.filter((x) => x.id.startsWith('moon-piece-') && x.discPx > 3 && x.screen) ?? []) {
          expect(b.mesh, `${width}x${height} ${b.id}`).toBeGreaterThan(0.99);
          // Off the view's axis, a perspective view draws it wider across by 1 / cos of its angle off the axis.
          expect(Math.abs((b.projectedPx * b.axis) / b.discPx - 1), `${width}x${height} ${b.id}: ${b.projectedPx} at ${b.axis} against ${b.discPx}`).toBeLessThan(0.05);
          checked += 1;
        }
      }
      expect(checked, `${width}x${height}`).toBeGreaterThan(0);
    }
    expect(pageErrors).toEqual([]);
  });

  test('the two-body laboratory: its star’s disc the size its radius and distance make it (within 2 per cent), its planet lit from the star’s side', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await command(page, { kind: 'start', seed: 'two' });
    await expect.poll(async () => (await lab(page))?.bodies.map((b) => b.id), LIVE).toEqual(['star', 'planet']);
    // At the star (its stand-in), settled.
    await expect.poll(async () => (await view(page))?.trip ?? null, LIVE).toBeNull();
    await page.waitForTimeout(1500);
    const l = await lab(page);
    const r = await draw(page);
    const star = r?.bodies.find((b) => b.id === 'star');
    const radius = l?.bodies.find((b) => b.id === 'star')?.radiusKm ?? 0;
    const distance = (l?.standIn?.altitudeKm ?? 0) + radius;
    // The camera's own field of view and the canvas's height: pixels per unit tangent, by the camera, not by the effects.
    const { fov, height } = await page.evaluate(() => ({ fov: (window as unknown as KfHook).__kf.camera().fov, height: document.querySelector('#scene')?.getBoundingClientRect().height ?? 0 }));
    const pxPerTan = height / 2 / Math.tan((fov * Math.PI) / 360);
    const expected = pxPerTan * Math.tan(Math.asin(Math.min(1, radius / distance)));
    expect(star?.star).toBe(true);
    expect(Math.abs((star?.discPx ?? 0) / expected - 1)).toBeLessThan(0.02);
    expect(Math.abs(((star?.projectedPx ?? 0) * (star?.axis ?? 1)) / expected - 1)).toBeLessThan(0.02);
    // The planet: its light comes from the star's side on screen (the way to the star from it).
    // The planet (1 au out, behind the camera at the star): seen with the star from five au above the plane.
    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.universe.place({ body: 'sun', distanceKm: 7.5e8, azimuthDeg: 0, elevationDeg: 70 });
    });
    await page.waitForTimeout(800);
    const seen = await draw(page);
    const planet = seen?.bodies.find((b) => b.id === 'planet');
    const starNow = seen?.bodies.find((b) => b.id === 'star');
    expect(planet?.lit ?? 0).toBeGreaterThan(0);
    expect(planet?.screen).toBeTruthy();
    expect(planet?.light).toBeTruthy();
    const dx = (starNow?.screen?.x ?? 0) - (planet?.screen?.x ?? 0);
    const dy = (starNow?.screen?.y ?? 0) - (planet?.screen?.y ?? 0);
    const cos = ((planet?.light?.x ?? 0) * dx + (planet?.light?.y ?? 0) * dy) / Math.hypot(dx, dy);
    expect(cos).toBeGreaterThan(Math.cos((3 * Math.PI) / 180));
    expect(pageErrors).toEqual([]);
  });

  test('a world drawn at the experiment’s radius: eased, a thirtieth of the change a frame at most, and back on undo', async ({ page, kf, pageErrors }) => {
    test.setTimeout(240_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    expect((await draw(page))?.scale.moon).toBeCloseTo(1, 6);
    expect(await command(page, { kind: 'radius', id: 'moon', radiusKm: 3000, keep: 'mass' })).toEqual({ ok: true, created: [] });
    // Sampled every frame in the page: never a jump, there within a second or two.
    const samples = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const out: number[] = [];
          const tick = (): void => {
            const r = (window as unknown as KfHook).__kf.universe.labDraw?.() as { scale: Record<string, number> } | null;
            out.push(r?.scale.moon ?? Number.NaN);
            if (out.length < 150) requestAnimationFrame(tick);
            else resolve(out);
          };
          requestAnimationFrame(tick);
        }),
    );
    const target = 3000 / 1737.4;
    for (let k = 1; k < samples.length; k += 1) expect(Math.abs((samples[k] ?? 0) - (samples[k - 1] ?? 0))).toBeLessThanOrEqual((target - 1) / 30 + 1e-9);
    expect(Math.abs((samples.at(-1) ?? 0) / target - 1)).toBeLessThan(0.005);
    // The camera stays outside the grown world.
    expect((await view(page))?.altitudeKm).toBeGreaterThan(0);
    await command(page, { kind: 'undo' });
    await expect.poll(async () => Math.abs(((await draw(page))?.scale.moon ?? 0) - 1), LIVE).toBeLessThan(0.005);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('impacts worth watching (slowing on, as for a visitor)', () => {
  test.use({ labSlow: true });

  test('a thrown Mars striking the Earth: the clock slows for it and comes back; the fireball eases in under its ceiling; the debris glow and cool; the same events with the slowing off', async ({ page, kf, pageErrors }) => {
    test.setTimeout(360_000 * SLOW);
    await kf.open('/universe/earth', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    // On by default.
    expect((await lab(page))?.slow.on).toBe(true);
    await expect(page.getByTestId('lab-slow-toggle')).toBeChecked();
    const throwAndWatch = async (): Promise<{ frames: Array<{ t: number; wall: number; shown: number; slow: number | null; inS: number | null; events: number; fire: number; lum: number; glow: number }> }> => {
      await fork(page);
      await command(page, AIM);
      await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
      expect((await command(page, { kind: 'throw' })).ok).toBe(true);
      await run(page, 86_400);
      // Every frame in the page, until the clock is back at full speed a while after the impact.
      return page.evaluate(
        () =>
          new Promise((resolve) => {
            const frames: Array<{ t: number; wall: number; shown: number; slow: number | null; inS: number | null; events: number; fire: number; lum: number; glow: number }> = [];
            const start = performance.now();
            let after = -1;
            // Timed by the frame (its start), not by when this runs in it: after the render, whose length varies,
            // that would be out by up to a frame either way. The drawn clock with the moment it was last advanced.
            const tick = (frame: number): void => {
              const kf = (window as unknown as KfHook).__kf;
              const l = kf.universe.state()?.lab;
              const r = kf.universe.labDraw?.() as { fireballs: Array<{ strength: number; luminance: number }>; bodies: Array<{ glow: number }>; clock: { ms: number; shownS: number } } | null;
              const t = (frame - start) / 1000;
              const events = l?.events.filter((e) => e.kind === 'fragment' || e.kind === 'merge').length ?? 0;
              frames.push({ t, wall: r?.clock.ms ?? 0, shown: r?.clock.shownS ?? 0, slow: l?.slow.active?.rate ?? null, inS: l?.slow.active?.inS ?? null, events, fire: r?.fireballs[0]?.strength ?? 0, lum: r?.fireballs[0]?.luminance ?? 0, glow: Math.max(0, ...(r?.bodies.map((b) => b.glow) ?? [0])) });
              if (events > 0 && after < 0) after = t;
              if ((after >= 0 && t - after > 8) || t > 90) resolve({ frames });
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    };
    const { frames } = await throwAndWatch();
    const hit = frames.findIndex((f) => f.events > 0);
    expect(hit).toBeGreaterThan(0);
    const at = frames[hit]?.t ?? 0;
    // Seen coming: slowing with the contact still ahead.
    expect(frames.some((f) => f.inS !== null && f.inS > 0)).toBe(true);
    // Within a second either side of the contact the drawn clock ran slowly, frame by frame by its own frame
    // times: at the rate that shows it (an eighth of R/v, about 36 s/s), give or take its steering, which is
    // never more than half as fast again (after a slow frame; src/explore/lab-clock.ts), and no jump.
    const show = 6371 / 22.1 / 8;
    const near = frames.filter((f) => Math.abs(f.t - at) < 1);
    let pairs = 0;
    for (let k = 1; k < near.length; k += 1) {
      const a = near[k - 1];
      const b = near[k];
      if (!a || !b || b.wall - a.wall < 1) continue;
      const drawn = (b.shown - a.shown) / ((b.wall - a.wall) / 1000);
      expect(drawn).toBeLessThanOrEqual(show * 1.5 * (1 + 1e-9));
      pairs += 1;
    }
    expect(pairs).toBeGreaterThan(20);
    // Back to the visitor's own rate within four seconds and a half after it.
    const back = frames.find((f) => f.t > at && f.slow === null);
    expect(back).toBeDefined();
    expect((back?.t ?? 99) - at).toBeLessThan(4.5);
    // The fireball: there within a frame or two of the event; rising no faster than a thirtieth of its peak a frame at 60 frames a second; never above its ceiling (sunlit white ground).
    expect(frames.slice(hit, hit + 3).some((f) => f.fire > 0)).toBe(true);
    for (let k = 1; k < frames.length; k += 1) {
      const a = frames[k - 1];
      const b = frames[k];
      if (!a || !b) continue;
      expect(b.fire - a.fire).toBeLessThanOrEqual((1.5 / 0.8) * Math.max(b.t - a.t, 1 / 60) + 1e-6);
      expect(b.lum).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(Math.max(...frames.map((f) => f.fire))).toBeGreaterThan(0.9);
    // The debris glow (molten), and cool: its glow falls as a crust forms.
    const glows = frames.filter((f) => f.t > at).map((f) => f.glow);
    expect(Math.max(...glows)).toBeGreaterThan(0.05);
    expect(glows.at(-1) ?? 1).toBeLessThan(Math.max(...glows));
    // The event card: what happened, with its numbers.
    await expect(page.getByTestId('lab-event-card')).toBeVisible();
    await expect(page.getByTestId('lab-event-title')).toContainText('Impact: Earth');
    await expect(page.getByTestId('lab-event-facts')).toContainText('km/s at contact');
    await expect(page.getByTestId('lab-event-facts')).toContainText('Thrown at 20');
    const slowEvents = (await lab(page))?.events.map((e) => [e.t, e.kind, e.speedKmS, e.regime]);
    // The same with the slowing off: the same events, exactly (only the rate shown changes).
    await page.getByTestId('lab-slow-toggle').uncheck();
    await expect.poll(async () => (await lab(page))?.slow.on).toBe(false);
    await fork(page);
    await command(page, AIM);
    await expect.poll(async () => (await lab(page))?.aim?.status, LIVE).toBe('ready');
    await command(page, { kind: 'throw' });
    await run(page, 86_400);
    await expect.poll(async () => ((await lab(page))?.elapsedS ?? 0) > (slowEvents?.at(-1)?.[0] as number) + 86_400, LIVE).toBe(true);
    const fastEvents = (await lab(page))?.events.map((e) => [e.t, e.kind, e.speedKmS, e.regime]);
    expect(fastEvents?.slice(0, slowEvents?.length ?? 0)).toEqual(slowEvents);
    expect(pageErrors).toEqual([]);
  });

  test('ten stones striking the Moon at once: at most two fireballs rise a second, and no part of the picture flashes more than three times a second', async ({ page, kf, pageErrors }) => {
    test.setTimeout(300_000 * SLOW);
    await kf.open('/universe/moon', { query: { jd: JD } });
    await waitForUniverse(page);
    await openLab(page);
    await fork(page);
    // Ten one-kilometre stones 2,000 to 2,900 km out, falling straight at the Moon at 3 km/s: they strike within a second or two of one another.
    for (let k = 0; k < 10; k += 1) {
      const d = 2000 + 100 * k;
      const a = (k / 10) * 2 * Math.PI;
      const out = await command(page, { kind: 'addState', relativeTo: 'moon', posKm: [d * Math.cos(a), d * Math.sin(a), 300], velKmS: [-3 * Math.cos(a), -3 * Math.sin(a), -0.4], massKg: 1.5e12, radiusKm: 0.5, name: `stone ${k}` });
      expect(out.ok).toBe(true);
    }
    await run(page, 60);
    // Pictures of the canvas as it runs, each with its time: per tile (341 x 256 CSS px at 1024 wide, scaled), its mean relative luminance.
    const pictures: Array<{ t: number; tiles: number[] }> = [];
    const started = Date.now();
    const rises: number[] = [];
    let lastFire = 0;
    while (Date.now() - started < 30_000) {
      const png = (await page.locator('#scene').screenshot({ style: 'body > :not(#scene), body > :not(#scene) * { visibility: hidden !important; transition: none !important; }' })) as Uint8Array;
      let binary = '';
      for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
      const tiles = await page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const w = bitmap.width;
        const h = bitmap.height;
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext('2d');
        if (!g) return [];
        g.drawImage(bitmap, 0, 0);
        const { data } = g.getImageData(0, 0, w, h);
        const tw = Math.max(1, Math.round((341 * window.innerWidth) / 1024) * (w / window.innerWidth));
        const th = Math.max(1, Math.round((256 * window.innerWidth) / 1024) * (h / window.innerHeight));
        const cols = Math.ceil(w / tw);
        const rows = Math.ceil(h / th);
        const sums = new Array<number>(cols * rows).fill(0);
        const counts = new Array<number>(cols * rows).fill(0);
        for (let y = 0; y < h; y += 2) {
          for (let x = 0; x < w; x += 2) {
            const i = (y * w + x) * 4;
            const lin = (c: number): number => (c / 255) ** 2.2;
            const l = 0.2126 * lin(data[i] ?? 0) + 0.7152 * lin(data[i + 1] ?? 0) + 0.0722 * lin(data[i + 2] ?? 0);
            const k = Math.floor(y / th) * cols + Math.floor(x / tw);
            sums[k] = (sums[k] ?? 0) + l;
            counts[k] = (counts[k] ?? 0) + 1;
          }
        }
        return sums.map((s, k) => s / Math.max(1, counts[k] ?? 1));
      }, btoa(binary));
      pictures.push({ t: (Date.now() - started) / 1000, tiles });
      const r = await draw(page);
      const fire = r?.fireballs.length ?? 0;
      if (fire > lastFire) rises.push((Date.now() - started) / 1000);
      lastFire = fire;
      const l = await lab(page);
      if ((l?.bodies.filter((b) => b.id.startsWith('body-')).length ?? 10) === 0 && (r?.fireballs.length ?? 0) === 0 && (Date.now() - started) / 1000 > 12) break;
    }
    // Every stone struck (none left), with their craters in the history.
    await expect.poll(async () => (await lab(page))?.bodies.filter((b) => b.id.startsWith('body-')).length, LIVE).toBe(0);
    // Fireballs rising: at most two in any second (events within a third of a second join one; never more than three a second).
    for (const t of rises) expect(rises.filter((x) => x >= t && x < t + 1).length).toBeLessThanOrEqual(3);
    // WCAG's general flash per tile: opposing changes of a tenth or more from the last turn, the darker below 0.8; at most three flashes (six turns) in any second.
    const tilesN = Math.max(...pictures.map((p) => p.tiles.length));
    let worst = 0;
    for (let k = 0; k < tilesN; k += 1) {
      const turns: number[] = [];
      let extreme = pictures[0]?.tiles[k] ?? 0;
      let direction = 0;
      for (const p of pictures) {
        const v = p.tiles[k] ?? 0;
        if (direction === 0) {
          if (Math.abs(v - extreme) >= 0.1) {
            direction = Math.sign(v - extreme);
            turns.push(p.t);
            extreme = v;
          }
        } else if (direction * (v - extreme) > 0) extreme = v;
        else if (Math.abs(v - extreme) >= 0.1 && Math.min(v, extreme) < 0.8) {
          direction = -direction;
          turns.push(p.t);
          extreme = v;
        }
      }
      for (const t of turns) worst = Math.max(worst, turns.filter((x) => x >= t && x < t + 1).length);
    }
    test.info().annotations.push({ type: 'flash', description: JSON.stringify({ pictures: pictures.length, worst, rises: rises.length }) });
    expect(pictures.length).toBeGreaterThan(30);
    expect(worst).toBeLessThanOrEqual(6);
    expect(pageErrors).toEqual([]);
  });
});
