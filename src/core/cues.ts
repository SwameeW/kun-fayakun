import type { Cue, FigureId } from './types';

/** Cues shown for a span of time; they fade in and out whole. */
export type RangeCue = Extract<Cue, { duration: number }>;
export type SceneCue = Extract<Cue, { type: 'scene' }>;
/** Instant cues that set lasting UI/audio state. */
type StateCue = Extract<Cue, { type: 'panel' | 'overlay' | 'audio' }>;

export type CueEffect =
  | { kind: 'cue'; cue: Cue; active: boolean }
  | { kind: 'scene'; cue: SceneCue };

const isRange = (c: Cue): c is RangeCue => 'duration' in c;
const isScene = (c: Cue): c is SceneCue => c.type === 'scene';
const isState = (c: Cue): c is StateCue => c.type === 'panel' || c.type === 'overlay' || c.type === 'audio';

/** Stable sort by time, so cues authored at the same t keep their order. */
const byTime = <T extends Cue>(cues: readonly Cue[], keep: (c: Cue) => c is T): T[] =>
  cues
    .map((cue, i) => ({ cue, i }))
    .filter((x): x is { cue: T; i: number } => keep(x.cue))
    .sort((a, b) => a.cue.t - b.cue.t || a.i - b.i)
    .map((x) => x.cue);

function lastAtOrBefore<T extends Cue>(cues: readonly T[], t: number, match: (c: T) => boolean): T | null {
  let found: T | null = null;
  for (const c of cues) {
    if (c.t > t) break;
    if (match(c)) found = c;
  }
  return found;
}

/**
 * Decides which cues fire or change as the cinematic clock moves. Pure logic:
 * the timeline turns the returned effects into events and scene calls.
 */
export class CueScheduler {
  private readonly ranges: readonly RangeCue[];
  private readonly states: readonly StateCue[];
  private readonly scenes: readonly SceneCue[];
  private readonly overlayIds: readonly FigureId[];
  private readonly active = new Set<RangeCue>();
  private nextState = 0;
  private nextScene = 0;
  private time = -Infinity;

  constructor(cues: readonly Cue[]) {
    this.ranges = byTime(cues, isRange);
    this.states = byTime(cues, isState);
    this.scenes = byTime(cues, isScene);
    this.overlayIds = [...new Set(this.states.flatMap((c) => (c.type === 'overlay' ? [c.id] : [])))];
  }

  /** Plays forward to t: fires crossed cues in order and updates range cues. */
  advance(t: number): CueEffect[] {
    const out: CueEffect[] = [];
    this.endRanges(t, out);
    for (;;) {
      const s = this.states[this.nextState];
      const sc = this.scenes[this.nextScene];
      const stateDue = s !== undefined && s.t <= t;
      const sceneDue = sc !== undefined && sc.t <= t;
      if (stateDue && (!sceneDue || s.t <= sc.t)) {
        out.push({ kind: 'cue', cue: s, active: true });
        this.nextState += 1;
      } else if (sceneDue) {
        out.push({ kind: 'scene', cue: sc });
        this.nextScene += 1;
      } else break;
    }
    this.beginRanges(t, out);
    this.time = t;
    return out;
  }

  /** True when jumping back to t un-crosses a scene cue, so the scene must be reset and replayed. */
  needsSceneReset(t: number): boolean {
    return t < this.time && this.scenes.some((c) => c.t > t && c.t <= this.time);
  }

  /**
   * Jumps to t. Range cues are recomputed, lasting state (panel section,
   * overlays, audio ducking) is rebuilt from the cues before t, and scene cues
   * are fired forward, from the start when resetScene is set.
   */
  seek(t: number, resetScene: boolean): CueEffect[] {
    const out: CueEffect[] = [];
    this.endRanges(t, out);

    const panel = lastAtOrBefore(this.states, t, (c) => c.type === 'panel');
    if (panel) out.push({ kind: 'cue', cue: panel, active: true });
    for (const id of this.overlayIds) {
      const last = lastAtOrBefore(this.states, t, (c) => c.type === 'overlay' && c.id === id);
      const cue: Cue = last ?? { t, type: 'overlay', id, visible: false };
      out.push({ kind: 'cue', cue, active: true });
    }
    const audio = lastAtOrBefore(this.states, t, (c) => c.type === 'audio');
    out.push({ kind: 'cue', cue: audio ?? { t, type: 'audio', action: 'restore' }, active: true });
    this.nextState = this.states.findIndex((c) => c.t > t);
    if (this.nextState < 0) this.nextState = this.states.length;

    if (resetScene) this.nextScene = 0;
    else if (t < this.time) {
      const i = this.scenes.findIndex((c) => c.t > t);
      this.nextScene = i < 0 ? this.scenes.length : i;
    }
    for (let sc = this.scenes[this.nextScene]; sc !== undefined && sc.t <= t; sc = this.scenes[this.nextScene]) {
      out.push({ kind: 'scene', cue: sc });
      this.nextScene += 1;
    }

    this.beginRanges(t, out);
    this.time = t;
    return out;
  }

  /** Ends everything still showing (chapter leaving): active ranges, visible overlays, ducking. */
  clear(): CueEffect[] {
    const out: CueEffect[] = [];
    for (const cue of this.active) out.push({ kind: 'cue', cue, active: false });
    this.active.clear();
    for (const id of this.overlayIds) {
      const last = lastAtOrBefore(this.states, this.time, (c) => c.type === 'overlay' && c.id === id);
      if (last?.type === 'overlay' && last.visible) {
        out.push({ kind: 'cue', cue: { t: this.time, type: 'overlay', id, visible: false }, active: true });
      }
    }
    const audio = lastAtOrBefore(this.states, this.time, (c) => c.type === 'audio');
    if (audio?.type === 'audio' && audio.action === 'duck') {
      out.push({ kind: 'cue', cue: { t: this.time, type: 'audio', action: 'restore' }, active: true });
    }
    return out;
  }

  private endRanges(t: number, out: CueEffect[]): void {
    for (const cue of [...this.active]) {
      if (!(t >= cue.t && t < cue.t + cue.duration)) {
        this.active.delete(cue);
        out.push({ kind: 'cue', cue, active: false });
      }
    }
  }

  private beginRanges(t: number, out: CueEffect[]): void {
    for (const cue of this.ranges) {
      if (cue.t > t) break;
      if (t < cue.t + cue.duration && !this.active.has(cue)) {
        this.active.add(cue);
        out.push({ kind: 'cue', cue, active: true });
      }
    }
  }
}
