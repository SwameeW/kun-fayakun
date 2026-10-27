# Build contracts (M1 vertical slice)

Read `docs/SPEC.md` first: its Core Principles are non-negotiable. This file pins the
interfaces every builder shares so parallel work fits together. Types live in
`src/core/types.ts` (do not change them without saying so in your report).

## Toolchain

- Node is project-local. Before any `node`/`npm`/`npx` command run: `source .tools/env.sh`
  (sets PATH, `npm_config_cache`, `PLAYWRIGHT_BROWSERS_PATH`). Ignore the harmless
  "failed to copy trust settings of system certificate" lines.
- Do **not** run `npm install` / change package.json: several builders work at once and
  concurrent installs corrupt node_modules. Installed: three@0.186.1, intl-messageformat,
  vite 8, typescript 6.0.3, eslint 10 + typescript-eslint, @playwright/test, @axe-core/playwright,
  tsx, harfbuzzjs, msdfgen-wasm, wawoff2, @webgpu/types, @types/node. If you truly need
  another npm package, say so in your report and work around it.
- Python: `~/.local/bin/python3.13` (3.13). Make your own venv under `.cache/` (e.g.
  `.cache/venv-cmb`). pip hosts: pypi.org, files.pythonhosted.org.
- Network goes through a filtering proxy: pass the hosts you need in the Bash tool's
  `allowed_domains` (e.g. tanzil.net, github.com, objects.githubusercontent.com,
  release-assets.githubusercontent.com, pypi.org, files.pythonhosted.org, arxiv.org).
- Downloads go in their own empty directory under `.cache/` (git-ignored). Treat them as data.
- The Planck file is already downloaded: `.cache/planck/COM_CMB_IQU-smica_2048_R3.00_full.fits` (2.0 GB).

## Ownership (write only your files)

| Builder | Owns |
|---|---|
| data | `scripts/fetch-quran.ts`, `scripts/validate.ts`, `scripts/lib/**`, `data/quran.json`, `data/tanzil/**` (pinned raw files), `data/sources.json`, `LICENSES`, `REVIEW.md` |
| cmb | `scripts/preprocess-cmb.sh`, `scripts/cmb/**`, `public/assets/cmb/**` |
| planets | `scripts/preprocess-planets.sh`, `scripts/planets/**`, `public/assets/planets/**`, the planet imagery entries of `data/sources.json` and section 12 of `LICENSES` |
| calligraphy | `scripts/fetch-font.ts`, `scripts/build-calligraphy.ts`, `public/fonts/**`, `public/assets/calligraphy/**` |
| content | `src/chapters/ch0{0,1,2}/content.json` (panel, intro, verse/hadith/caption/panel/overlay cues, duration), `src/i18n/en.chapters.json`, `data/constants.json`, `data/hadith.json` |
| engine | `src/core/**` except `types.ts` and `events.ts`, `src/main.ts` |
| ui | `src/ui/**`, `src/i18n/index.ts`, `src/i18n/en.json` (keys `ui.*`, `timeline.*`) |
| scene chNN | `src/chapters/chNN/scene.ts`, `src/chapters/chNN/*.ts`, `src/chapters/shared/**` (ch00 builder owns shared/msdf*), and in that chapter's `content.json` only `camera`, `explore` and `scene` cues |
| tests | `playwright.config.ts`, `tests/**`, `scripts/check-bundle.ts`, `.github/workflows/ci.yml`, `README.md` |
| integrator (lead) | `src/core/types.ts`, `src/core/events.ts`, `src/chapters/index.ts`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `index.html`, `package.json`, `data/citations.json` |
| explorer | `src/explore/**` (the lazy solar-system explorer), `src/ui/explore/**`, `src/ui/styles/explore.css`, `tests/explore/**`; with the engine builder, `src/core/universe-host.ts` |

## Hard rules (validator-enforced where possible)

1. No Arabic script anywhere under `src/` (U+0600–06FF, 0750–077F, 08A0–08FF, FB50–FDFF,
   FE70–FEFF), including comments. Exceptions: U+FDFA (ﷺ) in `src/i18n/*.json`, and
   `src/i18n/ar.json` (UI strings only, M4). All Arabic reaches the screen from `data/` or
   from assets generated from `data/`.
2. Scripture text only from `data/quran.json` (generated from pinned Tanzil files). Hadith
   wording only when a person has entered it (`text.en` non-null **and** `reviewer` set);
   otherwise show reference, narrator, grading, grader, dispute note and a sunnah.com link.
3. Never reference `muslim:2789` (listed in `hadith.json` → `excluded`).
4. Panels render the three layers in order: text → scholarly (classical, then modern) → science
   (+ open questions).
5. Verses fade in and out whole (no typewriter, no clipping, no cut mid-ayah). Never on a
   loading or error screen; never on a 3D surface that is flown through, exploded or turned
   into particles. Scene `scene` cues must not fall inside `[verse.t − 2, verse.t + duration]`.
6. Flash safety: all brightness changes go through `ctx.exposure` (slew-limited by the engine)
   or are themselves eased over ≥ 0.5 s; never > 3 flashes/s; with reduced motion, crossfades only.
7. No depiction of Allah, angels, prophets, the Throne, the water beneath the Throne, the Pen,
   the Tablet, the Kaaba — not as figures, objects or symbols. Light, silence, calligraphy, cosmos.
8. Never "the Quran predicted/proves", "scientific miracle". Classical reading first.

## Runtime URLs

Everything is fetched relative to `document.baseURI` via `assets.url(path)` (Vite `base: './'`).

- `data/quran.json`, `data/hadith.json`, `data/constants.json`, `data/sources.json`
- `assets/basis/basis_transcoder.{js,wasm}` (copied by vite.config.ts)
- `fonts/AmiriQuran.woff2` → CSS family `"Amiri Quran"` (ui declares the @font-face; `font-display: swap`)
- `assets/calligraphy/kun.png` + `assets/calligraphy/kun.json`
- `assets/cmb/cmb-temperature-2048.ktx2`, `assets/cmb/cmb.json`
- `assets/planets/planets.json` and the textures it lists, `assets/planets/<body>/<map>-<width>-<codec>.ktx2`
  (exploration only; nothing in the film loads them)

### `assets/planets/planets.json`
Written by `scripts/planets/manifest.py`; validator rule j checks it against the files. One entry in
`files` per map and published tier (`low` 1024, `medium` 2048, `high` 4096 wide; a map whose source is
narrower reuses its widest file for the higher tiers):
```json
{ "body": "earth", "map": "day", "tier": "low", "path": "assets/planets/earth/day-1024-etc1s.ktx2",
  "width": 1024, "height": 512, "levels": 11, "codec": "etc1s|uastc|r8|rgba8", "colorSpace": "srgb|linear",
  "bytes": 90480, "sha256": "…", "sourceId": "nasa-bmng-2004", "credit": "<data/sources.json credit>",
  "uAtLon0": 0.5, "lonIncreases": "right", "latitude": "…", "rowsBottomUp": true }
```
Maps: mercury and mars `colour` `normal`; venus, uranus and neptune `colour` (uniform, labelled display models); earth `day` `night` `clouds` `water` `normal`, moon `colour` `normal`, jupiter `colour`, saturn
`colour` `rings`. `path` goes straight to `assets.ktx2()`. Every equirectangular file is 2:1 with a full
mip chain, `u = (uAtLon0 + east longitude / 360) mod 1`, `v = 0.5 + latitude / 180` (v = 0 south), rows
stored bottom-up (`KTXorientation` "ru"), so use the textures as loaded; wrap S, clamp T. Raw `r8`/`rgba8`
files load as DataTexture with nearest filtering: set linear mip filtering yourself. Normal maps are UASTC
normal mode (`n.xy = texel.ga * 2 - 1`, x east, y north, z out) with relief exaggerated by
`reliefExaggeration`. Jupiter and Saturn use planetographic latitude (sample with the latitude of the
ellipsoid's normal). The ring strip (saturn `rings`, 8192 x 1 RGBA8, `u` from `radiusKm[0]` to
`radiusKm[1]`) has straight alpha (`bodies.saturn.maps.rings.alpha`): rgb is the ring material's own
colour, not multiplied by a, and a its normal opacity, so blend
`mix(background, rgb * light, 1 - (1 - a)^(1/mu))`. `bodies` and `facts` (the Great Red Spot's position
on 2025-12-11; the ring strip's radius span, colour registration, colour model and opacity noise floor)
say the rest. All four tiers are published and served with the site (GitHub Pages, same origin):
the `ultra` tier (8192, about 147 MB for every body's set) lists maps narrower than 8192 at source with
their High file. Only a visitor who chooses Ultra in the explorer's menu fetches it (Auto never does).

### `assets/calligraphy/<id>.json`
```json
{ "id": "kun", "text": "<word, copied from data/quran.json at build time>", "verse": "36:82",
  "wordIndexFromEnd": 2, "font": "Amiri Quran <version>", "fontSha256": "…",
  "atlas": "kun.png", "width": 1024, "height": 512, "pxRange": 8,
  "aspect": 2.0, "bounds": { "left": 0, "bottom": 0, "right": 1, "top": 1 },
  "type": "msdf" | "mtsdf", "flipY": false }
```
`bounds` = normalised glyph-ink box inside the atlas (0..1, origin bottom-left). A quad of
size `aspect × 1` world units shows the word. `pxRange` is the distance range in atlas pixels.

### `assets/cmb/cmb.json`
```json
{ "width": 4096, "height": 2048, "files": { "4096": "cmb-4096.ktx2", "2048": "cmb-2048.ktx2" },
  "projection": "equirectangular", "frame": "galactic",
  "uAtLon0": 0.5, "lonIncreases": "left",
  "column": "I_STOKES_INP", "unit": "uK_CMB", "range": [-300, 300],
  "colormap": { "name": "planck", "stops": [[0.0, "#0000ff"], … [1.0, "#640000"]] },
  "smoothingFwhmArcmin": 5, "colorSpace": "srgb",
  "credit": "ESA and the Planck Collaboration",
  "source": { "file": "COM_CMB_IQU-smica_2048_R3.00_full.fits", "sha256": "…", "release": "PR3 (2018)", "url": "…" } }
```
The texture is colour-mapped (sRGB). Sphere UV: u from galactic longitude per `uAtLon0`/`lonIncreases`,
v = 0 at south galactic pole … 1 at north (after `flipY` handling by the loader; document it).

## Chapter scale and scene events

Scene cues (`{type:'scene', event}`) are the hand-off between content timing and the scene.
Names are fixed; times live in content.json.

| Chapter | Scale | Events (in order) | Notes |
|---|---|---|---|
| ch00 | calligraphy quad ~4 units wide at origin; camera on +z, ~6–9 units away | `kun-reveal`, `kun-hold`, `kun-fade` | Opens in total darkness and silence for several seconds. Reveal is a slow ≥ 4 s fade of light. |
| ch01 | point at origin; endless comoving dust around the camera | `ignite`, `expand`, `cool` | Point of light grows softly (no flash); as it envelops the viewer the shared plasma medium condenses (deep-orange embers that warm to gold), its pattern fixed in comoving space so it grows as space stretches; it thickens into Chapter 2's opening state, and the final camera key equals Chapter 2's first. |
| ch02 | camera starts at (0, 0, 0.6) inside the same plasma; CMB sphere radius 10 at origin | `plasma`, `recombination`, `cmb-reveal`, `cmb-hold` | Photons random-walk in the plasma and stream free at recombination (nearest first), then redden and fade; the real Planck sky appears around the viewer (inside view, as seen from Earth) and the camera draws back out through the shell to see it whole (outside view, mirrored as a celestial globe is). Fog is never captioned "smoke". |
| ch03 | periodic box 48 units at origin (the web's region is a soft sphere); camera inside, drawing back to ~50 | `dark`, `web`, `stars`, `galaxies` | Dark matter in false colour grows into a web by the Zel'dovich approximation (one FFT-built 3D field moves every particle and star); first stars swell softly in the densest knots, highest peaks first, never a flash. |
| ch04 | comoving field radius 40 around the camera; scale factor stretches it | `galaxies`, `stretch`, `redshift`, `tension` | Space stretches with no centre: galaxies recede and redden with distance from wherever the camera is. The panel's slider (`app.interact('stretch', a)`) takes over the scale factor; `null` returns it to the film. |
| ch05 | resized world: 5 kpc per unit (our galaxy) to 800 Mpc per unit (the survey) and on to the observable universe; camera ~6–12 units out | `milky-way`, `pull-back`, `survey` | An artist's model of the Milky Way (tagged as such) gives way, by a logarithmic pull-back, to the real SDSS galaxies at their measured positions, coloured by measured redshift; the equatorial slice brightens to show the web (Sloan Great Wall tagged); the HUD scale bar is true throughout. Reduced motion: the pull-back is a dissolve. No layers or "seven heavens" are depicted. |
| ch06 | massive star radius 4 at origin; Type Ia pair at (24, 1.5, -6) | `star`, `collapse`, `white-dwarf`, `type-ia` | A cutaway star banded by element (schematic, tagged "not to scale"); core collapse, shock and neutrinos; element-coloured debris with tags that fade before the verse; then a white dwarf and companion, and a Type Ia whose light fades with the nickel-56 decay chain. Each brightening is one eased swell, with an exposure dip. |

The `cmb-legend` overlay cue (`{type:'overlay', id:'cmb-legend', visible}`) shows the DOM colour
scale + credit while the map is visible. The `bbn-abundances` figure lives in the ch02 science layer.
ch04 shows `hubble-tension` (overlay and science layer) and the `expansion` slider; ch06 shows
`decay-chain` (overlay and science layer); ch10 shows `cosmic-futures` (overlay and science layer).

| ch07 | protoplanetary disk radius ~8.6; orrery with sqrt-compressed orbits (Neptune ~6.9); Sun radius 0.32 | `disk`, `ignite`, `clear`, `orrery`, `moon`, `galaxy` | Disk with gaps and protoplanets; the Sun ignites (eased); planets on their real orbits for today from JPL elements, engraved astrolabe rings; a long-lens Moon showing its real phase (JPL Horizons); then a log pull-back to the Milky Way model and the Sun's path. Labelled not to scale. `app.interact('discovery', 1/null)` dims (eased, through `ctx.exposure`) and slows the scene for the letter analysis, which also holds the film clock with `app.holdFilm('discovery')` while it is open. |
| ch08 | Earth radius 1 at origin; Moon (radius 0.27) at 3.4 | `molten`, `impact`, `moon`, `oceans`, `continents` | One planet shader through molten rock, steam, oceans and drifting continents; a glancing impact (eased glow, exposure dip), debris ring gathering into the Moon. |
| ch09 | micro: 1 unit = 10 micrometres; planet: Earth radius 1 | `ocean`, `rise`, `oxygen`, `green` | Underwater light shafts, caustics and illustrative single cells; a soft dissolve up to orbit; seas and sky shift as oxygen rises; land greens. Ends before humans. |
| ch10 | galaxy field radius 40; calligraphy quad at y 1.25 | `cosmos`, `heat-death`, `big-rip`, `big-crunch`, `still`, `fold`, `light`, `calligraphy`, `silence` | Three labelled hypotheses; calm verses; a labelled artistic fold; calm light and the 21:104 calligraphy (MSDF, `kama-badana`); silence; end credits follow. |

**HUD.** A chapter may implement `labels()` (scene-anchored tags: `SceneLabel` with a world position,
an eased opacity and an optional `offset` in CSS pixels that turns the tag into a callout with a
leader line) and `scale()` (`metresPerUnit` and the camera distance it applies at, or null when the
picture is schematic). `app.hud()` projects them each frame; `src/ui/hud.ts` draws the tags
(decorative, `aria-hidden`: the panel carries the same facts) and a round-number scale bar.

**Continuity.** A registry entry may declare `continuesFrom` (src/chapters/index.ts): when it follows
that chapter in sequence play, the engine swaps chapters without fading to black (the previous one
stays lit, frozen at its last moment, until the next starts in the same frame). The previous chapter
must end exactly in the next one's opening state. ch02 continues ch01.

**Shared visual modules** (src/chapters/shared): `plasma-medium.ts` (the volumetric plasma: comoving
scale, coverage, heat; dimmer always means redder, never a plain dimmer), `streaks.ts` (instanced
screen-space light streaks, one draw call, vertex-stage motion on both backends), `noise-volume.ts`,
the MSDF calligraphy (`msdf-*`; the glow field's alpha carries precomputed light rays), and
`galaxy-sprites.ts` (one draw call of galaxies as tiny elliptical discs; comoving positions times a
scale factor; reddening from distance to the camera or from each galaxy's measured redshift; optional
redshift bands and a slice emphasis).

**M3 shared modules.** `blackbody.ts` (star colours from temperature, Kang et al. 2002 fits to the
Planckian locus), `sun.ts` (a living star: granulation, limb darkening and limb reddening, corona),
`planet.ts` (the Earth across its history from one `EarthEpoch`, and simple sunlit bodies),
`starfield.ts` (distant stars at infinity).

**Letter analysis.** `panel.discovery` names an asset in `public/assets/analysis/` built by
`scripts/build-analysis.ts` from data/quran.json and the `analysis` entries of data/citations.json; the
validator re-derives it. The UI (src/ui/discovery.ts) shows letters from their code points only.

**Film.** film/screenplay.md and film/shotlist.json describe the whole film shot by shot; each chapter's
shots tile its timeline.

**SDSS sample.** `assets/sdss/galaxies.bin` holds int16 (x, y, z, redshift) per galaxy in the galactic
frame (+x toward the Galactic centre, +y the north galactic pole), units in galaxies.json (`scaleMpc`,
`redshiftScale`); any prefix is a fair random subsample, so lower tiers draw a prefix. Below
`nearLimit` every galaxy is kept; beyond it a one-in-nine subsample (brightness is evened per part).

**CMB texture.** `assets/cmb/cmb-temperature-2048.ktx2` holds the temperature itself (R8, lossless
zstd, mip chain, rows bottom-up, ±300 µK → 0..255); the scene colours it through a half-float lookup
table built from cmb.json's stops (ACES-compensated). Texture coordinates come from the direction per
pixel with seam-safe gradients (no seam line, no pole pinch).

## Constant ids the UI relies on (content builder must create them)

`universe.age`, `cmb.temperature`, `recombination.redshift`, `recombination.age`,
`recombination.temperature`, `bbn.hydrogen.massFraction`, `bbn.helium.massFraction`,
`bbn.helium.numberFraction`, `bbn.deuterium.ratio`, `bbn.lithium7.ratio`.

## i18n

- ICU MessageFormat via `intl-messageformat`, flat dotted keys.
- `src/i18n/en.json` (ui builder): `ui.*`, `timeline.chNN.{title,stop,epoch}` for ALL 11 chapters,
  `ui.disclaimer` = the spec's disclaimer, verbatim.
- `src/i18n/en.chapters.json` (content builder): `ch00.*` to `ch10.*`.
- `createI18n(locale)` in `src/i18n/index.ts` merges both and throws on a duplicate key.
- Honorifics per spec §1.5. Hadith summaries (if any) are labelled as summaries, never quotes.

## Module entry points

- `src/main.ts` (engine): mounts the UI **first** (instant first visual), then initialises the
  renderer. `createApp(options)` in `src/core/app.ts` returns `App` (types.ts).
- `src/ui/index.ts` (ui): `export function mountUI(app: App, root: HTMLElement): void`.
- `src/i18n/index.ts` (ui): `export function createI18n(locale: 'en' | 'ar'): Promise<I18n>`.
- `src/chapters/chNN/scene.ts`: `export default function create(): ChapterModule` and imports
  its own `./content.json`.

## URL parameters and routes

- Routes (hash): `#/` home, `#/ch/<n>?t=<seconds>` chapter deep link, `#/sources`,
  `#/universe[/<body>][?jd=<Julian date>]` the solar-system explorer (`body` one of sun, earth,
  moon, jupiter, saturn; an unknown body opens the default view; `jd` is UTC and wins over the
  `?jd=` query parameter), `#/universe/lab` the orbital laboratory (`Route.universe.lab`). One
  parser (`src/core/router.ts`) serves the engine and the UI.
- Query: `?forceWebGL=1`, `?tier=high|mid|low`, `?reducedMotion=1|0`, `?autoplay=1`
  (skip the intro overlay and start playing), `?fps=1` (show a small fps readout), `?profile=1`
  (GPU timestamp queries where supported: `frameStats()` then reports `gpuMedianMs`/`gpuP95Ms`;
  holds the render scale at 1), `?gpuTime=1` (the same timestamp queries without holding anything
  still: the explorer's governor then judges GPU time), `?jd=<Julian date>` (pins "now" for astronomy views; plain decimals
  from 1 CE to 9999 CE, anything else is ignored; the explorer reads it as UTC),
  `?detail=ultra|high|medium|low` (fixes the explorer's detail tier and holds its governor still;
  `?tier=` fixes it too, mapped high→high, mid→medium, low→low; Ultra only where the device allows it).
- Dynamic resolution: unless `?tier` or `?profile` is set, the engine lowers the render scale in small
  steps (down to 0.6× the tier's DPR cap) when frames run slow, before the tier governor drops a tier,
  and probes back up after long comfortable stretches. Frames over 0.25 s (stalls) are ignored, a tier
  change holds the render scale for 3 s, and both governors judge frames against the display's cadence:
  a rAF that has never run faster than 30 Hz (Low Power Mode, battery savers) targets 30 fps, anything
  else 60 fps. A software-only WebGPU adapter (e.g. SwiftShader
  on GPU-less CI) is treated as unavailable: WebGL2 is used instead.

## Explore Mode's dock (content.json `explore`)

- `explore.points[]`: `{ id, t, titleKey, kind: 'measured' | 'model' | 'illustration', text: ProseBlock }`. Visiting one calls `app.setExploreTime(t)` (the scene's model time; the film's clock stays) and `app.focusView(t)` (the free camera eases to the film's camera pose at t; instantly with reduced motion). The card's text is a prose block: values from data/constants.json, `cite` source ids.
- `explore.process`: `{ from, to, titleKey, startKey, endKey }`, a slider over model time.
- `explore.extras[]`: closer looks the dock knows how to build (`terms`, `expansion-model`, `cmb`, `stretch`, `supernovae`, `orbits`, `earth`, `water`, `futures`).
- `app.exploreTime` is the model time or null; it clears when Explore Mode ends or the chapter changes. Strings: `src/i18n/en.discover.json` (loaded with the dock). Rule h checks the times lie inside the chapter; rules c, e and g check the cards like the notes' prose.

## Test hooks (engine sets these on `<html>`)

- `data-backend="webgpu|webgl2"`, `data-tier`, `data-state` (TimelineState), `data-chapter`,
  `data-ready="true"` after the first rendered frame, `data-chapter-ready="chNN"` after a
  chapter is entered and has rendered a frame, `data-reduced-motion="true|false"`,
  `data-experience="film|universe"` (set as soon as a switch starts), `data-universe-ready="true"`
  once the explorer has rendered a frame after loading (removed while it is not on screen),
  `data-travel="flying|arrived|stopped"` (the explorer's trips; removed when it leaves),
  `data-detail="ultra|high|medium|low"` (the explorer's detail tier running; removed when it leaves),
  and `data-universe-prefetched="true"` (the explorer's code fetched ahead of a visit by a chapter
  that offers it, 1.5 s after the chapter is ready; only the code, never its maps).
- `window.__kf = { app, frameStats(): { frames, seconds, medianFps, onePercentLowFps, p99FrameMs, memory: { geometries, textures }, experience }, resetFrameStats(), step(frames = 1, dt = 1/60), universe: { state(), place(pose) }, filmSound: { state(): { chapter, level, voices, duck, shots } | null, render(chapter, content, from, to): Promise<{ rms[], peak[] }> } }` (filmSound is added by the interface, src/ui/film-sound.ts).
  `universe.state()` is the explorer's `UniverseView` (focus, travelling and the body a flight left,
  whether the camera moved this frame, distance and altitude in km, sunlight, date) or null;
  `universe.place({ body, distanceKm, azimuthDeg?, elevationDeg?, from? })` puts its camera at once,
  with the exposure adapted at once too (tests and frame captures).
  `step` advances `frames` frames of `dt` seconds (0 < dt ≤ 0.1) and renders. Its first call switches the
  page to a manual clock for good: frames keep rendering, but the film, fades and exposure move only
  through `step`, and the tier and render scale stop adapting (navigation that waits for a fade needs steps too).

## UI test ids (ui builder)

`intro`, `begin`, `disclaimer`, `panel`, `panel-toggle`, `layer-text`, `layer-scholarly`,
`layer-science`, `timeline`, `stop-chNN`, `play-pause`, `mode-toggle`, `verse-overlay`,
`sources-page`, `cmb-legend`, `loading`, `error`, `discovery` (the Chapter 7 letter analysis),
`film-held` (the transport's status line while `app.holdFilm` holds the film), `open-universe`
(the ways into the explorer: the welcome screen, and Chapters 7 to 10's outro and free-look hint),
`universe` (the explorer's interface), `universe-bodies` (the navigator), `universe-back`,
`universe-readout`, `universe-nav-toggle` (folds and unfolds the navigator), `universe-detail` and
`universe-detail-<auto|ultra|high|medium|low>` (the detail menu and its choices), `universe-trip`
(the trip indicator), `universe-stop`, `universe-orbit` (stop a trip; orbit again from free
flight), `universe-note` (the note about what is near), `universe-seen` (the log of what was seen).

## Solar-system explorer (Stages 3 and 4)

A second experience beside the film, loaded on demand (`src/explore/**` and `src/ui/explore/**`
are their own chunks; `scripts/check-bundle.ts` holds them to 150 KB gzipped and out of the shell).

- **Host.** `ExperienceModule` (types.ts) is the chapter lifecycle without content or cues;
  `UniverseModule` adds `configure`, `focus`, `view`, `setInsets` and `place`, and is built with a
  `UniverseContext` whose `exposure` adds `setVeil` and `jump`. `src/core/universe-host.ts` runs
  the navigation sequence for it (shared navigation token, governor suspended, the film stopped
  and faded to black, dynamic import, `compileAsync` warm-up with frustum culling off so every body
  compiles, governors held off) and the reverse on leaving, then restores the chapters' lens. The
  picture comes up and goes down through a veil (2.2 s in, 0.9 s out, eased) that multiplies the
  exposure after its limiter, while the exposure itself jumps to its target under it: the explorer's
  light spans seven stops, more than the slew limit crosses quickly. `Engine.frame` updates either
  the explorer or the timeline, never both; `app.hud()` reads whichever is on screen. The explorer
  is kept after its first visit. `app.openUniverse(body?)`, `app.closeUniverse()` (back to the
  chapter and time it was opened from, paused if it was; home after a deep link: a step back in
  the history when the explorer's entry sits on one of ours, else its entry is replaced, so leaving
  never stacks entries) and `app.focusBody(body)`; Esc in the explorer is `closeUniverse`.
  `app.setViewInsets({ top, bottom })` (CSS px the interface covers) lets the explorer frame bodies
  in the clear part of the view. An explorer that cannot load shows `ui.error.universe` and returns
  the visitor the same way, replacing its address in the history (as a chapter that fails to load
  does). Chapters 7 to 10 (registry `opensUniverse`) offer it; earlier eras came before the Sun.
  They fetch its code 1.5 s after they are ready (`universeHost.prefetch()`: the code only, nothing
  built or fetched besides), so the way in waits only on its warm-up. From Chapter 7, with no body or
  date asked for (`UniverseOpenOptions.stretch`), the explorer opens on the film's compressed system
  (Chapter 7's square-root distances and enlarged sizes, every world lit alike, seen from 2.35 x
  Neptune's compressed orbit (the stretch unit still anchored to Saturn), 32 degrees above the ecliptic) and stretches it out to true distances, sizes and
  sunlight over 6.5 s after a 2.6 s hold (`src/explore/stretch.ts`, log-space blends, eased), then
  flies on to the Earth unless the visitor has steered; a trip asked for meanwhile finishes it in
  0.9 s. The readout says it is not to scale until it is (`UniverseView.trueScale` < 1), then
  announces true scale; notes wait until then; the enlarged Sun keeps the filtered brightness
  without glare until it shrinks. Under reduced motion it opens at true scale at once.
  Keyboard focus moves into the explorer's region when it opens and back to the transport (or the
  welcome screen's way in) when it closes.
- **Space.** State is float64 km from the barycentre in the render frame (ecliptic J2000 turned
  so ecliptic north is +y; the Sun's offset from the barycentre is not modelled yet). Each frame
  the camera sits at the origin and every object at `body - camera` (`space/origin.ts`); near is
  0.4 x the altitude above the nearest surface, Saturn's rings counting as one (1 m to 1e5 km),
  and far 2e4 x near (`space/lens.ts`, standard 24-bit depth, no renderer flags); bodies beyond half
  the far plane are drawn nearer and smaller by one factor between 0.5 and 0.95 of it, exactly at
  their angular size (`space/scaled-space.ts`); the starfield sits at 0.98 x far with depth testing.
- **Navigation.** A body is framed to a share of the narrower side of the clear view (a phone held
  upright frames it by its width; a side panel or sheet is left out of it) and first seen from its
  sunlit side turned about 50 degrees, Jupiter from near its equator, Saturn from the side of its
  rings the Sun lights. A trip (`src/explore/travel.ts`) leaves its body and closes in on the
  destination in log distance (its distance to the destination only falls, never below where it
  arrives), on an arc out of the planets' plane and clear of the Sun and of any body on the way,
  rounding the body it leaves when it starts on its far side; it eases in and out, lasts 2.5 s plus
  0.9 s per factor of ten in distance (2.5 to 9 s), hurries through the stretch where both ends are
  only points, pulls back from the world it leaves for its first tenth, has its gaze on the
  destination after its first third, banks a little into turns and widens the lens a touch at
  speed; with reduced motion it is a cut under the veil, the exposure jumping to the new body while
  the picture is dim, with neither bank nor lens. Esc stops a trip (the camera coasts to rest in free
  flight; a reduced-motion cut not yet made is called off, the light easing back where the visitor
  was, and one already made finishes) or folds a pulled-up navigator sheet; with neither to do, Esc
  goes back to the film. On foot (or going down through an atmosphere) Esc is the walk's from the
  moment one is asked for until a second after the climb back to orbit ends, each press within it
  holding it a second longer, and a held Esc's repeats go nowhere: Esc never leaves the explorer from
  the ground. Esc during that climb stops it where it is; a walk waiting for a trip is dropped with
  the trip. Entering, the camera pushes in on the first world from 2.4 times its framing
  distance over 5.5 s (it fills much of the view from the first frame; none with reduced motion), and
  the hint waits until the camera has settled.
- **Flight** (`src/explore/flight.ts`, `src/explore/input.ts`). Exact critically damped springs on
  the orbit's angles, its log height above the surface and its pan, and on free flight's turn
  rates; the lens is a spring too. Orbit: drag (one finger) turns round the focus (gently when low),
  wheel or pinch zooms in log height, right/middle/Shift drag or two fingers pan, a double click or
  tap on a body travels there. Free flight (W A S D, R F up and down, Q E roll, Shift five times
  faster, arrows look): speed is proportional to the height above the nearest surface, the camera
  rides along with the body it is near, never enters one nor rises past the orbit rig's ceiling
  (50 au above the nearest surface), says "holding still" at rest (speeds under 1 km/s in m/s), and
  O (or the readout's button) orbits again with the gaze easing round. `touch-action: none` is set
  on the canvas only while the explorer is on screen and restored after.
- **Detail** (`src/explore/detail.ts` presets, `src/explore/quality.ts` governor). The explorer
  starts on a rung from what the device says (phone Low, or Medium for an Apple GPU on WebGPU;
  software Low; hidden adapter, WebGL2 or an integrated GPU Medium; else High; Ultra only by choice,
  on non-software, non-mobile WebGPU with 8192 px textures). Its governor judges half-second
  buckets by their mean, each frame counted at most two display intervals, so a vsync-paced display
  that drops one frame in three (45 fps) reads as slow while one hitch decides nothing. The shipped
  page judges frame time against the display's rate the engine learned; GPU time only where timestamp
  queries run (`?gpuTime=1`; `?profile=1` measures too but holds the governor still). It ignores
  stalls over 0.25 s and the 2 s after a tier change or a texture upload, lowers the scene pass's
  internal resolution (`PostPipeline.setSceneScale`) to the rung's `minRenderScale` before dropping
  a rung, tries the rung above after 20 s stable (never Ultra), backs off 20 s (doubling) after a
  failed try and stops trying a rung after three failures in a visit; a phone slowing after a long
  steady spell is read as heat and not tried upward for 3 minutes. A visitor's choice (the navigator's detail menu,
  remembered in localStorage `kf.ui.exploreDetail`) is kept: then only the resolution adapts. In the
  menu (headed, with a close control and a line per level on what it draws, read from the presets)
  the arrow keys only select; a click or tap, Enter or Space applies the selection and closes it,
  leaving it with the selection moved applies it, Esc puts it back; an applied level is named in a
  toast with what it draws. The
  explorer's pixel-ratio cap and bloom follow the rung while it is on screen; the host gives the film
  its own back when it leaves (`UniverseHostDeps.claimPicture`/`restorePicture`), and the film's
  governors rest while the explorer runs.
- **Navigator and notes** (`src/ui/explore`). Every body with a live portrait (phase and lit side
  as the camera sees it, never black: a dim night side and a faint rim), its distance (to the
  surface, km up to 0.1 au, never broken from its unit) and the light-time of that same distance, an
  orrery to fly by (directions true for the date, distances compressed), the log of what was seen
  (its summary says how many entries it holds, with no total, score or achievement; each new entry
  gets a quiet toast, a polite live region) and the detail menu; a side panel on wide screens (the
  menu opening beside it), a bottom sheet on phones (ten portraits in two rows when folded; the list first, the log, then the orrery as a
  small strip, none held sideways; sized to what it holds; held sideways,
  pulled up at the right, the world framed beside it). Its body fades at whichever edge it scrolls
  on (`has-above`, `has-more`), never cutting a line in half. Folded, only the portraits stay, in an
  experiment its worlds and among the stars none: the laboratory's and the stars' panels fold away
  with every section and come back as they were; the folded rail never runs past the window's foot
  (a short window scrolls it). Entering the laboratory or the stars brings their panel into view
  from its top. The sections read only when opened (About, the sky, saved views: one chunk,
  `src/ui/explore/sections.ts`; the Living Earth; the qibla) and the laboratory's and the stars'
  panels are chunks of their own (`src/ui/explore/lazy.ts`): each loads once however often it is
  asked for on the way, with a line while it comes (`part-waiting`) and, if its code does not
  arrive, a status saying so with `part-retry` (and in the laboratory `lab-leave`, among the stars
  `stars-leave`); nothing is thrown. Their styles travel in their code, so a part that comes on a
  second try is styled as on the first. A "?" whose explanation does not load says so in the toast,
  and its next press tries again. The world in view is marked `aria-current`.
  Every control is at least 44 px each way on touch. A note and the trip indicator share the top of
  the view (the same width) and never show at once: a trip takes the note out first, and a note comes
  back only after the indicator has gone. A note's title folds it; on a phone it folds by itself after
  6.5 s or at a touch on the scene. Names beside the bodies stay inside the clear view (at a body's
  left when its right has no room; a body just out of frame gets a pointer at the edge), each choice
  holding until the body is clearly past the line, and a name that gives way to another fades
  quickly while one coming in waits until nothing still shows where it goes (no ghosting); they come
  up with the picture, never over a black screen. Inside the clear view they keep off what stands
  over it (the way back; on a wide screen the readout's card), which the interface reports on the
  window as `kf-universe-avoid`: a pointer at the edge slides along the edge past it, a tag gives way.
  A pointer's tag is inside the clear view whole, not only its point (it hangs toward the clear
  view's middle; where there is no room for one, above a phone's sheet held sideways, it gives way).
  The laboratory's names take part (`SceneLabel.rank`: the larger first): none behind a world's disc
  or outside the clear view, each trying the four corners about its body, and two never show over
  each other; the chosen body's name and its marks (burn directions, Lagrange points, encounters: no
  rank) keep those rules too, but come first: the others and the worlds' names give way to them. Notes near a body give numbers derived
  from cited data only (`src/explore/discoveries.ts`: IAU rotation rates, JPL elements, the Cassini
  ring profile, and `light.speed`, `earth.atmosphere.scaleHeight`, `sun.effectiveTemperature` in
  data/constants.json). Exploration shows no scripture.
- **Truth and honesty.** Positions, radii, flattening, poles and spin come from
  `public/assets/jpl` through `src/astro`; the date is now (or `?jd=`), clamped to the Moon
  table's span. Saturn's rings are drawn from the Cassini radio-occultation profile
  (`physical.json` `saturnRings.profile`: mean normal transmission in 2,048 bins, built by
  `scripts/jpl/build.py`) until the Cassini ring strip (`assets/planets`) arrives. Surfaces are the
  mission maps of `assets/planets/planets.json`; the readout names their imagery (an "Imagery:" line
  with the focus's credits, and the Earth's caption: a composite of several epochs) and says the
  Sun's surface detail is illustrative, along with "True scale: real sizes and distances". The film's
  metres-per-pixel bar is replaced by a readout of true distances.
- **Light.** Sunlight on a body falls as 1/r^2; the exposure adapts to the body in view as
  r^1.8 (so the outer planets stay a little dimmer), through `ctx.exposure` like every change
  (slew-limited: flash-safe); bloom is judged at that exposure (`PostPipeline.setBloomExposure`;
  the film keeps 1). Guides (orbit lines, points and ring markers of bodies under a few px, the Sun's
  glare) keep their brightness on screen; the Sun's disc is brilliant white when small and, as it
  fills the view, shown as through a solar filter (amber, limb-darkened, mottled), which the readout
  says. The engine's exposure cap is 1024 (chapters ask for 1 or less).
- **Bodies and detail.** The explorer draws its bodies with its own shaders (`src/explore/bodies`),
  never the chapters': the Earth from Blue Marble (day), Black Marble (city lights, night side only:
  today's Earth only), ETOPO relief and Natural Earth's water mask (an ocean-only glint), clouds on
  their own drifting shell that shade the ground, and Bruneton's reference atmosphere
  (`src/explore/render/air.ts`, constants in `data/constants.json`): single scattering through a
  transmittance table baked once by a quad pass ('scatter'), or an analytic chord ('chord'); the Moon
  from LROC colour and LOLA relief, Lommel-Seeliger light with an opposition surge and relief that casts
  shadows near the terminator; Jupiter and Saturn from OPAL with Minnaert limbs (Jupiter's bands drift
  in a two-phase flow, schematic speeds); Saturn's rings from the strip, lit by their own normal,
  shadows both ways, and at close range a field of particles; a filtered Sun (limb darkening from
  `data/constants.json`) with, at 'full' detail, a chromosphere, prominences and a corona, and a
  radiance ceiling. Detail follows `src/explore/detail.ts`: the rung (`UniverseModule.setDetail`, one
  call site `bodies.setDetail(detail)`) changes materials (compiled ahead), mesh segments, cloud shadows,
  stars and which maps stream; the film's `setQuality` no longer reaches the explorer. Maps stream through `src/explore/assets/streaming.ts`: one-texel
  means first, every body's Low files on entry, the focus (or a flight's destination) raised to
  `textureTier(detail)`, uploads budgeted by bytes (at most `UPLOAD_BYTES_PER_FRAME` a frame, a large
  texture in row bands over several frames) and each texture bound only on a frame after its upload
  finished, each arrival sharpening in from its predecessor's blur, upgrades kept while the tier's
  memory budget has room (the longest-unwanted go first) and dropped on leaving, within that budget. Shading
  edges (terminators, ring and shadow edges, crescents) are softened over one pixel and fine detail
  fades before it is smaller than one; MSAA (the scene pass inherits the renderer's 4 samples) handles
  outlines.
- **Shared modules, optional parameters only** (left out, the chapters' graphs are unchanged):
  `createStarfield(count, radius, seed, { depthTest, dynamicRadius })` with `setRadius`,
  `createStreakField({ ..., profile: 'trail'|'line', tailColor })`.

## Explorer: time machine and photo mode

- **Time machine** (`src/explore/time.ts`, `src/ui/explore/time-control.ts`). The explorer's clock
  runs at `UniverseTime.rate` explorer seconds per real second (negative backwards), stepped along
  `TIME_RATES` (1 to 30 days a second) by `UniverseTimeCommand` (`toggle`, `faster`, `slower`,
  `reverse`, `now`, `date`, `rate`) through `app.universeTime`. Every command is checked at that
  boundary (`validTimeCommand`: a rate or date that is not a finite number is refused, a rate's size
  held to [1, `MAX_RATE`]) and applied by one pure reducer, `applyTimeCommand`, which the laboratory
  shares: faster and slower step to the next rung (never skipping one), and at an end with the rate
  pointing into it play, faster and slower turn the clock round. `advanceClock` keeps it inside the
  span, stopping and pausing at either end (`UniverseTime.edge`); a date outside it stops at its
  nearest end, and the note says so once where the clock went is known. The span is JPL's tables'
  (the Moon's 2026 to 2035) until the chunk beyond the everyday (`src/explore/time-beyond`, with
  `src/astro/analytic`: Meeus's lunar theory, Standish's Table 2, blended into the tables at their
  ends; `installTheories`) arrives a few seconds in or as the clock heads past them or runs fast;
  then 1600-01-01 to 2399-12-31, and `UniverseTime.beyond` says which body comes from a theory (the
  note names it and its accuracy). A date beyond the tables asked for before it arrives waits for it
  (`UniverseTime.pending`, the row saying "Going to …"); offline, it stops at the tables' end and the
  chunk is asked for again 30 s later (or at the next such date), never every frame. During a trip
  (not the arrival's glide) it runs at real time, and on foot or on the way down at most
  `FOOT_MAX_RATE` (an hour a second: flash safety); `UniverseTime.held` says which. Past about 30
  degrees a frame (measured from the clock's own change, so a laboratory's goto counts) a world's turn
  is held at one hour of its day (`UniverseTime.spinHeld`); it is let go once the clock has run on its
  own under 20 degrees a frame for half a second (never while paused or during a trip), and caught up
  the way time runs, at most 8 degrees a frame (with reduced motion, at once). Satellites draw up to
  `SATELLITE_MAX_RATE` (600) and hide a state further than `STALE_MS` from the clock until a fresh
  one arrives; earthquakes draw only within a day of the present. Keys: Space (the page's play key
  pauses it in the explorer; in the row, even on a focused time button), [ and ], \ (also from the
  date field). A control that cannot act is `aria-disabled`, dimmed, and says why in the note
  (`universe-time-note`) when pressed. The controls head the navigator; on a phone's sheet the
  buttons sit above its scrolling part, folded or not, and the help, date and Islamic date under
  the list. A change is announced politely.
- **Photo mode.** `kf-photo` on the root hides the header, the HUD tags and everything in the
  explorer's interface but "Show the interface"; H toggles it and Esc leaves it (before Esc would
  leave the explorer).
- **Object information** (`src/explore/about.ts`, `src/ui/explore/about.ts`). `worldFacts(id)` from
  planets.json (each planet's row of JPL's "Planetary Physical Parameters", kept whole by
  scripts/jpl/build.py, and its elements) and physical.json (`gmKm3S2` from the DE440 header, NAIF's
  radii and rotation): the planets as JPL gives them; the Sun's and the Moon's mass by GM over the
  Earth's GM, gravity GM/R^2, escape speed sqrt(2GM/R). Axial tilts from NAIF's poles at J2000
  with their periodic terms, retrograde rotators from the other pole. The navigator's "About"
  section shows it for the world in view, with its distance now and a comparison to scale.
- **The sky** (`src/explore/sky.ts`, `src/ui/explore/sky-panel.ts`, `public/assets/sky/sky.json` from
  `scripts/sky/build.py`). The Bright Star Catalogue's stars (brightest first; a detail rung draws
  its brightest `starCount`), the IAU's names, and d3-celestial's 88 constellations (Serpens in two
  parts) with figures and boundaries, all J2000; placed by `skyDirection` (ICRF to the ecliptic by
  the obliquity, then to the render frame) on a sphere that moves with the camera, depth-tested
  so the worlds hide what is behind them. `UniverseSkyCommand` shows a layer (`constellations`,
  `names`, `boundaries`, `grid`); `UniverseView.sky` reports them. It replaced the explorer's
  procedural starfield (the chapters keep theirs).
- **Messages.** The explorer's strings live in `src/i18n/en.explore.json`, added to the catalogue by
  its interface (`I18n.extend`) so they never weigh on the shell (the Living Earth's and its field
  notes' own words in `en.living.json`, with its chunk); the validator reads them with en.json and
  en.chapters.json (no key in two files).
- **Layout under stress** (`tests/explore/layout-stress.spec.ts`, helpers in `tests/support/layout.ts`):
  at 1280x800, 1440x900, 2000x1300 and on a touch phone held both ways, every section, panel and mode
  opened and closed in bursts; every control inside the window or its own scroller, nothing wider
  than the window, no control over another, no text cut off, no error logged.
- Roadmap for the rest of SpaceEngine's mechanics: `docs/EXPLORER-MECHANICS.md`.

## Living Earth (explorer)

Zoom-anywhere imagery, live layers and Claude's field notes on the explorer's Earth.

- **Imagery** (`src/explore/earth-tiles`). Tiles stream into toroidal clipmaps: ranks from coarse
  to fine, each an atlas of k x k tiles addressed modulo k, with an index texture of the tiles
  loaded (`clipmap.ts`, `atlas.ts`: GPU textures made from a one-texel stub, tiles copied in with
  `copyExternalImageToTexture` or `texSubImage2D`). The Earth's surface shader samples them at the
  exact ray-sphere point (`sample.ts`) and weighs each rank by footprint, window edge and no-data.
  Two layers: EOX Sentinel-2 cloudless 2016 (WGS84, 256 px, z0 to z13) and NASA GIBS VIIRS NOAA-20
  for the last whole UTC day (EPSG:4326 "250m", 512 px, z0 to z8, plus a fixed z2 globe). The
  cloud shell fades as the zoom passes CLOUDS_FADE. `EarthImageryStats.showing` says which layer is
  on screen; the readout then credits it (EOX's sentence with its link, verbatim from
  `ui.universe.tilesClear`; GIBS with the date).
- **Lens** (`navigation.ts` `LENS`). Below the lowest orbit (150 km over the Earth) zooming narrows
  the field of view to `lensMinDeg` (1.2 degrees; 6 for the day mosaic), the gaze eased straight
  down (the nadir spring), and the view held over its place as the Earth turns. `glideTo` flies a
  great circle with lift; `UniverseView.lens` gives the angle and the ground per CSS pixel.
- **Live layers** (`src/explore/living`). Satellites: CelesTrak's active group (TLE), fetched at
  most once per browser per 6 hours (Cache Storage), falling back to the deploy's snapshot
  (`assets/live/active.tle`, written by the Pages workflow, never committed) and then a stale copy;
  SGP4 (satellite.js's JavaScript modules only) in a worker at 1 Hz, Earth-fixed positions and
  velocities, carried between answers on the GPU; shown only within 3 days of the catalogue's
  fetch. The crewed stations are named plainly (`ui.universe.station.*`). Earthquakes: the USGS
  2.5_day feed every 5 minutes, rings by magnitude and depth, a swell for the past hour (none with
  reduced motion), the strongest labelled on the side facing the camera.
- **Field notes, by Samee** (`src/explore/field-notes`). `bulletin.ts` composes "Today on Earth"
  about once a second from the ephemeris, the station's state and the quakes (the Sun's overhead
  point, the largest places at dawn and dusk within DAWN_BAND_DEG, the station's height and the
  place beneath, sunlit satellites); `data.ts` holds the atlas (23 places) and the 25 prophets with
  the sites their notes name, every coordinate a Wikidata P625 value with its item id;
  `places.ts` loads `public/assets/places/places.json` once for search and "near". The interface
  words everything (`ui.universe.field.*`, `ui.universe.living.*`).
- **Commands and view.** `EarthCommand`: `goto` (lat, lon, viewKm), `imagery` (clear | today),
  `layer` (satellites | quakes, on), `select` (a satellite's index, or null), `markers` (atlas |
  prophets | null: the set named on the ground, eased, facing the camera, MARKER_SPACING_PX apart).
  `UniverseView.living` carries both layers' state, the selected satellite, the station and the
  bulletin.
- **Rules.** Within `MAKKAH_FRAME.radiusKm` of Makkah no flight frames less than
  `MAKKAH_FRAME.minWidthKm` and the lens stops at that width (spec principle 4). The prophets'
  notes say "by tradition", state where traditions differ, mark no place where they differ too
  widely, show only names on the ground, and await a scholar's review (REVIEW.md). Places carry no
  country. The live layers are off until the visitor turns them on.
- **Tests.** Every page's live hosts are answered in the browser (`tests/support/live.ts`: a
  one-pixel tile, five real element sets moved to the test's day, three earthquakes ending now);
  `tests/unit/living-earth.spec.ts` covers the pure parts and `tests/explore/living-earth.spec.ts`
  the panel, tours, layers and the Makkah framing.

## The qibla and the new moon (explorer)

Methods, sources, checks and limits: `docs/ISLAMIC-ASTRONOMY.md`.

- **Modules.** `src/explore/islamic/astronomy.ts` (no DOM, no three.js): `KAABA` (Wikidata Q29466),
  `qiblaBearing`, `qiblaDistanceKm`, `qiblaPath`, `compassPoint`, `gmst`, `sunPlace`, `moonPlace`
  (geocentric, equator of date), `horizontal`, `topocentric`, `newMoons`, `kaabaSuns`, `yallopQ`,
  `yallopZone`, `skyTrack`, `crescentAt`, `GOLDEN_RATIO`, `meridianArcKm`, `goldenLatitude`,
  `meridianRatio`. `hijri.ts`: `hijriDate(unixMs)` (Umm al-Qura through ICU, null without it), used
  by the explorer's view. `heritage.ts`: `HERITAGE` (Wikidata places). `layer.ts`: three instanced
  sprites in the Earth's frame (the qibla's path, the two latitudes, the map's dots), fading over the
  horizon like the earthquake rings. `index.ts` (`createIslamic`, its own lazy chunk): state, the
  map computed `MAP_BUDGET_MS` (4 ms) a frame, the view and labels (`qibla-from`,
  `golden-latitude`, `kaaba-latitude`).
- **App and module.** `app.universeIslamic(command: UniverseIslamicCommand)` (`open`, `qiblaFrom`,
  `qiblaFromBelow`, `qiblaLine`, `golden`, `newMoon` with a step, `evening` 0 to 2 or null);
  `UniverseModule.islamic()`; `UniverseView.islamic: UniverseIslamic | null` (qibla, golden, the
  next four `kaabaSun` moments, `newMoon`, `crescent` with progress, counts per zone and the place
  in view, `marks`); `UniverseTime.hijri`. The first command loads the chunk; commands wait for it.
  Null and hidden in the laboratory.
- **Interface** (`src/ui/explore/islamic-panel.ts`, lazy, in the navigator's `universe-islamic`
  section). Test ids: `islamic-panel`, `islamic-qibla-from`, `islamic-qibla`, `islamic-find`,
  `islamic-find-results`, `islamic-from-below`, `islamic-qibla-line`, `islamic-kaaba-sun`,
  `islamic-sun-go-over`, `islamic-sun-go-opposite`, `islamic-golden`, `islamic-golden-line`,
  `islamic-golden-go`, `islamic-new-moon`, `islamic-moon-age`, `islamic-moon-previous`,
  `islamic-moon-next`, `islamic-evening-0|1|2`, `islamic-map-state`, `islamic-legend`,
  `islamic-here`, `islamic-heritage`, `islamic-heritage-<id>`; the time machine's
  `universe-time-hijri`. Messages: `ui.universe.islamic.*`, `ui.universe.hijri.*`.
- **Budget.** `scripts/check-bundle.ts` holds the section's lazy files to 40,000 bytes gzipped.
- **The Living Earth's Sun.** `living.sun` (the satellites' `SatelliteFrame.sun`, the bulletin's
  point beneath the Sun) is the unit direction from the Earth toward the Sun; it pointed the other
  way until this section's test found it.

## Orbital laboratory (explorer)

The explorer's experiment mode; the full description, scenario schema, limitations and measured
numbers are in `docs/LAB.md`, and the brief's whole ambition in `docs/FEATURE-LEDGER.md`.

- **Separation.** The real explorer's data is never written. `src/explore/lab.ts` (a lazy chunk,
  `createLab`) forks a scenario, runs it in `src/sim/worker.ts`, and during an experiment places the
  ten worlds from its snapshots (`Lab.applyBuiltIns`; their rotation stays the IAU models'), hides
  removed ones, and draws new bodies as impostor dots with labels (`lab-<id>`). Entering puts aside
  the explorer's time, imagery and markers and turns off satellites, earthquakes and discoveries;
  leaving gives them back. Real orbit lines are hidden in an experiment.
- **Engine** (`src/sim`, no DOM, no three.js). `nbody.ts`: state in km, s and GM (km³ s⁻²), direct
  pairwise gravity, KDK leapfrog, swept contacts resolved by `impacts.ts` (Leinhardt and Stewart):
  conservative mergers (mass, momentum, centre of mass; orbital angular momentum into spin; lost
  kinetic energy into `internal`, reported as heat), breakups (`fragment()`: the remnant keeps the
  target's id; `remnant-<step>` and `debris-<step>-<k>` bodies, at most `MAX_DEBRIS`, within
  `MAX_BODIES`) and grazes (`passing` pairs); `ContactEvent` (`merge`, `fragment`, `graze`; its
  `energy`, ½ μ v² at contact, and `crater`, `src/sim/craters.ts`: the final diameter and whether
  complex, on a solid target),
  `primaryOf` (the heavier body with the smallest distance over GM^(1/3)). `engine.ts`: `Engine`
  (scenario, edit log applied at recorded steps, checkpoints, `seek`, `replayFromStart`, `drift`
  since the last intervention), `Prediction` (a copy integrated ahead in slices, with its primary's
  path for drawing), `validateScenario` and `IMPORT_LIMITS`; `ENGINE_VERSION` `kf-nbody-1`,
  `SCHEMA_VERSION` 1. `seed.ts`: `seedSolarSystem` (from the explorer's ephemeris; the Sun in
  `persistentIds`), `seedLaboratory`.
- **Worker protocol** (`src/sim/protocol.ts`). Requests `load`, `run` (signed rate, paused, and
  paused the moment drawn, `landAt`: a negative rate plays the history backwards, exactly, by
  `src/sim/rewind`; a run stops a goto under way), `goto` (a time), `command`,
  `predict` (id, horizon), `seek`, `replay`, `save`; `run` and `goto` carry a `control` count the
  snapshots echo; replies `snapshot` (ids, names, GM, radii,
  positions, velocities, accelerations, step, dt, time owed, timeline, edge (back at the start),
  a goto under way, whether the step budget was spent, drift, requested and achieved rate, failure, collision events
  (with the crater's size, depth and rim, and the contact site in the scenario's frame),
  interventions, checkpoints), `prediction` (path, merger, frame and its path), `saved`, `error`. Every message
  carries the scenario's `generation`; replies from an older one are dropped, and snapshots by
  `seq`. Budgets per 16 ms tick: 8 ms of steps (owed time carried up to 0.25 s), 3 ms of prediction;
  snapshots every 33 ms.
- **App and module.** `app.openLab()` / `app.closeLab()` (history: back returns to the explorer
  exactly as it was), `app.universeLab(command: LabCommand)`; `UniverseModule.lab()`;
  `UniverseView.lab: UniverseLab | null` (seed, elapsed and simulated date, step and dt, requested
  and achieved rate, paused, bodies as `UniverseLabBody` with mass, radius, speeds, primary,
  relative velocity and escape speed, the selection, its prediction, drift, history (each collision's
  crater diameter and depth, and on a world drawn solid its place, planetocentric degrees),
  checkpoints, status; each body's starlight, a star's luminosity, and a solid world's climate:
  its bands, mean and range, ice, liquid water, greenhouse, pressure and gases; the temperature view).
  `Bodies.setClimate(body, bandsK, temperature)` draws a world's climate (its ice always in the
  laboratory, its temperatures on request); `Bodies.setMarks(body, marks)` draws the laboratory's craters
  (`src/explore/bodies/marks.ts`) on the Earth, the Moon, Mercury and Mars; `Lab.marks(body)` gives
  them, placed in each world's own frame at the moment of impact (`SolarSystem.basisAt`). `LabCommand` (masses in kg, velocities relative to a body): `start` (a seed: `solar`,
  `two`, `three`), `select`, `mass`, `velocity`, `addOrbit`, `addState`, `duplicate`, `remove`,
  `horizon`, `seek`, `replay`, `reset`, `save`, `restoreSaved`, `export`, `import`. Following a
  world is the explorer's own focus. The time machine's commands drive the experiment's clock
  through the same reducer: backwards replays its history and stops at the fork (`UniverseTime.edge`
  'start'); `now` and `date` go to that moment (from the fork to `LAB_DATE_SPAN_S` after it;
  `UniverseLab.seekingS`; a run request stops it where it is: Pause there, a rate or Reverse on from
  there); the row's Reset (`universe-time-reset`, added by the laboratory's panel) goes back to the
  fork, paused, as `seek` (only to a whole step, at most the run's or its latest checkpoint's: never
  an endless replay), `replay` and `reset` all leave it paused. The drawn clock
  (`src/explore/lab-clock`) runs at the rate asked for, or at the pace the worker reaches when it
  cannot keep up, never against its direction, the bodies drawn between two snapshots; paused, it
  lands on the run's own latest step (`UniverseLab.t`), which the worker steps on to (`run`
  `landAt`), so an edit is made at the moment drawn. A laboratory of its own (none of the worlds)
  is followed at its star, standing in for the hidden Sun (`UniverseLab.standIn`: the readout gives
  its name and height).
- **Persistence.** IndexedDB database `kf-lab`, store `scenarios`, key `current`; export as
  `kun-fayakun-<name>.json`; import through `validateScenario` (refused with reasons, nothing
  changed).
- **Interface** (`src/ui/explore/lab-panel.ts`, lazy, in the navigator's `labSlot`). Test ids:
  `lab-open` (in the navigator), `lab-panel`, `lab-note`, `lab-clock`, `lab-rates`, `lab-failure`,
  `lab-back`, `lab-bodies`, `lab-body-<id>`, `lab-inspector`, `lab-fact-*`, `lab-mass-input`,
  `lab-mass-apply`, `lab-mass-double`, `lab-mass-halve`, `lab-vel-x|y|z`, `lab-vel-apply`,
  `lab-duplicate`, `lab-remove`, `lab-follow`, `lab-horizon`, `lab-prediction`, `lab-add`,
  `lab-add-name|mass|radius|primary|distance`, `lab-add-orbit`, `lab-add-pos-x|y|z`,
  `lab-add-vel-x|y|z`, `lab-add-state`, `lab-checks`, `lab-history`, `lab-tools`, `lab-save`,
  `lab-restore-saved`, `lab-export`, `lab-import-file`, `lab-status`, `lab-checkpoints`,
  `lab-checkpoint-<step>`, `lab-replay`, `lab-reset`, `lab-preset-solar|two|three`. In an
  experiment the navigator hides About, Living Earth and the rows of removed worlds.
- **Budget.** `scripts/check-bundle.ts` holds the laboratory's lazy files (adapter, panel, worker)
  to 250,000 bytes gzipped, apart from the explorer's 150,000.
- **Messages.** `ui.universe.lab.*` in `src/i18n/en.explore.json`; the validator's "reflection, not
  proof" phrasing rule applies to them too (paths are "integrated ahead", never "predicted").

## On foot (explorer)

The space-suit walk on the Earth (ledger GR-5's first slice). Method, sources and limits:
`docs/WALKING.md`.

- **Modules** (`src/explore/walk/`, its own lazy chunk, loaded with the first walk):
  - `terrain.ts`: `TERRAIN` (with `retryS`, the waits before a failed tile is asked for again),
    `decodeTerrarium`, `despike`, `mercatorPixel`, `zoomFor`, and `createHeights(loader, maxZoom,
    now)`, which has `at`, `read` (without asking), `want`, `stats`, `retry` and `revision(zoom)`.
    `revision(zoom)` counts the tiles returned at that zoom or coarser. Also `terrariumImage(url)`
    and `terrariumLoader(url)`.
  - `png.ts`: `decodePng(bytes)` and `unfilter`: PNG pixels in script (no canvas read-back).
  - `walker.ts`: `WALK` (walking, running and the rover's speeds), `createWalker`, `look`
    (first-person sense), `stepWalker`, `localFrame`, `walkerPose`, `pressureKpa`, `sunElevationDeg`,
    `sunAzimuthDeg`, `solarTimeHours`.
  - `ground.ts`: `GROUND`, `HORIZON`, `VENUS_HAZE`, `MARS_HAZE`, and `createGround(colour, { light,
    seaLevel, surface })`, the clipmap with its horizon maps (its `copy`, the rings again, is what
    the eye's meter draws), and on the Earth the sea as water.
  - `light.ts`: `EXPOSURE`, `METER`, `MARS_DUST`, `VENUS_FILL`, `AIRLESS_FILL`, `NIGHT_SKY`,
    `GROUND_ALBEDO`, `MULTIPLE`, `CLEAR_DAY_AEROSOLS`, `SKY_KNEE`, `SUN_DISC`, `REGOLITH`,
    `HORIZON_MARCH`, `luminance`, `airMass`, `sunThroughAir`, `earthSkyLight`, `marsSunlight`,
    `marsSkyLight`, `venusDay`, `groundIlluminance`, `walkExposure(illuminance, light, seen)`,
    `skyRadiance` (the CPU twin of the sky), `clearDayAir`, `sunDiscTint`, `lunarLambert`,
    `horizonRise`, `skyCompression`.
  - `meter.ts`: `createMeter(ground)`: the eye's meter, the ground in view drawn small and read back
    from the GPU without waiting (its `luminance`, `readings`).
  - `scatter.ts`: `scatter(air, table, eye, ray, sun, steps, limit)`, the Earth's air along a ray
    (TSL), for the sky and the ground's aerial perspective.
  - `sky.ts`: `createWalkSky(kind, air)`, `heldUnderBloom`, `MARS_SKY`, `VENUS_SKY`.
  - `daylight.ts`: `DAYLIGHT`, `starlight`.
  - `index.ts`: `createWalk(setup)`, which returns `start`, `stop`, `where`, `starlight`, `look`,
    `step`, `place`, `view`, `exposure`, `sunColour`, `setDetail`, `retry` and `dispose`.
- **App, module and view.** `app.earthCommand` takes five walk commands:
  - `{ kind: 'walk', world?, lat?, lon?, headingDeg?, pitchDeg? }`: at the place, or at the point
    below the view (during a trip it waits for the arrival);
  - `{ kind: 'walkEnd' }`;
  - `{ kind: 'walkPad', forward, right?, run?, rover?, jump }`: the on-screen pad (values that are
    not numbers count as 0);
  - `{ kind: 'walkLook', scene }`: the look's sense on foot (a drag moves the scene with it when
    true; the default turns the view the way the hand moves);
  - `{ kind: 'walkRetry' }`: ask again at once for heights that could not be loaded.

  `UniverseView.walk` is a `UniverseWalk` or null. It holds the state (`landing`, `walking`, or
  `unavailable` when no heights for the place have come after 15 s), `coarse` (landed on coarser
  heights than asked for), the place, the ground's height and the feet's, the heading and pitch,
  `airborne`, `blocked`, `walkedM`, `gravity`, `pressureKpa`, `meanTempC`, `sunElevationDeg`,
  `sunAzimuthDeg`, `solarTimeH`, `groundZoom`, the tiles, the rings filled, the eye's meter's
  readings (`metered`) and its last (`groundLuminance`), the field of view (`fovDeg`), and whether
  the time machine is held down on foot (`timeCapped`). `UniverseView.walkRefused` says a walk was
  refused at Makkah; `UniverseView.walkWaiting` that one asked for waits (for a trip's arrival, or
  its code). While walking the explorer's exposure is the walk's (`exposure()`), the Sun's disc and
  glare take its colour (`sunColour`), the camera is not turned to frame the clear part of the view
  (the horizon stays level), the worlds' names show only as the stars come out (never the Sun's),
  and the time machine runs at most an hour a second (on the way down through an atmosphere too).
  The input's `onFoot` is what is shown, not what is asked for: `'ground'` once the walker's eye is
  the camera (Space jumps; a mouse's click takes the pointer), `'air'` on the way down (a click takes
  the pointer; Space stays the play key), null while landing waits in orbit.
- **Constants used:**
  - `earth.atmosphere.surfacePressure` (101.4 kPa);
  - `earth.atmosphere.scaleHeight`;
  - `earth.atmosphere.averageTemperature` (15 °C);
  - gravity from the Earth's GM (DE440) at the mean of `physical.bodies.Earth.radiiKm`.
- **Interface:**
  - `src/ui/explore/walk-hud.ts`, loaded with the first walk (or refusal). Test ids: `walk-hud`,
    `walk-title`, `walk-brief`, `walk-place`, `walk-ground`, `walk-gravity`, `walk-air`, `walk-sun`,
    `walk-qibla`, `walk-notice`, `walk-help`, `walk-forward`, `walk-backward`, `walk-left`,
    `walk-right`, `walk-run` and `walk-rover` (`aria-pressed`), `walk-jump`, `walk-drag-scene` (the
    look's sense, kept in localStorage as `kf-walk-drag-scene`), `walk-end` (with
    `aria-keyshortcuts` Escape) and `walk-retry` (only while the heights could not be loaded).
  - The Living Earth panel's `living-walk` button.
  - The explorer section gets `is-on-foot` while a walk is asked for (waiting included), landing or under way (the way
    back to orbit stands in for `universe-back`, which waits), and `is-walking` once landed, which
    hides the readout from orbit, the notes and the hint on every screen. Landing folds the
    navigator (it opens again after, if it was open); the notes say nothing on foot.
  - Messages: `ui.universe.walk.*`.
- **Rules:**
  - No walk begins within `MAKKAH_FRAME.radiusKm` (25 km) of the Kaaba, and no step enters it.
  - The field of view on foot (70°, the wheel or a pinch narrowing it to 20° or widening it to 90°)
    never narrows there below `MAKKAH_FRAME.minWidthKm` (30 km) across.
  - A trip (`nav.travelling`) ends a walk; a walk asked for during a trip goes where the trip goes
    (dropped if the trip turns elsewhere, is stopped, or ends at another world).
- **Budget.** `scripts/check-bundle.ts` holds walking's lazy files (the suit's readout included) to
  30,000 bytes gzipped.
- **Tests** (mocked terrain): `tests/support/live.ts` serves `tests/support/terrain-1000m.png`, flat
  at `MOCK_GROUND_M` (1,000 m), for every terrain tile; `tests/support/terrain.ts` makes PNGs and,
  per tile, terrarium tiles of any height field over the world (`routeTerrain`: a cliff, a hill, the
  sea), the same at every zoom.

## More worlds (explorer)

- **Chunk.** `src/explore/worlds/` (its own chunk, `scripts/check-bundle.ts` WORLDS_SOURCES, 30,000 B
  with `src/ui/explore/worlds-panel.ts` and `src/i18n/en.worlds.json`), asked for 2 s into a visit, at
  once by a `world` or `smallBodies` command, again 30 s after a failure. `createWorlds(ctx, system,
  obliquity, detail)` returns `Worlds`: `advance(jdTdb)` after the ten bodies are placed and before the
  camera moves; `nearestKm(camera)` joins the depth range's nearest surface; `update(frame)` with the
  camera, lens, the ten bodies as placed, the exposure's adaptation and whether the real sky's worlds
  show (not in an experiment, on foot or on the way down); `labels(out)`; `nav(id)`, `navList()`,
  `host(id)`, `find(name)`, `pick(x, y)`, `setDetail`, `setLayer`, `setGrouped`, `view(focus)`,
  `illustrative(out)`, `dispose`. Its parts: `orbits.ts` (pure: the files' decoding, Kepler's
  equation as the GPU solves it and to convergence, heliocentric and moon positions, the H, G law),
  `belt.ts` (the asteroids on the GPU), `comets.ts`, `bodies.ts` (the worlds to fly to, their maps),
  `rings.ts`, `eclipses.ts`, `glow.ts` (the Milky Way's and the zodiacal light's models).
- **Data.** `public/assets/smallbodies/` from `scripts/smallbodies/build.py <download dir>` (stdlib
  Python; `fixtures` writes `tests/support/astro/horizons-smallbodies.json`) and `maps.py` (Pillow and
  numpy in `.cache/venv-worlds`): `manifest.json` (common epoch, classes, counts, tiers with sha256,
  every query and its reply's sha256), `asteroids-0..3.bin` (16 bytes an object, brightest first,
  cumulative: 20,000, 80,000, 250,000, 500,000), `comets.json`, `worlds.json` (66 worlds and the
  rings), `maps.json` and `maps/<world>.jpg` (2048 x 1024, east longitude 0 in the middle, mean
  linear brightness 0.4).
- **Detail.** `ExploreDetail.smallBodies`: 20,000 (Low), 80,000 (Medium), 250,000 (High), 500,000
  (Ultra) asteroids; the files are fetched as far as the level needs.
- **Focus.** `FocusId = BodyId | WorldId` (`WorldId = \`w:${string}\``, the catalogue's name:
  `w:Ceres`, `w:Io`, `w:1P/Halley`). The navigator, trips, `UniverseView.focus` and `from`, and
  `UniversePose.body` take either. A world has no place beneath the camera (no saved view, no walk),
  no notes and none of the ten bodies' illustrative items; its host (`Worlds.host`: a moon's planet,
  the Sun for the rest) is what the ten bodies' code reads. Entering an experiment from a world flies
  to the Sun.
- **Commands.** `app.earthCommand({ kind: 'world', name })` flies to a world by its name or
  designation in any case ("Ceres", "io", "Halley", "67P", "433"; a name contained in one name is
  enough); asked before the chunk has come it is flown to when it does; a name that matches nothing
  does nothing. `{ kind: 'smallBodies', on }` shows or hides the small bodies' layer (the asteroids,
  the comets, and the dwarf planets', asteroids' and comets' points and names; the moons always
  show); `{ kind: 'smallBodiesGrouped', on }` colours the asteroids by group (illustrative).
- **View.** `UniverseView.worlds` (null until loaded): `layer`, `grouped`, `asteroids` (drawn; 0
  with the layer off), `asteroidsLoaded`, `groups` (main, near, trojans, hildas, centaurs, kuiper,
  other), `comets`, `tails`, `list` (id, name, kind, host), `focus` (the world in view's facts: kind,
  host, radius, axes, albedo, rotation, sizeFromH, sunAu, eclipsed, its map's credit), `eclipses`
  (receiver, occluder, depth) and `epochJdTdb`. Illustrative items: `small-body-light`,
  `comet-tails`, `world-shape`, `eclipse-red`, `ring-light`, `sky-glow`.
- **Cost** (2026-10-27, this Mac's GPU, Chromium on WebGPU, 1440 x 900 at a pixel ratio of 2,
  `?profile=1`; `tests/explore/small-worlds-perf.spec.ts`): 59.88 fps with the 99th percentile frame
  at 16.8 ms (the display's own rate) at High (250,000 asteroids) and at Low (20,000), the layer on
  and off, in the Earth's default view, the belt from above (7.4 au), Jupiter's system, Saturn's ring
  plane, the Sun at 4 million km and the outer system from 50 au. Uncapped (vsync and the frame-rate
  limit off), the median frame in ms over two runs each, with the layer on / off, against the commit
  before (48988b7), on a machine busy with other work (load 8 to 16, so a run differs from the next
  by up to a millisecond): High: Earth 2.2–2.9 / 2.2–2.4 against 1.8–2.9, the belt 2.0–2.1 / 2.0–2.1
  against 1.1–1.6, Jupiter 1.6–2.1 / 1.7–2.2 against 0.9–1.7, Saturn's ring plane 1.3–1.7 / 1.2–1.5
  against 1.0–1.1, the Sun 1.3–1.8 / 1.2 against 1.0–1.4, the outer system 1.9–2.2 / 1.9–2.0 against
  1.5–2.1; Low: 0.6–0.9 / 0.5–0.8 against 0.3–0.4, 1.0–1.7 / 0.9–1.2 against 0.9–1.2, 0.9–1.1 /
  0.8–1.0 against 0.8–0.9, 0.5–1.2 / 0.4–0.8 against 0.4–0.5, 0.6–1.3 / 0.4–1.0 against 0.3–0.6,
  1.1–1.5 / 0.9–1.2 against 0.9–1.2. So up to about a millisecond a frame where it costs most (the
  sky's glow fills every pixel; the moons, rings and eclipse shells stay with the layer off), far
  inside a 16.7 ms frame. What keeps it so: a point's light and colour are worked out once in the vertex stage
  (a varying), not for each of its pixels; a point too faint to see has no size, so no pixels; the
  comets are placed again only when the clock has moved; the files are decoded, and the glows' tables
  worked out, a slice a frame.
- **Test ids.** `universe-worlds` (the navigator's section), `worlds-intro`, `worlds-layer`,
  `worlds-grouped`, `worlds-groups`, `worlds-group-<group>`, `worlds-search`, `worlds-results`,
  `worlds-go-<name>`, `worlds-none`; the About section's `about-size`, `about-albedo`, `about-day`,
  `about-now` for a world.

## Browsers and local testing (measured on this machine)

- **The user browses with Brave** (installed: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
  Brave 1.97 / Chromium 155). Brave is a primary target. Its Shields fingerprinting protection
  can blank or randomise `GPUAdapter.info` and `WEBGL_debug_renderer_info`, so tier detection must
  treat missing/empty GPU info as "unknown desktop GPU" (WebGPU desktop → high; the governor
  protects), never as an error. Everything is self-hosted, so Shields' blocking does not apply.
- Chromium/Brave **cannot launch inside the Bash sandbox** (Mach port lookups are denied): run
  browser automation with `dangerouslyDisableSandbox: true`.
- **Local port binding is blocked in the sandbox.** Instead of a dev server, serve the build
  from disk with Playwright request interception: `npx vite build`, then
  `page.route('https://kf.test/**', …)` fulfilling files from `dist/`, and open
  `https://kf.test/index.html…`. Use **https** — WebGPU needs a secure context.
- Real GPU in automation: `chromium.launch({ channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })`
  gives WebGPU (Apple, metal-3) and WebGL2 on the Apple M5 Pro. The default headless shell
  has no WebGPU and only SwiftShader WebGL2. Brave: `chromium.launch({ executablePath: <brave path>, args: ['--use-angle=metal'] })`
  also exposes WebGPU.

## three.js r186 notes

- `import * as THREE from 'three/webgpu'`; TSL from `'three/tsl'`.
- `new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL })`, then `await renderer.init()`;
  backend: `(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend`.
- Post-processing: `THREE.RenderPipeline` (the old `PostProcessing` is deprecated), `pass(scene, camera)`,
  bloom from `three/addons/tsl/display/BloomNode.js`. Engine owns the pipeline; chapters never call render.
- KTX2: `three/addons/loaders/KTX2Loader.js`, `setTranscoderPath(assets.url('assets/basis/'))`,
  `await loader.detectSupportAsync(renderer)` (or `detectSupport`) after `init()`.
- Orbit: `three/addons/controls/OrbitControls.js`.
- Sized points on WebGPU: core WebGPU points are 1 px; for sized sprites use `PointsNodeMaterial`
  with `sizeNode` on an instanced `THREE.Sprite`/`InstancedMesh` setup as in three's
  `webgpu_instance_points` example (check node_modules/three/examples). Must also run on WebGL2.
- No compute shaders in M1 unless there is a non-compute WebGL2 path; prefer analytic
  vertex-stage animation (positions as a function of time) which runs on both backends.

### Five-planet extension

`BodyId` / `BODY_IDS` include the Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter,
Saturn, Uranus and Neptune, in that order. `PhysicalFile.bodies` includes all ten IAU
models. Nutation-precession angle polynomials have two coefficients, or three when
the PCK declares quadratic phases (Mars); omission of the third means zero.

Mercury and Mars reuse the regolith renderer with their own texture slots, true polar
flattening and phase-dependent solar angular size; neither gets the Moon's earthshine
or synthetic microcraters. Mars has an explicitly labelled schematic dust haze.
Venus and the ice giants use cloud-deck shading and uniform illustrative colour maps.
Uranus's and Neptune's rings and the moons are drawn by the small worlds' chunk (below).

The pipeline registers USGS GeoTIFFs using their metadata, including Mercury's DEM
central meridian, and preserves source pins, landmark probes and decoded-file checks.
The new metadata `facts.rockyProbes` holds named imaging/normal-channel reference
probes; `facts.cloudColours` holds the original uniform display swatches. Cloud-colour
constants are explicitly qualitative display choices, not physical measurements.
The full transfer set is 193,030,292 bytes. Tier byte ceilings are 8/24/110/250 MB;
the complete committed texture budget is 280 MB. Resident GPU budgets are unchanged.

Explorer note rules are scoped below `.kf-universe`; `.kf-note` in scripture panels
must stay in normal flow after an explorer visit. The graphics-detail menu has a
viewport-limited scrolling panel and a sticky header.
