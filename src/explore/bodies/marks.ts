/**
 * Craters the laboratory's impacts leave on the worlds drawn (ledger IM-2, IM-3). Each is drawn at
 * its impact site in the world's own frame, so it turns with the surface, at the size, depth and rim
 * height the crater model gives (src/sim/craters: Collins, Melosh and Marcus 2005), in a shape drawn
 * from them:
 * - a simple crater a bowl, a paraboloid from its floor up to the rim crest;
 * - a complex one a flat floor with a small central peak, and a wall rising to the rim (the floor's
 *   width and the peak's height illustrative: real ones vary);
 * - the ejecta beyond the rim thinning as the cube of the distance from the centre (the form of the
 *   paper's eq. 47), from the rim's height there.
 * The relief tilts the surface's normal by its slope times the world's own relief map's exaggeration
 * (planets.json), so a new crater stands among the old ones at the same scale. Fresh rock and ejecta
 * change the surface's colour (each world's fresh colour is illustrative); on an airless world rays
 * of bright ejecta run out several radii, as from the Moon's young craters (their pattern
 * illustrative, fixed by the site). The floor glows while its melt is hot, a dull red-orange no
 * brighter than half the sunlit ground: rock near 1,400 K is far fainter than sunlit regolith, so the
 * glow shows best on the night side. Nothing appears at once: a mark eases in, its glow eases in and
 * fades slowly (flash safety: no step in brightness), and a mark smaller than a few pixels fades out
 * rather than shimmer.
 */

import { Vector4, type Node } from 'three/webgpu';
import { abs, asin, atan, cross, dot, exp, float, Fn, fract, If, length, Loop, max, min, mix, mx_fractal_noise_float, normalize, pow, select, sin, smoothstep, uniformArray, vec3, vec4 } from 'three/tsl';
import type { FloatNode, Vec3Node } from './shading';
import { tiltNormal } from './shading';

/** The most marks a world shows (the newest kept). */
export const MAX_MARKS = 12;
/** A complex crater's flat floor (a share of its radius) and its central peak (a share of its depth, and its width as a share of the radius): illustrative. */
const COMPLEX = { floor: 0.55, peak: 0.3, peakWidth: 0.12 } as const;
/** How far out the ejecta's colour reaches (crater radii) and how far its relief is followed (radii): the continuous blanket ends about a radius beyond the rim. */
const EJECTA = { colour: 2.2, relief: 4 } as const;
/**
 * How strongly fresh rock shows (shares of the fresh colour): on the walls, rim and the ejecta at the
 * rim, and on the floor; and the fresh colour's tone on the walls and on the floor (a darker melt sheet).
 */
const FRESH = { wall: 0.9, floor: 0.94, wallTone: 1, floorTone: 0.7 } as const;
/** The old surface is buried out to here (crater radii): the crater and its continuous ejecta near the rim. */
const BURIED_TO = 1.7;
/** The ejecta's hummocky texture: its scale (features per crater radius) and depth (a share of the fresh rock's strength). */
const TEXTURE = { scale: 6, amount: 0.35 } as const;
/** Rays on airless worlds: how far they run (crater radii), how strongly they show, and their angular frequencies (whole numbers, so they close round the site). */
const RAYS = { reach: 14, strength: 0.38, frequencies: [23, 37, 11] } as const;
/** The melt's colour (a blackbody near 1,400 K, as a colour) and its brightness at full glow, linear: illustrative. */
const MELT = { colour: [1, 0.33, 0.07], strength: 0.18 } as const;

/** One crater as drawn. */
export interface SurfaceMark {
  /** The impact site: a unit vector in the world's own frame (the mesh's: y the pole, x the prime meridian). */
  site: readonly [number, number, number];
  /** Its angular radius on the world (radians): the final crater's radius over the world's. */
  angle: number;
  /** Rim crest to floor, and the rim's height above the ground around, over the world's radius. */
  depth: number;
  rim: number;
  complex: boolean;
  /** 0 to 1: how far it has appeared (eased in, never at once). */
  appear: number;
  /** 0 to 1: the melt's glow now. */
  glow: number;
}

export interface Marks {
  /** The marks to draw (the newest MAX_MARKS of them). */
  set(marks: readonly SurfaceMark[]): void;
  /**
   * The shader part: at a surface direction `n` (unit, the world's own frame), with `normal` and
   * `albedo` as drawn without the marks and `footprint` the radians a pixel spans there, the normal
   * and colour with the marks, and the melt's glow to add (light of its own, not lit by the Sun).
   */
  apply(n: Vec3Node, normal: Vec3Node, albedo: Vec3Node, footprint: FloatNode): { normal: Vec3Node; albedo: Vec3Node; glow: Vec3Node };
}

/**
 * `fresh` gives a world's freshly exposed rock's colour from its surface's colour there; `rays` draws
 * bright rays (airless worlds); `exaggeration` is the factor the world's relief map is drawn at.
 */
export function createMarks(fresh: (albedo: Vec3Node) => Vec3Node, options: { rays?: boolean; exaggeration?: number } = {}): Marks {
  const rays = options.rays ?? false;
  const exaggeration = options.exaggeration ?? 1;
  const sites = uniformArray(Array.from({ length: MAX_MARKS }, () => new Vector4(0, 1, 0, 0)), 'vec4');
  // depth, rim, complex (0 or 1), appear.
  const shapes = uniformArray(Array.from({ length: MAX_MARKS }, () => new Vector4()), 'vec4');
  const glows = uniformArray(new Array<number>(MAX_MARKS).fill(0), 'float');
  const siteValues = sites.array as Vector4[];
  const shapeValues = shapes.array as Vector4[];
  const glowValues = glows.array as number[];
  // The elements' node types are not carried by uniformArray's typings.
  const siteAt = (i: Node<'int'>): Vec4Node => sites.element(i) as unknown as Vec4Node;
  const shapeAt = (i: Node<'int'>): Vec4Node => shapes.element(i) as unknown as Vec4Node;
  const glowAt = (i: Node<'int'>): FloatNode => glows.element(i) as unknown as FloatNode;

  /** Per mark at `n`: x in crater radii, and how much of it a pixel can show (0 when it is under a few pixels across). */
  const place = (n: Vec3Node, site: Vec4Node, footprint: FloatNode): { x: FloatNode; away: Vec3Node; shown: FloatNode } => {
    // The angle from the site by its chord (acos loses its precision for small angles in single precision).
    const chord = length(n.sub(site.xyz));
    const theta = asin(min(chord.mul(0.5), 1)).mul(2);
    const x = theta.div(max(site.w, 1e-9));
    // Away from the site along the surface: the way the angle grows.
    const along = n.mul(dot(n, site.xyz)).sub(site.xyz);
    const away = along.div(max(length(along), 1e-9));
    const shown = float(1).sub(smoothstep(0.35, 1.2, footprint.div(max(site.w, 1e-9))));
    return { x, away, shown };
  };

  return {
    set(marks) {
      const list = marks.slice(-MAX_MARKS);
      for (let k = 0; k < MAX_MARKS; k += 1) {
        const m = list[k];
        const site = siteValues[k];
        const shape = shapeValues[k];
        if (!site || !shape) continue;
        if (!m || !(m.angle > 0)) {
          site.set(0, 1, 0, 0);
          shape.set(0, 0, 0, 0);
          glowValues[k] = 0;
          continue;
        }
        site.set(m.site[0], m.site[1], m.site[2], m.angle);
        shape.set(m.depth, m.rim, m.complex ? 1 : 0, Math.min(1, Math.max(0, m.appear)));
        glowValues[k] = Math.min(1, Math.max(0, m.glow));
      }
    },
    apply(n, normal, albedo, footprint) {
      // The relief's gradient (xyz) and how much fresh rock shows (w), over the marks.
      const relief = Fn(() => {
        const gradient = vec3(0).toVar();
        const amount = float(0).toVar();
        Loop(MAX_MARKS, ({ i }) => {
          const site = siteAt(i);
          If(site.w.greaterThan(0), () => {
            const shape = shapeAt(i);
            const { x, away, shown } = place(n, site, footprint);
            If(x.lessThan(rays ? Math.max(EJECTA.relief, RAYS.reach) : EJECTA.relief), () => {
              const depth = shape.x;
              const rim = shape.y;
              const complex = shape.z;
              const weight = shape.w.mul(shown);
              // Inside: the bowl (simple), or the floor, the peak and the wall (complex); outside, the ejecta.
              const u = x.sub(COMPLEX.floor).div(1 - COMPLEX.floor).clamp(0, 1);
              const wallSlope = depth.mul(u.mul(float(1).sub(u)).mul(6 / (1 - COMPLEX.floor)));
              const peak = exp(x.div(COMPLEX.peakWidth).pow(2).negate());
              const peakSlope = depth.mul(COMPLEX.peak).mul(peak).mul(x.mul(-2 / (COMPLEX.peakWidth * COMPLEX.peakWidth)));
              const inside = select(complex.greaterThan(0.5), wallSlope.add(peakSlope), depth.mul(x).mul(2));
              const outside = rim.mul(-3).div(max(x.pow(4), 1e-6)).mul(float(1).sub(smoothstep(EJECTA.relief * 0.75, EJECTA.relief, x)));
              const slope = select(x.lessThan(1), inside, outside);
              // Height per crater radius into height per radian of the world: over the angular radius.
              gradient.addAssign(away.mul(slope.div(max(site.w, 1e-9)).mul(weight)));
              // A frame fixed at the site, and the site's own seed for its patterns.
              const helper = select(abs(site.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
              const e1 = normalize(cross(site.xyz, helper));
              const e2 = cross(site.xyz, e1);
              const seed = fract(sin(dot(site.xyz, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)).mul(2 * Math.PI);
              // Hummocky ground, at a tenth of the crater's radius and finer (illustrative).
              const rough = mx_fractal_noise_float(vec3(dot(away, e1).mul(x), dot(away, e2).mul(x), seed).mul(TEXTURE.scale), 3, 2, 0.5).mul(TEXTURE.amount);
              const wall = mix(float(FRESH.floor), float(FRESH.wall), smoothstep(0.3, 1, x));
              // From the wall's own at the rim, so nothing marks the rim but its relief.
              let ejecta: FloatNode = float(FRESH.wall).mul(float(1).sub(smoothstep(1, EJECTA.colour, x))).mul(rough.add(1));
              if (rays) {
                // Narrow streaks round the site: the angle of `away` in the site's frame, the pattern's
                // phases from its seed; each streak brightens and fades along its length.
                const around = atan(dot(away, e2), dot(away, e1));
                const streak = (frequency: number, phase: FloatNode, sharpness: number): FloatNode => pow(sin(around.mul(frequency).add(phase)).mul(0.5).add(0.5), sharpness);
                const pattern = max(max(streak(RAYS.frequencies[0], seed, 14), streak(RAYS.frequencies[1], seed.mul(1.7), 18).mul(0.85)), streak(RAYS.frequencies[2], seed.mul(2.3), 9).mul(0.7));
                const along = sin(x.mul(2.1).add(seed)).mul(0.25).add(0.75);
                // Each direction's rays run their own length (ejecta are thrown out unevenly).
                const runs = float(RAYS.reach).mul(streak(3, seed.mul(3.1), 2).mul(0.45).add(streak(7, seed.mul(0.6), 3).mul(0.3)).add(0.25));
                const reach = smoothstep(0.95, 1.4, x).mul(float(1).sub(smoothstep(runs.mul(0.3), runs, x)));
                // Streaks need the crater several pixels across, or they would shimmer.
                const sharp = float(1).sub(smoothstep(0.08, 0.25, footprint.div(max(site.w, 1e-9))));
                ejecta = max(ejecta, pattern.mul(along).mul(reach).mul(sharp).mul(RAYS.strength));
              }
              amount.assign(max(amount, select(x.lessThan(1), wall.mul(rough.mul(0.4).add(1)), ejecta).clamp(0, 1).mul(weight)));
            });
          });
        });
        return vec4(gradient, amount);
      })();
      // The melt's glow, how much of the old surface the crater and its near ejecta bury, and how much is floor (all 0 to 1).
      const cover = Fn(() => {
        const glow = float(0).toVar();
        const buried = float(0).toVar();
        const floor = float(0).toVar();
        Loop(MAX_MARKS, ({ i }) => {
          const site = siteAt(i);
          If(site.w.greaterThan(0), () => {
            const { x, shown } = place(n, site, footprint);
            const weight = shapeAt(i).w.mul(shown);
            // The melt pools on the floor.
            glow.addAssign(glowAt(i).mul(float(1).sub(smoothstep(0.55, 1, x))).mul(shown));
            buried.assign(max(buried, float(1).sub(smoothstep(1, BURIED_TO, x)).mul(weight)));
            floor.assign(max(floor, float(1).sub(smoothstep(0.5, 0.8, x)).mul(weight)));
          });
        });
        return vec3(min(glow, 1), buried, floor);
      })();
      // Inside and near the rim the old relief is gone: the crater's own shape on the smooth sphere there.
      const base = normalize(mix(normalize(normal), n, cover.y));
      // The floor a darker melt sheet, the walls and ejecta bright fresh rock.
      const freshTone = fresh(albedo).mul(mix(float(FRESH.wallTone), float(FRESH.floorTone), cover.z));
      return {
        normal: tiltNormal(base, relief.xyz, exaggeration),
        albedo: mix(albedo, freshTone, relief.w),
        glow: vec3(...MELT.colour).mul(cover.x.mul(MELT.strength)),
      };
    },
  };
}

type Vec4Node = Node<'vec4'>;
