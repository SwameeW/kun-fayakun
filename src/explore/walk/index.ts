import type { Data3DTexture, Node, Object3D } from 'three/webgpu';
import type { UniverseWalk } from '../../core/types';
import { createGround } from './ground';
import { starlight } from './daylight';
import { createWalkSky } from './sky';
import { createHeights, zoomFor, type TileLoader } from './terrain';
import { createWalker, look, pressureKpa, solarTimeHours, stepWalker, sunElevationDeg, walkerPose, type WalkInput, type WalkerState } from './walker';

/**
 * On foot on the Earth (its own chunk, loaded the first time a walk starts): the walker (./walker),
 * the ground (./ground, from the terrain tiles of ./terrain under the globe's own colours), and the
 * sky (./sky). The explorer asks for a pose each frame and puts the camera there; the ground and the
 * sky are then placed relative to it. Until the ground under the walker has loaded the walk waits in
 * orbit, so the eye never starts inside a mountain. Places the explorer forbids (Makkah's framing
 * rule) can be neither landed on nor walked into. The world's figures (gravity, air) are given, so the
 * same walk goes on the Moon and Mars once their ground is in (docs/FEATURE-LEDGER.md GR-5).
 */

type Vec3Node = Node<'vec3'>;
type FloatNode = Node<'float'>;
type V3 = { x: number; y: number; z: number };

export interface WalkWorldFigures {
  name: string;
  radiusKm: number;
  /** Surface gravity, m/s^2. */
  gravity: number;
  /** Air at the surface (kPa) and its scale height (km), and the mean surface temperature (degrees C): null where not known. */
  surfaceKpa: number | null;
  scaleHeightKm: number | null;
  meanTempC: number | null;
}

export interface WalkSetup {
  groundColour(direction: Vec3Node): Vec3Node;
  sunlight(mu: FloatNode): Vec3Node;
  /** Decoded terrain tiles (./terrain terrariumLoader in the browser). */
  terrain: TileLoader;
  /** The explorer's noise volume, for the ground's fine detail (none without it). */
  noise: Data3DTexture | null;
  forbidden(lat: number, lon: number): boolean;
  world: WalkWorldFigures;
}

export interface Walk {
  readonly objects: readonly Object3D[];
  readonly active: boolean;
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
  /** Places the ground and sky for this frame, the camera at the origin. */
  place(frame: { earth: V3; basis: readonly number[]; sun: V3; sunWorld: readonly [number, number, number]; light: number; subSolarLon: number; near: number; far: number }): void;
  view(): UniverseWalk | null;
  dispose(): void;
}

/** The zoom the walker's own footing is read at, and the coarsest that counts as having landed. */
const FOOT_ZOOM_M = 5;
const LANDED_ZOOM = 9;

export function createWalk(setup: WalkSetup): Walk {
  const heights = createHeights(setup.terrain);
  const ground = createGround(
    (d) => setup.groundColour(d),
    (mu) => setup.sunlight(mu),
    setup.noise,
  );
  const sky = createWalkSky();
  const world = setup.world;
  let walker: WalkerState | null = null;
  let landed = false;
  let lastSun = { elevation: 0, solar: 12 };

  const footing = (lat: number, lon: number): { metres: number; zoom: number } | null => heights.at(lat, lon, zoomFor(FOOT_ZOOM_M, lat));
  const walkWorld = {
    radiusKm: world.radiusKm,
    gravity: world.gravity,
    // The sea (and land below it) is walked at sea level for now (./ground says why).
    ground: (lat: number, lon: number) => {
      const h = footing(lat, lon);
      return h ? Math.max(0, h.metres) : null;
    },
    blocked: (lat: number, lon: number) => setup.forbidden(lat, lon),
  };

  return {
    objects: [sky.mesh, ground.object],
    get active() {
      return walker !== null;
    },
    start(lat, lon, heading = 0) {
      if (setup.forbidden(lat, lon)) return 'forbidden';
      walker = createWalker(lat, lon, 0, heading);
      landed = false;
      ground.reset(lat, lon);
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
      return walker && landed ? starlight(sky.sunDeg) : 1;
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
        if (!under || under.zoom < LANDED_ZOOM) return null;
        landed = true;
        s.groundM = Math.max(0, under.metres);
        s.feetM = s.groundM;
      }
      stepWalker(s, input, Math.min(dt, 0.1), walkWorld);
      return walkerPose(s, world.radiusKm);
    },
    place(frame) {
      const s = walker;
      const show = s !== null && landed;
      ground.object.visible = show;
      sky.mesh.visible = show;
      if (!s || !show) return;
      ground.update(s, heights, { earth: frame.earth, basis: frame.basis, radiusKm: world.radiusKm, sun: frame.sun, light: frame.light, near: frame.near, far: frame.far });
      // The local vertical in the render frame, for the sky.
      const p = walkerPose(s, world.radiusKm).position;
      const m = frame.basis;
      const l = Math.hypot(p[0], p[1], p[2]) || 1;
      const up = { x: (p[0] * (m[0] ?? 1) + p[1] * (m[3] ?? 0) + p[2] * (m[6] ?? 0)) / l, y: (p[0] * (m[1] ?? 0) + p[1] * (m[4] ?? 1) + p[2] * (m[7] ?? 0)) / l, z: (p[0] * (m[2] ?? 0) + p[1] * (m[5] ?? 0) + p[2] * (m[8] ?? 1)) / l };
      sky.update(up, frame.sun, frame.far * 0.9);
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
        sunElevationDeg: lastSun.elevation,
        solarTimeH: lastSun.solar,
        groundZoom: under?.zoom ?? null,
        tiles: { ready: t.ready, loading: t.loading, failed: t.failed },
        rings: ground.stats.filled,
      };
    },
    dispose() {
      ground.dispose();
      sky.dispose();
      heights.clear();
    },
  };
}
