# Handoff: add Mercury, Venus, Mars, Uranus and Neptune to the explorer

You are taking over Kun Fayakun, a browser 3D experience (Vite, TypeScript strict, three.js r186
WebGPURenderer with a WebGL2 fallback, TSL node materials). It has two parts: a cinematic film in
11 chapters (`src/chapters/**`) and a true-scale solar-system explorer (`src/explore/**`,
`src/ui/explore/**`, route `#/universe`). The explorer currently has five bodies: the Sun, Earth,
Moon, Jupiter and Saturn. **Your task is to add Mercury, Venus, Mars, Uranus and Neptune, with
real data and real textures, at the same visual and engineering standard.** The owner asked to keep
compute and token usage reasonable: work directly, avoid exploratory rewrites, and verify with
targeted tests before the full suite.

- Repository: https://github.com/SwameeW/kun-fayakun (deploys to https://swameew.github.io/kun-fayakun/).
- Start from `main` at `8078679` or later, on a new branch such as `five-planets`.
- Nothing for this task has been started yet: no code, no downloads.

## Rules that must not break

These come from `docs/SPEC.md` section 1 and `docs/CONTRACTS.md`; read both first.

- **Scripture.** Quran verses and hadith come only from `data/quran.json` and `data/hadith.json`. Keep
  Arabic out of `src/`. The explorer is science only: no verses or hadith on objects or in the
  exploration UI.
- **Cited numbers only.** Every scientific number comes from cited data: `data/constants.json` (each
  entry with a source in `data/sources.json`), `public/assets/jpl/*.json`, or the texture manifest.
  Never type a number from memory. If you need a new constant, add it with its source.
- **Flash safety.** Every brightening is eased: at most 3 flashes per second, and no step changes in
  luminance.
- **Chapters unchanged.** The chapters must not change behaviour. Touch only `src/explore/**`,
  `src/ui/explore/**`, `src/ui/styles/explore.css`, shared types and data, the pipelines, docs and
  tests. If a shared file such as `src/chapters/shared/*` must change, the chapter frames must stay
  identical.
- **Budgets.** The explorer's lazy chunk stays at or under 150 KB gzip (it is about 84 KB now). The
  shell stays within 10 KB of the check-bundle baseline (`npx tsx scripts/check-bundle.ts`).
- **Honest labelling.** Anything illustrative is labelled. The readout names it through
  `UniverseView.illustrative`; see `UniverseIllustration` in `src/core/types.ts` and the i18n keys
  `ui.universe.illustrative.*`. Sizes and distances in the explorer are true.
- **Licensing.** Imagery must be public domain, CC0 or CC BY. Each source is pinned by sha256 and
  credited:
  - in `data/sources.json`, `LICENSES.md` and the Sources page;
  - in the explorer's short imagery line, with full credits a click away (`src/ui/explore/flight-hud.ts`).
- **Accessibility.** The UI is real DOM text, axe-clean, keyboard reachable, with touch targets of
  44 px or more on coarse pointers, and respects reduced motion.

## Tooling

- **Node.** Use Node 22.12 or newer, then run `npm ci`.
- **Checks:**
  - `npm run validate`, the scripture and data validator (`scripts/validate.ts`, rules in `scripts/lib/rules/*`);
  - `npm run typecheck`;
  - `npm run lint`;
  - `npx vite build`;
  - `npx tsx scripts/check-bundle.ts`.
- **Tests (Playwright).** The projects are `unit`, `webgpu`, `webgl2` and `mobile`, plus `brave` if Brave is
  installed. The full suite is `npx playwright test`, 333 tests at about 9 minutes on an Apple GPU.
  For targeted runs, use for example `npx playwright test --project=webgpu tests/explore/route.spec.ts`.
  `KF_PORT` sets the preview port so parallel checkouts don't clash.
- **CI** (`.github/workflows/ci.yml`):
  - a `check` job runs validate, typecheck, lint, build, the bundle check and the unit tests;
  - eight `browser` shards run webgpu, webgl2 and mobile;
  - CI has no GPU (it uses SwiftShader), so limits there are three times longer (`SLOW` in `tests/support/env.ts`);
  - tests that measure frame timing skip on CI with `test.skip(NO_GPU, NEEDS_REAL_FRAMES)`.
- **Deploy.** GitHub Pages (`.github/workflows/pages.yml`) runs only after the whole CI run succeeds on main.
- **Test hooks.** `window.__kf` exposes:
  - `app`;
  - `frameStats()` (including GPU memory: geometries and textures);
  - `step()`;
  - `universe.state()`, which returns `UniverseView`;
  - `universe.place({ body, distanceKm, azimuthDeg?, elevationDeg?, from? })`.

  `<html>` attributes include `data-universe-ready`, `data-travel`, `data-detail` and
  `data-universe-prefetched`. The URL parameters `?jd=` (pinned date), `?detail=ultra|high|medium|low`
  and `?forceWebGL=1` help with deterministic captures.
- **Not in the repository.** The capture, flash and profile harnesses I used lived in a gitignored
  `.cache/`, so you won't have them. Write small Playwright scripts that open
  `#/universe/<body>?jd=2461336.75`, call `__kf.universe.place(...)`, and screenshot. Look at the frames
  yourself; don't trust numbers alone.

## Data pipelines

**JPL, `scripts/preprocess-jpl.sh` running `scripts/jpl/build.py`.**
- It writes `public/assets/jpl/planets.json`, `moon.json` and `physical.json`.
- `planets.json` already has Kepler elements for all eight planets (Standish & Williams Table 1).
- `physical.json` (NAIF `pck00011.tpc` radii and IAU rotation models: pole RA, Dec, prime meridian,
  and nutation-precession terms where they exist) has only Sun, Earth, Moon, Jupiter and Saturn.
- **Extend it for Mercury, Venus, Mars, Uranus and Neptune.** Neptune's pole has a nutation-precession
  term. Venus and Uranus rotate retrograde: check how `src/astro/rotation.ts` handles a negative W rate
  and the IAU pole convention.
- Then update the validator rule `checkJpl` in `scripts/lib/rules/assets.ts`, and
  `tests/unit/ephemeris.spec.ts` (it has a Horizons fixture; add one or more positions for the new
  planets from JPL Horizons, cited).

**Planet textures, `scripts/preprocess-planets.sh` running `scripts/planets/{fetch,build,encode,manifest,preview}.py`.**
- `config.py` lists `MAPS` (body/map specs), the tiers (low 1024, medium 2048, high 4096, ultra 8192;
  all published), the codecs (ETC1S at Low and Medium, UASTC with RDO and zstd at High and Ultra, R8
  for single channels), and the byte budgets per tier and in total (`COMMITTED_BUDGET_BYTES`).
- `fetch.py` pins every download by sha256.
- `build.py` reprojects to equirectangular with rows stored bottom-up, and runs landmark checks: pick
  checkable landmarks for each new map, such as Olympus Mons or Hellas on Mars and Caloris on Mercury.
- `encode.py` runs KTX-Software, fetched by `scripts/cmb/fetch-ktx.sh`, then validates, decodes and
  measures PSNR.
- `manifest.py` writes `public/assets/planets/planets.json` and the planet entries of `data/sources.json`.
- The script creates a Python venv and installs its requirements (tifffile, imagecodecs and so on).
- In step with it, update:
  - `PLANET_MAPS` and the budgets in `scripts/lib/rules/assets.ts` (`checkPlanets`);
  - `src/explore/assets/planets.ts` (`PlanetBody`, `PlanetMap`);
  - `tests/unit/planets.spec.ts` (its `MAPS` list).
- Raise the tier and committed budgets as needed, with a comment. Keep every file under 50 MB, and the
  site well under GitHub Pages' 1 GB (it is about 130 MB now).

## Imagery: candidate sources

Verify every URL, size and licence yourself before use.

- **Mars, colour.** USGS "Mars Viking Global Color Mosaic 925m" (`Mars_Viking_ClrMosaic_global_925m.tif`, about
  764 MB, public domain): https://astrogeology.usgs.gov/search/map/mars_viking_global_color_mosaic_925m
  The sharper alternative is "Mars Viking Colorized Global Mosaic 232m" (MDIM 2.1):
  https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m
- **Mars, relief.** A MOLA DEM from USGS Astrogeology (for example "Mars MGS MOLA DEM 463m"), for normal maps as with
  ETOPO on Earth.
- **Mercury, colour.** USGS MESSENGER MDIS "Global Color Mosaic 665m" (1000, 750 and 430 nm as RGB):
  https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_global_color_mosaic_665m
  Do not use the "Basemap Enhanced Color" product: it is principal-component false colour. If even the
  natural-ish mosaic is too saturated for an honest look, use the monochrome MDIS basemap with a
  cited mean colour.
- **Mercury, relief.** "Mercury MESSENGER Global DEM 665m":
  https://astrogeology.usgs.gov/search/map/mercury-messenger-global-products
- **Venus.** In visible light Venus is a nearly featureless pale yellow-white cloud deck. Render the
  cloud tops in real colour with at most faint structure, and label that structure illustrative. Do
  not show the Magellan radar surface as Venus's appearance; if you add it at all, it must be an
  explicitly labelled radar view. Venus is very bright (high albedo), so check exposure.
- **Uranus and Neptune.** Voyager 2 shows nearly featureless discs. For colour, use Irwin et al. 2024 (MNRAS):
  both are pale greenish-blue, Neptune slightly bluer, contrary to the old saturated images. Add those
  colours as cited constants. Any faint zonal banding is illustrative.
  - **Uranus.** Use the real pole from `pck00011` (obliquity about 98°). Its narrow rings (the ε ring and others) are
    optional and must use real radii if added.
  - **Neptune.** Its rings are optional.

## Explorer code to extend

Everything currently assumes five bodies.

- **Body list.** `src/core/types.ts` has `BodyId` and `BODY_IDS`; `UniverseView.bodies` is in
  `BODY_IDS` order. Grep for `BODY_IDS`, `BodyId` and `'saturn'`: about 23 files reference them.
- **`src/explore/system.ts`.** `createSolarSystem` finds planets by name, keeps per-body state
  (position and basis), and holds `ROTATING` (line 36), which maps bodies to `physical.json` models.
- **`src/explore/index.ts`, the frame loop.** Things to extend:
  - the dot and label style per body (around line 106: `saturn: { tint, albedo, sizePx }`);
  - `exposureFor` (scales with distance from the Sun);
  - `lightAt`;
  - the orbit paths (around line 1451);
  - `navBodies`, `describe` and `illustrations()`;
  - the label system;
  - `refreshView`.
- **`src/explore/bodies/`.** Bodies are built in `index.ts`. The renderers to reuse:
  - `moon.ts` (Lommel-Seeliger, LOLA normals, horizon-march terminator shadows): the basis for
    Mercury, and for Mars with a thin dusty limb haze;
  - `giant.ts` (OPAL map, zonal flow, Minnaert limb): adapt for Uranus and Neptune with a cited
    colour, and maybe for Venus's cloud deck;
  - `rings.ts` and `ring-particles.ts` (Saturn);
  - `atmosphere.ts` (Earth only).

  Each body supports `setDetail(ExploreDetail)` and `suspend()`; streaming is in
  `src/explore/assets/streaming.ts` (Low on entry, the focus raised to the tier, a byte budget per
  frame).
- **`src/explore/detail.ts`.** The tier contract (Ultra, High, Medium, Low); don't change its meaning.
- **`src/explore/navigation.ts`, `travel.ts` and `flight.ts`.** Framing per body, the first-seen pose
  (sunlit face turned slightly away so the terminator shows), the trip planner (which avoids passing
  through bodies), and `MAX_ALTITUDE_KM` = 50 au (Neptune is at about 30 au, which is fine).
- **`src/explore/orbits.ts`.** `planetOrbit(...)` draws each planet's ellipse; add the new five.
- **`src/explore/stretch.ts`.** The Chapter 7 film-to-true-scale stretch.
  - `FILM.radii` needs the new bodies. Copy Chapter 7's values from `src/chapters/ch07/scene.ts`
    `RADII`: Mercury 0.026, Venus 0.046, Mars 0.034, Uranus 0.075, Neptune 0.072.
  - The stretch currently keeps Saturn's orbit fixed and frames 2.35 × Saturn's orbit. With Neptune
    present, decide whether to frame Neptune's orbit instead, as the film shows all eight planets.
  - Keep `tests/unit/stretch.spec.ts` and the route test passing.
- **`src/explore/discoveries.ts`.** Sourced notes. Optional: add a few for the new worlds, every
  number from cited data. Keep the tone: no scores or achievements.
- **Interface:**
  - `src/ui/explore/navigator.ts`: the list of worlds, with distance and light-time;
  - `orrery.ts`: the compressed top-down map, which must fit eight orbits legibly;
  - `body-icon.ts`: the portraits;
  - `flight-hud.ts`: the readout and `SURFACE_KEYS` (in `src/ui/explore/index.ts`, line 33);
  - `src/ui/styles/explore.css`: the navigator must fit ten worlds. On a phone held sideways it
    currently uses two columns for five, so check that portrait, landscape and desktop still fit
    without clipping.
- **Strings.** Every new string goes in `src/i18n/en.json` (`ui.universe.*`, the body names already
  used by the film, and surface and announcement keys).

## Tests to extend or check

- `tests/explore/*.spec.ts`: route, navigator, travel, quality, streaming, readout, planet-textures,
  mobile.
- `tests/unit/*`: planets, ephemeris, navigation, travel, stretch, detail-governor.
- Add at least:
  - each new body deep-links (`#/universe/mars`), renders and has its texture at the right place (a
    landmark check on decoded files, as `planet-textures.spec.ts` does);
  - the navigator lists all ten bodies and travel works to each;
  - GPU memory is stable over round trips.

## Done means

1. All ten bodies render at true scale, placed from JPL data and rotated by IAU models, with real
   textures where they exist and cited colours where they don't. Everything illustrative is labelled,
   and every source is credited.
2. Navigator, orrery, labels, orbits, readout, travel, the Chapter 7 stretch, phone and desktop
   layouts, and reduced motion all work with ten bodies.
3. validate, typecheck, lint, build, check-bundle and the full Playwright suite all pass locally. You
   have looked at captures of each new world at High and Low, and on a phone.
4. Merged to `main`, CI green and the Pages deploy succeeded. Update `docs/CONTRACTS.md` (explorer
   section, texture manifest) and `README.md` (asset table).

## Owner preferences

- Keep usage reasonable.
- Don't send the owner screenshots or open previews unless they ask; captures for your own checking are fine.
- The owner uses Brave.
- Credits read "Created by Samee and Muhaimin".
