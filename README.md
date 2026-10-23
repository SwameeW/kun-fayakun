# Kun Fayakun

An immersive, browser-based 3D experience about creation, from before time to the
formation of Earth and life and on to the end of the universe. It places verses of the
Quran and authentic hadith beside real cosmological data (including the Planck map of the
cosmic microwave background) for reflection. It plays like a planetarium show, and you can
also pause it and explore freely.

> An educational reflection, not tafsir or scientific proof. Interpretations are summarised from cited scholars; for religious guidance, consult a qualified scholar. Science reflects current models and may change.

The full brief is in [docs/SPEC.md](docs/SPEC.md). The interfaces shared between modules
are in [docs/CONTRACTS.md](docs/CONTRACTS.md) and [src/core/types.ts](src/core/types.ts).

## Status

| Milestone | Scope | Status |
|---|---|---|
| M1, vertical slice | Core engine, timeline, panel, data pipeline and validation, Chapters 0 to 2 including the real Planck CMB | Done, pending review |
| M2 | Chapters 3 to 6, SDSS galaxy data, GPU particle systems, HUD tags and scale bar | Done, pending review |
| M3 | Chapters 7 to 10, JPL ephemerides | Not started |
| M4 | Recitation proxy, Arabic UI, accessibility audit, scholarly and scientific review recorded | Not started |

Not for public release until the reviews in [Review process](#review-process) are recorded.

## Run it

You need Node 22.12 or newer (CI uses Node 24). This checkout also carries a
project-local toolchain: `source .tools/env.sh` puts it on your `PATH` and points the npm
and Playwright caches into `.cache/`.

```sh
source .tools/env.sh     # or use a system Node >= 22.12
npm ci
npm run dev              # http://localhost:5173
```

Production build and preview:

```sh
npm run build            # validate + typecheck + vite build
npm run preview          # http://localhost:4173
```

### Routes and URL options

| URL | Effect |
|---|---|
| `#/` | Home: intro and disclaimer |
| `#/ch/<n>?t=<seconds>` | Deep link into chapter `n` at time `t` |
| `#/sources` | Sources and licences page |
| `?forceWebGL=1` | Use the WebGL2 backend even where WebGPU is available |
| `?tier=high\|mid\|low` | Override the quality tier |
| `?reducedMotion=1\|0` | Override `prefers-reduced-motion` |
| `?autoplay=1` | Skip the intro overlay and start playing |
| `?fps=1` | Show a small frame-rate readout |
| `?profile=1` | Measure GPU time per frame with timestamp queries where the browser supports them; `window.__kf.frameStats()` then reports `gpuMedianMs` and `gpuP95Ms` (holds the render scale at 1) |

Query options go before the hash, e.g. `/?forceWebGL=1&autoplay=1#/ch/2?t=30`.

Without `?tier` or `?profile`, the engine adapts in two stages to keep frames smooth:
dynamic resolution first (the render scale steps down to 0.6× in small steps when frames run
slow, and probes back up after long comfortable stretches), then the quality governor drops
one tier if frames stay above 20 ms for 2 s.

Keyboard: `Space` pauses and resumes, `Right` / `Left` go to the next / previous chapter
(with `Shift` they seek), `P` shows or hides the panel, `E` enters free explore (orbit,
`WASD`), `Esc` returns to the timeline, `?` lists the shortcuts.

## Checks

These are the same steps CI runs ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

```sh
npm run validate                    # scripture and data validation
npm run typecheck                   # strict TypeScript, app and scripts
npm run lint                        # ESLint (typescript-eslint strictTypeChecked)
npx vite build
npx tsx scripts/check-bundle.ts     # shell + Chapter 0 must stay under 1.5 MB gzipped
npx playwright test                 # end-to-end tests, see below
```

### End-to-end tests

Playwright builds the app (`vite build`) and serves it with `vite preview` on port 4173.
Install the browser once with `npx playwright install chromium`. Every test runs in two
projects:

- `webgpu`: Chromium with WebGPU enabled. The backend that actually came up is recorded
  as a test annotation (headless Linux usually has only a software adapter). Set
  `EXPECT_WEBGPU=1` to fail when the app falls back to WebGL2.
- `webgl2`: every navigation adds `?forceWebGL=1`, and the backend must be WebGL2.

| Spec | Checks |
|---|---|
| `tests/smoke.spec.ts` | Per playable chapter: renders without console errors, canvas not blank, panel layers in order, every Arabic verse (in the panel and, at each verse cue, on the cinematic overlay) marked `lang="ar" dir="rtl" translate="no"` and identical to `data/quran.json`, and the CMB colour scale with the Planck credit whenever the map is up. Also the intro disclaimer and the Sources page. |
| `tests/a11y.spec.ts` | axe-core on home, each chapter with the panel open, and Sources: no violations of any impact. |
| `tests/keyboard.spec.ts` | Keyboard-only run-through with visible focus. |
| `tests/reduced-motion.spec.ts` | `prefers-reduced-motion` is detected and verses only cross-fade. |
| `tests/perf/*.spec.ts` (`@perf`) | 60 s auto-play frame stats and first contentful paint on slow 4G. |

Useful variables: `KF_SKIP_BUILD=1` serves the existing `dist/` without rebuilding.
`PERF=1 npx playwright test --workers=1` runs only the `@perf` specs, which are left out
of the default run. `PERF_ASSERT=1` also enforces the frame-rate thresholds, which only
mean something on the reference hardware in SPEC section 8.

## Data pipeline

Scripture reaches the screen only from frozen files in `data/`, generated from pinned
sources. Nothing is typed from memory or generated.

| Step | Command | Output |
|---|---|---|
| Cited references | edit `data/citations.json` | Verse keys and hadith references per chapter (references only, no text) |
| Quran text | `npm run fetch:quran` | `data/quran.json`: the cited ayat from the pinned Tanzil Uthmani file with its copyright block, transliteration, translation, licence and sha256 |
| Hadith | entered by a person from sunnah.com | `data/hadith.json`: collection, number, sunnah.com key, grading, grader, dispute note, reviewer |
| Science constants | edited by hand with citations | `data/constants.json`: value, uncertainty, unit, citation |
| Validation | `npm run validate` | Fails on any verse that does not match Tanzil byte for byte after NFC, any hadith without collection, number and grading, any verse key missing from `data/sources.json`, and any Arabic text in `src/` |
| Planck CMB | `npm run preprocess:cmb` | `public/assets/cmb/`: PR3 SMICA HEALPix map to equirectangular KTX2 textures plus `cmb.json` |
| Calligraphy | `npm run preprocess:calligraphy` | `public/assets/calligraphy/`: MSDF atlas of the word kun, set in Amiri Quran from the text in `data/quran.json` |
| SDSS galaxies | `npm run preprocess:sdss` | `public/assets/sdss/`: 420,000 DR20 galaxies (every one below z = 0.1, a one-in-nine sample beyond) at their comoving positions, `galaxies.bin` plus `galaxies.json`, and the SDSS acknowledgements in `data/sources.json` |

## Adding a chapter

1. **Registry.** In `src/chapters/index.ts`, give the chapter's entry a loader:
   `meta('ch03', 1.5e8 * YEAR, 'M2', () => import('./ch03/scene'))`. Chapters without a
   loader show as upcoming stops on the timeline.
2. **Content.** Write `src/chapters/chNN/content.json` (type `ChapterContent` in
   `src/core/types.ts`): duration, intro card, the three-layer panel, cues, camera
   keyframes and explore limits. Scene cues must not fall inside a verse cue's window or
   the 2 s before it.
3. **Scene.** Write `src/chapters/chNN/scene.ts` with
   `export default function create(): ChapterModule`, importing `./content.json`. Shaders
   in TSL only, brightness changes through `ctx.exposure`, and it must run with
   `?forceWebGL=1`.
4. **Strings.** Add the chapter's ICU messages (`chNN.*`) to `src/i18n/en.chapters.json`.
   Timeline labels (`timeline.chNN.*`) already exist in `src/i18n/en.json`.
5. **Citations and data.** Add the chapter's verse keys and hadith references to
   `data/citations.json`, run `npm run fetch:quran`, have a person enter any hadith in
   `data/hadith.json`, add constants to `data/constants.json` and sources to
   `data/sources.json`.
6. **Validate and test.** Run `npm run validate`, then the checks above. The smoke and
   accessibility tests pick the chapter up automatically once it has a loader. If the
   scene is not lit halfway through, add its "visible" scene event to `VISIBLE_AFTER` in
   `tests/support/data.ts`.

## Principles

The Core Principles in [docs/SPEC.md](docs/SPEC.md) are non-negotiable. In short:

- **Reflection, not proof.** Verses sit beside science for reflection, never as
  predictions or "scientific miracles". No reveal is timed to a verse's key word.
- **Verified text only.** Arabic, translation and hadith wording come only from frozen,
  verified data files. Anything that cannot be verified is left out.
- **Three layers, in order.** What the text says; how scholars have understood it
  (classical first, then "Some modern writers read this as..."); what science measures
  today, with uncertainties and open questions.
- **No depictions** of Allah, angels, prophets, the Throne, the water beneath the Throne,
  the Pen, the Preserved Tablet or the Kaaba. Light, silence, calligraphy and the cosmos
  only.
- **Respect for the text.** Verses fade in and out whole; never on loading or error
  screens; never on surfaces that are flown through, exploded or turned into particles.
  Honorifics as the spec sets out.
- **Tone.** Reverent and educational. No preaching, mockery or sectarian positions.
- **Accessible.** Real DOM text, full keyboard control, visible focus, reduced motion,
  contrast of at least 4.5:1, pause always available, no more than 3 flashes per second.

## Sources and licences

- The in-app Sources page (`#/sources`) is generated from `data/sources.json`, including
  reviewer names and dates.
- `LICENSES` covers fonts, texts and data.
- Quran text: Tanzil Uthmani, CC BY 3.0, used verbatim with its copyright block kept and
  a link to [tanzil.net](https://tanzil.net).
- Translation and transliteration: the licence of each is recorded in `data/sources.json`.
- Arabic font: Amiri Quran, SIL Open Font License, self-hosted.
- CMB map: Planck PR3 SMICA (Planck Legacy Archive). Credit: ESA and the Planck
  Collaboration.
- Galaxy positions: Sloan Digital Sky Survey DR20, with the SDSS-I/II, III, IV and V
  acknowledgements on the Sources page (per SDSS policy).
- Later milestones: NASA JPL Horizons and DE440/441, and live
  recitation from the Quran Foundation API (credited, never cached beyond its terms).

## Review process

Code changes go through CI: validation, strict typecheck, lint, build, loading budget,
and the Playwright suite on both backends. Changes to `data/` follow the pipeline above;
never hand-edit `data/quran.json`.

Before public release (SPEC section 9):

1. Automated: all Arabic checked against Tanzil (`npm run validate`).
2. A qualified Islamic scholar signs off on translations, tafsir summaries, honorifics,
   hadith gradings and the range-of-views statements (seven heavens, six days, evolution).
3. An astrophysicist reviews the science layer.
4. Names and dates are recorded in `REVIEW.md` and on the Sources page.
