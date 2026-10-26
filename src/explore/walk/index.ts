import type { Node, Object3D } from 'three/webgpu';
import type { UniverseWalk, WalkableWorld } from '../../core/types';
import { vec3 } from 'three/tsl';
import { AIRLESS_AIR, createGround, EARTH_AIR, MARS_AIR, VENUS_AIR, type GroundAir } from './ground';
import { EARTH_SURFACE, MARS_SURFACE, MERCURY_SURFACE, MOON_SURFACE, VENUS_SURFACE, type SurfaceStyle } from './surface';
import { starlight } from './daylight';
import { createWalkSky, MARS_SUN_TINT, type SkyKind } from './sky';
import { createHeights, TERRAIN, zoomFor, type TileLoader } from './terrain';
import { createWalker, look, pressureKpa, solarTimeHours, stepWalker, sunElevationDeg, walkerPose, type WalkInput, type WalkerState } from './walker';

/**
 * On foot (its own chunk, loaded the first time a walk starts), on the Earth, the Moon, Mars, Mercury
 * or Venus: the
 * walker (./walker), the ground (./ground, from the world's heights, ./terrain or ./equirect, under the
 * globe's own colours), and the sky (./sky: the Earth's, none, or Mars's). The explorer asks for a pose
 * each frame and puts the camera there; the ground and the sky are then placed relative to it. Until
 * the ground under the walker has loaded the walk waits in orbit, so the eye never starts inside a
 * mountain. Places the explorer forbids (Makkah's framing rule) can be neither landed on nor walked
 * into. Each world's figures (gravity, air) are given (docs/WALKING.md, ledger GR-5).
 */

type Vec3Node = Node<'vec3'>;
type FloatNode = Node<'float'>;
type V3 = { x: number; y: number; z: number };

export interface WalkWorldFigures {
  name: WalkableWorld;
  radiusKm: number;
  /** Surface gravity, m/s^2. */
  gravity: number;
  /** Air at the surface (kPa) and its scale height (km), and the mean surface temperature (degrees C): null where not known (or no air). */
  surfaceKpa: number | null;
  scaleHeightKm: number | null;
  meanTempC: number | null;
  /** The ground's range of temperatures through the day at the equator (degrees C), where given. */
  dayRangeC?: { min: number; max: number } | null;
}

export interface WalkSetup {
  /** The ground's colour at a direction from the world's centre (its globe's own); none: the world's illustrative colour (Venus's, whose surface no camera has mapped in colour). */
  groundColour?(direction: Vec3Node): Vec3Node;
  /** Sunlight's colour after the air, for the cosine of the Sun's height (the Earth's globe's model; elsewhere the world's own tint: ./sky). */
  sunlight?(mu: FloatNode): Vec3Node;
  /** Decoded terrain tiles (./terrain terrariumLoader for the Earth, ./equirect equirectLoader for the Moon and Mars), and the finest zoom they hold (the Earth's tiles' when not said). */
  terrain: TileLoader;
  maxZoom?: number;
  forbidden(lat: number, lon: number): boolean;
  world: WalkWorldFigures;
}

export interface Walk {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
  /** Whether the Sun (and the stars) can be seen from this world's ground (not through Venus's clouds). */
  readonly skySeen: boolean;
  /** Starts a walk at a place (refused where forbidden). */
  start(lat: number, lon: number, heading?: number): 'started' | 'forbidden';
  stop(): void;
  /** Where the walker stands (degrees) once landed, else null. */
  where(): { lat: number; lon: number } | null;
  /** How much starlight the sky lets through (1 at night, 0 by day, from the Sun's height): 1 while not walking. */
  starlight(): number;
  look(dxPx: number, dyPx: number): void;
  /** Steps the walker: its eye's pose in the world's frame (km from the centre, gaze, up), or null while the ground under it loads. */
  step(dt: number, input: WalkInput): { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] } | null;
  /**
   * Places the ground and sky for this frame, the camera at the origin: the world's centre relative to
   * the camera and its frame's axes (render frame), the Sun's direction from it (render frame, and in
   * the world's own frame), the sunlight's strength (1 at 1 au), the longitude beneath the Sun, and the
   * depth range.
   */
  place(frame: { centre: V3; basis: readonly number[]; sun: V3; sunWorld: readonly [number, number, number]; light: number; subSolarLon: number; near: number; far: number }): void;
  view(): UniverseWalk | null;
  /** The explorer's detail: all of the ground's illustrative detail, or all but its stones (./surface). */
  setDetail(fine: boolean): void;
  dispose(): void;
}

/**
 * Each world on foot: its sky (./sky), its air as the ground sees it (./ground), its illustrative
 * ground between the measured heights (./surface), its sunlight's tint where the setup gives none
 * (white: unfiltered, as on an airless world), and whether ground below sea level is walked at sea
 * level (the Earth's: its sea is not drawn; elsewhere the heights are the ground's own).
 */
const LOOKS: Record<WalkableWorld, { sky: SkyKind; air: GroundAir; surface: SurfaceStyle; sunTint: readonly [number, number, number]; seaLevel: boolean; ground?: readonly [number, number, number] }> = {
  earth: { sky: 'earth', air: EARTH_AIR, surface: EARTH_SURFACE, sunTint: [1, 1, 1], seaLevel: true },
  moon: { sky: 'airless', air: AIRLESS_AIR, surface: MOON_SURFACE, sunTint: [1, 1, 1], seaLevel: false },
  mars: { sky: 'mars', air: MARS_AIR, surface: MARS_SURFACE, sunTint: MARS_SUN_TINT, seaLevel: false },
  mercury: { sky: 'airless', air: AIRLESS_AIR, surface: MERCURY_SURFACE, sunTint: [1, 1, 1], seaLevel: false },
  // Venus: no sunlight reaches the ground as a beam (all of it is the overcast's), and its ground is dark basalt (illustrative).
  venus: { sky: 'venus', air: VENUS_AIR, surface: VENUS_SURFACE, sunTint: [0, 0, 0], seaLevel: false, ground: [0.1, 0.09, 0.08] },
};

/** On an airless world by day, how much of the stars' light shows past the sunlit ground's glare (illustrative). */
const AIRLESS_DAY_STARS = 0.35;
/** The zoom the walker's own footing is read at, and the coarsest that counts as having landed. */
const FOOT_ZOOM_M = 5;
const LANDED_ZOOM = 9;

export function createWalk(setup: WalkSetup): Walk {
  const maxZoom = setup.maxZoom ?? TERRAIN.maxZoom;
  const heights = createHeights(setup.terrain, maxZoom);
  const looks = LOOKS[setup.world.name];
  const seaLevel = looks.seaLevel;
  const ground = createGround(
    (d) => (setup.groundColour ? setup.groundColour(d) : vec3(...(looks.ground ?? [0.2, 0.2, 0.2]))),
    (mu) => (setup.sunlight ? setup.sunlight(mu) : vec3(...looks.sunTint)),
    { air: looks.air, seaLevel, surface: looks.surface },
  );
  const skyKind = looks.sky;
  const sky = createWalkSky(skyKind);
  const world = setup.world;
  // Landed once the ground under the feet is this fine (or as fine as the world's heights go).
  const landedZoom = Math.min(LANDED_ZOOM, maxZoom);
  let walker: WalkerState | null = null;
  let landed = false;
  let lastSun = { elevation: 0, solar: 12 };

  const footing = (lat: number, lon: number): { metres: number; zoom: number } | null => heights.at(lat, lon, zoomFor(FOOT_ZOOM_M, lat, world.radiusKm));
  const walkWorld = {
    radiusKm: world.radiusKm,
    gravity: world.gravity,
    // On the Earth the sea (and land below it) is walked at sea level for now (./ground says why).
    ground: (lat: number, lon: number) => {
      const h = footing(lat, lon);
      return h ? (seaLevel ? Math.max(0, h.metres) : h.metres) : null;
    },
    blocked: (lat: number, lon: number) => setup.forbidden(lat, lon),
  };

  return {
    objects: [sky.mesh, ground.object],
    get active() {
      return walker !== null;
    },
    skySeen: skyKind !== 'venus',
    start(lat, lon, heading = 0) {
      if (setup.forbidden(lat, lon)) return 'forbidden';
      walker = createWalker(lat, lon, 0, heading);
      landed = false;
      ground.reset(walker.lat, walker.lon);
      return 'started';
    },
    stop() {
      walker = null;
      landed = false;
      ground.object.visible = false;
      sky.mesh.visible = false;
    },
    where() {
      return walker && landed ? { lat: walker.lat, lon: walker.lon } : null;
    },
    starlight() {
      if (!walker || !landed) return 1;
      // Airless, the sky stays black; by day the sunlit ground's glare leaves the eye only the brightest stars.
      if (skyKind === 'airless') return sky.sunDeg > 0 ? AIRLESS_DAY_STARS : 1;
      // Under Venus's clouds no star is ever seen.
      if (skyKind === 'venus') return 0;
      return starlight(sky.sunDeg);
    },
    look(dx, dy) {
      if (walker) look(walker, dx, dy);
    },
    step(dt, input) {
      const s = walker;
      if (!s) return null;
      // Landing waits for the ground under the feet (coarse is enough; it sharpens as finer tiles come).
      const under = footing(s.lat, s.lon);
      if (!landed) {
        if (!under || under.zoom < landedZoom) return null;
        landed = true;
        s.groundM = seaLevel ? Math.max(0, under.metres) : under.metres;
        s.feetM = s.groundM;
      }
      // At most a fifth of a second a frame: a stalled frame does not fling the walker.
      stepWalker(s, input, Math.min(dt, 0.2), walkWorld);
      return walkerPose(s, world.radiusKm);
    },
    place(frame) {
      const s = walker;
      const show = s !== null && landed;
      ground.object.visible = show;
      sky.mesh.visible = show;
      if (!s || !show) return;
      ground.update(s, heights, { centre: frame.centre, basis: frame.basis, radiusKm: world.radiusKm, sun: frame.sun, light: frame.light, near: frame.near, far: frame.far });
      // The local vertical in the render frame, for the sky.
      const p = walkerPose(s, world.radiusKm).position;
      const m = frame.basis;
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      const up = { x: (p[0] * (m[0] ?? 1) + p[1] * (m[3] ?? 0) + p[2] * (m[6] ?? 0)) / l, y: (p[0] * (m[1] ?? 0) + p[1] * (m[4] ?? 1) + p[2] * (m[7] ?? 0)) / l, z: (p[0] * (m[2] ?? 0) + p[1] * (m[5] ?? 0) + p[2] * (m[8] ?? 1)) / l };
      sky.update(up, frame.sun, frame.far * 0.9, frame.light);
      lastSun = { elevation: sunElevationDeg(s.lat, s.lon, frame.sunWorld), solar: solarTimeHours(s.lon, frame.subSolarLon) };
    },
    view() {
      const s = walker;
      if (!s) return null;
      const t = heights.stats();
      const under = footing(s.lat, s.lon);
      return {
        state: landed ? 'walking' : 'landing',
        world: world.name,
        lat: s.lat,
        lon: s.lon,
        groundM: s.groundM,
        feetM: s.feetM,
        headingDeg: (s.heading * 180) / Math.PI,
        pitchDeg: (s.pitch * 180) / Math.PI,
        airborne: s.airborne,
        blocked: s.blocked,
        walkedM: s.walkedM,
        gravity: world.gravity,
        pressureKpa: world.surfaceKpa !== null && world.scaleHeightKm !== null ? pressureKpa(s.feetM, world.surfaceKpa, world.scaleHeightKm) : null,
        meanTempC: world.meanTempC,
        dayRangeC: world.dayRangeC ?? null,
        sunElevationDeg: lastSun.elevation,
        sunSeen: skyKind !== 'venus',
        solarTimeH: lastSun.solar,
        groundZoom: under?.zoom ?? null,
        tiles: { ready: t.ready, loading: t.loading, failed: t.failed },
        rings: ground.stats.filled,
      };
    },
    setDetail(fine) {
      ground.setFine(fine);
    },
    dispose() {
      ground.dispose();
      sky.dispose();
      heights.clear();
    },
  };
}
