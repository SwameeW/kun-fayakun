/**
 * The laboratory's names laid out (src/explore/label-layout.ts; docs/SANDBOX-ROADMAP.md W1.10), alone:
 * over a thousand random scenes of 74 names, no two ever show over each other, frame after frame as they
 * ease in; a name that cannot show (behind a world, off the clear view) never does; nor under the
 * interface or outside the clear view; the chosen body's name shows wherever it has room, and a world's
 * name under it gives way; small movements leave which names show, and where, as they were.
 */
import { expect, test } from '@playwright/test';
import { layoutNames, NAME_GEOM, NAME_HANDOVER, NAME_TAG_PX, nameBox, type NameLabel, type NameState, type NameView } from '../../src/explore/label-layout';

/** Mulberry32, for the seeded scenes. */
const random = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const W = 1440;
const H = 900;
/** A clear view with a panel at the right (the navigator) and a card at the bottom left (the readout). */
const view = (worldNames: Array<{ id: string; x: number; y: number }> = [], gaveWay: string[] = []): NameView<string> => ({
  left: 0,
  top: 60,
  right: W - 320,
  bottom: H,
  avoid: [{ left: 30, top: 640, right: 450, bottom: 880 }],
  taken: worldNames,
  takenCount: worldNames.length,
  worldW: 86,
  worldH: 26,
  worlds: worldNames.map((n) => n.id),
  worldAt: (id, x, y, w, h) => {
    const n = worldNames.find((o) => o.id === id);
    return !!n && !gaveWay.includes(id) && x < n.x + 86 && n.x < x + w && y < n.y + 26 && n.y < y + h;
  },
  giveWay: (id) => {
    gaveWay.push(id);
  },
});
const state = (): NameState => ({ place: new Map(), fade: new Map(), order: [], boxes: [], shown: [] });

interface Scene {
  labels: NameLabel[];
  geom: number[];
}
/** `n` names at random points (a third crowded into one spot, as a torn moon's pieces start), random widths and ranks; the first the chosen body's. */
function scene(seed: number, n: number): Scene {
  const next = random(seed);
  const labels: NameLabel[] = [];
  const geom: number[] = [];
  for (let k = 0; k < n; k += 1) {
    const crowd = k % 3 === 0;
    const x = crowd ? 600 + 60 * next() : W * next();
    const y = crowd ? 400 + 40 * next() : H * next();
    labels.push({ id: `n${k}`, ...(k === 0 ? {} : { rank: 1 + Math.floor(1000 * next()) }), opacity: 0.9 });
    geom.push(x, y, 40 + 120 * next(), next() < 0.9 ? 1 : 0, 0, 0);
  }
  return { labels, geom };
}
/**
 * One frame: what each asks for set again (as the laboratory makes its names each frame), laid out; then,
 * as the explorer's worlds' names do on the next frame, a world's name under the chosen body's name or mark
 * given a place gives way (`gave`).
 */
function frame(sc: Scene, v: NameView<string>, st: NameState, dt = 1 / 60, worlds: Array<{ id: string; x: number; y: number }> = [], gave: string[] = []): void {
  for (const l of sc.labels) l.opacity = 0.9;
  // Whether each can show is the explorer's to say each frame: given a corner (2) last frame, it may again (1).
  for (let j = 0; j < sc.labels.length; j += 1) if (sc.geom[j * NAME_GEOM + 3] === 2) sc.geom[j * NAME_GEOM + 3] = 1;
  layoutNames(sc.labels, 0, sc.labels.length, sc.geom, v, st, 1 - Math.exp(-dt / 0.35), 1 - Math.exp(-dt / 0.1), false);
  for (const n of worlds) {
    for (let t = 0; t + 3 < st.shown.length; t += 4) {
      const x = st.shown[t] ?? 0;
      const y = st.shown[t + 1] ?? 0;
      const w = st.shown[t + 2] ?? 0;
      if (st.shown[t + 3] === 1 && x < n.x + 86 && n.x < x + w && y < n.y + 26 && n.y < y + NAME_TAG_PX && !gave.includes(n.id)) gave.push(n.id);
    }
  }
}
/** The boxes of the names showing (above the handover). */
function showing(sc: Scene, st: NameState): Array<{ id: string; x: number; y: number; w: number }> {
  return sc.labels
    .map((l, j) => ({ l, j }))
    .filter(({ l }) => l.opacity > NAME_HANDOVER)
    .map(({ l, j }) => {
      const spot = st.place.get(l.id) ?? 0;
      return { id: l.id, x: nameBox(sc.geom, j, spot, 'x'), y: nameBox(sc.geom, j, spot, 'y'), w: sc.geom[j * NAME_GEOM + 2] ?? 0 };
    });
}
const overlap = (a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + NAME_TAG_PX && b.y < a.y + NAME_TAG_PX;

test('a thousand random scenes of 74 names: frame after frame no two show over each other, none under the interface or outside the clear view, none that cannot show', () => {
  test.setTimeout(120_000);
  const v = view();
  // What went wrong, collected (one assertion at the end: thousands of checks a scene).
  const wrong: string[] = [];
  let fewest = Number.POSITIVE_INFINITY;
  for (let seed = 1; seed <= 1000; seed += 1) {
    const sc = scene(seed, 74);
    const st = state();
    for (let f = 0; f < 12; f += 1) {
      frame(sc, v, st, f < 6 ? 1 / 60 : 0.25);
      const shown = showing(sc, st);
      for (let a = 0; a < shown.length; a += 1) {
        const p = shown[a];
        if (!p) continue;
        if (!(p.x >= v.left && p.x + p.w <= v.right && p.y >= v.top && p.y + NAME_TAG_PX <= v.bottom)) wrong.push(`${seed}/${f}: ${p.id} outside the clear view`);
        for (const r of v.avoid) if (p.x < r.right && r.left < p.x + p.w && p.y < r.bottom && r.top < p.y + NAME_TAG_PX) wrong.push(`${seed}/${f}: ${p.id} under the interface`);
        for (let b = a + 1; b < shown.length; b += 1) {
          const q = shown[b];
          if (q && overlap(p, q)) wrong.push(`${seed}/${f}: ${p.id} meets ${q.id}`);
        }
      }
      // One that cannot show (behind a world, off the view) never does.
      sc.labels.forEach((l, j) => {
        if (sc.geom[j * NAME_GEOM + 3] === 0 && l.opacity !== 0) wrong.push(`${seed}/${f}: ${l.id} shows though it cannot`);
      });
    }
    fewest = Math.min(fewest, showing(sc, st).length);
  }
  expect(wrong.slice(0, 10)).toEqual([]);
  // Most names in a scene this crowded still find a corner.
  expect(fewest).toBeGreaterThan(10);
});

test('the chosen body’s name shows where it has room even over a world’s name, which gives way to it; another’s waits for the world’s', () => {
  const gave: string[] = [];
  const worlds = [{ id: 'earth', x: 705, y: 380 }];
  const v = view(worlds, gave);
  const sc: Scene = { labels: [{ id: 'chosen', opacity: 0.9 }, { id: 'other', rank: 5, opacity: 0.9 }], geom: [700, 400, 80, 1, 0, 0, 700, 600, 80, 1, 0, 0] };
  const st = state();
  for (let f = 0; f < 120; f += 1) frame(sc, v, st, 1 / 60, worlds, gave);
  expect(gave).toContain('earth');
  expect(sc.labels[0]?.opacity).toBeGreaterThan(0.85);
  expect(sc.labels[1]?.opacity).toBeGreaterThan(0.85);
  // Another's name over a world's waits for it (the world's is not in the chosen body's way, but is in another's).
  const sc2: Scene = { labels: [{ id: 'other', rank: 5, opacity: 0.9 }], geom: [700, 400, 80, 1, 0, 0] };
  const still = view([{ id: 'mars', x: 600, y: 380 }, { id: 'venus', x: 700, y: 380 }, { id: 'earth', x: 600, y: 405 }, { id: 'moon', x: 700, y: 405 }]);
  const st2 = state();
  for (let f = 0; f < 60; f += 1) frame(sc2, still, st2);
  expect(sc2.labels[0]?.opacity).toBe(0);
});

test('hysteresis: names jittered by up to 3.9 px a frame (moving under the margin between coming in and giving way) keep which show and their corners', () => {
  test.setTimeout(120_000);
  const v = view();
  const wrong: string[] = [];
  for (let seed = 1; seed <= 200; seed += 1) {
    const sc = scene(seed, 40);
    const st = state();
    for (let f = 0; f < 30; f += 1) frame(sc, v, st);
    const settled = new Map(sc.labels.filter((l) => l.opacity > 0.5).map((l) => [l.id, st.place.get(l.id)]));
    const base = [...sc.geom];
    const next = random(seed * 7);
    for (let f = 0; f < 60; f += 1) {
      for (let j = 0; j < sc.labels.length; j += 1) {
        sc.geom[j * NAME_GEOM] = (base[j * NAME_GEOM] ?? 0) + (next() - 0.5) * 7.8;
        sc.geom[j * NAME_GEOM + 1] = (base[j * NAME_GEOM + 1] ?? 0) + (next() - 0.5) * 7.8;
      }
      frame(sc, v, st);
      for (const [id, spot] of settled) {
        const l = sc.labels.find((x) => x.id === id);
        if ((l?.opacity ?? 0) <= 0.5) wrong.push(`${seed}/${f}: ${id} gave way`);
        else if (st.place.get(id) !== spot) wrong.push(`${seed}/${f}: ${id} moved corner`);
      }
    }
  }
  expect(wrong.slice(0, 10)).toEqual([]);
});
