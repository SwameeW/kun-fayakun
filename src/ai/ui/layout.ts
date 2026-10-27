/**
 * Where the assistant's panel may stand: the part of the window that none of the app's own chrome
 * covers. The panel is measured against what is really on screen (the header, the film's timeline,
 * the notes, the explorer's way back, its readout and its navigator), so it hides none of them,
 * whatever the route, the window or the explorer's layout. The one exception: a sheet left less than
 * SHEET_MIN_PX of height (the laboratory on a phone, whose navigator stays tall even folded) comes up
 * over the chrome at the bottom, inert behind the modal sheet while it is open.
 *
 * - side: a wide window (desktop): a column at the inline start, below the header (and the
 *   explorer's way back), ending above the film's timeline or the explorer's readout, and never
 *   reaching the notes or the navigator at the other side.
 * - sheet: a phone or a narrow window: the width of the window, below everything at the top (the
 *   header, the way back, a phone's readout), above everything at the bottom (the timeline, the
 *   navigator's folded sheet).
 */

/** At least this wide (CSS px) and this tall, the panel stands beside the scene; below, it is a sheet. */
export const SIDE_QUERY = '(min-width: 900px) and (min-height: 560px)';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Space kept between the panel and the chrome around it, px. */
const GAP = 8;
/** The side panel's width: up to 24rem, at most 36% of the window. */
const SIDE_MAX_PX = 384;
const SIDE_SHARE = 0.36;
/** A sheet on a tablet stays a readable width, centred. */
const SHEET_MAX_PX = 640;
/** A sheet shorter than this could not hold a question and an answer. */
const SHEET_MIN_PX = 320;

/** An element's box when it is on screen (not hidden, not collapsed to nothing), else null. */
function onScreen(selector: string): DOMRect | null {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/** A box's extent along the line (from the inline start), so a right-to-left page mirrors the column. */
interface Span {
  start: number;
  end: number;
}

function span(r: DOMRect, rtl: boolean): Span {
  return rtl ? { start: window.innerWidth - r.right, end: window.innerWidth - r.left } : { start: r.left, end: r.right };
}

const overlaps = (s: Span, start: number, end: number): boolean => s.end > start && s.start < end;

/** The window's side gutter, as the header uses it. */
function gutter(): number {
  const header = document.querySelector('.kf-header');
  const px = header ? parseFloat(getComputedStyle(header).paddingInlineStart) : NaN;
  return Number.isFinite(px) && px > 0 ? px : 16;
}

/** The chrome the panel must keep clear of, measured now. */
function chrome(): { header: DOMRect | null; timeline: DOMRect | null; back: DOMRect | null; readout: DOMRect | null; nav: DOMRect | null; notes: DOMRect | null } {
  return {
    header: onScreen('.kf-header'),
    timeline: onScreen('[data-testid="timeline"]'),
    back: onScreen('[data-testid="universe-back"]'),
    readout: onScreen('[data-testid="universe-readout"]'),
    nav: onScreen('[data-testid="universe-bodies"]'),
    notes: onScreen('[data-testid="panel"]'),
  };
}

/** The side column at the inline start (a left-to-right page's left). */
export function sideBox(): Box {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  const c = chrome();
  const start = gutter();
  let end = start + Math.min(SIDE_MAX_PX, width * SIDE_SHARE);
  // The notes and the navigator stand at the other side: the column stops short of them.
  for (const other of [c.notes, c.nav]) {
    const s = other ? span(other, rtl) : null;
    if (s && s.start > width / 2) end = Math.min(end, s.start - GAP);
  }
  let top = (c.header?.bottom ?? 0) + GAP;
  if (c.back && overlaps(span(c.back, rtl), start, end)) top = Math.max(top, c.back.bottom + GAP);
  let bottom = height - GAP;
  if (c.timeline) bottom = Math.min(bottom, c.timeline.top - GAP);
  if (c.readout && overlaps(span(c.readout, rtl), start, end)) {
    if (c.readout.top > height / 2) bottom = Math.min(bottom, c.readout.top - GAP);
    else top = Math.max(top, c.readout.bottom + GAP);
  }
  const w = Math.max(0, end - start);
  return { top, left: rtl ? width - start - w : start, width: w, height: Math.max(0, bottom - top) };
}

/** The sheet across the window, between the chrome at the top and at the bottom. */
export function sheetBox(): Box {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const c = chrome();
  const w = Math.min(SHEET_MAX_PX, width - 2 * GAP);
  const left = (width - w) / 2;
  let top = (c.header?.bottom ?? 0) + GAP;
  let bottom = height - GAP;
  for (const r of [c.back, c.readout, c.nav, c.timeline]) {
    if (!r || r.right <= left || r.left >= left + w) continue;
    // Chrome in the upper half pushes the sheet down; in the lower half, it stops the sheet above it.
    if (r.top + r.height / 2 < height / 2) top = Math.max(top, r.bottom + GAP);
    else bottom = Math.min(bottom, r.top - GAP);
  }
  // Too little room left (the laboratory's sheet on a phone stays tall even folded): the sheet comes
  // up over the chrome at the bottom, which its modal dialog makes inert meanwhile.
  if (bottom - top < SHEET_MIN_PX) bottom = height - GAP;
  return { top, left, width: w, height: Math.max(0, bottom - top) };
}

/** Puts an element at a box (fixed position, px). */
export function place(el: HTMLElement, box: Box): void {
  el.style.top = `${Math.round(box.top)}px`;
  el.style.left = `${Math.round(box.left)}px`;
  el.style.width = `${Math.round(box.width)}px`;
  el.style.height = `${Math.round(box.height)}px`;
}
