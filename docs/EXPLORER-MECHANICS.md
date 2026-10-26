# SpaceEngine's mechanics in the explorer

What [SpaceEngine](https://spaceengine.org/) does, mapped onto Kun Fayakun's solar-system explorer,
and the order the rest is built in. Read from spaceengine.org (its features page and the graphics
section of its user manual) on 2026-10-25.

One rule carries over from `docs/SPEC.md`: the explorer shows what has been observed and catalogued,
from cited data, and labels anything drawn beyond the data as illustrative. So it takes SpaceEngine's
mechanics, not its invented worlds.

Since the Universe Sandbox and SpaceEngine brief, the explorer has two domains, kept apart: the
**real-data explorer** (this page's subject) and the **orbital laboratory** (`#/universe/lab`), a
sandbox where a copy of the system is changed and moved by its own gravity (`docs/LAB.md`). Nothing
done in the laboratory reaches the explorer's data, and the laboratory never presents its results
as observations. Every mechanic of both, with its status, is in `docs/FEATURE-LEDGER.md`.

## Already in the explorer

| SpaceEngine | The explorer |
|---|---|
| Select and fly ("G"), speed chosen automatically | Trips to any world, the distance falling through its orders of magnitude, light-time shown |
| Free, orbit and ship-like movement (WASD) | Orbit and free flight (W A S D, R F, Q E), Shift faster |
| Bound to a moving object; synced with its rotation | Orbiting follows each world; held over a place, the view turns with the Earth |
| Seamless zoom from orbit to the surface | Zoom anywhere on the Earth to about 10 m a pixel, through a lens below the lowest orbit (Living Earth) |
| Orbit lines, labels, markers | Orbit lines, names, the crewed stations, the field notes' places |
| Map of the planetary system | The navigator's orrery |
| Search by name | Place search on the Earth (Natural Earth) |
| Real Solar System bodies and terrain from probes | Ten worlds from JPL ephemerides; NASA, USGS and NOAA maps with relief |
| Graphics presets | Low, Medium, High and Ultra detail, with an automatic governor |
| Realistic lighting and atmospheres | Sunlight falling off with distance, eclipses of the Sun by nearer bodies, the Earth's air at the limb |
| Live data | Every active satellite (CelesTrak, SGP4) and the past day's earthquakes (USGS) |

## Added in this stage

- **Time machine.** Pause (Space), slower and faster ([ and ], real time to thirty days a second),
  backwards (\\), a date to go to, and back to now. Everything follows the clock: orbits, the
  Moon's phase, each world's turn, day and night, eclipses, the day's imagery of the Earth. It
  stops at the ends of the Moon's table (2026 to 2035) and runs at real time during a trip.
  Satellites show up to 600 times real time, and earthquakes only near the present.
- **Photo mode.** Only the view (H); H, Esc or "Show the interface" brings everything back. "Save
  the picture" (ledger CR-1) saves the view as drawn, as a PNG named for the place and the date, with
  its credits set in a band below it, never over it: where and when, what in it is illustrative, whose
  imagery and data it shows (the lines the readouts carry: the planet maps', the streamed imagery's
  with EOX's link, a walk's or a descent's, the stars'), and the app with its Sources page.
- **Object information** (SpaceEngine's wiki). "About" the world in view, in the navigator: radius,
  mass, density, gravity, escape speed, its day (one turn, and sunrise to sunrise), year, orbit,
  axial tilt, how far it is now, and a size comparison to scale beside the Earth. The planets'
  numbers are JPL's "Planetary Physical Parameters" as given; the Sun's and the Moon's come from
  DE440's GM and NAIF's radii.
- **The real sky** (SpaceEngine's planetarium). The procedural backdrop is gone: behind the worlds
  are the Bright Star Catalogue's 9,096 naked-eye stars at their real places, colours (from B-V) and
  brightness, so the planets stand in their real constellations. Switches in the navigator show the
  constellation figures and names, the brightest stars' IAU names, the IAU boundaries, and a grid
  with the celestial equator and the ecliptic. The Milky Way's glow waits for an all-sky map with a
  clear licence.
- **The qibla and the new moon** (`docs/ISLAMIC-ASTRONOMY.md`). The qibla from any place, drawn as a
  great circle on the globe; the four moments a year the Sun stands over the Kaaba or the point
  opposite it, each a moment to go to; the golden latitude beside the Kaaba's, at its actual size;
  new moons, and the new crescent's map by Yallop's test for the evenings after one; the date in
  the Umm al-Qura calendar; and the observatories and tiles of the Islamic world's astronomers and
  geometers. All from the explorer's ephemeris, checked against published times.
- **The orbital laboratory** (Universe Sandbox's core, the brief's Phase 1). "Experiment with this
  system" forks the solar system at the explorer's date into an N-body integration in a worker: edit
  masses and velocities, add bodies (on a circular orbit or at a given state), duplicate and
  remove them, see trails and the path integrated ahead, watch conservation, and save, export,
  reset, go back to a checkpoint or replay. Collisions merge, with the energy accounted. The time
  machine drives its clock; leaving gives the real explorer back as it was.
- **On foot on the Earth** (SpaceEngine's surface view, and the brief's space suit, ledger GR-5;
  `docs/WALKING.md`). "Walk here" stands the visitor on the ground below: first person at 1.7 m,
  walking, running and jumping at the Earth's gravity, on the Terrain Tiles' heights out to the
  horizon under the streamed imagery, with the day's sky, its twilight and the stars at night. The
  suit reads out the ground's height, gravity, the air's pressure at the feet and the Sun's height.
  Makkah's 25 km rule holds on foot.

- **Saved views** (ledger GR-4): the navigator keeps views under a name in this browser: the world,
  the place beneath the camera, the height and the date, or on foot the walk (its place, heading and
  look). Going back to one sets its date, travels to its world if the camera is elsewhere, glides
  over its place, and on foot begins the walk again (`src/ui/explore/saved-views.ts`).

- **Sound where there is air** (ledger CR-6; `src/explore/sound.ts`). Space is silent, and so is the
  explorer there. On foot on a world with air, and on the way down through Venus's or Jupiter's, the
  wind: noise as loud as the air's dynamic pressure (half its density times the wind's speed squared;
  the density at the feet from the pressure there, the world's mean temperature and its air's molar
  mass, by the ideal gas law, from `data/constants.json`; on the way down, the probe's own density and
  wind), and as bright as the air lets high pitches carry (Mars's thin carbon dioxide takes them first,
  as Perseverance's microphones found: Maurice et al. 2022). The walks' breeze is illustrative (5 m/s
  on the Earth and Mars, 1 m/s on Venus): they know no wind. On the Moon and Mercury, only the suit's
  own fans, as the Apollo crews heard theirs. No music, no voice; it plays through the app's ambient
  bus, so a recitation silences it, and begins only after the visitor first touches the page (as
  browsers require). "Sound" at the navigator's foot turns it off, and the choice is kept in this
  browser.

## Planned, in this order (each from cited data)

1. **More worlds.** The major moons (JPL's satellite mean elements; NASA and USGS maps), Pluto and
   Charon, Ceres and Vesta, the asteroid belt as points from JPL's small-body database, and comets.
2. **Beyond the Sun.** Flights to the nearest stars (catalogue parallaxes), systems with known
   exoplanets (NASA Exoplanet Archive), out of the Milky Way (the film's model), the Local Group,
   the SDSS cosmic web (Chapter 5's 420,000 galaxies) and the Planck CMB (Chapter 1): from a street
   on the Earth to the edge of the observable universe, without a cut. The sky now supplies the
   stars' directions only. Travelling among them also needs their distances (parallaxes, one
   identity per star so the sky never draws a star twice) and hierarchical coordinates (galaxy,
   system, body and surface frames, each in Float64, giving small camera-relative values to the
   GPU): the explorer's kilometre floating origin cannot simply be stretched to light-years
   without losing the precision of the surface.
3. **Down to the ground.** On foot on the Earth is in ([WALKING.md](WALKING.md)): the Terrain
   Tiles under the streamed imagery, at the Earth's gravity, with the day's sky. Still to come: the
   same walk on the Moon (LOLA), Mars (MOLA, HRSC), Mercury and Venus; the next eclipses found from
   the ephemeris to fly to; saved, shareable locations (place, view and time); and down through the
   atmospheres of Venus, Titan and the giant planets (ledger GR-5, GR-6), in as much detail as the
   data hold, with anything finer labelled as drawn.
4. **Ship mode** (optional). Newtonian flight with thrust and gravity, and orbit prediction.

## Not planned

- **Invented objects shown as real.** SpaceEngine fills uncharted space with invented objects. The
  brief allows generated systems only where nothing is catalogued, deterministic (the same seed,
  the same world, however it is reached) and always marked "generated", never mixed into the
  catalogue's views or given measured-looking values (ledger IS-5). Anything else stays as observed.
- **SpaceEngine's music, addons, VR, aerodynamics and warp drives.** Outside this project's scope.
