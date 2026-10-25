/**
 * The explorer's bodies, each its own shader (never the chapters' objects or materials), at unit
 * radius: the explorer scales each one to its true radius (times the scaled-space factor) every frame
 * and turns it as the body really stands.
 *
 * Surfaces are the mission maps (assets/planets, streamed by ../assets/streaming): the Earth from Blue
 * Marble, Black Marble, ETOPO and Natural Earth, the Moon from LROC and LOLA, Jupiter and Saturn from
 * Hubble's OPAL, Saturn's rings from Cassini's radio occultation and colour mosaic. The Sun is
 * procedural (its limb darkening measured). Sizes, shapes (flattening), tilts, spins, phases and
 * lighting are real.
 *
 * Detail (../detail): setDetail() changes what every body draws (tessellation, the atmosphere model and
 * its steps, clouds and their shadows, night lights, relief, ring particles, the Sun's limb) and which
 * maps stream. New materials compile ahead (the caller's compile(), renderer.compileAsync) while the
 * old ones keep drawing; the switch happens only when they are ready, so a change never hitches.
 * setFocus() says which bodies' maps to raise to the detail's texture tier.
 */

import { Group, type Data3DTexture, type Object3D } from 'three/webgpu';
import type { BodyId } from '../../core/types';
import { planetCredits, ringColourGeometry, type PlanetBody } from '../assets/planets';
import type { PlanetTextures } from '../assets/streaming';
import type { ExploreDetail } from '../detail';
import type { AirModel, TransmittanceTable } from '../render/air';
import type { BodySpec } from '../system';
import { createEarth, type ExploreEarth } from './earth';
import { createGiant, type ExploreGiant } from './giant';
import { createMoon, type ExploreMoon } from './moon';
import { createSun, type ExploreSun, type SunLimb } from './sun';

/** The Sun's effective temperature, as Chapter 7 uses it (its colour, from the blackbody law). */
export const SUN_KELVIN = 5772;

export interface Bodies {
  readonly sun: ExploreSun;
  readonly earth: ExploreEarth;
  readonly moon: ExploreMoon;
  readonly jupiter: ExploreGiant;
  readonly saturn: ExploreGiant;
  readonly mercury: ExploreMoon;
  readonly mars: ExploreMoon;
  readonly venus: ExploreGiant;
  readonly uranus: ExploreGiant;
  readonly neptune: ExploreGiant;
  /** Every body's root object, by id. */
  readonly objects: Readonly<Record<BodyId, Group>>;
  /** Objects drawn in the render frame itself rather than a body's (Saturn's ring particles): add them to the scene's root. */
  readonly extras: readonly Object3D[];
  /** The detail level drawn now (a requested one is applied once its materials have compiled). */
  readonly detail: ExploreDetail;
  /** Changes what the bodies draw and stream; resolves once the new detail is on screen. */
  setDetail(detail: ExploreDetail): Promise<void>;
  /** The bodies whose maps should be raised to the detail's tier (the focus, a flight's destination). */
  setFocus(bodies: readonly BodyId[]): void;
  /** Per frame: texture streaming (fetches, one upload at most, eases). */
  update(dt: number): void;
  /** Leaving the explorer: drop every texture upgrade. */
  suspend(): void;
  /** The credits of the maps a body shows now. */
  credits(body: BodyId): string[];
  dispose(): void;
}

export interface BodiesOptions {
  noise: Data3DTexture;
  specs: Readonly<Record<BodyId, BodySpec>>;
  /** The ring strip's span (km from Saturn's centre). */
  ringSpanKm: readonly [number, number];
  textures: PlanetTextures;
  air: AirModel;
  /** The transmittance table ('scatter' detail), or null where it cannot be baked. */
  table: TransmittanceTable | null;
  sunLimb: SunLimb;
  /** The Sun's angular radius from the Moon (its shadows' penumbra), radians. */
  sunAngularRadius: number;
  detail: ExploreDetail;
  /** Compiles objects' materials ahead of their first use (renderer.compileAsync against the scene). */
  compile(objects: Object3D[]): Promise<void>;
}

const PLANETS: readonly PlanetBody[] = ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const isPlanet = (id: BodyId): id is PlanetBody => (PLANETS as readonly string[]).includes(id);

export function createBodies(options: BodiesOptions): Bodies {
  const { specs, textures } = options;
  let detail = options.detail;
  textures.setDetail(detail);
  const polar = (spec: BodySpec): number => spec.polarKm / spec.radiusKm;
  const uAt = (body: PlanetBody, map: 'colour' | 'day'): number => textures.manifest.files.find((f) => f.body === body && f.map === map)?.uAtLon0 ?? 0;
  const sun = createSun(options.noise, options.sunLimb, detail);
  const earth = createEarth(textures, options.noise, options.air, options.table, detail);
  const moon = createMoon(textures, options.sunAngularRadius, detail);
  const jupiter = createGiant(textures, { name: 'explore-jupiter', body: 'jupiter', polar: polar(specs.jupiter), uAtLon0: uAt('jupiter', 'colour'), flow: true }, detail);
  const radius = specs.saturn.radiusKm;
  const saturn = createGiant(
    textures,
    {
      name: 'explore-saturn',
      body: 'saturn',
      polar: polar(specs.saturn),
      uAtLon0: uAt('saturn', 'colour'),
      flow: false,
      rings: { inner: options.ringSpanKm[0] / radius, outer: options.ringSpanKm[1] / radius, mosaic: ringColourGeometry(textures.manifest) },
    },
    detail,
  );
  const mercury = createMoon(textures, options.sunAngularRadius, detail, { body: 'mercury', uAtLon0: uAt('mercury', 'colour'), polar: polar(specs.mercury) });
  const venus = createGiant(textures, { name: 'explore-venus', body: 'venus', polar: polar(specs.venus), uAtLon0: uAt('venus', 'colour'), flow: false }, detail);
  const mars = createMoon(textures, options.sunAngularRadius, detail, { body: 'mars', uAtLon0: uAt('mars', 'colour'), polar: polar(specs.mars) });
  const uranus = createGiant(textures, { name: 'explore-uranus', body: 'uranus', polar: polar(specs.uranus), uAtLon0: uAt('uranus', 'colour'), flow: false }, detail);
  const neptune = createGiant(textures, { name: 'explore-neptune', body: 'neptune', polar: polar(specs.neptune), uAtLon0: uAt('neptune', 'colour'), flow: false }, detail);
  const all = [sun, earth, moon, jupiter, saturn, mercury, venus, mars, uranus, neptune];
  let generation = 0;

  return {
    sun,
    earth,
    moon,
    jupiter,
    saturn,
    mercury, venus, mars, uranus, neptune,
    objects: { mercury: mercury.object, venus: venus.object, mars: mars.object, uranus: uranus.object, neptune: neptune.object, sun: sun.object, earth: earth.object, moon: moon.object, jupiter: jupiter.object, saturn: saturn.object },
    extras: saturn.rings?.particles ? [saturn.rings.particles.object] : [],
    get detail() {
      return detail;
    },
    async setDetail(next) {
      const token = (generation += 1);
      textures.setDetail(next);
      const pending = all.flatMap((b) => b.prepare(next));
      if (pending.length > 0) {
        const holder = new Group();
        holder.add(...pending);
        try {
          await options.compile([holder]);
        } catch (err) {
          // A material that fails to compile ahead is compiled on first draw instead.
          console.warn('explore: could not compile ahead', err);
        }
        holder.clear();
      }
      if (token !== generation) return;
      detail = next;
      for (const b of all) b.apply(next);
    },
    setFocus(bodies) {
      textures.setWanted(bodies.filter(isPlanet));
    },
    update(dt) {
      textures.update(dt);
    },
    suspend() {
      textures.suspend();
    },
    credits(body) {
      if (!isPlanet(body)) return [];
      return planetCredits(textures.boundFiles(body));
    },
    dispose() {
      for (const body of all) body.dispose();
      textures.dispose();
      options.table?.dispose();
    },
  };
}
