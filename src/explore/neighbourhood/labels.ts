/**
 * Names among the stars that never overlap (docs/NEIGHBOURHOOD.md, "Names"): pure. Candidates come
 * most important first (the star in view, the one under the pointer, then the brightest seen from
 * here); each takes its tag's box beside its point (as the HUD draws it: up and to the right) if that
 * is inside the part of the view the interface leaves clear and meets no box already taken.
 */

export interface LabelCandidate {
  id: string;
  text: string;
  /** Its point on the screen (CSS px from the canvas's top left). */
  x: number;
  y: number;
}

export interface ClearArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The HUD's tag beside its point (src/ui/styles/hud.css: 0.6rem right, 1.6rem up; 0.75rem type at 1.3 lines, 0.45rem padding each side): its box, and a margin between boxes. */
export const TAG = { dx: 9.6, dy: -25.6, height: 19, letter: 7.2, padding: 16, gap: 3 } as const;

export function tagBox(c: LabelCandidate): ClearArea {
  const left = c.x + TAG.dx;
  const top = c.y + TAG.dy;
  return { left, top, right: left + c.text.length * TAG.letter + TAG.padding, bottom: top + TAG.height };
}

/** The candidates (most important first) whose tags fit, at most `max`: their ids in that order. */
export function placeLabels(candidates: readonly LabelCandidate[], area: ClearArea, max: number): string[] {
  const taken: ClearArea[] = [];
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    const box = tagBox(c);
    if (box.left < area.left || box.right > area.right || box.top < area.top || box.bottom > area.bottom) continue;
    if (taken.some((t) => box.left < t.right + TAG.gap && t.left < box.right + TAG.gap && box.top < t.bottom + TAG.gap && t.top < box.bottom + TAG.gap)) continue;
    taken.push(box);
    out.push(c.id);
  }
  return out;
}
