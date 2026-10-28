/**
 * Chapter 3's numbers that its scene and the tests share (tests/unit/reionisation.spec.ts works the
 * gas out as the chapter does, without the scene's JSON imports).
 */

/** Periodic box of the web, world units (the camera starts inside it). */
export const BOX = 48;
export const FIELD = { size: 64, box: BOX, index: -1.8, smoothCells: 1.6, rmsDisplacement: 2.0, peakSigma: 2.4, maxPeaks: 380, seed: 20_260_301 } as const;
/** Growth factor: nearly uniform in the dark ages, the web by about 24 s after `web`, then slowly onward. */
export const GROWTH = { dark: 0.04, formed: 1.25, final: 1.45, formSeconds: 24 } as const;
/** First stars ignite over this many seconds after `stars` (highest peaks first, a little scatter from this seed). */
export const STAR_SPREAD = 18;
export const IGNITION_SEED = 20_260_302;
/**
 * Reionisation stops partway: this share of the visible gas is ionised by the chapter's end, with
 * neutral islands left (it was about half done near redshift 7.8 and finished by about 5.3, around
 * a billion years after the beginning, well after this chapter's era).
 */
export const IONISED_AT_END = 0.4;
/**
 * The gas's tag comes in this many seconds after `stars` (at the film's pace), once the first bubbles
 * in view have grown, on one whose star has lit by then.
 */
export const TAG_FROM = 15;
