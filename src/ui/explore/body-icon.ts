import type { BodyId, UniverseBodyView } from '../../core/types';
import { svg, uniqueId } from '../dom';

/**
 * A small live portrait of each body for the navigator: its disc lit as the camera sees it now (the
 * phase and the side the Sun is on, from the ephemeris), Saturn with its rings opened as they are
 * from here. Colours are a gentle likeness (decorative, aria-hidden: the list says the rest in text).
 */

export interface BodyIcon {
  readonly element: SVGSVGElement;
  update(view: UniverseBodyView): void;
}

const STYLE: Readonly<Record<BodyId, { lit: [string, string]; night: string }>> = {
  sun: { lit: ['#fff4d6', '#f2a63c'], night: '#f2a63c' },
  earth: { lit: ['#bfe0ff', '#2e68a8'], night: '#0a1522' },
  moon: { lit: ['#f1ede4', '#9d988e'], night: '#121212' },
  jupiter: { lit: ['#f6e6cc', '#c49a6c'], night: '#16110c' },
  saturn: { lit: ['#f6e7c1', '#c9a96a'], night: '#15120b' },
};

/** The lit part of a unit disc, bright limb toward +x, for a lit share k (0 new, 1 full). */
export function phasePath(k: number): string {
  const lit = Math.min(1, Math.max(0, k));
  if (lit >= 0.999) return 'M0,-1A1,1 0 1 1 0,1A1,1 0 1 1 0,-1Z';
  if (lit <= 0.001) return '';
  const rx = Math.abs(2 * lit - 1).toFixed(4);
  // Right half-circle from the top down, then the terminator back up: bulging left past half (gibbous), right before (crescent).
  return `M0,-1A1,1 0 0 1 0,1A${rx},1 0 0 ${lit > 0.5 ? 1 : 0} 0,-1Z`;
}

export function createBodyIcon(id: BodyId): BodyIcon {
  const style = STYLE[id];
  const gradient = uniqueId(`icon-${id}`);
  const clip = uniqueId(`clip-${id}`);
  const defs = svg(
    'defs',
    {},
    svg(
      'radialGradient',
      { id: gradient, cx: '35%', cy: '30%', r: '75%' },
      svg('stop', { offset: '0%', 'stop-color': style.lit[0] }),
      svg('stop', { offset: '100%', 'stop-color': style.lit[1] }),
    ),
    svg('clipPath', { id: clip }, svg('circle', { r: 1 })),
  );
  const night = svg('circle', { r: 1, fill: style.night });
  const lit = svg('path', { d: phasePath(1), fill: `url(#${gradient})` });
  const litGroup = svg('g', {}, lit);
  const parts: SVGElement[] = [defs];
  let ringBack: SVGEllipseElement | null = null;
  let ringFront: SVGPathElement | null = null;
  if (id === 'saturn') {
    ringBack = svg('ellipse', { rx: 1.85, ry: 0.4, fill: 'none', stroke: '#d9c393', 'stroke-width': 0.22, opacity: 0.55 });
    ringFront = svg('path', { d: '', fill: 'none', stroke: '#e6d2a4', 'stroke-width': 0.22, opacity: 0.85 });
    parts.push(ringBack);
  }
  if (id === 'sun') {
    parts.push(svg('circle', { r: 1.45, fill: '#f2a63c', opacity: 0.18 }), svg('circle', { r: 1.18, fill: '#f8c35a', opacity: 0.25 }));
  }
  parts.push(night, litGroup);
  if (id === 'jupiter') {
    // Belts, faint, over both day and night (clipped to the disc).
    const belts = svg('g', { 'clip-path': `url(#${clip})`, opacity: 0.35 });
    for (const [y, h] of [[-0.42, 0.16], [-0.05, 0.12], [0.28, 0.17]] as const) belts.append(svg('rect', { x: -1, y, width: 2, height: h, fill: '#7a4f2c' }));
    parts.push(belts);
  }
  if (ringFront) parts.push(ringFront);
  const element = svg('svg', { class: `kf-body-icon kf-body-icon--${id}`, viewBox: id === 'saturn' ? '-2.1 -1.25 4.2 2.5' : '-1.5 -1.5 3 3', 'aria-hidden': 'true', focusable: 'false' }, ...parts);

  let shown = '';
  return {
    element,
    update(view) {
      const opening = view.ringOpening;
      const key = `${view.lit.toFixed(3)}:${view.limbAngle.toFixed(2)}:${opening.toFixed(3)}`;
      if (key === shown) return;
      shown = key;
      if (id !== 'sun') {
        lit.setAttribute('d', phasePath(view.lit));
        // Screen angles count counterclockwise; SVG rotates clockwise (its y points down).
        litGroup.setAttribute('transform', `rotate(${((-view.limbAngle * 180) / Math.PI).toFixed(1)})`);
      }
      if (ringBack && ringFront) {
        const ry = Math.max(0.03, 1.85 * Math.abs(Math.sin(opening)));
        ringBack.setAttribute('ry', ry.toFixed(3));
        // The near half of the rings passes in front of the globe: the lower half when seen from above the lit face.
        const sweep = opening >= 0 ? 0 : 1;
        ringFront.setAttribute('d', `M-1.85,0A1.85,${ry.toFixed(3)} 0 0 ${sweep} 1.85,0`);
      }
    },
  };
}
