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
  - `app.earthCommand({ kind: 'walk', world?, lat?, lon?, headingDeg?, pitchDeg? })` does the same,
    or walks at a given place on a given world (the Earth when not said), facing a given way.
- **The descent (ledger GR-3).** With the world in view, the camera glides down over the place to the
  lowest orbit the explorer allows (150 km over the Earth, 2% of the radius elsewhere: 35 km over
  the Moon) while the ground loads; with reduced motion it is there at once.
- **Landing.** The walk waits ("Landing: the ground here is loading…") until the heights under the
  feet have loaded finely enough (zoom 9 on the Earth, the finest the world's grid holds elsewhere)
  and the glide has ended. Then the picture dips: it darkens over a quarter of a second, the camera
  moves to the walker's eye while it is dark (the exposure jumping to the ground's light), and it
  comes back over four tenths, as a reduced-motion cut does. The eye never starts inside a mountain.
  - It never hangs. Tiles that fail are asked for again after 1, 2, 4 and 8 s, then every 30 s while
    they are wanted. After 8 s with only coarser heights come (zoom 6 is asked for from the start), the
    walk lands on those and says so ("The ground's finer heights did not load here…"); the finer ones
    sharpen it if they come. With none at all after 15 s the readout says the ground could not be
    loaded, offers **Retry** (asks again at once) beside **Back to orbit** (which takes the focus), and
    keeps asking.
  - Asked for during a trip, the walk waits for the arrival, Back to orbit showing meanwhile; it goes
    where the trip goes: Esc stops the trip and drops it, and a trip turned elsewhere (another world
    chosen) or ending at another world drops it too.
- **Back to orbit** dips the same way, then climbs back to the orbit the descent left (at once with
  reduced motion), unless a trip has taken the camera elsewhere. Its button stands where "Back to the
  start" stands in orbit (top left), with Esc named beside it, from the moment a walk is asked for;
  "Back to the start" waits while the visitor is on foot, so no press leaves the explorer from the
  ground.
- **Esc** goes back to orbit, and is the walk's from the moment one is asked for until a second after
  the climb back ends: pressed again in that time (each press holds it a second longer) or held (its
  repeats), it goes no further; pressed during the climb, it stops the climb where it is. Only after a
  pause does one Esc leave the explorer, as in orbit. In mouse-look the browser's own first Esc lets
  the pointer go.
- **Time on foot.** From the descent to back in orbit (and on the way down through an atmosphere)
  the time machine runs at most an hour a second (`FOOT_MAX_RATE`): a day passes in 24 seconds, so
  the sky and the ground brighten and darken once in that time, never several times a second (at a
  week a second the Sun would cross the horizon 14 times a second: a strobe). Faster stops there and
  says why; the rate chosen before comes back in orbit.
- **Moving.**
  - Keys:
    - W A S D walk (1.4 m/s), and step aside;
    - Shift runs (5 m/s), and V held rides the rover (30 m/s, to cross a landscape: illustrative);
    - Space jumps (R too), at 3.1 m/s upward, under the world's own gravity: about 0.49 m on the
      Earth, 1.3 m on Mars and 3.0 m on the Moon (v² / 2g). On the ground Space is the walk's, not
      the time machine's play key (a focused button or link still takes it); while landing, and on
      the way down through an atmosphere (which has no jump), it is the play key as elsewhere;
    - the arrows, Q and E turn and tip the look;
    - Esc or O goes back to orbit.
  - A drag looks round as a first-person camera does: right turns right, up looks up. Among the
    suit's figures, "A drag moves the scene" turns it round for those who prefer the scene to follow
    the hand (kept in this browser; mouse-look keeps the first-person sense).
  - A mouse's click on the view takes the pointer for mouse-look (where the browser allows it), once
    the walker's eye is shown (never while the camera still waits in orbit for the ground); the
    mouse then turns the look with no button held, and Esc lets it go.
  - The pad (on every screen: a mouse or a keyboard can walk with it too; its targets are 44 px for
    a finger): walk forward and back and step left and right (held down, as the keys are; a
    keyboard's press on one takes a short step), Run and Rover (toggles) and Jump. On a touch screen
    a finger dragged across the view looks round.
  - The controls are shown in a card when the walk lands (until the visitor has moved, after five
    seconds at least, at most twenty), and with the suit's figures; a screen reader hears the title
    and the keys once (on a touch screen, the pad and the look instead), and no note talks over it.
  - The wheel, or a pinch, narrows the view to 20° (binoculars) or widens it to 90° from its 70°;
    it never narrows near Makkah below the framing rule (below). Each walk begins at 70°.
  - The time machine runs at most an hour a second on foot (and on the way down), so the day's
    light changes no faster than the eye follows it (never a strobe of day and night); the rate
    chosen is kept for orbit, and the readout says so.
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
  - on the Earth, the qibla: the great circle's bearing to the Kaaba from where the walker stands
    (degrees from true north, the function of the section on the qibla and the new moon), and how
    far to turn left or right from the heading to face it (within 2°, "straight ahead");
  - where the ground comes from, and what is illustrative.

  The readout leaves the view to the world: one line at the lower left (the title, the ground's
  height, the Sun's height and the local solar time), the figures folded under it on every screen
  (scrolling there if they must; the pad never scrolls away), the pad below it. On landing the
  navigator folds to its row of worlds (it opens again after, if it was open), the notes and the hint
  step aside, and the worlds' names show only as the stars come out (never on a daylit sky, and the
  Sun's never). On a phone the dock sits above the sheet and waits while the sheet is pulled up; the
  way back stays.
- **The horizon** stays level: on foot the view is not turned to frame the part of the screen the
  interface leaves clear (as it is from orbit), so looking up or down, or folding the navigator, never
  tilts it.
- **Makkah.**
  - No walk begins within 25 km of the Kaaba, and a step into that radius is refused, with a
    notice.
  - At 25 km or more, the view never narrows there below 30 km across, however it is zoomed. That
    keeps the 30 km framing rule (`MAKKAH_FRAME`) on foot as from above.

## How it is drawn

### The ground

`src/explore/walk/ground.ts` builds a geometry clipmap.

- **Rings.** 11 nested square rings of 48 × 48 cells. Point spacing runs from 8 m in the innermost
  ring to 8.2 km in the outermost, which reaches 196 km. That puts real ground on the horizon at
  every height a walker reaches.
- **Heights sharper than the points.** Each ring reads tiles whose pixels are half its spacing (a
  tile at the spacing's own size is an average over it, which rounds every cliff away), asked for
  once over the ring and then read point by point.
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
  - **Decoded from the file's own bytes** (`src/explore/walk/png.ts`: the browser's
    DecompressionStream inflates them, the five row filters are undone in script). No canvas is drawn
    or read back: a browser's fingerprinting guard may alter a canvas's read-back (Brave's does, by
    default, a few hundred bytes of each, which in a red byte is 256 m), and the ground grew spikes
    and pits there. Where the decoder cannot (no DecompressionStream, a kind of PNG it does not read),
    a canvas still decodes it, and any pixel standing half of 256 m or more above or below all eight
    neighbours that 256 m the other way puts back among them is mended.
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

- **Grain**, on every world: six octaves of gradient noise (MaterialX's Perlin, smooth at any
  magnification) from 6 cm to 51 m, each turned by the golden angle against the one before so that no
  direction lines up, in brightness and in relief; each kept while it spans 12 pixels or more.
- **The Earth's ground**, by its slope and the imagery's own colour: rock on the steep (a little paler
  and greyer than the imagery, banded by height in layers a few metres and a few tens of metres thick,
  wavering along the cliff, as the Grand Canyon's walls are), plants in tufts where the imagery is
  green, soil in warmer and cooler patches elsewhere. No stones: drawn as shading on ground that is
  flat at that scale, a low Sun stretched their shadows into dark streaks that read as spikes, and a
  high one made a pitted, lunar ground of their domes.
- **The sea** (the Earth's, where the tiles hold ground below sea level), at sea level as water: its
  own colour the imagery's, darkened; the sky in it by Fresnel's law (2% straight down, all of it at a
  grazing view); and the Sun's glint spread by waves (a GGX lobe of roughness 0.18) into a path of
  light toward a low Sun. Illustrative waves; the land below sea level is drawn as water too.
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
- **Stones** (not on the Earth): a scattering of grey ones on the Moon and Mercury (up to 1.2 m
  across), more, darker ones on Mars's dust (up to 1 m), and flat slabs on Venus (as the Venera
  landers' pictures show),
  each casting a shadow away from the Sun where the Sun is seen. They are left out on the lowest
  detail tier (they are the costliest part).
- A crater's shadow is drawn only where the crater spans enough pixels to show the rim that casts it,
  and is lit a little by the sunlit wall across it.
- **Fading.** Each octave fades out as its features near a pixel.
- **Relief is bump mapping.** It tilts the ground's shading but does not move the ground (a stone
  has no silhouette), the shading never tilts past a slope of about 56°, and it fades out where the
  ground is seen at a grazing angle (below about 3°, toward the horizon, where a pixel's change across
  the ground is no measure of a slope: the far ground glittered in a low Sun).

### Light and depth

`src/explore/walk/light.ts` holds the light on the CPU (it meters the eye and tints the Sun; the unit
tests check it); the shaders draw the same light per pixel (`./sky`, `./ground`, `./scatter`).

- **Sunlight.** The Sun's light at the world (1 at 1 au: Mars gets 0.43 of the Earth's, Venus 1.9,
  Mercury about 6.7) falls on each terrain normal, setting over the Sun's disc at the horizon on every
  world:
  - the Earth: through the explorer's own air (`../render/air`, Bruneton's reference atmosphere,
    every constant cited) on a clear day (its aerosols eight times the reference's exceptionally clean
    air: about 0.04 at 550 nm, illustrative), along the slant path with the planet's curve, from its
    own transmittance table: white high, yellowing, then red and dim at the horizon;
  - Mars: through a dust column of optical depth about 0.6, darker in the blue, across Kasten and
    Young's air mass (illustrative);
  - the Moon and Mercury: unfiltered; Venus: none as a beam.
- **The terrain's own shadows and the sky it hides** (horizon mapping, Max 1988). From every other
  point of each ring the highest angle the ground rises to in eight directions is marched out over the
  rings' heights to 60 km in steps growing by 45% (the world's curve counted), the best step then
  sought between its neighbours in seven golden-section steps (a crest or a cliff's foot falls
  between steps: to half a degree on a ridge or a cliff), and shared with the points between. A point is
  in the ground's shadow while the Sun is below its horizon toward the Sun (between the eight,
  interpolated), softened over the Sun's disc and a little more; the sky's light on it is the share of
  the sky its horizons leave open (a valley floor gets less than a summit).
- **The regolith** (the Moon and Mercury): McEwen's lunar-Lambert law (1991), Lommel and Seeliger's
  2 μ0 / (μ0 + μ) blended with Lambert's by the phase angle, so the ground is flat-lit and bright
  down-Sun; and an opposition surge at the shadow point (illustrative strength and width).
- **The sky's light.** The Earth's: half the vertical column's scattered sunlight comes down, bluish,
  through the twilight to a faint night (starlight and airglow); Mars's: its dust's, butterscotch;
  Venus's: all the light there is, orange, by the Sun's height; the Moon's and Mercury's: only a faint
  fill from the sunlit ground around.
- **The colours as albedos.** The Moon's, Mars's and Mercury's colour maps are pictures made for the
  eye; on foot each is scaled so its mean is the world's measured Bond albedo (NASA's fact sheets:
  0.11, 0.25, 0.068): the Moon is as dark as worn asphalt. The Earth's imagery is used as it is.
- **The air between** (aerial perspective). On the Earth each ground pixel's ray is marched through the
  same air as the sky's: the ground dimmed by it and the air's own light added, so the far ridges blue
  and, at sunset, the haze takes the Sun's colour. Beyond a few hundred metres (fully by 2 km) the
  land is held as the sky is (below), so at the horizon it never stands as a bright line under the
  sky above it. Mars's dust and Venus's deep air fade the distance
  into their skies' horizon colours over 12 and 4 km (illustrative); none on the Moon or Mercury.
- **The eye.** On foot the exposure is metered, as a camera's would be:
  - it adapts wholly to its world's sunlight (Mars's 0.43 of the Earth's, Mercury's 6.7), and to the
    illuminance on level ground there (Sun and sky together) to the power −0.85 by day, easing to
    −0.68 through the twilight (from the Sun about 5° up to the night's light), between 2^−3 and
    2^6: by day the ground sits near middle grey at any Sun height, a little darker as it sinks; the
    picture darkens through the whole twilight, not all at once after sunset; at night the eye opens
    no further, so the night stays dark and the stars show;
  - its meter (`src/explore/walk/meter.ts`) reads the ground in view, four times a second: the rings
    drawn into a picture of 32 × 18 of their own (before the exposure, the sky left out) and read
    back from the GPU without waiting, as the mean of their luminance's logarithm. Ground seen darker
    than a grey of 25% under the light on level ground is opened up by the ratio to the power 0.85
    (Apollo 11's dark mare and Jezero's floor are seen, not lost in shadow; a darker plain still a
    little darker), ground seen brighter than half a white level ground's (a slope turned to a low
    Sun) is stopped down the same way, at most two and a half stops either way; sand and snow on
    the level are left bright. Until it has read, the world's albedo stands in;
  - it changes through the explorer's flash-safe slew limiter, and jumps at the walk's dip.
- **The Sun.** The explorer's own disc, at its true size (0.53° across from the Earth: about 3 px of
  radius at 900 px over 70°), and its tight glare; on foot both take the air's colour on the way and
  dim with its luminance (to its 0.35 power), so the setting Sun is red and the noon Sun white; but
  the disc never shows dimmer than 3 on screen in luminance, six times the sky's ceiling, its core
  yellowing toward white when a deep red would need more than its ceiling of 6 (as an overexposed
  sunset's does): the setting Sun is always seen above the glow round it.
- **Depth.** Depth is logarithmic in the ground's material only, from 0.1 m to 2,000 km. The
  renderer keeps standard depth.

### The sky

`src/explore/walk/sky.ts`. Every sky is held under the bloom's threshold on screen, and under the
Sun's disc: above 0.3 its luminance (after the exposure) rises ever more slowly toward 0.5 (a pale
grey on screen, never white: luma under 200), its slope continuous at 0.3 and its approach a power
law with a long tail (a glow ten times brighter still shows a little brighter), its hue kept. Only
the Sun's disc and glare bloom; the sky round the Sun is never a blown-out white, at noon or at
sunset.

- **The Earth.** The same air as the ground's light, scattered along each pixel's ray from the
  walker's eye (16 steps, denser near the eye): single scattering by Rayleigh's and the aerosols'
  phases, each sample lit through the transmittance table (the planet's shadow included), and the
  light scattered more than once as each sample's share of the light around it (half the ground's,
  half the sky's, twice that for the higher orders: illustrative). Blue overhead, paler to the horizon,
  a glow round the Sun from the aerosols (at 10° about four times the zenith's brightness, as the CIE's
  standard clear sky has it), and at sunset the reds under the Sun, the Earth's shadow rising opposite,
  then the twilight as only the upper air is still lit. No clouds.
- **The Moon and Mercury.** No sky: the black sky and the explorer's real stars. By day the sunlit
  ground's glare leaves the eye only the brightest stars (`AIRLESS_DAY` in
  `src/explore/walk/daylight.ts`): the sky's brightest star is held at 0.4 in linear light on the
  screen (about 184 of 255), short of white, and every other star is dimmed with it. The hold is eased
  in as the eye adapts to the day. The planets' points and names keep about a third of their light. A
  share of the light alone no longer did it: the explorer's star light keeps faint stars above the tone
  curve's black and put the brightest near white (312 lit spots facing the Sun at Apollo 11's site,
  where there are now 2).
- **Venus** (illustrative): the underside of its cloud deck, brightest overhead by day, dark by
  night, its light dim and orange (the deep air takes the blue out of what the clouds let down).
  Neither the Sun's disc nor any star is drawn; the readout says where the Sun is.
- **Mars** (illustrative: no radiative transfer of its dust): butterscotch by day, warmer toward the
  horizon, with a blue glow about the Sun that strengthens as it sets (the dust scatters blue light
  forward, as the rovers' cameras show), dimming through twilight; lit by Mars's sunlight, its
  horizon about as bright as the sunlit ground below it.
- **Stars** (`src/explore/walk/daylight.ts`): the sky hides the stars, the planets' points and their
  names until the Sun is 4° down, and lets all of them through by 12°.

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
  - trees, buildings, or stones with silhouettes (the stones are shading only, and none on the Earth);
  - a land-and-water mask: the sea is water where the tiles hold ground below sea level, so land
    below it (the Dead Sea's shore, the Caspian's) is water too;
  - a finer geometry than 48 cells a ring, normals finer than its points, or heights read by their
    size on screen (a GPU clipmap, Losasso and Hoppe 2004): the far canyon walls are still smooth;
  - terrain shadows finer than every other point of a ring (16 m near the walker, 16 km at the
    horizon);
  - clouds in the walk's sky, weather, and Mars's dust storms;
  - the Earth in the Moon's sky as more than the explorer's globe.
- The eye's meter reads the ground's light, not the whole picture: looking at the sky alone it keeps
  its last reading of the ground.
- The walker climbs any slope and walks through what it cannot see; there are no collisions.
- The Earth's imagery is 2016's mosaic at about 10 m. Up close, the colour is that of a 10 m patch.
- Terrain accuracy is the source's own:
  - SRTM, about 30 m, with voids filled;
  - 3DEP, 1 to 10 m in the United States;
  - national models elsewhere;
  - GMTED and ETOPO in the far north and at sea;
  - LOLA and MOLA as averaged here.
- The Earth's sky is single scattering with an approximation of the rest; Mars's and Venus's skies
  are illustrative, not radiative-transfer models of their real air.

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
  - the PNG decoder: exact on the mocked tile and through all five row filters; a canvas read-back's
    256 m spikes and pits mended, a real cliff left alone;
  - heights read seamlessly across tiles, from coarser tiles until finer ones arrive, and no finer
    than a world's grids hold; failed tiles asked for again after a growing back-off, at once on
    Retry;
  - walks kept within the tiles' latitudes, and standing below a datum where there is no sea;
  - the walker's frame, its first-person look, a jump of v² / 2g on the Earth and on the Moon,
    walking speed, and a place it may not enter;
  - the suit's figures, and the Sun's azimuth;
  - the light: the Sun through the Earth's air (white high, red at 1°, gone below its disc); its disc
    on foot never under four times the sky's ceiling at any height, still red over green over blue;
    the sky (blue overhead, paler at the horizon, its glow round the Sun no plateau, red under the
    setting Sun, black at night); the sky held under the bloom at every Sun height 3° or more from
    the Sun, smooth at its knee, a glow ten times brighter still brighter; the eye's exposure
    (opening as the light fails, continuous, within its stops, wholly to its world's sunlight) and
    its meter (dark ground opened, bright level ground left, a sunward slope stopped down, at most
    METER.most); the regolith's lunar-Lambert law; the terrain's horizons over a ridge and a cliff
    within half a degree; the Sun's true size; the stars' fade.
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
- **`tests/explore/walk-stress.spec.ts`** (mocked flat terrain):
  - Esc pressed eight times a tenth of a second apart, held (its repeats), and during the landing:
    back to orbit and no further; a second later one Esc still leaves the explorer; with motion, Esc
    every quarter of a second through the dip and the climb, and Esc during the climb stops it there;
    on the way down through Venus's clouds, Esc eight times goes back to orbit and no further, and
    Space toggles the time machine;
  - landing and leaving ten times on the stepped clock, a picture each thirtieth of a second: the
    dips seen, never more than three flashes in a second (WCAG 2.3.1);
  - 300 pad presses, walks, ends and nonsense values on the pad in one frame, then 200 keys and 20
    drags: on the ground, every figure a number, time's play state untouched;
  - six walks begun and left, and ten Back to orbit clicks at once;
  - the controls' sense (drag, Space, Q and E, Step right, Run) and mouse-look; the rover (a second
    of V and W covers 25 m), the wheel's zoom (20° to 90°, never under Makkah's framing at 25 km),
    the look's sense chosen and kept; the time machine held to an hour a second on foot, and as
    chosen back in orbit;
  - at 1280 × 800, 1440 × 900, 2000 × 1300 and 1000 × 650 at two device pixels each: the way back in
    reach, every control inside the window and uncovered, none over another, no sideways scroll, no
    text cut off, the view taking the pointer, under a quarter of the view covered, the keys said,
    the figures opened and folded twenty times, the navigator folded and open again after;
  - a terrain host that never answers (Retry, and the way back focused; a click on the view while
    landing or unavailable takes no pointer, and Space stays the play key), and only coarse tiles (a
    coarse landing, said);
  - a walk asked for during a trip (the way back shown while it waits), dropped by Esc with the trip
    and by another world chosen;
  - the horizon level within 0.06° at five looks up and down, the navigator open and folded, and
    through twenty folds.
- **`tests/explore/walk-light.spec.ts`** (also in Brave; the interface hidden whole, its fades
  included):
  - the Sun's disc at its true size; at 50°, 20°, 5° and 1.5° up, at 1280 × 800 and 2000 × 1300,
    nothing in the sky at luma 200 or more beyond 75 and 120 px of the Sun, its disc at least 25
    above the sky round it, and at 1.5° that sky red over green over blue;
  - the ground's luma by day (the Sahara at noon 110 to 205; the Moon's mare and Jezero's floor
    above 90, below 130 and 170); the land seen after sunset; the night dark (mean under 25); the
    Moon's ground 3° after sunset dark (its 99th percentile under 20);
  - a day in four-minute steps facing north: no step's mean luma more than 25 from the last;
  - on a hill's slope facing a low Sun and a high one: no dark streaks (under 1% of the ground at a
    third of its median) and its detail within bounds (the stones that were taken away failed both);
  - a cliff (made per tile) shading the ground under it from an evening Sun 10° up that a morning Sun
    at the same height lights: the ground's luminance in the meter's reading 0.4 of the morning's or
    less;
  - the sea (made per tile): a path of light under a low Sun, the water beside it darker;
  - every point of every ring on the flat mocked ground within a metre of 1,000 m.
- **`tests/explore/mobile.spec.ts` (emulated phone):**
  - Forward held walks, a finger looks round, and Jump jumps;
  - the pad and the look said to a screen reader on landing, not the keys;
  - Step right and Run; at 390 × 844 and 844 × 390, with the figures open and the sheet pulled up,
    the way back on screen, every control a 44 px target inside the screen (the Rover too), none
    over another; turned ten times, Back to orbit ends the walk;
  - nothing is wider than the screen;
  - axe finds nothing.
- **`node --import tsx scripts/validate.ts`:** the four worlds' 36 height PNGs present at the sizes
  `heights.json` lists, and credited.
- **Captures checked by hand while building** (not committed): on the Earth at noon facing the Sun,
  across the Grand Canyon from Yavapai Point and down into it, at the feet, at sunset both ways, at
  dusk and at night; Gornergrat facing the Matterhorn; the Moon at Apollo 11 with the Sun behind and
  beside; Mars at Jezero; Mercury in Rachmaninoff; Venus at Venera 13.

## Next

- A GPU clipmap (about 255 cells a ring, heights in textures updated as the walker moves, geomorphing,
  normals from the next finer level per pixel, tiles chosen by their size on screen), so cliffs and
  buttes keep their edges at every distance; then true displacement near the walker (stones and crater
  rims with silhouettes), and land-cover materials up close.
- Finer heights where the sources allow them (a third level of tiles: LOLA and MOLA at 16 pixels a
  degree, MESSENGER's at 64; NAC and HRSC models at the landing sites), and past 85° of latitude (the
  Moon's south pole).
- GR-6: down through Venus's clouds and the giants' cloud decks in the suit, with cited profiles.
