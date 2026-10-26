/**
 * Worlds that respond (ledger WR-2 to WR-6): each solid world's surface temperature by latitude,
 * through the year, from the light of every star in the experiment, so that a world moved, tilted or
 * given a thicker atmosphere warms or freezes, slowly, as its heat capacity has it.
 *
 * An energy balance model in the manner of North, Cahalan and Coakley (1981, Rev. Geophys. Space
 * Phys. 19, 91): eighteen latitude bands, each with a temperature T and a heat capacity C,
 *
 *   C dT/dt = Q (1 - albedo) - OLR(T) + D d/dx [(1 - x^2) dT/dx],   x = sin(latitude),
 *
 * where Q is the day's mean sunlight on the band (every star's, from its luminosity, distance and the
 * declination its direction makes with the world's equator: Berger 1978), OLR the heat the band sends
 * to space and D the transport of heat toward the poles by air and sea.
 * - The Earth: the paper's own model. OLR = A + B T (Budyko's empirical fit, T in degrees C: A = 203.3
 *   W/m^2, B = 2.09 W/m^2/C), D = 0.649 W/m^2/C, the albedo where it is ice free rising toward the
 *   poles (co-albedo 0.681 - 0.202 P2(sin latitude), their eq. 19: more cloud and a lower Sun there)
 *   and 0.62 where the year's temperature is below -10 C (the ice-albedo feedback that can freeze it
 *   over), and the heat capacity of its oceans' mixed layer (4.7 B years) and land (0.16 B years) in
 *   proportion. Its climates are several for the same light (an ice-free Earth, today's, a snowball),
 *   so it starts from today's: North's fit to the observed annual means, 15 C less 28 C P2(x).
 * - Other worlds: a grey atmosphere of infrared optical depth tau (Eddington's approximation:
 *   OLR = e sigma T^4 / (1 + 3 tau / 4); 0 for an airless world), tau chosen so that the world, at its
 *   distance and albedo today and with an even temperature, has its measured mean surface temperature
 *   (a parameterised greenhouse, labelled so); its fact sheet's Bond albedo; an illustrative heat
 *   capacity and transport (a thick atmosphere evens temperatures out, an airless world does not).
 * The day's mean light is used, as for a world that turns faster than its temperatures change; an
 * airless world's noon is hotter than its band's mean, and the interface gives its noon too. Steps are
 * implicit (backward Euler, the radiation linearised), so a world of small heat capacity cannot
 * oscillate. Nothing here moves water, makes clouds or winds (WR-4's inventories and WR-7 are later).
 */

/** Latitude bands, pole to pole, ten degrees each. */
export const BANDS = 18;
/** The Stefan-Boltzmann constant (CODATA 2018), W m^-2 K^-4. */
export const SIGMA = 5.670374419e-8;
/** The longest a climate step may be (s): a day of the experiment's clock. */
export const CLIMATE_STEP_S = 86_400;
/** Water's triple point (Pa, K) and the temperature at which it boils at one standard atmosphere (K): IAPWS. */
const WATER = { triplePa: 611.657, tripleK: 273.16, boilK: 373.124, standardPa: 101_325 } as const;
/** Budyko's ice line: below the year's -10 C the surface is taken as ice (North et al. 1981). */
const ICE_LINE_K = 263.15;

/** A world's climate as set (from data/constants.json for the explorer's worlds; a default for others). */
export interface ClimateSpec {
  /** 'budyko': the Earth's model (North et al. 1981); 'grey': a grey atmosphere of optical depth `tau`. */
  model: 'budyko' | 'grey';
  /**
   * The Bond albedo (for 'budyko', the ice-free mean), its rise toward the poles ('budyko': the
   * coefficient of P2(sin latitude), more cloud and a lower Sun there; North et al.'s eq. 19), and
   * where ice covers ('budyko' only).
   */
  albedo: number;
  albedoP2: number;
  iceAlbedo: number;
  /** Infrared optical depth ('grey'), and the surface's emissivity. */
  tau: number;
  emissivity: number;
  /** Budyko's A (W/m^2) and B (W/m^2/K) ('budyko'), and a greenhouse forcing the visitor added (W/m^2, taken from the heat sent to space). */
  a: number;
  b: number;
  forcing: number;
  /** Heat capacity (J m^-2 K^-1) and poleward transport (W m^-2 K^-1). */
  heatCapacity: number;
  diffusion: number;
  /** Ocean's share of the surface (where liquid water can lie), and the surface pressure (Pa). */
  ocean: number;
  pressurePa: number;
}

/** A world's climate now: its bands' temperatures (K), from the south pole to the north. */
export interface ClimateState {
  spec: ClimateSpec;
  t: number[];
}

/** A star's light: its luminosity (W) at a GM (km^3 s^-2), from which it follows its mass as a main-sequence star's would. */
export interface StarLight {
  watts: number;
  gm: number;
}

/** What the climate reads of the experiment: its bodies, its stars and the climates. */
interface Bodies {
  ids: string[];
  gm: number[];
  pos: number[];
  vel: number[];
  spin: number[];
  stars: Record<string, StarLight>;
  climate: Record<string, ClimateState>;
}

/** The Sun's GM (km^3 s^-2, DE440): a mass in solar masses is GM over it. */
export const SUN_GM = 132_712_440_041.279_42;
/** The least mass that burns hydrogen, about 0.075 solar masses (as GM): a body this heavy shines as a star. */
export const STAR_MIN_GM = 0.075 * SUN_GM;

/**
 * A star's luminosity now (W): its own at the GM it was given, carried to its GM now by the
 * main-sequence relation (so a star whose mass the visitor changes brightens or dims as a star of that
 * mass would); the relation extended beyond its range where it must be (labelled so in the interface).
 */
export function starWatts(light: StarLight, gmNow: number): number {
  if (!(gmNow > 0) || !(light.gm > 0)) return 0;
  if (gmNow === light.gm) return light.watts;
  return (light.watts * relativeLuminosity(gmNow / SUN_GM)) / relativeLuminosity(light.gm / SUN_GM);
}

/** Eker et al.'s (2018) relation, its end pieces extended beyond 0.179 and 31 solar masses, in solar luminosities. */
function relativeLuminosity(solarMasses: number): number {
  const m = Math.max(solarMasses, 1e-6);
  const [a, b] = m <= 0.45 ? [2.028, -0.976] : m <= 0.72 ? [4.572, -0.102] : m <= 1.05 ? [5.743, -0.007] : m <= 2.4 ? [4.329, 0.01] : m <= 7 ? [3.967, 0.093] : [2.865, 1.105];
  return 10 ** (a * Math.log10(m) + b);
}

/** Every star's luminosity now (W), by id. */
export function luminosities(s: Pick<Bodies, 'ids' | 'gm' | 'stars'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, light] of Object.entries(s.stars)) {
    const i = s.ids.indexOf(id);
    if (i >= 0) out[id] = starWatts(light, s.gm[i] ?? 0);
  }
  return out;
}

/** The bands' centres, edges (as x = sin latitude) and area shares (summing to 1). */
export const BAND_LATITUDES: readonly number[] = Array.from({ length: BANDS }, (_, i) => -90 + (180 * (i + 0.5)) / BANDS);
const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => Math.sin(((-90 + (180 * i) / BANDS) * Math.PI) / 180));
const CENTRES = BAND_LATITUDES.map((d) => Math.sin((d * Math.PI) / 180));
export const BAND_AREAS: readonly number[] = Array.from({ length: BANDS }, (_, i) => ((EDGES[i + 1] ?? 0) - (EDGES[i] ?? 0)) / 2);

/**
 * The day's mean sunlight (W/m^2) at latitude `lat` (radians) from a star giving `s` W/m^2 at the
 * world, at declination `dec` (radians): (S / pi)(h0 sin(lat) sin(dec) + cos(lat) cos(dec) sin(h0)),
 * h0 the hour angle of sunset (Berger 1978).
 */
export function dailyInsolation(s: number, lat: number, dec: number): number {
  const c = -Math.tan(lat) * Math.tan(dec);
  const h0 = c >= 1 ? 0 : c <= -1 ? Math.PI : Math.acos(c);
  return Math.max(0, (s / Math.PI) * (h0 * Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.sin(h0)));
}

/** A band's co-albedo (the share of light it takes in) at x = sin(latitude): Budyko's ice where it is below the ice line, eased over 2 K. */
function coAlbedo(spec: ClimateSpec, t: number, x: number): number {
  if (spec.model === 'grey') return 1 - spec.albedo;
  const free = spec.albedo + spec.albedoP2 * ((3 * x * x - 1) / 2);
  const ice = Math.min(1, Math.max(0, (ICE_LINE_K + 1 - t) / 2));
  return 1 - (free + (spec.iceAlbedo - free) * ice * ice * (3 - 2 * ice));
}

/** The heat a band sends to space (W/m^2) and its rate of change with temperature. */
function outgoing(spec: ClimateSpec, t: number): [number, number] {
  if (spec.model === 'budyko') return [spec.a + spec.b * (t - 273.15) - spec.forcing, spec.b];
  const k = (spec.emissivity * SIGMA) / (1 + 0.75 * spec.tau);
  return [k * t ** 4, 4 * k * t ** 3];
}

/** Each band's day-mean sunlight (W/m^2) on world `i` from every star, with its equator's pole `pole`. */
export function bandInsolation(s: Bodies, i: number, light: Record<string, number> = luminosities(s)): number[] {
  const out = new Array<number>(BANDS).fill(0);
  const pole = poleOf(s, i);
  for (const [star, watts] of Object.entries(light)) {
    const j = s.ids.indexOf(star);
    if (j < 0 || j === i || !(watts > 0)) continue;
    const d = [0, 1, 2].map((k) => (s.pos[j * 3 + k] ?? 0) - (s.pos[i * 3 + k] ?? 0));
    const r = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
    if (!(r > 0)) continue;
    // W/m^2 at the world: luminosity over 4 pi d^2, d in metres.
    const flux = watts / (4 * Math.PI * (r * 1000) ** 2);
    const dec = Math.asin(Math.max(-1, Math.min(1, ((d[0] ?? 0) * pole[0] + (d[1] ?? 0) * pole[1] + (d[2] ?? 0) * pole[2]) / r)));
    for (let b = 0; b < BANDS; b += 1) out[b] = (out[b] ?? 0) + dailyInsolation(flux, ((BAND_LATITUDES[b] ?? 0) * Math.PI) / 180, dec);
  }
  return out;
}

/** World `i`'s pole: its spin's axis, or (turning not at all) the ecliptic's. */
function poleOf(s: Bodies, i: number): [number, number, number] {
  const L = [s.spin[i * 3] ?? 0, s.spin[i * 3 + 1] ?? 0, s.spin[i * 3 + 2] ?? 0];
  const l = Math.hypot(L[0] ?? 0, L[1] ?? 0, L[2] ?? 0);
  return l > 0 ? [(L[0] ?? 0) / l, (L[1] ?? 0) / l, (L[2] ?? 0) / l] : [0, 0, 1];
}

/**
 * One implicit step of `dt` seconds for a climate under day-mean sunlight `q` (W/m^2 per band): the
 * radiation linearised about the bands' temperatures now, the transport implicit, solved as the
 * tridiagonal system it is (Thomas's algorithm).
 */
export function stepBands(c: ClimateState, q: readonly number[], dt: number): void {
  const { spec, t } = c;
  const lower = new Array<number>(BANDS).fill(0);
  const diag = new Array<number>(BANDS).fill(0);
  const upper = new Array<number>(BANDS).fill(0);
  const rhs = new Array<number>(BANDS).fill(0);
  for (let i = 0; i < BANDS; i += 1) {
    const ti = t[i] ?? 0;
    const [olr, slope] = outgoing(spec, ti);
    const width = 2 * (BAND_AREAS[i] ?? 0);
    // Transport across each edge: D (1 - x^2) dT/dx, nothing across the poles.
    const below = i > 0 ? (spec.diffusion * (1 - (EDGES[i] ?? 0) ** 2)) / (((CENTRES[i] ?? 0) - (CENTRES[i - 1] ?? 0)) * width) : 0;
    const above = i < BANDS - 1 ? (spec.diffusion * (1 - (EDGES[i + 1] ?? 0) ** 2)) / (((CENTRES[i + 1] ?? 0) - (CENTRES[i] ?? 0)) * width) : 0;
    const inertia = spec.heatCapacity / dt;
    lower[i] = -below;
    upper[i] = -above;
    diag[i] = inertia + slope + below + above;
    rhs[i] = inertia * ti + (q[i] ?? 0) * coAlbedo(spec, ti, CENTRES[i] ?? 0) - olr + slope * ti;
  }
  // Forward sweep, then back substitution.
  for (let i = 1; i < BANDS; i += 1) {
    const w = (lower[i] ?? 0) / (diag[i - 1] ?? 1);
    diag[i] = (diag[i] ?? 0) - w * (upper[i - 1] ?? 0);
    rhs[i] = (rhs[i] ?? 0) - w * (rhs[i - 1] ?? 0);
  }
  t[BANDS - 1] = (rhs[BANDS - 1] ?? 0) / (diag[BANDS - 1] ?? 1);
  for (let i = BANDS - 2; i >= 0; i -= 1) t[i] = ((rhs[i] ?? 0) - (upper[i] ?? 0) * (t[i + 1] ?? 0)) / (diag[i] ?? 1);
  // Never below the cosmic background, never not a number.
  for (let i = 0; i < BANDS; i += 1) {
    const v = t[i] ?? 0;
    t[i] = Number.isFinite(v) ? Math.max(3, v) : 3;
  }
}

/**
 * A climate started in balance with its light: the year's mean sunlight on each band (the world on
 * the orbit it has now about its primary, its declination swept round the year at its obliquity),
 * stepped implicitly with long steps until the bands settle.
 */
export function settleClimate(s: Bodies, i: number, primary: number): void {
  const id = s.ids[i] ?? '';
  const c = s.climate[id];
  if (!c) return;
  const light = luminosities(s);
  let q = bandInsolation(s, i, light);
  const watts = light[s.ids[primary] ?? ''] ?? 0;
  if (primary >= 0 && watts > 0) {
    // The year's mean: the star's light at today's distance, the declination swept as the world goes round.
    const d = [0, 1, 2].map((k) => (s.pos[primary * 3 + k] ?? 0) - (s.pos[i * 3 + k] ?? 0));
    const v = [0, 1, 2].map((k) => (s.vel[i * 3 + k] ?? 0) - (s.vel[primary * 3 + k] ?? 0));
    const r = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
    const h = [(d[1] ?? 0) * (v[2] ?? 0) - (d[2] ?? 0) * (v[1] ?? 0), (d[2] ?? 0) * (v[0] ?? 0) - (d[0] ?? 0) * (v[2] ?? 0), (d[0] ?? 0) * (v[1] ?? 0) - (d[1] ?? 0) * (v[0] ?? 0)];
    const hl = Math.hypot(h[0] ?? 0, h[1] ?? 0, h[2] ?? 0);
    const pole = poleOf(s, i);
    // The orbit's pole points the other way from r x v taken from the world: the angle between the poles is the obliquity either way.
    const obliquity = hl > 0 ? Math.acos(Math.min(1, Math.abs(((h[0] ?? 0) * pole[0] + (h[1] ?? 0) * pole[1] + (h[2] ?? 0) * pole[2]) / hl))) : 0;
    const flux = watts / (4 * Math.PI * (r * 1000) ** 2);
    q = new Array<number>(BANDS).fill(0);
    const samples = 72;
    for (let k = 0; k < samples; k += 1) {
      const dec = Math.asin(Math.sin(obliquity) * Math.sin((2 * Math.PI * (k + 0.5)) / samples));
      for (let b = 0; b < BANDS; b += 1) q[b] = (q[b] ?? 0) + dailyInsolation(flux, ((BAND_LATITUDES[b] ?? 0) * Math.PI) / 180, dec) / samples;
    }
    // Other stars as they are now.
    const others = bandInsolation(s, i, Object.fromEntries(Object.entries(light).filter(([key]) => key !== s.ids[primary])));
    for (let b = 0; b < BANDS; b += 1) q[b] = (q[b] ?? 0) + (others[b] ?? 0);
  }
  for (let k = 0; k < 400; k += 1) stepBands(c, q, 1e8);
}

/** The climates `dt` seconds on (one implicit step: the caller keeps steps to a day or less). */
export function stepClimates(s: Bodies, dt: number): void {
  const light = luminosities(s);
  for (const [id, c] of Object.entries(s.climate)) {
    const i = s.ids.indexOf(id);
    if (i < 0) continue;
    stepBands(c, bandInsolation(s, i, light), dt);
  }
}

/** The star giving world `i` the most light now (its index), or -1. */
export function brightestStar(s: Bodies, i: number): number {
  let best = -1;
  let most = 0;
  for (const [id, watts] of Object.entries(luminosities(s))) {
    const j = s.ids.indexOf(id);
    if (j < 0 || j === i) continue;
    const r2 = [0, 1, 2].reduce((sum, k) => sum + ((s.pos[j * 3 + k] ?? 0) - (s.pos[i * 3 + k] ?? 0)) ** 2, 0);
    const flux = watts / Math.max(r2, 1e-9);
    if (flux > most) {
      most = flux;
      best = j;
    }
  }
  return best;
}

/** A climate's summary: the area-weighted mean, the warmest and coldest bands, the ice and where liquid water could lie (shares of the surface). */
export function climateSummary(c: ClimateState): { meanK: number; minK: number; maxK: number; ice: number; liquid: number; iceLineDeg: number | null } {
  const { spec, t } = c;
  let mean = 0;
  let ice = 0;
  let liquid = 0;
  const boil = boilingK(spec.pressurePa);
  for (let i = 0; i < BANDS; i += 1) {
    const ti = t[i] ?? 0;
    const area = BAND_AREAS[i] ?? 0;
    mean += ti * area;
    if (spec.model === 'budyko' && ti < ICE_LINE_K) ice += area;
    if (spec.ocean > 0 && spec.pressurePa >= WATER.triplePa && ti > WATER.tripleK && ti < boil) liquid += area * spec.ocean;
  }
  // The ice line: the lowest latitude (either hemisphere) whose band is below it.
  let iceLine: number | null = null;
  if (spec.model === 'budyko') {
    for (let i = 0; i < BANDS; i += 1) {
      if ((t[i] ?? 0) >= ICE_LINE_K) continue;
      const lat = Math.abs(BAND_LATITUDES[i] ?? 0) - 90 / BANDS;
      iceLine = iceLine === null ? lat : Math.min(iceLine, lat);
    }
  }
  return { meanK: mean, minK: Math.min(...t), maxK: Math.max(...t), ice, liquid, iceLineDeg: iceLine };
}

/**
 * Water's boiling point (K) at a pressure (Pa): the Clausius-Clapeyron relation with a constant
 * latent heat (2.257 MJ/kg) from one standard atmosphere, within a few per cent up to near the critical
 * point; past the critical point (22.064 MPa) there is no liquid at all, and nothing boils.
 */
export function boilingK(pressurePa: number): number {
  if (pressurePa < WATER.triplePa) return WATER.tripleK;
  if (pressurePa >= 22.064e6) return 647.096;
  const k = 8.314462618 / (2.257e6 * 0.018015);
  return 1 / (1 / WATER.boilK - k * Math.log(pressurePa / WATER.standardPa));
}

/** The noon temperature (K) of an airless surface facing a star that gives `s` W/m^2, at angle `zenith` from overhead: radiative balance, no heat stored. */
export function noonK(s: number, albedo: number, emissivity: number, zenith = 0): number {
  return ((s * (1 - albedo) * Math.max(0, Math.cos(zenith))) / (emissivity * SIGMA)) ** 0.25;
}

/** A main-sequence star's luminosity (W) from its mass (solar masses): Eker et al.'s (2018, MNRAS 479, 5491) six-piece relation (0.179 to 31 solar masses; its end pieces extended beyond). */
export function mainSequenceLuminosityW(solarMasses: number): number {
  return relativeLuminosity(solarMasses) * SUN_LUMINOSITY_W;
}

/** The Sun's luminosity (W): the IAU 2015 nominal value (Prsa et al. 2016), as NASA's fact sheet gives it (382.8 x 10^24 J/s). */
export const SUN_LUMINOSITY_W = 3.828e26;

/**
 * Where a climate starts before it settles: the Earth's model from today's (North's fit to the
 * observed annual means, 15 C - 28 C P2(sin latitude)), since its light allows several; a grey
 * world, which has one, from 250 K.
 */
export function startingBands(spec: ClimateSpec): number[] {
  return CENTRES.map((x) => (spec.model === 'budyko' ? 288.15 - 28 * ((3 * x * x - 1) / 2) : 250));
}

/**
 * Illustrative settings where no measurement gives one: an airless world's heat capacity (about its
 * regolith's daily skin) and emissivity; Mars's (its regolith's seasonal skin and thin air) and its
 * weak transport; Venus's (its 92 bar column of CO2 at about 1.1 kJ/kg/K) and its strong transport.
 */
export const ILLUSTRATIVE = { airlessHeatCapacity: 5e4, airlessEmissivity: 0.95, marsHeatCapacity: 1e6, marsDiffusion: 0.05, venusHeatCapacity: 1.2e9, venusDiffusion: 10 } as const;

/**
 * The explorer's solid worlds' climates from the sourced constants (data/constants.json), or null for a
 * world a figure is missing for. The Earth's is North et al.'s; Venus's and Mars's are grey, their
 * optical depth from (T_s / T_e)^4 = 1 + 3 tau / 4, T_e the world's effective temperature for its
 * fact sheet's irradiance and Bond albedo, T_s its measured mean; Mercury and the Moon are airless.
 */
export function worldClimates(figure: (id: string) => number | null): Record<string, ClimateSpec | null> {
  const f = (id: string): number | null => figure(id);
  const grey = (albedo: number | null, rest: Partial<ClimateSpec>): ClimateSpec | null =>
    albedo === null ? null : { model: 'grey', albedo, albedoP2: 0, iceAlbedo: albedo, tau: 0, emissivity: 1, a: 0, b: 0, forcing: 0, heatCapacity: ILLUSTRATIVE.airlessHeatCapacity, diffusion: 0, ocean: 0, pressurePa: 0, ...rest };
  const tauFor = (world: string): number | null => {
    const s = f(`${world}.solarIrradiance`);
    const albedo = f(`${world}.bondAlbedo`);
    const surface = f(`${world}.averageTemperature`);
    if (s === null || albedo === null || surface === null) return null;
    const te4 = (s * (1 - albedo)) / (4 * SIGMA);
    return Math.max(0, (surface ** 4 / te4 - 1) / 0.75);
  };
  const a = f('climate.ebm.budykoA');
  const b = f('climate.ebm.budykoB');
  const d = f('climate.ebm.diffusion');
  const a0 = f('climate.ebm.coAlbedo0');
  const a2 = f('climate.ebm.coAlbedo2');
  const ice = f('climate.ebm.iceCoAlbedo');
  const cw = f('climate.ebm.oceanHeatCapacity');
  const cl = f('climate.ebm.landHeatCapacity');
  const ocean = f('earth.oceanFraction');
  const kpa = f('earth.atmosphere.surfacePressure');
  const earth: ClimateSpec | null =
    a === null || b === null || d === null || a0 === null || a2 === null || ice === null || cw === null || cl === null || ocean === null || kpa === null
      ? null
      : { model: 'budyko', albedo: 1 - a0, albedoP2: -a2, iceAlbedo: 1 - ice, tau: 0, emissivity: 1, a, b, forcing: 0, heatCapacity: (ocean * cw + (1 - ocean) * cl) * b * 365.25 * 86_400, diffusion: d, ocean, pressurePa: kpa * 1000 };
  const venusTau = tauFor('venus');
  const marsTau = tauFor('mars');
  const venusKpa = f('venus.surfacePressure');
  const marsKpa = f('mars.surfacePressure');
  return {
    earth,
    venus: venusTau === null || venusKpa === null ? null : grey(f('venus.bondAlbedo'), { tau: venusTau, heatCapacity: ILLUSTRATIVE.venusHeatCapacity, diffusion: ILLUSTRATIVE.venusDiffusion, pressurePa: venusKpa * 1000 }),
    mars: marsTau === null || marsKpa === null ? null : grey(f('mars.bondAlbedo'), { tau: marsTau, heatCapacity: ILLUSTRATIVE.marsHeatCapacity, diffusion: ILLUSTRATIVE.marsDiffusion, pressurePa: marsKpa * 1000 }),
    mercury: grey(f('mercury.bondAlbedo'), { emissivity: ILLUSTRATIVE.airlessEmissivity }),
    moon: grey(f('moon.bondAlbedo'), { emissivity: ILLUSTRATIVE.airlessEmissivity }),
  };
}

/** A solid body the visitor adds: an airless rock of albedo 0.3 (illustrative), so it too has a temperature. */
export function airlessRock(): ClimateSpec {
  return { model: 'grey', albedo: 0.3, albedoP2: 0, iceAlbedo: 0.3, tau: 0, emissivity: ILLUSTRATIVE.airlessEmissivity, a: 0, b: 0, forcing: 0, heatCapacity: ILLUSTRATIVE.airlessHeatCapacity, diffusion: 0, ocean: 0, pressurePa: 0 };
}

export function cloneClimate(c: ClimateState): ClimateState {
  return { spec: { ...c.spec }, t: [...c.t] };
}
