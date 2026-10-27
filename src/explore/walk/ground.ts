import { BufferAttribute, BufferGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, Vector3, Vector4, type Node, type Texture } from 'three/webgpu';
import { abs, acos, asin, atan, attribute, clamp, cos, Discard, dot, exp, float, Fn, fwidth, If, length, max, min, mix, modelWorldMatrix, normalize, normalWorldGeometry, positionView, positionWorld, pow, smoothstep, step, uniform, vec3, vec4, viewZToLogarithmicDepth } from 'three/tsl';
import { bumpGradient, tiltNormal } from '../bodies/shading';
import { sunTransmittance, type AirModel } from '../render/air';
import { AIRLESS_FILL, MARS_DUST, NIGHT_SKY, VENUS_FILL, venusDay, type LightKind } from './light';
import { scatter } from './scatter';
import { MARS_SKY, VENUS_SKY } from './sky';
import { EARTH_SURFACE, earthGround, sunInFrame, surfaceDetail, type SurfaceStyle } from './surface';
import { localFrame } from './walker';
import { zoomFor, type Heights } from './terrain';

type Vec3Node = Node<'vec3'>;
type FloatNode = Node<'float'>;

/** Steps along each ground pixel's ray through the Earth's air (its aerial perspective). */
const AIR_STEPS = 5;

/**
 * The ground under a walker (on the Earth, the Moon, Mars, Mercury or Venus): nested square rings of real terrain (a geometry clipmap),
 * each twice the size and half the detail of the one inside it, from about 8 m between points at
 * the feet to 8 km at 200 km away, so the horizon is real ground at every height a walker reaches.
 * Heights come from the terrain tiles (./terrain) a zoom finer than each ring's spacing; each ring re-centres
 * as the walker moves, refilling a few rings a frame, and refills as finer tiles arrive (all at once
 * when the walk lands or re-anchors, so no ring is ever drawn about the wrong anchor). Each ring
 * hides where the ring inside it lies and hangs a skirt from its edge, so no seam opens between them.
 *
 * Positions are kept relative to an anchor near the walker, in the world's own frame (the object
 * turns with the world), so the GPU's single precision is centimetres here, not metres. The colour is
 * the globe's own (on the Earth its day map and streamed imagery, through `colour`), lit by the
 * world's sunlight and its sky's light (./light), shaded by the terrain's own shadows and the sky its
 * horizons hide (HORIZON), the regolith's law on the Moon and Mercury, and seen through the air
 * between (on the Earth its scattering along the pixel's ray: ./scatter; on Mars and Venus a fade into
 * their skies' horizon colour). Where the
 * colour's and the heights' pixels are magnified, illustrative fine detail (./surface: grain, and on
 * the Moon and Mars craters and rocks, in brightness and relief) gives the ground its texture down to
 * a few centimetres; each octave fades out as its features near a pixel. It is not measured ground:
 * the real ground is the terrain and the imagery. Its relief tilts the shading (bump mapping), but
 * never on the skirts (whose faces stand upright, where it would tilt wildly) and never past a slope
 * of DETAIL.maxSlope. Depth is logarithmic in this
 * material only (the renderer keeps standard depth; see ../space/lens): standing on the ground, the
 * near plane is a decimetre away and the far one past the horizon.
 *
 * Land below sea level, and the sea, are drawn at sea level for now: the tiles hold the sea floor,
 * and there is no land-and-water mask on the CPU yet (docs/WALKING.md).
 */

export const GROUND = {
  levels: 11,
  /** Cells along each side of a ring. */
  cells: 48,
  /** Metres between points in the innermost ring. */
  spacingM: 8,
  /** A skirt hangs this many of its ring's spacings below its edge. */
  skirtSpacings: 3,
  /** Over this many cells from its edge a ring's heights become the next ring's (the geometry clipmap's transition region). */
  transitionCells: 8,
  /** Rings refilled per frame at most (except on landing and re-anchoring, when all are). */
  refillsPerFrame: 2,
  /** The walker may stray this far (km) from the anchor before everything is re-anchored. */
  reanchorKm: 20,
  /**
   * Heights are read from tiles whose pixels are this share of the ring's spacing: finer than the
   * points, so a cliff between two points keeps its height (a tile at the spacing's own size is an
   * average over it, and rounds every edge away).
   */
  sharpen: 0.5,
} as const;

/**
 * The terrain's own shadows and the sky it hides (horizon mapping, Max 1988): from every other point of
 * each ring, the highest angle the ground rises to in eight directions, marched out over the rings'
 * heights to `reachKm` in steps growing by `growth` (the world's curve counted), and shared with the
 * points between. A point is in the ground's shadow while the Sun is below its horizon in the Sun's
 * direction (between the eight, interpolated), softened over `penumbraRad` (the Sun's disc, a little
 * more for the interpolation); and the sky's light on it is the share of the sky its horizons leave
 * open (the mean of cos^2 of their angles: a valley floor gets less of the sky than a summit).
 */
export const HORIZON = { directions: 8, reachKm: 60, growth: 1.45, penumbraRad: 0.012 } as const;

/** The fine detail's brightness (its grain's share of the albedo), and the steepest it tilts the ground (the slope's tangent). */
const DETAIL = { brightness: 0.55, maxSlope: 1.5 } as const;

export interface GroundFrame {
  /** The world's centre relative to the camera (render frame, km) and its frame's axes (9 numbers: columns x, y, z). */
  centre: { x: number; y: number; z: number };
  basis: readonly number[];
  radiusKm: number;
  /** Unit direction to the Sun (render frame) and the sunlight's strength (1 at 1 au). */
  sun: { x: number; y: number; z: number };
  light: number;
  /** The depth range this material maps logarithmically (km). */
  near: number;
  far: number;
}

export interface Ground {
  readonly object: Group;
  /** Starts over at a place (a new anchor; every ring refilled). */
  reset(lat: number, lon: number): void;
  /** Re-centres on the walker and refills what moved or sharpened; then places the rings for this frame. */
  update(walker: { lat: number; lon: number }, heights: Heights, frame: GroundFrame): void;
  /** Rings filled at least once, and the ground's points refilled so far (for the view and the tests). */
  readonly stats: { filled: number; refills: number };
  /** All the illustrative detail, or all but the stones (the explorer's lowest detail). */
  setFine(fine: boolean): void;
  dispose(): void;
}

interface Ring {
  spacingKm: number;
  halfKm: number;
  /** Centre in the anchor's tangent plane (km); the anchor and centre it was filled for ('' never), the heights' revision then, and the frame. */
  centre: [number, number];
  placedFor: string;
  revision: number;
  filledAt: number;
  mesh: Mesh;
  geometry: BufferGeometry;
  position: BufferAttribute;
  normal: BufferAttribute;
  direction: BufferAttribute;
  tangent: BufferAttribute;
  /** Its points' horizons (the tangents of their angles) to the north, north-east, east and south-east, and to the south, south-west, west and north-west. */
  horizonA: BufferAttribute;
  horizonB: BufferAttribute;
  /** Its points' heights (m), for the horizons' march, and as an attribute for the shading. */
  metres: Float32Array;
  above: BufferAttribute;
  /** Where the ring inside lies (centre x, y and half-width, km; w 1 once it is filled). */
  inner: { value: Vector4 };
}

const N = GROUND.cells;
const GRID = (N + 1) * (N + 1);
const PERIMETER = 4 * N;

/** The perimeter's grid indices in order round the square (top, right, bottom, left). */
function perimeter(): number[] {
  const out: number[] = [];
  for (let i = 0; i < N; i += 1) out.push(i);
  for (let j = 0; j < N; j += 1) out.push(j * (N + 1) + N);
  for (let k = 0; k < N; k += 1) out.push(N * (N + 1) + (N - k));
  for (let k = 0; k < N; k += 1) out.push((N - k) * (N + 1));
  return out;
}

function ringIndex(): Uint32Array {
  const out: number[] = [];
  for (let j = 0; j < N; j += 1)
    for (let i = 0; i < N; i += 1) {
      const a = j * (N + 1) + i;
      out.push(a, a + N + 1, a + 1, a + 1, a + N + 1, a + N + 2);
    }
  const edge = perimeter();
  for (let k = 0; k < PERIMETER; k += 1) {
    const p0 = edge[k] ?? 0;
    const p1 = edge[(k + 1) % PERIMETER] ?? 0;
    const s0 = GRID + k;
    const s1 = GRID + ((k + 1) % PERIMETER);
    out.push(p0, p1, s0, p1, s1, s0);
  }
  return new Uint32Array(out);
}

/**
 * A world's light as the ground sees it (./light has the same on the CPU): whose (the Earth's air
 * through its transmittance table and scattered along each pixel's ray for the aerial perspective;
 * Mars's dust; Venus's overcast; none), and for Mars and Venus the haze the distance fades into (its
 * colour by day, and the distance it takes: illustrative).
 */
export interface GroundLight {
  kind: LightKind;
  air?: { model: AirModel; table: Texture } | null;
  haze?: { colour: readonly [number, number, number]; km: number } | null;
}
/** Venus's deep air's haze over 4 km, fading into its sky's horizon (illustrative). */
export const VENUS_HAZE = { colour: [VENUS_SKY.horizon[0] * VENUS_SKY.scale, VENUS_SKY.horizon[1] * VENUS_SKY.scale, VENUS_SKY.horizon[2] * VENUS_SKY.scale], km: 4 } as const;
/** Mars's dust's haze over 12 km, fading into its sky's horizon (illustrative). */
export const MARS_HAZE = { colour: [MARS_SKY.horizon[0] * MARS_SKY.scale, MARS_SKY.horizon[1] * MARS_SKY.scale, MARS_SKY.horizon[2] * MARS_SKY.scale], km: 12 } as const;

/**
 * The regolith's photometry on the Moon and Mercury: McEwen's lunar-Lambert law (1991), Lommel and
 * Seeliger's 2 mu0 / (mu0 + mu) blended with Lambert's mu0 by a share falling with the phase angle (its
 * cubic in degrees), so the ground looks flat-lit and bright down-Sun and shades like Lambert's toward
 * the Sun; and an opposition surge at the shadow point (illustrative strength and width).
 */
const REGOLITH = { l: [1, -0.019, 2.42e-4, -1.46e-6], surge: 0.4, surgeDeg: 6 } as const;

/**
 * The ground for a world: its colour at a direction from its centre, its light, whether ground below
 * sea level is drawn at sea level (the Earth's, whose sea is not drawn; elsewhere the heights are the
 * ground's own), and its illustrative surface (./surface).
 */
export function createGround(colour: (direction: Vec3Node) => Vec3Node, options: { light: GroundLight; seaLevel?: boolean; surface?: SurfaceStyle }): Ground {
  const light = options.light;
  const seaLevel = options.seaLevel ?? true;
  const surface = options.surface ?? EARTH_SURFACE;
  const object = new Group();
  object.name = 'explore-walk-ground';
  object.visible = false;
  const uSun = uniform(new Vector3(0, 1, 0));
  /** The Sun's direction in the anchor's frame (east, north, up), for the detail's shadows; and 1 to draw the stones. */
  const uSunLocal = uniform(new Vector3(0, 0, 1));
  const uStones = uniform(1);
  const uLight = uniform(1);
  const uNear = uniform(1e-4);
  const uFar = uniform(2000);
  /** The world's centre relative to the camera (render frame, km), its radius, and Mars's and Venus's day (1 by day, 0 at night). */
  const uCentre = uniform(new Vector3());
  const uRadius = uniform(1);
  const uDay = uniform(1);
  /** Sunlight reaching the ground for the Sun's height there (mu), setting over its disc. */
  const sunlight = (mu: FloatNode): Vec3Node => {
    const air = light.air;
    if (light.kind === 'earth' && air) return sunTransmittance(air.model, air.table, length(positionWorld.sub(uCentre)).div(uRadius), mu);
    if (light.kind === 'mars') {
      // Kasten and Young's air mass (./light airMass) through the dust's column.
      const h = asin(clamp(mu, -1, 1)).mul(180 / Math.PI);
      const mass = float(1).div(max(mu, 0).add(pow(max(h.add(6.07995), 1e-3), -1.6364).mul(0.50572)));
      return vec3(...MARS_DUST.sun).mul(exp(vec3(...MARS_DUST.tau).mul(mass).negate())).mul(smoothstep(-0.003, 0.003, mu));
    }
    if (light.kind === 'venus') return vec3(0, 0, 0);
    return vec3(1, 1, 1).mul(smoothstep(-0.005, 0.005, mu));
  };
  /** The sky's light on level ground for the Sun's height (./light earthSkyLight, marsSkyLight, VENUS_FILL, AIRLESS_FILL). */
  const skyLight = (mu: FloatNode): Vec3Node => {
    const air = light.air;
    if (light.kind === 'earth' && air) {
      const [tr, tg, tb] = air.model.verticalDepth;
      return float(1).sub(exp(vec3(tr, tg, tb).negate())).mul(0.5).mul(clamp(mu.add(0.1), 0, 1)).add(vec3(...NIGHT_SKY));
    }
    if (light.kind === 'mars') return float(1).sub(exp(vec3(...MARS_DUST.tau).negate())).mul(0.55).mul(clamp(mu.add(0.12), 0, 1)).mul(vec3(...MARS_DUST.sky));
    if (light.kind === 'venus') return vec3(...VENUS_FILL).mul(uDay);
    return vec3(AIRLESS_FILL.floor, AIRLESS_FILL.floor, AIRLESS_FILL.floor).add(max(mu, 0).mul(AIRLESS_FILL.bounce));
  };
  /** How the ground returns the sunlight: Lambert's mu0, or on the Moon and Mercury the regolith's law (REGOLITH). */
  const regolith = (n: Vec3Node, mu0: FloatNode): FloatNode => {
    if (light.kind !== 'airless') return mu0;
    const toEye = normalize(positionWorld).negate();
    const muE = max(dot(n, toEye), 0.02);
    const g = acos(clamp(dot(uSun, toEye), -1, 1)).mul(180 / Math.PI);
    const [l0, l1, l2, l3] = REGOLITH.l;
    const share = clamp(g.mul(l3).add(l2).mul(g).add(l1).mul(g).add(l0), 0, 1);
    const surge = exp(g.div(-REGOLITH.surgeDeg)).mul(REGOLITH.surge).add(1);
    return share.mul(mu0.mul(2).div(mu0.add(muE).max(1e-4))).add(float(1).sub(share).mul(mu0)).mul(surge);
  };
  /**
   * The terrain's shadow for the Sun's height here (mu) and its direction in the anchor's frame, and the
   * share of the sky left open (HORIZON), from the point's eight horizons.
   */
  const horizons = (mu: FloatNode): { shadow: FloatNode; open: FloatNode } => {
    const a = attribute<'vec4'>('horizonA', 'vec4');
    const b = attribute<'vec4'>('horizonB', 'vec4');
    const tans = [a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w];
    // The Sun's bearing in eighths of a turn from north, clockwise; each horizon weighted by its nearness to it.
    const eighths = atan(uSunLocal.x, uSunLocal.y).div(Math.PI / 4);
    let toward: FloatNode = float(0);
    let open: FloatNode = float(0);
    tans.forEach((t, k) => {
      const d = eighths.sub(k).add(12).mod(8).sub(4).abs();
      toward = toward.add(atan(t, float(1)).mul(max(float(1).sub(d), 0)));
      const angle = atan(max(t, 0), float(1));
      open = open.add(cos(angle).mul(cos(angle)).div(tans.length));
    });
    const shadow = smoothstep(toward.sub(HORIZON.penumbraRad), toward.add(HORIZON.penumbraRad), asin(clamp(mu, -1, 1)));
    return { shadow, open };
  };
  const index = new BufferAttribute(ringIndex(), 1);
  const edge = perimeter();
  const stats = { filled: 0, refills: 0 };

  const rings: Ring[] = Array.from({ length: GROUND.levels }, (_, level) => {
    const spacingKm = (GROUND.spacingM * 2 ** level) / 1000;
    const count = GRID + PERIMETER;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(count * 3), 3);
    const normal = new BufferAttribute(new Float32Array(count * 3), 3);
    const direction = new BufferAttribute(new Float32Array(count * 3), 3);
    const tangent = new BufferAttribute(new Float32Array(count * 2), 2);
    const horizonA = new BufferAttribute(new Float32Array(count * 4), 4);
    const horizonB = new BufferAttribute(new Float32Array(count * 4), 4);
    // The ground's height above the datum (m), for the illustrative detail that follows it.
    const above = new BufferAttribute(new Float32Array(count), 1);
    // 1 on the skirt's lower edge (0 on the ring), so a skirt's fragments are known.
    const skirt = new BufferAttribute(new Float32Array(count).fill(1, GRID), 1);
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('direction', direction);
    geometry.setAttribute('tangent2', tangent);
    geometry.setAttribute('horizonA', horizonA);
    geometry.setAttribute('horizonB', horizonB);
    geometry.setAttribute('above', above);
    geometry.setAttribute('skirt', skirt);
    geometry.setIndex(index);
    const inner = uniform(new Vector4(0, 0, 0, 0));
    const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
    const dir = normalize(attribute<'vec3'>('direction', 'vec3'));
    material.colorNode = Fn(() => {
      // Where the ring inside lies, this one gives way (its skirt covers the join).
      const t = attribute<'vec2'>('tangent2', 'vec2');
      If(inner.w.greaterThan(0.5).and(abs(t.x.sub(inner.x)).lessThan(inner.z)).and(abs(t.y.sub(inner.y)).lessThan(inner.z)), () => {
        Discard();
      });
      // The fine detail, over the ground's own metres (east and north of the anchor).
      const metres = t.mul(1000);
      const span = length(fwidth(metres));
      // The geometry's own normal, also on a back face (seen from below through any gap, the ground is lit as from above).
      const smooth = normalize(normalWorldGeometry);
      const up = normalize(modelWorldMatrix.mul(vec4(dir, 0)).xyz);
      // The Earth's ground up close: rock on the steep, plants where the imagery is green (illustrative).
      const ground = surface === EARTH_SURFACE ? earthGround(colour(dir), smoothstep(0.03, 0.2, float(1).sub(dot(smooth, up))), attribute<'float'>('above', 'float'), metres, span) : { colour: colour(dir), stony: float(1) };
      const detail = surfaceDetail(metres, span, uSunLocal, surface, uStones.mul(ground.stony));
      const albedo = ground.colour.mul(detail.grain.mul(DETAIL.brightness).add(1)).mul(detail.shade);
      // Its relief (km, as the positions are) tilts the shading: not on a skirt, and never past maxSlope.
      const onRing = float(1).sub(step(1e-4, attribute<'float'>('skirt', 'float')));
      const gradient = bumpGradient(positionWorld, smooth, detail.relief.div(1000)).mul(onRing);
      const steep = length(gradient);
      const n = tiltNormal(smooth, gradient.mul(min(1, float(DETAIL.maxSlope).div(max(steep, 1e-6)))), 1);
      const mu = dot(up, uSun);
      const nl = max(dot(n, uSun), 0);
      // The terrain's own shadow (the Sun below this point's horizon toward it) and the sky it leaves open.
      const { shadow, open } = horizons(mu);
      const sunlit = sunlight(mu).mul(uLight).mul(regolith(n, nl)).mul(detail.sunlit).mul(shadow);
      // The sky's light from above, as much as the open sky over a slope lets in.
      const sky = skyLight(mu).mul(uLight).mul(dot(n, up).mul(0.5).add(0.5)).mul(open);
      const lit = albedo.mul(sunlit.add(sky));
      const air = light.air;
      if (light.kind === 'earth' && air) {
        // The air between: the ground dimmed by it, and its own light added (the same light as the sky's).
        const { light: between, transmittance } = scatter(air.model, air.table, uCentre.negate().div(uRadius), normalize(positionWorld), uSun, AIR_STEPS, length(positionWorld).div(uRadius));
        return vec4(lit.mul(transmittance).add(between.mul(uLight)), 1);
      }
      const haze = light.haze;
      if (!haze) return vec4(lit, 1);
      // The air between: a fade with distance into its colour, by day bright, by night dark.
      const fade = float(1).sub(exp(length(positionView).div(haze.km).negate()));
      return vec4(mix(lit, vec3(...haze.colour).mul(uDay).mul(uLight), fade), 1);
    })();
    material.depthNode = viewZToLogarithmicDepth(positionView.z, uNear, uFar);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = `explore-walk-ring-${level}`;
    mesh.renderOrder = -1;
    object.add(mesh);
    return { spacingKm, halfKm: (N / 2) * spacingKm, centre: [0, 0], placedFor: '', revision: -1, filledAt: 0, mesh, geometry, position, normal, direction, tangent, horizonA, horizonB, above, metres: new Float32Array(GRID), inner };
  });

  // The anchor: a place on the sphere, its local frame, and where the walker is in its tangent plane.
  let anchor = { lat: 0, lon: 0, frame: localFrame(0, 0) };
  let version = 0;
  let frames = 0;
  let refillAll = true;
  const point = new Float64Array(3);

  /** A tangent-plane point (km east and north of the anchor) as a unit direction in the Earth's frame. */
  const directionAt = (e: number, n: number, radiusKm: number, out: Float64Array): Float64Array => {
    const { up, east, north } = anchor.frame;
    for (let k = 0; k < 3; k += 1) out[k] = (up[k] ?? 0) * radiusKm + (east[k] ?? 0) * e + (north[k] ?? 0) * n;
    const l = Math.hypot(out[0] ?? 0, out[1] ?? 0, out[2] ?? 0);
    for (let k = 0; k < 3; k += 1) out[k] = (out[k] ?? 0) / l;
    return out;
  };
  /** A place's tangent-plane coordinates (km) about the anchor (gnomonic: straight lines stay straight). */
  const tangentOf = (lat: number, lon: number, radiusKm: number): [number, number] => {
    const d = localFrame(lat, lon).up;
    const { up, east, north } = anchor.frame;
    const u = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    return [(radiusKm * (d[0] * east[0] + d[1] * east[1] + d[2] * east[2])) / u, (radiusKm * (d[0] * north[0] + d[1] * north[1] + d[2] * north[2])) / u];
  };

  /** The zoom a ring's heights are read at (GROUND.sharpen). */
  const ringZoom = (spacingKm: number, radiusKm: number): number => zoomFor(spacingKm * 1000 * GROUND.sharpen, anchor.lat, radiusKm);

  const fill = (ring: Ring, heights: Heights, radiusKm: number): void => {
    const { up } = anchor.frame;
    const zoom = ringZoom(ring.spacingKm, radiusKm);
    // The next ring out reads coarser heights: toward its edge this one's heights become those, so the
    // two meet with no step (a coarser ring standing above a finer one would leave a gap to see through).
    const outer = ringZoom(ring.spacingKm * 2, radiusKm);
    // The tiles under the ring asked for once (a 5 x 5 net of points over it), then read point by point.
    for (let a = 0; a <= 4; a += 1)
      for (let b = 0; b <= 4; b += 1) {
        directionAt(ring.centre[0] + ((a - 2) / 2) * ring.halfKm, ring.centre[1] + ((b - 2) / 2) * ring.halfKm, radiusKm, point);
        const la = (Math.asin(Math.max(-1, Math.min(1, point[1] ?? 0))) * 180) / Math.PI;
        const lo = (Math.atan2(-(point[2] ?? 0), point[0] ?? 1) * 180) / Math.PI;
        heights.want(la, lo, zoom);
        if (outer !== zoom) heights.want(la, lo, outer);
      }
    const height = (lat: number, lon: number, z: number): number => {
      const read = heights.read(lat, lon, z)?.metres ?? 0;
      // On the Earth the sea and land below it at sea level for now (the tiles hold the sea floor).
      return seaLevel ? Math.max(0, read) : read;
    };
    const pos = ring.position.array as Float32Array;
    const nor = ring.normal.array as Float32Array;
    const dirs = ring.direction.array as Float32Array;
    const tan = ring.tangent.array as Float32Array;
    const world = new Float64Array(GRID * 3);
    for (let j = 0; j <= N; j += 1)
      for (let i = 0; i <= N; i += 1) {
        const v = j * (N + 1) + i;
        const e = ring.centre[0] + (i - N / 2) * ring.spacingKm;
        const n = ring.centre[1] + (N / 2 - j) * ring.spacingKm;
        directionAt(e, n, radiusKm, point);
        const lat = (Math.asin(Math.max(-1, Math.min(1, point[1] ?? 0))) * 180) / Math.PI;
        const lon = (Math.atan2(-(point[2] ?? 0), point[0] ?? 1) * 180) / Math.PI;
        const fromEdge = Math.min(i, j, N - i, N - j);
        const toOuter = outer === zoom ? 0 : Math.max(0, Math.min(1, (GROUND.transitionCells - fromEdge) / GROUND.transitionCells));
        const h = toOuter > 0 ? height(lat, lon, zoom) * (1 - toOuter) + height(lat, lon, outer) * toOuter : height(lat, lon, zoom);
        ring.metres[v] = h;
        const r = radiusKm + h / 1000;
        for (let k = 0; k < 3; k += 1) {
          world[v * 3 + k] = (point[k] ?? 0) * r;
          pos[v * 3 + k] = (point[k] ?? 0) * r - (up[k] ?? 0) * radiusKm;
          dirs[v * 3 + k] = point[k] ?? 0;
        }
        tan[v * 2] = e;
        tan[v * 2 + 1] = n;
      }
    // Normals from the neighbours (one-sided at the edges), turned outward.
    for (let j = 0; j <= N; j += 1)
      for (let i = 0; i <= N; i += 1) {
        const v = j * (N + 1) + i;
        const at = (ii: number, jj: number, k: number): number => world[(Math.max(0, Math.min(N, jj)) * (N + 1) + Math.max(0, Math.min(N, ii))) * 3 + k] ?? 0;
        const ax = at(i + 1, j, 0) - at(i - 1, j, 0);
        const ay = at(i + 1, j, 1) - at(i - 1, j, 1);
        const az = at(i + 1, j, 2) - at(i - 1, j, 2);
        const bx = at(i, j - 1, 0) - at(i, j + 1, 0);
        const by = at(i, j - 1, 1) - at(i, j + 1, 1);
        const bz = at(i, j - 1, 2) - at(i, j + 1, 2);
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const outward = nx * (dirs[v * 3] ?? 0) + ny * (dirs[v * 3 + 1] ?? 0) + nz * (dirs[v * 3 + 2] ?? 0);
        const l = (Math.hypot(nx, ny, nz) || 1) * (outward < 0 ? -1 : 1);
        nx /= l;
        ny /= l;
        nz /= l;
        nor.set([nx, ny, nz], v * 3);
      }
    // The skirt: the edge again, hung below it (its horizons copied when they are made).
    const drop = GROUND.skirtSpacings * ring.spacingKm;
    const above = ring.above.array as Float32Array;
    above.set(ring.metres);
    edge.forEach((g, k) => {
      const s = GRID + k;
      above[s] = ring.metres[g] ?? 0;
      for (let c = 0; c < 3; c += 1) {
        pos[s * 3 + c] = (pos[g * 3 + c] ?? 0) - (dirs[g * 3 + c] ?? 0) * drop;
        nor[s * 3 + c] = nor[g * 3 + c] ?? 0;
        dirs[s * 3 + c] = dirs[g * 3 + c] ?? 0;
      }
      tan[s * 2] = tan[g * 2] ?? 0;
      tan[s * 2 + 1] = tan[g * 2 + 1] ?? 0;
    });
    for (const a of [ring.position, ring.normal, ring.direction, ring.tangent, ring.above]) a.needsUpdate = true;
    stats.refills += 1;
  };

  /** The ground's height (m) at a tangent-plane point (km), from the finest filled ring from `from` out that holds it, or null beyond them all. */
  const heightAt = (e: number, n: number, from: number): number | null => {
    for (let level = from; level < rings.length; level += 1) {
      const r = rings[level];
      if (!r || r.placedFor === '') continue;
      const x = (e - r.centre[0]) / r.spacingKm + N / 2;
      const y = N / 2 - (n - r.centre[1]) / r.spacingKm;
      if (x < 0 || y < 0 || x > N || y > N) continue;
      const i = Math.min(N - 1, Math.floor(x));
      const j = Math.min(N - 1, Math.floor(y));
      const fx = x - i;
      const fy = y - j;
      const m = r.metres;
      const v = j * (N + 1) + i;
      return ((m[v] ?? 0) * (1 - fx) + (m[v + 1] ?? 0) * fx) * (1 - fy) + ((m[v + N + 1] ?? 0) * (1 - fx) + (m[v + N + 2] ?? 0) * fx) * fy;
    }
    return null;
  };
  /** The eight directions' east and north components, clockwise from north. */
  const BEARINGS = Array.from({ length: HORIZON.directions }, (_, k) => [Math.sin((k * 2 * Math.PI) / HORIZON.directions), Math.cos((k * 2 * Math.PI) / HORIZON.directions)] as const);
  /** A ring's horizons (HORIZON): marched from every other point, shared with the points between. */
  const horizon = (ring: Ring, level: number, radiusKm: number): void => {
    const a = ring.horizonA.array as Float32Array;
    const b = ring.horizonB.array as Float32Array;
    const tan = ring.tangent.array as Float32Array;
    const write = (v: number, k: number, value: number): void => {
      if (k < 4) a[v * 4 + k] = value;
      else b[v * 4 + k - 4] = value;
    };
    const read = (v: number, k: number): number => (k < 4 ? (a[v * 4 + k] ?? 0) : (b[v * 4 + k - 4] ?? 0));
    for (let j = 0; j <= N; j += 2)
      for (let i = 0; i <= N; i += 2) {
        const v = j * (N + 1) + i;
        const e0 = tan[v * 2] ?? 0;
        const n0 = tan[v * 2 + 1] ?? 0;
        const h0 = ring.metres[v] ?? 0;
        BEARINGS.forEach(([de, dn], k) => {
          let rise = -1;
          for (let x = ring.spacingKm; x < HORIZON.reachKm; x *= HORIZON.growth) {
            const h = heightAt(e0 + de * x, n0 + dn * x, level);
            if (h === null) break;
            // The world's curve: the ground x km away has dropped x^2 / 2R below the level.
            rise = Math.max(rise, (h - h0 - ((x * x) / (2 * radiusKm)) * 1000) / (x * 1000));
          }
          write(v, k, rise);
        });
      }
    // The points between: the mean of their marched neighbours.
    for (let j = 0; j <= N; j += 1)
      for (let i = 0; i <= N; i += 1) {
        if (i % 2 === 0 && j % 2 === 0) continue;
        const i0 = i - (i % 2);
        const j0 = j - (j % 2);
        const i1 = Math.min(N, i0 + (i % 2) * 2);
        const j1 = Math.min(N, j0 + (j % 2) * 2);
        const v = j * (N + 1) + i;
        for (let k = 0; k < HORIZON.directions; k += 1) write(v, k, (read(j0 * (N + 1) + i0, k) + read(j0 * (N + 1) + i1, k) + read(j1 * (N + 1) + i0, k) + read(j1 * (N + 1) + i1, k)) / 4);
      }
    edge.forEach((g, k) => {
      for (let c = 0; c < HORIZON.directions; c += 1) write(GRID + k, c, read(g, c));
    });
    ring.horizonA.needsUpdate = true;
    ring.horizonB.needsUpdate = true;
  };

  const placeQuat = new Quaternion();
  const basisMatrix = new Matrix4();

  return {
    object,
    stats,
    setFine(fine) {
      uStones.value = fine ? 1 : 0;
    },
    reset(lat, lon) {
      anchor = { lat, lon, frame: localFrame(lat, lon) };
      version += 1;
      refillAll = true;
      for (const r of rings) r.placedFor = '';
      stats.filled = 0;
    },
    update(walker, heights, frame) {
      // Re-anchored when the walker strays far from the anchor (the tangent plane stays small).
      let [we, wn] = tangentOf(walker.lat, walker.lon, frame.radiusKm);
      if (Math.hypot(we, wn) > GROUND.reanchorKm) {
        this.reset(walker.lat, walker.lon);
        [we, wn] = [0, 0];
      }
      // Each ring centred on the walker, snapped to its own spacing. A few refills a frame: rings that
      // moved first (finest first), then rings whose heights sharpened since they were filled (the
      // longest-waiting first, so a stream of fine tiles never starves the far rings).
      frames += 1;
      const due = rings
        .map((ring, level) => {
          const centre: [number, number] = [Math.round(we / ring.spacingKm) * ring.spacingKm, Math.round(wn / ring.spacingKm) * ring.spacingKm];
          const placed = `${version}:${centre[0]}:${centre[1]}`;
          return { ring, level, centre, placed, revision: heights.revision(ringZoom(ring.spacingKm, frame.radiusKm)), moved: ring.placedFor !== placed };
        })
        .filter((d) => d.moved || d.ring.revision !== d.revision)
        .sort((a, b) => Number(b.moved) - Number(a.moved) || (a.moved ? 0 : a.ring.filledAt - b.ring.filledAt) || a.level - b.level);
      const refilled = due.slice(0, refillAll ? rings.length : GROUND.refillsPerFrame);
      for (const d of refilled) {
        if (d.ring.placedFor === '') stats.filled += 1;
        d.ring.centre = d.centre;
        fill(d.ring, heights, frame.radiusKm);
        d.ring.placedFor = d.placed;
        d.ring.revision = d.revision;
        d.ring.filledAt = frames;
      }
      // Their horizons once every ring refilled this frame has its heights (a horizon looks out over the coarser rings).
      for (const d of refilled) horizon(d.ring, d.level, frame.radiusKm);
      refillAll = false;
      rings.forEach((ring, level) => {
        // Where the ring inside lies (less half a spacing, so the two overlap rather than part).
        const inside = rings[level - 1];
        if (inside) ring.inner.value.set(inside.centre[0], inside.centre[1], inside.halfKm - inside.spacingKm / 2, inside.placedFor === '' ? 0 : 1);
        ring.mesh.visible = ring.placedFor !== '';
      });
      // The anchor's place relative to the camera, and the world's turn.
      const m = frame.basis;
      const { up } = anchor.frame;
      const ax = up[0] * frame.radiusKm;
      const ay = up[1] * frame.radiusKm;
      const az = up[2] * frame.radiusKm;
      object.position.set(
        frame.centre.x + ax * (m[0] ?? 1) + ay * (m[3] ?? 0) + az * (m[6] ?? 0),
        frame.centre.y + ax * (m[1] ?? 0) + ay * (m[4] ?? 1) + az * (m[7] ?? 0),
        frame.centre.z + ax * (m[2] ?? 0) + ay * (m[5] ?? 0) + az * (m[8] ?? 1),
      );
      basisMatrix.set(m[0] ?? 1, m[3] ?? 0, m[6] ?? 0, 0, m[1] ?? 0, m[4] ?? 1, m[7] ?? 0, 0, m[2] ?? 0, m[5] ?? 0, m[8] ?? 1, 0, 0, 0, 0, 1);
      object.quaternion.copy(placeQuat.setFromRotationMatrix(basisMatrix));
      uSun.value.set(frame.sun.x, frame.sun.y, frame.sun.z);
      const sunWorld: [number, number, number] = [
        frame.sun.x * (m[0] ?? 1) + frame.sun.y * (m[1] ?? 0) + frame.sun.z * (m[2] ?? 0),
        frame.sun.x * (m[3] ?? 0) + frame.sun.y * (m[4] ?? 1) + frame.sun.z * (m[5] ?? 0),
        frame.sun.x * (m[6] ?? 0) + frame.sun.y * (m[7] ?? 0) + frame.sun.z * (m[8] ?? 1),
      ];
      uSunLocal.value.set(...sunInFrame(sunWorld, anchor.frame.east, anchor.frame.north, anchor.frame.up));
      uLight.value = frame.light;
      uNear.value = frame.near;
      uFar.value = frame.far;
      uCentre.value.set(frame.centre.x, frame.centre.y, frame.centre.z);
      uRadius.value = frame.radiusKm;
      // Mars's and Venus's day at the walker (their skies' own): full from 6 degrees up, gone 12 down.
      const upR = [ax * (m[0] ?? 1) + ay * (m[3] ?? 0) + az * (m[6] ?? 0), ax * (m[1] ?? 0) + ay * (m[4] ?? 1) + az * (m[7] ?? 0), ax * (m[2] ?? 0) + ay * (m[5] ?? 0) + az * (m[8] ?? 1)];
      const l = Math.hypot(upR[0] ?? 0, upR[1] ?? 0, upR[2] ?? 0) || 1;
      const sinSun = ((upR[0] ?? 0) * frame.sun.x + (upR[1] ?? 0) * frame.sun.y + (upR[2] ?? 0) * frame.sun.z) / l;
      uDay.value = venusDay((Math.asin(Math.max(-1, Math.min(1, sinSun))) * 180) / Math.PI);
    },
    dispose() {
      for (const r of rings) {
        r.geometry.dispose();
        (r.mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
