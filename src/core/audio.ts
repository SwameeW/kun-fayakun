/**
 * Audio policy (spec §6): no music, no instrument, no voice. The film's sounds come from what it
 * shows (src/core/film-score.ts); the explorer's are the wind where there is air, or a suit's fans
 * where there is none (src/explore/sound.ts). All made in Web Audio, no audio assets; one Sound
 * choice turns both off (the film's speaker, the navigator's foot).
 *
 * Two buses (ambient, scene) feed the output through gains the engine controls.
 * Recitation (M4) never goes through Web Audio: it plays on its own media
 * element at rate 1 with pitch preserved, so no effect can ever be applied to
 * it. While it plays, ambient and scene sound fade to silence (Quran 7:204).
 */
export interface AudioEngine {
  /** 'audio' cue: lower ambient and scene sound (e.g. under a verse). */
  duck(): void;
  /** 'audio' cue: bring ambient and scene sound back. */
  restore(): void;
  /** Bus that future ambient/scene sources connect to; creates the AudioContext on first use. */
  bus(kind: 'ambient' | 'scene'): GainNode;
  /** M4 hook: plays a recitation untouched; resolves when it ends or is stopped. */
  recite(src: string): Promise<void>;
  stopRecitation(): void;
  setPaused(paused: boolean): void;
  /** Gain currently aimed at for ambient and scene buses (0..1). */
  readonly level: number;
  dispose(): void;
}

const DUCK_LEVEL = 0.25;
const RAMP_SECONDS = 0.8;
/** A pause fades the sound out this fast before the context is suspended. */
const PAUSE_FADE_SECONDS = 0.12;

export function createAudioEngine(): AudioEngine {
  let context: AudioContext | null = null;
  const buses = new Map<'ambient' | 'scene', GainNode>();
  let ducked = false;
  let reciting: HTMLAudioElement | null = null;
  let endRecitation: (() => void) | null = null;
  let paused = false;
  let suspendTimer = 0;

  const level = (): number => (reciting ? 0 : ducked ? DUCK_LEVEL : 1);

  const applyLevel = (): void => {
    if (!context) return;
    const now = context.currentTime;
    for (const gain of buses.values()) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(paused ? 0 : level(), now + RAMP_SECONDS);
    }
  };

  const ensureContext = (): AudioContext => {
    context ??= new AudioContext();
    return context;
  };

  return {
    get level() {
      return level();
    },
    duck() {
      ducked = true;
      applyLevel();
    },
    restore() {
      ducked = false;
      applyLevel();
    },
    bus(kind) {
      const existing = buses.get(kind);
      if (existing) return existing;
      const ctx = ensureContext();
      const gain = ctx.createGain();
      gain.gain.value = paused ? 0 : level();
      gain.connect(ctx.destination);
      buses.set(kind, gain);
      return gain;
    },
    recite(src) {
      this.stopRecitation();
      const el = new Audio(src);
      el.preservesPitch = true;
      el.playbackRate = 1;
      el.defaultPlaybackRate = 1;
      el.volume = 1;
      reciting = el;
      applyLevel();
      return new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          el.removeEventListener('ended', finish);
          if (reciting === el) {
            reciting = null;
            endRecitation = null;
            applyLevel();
          }
          resolve();
        };
        endRecitation = finish;
        el.addEventListener('ended', finish);
        el.play().catch((err: unknown) => {
          finish();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
    stopRecitation() {
      if (!reciting) return;
      reciting.pause();
      endRecitation?.();
    },
    setPaused(value) {
      if (value === paused) return;
      paused = value;
      if (reciting) {
        if (paused) reciting.pause();
        else void reciting.play().catch(() => undefined);
      }
      const ctx = context;
      if (!ctx) return;
      // Faded out before the context stops, and back in after it starts, so a pause never clicks.
      const now = ctx.currentTime;
      for (const gain of buses.values()) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(paused ? 0 : level(), now + (paused ? PAUSE_FADE_SECONDS : RAMP_SECONDS));
      }
      window.clearTimeout(suspendTimer);
      if (paused) {
        suspendTimer = window.setTimeout(() => {
          if (paused) void ctx.suspend();
        }, PAUSE_FADE_SECONDS * 1000 + 30);
      } else void ctx.resume();
    },
    dispose() {
      this.stopRecitation();
      buses.clear();
      if (context) void context.close();
      context = null;
    },
  };
}
