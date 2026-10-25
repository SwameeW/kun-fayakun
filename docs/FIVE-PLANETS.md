# Five-planet explorer extension

The explorer adds Mercury, Venus, Mars, Uranus and Neptune to the existing Sun,
Earth, Moon, Jupiter and Saturn. The film's chapter sources and content are unchanged.

## Data and display choices

- Position: the existing JPL Standish/Williams elements for all eight planets.
  Independent Horizons vectors for the five additions are recorded at seven epochs
  in `tests/support/astro/horizons-reference.json`, with queries and source information.
- Radius, pole and spin: NAIF `pck00011.tpc`, parsed into `physical.json`. Signed spin
  is retained for Venus and Uranus; Neptune's periodic terms and Mars's quadratic
  phase angles are supported. The old two-coefficient phase representation still works.
- Mercury: real MDIS visible-band imaging (430 nm, the blue channel of the USGS
  1000/750/430 nm composite), presented as explicitly labelled neutral monochrome.
  The published linear contrast stretch is undone to recover the visible-band I/F display values. Missing imaging patches are interpolated and labelled. This avoids passing near-infrared colour off as natural colour. The MESSENGER DEM
  supplies relief. Its central meridian is 180 E; the colour mosaic's is 0 E.
- Mars: real Viking global colour and MOLA elevation data, with the GeoTIFF projection
  and pixel extents used to register the maps. A faint dust haze is labelled schematic.
- Venus: an almost featureless pale yellowish-white cloud deck, following NASA's
  visible-light description. No Magellan radar surface or ultraviolet clouds are shown.
- Uranus and Neptune: similar pale greenish-blue cloud decks, Neptune slightly bluer,
  informed by Irwin et al. (2024), doi:10.1093/mnras/stad3761. These uniform RGB swatches
  are original illustrative display choices, not measured values or mission maps.
  The UI labels that distinction; the source and credits are accessible in the readout.
  Optional rings are omitted.

Downloaded imagery and DEMs are pinned by size and SHA256 in `scripts/planets/config.py`.
The pipeline checks named landmarks before compression and on decoded KTX2 files;
its recorded probes are checked again through the browser's Basis transcoder.
Mercury and Mars colour reach 8K, relief 4K. The three uniform cloud models reuse
small 1K textures across tiers. Nothing is upsampled to pretend to contain detail.

The complete published texture set is about 193 MB, with every file below 50 MB.
The explorer streams Low first and raises focused bodies within the existing GPU
memory budgets. The detail menu describes the larger optional Ultra download.

## Interface and regressions

The navigator lists ten bodies, using two rows of portraits on phones, compact cards
in portrait, and a scrolling list where vertical space is short. The orrery includes
all eight planetary orbits. Travel, labels and readouts use the shared body registry.
The Chapter 7 transition starts with all eight compressed orbits in frame, retaining
Saturn's scale anchor to match the film's geometry before stretching to true scale.

Two existing defects are fixed: explorer note CSS no longer repositions scripture
annotations, and the detail menu stays within short viewports with a sticky header.

## Verification

Run `npm run validate`, `npm run typecheck`, `npm run lint`, `npx vite build`,
`npx tsx scripts/check-bundle.ts`, then `npx playwright test` after targeted checks.
The added tests cover each deep link, navigation entries, travel to the new worlds,
source credits, Horizons positions, signed rotation, quadratic phases and the
explorer-to-film annotation regression. Browser texture checks include the new maps.

The explorer can adapt through ten exposure stops for the ice giants, with the same
flash-safe slew limits. A one-time comparison against main verified that all 12,000
film-range exposure updates were bit-identical; the chapter targets remain at 1 or less.
