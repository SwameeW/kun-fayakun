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
  `?jd=` query parameter). One parser (`src/core/router.ts`) serves the engine and the UI.
- Query: `?forceWebGL=1`, `?tier=high|mid|low`, `?reducedMotion=1|0`, `?autoplay=1`
  (skip the intro overlay and start playing), `?fps=1` (show a small fps readout), `?profile=1`
  (GPU timestamp queries where supported: `frameStats()` then reports `gpuMedianMs`/`gpuP95Ms`;
  holds the render scale at 1), `?jd=<Julian date>` (pins "now" for astronomy views; plain decimals
  from 1 CE to 9999 CE, anything else is ignored; the explorer reads it as UTC).
- Dynamic resolution: unless `?tier` or `?profile` is set, the engine lowers the render scale in small
  steps (down to 0.6× the tier's DPR cap) when frames run slow, before the tier governor drops a tier,
  and probes back up after long comfortable stretches. Frames over 0.25 s (stalls) are ignored, a tier
  change holds the render scale for 3 s, and both governors judge frames against the display's cadence:
  a rAF that has never run faster than 30 Hz (Low Power Mode, battery savers) targets 30 fps, anything
  else 60 fps. A software-only WebGPU adapter (e.g. SwiftShader
  on GPU-less CI) is treated as unavailable: WebGL2 is used instead.

## Test hooks (engine sets these on `<html>`)

- `data-backend="webgpu|webgl2"`, `data-tier`, `data-state` (TimelineState), `data-chapter`,
  `data-ready="true"` after the first rendered frame, `data-chapter-ready="chNN"` after a
  chapter is entered and has rendered a frame, `data-reduced-motion="true|false"`,
  `data-experience="film|universe"` (set as soon as a switch starts), `data-universe-ready="true"`
  once the explorer has rendered a frame after loading (removed while it is not on screen).
- `window.__kf = { app, frameStats(): { frames, seconds, medianFps, onePercentLowFps, p99FrameMs, memory: { geometries, textures }, experience }, resetFrameStats(), step(frames = 1, dt = 1/60), universe: { state(), place(pose) } }`.
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
`universe` (the explorer's interface), `universe-bodies`, `universe-back`, `universe-readout`.

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
  upright frames it by its width) and first seen from its sunlit side turned about 50 degrees,
  Jupiter from near its equator, Saturn from the side of its rings the Sun lights. A flight leaves
  its body and closes in on the destination in log distance (its distance to the destination only
  falls), on an arc out of the planets' plane and clear of the Sun, its gaze on the destination
  after its first third; with reduced motion it is a cut under the veil, the exposure jumping to the
  new body while the picture is dim.
- **Truth and honesty.** Positions, radii, flattening, poles and spin come from
  `public/assets/jpl` through `src/astro`; the date is now (or `?jd=`), clamped to the Moon
  table's span. Saturn's rings are drawn from the Cassini radio-occultation profile
  (`physical.json` `saturnRings.profile`: mean normal transmission in 2,048 bins, built by
  `scripts/jpl/build.py`), only their colour illustrative. Surfaces are procedural until mission
  maps arrive, and the interface says so ("Surfaces are illustrative"), along with "True scale: real
  sizes and distances". The film's metres-per-pixel bar is replaced by a readout of true distances.
- **Light.** Sunlight on a body falls as 1/r^2; the exposure adapts to the body in view as
  r^1.8 (so the outer planets stay a little dimmer), through `ctx.exposure` like every change
  (slew-limited: flash-safe); bloom is judged at that exposure (`PostPipeline.setBloomExposure`;
  the film keeps 1). Guides (orbit lines, points and ring markers of bodies under a few px, the Sun's
  glare) keep their brightness on screen; the Sun's disc is brilliant white when small and, as it
  fills the view, shown as through a solar filter (amber, limb-darkened, mottled), which the readout
  says. The engine's exposure cap is 128 (chapters ask for 1 or less).
- **Bodies and detail.** The explorer draws its bodies with its own shaders (`src/explore/bodies`),
  never the chapters': an Earth with detail that fades in with closeness, cloud shadows, an
  ocean-only glint and an atmosphere shaded from the air's column; a cratered Moon with relief and
  earthshine; limb-darkened giants; the rings above; a filtered Sun and its glare. Shading edges
  (terminators, ring and shadow edges, crescents) are softened over one pixel and fine detail fades
  before it is smaller than one; MSAA (the scene pass inherits the renderer's 4 samples) handles
  outlines. `setQuality` lowers mesh segments, detail octaves, cloud shadows and stars on mid and low.
- **Shared modules, optional parameters only** (left out, the chapters' graphs are unchanged):
  `createStarfield(count, radius, seed, { depthTest, dynamicRadius })` with `setRadius`,
  `createStreakField({ ..., profile: 'trail'|'line', tailColor })`.

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
