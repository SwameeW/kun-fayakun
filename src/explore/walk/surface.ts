/**
 * The ground's illustrative fine detail (./ground): what lies between the measured heights, which are
 * tens of metres apart on the Earth and kilometres apart on the Moon and Mars. None of it is measured
 * ground, and the suit's readout says so.
 *
 * - **Grain**, everywhere: octaves of gradient noise (MaterialX's Perlin, smooth to any magnification)
 *   from 6 cm (soil's grit) to 51 m, each turned by the golden angle against the one before so no
 *   direction lines up, in brightness and in relief.
 * - **The Earth's ground** (earthGround), by its slope and the imagery's own colour: rock on the steep,
 *   paler, banded by height as cliffs of layered rock are; plants in tufts where the imagery is green;
 *   soil in patches on the rest.
 * - **Craters** on the Moon and Mars: one at most to a cell, in octaves of cells four times larger each
 *   time, so there are sixteen times fewer craters four times wider (the -2 power law of an old surface
 *   battered to equilibrium: Gault 1970). Each is a parabolic bowl a third of its radius deep inside a
 *   raised, rounded rim, its ejecta falling away to nothing by 1.6 radii (all within its cell, so one
 *   cell's reading is enough); most are worn shallow, a few are fresh, and on the Moon the fresh ones
 *   are brighter (young, unweathered soil). The rim toward a low Sun shades the floor, as the craters
 *   near the terminator are drawn in shadow.
 * - **Stones**: dark rounded ones on Mars's paler dust, a scattering of grey ones on the Moon and
 *   Mercury, flat slabs on Venus, each casting a shadow away from the Sun where the Sun is seen (from
 *   its own cell or a neighbour's).
 *
 * Every octave fades out as its features near a pixel. The relief is given in metres, for bump
 * mapping: it tilts the ground's shading, it does not move the ground; the shadows dim the sunlight
 * alone.
 */

import { abs, dot, float, floor, Fn, fract, If, length, max, min, mix, mx_noise_float, pow, select, smoothstep, sqrt, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

type FloatNode = Node<'float'>;
type Vec2Node = Node<'vec2'>;
type Vec3Node = Node<'vec3'>;

export interface SurfaceStyle {
  /** Craters: the octaves' cell sizes (m), the chance a cell holds one, and how much brighter a fresh one is (0: no brighter). */
  craters: { cellsM: readonly number[]; chance: number; freshBright: number } | null;
  /** Stones: the octaves' cell sizes (m), the chance a cell holds one, their brightness against the ground (and how far it varies, stone to stone), and their height (their radii). */
  rocks: { cellsM: readonly number[]; chance: number; brightness: number; spread: number; height: number } | null;
}

/**
 * The Earth's ground: grain only (with ./ground earthGround's rock, plants and soil). No stones: drawn
 * as shading on a flat ground, a low Sun stretched their shadows into dark streaks that read as spikes,
 * and a high one turned their domes into a pitted, lunar ground (not the Earth's look).
 */
export const EARTH_SURFACE: SurfaceStyle = { craters: null, rocks: null };
/** The Moon's: craters from half a metre to about 160 m across, about half the cells holding one, fresh ones a third brighter; a scattering of grey stones. */
export const MOON_SURFACE: SurfaceStyle = { craters: { cellsM: [4, 16, 64, 256], chance: 0.55, freshBright: 0.35 }, rocks: { cellsM: [1, 4], chance: 0.15, brightness: 0.9, spread: 0.3, height: 0.7 } };
/** Mercury's: battered as the Moon is, its fresh craters a little less bright against its darker ground. */
export const MERCURY_SURFACE: SurfaceStyle = { craters: { cellsM: [4, 16, 64, 256], chance: 0.55, freshBright: 0.3 }, rocks: { cellsM: [1, 4], chance: 0.15, brightness: 0.9, spread: 0.3, height: 0.7 } };
/** Mars's: fewer craters, none under about 10 m across (its air and dust wear the small ones away, and fill them), and stones on its dust. */
export const MARS_SURFACE: SurfaceStyle = { craters: { cellsM: [96, 384], chance: 0.3, freshBright: 0 }, rocks: { cellsM: [0.8, 3.2], chance: 0.4, brightness: 0.85, spread: 0.3, height: 0.7 } };
/**
 * Venus's: no small craters at all (its thick air breaks up anything that would make one smaller than
 * a few kilometres), and flat slabs of rock, as the Venera landers' pictures show.
 */
export const VENUS_SURFACE: SurfaceStyle = { craters: null, rocks: { cellsM: [0.6, 2.4], chance: 0.45, brightness: 0.85, spread: 0.2, height: 0.25 } };

/**
 * The grain's octaves: their sizes (m), weights in brightness, and relief (metres of height per metre of
 * octave); each kept while it spans at least `keepPx` pixels, gone by half that.
 */
export const GRAIN = { tilesM: [0.06, 0.24, 0.8, 3.2, 12.8, 51.2], weights: [0.3, 0.38, 0.42, 0.55, 0.7, 0.65], relief: 0.04, keepPx: 12 } as const;
/**
 * The Earth's rock bands' strength (the thin layers' and the thick ones', a share of the rock's
 * brightness: faint, as weathered cliffs show them), and snow and ice in the imagery: its linear
 * luminance (from `grey[0]`, all of it by `grey[1]`) and how little colour it has (its spread from the
 * brightest channel to the darkest over its luminance, snow below `chroma[0]`, none above `chroma[1]`).
 */
const STRATA = { thin: 0.15, thick: 0.28 } as const;
const SNOW = { grey: [0.45, 0.65], chroma: [0.08, 0.25] } as const;
/** The golden angle (radians): each octave turned by it against the one before. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** A crater's shape, in its radii: the rim's height, the floor's depth below the surroundings, the ejecta's reach, and how far the crest is rounded. */
const CRATER = { rim: 0.07, floor: 0.33, reach: 1.6, crest: 0.06 } as const;
/** A cell's crater radius (cell widths): from the smallest to the largest, most of them small. */
const CRATER_RADIUS = { min: 0.06, span: 0.25 } as const;
/** A cell's stone: its radius (cell widths, most of them small: at most 1.2 m across on the Moon and 1 m on Mars), and the longest shadow drawn (cell widths). */
const ROCK = { min: 0.05, span: 0.1, shadowCells: 1 } as const;

/** Two pseudo-random numbers in [0, 1) for a cell (Hoskins's hash22: no sine, so no precision troubles far from the origin). */
const hash22 = Fn(([p]: [Vec2Node]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});

/** Fades an octave out as its features (`sizeM` across) near a pixel (`spanM` per pixel). */
const fade = (sizeM: number, spanM: FloatNode): FloatNode => float(1).sub(smoothstep(sizeM / 40, sizeM / 12, spanM));

export interface SurfaceDetail {
  /** Brightness about 0 (the grain); times the albedo's change (craters, stones); the height (m); and the share of the sunlight let through (shadows). */
  grain: FloatNode;
  shade: FloatNode;
  relief: FloatNode;
  sunlit: FloatNode;
}

/**
 * The detail at a point of the ground: `metres` its place east and north of the walk's anchor, `span`
 * the ground's metres per pixel there, `sun` the Sun's direction in the anchor's frame (east, north,
 * up), and `stones` 1 to draw the stones (the costliest part; 0 on the lowest detail).
 */
export function surfaceDetail(metres: Vec2Node, span: FloatNode, sun: Vec3Node, style: SurfaceStyle, stones: FloatNode): SurfaceDetail {
  const out = Fn(() => {
    const grain = float(0).toVar();
    const relief = float(0).toVar();
    const shade = float(1).toVar();
    const sunlit = float(1).toVar();
    // The Sun's way across the ground and the tangent of its height (shadows only while it is up).
    const level = length(sun.xy);
    const toward = sun.xy.div(max(level, 1e-6));
    const rise = sun.z.div(max(level, 1e-4));
    const up = sun.z.greaterThan(0.002);
    GRAIN.tilesM.forEach((tileM, i) => {
      const kept = float(1).sub(smoothstep(0.5, 1, span.mul(GRAIN.keepPx / tileM)));
      If(kept.greaterThan(0), () => {
        const c = Math.cos(GOLDEN_ANGLE * i);
        const s = Math.sin(GOLDEN_ANGLE * i);
        const q = metres.div(tileM);
        const turned = vec2(q.x.mul(c).sub(q.y.mul(s)), q.x.mul(s).add(q.y.mul(c))).add(vec2(17.3 * i, 41.9 * i));
        const octave = mx_noise_float(turned).mul(0.5).mul(kept);
        grain.addAssign(octave.mul(GRAIN.weights[i] ?? 0.5));
        relief.addAssign(octave.mul(tileM * GRAIN.relief));
      });
    });
    const craters = style.craters;
    if (craters)
      craters.cellsM.forEach((cellM, k) => {
        const kept = fade(cellM, span);
        If(kept.greaterThan(0), () => {
          const p = metres.div(cellM);
          const cell = floor(p);
          const a = hash22(cell.add(vec2(13.7 * (k + 1), 7.1)));
          const b = hash22(cell.add(vec2(5.3, 29.9 * (k + 1))));
          const e = hash22(cell.add(vec2(61.1 * (k + 1), 83.3)));
          const there = select(a.x.lessThan(craters.chance), float(1), float(0));
          const r = a.y.mul(a.y).mul(CRATER_RADIUS.span).add(CRATER_RADIUS.min);
          const reach = r.mul(CRATER.reach);
          const centre = vec2(reach, reach).add(b.mul(float(1).sub(reach.mul(2))));
          // Where the point is, in the crater's radii.
          const x = fract(p).sub(centre).div(r);
          const d = length(x);
          // Most worn shallow; a few fresh (wear 1).
          const wear = pow(e.x, 3).mul(0.85).add(0.15);
          // The bowl rising to the rim and the ejecta falling from it: the lower of the two, the crest rounded (a smooth minimum).
          const inside = float(CRATER.rim).sub(float(CRATER.rim + CRATER.floor).mul(float(1).sub(d.mul(d))));
          const away = float(1).sub(smoothstep(1, CRATER.reach, d));
          const outside = float(CRATER.rim).mul(away.mul(away));
          const blend = max(float(CRATER.crest).sub(abs(inside.sub(outside))), 0).div(CRATER.crest);
          const profile = min(inside, outside).sub(blend.mul(blend).mul(CRATER.crest / 4));
          const weight = there.mul(kept);
          relief.addAssign(profile.mul(wear).mul(r).mul(cellM).mul(weight));
          if (craters.freshBright > 0) {
            const fresh = smoothstep(0.7, 0.95, wear);
            shade.mulAssign(float(1).add(fresh.mul(craters.freshBright).mul(float(1).sub(smoothstep(0.7, CRATER.reach, d))).mul(weight)));
          }
          // Inside, the rim toward the Sun shades the floor where the Sun is lower than the rim seen from there.
          If(up.and(d.lessThan(1)), () => {
            const along = dot(x, toward);
            const toRim = along.negate().add(sqrt(max(along.mul(along).sub(d.mul(d)).add(1), 0)));
            const below = float(CRATER.rim).sub(inside).mul(wear);
            const dark = smoothstep(-0.03, 0.03, below.sub(rise.mul(toRim)));
            // The floor's shadow, lit a little by the sunlit wall across it (illustrative), and only where
            // the crater spans enough pixels to show its rim (seen along the ground, a sliver of shadow
            // with no rim to cast it reads as an ink stroke).
            sunlit.mulAssign(float(1).sub(dark.mul(weight).mul(fade(cellM / 3, span)).mul(0.88)));
          });
        });
      });
    const rocks = style.rocks;
    if (rocks)
      rocks.cellsM.forEach((cellM, k) => {
        const kept = fade(cellM, span).mul(stones);
        If(kept.greaterThan(0), () => {
          const p = metres.div(cellM);
          const home = floor(p);
          const local = fract(p);
          // A stone in a cell: there or not, its radius, its centre (all within the cell).
          const stone = (cell: Vec2Node): { there: FloatNode; r: FloatNode; centre: Vec2Node } => {
            const a = hash22(cell.add(vec2(91.3 * (k + 1), 3.7)));
            const b = hash22(cell.add(vec2(11.9, 57.1 * (k + 1))));
            const r = a.y.mul(a.y).mul(ROCK.span).add(ROCK.min);
            return { there: select(a.x.lessThan(rocks.chance), float(1), float(0)), r, centre: vec2(r, r).add(b.mul(float(1).sub(r.mul(2)))) };
          };
          const own = stone(home);
          const d = length(local.sub(own.centre)).div(own.r);
          const dome = pow(max(float(1).sub(d.mul(d)), 0), 1.5);
          const weight = own.there.mul(kept);
          relief.addAssign(dome.mul(rocks.height).mul(own.r).mul(cellM).mul(weight));
          const on = float(1).sub(smoothstep(0.85, 1, d)).mul(weight);
          // Each stone its own shade about the style's (paler and darker ones among the rest), by a third either way.
          const tone = hash22(home.add(vec2(37.7, 19.3 * (k + 1)))).x.sub(0.5).mul(rocks.spread);
          shade.mulAssign(float(1).add(on.mul(tone.add(rocks.brightness - 1))));
          // Shadows: a stone's, swept away from the Sun as far as its height throws it (narrowing to its
          // tip), at most a cell: from this cell or the three beside it toward the Sun.
          If(up, () => {
            const sx = select(toward.x.greaterThanEqual(0), float(1), float(-1));
            const sy = select(toward.y.greaterThanEqual(0), float(1), float(-1));
            for (const [ox, oy] of [
              [0, 0],
              [1, 0],
              [0, 1],
              [1, 1],
            ] as const) {
              const offset = vec2(sx.mul(ox), sy.mul(oy));
              const s = stone(home.add(offset));
              const q = local.sub(offset).sub(s.centre);
              const reachCells = min(s.r.mul(rocks.height).div(max(rise, 1e-3)), ROCK.shadowCells);
              const t = max(min(dot(q, toward.negate()), reachCells), 0);
              const width = s.r.mul(float(1).sub(t.div(max(reachCells, 1e-4)).mul(0.6))).mul(0.9);
              const off = length(q.add(toward.mul(t)));
              const cast = float(1).sub(smoothstep(width.mul(0.75), width, off)).mul(smoothstep(0.9, 1.05, length(q).div(s.r))).mul(s.there).mul(kept);
              sunlit.mulAssign(float(1).sub(cast.mul(0.92)));
            }
          });
        });
      });
    return vec4(grain, shade, relief, sunlit);
  })();
  return { grain: out.x, shade: out.y, relief: out.z, sunlit: out.w };
}

/**
 * The Earth's ground up close (illustrative: between the imagery's 10 m pixels and the terrain's 30 m
 * heights): `base` the imagery's colour, `steep` 0 on the level to 1 on a cliff, `heightM` the ground's
 * height above sea level, `metres` its place east and north of the walk's anchor, `span` the ground's
 * metres per pixel. Rock on the steep, a little paler and greyer than the imagery, faintly banded by
 * height (layers a few metres and a few tens of metres thick, wavering along the cliff, as the Grand
 * Canyon's walls are), but not where the imagery is snow or ice (bright and colourless: SNOW), which
 * lies over the layers; plants in tufts where the imagery is green (an excess of green over red and
 * blue); soil elsewhere.
 */
export function earthGround(base: Vec3Node, steep: FloatNode, heightM: FloatNode, metres: Vec2Node, span: FloatNode): Vec3Node {
  const grey = dot(base, vec3(0.2126, 0.7152, 0.0722));
  const green = base.y.sub(base.x.add(base.z).mul(0.5)).div(max(grey, 0.02));
  const plants = smoothstep(0.02, 0.35, green).mul(float(1).sub(steep));
  // Snow and ice: bright, and nearly as bright in red as in blue (sand and pale rock are as bright, but coloured).
  const chroma = max(base.x, max(base.y, base.z)).sub(min(base.x, min(base.y, base.z))).div(max(grey, 0.02));
  const snow = smoothstep(SNOW.grey[0], SNOW.grey[1], grey).mul(float(1).sub(smoothstep(SNOW.chroma[0], SNOW.chroma[1], chroma)));
  // Strata: thin layers seen up close, thick ones from afar, each faded as it nears a pixel.
  const waver = mx_noise_float(metres.div(220)).mul(9);
  const thin = mx_noise_float(vec2(heightM.add(waver).div(4.5), 0.37)).mul(float(1).sub(smoothstep(0.6, 2.5, span)));
  const thick = mx_noise_float(vec2(heightM.add(waver.mul(3)).div(38), 5.1)).mul(float(1).sub(smoothstep(8, 30, span)));
  const rock = mix(base, vec3(grey, grey, grey), 0.2).mul(thin.mul(STRATA.thin).add(thick.mul(STRATA.thick)).mul(float(1).sub(snow)).add(1.1));
  // Tufts: darker and greener clumps a third of a metre across, only where they span a few pixels.
  const tuft = smoothstep(-0.05, 0.3, mx_noise_float(metres.div(0.33))).mul(float(1).sub(smoothstep(0.03, 0.12, span)));
  const leafy = mix(vec3(1, 1, 1), vec3(0.72, 0.86, 0.64), tuft.mul(0.8).add(0.2));
  // The soil's own patches, warmer and cooler, a couple of metres across.
  const patch = mx_noise_float(metres.div(1.7)).mul(float(1).sub(smoothstep(0.15, 0.6, span)));
  const soil = base.mul(mix(vec3(0.93, 0.97, 1.03), vec3(1.07, 1.01, 0.94), patch.mul(0.5).add(0.5)));
  return mix(mix(soil, soil.mul(leafy), plants), rock, steep);
}

/** The Sun's direction in a local frame (its east, north and up: unit vectors in the same frame as `sun`). */
export function sunInFrame(sun: readonly [number, number, number], east: readonly number[], north: readonly number[], up: readonly number[]): [number, number, number] {
  const along = (a: readonly number[]): number => (a[0] ?? 0) * sun[0] + (a[1] ?? 0) * sun[1] + (a[2] ?? 0) * sun[2];
  return [along(east), along(north), along(up)];
}
