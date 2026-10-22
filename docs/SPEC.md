# Kun Fayakun: Build Spec v2 (verified)

Build an immersive, browser-based 3D experience called “Kun Fayakun” that tells the story of creation, from before time to the formation of Earth and life and on to the end of the universe. It places verses of the Quran and authentic hadith beside real cosmological data, for reflection. It should feel like a reverent, cinematic planetarium show that the viewer can also explore freely.

Build it in milestones (see DELIVERABLE). Ship a working vertical slice (Chapters 0 to 2) before anything else.

—

## 1. CORE PRINCIPLES (non-negotiable)

1. Reflection, not proof. Verses are shown beside science for reflection, never as predictions, proofs, or “scientific miracles”. Never write “the Quran predicted X”. Never time an explosion, burst, or reveal to land on the key word of a verse.
2. Scripture comes only from frozen, verified data files. No Arabic, translation, or hadith text may be typed from model memory or generated. If a text cannot be verified against its source, leave it out.
3. Three layers on every panel, always in this order:
   1. What the text says (Arabic, transliteration, translation, reference).
   2. How scholars have understood it: the classical reading first (Ibn Kathir, al-Tabari, al-Qurtubi), then “Some modern writers read this as...”.
   3. What science measures today, with uncertainties and open questions.
4. No depictions. Never depict Allah, angels, prophets, the Throne, the water beneath the Throne, the Pen, the Preserved Tablet, or the Kaaba, as figures, objects, or symbols. Represent divine acts only through light, silence, Arabic calligraphy, and the cosmos itself. No hands for 39:67.
5. Respect for the text.
   - Never put verses on surfaces that are flown through, exploded, turned into particles, or shown on error or loading screens.
   - Verses fade in and out whole. Never cut one off mid-ayah.
   - Use ﷺ after the Prophet’s name, “peace be upon him” for other prophets, “may Allah be pleased with him” for Companions, and “glorified and exalted is He” after Allah at least on first mention in each chapter.
6. Tone: reverent, awe-inspiring, educational. No preaching, no mockery, no sectarian positions.
7. On-screen disclaimer (intro and Sources page): “An educational reflection, not tafsir or scientific proof. Interpretations are summarised from cited scholars; for religious guidance, consult a qualified scholar. Science reflects current models and may change.”

—

## 2. SOURCES AND LICENSING (verified Oct 2026)

- Quranic Arabic: Tanzil Uthmani text, verbatim, full tashkeel. CC BY 3.0. Must not be modified. Keep its copyright block and link to tanzil.net.
- English translation: a translation whose license permits redistribution, OR Sahih International with written permission (it is copyrighted). Record the license in sources.json.
- Arabic font: Amiri Quran (SIL OFL), self-hosted WOFF2. Do NOT use KFGQPC Uthmanic Hafs (restrictive license, built for a different text encoding).
- Recitation audio: Quran Foundation API v4, live and optional. Needs OAuth2 client credentials via a small serverless proxy (secret never in the browser). Terms forbid caching beyond 1 week or bundling, so do not freeze its text. Use it for recitation and for validating the Tanzil text. Credit Quran Foundation.
- Hadith: entered by a person from the sunnah.com references below. Record collection, number, sunnah.com key, grading, grader, any dispute note, and reviewer.
- CMB map: Planck PR3 SMICA HEALPix FITS (Planck Legacy Archive). Convert offline to a 4096x2048 equirectangular texture. Credit “ESA and the Planck Collaboration”.
- Galaxy positions: latest public SDSS release (DR20, Sept 2026) via SkyServer/CasJobs. Credit per SDSS policy.
- Solar system: NASA JPL Horizons and DE440/441 ephemerides. Free with credit.

—

## 3. CHAPTERS

A log-scale timeline from “Before time” to “The end”, with labelled stops. Viewers can play in order or jump.

### Chapter 0: Before creation
Text:
- Quran 2:117 and 36:82 (“Be,” and it is: kun fa-yakun).
- Sahih al-Bukhari 3191 (parallel 7418), narrated by Imran ibn Husain, may Allah be pleased with him: Allah existed and nothing else; His Throne was over the water; He wrote all things in the Dhikr; He created the heavens and earth. Quote the wording of the number cited.
- Sahih Muslim 2653 (sunnah.com: muslim:2653b), narrated by Abdullah ibn Amr: the measures of creation were written 50,000 years before the heavens and earth, while His Throne was over the water.
- Hadith of the Pen: Sunan Abi Dawud 4700 (sahih per al-Albani) and Jami at-Tirmidhi 2155 (Tirmidhi notes it is gharib by this chain). Show both gradings.

Scholarly layer: Do NOT say “the Pen was created first” as a flat fact. Say: “A hadith states the first thing Allah created was the Pen, commanded to write. Many scholars, including Ibn Hajar, understood this to mean first after the Throne and the water, or first in the command to write, since other authentic hadith mention the Throne already over the water.”

Visual: total darkness and silence, then the word كُن in light calligraphy (MSDF from the Amiri Quran font, never hand-drawn glyphs).

Do not use: Sahih Muslim 2789 (the “soil on Saturday” hadith). Al-Bukhari, Ali ibn al-Madini, al-Bayhaqi and others judged it defective.

### Chapter 1: The beginning
Text: Quran 21:30 (the heavens and earth were joined, ratqan, then We parted them, fa-fataqnahuma).

Scholarly layer: Ibn Kathir, citing Ibn Abbas, Sa’id ibn Jubayr and Qatadah: they were joined, then separated by raising the sky. Another early report: the sky gave no rain and the earth no plants until both were opened. Then: “Some modern writers read this as resembling the Big Bang.”

Science: about 13.8 billion years ago (Planck 2018: 13.787 ± 0.020 Gyr, assuming the standard ΛCDM model). Hot, dense early universe; inflation (well supported but not directly confirmed).

Visual: a single point of light expanding; space itself stretching. Not timed to the verse.

### Chapter 2: The first light
Text: Quran 41:11 (He turned to the heaven while it was smoke, dukhan).

Scholarly layer: classical commentators describe the smoke as steam or vapour, and note the earth’s creation is mentioned before the heavens were shaped. Do NOT caption the CMB fog as “the smoke”.

Science:
- Big Bang nucleosynthesis: about 75% hydrogen and 25% helium by mass (about 92/8 by number of atoms), with traces of deuterium, helium-3, lithium-7.
- Recombination about 380,000 years after the beginning (redshift ~1,100, ~3,000 K). The CMB today is 2.7 K.

Visual: glowing opaque plasma that clears into transparent space; the real Planck CMB map with its colour scale and credit.

### Chapter 3: The dark ages and first stars
Science:
- Dark matter clumps into a cosmic web.
- First stars likely at about 100 to 200 million years.
- JWST has confirmed galaxies at about 280 to 290 million years (JADES-GS-z14-0 at z = 14.32; MoM-z14 at z = 14.44, the current spectroscopic record). They are brighter and earlier than many models expected: an open question.

Visual: filaments forming, then first stars igniting. Flash-safety rules apply.

### Chapter 4: A vast heaven
Text: Quran 51:47 (We built the heaven with strength, and indeed We are la-musi’un).

Scholarly layer: classical glosses include “We made it vast” and “We are capable, vast in power”. “Expanding” is a modern reading; label it so.

Science:
- Hubble’s discovery, redshift, accelerating expansion.
- Hubble tension: early-universe measurements give about 67 to 68 km/s/Mpc (Planck 67.4; ACT DR6 with Planck and DESI 68.2 to 68.4); local measurements (SH0ES) give about 73. Show both; it is unresolved.
- Dark energy: a cosmological constant is the simplest explanation, but DESI 2024/2025 with CMB and supernova data hints (2.8 to 4.2σ) that dark energy may be weakening. Not yet a discovery.

Interactive: slider that stretches space, showing galaxies receding and light redshifting.

### Chapter 5: Seven heavens and the galaxies
Text: Quran 67:3 (seven heavens in layers, no flaw), 41:12 (completed them as seven heavens in two days), 65:12 (seven heavens, and of the earth the like of them).

Scholarly layer: “The Quran affirms seven heavens. Most classical scholars understood them as real realms, largely beyond what we can observe. This scene shows only observable structure and does not identify the seven heavens with it.”

Science: galaxy formation, the Milky Way, real SDSS galaxy positions (about 200k points, subsampled).

Visual: pull back from our galaxy to the observable universe.

### Chapter 6: Stars and iron
Text: Quran 57:25 (and We sent down iron, anzalna al-hadid, in which is great might and benefits).

Scholarly layer: Ibn Kathir emphasises iron’s might and benefit. Reading anzalna as “granted” or “provided” is common in tafsir (compare 39:6, where cattle are “sent down”). The meteorite or supernova reading is modern and debated.

Science:
- Fusion in massive stars stops at the “iron peak”: silicon burning makes nickel-56, which decays through cobalt-56 to iron-56.
- Much of the galaxy’s iron (roughly half or more) comes from Type Ia supernovae (exploding white dwarfs), not only core-collapse supernovae.

Visual: both supernova types. Never place verse text on the exploding star.

### Chapter 7: The Sun and its course
Text (tie each phrase to its own ayah):
- 36:38: the sun runs to its resting place (li-mustaqarrin laha).
- 36:39: the moon’s phases.
- 36:40 and 21:33: each floating in an orbit (kullun fi falakin yasbahun).

Scholarly layer: include Sahih al-Bukhari 3199 (Abu Dharr, may Allah be pleased with him): the Prophet ﷺ said the sun’s resting place is beneath the Throne, where it prostrates and asks permission to rise. Present it as a matter of the unseen (ghayb), not a physical claim about orbits; scholars read it differently. Ibn Kathir’s other view: the mustaqarr is an appointed term ending on the Last Day. Do NOT present the galactic orbit as “the explanation” of the verse.

Science: the Sun formed 4.567 billion years ago; protoplanetary disk; planets; the Sun orbits the galactic centre about every 225 to 250 million years (real JPL data for planets).

### Chapter 8: The earth spread out
Text:
- 41:9 to 12: Earth in two days (41:9); its provisions “in four days” (41:10); heavens in two days (41:12). State the classical explanation that the four days include the first two, so the total is six, matching 7:54.
- 7:54, 32:4, 25:59: six days. 50:38: no weariness touched Him.
- 32:5 and 70:4: a “Day” can be a thousand or fifty thousand years. Give one line of context: 70:4 concerns the ascent of the angels. (22:47 may be added with a note that its context is people asking to hasten punishment.)
- 79:30 to 32: after that He spread the earth (dahaha), brought forth its water and pasture, and set the mountains firmly.

Scholarly layer:
- Six days: “Scholars differed on whether these are ordinary days or longer periods. The 13.8-billion-year timeline is science’s model, not an interpretation of the days.”
- Order: note that 79:30 (“after that”) and 41:9 to 11 are reconciled by commentators (the earth created, then the heavens shaped, then the earth spread).
- Avoid the popular “ostrich egg” reading of dahaha.

Science: Earth formed 4.54 ± 0.05 billion years ago; the Moon-forming impact roughly 30 to 100 million years after the solar system formed (timing debated); cooling, oceans, plate tectonics, mountains.

### Chapter 9: Life from water
Text: Quran 21:30 (We made from water every living thing) and 24:45 (Allah created every creature from water).

Scholarly layer: “Scholars differ on biological evolution. Many accept it for other life while holding that Adam, peace be upon him, was specially created. This chapter does not take a side.” End the chapter before early humans.

Science: evidence of life by about 3.5 billion years (widely accepted), likely 3.7; contested claims reach 3.95 to 4.1. A 2024 genetic study places the last universal common ancestor at about 4.2 billion years (range ~4.09 to 4.33).

Rise of oxygen; spread of life.

### Chapter 10: The folding of the heavens
Text:
- 21:104: the day We fold the heaven like the folding of a written scroll; as We began the first creation, We will repeat it.
- 39:67 with Sahih al-Bukhari 4812 and Sahih Muslim 2787 (Abu Huraira): the earth grasped and the heavens rolled up on the Day of Resurrection. No hand imagery.
- 81:1 to 2: the sun wrapped up; the stars fall, dispersing.
- 82:1 to 2: the sky breaks apart; the stars scatter.
- 14:48: the earth and heavens replaced.

Science (separate layer): possible cosmic futures as open hypotheses. A constant dark energy leads to heat death; strengthening dark energy to a Big Rip; if DESI’s weakening hint holds, slowing expansion or even recollapse (Big Crunch) becomes possible again.

Visual: label the folding as artistic, not a depiction of the Last Day. Ends in light and the calligraphy of 21:104.

Optional across chapters (verified references): 86:11 (the sky which returns), 55:33 (the regions of the heavens and earth).

—

## 4. TECH

- Stack: Vite + TypeScript (strict) + Three.js from three/webgpu. WebGPURenderer with its automatic WebGL2 fallback; await renderer.init() first. All shaders in TSL (GLSL ShaderMaterial and EffectComposer do not work on WebGPU). Post-processing via TSL nodes. Every compute effect needs a non-compute WebGL2 path.
- Support: WebGPU on Chrome/Edge 113+, Safari 26 (macOS, iOS), Firefox 141+ (Windows) and 147+ (Apple Silicon), Chrome Android 12+. WebGL2 everywhere else.
- Structure:
  src/core/      renderer, quality tiers, loader, audio, timeline
  src/chapters/  ch00..ch10 (scene.ts + content.json each)
  src/ui/        panel, timeline, captions, sources page
  src/i18n/      en.json, ar.json
  data/          frozen scripture + science data (read-only at runtime)
  scripts/       fetch, freeze, validate, preprocess
- Chapter system: each chapter exports {id, load(), enter(), update(t, dt), exit(), dispose(), cues[]}. One timeline state machine (idle → loading → intro → playing → explore → outro) owns camera keyframes, text cues and audio cues. Deep links like #/ch/2?t=30. One verse key may appear in several chapters (e.g. 21:30).
- Loading: shell + Chapter 0 under 1.5 MB gzipped. Prefetch chapter N+1, dispose N-1. KTX2 textures, Meshopt geometry, binary data (Float32Array, quantized Int16).
- Quality tiers: High (WebGPU desktop) 2M particles; Mid (WebGL2 or integrated GPU) 300k; Low (mobile) 80k with DPR capped at 1.5. Governor drops one tier if frame time stays above 20 ms for 2 seconds; never upgrades mid-scene.

## 5. DATA PIPELINE

1. scripts/fetch-quran.ts: download the pinned Tanzil Uthmani file, keep its copyright block, extract only cited ayat to data/quran.json with {key, arabic, translit, translation, translationId, license, source, sourceVersion, sha256, fetchedAt}.
2. data/hadith.json: entered by a person from sunnah.com, with {collection, number, sunnahKey, grading, grader, disputedNote, reviewer}. Never generated.
3. data/constants.json: every scientific number with value, uncertainty, and citation.
4. scripts/validate.ts: NFC-normalise and compare every displayed verse against Tanzil (and the Quran Foundation API when credentials exist). Fail CI on any mismatch, missing source, or verse key absent from sources.json. CI also fails if Arabic text appears anywhere in src/.
5. Offline preprocessing: Planck FITS → equirectangular texture (healpy); SDSS galaxies with reliable redshift (zWarning = 0) → comoving 3D positions (Planck 2018 cosmology) → ~200k quantized points; JPL elements → JSON.

## 6. AUDIO

- Default: no music. While a verse is recited, ambient sound and scene effects fade to silence (Quran 7:204: listen and pay attention).
- Between verses: optional ambient track of voice and nature sounds only; instruments off by default.
- Recitation: live via the Quran Foundation proxy, reciter selectable. No effects on recitation (no pitch, speed, or reverb changes). Confirm the audio license.

## 7. UI AND ACCESSIBILITY

- Cinematic auto-play and free-explore modes (orbit by mouse or touch, WASD, Esc returns to timeline).
- Side panel with the three layers; bottom sheet on mobile.
- Sources page generated from sources.json, including reviewer names and dates.
- English and Arabic UI via ICU message files; dir=“rtl” with CSS logical properties; Urdu added later by one locale file.
- Scripture blocks: lang=“ar” dir=“rtl” translate=“no” so browsers never auto-translate them.
- Captions (WebVTT) for all narration and recitation.
- prefers-reduced-motion: no shake or flashes, crossfades instead. Never more than 3 flashes per second.
- Full keyboard control, visible focus, real DOM text (never baked into the canvas), contrast at least 4.5:1, pause always available.

## 8. QUALITY BAR (acceptance criteria)

- npm run validate exits 0: every ayah matches its source byte for byte after NFC, every hadith has collection, number, and grading.
- Median fps over a 60-second auto-play: at least 60 (1% low at least 45) on an M1 or RTX 3060 laptop at High; at least 30 on a Pixel 7 or iPhone 13 at Low.
- First visual in under 3 seconds on throttled 4G.
- Lighthouse accessibility at least 95; axe passes; keyboard-only run-through passes.
- All chapters work with forceWebGL: true.
- Strict TypeScript with zero errors, ESLint clean, Playwright smoke test per chapter.

## 9. REVIEW (required before public release)

1. Automated: all Arabic checked against Tanzil.
2. A qualified Islamic scholar signs off on translations, tafsir summaries, honorifics, hadith gradings, and the range-of-views statements (seven heavens, six days, evolution).
3. An astrophysicist reviews the science layer.
4. Record names and dates in REVIEW.md and on the Sources page.

## 10. DELIVERABLE (milestones)

- M1, vertical slice: core engine, timeline, panel, data pipeline and validation, Chapters 0 to 2 including the CMB. Deployed and meeting every criterion above.
- M2: Chapters 3 to 6, SDSS data, GPU particle systems.
- M3: Chapters 7 to 10, JPL data.
- M4: recitation proxy, Arabic UI, accessibility audit, scholarly and scientific review recorded.
- Each milestone ships a README (how to run, how to add a chapter), sources.json, the generated Sources page, and a LICENSES file covering fonts, texts, and data.
