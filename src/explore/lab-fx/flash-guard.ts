/**
 * The laboratory's flash guard (CONTRACTS rule 6; WCAG 2.2 success criterion 2.3.1): no part of the
 * view may flash more than three times a second, and this guard keeps the laboratory's own light (an
 * impact's fireball, a glow) to two, so the margin holds whatever else is on screen.
 *
 * A flash is a pair of opposing changes in relative luminance of 10 per cent or more where the darker
 * state is below 0.8 (or, for saturated red, any such pair: the red flash rule), over a combined area
 * of more than a quarter of 10 degrees of the visual field: at 1024 x 768 a tile of 341 x 256 CSS px,
 * scaled with the viewport.
 *
 * It guards each tile as a whole, once a frame: every effect in a tile adds the light it would show
 * there without rising this frame and the light it asks for (each its luminance times the share of the
 * tile it covers: add), and every rise in the tile is let through by the same share (kappa). Two
 * fireballs in one tile so make one light, never two levels that overwrite each other, and an effect
 * coming in dark (a fireball's first frame) changes nothing. A change counts when the tile's light
 * moves by a tenth of the share its effects cover (a tenth in luminance over all of it), where they
 * cover a quarter of the tile or more. The guard holds back a rise that would make a third pair within
 * a second, keeping the light just short of the change: it only slows rises (a fall is the effects'
 * own fade), so it lets a rise through only with room for the fall after it. It never makes a step of
 * its own: a rise held back stops where it is and, let go, goes on at its own eased pace (the effects'
 * rises are eased, at most a thirtieth of their peak a frame). The browser tests read the effects and
 * the canvas back frame by frame: that is the real check, this the runtime's.
 */

export const FLASH = {
  /** Flash pairs a second the guard allows (WCAG allows three). */
  pairsPerS: 2,
  /** A change counts at this much relative luminance, the darker state below `dark` (or saturated red at any level). */
  change: 0.1,
  dark: 0.8,
  /** The share of a tile effects must cover to count, and the window (s) flashes are counted over. */
  area: 0.25,
  windowS: 1,
  /** A tile: 10 degrees of the visual field at 1024 x 768 (CSS px), scaled with the viewport. */
  tile: { width: 341, height: 256, referenceWidth: 1024 },
} as const;

interface TileState {
  /** The frame it was last asked in, this frame's asks (light without rising, light asked: luminance times share; share) and whether any is a saturated red. */
  frame: number;
  held: number;
  asked: number;
  share: number;
  red: boolean;
  /** Resolved this frame: the light shown, and the share of each rise let through. */
  resolved: boolean;
  shown: number;
  kappa: number;
  /** Where the current excursion began (light), which way it goes (+1, -1, 0), whether it has counted as a change. */
  from: number;
  way: number;
  counted: boolean;
  /** When the changes counted were made (s). */
  times: number[];
}

export class FlashGuard {
  private readonly tiles = new Map<number, TileState>();
  private frameNo = 0;
  private nowS = 0;

  /** The tile a point (CSS px) is in, for a viewport `widthPx` wide. */
  static tileAt(x: number, y: number, widthPx: number): number {
    const scale = Math.max(widthPx, 1) / FLASH.tile.referenceWidth;
    const col = Math.floor(x / (FLASH.tile.width * scale));
    const row = Math.floor(y / (FLASH.tile.height * scale));
    return (row + 64) * 1024 + (col + 64);
  }

  /** The area of a tile (CSS px^2) at a viewport `widthPx` wide. */
  static tileArea(widthPx: number): number {
    const scale = Math.max(widthPx, 1) / FLASH.tile.referenceWidth;
    return FLASH.tile.width * FLASH.tile.height * scale * scale;
  }

  /** A new frame at wall time `nowS`. */
  begin(nowS: number): void {
    this.frameNo += 1;
    this.nowS = nowS;
  }

  /**
   * An effect's light in `tile` this frame: the luminance (relative, 0 to 1 and beyond) it would show
   * without rising (where it is, or where it falls to) and the luminance it asks for, over `share` of the
   * tile (0 to 1); `red` for a saturated red light.
   */
  add(tile: number, held: number, asked: number, share: number, red = false): void {
    let t = this.tiles.get(tile);
    if (!t) {
      t = { frame: this.frameNo, held: 0, asked: 0, share: 0, red: false, resolved: false, shown: 0, kappa: 1, from: 0, way: 0, counted: false, times: [] };
      this.tiles.set(tile, t);
    }
    if (t.frame !== this.frameNo) {
      // Nothing asked in the frames between: nothing of this light was shown there.
      if (t.frame < this.frameNo - 1) t.shown = 0;
      t.frame = this.frameNo;
      t.held = 0;
      t.asked = 0;
      t.share = 0;
      t.red = false;
      t.resolved = false;
    }
    const a = Math.max(0, asked) * Math.max(0, share);
    t.asked += a;
    t.held += Math.min(a, Math.max(0, held) * Math.max(0, share));
    t.share += Math.max(0, share);
    t.red ||= red;
  }

  /** The share of each rise in `tile` let through this frame (1: all; where nothing was added, 1): the tile is resolved the first time it is asked. */
  kappa(tile: number): number {
    const t = this.tiles.get(tile);
    if (!t || t.frame !== this.frameNo) return 1;
    if (!t.resolved) this.resolve(t);
    return t.kappa;
  }

  private resolve(t: TileState): void {
    t.resolved = true;
    const now = this.nowS;
    while (t.times.length > 0 && now - (t.times[0] ?? 0) > FLASH.windowS) t.times.shift();
    const asked = t.asked;
    const share = Math.min(1, t.share);
    // What may be shown: what is asked, or a rise held just short of a change.
    let allowed = asked;
    if (share >= FLASH.area) {
      const way = Math.sign(asked - t.shown);
      // A turn: the next excursion starts where this one ended.
      if (way !== 0 && way !== t.way) {
        t.from = t.shown;
        t.way = way;
        t.counted = false;
      }
      const threshold = FLASH.change * share;
      const counts = way !== 0 && Math.abs(asked - t.from) >= threshold && (t.red || Math.min(asked, t.from) / share < FLASH.dark);
      if (counts && !t.counted) {
        // Two changes make a pair, at most pairsPerS pairs in the window. The guard only slows rises (a fall is
        // the effects' own fade): a rise is let through only with room for the fall after it too, and otherwise
        // held just short of a change.
        if (way > 0 && t.times.length + 2 > 2 * FLASH.pairsPerS) allowed = Math.min(asked, Math.max(t.held, t.from + threshold * 0.95));
        else {
          t.times.push(now);
          t.counted = true;
        }
      }
    }
    // Each rise let through by the same share: what is allowed over what the rises ask, the rest held where it is.
    const rise = asked - t.held;
    t.kappa = rise > 1e-12 ? Math.min(1, Math.max(0, (allowed - t.held) / rise)) : 1;
    t.shown = t.held + t.kappa * rise;
  }

  /** Changes counted in a tile in the last window (for the tests). */
  changes(tile: number, nowS: number): number {
    const t = this.tiles.get(tile);
    return t ? t.times.filter((x) => nowS - x <= FLASH.windowS).length : 0;
  }

  clear(): void {
    this.tiles.clear();
  }
}
