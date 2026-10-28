import { Group, MathUtils, Vector3, type Data3DTexture } from 'three/webgpu';
import { float, hash, instanceIndex, max, min, smoothstep, uniform, vec3, cos, sin, sqrt } from 'three/tsl';
import type { ChapterContent, ChapterContext, ChapterModule, Cue, QualityTier, SceneLabel } from '../../core/types';
import { createNoiseVolume } from '../shared/noise-volume';
import { createStreakField, type StreakField } from '../shared/streaks';
import messages from '../../i18n/en.ch06.json';
import contentJson from './content.json';
import { createBinary, type Binary } from './binary';
import { createEjecta, type Ejecta, type RemnantStructure } from './ejecta';
import { STAR_LAYERS, TYPE_IA_LAYERS } from './layers';
import { createRemnantMarks, type RemnantMarks } from './remnant';
import { createMassiveStar, type MassiveStar } from './star';

/**
 * Chapter 6, "Stars and iron": a massive star cut open to show its layers, hydrogen
 * outside down to the iron at its heart, where fusion stops. The core collapses; a shock
 * wave rebounds through the layers and a flood of neutrinos streams out; the star is torn
 * apart and its debris, coloured by element, spreads into space and cools. As it thins, the
 * remnant's structure shows (ejecta.ts, remnant.ts): plumes of iron that have overtaken the
 * silicon, a pair of silicon jets, cavities in the inner debris, the blast wave's faint rim
 * ahead of it all and the neutron star left at the centre. Elsewhere, a white dwarf draws gas
 * from a companion until it explodes as a Type Ia supernova, its light fading as nickel-56
 * decays to cobalt and iron (the panel's decay chain).
 *
 * Flash safety: every brightening is a single eased swell of a few seconds, never
 * repeated, and the engine's exposure limiter smooths what is left; nothing flares
 * during the verse.
 */

const content = contentJson as unknown as ChapterContent;

const STAR_RADIUS = 4;
const TYPE_IA_CENTRE = [24, 1.5, -6] as const;
/** Seconds after `collapse`: the core falls in, the shock rebounds, and reaches the surface. */
const COLLAPSE = { fall: 0.6, breakout: 6 } as const;
/** The core-collapse debris: final extent beyond the star (world units) and expansion time constant. */
const REMNANT = { reach: 9, tau: 11 } as const;
/**
 * The remnant's structure, a composite after Cassiopeia A (the Discover card says so). Directions are
 * in the world, chosen so that from the film's camera as the structure shows (about 37 s) the larger
 * iron plume points down and right, under the iron tag, the smaller one up, the silicon jets run
 * nearly level, clear of the caption below, and the cavities sit between them. Shares are of the
 * inner matter mixed outward (STAR_LAYERS: iron or silicon); speeds are fractions of the fastest
 * debris', so the plumes' heads run out past the silicon into the helium and the jets past the edge.
 */
const IRON_PLUME = [0.61, -0.75, 0.24] as const;
const STRUCTURE: RemnantStructure = {
  plumes: [
    { dir: IRON_PLUME, share: 0.45, speed: 0.8, spread: 0.2 },
    { dir: [-0.15, 0.92, -0.35], share: 0.3, speed: 0.78, spread: 0.17 },
  ],
  jets: { axis: [0.96, 0.27, -0.07], share: 0.5, speed: 1.9, spread: 0.045 },
  bubbles: [
    { dir: [0.57, 0.82, 0.07], at: 0.29, radius: 0.25 },
    { dir: [-0.88, 0.45, -0.14], at: 0.28, radius: 0.24 },
    { dir: [-0.35, -0.85, 0.39], at: 0.29, radius: 0.23 },
    { dir: [0.82, -0.37, -0.45], at: 0.26, radius: 0.22 },
  ],
  ironLight: 0.38,
};
/**
 * When it shows, in seconds after breakout (the debris' age): it comes into view as the debris cools
 * and thins (the cavities opening, the rim and the neutron star fading in) and is complete by 38 s,
 * before the quiet ahead of the verse; under the verse it only dims with the debris. The blast wave's
 * rim runs this far beyond the debris' extent (relative to its travel).
 */
const REVEAL = { cavities: [6, 14], rim: [8, 13], star: [8.5, 12.5], rimReach: 1.32 } as const;
const TYPE_IA = { reach: 7.5, tau: 5.5, rise: 2.6 } as const;
/** The pair turns slowly (radians per second), placed so the companion is left of the white dwarf as the camera arrives. */
const ORBIT = { rate: 0.05, settledBefore: 4 } as const;
const COUNT: Readonly<Record<QualityTier, { remnant: number; typeIa: number; neutrinos: number }>> = {
  high: { remnant: 260_000, typeIa: 150_000, neutrinos: 2400 },
  mid: { remnant: 120_000, typeIa: 70_000, neutrinos: 1400 },
  low: { remnant: 50_000, typeIa: 30_000, neutrinos: 700 },
};
const NEUTRINO = { speed: 26, trail: 2.2, spread: 2.2, life: 3.2 } as const;

const smootherstep = (edge0: number, edge1: number, x: number): number => {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
/** Up over [a, b], down over [c, d]. */
const span = (a: number, b: number, c: number, d: number, t: number): number => smootherstep(a, b, t) * (1 - smootherstep(c, d, t));

function eventTime(cues: readonly Cue[], event: string, fallback: number): number {
  return cues.find((c): c is Extract<Cue, { type: 'scene' }> => c.type === 'scene' && c.event === event)?.t ?? fallback;
}

interface Neutrinos {
  readonly field: StreakField;
  /** Seconds since the burst began, and its brightness. */
  update(since: number, light: number): void;
}

/** Neutrinos: thin fast streaks from the core in every direction, emitted over about two seconds. */
function createNeutrinos(maxCount: number): Neutrinos {
  const uSince = uniform(-1);
  const uLight = uniform(0);
  const seed = instanceIndex.mul(4);
  const z = hash(seed).mul(2).sub(1);
  const phi = hash(seed.add(1)).mul(Math.PI * 2);
  const ring = sqrt(max(float(1).sub(z.mul(z)), 0));
  const dir = vec3(ring.mul(cos(phi)), z, ring.mul(sin(phi)));
  const age = uSince.sub(hash(seed.add(2)).mul(NEUTRINO.spread));
  const reach = max(age, 0).mul(NEUTRINO.speed);
  const head = dir.mul(reach);
  const tail = dir.mul(max(reach.sub(NEUTRINO.trail), 0));
  const alive = smoothstep(0, 0.15, age).mul(float(1).sub(smoothstep(NEUTRINO.life * 0.6, NEUTRINO.life, age)));
  const field = createStreakField({
    name: 'ch06-neutrinos',
    maxCount,
    head,
    tail,
    color: vec3(0.55, 0.7, 1.0).mul(alive.mul(uLight).mul(min(reach.div(3), 1))),
    width: float(0.0022),
  });
  return {
    field,
    update(since, light) {
      uSince.value = since;
      uLight.value = light;
      field.mesh.visible = light > 1e-3;
    },
  };
}

export default function create(): ChapterModule {
  const times = {
    collapse: eventTime(content.cues, 'collapse', 18),
    whiteDwarf: eventTime(content.cues, 'white-dwarf', 88),
    typeIa: eventTime(content.cues, 'type-ia', 100),
  };
  const breakout = times.collapse + COLLAPSE.breakout;
  // While the verse is on screen the debris dims to a quiet glow behind it.
  const verseCue = content.cues.find((c): c is Extract<Cue, { type: 'verse' }> => c.type === 'verse');
  const verse = verseCue ? { from: verseCue.t, to: verseCue.t + verseCue.duration } : { from: Infinity, to: Infinity };
  const root = new Group();
  root.name = 'ch06';
  let ctx: ChapterContext | null = null;
  let noise: Data3DTexture | null = null;
  let star: MassiveStar | null = null;
  let remnant: Ejecta | null = null;
  let typeIa: Ejecta | null = null;
  let binary: Binary | null = null;
  let neutrinos: Neutrinos | null = null;
  let marks: RemnantMarks | null = null;
  let tier: QualityTier = 'high';
  let rimRadius = 0;
  let now = 0;
  let exposure = 1;
  const scratch = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const dir = new Vector3();
  const projected = new Vector3();
  /** Canvas pixels of a world point (the HUD adds the canvas offset; callout offsets are relative). */
  const toPixels = (p: Vector3): [number, number] => {
    if (!ctx) return [0, 0];
    const canvas = ctx.renderer.domElement;
    projected.copy(p).project(ctx.camera);
    return [((projected.x + 1) / 2) * canvas.clientWidth, ((1 - projected.y) / 2) * canvas.clientHeight];
  };

  const setCounts = (next: QualityTier): void => {
    tier = next;
    remnant?.setCount(COUNT[next].remnant);
    typeIa?.setCount(COUNT[next].typeIa);
    neutrinos?.field.setCount(COUNT[next].neutrinos);
  };

  /** Camera-relative direction (right, up, toward the camera), so tags spread across the screen. */
  const towardScreen = (x: number, y: number, out: Vector3): Vector3 => {
    if (!ctx) return out.set(x, y, 0);
    right.setFromMatrixColumn(ctx.camera.matrixWorld, 0);
    up.setFromMatrixColumn(ctx.camera.matrixWorld, 1);
    return out.copy(right).multiplyScalar(x).addScaledVector(up, y).normalize();
  };

  return {
    id: 'ch06',
    content,
    cues: content.cues,

    async load(c) {
      ctx = c;
      if (!star) {
        noise = await createNoiseVolume(64, 6_025);
        star = createMassiveStar(noise, STAR_RADIUS);
        remnant = createEjecta(noise, {
          name: 'ch06-remnant',
          count: COUNT.high.remnant,
          layers: STAR_LAYERS,
          centre: [0, 0, 0],
          fingers: 70,
          fingerShare: 0.45,
          mixing: 0.14,
          seed: 1_054,
          structure: STRUCTURE,
        });
        typeIa = createEjecta(noise, {
          name: 'ch06-type-ia',
          count: COUNT.high.typeIa,
          layers: TYPE_IA_LAYERS,
          centre: TYPE_IA_CENTRE,
          fingers: 24,
          fingerShare: 0.18,
          mixing: 0.02,
          seed: 1_572,
        });
        binary = createBinary(noise, TYPE_IA_CENTRE);
        neutrinos = createNeutrinos(COUNT.high.neutrinos);
        marks = createRemnantMarks(noise, [0, 0, 0]);
        root.add(star.object, remnant.object, marks.object, binary.object, typeIa.object, neutrinos.field.mesh);
      }
      // The tags this chapter adds (its own strings, with its chunk).
      c.i18n?.extend('en.ch06.json', messages);
      setCounts(c.quality.tier);
    },

    enter(c) {
      ctx = c;
      setCounts(c.quality.tier);
      c.exposure.setTarget(1);
      exposure = 1;
      c.scene.add(root);
    },

    update(t) {
      if (!ctx || !star || !remnant || !typeIa || !binary || !neutrinos || !marks) return;
      now = t;
      const reduced = ctx.reducedMotion;
      const since = t - times.collapse;
      // A little less exposure while the debris is white-hot and while the Type Ia peaks (eased by the engine).
      const dip = Math.max(span(3.5, 6.5, 14, 22, since), span(-0.5, 2, 6, 12, t - times.typeIa));
      const target = 1 - 0.25 * dip;
      if (Math.abs(target - exposure) > 0.005) {
        exposure = target;
        ctx.exposure.setTarget(exposure);
      }

      // The star: in, collapse, shock, torn apart at breakout.
      const shockRun = smootherstep(COLLAPSE.fall, COLLAPSE.breakout, since);
      star.update({
        time: t,
        core: 1 - 0.88 * smootherstep(0, COLLAPSE.fall, since),
        shock: since > COLLAPSE.fall ? 0.03 + 1.12 * shockRun : 0,
        shockLight: span(COLLAPSE.fall, COLLAPSE.fall + 1, COLLAPSE.breakout + 0.5, COLLAPSE.breakout + 2.5, since),
        light: smootherstep(0, 2.5, t) * (1 - smootherstep(breakout, breakout + 2.2, t)),
      });

      neutrinos.update(since - COLLAPSE.fall * 0.5, since > 0 ? span(0, 0.3, 4.5, 6, since) * (reduced ? 0.6 : 1) : 0);

      // The debris: white-hot, swelling into view over a few seconds (no flash), then cooling and slowing.
      // While it is compact each point is dimmer, so the cloud never glares; it leaves before the pair appears.
      const age = Math.max(0, t - breakout);
      const leaving = 1 - smootherstep(times.whiteDwarf - 2, times.whiteDwarf + 5, t);
      const swell = smootherstep(breakout - 0.6, breakout + (reduced ? 3.5 : 2.4), t) * leaving;
      const travel = REMNANT.reach * (1 - Math.exp(-age / REMNANT.tau)) * (reduced ? 0.9 : 1);
      const compact = Math.min(1, Math.max(0.3, ((STAR_RADIUS + travel) / (STAR_RADIUS + REMNANT.reach)) ** 1.5));
      const hush = span(verse.from - 2, verse.from + 1, verse.to - 1, verse.to + 2, t);
      const hushed = 1 - 0.6 * hush;
      // With reduced motion the cavities are open from the start, so they only grow with the debris.
      const open = reduced ? 1 : smootherstep(REVEAL.cavities[0], REVEAL.cavities[1], age);
      remnant.update({
        start: STAR_RADIUS,
        travel,
        heat: 1 - smootherstep(0, 9, age),
        shell: smootherstep(6, 22, age),
        light: swell * compact * (0.55 + 0.5 * Math.exp(-age / 4)) * hushed,
        sizePx: 2.1,
        // Low draws the rim and the neutron star only.
        cavities: tier === 'low' ? 0 : open,
      });
      // The rim and the neutron star all but go out under the verse, as the debris dims, so no ring frames the card.
      const quiet = (1 - 0.92 * hush) * leaving;
      const starLight = smootherstep(REVEAL.star[0], REVEAL.star[1], age) * quiet;
      rimRadius = STAR_RADIUS + REVEAL.rimReach * travel;
      marks.update({
        rimRadius,
        // Low's sparser debris, with no bloom, would leave the rim standing out more: a little fainter there.
        rim: smootherstep(REVEAL.rim[0], REVEAL.rim[1], age) * quiet * (tier === 'low' ? 0.8 : 1),
        star: starLight,
        glow: tier === 'low' ? 0 : starLight,
      });

      // The pair, then the Type Ia.
      const sinceIa = t - times.typeIa;
      const ageIa = Math.max(0, sinceIa);
      binary.update({
        time: t,
        turn: (t - times.typeIa + ORBIT.settledBefore) * ORBIT.rate,
        light: smootherstep(times.whiteDwarf - 6, times.whiteDwarf, t),
        flow: 1 - smootherstep(0.4, 2.2, sinceIa),
        dwarf: 1 - smootherstep(-0.2, 0.6, sinceIa),
      });
      // Its light rises over a few seconds, then fades as nickel-56 decays (time much compressed).
      const rise = smootherstep(-0.3, reduced ? TYPE_IA.rise * 1.4 : TYPE_IA.rise, sinceIa);
      typeIa.update({
        start: 0.07,
        travel: TYPE_IA.reach * (1 - Math.exp(-ageIa / TYPE_IA.tau)),
        heat: 1 - smootherstep(0, 7, ageIa),
        shell: smootherstep(5, 18, ageIa),
        light: rise * (0.4 + 0.6 * Math.exp(-Math.max(0, ageIa - TYPE_IA.rise) / 7)),
        sizePx: 2.1,
      });
    },

    labels(): readonly SceneLabel[] {
      if (!ctx || !star || !remnant || !typeIa || !binary) return [];
      const t = now;
      const labels: SceneLabel[] = [];
      const push = (id: string, textKey: string, p: Vector3, opacity: number, offset?: readonly [number, number]): void => {
        if (opacity > 0) labels.push({ id, textKey, position: [p.x, p.y, p.z], opacity, ...(offset ? { offset } : {}) });
      };
      const since = t - times.collapse;

      // The layers: each band's middle on the right-hand cut face, called out to a column beside the star
      // (iron at the top, hydrogen at the bottom) so even the thin inner bands get a clear tag.
      const layers = span(4.5, 6.5, times.collapse - 1.5, times.collapse, t);
      if (layers > 0) {
        const cut = star;
        const canvas = ctx.renderer.domElement;
        const [cx, cy] = toPixels(scratch.set(0, 0, 0));
        const radiusPx = (STAR_RADIUS / (ctx.camera.position.length() * Math.tan(MathUtils.degToRad(ctx.camera.fov / 2)))) * (canvas.clientHeight / 2);
        const column = Math.min(cx + radiusPx + 56, canvas.clientWidth - 150);
        const spacing = Math.min(30, (radiusPx * 1.5) / STAR_LAYERS.length);
        STAR_LAYERS.forEach((layer, i) => {
          const inner = STAR_LAYERS[i - 1]?.outer ?? 0;
          const anchor = cut.facePoint((inner + layer.outer) / 2, -0.35, scratch);
          const [ax, ay] = toPixels(anchor);
          const row = cy - radiusPx * 0.62 + i * spacing;
          push(`layer-${layer.id}`, layer.textKey, anchor, layers * smootherstep(4.5 + i * 0.3, 6.5 + i * 0.3, t), [column - ax, row - ay]);
        });
        push('not-to-scale', 'ui.hud.notToScale', scratch.set(-STAR_RADIUS * 0.8, STAR_RADIUS * 1.02, 0), layers);
      }
      push('shock', 'ui.element.shock', star.facePoint(Math.min(1.1, 0.03 + 1.12 * smootherstep(COLLAPSE.fall, COLLAPSE.breakout, since)), 0.15, scratch), span(1.2, 2, COLLAPSE.breakout, COLLAPSE.breakout + 1, since));
      const reach = Math.min(Math.max(0, since - COLLAPSE.fall * 0.5) * NEUTRINO.speed * 0.8, STAR_RADIUS * 1.3);
      push('neutrinos', 'ui.element.neutrinos', towardScreen(-0.8, 0.55, dir).multiplyScalar(Math.max(reach, STAR_RADIUS * 1.2)), span(0.6, 1.3, 3.6, 4.6, since));

      // The debris, by element: hydrogen outermost, iron mixed out from the core (on its larger plume,
      // out past the silicon). Gone before the verse, with the blast wave's and the neutron star's tags.
      const debris = span(times.collapse + 13.5, times.collapse + 15.5, 39, 41, t);
      if (debris > 0) {
        push('debris-h', 'ui.element.h', remnant.pointAt(towardScreen(0.85, 0.55, dir), 0.98, scratch), debris);
        push('debris-o', 'ui.element.o', remnant.pointAt(towardScreen(-0.75, 0.6, dir), 0.62, scratch), debris);
        push('debris-si', 'ui.element.si', remnant.pointAt(towardScreen(-0.7, -0.65, dir), 0.42, scratch), debris);
        push('debris-fe', 'ui.element.fe', remnant.pointAt(dir.set(...IRON_PLUME), 0.48, scratch), debris);
      }
      // The blast wave's rim (upper left, clear of the caption) and the neutron star, once each has come.
      push('blast-wave', 'ui.element.shock', towardScreen(-0.62, 0.78, dir).multiplyScalar(rimRadius), span(breakout + REVEAL.rim[1] - 1.5, breakout + REVEAL.rim[1], 39, 41, t));
      push('neutron-star', 'ch06.tag.neutronStar', scratch.set(0, 0, 0), span(breakout + REVEAL.star[1] - 1.5, breakout + REVEAL.star[1], 39, 41, t), [84, 26]);

      // The pair, then the nickel-56 at the heart of the Type Ia.
      const pair = span(times.whiteDwarf + 2.5, times.whiteDwarf + 4, times.typeIa - 1.5, times.typeIa - 0.3, t);
      push('white-dwarf', 'ui.element.whiteDwarf', binary.dwarfPosition(scratch), pair);
      push('companion', 'ui.element.companion', binary.companionTop(scratch), pair);
      push('nickel', 'ui.element.ni', typeIa.pointAt(towardScreen(0.3, 0.2, dir), 0.15, scratch), span(times.typeIa + 4, times.typeIa + 5.5, times.typeIa + 11, times.typeIa + 12.5, t));
      return labels;
    },

    scale() {
      // Schematic (the star's layers) and compressed in time: no true scale to show.
      return null;
    },

    setQuality(profile) {
      setCounts(profile.tier);
    },

    exit() {
      root.removeFromParent();
    },

    dispose() {
      root.removeFromParent();
      star?.dispose();
      remnant?.dispose();
      typeIa?.dispose();
      binary?.dispose();
      neutrinos?.field.dispose();
      marks?.dispose();
      noise?.dispose();
      star = null;
      remnant = null;
      typeIa = null;
      binary = null;
      neutrinos = null;
      marks = null;
      noise = null;
      ctx = null;
    },
  };
}
