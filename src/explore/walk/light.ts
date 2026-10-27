/**
 * The light on foot, on the CPU (docs/WALKING.md, "Light and depth"): what reaches the ground and the
 * eye from the Sun and the sky, by the Sun's height, on each world, and the exposure the eye adapts to.
 * The shaders (./ground, ./sky) draw the same light per pixel; these numbers meter it and tint the Sun.
 *
 * - **The Earth.** The explorer's own air (../render/air: Bruneton's reference atmosphere, every
 *   constant cited in data/constants.json): sunlight through the slant path from the walker's height
 *   (Rayleigh, aerosols and ozone, the planet's curve, the Sun's disc setting over its angular radius),
 *   so the setting Sun reddens and dims as the air takes its blue; and the sky's light on the ground,
 *   the globe's own estimate (half the air's scattered sunlight comes down, bluish: ../bodies/earth).
 * - **Mars** (illustrative: no radiative transfer of its dust): a dust column of optical depth about
 *   0.6, darker in the blue (the dust absorbs it), across Kasten and Young's air mass, and a bright
 *   butterscotch sky's light (the dust scatters much of the sunlight down).
 * - **Venus**: no beam reaches the ground; all its light is the overcast's, by the Sun's height.
 * - **The Moon and Mercury**: no air. Sunlight unfiltered (setting over the Sun's disc), no sky's light;
 *   only a faint fill from the sunlit ground around (illustrative).
 *
 * The eye's adaptation: the exposure is the illuminance on level ground (Sun and sky together) to the
 * power -EXPOSURE.adapt, between EXPOSURE.min and EXPOSURE.max (2^-3 and 2^6): a day's ground sits
 * near middle grey at any Sun height, a little darker as it sinks (the eye adapts almost, not wholly),
 * the sky keeps its brightness about the ground's, and night stays night (the exposure stops opening,
 * so the stars and the dark land show as dark); a world darker than middle grey is opened up by its
 * albedo (ALBEDO_KEY), as a camera metering its ground would. Units are the explorer's: sunlight on a
 * white surface facing the Sun at 1 au is 1. The ground's albedo is its globe's colour (the Moon's,
 * Mars's and Mercury's scaled to their measured Bond albedos: ./index).
 */

import type { AirModel } from '../render/air';

/** The world's light on foot: whose air (or none). */
export type LightKind = 'earth' | 'mars' | 'venus' | 'airless';

/** Rec. 709 luminance of linear RGB. */
export const luminance = (c: readonly [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The eye's adaptation: exposure = E^-adapt for illuminance E on level ground (sunlight 1 at 1 au on a
 * surface facing it), between `min` and `max` (2^-3 and 2^6). E never counts below `floorE` (a
 * moonless night's ground under the stars and the airglow, illustrative).
 */
export const EXPOSURE = { adapt: 0.85, min: 0.125, max: 64, floorE: 0.002 } as const;

/** Mars's dust (illustrative): vertical optical depth in red, green and blue, the sky's colour, and the sunlight's own tint. */
export const MARS_DUST = { tau: [0.5, 0.62, 0.82], sky: [1, 0.72, 0.48], sun: [1, 0.93, 0.85] } as const;
/** Venus's overcast light on the ground at full day (Sun 6 degrees up and more), as the sky's fill (illustrative). */
export const VENUS_FILL = [0.56, 0.37, 0.18] as const;
/** On an airless world, the fill from the sunlit ground around (a share of the level ground's sunlight), and the night's floor (illustrative). */
export const AIRLESS_FILL = { bounce: 0.1, floor: 0.0015 } as const;
/** The sky's light on the Earth's ground through the night, after the twilight (starlight and airglow, illustrative). */
export const NIGHT_SKY = [0.0012, 0.0016, 0.0026] as const;

/** Kasten and Young's (1989) relative air mass for a Sun this high (sine of its elevation), finite at the horizon. */
export function airMass(sinElevation: number): number {
  const h = (Math.asin(Math.max(-1, Math.min(1, sinElevation))) * 180) / Math.PI;
  if (h <= -1) return 40;
  return 1 / (Math.max(sinElevation, 0) + 0.50572 * Math.max(h + 6.07995, 1e-3) ** -1.6364);
}

/**
 * Sunlight through the Earth's air to a point `heightRadii` above the ground (r, g, b; 1 above the
 * air): the slant column marched to the top of the air (denser steps near the eye), the planet's curve
 * included; none once the Sun's disc has set behind the ground's horizon from there.
 */
export function sunThroughAir(air: AirModel, heightRadii: number, sinElevation: number, steps = 64): [number, number, number] {
  const r0 = 1 + Math.max(0, heightRadii);
  const horizon = -Math.sqrt(Math.max(0, 1 - 1 / (r0 * r0)));
  const visible = smoothstep(horizon - air.sunAngularRadius, horizon + air.sunAngularRadius, sinElevation);
  if (visible <= 0) return [0, 0, 0];
  const mu = Math.max(sinElevation, horizon);
  const length = -r0 * mu + Math.sqrt(Math.max(0, r0 * r0 * (mu * mu - 1) + air.top * air.top));
  let rayleigh = 0;
  let mie = 0;
  let ozone = 0;
  for (let i = 0; i < steps; i += 1) {
    const t = length * ((i + 0.5) / steps) ** 2;
    const dt = (length * (2 * i + 1)) / (steps * steps);
    const h = Math.sqrt(t * t + 2 * r0 * mu * t + r0 * r0) - 1;
    rayleigh += Math.exp(-h / air.rayleighScale) * dt;
    mie += Math.exp(-h / air.mieScale) * dt;
    ozone += Math.max(0, 1 - Math.abs(h - air.ozonePeak) / air.ozoneHalfWidth) * dt;
  }
  return [0, 1, 2].map((k) => Math.exp(-((air.rayleigh[k] ?? 0) * rayleigh + air.mieExtinction * mie + (air.ozone[k] ?? 0) * ozone)) * visible) as [number, number, number];
}

/** The sky's light on level ground (the globe's estimate: half the vertical column's scattered sunlight comes down), fading through twilight to the night's. */
export function earthSkyLight(air: AirModel, sinElevation: number): [number, number, number] {
  const day = Math.min(1, Math.max(0, sinElevation + 0.1));
  return [0, 1, 2].map((k) => (1 - Math.exp(-(air.verticalDepth[k] ?? 0))) * 0.5 * day + (NIGHT_SKY[k] ?? 0)) as [number, number, number];
}

/** Sunlight through Mars's dust (illustrative), setting over the Sun's disc there (about 0.18 degrees in radius). */
export function marsSunlight(sinElevation: number): [number, number, number] {
  const m = airMass(sinElevation);
  const set = smoothstep(-0.003, 0.003, sinElevation);
  return [0, 1, 2].map((k) => (MARS_DUST.sun[k] ?? 1) * Math.exp(-(MARS_DUST.tau[k] ?? 0) * m) * set) as [number, number, number];
}

/** Mars's sky's light on level ground (illustrative): the share of sunlight its dust scatters down, through the twilight. */
export function marsSkyLight(sinElevation: number): [number, number, number] {
  const day = Math.min(1, Math.max(0, sinElevation + 0.12));
  return [0, 1, 2].map((k) => (1 - Math.exp(-(MARS_DUST.tau[k] ?? 0))) * 0.55 * day * (MARS_DUST.sky[k] ?? 1)) as [number, number, number];
}

/** Venus's day under its clouds: full from 6 degrees up, gone 12 degrees down. */
export const venusDay = (sunDeg: number): number => Math.min(1, Math.max(0, (sunDeg + 12) / 18));

/**
 * Illuminance on level ground (luminance, sunlight 1 at 1 au on a surface facing it times `light`),
 * Sun and sky together, for a Sun this high: what the eye adapts to. `air` is the Earth's model.
 */
export function groundIlluminance(kind: LightKind, sunDeg: number, light: number, air: AirModel | null, heightRadii = 0): number {
  const s = Math.sin((sunDeg * Math.PI) / 180);
  let e: number;
  if (kind === 'earth' && air) e = luminance(sunThroughAir(air, heightRadii, s, 32)) * Math.max(s, 0) + luminance(earthSkyLight(air, s));
  else if (kind === 'mars') e = luminance(marsSunlight(s)) * Math.max(s, 0) + luminance(marsSkyLight(s));
  else if (kind === 'venus') e = luminance(VENUS_FILL) * venusDay(sunDeg);
  else e = Math.max(s, 0) * smoothstep(-0.005, 0.005, s) * (1 + AIRLESS_FILL.bounce) + AIRLESS_FILL.floor;
  return e * light;
}

/**
 * The eye's exposure for an illuminance on level ground (EXPOSURE), and the ground's albedo where it is
 * known (a world's colour map's mean: its darker ground opened up, as a camera metering the scene
 * would, but only partly (ALBEDO_KEY), so a dark world still looks darker than a bright one).
 */
export function walkExposure(illuminance: number, albedo: number | null = null): number {
  if (Number.isNaN(illuminance)) return 1;
  const e = Math.max(illuminance, EXPOSURE.floorE);
  const key = albedo && albedo > 0 ? Math.min(ALBEDO_KEY.most, Math.max(1, (ALBEDO_KEY.reference / albedo) ** ALBEDO_KEY.power)) : 1;
  return Math.min(EXPOSURE.max * key, Math.max(EXPOSURE.min, e ** -EXPOSURE.adapt * key));
}

/** A camera's metering for a dark world: grey of this reflectance taken as the reference, and the most it opens for a darker ground, to this power of the ratio. */
export const ALBEDO_KEY = { reference: 0.18, power: 1, most: 3 } as const;

/**
 * Light scattered toward an eye inside the Earth's air along a ray (the CPU twin of ./sky's and
 * ./ground's march, for the tests and for tuning): single scattering by Rayleigh's and the aerosols'
 * phases, each sample lit by the sunlight that reaches it (sunThroughAir), dimmed by the air between it
 * and the eye; plus the light scattered more than once, as each sample's share of the light around it
 * (half from the ground below, `GROUND_ALBEDO` of what falls on it, half from the sky above:
 * earthSkyLight), scattered isotropically. The eye at `heightRadii` with the zenith along +z, the Sun in
 * the x-z plane at `sunSin`; the ray (unit) toward (x, y, z). Before the sunlight's strength (1 at 1
 * au). `steps` samples, denser near the eye.
 */
export function skyRadiance(air: AirModel, heightRadii: number, sunSin: number, ray: readonly [number, number, number], steps = 24): [number, number, number] {
  const r0 = 1 + heightRadii;
  const sun: [number, number, number] = [Math.sqrt(Math.max(0, 1 - sunSin * sunSin)), 0, sunSin];
  const b = r0 * ray[2];
  const c = r0 * r0;
  const top = -b + Math.sqrt(Math.max(0, b * b - c + air.top * air.top));
  const ground = b * b - c + 1;
  const tGround = -b - Math.sqrt(Math.max(0, ground));
  const end = ground > 0 && tGround > 0 ? tGround : top;
  const column = [0, 0, 0];
  const sumR = [0, 0, 0];
  const sumM = [0, 0, 0];
  const sumMs = [0, 0, 0];
  for (let i = 0; i < steps; i += 1) {
    const t = end * ((i + 0.5) / steps) ** 2;
    const dt = (end * (2 * i + 1)) / (steps * steps);
    const q = [ray[0] * t, ray[1] * t, r0 + ray[2] * t];
    const r = Math.hypot(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0);
    const h = r - 1;
    const dR = Math.exp(-h / air.rayleighScale);
    const dM = Math.exp(-h / air.mieScale);
    const dO = Math.max(0, 1 - Math.abs(h - air.ozonePeak) / air.ozoneHalfWidth);
    const muSun = ((q[0] ?? 0) * sun[0] + (q[2] ?? 0) * sun[2]) / r;
    const toSun = sunThroughAir(air, h, muSun, 24);
    const around = earthSkyLight(air, muSun);
    for (let k = 0; k < 3; k += 1) {
      const tau = (air.rayleigh[k] ?? 0) * (column[0] ?? 0) + air.mieExtinction * (column[1] ?? 0) + (air.ozone[k] ?? 0) * (column[2] ?? 0) + ((air.rayleigh[k] ?? 0) * dR + air.mieExtinction * dM + (air.ozone[k] ?? 0) * dO) * dt * 0.5;
      const toEye = Math.exp(-tau);
      sumR[k] = (sumR[k] ?? 0) + toEye * (toSun[k] ?? 0) * dt * dR;
      sumM[k] = (sumM[k] ?? 0) + toEye * (toSun[k] ?? 0) * dt * dM;
      const field = MULTIPLE * (0.5 * GROUND_ALBEDO * ((toSun[k] ?? 0) * Math.max(muSun, 0) + (around[k] ?? 0)) + 0.5 * (around[k] ?? 0));
      sumMs[k] = (sumMs[k] ?? 0) + toEye * dt * field * ((air.rayleigh[k] ?? 0) * dR + air.mieScattering * dM);
    }
    column[0] = (column[0] ?? 0) + dR * dt;
    column[1] = (column[1] ?? 0) + dM * dt;
    column[2] = (column[2] ?? 0) + dO * dt;
  }
  const cos = ray[0] * sun[0] + ray[2] * sun[2];
  const phaseR = (3 / 16) * (1 + cos * cos);
  const g = air.mieG;
  const phaseM = ((3 / 8) * ((1 - g * g) / (2 + g * g)) * (1 + cos * cos)) / Math.max(1e-4, 1 + g * g - 2 * g * cos) ** 1.5;
  return [0, 1, 2].map((k) => (sumR[k] ?? 0) * (air.rayleigh[k] ?? 0) * phaseR + (sumM[k] ?? 0) * air.mieScattering * phaseM + (sumMs[k] ?? 0)) as [number, number, number];
}

/** The ground's albedo the light scattered more than once sees below (typical land, illustrative). */
export const GROUND_ALBEDO = 0.15;
/**
 * The light scattered more than once, as a multiple of the field's estimate: the sky's mean radiance is
 * about twice the light it sheds on level ground suggests (the horizon's long paths are bright), and
 * the third and higher orders add more again (illustrative: about 2, as full multiple-scattering models
 * give for a clear sky's zenith).
 */
export const MULTIPLE = 2;

/**
 * A clear day's air on foot: the explorer's (Bruneton's reference, whose aerosols are those of an
 * exceptionally clean day: optical depth 0.005) with eight times its aerosols, about 0.04 at 550 nm,
 * a clear day's (illustrative; the view from orbit keeps the reference's). The aerosols are what light
 * the sky round the Sun and pale the horizon.
 */
export const CLEAR_DAY_AEROSOLS = 8;
export function clearDayAir(air: AirModel): AirModel {
  const k = CLEAR_DAY_AEROSOLS;
  const extra = air.mieExtinction * air.mieScale * (k - 1);
  return { ...air, mieExtinction: air.mieExtinction * k, mieScattering: air.mieScattering * k, verticalDepth: air.verticalDepth.map((t) => t + extra) as [number, number, number] };
}

/**
 * The sky's brightness held under the bloom's threshold on screen (display terms after the exposure):
 * above `knee` it rises ever more slowly toward `ceiling`, hue kept. Only the Sun's disc and its glare
 * then bloom; the sky round it never blows out to white. Returns the factor to scale the colour by.
 */
export const SKY_KNEE = { knee: 0.42, ceiling: 0.68 } as const;
export function skyCompression(displayLuminance: number): number {
  const l = displayLuminance;
  if (l <= SKY_KNEE.knee) return 1;
  const span = SKY_KNEE.ceiling - SKY_KNEE.knee;
  return (SKY_KNEE.knee + span * (1 - Math.exp(-(l - SKY_KNEE.knee) / span))) / l;
}
