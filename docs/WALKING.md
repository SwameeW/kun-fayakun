# On foot (ledger GR-5): the Earth first

The explorer's space-suit walk. This is the Earth's first slice: first person at human height, on
real terrain under the imagery the explorer already streams, with a suit's readout. The Moon, Mars,
Mercury and Venus follow (see [Next](#next-the-other-worlds)). The giant planets have no surface to
stand on; their atmospheres are GR-6.

## What a visitor does

- **Begin.** In the Living Earth panel, "Walk here" stands the visitor on the ground below the
  view. `app.earthCommand({ kind: 'walk', lat?, lon? })` does the same, or walks at a given place.
- **Landing.** The walk waits in orbit ("Landing: the ground here is loading…") until the terrain
  under the feet has loaded at zoom 9 or finer. The eye never starts inside a mountain.
- **Moving.**
  - Keys:
    - W A S D walk (1.4 m/s);
    - Shift runs (5 m/s);
    - R jumps (3.1 m/s upward, so about 0.49 m under the Earth's gravity);
    - the arrows turn and tip the look;
    - Esc or O goes back to orbit.
  - A drag looks round. The scene moves with the drag, as in a street-level photo viewer.
  - On a touch screen, Forward, Back and Jump buttons are held down as the keys are. A keyboard
    press on one takes a short step.
  - Zoom does nothing on foot (the field of view is fixed at 70°).
  - A trip elsewhere ends the walk: a world chosen, or a place flown to.
- **The suit's readout:**
  - the place;
  - the ground's height above sea level, and the distance walked;
  - gravity: 9.82 m/s², from the Earth's GM (DE440) at its mean radius;
  - the air's pressure at the feet: an isothermal atmosphere, 101.4 kPa × e^(−h / 8.5 km), from the
    sea-level pressure and scale height in NASA's Earth Fact Sheet;
  - the Earth's mean surface temperature, 15 °C, named as a mean and not today's;
  - the Sun's height, and the local solar time.

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
- **Seams.** Each ring hides where the ring inside it lies, and hangs a skirt from its edge.
- **Re-centring.** Each ring re-centres as the walker moves, snapped to its own spacing.
- **Refills.** At most two rings refill each frame:
  - moved rings first, finest first;
  - then rings whose heights have sharpened, the longest-waiting first.

  When the walk lands or re-anchors, every ring refills in the same frame.
- **Precision.** Positions are kept relative to an anchor near the walker, in the Earth's own
  frame, which keeps single precision at centimetres. The anchor moves after 20 km.

### Heights

`src/explore/walk/terrain.ts` reads the AWS Terrain Tiles.

- **Format.** Terrarium PNGs: height = R × 256 + G + B / 256 − 32768 m. Zoom runs to 15: 4.8 m per
  pixel at the equator, finer toward the poles (3.9 m at the Grand Canyon).
- **Zoom per ring.** Each ring reads tiles at the zoom its spacing needs.
- **Interpolation.** Heights are bilinear across tile edges, so there are no seams.
- **Fallback.** Coarser zooms stand in until finer tiles arrive. A count per zoom of the tiles
  returned tells the ground which rings are stale.
- **Decoding.** Tiles are decoded without colour conversion, so the bytes stay exact.
- **Cache.** 192 tiles, with 8 requests in flight.

### Colour

- **The globe's own colour.** The ground uses the globe's day map and the streamed Sentinel-2
  cloudless imagery, about 10 m per pixel at best. While walking, the imagery is aimed at the
  walker's feet; looking along the ground, the view's centre may miss the globe.
- **Grain.** Where the imagery's pixels are magnified, illustrative fine grain gives the ground
  texture down to about 5 cm.
  - The grain is four octaves of the explorer's noise volume, over the ground's own metres, in both
    brightness and relief.
  - Each octave fades out as its features near a pixel.
  - The texel interpolation is eased, so a magnified octave shows no facets.
  - The grain is drawn, not measured; the HUD says so ("illustrative grain up close").

### Light and depth

- **Sunlight.** The globe's sunlight model, after the air, falls on each terrain normal. A sky's
  fill is added, and a haze fades into the air's colour with distance (e-folding over 30 km).
- **Depth.** Depth is logarithmic in the ground's material only, from 0.1 m to 2,000 km. The
  renderer keeps standard depth.

### The sky

`src/explore/walk/sky.ts` uses Preetham, Shirley and Smits's daylight model, as three.js's SkyMesh
implements it. Here the local vertical is an input, and there are no clouds.

`src/explore/walk/daylight.ts` holds the day's light by the Sun's height:

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

The globe, the orbit lines, the satellites, the earthquakes, the place markers, the qibla layer and
the readout from orbit.

## Limits

- The sea, and land below sea level (the Dead Sea's shore, the Caspian), are drawn at sea level. The
  tiles hold the sea floor, and there is no land-and-water mask on the CPU yet.
- **Not drawn yet:**
  - trees, buildings or rocks (no data for them is used);
  - shadows cast by terrain onto terrain (a ridge does not shade the valley behind it);
  - clouds in the walk's sky;
  - weather.
- The walker climbs any slope and walks through what it cannot see; there are no collisions.
- The imagery is 2016's mosaic at about 10 m. Up close, the colour is that of a 10 m patch.
- Terrain accuracy is the source's own:
  - SRTM, about 30 m, with voids filled;
  - 3DEP, 1 to 10 m in the United States;
  - national models elsewhere;
  - GMTED and ETOPO in the far north and at sea.
- The sky and twilight are illustrative, not a radiative-transfer model of the day's real air.

## Credits

Terrain Tiles: the full attribution list the tiles require is in `data/sources.json`
(`aws-terrain-tiles`, shown on the Sources page) and section 13 of `LICENSES`. The walk's panel
credits them in short. The imagery is credited as from orbit.

## Tests

- **`tests/unit/walk.spec.ts`:**
  - the terrarium encoding, and Web Mercator tile arithmetic;
  - heights read seamlessly across tiles, and from coarser tiles until finer ones arrive;
  - the walker's frame;
  - a jump of v² / 2g on the Earth and on the Moon;
  - walking speed, and a place it may not enter;
  - the suit's figures;
  - the day's light: the stars' fade, the sky's adaptation, twilight, the ambient light and the
    haze.
- **`tests/explore/walk.spec.ts`, with mocked flat terrain at 1,000 m:**
  - landing, and the readout's figures;
  - walking, turning, jumping, and the on-screen pad;
  - back to orbit, as it was;
  - the refusal at Makkah;
  - a trip that ends a walk.
- **`tests/explore/mobile.spec.ts` (emulated phone):**
  - Forward held walks, a finger looks round, and Jump jumps;
  - every control is a 44 px target;
  - nothing is wider than the screen;
  - axe finds nothing.
- **Captures checked by hand while building** (real terrain and imagery, not committed):
  - Yavapai Point on the Grand Canyon's South Rim, looking north and down;
  - Gornergrat facing the Matterhorn, on Low and on a phone in portrait and landscape;
  - the canyon at sunset, at dusk both ways, and at night.

## Next: the other worlds

The same walk, given each world's figures (`WalkWorldFigures`: radius, gravity, air) and its own
ground. The order is set by the data:

1. **The Moon.**
   - Ground: LOLA's elevation model (about 118 m globally, finer near the poles), under the LRO
     colour the explorer already draws.
   - Gravity: 1.62 m/s², so a jump rises about 3 m.
   - Air: none, so the stars stay out by day.
2. **Mars.**
   - Ground: MOLA's elevation (about 463 m), with HRSC's finer models (50 to 100 m) where they
     cover.
   - Air: about 0.6 kPa, with its own sky colour (a butterscotch day, a blue sunset).
3. **Mercury.** MESSENGER's global elevation and mosaic.
4. **Venus.**
   - Ground: Magellan's radar altimetry and imagery.
   - Air: 9.2 MPa and about 464 °C at the surface. The suit's readout says so, and the light under
     the clouds is dim and orange (with the cloud deck in GR-6).

Each needs:

- tiles cut from its model, or a tiled service with open terms;
- its own sea level (its datum) for the readout;
- its own sky. With no air, the sky is black, with the Sun's glare.

Anything finer than the data is drawn procedurally and labelled so, as on the Earth.
