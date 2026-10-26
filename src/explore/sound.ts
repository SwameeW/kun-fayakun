import type { AudioBuses } from '../core/types';

/**
 * The explorer's sound (ledger CR-6, docs/EXPLORER-MECHANICS.md): sound only where there is air to
 * carry it. Space is silent, and so is the explorer there. On foot and on the way down through an
 * atmosphere, the wind: noise shaped by the air, as loud as its dynamic pressure (half the density
 * times the wind's speed squared; on Mars, about 20 dB under the Earth's for the same wind, as
 * Perseverance's microphones found) and as bright as the air lets high pitches carry (Mars's thin
 * carbon dioxide takes them first). On an airless world, only the suit's own fans, as the Apollo crews
 * heard theirs. All of it a display of the conditions, not a recording: no music, no voice. It plays
 * through the app's ambient bus, so a recitation silences it (src/core/audio.ts), and only once the
 * visitor has touched the page (browsers ask for that) and while sound is on.
 */

export interface SoundState {
  /** The air where the listener is: its density (kg/m^3) and wind (m/s), and how far high pitches carry in it (Hz); null without air. */
  air: { densityKgM3: number; windMs: number; brightHz: number } | null;
  /** In a suit on a world without air: its fans. */
  suit: boolean;
}

export interface Soundscape {
  /** Whether sound is on (the visitor's choice, kept by the interface). */
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  /** Called on the visitor's first touch of the page: browsers allow sound to begin only then. */
  unlock(): void;
  /** This frame's conditions (`dt` in seconds, for gusts); silence when null (out in space, or in the film). */
  update(state: SoundState | null, dt: number): void;
  /** What plays now, for the view and the tests. */
  readonly playing: 'wind' | 'suit' | null;
  dispose(): void;
}

/** Display terms: the wind's dynamic pressure at which it plays at REFERENCE_GAIN (an Earthly breeze of 5 m/s: 15 Pa), and the loudest. */
const WIND = { referencePa: 15, referenceGain: 0.12, maxGain: 0.42 } as const;
const SUIT_GAIN = 0.035;
/** Seconds to ease between conditions. */
const EASE_S = 0.6;

export function createSoundscape(audio: AudioBuses | undefined): Soundscape {
  let enabled = true;
  let unlocked = false;
  let nodes: {
    context: AudioContext;
    windGain: GainNode;
    windFilter: BiquadFilterNode;
    suitGain: GainNode;
    sources: AudioScheduledSourceNode[];
  } | null = null;
  let playing: 'wind' | 'suit' | null = null;
  let gust = 0;

  /** Pink-ish noise (white noise through a running filter), a few seconds long, looped. */
  const noiseBuffer = (context: AudioContext): AudioBuffer => {
    const seconds = 4;
    const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      // Paul Kellet's economy pink filter.
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
    }
    return buffer;
  };

  const build = (): void => {
    if (nodes || !audio || !unlocked) return;
    const bus = audio.bus('ambient') as GainNode;
    const context = bus.context as AudioContext;
    const buffer = noiseBuffer(context);
    const wind = context.createBufferSource();
    wind.buffer = buffer;
    wind.loop = true;
    const windFilter = context.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 1200;
    windFilter.Q.value = 0.7;
    const windGain = context.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter).connect(windGain).connect(bus);
    // The suit's fans: a low hum and a soft hiss.
    const hum = context.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 118;
    const hiss = context.createBufferSource();
    hiss.buffer = buffer;
    hiss.loop = true;
    hiss.playbackRate.value = 1.7;
    const hissFilter = context.createBiquadFilter();
    hissFilter.type = 'bandpass';
    hissFilter.frequency.value = 1800;
    hissFilter.Q.value = 0.9;
    const humGain = context.createGain();
    humGain.gain.value = 0.35;
    const suitGain = context.createGain();
    suitGain.gain.value = 0;
    hum.connect(humGain).connect(suitGain);
    hiss.connect(hissFilter).connect(suitGain);
    suitGain.connect(bus);
    for (const s of [wind, hum, hiss]) s.start();
    nodes = { context, windGain, windFilter, suitGain, sources: [wind, hum, hiss] };
  };

  const ease = (param: AudioParam, value: number, context: AudioContext): void => {
    param.setTargetAtTime(value, context.currentTime, EASE_S / 3);
  };

  return {
    setEnabled(on) {
      enabled = on;
      if (!on && nodes) {
        ease(nodes.windGain.gain, 0, nodes.context);
        ease(nodes.suitGain.gain, 0, nodes.context);
        playing = null;
      }
    },
    get enabled() {
      return enabled;
    },
    unlock() {
      if (unlocked) return;
      unlocked = true;
    },
    update(state, dt) {
      if (enabled && state && (state.air || state.suit)) build();
      if (!nodes) {
        playing = null;
        return;
      }
      const { context, windGain, windFilter, suitGain } = nodes;
      if (context.state === 'suspended' && enabled && unlocked) void context.resume();
      // Gusts: a slow wander of the wind's strength, a fifth either way.
      gust += (Math.random() - 0.5) * dt * 0.6 - gust * dt * 0.3;
      gust = Math.max(-0.2, Math.min(0.2, gust));
      const air = enabled ? (state?.air ?? null) : null;
      const suit = enabled && state?.suit === true;
      if (air) {
        const q = 0.5 * air.densityKgM3 * air.windMs * air.windMs;
        const gain = Math.min(WIND.maxGain, WIND.referenceGain * Math.sqrt(q / WIND.referencePa) * (1 + gust));
        ease(windGain.gain, gain, context);
        ease(windFilter.frequency, air.brightHz * (1 + gust * 0.5), context);
      } else ease(windGain.gain, 0, context);
      ease(suitGain.gain, suit ? SUIT_GAIN : 0, context);
      playing = air ? 'wind' : suit ? 'suit' : null;
    },
    get playing() {
      return playing;
    },
    dispose() {
      if (!nodes) return;
      for (const s of nodes.sources) s.stop();
      nodes.windGain.disconnect();
      nodes.suitGain.disconnect();
      nodes = null;
    },
  };
}
