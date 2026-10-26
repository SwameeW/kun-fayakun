import { BufferAttribute, BufferGeometry, DoubleSide, Group, Matrix4, Mesh, MeshBasicNodeMaterial, Quaternion, Vector3, Vector4, type Node } from 'three/webgpu';
import { abs, attribute, Discard, dot, exp, float, Fn, fwidth, If, length, max, min, mix, modelWorldMatrix, normalize, normalWorldGeometry, positionView, positionWorld, step, uniform, vec3, vec4, viewZToLogarithmicDepth } from 'three/tsl';
import { bumpGradient, tiltNormal } from '../bodies/shading';
import { ambient, haze } from './daylight';
import { MARS_SKY, VENUS_SKY } from './sky';
import { EARTH_SURFACE, sunInFrame, surfaceDetail, type SurfaceStyle } from './surface';
import { localFrame } from './walker';
import { zoomFor, type Heights } from './terrain';

type Vec3Node = Node<'vec3'>;
type FloatNode = Node<'float'>;

/**
 * The ground under a walker (on the Earth, the Moon or Mars): nested square rings of real terrain (a geometry clipmap),
 * each twice the size and half the detail of the one inside it, from about 8 m between points at
 * the feet to 8 km at 200 km away, so the horizon is real ground at every height a walker reaches.
 * Heights come from the terrain tiles (./terrain) at the zoom each ring needs; each ring re-centres
 * as the walker moves, refilling a few rings a frame, and refills as finer tiles arrive (all at once
 * when the walk lands or re-anchors, so no ring is ever drawn about the wrong anchor). Each ring
 * hides where the ring inside it lies and hangs a skirt from its edge, so no seam opens between them.
 *
 * Positions are kept relative to an anchor near the walker, in the world's own frame (the object
 * turns with the world), so the GPU's single precision is centimetres here, not metres. The colour is
 * the globe's own (on the Earth its day map and streamed imagery, through `colour`), lit by the
 * globe's sunlight model with a sky's fill, fading into the air's haze with distance. Where the
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
} as const;

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
 * A world's air as the ground sees it: the sky's fill from above (its colour at full day) and the haze
 * the distance fades into (its colour by day, and the distance it takes), or none (airless: shadows
 * lit only faintly, by the sunlit ground around, and no haze).
 */
export interface GroundAir {
  fill: readonly [number, number, number];
  haze: { colour: readonly [number, number, number]; km: number } | null;
}
/** The Earth's: a blue fill, and a pale blue haze over 30 km (its e-folding distance). */
export const EARTH_AIR: GroundAir = { fill: [0.32, 0.45, 0.7], haze: { colour: [0.62, 0.72, 0.84], km: 30 } };
/** None (the Moon's): shadows lit only by the sunlit ground around them, a faint grey; no haze. */
export const AIRLESS_AIR: GroundAir = { fill: [0.035, 0.035, 0.035], haze: null };
/**
 * Venus's: all its light is the overcast's (no Sun is seen), orange, and its deep air's haze over 4 km
 * fading into the sky's horizon (illustrative).
 */
export const VENUS_AIR: GroundAir = { fill: [1.6, 1.05, 0.5], haze: { colour: [VENUS_SKY.horizon[0] * VENUS_SKY.scale, VENUS_SKY.horizon[1] * VENUS_SKY.scale, VENUS_SKY.horizon[2] * VENUS_SKY.scale], km: 4 } };
/** Mars's: a butterscotch fill, and its dust's haze over 12 km fading into its sky's horizon (illustrative). */
export const MARS_AIR: GroundAir = { fill: [0.45, 0.34, 0.24], haze: { colour: [MARS_SKY.horizon[0] * MARS_SKY.scale, MARS_SKY.horizon[1] * MARS_SKY.scale, MARS_SKY.horizon[2] * MARS_SKY.scale], km: 12 } };

/**
 * The ground for a world: its colour at a direction from its centre, its sunlight for the Sun's
 * height, its air, whether ground below sea level is drawn at sea level (the Earth's, whose sea is not
 * drawn; elsewhere the heights are the ground's own), and its illustrative surface (./surface).
 */
export function createGround(colour: (direction: Vec3Node) => Vec3Node, sunlight: (mu: FloatNode) => Vec3Node, options: { air?: GroundAir; seaLevel?: boolean; surface?: SurfaceStyle } = {}): Ground {
  const air = options.air ?? EARTH_AIR;
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
  const uDaylight = uniform(1);
  const uHaze = uniform(1);
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
    // 1 on the skirt's lower edge (0 on the ring), so a skirt's fragments are known.
    const skirt = new BufferAttribute(new Float32Array(count).fill(1, GRID), 1);
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('direction', direction);
    geometry.setAttribute('tangent2', tangent);
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
      const detail = surfaceDetail(metres, span, uSunLocal, surface, uStones);
      const albedo = colour(dir).mul(detail.grain.mul(DETAIL.brightness).add(1)).mul(detail.shade);
      // The geometry's own normal, also on a back face (seen from below through any gap, the ground is lit as from above).
      const smooth = normalize(normalWorldGeometry);
      // Its relief (km, as the positions are) tilts the shading: not on a skirt, and never past maxSlope.
      const onRing = float(1).sub(step(1e-4, attribute<'float'>('skirt', 'float')));
      const gradient = bumpGradient(positionWorld, smooth, detail.relief.div(1000)).mul(onRing);
      const steep = length(gradient);
      const n = tiltNormal(smooth, gradient.mul(min(1, float(DETAIL.maxSlope).div(max(steep, 1e-6)))), 1);
      const up = normalize(modelWorldMatrix.mul(vec4(dir, 0)).xyz);
      const mu = dot(up, uSun);
      const sun = sunlight(mu).mul(uLight);
      // The sky's fill: its light from above, as bright as the day is (and the sunlight that lights the sky).
      const sky = vec3(...air.fill).mul(uDaylight).mul(uLight).mul(dot(n, up).mul(0.5).add(0.5));
      const lit = albedo.mul(sun.mul(max(dot(n, uSun), 0)).mul(detail.sunlit).add(sky.mul(0.35)));
      if (!air.haze) return vec4(lit, 1);
      // The air between: a fade with distance into its colour, by day bright, by night dark.
      const haze = float(1).sub(exp(length(positionView).div(air.haze.km).negate()));
      return vec4(mix(lit, vec3(...air.haze.colour).mul(uHaze).mul(uLight), haze), 1);
    })();
    material.depthNode = viewZToLogarithmicDepth(positionView.z, uNear, uFar);
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = `explore-walk-ring-${level}`;
    mesh.renderOrder = -1;
    object.add(mesh);
    return { spacingKm, halfKm: (N / 2) * spacingKm, centre: [0, 0], placedFor: '', revision: -1, filledAt: 0, mesh, geometry, position, normal, direction, tangent, inner };
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

  const fill = (ring: Ring, heights: Heights, radiusKm: number): void => {
    const { up } = anchor.frame;
    const zoom = zoomFor(ring.spacingKm * 1000, anchor.lat, radiusKm);
    // The next ring out reads coarser heights: toward its edge this one's heights become those, so the
    // two meet with no step (a coarser ring standing above a finer one would leave a gap to see through).
    const outer = zoomFor(ring.spacingKm * 2000, anchor.lat, radiusKm);
    const height = (lat: number, lon: number, z: number): number => {
      const read = heights.at(lat, lon, z)?.metres ?? 0;
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
    // The skirt: the edge again, hung below it.
    const drop = GROUND.skirtSpacings * ring.spacingKm;
    edge.forEach((g, k) => {
      const s = GRID + k;
      for (let c = 0; c < 3; c += 1) {
        pos[s * 3 + c] = (pos[g * 3 + c] ?? 0) - (dirs[g * 3 + c] ?? 0) * drop;
        nor[s * 3 + c] = nor[g * 3 + c] ?? 0;
        dirs[s * 3 + c] = dirs[g * 3 + c] ?? 0;
      }
      tan[s * 2] = tan[g * 2] ?? 0;
      tan[s * 2 + 1] = tan[g * 2 + 1] ?? 0;
    });
    for (const a of [ring.position, ring.normal, ring.direction, ring.tangent]) a.needsUpdate = true;
    stats.refills += 1;
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
          return { ring, level, centre, placed, revision: heights.revision(zoomFor(ring.spacingKm * 1000, anchor.lat, frame.radiusKm)), moved: ring.placedFor !== placed };
        })
        .filter((d) => d.moved || d.ring.revision !== d.revision)
        .sort((a, b) => Number(b.moved) - Number(a.moved) || (a.moved ? 0 : a.ring.filledAt - b.ring.filledAt) || a.level - b.level);
      for (const d of due.slice(0, refillAll ? rings.length : GROUND.refillsPerFrame)) {
        if (d.ring.placedFor === '') stats.filled += 1;
        d.ring.centre = d.centre;
        fill(d.ring, heights, frame.radiusKm);
        d.ring.placedFor = d.placed;
        d.ring.revision = d.revision;
        d.ring.filledAt = frames;
      }
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
      // Daylight at the walker: the Sun's height, eased through twilight.
      const upR = [ax * (m[0] ?? 1) + ay * (m[3] ?? 0) + az * (m[6] ?? 0), ax * (m[1] ?? 0) + ay * (m[4] ?? 1) + az * (m[7] ?? 0), ax * (m[2] ?? 0) + ay * (m[5] ?? 0) + az * (m[8] ?? 1)];
      const l = Math.hypot(upR[0] ?? 0, upR[1] ?? 0, upR[2] ?? 0) || 1;
      const sinSun = ((upR[0] ?? 0) * frame.sun.x + (upR[1] ?? 0) * frame.sun.y + (upR[2] ?? 0) * frame.sun.z) / l;
      const sunDeg = (Math.asin(Math.max(-1, Math.min(1, sinSun))) * 180) / Math.PI;
      uDaylight.value = ambient(sunDeg);
      uHaze.value = haze(sunDeg);
    },
    dispose() {
      for (const r of rings) {
        r.geometry.dispose();
        (r.mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
