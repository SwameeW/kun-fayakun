/**
 * On foot in a space suit: a place on a world's surface (latitude, longitude, degrees), a heading
 * (radians clockwise from north) and a look up or down, the feet on the ground its height source
 * gives, and jumps under the world's own surface gravity, so the same legs bound on the Moon. Pure:
 * the explorer feeds it input and the ground and reads back a pose in the world's own frame (x through
 * the prime meridian, y the north pole, z toward 90 W: ../living/quakes bodyFrame's).
 */

export const WALK = {
  /** Eye height above the feet (m). */
  eyeM: 1.7,
  /** Walking and running speeds (m/s). */
  walkMps: 1.4,
  runMps: 5,
  /** Take-off speed (m/s): about half a metre on the Earth, six times higher on the Moon. */
  jumpMps: 3.1,
  /** Radians of turn per CSS pixel dragged, and the furthest the look tips up or down. */
  lookPerPx: 0.0032,
  maxPitch: 1.45,
  /** Radians per second the arrow keys turn and tip the look. */
  turnRadPerS: 1.2,
} as const;

export interface WalkerState {
  lat: number;
  lon: number;
  heading: number;
  pitch: number;
  /** The ground under the feet and the feet themselves, metres above sea level. */
  groundM: number;
  feetM: number;
  /** Vertical speed (m/s) while in the air. */
  vUp: number;
  airborne: boolean;
  /** The last step was refused (a place the walker may not enter). */
  blocked: boolean;
  /** Metres walked. */
  walkedM: number;
}

export interface WalkInput {
  /** -1 back, 1 forward; -1 left, 1 right. */
  forward: number;
  right: number;
  run: boolean;
  jump: boolean;
  /** Arrow keys: turn (-1 left, 1 right) and tip the look (1 up). */
  turn: number;
  tip: number;
}

export interface WalkWorld {
  radiusKm: number;
  /** Surface gravity, m/s^2. */
  gravity: number;
  /** The ground's height (m) at a place, or null where it is not known yet. */
  ground(lat: number, lon: number): number | null;
  /** Places the walker may not enter. */
  blocked(lat: number, lon: number): boolean;
}

export function createWalker(lat: number, lon: number, groundM: number, heading = 0): WalkerState {
  return { lat, lon, heading, pitch: 0, groundM, feetM: groundM, vUp: 0, airborne: false, blocked: false, walkedM: 0 };
}

const DEG = Math.PI / 180;
const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** A drag turns the walker and tips the look. */
export function look(s: WalkerState, dxPx: number, dyPx: number): void {
  // The scene moves with the drag (as in a street-level photo viewer): dragged right, the view turns left.
  s.heading = (((s.heading - dxPx * WALK.lookPerPx) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  s.pitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, s.pitch + dyPx * WALK.lookPerPx));
}

/** One step of `dt` seconds: across the ground (unless refused), then up or down under gravity. */
export function stepWalker(s: WalkerState, input: WalkInput, dt: number, world: WalkWorld): void {
  s.heading = (((s.heading + input.turn * WALK.turnRadPerS * dt) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  s.pitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, s.pitch + input.tip * WALK.turnRadPerS * dt));
  const along = Math.hypot(input.forward, input.right);
  s.blocked = false;
  if (along > 0) {
    const speed = (input.run ? WALK.runMps : WALK.walkMps) * dt;
    const f = input.forward / along;
    const r = input.right / along;
    const north = (Math.cos(s.heading) * f - Math.sin(s.heading) * r) * speed;
    const east = (Math.sin(s.heading) * f + Math.cos(s.heading) * r) * speed;
    const radiusM = world.radiusKm * 1000;
    const lat = Math.max(-89.999, Math.min(89.999, s.lat + north / radiusM / DEG));
    const lon = wrapLon(s.lon + east / (radiusM * Math.max(Math.cos(s.lat * DEG), 1e-6)) / DEG);
    if (world.blocked(lat, lon)) s.blocked = true;
    else {
      s.walkedM += Math.hypot(north, east);
      s.lat = lat;
      s.lon = lon;
    }
  }
  s.groundM = world.ground(s.lat, s.lon) ?? s.groundM;
  if (!s.airborne && input.jump) {
    s.vUp = WALK.jumpMps;
    s.airborne = true;
  }
  if (s.airborne) {
    s.vUp -= world.gravity * dt;
    s.feetM += s.vUp * dt;
    if (s.feetM <= s.groundM && s.vUp <= 0) {
      s.feetM = s.groundM;
      s.vUp = 0;
      s.airborne = false;
    }
  } else s.feetM = s.groundM;
}

/** The local frame at a place (unit vectors in the world's frame): up, east and north. */
export function localFrame(latDeg: number, lonDeg: number): { up: [number, number, number]; east: [number, number, number]; north: [number, number, number] } {
  const p = latDeg * DEG;
  const l = lonDeg * DEG;
  return {
    up: [Math.cos(p) * Math.cos(l), Math.sin(p), -Math.cos(p) * Math.sin(l)],
    east: [-Math.sin(l), 0, -Math.cos(l)],
    north: [-Math.sin(p) * Math.cos(l), Math.cos(p), Math.sin(p) * Math.sin(l)],
  };
}

/** The eye's place (km from the world's centre) and its gaze and up, in the world's frame. */
export function walkerPose(s: WalkerState, radiusKm: number): { position: [number, number, number]; forward: [number, number, number]; up: [number, number, number] } {
  const { up, east, north } = localFrame(s.lat, s.lon);
  const r = radiusKm + (s.feetM + WALK.eyeM) / 1000;
  const ch = Math.cos(s.heading);
  const sh = Math.sin(s.heading);
  const cp = Math.cos(s.pitch);
  const sp = Math.sin(s.pitch);
  const level = [0, 1, 2].map((k) => ch * (north[k] ?? 0) + sh * (east[k] ?? 0));
  return {
    position: [up[0] * r, up[1] * r, up[2] * r],
    forward: [0, 1, 2].map((k) => cp * (level[k] ?? 0) + sp * (up[k] ?? 0)) as [number, number, number],
    up: [0, 1, 2].map((k) => -sp * (level[k] ?? 0) + cp * (up[k] ?? 0)) as [number, number, number],
  };
}

/** Pressure (kPa) at a height (m) in an isothermal atmosphere: the surface pressure falling by e every scale height. */
export const pressureKpa = (heightM: number, surfaceKpa: number, scaleHeightKm: number): number => surfaceKpa * Math.exp(-heightM / 1000 / scaleHeightKm);

/** The Sun's elevation (degrees) at a place, from its direction in the world's frame. */
export function sunElevationDeg(latDeg: number, lonDeg: number, sun: readonly [number, number, number]): number {
  const { up } = localFrame(latDeg, lonDeg);
  const l = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  return Math.asin(Math.max(-1, Math.min(1, (up[0] * sun[0] + up[1] * sun[1] + up[2] * sun[2]) / l))) / DEG;
}

/** Local apparent solar time (hours, 0 to 24) at a longitude, from the longitude where the Sun is overhead. */
export const solarTimeHours = (lonDeg: number, subSolarLonDeg: number): number => ((((12 + (lonDeg - subSolarLonDeg) / 15) % 24) + 24) % 24);
