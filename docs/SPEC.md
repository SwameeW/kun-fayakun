# Kun Fayakun: Build Spec v2 (verified)

Build an immersive, browser-based 3D experience called “Kun Fayakun” that tells the story of creation, from before time to the formation of Earth and life and on to the end of the universe. It places verses of the Quran and authentic hadith beside real cosmological data, for reflection. It should feel like a reverent, cinematic planetarium show that the viewer can also explore freely.

Build it in milestones (see DELIVERABLE). Ship a working vertical slice (Chapters 0 to 2) before anything else.

—

## 0. PURPOSE (owner, 2026-10-26)

Kun Fayakun is an Islamic educational and reflective experience. Its purpose is to help people
contemplate the precision, balance, intricacy and interconnectedness of the universe Allah has
created, through the cinematic timeline, the scientific explanations, the astronomical explorer, the
physics laboratory and the interactive features alike.

**The real universe is the reference. The sandbox is the thought experiment. Reflection is the
purpose.**

- **The laboratory (sandbox) is never a universe-creation game.** It does not make the visitor a
  creator or give them control over creation. It lets them change physical conditions and see what
  the scientific models say would follow (a planet's distance from the Sun, the Sun's mass, an orbit's
  speed, the Moon's orbit, an atmosphere's thickness, its greenhouse gases, an unstable orbit, a
  collision), so that they understand how the conditions depend on one another and reflect on the
  relationships in the real universe. Every useful mechanic stays; this is its meaning, not a limit on it.
- **Four kinds of content are always kept apart, and labelled:** (1) real observed or measured data;
  (2) scientific theories and models; (3) hypothetical simulation results; (4) Quranic content and
  Islamic interpretation. Modern scientific theories are never presented as definitive Quranic
  interpretations, nor as mathematical proofs of theological claims. A simulation's outcome never
  says what Allah would have decreed under other conditions. Uncertainty, modelling assumptions and a
  simulation's limits are stated.
- **Words.** Never "create your universe", "become the creator", "play God" or "control creation".
  Use "explore the consequences", "what if?", "change the conditions", "experiment with gravity",
  "compare with reality", "investigate the effects".
- **Reflection arises from understanding, not commentary.** Religious commentary is not forced into
  every interaction. A visitor should see what changed, understand why, and compare it with the real
  baseline; occasional questions ("What changed?", "Why did the orbit become unstable?", "How is this
  different from the real solar system?") lead from observation to understanding to reflection.

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
  - Owner, 2026-10-26: the translation shown now is Pickthall’s (1930, public domain), which reads as archaic. A modern translation replaces it only once one is confirmed usable (its licence, or the holder’s written permission) and the owner approves it; it then comes in through the same pinned pipeline (scripts/fetch-quran.ts, sha256, sources.json). Never generate a translation, rewrite a published one, or attribute new wording to a translator.
  - Until then, every cited verse has a plain-words explanation (en.chapters.json `plain.<key>`): explanatory prose like the scholars’ layer, never scripture. It is shown apart from the translation and labelled as an explanation, not a translation, follows the classical commentators, and awaits the scholar’s review (REVIEW.md). In the notes it follows the translation and its attribution; on the film’s verse cards it replaces the translation only when the visitor chooses it, under its label. The validator requires one for every verse in quran.json and holds each verse cue long enough for the longer of the two (rule h).
- Arabic font: Amiri Quran (SIL OFL), self-hosted WOFF2. Do NOT use KFGQPC Uthmanic Hafs (restrictive license, built for a different text encoding).
- Recitation audio: Quran Foundation API v4, live and optional. Needs OAuth2 client credentials via a small serverless proxy (secret never in the browser). Terms forbid caching beyond 1 week or bundling, so do not freeze its text. Use it for recitation and for validating the Tanzil text. Credit Quran Foundation.
- Hadith: entered by a person from the sunnah.com references below. Record collection, number, sunnah.com key, grading, grader, any dispute note, and reviewer.
  - Owner, 2026-10-26: hadith are shown in two levels. In the film, narrations of the same report share one short card: the verified wording once a person has entered and checked it, until then a sourced summary labelled “Summary, not a quotation”, then discreet references (with each narration’s grading and grader outside the two Sahih collections, so gradings that differ sit side by side) and a pointer to the notes. In the notes every narration keeps its own entry: summary, grading and grading notes in view; narrator, parallels, why the wording is not shown, and the sunnah.com link behind “Source details”. Never invent or modernise wording, never present a summary as the Prophet’s ﷺ words, and never drop a grading to save space. The validator requires a summary on every hadith card without verified wording and holds each card long enough to read (rule h).
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

Scholarly layer: Ibn Kathir, citing Ibn Abbas, Sa’id ibn Jubayr and Qatadah: they were joined, then separated by raising the sky. Another early report: the sky gave no rain and the earth no plants until both were opened. Then: “Some modern writers read 21:30 as resembling the Big Bang.”

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

#### Interactive discovery: "Each in an orbit" (planned for M3)

An optional, visitor-led moment in which the letters of the three words *kullun fī falakin* ("each in an orbit", 21:33 and 36:40) are seen to read the same in both directions, while the Sun and Moon keep their courses in the scene behind. It must feel like contemplation, never like a trick. It ships with Chapter 7 in M3 and does not change M1/M2 priorities.

**What is true, and exactly how far it goes** (verified 2026-10-23 against `data/quran.json`, Tanzil Uthmani):
- In 21:33, the three words before *yasbaḥūn* have the base letters (all diacritics removed): kāf, lām · fāʾ, alif maqṣūra · fāʾ, lām, kāf: seven letters, symmetric about the fourth (U+0643 U+0644 · U+0641 U+0649 · U+0641 U+0644 U+0643).
- In 36:40 the same three words are preceded by the attached conjunction *wa-* ("and"), so the first written word there is *wa-kullun*. The symmetry holds for the three words without the conjunction, as classical rhetoricians also treat a parallel case (below). This must be said on screen, not hidden.
- It is a property of the written base letters (the rasm) of those three words only. It is not true of the whole verse, nor of the pronunciation (*kullun fī falakin* does not sound the same reversed), nor of the vowelled text.
- The central letter in the Uthmani text is alif maqṣūra (U+0649, written without dots), not yāʾ (U+064A). Show it as the data has it.
- Classical framing (scholarly layer, classical first): Ibn ʿĀshūr, *al-Taḥrīr wa-l-Tanwīr* on 21:33, counts the phrase as a rhetorical embellishment (*badīʿ*) whose letters read alike from either end, a kind al-Sakkākī named *al-maqlūb al-mustawī* under *qalb* (inversion); he notes al-Ḥarīrī called a similar device by another name, and gives 74:3 *rabbaka fa-kabbir* as a parallel, with the conjunction *wa-* set aside. (Checked on quran-tafsir.net, 2026-10-23; the scholar reviewer must confirm against a printed edition before release. 74:3 may be shown as the second example only after it is added to `data/citations.json` and validated.)
- It is a literary feature. Never present it as scientific proof, a prediction, evidence for any astronomical model, or numerology (do not link "seven letters" to the seven heavens or anything else).

**Quranic text handling (non-negotiable)**
1. The verses are always shown complete and exactly as stored in `data/quran.json`: never reversed, re-ordered, split into animated letters, distorted, morphed, or turned into particles. Verse cards fade in and out whole, as everywhere else.
2. The letter analysis is derived by `scripts/build-analysis.ts` from the verified data, never typed into source: `data/citations.json` names the verses and the word positions (counted over whitespace tokens that contain at least one base letter, because Tanzil writes some pause marks as standalone tokens), plus `dropLeadingLetters: 1` for 36:40 with the expected code point of the dropped letter. The script strips every combining mark (Unicode Mn, including harakāt, shadda, tanwīn, superscript alif and the Quranic annotation signs U+06D6–U+06ED) and tatweel (U+0640), asserts that both verses yield the same seven letters, asserts the sequence equals its reverse, and writes `public/assets/analysis/kullun-fi-falak.json` with the verse keys, the sha256 of each source verse's Arabic, the token positions, the letters as code points and their English letter names. `npm run validate` re-derives it and fails on any mismatch.
3. The analysis is always visibly labelled as such, e.g. "Letter analysis: base letters only, diacritics and spaces removed. This is not the Quranic text as written." It sits in its own panel, styled differently from scripture (no Amiri Quran display face, no verse framing), and the vowelled verse remains on screen above it, untouched.
4. "Reading in either direction" moves a light over letter tiles that never change order. Where the sequence read the other way is listed, it is listed as letter names (kāf, lām, fāʾ, alif maqṣūra, fāʾ, lām, kāf), never as a reversed Arabic string presented as text.
5. Every Arabic element carries `lang="ar" dir="rtl" translate="no"`. No Arabic in `src/`.

**Visual direction**
- The scene: the Sun as a living star (animated granulation, limb darkening, a faint corona that the bloom carries), the Moon lit by it with the correct phase, and the Earth with its terminator, each moving on its own course from JPL ephemerides (positions and periods real; sizes and distances compressed and labelled "not to scale"). The modern heliocentric picture is shown as science; the verse is not mapped onto it.
- An instrument-of-light motif drawn from the astrolabes and armillary spheres of the Islamic astronomical tradition: orbits as fine engraved rings of warm light, graduated like an astrolabe's limb, with deep parallax as the camera drifts. Restrained, never ornamental clutter. (A user-supplied orrery image is mood reference only, not to be copied.)
- When the discovery opens, the scene dims gently and its motion slows, but it never stops: the orbits continue behind the letters, so the symmetry is felt inside the cosmos rather than on a page.

**Discovery sequence** (visitor-led; nothing auto-starts)
1. Invitation: after the verse card has finished and its three panel layers are available, the scholarly layer offers "Explore the letters of this phrase". A quiet button, never a pop-up and never timed to the verse.
2. The phrase: the vowelled verse stays in its card; the three words are marked in place with a soft underline of light (the text itself is not altered or moved).
3. Letters on an orbit: the analysis panel shows the seven base letters as tiles along a gentle arc, a *falak* of their own, with the mirror axis through the central letter drawn as a thin vertical line of light.
4. Mirrored pairs: the outer pair (kāf, kāf), then lām and lām, then fāʾ and fāʾ, glide along the arc toward the centre like two bodies on one orbit approaching from either side, meeting the central letter with a soft ring of light (eased over at least 0.6 s, low intensity, never a flash), then return. Behind them, the Sun and Moon keep their courses.
5. Either way: two controls, "Read right to left" and "Read left to right", send a travelling light across the tiles, naming each letter as it passes. Both readings produce the same list, shown side by side as letter names, with one sentence: "Read the seven base letters from either end: the sequence is the same."
6. Context: one line each for 36:40's conjunction, the "central three words, not the whole verse" point, and the rasm-not-pronunciation point; then the classical note (Ibn ʿĀshūr, al-Sakkākī) and a closing line that this is a literary beauty of the text, offered for reflection.
7. Close: the panel fades; the scene returns to full brightness and speed; focus returns to the button that opened it.

**Interaction and accessibility**
- Opens inline in the panel on desktop and as a full-height sheet on mobile (touch targets at least 44 px; swipe on the tiles moves the reading light).
- Keyboard: Tab reaches every control; Left and Right arrows move the reading light one letter; Home and End jump to either end; Enter or Space plays a reading; P replays the mirrored pairs; Esc closes and restores focus. Visible focus on every tile and control.
- Screen readers: tiles are real DOM text, each named "kāf, letter 1 of 7, pairs with letter 7"; the pairing and both readings are announced in an `aria-live="polite"` region; the meaning never depends on colour alone (pairs also carry numbers).
- Reduced motion: no gliding or travelling light; pairs and the current letter are shown with crossfaded highlights; readings advance only when the visitor steps them; the scene's orbits slow to near-still.
- Text stays DOM, never baked into the canvas. Tiles may be anchored to 3D positions (projected once per frame and written as compositor-only CSS transforms) for depth, while remaining real text.
- English and Arabic UI via the locale files; letter names and all explanatory strings are ICU messages.

**Performance**
- The discovery layer is DOM and CSS (transform and opacity only, no layout per frame) plus at most three extra draw calls in the scene (the mirror axis, the pair arcs, one soft glow), all running on WebGPU and WebGL2 with no compute.
- Budget: opening it adds at most 0.5 ms GPU and 1 ms CPU per frame on High; the chapter keeps the M3 targets (60 fps median, 1% low at least 45 on an M1-class laptop at High; 30 fps on a Pixel 7 or iPhone 13 at Low). Measured with `?profile=1` and the Playwright perf spec.
- Every effect must earn its place: if an effect does not help the visitor see the symmetry or feel the orbit, it is cut.

**Tests and review**
- Unit tests for the extraction (both verses, the conjunction, standalone pause-mark tokens, the alif maqṣūra) and a validator rule for the generated asset.
- Playwright: open and close by keyboard, read both directions, axe with the panel open, reduced motion, mobile width, and a check that the verse text in the card is byte-identical to `data/quran.json` while the discovery runs.
- The scholar reviewer signs off on the wording of the analysis labels, the classical attribution, and the conjunction note (section 9).

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
  - Owner, 2026-10-26 (“add high quality sounds to the cinematic parts … make sure they make sense”): the film has a sound score of nature and physics only, made in Web Audio (no recordings, nothing to license), on by default with one speaker in the header shared with the explorer’s Sound. Where there was sound it is that sound (the plasma’s acoustic peaks until recombination; the Sun’s acoustic modes; lava, rain, sea, wind); in space, only a low hush. Levels follow each chapter’s scene events, near silence under every verse and lower under hadith cards, silence where the screenplay keeps it, no one-shot on a seek, a fade before a pause. film/screenplay.md “Sound” and the shot list’s sound column describe it; tests/film-sound.spec.ts measures it (headroom, the duck, the silences).
  - Owner, 2026-10-28 (“fix the sounds in the cinematic, it’s awful … if you wanna add anything cool in the cinematics please go ahead”): still nature and physics only (no music, instrument, melody, chord or voice; no oscillator anywhere, so nothing can form a note, and no breath with a mouth’s resonances), but real recordings where they are better than anything made: public domain or CC0 only, from a page that says so, never anything in doubt (USGS, the NPS Sound Gallery, Wikimedia Commons; not Freesound behind an account, nothing CC BY or NC). They are credited on the Sources page (sources.json kind “recording”) and in LICENSES, cut from their pinned originals by scripts/sound/build.py into public/assets/sound (AAC, about 2.7 MB in all), and fetched only when their chapter plays with sound on. The plasma’s acoustic peaks and the Sun’s modes stay made in Web Audio from the physics, as resonances of noise. The mix has a measured target: -27 LUFS per chapter outside verses and silences, within 1.5 LU (Chapter 0 about -36; beds -28 to -24 short-term, swells a few LU above, true peaks under -3 dBFS), -51 to -60 under a verse, on a laptop’s speakers within about 3 dB of that and on a phone’s within about 6; the duck eases down before a card and back up over five seconds after it.
- Recitation: live via the Quran Foundation proxy, reciter selectable. No effects on recitation (no pitch, speed, or reverb changes). Confirm the audio license.

## 7. UI AND ACCESSIBILITY

- Cinematic auto-play and free-explore modes (orbit by mouse or touch, WASD, Esc returns to timeline).
  - Owner, 2026-10-26: free explore is more than a free camera. Each chapter's Discover dock (content.json `explore`: points, process, extras; src/ui/discover-dock.ts) offers moments to visit (the scene at that time, seen from the film's camera then, with a card labelled measured, model or illustration, its numbers from data/constants.json and its sources cited), a slider through the chapter's own process, and closer looks suited to the chapter. The film's clock never moves; "Back to the film's moment" and leaving explore restore the scene and camera; the film's captions and verse cards step aside while another moment is shown. No scores or collectibles. Chapter 0 offers words only (nothing of the unseen is pictured); Chapter 10's futures are labelled models, apart from the Quran's descriptions of the Last Day. Different from the laboratory, which is for hypothetical experiments.
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

## 9. REVIEW (before each release)

1. Automated: all Arabic checked against Tanzil (`npm run validate`, and `-- --online` before a release).
2. Everything else is checked within the project, with no outside sign-off (the owner's decision, 2026-10-28: no Islamic scholar's or astrophysicist's sign-off is sought): the commentary only summarises the classical works it cites and labels modern readings as modern; the hadith carry their collection, number and grading; every number in the science is cited; the data pipelines check themselves; and each change is tested and independently reviewed.
3. REVIEW.md records what those checks cover; the Sources page says how the content is checked.

## 10. DELIVERABLE (milestones)

- M1, vertical slice: core engine, timeline, panel, data pipeline and validation, Chapters 0 to 2 including the CMB. Deployed and meeting every criterion above.
- M2: Chapters 3 to 6, SDSS data, GPU particle systems.
- M3: Chapters 7 to 10, JPL data, and the Chapter 7 "Each in an orbit" letter discovery (section 3, Chapter 7).
- M4: recitation proxy, Arabic UI, accessibility audit, scholarly and scientific review recorded.
- Each milestone ships a README (how to run, how to add a chapter), sources.json, the generated Sources page, and a LICENSES file covering fonts, texts, and data.
