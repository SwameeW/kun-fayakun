# SpaceEngine's mechanics in the explorer

What [SpaceEngine](https://spaceengine.org/) does, mapped onto Kun Fayakun's solar-system explorer,
and the order the rest is built in. Read from spaceengine.org (its features page and the graphics
section of its user manual) on 2026-10-25.

One rule carries over from `docs/SPEC.md`: the explorer shows what has been observed and catalogued,
from cited data, and labels anything drawn beyond the data as illustrative. So it takes SpaceEngine's
mechanics, not its invented worlds.

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

## Planned, in this order (each from cited data)

1. **The real sky.** Stars from a public catalogue (the Yale Bright Star Catalogue or Hipparcos)
   with colours from their measured B-V, the Milky Way from NASA SVS's Deep Star Maps, IAU
   constellation figures and boundaries, IAU star names, celestial grids. Licences are confirmed
   before anything is fetched.
2. **Object information** (SpaceEngine's wiki). For each world: radius, mass, surface gravity,
   escape speed, day, year, orbit and atmosphere from cited constants, with a size comparison.
3. **More worlds.** The major moons (JPL's satellite mean elements; NASA and USGS maps), Pluto and
   Charon, Ceres and Vesta, the asteroid belt as points from JPL's small-body database, and comets.
4. **Beyond the Sun.** Flights to the nearest stars (catalogue parallaxes), systems with known
   exoplanets (NASA Exoplanet Archive), out of the Milky Way (the film's model), the Local Group,
   the SDSS cosmic web (Chapter 5's 420,000 galaxies) and the Planck CMB (Chapter 1): from a street
   on the Earth to the edge of the observable universe, without a cut.
5. **Down to the ground.** Real terrain near the surface (the Earth's terrain tiles, LOLA, MOLA), a
   view from the ground with the real sky, the next eclipses found from the ephemeris to fly to, and
   saved, shareable locations (place, view and time).
6. **Ship mode** (optional). Newtonian flight with thrust and gravity, and orbit prediction.

## Not planned

- **Procedurally generated stars, planets and galaxies.** SpaceEngine fills uncharted space with
  invented objects. The explorer invents none: past what is catalogued, space stays as observed.
- **SpaceEngine's music, addons, VR, aerodynamics and warp drives.** Outside this project's scope.
