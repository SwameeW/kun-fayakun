import type { ChapterContent, ChapterId, Cue } from './types';

/**
 * The film's sound (docs/SPEC.md section 6, film/shotlist.json's sound column): nature and physics
 * only. No music, no instrument, no melody or chord, no voice. Nothing here is an oscillator: every
 * sound is noise or a recording shaped by filters, so nothing can form a note; and no breath has a
 * mouth's resonances.
 *
 * Recorded, where a real sound is better than anything made (public domain or CC0, each credited in
 * data/sources.json; public/assets/sound, rebuilt from the originals by scripts/sound/build.py):
 * - the young Earth's lava: Kilauea's lava lake churning (USGS), a Yellowstone mudpot's plops slowed
 *   an octave into thick lava's, a vent's walls crackling in the heat (USGS); and for the bombardment,
 *   the distant thud of a real meteor that burst over Yellowstone, its infrasound sped up (USGS);
 * - a star's convection: a roiling mud pool (USGS, Yellowstone) slowed more than an octave;
 * - gas falling onto a white dwarf, the dust in the Sun's disk, the Big Rip's tearing: a steam vent's
 *   hiss (USGS), filtered, with the vent's crackle for the tearing;
 * - rain (CC0), the sea on a beach (public domain), and bubbles of carbon dioxide rising through a hot
 *   spring (USGS) for the first ocean;
 * - the low swells (a star's collapse and its Type Ia, the Sun's ignition, the giant impact) and the
 *   Big Crunch's gathering rumble: one rolling thunder (NPS), slowed and darkened until it is felt
 *   rather than heard, and played backwards for the gathering. It is never heard as a storm.
 * Made here, from the physics:
 * - Before the first light the young universe rang with sound waves in its plasma (the acoustic peaks
 *   of the Planck sky are their trace). Chapter 1 and the start of Chapter 2 sound those peaks, at
 *   l = 220, 540, 810, 1130 and 1440 with Planck's relative heights, as resonances of a roaring noise
 *   raised into hearing (never tones); they fall as space stretches, and darken and end at
 *   recombination, when light and matter part ("one exhaled breath, then silence").
 * - The Sun rings with millions of acoustic modes, about 135 microhertz apart near 3 mHz, each
 *   excited and damped at random by the boiling of its surface. Chapter 7 sounds the strongest twenty
 *   (l = 0 and 1), sped up about 165,000 times, each a band of noise swelling and fading on its own
 *   over the granulation's broad roar.
 * - Out in space, where nothing carries sound, a hush: bands of noise that drift slowly at random.
 *   The dark ages' deep rumble, the wind over new land, the body of the first sea, the breath of air
 *   as the word forms and the exhale at recombination are made the same way. Each noise is long
 *   (white 17 s, pink 27 s, brown 67 s) and every looping layer's speed wanders a little at random,
 *   so no layer's waveform, made or recorded, lines up with itself again. A recording's events still
 *   come back once a loop (lava 16 s, surf 29 s, steam 30 s), a little moved; the lava's is the one
 *   most likely to be heard.
 * Silence is kept where the film asks for it: before the word forms, after the plasma's sound ends,
 * for the verses of the end and after its light. A verse on screen sinks the sound to near silence
 * (the spec: ambient sound fades for the Quran, 7:204), a hadith card a little less; the sound eases
 * down just before a card and back up slowly after it, darkening as it sinks, and two cards close
 * together share one dip. Every swell eases in; nothing startles: the breath out of silence (as the
 * word forms, and as the word of the return forms) rises over three seconds to about -36 LUFS, about
 * level with the hush that follows it; nothing crackles like a record or static (the disk's dust is a
 * smooth hiss, the tearing's crackle and the lava's are softened above 3.5 kHz, the steam's puffs are
 * held down), and a star's glint shimmers above 5 kHz rather than in the band a small speaker makes
 * harsh.
 *
 * Loudness, the target (measured offline; tests/film-sound.spec.ts holds the film to it): outside its
 * verses and silences every chapter sits at -27 LUFS integrated, within 1.5 LU (Chapter 0, a breath
 * and a faint hush, about -39), its beds -28 to -24 LUFS short-term, the swells a few LU above them
 * (about -20 LUFS momentary at most), true peaks under -3 dBFS; on a laptop's speakers within about
 * 3 dB of that, on a phone's within about 6. Under a verse it sinks to -52 to -61 LUFS. The master:
 * a high-pass under 32 Hz; harmonics of the deepest sound (under 110 Hz) added from 200 to 700 Hz,
 * where a laptop's speakers play, so a swell or rumble is still felt there (measured: with them the
 * swells of Chapters 6 and 8 are 2.5 to 3.3 dB louder on a laptop, about 1 dB over the full range);
 * a high shelf so no bed hisses on a phone; a gentle bus compressor; a limiter; and a soft clip that
 * holds any peak under -1 dBFS. A long reverb (an impulse made here, darkening as it decays) gives the
 * one-shots and resonances their space.
 *
 * Levels are written per chapter against its scene events (content.json), so re-timing a chapter
 * moves its sound with its picture. Loaded with its own chunk the first time a chapter plays with
 * sound on (./film-sound decides when). A chapter's voices all play at once; each recording joins its
 * layer when it arrives (a slow or missing one leaves only that layer silent, and a one-shot due
 * before it plays its made part), and a download that stalls is let go after STALL_S. Once a
 * chapter's recordings are in, the next chapter's are fetched; only those two chapters' are kept,
 * and all are let go, with the noises, when the film's sound stops or the explorer opens.
 */

type VoiceName = 'hush' | 'rumble' | 'roar' | 'convection' | 'sun' | 'infall' | 'dust' | 'tear' | 'rain' | 'surf' | 'wind' | 'underwater' | 'lava';
type ShotName = 'breath' | 'exhale' | 'swell' | 'glint' | 'rise' | 'surface' | 'gather' | 'thud';
type RecordingName = 'lava' | 'crackle' | 'mud' | 'roil' | 'steam' | 'bubbles' | 'rain' | 'surf' | 'thunder' | 'bolide';
/** A chapter time: seconds, a scene event ('cool'), one with an offset ('cool+6'), or the end ('end-4'). */
type At = number | string;
type Curve = ReadonlyArray<readonly [At, number]>;

interface Track {
  voice: VoiceName;
  /** 0..1 over the chapter, eased between points. */
  level: Curve;
  /** The voice's one parameter: brightness (0..1); for the roar its pitch (1 = the peaks' own); for the sea its nearness, under water its depth. */
  param?: Curve;
}

/** A one-shot at a time, and how much longer than its own length it lasts (1 if not given). */
type Shot = readonly [At, ShotName] | readonly [At, ShotName, number];

interface Score {
  tracks: readonly Track[];
  shots?: readonly Shot[];
}

const SCORES: Readonly<Record<ChapterId, Score>> = {
  // Before creation: silence; one breath of air as the word forms; a faint hush while it holds; silence after its light.
  ch00: {
    tracks: [{ voice: 'hush', level: [[0, 0], ['kun-hold', 0], ['kun-hold+5', 0.22], ['kun-fade', 0.22], ['kun-fade+5', 0]], param: [[0, 0.25]] }],
    shots: [['kun-reveal', 'breath']],
  },
  // The beginning: the plasma's sound rises with the point of light and widens and falls as space stretches.
  ch01: {
    tracks: [
      { voice: 'roar', level: [[0, 0], ['ignite', 0], ['ignite+9', 0.42], ['expand', 0.52], ['cool', 0.6], ['end', 0.6]], param: [[0, 1.9], ['expand', 1.7], ['cool', 1.3], ['end', 1.08]] },
      { voice: 'hush', level: [[0, 0], ['expand', 0], ['expand+6', 0.3], ['end', 0.22]], param: [[0, 0.5], ['end', 0.35]] },
    ],
  },
  // The first light: the sound goes on in the plasma until recombination, then darkens and ends; a hush opens around the Planck sky.
  ch02: {
    tracks: [
      { voice: 'roar', level: [[0, 0.6], ['recombination', 0.6], ['recombination+5', 0]], param: [[0, 1.08], ['recombination', 0.95]] },
      { voice: 'hush', level: [[0, 0], ['cmb-reveal+2', 0], ['cmb-hold', 0.4], ['end-3', 0.4], ['end', 0.15]], param: [[0, 0.3]] },
    ],
    shots: [['recombination', 'exhale']],
  },
  // The dark ages, deep and low; the first stars lift and brighten the hush, with a glint of high air as each ignites.
  ch03: {
    tracks: [
      { voice: 'rumble', level: [[0, 0.5], ['web', 0.45], ['stars', 0.25], ['galaxies', 0.18]] },
      { voice: 'hush', level: [[0, 0.2], ['web', 0.3], ['stars', 0.45], ['galaxies', 0.5], ['end', 0.45]], param: [[0, 0.1], ['web', 0.3], ['stars', 0.6], ['galaxies', 0.7]] },
    ],
    shots: [['stars+1', 'glint'], ['stars+7', 'glint'], ['stars+14', 'glint'], ['galaxies+4', 'glint']],
  },
  // A vast heaven: a wind-like hush that deepens as the galaxies' light reddens.
  ch04: {
    tracks: [{ voice: 'hush', level: [[0, 0.5], ['stretch', 0.55], ['end-3', 0.5], ['end', 0.25]], param: [[0, 0.6], ['stretch', 0.55], ['redshift', 0.5], ['redshift+12', 0.2]] }],
  },
  // The galaxies: air rising as the view draws back through five powers of ten.
  ch05: {
    tracks: [{ voice: 'hush', level: [[0, 0.45], ['pull-back', 0.45], ['pull-back+10', 0.6], ['survey+6', 0.5], ['end-8', 0.5], ['end', 0.2]], param: [[0, 0.4], ['pull-back', 0.4], ['pull-back+12', 0.65], ['survey+6', 0.5]] }],
    shots: [['pull-back', 'rise']],
  },
  // Stars and iron: the churning inside a star; one low swell for the collapse and one for the Type Ia,
  // the gas falling onto the white dwarf before it, the hum after it fading as the nickel-56 and
  // cobalt-56 decay chain dims its light.
  ch06: {
    tracks: [
      { voice: 'convection', level: [[0, 0.6], ['collapse', 0.6], ['collapse+3', 0]] },
      { voice: 'hush', level: [[0, 0], ['collapse+4', 0], ['collapse+10', 0.3], ['white-dwarf', 0.3], ['white-dwarf+3', 0.15], ['end', 0.15]], param: [[0, 0.3]] },
      { voice: 'infall', level: [[0, 0], ['white-dwarf', 0], ['white-dwarf+3', 0.5], ['type-ia', 0.5], ['type-ia+2', 0]], param: [[0, 0.5]] },
      { voice: 'rumble', level: [[0, 0], ['type-ia', 0], ['type-ia+3', 0.55], ['type-ia+8', 0.4], ['type-ia+16', 0.2], ['end', 0.1]] },
    ],
    shots: [['collapse', 'swell'], ['type-ia', 'swell']],
  },
  // The Sun: dust in the disk under a hush; a slow swell as it begins to shine; its own acoustic modes when it is seen close.
  ch07: {
    tracks: [
      { voice: 'dust', level: [[0, 0.4], ['ignite', 0.4], ['ignite+8', 0.22], ['clear', 0]], param: [[0, 0.4]] },
      { voice: 'hush', level: [[0, 0.45], ['ignite', 0.45], ['clear', 0.2], ['clear+6', 0], ['orrery', 0], ['orrery+4', 0.38], ['galaxy', 0.4], ['galaxy+10', 0.55], ['end', 0.45]], param: [[0, 0.35]] },
      { voice: 'sun', level: [[0, 0], ['clear', 0], ['clear+8', 0.72], ['orrery', 0.6], ['orrery+4', 0.15], ['moon', 0]] },
    ],
    shots: [['ignite', 'swell']],
  },
  // The earth spread out: lava under a bombardment, the giant impact, the first rain and seas, then wind over the land.
  ch08: {
    tracks: [
      { voice: 'lava', level: [[0, 0.6], ['impact', 0.55], ['impact+12', 0.4], ['oceans', 0.15], ['oceans+10', 0]] },
      { voice: 'rain', level: [[0, 0], ['oceans', 0], ['oceans+4', 0.6], ['continents-6', 0.5], ['continents+4', 0.15], ['continents+12', 0]], param: [[0, 0.6]] },
      { voice: 'surf', level: [[0, 0], ['oceans+20', 0], ['oceans+30', 0.4], ['continents', 0.5], ['end', 0.4]], param: [[0, 0.45]] },
      { voice: 'wind', level: [[0, 0], ['continents-4', 0], ['continents+4', 0.5], ['end-30', 0.4], ['end', 0.2]], param: [[0, 0.4]] },
    ],
    shots: [['molten+3', 'thud'], ['molten+9', 'thud'], ['molten+15', 'thud'], ['impact', 'thud'], ['impact', 'swell']],
  },
  // Life from water: under the sea among rising bubbles, up through its surface, then the sea and the wind of the living Earth.
  ch09: {
    tracks: [
      { voice: 'underwater', level: [[0, 0.6], ['rise+6', 0.6], ['rise+9', 0]], param: [[0, 1], ['rise', 1], ['rise+8', 0.2]] },
      { voice: 'surf', level: [[0, 0], ['rise+8', 0], ['rise+11', 0.55], ['end', 0.4]], param: [[0, 0.8]] },
      { voice: 'wind', level: [[0, 0], ['oxygen', 0.15], ['oxygen+8', 0.45], ['green', 0.45], ['end-10', 0.4], ['end', 0.2]], param: [[0, 0.35], ['green', 0.5]] },
    ],
    shots: [['rise+5', 'surface']],
  },
  // The end: the hush of the galaxies thins with heat death, tears with the Big Rip, gathers with the
  // Big Crunch; then silence for the verses of the end. A long exhale as the heavens fold, one breath
  // as the word of the return forms (as it began, Chapter 0), and silence to close.
  ch10: {
    tracks: [
      { voice: 'hush', level: [[0, 0.5], ['heat-death', 0.5], ['heat-death+10', 0.14], ['big-rip', 0.28], ['big-crunch', 0.38], ['still-3', 0.32], ['still+2', 0]], param: [[0, 0.45], ['heat-death', 0.45], ['heat-death+10', 0.15], ['big-rip', 0.5]] },
      { voice: 'tear', level: [[0, 0], ['big-rip', 0], ['big-rip+6', 0.55], ['big-rip+11', 0]], param: [[0, 0], ['big-rip', 0], ['big-rip+11', 1]] },
      { voice: 'rumble', level: [[0, 0], ['big-crunch', 0], ['big-crunch+8', 0.45], ['still', 0]] },
    ],
    shots: [['big-crunch', 'gather'], ['fold', 'exhale', 1.4], ['calligraphy', 'breath']],
  },
};

/** The recordings (public/assets/sound/<name>.m4a): seconds of seamless loop, or null for a one-shot (scripts/sound/build.py makes them so). */
const RECORDINGS: Readonly<Record<RecordingName, number | null>> = {
  lava: 16,
  crackle: null,
  mud: 30,
  roil: 30,
  steam: 30,
  bubbles: 30,
  rain: 30,
  surf: 30,
  thunder: null,
  bolide: null,
};
/** A loop's file holds a quarter second of its own end before it and of its start after it. */
const PAD_S = 0.25;
/** The recordings' own rate: decoded at it, so a 32 kHz file takes no more memory than it needs. */
const RECORDING_RATE = 32_000;
/** How long a recording's download may go without a byte before it is let go (it is tried again the next time its chapter plays). */
const STALL_S = 15;
const VOICE_RECORDINGS: Partial<Readonly<Record<VoiceName, readonly RecordingName[]>>> = {
  convection: ['roil'],
  infall: ['steam'],
  dust: ['steam'],
  tear: ['steam', 'crackle'],
  rain: ['rain'],
  surf: ['surf'],
  underwater: ['bubbles'],
  lava: ['lava', 'mud', 'crackle'],
};
const SHOT_RECORDINGS: Partial<Readonly<Record<ShotName, readonly RecordingName[]>>> = {
  swell: ['thunder'],
  gather: ['thunder'],
  thud: ['bolide'],
  surface: ['bubbles'],
};

/** Each voice's gain at level 1: on its own, level 1 is about -22 LUFS and 0.5 about -28 (measured offline). */
const GAIN: Readonly<Record<VoiceName, number>> = {
  hush: 0.33,
  rumble: 0.39,
  roar: 0.68,
  convection: 0.5,
  sun: 0.69,
  infall: 1.38,
  dust: 0.92,
  tear: 0.95,
  rain: 1.16,
  surf: 0.67,
  wind: 0.52,
  underwater: 0.26,
  lava: 0.65,
};
/** How much of each voice goes to the reverb: the resonances and the airy voices most, the beds and the near sounds little. */
const SEND: Readonly<Record<VoiceName, number>> = {
  hush: 0.15,
  rumble: 0.12,
  roar: 0.4,
  convection: 0.2,
  sun: 0.45,
  infall: 0.3,
  dust: 0.35,
  tear: 0.35,
  rain: 0.08,
  surf: 0.1,
  wind: 0.12,
  underwater: 0.25,
  lava: 0.15,
};
/** The one-shots' own loudness and reverb (the reverb is the space a glint or a swell rings in). */
const SHOT_GAIN: Readonly<Record<ShotName, number>> = { breath: 0.145, exhale: 0.34, swell: 0.5, glint: 0.37, rise: 0.3, surface: 0.32, gather: 0.3, thud: 0.5 };
const SHOT_SEND: Readonly<Record<ShotName, number>> = { breath: 0.3, exhale: 0.35, swell: 0.4, glint: 0.8, rise: 0.3, surface: 0.25, gather: 0.3, thud: 0.4 };
/** Under a verse the sound sinks to near silence; under a hadith card, a little less (dB). */
const DUCK_DB = { verse: -26, hadith: -14 } as const;
/** The duck begins this long before a card and is down when it is up; it lets go after a card in RELEASE seconds; cards closer than MERGE share one dip. */
const DUCK_S = { lead: 1.5, settle: 0.5, hold: 0.5, release: 5, merge: 5 } as const;
/** Easing time constants (s): levels, a drift's step, a chapter's change. */
const TAU = { level: 0.35, drift: 0.5, change: 0.5 } as const;
/** A one-shot fires when the film plays across its time, not when a seek jumps over it. */
const MAX_STEP_S = 0.6;
/** What the master's compressor and limiter add on their own (Web Audio's automatic make-up gain, measured), taken back after each. */
const MAKEUP_DB = { glue: 4.5, limiter: 1.7 } as const;

type Color = 'white' | 'pink' | 'brown';

/**
 * The noises: each colour its own length, so no two line up, and made at no higher a rate than its
 * sound needs (brown is all under a few hundred hertz), which keeps them to about 8 MB.
 */
const NOISE: Readonly<Record<Color, { seconds: number; rate: number }>> = {
  white: { seconds: 17.3, rate: 32_000 },
  pink: { seconds: 26.9, rate: 32_000 },
  brown: { seconds: 67.1, rate: 8000 },
};
/** How far a looping layer's speed wanders at random (a fraction either way), and the wander's period (s). */
const WANDER = { depth: 0.02, period: 9 } as const;

interface Voice {
  /** Level 0..1 and the parameter, eased from `now`; the voice's own slow movement goes on with it. */
  set(level: number, param: number, now: number): void;
  /** Fades out and stops by `now + seconds`. */
  stop(now: number, seconds: number): void;
}

interface Mix {
  context: BaseAudioContext;
  dry: GainNode;
  wet: GainNode;
  noise: Map<Color, AudioBuffer>;
  /** The recordings in hand (the chapter playing and the next), decoded. */
  recordings: Map<RecordingName, AudioBuffer>;
  reversed: Map<RecordingName, AudioBuffer>;
  /** A recording, fetched and decoded once while it is wanted: resolves as it arrives, or null if it cannot be had. */
  load(name: RecordingName): Promise<AudioBuffer | null>;
}

const db = (decibels: number): number => 10 ** (decibels / 20);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** A number from a name, the same in every run (each voice's seed). */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
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

/** A random value in -1..1 for knot i of a seed. */
function knot(seed: number, i: number): number {
  let x = (seed ^ Math.imul(i, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (((x ^ (x >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

/** Slow random movement in about -1..1 over time: smoothed random knots `period` seconds apart, with a faster, smaller second layer. */
function drift(seed: number, period: number): (t: number) => number {
  const layer = (s: number, p: number, t: number): number => {
    const x = t / p;
    const i = Math.floor(x);
    const u = x - i;
    const a = knot(s, i);
    return a + (knot(s, i + 1) - a) * u * u * (3 - 2 * u);
  };
  return (t) => (layer(seed, period, t) + 0.45 * layer(seed + 101, period / 2.7, t)) / 1.15;
}

/** Mono noise of a colour (NOISE: its length and rate), its ends crossfaded so it loops without a seam. Each layer plays it at its own speed and start. */
function noise(mix: Mix, color: Color): AudioBuffer {
  const cached = mix.noise.get(color);
  if (cached) return cached;
  const rate = Math.min(NOISE[color].rate, mix.context.sampleRate);
  const length = Math.floor(rate * NOISE[color].seconds);
  const fade = Math.floor(rate * 0.5);
  const buffer = mix.context.createBuffer(1, length, rate);
  const rnd = random(hash(color));
  const raw = new Float32Array(length + fade);
  // Brown noise leaks back to zero with a corner near 150 Hz, whatever the rate.
  const leak = Math.exp((-2 * Math.PI * 150) / rate);
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
      brown = brown * leak + white * (1 - leak);
      raw[i] = brown;
    }
  }
  const out = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const head = raw[i] ?? 0;
    if (i < fade) {
      const u = i / fade;
      out[i] = head * Math.sqrt(u) + (raw[length + i] ?? 0) * Math.sqrt(1 - u);
    } else out[i] = head;
    sum += (out[i] ?? 0) ** 2;
  }
  // Every colour at the power it has at 48 kHz with an RMS of 0.2 (white keeps that power per hertz at
  // its lower rate), so a filter's band holds what the colour gives it.
  const scale = sum > 0 ? (color === 'white' ? 0.2 * Math.sqrt(rate / 48_000) : 0.2) / Math.sqrt(sum / length) : 0;
  for (let i = 0; i < length; i += 1) out[i] = (out[i] ?? 0) * scale;
  mix.noise.set(color, buffer);
  return buffer;
}

/**
 * A looping layer's speed, wandering slowly at random about `rate` (WANDER) for the next twenty
 * minutes: a loop then never meets itself again at the same place and speed, so its waveform never
 * repeats (a recorded event still comes back about once a loop).
 * Far too slow and small to hear as a change of pitch in noise, rain or the sea.
 */
function wander(param: AudioParam, rate: number, seed: number, at: number): void {
  const d = drift(seed, WANDER.period);
  const curve = new Float32Array(2400);
  for (let i = 0; i < curve.length; i += 1) curve[i] = rate * (1 + WANDER.depth * d(i / 2));
  param.setValueCurveAtTime(curve, at, (curve.length - 1) / 2);
}

/**
 * A space's reverberation: 4.8 s of decaying stereo noise after 32 ms, which darkens as it fades (a
 * low-pass falling from about 7 kHz to 600 Hz), so the low notes ring longest, as in a large hall.
 */
function impulse(context: BaseAudioContext): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.floor(rate * 4.8);
  const delay = Math.floor(rate * 0.032);
  const buffer = context.createBuffer(2, length, rate);
  const rnd = random(hash('hall'));
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    let energy = 0;
    for (let i = delay; i < length; i += 1) {
      const t = (i - delay) / rate;
      const cutoff = 600 + 6400 * Math.exp(-t / 1.1);
      const k = Math.exp((-2 * Math.PI * cutoff) / rate);
      low = low * k + (rnd() * 2 - 1) * (1 - k);
      // A 4 s decay (60 dB) at the lowest; the onset eased over 40 ms so nothing clicks.
      const onset = t < 0.04 ? Math.sin((Math.PI / 2) * (t / 0.04)) ** 2 : 1;
      data[i] = low * onset * Math.exp((-6.91 * t) / 4);
      energy += (data[i] ?? 0) ** 2;
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i += 1) data[i] = (data[i] ?? 0) * scale;
  }
  return buffer;
}

function filter(context: BaseAudioContext, type: BiquadFilterType, frequency: number, q = 0.707): BiquadFilterNode {
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

function pan(context: BaseAudioContext, value: number): StereoPannerNode {
  const p = context.createStereoPanner();
  p.pan.value = value;
  return p;
}

/** A stereo sound with its sides swapped (a second copy of a recording that should not mirror the first). */
function mirror(context: BaseAudioContext, from: AudioNode): AudioNode {
  const split = context.createChannelSplitter(2);
  const merge = context.createChannelMerger(2);
  from.connect(split);
  split.connect(merge, 0, 1);
  split.connect(merge, 1, 0);
  return merge;
}

function ease(param: AudioParam, value: number, now: number, tau: number = TAU.drift): void {
  param.setTargetAtTime(value, now, tau);
}

/** An envelope from silence to silence: a raised-cosine rise, a hold, then a fall that reaches zero exactly. Returns when it ends. */
function envelope(param: AudioParam, at: number, peak: number, rise: number, hold: number, fall: number): number {
  const total = rise + hold + fall;
  const curve = new Float32Array(256);
  for (let i = 0; i < curve.length; i += 1) {
    const t = (i / (curve.length - 1)) * total;
    const v = t < rise ? 0.5 - 0.5 * Math.cos((Math.PI * t) / rise) : t < rise + hold ? 1 : (1 - (t - rise - hold) / fall) ** 3;
    curve[i] = v * peak;
  }
  param.setValueCurveAtTime(curve, at, total);
  return at + total;
}

/** A parameter moved through values evenly spread over `seconds`, eased between them. */
function sweep(param: AudioParam, at: number, seconds: number, values: readonly number[]): void {
  const curve = new Float32Array(128);
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * (values.length - 1);
    const j = Math.min(values.length - 2, Math.floor(x));
    const u = x - j;
    const a = values[j] ?? 0;
    curve[i] = a + ((values[j + 1] ?? a) - a) * u * u * (3 - 2 * u);
  }
  param.setValueCurveAtTime(curve, at, seconds);
}

/** The pieces every voice is built from: its output, its noises and recordings (each with its own speed and start), its drifts. */
interface Kit {
  context: BaseAudioContext;
  out: GainNode;
  rnd: () => number;
  noise(color: Color): AudioBufferSourceNode;
  /** A buffer of the voice's own, looping from a random start. */
  loop(buffer: AudioBuffer): AudioBufferSourceNode;
  /**
   * Where a recording plays (looping from `offset`) once it arrives: silent until then, and silent
   * for good if it cannot be had. One that comes after the voice has begun eases in.
   */
  recording(name: RecordingName, rate: number, offset: number): AudioNode;
  drift(period: number): (t: number) => number;
  level(level: number, now: number): void;
  stop(now: number, seconds: number): void;
}

function kit(mix: Mix, name: VoiceName): Kit {
  const { context } = mix;
  const out = gain(context, 0);
  const send = gain(context, SEND[name]);
  out.connect(mix.dry);
  out.connect(send).connect(mix.wet);
  const sources: AudioScheduledSourceNode[] = [];
  const seed = hash(name);
  const rnd = random(seed);
  const born = context.currentTime;
  let drifts = 0;
  let wanders = 0;
  let stopped = false;
  const wanderFrom = (source: AudioBufferSourceNode, rate: number): void => {
    wanders += 1;
    wander(source.playbackRate, rate, seed + 104_729 * wanders, context.currentTime);
  };
  return {
    context,
    out,
    rnd,
    noise(color) {
      const source = this.loop(noise(mix, color));
      wanderFrom(source, 0.93 + 0.14 * rnd());
      return source;
    },
    loop(buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.start(0, rnd() * buffer.duration);
      sources.push(source);
      return source;
    },
    recording(recording, rate, offset) {
      const inlet = gain(context, 0);
      void mix.load(recording).then(() => {
        const source = stopped ? null : play(mix, recording, rate, offset, 0);
        if (!source) return;
        sources.push(source);
        wanderFrom(source, rate);
        source.connect(inlet);
        const now = context.currentTime;
        if (now - born < 0.25) inlet.gain.value = 1;
        else inlet.gain.setTargetAtTime(1, now, 0.7);
      });
      return inlet;
    },
    drift(period) {
      drifts += 1;
      return drift(seed + drifts * 7919, period);
    },
    level(level, now) {
      out.gain.setTargetAtTime(level * GAIN[name], now, TAU.level);
    },
    stop(now, seconds) {
      stopped = true;
      out.gain.cancelScheduledValues(now);
      out.gain.setTargetAtTime(0, now, seconds / 4);
      for (const s of sources) s.stop(now + seconds);
      // Disconnected once silent, its send too, so nothing of a past chapter lingers in the graph.
      const release = (): void => {
        out.disconnect();
        send.disconnect();
      };
      const first = sources[0];
      if (first) first.onended = release;
      else release();
    },
  };
}

/** A recording from the chapter's set: a loop from `offset` into it, or a one-shot from `offset`; null if it did not load. */
function play(mix: Mix, name: RecordingName, rate: number, offset: number, when: number, backwards = false): AudioBufferSourceNode | null {
  const buffer = backwards ? reversed(mix, name) : mix.recordings.get(name);
  if (!buffer) return null;
  const source = mix.context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const loop = RECORDINGS[name];
  if (loop !== null && !backwards) {
    source.loop = true;
    source.loopStart = PAD_S;
    source.loopEnd = PAD_S + loop;
    source.start(when, PAD_S + (offset % loop));
  } else source.start(when, Math.min(offset, buffer.duration));
  return source;
}

function reversed(mix: Mix, name: RecordingName): AudioBuffer | undefined {
  const cached = mix.reversed.get(name);
  if (cached) return cached;
  const buffer = mix.recordings.get(name);
  if (!buffer) return undefined;
  const back = mix.context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) back.getChannelData(ch).set(buffer.getChannelData(ch).slice().reverse());
  mix.reversed.set(name, back);
  return back;
}

/** Space: a body of noise above 140 Hz, darkened above a few hundred hertz; air in two wandering bands, one to each side; a faint sheen when it is bright. */
function hush(mix: Mix): Voice {
  const k = kit(mix, 'hush');
  const c = k.context;
  const bodyTone = filter(c, 'lowpass', 400, 0.6);
  const body = gain(c, 1);
  bodyTone.connect(body).connect(k.out);
  for (const side of [-0.3, 0.3]) k.noise('pink').connect(filter(c, 'highpass', 140)).connect(filter(c, 'highpass', 140)).connect(pan(c, side)).connect(bodyTone);
  const air = [-0.6, 0.6].map((side) => {
    const band = filter(c, 'bandpass', 900, 0.7);
    const level = gain(c, 0);
    k.noise('pink').connect(filter(c, 'highpass', 200)).connect(band).connect(level).connect(pan(c, side)).connect(k.out);
    return { band, level, centre: k.drift(23), swell: k.drift(13) };
  });
  const sheen = gain(c, 0);
  k.noise('white').connect(filter(c, 'bandpass', 3000, 0.8)).connect(filter(c, 'lowpass', 5000, 0.5)).connect(sheen).connect(pan(c, 0.25)).connect(k.out);
  const breathe = k.drift(31);
  const bodySwell = k.drift(17);
  return {
    set(level, p, now) {
      k.level(level * db(1.5 * breathe(now)), now);
      ease(bodyTone.frequency, 350 + 650 * p, now);
      ease(body.gain, db(3 * bodySwell(now)), now);
      for (const a of air) {
        ease(a.band.frequency, (500 + 1300 * p) * (1 + 0.3 * a.centre(now)), now);
        ease(a.level.gain, (0.7 + 0.8 * p) * db(5 * a.swell(now)), now);
      }
      ease(sheen.gain, 0.5 * Math.max(0, p - 0.35), now);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** Deep and low: a felt sub of brown noise, and over it the part a small speaker plays, 120 to 500 Hz, swelling at random to each side. */
function rumble(mix: Mix): Voice {
  const k = kit(mix, 'rumble');
  const c = k.context;
  const sub = gain(c, 0.5);
  k.noise('brown').connect(filter(c, 'lowpass', 100, 0.6)).connect(filter(c, 'highpass', 30)).connect(sub).connect(k.out);
  const bands = [-0.4, 0.4].map((side) => {
    const g = gain(c, 1.4);
    k.noise('pink').connect(filter(c, 'bandpass', 260, 0.7)).connect(filter(c, 'lowpass', 700, 0.6)).connect(g).connect(pan(c, side)).connect(k.out);
    return { g, swell: k.drift(4.5) };
  });
  const subSwell = k.drift(7);
  return {
    set(level, _p, now) {
      k.level(level, now);
      ease(sub.gain, 0.5 * db(4 * subSwell(now)), now);
      for (const b of bands) ease(b.g.gain, 1.4 * db(7 * b.swell(now)), now);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/**
 * The plasma's sound: Planck's five acoustic peaks as resonances of a roaring noise (a third of an
 * octave and more wide, never tones), each wandering a little in level and place, over a broad roar
 * that darkens as it dies and a low weight; all fall together as space stretches.
 */
function roar(mix: Mix): Voice {
  const k = kit(mix, 'roar');
  const c = k.context;
  /** Planck's acoustic peaks: multipole l and relative amplitude (square root of the peak's D_l). */
  const PEAKS: ReadonlyArray<readonly [number, number]> = [[220, 1], [540, 0.68], [810, 0.66], [1130, 0.46], [1440, 0.37]];
  /** The first peak at 154 Hz at pitch 1 (l times 0.7 Hz). */
  const HZ_PER_L = 0.7;
  const bands = PEAKS.map(([l, amp], i) => {
    const band = filter(c, 'bandpass', l * HZ_PER_L, 2.2);
    const level = gain(c, amp);
    k.noise('pink').connect(band).connect(level).connect(pan(c, (i % 2 === 0 ? -1 : 1) * (0.15 + 0.1 * i))).connect(k.out);
    return { band, level, l, amp, place: k.drift(11 + 3 * i), swell: k.drift(6 + 2.5 * i) };
  });
  const tone = filter(c, 'lowpass', 900, 0.5);
  const broad = gain(c, 0.3);
  k.noise('pink').connect(filter(c, 'highpass', 90)).connect(tone).connect(broad).connect(k.out);
  const sub = gain(c, 0.2);
  k.noise('brown').connect(filter(c, 'lowpass', 90, 0.6)).connect(filter(c, 'highpass', 28)).connect(sub).connect(k.out);
  return {
    set(level, pitch, now) {
      k.level(level, now);
      for (const b of bands) {
        ease(b.band.frequency, b.l * HZ_PER_L * pitch * (1 + 0.03 * b.place(now)), now, 1.2);
        ease(b.level.gain, b.amp * db(3 * b.swell(now)), now);
      }
      ease(tone.frequency, (300 + 1500 * Math.min(1, level)) * pitch, now, 0.8);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** A star's convection: a roiling mud pool slowed more than an octave, two copies apart, over a deep weight that boils up now and then. */
function convection(mix: Mix): Voice {
  const k = kit(mix, 'convection');
  const c = k.context;
  const layers = ([[0.42, 0, -0.5], [0.36, 13.7, 0.5]] as const).map(([rate, offset, side]) => {
    const g = gain(c, 1);
    k.recording('roil', rate, offset).connect(filter(c, 'lowpass', 1600, 0.6)).connect(g).connect(pan(c, side)).connect(k.out);
    return { g, swell: k.drift(9) };
  });
  const sub = gain(c, 0.25);
  k.noise('brown').connect(filter(c, 'lowpass', 110, 0.6)).connect(filter(c, 'highpass', 30)).connect(sub).connect(k.out);
  const boil = k.drift(3.3);
  return {
    set(level, _p, now) {
      k.level(level, now);
      for (const l of layers) ease(l.g.gain, db(3 * l.swell(now)), now);
      ease(sub.gain, 0.25 * db(5 * boil(now)), now);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/**
 * The Sun's acoustic modes: l = 0 and 1 for overtones n = 17 to 26, at Delta-nu (n + l/2 + epsilon)
 * (Delta-nu 135 microhertz, epsilon 1.45), with heights on a Gaussian about 3.1 mHz, sped up 165,000
 * times (411 to 622 Hz). Each mode is a band of noise excited and damped at random, as the Sun's are
 * by its boiling surface, over the granulation's broad roar.
 */
function sun(mix: Mix): Voice {
  const k = kit(mix, 'sun');
  const c = k.context;
  const DELTA_NU = 135e-6;
  const EPSILON = 1.45;
  const NU_MAX = 3.1e-3;
  const SPEED = 165_000;
  const granulation = gain(c, 0.35);
  k.noise('pink').connect(filter(c, 'highpass', 140)).connect(filter(c, 'lowpass', 1600, 0.5)).connect(granulation).connect(k.out);
  const sides = [k.noise('pink'), k.noise('pink')];
  const modes: Array<{ level: GainNode; height: number; excite: (t: number) => number }> = [];
  for (let n = 17; n <= 26; n += 1) {
    for (const l of [0, 1]) {
      const nu = DELTA_NU * (n + l / 2 + EPSILON);
      const height = Math.exp(-0.5 * ((nu - NU_MAX) / 0.42e-3) ** 2) * (l === 0 ? 1 : 0.85);
      const band = filter(c, 'bandpass', nu * SPEED * (1 + (k.rnd() - 0.5) * 0.02), 14);
      const level = gain(c, 0);
      sides[l]?.connect(band).connect(level).connect(pan(c, (k.rnd() - 0.5) * 1.2)).connect(k.out);
      modes.push({ level, height, excite: k.drift(2 + 4 * k.rnd()) });
    }
  }
  const roil = k.drift(8);
  return {
    set(level, _p, now) {
      k.level(level, now);
      ease(granulation.gain, 0.35 * db(3 * roil(now)), now);
      for (const m of modes) ease(m.level.gain, 2.2 * m.height * (0.12 + 0.88 * ((1 + m.excite(now)) / 2) ** 3), now, 0.3);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** The disk's fine sand: a band of noise (centre, top, level against the vent's hiss). */
const SAND = { hz: 1400, top: 3000, gain: 0.54 } as const;

/**
 * A steam vent's hiss, filtered: gas falling onto a white dwarf (a soft rush whose band wanders),
 * dust in the young Sun's disk (darker, with a smooth wash of fine sand over it that swells and fades:
 * never grains, so nothing crackles like a record), or the Big Rip's tearing (a band that rises and
 * widens with the param, the vent's crackle coming faster).
 */
function hiss(mix: Mix, name: 'infall' | 'dust' | 'tear'): Voice {
  const k = kit(mix, name);
  const c = k.context;
  const top = name === 'dust' ? 2800 : 4500;
  const shelf = c.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 2500;
  shelf.gain.value = -6;
  shelf.connect(filter(c, 'lowpass', top, 0.6)).connect(k.out);
  const layers = ([[1, 0, -0.5], [0.9, 14.2, 0.5]] as const).map(([rate, offset, side]) => {
    const band = filter(c, 'bandpass', 1200, name === 'tear' ? 3 : 0.9);
    const g = gain(c, 1);
    k.recording('steam', rate, offset).connect(band).connect(g).connect(pan(c, side)).connect(shelf);
    return { band, g, place: k.drift(9), swell: k.drift(6) };
  });
  const sand = gain(c, 0);
  if (name === 'dust') k.noise('pink').connect(filter(c, 'bandpass', SAND.hz, 0.7)).connect(filter(c, 'lowpass', SAND.top, 0.6)).connect(sand).connect(pan(c, -0.2)).connect(k.out);
  const sandSwell = k.drift(7);
  const rnd = random(hash(`${name}-crackle`));
  let next = -1;
  let level = 0;
  return {
    set(l, p, now) {
      level = l;
      k.level(l, now);
      for (const layer of layers) {
        const centre = name === 'tear' ? 400 + 2600 * p : name === 'dust' ? 1100 : 600 + 1900 * (0.5 + 0.5 * layer.place(now));
        ease(layer.band.frequency, centre * (1 + 0.25 * layer.place(now)), now, name === 'tear' ? 0.8 : 1.5);
        if (name === 'tear') ease(layer.band.Q, 3 - 2.3 * p, now, 0.8);
        ease(layer.g.gain, db(3 * layer.swell(now)), now);
      }
      if (name === 'dust') ease(sand.gain, SAND.gain * db(4 * sandSwell(now)), now);
      if (name !== 'tear' || level < 0.02) return;
      // The tearing: crackle grains, faster as the band widens.
      if (next < now) next = now;
      while (next < now + 0.2) {
        grain(mix, 'crackle', next, k.out, rnd, 0.35 + 0.7 * rnd());
        next += -Math.log(1 - rnd()) / (0.6 + 4 * p);
      }
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/**
 * One grain of a recording: a slice a few tenths of a second long at a random place, eased in and
 * out, panned at random, its top softened (under 3.5 kHz) so a crackle never turns to static.
 */
function grain(mix: Mix, name: RecordingName, at: number, to: AudioNode, rnd: () => number, loudness: number): void {
  const buffer = mix.recordings.get(name);
  if (!buffer) return;
  const c = mix.context;
  const source = c.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = 0.8 + 0.25 * rnd();
  const length = 0.15 + 0.4 * rnd();
  const env = gain(c, 0);
  const p = pan(c, (rnd() - 0.5) * 1.4);
  source.connect(filter(c, 'lowpass', 3500, 0.6)).connect(env).connect(p).connect(to);
  envelope(env.gain, at, loudness, 0.01, length - 0.06, 0.05);
  source.start(at, rnd() * Math.max(0, buffer.duration - 1));
  source.stop(at + length + 0.05);
  source.onended = () => { p.disconnect(); };
}

/** Rain: the recording near, a second copy further off on the other side, and a wash of drops beyond counting. */
function rain(mix: Mix): Voice {
  const k = kit(mix, 'rain');
  const c = k.context;
  const tone = filter(c, 'lowpass', 8000, 0.5);
  tone.connect(k.out);
  const near = gain(c, 1);
  k.recording('rain', 1, 0).connect(near).connect(tone);
  const far = gain(c, 0.55);
  const second = k.recording('rain', 0.92, 14.3);
  mirror(c, second).connect(filter(c, 'lowpass', 4500, 0.6)).connect(far).connect(tone);
  const washes = [-0.5, 0.5].map((side) => {
    const g = gain(c, 0.3);
    k.noise('pink').connect(filter(c, 'highpass', 300)).connect(filter(c, 'lowpass', 3000)).connect(g).connect(pan(c, side)).connect(tone);
    return { g, swell: k.drift(11) };
  });
  const nearSwell = k.drift(7);
  const farSwell = k.drift(9);
  return {
    set(level, p, now) {
      k.level(level, now);
      ease(tone.frequency, 4500 + 6000 * p, now);
      ease(near.gain, db(2 * nearSwell(now)), now);
      ease(far.gain, 0.55 * db(2.5 * farSwell(now)), now);
      for (const w of washes) ease(w.g.gain, 0.3 * db(2 * w.swell(now)), now);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** The sea: waves on a beach, near, and the same shore further along on the other side; the param brings it near (bright) or far (dark). */
function surf(mix: Mix): Voice {
  const k = kit(mix, 'surf');
  const c = k.context;
  const tone = filter(c, 'lowpass', 6000, 0.5);
  tone.connect(k.out);
  const near = gain(c, 1);
  k.recording('surf', 1, 0).connect(filter(c, 'highpass', 70)).connect(near).connect(tone);
  const far = gain(c, 0.6);
  const second = k.recording('surf', 0.96, 17);
  mirror(c, second).connect(filter(c, 'lowpass', 1500, 0.6)).connect(far).connect(tone);
  const swell = k.drift(19);
  return {
    set(level, p, now) {
      k.level(level, now);
      ease(tone.frequency, 900 + 11000 * p * p, now);
      ease(far.gain, 0.6 * db(2.5 * swell(now)), now);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** Wind: broad noise to each side that gusts (the right a beat behind the left, as a gust crosses), a whistle riding the gusts, buffeting under the strongest. */
function wind(mix: Mix): Voice {
  const k = kit(mix, 'wind');
  const c = k.context;
  const sides = [-0.55, 0.55].map((side, i) => {
    const tone = filter(c, 'lowpass', 1500, 0.6);
    const g = gain(c, 0.3);
    k.noise('pink').connect(filter(c, 'highpass', 80)).connect(tone).connect(g).connect(pan(c, side)).connect(k.out);
    return { tone, g, lag: 0.35 * i };
  });
  const whistleBand = filter(c, 'bandpass', 800, 8);
  const whistle = gain(c, 0);
  k.noise('pink').connect(whistleBand).connect(whistle).connect(pan(c, 0.3)).connect(k.out);
  const buffet = gain(c, 0);
  k.noise('brown').connect(filter(c, 'lowpass', 140, 0.7)).connect(buffet).connect(k.out);
  const gust = k.drift(6);
  const flutter = k.drift(2.2);
  const weather = k.drift(45);
  const wander = k.drift(9);
  const strength = (t: number): number => clamp01(0.5 + 0.6 * gust(t) + 0.2 * flutter(t) + 0.3 * weather(t));
  return {
    set(level, p, now) {
      k.level(level, now);
      for (const s of sides) {
        const g = strength(now - s.lag);
        ease(s.tone.frequency, (450 + 3200 * g) * (0.7 + 0.6 * p), now, 0.4);
        ease(s.g.gain, 0.12 + 0.88 * g ** 1.6, now, 0.4);
      }
      const g = strength(now - 0.15);
      ease(whistleBand.frequency, (550 + 900 * g) * (1 + 0.12 * wander(now)), now, 0.6);
      ease(whistle.gain, 0.5 * g ** 3, now, 0.6);
      ease(buffet.gain, 1.5 * Math.max(0, g - 0.65), now, 0.3);
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** Under the sea: low noise that surges, and gas bubbling up (a hot spring's, slowed so the bubbles are larger), heard through the water; the param is depth. */
function underwater(mix: Mix): Voice {
  const k = kit(mix, 'underwater');
  const c = k.context;
  const bodies = [-0.4, 0.4].map((side) => {
    const tone = filter(c, 'lowpass', 500, 0.6);
    const g = gain(c, 1);
    k.noise('brown').connect(filter(c, 'highpass', 70)).connect(tone).connect(g).connect(pan(c, side)).connect(k.out);
    return { tone, g, surge: k.drift(9) };
  });
  const bubbles = ([[0.66, 0, -0.5], [0.58, 12.9, 0.5]] as const).map(([rate, offset, side]) => {
    const tone = filter(c, 'lowpass', 2200, 0.6);
    const g = gain(c, 0.8);
    k.recording('bubbles', rate, offset).connect(tone).connect(g).connect(pan(c, side)).connect(k.out);
    return { tone, g, swell: k.drift(5) };
  });
  return {
    set(level, depth, now) {
      k.level(level, now);
      for (const b of bodies) {
        ease(b.tone.frequency, 380 + 1600 * (1 - depth), now, 0.8);
        ease(b.g.gain, db(4 * b.surge(now)), now);
      }
      for (const b of bubbles) {
        ease(b.tone.frequency, 1800 + 5000 * (1 - depth), now, 0.8);
        ease(b.g.gain, 0.8 * db(4 * b.swell(now)), now);
      }
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

/** Lava: a lava lake's churning roar slowed a little (two copies apart), a mudpot's plops slowed an octave into thick lava's, the crust crackling, a low weight. */
function lava(mix: Mix): Voice {
  const k = kit(mix, 'lava');
  const c = k.context;
  const roars = ([[0.86, 0, -0.45], [0.78, 8.3, 0.45]] as const).map(([rate, offset, side]) => {
    const g = gain(c, 0.8);
    k.recording('lava', rate, offset).connect(filter(c, 'highpass', 100)).connect(filter(c, 'lowpass', 3200, 0.6)).connect(g).connect(pan(c, side)).connect(k.out);
    return { g, swell: k.drift(8) };
  });
  const plops = gain(c, 1.4);
  k.recording('mud', 0.55, 3).connect(filter(c, 'lowpass', 1800, 0.6)).connect(plops).connect(pan(c, 0.1)).connect(k.out);
  const sub = gain(c, 0.2);
  k.noise('brown').connect(filter(c, 'lowpass', 90, 0.6)).connect(filter(c, 'highpass', 28)).connect(sub).connect(k.out);
  const plopSwell = k.drift(10);
  const subSwell = k.drift(6);
  const rnd = random(hash('lava-crackle'));
  let next = -1;
  return {
    set(level, _p, now) {
      k.level(level, now);
      for (const r of roars) ease(r.g.gain, 0.8 * db(3 * r.swell(now)), now);
      ease(plops.gain, 1.4 * db(3 * plopSwell(now)), now);
      ease(sub.gain, 0.2 * db(4 * subSwell(now)), now);
      if (level < 0.02) return;
      if (next < now) next = now + rnd();
      while (next < now + 0.2) {
        grain(mix, 'crackle', next, k.out, rnd, 0.15 + 0.35 * rnd());
        next += -Math.log(1 - rnd()) / 0.8;
      }
    },
    stop: (now, s) => { k.stop(now, s); },
  };
}

function makeVoice(mix: Mix, name: VoiceName): Voice {
  switch (name) {
    case 'hush':
      return hush(mix);
    case 'rumble':
      return rumble(mix);
    case 'roar':
      return roar(mix);
    case 'convection':
      return convection(mix);
    case 'sun':
      return sun(mix);
    case 'infall':
    case 'dust':
    case 'tear':
      return hiss(mix, name);
    case 'rain':
      return rain(mix);
    case 'surf':
      return surf(mix);
    case 'wind':
      return wind(mix);
    case 'underwater':
      return underwater(mix);
    case 'lava':
      return lava(mix);
  }
}

/**
 * One-shots: a breath of air (a gust passing, never a mouth), an exhale falling away, a low swell
 * felt more than heard, a glint of high air, air rising, rising to the surface, the gathering rumble,
 * a distant thud. Every one eases in, and each runs out to silence before its sounds are let go.
 */
function shot(mix: Mix, name: ShotName, now: number, scale: number): void {
  const c = mix.context;
  const rnd = random(hash(name) + Math.floor(now * 1000));
  const out = gain(c, SHOT_GAIN[name]);
  const send = gain(c, SHOT_SEND[name]);
  out.connect(mix.dry);
  out.connect(send).connect(mix.wet);
  const sources: AudioScheduledSourceNode[] = [];
  const noiseSource = (color: Color): AudioBufferSourceNode => {
    const s = c.createBufferSource();
    s.buffer = noise(mix, color);
    s.loop = true;
    s.playbackRate.value = 0.93 + 0.14 * rnd();
    s.start(now, rnd() * s.buffer.duration);
    sources.push(s);
    return s;
  };
  let end = now;
  if (name === 'breath' || name === 'exhale') {
    // Air: one broad band of noise moving as a gust passes (a breath rises slowly out of silence and
    // falls; an exhale falls away).
    const env = gain(c, 0);
    const band = filter(c, 'bandpass', 600, 0.6);
    const p = pan(c, 0);
    noiseSource('pink').connect(filter(c, 'highpass', 150)).connect(band).connect(env).connect(p).connect(out);
    const [rise, hold, fall] = name === 'breath' ? [3.2, 0.6, 3.6] : [0.9 * scale, 0.3 * scale, 5.3 * scale];
    end = envelope(env.gain, now, 1, rise, hold, fall);
    sweep(band.frequency, now, end - now, name === 'breath' ? [350, 1400, 600] : [1500, 900, 260]);
    sweep(p.pan, now, end - now, name === 'breath' ? [-0.35, 0.35] : [0.2, -0.15]);
  } else if (name === 'swell') {
    // A low swell (a collapse, an impact, a star's death or birth): a deep sub, slowed thunder as its body
    // opening and closing, and a faint breath of air over it for small speakers. Never a bang.
    const env = gain(c, 0);
    env.connect(out);
    const [rise, hold, fall] = [2.2, 1.4, 7];
    end = envelope(env.gain, now, 1, rise, hold, fall);
    noiseSource('brown').connect(filter(c, 'lowpass', 75, 0.7)).connect(gain(c, 0.9)).connect(env);
    const body = filter(c, 'lowpass', 200, 0.7);
    sweep(body.frequency, now, end - now, [200, 900, 400, 250]);
    body.connect(env);
    const thunder = play(mix, 'thunder', 0.5 + 0.1 * rnd(), rnd() * 3, now);
    if (thunder) {
      sources.push(thunder);
      thunder.connect(gain(c, 1.2)).connect(body);
    }
    noiseSource('pink').connect(filter(c, 'bandpass', 260, 0.7)).connect(gain(c, 0.35)).connect(body);
    noiseSource('pink').connect(filter(c, 'bandpass', 1800, 0.8)).connect(gain(c, 0.06)).connect(env);
  } else if (name === 'glint') {
    // A glint of high air as a star ignites: a few short grains of noise, scattered across the field,
    // up where air shimmers (5.5 to 8.5 kHz) rather than where a small speaker turns a burst harsh.
    const source = noiseSource('white');
    const grains = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < grains; i += 1) {
      const at = now + rnd() * 0.8;
      const env = gain(c, 0);
      source.connect(filter(c, 'bandpass', 5500 + 3000 * rnd(), 0.9)).connect(env).connect(pan(c, (rnd() - 0.5) * 1.4)).connect(out);
      end = Math.max(end, envelope(env.gain, at, 0.4 + 0.6 * rnd(), 0.03, 0.01, 0.08 + 0.17 * rnd()));
    }
  } else if (name === 'rise' || name === 'surface') {
    // Air rising: a band sweeping up; rising to the surface, bubbles rising with it, growing smaller and quicker.
    const env = gain(c, 0);
    env.connect(out);
    const band = filter(c, 'bandpass', 300, 0.8);
    noiseSource('pink').connect(band).connect(env);
    end = envelope(env.gain, now, 1, 3.5, 2, 4.5);
    sweep(band.frequency, now, end - now, [300, 1500]);
    if (name === 'surface') {
      const bubbles = play(mix, 'bubbles', 0.55, rnd() * 20, now);
      if (bubbles) {
        sources.push(bubbles);
        sweep(bubbles.playbackRate, now, end - now, [0.55, 0.95]);
        bubbles.connect(filter(c, 'lowpass', 3000, 0.6)).connect(gain(c, 0.6)).connect(env);
      }
    }
  } else if (name === 'gather') {
    // The Big Crunch: the thunder backwards and slowed, a rumble gathering towards the stillness.
    const env = gain(c, 0);
    env.connect(out);
    end = envelope(env.gain, now, 1, 4, 4.5, 2);
    const back = play(mix, 'thunder', 0.6, Math.max(0, (mix.recordings.get('thunder')?.duration ?? 0) - 6.6), now, true);
    if (back) {
      sources.push(back);
      back.connect(filter(c, 'lowpass', 450, 0.7)).connect(env);
    }
    noiseSource('brown').connect(filter(c, 'lowpass', 80, 0.7)).connect(gain(c, 0.5)).connect(env);
  } else {
    // A meteor's distant thud: the bolide's boom, darkened, with a short push of low air a small speaker can play.
    const p = pan(c, (rnd() - 0.5) * 0.8);
    p.connect(out);
    const thud = play(mix, 'bolide', 0.85 + 0.15 * rnd(), 0, now);
    if (thud) {
      sources.push(thud);
      thud.connect(filter(c, 'lowpass', 900, 0.7)).connect(p);
    }
    const env = gain(c, 0);
    noiseSource('pink').connect(filter(c, 'bandpass', 220, 1)).connect(env).connect(p);
    envelope(env.gain, now + 0.25, 0.5, 0.03, 0.05, 1.2);
    end = now + 4;
  }
  for (const s of sources) s.stop(end + 0.05);
  // Let go once it has run out, its send too.
  const release = (): void => {
    out.disconnect();
    send.disconnect();
  };
  const first = sources[0];
  if (first) first.onended = release;
  else release();
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

const smoothstep = (u: number): number => {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
};

/** A curve's value at t: eased (smoothstep) between its points, flat before the first and after the last. */
function valueAt(points: ReadonlyArray<readonly [number, number]>, t: number): number {
  const first = points[0];
  if (!first) return 0;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i];
    const q = points[i - 1];
    if (!p || !q) break;
    if (t <= p[0]) return q[1] + (p[1] - q[1]) * smoothstep(p[0] > q[0] ? (t - q[0]) / (p[0] - q[0]) : 1);
  }
  return points[points.length - 1]?.[1] ?? 0;
}

/**
 * The duck at t (a gain): under a verse, near silence; under a hadith card, a little less. It eases
 * down from just before a card (in dB, so the ear hears an even fade), and back up slowly after it;
 * a card that follows another within a few seconds keeps the dip down between them.
 */
function duckAt(cues: readonly Cue[], t: number): number {
  const cards = cues.filter((c) => c.type === 'verse' || c.type === 'hadith').sort((a, b) => a.t - b.t);
  let depth = 0;
  cards.forEach((card, i) => {
    const next = cards[i + 1];
    let end = card.t + card.duration;
    if (next && next.t - end < DUCK_S.merge) end = Math.max(end, next.t);
    const down = smoothstep((t - (card.t - DUCK_S.lead)) / (DUCK_S.lead + DUCK_S.settle));
    const up = smoothstep((t - (end + DUCK_S.hold)) / DUCK_S.release);
    depth = Math.min(depth, (card.type === 'verse' ? DUCK_DB.verse : DUCK_DB.hadith) * down * (1 - up));
  });
  return db(depth);
}

/** A soft clip above -3 dBFS to a ceiling of -1 dBFS: past the limiter, the last guard against an overshoot. Straight below, so silence stays silence. */
function softClip(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const curve = new Float32Array(n);
  const knee = db(-3);
  const ceiling = db(-1);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

/** Saturation for the harmonics of the deepest sound: odd and even overtones, more the louder it is. */
function warmth(): Float32Array<ArrayBuffer> {
  const n = 2049;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.tanh(1.5 * x);
    curve[i] = y + 0.3 * y * y;
  }
  return curve;
}

interface Master {
  /** Where the voices' dry sound and the reverb's return meet. */
  input: GainNode;
  duck: GainNode;
  tone: BiquadFilterNode;
  level: GainNode;
}

/**
 * The harmonics of the deepest sound: how hard the sound under 110 Hz (taken steeply, so nothing above
 * it passes through the stage unchanged and colours the mix) drives the saturation, the band its
 * overtones are kept in (a steep high-pass at `from`, so they land where a laptop's speakers play
 * rather than just above the fundamentals, and a low-pass at `to`), and how much of them is added.
 */
const WARMTH = { drive: 14, from: 200, to: 700, gain: 0.17 } as const;

/**
 * The master: the duck (a gain, and a low-pass that darkens the sound as it sinks), the app's level,
 * a high-pass under 32 Hz, harmonics of the deepest sound added from 200 to 700 Hz (so a rumble is
 * still felt on a laptop's speakers), a high shelf, a gentle bus compressor, a limiter, and a soft
 * clip at -1 dBFS.
 */
function master(context: BaseAudioContext, destination: AudioNode): Master {
  const input = gain(context, 1);
  const duck = gain(context, 1);
  const tone = filter(context, 'lowpass', 18000, 0.5);
  const level = gain(context, 0);
  const floor = filter(context, 'highpass', 32);
  input.connect(duck).connect(tone).connect(level).connect(floor);
  const sum = gain(context, 1);
  floor.connect(sum);
  const drive = gain(context, WARMTH.drive);
  const shaper = context.createWaveShaper();
  shaper.curve = warmth();
  floor.connect(filter(context, 'lowpass', 110)).connect(filter(context, 'lowpass', 110)).connect(drive).connect(shaper).connect(filter(context, 'highpass', WARMTH.from)).connect(filter(context, 'highpass', WARMTH.from)).connect(filter(context, 'lowpass', WARMTH.to)).connect(gain(context, WARMTH.gain)).connect(sum);
  const shelf = context.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 6500;
  shelf.gain.value = -4;
  const glue = context.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 10;
  glue.ratio.value = 2;
  glue.attack.value = 0.03;
  glue.release.value = 0.4;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  const clip = context.createWaveShaper();
  clip.curve = softClip();
  clip.oversample = '2x';
  sum.connect(shelf).connect(glue).connect(gain(context, db(-MAKEUP_DB.glue))).connect(limiter).connect(gain(context, db(-MAKEUP_DB.limiter))).connect(clip).connect(destination);
  return { input, duck, tone, level };
}

/** Decodes the recordings at their own rate (a decoded buffer plays in any context). */
let decoder: OfflineAudioContext | null = null;

function recordingUrl(name: RecordingName): string {
  return new URL(`assets/sound/${name}.m4a`, document.baseURI).href;
}

/**
 * A recording, fetched and decoded at its own rate; null if it cannot be had: missing, undecodable,
 * let go (`signal`), or stalled, with no byte for STALL_S.
 */
async function fetchRecording(name: RecordingName, context: BaseAudioContext, signal: AbortSignal): Promise<AudioBuffer | null> {
  const stall = new AbortController();
  const abort = (): void => {
    stall.abort();
  };
  signal.addEventListener('abort', abort);
  let timer = 0;
  const wait = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(abort, STALL_S * 1000);
  };
  try {
    wait();
    const response = await fetch(recordingUrl(name), { signal: stall.signal });
    if (!response.ok || !response.body) throw new Error(`${name}: ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      wait();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    try {
      decoder ??= new OfflineAudioContext(1, 1, RECORDING_RATE);
    } catch {
      return await context.decodeAudioData(bytes.buffer);
    }
    return await decoder.decodeAudioData(bytes.buffer);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function recordingsOf(score: Score | undefined): Set<RecordingName> {
  const names = new Set<RecordingName>();
  for (const track of score?.tracks ?? []) for (const name of VOICE_RECORDINGS[track.voice] ?? []) names.add(name);
  for (const s of score?.shots ?? []) for (const name of SHOT_RECORDINGS[s[1]] ?? []) names.add(name);
  return names;
}

/** The chapters in the film's order: the one after a chapter is the one whose recordings are fetched while it plays. */
const ORDER = Object.keys(SCORES) as ChapterId[];

interface Playing {
  chapter: ChapterId;
  content: ChapterContent;
  tracks: Array<{ name: VoiceName; voice: Voice; level: Array<[number, number]>; param: Array<[number, number]> }>;
  shots: Array<[number, ShotName, number]>;
  last: number | null;
  ready: Promise<void>;
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
  /** The recordings in hand now (the chapter playing and the next), for the tests. */
  recordings: string[];
}

export interface FilmScore {
  /**
   * The chapter that plays: its voices begin at once and its recordings are fetched (each joins its
   * layer as it arrives), then the next chapter's. Null for none: the sound fades out, and every
   * recording and noise is let go.
   */
  setChapter(chapter: ChapterId | null, content: ChapterContent | null): void;
  /** Resolves once each of the chapter's recordings has arrived or failed (the voices do not wait for it). */
  ready(): Promise<void>;
  /** The chapter's time; `playing` false (paused, held, seeking) never fires a one-shot. */
  update(t: number, playing: boolean): void;
  /** The film's level as the visitor and the app allow it (sound off, the explorer, loading): 0..1. */
  setLevel(level: number): void;
  state(): FilmScoreState;
  dispose(): void;
}

export function createFilmScore(context: BaseAudioContext, destination: AudioNode): FilmScore {
  const out = master(context, destination);
  const dry = gain(context, 1);
  const wet = gain(context, 1);
  const reverb = context.createConvolver();
  reverb.normalize = false;
  reverb.buffer = impulse(context);
  dry.connect(out.input);
  wet.connect(filter(context, 'highpass', 150)).connect(reverb).connect(gain(context, 0.5)).connect(out.input);
  /** Each recording being fetched or in hand, and which are wanted (the chapter playing and the next). */
  const loads = new Map<RecordingName, { promise: Promise<AudioBuffer | null>; abort: AbortController }>();
  let wanted = new Set<RecordingName>();
  const mix: Mix = {
    context,
    dry,
    wet,
    noise: new Map(),
    recordings: new Map(),
    reversed: new Map(),
    load(name) {
      const known = loads.get(name);
      if (known) return known.promise;
      const abort = new AbortController();
      const promise = fetchRecording(name, context, abort.signal).then((buffer) => {
        if (buffer && wanted.has(name)) {
          mix.recordings.set(name, buffer);
          return buffer;
        }
        // Failed (tried again the next time it is wanted) or no longer wanted.
        if (loads.get(name)?.abort === abort) loads.delete(name);
        return null;
      });
      loads.set(name, { promise, abort });
      return promise;
    },
  };
  /** Keeps only these recordings, letting the rest go (a download under way is stopped). */
  const keep = (names: ReadonlySet<RecordingName>): void => {
    wanted = new Set(names);
    for (const [name, load] of loads) {
      if (names.has(name)) continue;
      load.abort.abort();
      loads.delete(name);
      mix.recordings.delete(name);
      mix.reversed.delete(name);
    }
  };
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

  const apply = (p: Playing, t: number): void => {
    const now = context.currentTime;
    for (const track of p.tracks) {
      const level = valueAt(track.level, t);
      levels.set(track.name, level);
      track.voice.set(level, valueAt(track.param, t), now);
    }
  };

  const setChapter = (chapter: ChapterId | null, content: ChapterContent | null): void => {
    if (playing?.chapter === chapter && playing.content === content) return;
    stopPlaying();
    if (!chapter || !content) {
      // The film's sound has stopped, or the explorer is open: nothing is kept for it.
      keep(new Set());
      mix.noise.clear();
      return;
    }
    const score = SCORES[chapter];
    const events = eventTimes(content);
    const curve = (c: Curve | undefined, fallback: number): Array<[number, number]> =>
      (c ?? [[0, fallback]]).map(([at, v]) => [resolveAt(at, events, content.duration), v] as [number, number]).filter(([t]) => Number.isFinite(t));
    // The recordings kept: this chapter's and the next's; any others are let go.
    const after = ORDER[ORDER.indexOf(chapter) + 1];
    const own = recordingsOf(score);
    const next = recordingsOf(after && SCORES[after]);
    keep(new Set([...own, ...next]));
    const p: Playing = {
      chapter,
      content,
      tracks: score.tracks.map((track) => ({ name: track.voice, voice: makeVoice(mix, track.voice), level: curve(track.level, 0), param: curve(track.param, track.voice === 'roar' ? 1 : 0.5) })),
      shots: (score.shots ?? []).map(([at, name, scale]) => [resolveAt(at, events, content.duration), name, scale ?? 1] as [number, ShotName, number]).filter(([t]) => Number.isFinite(t)),
      last: null,
      ready: Promise.resolve(),
    };
    playing = p;
    apply(p, 0);
    // Once this chapter's recordings are in (or have failed), the next chapter's are fetched while it plays.
    p.ready = Promise.all([...own].map((name) => mix.load(name))).then(() => {
      if (playing === p) for (const name of next) void mix.load(name);
    });
  };

  return {
    setChapter,
    ready() {
      return playing?.ready ?? Promise.resolve();
    },
    update(t, isPlaying) {
      const p = playing;
      if (!p) return;
      const now = context.currentTime;
      apply(p, t);
      const d = duckAt(p.content.cues, t);
      duckNow = d;
      ease(out.duck.gain, d, now, 0.12);
      // The duck darkens the sound as it sinks: open at full, about 350 Hz under a verse.
      const sink = clamp01(Math.log(d) / Math.log(db(DUCK_DB.verse)));
      ease(out.tone.frequency, Math.exp(Math.log(18000) + (Math.log(350) - Math.log(18000)) * sink), now, 0.12);
      // A one-shot plays when the film plays across it, whether or not its recording has come (its made part plays regardless).
      if (isPlaying && p.last !== null && t > p.last && t - p.last < MAX_STEP_S) {
        for (const [at, name, scale] of p.shots) {
          if (p.last < at && at <= t) {
            shot(mix, name, now, scale);
            fired.push(`${p.chapter}:${name}`);
          }
        }
      }
      p.last = t;
    },
    setLevel(level) {
      levelNow = level;
      out.level.gain.setTargetAtTime(level, context.currentTime, TAU.change);
    },
    state() {
      return { chapter: playing?.chapter ?? null, level: levelNow, voices: Object.fromEntries(levels), duck: duckNow, shots: [...fired], recordings: [...mix.recordings.keys()] };
    },
    dispose() {
      setChapter(null, null);
      out.level.disconnect();
    },
  };
}

/**
 * Renders a stretch of a chapter's sound offline, for the tests: per second, the louder channel's RMS
 * and peak. The film is played across it (one-shots fire), with the app's level at 1, once the
 * chapter's recordings are in or have failed.
 */
export async function renderFilmSound(chapter: ChapterId, content: ChapterContent, from: number, to: number, sampleRate = 22050): Promise<{ rms: number[]; peak: number[] }> {
  const seconds = Math.max(1, Math.ceil(to - from));
  const context = new OfflineAudioContext(2, seconds * sampleRate, sampleRate);
  const score = createFilmScore(context, context.destination);
  score.setChapter(chapter, content);
  await score.ready();
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
  score.dispose();
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

/** A recording as the tests see it: its file, whether it decoded, its length against the one its loop needs, its channels and level. */
export interface FilmRecordingCheck {
  name: string;
  url: string;
  ok: boolean;
  seconds: number;
  /** A loop's length with its quarter second either side; null for a one-shot. */
  expected: number | null;
  channels: number;
  rms: number;
}

/** Every recording any chapter plays, fetched and decoded as the film does, for the tests. */
export async function checkFilmRecordings(): Promise<FilmRecordingCheck[]> {
  const names = new Set<RecordingName>();
  for (const score of Object.values(SCORES)) for (const name of recordingsOf(score)) names.add(name);
  const context = new OfflineAudioContext(1, 1, RECORDING_RATE);
  return Promise.all(
    [...names].map(async (name) => {
      const url = recordingUrl(name);
      const buffer = await fetchRecording(name, context, new AbortController().signal);
      const loop = RECORDINGS[name];
      let sum = 0;
      const data = buffer?.getChannelData(0) ?? new Float32Array(0);
      for (const x of data) sum += x * x;
      return {
        name,
        url,
        ok: buffer !== null,
        seconds: buffer?.duration ?? 0,
        expected: loop === null ? null : loop + 2 * PAD_S,
        channels: buffer?.numberOfChannels ?? 0,
        rms: data.length > 0 ? Math.sqrt(sum / data.length) : 0,
      };
    }),
  );
}
