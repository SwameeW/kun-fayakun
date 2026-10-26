# On foot (ledger GR-5): the Earth, the Moon, Mars, Mercury and Venus

The explorer's space-suit walk: first person at human height, on real terrain, with a suit's
readout, on every solid world it shows. The Earth's ground comes from its terrain tiles under the
imagery the explorer already streams; the Moon's, Mars's and Mercury's from their orbiters'
altimeters and stereo models (LOLA, MOLA, MESSENGER) under the globes' own colour maps; Venus's from
Magellan's radar altimetry, under an illustrative overcast. The giant planets have no surface to
stand on; their atmospheres are GR-6.

## What a visitor does

- **Begin.**
  - On the Earth, "Walk here" in the Living Earth panel stands the visitor on the ground below the
    view.
  - On the Moon, Mars, Mercury and Venus, "Walk here" in the navigator does the same, once the world
    in view is drawn at its true size (`UniverseView.walkHere` says where).
  - `app.earthCommand({ kind: 'walk', world?, lat?, lon? })` does the same, or walks at a given place
    on a given world (the Earth when not said).
- **Landing.** The walk waits in orbit ("Landing: the ground here is loading…") until the heights
  under the feet have loaded finely enough: zoom 9 on the Earth, the finest the world's grid holds
  on the Moon and Mars. The eye never starts inside a mountain.
- **Moving.**
  - Keys:
    - W A S D walk (1.4 m/s);
    - Shift runs (5 m/s);
    - R jumps, at 3.1 m/s upward, under the world's own gravity: about 0.49 m on the Earth, 1.3 m on
      Mars and 3.0 m on the Moon (v² / 2g);
    - the arrows turn and tip the look;
    - Esc or O goes back to orbit.
  - A drag looks round. The scene moves with the drag, as in a street-level photo viewer.
  - On a touch screen, Forward, Back and Jump buttons are held down as the keys are. A keyboard
    press on one takes a short step.
  - Zoom does nothing on foot (the field of view is fixed at 70°).
  - A trip elsewhere ends the walk: a world chosen, or a place flown to. A walk begun on another
    world ends the one under way.
  - Walks stay within 85° of the equator, where the terrain's Web Mercator tiles stop.
- **The suit's readout:**
  - the place;
  - the ground's height above the world's datum (the Earth's sea level, the Moon's 1,737.4 km
    sphere, Mars's areoid, Mercury's 2,439.4 km sphere, Venus's mean radius of 6,051.8 km), and the
    distance walked;
  - gravity, from each world's GM (DE440) at its mean radius: 9.82 m/s² on the Earth, 1.62 on the
    Moon, 3.73 on Mars, 3.70 on Mercury, 8.87 on Venus;
  - the air:
    - the Earth: the pressure at the feet in an isothermal atmosphere, 101.4 kPa × e^(−h / 8.5 km),
      from the sea-level pressure and scale height in NASA's Earth Fact Sheet, and the Earth's mean
      surface temperature, 15 °C, named as a mean and not today's;
    - Mars: 0.636 kPa × e^(−h / 11.0 km) from its fact sheet (the pressure at its datum, taken at the
      areoid, where a resting atmosphere's pressure is the same all round), "mostly carbon dioxide",
      and its mean surface temperature, −59 °C (214 K), not today's. In Jezero crater, 2.6 km below
      the datum, that is about 0.80 kPa;
    - Venus: 9,200 kPa (92 bar) × e^(−h / 15.9 km) from its fact sheet, "mostly carbon dioxide",
      and its mean surface temperature, 464 °C (737 K);
    - the Moon: no air, a vacuum, and its equator's ground from −178 °C before dawn to 117 °C at noon
      (the fact sheet's 95 K to 390 K);
    - Mercury: no air, a vacuum (a thin exosphere), its ground averaging 167 °C, and 317 to 452 °C
      on the side toward the Sun (the fact sheet's 440 K, and 590 to 725 K);
  - the Sun's height (on Venus "unseen behind the clouds"), and the local solar time;
  - where the ground comes from, and what is illustrative.

  On a narrow screen the figures fold under the title, leaving the view and the buttons.
- **Makkah.**
  - No walk begins within 25 km of the Kaaba, and a step into that radius is refused, with a
    notice.
  - At 25 km or more, the fixed 70° view spans at least 35 km there. That keeps the 30 km framing
    rule (`MAKKAH_FRAME`) on foot as from above.

## How it is drawn

### The ground

`src/explore/walk/ground.ts` builds a geometry clipmap.

- **Rings.** 11 nested square rings of 48 × 48 cells. Point spacing runs from 8 m in the innermost
  ring to 8.2 km in the outermost, which reaches 196 km. That puts real ground on the horizon at
  every height a walker reaches.
- **Seams.**
  - Each ring hides where the ring inside it lies, and hangs a skirt from its edge.
  - Over the 8 cells nearest its edge a ring's heights become the next ring's (which come from
    coarser data), so the two meet with no step. Without it a coarser ring standing higher than the
    finer one inside it would leave a slit to see through (on the Moon, where neighbouring zooms of
    its 3.8 km grid differ by up to 100 m, the sky showed through such slits near the horizon).
  - Back faces are lit as front faces, and the fine relief never tilts a skirt (whose faces stand
    upright), so nothing seen through a gap can catch a Sun below the horizon.
- **Re-centring.** Each ring re-centres as the walker moves, snapped to its own spacing.
- **Refills.** At most two rings refill each frame:
  - moved rings first, finest first;
  - then rings whose heights have sharpened, the longest-waiting first.

  When the walk lands or re-anchors, every ring refills in the same frame.
- **Precision.** Positions are kept relative to an anchor near the walker, in the world's own
  frame, which keeps single precision at centimetres. The anchor moves after 20 km.

### Heights

- **The Earth.** `src/explore/walk/terrain.ts` reads the AWS Terrain Tiles.
  - Terrarium PNGs: height = R × 256 + G + B / 256 − 32768 m. Zoom runs to 15: 4.8 m per pixel at
    the equator, finer toward the poles (3.9 m at the Grand Canyon).
  - Decoded without colour conversion, so the bytes stay exact.
- **The Moon, Mars, Mercury and Venus.** `scripts/walk/heights.py` writes each world's heights from
  its global grid, averaged down to two grids, both terrarium PNGs to half a metre in
  `public/assets/walk/`:
  - the whole world at 2 pixels a degree (720 × 360);
  - eight 90° × 90° tiles at 8 pixels a degree (720 × 720 each): about 3.8 km between heights on
    the Moon, 7.4 km on Mars, 5.3 km on Mercury and 13 km on Venus.

  The grids: LOLA's (16 pixels a degree) for the Moon; MOLA's MEGDR (16) for Mars; USGS's MESSENGER
  DEM (64, half-metres above 2,439.4 km) for Mercury; USGS's Magellan topography (22.76, radii above
  6,051.0 km) for Venus, re-referenced to its mean radius, averaged over each output pixel's exact
  overlap, and with the 8.3% Magellan did not measure (its poles, and strips further south and
  north) filled from around them and relaxed smooth.

  `src/explore/walk/equirect.ts` serves them to the walk as the same Web Mercator tiles the Earth's
  come in, resampled bilinearly from the finest grid loaded for the place. Tiles finer than a
  quarter of the detailed grid's pixel (zoom 6) add nothing, so none finer is asked for.
- **Zoom per ring.** Each ring reads tiles at the zoom its spacing needs on its world: the same
  tiling over a smaller world has smaller pixels (the Moon's are 0.27 of the Earth's).
- **Interpolation.** Heights are bilinear across tile edges, so there are no seams.
- **Fallback.** Coarser zooms stand in until finer tiles arrive. A count per zoom of the tiles
  returned tells the ground which rings are stale.
- **Cache.** 192 tiles, with 8 requests in flight.

### Colour

- **The Earth.** The globe's day map and the streamed Sentinel-2 cloudless imagery, about 10 m per
  pixel at best. While walking, the imagery is aimed at the walker's feet; looking along the
  ground, the view's centre may miss the globe.
- **The Moon, Mars and Mercury.** Their globes' own colour maps (the CGI Moon Kit's LROC colour;
  Viking's colour mosaic, with Mars's hue as the globe keeps it; MESSENGER's neutral 430 nm mosaic).
- **Venus.** Illustrative dark basalt: no camera has mapped its surface in colour (the explorer
  draws its cloud deck), and the landers that saw it saw it under orange light.

### The fine detail (illustrative)

`src/explore/walk/surface.ts` draws what lies between the measured heights. None of it is measured
ground, and the readout says so.

- **Grain**, on every world: four octaves of gradient noise (MaterialX's Perlin, smooth at any
  magnification), each turned by the golden angle against the one before so that no direction lines
  up, in brightness and in relief, down to about 5 cm.
- **Craters**, on the Moon, Mars and Mercury (none on Venus, whose thick air breaks up the small
  impactors that would make them):
  - One at most to a cell, in octaves of cells four times larger each time. That gives sixteen
    times fewer craters four times wider: the −2 power law of an old surface battered to
    equilibrium (Gault 1970).
  - Each is a parabolic bowl a third of its radius deep inside a rounded rim, its ejecta falling
    away to nothing by 1.6 radii.
  - Most are worn shallow; a few are fresh. On the Moon the fresh ones are brighter (young,
    unweathered soil).
  - The Moon's and Mercury's run from half a metre to about 160 m across, in about half of the
    cells. Mars's are fewer and none under about 10 m (its air and dust wear the small ones away,
    and fill them).
  - The rim toward a low Sun shades the floor, as craters near the terminator are drawn in
    shadow.
- **Stones**: a scattering of grey ones on the Moon and Mercury (up to 1.2 m across), more, darker
  ones on Mars's dust (up to 1 m), and flat slabs on Venus (as the Venera landers' pictures show),
  each casting a shadow away from the Sun where the Sun is seen. They are left out on the lowest
  detail tier (they are the costliest part).
- **Fading.** Each octave fades out as its features near a pixel.
- **Relief is bump mapping.** It tilts the ground's shading but does not move the ground (a stone
  has no silhouette), and the shading never tilts past a slope of about 56°.

### Light and depth

- **Sunlight.** The Sun's light at the world (1 at 1 au: Mars gets 0.43 of the Earth's, Venus 1.9,
  Mercury about 6.7) falls on each terrain normal: through the Earth's globe's air model on the
  Earth, a little reddened by the dust on Mars, unfiltered on the Moon and Mercury. On Venus none
  falls as a beam: all its light is the overcast's.
- **The sky's fill.** Light from the sky above, as bright as the day is: blue on the Earth,
  butterscotch on Mars, orange on Venus (where it is all the light there is), and on the Moon and
  Mercury only a faint grey (the sunlit ground around a shadow).
- **Haze.** The distance fades into the air's colour: the Earth's pale blue over 30 km (its
  e-folding distance); Mars's dust over 12 km and Venus's deep air over 4 km, each into its sky's
  horizon colour; none on the Moon or Mercury.
- **Depth.** Depth is logarithmic in the ground's material only, from 0.1 m to 2,000 km. The
  renderer keeps standard depth.

### The sky

- **The Earth.** `src/explore/walk/sky.ts` uses Preetham, Shirley and Smits's daylight model, as
  three.js's SkyMesh implements it. Here the local vertical is an input, and there are no clouds.
- **The Moon and Mercury.** No sky: the black sky and the explorer's real stars. By day the sunlit
  ground's glare leaves the eye about a third of the stars' light.
- **Venus** (illustrative): the underside of its cloud deck, brightest overhead by day, dark by
  night, its light dim and orange (the deep air takes the blue out of what the clouds let down).
  Neither the Sun's disc nor any star is drawn; the readout says where the Sun is.
- **Mars** (illustrative: no radiative transfer of its dust): butterscotch by day, warmer toward the
  horizon, with a blue glow about the Sun that strengthens as it sets (the dust scatters blue light
  forward, as the rovers' cameras show), dimming through twilight; lit by Mars's sunlight, its
  horizon a little brighter than the sunlit ground below it.

`src/explore/walk/daylight.ts` holds the day's light by the Sun's height (the Earth's and Mars's):

- **Adaptation.** The model's sky darkens as the Sun sinks (its Sun's intensity falls about
  fifteenfold from 42° to the horizon). The eye's adaptation brightens it again, at most twentyfold.
- **Twilight.** The model's light ends 2.3° below the horizon, so twilight is a gradient of its own:
  blue overhead, a warm glow on the horizon under the Sun.
- **Stars.** The sky hides the stars (and the planets' points) until the Sun is 4° down, and lets
  all of them through by 12°.
- **The ground at dusk.** The ground's ambient light follows the same adapted level, down to a faint
  floor at night. The haze goes sooner.
- **The Sun.** The Sun's disc and glare are the explorer's own.

### What hides on foot

The globe walked on, the orbit lines, the satellites, the earthquakes, the place markers, the qibla
layer and the readout from orbit.

## Limits

- On the Earth the sea, and land below sea level (the Dead Sea's shore, the Caspian), are drawn at
  sea level. The tiles hold the sea floor, and there is no land-and-water mask on the CPU yet.
- The Moon's, Mars's, Mercury's and Venus's heights are 3.8, 7.4, 5.3 and 13 km apart. Their
  mountains, crater walls and canyons are as the instruments saw them; everything smaller is the
  illustrative detail above. Venus's gaps are smooth fills, not measurements.
- Walks stop at 85° of latitude, where the Web Mercator tiles stop: not yet the Moon's south pole.
- **Not drawn yet:**
  - trees, buildings, or stones with silhouettes (the stones are shading only);
  - shadows cast by terrain onto terrain (a ridge does not shade the valley behind it; only the
    craters' rims and the stones cast shadows);
  - clouds in the walk's sky, weather, and Mars's dust storms;
  - the Earth in the Moon's sky as more than the explorer's globe.
- The walker climbs any slope and walks through what it cannot see; there are no collisions.
- The Earth's imagery is 2016's mosaic at about 10 m. Up close, the colour is that of a 10 m patch.
- Terrain accuracy is the source's own:
  - SRTM, about 30 m, with voids filled;
  - 3DEP, 1 to 10 m in the United States;
  - national models elsewhere;
  - GMTED and ETOPO in the far north and at sea;
  - LOLA and MOLA as averaged here.
- The skies and twilight are illustrative, not radiative-transfer models of the real air.

## Credits

- Terrain Tiles: the full attribution list the tiles require is in `data/sources.json`
  (`aws-terrain-tiles`, shown on the Sources page) and section 13 of `LICENSES`.
- The Moon: NASA's Scientific Visualization Studio, CGI Moon Kit (`nasa-svs-cgi-moon-kit`), from LRO
  LOLA data.
- Mars: the MGS MOLA Mission Experiment Gridded Data Record, PDS Geosciences Node
  (`pds-mola-megdr`).
- Mercury: USGS's MESSENGER global DEM (`usgs-dem-mercury`), the globe's own relief source.
- Venus: USGS's Magellan global topography (`usgs-magellan-venus`).

The walk's panel credits each in short. The colour is credited as from orbit.

## Tests

- **`tests/unit/walk.spec.ts`:**
  - the terrarium encoding, and Web Mercator tile arithmetic, on worlds of any size;
  - heights read seamlessly across tiles, from coarser tiles until finer ones arrive, and no finer
    than a world's grids hold;
  - walks kept within the tiles' latitudes, and standing below a datum where there is no sea;
  - the walker's frame;
  - a jump of v² / 2g on the Earth and on the Moon;
  - walking speed, and a place it may not enter;
  - the suit's figures;
  - the day's light: the stars' fade, the sky's adaptation, twilight, the ambient light and the
    haze.
- **`tests/unit/equirect.spec.ts`:** a grid read between its pixel centres (exactly for a ramp,
  wrapping round in longitude); Mercator tiles from the whole world's grid when coarse and from the
  detailed tile where finer, every pixel where it lies.
- **`tests/explore/walk.spec.ts`:**
  - on the Earth, with mocked flat terrain at 1,000 m:
    - landing, and the readout's figures;
    - walking, turning, jumping, and the on-screen pad;
    - back to orbit, as it was;
    - the refusal at Makkah;
    - a trip that ends a walk;
  - on the Moon: Walk here from orbit; Apollo 11's landing site, its ground within 40 m of the
    grid's own reading there (about 1.9 km below the reference sphere); the Moon's gravity, its
    vacuum and its day's range; walking; back to orbit;
  - on Mars: Perseverance's landing site in Jezero crater, its ground within 40 m of the grid's
    reading (about 2.56 km below the areoid; the mission gives 2.57); Mars's gravity; the air at the
    walker's height;
  - on Mercury: Walk here; Rachmaninoff basin's floor, within 40 m of the grid's reading; its
    gravity, vacuum and temperatures;
  - on Venus: Venera 13's landing site, within 40 m of the grid's reading; its gravity; its air at
    the walker's height; no Sun seen through the clouds.
- **`tests/explore/mobile.spec.ts` (emulated phone):**
  - Forward held walks, a finger looks round, and Jump jumps;
  - every control is a 44 px target;
  - nothing is wider than the screen;
  - axe finds nothing.
- **`node --import tsx scripts/validate.ts`:** the four worlds' 36 height PNGs present at the sizes
  `heights.json` lists, and credited.
- **Captures checked by hand while building** (not committed):
  - on the Earth: Yavapai Point on the Grand Canyon's South Rim; Gornergrat facing the Matterhorn, on
    Low and on a phone; the canyon at sunset, at dusk both ways, and at night;
  - on the Moon, Mars, Mercury and Venus: the Sun high, the Sun 8° up (the craters' shadows), and
    night, looking along the ground, down at the feet, and up at the sky.

## Next

- Finer heights where the sources allow them (a third level of tiles: LOLA and MOLA at 16 pixels a
  degree, MESSENGER's at 64), and past 85° of latitude (the Moon's south pole).
- GR-6: down through Venus's clouds and the giants' cloud decks in the suit, with cited profiles.
