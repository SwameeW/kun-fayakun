import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedBufferAttribute,
  PointsNodeMaterial,
  Sprite,
  SpriteNodeMaterial,
  Vector3,
  type Data3DTexture,
  type Node,
} from 'three/webgpu';
import { cos, dot, exp, float, hash, instanceIndex, instancedBufferAttribute, max, mix, pow, select, sin, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel } from '../../core/types';
import { airSteps, createFilmAir, type FilmAir } from '../shared/film-air';
import { createNoiseVolume } from '../shared/noise-volume';
import { createEarth, createSimpleBody, type Earth, type EarthEpoch, type SimpleBody } from '../shared/planet';
import { createStarfield, type Starfield } from '../shared/starfield';
import contentJson from './content.json';

/**
 * Chapter 8, "The earth spread out": the young Earth as a molten world; a body about the
 * size of Mars strikes it a glancing blow (an eased glow under a dipped exposure, never a
 * flash), its debris rings the Earth and gathers into the Moon; the crust cools under
 * steam; rain fills the first oceans; plates move and continents rise. One planet shader
 * carries the whole history (shared/planet.ts), under the explorer's air (shared/film-air.ts).
 * Sizes and distances are not to scale, and the continents are illustrative, not a
 * reconstruction of any real ancient geography. Nothing is timed to a verse: the verses come
 * in calm stretches between the events.
 */

const content = contentJson as unknown as ChapterContent;

/**
 * The Sun, low over the southern tropic (23 degrees: as far from the equator as the Sun goes), and
 * placed so that along the camera's slow orbit the planet is seen near quarter phase (about 60 to 115
 * degrees between the Sun and the camera): a terminator across the disc and a dark night side.
 */
const SUN = new Vector3(0.907, -0.391, 0.16).normalize();
const IMPACT = { contact: new Vector3(1, 0.25, 0.35).normalize(), theiaRadius: 0.5, from: new Vector3(7, 1.2, -3.2) } as const;
/** Where the impactor's centre is at contact: touching the Earth at the contact point. */
const CONTACT_CENTRE = IMPACT.contact.clone().multiplyScalar(1 + IMPACT.theiaRadius * 0.9);
const MOON = { orbit: 3.4, radius: 0.27, speed: 0.045 } as const;
const DEBRIS: Readonly<Record<QualityTier, number>> = { high: 70_000, mid: 35_000, low: 15_000 };

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (a: number, b: number, c: number, d: number, t: number): number => smootherstep(a, b, t) * (1 - smootherstep(c, d, t));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

function createQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  return geometry;
}

interface Debris {
  readonly object: Sprite;
  update(state: { time: number; launch: number; gather: number; light: number; heat: number; moon: Vector3 }): void;
  setCount(count: number): void;
  dispose(): void;
}

/** The impact's debris: thrown out from the contact point into a ring, which then gathers into the Moon. */
function createDebris(maxCount: number): Debris {
  const orbit = new Float32Array(maxCount * 4);
  for (let i = 0; i < maxCount; i += 1) {
    const u = Math.random();
    const r = 1.35 + 2.9 * Math.sqrt(u);
    orbit.set([r, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.08 * r, Math.random()], i * 4);
  }
  const attr = instancedBufferAttribute(new InstancedBufferAttribute(orbit, 4)) as unknown as Node<'vec4'>;
  const uTime = uniform(0);
  const uLaunch = uniform(0);
  const uGather = uniform(0);
  const uLight = uniform(0);
  const uHeat = uniform(1);
  const uMoon = uniform(new Vector3());
  const uContact = uniform(IMPACT.contact.clone().multiplyScalar(1.05));
  const uGain = uniform(1);
  const r = attr.x;
  const angle = attr.y.add(pow(r, -1.5).mul(0.9).mul(uTime));
  const ring = vec3(cos(angle).mul(r), attr.z, sin(angle).mul(r));
  const out = mix(uContact, ring, pow(uLaunch, 0.7));
  // Gathering: the outer debris falls together into the Moon, the inner falls back to the Earth.
  const outer = smoothstep(2.2, 3.6, r);
  const gather = smoothstep(attr.w.mul(0.35), attr.w.mul(0.35).add(0.65), uGather);
  const position = mix(out, mix(out.mul(0.6), uMoon, outer), gather);
  const brightness = uLight.mul(uGain).mul(float(1).sub(gather.mul(0.92))).mul(hash(instanceIndex.mul(7)).mul(0.6).add(0.6)).mul(0.25);
  const material = new PointsNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: true, sizeAttenuation: false, fog: false });
  material.positionNode = position;
  material.sizeNode = select(brightness.greaterThan(1e-4), float(2.2), float(0));
  const c = uv().sub(0.5).mul(2);
  const r2 = dot(c, c);
  const color = mix(vec3(0.62, 0.48, 0.4), vec3(1.0, 0.52, 0.18).mul(1.6), uHeat);
  material.colorNode = color.mul(brightness).mul(exp(r2.mul(-4)).mul(max(float(1).sub(r2), 0)));
  material.opacityNode = float(1);
  const geometry = createQuad();
  const sprite = new Sprite(material);
  sprite.geometry = geometry;
  sprite.count = maxCount;
  sprite.frustumCulled = false;
  // After the Earth's air (its shell would dim what is drawn before it, debris in front included).
  sprite.renderOrder = 4;
  sprite.name = 'ch08-debris';
  return {
    object: sprite,
    update(state) {
      uTime.value = state.time;
      uLaunch.value = state.launch;
      uGather.value = state.gather;
      uLight.value = state.light;
      uHeat.value = state.heat;
      uMoon.value.copy(state.moon);
      sprite.visible = state.light > 1e-3;
    },
    setCount(count) {
      sprite.count = Math.max(1, Math.min(maxCount, Math.floor(count)));
      uGain.value = (maxCount / sprite.count) ** 0.6;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export default function create(): ChapterModule {
  const times = {
    impact: eventTime(content.cues, 'impact', 22),
    moon: eventTime(content.cues, 'moon', 40),
    oceans: eventTime(content.cues, 'oceans', 76),
    continents: eventTime(content.cues, 'continents', 108),
  };
  const contactAt = times.impact + 5;
  const root = new Group();
  root.name = 'ch08';
  let ctx: ChapterContext | null = null;
  let noise: Data3DTexture | null = null;
  let air: FilmAir | null = null;
  let earth: Earth | null = null;
  let theia: SimpleBody | null = null;
  let moon: SimpleBody | null = null;
  let debris: Debris | null = null;
  let stars: Starfield | null = null;
  let exposure = 1;
  let now = 0;
  const moonPos = new Vector3();
  const theiaPos = new Vector3();
  const sunFrom = new Vector3();
  // The impact's glow at the contact point: an eased swell, never a flash.
  const uGlow = uniform(0);
  const glowMaterial = new SpriteNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false });
  const gc = uv().sub(0.5).mul(2);
  const gr = gc.length();
  glowMaterial.colorNode = vec3(1.0, 0.6, 0.25).mul(exp(gr.mul(-4)).mul(max(float(1).sub(gr), 0))).mul(uGlow);
  glowMaterial.opacityNode = float(1);
  const glow = new Sprite(glowMaterial);
  glow.scale.setScalar(2.6);
  glow.position.copy(IMPACT.contact).multiplyScalar(1.02);
  glow.renderOrder = 4;
  glow.name = 'ch08-impact-glow';

  const epochAt = (t: number): EarthEpoch => {
    const remelt = span(contactAt - 0.5, contactAt + 3, contactAt + 6, 74, t);
    const molten = Math.max(lerp(1, 0.78, smootherstep(0, times.impact, t)) * (1 - smootherstep(contactAt + 6, 74, t)), remelt, 0) * (1 - smootherstep(74, 90, t));
    return {
      molten,
      steam: Math.max(0.2, lerp(0.2, 0.65, smootherstep(contactAt + 8, 60, t))) * (1 - 0.88 * smootherstep(times.oceans, times.oceans + 24, t)),
      ocean: smootherstep(times.oceans, times.oceans + 28, t),
      land: smootherstep(times.continents, times.continents + 18, t),
      drift: Math.max(0, t - times.continents) * 0.05,
      oxygen: 0,
      life: 0,
      clouds: 0.5 * smootherstep(times.oceans, times.oceans + 24, t),
    };
  };

  return {
    id: 'ch08',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!earth) {
        noise = await createNoiseVolume(64, 8_008);
        air = createFilmAir(c);
        earth = createEarth(noise, 1, { model: air.model, table: air.table, steps: airSteps(c.quality.tier) });
        theia = createSimpleBody(noise, IMPACT.theiaRadius, { name: 'theia', color: [0.42, 0.3, 0.24], mottle: 0.6, seed: 0.83 });
        moon = createSimpleBody(noise, MOON.radius, { name: 'moon', color: [0.6, 0.58, 0.55], mottle: 0.55, seed: 0.37 });
        debris = createDebris(DEBRIS.high);
        stars = createStarfield();
        root.add(stars.object, earth.object, theia.object, moon.object, debris.object, glow);
      }
      debris?.setCount(DEBRIS[c.quality.tier]);
      earth.setAirSteps(airSteps(c.quality.tier));
    },

    enter(c) {
      ctx = c;
      exposure = 1;
      debris?.setCount(DEBRIS[c.quality.tier]);
      earth?.setAirSteps(airSteps(c.quality.tier));
      c.exposure.setTarget(1);
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !earth || !theia || !moon || !debris || !stars) return;
      now = t;
      air?.bake(ctx.renderer);
      stars.setLight(1);
      earth.update({ time: t, sun: SUN, spin: t * 0.12, light: smootherstep(0, 2.5, t), epoch: epochAt(t), eye: ctx.camera.position });

      // The impactor: in along a gentle curve, gone into the glow at contact.
      const approach = smootherstep(times.impact - 4, contactAt, t);
      theiaPos.copy(IMPACT.from).lerp(CONTACT_CENTRE, approach);
      theiaPos.y += Math.sin(approach * Math.PI) * 0.6;
      theia.object.position.copy(theiaPos);
      sunFrom.copy(SUN);
      theia.update({ time: t, sun: sunFrom, spin: t * 0.3, light: span(times.impact - 4, times.impact - 1, contactAt - 0.2, contactAt + 0.8, t) });
      uGlow.value = span(contactAt - 0.5, contactAt + 2, contactAt + 3, contactAt + 11, t) * 1.3;
      glow.visible = uGlow.value > 1e-3;
      // Exposure dips a little while the impact glows (the engine eases it).
      const target = 1 - 0.3 * span(contactAt - 1, contactAt + 1.5, contactAt + 5, contactAt + 10, t);
      if (Math.abs(target - exposure) > 0.005) {
        exposure = target;
        ctx.exposure.setTarget(exposure);
      }

      // The Moon gathers from the ring, then keeps its slow orbit (far closer than the real 60 Earth radii).
      const angle = 0.6 + t * MOON.speed;
      moonPos.set(Math.cos(angle) * MOON.orbit, 0.12, Math.sin(angle) * MOON.orbit);
      moon.object.position.copy(moonPos);
      sunFrom.copy(SUN);
      moon.update({ time: t, sun: sunFrom, spin: 0, light: smootherstep(times.moon + 4, times.moon + 12, t) });
      debris.update({
        time: t - contactAt,
        launch: smootherstep(contactAt, contactAt + 5, t),
        gather: smootherstep(times.moon, times.moon + 12, t),
        light: span(contactAt + 0.2, contactAt + 2, times.moon + 9, times.moon + 14, t),
        heat: 1 - smootherstep(contactAt + 3, times.moon + 4, t),
        moon: moonPos,
      });
    },

    labels(): readonly SceneLabel[] {
      const labels: SceneLabel[] = [];
      const theiaTag = span(times.impact - 2, times.impact, contactAt - 1.5, contactAt - 0.5, now);
      if (theiaTag > 0) labels.push({ id: 'theia', textKey: 'ui.hud.theia', position: [theiaPos.x, theiaPos.y + IMPACT.theiaRadius, theiaPos.z], opacity: theiaTag });
      const moonTag = span(times.moon + 8, times.moon + 10, 50, 51.5, now);
      if (moonTag > 0) labels.push({ id: 'moon', textKey: 'ui.hud.moon', position: [moonPos.x, moonPos.y + MOON.radius, moonPos.z], opacity: moonTag });
      return labels;
    },

    scale() {
      // Sizes and distances are compressed here (the Moon would be 60 Earth radii away).
      return null;
    },

    setQuality(profile) {
      debris?.setCount(DEBRIS[profile.tier]);
      earth?.setAirSteps(airSteps(profile.tier));
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      earth?.dispose();
      theia?.dispose();
      moon?.dispose();
      debris?.dispose();
      stars?.dispose();
      noise?.dispose();
      air?.dispose();
      glowMaterial.dispose();
      air = null;
      earth = null;
      theia = null;
      moon = null;
      debris = null;
      stars = null;
      noise = null;
      ctx = null;
    },
  };
}
