/**
 * The sky's faint glows behind the stars, in the solar-system explorer: the Milky Way (the light of
 * its countless unresolved stars) and the zodiacal light with the gegenschein (sunlight scattered by
 * the dust in the planets' plane). Both are models, computed once when this chunk loads, and the
 * readout says so (UniverseIllustration 'sky-glow'): no all-sky photograph with a clear licence is
 * used (docs/EXPLORER-MECHANICS.md).
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
 *   1998), and seen from elsewhere brighter or fainter as r^-2.3 (the Helios and Pioneer measurements).
 *
 * Light: S10(V) is the light of one tenth-magnitude star per square degree; a square degree of glow
 * is given that star's light in proportion to the sky's naked-eye stars, spread over the pixels it
 * covers, and held in display terms with the stars.
 */

import { AdditiveBlending, BackSide, DataTexture, LinearFilter, Mesh, MeshBasicNodeMaterial, RepeatWrapping, RGBAFormat, SphereGeometry, Vector3, type Node } from 'three/webgpu';
import { abs, acos, asin, atan, clamp, dot, exp, float, max, normalize, positionLocal, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';

/** The textures' resolution (galactic longitude by latitude; elongation in longitude by ecliptic latitude). */
const MILKY = { width: 192, height: 96, steps: 72, reachKpc: 30 } as const;
const ZODI = { width: 64, height: 32, steps: 96, reachAu: 6 } as const;
/** Rows of the tables worked out a frame (about a millisecond's work). */
const ROWS_PER_FRAME = 4;
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
/** The zodiacal light's fall with the observer's distance from the Sun (au), and how close to the Sun's direction the table is trusted (degrees). */
const ZODI_POWER = 2.3;
const ZODI_NEAREST_DEG = 12;
/** J2000 equatorial to galactic (rows), the IAU's. */
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
] as const;

const encode = (s10: number): number => Math.round(Math.min(1, Math.max(0, (Math.log10(Math.max(s10, 1e-9)) - LOG_RANGE[0]) / (LOG_RANGE[1] - LOG_RANGE[0]))) * 255);

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

export interface SkyGlow {
  readonly object: Mesh;
  /**
   * Per frame: the sphere's radius (inside the far plane, behind the stars), the camera from the Sun
   * (render frame, km) and its distance in au, a pixel's solid angle (square degrees), the stars' light
   * (display terms), and how much shows (0 to 1).
   */
  update(radius: number, cameraKm: { x: number; y: number; z: number }, au: number, pixelDeg2: number, light: number, shown: number): void;
  dispose(): void;
}

export function createSkyGlow(obliquity: number): SkyGlow {
  // The Milky Way's table, galactic longitude -180..180 by latitude -90..90.
  // The tables are filled a few rows a frame (update), so working them out never holds a frame up;
  // the glow shows, eased in, once both are done.
  const milky = new Uint8Array(MILKY.width * MILKY.height * 4);
  const zodi = new Uint8Array(ZODI.width * ZODI.height * 4);
  let pole = 0;
  let at90 = 0;
  let filled = 0;
  const rows = MILKY.height + ZODI.height;
  const fillRow = (): void => {
    const row = filled;
    if (row < MILKY.height) {
      if (row === 0) pole = (milkyWayAlong(0, Math.PI / 2) + milkyWayAlong(0, -Math.PI / 2)) / 2;
      const b = ((row + 0.5) / MILKY.height - 0.5) * Math.PI;
      for (let i = 0; i < MILKY.width; i += 1) {
        const v = encode((milkyWayAlong(((i + 0.5) / MILKY.width - 0.5) * 2 * Math.PI, b) / pole) * POLES_S10);
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
  const table = (data: Uint8Array, width: number, height: number, wrap: boolean): DataTexture => {
    const t = new DataTexture(data, width, height, RGBAFormat);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    if (wrap) t.wrapS = RepeatWrapping;
    return t;
  };
  const milkyTexture = table(milky, MILKY.width, MILKY.height, true);
  const zodiTexture = table(zodi, ZODI.width, ZODI.height, false);

  const uSun = uniform(new Vector3(1, 0, 0));
  const uZodi = uniform(0);
  const uLight = uniform(0);
  const decode = (v: Node<'float'>): Node<'float'> => exp(v.mul((LOG_RANGE[1] - LOG_RANGE[0]) * Math.LN10).add(LOG_RANGE[0] * Math.LN10));
  // The direction from the camera (at the centre) in the render frame; to the ecliptic, the equator and the galaxy.
  const d = normalize(positionLocal);
  const ex = d.x;
  const ey = d.z.negate();
  const ez = d.y;
  const c = Math.cos(obliquity);
  const s = Math.sin(obliquity);
  const qx = ex;
  const qy = ey.mul(c).sub(ez.mul(s));
  const qz = ey.mul(s).add(ez.mul(c));
  const row = (r: readonly [number, number, number]): Node<'float'> => qx.mul(r[0]).add(qy.mul(r[1])).add(qz.mul(r[2]));
  const gx = row(EQ_TO_GAL[0]);
  const gy = row(EQ_TO_GAL[1]);
  const gz = row(EQ_TO_GAL[2]);
  const l = atan(gy, gx);
  const b = asin(clamp(gz, -1, 1));
  const milkyS10 = decode(texture(milkyTexture, vec2(l.div(2 * Math.PI).add(0.5), b.div(Math.PI).add(0.5))).r);
  // The zodiacal light: elongation in longitude from the Sun's direction (the ecliptic is the render frame's xz plane) and |latitude|.
  const beta = asin(clamp(d.y, -1, 1));
  const flat = normalize(vec3(d.x, 0, d.z).add(vec3(1e-6, 0, 0)));
  const sunFlat = normalize(vec3(uSun.x, 0, uSun.z).add(vec3(1e-6, 0, 0)));
  const dLambda = acos(clamp(dot(flat, sunFlat), -1, 1));
  const zodiS10 = decode(texture(zodiTexture, vec2(dLambda.div(Math.PI), abs(beta).div(Math.PI / 2))).r);
  // Not toward the Sun itself, where the table is not to be trusted (its glare is the Sun's own).
  const fromSun = acos(clamp(dot(d, uSun), -1, 1));
  const zodiShown = smoothstep(ZODI_NEAREST_DEG * (Math.PI / 180), ZODI_NEAREST_DEG * 2 * (Math.PI / 180), fromSun);
  const s10 = milkyS10.add(zodiS10.mul(uZodi).mul(zodiShown));
  const material = new MeshBasicNodeMaterial({ side: BackSide, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, fog: false });
  // Both in the warm white of old stars and of sunlight (display terms).
  material.colorNode = vec3(...GLOW_COLOUR).mul(max(s10, 0)).mul(uLight);
  material.opacityNode = float(1);
  const geometry = new SphereGeometry(1, 64, 32);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'explore-sky-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = -6;
  return {
    object: mesh,
    update(radius, cameraKm, au, pixelDeg2, light, shown) {
      if (filled < rows) {
        for (let k = 0; k < ROWS_PER_FRAME && filled < rows; k += 1) fillRow();
        if (filled >= rows) {
          milkyTexture.needsUpdate = true;
          zodiTexture.needsUpdate = true;
        }
      } else ready = Math.min(1, ready + 0.05);
      mesh.scale.setScalar(radius);
      mesh.visible = shown * ready > 1e-3;
      const d = Math.hypot(cameraKm.x, cameraKm.y, cameraKm.z) || 1;
      uSun.value.set(-cameraKm.x / d, -cameraKm.y / d, -cameraKm.z / d);
      uZodi.value = Math.max(au, 0.1) ** -ZODI_POWER;
      uLight.value = S10_LIGHT * pixelDeg2 * light * shown * ready;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      milkyTexture.dispose();
      zodiTexture.dispose();
    },
  };
}
