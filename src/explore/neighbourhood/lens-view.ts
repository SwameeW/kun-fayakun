import { BackSide, CubeCamera, CubeRenderTarget, DataTexture, FloatType, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicNodeMaterial, NoBlending, RGBAFormat, SphereGeometry, Vector3, type Node, type Scene, type WebGPURenderer } from 'three/webgpu';
import { abs, atan, Break, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, cos, cross, cubeTexture, Discard, dot, exp, float, Fn, fwidth, If, int, length, log2, Loop, max, mix, normalize, positionWorld, pow, select, sin, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4, viewportSharedTexture, viewportSize } from 'three/tsl';
import { blackbodyRgb } from '../../chapters/shared/blackbody';
import { CRITICAL_B, GAUSS, TRACE } from './lens';

/**
 * A black hole drawn by its light bending (docs/NEIGHBOURHOOD.md, "Black holes"; its own chunk,
 * loaded the first time the camera comes near one): a sphere round the camera whose every pixel
 * traces its ray back past the hole by ./lens's steps (the same equation and steps, here on the GPU),
 * to the horizon (black: the shadow) or out to the direction its light came from. That light is the
 * sky's glow behind (the band, the Milky Way's model, the galaxies, as drawn this frame) where that
 * direction is on the screen and not squeezed, else a capture of the glow round the camera (taken on
 * arriving, its blur matched to how much the lens squeezes it), the two blended near the screen's
 * edge. The stars are not in either: each is bent in its own vertex stage (./field), a sharp point at
 * the screen's resolution, drawn after this with its secondary image; where the gas is opaque this
 * writes the nearest depth, so a star behind the disc is hidden.
 *
 * Where the hole has gas, the ray's crossings of its disc's plane add its light: a thin disc (from the
 * innermost stable orbit, 3 r_s, out) whose temperature falls as Shakura and Sunyaev's, or a hot thin
 * ring near the photon sphere, each shifted by the gas's motion and the hole's pull (g, ./lens). A
 * disc's light is a blackbody's: since I_nu / nu^3 is kept along a ray, what reaches the camera is the
 * spectrum of a blackbody at g T, so it is drawn in that temperature's colour and as bright as that
 * blackbody at the middle of the visible (550 nm); the ring's brightened as g^3. Their temperatures
 * and extents are illustrative (a supermassive hole's disc cooler and wider than a stellar one's, as
 * such discs are), the bending computed.
 */

/** Steps by tier (a step is pi/40 of a turn round the hole); the sky's capture (px a face). */
export const LENS_DETAIL = { high: TRACE.steps, medium: 140, low: 100, capturePx: 512 } as const;
/**
 * A thin disc's display (illustrative): its temperature at its hottest (K), its outer edge (r_s), and
 * its light where it is hottest, seen face on (under the bloom's threshold of 0.75; the side coming
 * toward the camera, hotter seen, brighter). A supermassive hole's disc is cooler and wider than a
 * stellar one's (a disc's temperature falls as its hole's mass to the -1/4).
 */
const DISC = { supermassive: { kelvin: 12_000, outer: 22, light: 0.4 }, stellar: { kelvin: 20_000, outer: 12, light: 0.35 } } as const;
/** A disc's streaks turn once round its inner edge in this many seconds (illustrative: its real orbits there take a fraction of a millisecond round a stellar hole, about a year round TON 618). */
const DISC_TURN_S = 40;
/** hc / (k 550 nm): a blackbody's light at 550 nm goes as 1 / (exp(VISIBLE_K / T) - 1). */
const VISIBLE_K = 26_160;
const visible = (kelvin: number): number => 1 / Math.expm1(VISIBLE_K / kelvin);

export interface LensView {
  readonly mesh: Mesh;
  /**
   * This frame: the camera's place from the hole in its Schwarzschild radii (render frame), the gas's
   * model and axis, the screen's angle per device pixel, how many steps to trace, and the seconds a
   * disc's streaks have turned for (DISC_TURN_S a turn; held still under reduced motion).
   */
  update(camera: readonly [number, number, number], kind: 'supermassive' | 'stellar', model: 'thin-disc' | 'hot-ring' | 'dormant', axis: readonly [number, number, number], pixelAngle: number, steps: number, seconds: number): void;
  /** Captures the sky's glow round the camera (the lens and the stars hidden) for the light from off the screen. */
  capture(renderer: WebGPURenderer, scene: Scene): void;
  /** Forgets the capture (another hole's sky), until the next. */
  forget(): void;
  dispose(): void;
}

/** Blackbody colours from 1,000 to 40,000 K (log-spaced), for the gas. */
function colourTable(): DataTexture {
  const n = 64;
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const k = 1000 * 40 ** (i / (n - 1));
    data.set([...blackbodyRgb(k), 1], i * 4);
  }
  const t = new DataTexture(data, n, 1, RGBAFormat, FloatType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function createLensView(): LensView {
  const uCam = uniform(new Vector3(0, 0, 20));
  const uR0 = uniform(20);
  const uAxis = uniform(new Vector3(0, 1, 0));
  const uModel = uniform(0, 'int');
  const uSteps = uniform(LENS_DETAIL.high, 'int');
  const uPixel = uniform(0.001);
  const uTexel = uniform(Math.PI / 2 / LENS_DETAIL.capturePx);
  const uHasCapture = uniform(0);
  /** Bent by under half a pixel past this impact parameter (r_s): left as it is. */
  const uSkipB = uniform(1e9);
  const target = new CubeRenderTarget(LENS_DETAIL.capturePx, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter });
  const cubeCamera = new CubeCamera(1e-9, 1e13, target);
  const colours = colourTable();
  const uDiscKelvin = uniform(DISC.supermassive.kelvin);
  const uDiscOuter = uniform(DISC.supermassive.outer);
  /** The disc's plane (two axes in it) and how far round its streaks have turned at its inner edge (rad). */
  const uE1 = uniform(new Vector3(1, 0, 0));
  const uE2 = uniform(new Vector3(0, 0, 1));
  const uSpin = uniform(0);
  /** The disc's light at its hottest over a blackbody's at 550 nm there. */
  const uDiscLight = uniform(DISC.supermassive.light / visible(DISC.supermassive.kelvin));

  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: true, depthTest: false, transparent: true, blending: NoBlending, fog: false });
  const traced = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const er = uCam.div(uR0);
    const radial = dot(d, er);
    const across = d.sub(er.mul(radial));
    const la = length(across);
    const b = la.mul(uR0).div(sqrt(float(1).sub(float(1).div(uR0))));
    // How fast the ray's way out turns across a pixel (rad): steep near the shadow's edge, where the
    // sky behind is squeezed into the photon ring (worked out before any branch: derivatives need it).
    const turn = float(1).div(max(b.sub(CRITICAL_B), 1e-5)).mul(pow(float(CRITICAL_B).div(max(b, CRITICAL_B)), 2));
    const spread = fwidth(b).mul(turn).add(uPixel);
    const detail = smoothstep(3, 1, spread.div(uPixel));
    If(b.greaterThan(uSkipB), () => {
      Discard();
    });
    const et = across.div(max(la, 1e-12));
    const u = float(1).div(uR0).toVar();
    const inward = radial.lessThan(0).select(float(1), float(-1));
    const du = inward.mul(sqrt(max(float(1).div(b.mul(b)).sub(u.mul(u)).add(u.mul(u).mul(u)), 0))).toVar();
    const phi = float(0).toVar();
    const end = float(-1).toVar();
    // Where the ray's plane meets the disc's: at nextCross, then every half turn.
    const A = dot(er, uAxis);
    const B = dot(et, uAxis);
    const nextCross = atan(A.negate(), B).toVar();
    If(nextCross.lessThanEqual(1e-6), () => {
      nextCross.addAssign(Math.PI);
    });
    const gas = vec3(0).toVar();
    const opaque = float(0).toVar();
    // The light's angular momentum about the disc's axis (per unit energy), and the camera's own shift.
    const lambda = b.negate().mul(dot(cross(er, et), uAxis));
    const seen = float(1).div(sqrt(float(1).sub(float(1).div(uR0))));
    const h = float(TRACE.dPhi);
    const curve = (x: Node<'float'>): Node<'float'> => x.negate().add(x.mul(x).mul(1.5));
    Loop({ start: int(0), end: uSteps }, () => {
      const k1u = du;
      const k1v = curve(u);
      const k2u = du.add(h.mul(0.5).mul(k1v));
      const k2v = curve(u.add(h.mul(0.5).mul(k1u)));
      const k3u = du.add(h.mul(0.5).mul(k2v));
      const k3v = curve(u.add(h.mul(0.5).mul(k2u)));
      const k4u = du.add(h.mul(k3v));
      const k4v = curve(u.add(h.mul(k3u)));
      const nu = u.add(h.div(6).mul(k1u.add(k2u.mul(2)).add(k3u.mul(2)).add(k4u))).toVar();
      const ndu = du.add(h.div(6).mul(k1v.add(k2v.mul(2)).add(k3v.mul(2)).add(k4v))).toVar();
      If(nextCross.lessThanEqual(phi.add(h)).and(uModel.greaterThan(int(0))).and(opaque.lessThan(1)), () => {
        // u where the plane is crossed, by a cubic through the step's ends.
        const s = nextCross.sub(phi).div(h);
        const s2 = s.mul(s);
        const s3 = s2.mul(s);
        const uc = s3.mul(2).sub(s2.mul(3)).add(1).mul(u).add(s3.sub(s2.mul(2)).add(s).mul(h).mul(du)).add(s3.mul(-2).add(s2.mul(3)).mul(nu)).add(s3.sub(s2).mul(h).mul(ndu));
        const r = float(1).div(max(uc, 1e-6));
        If(uc.greaterThan(0).and(uc.lessThan(0.66)), () => {
          const omega = sqrt(float(0.5).div(r.mul(r).mul(r)));
          const g = sqrt(float(1).sub(float(1.5).div(r))).div(float(1).sub(omega.mul(lambda))).mul(seen);
          If(uModel.equal(int(1)), () => {
            // A thin disc from 3 r_s out, opaque: its temperature by Shakura and Sunyaev's law, its outer edge sharp.
            If(r.greaterThan(3).and(r.lessThan(uDiscOuter)), () => {
              const t = pow(pow(r, -3).mul(float(1).sub(sqrt(float(3).div(r)))), 0.25).div(0.21403);
              const kelvin = g.mul(t).mul(uDiscKelvin);
              const tint = texture(colours, vec2(log2(kelvin.div(1000).clamp(1, 40)).div(Math.log2(40)), 0.5)).rgb;
              const edge = smoothstep(uDiscOuter, uDiscOuter.mul(0.92), r);
              // Streaks of hotter and cooler gas (illustrative), wound by the disc's own turning (the inner faster, as
              // Kepler's), softened where the lens squeezes them under a pixel.
              const at = er.mul(cos(nextCross)).add(et.mul(sin(nextCross)));
              const w = atan(dot(at, uE2), dot(at, uE1)).sub(uSpin.mul(pow(float(3).div(r), 1.5)));
              const lr = log2(r).mul(Math.LN2);
              const streaks = float(1).add(sin(w.mul(5).add(lr.mul(21))).mul(0.16).add(sin(w.mul(11).sub(lr.mul(37))).mul(0.1)).add(sin(lr.mul(47)).mul(0.08)).mul(detail));
              // A blackbody's at the shifted temperature, at 550 nm, in its colour; front to back (the nearer crossing hides the farther).
              const seenShare = float(1).sub(opaque).mul(edge);
              const light = float(1).div(exp(float(VISIBLE_K).div(kelvin.max(500))).sub(1));
              gas.addAssign(tint.mul(light).mul(uDiscLight).mul(streaks).mul(seenShare));
              opaque.addAssign(seenShare);
            });
          }).Else(() => {
            // A hot, thin ring round the photon sphere (as the Event Horizon Telescope's images show): its light adds at every crossing.
            const ring = exp(r.sub(2.6).div(0.9).pow(2).negate());
            gas.addAssign(vec3(1, 0.62, 0.28).mul(ring).mul(pow(g, 3)).mul(0.9));
          });
        });
        nextCross.addAssign(Math.PI);
      });
      If(nu.greaterThanEqual(1), () => {
        Break();
      });
      If(nu.lessThanEqual(0), () => {
        // Out: the rest of the way from this step's start, by the integral of du / sqrt(1/b^2 - u^2 + u^3) (four Gauss points, as ../lens).
        const inv = float(1).div(b.mul(b));
        const tail = GAUSS.nodes.map((n, k) => {
          const x = u.mul(n);
          return float(GAUSS.weights[k] ?? 0).div(sqrt(max(inv.sub(x.mul(x)).add(x.mul(x).mul(x)), 1e-12)));
        });
        end.assign(phi.add(tail.reduce((a, t) => a.add(t)).mul(u)));
        Break();
      });
      u.assign(nu);
      du.assign(ndu);
      phi.addAssign(h);
    });
    // The light from behind: the picture where its direction is on the screen and not squeezed, else the capture.
    const out = er.mul(cos(end)).add(et.mul(sin(end)));
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(out, 0)));
    const ndc = clip.xy.div(max(clip.w, 1e-6));
    // The picture where its direction is on the screen, handing over to the capture as the lens squeezes it (between 1.5 and 3.5 pixels a pixel) and toward the screen's edge.
    const share = clip.w.greaterThan(0).select(smoothstep(3.5, 1.5, spread.div(uPixel)).mul(smoothstep(0.99, 0.85, max(abs(ndc.x), abs(ndc.y)))), float(0));
    // (At the middle of its pixel: a star bent by a pixel or so moves whole, not smeared over four.)
    const picture = viewportSharedTexture(vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))).mul(viewportSize).floor().add(0.5).div(viewportSize)).level(float(0)).rgb;
    const level = log2(spread.div(uTexel)).clamp(0, 9);
    const sky = cubeTexture(target.texture, out, level).rgb.mul(uHasCapture);
    const behind = select(end.lessThan(0), vec3(0), mix(sky, picture, share));
    return vec4(behind.mul(float(1).sub(opaque)).add(gas), opaque);
  })().toVar();
  material.colorNode = vec4(traced.rgb, 1);
  // The disc's gas in front of what is behind it: the nearest depth there (the stars after it are hidden), the farthest elsewhere.
  material.depthNode = traced.a.greaterThan(0.5).select(float(0), float(1));
  const mesh = new Mesh(new SphereGeometry(1e6, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.name = 'explore-neighbourhood-lens';
  mesh.visible = false;

  return {
    mesh,
    update(camera, kind, model, axis, pixelAngle, steps, seconds) {
      const r = Math.max(1.0001, Math.hypot(camera[0], camera[1], camera[2]));
      uCam.value.set(camera[0], camera[1], camera[2]);
      uR0.value = r;
      uAxis.value.set(axis[0], axis[1], axis[2]).normalize();
      uE1.value.set(1, 0, 0).cross(uAxis.value);
      if (uE1.value.lengthSq() < 1e-6) uE1.value.set(0, 1, 0).cross(uAxis.value);
      uE1.value.normalize();
      uE2.value.copy(uAxis.value).cross(uE1.value);
      uSpin.value = (2 * Math.PI * seconds) / DISC_TURN_S;
      uModel.value = model === 'thin-disc' ? 1 : model === 'hot-ring' ? 2 : 0;
      uPixel.value = pixelAngle;
      uSteps.value = Math.round(steps);
      const disc = DISC[kind];
      uDiscKelvin.value = disc.kelvin;
      uDiscOuter.value = disc.outer;
      uDiscLight.value = disc.light / visible(disc.kelvin);
      // Past the impact parameter bending a ray by under half a pixel (2 / b < pixel / 2), and with no gas out there, the picture stands.
      uSkipB.value = Math.max(4 / Math.max(pixelAngle, 1e-9), model === 'dormant' ? 0 : 40);
      mesh.visible = true;
    },
    capture(renderer, scene) {
      mesh.visible = false;
      cubeCamera.position.set(0, 0, 0);
      cubeCamera.updateMatrixWorld();
      cubeCamera.update(renderer, scene);
      uHasCapture.value = 1;
    },
    forget() {
      uHasCapture.value = 0;
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      target.dispose();
      colours.dispose();
    },
  };
}

/** The steps for a tier's detail. */
export const lensSteps = (tier: 'ultra' | 'high' | 'medium' | 'low'): number => (tier === 'low' ? LENS_DETAIL.low : tier === 'medium' ? LENS_DETAIL.medium : LENS_DETAIL.high);

