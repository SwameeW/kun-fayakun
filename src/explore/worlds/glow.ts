/**
 * The sky's faint glows behind the stars, in the solar-system explorer: the Milky Way (the light of
 * its countless unresolved stars) and the zodiacal light with the gegenschein (sunlight scattered by
 * the dust in the planets' plane). Both are models, computed once when this chunk loads, and the
 * readout says so (UniverseIllustration 'sky-glow') while either can be seen: no all-sky photograph
 * with a clear licence is used (docs/EXPLORER-MECHANICS.md).
 *
 * - The Milky Way: the Galaxy's starlight along each line of sight from the Sun (20 pc above the
 *   plane, 8.2 kpc from the centre): a thin and a thick exponential disc and a boxy bulge (Bland-Hawthorn
 *   and Gerhard 2016, ARA&A 54, 529), dimmed by a thinner exponential layer of dust (about a magnitude
 *   per kiloparsec in V near the Sun), so the dark rift runs along the bright band and the centre is
 *   brightest toward Sagittarius. Scaled so the galactic poles' starlight is about 50 S10(V), the
 *   order Leinert et al. (1998, A&AS 127, 1) give.
 * - The zodiacal light: the COBE/DIRBE model's smooth cloud (Kelsall et al. 1998, ApJ 508, 44: density
 *   as r^-1.34, its fan-shaped fall-off from the plane) lit by the Sun as 1/r^2 and scattering by
 *   Hong's (1985, A&A 146, 67) three-term phase function, integrated along each line of sight from 1
 *   au; scaled so it is about 250 S10(V) at 90 degrees from the Sun along the ecliptic (Leinert et al.
 *   1998), and seen from elsewhere brighter or fainter as r^-2.3 (the Helios and Pioneer measurements),
 *   between 0.3 and 3 au from the Sun only: the table is a view from inside the cloud near 1 au, and
 *   Pioneer 10 saw the light end past about 3.3 au (zodiacalScale).
 *
 * Light: S10(V) is the light of one tenth-magnitude star per square degree; a square degree of glow
 * is given that star's light in proportion to the sky's naked-eye stars, spread over the pixels it
 * covers. It is held in display terms with the stars as the exposure opens (far from the Sun), but
 * never lifted as the exposure closes (near the Sun, or a bright world in view): a glow over the whole
 * sky dims as a camera's would (glowLight). Through the solar filter it is not seen at all.
 *
 * Cost: the Milky Way's table is worked out in the render frame itself, as the sphere's own texture
 * coordinates map it, and the zodiacal light's is read by the angle from the Sun along those same
 * coordinates, so a pixel costs two texture reads and no trigonometry. At the Low detail level it is
 * not drawn.
 */

import { AdditiveBlending, BackSide, DataTexture, LinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, RGBAFormat, SphereGeometry, Vector3, type Node, type PerspectiveCamera } from 'three/webgpu';
import { abs, exp, float, fract, max, texture, uniform, uv, vec2, vec3 } from 'three/tsl';

/** The tables' resolution (the render frame's longitude by latitude; elongation in longitude by ecliptic latitude). */
const MILKY = { width: 256, height: 128, steps: 72, reachKpc: 30 } as const;
const ZODI = { width: 64, height: 32, steps: 96, reachAu: 6 } as const;
/** The tables are worked out a few rows a frame, for at most this long a frame (ms). */
const FILL_MS = 1;
/** log10 of S10 is stored in eight bits over this range. */
const LOG_RANGE = [0, 4.2] as const;
/** The Galaxy (kpc): the Sun's place, the discs, the bulge (bar 27 degrees from the Sun-centre line), the dust. */
const GALAXY = {
  sunR: 8.2,
  sunZ: 0.02,
  thin: { scaleR: 2.6, scaleZ: 0.3 },
  thick: { scaleR: 2.0, scaleZ: 0.9, share: 0.04 },
  bulge: { axes: [1.0, 0.42, 0.32], angleDeg: 27, share: 6 },
  dust: { scaleR: 3.3, scaleZ: 0.12, magPerKpc: 1.0 },
} as const;
/** Kelsall et al.'s smooth cloud, and Hong's phase function: weights and asymmetries. */
const CLOUD = { alpha: 1.34, beta: 4.14, gamma: 0.942, mu: 0.189 } as const;
const HONG = { w: [0.665, 0.33, 0.005], g: [0.7, -0.2, -0.81] } as const;
/** The anchors: S10(V) at the galactic poles, and 90 degrees from the Sun along the ecliptic at 1 au. */
const POLES_S10 = 50;
/** The glows' colour (linear, display terms): the integrated light of old stars and sunlight, a warm white. */
const GLOW_COLOUR: readonly [number, number, number] = [1, 0.95, 0.88];
const ZODI_90_S10 = 250;
/**
 * One S10 per square degree as display light per square degree: a tenth-magnitude star's light, in
 * proportion to the faintest naked-eye star's (V = 6.5) as the sky shows it (./belt SEEN), the flux
 * itself (not the points' gentler curve, which lifts faint stars so they show at all).
 */
const S10_LIGHT = (0.05 / 0.276) * 10 ** (-0.4 * (10 - 6.5));
/**
 * The zodiacal light's fall with the observer's distance from the Sun (au); the distances it is shown
 * between (au: coming in from, full at; full until, gone at); and how close to the Sun's direction the
 * table is trusted (degrees: nearer, the light is held at its value there, rising no further, so the
 * Sun's surroundings have a soft glow, its glare drawn over it, and no hole).
 */
const ZODI_POWER = 2.3;
const ZODI_NEAR_AU = [0.2, 0.3] as const;
const ZODI_FAR_AU = [2.5, 3.3] as const;
const ZODI_HELD_DEG = 24;
/**
 * The glow's ease in once worked out (s); and the display light it must reach somewhere in view to be
 * said to show: through the tone curve's toe, about ten steps of eight bits above black.
 */
const READY_SECONDS = 0.5;
const SEEN_LIGHT = 0.012;
/** The sphere's segments: its texture coordinates follow the directions closely enough for a 1.4 degree table. */
const SEGMENTS = [96, 48] as const;
/** J2000 equatorial to galactic (rows), the IAU's. */
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
] as const;

const encode = (s10: number): number => Math.round(Math.min(1, Math.max(0, (Math.log10(Math.max(s10, 1e-9)) - LOG_RANGE[0]) / (LOG_RANGE[1] - LOG_RANGE[0]))) * 255);
const decodeCpu = (v: number): number => 10 ** (LOG_RANGE[0] + (v / 255) * (LOG_RANGE[1] - LOG_RANGE[0]));
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Starlight along a line of sight (galactic l, b, radians) from the Sun: discs and bulge, dimmed by dust (arbitrary units). */
export function milkyWayAlong(l: number, b: number): number {
  const g = GALAXY;
  const dx = Math.cos(b) * Math.cos(l);
  const dy = Math.cos(b) * Math.sin(l);
  const dz = Math.sin(b);
  const tauPerKpc = (g.dust.magPerKpc / 1.0857) / Math.exp(-g.sunR / g.dust.scaleR);
  const bar = (g.bulge.angleDeg * Math.PI) / 180;
  const [ax, ay, az] = g.bulge.axes;
  let light = 0;
  let tau = 0;
  let s = 0.002;
  const grow = (MILKY.reachKpc / s) ** (1 / MILKY.steps);
  for (let k = 0; k < MILKY.steps; k += 1) {
    const next = s * grow;
    const ds = next - s;
    const mid = s + ds / 2;
    // Galactocentric: the Sun at (-R0, 0, z0), the centre at the origin, x toward the centre from the Sun.
    const x = -g.sunR + mid * dx;
    const y = mid * dy;
    const z = g.sunZ + mid * dz;
    const R = Math.hypot(x, y);
    const thin = Math.exp(-R / g.thin.scaleR - Math.abs(z) / g.thin.scaleZ);
    const thick = g.thick.share * Math.exp(-R / g.thick.scaleR - Math.abs(z) / g.thick.scaleZ);
    const bx = x * Math.cos(bar) + y * Math.sin(bar);
    const by = -x * Math.sin(bar) + y * Math.cos(bar);
    const bulge = g.bulge.share * Math.exp(-Math.hypot(bx / ax, by / ay, z / az));
    const dust = Math.exp(-R / g.dust.scaleR - Math.abs(z) / g.dust.scaleZ);
    tau += dust * tauPerKpc * ds * 0.5;
    light += (thin + thick + bulge) * Math.exp(-tau) * ds;
    tau += dust * tauPerKpc * ds * 0.5;
    s = next;
  }
  return light;
}

/** Hong's phase function at a scattering angle with this cosine (per steradian). */
function hong(cos: number): number {
  let p = 0;
  for (let i = 0; i < 3; i += 1) {
    const g = HONG.g[i] ?? 0;
    p += ((HONG.w[i] ?? 0) * (1 - g * g)) / (4 * Math.PI * (1 + g * g - 2 * g * cos) ** 1.5);
  }
  return p;
}

/**
 * Zodiacal light seen from 1 au in the ecliptic, at an elongation in longitude from the Sun `dLambda`
 * and ecliptic latitude `beta` (radians) (arbitrary units).
 */
export function zodiacalAlong(dLambda: number, beta: number): number {
  // The observer at (1, 0, 0) au, the Sun at the origin; the line of sight dLambda from the Sun's direction (-x).
  const dx = -Math.cos(beta) * Math.cos(dLambda);
  const dy = Math.cos(beta) * Math.sin(dLambda);
  const dz = Math.sin(beta);
  let light = 0;
  let s = 0.002;
  const grow = (ZODI.reachAu / s) ** (1 / ZODI.steps);
  for (let k = 0; k < ZODI.steps; k += 1) {
    const next = s * grow;
    const ds = next - s;
    const mid = s + ds / 2;
    const x = 1 + mid * dx;
    const y = mid * dy;
    const z = mid * dz;
    const r = Math.max(Math.hypot(x, y, z), 0.02);
    const zeta = Math.abs(z) / r;
    const g = zeta < CLOUD.mu ? (zeta * zeta) / (2 * CLOUD.mu) : zeta - CLOUD.mu / 2;
    const density = r ** -CLOUD.alpha * Math.exp(-CLOUD.beta * g ** CLOUD.gamma);
    // Scattering angle: the sunlight's way on (from the Sun through the grain) against the way to the observer (-line of sight).
    const cos = -(x * dx + y * dy + z * dz) / r;
    light += (density * hong(cos) * ds) / (r * r);
    s = next;
  }
  return light;
}

/** The zodiacal light's brightness seen from `au` from the Sun, against 1 au's: r^-2.3 between 0.3 and 3 au, faded to none outside (see above), never brighter than at 0.3 au. */
export function zodiacalScale(au: number): number {
  return Math.max(au, ZODI_NEAR_AU[1]) ** -ZODI_POWER * smooth(ZODI_NEAR_AU[0], ZODI_NEAR_AU[1], au) * (1 - smooth(ZODI_FAR_AU[0], ZODI_FAR_AU[1], au));
}

/**
 * The glow's light (display terms, before the exposure) for the stars' light and how much of the
 * exposure's adaptation they show: held with the stars as the exposure opens (compensation above 1),
 * never lifted as it closes, so on screen it dims with the exposure there as a surface's light does.
 */
export function glowLight(compensation: number, light: number, follow: number): number {
  return light * Math.min(1, Math.max(compensation, 1e-6) ** (follow - 1));
}

/**
 * A render-frame direction's texture coordinates on three's SphereGeometry (u round from -x through
 * +z, v from the south pole up), as the glow's sphere has them; `out` [u, v].
 */
export function skyUv(x: number, y: number, z: number, out: number[]): number[] {
  const r = Math.hypot(x, y, z) || 1;
  const u = Math.atan2(z, -x) / (2 * Math.PI);
  out[0] = u - Math.floor(u);
  out[1] = 1 - Math.acos(Math.min(1, Math.max(-1, y / r))) / Math.PI;
  return out;
}

export interface SkyGlowFrame {
  /** The sphere's radius (inside the far plane, behind the stars), and the camera from the Sun (render frame, km). */
  radius: number;
  cameraKm: { x: number; y: number; z: number };
  au: number;
  /** A pixel's solid angle (square degrees), the glow's light (display terms: glowLight), the exposure's adaptation, and how much shows (0 to 1: the night sky's share, the worlds' fade, the solar filter's). */
  pixelDeg2: number;
  light: number;
  compensation: number;
  shown: number;
  dt: number;
}

export interface SkyGlow {
  readonly object: Mesh;
  update(frame: SkyGlowFrame): void;
  /** Off at the Low detail level. */
  setEnabled(on: boolean): void;
  /** Whether the glow shows anywhere in the camera's view now (its brightest above what the tone curve shows). */
  seen(view: PerspectiveCamera): boolean;
  dispose(): void;
}

export function createSkyGlow(obliquity: number): SkyGlow {
  // The tables are filled a few rows a frame (update), so working them out never holds a frame up;
  // the glow shows, eased in, once both are done.
  const milky = new Uint8Array(MILKY.width * MILKY.height * 4);
  const zodi = new Uint8Array(ZODI.width * ZODI.height * 4);
  let pole = 0;
  let at90 = 0;
  let filled = 0;
  const rows = MILKY.height + ZODI.height;
  const c = Math.cos(obliquity);
  const s = Math.sin(obliquity);
  const fillRow = (): void => {
    const row = filled;
    if (row < MILKY.height) {
      // The Milky Way's, in the render frame as the sphere's texture coordinates run (skyUv).
      if (row === 0) pole = (milkyWayAlong(0, Math.PI / 2) + milkyWayAlong(0, -Math.PI / 2)) / 2;
      const theta = Math.PI * (1 - (row + 0.5) / MILKY.height);
      for (let i = 0; i < MILKY.width; i += 1) {
        const phi = ((i + 0.5) / MILKY.width) * 2 * Math.PI;
        // Render frame (x, y, z) to the ecliptic (x, -z, y), to the equator, to the Galaxy.
        const ex = -Math.cos(phi) * Math.sin(theta);
        const ey = -Math.sin(phi) * Math.sin(theta);
        const ez = Math.cos(theta);
        const q = [ex, ey * c - ez * s, ey * s + ez * c];
        const g = EQ_TO_GAL.map((r) => r[0] * (q[0] ?? 0) + r[1] * (q[1] ?? 0) + r[2] * (q[2] ?? 0));
        const v = encode((milkyWayAlong(Math.atan2(g[1] ?? 0, g[0] ?? 1), Math.asin(Math.min(1, Math.max(-1, g[2] ?? 0)))) / pole) * POLES_S10);
        milky.set([v, v, v, 255], (row * MILKY.width + i) * 4);
      }
    } else {
      // The zodiacal light's, elongation in longitude 0..180 by |ecliptic latitude| 0..90.
      const j = row - MILKY.height;
      if (j === 0) at90 = zodiacalAlong(Math.PI / 2, 0);
      const beta = ((j + 0.5) / ZODI.height) * (Math.PI / 2);
      for (let i = 0; i < ZODI.width; i += 1) {
        const v = encode((zodiacalAlong(((i + 0.5) / ZODI.width) * Math.PI, beta) / at90) * ZODI_90_S10);
        zodi.set([v, v, v, 255], (j * ZODI.width + i) * 4);
      }
    }
    filled += 1;
  };
  let ready = 0;
  let enabled = true;
  const table = (data: Uint8Array, width: number, height: number, wrap: boolean): DataTexture => {
    const t = new DataTexture(data, width, height, RGBAFormat);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    if (wrap) t.wrapS = RepeatWrapping;
    return t;
  };
  const milkyTexture = table(milky, MILKY.width, MILKY.height, true);
  const zodiTexture = table(zodi, ZODI.width, ZODI.height, false);

  /** The Sun's direction from the camera (render frame). */
  const sun = new Vector3(1, 0, 0);
  const uSunU = uniform(0);
  const uZodi = uniform(0);
  const uLight = uniform(0);
  const decode = (v: Node<'float'>): Node<'float'> => exp(v.mul((LOG_RANGE[1] - LOG_RANGE[0]) * Math.LN10).add(LOG_RANGE[0] * Math.LN10));
  // The Milky Way, straight from the sphere's texture coordinates; the zodiacal light by the angle from
  // the Sun's longitude along them (u is the ecliptic longitude less half a turn) and |latitude| (v).
  const at = uv();
  const milkyS10 = decode(texture(milkyTexture, at).r);
  const along = max(abs(fract(at.x.sub(uSunU).add(0.5)).sub(0.5)).mul(2), ZODI_HELD_DEG / 180);
  const zodiS10 = decode(texture(zodiTexture, vec2(along, abs(at.y.mul(2).sub(1)))).r);
  const s10 = milkyS10.add(zodiS10.mul(uZodi));
  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false });
  // Both in the warm white of old stars and of sunlight (display terms).
  material.colorNode = vec3(...GLOW_COLOUR).mul(max(s10, 0)).mul(uLight);
  material.opacityNode = float(1);
  const geometry = new SphereGeometry(1, SEGMENTS[0], SEGMENTS[1]);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'explore-sky-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;

  /** The glow's S10 in a render-frame direction, as the shader has it (nearest texels; for seen()). */
  const scratch = [0, 0];
  const s10At = (x: number, y: number, z: number): number => {
    const [u = 0, v = 0] = skyUv(x, y, z, scratch);
    const m = decodeCpu(milky[(Math.min(MILKY.height - 1, Math.floor(v * MILKY.height)) * MILKY.width + Math.min(MILKY.width - 1, Math.floor(u * MILKY.width))) * 4] ?? 0);
    const a = Math.max(Math.abs(u - uSunU.value + 0.5 - Math.floor(u - uSunU.value + 0.5) - 0.5) * 2, ZODI_HELD_DEG / 180);
    const zv = decodeCpu(zodi[(Math.min(ZODI.height - 1, Math.floor(Math.abs(v * 2 - 1) * ZODI.height)) * ZODI.width + Math.min(ZODI.width - 1, Math.floor(a * ZODI.width))) * 4] ?? 0);
    return m + zv * uZodi.value;
  };
  const corner = new Vector3();
  let exposure = 1;

  return {
    object: mesh,
    update(frame) {
      if (filled < rows) {
        const start = performance.now();
        do fillRow();
        while (filled < rows && performance.now() - start < FILL_MS);
        if (filled >= rows) {
          milkyTexture.needsUpdate = true;
          zodiTexture.needsUpdate = true;
        }
      } else ready += (1 - ready) * (frame.dt > 0 ? 1 - Math.exp(-frame.dt / READY_SECONDS) : 0);
      const shown = enabled ? frame.shown * ready : 0;
      mesh.scale.setScalar(frame.radius);
      mesh.visible = shown > 1e-3;
      const d = Math.hypot(frame.cameraKm.x, frame.cameraKm.y, frame.cameraKm.z) || 1;
      sun.set(-frame.cameraKm.x / d, -frame.cameraKm.y / d, -frame.cameraKm.z / d);
      uSunU.value = skyUv(sun.x, sun.y, sun.z, scratch)[0] ?? 0;
      uZodi.value = zodiacalScale(frame.au);
      uLight.value = S10_LIGHT * frame.pixelDeg2 * frame.light * shown;
      exposure = frame.compensation;
    },
    setEnabled(on) {
      enabled = on;
    },
    seen(view) {
      if (!mesh.visible) return false;
      // The brightest of a few directions across the view (its middle, edges and corners), on screen.
      let most = 0;
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          corner.set(i * 0.9, j * 0.9, 0.5).unproject(view).sub(view.position);
          most = Math.max(most, s10At(corner.x, corner.y, corner.z));
        }
      }
      return most * uLight.value * exposure > SEEN_LIGHT;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      milkyTexture.dispose();
      zodiTexture.dispose();
    },
  };
}
