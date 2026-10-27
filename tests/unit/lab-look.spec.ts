/**
 * How the laboratory's experiments are drawn (src/explore/lab-fx, docs/LAB.md "How experiments are
 * drawn"): pure parts, checked without a browser. The potato rule and the crossover to a point; a
 * disc's size; a star's temperature from its light and radius; Planck's law weighed by the eye (the
 * table against a direct integral, the reviewed values, the colour against the blackbody fit); a melt's
 * crust; a splat's light the same at every size; a ring's coverage; the flash guard's pairs; the
 * fireball's merging, its rise per frame and its ceiling.
 */
import { expect, test } from '@playwright/test';
import { blackbodyRgb } from '../../src/chapters/shared/blackbody';
import { radialProfile, ringCoverage, RING_FORMED } from '../../src/explore/lab-fx/annulus';
import { FIREBALL, fireballRadiusKm, Fireballs, type FireballEvent } from '../../src/explore/lab-fx/fireball';
import { FLASH, FlashGuard } from '../../src/explore/lab-fx/flash-guard';
import { crustK, giantMeltK, MELT } from '../../src/explore/lab-fx/heat';
import { incandescence, incandescenceTable, INCANDESCENCE, SUNLIT_WHITE_CD_M2, tristimulus } from '../../src/explore/lab-fx/incandescence';
import { LAB_EFFECTS, effectsFor } from '../../src/explore/lab-fx/ladder';
import { axesFor, crossover, discPx, effectiveTemperature, irregularity, starLights } from '../../src/explore/lab-fx/look';
import { SPLAT_SIZE, splatGain, splatProfile } from '../../src/explore/lab-fx/splats';

test('the potato rule: round at 300 km and above, lumpy at 50 km and below; a fragment’s axes 2 : sqrt 2 : 1 with its volume kept', () => {
  for (const m of ['rock', 'ice', 'metal'] as const) {
    expect(irregularity(300, m)).toBe(0);
    expect(irregularity(869, m)).toBe(0);
    expect(irregularity(50, m)).toBeGreaterThan(0);
  }
  expect(irregularity(50, 'rock')).toBe(1);
  // Ice is round only above a larger radius than rock (Lineweaver and Norman 2010).
  expect(irregularity(180, 'ice')).toBeGreaterThan(irregularity(180, 'rock'));
  expect(irregularity(10, 'gas')).toBe(0);
  const [a, b, c] = axesFor(1);
  expect(a / c).toBeCloseTo(2, 12);
  expect(b / c).toBeCloseTo(Math.SQRT2, 12);
  expect(a * b * c).toBeCloseTo(1, 12);
  expect(axesFor(0)).toEqual([1, 1, 1]);
});

test('a disc’s size and the crossover to a point: weights always adding to 1, no cap on the disc', () => {
  for (let px = 0; px <= 200; px += 0.25) {
    const w = crossover(px);
    expect(w.mesh + w.point).toBeCloseTo(1, 12);
    expect(w.mesh).toBeGreaterThanOrEqual(0);
  }
  expect(crossover(1).mesh).toBe(0);
  expect(crossover(3).mesh).toBe(1);
  // An 869 km piece 25,000 km away with 1,430 px per unit tangent: a disc 99 px across, drawn as a mesh.
  const r = discPx(869, 25_000, 1430);
  expect(2 * r).toBeCloseTo(99.5, 0);
  expect(crossover(r).mesh).toBe(1);
});

test('a star’s effective temperature from its luminosity and radius: the Sun’s 5,772 K', () => {
  // IAU 2015 Resolution B3: nominal L = 3.828e26 W, R = 695,700 km, T_eff = 5,772 K.
  expect(Math.abs(effectiveTemperature(3.828e26, 695_700) - 5772)).toBeLessThan(5);
});

test('incandescence: the table is monotonic, within a per cent of a direct Planck integral, coloured as the blackbody fit; the reviewed values hold', () => {
  const { lnLuminance, kelvin } = incandescenceTable();
  expect(kelvin.length).toBe(INCANDESCENCE.entries);
  for (let k = 1; k < lnLuminance.length; k += 1) expect(lnLuminance[k] ?? 0).toBeGreaterThan(lnLuminance[k - 1] ?? 0);
  for (const t of [740, 1000, 1234, 1400, 1777, 2000, 2600, 3000, 4321, 5772, 9000, 11_900]) {
    const direct = (683 * tristimulus(t, 0.25)[1]) / SUNLIT_WHITE_CD_M2;
    expect(Math.abs(incandescence(t).luminance / direct - 1)).toBeLessThan(0.01);
  }
  // Sunlit white ground: about 40,400 cd/m^2 (S / pi times the solar spectrum's efficacy).
  expect(Math.abs(SUNLIT_WHITE_CD_M2 / 40_400 - 1)).toBeLessThan(0.02);
  // The roadmap's reviewed values: 1,400 K about 0.061, 2,000 K about 11.5, 3,000 K about 749 times sunlit white ground.
  expect(incandescence(1400).luminance).toBeCloseTo(0.061, 2);
  expect(Math.abs(incandescence(2000).luminance / 11.5 - 1)).toBeLessThan(0.03);
  expect(Math.abs(incandescence(3000).luminance / 749 - 1)).toBeLessThan(0.03);
  // Rock at 1,400 K against sunlit ground of the Moon's albedo (0.12): about half as bright.
  expect(Math.abs(incandescence(1400).luminance / 0.12 - 0.49)).toBeLessThan(0.05);
  // The colour: the blackbody fit's (Kang et al. 2002) where that fit holds.
  for (const t of [1800, 2500, 3500, 5772, 9000]) {
    const a = incandescence(t).rgb;
    const b = blackbodyRgb(t);
    for (let c = 0; c < 3; c += 1) expect(Math.abs((a[c] ?? 0) - (b[c] ?? 0))).toBeLessThan(0.03);
  }
  expect(incandescence(500).luminance).toBe(0);
});

test('a melt’s crust: its surface cools fast and then slowly, never below nothing nor above the melt, gone from sight within minutes', () => {
  expect(crustK(MELT.craterK, 0)).toBe(MELT.craterK);
  let last: number = MELT.craterK;
  for (const s of [0.1, 1, 10, 60, 600, 3600, 86_400]) {
    const t = crustK(MELT.craterK, s);
    expect(t).toBeLessThan(last);
    expect(t).toBeGreaterThan(0);
    last = t;
  }
  // The balance holds: what the surface radiates equals what conducts through the crust.
  const t = crustK(2000, 60);
  const radiated = 0.9 * 5.670374419e-8 * t ** 4;
  const conducted = (2 * (2000 - t)) / Math.sqrt(Math.PI * 1e-6 * 60);
  expect(Math.abs(radiated / conducted - 1)).toBeLessThan(1e-6);
  // A crater's melt glows for a minute or two (above 1,100 K: a thousandth of sunlit ground or more), not an hour.
  expect(incandescence(crustK(MELT.craterK, 30)).luminance).toBeGreaterThan(0.01);
  expect(incandescence(crustK(MELT.craterK, 3600)).luminance).toBeLessThan(1e-6);
  expect(giantMeltK(1e3)).toBe(MELT.minK);
  expect(giantMeltK(1e9)).toBe(MELT.maxK);
});

test('a splat’s light is the same at every size: its profile times its gain, integrated, within 1 per cent from 2.5 to 18 px', () => {
  const flux = (size: number): number => {
    // The profile over the splat's plane (g = distance over half its size), on a fine grid.
    let sum = 0;
    const step = size / 400;
    for (let x = -size * 2; x <= size * 2; x += step) {
      for (let y = -size * 2; y <= size * 2; y += step) sum += splatProfile(Math.hypot(x, y) / (size / 2)) * step * step;
    }
    return sum * splatGain(size);
  };
  const ref = flux(SPLAT_SIZE.min);
  for (const size of [2.5, 4, 7, 11, 18]) expect(Math.abs(flux(size) / ref - 1)).toBeLessThan(0.01);
});

test('a ring’s coverage: a clump covers its arc, a ring spread round covers the whole circle; its profile peaks where it is densest', () => {
  const ring = new Float32Array(600 * 3);
  const clump = new Float32Array(600 * 3);
  for (let k = 0; k < 600; k += 1) {
    const a = (k / 600) * 2 * Math.PI;
    const r = 20_000 + 2000 * ((k * 0.618) % 1);
    ring.set([r * Math.cos(a), r * Math.sin(a), 0], k * 3);
    const b = (k / 600) * (Math.PI / 3);
    clump.set([r * Math.cos(b), r * Math.sin(b), 0], k * 3);
  }
  expect(ringCoverage(ring, [0, 0, 1])).toBeGreaterThanOrEqual(RING_FORMED.arcDeg);
  expect(ringCoverage(clump, [0, 0, 1])).toBeLessThan(90);
  // Tilted: the same ring about another pole.
  const tilted = new Float32Array(600 * 3);
  for (let k = 0; k < 600; k += 1) tilted.set([ring[k * 3] ?? 0, 0, ring[k * 3 + 1] ?? 0], k * 3);
  expect(ringCoverage(tilted, [0, 1, 0])).toBeGreaterThanOrEqual(RING_FORMED.arcDeg);
  const profile = radialProfile(ring, 20_000, 22_000, new Float32Array(64));
  expect(Math.max(...profile)).toBe(1);
  expect(profile.every((v) => v >= 0 && v <= 1)).toBe(true);
});

test('the flash guard: a 3.5 Hz flicker over 30 per cent of a tile held to two pairs a second; over 10 per cent let through; saturated red counted', () => {
  const run = (area: number, low: number, high: number, red = false): { flashes: number; shown: number[] } => {
    const guard = new FlashGuard();
    const shown: number[] = [];
    // Four seconds at 60 frames a second of a square wave at 3.5 Hz (each rise asked at once: the guard lets through a share of it).
    let was = 0;
    for (let f = 0; f < 240; f += 1) {
      const t = f / 60;
      const want = Math.floor(t * 3.5 * 2) % 2 === 0 ? low : high;
      guard.begin(t);
      guard.add(1, Math.min(was, want), want, area, red);
      const k = guard.kappa(1);
      was = want > was ? was + (want - was) * k : want;
      shown.push(was);
    }
    // Opposing changes of 10 per cent or more from the last turn (two make a pair), in every second's window.
    let worst = 0;
    for (let s = 0; s + 60 <= shown.length; s += 1) {
      let ref = shown[s] ?? 0;
      let dir = 0;
      let changes = 0;
      for (let k = s + 1; k < s + 60; k += 1) {
        const v = shown[k] ?? 0;
        if (dir > 0 && v > ref) ref = v;
        else if (dir < 0 && v < ref) ref = v;
        else if (dir >= 0 && ref - v >= FLASH.change) {
          changes += 1;
          dir = -1;
          ref = v;
        } else if (dir <= 0 && v - ref >= FLASH.change) {
          changes += 1;
          dir = 1;
          ref = v;
        }
      }
      worst = Math.max(worst, Math.floor(changes / 2));
    }
    return { flashes: worst, shown };
  };
  expect(run(0.3, 0.1, 0.6).flashes).toBeLessThanOrEqual(FLASH.pairsPerS);
  // Too small a part of the tile to count: through as asked.
  expect(run(0.1, 0.1, 0.6).flashes).toBeGreaterThan(FLASH.pairsPerS);
  // Bright to brighter (the darker state above 0.8) does not count, unless the light is saturated red.
  expect(run(0.3, 0.85, 0.98).flashes).toBeGreaterThan(FLASH.pairsPerS);
  expect(run(0.3, 0.85, 0.98, true).flashes).toBeLessThanOrEqual(FLASH.pairsPerS);
  expect(FlashGuard.tileArea(1024)).toBeCloseTo(341 * 256, 6);
  expect(FlashGuard.tileAt(10, 10, 1024)).not.toBe(FlashGuard.tileAt(400, 10, 1024));
});

test('the flash guard sees a tile’s effects together: fireballs in one tile, each eased, never step a frame, held back or let go', () => {
  // Fireballs as the effects plan and settle them (each rise of 0.8 s), two in one tile 0.4 s apart and four
  // more pairs: enough rises for the guard to hold some back.
  const f = new Fireballs();
  const event = (key: string): FireballEvent => ({ key, body: 'moon', site: [1, 0, 0], energyJ: 1e24, speedKmS: 20, impactorKm: 50, targetKm: 1737 });
  const guard = new FlashGuard();
  const peak = new Map<string, number>();
  const shown = new Map<string, number[]>();
  for (let n = 0; n < 6 * 60; n += 1) {
    const t = n / 60;
    for (let k = 0; k < 5; k += 1) {
      if (n === Math.round(k * 0.9 * 60)) f.add(event(`a${k}`), t);
      if (n === Math.round((k * 0.9 + 0.4) * 60)) f.add(event(`b${k}`), t);
    }
    f.plan(t, 1 / 60, false);
    guard.begin(t);
    for (const b of f.live) guard.add(7, b.unit * Math.min(b.strength, b.next), b.unit * b.next, 0.3);
    const kappa = guard.kappa(7);
    expect(kappa).toBeGreaterThanOrEqual(0);
    expect(kappa).toBeLessThanOrEqual(1);
    for (const b of f.live) {
      f.settle(b, kappa);
      shown.set(b.key, [...(shown.get(b.key) ?? []), b.luminance]);
      peak.set(b.key, Math.max(peak.get(b.key) ?? 0, b.unit));
    }
  }
  // Never more than a thirtieth of its peak a frame (its own eased rise at most; the guard only slows it).
  for (const [key, values] of shown) {
    const p = peak.get(key) ?? 1;
    let before = 0;
    for (const v of values) {
      expect(Math.abs(v - before)).toBeLessThanOrEqual(p / 30 + 1e-9);
      before = v;
    }
  }
  expect(guard.changes(7, 6)).toBeLessThanOrEqual(2 * FLASH.pairsPerS);
});

test('the flash guard: a tile’s light as two effects ask it at once is held to two pairs a second; a rise held back goes on at its own pace when let go', () => {
  const guard = new FlashGuard();
  const shown: number[] = [];
  // Two effects together, each a 3.5 Hz square wave over 15 per cent of the tile (30 per cent between them).
  let was = 0;
  for (let n = 0; n < 240; n += 1) {
    const t = n / 60;
    const want = Math.floor(t * 3.5 * 2) % 2 === 0 ? 0.1 : 0.6;
    guard.begin(t);
    guard.add(3, Math.min(was, want), want, 0.15);
    guard.add(3, Math.min(was, want), want, 0.15);
    const k = guard.kappa(3);
    was = want > was ? was + (want - was) * k : want;
    shown.push(was);
  }
  // Changes of 10 per cent or more, each way from the last turn, counted in every one-second window.
  let worst = 0;
  for (let s = 0; s + 60 <= shown.length; s += 1) {
    let ref = shown[s] ?? 0;
    let dir = 0;
    let changes = 0;
    for (let k = s + 1; k < s + 60; k += 1) {
      const v = shown[k] ?? 0;
      if (dir > 0 && v > ref) ref = v;
      else if (dir < 0 && v < ref) ref = v;
      else if (dir >= 0 && ref - v >= FLASH.change) {
        changes += 1;
        dir = -1;
        ref = v;
      } else if (dir <= 0 && v - ref >= FLASH.change) {
        changes += 1;
        dir = 1;
        ref = v;
      }
    }
    worst = Math.max(worst, Math.floor(changes / 2));
  }
  expect(worst).toBeLessThanOrEqual(FLASH.pairsPerS);
  // An eased rise held back, then let go: it never steps (no more than its own pace a frame).
  const g = new FlashGuard();
  let level = 0;
  let steepest = 0;
  for (let n = 0; n < 180; n += 1) {
    const t = n / 60;
    // Four quick changes (two pairs) asked at once, then a slow rise (a thirtieth a frame) the guard holds back until the second has passed.
    const want = t < 0.3 ? (Math.floor(t * 13.4) % 2 === 0 ? 0.1 : 0.5) : Math.min(0.9, level + 0.9 / 30);
    g.begin(t);
    g.add(1, Math.min(level, want), want, 0.5);
    const k = g.kappa(1);
    const next = want > level ? level + (want - level) * k : want;
    if (t > 0.35) steepest = Math.max(steepest, Math.abs(next - level));
    level = next;
  }
  expect(steepest).toBeLessThanOrEqual(0.9 / 30 + 1e-9);
  expect(level).toBeCloseTo(0.9, 6);
});

test('fireballs: two impacts 0.2 s apart make one (the larger kept); never more than three rise in a second; a rise never more than a thirtieth of the peak a frame, never above the ceiling', () => {
  const event = (key: string, energyJ: number): FireballEvent => ({ key, body: 'earth', site: [1, 0, 0], energyJ, speedKmS: 20, impactorKm: 1, targetKm: 6371 });
  const f = new Fireballs();
  f.add(event('a', 1e20), 0);
  f.update(0.2, 0.2, false);
  const before = f.live[0]?.radiusKm ?? 0;
  f.add(event('b', 5e20), 0.2);
  expect(f.live.length).toBe(1);
  expect(f.live[0]?.energyJ).toBe(5e20);
  // The larger's size, eased to: never more than a thirtieth of the change a frame, there within a few seconds.
  const grown = fireballRadiusKm(5e20, 1, 6371);
  expect(f.live[0]?.toRadiusKm).toBeCloseTo(grown, 9);
  expect(f.live[0]?.radiusKm).toBe(before);
  let r = before;
  for (let k = 1; k <= 180; k += 1) {
    f.update(0.2 + k / 60, 1 / 60, false);
    const now = f.live[0]?.radiusKm ?? 0;
    expect(now - r).toBeLessThanOrEqual((grown - before) / 30 + 1e-9);
    r = now;
  }
  expect(Math.abs(r - grown)).toBeLessThan(0.01 * (grown - before));
  // Ten in two seconds: at most three a second rise.
  const g = new Fireballs();
  for (let k = 0; k < 10; k += 1) g.add(event(`k${k}`, 1e20), k * 0.2);
  expect(g.live.length).toBeLessThanOrEqual(FIREBALL.maxLive);
  const h = new Fireballs();
  h.add(event('x', 1e32), 0);
  let last = 0;
  let peak = 0;
  for (let k = 1; k <= 300; k += 1) {
    h.update(k / 60, 1 / 60, false);
    const s = h.live[0]?.strength ?? 0;
    expect(s - last).toBeLessThanOrEqual(1 / 30 + 1e-9);
    expect(h.live[0]?.luminance ?? 0).toBeLessThanOrEqual(FIREBALL.ceiling + 1e-12);
    peak = Math.max(peak, s);
    last = s;
  }
  expect(peak).toBeCloseTo(1, 6);
  // Collins and others' scaling: 0.002 E^(1/3) m, at least the impactor, at most half the target.
  expect(fireballRadiusKm(1e21, 0.5, 6371)).toBeCloseTo((0.002 * Math.cbrt(1e21)) / 1000, 9);
  expect(fireballRadiusKm(1e40, 0.5, 6371)).toBe(6371 / 2);
  expect(fireballRadiusKm(1, 0.5, 6371)).toBe(0.5);
});

test('a rock lit by up to four stars, the strongest first, each nought in the shadow of a body between', () => {
  const AU = 1.495978707e8;
  // Five stars about a rock at the origin, of different light; a planet between the rock and the brightest.
  const lights = [
    { id: 'a', pos: [AU, 0, 0], watts: 3.828e26 },
    { id: 'b', pos: [0, 2 * AU, 0], watts: 3.828e26 },
    { id: 'c', pos: [0, 0, 3 * AU], watts: 3.828e26 },
    { id: 'd', pos: [-4 * AU, 0, 0], watts: 3.828e26 },
    { id: 'e', pos: [0, -5 * AU, 0], watts: 3.828e26 },
  ];
  const out = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  starLights(lights, [], [0, 0, 0], 'rock', 1, out);
  // The Sun's light at 1 au is 1; the rest by the inverse square, the strongest four in order.
  expect(out.map((o) => o[3])).toEqual([1, 1 / 4, 1 / 9, 1 / 16].map((x) => expect.closeTo(x, 9) as unknown as number));
  // Directions in the render frame (x, z, -y): toward a, then b.
  expect(out[0]?.slice(0, 3)).toEqual([1, 0, -0].map((x) => expect.closeTo(x, 12) as unknown as number));
  expect(out[1]?.slice(0, 3)).toEqual([0, 0, -1].map((x) => expect.closeTo(x, 12) as unknown as number));
  // A planet between the rock and a: that light is nought (an eclipse); the next four take its places.
  starLights(lights, [{ id: 'planet', pos: [AU / 2, 0, 0], radiusKm: 6371 }], [0, 0, 0], 'rock', 1, out);
  expect(out.map((o) => o[3])).toEqual([1 / 4, 1 / 9, 1 / 16, 1 / 25].map((x) => expect.closeTo(x, 9) as unknown as number));
});

test('the effects ladder: fewer and coarser at lower tiers, an unknown tier taken as Medium', () => {
  expect(effectsFor(undefined)).toBe(LAB_EFFECTS.medium);
  expect(LAB_EFFECTS.low.splats).toBeLessThanOrEqual(LAB_EFFECTS.high.splats);
  expect(LAB_EFFECTS.low.plumePoints).toBeLessThan(LAB_EFFECTS.high.plumePoints);
  expect(LAB_EFFECTS.low.rockDetail[2]).toBeLessThan(LAB_EFFECTS.high.rockDetail[2]);
});
