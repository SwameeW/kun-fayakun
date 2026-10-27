/**
 * Boxes and discs on screen (CSS px), pure (no three.js): what the worlds' names (./index) keep off,
 * and the unit tests check.
 */

/** Whether a box (CSS px: left, top, width, height) meets a disc (centre and radius, px). */
export function boxMeetsCircle(x: number, y: number, w: number, h: number, cx: number, cy: number, r: number): boolean {
  return Math.hypot(Math.min(x + w, Math.max(x, cx)) - cx, Math.min(y + h, Math.max(y, cy)) - cy) < r;
}

/**
 * Whether a box (CSS px) meets a convex outline (its corners in order, x and y in turn): neither the
 * box's sides nor any of the outline's edges separate them.
 */
export function boxMeetsConvex(x: number, y: number, w: number, h: number, outline: readonly number[]): boolean {
  const n = outline.length / 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < n; k += 1) {
    const px = outline[2 * k] ?? 0;
    const py = outline[2 * k + 1] ?? 0;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  if (maxX <= x || minX >= x + w || maxY <= y || minY >= y + h) return false;
  for (let k = 0; k < n; k += 1) {
    const ax = outline[2 * k] ?? 0;
    const ay = outline[2 * k + 1] ?? 0;
    const nx = (outline[2 * ((k + 1) % n) + 1] ?? 0) - ay;
    const ny = -((outline[2 * ((k + 1) % n)] ?? 0) - ax);
    // The outline's extent along this edge's normal, and the box's.
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < n; j += 1) {
      const d = ((outline[2 * j] ?? 0) - ax) * nx + ((outline[2 * j + 1] ?? 0) - ay) * ny;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    let blo = Infinity;
    let bhi = -Infinity;
    for (const [cx, cy] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ] as const) {
      const d = (cx - ax) * nx + (cy - ay) * ny;
      blo = Math.min(blo, d);
      bhi = Math.max(bhi, d);
    }
    if (bhi <= lo || blo >= hi) return false;
  }
  return true;
}
