import type { Camera, Node, Object3D, WebGPURenderer } from 'three/webgpu';
import type { UniverseWalk, WalkableWorld } from '../../core/types';
import { vec3 } from 'three/tsl';
import { qiblaBearing } from '../islamic/kaaba';
import { createTransmittanceTable, type AirModel } from '../render/air';
import { createGround, MARS_HAZE, VENUS_HAZE } from './ground';
import { EARTH_SURFACE, MARS_SURFACE, MERCURY_SURFACE, MOON_SURFACE, VENUS_SURFACE, type SurfaceStyle } from './surface';
import { footStarLight, pointsSeen, type FootStars } from './daylight';
import { dayAdaptation, groundIlluminance, marsSunlight, sunDiscTint, sunThroughAir, walkExposure, type LightKind } from './light';
import { createMeter } from './meter';
import { createWalkSky, type SkyKind } from './sky';
import { createHeights, TERRAIN, zoomFor, type TileLoader } from './terrain';
import { createWalker, look, pressureKpa, solarTimeHours, stepWalker, sunAzimuthDeg, sunElevationDeg, WALK, walkerPose, type WalkInput, type WalkerState } from './walker';

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
  /** The Earth's air (../render/air, the globe's model, a clear day's: clearDayAir): the walk's sky, sunlight and aerial perspective come from it. */
  air?: AirModel;
  /**
   * The world's colour map's mean luminance and its measured Bond albedo (NASA's fact sheets): the map,
   * a picture made for the eye, is scaled so its mean is the world's albedo (the Moon is as dark as
   * worn asphalt, Mars twice as bright); the eye meters the world's albedo until it has read the
   * ground in view (./meter, ./light walkExposure).
   */
  albedo?: { map: number; bond: number };
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
  /** Starts a walk at a place, facing a heading and looking up or down (radians), refused where forbidden. */
  start(lat: number, lon: number, heading?: number, pitch?: number): 'started' | 'forbidden';
  stop(): void;
  /** Where the walker stands (degrees) once landed, else null. */
  where(): { lat: number; lon: number } | null;
  /**
   * How much of the planets' points' and names' light the sky lets through (1 at night, 0 by day, from
   * the Sun's height; on an airless world a third by day, eased in as the eye adapts): 1 while not walking.
   */
  starlight(): number;
  /**
   * The sky's stars' light (a multiple of the star light's, before the exposure) and the knee on their
   * brightest, from the explorer's own light (`light`, following a fifth of the eye's `exposure`), at `dpr`
   * pixels a CSS pixel, the sky's brightest star of magnitude `brightest`: held short of white by night,
   * hidden by the day and the twilight, and on an airless world held under the sunlit ground's glare by
   * day (./daylight footStarLight). The explorer's own, and no knee, while not walking. The object is
   * the walk's, rewritten each call.
   */
  starLight(light: number, exposure: number, dpr: number, brightest: number): Readonly<FootStars>;
  look(dxPx: number, dyPx: number): void;
  /** Steps the walker: its eye's pose in the world's frame (km from the centre, gaze, up), or null while the ground under it loads. */
  step(dt: number, input: WalkInput): { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] } | null;
  /**
   * Places the ground and sky for this frame, the camera at the origin: the world's centre relative to
   * the camera and its frame's axes (render frame), the Sun's direction from it (render frame, and in
   * the world's own frame), the sunlight's strength (1 at 1 au), the longitude beneath the Sun, the
   * depth range, and the camera: whether the ground and the sky are drawn (`shown`: never from orbit),
   * and whether the camera is the walker's eye (`eye`: the eye's meter reads only then; shown but not
   * the eye, it is above the walker on the way down, and the sky is drawn from up there).
   */
  place(frame: { centre: V3; basis: readonly number[]; sun: V3; sunWorld: readonly [number, number, number]; light: number; subSolarLon: number; near: number; far: number; exposure: number; renderer: WebGPURenderer; camera: Camera; shown: boolean; eye: boolean }): void;
  view(): UniverseWalk | null;
  /**
   * The exposure the walker's eye adapts to (./light walkExposure), from the light on level ground where
   * it stands and the ground in view (./meter: read while the camera is the walker's eye, `eye` in
   * place's frame); null until landed.
   */
  exposure(): number | null;
  /**
   * The Sun's colour as the walker sees it (into `out`): its light through the air on the way (the
   * Earth's slant path from the eye's height, Mars's dust), as sunDiscTint makes it (dimmed with its
   * luminance, but always far brighter than the sky round it); white where there is no air.
   */
  sunColour(out: [number, number, number]): void;
  /** The explorer's detail: all of the ground's illustrative detail, or all but its stones (./surface). */
  setDetail(fine: boolean): void;
  /** Asks again at once for heights that could not be loaded (and waits afresh for them, if not landed). */
  retry(): void;
  dispose(): void;
}

/**
 * Each world on foot: its sky (./sky), its light (./light, as the ground and the eye see it), its
 * illustrative ground between the measured heights (./surface), the haze its distance fades into
 * (Mars's and Venus's; the Earth's comes from its air), and whether ground below sea level is walked
 * at sea level (the Earth's: its sea is not drawn; elsewhere the heights are the ground's own).
 */
const LOOKS: Record<WalkableWorld, { sky: SkyKind; light: LightKind; surface: SurfaceStyle; haze?: { colour: readonly [number, number, number]; km: number }; seaLevel: boolean; ground?: readonly [number, number, number] }> = {
  earth: { sky: 'earth', light: 'earth', surface: EARTH_SURFACE, seaLevel: true },
  moon: { sky: 'airless', light: 'airless', surface: MOON_SURFACE, seaLevel: false },
  mars: { sky: 'mars', light: 'mars', surface: MARS_SURFACE, haze: MARS_HAZE, seaLevel: false },
  mercury: { sky: 'airless', light: 'airless', surface: MERCURY_SURFACE, seaLevel: false },
  // Venus: no sunlight reaches the ground as a beam (all of it is the overcast's), and its ground is dark basalt (illustrative).
  venus: { sky: 'venus', light: 'venus', surface: VENUS_SURFACE, haze: VENUS_HAZE, seaLevel: false, ground: [0.1, 0.09, 0.08] },
};

/** The zoom the walker's own footing is read at, and the coarsest that counts as having landed. */
const FOOT_ZOOM_M = 5;
const LANDED_ZOOM = 9;
/**
 * Landing waits this long (seconds) for heights that fine, then lands on whatever coarser ones have
 * come (asked for from the start at `fallbackZoom`), saying so; with none at all after `unavailableS`
 * it says the heights could not be loaded (they are still asked for: it lands as soon as some come).
 */
const LANDING = { coarseS: 8, unavailableS: 15, fallbackZoom: 6 } as const;

export function createWalk(setup: WalkSetup): Walk {
  const maxZoom = setup.maxZoom ?? TERRAIN.maxZoom;
  const heights = createHeights(setup.terrain, maxZoom);
  const looks = LOOKS[setup.world.name];
  const seaLevel = looks.seaLevel;
  // The Earth's air (the globe's, a clear day's), with its own transmittance table (baked on the first frame placed).
  const air = setup.air ?? null;
  const table = air ? createTransmittanceTable(air) : null;
  const airTable = air && table ? { model: air, table: table.texture } : null;
  const calibrate = setup.albedo && setup.albedo.map > 0 ? setup.albedo.bond / setup.albedo.map : 1;
  // On the Earth the ground reaches past the horizon from orbit, for the way down (./ground GROUND.farLevels).
  const ground = createGround((d) => (setup.groundColour ? setup.groundColour(d).mul(calibrate) : vec3(...(looks.ground ?? [0.2, 0.2, 0.2]))), { light: { kind: looks.light, air: airTable, haze: looks.haze ?? null }, seaLevel, surface: looks.surface, farRings: setup.world.name === 'earth' });
  const skyKind = looks.sky;
  const sky = createWalkSky(skyKind, airTable);
  const meter = createMeter(ground.copy);
  const world = setup.world;
  // Landed once the ground under the feet is this fine (or as fine as the world's heights go).
  const landedZoom = Math.min(LANDED_ZOOM, maxZoom);
  let walker: WalkerState | null = null;
  let landed = false;
  /** Seconds waited for the ground so far, and whether the walk landed on coarser heights than it asks for. */
  let waited = 0;
  let coarse = false;
  let lastSun = { elevation: 0, azimuth: 0, solar: 12 };
  /** The exposure the eye adapts to, and the Sun's colour, from the last frame placed. */
  let metered: number | null = null;
  /** How far the eye has adapted to the day (./light dayAdaptation, set as placed): the airless sky's glare on the stars eases in by it. */
  let day = 0;
  /** Landed, and the camera not yet the walker's eye: how far it is above the ground it is coming down to (km, set as placed; null otherwise). */
  let comingDownKm: number | null = null;
  const footStars: FootStars = { light: 1, knee: 0 };
  const sunTint: [number, number, number] = [1, 1, 1];

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
    start(lat, lon, heading = 0, pitch = 0) {
      if (setup.forbidden(lat, lon)) return 'forbidden';
      walker = createWalker(lat, lon, 0, heading);
      walker.pitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, pitch));
      landed = false;
      comingDownKm = null;
      waited = 0;
      coarse = false;
      ground.reset(walker.lat, walker.lon);
      meter.reset();
      return 'started';
    },
    stop() {
      walker = null;
      landed = false;
      metered = null;
      day = 0;
      comingDownKm = null;
      ground.object.visible = false;
      sky.mesh.visible = false;
    },
    where() {
      return walker && landed ? { lat: walker.lat, lon: walker.lon } : null;
    },
    starlight() {
      // Airless, the sky stays black: by day the sunlit ground's glare leaves only the brightest planets,
      // eased in as the eye adapts (a share that stepped as the Sun crossed the horizon was a visible pop).
      return walker && landed ? pointsSeen(skyKind, sky.sunDeg, day) : 1;
    },
    starLight(light, exposure, dpr, brightest) {
      if (walker && landed) return footStarLight(skyKind, sky.sunDeg, day, light, exposure, dpr, brightest, footStars);
      footStars.light = light;
      footStars.knee = 0;
      return footStars;
    },
    look(dx, dy) {
      if (walker) look(walker, dx, dy);
    },
    step(dt, input) {
      const s = walker;
      if (!s) return null;
      // Landing waits for the ground under the feet (coarse is enough; it sharpens as finer tiles come),
      // or after a while for any that has come.
      const under = footing(s.lat, s.lon);
      if (!landed) {
        waited += Math.min(Math.max(dt, 0), 0.25);
        heights.want(s.lat, s.lon, Math.min(LANDING.fallbackZoom, maxZoom));
        const fine = under !== null && under.zoom >= landedZoom;
        if (!under || (!fine && waited < LANDING.coarseS)) return null;
        landed = true;
        coarse = !fine;
        s.groundM = seaLevel ? Math.max(0, under.metres) : under.metres;
        s.feetM = s.groundM;
      }
      if (coarse && under && under.zoom >= landedZoom) coarse = false;
      // At most a fifth of a second a frame: a stalled frame does not fling the walker.
      stepWalker(s, input, Math.min(dt, 0.2), walkWorld);
      return walkerPose(s, world.radiusKm);
    },
    place(frame) {
      const s = walker;
      const show = s !== null && landed;
      // Drawn only once the camera is the walker's eye or on its way down to it: through the glide down
      // they are filled and their horizons marched (so the first frame shown is whole), but never seen
      // from orbit, where the sky would paint the ground's noon round the camera and the rings sit over
      // the globe.
      ground.object.visible = show && frame.shown;
      sky.mesh.visible = show && frame.shown;
      // Landed and still coming down (the glide, the dip, the way down through the air): the camera's
      // height above the ground under the walker, for the readout (on the way down it is right over it).
      comingDownKm = s && show && !frame.eye ? Math.max(0, Math.hypot(frame.centre.x, frame.centre.y, frame.centre.z) - world.radiusKm - s.groundM / 1000) : null;
      if (!s || !show) return;
      if (table && !table.baked) table.bake(frame.renderer);
      // The sky from the camera (on foot the walker's eye; on the way down, wherever in or above the air
      // the camera is): its local vertical in the render frame, and its distance from the centre; and
      // the walker's own, for the light it stands in.
      const c = frame.centre;
      const l = Math.hypot(c.x, c.y, c.z) || 1;
      const up = { x: -c.x / l, y: -c.y / l, z: -c.z / l };
      const eyeRadii = l / world.radiusKm;
      const p = walkerPose(s, world.radiusKm).position;
      const standRadii = Math.hypot(p[0], p[1], p[2]) / world.radiusKm;
      const aboveKm = frame.shown && !frame.eye ? Math.max(1e-6, (eyeRadii - standRadii) * world.radiusKm) : 0;
      ground.update(s, heights, { centre: frame.centre, basis: frame.basis, radiusKm: world.radiusKm, sun: frame.sun, light: frame.light, near: frame.near, far: frame.far, exposure: frame.exposure, aboveKm });
      sky.update({ up, sun: frame.sun, radiusKm: frame.far * 0.9, light: frame.light, exposure: frame.exposure, eyeRadii });
      lastSun = { elevation: sunElevationDeg(s.lat, s.lon, frame.sunWorld), azimuth: sunAzimuthDeg(s.lat, s.lon, frame.sunWorld), solar: solarTimeHours(s.lon, frame.subSolarLon) };
      // What the eye adapts to (the ground in view as the meter last read it, the world's albedo till then), and the Sun's colour through the air on the way.
      if (frame.eye) meter.read(frame.renderer, frame.camera);
      const e = groundIlluminance(looks.light, lastSun.elevation, frame.light, air, standRadii - 1);
      metered = walkExposure(e, frame.light, meter.luminance !== null && e > 0 ? meter.luminance / e : (setup.albedo?.bond ?? null));
      day = dayAdaptation(e, frame.light);
      const sin = Math.sin((lastSun.elevation * Math.PI) / 180);
      // The Sun's colour through the air between it and the camera (on the way down, from up there).
      const through: [number, number, number] = looks.light === 'earth' && air ? sunThroughAir(air, eyeRadii - 1, sin, 32) : looks.light === 'mars' ? marsSunlight(sin) : [1, 1, 1];
      sunDiscTint(through, sunTint);
    },
    view() {
      const s = walker;
      if (!s) return null;
      const t = heights.stats();
      const under = footing(s.lat, s.lon);
      return {
        state: landed ? 'walking' : waited >= LANDING.unavailableS && !under ? 'unavailable' : 'landing',
        comingDownKm,
        coarse,
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
        sunAzimuthDeg: lastSun.azimuth,
        sunSeen: skyKind !== 'venus',
        solarTimeH: lastSun.solar,
        qiblaDeg: world.name === 'earth' ? qiblaBearing(s.lat, s.lon) : null,
        groundZoom: under?.zoom ?? null,
        tiles: { ready: t.ready, loading: t.loading, failed: t.failed },
        rings: ground.stats.filled,
        metered: meter.readings,
        groundLuminance: meter.luminance,
        // The explorer's own (its lens and its clock).
        fovDeg: 70,
        timeCapped: false,
      };
    },
    exposure() {
      return metered;
    },
    sunColour(out) {
      out[0] = sunTint[0];
      out[1] = sunTint[1];
      out[2] = sunTint[2];
    },
    setDetail(fine) {
      ground.setFine(fine);
    },
    retry() {
      heights.retry();
      if (!landed) waited = 0;
    },
    dispose() {
      ground.dispose();
      meter.dispose();
      sky.dispose();
      table?.dispose();
      heights.clear();
    },
  };
}
