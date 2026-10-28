import { MathUtils, Vector3, type Data3DTexture, type Group, type PerspectiveCamera, type Sprite } from 'three/webgpu';
import type { DataStore, QualityTier } from '../../core/types';
import { createSunGlare, type SunGlare } from '../../explore/bodies/glare';
import { createSun, type ExploreSun } from '../../explore/bodies/sun';
import { DETAIL, type ExploreDetail } from '../../explore/detail';
import { blackbodyRgb } from './blackbody';

/**
 * The Sun for the film, drawn by the explorer's (../../explore/bodies/sun): the limb darkened by
 * the measured law (Allen's quadratic, data/constants.json) and reddened, a faint grain standing
 * for granules at their real size (far finer than a pixel at the film's scale), bright faculae
 * toward the limb, a crisp edge, and a ceiling on its brightness in display terms. Around it the
 * explorer's glare (../../explore/bodies/glare): a steep lens halo, a white-hot core and faint
 * diffraction spikes while it is small, so a distant Sun reads as a blinding point.
 *
 * It is shown in white light, the colour of its temperature's blackbody, never picked by eye (no
 * solar filter's amber, and none of the explorer's prominences or corona, which would need saying
 * how they are drawn). Seen small it is brilliant; as it grows to fill the view it is shown dimmer,
 * so its limb darkening reads, as a camera stopped down for the Sun would show it, and its glare
 * gives way to the disc's own light.
 */

/**
 * The disc's brightness at its centre, display terms: brilliant while small, and filling the view
 * at a level the tone curve compresses only a little (its limb darkening then reads). Between the
 * sizes (CSS px on a view whose shorter side is `refPx`, in proportion on any other) it passes from
 * one to the other; the glare fades by `filtered` of its strength over the same sizes. The glare is
 * shown at `glare` of the explorer's, so the orrery's inner orbits stay legible beside the Sun.
 */
const BRIGHTNESS = { small: 5, large: 1.6, fromPx: 12, toPx: 110, refPx: 800, filtered: 0.85, glare: 0.8 } as const;
/** The film's tiers onto the explorer's detail: its Medium (the disc's grain) on High and Mid, Low without. */
const DETAIL_FOR: Readonly<Record<QualityTier, ExploreDetail>> = { high: DETAIL.medium, mid: DETAIL.medium, low: DETAIL.low };
const MAIN_SEQUENCE_KELVIN = 5772;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface FilmSunFrame {
  time: number;
  kelvin: number;
  /** The Sun's light, 0 (dark) to 1 (shining in full): its disc and glare together. */
  light: number;
  /** How much of its glare shows, 0 to 1 (beyond the light: none while it is still forming). */
  glare: number;
  camera: PerspectiveCamera;
  /** The view's height and width, CSS px. */
  viewportPx: number;
  widthPx: number;
  /** The film's exposure now (the disc's ceiling is held in display terms). */
  exposure: number;
}

export interface FilmSun {
  /** The disc, a unit sphere scaled to `radius`: place it in the scene. */
  readonly object: Group;
  /** The glare, drawn around the camera: add it to an unscaled group at the scene's origin. */
  readonly glare: Sprite;
  update(frame: FilmSunFrame): void;
  setQuality(tier: QualityTier): void;
  dispose(): void;
}

export function createFilmSun(noise: Data3DTexture, radius: number, data: DataStore, tier: QualityTier): FilmSun {
  const limb = { a1: data.constant('sun.limbDarkening.a1').value, a2: data.constant('sun.limbDarkening.a2').value };
  const sun: ExploreSun = createSun(noise, limb, DETAIL_FOR[tier]);
  sun.object.scale.setScalar(radius);
  const white = blackbodyRgb(MAIN_SEQUENCE_KELVIN);
  const glare: SunGlare = createSunGlare(white);
  const centre = new Vector3();
  const toSun = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const tint: [number, number, number] = [1, 1, 1];
  const filter = [1, 1, 1] as const;

  return {
    object: sun.object,
    glare: glare.object,
    update(frame) {
      const { camera } = frame;
      sun.object.updateWorldMatrix(true, false);
      sun.object.getWorldPosition(centre);
      const drawnRadius = sun.object.matrixWorld.getMaxScaleOnAxis();
      toSun.copy(centre).sub(camera.position);
      const distance = Math.max(toSun.length(), 1e-9);
      const angular = Math.asin(Math.min(1, drawnRadius / distance));
      const radiusPx = (Math.tan(angular) / Math.tan(MathUtils.degToRad(camera.fov / 2))) * (frame.viewportPx / 2);
      const scale = Math.min(frame.viewportPx, frame.widthPx) / BRIGHTNESS.refPx;
      const large = smoothstep(BRIGHTNESS.fromPx * scale, BRIGHTNESS.toPx * scale, radiusPx);
      // Brilliant while small, dimmer as it fills the view (geometric between the two).
      const display = BRIGHTNESS.small * (BRIGHTNESS.large / BRIGHTNESS.small) ** large;
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      sun.update({
        time: frame.time,
        kelvin: frame.kelvin,
        light: display * frame.light,
        exposure: frame.exposure,
        filter,
        filtered: 0,
        radiusPx,
        right,
        up,
      });
      // The glare in the young star's colour as it warms toward the main sequence's.
      const own = blackbodyRgb(frame.kelvin);
      for (let i = 0; i < 3; i += 1) tint[i] = (own[i] ?? 1) / (white[i] ?? 1);
      glare.object.position.copy(camera.position);
      glare.update({
        position: toSun,
        drawnRadius,
        radiusPx,
        viewportPx: frame.viewportPx,
        visible: frame.light * frame.glare * BRIGHTNESS.glare,
        // The film's exposure dims the glare with everything else (the letter analysis's dim, the fades).
        compensation: 1,
        filtered: large * BRIGHTNESS.filtered,
        tint,
      });
    },
    setQuality(next) {
      sun.apply(DETAIL_FOR[next]);
    },
    dispose() {
      sun.dispose();
      glare.dispose();
    },
  };
}
