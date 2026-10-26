# Refinement and educational overhaul: report (2026-10-26)

The owner's brief "Complete Experience Refinement & Educational Overhaul", with the film's sound
added mid-way ("add some high quality sounds to the cinematic parts"). Guiding principle (SPEC
section 0): *The real universe is the reference. The sandbox is the thought experiment. Reflection is
the purpose.* Commits `29e106f` to the end of this pass; each says what changed and why.

## 1. Chapters changed, and the pacing

Measured first: every chapter's on-screen change scanned second by second, with what was on screen
to read, then the long stretches looked at. Nothing was cut that carried a verse, a hadith, a
caption or a visible development; no verse was shortened, split or altered.

| Chapter | Before | After | What changed |
|---|---|---|---|
| 0 | 96 s | 97 s | Cold open is the screenplay's four seconds of black (was 5.5). The word *kun* now stays alight, breathing, through the hadith instead of fading at 56.5 s: the screen had been black for about forty seconds under four reference cards. Two hadith cards replace the four (see 5); the light fades for the closing caption. |
| 2 | 90 s | 86 s | The hold after the last caption, over the CMB globe, trimmed from 9 s to 5 s. |
| 4 | 92 s | 87 s | The hold after the last caption trimmed from 10 s to 5 s; the Hubble-tension figure leaves 3 s before the end. |
| 6 | 128 s | 125 s | The hold after "us" trimmed from 8 s to 5 s. |
| 7 | 172 s | 166 s | The hold over the Sun's course trimmed from 11 s to 5 s; the Sun-path label now ends with the chapter rather than at a fixed time. |
| 8 | 170 s | 167 s | The 12 s wait before 79:30 shortened to 9 s (the verses keep their 9 s each, after the land has risen). |
| 9 | 150 s | 144 s | The 14 s wait before the land turns green shortened to 8 s. |
| 1, 3, 5, 10 | unchanged | | Their quiet stretches carry visible development or, in Chapter 10, the finale's chosen silence. |

The chapters together: 22 min 44 s before, 22 min 18 s now. Every timing change is in the chapter's
`content.json` (cues and camera keyframes), `film/shotlist.json` and `film/screenplay.md`. A new
validator rule (k) checks that the three agree: shots tile each chapter exactly, every verse, hadith,
caption, panel and figure cue is listed in the shot it starts in, and the screenplay's tables,
headings and runtime match. It found and fixed older drift (Chapter 3's captions a shot late,
Chapter 8's notes cue, two figure overlays). Seeking, pausing and reduced motion are unchanged; the
pacing tests and the rest of the suite pass (section 9).

## 2. Explore Mode: what each chapter now offers

Free explore opens a **Discover** dock beside the scene (its own chunk). A *moment* shows the scene
as it was then (the scene's model time; the film's clock never moves), eases the camera to the film's
own view of it (placed at once with reduced motion) and opens a card labelled **Measured**, **A
scientific model** or **An illustration**, its numbers from `data/constants.json` and its sources
cited. A slider runs the chapter's own process. "Back to the film's moment", or leaving explore,
restores scene and camera. No scores, achievements or collectibles. Mouse, keyboard and touch;
axe-checked; on a phone it is a sheet above the timeline.

| Chapter | Moments | Process | Closer look |
|---|---|---|---|
| 0 | none (nothing of the unseen is pictured) | none | Words to know: kun fayakun, Badi', al-'Arsh, al-Qalam, al-Ghayb, with their references |
| 1 | A point of light (illustration), Space stretching, Hot to cool (models) | Stretch space | **A model of expanding space**: dots for galaxies; stretch it and watch the distances from any dot; every distance scales alike, the farther faster, no centre |
| 2 | Inside the plasma, The fog clears (models), The real sky of first light, The whole sky at once (measured, Planck) | Let the first light go | How the Planck map was measured (mission, method, resolution, the average temperature, the reconstructed galactic band, our motion removed), with the fog and the clear sky to compare |
| 3 | The dark ages, Gravity builds a web (models), The first stars, The first galaxies (illustrations, with JWST's measured ages) | Let gravity work | |
| 4 | Among the galaxies, Space stretching, Light reddens, Two measurements disagree (the Hubble tension, measured) | Stretch space | The notes' stretch control, here where its effect is seen (reused, not duplicated) |
| 5 | Our galaxy (artist's model), Drawing back, Real galaxies (SDSS, measured), The Sloan Great Wall (measured), As far as we can see | Draw back | |
| 6 | Burning in layers (illustration, not to scale), The core collapses, Elements set free, A white dwarf and its companion, A Type Ia supernova | A massive star's end | **Two kinds of supernova** side by side (what explodes, why, what remains, its light, why it matters), with buttons to each |
| 7 | A disk of dust, The living Sun, Real orbits today (JPL, measured), The Moon's phases, The Sun's course | Let the planets move | **Kepler's law from the real orbits**: each planet's year from JPL's mean motion against its distance cubed; and the solar system explorer. The letter analysis stays in the notes, the verse untouched |
| 8 | A molten world, A giant impact, The Moon gathers, Rain and the first seas, Land rises (models) | Shape the young Earth | **The Earth today**: opens the real Earth in the solar system explorer (reused) |
| 9 | The early ocean (illustration; not a reconstruction of life's origin), Up through the surface, Oxygen in the air, The land turns green | Let the Earth change | **Why water matters** and the habitable zone (a condition, not a sign of life); the Earth today |
| 10 | The cosmos today (measured), Heat death, Big Rip, Big Crunch (each labelled a model) | none | **Models, not the unseen**: the futures as hypotheses, apart from the Quran's descriptions of the Last Day |

While another moment is shown, the film's captions and verse cards step aside (they belong to the
film's moment). Different from the laboratory, which stays the place for hypothetical experiments; the
laboratory now says what it is for and compares an edited world with the real one.

## 3. Question-mark help in the navigator

A "?" beside the solar-system explorer's controls and sections (45 fixed places, plus every body's facts) opens a plain-words explanation
(113 topics, `src/i18n/en.help.json`, its own chunk): the navigator and its lists, time and the
Hijri date, the orrery, distance and light-time, every body, the About facts, walking and descents,
Living Earth and *Field notes, by Samee*, the Islamic panel (qibla, crescent, prayer conventions, Asr,
the astrolabe), the stars and galaxies, the laboratory and its lessons, the camera and photo mode,
sound. Keyboard (Enter, Esc), screen readers (a labelled dialog, focus returned), touch (44 px
targets); it stays inside the screen, never triggers the control beside it, and stays open while the
laboratory rewrites its figures. Every explanation is at most three sentences. Budgets kept.

## 4. The Quran translation: what was chosen, and what blocks a replacement

**Nothing has replaced Pickthall yet, by the brief's rule:** no modern translation is confirmed as
usable without the copyright holder's permission, and none was copied, generated or rewritten. The
Arabic is untouched.

The options, for the owner's decision:

| Translation | Readability | Licence as published | What it would take |
|---|---|---|---|
| Saheeh International (Abul-Qasim Publishing House, Jeddah) | Clear, literal modern English | Copyright, no public licence; Tanzil offers it for non-commercial use only | Written permission from the publisher (the SPEC already anticipated this) |
| The Clear Quran (Dr Mustafa Khattab) | Very readable, suits young readers | All rights reserved; an excerpt licence (up to 10%) for registered nonprofits; withdrawn from the Quran Foundation API at the holder's request | Written consent from the author or publisher |
| M. A. S. Abdel Haleem (Oxford University Press) | Fluent, scholarly | Rights reserved by OUP | Permission from OUP |
| Talal Itani, ClearQuran | Plain modern English | All rights reserved (PDF); Tanzil lists it non-commercial | Permission from the translator |
| Quran Foundation API v4 | Several translations, live | Display only, no caching beyond a week or bundling; OAuth client credentials kept secret | A small server proxy; not a static-site change |

Recommended: ask Abul-Qasim for written permission for Saheeh International (the closest fit with the
pinned, verified pipeline), or Dr Khattab for The Clear Quran (the most readable). On approval and
permission it comes in through the existing pipeline: pinned file, sha256, `sources.json`,
attribution, validator.

**Meanwhile** every cited verse has a **plain-words explanation** (36, `src/i18n/en.plain.json`),
written from the classical commentaries for this project and labelled everywhere as an explanation,
not a translation, awaiting a scholar's review. In the notes it sits under the translation and its
attribution in its own block; a switch lets a visitor show it on the film's verse cards in the
translation's place, labelled there too (the translation stays the default). The validator requires
one for every verse and keeps each verse card long enough for either English.

## 5. Hadith, simplified

In the film, Chapter 0's four reference cards (30 s of collection names and numbers) became two short
cards: Imran ibn Husain's hadith with Abdullah ibn Amr's, then the hadith of the Pen. Each shows a
sourced summary labelled "Summary, not a quotation", discreet references, and for the Pen both
narrations with their gradings side by side (sahih per al-Albani; gharib by this chain per
at-Tirmidhi). In the notes every narration keeps its own entry: summary, grading and the note on the
grading in view; narrator, parallels, why the wording is not shown and the sunnah.com link under
"Source details". No wording was invented or modernised, nothing is attributed to the Prophet ﷺ as
his words, and no grading was dropped. The verified-wording fields stay pending a person's entry. The
validator requires a summary on any hadith card without verified wording, and enough time to read it.

## 6. Creator credits removed

Removed: the "made by" credits in the closing card (`ui.credits.app` now "Kun Fayakun"), the photo
credit line, the screenplay's end-credits line, the shot list's `createdBy`, and the README's creator
line. Kept: legal notices, dataset and software acknowledgements, translation attributions, the review
record, and git history.

## 7. *Field notes, by Samee*, preserved

Its title, its introduction ("I'm Samee"), the prophets' lands, the places and every feature are
unchanged, and its heading has a "?" (`help.fieldNotes`, in the owner's words). The readability pass
split two of its sentences (Adam's and Ibrahim's notes) without changing their wording or facts.

## 8. Files changed

About a hundred files across the pass (`git diff --stat 29e106f^..HEAD`). The main ones:

- Film: `src/chapters/ch00,02,04,06,07,08,09/content.json`, `src/chapters/ch07/scene.ts`,
  `film/shotlist.json`, `film/screenplay.md`.
- Sound: `src/core/film-score.ts` (new), `src/ui/film-sound.ts` (new), `src/ui/sound-preference.ts`
  (new), `src/core/audio.ts`, `src/ui/index.ts`, `src/ui/icons.ts`, `src/ui/explore/navigator.ts`.
- Explore Mode: `src/ui/discover-dock.ts` (new), `src/ui/styles/discover.css` (new),
  `src/i18n/en.discover.json` (new), `src/core/types.ts`, `timeline.ts`, `camera.ts`, `explore.ts`,
  `app.ts`, `hooks.ts`.
- Scripture: `src/ui/scripture.ts`, `cue-text.ts`, `panel.ts`, `verse-english.ts` (new),
  `plain-words.ts` (new), `src/i18n/en.plain.json` (new), `styles/panel.css`, `styles/cue-text.css`.
- Help: `src/ui/explore/help.ts`, `help-popover.ts` (new), `src/i18n/en.help.json` (new), and the
  explorer's panels that carry a "?".
- Laboratory: `src/explore/lab.ts`, `src/ui/explore/lab-panel.ts`, `src/i18n/en.lab.json`.
- Load: `src/ui/sources-page.ts`, `sources-content.ts` (new), `scripts/check-bundle.ts`.
- Strings: every `src/i18n/en.*.json` (readability).
- Validator: `scripts/validate.ts`, `scripts/lib/rules/film.ts` (new), `cues.ts`, `scripture.ts`,
  `i18n.ts`, `scripts/lib/content.ts`, `context.ts`.
- Tests: `tests/plain-words.spec.ts`, `hadith.spec.ts`, `film-sound.spec.ts`, `discover.spec.ts`,
  `explore/help.spec.ts`, `unit/help.spec.ts` (new), `discovery.spec.ts`, `explore/lab.spec.ts`,
  `support/fixtures.ts`.
- Docs: `docs/SPEC.md` (purpose; translation and hadith; audio; explore), `docs/LAB.md`,
  `docs/CONTRACTS.md`, `docs/FEATURE-LEDGER.md`, `REVIEW.md`, `README.md`, this report.

## 9. Tests

On the final build of this pass, locally:

- **The full Playwright suite: 664 of 664 passed** (8.6 minutes; none flaky), in every project:
  unit (Node), WebGPU, WebGL2 (forced), a phone (Pixel 7 emulation) and Brave.
- **New in this pass:** `tests/plain-words.spec.ts` (the translation verbatim and attributed, the
  explanation apart and labelled, the cards' switch remembered), `tests/hadith.spec.ts` (the two
  film cards, the Pen's gradings, every narration's entry and source details),
  `tests/film-sound.spec.ts` (all eleven chapters rendered offline: peaks under 0.5, at least 15 dB
  quieter or under -60 dB beneath every verse, the screenplay's silences; live: the speaker, the
  duck, no one-shot on a seek, pause, the shared choice), `tests/discover.spec.ts` (16: every
  chapter's dock and moments, the process, reset, the expansion model's arithmetic, Kepler's law
  from JPL's orbits, the Earth in the explorer, keyboard, axe, a phone), the help popovers
  (`tests/explore/help.spec.ts`, `tests/unit/help.spec.ts`), and the laboratory's comparison with
  reality (`tests/explore/lab.spec.ts`).
- **Validator:** every rule passes, including the new rule k (shot list and screenplay agree with
  the chapters), the plain-words coverage, the hadith cards' summaries and reading time, and the
  Explore Mode cards' values and sources. (Rule a's long-standing note about NFC normalisation is a
  warning, not a failure; rule b runs online only.)
- **Budgets:** all pass. First load 337,119 B gzipped (+9,490 of its +10,000 allowance); Explore
  Mode's dock 10,919 of 20,000; the film's sound 5,598 of 12,000; the explorer 147,446 of 150,000.
- **Lint and types:** clean (`npx eslint .`, `tsc` for the app and the scripts).
- Where a test failed on the way it was the code or the test's own mistake, fixed at its cause; no
  assertion was loosened to pass and no timeout lengthened. One check was reformulated on evidence:
  near silence under a verse means 15 dB under the chapter's sound or below -60 dB, because Chapter
  0's sound around its verses is itself only a breath (-50 dB).

## 10. Still open

- **Translation licensing (owner):** choose an option in section 4 and obtain written permission;
  nothing restricted is used until then.
- **Scholar's review (REVIEW.md):** the 36 plain-words explanations; Chapter 0's two hadith summaries
  (and joining two narrations on one card); the scholarly summaries re-split for readability; the
  words-to-know entries in Chapter 0's Explore Mode; and everything already listed there.
- **Hadith wording:** still pending entry by a person from sunnah.com, with a reviewer.
- **Astrophysicist's review:** the Explore Mode cards' science (each cites its constants and sources).
- **Not done, deliberately:** flying to marked places on the Planck sky (the CMB's measurement notes
  are there instead; its orientation conventions would need their own test first).
- **Budget margin:** the first load sits at +9,490 bytes of its +10,000 allowance; the letter
  analysis (`src/ui/discovery.ts`, Chapter 7 only) is the next candidate to load lazily.
