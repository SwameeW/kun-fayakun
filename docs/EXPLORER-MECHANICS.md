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
- **Photo mode.** Only the view (H); H, Esc or "Show the interface" brings everything back.
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
- **The orbital laboratory** (Universe Sandbox's core, the brief's Phase 1). "Experiment with this
  system" forks the solar system at the explorer's date into an N-body integration in a worker: edit
  masses and velocities, add bodies (on a circular orbit or at a given state), duplicate and
  remove them, see trails and the path integrated ahead, watch conservation, and save, export,
  reset, go back to a checkpoint or replay. Collisions merge, with the energy accounted. The time
  machine drives its clock; leaving gives the real explorer back as it was.

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
3. **Down to the ground.** Real terrain near the surface (the Earth's terrain tiles, LOLA, MOLA), a
   view from the ground with the real sky, the next eclipses found from the ephemeris to fly to, and
   saved, shareable locations (place, view and time).
4. **Ship mode** (optional). Newtonian flight with thrust and gravity, and orbit prediction.

## Not planned

- **Invented objects shown as real.** SpaceEngine fills uncharted space with invented objects. The
  brief allows generated systems only where nothing is catalogued, deterministic (the same seed,
  the same world, however it is reached) and always marked "generated", never mixed into the
  catalogue's views or given measured-looking values (ledger IS-5). Anything else stays as observed.
- **SpaceEngine's music, addons, VR, aerodynamics and warp drives.** Outside this project's scope.
