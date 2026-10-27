import type { PlanetsFile } from '../../astro/ephemeris';
import type { PhysicalFile } from '../../astro/physical';
import worldsMessages from '../../i18n/en.worlds.json';
import type { App, BodyId, FocusId, UniverseView } from '../../core/types';
import { worldFacts, type WorldFacts } from '../../explore/about';
import { h, svg } from '../dom';
import type { Formatters } from './format';
import { helpButton } from './help';

/**
 * The navigator's "About" the world in view (SpaceEngine's wiki), from cited data only
 * (src/explore/about computes it from JPL's files): its size, mass, density, gravity and escape
 * speed, its day (one turn, and sunrise to sunrise), its year and orbit, its axial tilt, how far it
 * is now (live), and a size comparison drawn to scale beside the Earth (the Earth's beside the Moon),
 * with its sources named. A definition list, rewritten when the world in view changes; the live
 * distance only on the navigator's slow ticks. Its own chunk (./sections), loaded the first time the
 * section opens: the section and its summary (the world's name) are the navigator's.
 *
 * A small world flown to (src/explore/worlds) gets its own short list from the view: what it is (and
 * what it goes round: Charon, Pluto), its size (an ellipsoid's three axes where measured; where its
 * shape is not, a sphere of its mean radius stands in, and it says so), albedo, day and distance from
 * the Sun, beside the Moon to scale; its map's credit and the share of it never imaged. Its strings come
 * with the small worlds' (src/i18n/en.worlds.json).
 */

export interface About {
  readonly body: HTMLElement;
  /** `open`: whether the section shows (the live distance is written only then). */
  update(view: UniverseView, slow: boolean, open: boolean): void;
}

const PLANETS_URL = 'assets/jpl/planets.json';
/** src/astro/physical's file (named here, so this chunk takes none of that module's code with it). */
const PHYSICAL_URL = 'assets/jpl/physical.json';
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** The comparison's larger disc, in its drawing's units (the drawing is 220 wide). */
const DISC = 80;
const MIN_DISC = 1.6;

export function createAbout(app: App, f: Formatters): About {
  const { i18n } = app;
  let files: { physical: PhysicalFile; planets: PlanetsFile } | null = null;
  /** The world the list was built for (null: build it again on the next update). */
  let shown: FocusId | null = null;
  i18n.extend('en.worlds.json', worldsMessages);
  void Promise.all([app.assets.json<PhysicalFile>(PHYSICAL_URL), app.assets.json<PlanetsFile>(PLANETS_URL)])
    .then(([physical, planets]) => {
      files = { physical, planets };
      shown = null;
    })
    .catch((err: unknown) => {
      console.warn('explore: the object information could not be loaded', err);
    });

  const facts = h('dl', { class: 'kf-about-facts', 'data-testid': 'universe-about-facts' });
  // The world in a few plain words, behind its "?".
  const plain = h('p', { class: 'kf-help-row kf-about-plain' });
  const picture = h('figure', { class: 'kf-about-compare' });
  const sources = h('p', { class: 'kf-about-sources' });
  const body = h('div', { class: 'kf-about-body' }, plain, facts, picture, sources);

  const km = (value: number): string => f.keep(i18n.t('ui.hud.unit.km', { value: f.number(value, value < 10_000 ? 1 : 0) }));
  /** A number of three figures in powers of ten: "1.90 × 10²⁷". */
  const scientific = (value: number): string => {
    const exponent = Math.floor(Math.log10(value));
    const mantissa = value / 10 ** exponent;
    const digits = String(Math.abs(exponent)).split('').map((d) => SUPERSCRIPT[Number(d)] ?? d).join('');
    return `${f.number(mantissa, 2)} × 10${exponent < 0 ? '⁻' : ''}${digits}`;
  };
  /** "11.0 times the Earth's" or "0.107 of the Earth's" (three figures). */
  const relative = (ratio: number): string => {
    const value = f.number(Number(ratio.toPrecision(3)), 6);
    return i18n.t(ratio >= 1 ? 'ui.universe.about.timesEarth' : 'ui.universe.about.ofEarth', { value });
  };
  /** A period: hours and minutes below two days, days to two decimals below two years, else years. */
  const period = (days: number): string => {
    const d = Math.abs(days);
    if (d < 2) return f.hours(d * 24);
    return f.keep(i18n.t('ui.universe.about.days', { value: f.number(d, d < 100 ? 2 : 0) }));
  };
  const au = (kmValue: number, auKm: number): string => f.keep(i18n.t('ui.hud.unit.au', { value: f.number(kmValue / auKm, 3) }));

  /** A fact, its term with a "?" in plain words where `topic` names one. */
  const row = (term: string, detail: string, testId: string, topic?: string): HTMLElement[] => [h('dt', {}, term, topic ? helpButton(app, topic, term) : null), h('dd', { 'data-testid': `about-${testId}` }, detail)];

  /** The world beside its comparison, both to the same scale. */
  const compare = (a: Pick<WorldFacts, 'meanRadiusKm'> & { id: FocusId }, b: Pick<WorldFacts, 'meanRadiusKm'> & { id: FocusId }): void => {
    const big = Math.max(a.meanRadiusKm, b.meanRadiusKm);
    const r = (x: { meanRadiusKm: number }): number => Math.max(MIN_DISC, (DISC / 2) * (x.meanRadiusKm / big));
    const ra = r(a);
    const rb = r(b);
    const cy = DISC / 2 + 4;
    const ax = 8 + ra;
    const bx = ax + ra + 24 + rb;
    const disc = (x: number, radius: number, cls: string): SVGCircleElement => svg('circle', { cx: x.toFixed(2), cy: cy.toFixed(2), r: radius.toFixed(2), class: cls });
    const label = (x: number, text: string): SVGTextElement => svg('text', { x: x.toFixed(2), y: (cy + DISC / 2 + 16).toFixed(2), 'text-anchor': 'middle', class: 'kf-about-label' }, text);
    picture.replaceChildren(
      svg('svg', { viewBox: `0 0 ${Math.max(220, bx + rb + 8).toFixed(0)} ${(DISC + 28).toFixed(0)}`, class: 'kf-about-drawing', 'aria-hidden': 'true' }, disc(ax, ra, 'kf-about-disc'), disc(bx, rb, 'kf-about-disc kf-about-disc--other'), label(ax, f.name(a.id)), label(bx, f.name(b.id))),
      h('figcaption', {}, i18n.t(a.meanRadiusKm >= b.meanRadiusKm ? 'ui.universe.about.compareWider' : 'ui.universe.about.compareNarrower', { body: f.name(a.id), other: f.name(b.id), ratio: f.number(Number((a.meanRadiusKm / b.meanRadiusKm).toPrecision(3)), 6) })),
    );
  };

  let nowDetail: HTMLElement | null = null;
  const build = (id: BodyId, view: UniverseView): void => {
    if (!files) return;
    const { physical, planets } = files;
    const w = worldFacts(id, physical, planets);
    const earth = worldFacts('earth', physical, planets);
    const name = f.name(id);
    plain.replaceChildren(h('span', {}, i18n.t('ui.universe.about.plain', { body: name })), helpButton(app, `body.${id}`, name));
    const isEarth = id === 'earth';
    const items: HTMLElement[] = [
      ...row(i18n.t('ui.universe.about.radius'), isEarth ? km(w.meanRadiusKm) : `${km(w.meanRadiusKm)}, ${relative(w.meanRadiusKm / earth.meanRadiusKm)}`, 'radius', 'radius'),
      ...row(i18n.t('ui.universe.about.mass'), `${scientific(w.massKg)} kg${isEarth ? '' : `, ${relative(w.massEarths)}`}`, 'mass', 'mass'),
      ...row(i18n.t('ui.universe.about.density'), i18n.t('ui.universe.about.densityValue', { value: f.number(w.densityGcm3, 2) }), 'density', 'density'),
      ...row(
        i18n.t(w.gravityAt === 'equator' ? 'ui.universe.about.gravityEquator' : 'ui.universe.about.gravitySurface'),
        `${i18n.t('ui.universe.about.gravityValue', { value: f.number(w.gravityMs2, w.gravityMs2 < 10 ? 2 : 1) })}${isEarth ? '' : `, ${relative(w.gravityEarths)}`}`,
        'gravity',
        'gravity',
      ),
      ...row(i18n.t('ui.universe.about.escape'), f.keep(i18n.t('ui.universe.about.speedValue', { value: f.number(w.escapeKmS, w.escapeKmS < 100 ? 2 : 1) })), 'escape', 'escape'),
      ...row(
        i18n.t('ui.universe.about.day'),
        w.solarDayDays === null
          ? i18n.t('ui.universe.about.turn', { period: period(w.rotationDays) })
          : i18n.t(w.rotationDays < 0 ? 'ui.universe.about.turnBackSolar' : 'ui.universe.about.turnSolar', { period: period(w.rotationDays), solar: period(w.solarDayDays) }),
        'day',
        'day',
      ),
    ];
    const o = w.orbit;
    if (o?.around === 'sun' && o.semiMajorKm !== null) {
      const years = o.periodDays / 365.25;
      items.push(
        ...row(i18n.t('ui.universe.about.year'), years >= 1 && !isEarth ? i18n.t('ui.universe.about.years', { years: f.number(years, 2), days: f.number(o.periodDays, 0) }) : f.keep(i18n.t('ui.universe.about.days', { value: f.number(o.periodDays, 2) })), 'year', 'year'),
        ...row(
          i18n.t('ui.universe.about.orbit'),
          i18n.t(isEarth ? 'ui.universe.about.orbitEarth' : 'ui.universe.about.orbitValue', {
            au: au(o.semiMajorKm, physical.auKm),
            km: f.distanceWords(o.semiMajorKm),
            e: f.number(o.eccentricity ?? 0, 3),
            i: f.number(Math.abs(o.inclinationDeg ?? 0), 2),
          }),
          'orbit',
          'orbit',
        ),
      );
    } else if (o?.around === 'earth') {
      items.push(...row(i18n.t('ui.universe.about.orbit'), i18n.t('ui.universe.about.orbitMoon', { period: period(o.periodDays) }), 'orbit', 'orbit'));
    }
    if (w.tiltDeg !== null) {
      items.push(...row(i18n.t(w.kind === 'planet' ? 'ui.universe.about.tilt' : 'ui.universe.about.tiltEcliptic'), i18n.t('ui.universe.about.degrees', { value: f.number(w.tiltDeg, w.tiltDeg < 10 ? 2 : 1) }), 'tilt', 'tilt'));
    }
    const now = row(i18n.t(id === 'moon' ? 'ui.universe.about.nowEarth' : id === 'sun' ? 'ui.universe.about.nowFromEarth' : 'ui.universe.about.nowSun'), '', 'now', id === 'moon' || id === 'sun' ? 'distance' : 'fromSun');
    nowDetail = now[1] ?? null;
    items.push(...now);
    facts.replaceChildren(...items);
    compare(w, isEarth ? worldFacts('moon', physical, planets) : earth);
    sources.textContent = i18n.t('ui.universe.about.sources', { list: w.sources.map((s) => i18n.t(`ui.universe.about.source.${s}`)).join(' · ') });
    shown = id;
    writeNow(view);
  };

  /** A small world: what it is, its size and shape, albedo, day and distance from the Sun (live), beside the Moon. */
  const buildWorld = (w: NonNullable<NonNullable<UniverseView['worlds']>['focus']>): void => {
    shown = w.id;
    plain.replaceChildren(h('span', {}, i18n.t('ui.universe.worlds.about.plain', { body: w.name, kind: w.kind, host: f.name(w.host) })));
    const [a = 0, b = 0, c = 0] = [...w.axesKm].sort((x, y) => y - x);
    const size = w.sizeFromH
      ? i18n.t('ui.universe.worlds.about.fromH', { radius: km(w.radiusKm) })
      : !w.shaped
        ? i18n.t('ui.universe.worlds.about.sphere', { radius: km(w.radiusKm) })
        : a - c < 0.01 * a
          ? i18n.t('ui.universe.worlds.about.radius', { radius: km(w.radiusKm) })
          : i18n.t('ui.universe.worlds.about.axes', { a: km(2 * a), b: km(2 * b), c: km(2 * c) });
    const day = w.kind === 'moon' && w.rotationHours === null ? i18n.t('ui.universe.worlds.about.facesHost', { body: f.name(w.host) }) : w.rotationHours === null ? '—' : period(w.rotationHours / 24);
    const items = [
      ...row(i18n.t('ui.universe.worlds.about.size'), size, 'size'),
      ...row(i18n.t('ui.universe.worlds.about.albedo'), w.albedo === null ? i18n.t('ui.universe.worlds.about.albedoUnknown') : i18n.t('ui.universe.worlds.about.albedoValue', { value: f.number(w.albedo, 3) }), 'albedo'),
      ...row(i18n.t('ui.universe.worlds.about.day'), day, 'day'),
    ];
    const now = row(i18n.t('ui.universe.worlds.about.sunNow'), '', 'now');
    nowDetail = now[1] ?? null;
    items.push(...now);
    facts.replaceChildren(...items);
    compare({ id: w.id, meanRadiusKm: w.radiusKm }, { id: 'moon', meanRadiusKm: files ? worldFacts('moon', files.physical, files.planets).meanRadiusKm : 1737.4 });
    const surface = w.map ? i18n.t('ui.universe.worlds.about.map', { credit: w.map }) : i18n.t('ui.universe.worlds.about.surface');
    const gaps = w.map && w.unimaged >= 0.02 ? ` ${i18n.t('ui.universe.worlds.about.unimaged', { percent: Math.round(w.unimaged * 100) })}` : '';
    sources.textContent = `${surface}${gaps} ${i18n.t('ui.universe.worlds.about.sources')}`;
  };

  const writeNow = (view: UniverseView): void => {
    const world = view.worlds?.focus;
    if (world && nowDetail) {
      const text = f.keep(i18n.t('ui.hud.unit.au', { value: f.number(world.sunAu, 3) }));
      if (nowDetail.textContent !== text) nowDetail.textContent = text;
      return;
    }
    if (!nowDetail || !files || view.focus.startsWith('w:')) return;
    const at = (id: BodyId): { x: number; y: number; z: number } | undefined => view.bodies.find((b) => b.id === id)?.ecliptic;
    const body = at(view.focus as BodyId);
    const earth = at('earth');
    if (!body || !earth) return;
    const km = view.focus === 'moon' || view.focus === 'sun' ? Math.hypot(body.x - earth.x, body.y - earth.y, body.z - earth.z) : Math.hypot(body.x, body.y, body.z);
    const text = view.focus === 'moon' ? f.distance(km) : au(km, files.physical.auKm);
    if (nowDetail.textContent !== text) nowDetail.textContent = text;
  };

  return {
    body,
    update(view, slow, open) {
      const world = view.worlds?.focus;
      if (world) {
        if (world.id !== shown) buildWorld(world);
        if (slow && open) writeNow(view);
      } else if (view.focus.startsWith('w:')) return;
      else if (view.focus !== shown) build(view.focus as BodyId, view);
      else if (slow && open) writeNow(view);
    },
  };
}
