/**
 * The laboratory's flash guard (CONTRACTS rule 6; WCAG 2.2 success criterion 2.3.1): no part of the
 * view may flash more than three times a second, and this guard keeps the laboratory's own light (an
 * impact's fireball, a glow) to two, so the margin holds whatever else is on screen.
 *
 * A flash is a pair of opposing changes in relative luminance of 10 per cent or more where the darker
 * state is below 0.8 (or, for saturated red, any such pair: the red flash rule), over a combined area
 * of more than a quarter of 10 degrees of the visual field: at 1024 x 768 a tile of 341 x 256 CSS px,
 * scaled with the viewport. Each effect reports, for the tile it is in, the luminance it would show
 * there and the share of the tile it covers; the guard holds back any change that would make a third
 * pair within a second (it keeps the luminance just short of the change), and lets through what covers
 * too little of a tile to count. The browser tests read the canvas back frame by frame: that is the
 * real check, this the runtime's.
 */

export const FLASH = {
  /** Flash pairs a second the guard allows (WCAG allows three). */
  pairsPerS: 2,
  /** A change counts at this much relative luminance, the darker state below `dark` (or saturated red at any level). */
  change: 0.1,
  dark: 0.8,
  /** The share of a tile an effect must cover to count, and the window (s) flashes are counted over. */
  area: 0.25,
  windowS: 1,
  /** A tile: 10 degrees of the visual field at 1024 x 768 (CSS px), scaled with the viewport. */
  tile: { width: 341, height: 256, referenceWidth: 1024 },
} as const;

interface TileState {
  level: number;
  /** Where the current excursion began, which way it goes (+1, -1, 0), whether it has counted as a change. */
  from: number;
  way: number;
  counted: boolean;
  /** When the changes counted were made (s). */
  times: number[];
}

export class FlashGuard {
  private readonly tiles = new Map<number, TileState>();

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

  /**
   * The luminance (relative, 0 to 1 and beyond) an effect may show now in `tile`, asking for `requested`
   * over `area` of it (a share, 0 to 1), at time `nowS`; `red` for a saturated red light.
   */
  limit(tile: number, requested: number, area: number, nowS: number, red = false): number {
    let t = this.tiles.get(tile);
    if (!t) {
      t = { level: requested, from: requested, way: 0, counted: false, times: [] };
      this.tiles.set(tile, t);
      return requested;
    }
    while (t.times.length > 0 && nowS - (t.times[0] ?? 0) > FLASH.windowS) t.times.shift();
    if (area < FLASH.area) {
      t.level = requested;
      t.from = requested;
      t.way = 0;
      t.counted = false;
      return requested;
    }
    const way = Math.sign(requested - t.level);
    if (way === 0) return t.level;
    // A turn: the next excursion starts where this one ended.
    if (way !== t.way) {
      t.from = t.level;
      t.way = way;
      t.counted = false;
    }
    const counts = Math.abs(requested - t.from) >= FLASH.change && (red || Math.min(requested, t.from) < FLASH.dark);
    if (counts && !t.counted) {
      // Two changes make a pair: at most pairsPerS pairs in the window.
      if (t.times.length >= 2 * FLASH.pairsPerS) {
        t.level = t.from + way * FLASH.change * 0.95;
        return t.level;
      }
      t.times.push(nowS);
      t.counted = true;
    }
    t.level = requested;
    return requested;
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
