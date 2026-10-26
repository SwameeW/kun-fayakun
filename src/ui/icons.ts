import { svg } from './dom';

/** Small stroke icons (24-unit grid). Decorative: buttons carry their own text labels. */
const PATHS = {
  play: 'M8 5.5v13l10.5-6.5z',
  pause: 'M8 5.5v13M16 5.5v13',
  orbit: 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM3.5 12c0-2.2 3.8-4 8.5-4s8.5 1.8 8.5 4-3.8 4-8.5 4-8.5-1.8-8.5-4z',
  panel: 'M4 5h16v14H4zM14.5 5v14',
  keyboard: 'M3.5 7h17v10h-17zM7 10.5h.01M10 10.5h.01M13 10.5h.01M16 10.5h.01M8 14h8',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M6 15l6-6 6 6',
  back: 'M15 6l-6 6 6 6',
  slower: 'M18.5 6.5l-5.5 5.5 5.5 5.5M11 6.5L5.5 12l5.5 5.5',
  faster: 'M5.5 6.5l5.5 5.5-5.5 5.5M13 6.5l5.5 5.5-5.5 5.5',
  reverse: 'M9 5.5L4.5 10 9 14.5M4.5 10h10a5 5 0 0 1 0 10H11',
  photo: 'M4 8h3.5l2-2.5h5l2 2.5H20v10.5H4zM12 10.2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set(['play']);

export function icon(name: IconName): SVGSVGElement {
  const filled = FILLED.has(name);
  return svg(
    'svg',
    {
      class: `kf-icon kf-icon--${name}`,
      viewBox: '0 0 24 24',
      width: 20,
      height: 20,
      'aria-hidden': 'true',
      focusable: 'false',
      fill: filled ? 'currentColor' : 'none',
      stroke: 'currentColor',
      'stroke-width': filled ? 1 : 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    svg('path', { d: PATHS[name] }),
  );
}
