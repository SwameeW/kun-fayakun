# Review record

Kun Fayakun places Quranic verses and hadith beside cosmology. Under the spec
(docs/SPEC.md, section 9) it must not be released publicly until all four reviews
below are signed off. This file is the record. `data/sources.json` → `reviews`
mirrors it, and the Sources page shows it.

## Process (spec section 9)

1. **Automated:** all Arabic is checked against Tanzil. `npm run validate` must
   exit 0. Run `npm run validate -- --online` before each release as well: it
   re-downloads Tanzil and, when `QF_CLIENT_ID` and `QF_CLIENT_SECRET` are set,
   compares every ayah with the Quran Foundation API.
2. **Islamic scholar:** a qualified scholar signs off on the translations, the
   tafsir summaries, the honorifics, the hadith gradings and the range-of-views
   statements (seven heavens, six days, evolution).
3. **Astrophysicist:** reviews the science layer.
4. **Record:** each reviewer's name, role and date go in the table below and in
   `data/sources.json` → `reviews` (areas: `scripture`, `tafsir`, `hadith`,
   `science`, `accessibility`). For a review that covers one source, also fill
   that source's `review` field. The Sources page shows them.

A sign-off covers the content as it stood on the date given. If verses, hadith,
scholarly text or science text change later, that area needs review again.

## Sign-offs

| Area | Reviewer | Role | Date | Status | Result / notes |
|---|---|---|---|---|---|
| Scripture, automated check | `npm run validate` | Automated | 2026-10-22 | Partial | Rule a (scripture) **passes**: the 3 pinned Tanzil files match their sha256 pins; all 36 ayat in `data/quran.json` equal NFC(pinned line), and their sha256, transliteration and translation match. There is 1 warning: NFC reorders marks in 34 ayat (see Open decisions). Rules c-i pass. Rule j **fails** only because the calligraphy assets have not been built yet (`public/assets/calligraphy/kun.json`, `public/fonts/AmiriQuran.woff2`). Overall exit code: 1. The online check (rule b) was run with no QF credentials: tanzil.net still serves the 3 pinned files; the Quran Foundation comparison was skipped. |
| Islamic scholar (translations, tafsir, honorifics, hadith, range of views) | | Qualified Islamic scholar | | **Pending** | |
| Astrophysicist (science layer) | | Astrophysicist | | **Pending** | |
| Accessibility audit | | Accessibility auditor | | **Pending** (planned for M4) | |

## What each reviewer must check

### 1. Scripture (automated, plus a human spot check)

- `npm run validate` exits 0, and `npm run validate -- --online` shows no failures.
  Every displayed ayah must equal the NFC form of its line in the pinned Tanzil
  Uthmani file, byte for byte.
- Spot-check several ayat on screen against https://tanzil.net. Check that
  each verse fades in and out whole, is never cut mid-ayah, and never appears
  on a loading or error screen or on a surface that is flown through, exploded
  or turned into particles.
- Check the Tanzil credit and the link to tanzil.net on the Sources page.

### 2. Islamic scholar

- **Translations.** The Pickthall translation (1930, public domain) for every
  cited ayah. Is it acceptable to show next to the Arabic, and does any ayah
  need a note? Also check the transliteration (Tanzil `en.transliteration`).
- **Tafsir summaries.** The classical reading comes first: Ibn Kathir,
  al-Tabari, al-Qurtubi. Each summary must be faithful to the cited scholar.
  Modern readings must be labelled "Some modern writers read this as...", and
  nothing may say the Quran "predicted" or "proves" anything.
- **Chapter 0.** The Pen hadith wording must match the spec: first after the
  Throne and the water, or first in the command to write (Ibn Hajar). Check that
  Sahih Muslim 2789 is not used anywhere.
- **Honorifics.** These follow spec section 1.5: the honorific ligature after
  the Prophet's name, "peace be upon him" for other prophets, "may Allah be
  pleased with him" for Companions, and "glorified and exalted is He" after
  Allah at least on first mention in each chapter.
- **Hadith.** For every record in `data/hadith.json` check the collection,
  number, sunnah.com key, narrator, grading, grader and dispute note. Both
  gradings of the Pen hadith must appear: Abu Dawud 4700 (sahih per al-Albani)
  and Tirmidhi 2155 (gharib by this chain). Any hadith wording must be entered by
  a person from sunnah.com and carry `reviewer` and `reviewedAt`.
- **Range-of-views statements.** These cover the seven heavens (Chapter 5), the
  six days (Chapter 8) and evolution (Chapter 9), and are due in later
  milestones. Each must state the range of scholarly views and take no side.
- **Depictions.** Allah, angels, prophets, the Throne, the water beneath the
  Throne, the Pen, the Tablet and the Kaaba must not be depicted in any form.
- **The prophets' lands (explorer, Living Earth, "Field notes, by Samee").**
  The 25 prophets named in the Quran, each with a short note and, where a
  tradition is widely held, the place it points to (`src/explore/field-notes/data.ts`,
  the `ui.universe.field.prophet.*` and `ui.universe.field.site.*` messages in
  `src/i18n/en.json`). Check each note: that it is labelled "by tradition",
  states where traditions differ, takes no sectarian position, and that the
  places chosen are the widely held ones (Adam's Peak in Sri Lanka, for the
  Sarandib reports in the early histories such as al-Tabari's and Ibn Kathir's,
  described as weakly attested; Mount Judi; Shib Hud in Hadramawt;
  al-Hijr by Hegra; Harran, Hebron and Makkah; the Dead Sea; Bahr Yussef; al-Bad
  for Madyan; Jabal Musa; Jabal Harun; Jerusalem; Nineveh; the Umayyad Mosque;
  Nazareth; Madinah). No place is marked for Idris, Ayyub, Dhul-Kifl, Ilyas or
  Al-Yasa. Also check the honorifics and the biblical names given in
  brackets. Only names on the ground are shown; Makkah is never framed closer
  than 30 km across (`MAKKAH_FRAME`).
- **The qibla and the new moon (explorer, `docs/ISLAMIC-ASTRONOMY.md`).** That
  the section gives no rulings: the qibla as a great-circle direction from true
  north, the crescent map as what the sky allows (Yallop's criterion, or
  Odeh's) with the note that communities begin each month by their own
  practice, and the Umm al-Qura date named as such. That the golden-latitude
  note is worded as a closeness of numbers, not evidence. The times of prayer
  (`ui.universe.islamic.prayer*`): that the ten conventions are named and
  described fairly (each its institution's, none preferred, the Muslim World
  League's shown first only as PrayTimes.org lists it first), that Asr's two
  reckonings name the schools correctly (one shadow-length: Shafi'i, Maliki,
  Hanbali, Ja'fari; two: Hanafi), that Maghrib by the Sun 4 or 4.5 degrees
  below the horizon is described rightly for the Tehran and Qum conventions,
  and that the note sends people to their own community's timetable. The
  heritage notes (`ui.universe.islamic.heritage.*`): al-Battani, al-Sufi,
  al-Tusi, Ulugh Beg, the Darb-i Imam's girih tiles, Taqi al-Din; and the
  Andromeda Galaxy named on the sky as al-Sufi's "little cloud". The astrolabe's
  note (`ui.universe.islamic.astrolabe.*`): the one instrument it names (the
  Science Museum's, from its catalogue) and the line 18 degrees below the
  horizon described as several conventions' depression for Fajr or Isha. The
  qibla on foot (`ui.universe.walk.qibla*`): a great-circle bearing and the turn
  to face it, worded as a direction only.

### 3. Astrophysicist

- The qibla and the new moon's astronomy (`src/explore/islamic/astronomy.ts`):
  the checks against published values in `docs/ISLAMIC-ASTRONOMY.md`,
  Yallop's test as implemented (best time, geocentric ARCV, topocentric W'),
  Odeh's (topocentric ARCV and W at the same best time), and the times of
  prayer (depressions of the Sun's centre without refraction; sunrise and
  sunset by the upper limb with 34' of refraction; Asr from the noon shadow).
  The astrolabe (`src/explore/islamic/astrolabe.ts`): the stereographic
  projection from the pole below the horizon, the plate's circles against their
  classic constructions, the rete turned by the local mean sidereal time with
  the stars precessed to the date, and the rule's local apparent time.

- Every number in `data/constants.json` (value, uncertainty, unit, qualifier,
  citation and access date), and every place it appears in the panels.
- Chapter 1: the age of the universe (13.787 ± 0.020 Gyr, assuming ΛCDM) and
  how inflation is described ("well supported but not directly confirmed").
- Chapter 2: the Big Bang nucleosynthesis abundances (mass and number
  fractions, deuterium, helium-3, lithium-7), recombination (about 380,000
  years, z ≈ 1,100, about 3,000 K) and the CMB today (2.7 K). The Planck map:
  correct projection and colour scale, credit "ESA and the Planck
  Collaboration". The fog must never be captioned "smoke".
- Open questions must be presented as open; the science layer must never be
  presented as an interpretation of a verse.

### 4. Accessibility audit (M4)

- Lighthouse accessibility score ≥ 95, axe passes, and a full keyboard-only run
  through. Focus must be visible and contrast ≥ 4.5:1.
- Real DOM text, never text baked into the canvas. Scripture blocks must carry
  `lang="ar" dir="rtl" translate="no"`. Captions are needed for all narration
  and recitation.
- With `prefers-reduced-motion`: no shaking or flashes, crossfades only. Never
  more than 3 flashes per second. Pause must always be available.

## Open decisions for the owner (found while building the data pipeline)

1. **Transliteration licence.** Tanzil's `en.transliteration` names no author or
   publisher. Tanzil distributes it "for non-commercial purposes only", so it is
   not clearly redistributable. It is kept for now, flagged in
   `data/sources.json` and `LICENSES`. Before any commercial use, replace it or
   obtain clear permission.
2. **NFC versus the raw bytes.** The contract stores the Arabic as NFC. For 34
   of the 36 cited ayat, NFC reorders combining marks (for example shadda after
   the vowel sign) or composes alef + madda. The result is canonically
   equivalent to Tanzil's text but not byte-identical to the file. A scholar or
   the owner should confirm this is acceptable under Tanzil's "verbatim" terms,
   and that the rendering (Amiri Quran in each browser) looks identical.
3. **Project licence.** The owner has not chosen a licence for the project's own
   code yet (see `LICENSES`).
4. **sunnah.com terms.** These were not readable by the build tools. Check them
   before any hadith wording is entered.
5. **Quran Foundation API terms.** Re-read them before the M4 recitation proxy.
