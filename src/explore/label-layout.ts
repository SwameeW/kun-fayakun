/**
 * Where the laboratory's names go (docs/SANDBOX-ROADMAP.md W1.10): the layout the explorer runs each
 * frame for them (./index declutterLab, which finds each name's point on screen and whether it can show
 * at all: in front, inside the clear view, not behind a world), kept apart from the explorer so the unit
 * tests check it alone (tests/unit/label-layout.spec.ts).
 *
 * The most important first (the chosen body's own names and marks, rank unset; then by rank: the larger
 * body), each tries the four corners about its point, keeping the one it had while it has room there:
 * a name showing gives way once another comes within NAME_MARGIN_PX (so its quick fade is done before
 * they would meet), and one comes in only with twice that room, and NAME_MARGIN_PX inside the clear view
 * and off the interface, and only where no other name shows (so, once in, a few pixels' movement does not
 * send it out again, nor does a greater name coming in: no flicker at the edge of room); clear of the
 * interface (inside the
 * clear view, off the rectangles over it), of the names already given a corner and, but for the chosen
 * body's, of the worlds' names. One coming in, or moving to another corner, waits until nothing else
 * still shows where it goes; one with no corner fades out. Names ease in and out (`show`, `hide`: the
 * share of what is left a frame), and whatever the easing leaves, two never show over each other: by
 * rank, a name whose box meets one shown before it gives way at once, and a world's name under the chosen
 * body's gives way to it (`giveWay`). Nothing is allocated but a new name's entries.
 */

/** The corners a name may take about its point (CSS px, its leader's end): up and right first, then up-left, down-right, down-left. */
export const NAME_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [10, -10],
  [-10, -10],
  [10, 18],
  [-10, 18],
];
/** Numbers kept per name (`geom`): its point (x, y), its tag's width, whether it shows (0: it cannot; 1: it may; 2: given a corner this frame), its box (left, top) at the corner it had. */
export const NAME_GEOM = 6;
/** A tag's height (CSS px); the room a name showing keeps from another before it gives way (one coming in needs twice it); the opacity below which a name counts as gone (one taking its place may come in). */
export const NAME_TAG_PX = 21;
export const NAME_MARGIN_PX = 8;
export const NAME_HANDOVER = 0.08;

/** A name: its id, its rank (unset: the chosen body's own), the opacity asked for (and, once laid out, shown) and the corner it is given. */
export interface NameLabel {
  id: string;
  rank?: number;
  opacity: number;
  offset?: readonly [number, number];
  /** Whether the name may take a box (CSS px: left, top, width, height); false where it would cover what it must not (a small world's name keeps off every disc). */
  fits?(x: number, y: number, w: number, h: number): boolean;
}

/** What a name must keep clear of, and the worlds' names it meets (by id, ids `W`). */
export interface NameView<W> {
  /** The clear view (CSS px): every box inside it. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** The interface over the view (the way back, a readout's card). */
  avoid: ReadonlyArray<{ left: number; top: number; right: number; bottom: number }>;
  /** The worlds' names placed this frame (boxes' top left, `worldW` by `worldH`), the first `takenCount`. */
  taken: ReadonlyArray<{ x: number; y: number }>;
  takenCount: number;
  worldW: number;
  worldH: number;
  /** Each world, whether its name still shows over a box, and its name giving way at once. */
  worlds: readonly W[];
  worldAt(id: W, x: number, y: number, w: number, h: number): boolean;
  giveWay(id: W): void;
}

/** What is kept from frame to frame (place and fade, by id) and reused within one (order, boxes, shown: four numbers each, its box and 1 for the chosen body's). */
export interface NameState {
  place: Map<string, number>;
  fade: Map<string, number>;
  order: number[];
  boxes: Array<{ x: number; y: number; w: number }>;
  shown: number[];
}

const rankOf = (label: NameLabel | undefined): number => label?.rank ?? Number.MAX_VALUE;

/** A name's box (left, top) at a corner, from its point and width in `geom`. */
export function nameBox(geom: readonly number[], j: number, spot: number, out: 'x' | 'y'): number {
  const [dx, dy] = NAME_SPOTS[spot] ?? [0, 0];
  const g = j * NAME_GEOM;
  return out === 'x' ? (dx < 0 ? (geom[g] ?? 0) + dx - (geom[g + 2] ?? 0) : (geom[g] ?? 0) + dx) : (geom[g + 1] ?? 0) + dy - NAME_TAG_PX / 2;
}

/**
 * Lays out `count` names from `labels[from]` (their points, widths and whether each can show already in
 * `geom`, NAME_GEOM numbers each): sets each name's corner (`offset`) and the opacity it shows at
 * (`opacity`, eased from what it asks for), and its box at the corner it had (`geom` 4 and 5) for the
 * next frame. `entering`: the view has just come (names take what they ask at once).
 */
export function layoutNames<W>(labels: NameLabel[], from: number, count: number, geom: number[], view: NameView<W>, state: NameState, show: number, hide: number, entering: boolean): void {
  const h = NAME_TAG_PX;
  const { place, fade, order, boxes } = state;
  const meets = (ax: number, ay: number, aw: number, bx: number, by: number, bw: number, pad: number): boolean => ax - pad < bx + bw && bx < ax + aw + pad && ay - pad < by + h && by < ay + h + pad;
  order.length = 0;
  for (let j = 0; j < count; j += 1) {
    const label = labels[from + j];
    if (!label) continue;
    order.push(j);
    const had = place.get(label.id) ?? 0;
    geom[j * NAME_GEOM + 4] = nameBox(geom, j, had, 'x');
    geom[j * NAME_GEOM + 5] = nameBox(geom, j, had, 'y');
  }
  order.sort((a, b) => rankOf(labels[from + b]) - rankOf(labels[from + a]) || a - b);
  // The most important first, where each may go: clear of the interface, the corners already given and (but for the chosen body's) the worlds' names.
  let used = 0;
  /**
   * `first`: the chosen body's name or mark, which the worlds' names give way to (theirs are not in its way);
   * `self`: a name coming in (by its index; -1 for one showing), which also keeps clear of every other name
   * showing where it was (a lesser one included: one coming in never sends one showing away).
   */
  /** Inside the clear view and off the interface over it, with no margin: where a name may be drawn at all. */
  const free = (bx: number, by: number, w: number): boolean =>
    !(bx < view.left || bx + w > view.right || by < view.top || by + h > view.bottom) && !view.avoid.some((r) => bx < r.right && r.left < bx + w && by < r.bottom && r.top < by + h);
  const clear = (bx: number, by: number, w: number, pad: number, first: boolean, self: number, label: NameLabel): boolean => {
    // Edges and the interface: with the margin's worth less room to keep a place than to take one.
    const edge = pad - NAME_MARGIN_PX;
    if (bx < view.left + edge || bx + w > view.right - edge || by < view.top + edge || by + h > view.bottom - edge) return false;
    if (label.fits?.(bx, by, w, h) === false) return false;
    for (let t = 0; t < view.takenCount && !first; t++) {
      const o = view.taken[t];
      if (o && bx < o.x + view.worldW && o.x < bx + w && by < o.y + view.worldH && o.y < by + h) return false;
    }
    for (const r of view.avoid) if (bx - edge < r.right && r.left < bx + w + edge && by - edge < r.bottom && r.top < by + h + edge) return false;
    for (let t = 0; t < used; t++) {
      const o = boxes[t];
      if (o && meets(bx, by, w, o.x, o.y, o.w, pad)) return false;
    }
    if (self >= 0 && !first)
      for (const k of order) {
        const other = labels[from + k];
        const q = k * NAME_GEOM;
        if (k !== self && other && (fade.get(other.id) ?? 0) > NAME_HANDOVER && meets(bx, by, w, geom[q + 4] ?? 0, geom[q + 5] ?? 0, geom[q + 2] ?? 0, pad)) return false;
      }
    return true;
  };
  for (const j of order) {
    const label = labels[from + j];
    if (!label) continue;
    const g = j * NAME_GEOM;
    const w = geom[g + 2] ?? 0;
    const before = fade.get(label.id) ?? (entering ? label.opacity : 0);
    const showing = before > NAME_HANDOVER;
    const was = place.get(label.id) ?? 0;
    let spot = -1;
    for (let t = -1; geom[g + 3] === 1 && spot < 0 && t < NAME_SPOTS.length; t += 1) {
      if (t === was) continue;
      const k = t < 0 ? was : t;
      if (clear(nameBox(geom, j, k, 'x'), nameBox(geom, j, k, 'y'), w, showing ? NAME_MARGIN_PX : 2 * NAME_MARGIN_PX, rankOf(label) === Number.MAX_VALUE, showing ? -1 : j, label)) spot = k;
    }
    let wait = false;
    if (spot >= 0) {
      geom[g + 3] = 2;
      const bx = nameBox(geom, j, spot, 'x');
      const by = nameBox(geom, j, spot, 'y');
      let box = boxes[used];
      if (!box) {
        box = { x: 0, y: 0, w: 0 };
        boxes.push(box);
      }
      box.x = bx;
      box.y = by;
      box.w = w;
      used += 1;
      // Coming in, or to another corner: only once no other name still shows there (a world's fading out too).
      if (!showing || spot !== was) {
        for (const k of order) {
          const other = labels[from + k];
          const q = k * NAME_GEOM;
          if (k !== j && other && (fade.get(other.id) ?? 0) > NAME_HANDOVER && meets(bx, by, w, geom[q + 4] ?? 0, geom[q + 5] ?? 0, geom[q + 2] ?? 0, 0)) wait = true;
        }
        for (const id of view.worlds) if (view.worldAt(id, bx, by, w, h)) wait = true;
      }
      if (!wait || !showing) place.set(label.id, spot);
    }
    label.offset = NAME_SPOTS[place.get(label.id) ?? 0];
    const want = spot >= 0 && !wait ? label.opacity : 0;
    const now = before + (want - before) * (entering ? 1 : want < before ? hide : show);
    fade.set(label.id, now);
    label.opacity = now < 1e-3 ? 0 : now;
  }
  // Whatever the easing left, two never show over each other: by rank, a name whose box meets one
  // shown (or given a place) before it gives way at once (it comes back once it has room), and so does
  // a world's under the chosen body's name or marks, or over another of the laboratory's. What shows,
  // and where the chosen body's names go, is kept for the worlds' names on the next frame.
  const shown = state.shown;
  shown.length = 0;
  for (const j of order) {
    const label = labels[from + j];
    if (!label) continue;
    const first = rankOf(label) === Number.MAX_VALUE;
    const spot = place.get(label.id) ?? 0;
    const bx = nameBox(geom, j, spot, 'x');
    const by = nameBox(geom, j, spot, 'y');
    const w = geom[j * NAME_GEOM + 2] ?? 0;
    if (label.opacity <= NAME_HANDOVER) {
      // The chosen body's name or mark coming in has its place: a world's name there gives way to it.
      if (first && geom[j * NAME_GEOM + 3] === 2) shown.push(bx, by, w, 1);
      continue;
    }
    // (Nor where the interface now covers it, or where it may not be: gone at once, never drawn under it while it fades.)
    let meet = !free(bx, by, w) || label.fits?.(bx, by, w, h) === false;
    for (let t = 0; t + 3 < shown.length; t += 4) if (meets(bx, by, w, shown[t] ?? 0, shown[t + 1] ?? 0, shown[t + 2] ?? 0, 0)) meet = true;
    for (const id of view.worlds) {
      if (meet || !view.worldAt(id, bx, by, w, h)) continue;
      if (first) view.giveWay(id);
      else meet = true;
    }
    if (meet) {
      label.opacity = 0;
      fade.set(label.id, 0);
    } else shown.push(bx, by, w, first ? 1 : 0);
  }
}
