import { AdditiveBlending, BufferAttribute, BufferGeometry, LineBasicNodeMaterial, LineSegments, type Node } from 'three/webgpu';
import { attribute, uniform, vec3 } from 'three/tsl';
import type { SkyFile } from '../sky';
import type { Star } from './data';
import { cameraParts } from './field';

/**
 * The constellations' figures in space (docs/NEIGHBOURHOOD.md, "Figures"): each line of the sky's
 * figures (public/assets/sky/sky.json, the explorer's own) joined between the real places of the two
 * stars at its ends, where both are placed in space. From the Sun they are the figures of the night
 * sky; flown away from, they come apart, their stars at very different distances. Each line's end is
 * the star of the neighbourhood's file within a fifth of a degree of the figure's point (the Bright
 * Star Catalogue's stars are in it).
 */

/** How near on the sky (degrees) a figure's point and its star must be. */
const MATCH_DEG = 0.2;

export interface Figures {
  readonly object: LineSegments;
  /** The lines drawn (both ends placed). */
  readonly count: number;
  setShown(share: number): void;
  dispose(): void;
}

export function createFigures(sky: SkyFile, stars: readonly Star[], placeOf: (s: Star) => readonly [number, number, number] | null): Figures {
  // The placed stars by a grid of a degree on the sky.
  const grid = new Map<string, Star[]>();
  const key = (ra: number, dec: number): string => `${String(Math.floor(((ra % 360) + 360) % 360))}:${String(Math.floor(dec))}`;
  for (const s of stars) {
    if (!placeOf(s)) continue;
    const k = key(s.raDeg, s.decDeg);
    const list = grid.get(k);
    if (list) list.push(s);
    else grid.set(k, [s]);
  }
  const find = (ra: number, dec: number): Star | null => {
    let best: Star | null = null;
    let bestD = MATCH_DEG;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dd = -1; dd <= 1; dd += 1) {
        for (const s of grid.get(key(ra + dr, dec + dd)) ?? []) {
          let dRa = Math.abs(s.raDeg - ra) % 360;
          if (dRa > 180) dRa = 360 - dRa;
          const d = Math.hypot(dRa * Math.cos((dec * Math.PI) / 180), s.decDeg - dec);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
      }
    }
    return best;
  };
  const points: number[] = [];
  for (const c of sky.constellations) {
    for (const path of c.lines) {
      for (let i = 1; i < path.length; i += 1) {
        const [ra0 = 0, dec0 = 0] = path[i - 1] ?? [];
        const [ra1 = 0, dec1 = 0] = path[i] ?? [];
        const a = find(ra0, dec0);
        const b = find(ra1, dec1);
        const pa = a ? placeOf(a) : null;
        const pb = b ? placeOf(b) : null;
        if (pa && pb && a !== b) points.push(...pa, ...pb);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  const shown = uniform(0);
  const material = new LineBasicNodeMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  const at = attribute('position', 'vec3') as unknown as Node<'vec3'>;
  material.positionNode = at.sub(cameraParts.high).sub(cameraParts.low);
  material.colorNode = vec3(0.3, 0.4, 0.6).mul(shown);
  const object = new LineSegments(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = -2;
  object.name = 'explore-neighbourhood-figures';
  object.visible = false;
  return {
    object,
    count: points.length / 6,
    setShown(share) {
      shown.value = share;
      object.visible = share > 0.002;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
