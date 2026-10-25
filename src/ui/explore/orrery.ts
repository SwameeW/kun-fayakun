import type { BodyId, UniverseView } from '../../core/types';
import { svg } from '../dom';

/**
 * A compact orrery for the navigator, in the manner of an astrolabe's face: the planets where the
 * ephemeris puts them on the date, seen from above the ecliptic's north (so they go round
 * anticlockwise), on rings through their present distances from the Sun, inside a limb graduated in
 * ecliptic longitude (0 degrees toward the March equinox). Distances are compressed (square root)
 * so the inner planets do not crowd the Sun; the Moon sits beside the Earth in its true direction
 * but far out of scale; the caption says both. A marker shows where the camera is and which way it
 * looks; during a trip, a line runs to the destination.
 *
 * Tapping a world flies there. The map is a pointer shortcut (aria-hidden): the list beside it
 * offers the same moves to the keyboard and to screen readers.
 */

export interface Orrery {
  readonly element: SVGSVGElement;
  update(view: UniverseView): void;
}

const R = 84;
const LIMB = 93;
/** The Moon's place on the map, map units from the Earth (not to scale). */
const MOON_OFFSET = 7;
const DOT: Readonly<Record<BodyId, { r: number; fill: string }>> = {
  sun: { r: 4.2, fill: '#ffd27a' },
  earth: { r: 2.6, fill: '#8fc1ff' },
  moon: { r: 1.5, fill: '#d9d4ca' },
  jupiter: { r: 3.4, fill: '#e8cfa6' },
  mercury: { r: 2.2, fill: '#c5c1b9' },
  venus: { r: 2.2, fill: '#fff5d6' },
  mars: { r: 2.2, fill: '#e7a47b' },
  uranus: { r: 2.2, fill: '#b9dedb' },
  neptune: { r: 2.2, fill: '#b4d5dd' },
  saturn: { r: 3, fill: '#ecd9a8' },
};

export function createOrrery(onPick: (body: BodyId) => void, nameOf: (body: BodyId) => string): Orrery {
  const limb = svg('g', { class: 'kf-orrery-limb' });
  limb.append(svg('circle', { r: LIMB, class: 'kf-orrery-limb-ring' }));
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0;
    const len = major ? 4.5 : deg % 10 === 0 ? 2.8 : 1.4;
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = -Math.sin(a);
    limb.append(svg('line', { x1: (c * (LIMB - len)).toFixed(2), y1: (s * (LIMB - len)).toFixed(2), x2: (c * LIMB).toFixed(2), y2: (s * LIMB).toFixed(2), class: major ? 'kf-orrery-tick is-major' : 'kf-orrery-tick' }));
  }
  limb.append(svg('text', { x: LIMB - 9, y: -2.2, class: 'kf-orrery-zero' }, '0°'));
  const rings = svg('g', { class: 'kf-orrery-rings' });
  const route = svg('line', { class: 'kf-orrery-route', x1: 0, y1: 0, x2: 0, y2: 0, visibility: 'hidden' });
  const bodies = svg('g', { class: 'kf-orrery-bodies' });
  const camera = svg(
    'g',
    { class: 'kf-orrery-camera' },
    svg('circle', { r: 4.2, class: 'kf-orrery-camera-halo' }),
    svg('path', { d: 'M0,-3.6L2.4,2.6L0,1.3L-2.4,2.6Z', class: 'kf-orrery-camera-mark' }),
  );
  const sunGlow = svg('circle', { r: 9, class: 'kf-orrery-sun-glow' });
  const element = svg('svg', { class: 'kf-orrery', viewBox: '-100 -100 200 200', 'aria-hidden': 'true', focusable: 'false' }, limb, rings, sunGlow, route, bodies, camera);

  const ringOf = new Map<BodyId, SVGCircleElement>();
  const dotOf = new Map<BodyId, SVGGElement>();
  const ensure = (id: BodyId): SVGGElement => {
    const existing = dotOf.get(id);
    if (existing) return existing;
    const style = DOT[id];
    const group = svg(
      'g',
      { class: `kf-orrery-body kf-orrery-body--${id}`, 'data-body': id },
      // A pointer's tooltip (the map is hidden from screen readers; the list names every world).
      svg('title', {}, nameOf(id)),
      svg('circle', { r: 9, class: 'kf-orrery-hit' }),
      svg('circle', { r: style.r + 2.4, class: 'kf-orrery-focus' }),
      svg('circle', { r: style.r, fill: style.fill, class: 'kf-orrery-dot' }),
      id === 'saturn' ? svg('ellipse', { rx: style.r * 2, ry: style.r * 0.7, class: 'kf-orrery-saturn-ring' }) : null,
    );
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      onPick(id);
    });
    bodies.append(group);
    dotOf.set(id, group);
    if (id !== 'sun' && id !== 'moon') {
      const ring = svg('circle', { r: 0, class: 'kf-orrery-ring' });
      rings.append(ring);
      ringOf.set(id, ring);
    }
    return group;
  };

  return {
    element,
    update(view) {
      // The scale: the farthest present world (with a margin) sits just inside the limb.
      const helio = (e: { x: number; y: number }): number => Math.hypot(e.x, e.y);
      const outer = Math.max(...view.bodies.filter((b) => b.id !== 'moon').map((b) => helio(b.ecliptic)), 1) * 1.06;
      const map = (e: { x: number; y: number }): { x: number; y: number; r: number } => {
        const r = helio(e);
        const m = R * Math.sqrt(Math.min(1.25, r / outer));
        const a = Math.atan2(e.y, e.x);
        return { x: m * Math.cos(a), y: -m * Math.sin(a), r: m };
      };
      const earth = view.bodies.find((b) => b.id === 'earth');
      const place = (id: BodyId, e: { x: number; y: number }): { x: number; y: number; r: number } => {
        if (id === 'sun') return { x: 0, y: 0, r: 0 };
        if (id !== 'moon' || !earth) return map(e);
        // The Moon beside the Earth, in its true direction from it.
        const at = map(earth.ecliptic);
        const a = Math.atan2(e.y - earth.ecliptic.y, e.x - earth.ecliptic.x);
        return { x: at.x + MOON_OFFSET * Math.cos(a), y: at.y - MOON_OFFSET * Math.sin(a), r: 0 };
      };
      for (const body of view.bodies) {
        const p = place(body.id, body.ecliptic);
        const group = ensure(body.id);
        group.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
        group.classList.toggle('is-focus', body.id === view.focus);
        ringOf.get(body.id)?.setAttribute('r', p.r.toFixed(2));
      }
      // The camera: where it is (held to the limb when beyond the map) and which way it looks.
      const c = map(view.camera);
      const clamp = Math.min(1, (LIMB - 3) / Math.max(1e-9, Math.hypot(c.x, c.y)));
      const cx = c.x * clamp;
      const cy = c.y * clamp;
      const heading = (-view.camera.heading * 180) / Math.PI + 90;
      camera.setAttribute('transform', `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) rotate(${heading.toFixed(1)})`);
      const to = view.trip ? view.bodies.find((b) => b.id === view.focus) : undefined;
      if (to) {
        const p = place(to.id, to.ecliptic);
        route.setAttribute('x1', cx.toFixed(2));
        route.setAttribute('y1', cy.toFixed(2));
        route.setAttribute('x2', p.x.toFixed(2));
        route.setAttribute('y2', p.y.toFixed(2));
      }
      route.setAttribute('visibility', to ? 'visible' : 'hidden');
    },
  };
}
