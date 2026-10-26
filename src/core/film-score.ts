import type { ChapterContent, ChapterId, Cue } from './types';

/**
 * The film's sound (docs/SPEC.md section 6, film/shotlist.json's sound column): nature and physics
 * only. No music, no instrument, no voice; made in Web Audio, with no recordings to license.
 *
 * Each sound comes from what the picture shows, and where there was sound to hear, it is that sound:
 * - Before the first light the young universe rang with sound waves in its plasma (the acoustic peaks
 *   of the Planck sky are their trace). Chapter 1 and the start of Chapter 2 sound those peaks, at
 *   l = 220, 540, 810, 1130 and 1440 with Planck's relative heights, raised into hearing; their pitch
 *   falls as space stretches, and they fall silent at recombination, when light and matter part and
 *   sound in the plasma ends ("one exhaled breath, then silence").
 * - A star rumbles with convection; the Sun rings with millions of acoustic modes near 3 mHz, a
 *   comb about 135 microhertz apart. Chapter 7 sounds that comb, sped up about 42,000 times, each mode
 *   swelling and fading at random as the real modes do (stochastically excited, damped).
 * - The young Earth: lava, the giant impact as a low swell (never a bang), rain and the first seas,
 *   wind over new land; Chapter 9 begins under water.
 * - Out in space, where nothing carries sound, only a low hush.
 * Silence is kept where the film asks for it: before the word forms, after the light of the end. While
 * a verse is on screen everything sinks to near silence (spec: ambient sound fades for the Quran,
 * 7:204), and a little less under a hadith card. Every swell eases in; nothing startles.
 *
 * Levels are written per chapter against its scene events (content.json), so re-timing a chapter
 * moves its sound with its picture. Loaded with its own chunk the first time a chapter plays with
 * sound on (./film-sound decides when).
 */

type VoiceName = 'hush' | 'rumble' | 'roar' | 'convection' | 'sun' | 'hiss' | 'rain' | 'surf' | 'wind' | 'underwater' | 'lava';
type ShotName = 'breath' | 'exhale' | 'swell' | 'glint' | 'rise';
/** A chapter time: seconds, a scene event ('cool'), one with an offset ('cool+6'), or the end ('end-4'). */
type At = number | string;
type Curve = ReadonlyArray<readonly [At, number]>;

interface Track {
  voice: VoiceName;
  /** 0..1 over the chapter, eased between points. */
  level: Curve;
  /** The voice's one parameter: brightness (0..1), or for the roar its pitch (1 = the peaks' own). */
  param?: Curve;
}

interface Score {
  tracks: readonly Track[];
  shots?: ReadonlyArray<readonly [At, ShotName]>;
}

const SCORES: Readonly<Record<ChapterId, Score>> = {
  // Before creation: silence; one breath as the word forms; a faint hush while it holds; silence after its light.
  ch00: {
    tracks: [{ voice: 'hush', level: [[0, 0], ['kun-hold', 0], ['kun-hold+4', 0.3], ['kun-fade', 0.3], ['kun-fade+5', 0]], param: [[0, 0.2]] }],
    shots: [['kun-reveal', 'breath']],
  },
  // The beginning: the plasma's sound rises with the point of light and widens and falls as space stretches.
  ch01: {
    tracks: [
      { voice: 'roar', level: [[0, 0], ['ignite', 0], ['ignite+8', 0.45], ['expand', 0.6], ['cool', 0.8], ['end', 0.8]], param: [[0, 1.9], ['expand', 1.7], ['cool', 1.3], ['end', 1.08]] },
      { voice: 'hush', level: [[0, 0], ['expand', 0], ['expand+6', 0.35], ['end', 0.25]], param: [[0, 0.55], ['end', 0.35]] },
    ],
  },
  // The first light: the sound goes on in the plasma until recombination, then ends; a hush opens around the Planck sky.
  ch02: {
    tracks: [
      { voice: 'roar', level: [[0, 0.8], ['recombination', 0.8], ['recombination+5', 0]], param: [[0, 1.08], ['recombination', 0.95]] },
      { voice: 'hush', level: [[0, 0], ['cmb-reveal+2', 0], ['cmb-hold', 0.3], ['end-3', 0.3], ['end', 0.12]], param: [[0, 0.3]] },
    ],
    shots: [['recombination', 'exhale']],
  },
  // The dark ages, deep and low; the first stars lift the hush, with a glint here and there.
  ch03: {
    tracks: [
      { voice: 'rumble', level: [[0, 0.3], ['web', 0.28], ['stars', 0.12], ['galaxies', 0.08]] },
      { voice: 'hush', level: [[0, 0.15], ['web', 0.25], ['stars', 0.35], ['galaxies', 0.4], ['end', 0.35]], param: [[0, 0.1], ['web', 0.3], ['stars', 0.6], ['galaxies', 0.7]] },
    ],
    shots: [['stars+1', 'glint'], ['stars+7', 'glint'], ['stars+14', 'glint'], ['galaxies+4', 'glint']],
  },
  // A vast heaven: the hush deepens as the galaxies' light reddens.
  ch04: {
    tracks: [{ voice: 'hush', level: [[0, 0.35], ['stretch', 0.4], ['end-3', 0.35], ['end', 0.2]], param: [[0, 0.6], ['stretch', 0.55], ['redshift', 0.5], ['redshift+12', 0.25]] }],
  },
  // The galaxies: air rising as the view draws back through five powers of ten.
  ch05: {
    tracks: [{ voice: 'hush', level: [[0, 0.3], ['pull-back', 0.3], ['pull-back+10', 0.5], ['survey+6', 0.4], ['end-8', 0.4], ['end', 0.15]], param: [[0, 0.4], ['pull-back', 0.4], ['pull-back+12', 0.65], ['survey+6', 0.5]] }],
    shots: [['pull-back', 'rise']],
  },
  // Stars and iron: the churning inside a star; one low swell for the collapse and one for the Type Ia,
  // whose hum then fades as the nickel-56 and cobalt-56 decay chain dims its light.
  ch06: {
    tracks: [
      { voice: 'convection', level: [[0, 0.6], ['collapse', 0.6], ['collapse+3', 0]] },
      { voice: 'hush', level: [[0, 0], ['collapse+4', 0], ['collapse+10', 0.2], ['white-dwarf', 0.2], ['white-dwarf+3', 0.1], ['end', 0.1]], param: [[0, 0.3]] },
      { voice: 'hiss', level: [[0, 0], ['white-dwarf', 0], ['white-dwarf+3', 0.35], ['type-ia', 0.35], ['type-ia+2', 0]], param: [[0, 0.4]] },
      { voice: 'rumble', level: [[0, 0], ['type-ia', 0], ['type-ia+3', 0.5], ['type-ia+8', 0.3], ['type-ia+16', 0.15], ['end', 0.08]] },
    ],
    shots: [['collapse', 'swell'], ['type-ia', 'swell']],
  },
  // The Sun: dust in the disk; a slow swell as it begins to shine; its own acoustic modes when it is seen close.
  ch07: {
    tracks: [
      { voice: 'hiss', level: [[0, 0.25], ['ignite', 0.3], ['clear', 0.25], ['clear+10', 0]], param: [[0, 0.15]] },
      { voice: 'sun', level: [[0, 0], ['clear', 0], ['clear+8', 0.55], ['orrery', 0.5], ['orrery+4', 0.12], ['moon', 0]] },
      { voice: 'hush', level: [[0, 0], ['orrery', 0], ['orrery+4', 0.2], ['galaxy', 0.22], ['galaxy+10', 0.4], ['end', 0.3]], param: [[0, 0.35]] },
    ],
    shots: [['ignite', 'swell']],
  },
  // The earth spread out: lava and steam, the giant impact, the first rain and seas, then wind over the land.
  ch08: {
    tracks: [
      { voice: 'lava', level: [[0, 0.6], ['impact', 0.5], ['impact+12', 0.3], ['oceans', 0.1], ['oceans+10', 0]] },
      { voice: 'rain', level: [[0, 0], ['oceans', 0], ['oceans+4', 0.6], ['continents-6', 0.5], ['continents+4', 0.1], ['continents+12', 0]], param: [[0, 0.5]] },
      { voice: 'surf', level: [[0, 0], ['oceans+20', 0], ['oceans+30', 0.3], ['continents', 0.35], ['end', 0.25]] },
      { voice: 'wind', level: [[0, 0], ['continents-4', 0], ['continents+4', 0.4], ['end-30', 0.3], ['end', 0.15]], param: [[0, 0.4]] },
    ],
    shots: [['impact', 'swell']],
  },
  // Life from water: under the sea, up through its surface, then the sea and the wind of the living Earth.
  ch09: {
    tracks: [
      { voice: 'underwater', level: [[0, 0.6], ['rise+6', 0.6], ['rise+8', 0]] },
      { voice: 'surf', level: [[0, 0], ['rise+8', 0], ['rise+11', 0.4], ['end', 0.3]] },
      { voice: 'wind', level: [[0, 0], ['oxygen', 0.1], ['oxygen+8', 0.35], ['green', 0.35], ['end-10', 0.3], ['end', 0.15]], param: [[0, 0.35], ['green', 0.5]] },
    ],
    shots: [['rise+5', 'rise']],
  },
  // The end: the hush of the galaxies thins with heat death, tears with the Big Rip, gathers with the Big Crunch;
  // then silence for the verses of the end. A long exhale as the heavens fold, one breath as the word of the
  // return forms (as it began, Chapter 0), and silence to close.
  ch10: {
    tracks: [
      { voice: 'hush', level: [[0, 0.35], ['heat-death', 0.35], ['heat-death+10', 0.08], ['big-rip', 0.2], ['big-crunch', 0.3], ['still-3', 0.25], ['still+2', 0]], param: [[0, 0.45], ['heat-death', 0.45], ['heat-death+10', 0.15], ['big-rip', 0.5]] },
      { voice: 'hiss', level: [[0, 0], ['big-rip', 0], ['big-rip+6', 0.35], ['big-rip+11', 0]], param: [[0, 0.7]] },
      { voice: 'rumble', level: [[0, 0], ['big-crunch', 0], ['big-crunch+8', 0.45], ['still', 0]] },
    ],
    shots: [['fold', 'exhale'], ['calligraphy', 'breath']],
  },
};

/** The voices' own gains at level 1, set so the film sits quietly under the picture (tests/film-sound.spec.ts measures it). */
const GAIN: Readonly<Record<VoiceName, number>> = {
  hush: 0.16,
  rumble: 0.35,
  roar: 0.11,
  convection: 0.22,
  sun: 0.07,
  hiss: 0.035,
  rain: 0.3,
  surf: 0.32,
  wind: 0.24,
  underwater: 0.28,
  lava: 0.28,
};
/** How much of each voice goes to the reverb (space for the hush and the swells, little for rain and wind). */
const SEND: Readonly<Record<VoiceName, number>> = {
  hush: 0.6,
  rumble: 0.3,
  roar: 0.35,
  convection: 0.25,
  sun: 0.4,
  hiss: 0.5,
  rain: 0.15,
  surf: 0.2,
  wind: 0.2,
  underwater: 0.35,
  lava: 0.25,
};
/** Under a verse the sound sinks to near silence; under a hadith card, lower. */
const DUCK = { verse: 0.08, hadith: 0.3 } as const;
/** Easing time constants (s): levels, the duck, a chapter's change. */
const TAU = { level: 0.35, duck: 0.45, change: 0.5 } as const;
/** A one-shot fires when the film plays across its time, not when a seek jumps over it. */
const MAX_STEP_S = 0.6;

type Color = 'white' | 'pink' | 'brown';

interface Voice {
  /** Level 0..1 and the parameter, eased from `now`. */
  set(level: number, param: number, now: number): void;
  /** Schedules what comes next (waves, bubbles, gusts) a little ahead of `now`. */
  tick?(now: number): void;
  /** Fades out and stops by `now + seconds`. */
  stop(now: number, seconds: number): void;
}

interface Mix {
  context: BaseAudioContext;
  dry: GainNode;
  wet: GainNode;
  buffers: Map<Color, AudioBuffer>;
}

/** Random numbers that differ per voice but repeat from run to run (the tests render the same sound twice). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Six seconds of stereo noise of a colour, its ends crossfaded so it loops without a seam. */
function noise(mix: Mix, color: Color): AudioBuffer {
  const cached = mix.buffers.get(color);
  if (cached) return cached;
  const rate = mix.context.sampleRate;
  const length = Math.floor(rate * 6);
  const fade = Math.floor(rate * 0.25);
  const buffer = mix.context.createBuffer(2, length, rate);
  const rnd = random(color === 'white' ? 11 : color === 'pink' ? 23 : 37);
  for (let ch = 0; ch < 2; ch += 1) {
    const raw = new Float32Array(length + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const white = rnd() * 2 - 1;
      if (color === 'white') raw[i] = white;
      else if (color === 'pink') {
        // Paul Kellet's refined pink filter.
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
      } else {
        // Integrated white noise, leaking back to zero so it cannot wander off.
        brown = (brown + 0.02 * white) / 1.02;
        raw[i] = brown;
      }
    }
    const out = buffer.getChannelData(ch);
    let peak = 0;
    for (let i = 0; i < length; i += 1) {
      const head = raw[i] ?? 0;
      if (i < fade) {
        const u = i / fade;
        out[i] = head * Math.sqrt(u) + (raw[length + i] ?? 0) * Math.sqrt(1 - u);
      } else out[i] = head;
      peak = Math.max(peak, Math.abs(out[i] ?? 0));
    }
    const scale = peak > 0 ? 0.7 / peak : 0;
    for (let i = 0; i < length; i += 1) out[i] = (out[i] ?? 0) * scale;
  }
  mix.buffers.set(color, buffer);
  return buffer;
}

/** A space's reverberation: 3.4 s of decaying stereo noise that darkens as it fades, after a short pre-delay. */
function impulse(context: BaseAudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.floor(rate * 3.4);
  const delay = Math.floor(rate * 0.018);
  const buffer = context.createBuffer(2, length, rate);
  const rnd = random(53);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    let energy = 0;
    for (let i = delay; i < length; i += 1) {
      const u = (i - delay) / (length - delay);
      const k = 0.35 + 0.6 * u;
      low = low * k + (rnd() * 2 - 1) * (1 - k);
      data[i] = low * (1 - u) ** 2.6;
      energy += (data[i] ?? 0) ** 2;
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i += 1) data[i] = (data[i] ?? 0) * scale;
  }
  return buffer;
}

function loop(mix: Mix, color: Color, offset: number): AudioBufferSourceNode {
  const source = mix.context.createBufferSource();
  source.buffer = noise(mix, color);
  source.loop = true;
  source.start(0, offset % 6);
  return source;
}

function filter(context: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
  const f = context.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

function gain(context: BaseAudioContext, value: number): GainNode {
  const g = context.createGain();
  g.gain.value = value;
  return g;
}

/** A slow wobble of a gain around 1 (depth 0..1) at `hz`, from `phase` (0..1) of its cycle: breathing, churning, a mode's swell. */
function wobble(context: BaseAudioContext, target: GainNode, hz: number, depth: number, phase: number): OscillatorNode {
  const lfo = context.createOscillator();
  const turn = 2 * Math.PI * (phase % 1);
  lfo.setPeriodicWave(context.createPeriodicWave(new Float32Array([0, Math.sin(turn)]), new Float32Array([0, Math.cos(turn)])));
  lfo.frequency.value = hz;
  const amount = gain(context, depth);
  target.gain.value = 1;
  lfo.connect(amount).connect(target.gain);
  lfo.start();
  return lfo;
}

/** The voice's output: its level gain, sent to the dry mix and, by its share, to the reverb. */
function output(mix: Mix, name: VoiceName): GainNode {
  const out = gain(mix.context, 0);
  out.connect(mix.dry);
  out.connect(gain(mix.context, SEND[name])).connect(mix.wet);
  return out;
}

function stopAll(nodes: readonly AudioScheduledSourceNode[], out: GainNode, now: number, seconds: number): void {
  out.gain.cancelScheduledValues(now);
  out.gain.setTargetAtTime(0, now, seconds / 4);
  for (const n of nodes) n.stop(now + seconds);
  // Disconnected once silent, so nothing of a past chapter lingers in the graph.
  const last = nodes[0];
  if (last) last.onended = () => { out.disconnect(); };
}

function setLevel(out: GainNode, name: VoiceName, level: number, now: number): void {
  out.gain.setTargetAtTime(level * GAIN[name], now, TAU.level);
}

/** A bed of filtered noise (hush, rumble, convection, hiss, underwater's body, lava's body). */
function bed(mix: Mix, name: VoiceName, color: Color, shape: (param: number) => { low: number; high: number; q?: number; band?: boolean }, motion?: { hz: number; depth: number }): Voice & { out: GainNode; sources: AudioScheduledSourceNode[] } {
  const { context } = mix;
  const source = loop(mix, color, name.length * 0.73);
  const start = shape(0.5);
  const band = start.band === true;
  const a = filter(context, band ? 'bandpass' : 'lowpass', start.low, start.q ?? 0.5);
  const b = filter(context, 'highpass', start.high, 0.5);
  const inner = gain(context, 1);
  const out = output(mix, name);
  source.connect(a).connect(b).connect(inner).connect(out);
  const sources: AudioScheduledSourceNode[] = [source];
  if (motion) sources.push(wobble(context, inner, motion.hz, motion.depth, name.length * 0.37));
  return {
    out,
    sources,
    set(level, param, now) {
      setLevel(out, name, level, now);
      const s = shape(param);
      a.frequency.setTargetAtTime(s.low, now, TAU.level);
      b.frequency.setTargetAtTime(s.high, now, TAU.level);
    },
    stop(now, seconds) {
      stopAll(sources, out, now, seconds);
    },
  };
}

/** The plasma's sound: the five acoustic peaks as partials over a band of roaring noise, all at one pitch ratio. */
function roar(mix: Mix): Voice {
  const { context } = mix;
  const out = output(mix, 'roar');
  /** Planck's acoustic peaks: multipole l and relative amplitude (square root of the peak's D_l). */
  const PEAKS: ReadonlyArray<readonly [number, number]> = [[220, 1], [540, 0.68], [810, 0.66], [1130, 0.46], [1440, 0.37]];
  /** l / 4 Hz at pitch 1: the first peak at 55 Hz. */
  const HZ_PER_L = 0.25;
  const sources: AudioScheduledSourceNode[] = [];
  const oscillators: Array<{ osc: OscillatorNode; base: number }> = [];
  const rnd = random(71);
  PEAKS.forEach(([l, amp], i) => {
    for (const detune of [-0.004, 0.004]) {
      const osc = context.createOscillator();
      const base = l * HZ_PER_L * (1 + detune);
      osc.frequency.value = base;
      const inner = gain(context, 1);
      const level = gain(context, (amp * 0.5) / PEAKS.length);
      const pan = context.createStereoPanner();
      pan.pan.value = (i % 2 === 0 ? -1 : 1) * (0.15 + 0.12 * i) * (detune < 0 ? 1 : -1);
      osc.connect(inner).connect(level).connect(pan).connect(out);
      osc.start();
      sources.push(osc, wobble(context, inner, 0.11 + 0.27 * rnd(), 0.45, rnd()));
      oscillators.push({ osc, base });
    }
  });
  const body = loop(mix, 'pink', 2.1);
  const band = filter(context, 'bandpass', 90, 0.6);
  const low = filter(context, 'lowpass', 900, 0.5);
  body.connect(band).connect(low).connect(gain(context, 0.9)).connect(out);
  sources.push(body);
  return {
    set(level, param, now) {
      setLevel(out, 'roar', level, now);
      for (const { osc, base } of oscillators) osc.frequency.setTargetAtTime(base * param, now, 1.2);
      band.frequency.setTargetAtTime(90 * param, now, 1.2);
    },
    stop(now, seconds) {
      stopAll(sources, out, now, seconds);
    },
  };
}

/**
 * The Sun's acoustic modes: a comb about 135 microhertz apart around 3.1 mHz (here 5.73 Hz apart around
 * 130 Hz, about 42,000 times faster), each mode swelling and fading on its own as the Sun's do.
 */
function sun(mix: Mix): Voice {
  const { context } = mix;
  const out = output(mix, 'sun');
  const lowpass = filter(context, 'lowpass', 700, 0.5);
  lowpass.connect(out);
  const MODES = 36;
  const rnd = random(97);
  const sources: AudioScheduledSourceNode[] = [];
  let norm = 0;
  const amps = Array.from({ length: MODES }, (_, k) => Math.exp(-(((k - MODES / 2) / 6.5) ** 2) / 2));
  for (const a of amps) norm += a * a;
  amps.forEach((amp, k) => {
    const osc = context.createOscillator();
    osc.frequency.value = 130 + (k - MODES / 2) * 5.73 + (rnd() - 0.5) * 1.4;
    const inner = gain(context, 1);
    const pan = context.createStereoPanner();
    pan.pan.value = (rnd() - 0.5) * 0.9;
    osc.connect(inner).connect(gain(context, (amp / Math.sqrt(norm)) * 0.9)).connect(pan).connect(lowpass);
    osc.start();
    sources.push(osc, wobble(context, inner, 0.04 + 0.11 * rnd(), 0.8, rnd()));
  });
  return {
    set(level, _param, now) {
      setLevel(out, 'sun', level, now);
    },
    stop(now, seconds) {
      stopAll(sources, out, now, seconds);
    },
  };
}

/** Rain: a hiss and some 260 drops a second, each a tiny decaying tick, made once and looped without a seam. */
function rain(mix: Mix): Voice {
  const { context } = mix;
  const rate = context.sampleRate;
  const length = Math.floor(rate * 6);
  const buffer = context.createBuffer(2, length, rate);
  const rnd = random(131);
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let hp = 0;
    let prev = 0;
    for (let i = 0; i < length; i += 1) {
      const w = rnd() * 2 - 1;
      hp = 0.97 * (hp + w - prev);
      prev = w;
      data[i] = hp * 0.05;
    }
    const drops = Math.floor(6 * 260);
    for (let d = 0; d < drops; d += 1) {
      const at = Math.floor(rnd() * length);
      const amp = 0.04 + 0.5 * rnd() ** 3;
      const tau = rate * (0.0015 + 0.004 * rnd());
      const span = Math.floor(tau * 6);
      let lp = 0;
      for (let j = 0; j < span; j += 1) {
        lp = 0.55 * lp + 0.45 * (rnd() * 2 - 1);
        const i = (at + j) % length;
        data[i] = (data[i] ?? 0) + lp * amp * Math.exp(-j / tau);
      }
    }
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start(0, 1.3);
  const tone = filter(context, 'lowpass', 5000, 0.4);
  const out = output(mix, 'rain');
  source.connect(tone).connect(out);
  return {
    set(level, param, now) {
      setLevel(out, 'rain', level, now);
      tone.frequency.setTargetAtTime(2500 + 5000 * param, now, TAU.level);
    },
    stop(now, seconds) {
      stopAll([source], out, now, seconds);
    },
  };
}

/** The sea: two lines of waves, each a swell of noise that brightens as it breaks and darkens as it draws back. */
function surf(mix: Mix): Voice {
  const { context } = mix;
  const out = output(mix, 'surf');
  const rnd = random(173);
  const sources: AudioScheduledSourceNode[] = [];
  const lines = [-0.45, 0.5].map((side, i) => {
    const source = loop(mix, 'pink', 1.7 + i * 2.9);
    const tone = filter(context, 'lowpass', 600, 0.5);
    const swell = gain(context, 0.25);
    const pan = context.createStereoPanner();
    pan.pan.value = side;
    source.connect(tone).connect(swell).connect(pan).connect(out);
    sources.push(source);
    return { tone, swell, next: context.currentTime + i * 4.1 };
  });
  return {
    set(level, _param, now) {
      setLevel(out, 'surf', level, now);
    },
    tick(now) {
      for (const line of lines) {
        if (line.next > now + 1) continue;
        const at = Math.max(line.next, now);
        const rise = 2.6 + 1.6 * rnd();
        const fall = 3.5 + 2 * rnd();
        line.swell.gain.setTargetAtTime(0.85 + 0.15 * rnd(), at, rise / 3);
        line.swell.gain.setTargetAtTime(0.22, at + rise, fall / 3);
        line.tone.frequency.setTargetAtTime(1700 + 500 * rnd(), at + rise * 0.6, rise / 4);
        line.tone.frequency.setTargetAtTime(550, at + rise, fall / 3);
        line.next = at + 7.5 + 3.5 * rnd();
      }
    },
    stop(now, seconds) {
      stopAll(sources, out, now, seconds);
    },
  };
}

/** Wind: noise in a band that gusts, in loudness and in pitch, a little differently in each ear. */
function wind(mix: Mix): Voice {
  const { context } = mix;
  const out = output(mix, 'wind');
  const source = loop(mix, 'pink', 3.3);
  const band = filter(context, 'bandpass', 500, 0.9);
  const high = filter(context, 'highpass', 70, 0.5);
  const gust = gain(context, 0.75);
  source.connect(band).connect(high).connect(gust).connect(out);
  const rnd = random(211);
  let next = context.currentTime;
  let centre = 500;
  return {
    set(level, param, now) {
      setLevel(out, 'wind', level, now);
      centre = 350 + 600 * param;
    },
    tick(now) {
      if (next > now + 1) return;
      const at = Math.max(next, now);
      const strength = 0.55 + 0.45 * rnd();
      gust.gain.setTargetAtTime(strength, at, 0.8 + rnd());
      band.frequency.setTargetAtTime(centre * (0.75 + 0.5 * strength), at, 1 + rnd());
      next = at + 1.2 + 2 * rnd();
    },
    stop(now, seconds) {
      stopAll([source], out, now, seconds);
    },
  };
}

/** A body of low noise with occasional short tones over it: bubbles rising under water, or lava's blups. */
function bubbling(mix: Mix, name: 'underwater' | 'lava'): Voice {
  const { context } = mix;
  const water = name === 'underwater';
  const body = bed(mix, name, 'brown', () => ({ low: water ? 280 : 170, high: 22 }), { hz: water ? 0.07 : 0.12, depth: 0.25 });
  const rnd = random(water ? 251 : 263);
  let next = context.currentTime + 0.5;
  let level = 0;
  return {
    set(l, param, now) {
      level = l;
      body.set(l, param, now);
    },
    tick(now) {
      if (next > now + 1 || level < 0.02) {
        if (next < now) next = now + 0.3;
        return;
      }
      const at = Math.max(next, now);
      const osc = context.createOscillator();
      const env = gain(context, 0);
      const pan = context.createStereoPanner();
      pan.pan.value = (rnd() - 0.5) * 1.2;
      // A bubble's pitch rises as it shrinks and rises; a blup of lava falls as it bursts.
      const f0 = water ? 350 + 750 * rnd() : 70 + 80 * rnd();
      const length = water ? 0.06 + 0.07 * rnd() : 0.14 + 0.1 * rnd();
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f0 * (water ? 1.6 : 0.6), at + length);
      // The voice's output carries its level; this is the bubble's own loudness.
      const peak = water ? 0.05 + 0.07 * rnd() : 0.12 + 0.1 * rnd();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.006);
      env.gain.setTargetAtTime(0, at + 0.006, length / 3);
      osc.connect(env).connect(pan).connect(body.out);
      osc.start(at);
      osc.stop(at + length * 4);
      osc.onended = () => { pan.disconnect(); };
      next = at + (water ? 0.3 + 2.2 * rnd() : 0.4 + 1.6 * rnd());
    },
    stop(now, seconds) {
      body.stop(now, seconds);
    },
  };
}

function makeVoice(mix: Mix, name: VoiceName): Voice {
  switch (name) {
    case 'hush':
      return bed(mix, name, 'pink', (p) => ({ low: 250 + 1100 * p ** 1.5, high: 40 }), { hz: 0.06, depth: 0.15 });
    case 'rumble':
      return bed(mix, name, 'brown', () => ({ low: 140, high: 22 }), { hz: 0.08, depth: 0.25 });
    case 'convection':
      return bed(mix, name, 'brown', () => ({ low: 220, high: 25 }), { hz: 0.43, depth: 0.4 });
    case 'hiss':
      return bed(mix, name, 'white', (p) => ({ low: 2500 + 3500 * p, high: 900, q: 0.6, band: true }), { hz: 0.09, depth: 0.2 });
    case 'roar':
      return roar(mix);
    case 'sun':
      return sun(mix);
    case 'rain':
      return rain(mix);
    case 'surf':
      return surf(mix);
    case 'wind':
      return wind(mix);
    case 'underwater':
    case 'lava':
      return bubbling(mix, name);
  }
}

/** One-shots: a breath, an exhale, a low swell, a glint of high air, air rising. Every one eases in. */
function shot(mix: Mix, name: ShotName, now: number): void {
  const { context } = mix;
  const rnd = random(Math.floor(now * 1000) + name.length);
  const env = gain(context, 0);
  const pan = context.createStereoPanner();
  env.connect(pan);
  pan.connect(mix.dry);
  pan.connect(gain(context, 0.55)).connect(mix.wet);
  const source = context.createBufferSource();
  const g = env.gain;
  let end: number;
  g.setValueAtTime(0, now);
  if (name === 'breath' || name === 'exhale') {
    // Air through a mouth: two broad formants over pink noise; a breath swells and lets go, an exhale falls.
    source.buffer = noise(mix, 'pink');
    const f1 = filter(context, 'bandpass', 600, 1.4);
    const f2 = filter(context, 'bandpass', 1400, 1.6);
    const hp = filter(context, 'highpass', 250, 0.5);
    source.connect(hp);
    hp.connect(f1).connect(env);
    hp.connect(f2).connect(gain(context, 0.6)).connect(env);
    const peak = name === 'breath' ? 0.11 : 0.12;
    if (name === 'breath') {
      g.setTargetAtTime(peak, now, 0.6);
      g.setTargetAtTime(0, now + 2.2, 1.1);
      end = now + 8;
    } else {
      g.setTargetAtTime(peak, now, 0.25);
      g.setTargetAtTime(0, now + 0.9, 1.6);
      f1.frequency.setValueAtTime(900, now);
      f1.frequency.exponentialRampToValueAtTime(420, now + 5);
      f2.frequency.setValueAtTime(1800, now);
      f2.frequency.exponentialRampToValueAtTime(900, now + 5);
      end = now + 9;
    }
  } else if (name === 'swell') {
    // A low swell (a collapse, an impact, a star's death): felt more than heard, never a bang.
    source.buffer = noise(mix, 'brown');
    const lp = filter(context, 'lowpass', 110, 0.6);
    source.connect(lp).connect(env);
    const sub = context.createOscillator();
    sub.frequency.setValueAtTime(38, now);
    sub.frequency.exponentialRampToValueAtTime(29, now + 9);
    sub.connect(gain(context, 0.18)).connect(env);
    sub.start(now);
    sub.stop(now + 14);
    g.setTargetAtTime(0.3, now, 0.9);
    g.setTargetAtTime(0, now + 2.8, 2.4);
    end = now + 14;
  } else if (name === 'glint') {
    source.buffer = noise(mix, 'white');
    const band = filter(context, 'bandpass', 4200 + 2000 * rnd(), 2);
    source.connect(band).connect(env);
    pan.pan.value = (rnd() - 0.5) * 1;
    g.setTargetAtTime(0.025, now, 0.4);
    g.setTargetAtTime(0, now + 1.2, 1);
    end = now + 6;
  } else {
    source.buffer = noise(mix, 'pink');
    const band = filter(context, 'bandpass', 300, 0.8);
    band.frequency.setValueAtTime(300, now);
    band.frequency.exponentialRampToValueAtTime(1500, now + 10);
    source.connect(band).connect(env);
    g.setTargetAtTime(0.08, now, 2);
    g.setTargetAtTime(0, now + 6, 1.7);
    end = now + 14;
  }
  source.start(now, rnd() * 5);
  source.stop(end);
  source.onended = () => { pan.disconnect(); };
}

function eventTimes(content: ChapterContent): Map<string, number> {
  const times = new Map<string, number>();
  for (const cue of content.cues) if (cue.type === 'scene' && !times.has(cue.event)) times.set(cue.event, cue.t);
  return times;
}

/** A score time in seconds: a number, an event's time with its offset, or the end's; unknown events stay silent (NaN). */
export function resolveAt(at: At, events: ReadonlyMap<string, number>, duration: number): number {
  if (typeof at === 'number') return at;
  const m = /^(.+?)([+-]\d+(?:\.\d+)?)?$/u.exec(at);
  const name = m?.[1] ?? at;
  const base = name === 'end' ? duration : events.get(name);
  return base === undefined ? Number.NaN : base + Number(m?.[2] ?? 0);
}

/** A curve's value at t: eased (smoothstep) between its points, flat before the first and after the last. */
function valueAt(points: ReadonlyArray<readonly [number, number]>, t: number): number {
  const first = points[0];
  if (!first) return 0;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    const q = points[i - 1];
    if (!p || !q) break;
    if (t <= p[0]) {
      const u = p[0] > q[0] ? (t - q[0]) / (p[0] - q[0]) : 1;
      return q[1] + (p[1] - q[1]) * u * u * (3 - 2 * u);
    }
  }
  return points[points.length - 1]?.[1] ?? 0;
}

/** The duck at t: under a verse, near silence; under a hadith card, lower; otherwise full. */
function duckAt(cues: readonly Cue[], t: number): number {
  let duck = 1;
  for (const cue of cues) {
    if (cue.type !== 'verse' && cue.type !== 'hadith') continue;
    if (t >= cue.t && t < cue.t + cue.duration) duck = Math.min(duck, DUCK[cue.type]);
  }
  return duck;
}

interface Playing {
  chapter: ChapterId;
  content: ChapterContent;
  tracks: Array<{ name: VoiceName; voice: Voice; level: Array<[number, number]>; param: Array<[number, number]> }>;
  shots: Array<[number, ShotName]>;
  last: number | null;
}

export interface FilmScoreState {
  chapter: ChapterId | null;
  /** The film's level as the app sets it (0 with sound off, in the explorer, on loading screens). */
  level: number;
  /** Each voice's level now (0..1, before the duck), and the duck. */
  voices: Partial<Record<VoiceName, number>>;
  duck: number;
  /** One-shots fired so far, by name, for the tests. */
  shots: string[];
}

export interface FilmScore {
  /** The chapter that plays, or null for none (its sound fades out). */
  setChapter(chapter: ChapterId | null, content: ChapterContent | null): void;
  /** The chapter's time; `playing` false (paused, held, seeking) never fires a one-shot. */
  update(t: number, playing: boolean): void;
  /** The film's level as the visitor and the app allow it (sound off, the explorer, loading): 0..1. */
  setLevel(level: number): void;
  state(): FilmScoreState;
  dispose(): void;
}

export function createFilmScore(context: BaseAudioContext, destination: AudioNode): FilmScore {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const master = gain(context, 0);
  const duck = gain(context, 1);
  const dry = gain(context, 1);
  const wet = gain(context, 0.55);
  const reverb = context.createConvolver();
  reverb.normalize = false;
  reverb.buffer = impulse(context);
  dry.connect(duck);
  wet.connect(reverb).connect(gain(context, 0.5)).connect(duck);
  duck.connect(master).connect(limiter).connect(destination);
  const mix: Mix = { context, dry, wet, buffers: new Map() };
  let playing: Playing | null = null;
  let duckNow = 1;
  let levelNow = 0;
  const fired: string[] = [];
  const levels = new Map<VoiceName, number>();

  const stopPlaying = (): void => {
    if (!playing) return;
    const now = context.currentTime;
    for (const track of playing.tracks) track.voice.stop(now, 2);
    playing = null;
    levels.clear();
  };

  return {
    setChapter(chapter, content) {
      if (playing?.chapter === chapter && playing.content === content) return;
      stopPlaying();
      if (!chapter || !content) return;
      const score = SCORES[chapter];
      const events = eventTimes(content);
      const curve = (c: Curve | undefined, fallback: number): Array<[number, number]> =>
        (c ?? [[0, fallback]]).map(([at, v]) => [resolveAt(at, events, content.duration), v] as [number, number]).filter(([t]) => Number.isFinite(t));
      playing = {
        chapter,
        content,
        tracks: score.tracks.map((track) => ({ name: track.voice, voice: makeVoice(mix, track.voice), level: curve(track.level, 0), param: curve(track.param, track.voice === 'roar' ? 1 : 0.5) })),
        shots: (score.shots ?? []).map(([at, name]) => [resolveAt(at, events, content.duration), name] as [number, ShotName]).filter(([t]) => Number.isFinite(t)),
        last: null,
      };
    },
    update(t, isPlaying) {
      const p = playing;
      if (!p) return;
      const now = context.currentTime;
      for (const track of p.tracks) {
        const level = valueAt(track.level, t);
        levels.set(track.name, level);
        track.voice.set(level, valueAt(track.param, t), now);
        track.voice.tick?.(now);
      }
      const d = duckAt(p.content.cues, t);
      if (d !== duckNow) {
        duckNow = d;
        duck.gain.setTargetAtTime(d, now, TAU.duck);
      }
      if (isPlaying && p.last !== null && t > p.last && t - p.last < MAX_STEP_S) {
        for (const [at, name] of p.shots) {
          if (p.last < at && at <= t) {
            shot(mix, name, now);
            fired.push(`${p.chapter}:${name}`);
          }
        }
      }
      p.last = t;
    },
    setLevel(level) {
      levelNow = level;
      master.gain.setTargetAtTime(level, context.currentTime, TAU.change);
    },
    state() {
      return { chapter: playing?.chapter ?? null, level: levelNow, voices: Object.fromEntries(levels), duck: duckNow, shots: [...fired] };
    },
    dispose() {
      stopPlaying();
      master.disconnect();
    },
  };
}

/**
 * Renders a stretch of a chapter's sound offline, for the tests: per second, the louder channel's RMS
 * and peak. The film is played across it (one-shots fire), with the app's level at 1.
 */
export async function renderFilmSound(chapter: ChapterId, content: ChapterContent, from: number, to: number, sampleRate = 22050): Promise<{ rms: number[]; peak: number[] }> {
  const seconds = Math.max(1, Math.ceil(to - from));
  const context = new OfflineAudioContext(2, seconds * sampleRate, sampleRate);
  const score = createFilmScore(context, context.destination);
  score.setChapter(chapter, content);
  score.setLevel(1);
  // The film's time advances in tenths of a second, as the app's time events do.
  const STEPS_PER_SECOND = 10;
  score.update(from, true);
  for (let i = 1; i < seconds * STEPS_PER_SECOND; i += 1) {
    const at = i / STEPS_PER_SECOND;
    void context.suspend(at).then(() => {
      score.update(from + at, true);
      void context.resume();
    });
  }
  const buffer = await context.startRendering();
  const rms: number[] = [];
  const peak: number[] = [];
  for (let s = 0; s < seconds; s += 1) {
    let worstRms = 0;
    let worstPeak = 0;
    for (let ch = 0; ch < 2; ch += 1) {
      const data = buffer.getChannelData(ch).subarray(s * sampleRate, (s + 1) * sampleRate);
      let sum = 0;
      let max = 0;
      for (const x of data) {
        sum += x * x;
        max = Math.max(max, Math.abs(x));
      }
      worstRms = Math.max(worstRms, Math.sqrt(sum / data.length));
      worstPeak = Math.max(worstPeak, max);
    }
    rms.push(worstRms);
    peak.push(worstPeak);
  }
  return { rms, peak };
}
