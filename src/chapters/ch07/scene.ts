import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, MathUtils, PointsNodeMaterial, Sprite, Vector3, type Data3DTexture } from 'three/webgpu';
import { dot, exp, float, max, uniform, uv, vec3 } from 'three/tsl';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel, SceneScale } from '../../core/types';
import { createMilkyWay, type MilkyWay } from '../ch05/milky-way';
import { createNoiseVolume } from '../shared/noise-volume';
import { createEarth, createSimpleBody, EARTH_TODAY, type Earth, type SimpleBody } from '../shared/planet';
import { createFilmSun, type FilmSun } from '../shared/film-sun';
import { createStarfield, type Starfield } from '../shared/starfield';
import contentJson from './content.json';
import { createDisk, type Disk } from './disk';
import { compress, julianDateNow, loadEphemeris, type Ephemeris } from './ephemeris';
import { createRings, type Rings } from './rings';

/**
 * Chapter 7, "The Sun and its course": a slow crane over the protoplanetary disk, its dust
 * lanes and the gaps that growing planets clear; the Sun (the explorer's, shared/film-sun.ts)
 * begins to shine (an eased swell);
 * the disk clears and the planets remain on their real orbits, placed for today's date from
 * NASA JPL's elements and drawn as engraved rings graduated like an astrolabe; a long-lens
 * hold on the Moon shows its real phase, from JPL Horizons, as the days pass; then the view
 * draws back to the Sun's course around the Milky Way (science, after the verses, never
 * offered as their meaning). Sizes and distances are compressed and labelled not to scale.
 */

const content = contentJson as unknown as ChapterContent;

const SUN_RADIUS = 0.32;
/** Displayed radii (scene units), compressed; their order is real, their sizes are not. */
const RADII: Readonly<Record<string, number>> = {
  Mercury: 0.026, Venus: 0.046, Earth: 0.05, Mars: 0.034, Jupiter: 0.13, Saturn: 0.11, Uranus: 0.075, Neptune: 0.072,
};
const LOOKS: Readonly<Record<string, { color: [number, number, number]; bands?: number; mottle?: number; rings?: [number, number] }>> = {
  Mercury: { color: [0.55, 0.52, 0.5], mottle: 0.5 },
  Venus: { color: [0.92, 0.84, 0.66], mottle: 0.15 },
  Mars: { color: [0.75, 0.38, 0.22], mottle: 0.45 },
  Jupiter: { color: [0.86, 0.74, 0.6], bands: 9 },
  Saturn: { color: [0.9, 0.82, 0.62], bands: 7, rings: [1.25, 2.25] },
  Uranus: { color: [0.62, 0.84, 0.88], bands: 2 },
  Neptune: { color: [0.36, 0.52, 0.92], bands: 3 },
};
const TAG_KEYS: Readonly<Record<string, string>> = {
  Mercury: 'ui.hud.planet.mercury', Venus: 'ui.hud.planet.venus', Earth: 'ui.hud.earth', Mars: 'ui.hud.planet.mars',
  Jupiter: 'ui.hud.planet.jupiter', Saturn: 'ui.hud.planet.saturn', Uranus: 'ui.hud.planet.uranus', Neptune: 'ui.hud.planet.neptune',
};
/** Days of solar-system time per chapter second, from each time on (the Moon's phase is today's at `moon` + 5 s). */
const RATES: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [40, 3], [70, 1], [81, 2.1], [101, 5], [141, 10],
];
const TODAY_AT = 86;
const MOON = { orbit: 0.16, closeUpAt: new Vector3(0, 0, -0.5), closeRadius: 0.03, radius: 0.014 } as const;
const SUN_KELVIN = { young: 3800, main: 5772 } as const;
/** The young Sun's light inside its dust, before it begins to shine, as a share of its full light. */
const YOUNG_SUN_LIGHT = 0.08;
/** The Sun is about 8.2 kpc from the Galactic centre (GRAVITY Collaboration 2019), in the model's frame at -x. */
const SUN_KPC = 8.2;
const KPC_PER_UNIT = { inside: 0.004, galaxy: 5 } as const;
const KPC_IN_METRES = 3.085677581491367e19;
/**
 * The letter analysis (docs/SPEC.md, Chapter 7): the scene dims to 45% through the engine's
 * exposure (one slew-limited control for the galaxy, the Sun's path and the marker alike) and
 * slows to a few per cent of its pace, but never stops. The film clock is held meanwhile, so the
 * orbits move only by these days. The dim and slow ease in and out with this time constant.
 */
const DISCOVERY = { dim: 0.55, daysPerSecond: 0.4, reducedDaysPerSecond: 0.05, livingRate: 0.25, easeSeconds: 0.8 } as const;
const COUNT: Readonly<Record<QualityTier, { disk: number; stars: number }>> = {
  high: { disk: 260_000, stars: 320_000 },
  mid: { disk: 120_000, stars: 160_000 },
  low: { disk: 50_000, stars: 70_000 },
};

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (a: number, b: number, c: number, d: number, t: number): number => smootherstep(a, b, t) * (1 - smootherstep(c, d, t));

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

/** Days elapsed by chapter time t (integral of RATES). */
function elapsedDays(t: number): number {
  let days = 0;
  for (let i = 0; i < RATES.length; i += 1) {
    const [start, rate] = RATES[i] ?? [0, 0];
    const end = RATES[i + 1]?.[0] ?? Infinity;
    if (t <= start) break;
    days += (Math.min(t, end) - start) * rate;
  }
  return days;
}

export default function create(): ChapterModule {
  const times = {
    ignite: eventTime(content.cues, 'ignite', 16),
    clear: eventTime(content.cues, 'clear', 40),
    orrery: eventTime(content.cues, 'orrery', 70),
    moon: eventTime(content.cues, 'moon', 81),
    galaxy: eventTime(content.cues, 'galaxy', 143),
  };
  const root = new Group();
  root.name = 'ch07';
  const system = new Group();
  system.name = 'ch07-system';
  root.add(system);
  let ctx: ChapterContext | null = null;
  let noise: Data3DTexture | null = null;
  let ephemeris: Ephemeris | null = null;
  let sun: FilmSun | null = null;
  let disk: Disk | null = null;
  let rings: Rings | null = null;
  let earth: Earth | null = null;
  let moon: SimpleBody | null = null;
  let stars: Starfield | null = null;
  let galaxy: MilkyWay | null = null;
  let sunPath: Rings | null = null;
  const others: Array<{ name: string; index: number; body: SimpleBody }> = [];
  let earthIndex = 2;
  /** Julian date at chapter time 0 + elapsed days gives the date shown; today falls at TODAY_AT. */
  let jdZero = 0;
  /** The letter analysis: its target (0 or 1), the eased value, and the extra days and seconds it lets pass. */
  let discovery = 0;
  let discoveryEased = 0;
  let discoveryDays = 0;
  /** Extra time for the living surfaces (granulation, spin) while the film clock is held, so they slow rather than freeze. */
  let discoveryLiving = 0;
  let now = 0;
  let kpc: number = KPC_PER_UNIT.inside;
  let galaxyShare = 0;
  const positions = new Map<string, Vector3>();
  const scratch = new Vector3();
  const au = new Vector3();
  const sunDir = new Vector3();
  const earthPos = new Vector3();
  const moonPos = new Vector3();
  const offset = new Vector3();
  const sunWorld = new Vector3();
  // A point for the Sun when the view pulls back to the galaxy (the solar system is then far below a pixel).
  const uMarker = uniform(0);
  const uMarkerAt = uniform(new Vector3());
  const markerMaterial = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false });
  markerMaterial.positionNode = uMarkerAt;
  markerMaterial.sizeNode = float(9);
  const mc = uv().sub(0.5).mul(2);
  markerMaterial.colorNode = vec3(1.0, 0.92, 0.78).mul(exp(dot(mc, mc).mul(-6)).mul(1.4).mul(max(float(1).sub(dot(mc, mc)), 0))).mul(uMarker);
  markerMaterial.opacityNode = float(1);
  const markerGeometry = new BufferGeometry();
  markerGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  markerGeometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  markerGeometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  const marker = new Sprite(markerMaterial);
  marker.geometry = markerGeometry;
  marker.frustumCulled = false;
  marker.name = 'ch07-sun-marker';
  root.add(marker);

  const setCounts = (tier: QualityTier): void => {
    disk?.setCount(COUNT[tier].disk);
    galaxy?.setBudget(COUNT[tier].stars);
  };

  return {
    id: 'ch07',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!sun) {
        const [volume, eph, mw] = await Promise.all([createNoiseVolume(64, 7_007), loadEphemeris(c), createMilkyWay()]);
        noise = volume;
        ephemeris = eph;
        galaxy = mw;
        jdZero = julianDateNow() - elapsedDays(TODAY_AT);
        earthIndex = Math.max(0, eph.bodies.findIndex((b) => b.name === 'Earth'));
        sun = createFilmSun(volume, SUN_RADIUS, c.data, c.quality.tier);
        stars = createStarfield();
        // Gaps in the disk where each planet's orbit will be (compressed radii).
        const gaps = eph.bodies.map((b) => ({
          radius: compress(au.set(b.elements.a, 0, 0), scratch).x,
          width: b.name === 'Jupiter' || b.name === 'Saturn' ? 0.2 : 0.08 + 0.02 * b.elements.a ** 0.3,
          depth: b.name === 'Jupiter' || b.name === 'Saturn' ? 0.92 : 0.6,
        }));
        disk = createDisk({ count: COUNT.high.disk, inner: 0.42, outer: 8.6, gaps, seed: 4_567 });
        // Orbit loops for the rings, for today's elements.
        const jd = julianDateNow();
        const loops = eph.bodies.map((b, index) => {
          const period = 365.25 * b.elements.a ** 1.5;
          return Array.from({ length: 240 }, (_, i) => compress(eph.planetAu(index, jd + (period * i) / 240, au), new Vector3()));
        });
        rings = createRings(loops);
        sunPath = createRings([Array.from({ length: 240 }, (_, i) => new Vector3(Math.cos((i / 240) * 2 * Math.PI) * SUN_KPC, 0, Math.sin((i / 240) * 2 * Math.PI) * SUN_KPC))]);
        earth = createEarth(volume, RADII.Earth ?? 0.05);
        moon = createSimpleBody(volume, MOON.radius, { name: 'moon', color: [0.62, 0.6, 0.57], mottle: 0.55, seed: 0.37 });
        eph.bodies.forEach((b, index) => {
          if (b.name === 'Earth') return;
          const look = LOOKS[b.name] ?? { color: [0.7, 0.7, 0.7] as [number, number, number] };
          others.push({ name: b.name, index, body: createSimpleBody(volume, RADII[b.name] ?? 0.04, { name: b.name, ...look, seed: index * 0.13 }) });
        });
        system.add(sun.object, earth.object, moon.object, ...others.map((o) => o.body.object));
        root.add(stars.object, disk.object, rings.field.mesh, galaxy.object, sunPath.field.mesh, sun.glare);
      }
      setCounts(c.quality.tier);
      sun.setQuality(c.quality.tier);
    },

    enter(c) {
      ctx = c;
      discovery = 0;
      discoveryEased = 0;
      discoveryDays = 0;
      discoveryLiving = 0;
      setCounts(c.quality.tier);
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t, dt) {
      if (!ctx || !ephemeris || !sun || !disk || !rings || !earth || !moon || !stars || !galaxy || !sunPath) return;
      now = t;
      // While the letter analysis is open the scene dims and slows, but never stops (eased both ways).
      const step = Math.max(0, dt);
      discoveryEased += (discovery - discoveryEased) * (1 - Math.exp(-step / DISCOVERY.easeSeconds));
      if (discovery === 0 && discoveryEased < 1e-4) discoveryEased = 0;
      const rate = ctx.reducedMotion ? DISCOVERY.reducedDaysPerSecond : DISCOVERY.daysPerSecond;
      discoveryDays += step * rate * discoveryEased;
      if (!ctx.reducedMotion) discoveryLiving += step * DISCOVERY.livingRate * discoveryEased;
      ctx.exposure.setTarget(1 - DISCOVERY.dim * discoveryEased);
      const jd = jdZero + elapsedDays(t) + discoveryDays;
      const living = t + discoveryLiving;

      // Solar-system scale for the final pull-back: the system shrinks to the point of the Sun.
      const shrink = 10 ** (-3 * smootherstep(times.galaxy, times.galaxy + 9, t));
      galaxyShare = smootherstep(times.galaxy + 3, times.galaxy + 9, t);
      const drift = smootherstep(times.galaxy + 7, times.galaxy + 25, t);
      kpc = 10 ** (Math.log10(KPC_PER_UNIT.inside) + (Math.log10(KPC_PER_UNIT.galaxy) - Math.log10(KPC_PER_UNIT.inside)) * smootherstep(times.galaxy + 3, times.galaxy + 23, t));
      // Floating origin: from the Sun (the origin) to the Galactic centre as the galaxy comes into view.
      sunWorld.set((-SUN_KPC * drift) / kpc, 0, 0);

      // The Moon close-up: the Earth is brought to the origin (translation only).
      const close = smootherstep(times.moon, times.moon + 5, t) * (1 - smootherstep(times.moon + 19, times.moon + 24, t));
      ephemeris.planetAu(earthIndex, jd, au);
      compress(au, earthPos);
      offset.copy(earthPos).multiplyScalar(-close);
      system.position.copy(offset).multiplyScalar(shrink).add(sunWorld);
      system.scale.setScalar(shrink);

      // The Sun: dim and cool inside its dust, then shining (an eased swell over twelve seconds); its
      // glare goes as the view pulls back to the galaxy, where the Sun is a marked point.
      const ignite = smootherstep(times.ignite, times.ignite + 12, t);
      const kelvin = SUN_KELVIN.young + (SUN_KELVIN.main - SUN_KELVIN.young) * ignite;
      sun.update({
        time: living,
        kelvin,
        light: (YOUNG_SUN_LIGHT + (1 - YOUNG_SUN_LIGHT) * ignite) * smootherstep(0, 3, t),
        glare: ignite * (1 - smootherstep(times.galaxy, times.galaxy + 5, t)),
        camera: ctx.camera,
        viewportPx: ctx.renderer.domElement.clientHeight,
        widthPx: ctx.renderer.domElement.clientWidth,
        exposure: ctx.exposure.current,
      });
      stars.setLight((0.35 + 0.65 * smootherstep(times.clear, times.clear + 10, t)) * (1 - galaxyShare));

      disk.update({ time: t, light: smootherstep(0, 3, t), clearing: smootherstep(times.clear, times.clear + 12, t) });

      // Planets on their real orbits; they come out as the disk clears, and fade as the view pulls back.
      const planetLight = smootherstep(times.clear + 2, times.clear + 10, t) * (1 - smootherstep(times.galaxy + 1, times.galaxy + 6, t));
      for (const o of others) {
        ephemeris.planetAu(o.index, jd, au);
        const p = compress(au, positions.get(o.name) ?? new Vector3());
        positions.set(o.name, p);
        o.body.object.position.copy(p);
        sunDir.copy(p).negate().normalize();
        o.body.update({ time: t, sun: sunDir, spin: living * 0.6, light: planetLight });
      }
      earth.object.position.copy(earthPos);
      earth.object.scale.setScalar((RADII.Earth ?? 0.05) * (1 + 1.6 * close));
      positions.set('Earth', earthPos);
      sunDir.copy(earthPos).negate().normalize();
      // A slow, steady turn: at the sped-up calendar a true day would strobe.
      earth.update({ time: t, sun: sunDir, spin: living * 0.25, light: planetLight, epoch: EARTH_TODAY });

      // The Moon: around the Earth on its real bearing; in the close-up, before the camera, lit for its real phase.
      ephemeris.moonKm(jd, moonPos).normalize().multiplyScalar(MOON.orbit);
      moonPos.add(earthPos);
      const elongation = ephemeris.moonElongation(jd);
      const phaseAngle = Math.PI - Math.abs(elongation);
      // Close-up light: from in front for a full moon, from behind for a new one; waxing lit on the right.
      const closeLight = scratch.set(Math.sin(phaseAngle) * Math.sign(elongation || 1), 0, Math.cos(phaseAngle));
      sunDir.copy(moonPos).negate().normalize();
      sunDir.lerp(closeLight, close).normalize();
      moon.object.position.copy(moonPos).lerp(scratch.copy(MOON.closeUpAt).sub(offset), close);
      moon.object.scale.setScalar(MOON.radius + (MOON.closeRadius - MOON.radius) * close);
      moon.update({ time: t, sun: sunDir, spin: 0, light: Math.max(planetLight, close) });

      rings.update({ light: smootherstep(times.orrery, times.orrery + 4, t) * (1 - close) * (1 - smootherstep(times.galaxy, times.galaxy + 4, t)), offset: system.position, scale: shrink });

      // The galaxy, and the Sun's path around it.
      const viewportPx = ctx.renderer.domElement.clientHeight;
      const distance = Math.max(ctx.camera.position.length(), 1e-3);
      const pxPerUnit = viewportPx / (2 * Math.tan(MathUtils.degToRad(ctx.camera.fov / 2)) * distance);
      galaxy.object.position.set((SUN_KPC * (1 - drift)) / kpc, 0, 0);
      galaxy.update({ kpcPerUnit: kpc, brightness: galaxyShare, radiusPx: (galaxy.radiusKpc / kpc) * pxPerUnit, viewportPx });
      const pathLight = smootherstep(times.galaxy + 9, times.galaxy + 13, t);
      sunPath.update({ light: pathLight * 1.8, offset: galaxy.object.position, scale: 1 / kpc });
      uMarker.value = pathLight;
      uMarkerAt.value.copy(sunWorld);
      marker.visible = pathLight > 1e-3;
    },

    labels(): readonly SceneLabel[] {
      if (!ctx) return [];
      const t = now;
      const labels: SceneLabel[] = [];
      const push = (id: string, textKey: string, p: Vector3, opacity: number): void => {
        if (opacity > 0) labels.push({ id, textKey, position: [p.x, p.y, p.z], opacity });
      };
      // Planet names while the orrery opens, and the not-to-scale note; none during a verse.
      const names = span(times.orrery + 1, times.orrery + 3, times.moon - 1, times.moon, t);
      if (names > 0) {
        for (const [name, p] of positions) {
          const key = TAG_KEYS[name];
          if (key) push(`planet-${name}`, key, scratch.copy(p).multiplyScalar(system.scale.x).add(system.position), names);
        }
        push('not-to-scale', 'ui.hud.orbitsNotToScale', scratch.set(0, -1.6, 0).add(system.position), names);
      }
      push('moon', 'ui.hud.moon', moon?.object.getWorldPosition(scratch) ?? scratch, span(times.moon + 1, times.moon + 2.5, times.moon + 3.5, times.moon + 4.5, t));
      // The Sun's path stays named until the chapter's last two seconds.
      const path = span(times.galaxy + 11, times.galaxy + 13, content.duration - 2, content.duration, t);
      if (path > 0) push('sun-path', 'ui.hud.sunPath', scratch.set(0, 0, SUN_KPC / kpc).add(galaxy?.object.position ?? scratch), path);
      return labels;
    },

    scale(): SceneScale | null {
      // The orrery is compressed (no true scale); the galaxy, an artist's model, has a true size.
      if (!ctx || galaxyShare < 0.5) return null;
      return { metresPerUnit: kpc * KPC_IN_METRES, distance: ctx.camera.position.length() };
    },

    onInteract(id, value) {
      if (id === 'discovery') discovery = value === null ? 0 : Math.min(1, Math.max(0, value));
    },

    setQuality(profile) {
      setCounts(profile.tier);
      sun?.setQuality(profile.tier);
    },

    exit() {
      root.removeFromParent();
      discovery = 0;
      discoveryEased = 0;
    },

    dispose() {
      root.removeFromParent();
      sun?.dispose();
      disk?.dispose();
      rings?.dispose();
      sunPath?.dispose();
      earth?.dispose();
      moon?.dispose();
      stars?.dispose();
      galaxy?.dispose();
      for (const o of others) o.body.dispose();
      others.length = 0;
      noise?.dispose();
      sun = null;
      disk = null;
      rings = null;
      sunPath = null;
      earth = null;
      moon = null;
      stars = null;
      galaxy = null;
      noise = null;
      markerGeometry.dispose();
      markerMaterial.dispose();
      ephemeris = null;
      ctx = null;
    },
  };
}
