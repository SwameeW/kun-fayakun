import type { ExploreTier } from '../detail';

/**
 * The laboratory's effects by the explorer's detail tier (docs/SANDBOX-ROADMAP.md W1.0): the explorer's
 * governor decides the tier (src/explore/quality); this only says what each tier draws, so a phone at
 * Low keeps its frame rate with the same physics. Every count here is decorative or a drawing's
 * fineness, never the model's.
 */
export interface LabEffects {
  /** Decorative dust points per impact plume (ledger IM-4). */
  plumePoints: number;
  /** Icosahedron subdivisions of the rocks' meshes for small, middling and large discs (./rocks). */
  rockDetail: readonly [number, number, number];
  /** A disc this many CSS px in radius or more takes the middling mesh, then the large one. */
  rockLodPx: readonly [number, number];
  /** Particles drawn as soft splats (the rest not drawn; the physics keeps them all). */
  splats: number;
  /** A ring seen whole drawn as a band (./annulus), and a star's glare. */
  annulus: boolean;
  glare: boolean;
}

export const LAB_EFFECTS: Readonly<Record<ExploreTier, LabEffects>> = {
  ultra: { plumePoints: 720, rockDetail: [1, 3, 5], rockLodPx: [16, 120], splats: 4000, annulus: true, glare: true },
  high: { plumePoints: 480, rockDetail: [1, 3, 5], rockLodPx: [16, 140], splats: 4000, annulus: true, glare: true },
  medium: { plumePoints: 320, rockDetail: [1, 2, 4], rockLodPx: [20, 160], splats: 4000, annulus: true, glare: true },
  low: { plumePoints: 160, rockDetail: [1, 2, 3], rockLodPx: [24, 200], splats: 2000, annulus: true, glare: false },
};

/** An unknown tier (a GPU Brave's Shields hide) is taken as Medium. */
export const effectsFor = (tier: ExploreTier | undefined): LabEffects => LAB_EFFECTS[tier ?? 'medium'];
