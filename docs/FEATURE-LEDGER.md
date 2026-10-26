# Feature ledger

Every mechanic the Universe Sandbox and SpaceEngine brief asks for (Universe Sandbox: US;
SpaceEngine: SE), with the approximation chosen or needed, what it depends on, how it will be
accepted, and where it stands. Written 2026-10-25, with the orbital laboratory's first slice.

Statuses: **implemented** (in the code, with the tests named), **partial** (some of it, the rest
named), **planned** (designed enough to start, in phase order), **research needed** (the model,
data or licence is not settled), **deferred** (wanted, not soon), **not planned** (out of scope).
A stub or an animation standing in for a model is never "implemented".

Phases follow the brief's roadmap: 1 orbital laboratory, 2 impacts and debris, 3 worlds that
respond, 4 orbit to ground, 5 interstellar, 6 stars and extremes, 7 spacecraft, 8 creative
platform.

## Explorer foundations (real data, already shipped)

| ID | Feature | Model / data | Acceptance | Status |
|---|---|---|---|---|
| EX-1 | Ten worlds at their real places | JPL approximate elements, Horizons Moon table, IAU rotation | `tests/unit/ephemeris.spec.ts`, `tests/explore/five-planets.spec.ts` | implemented |
| EX-2 | True scale from orbit to the surface | Float64 km, floating origin, scaled space | `tests/unit/origin.spec.ts`, `tests/unit/scaled-space.spec.ts`, `tests/explore/route.spec.ts` | implemented |
| EX-3 | Trips, orbit and free flight (SE "go to") | Distance-scaled speeds, light-time | `tests/unit/flight.spec.ts`, `tests/explore/travel.spec.ts` | implemented |
| EX-4 | Time machine | `src/explore/time.ts`, 1 s/s to 30 d/s, within the data's span | `tests/unit/time.spec.ts`, `tests/explore/time.spec.ts` | implemented |
| EX-5 | Photo mode | Interface hidden, H and Esc | the same | implemented |
| EX-6 | Object information, size comparison (SE wiki) | JPL physical parameters, DE440 GM | `tests/unit/about.spec.ts`, `tests/explore/about.spec.ts` | implemented |
| EX-7 | The real sky (SE planetarium) | BSC5 directions, B-V colours, IAU names, constellations | `tests/unit/sky.spec.ts`, `tests/explore/sky.spec.ts` | implemented (directions only: see IS-2) |
| EX-8 | Living Earth (daily imagery, satellites, earthquakes) | GIBS, CelesTrak SGP4, USGS | `tests/unit/living-earth.spec.ts`, `tests/explore/living-earth.spec.ts` | implemented |
| EX-9 | Detail tiers with a governor | Low to Ultra | `tests/unit/detail-governor.spec.ts`, `tests/explore/quality.spec.ts` | implemented |

## Islamic astronomy (explorer, real data)

| ID | Feature | Model / data | Acceptance | Status |
|---|---|---|---|---|
| IA-1 | Qibla from any place, its great circle on the globe | Spherical great circle to Wikidata's Kaaba | `tests/unit/islamic.spec.ts` (published bearings; travelling the bearing reaches the Kaaba), `tests/explore/islamic.spec.ts` | implemented |
| IA-2 | The Sun over the Kaaba and over its opposite point | Daily transits from the ephemeris | the same (announced 2026 times, within seconds; the explorer's Sun over the Kaaba then) | implemented |
| IA-3 | The golden latitude beside the Kaaba's | WGS 84 meridian arcs | the same (quarter meridian; ratio; 8.7 km) | implemented |
| IA-4 | New moons and the new crescent's map | Yallop's q-test at the best time | the same (Espenak's 2026 new moons; Ramadan 1447 reports) | implemented |
| IA-5 | The Umm al-Qura date | ICU's islamic-umalqura | the same (Ramadan and Shawwal 1447) | implemented |
| IA-6 | Astronomers and geometers of the Islamic world | Wikidata places, cited notes | the same | implemented |
| IA-7 | Al-Sufi's "little cloud" named on the sky | The Andromeda Galaxy's position from SIMBAD (2MASS), named with the stars' names | `tests/unit/islamic.spec.ts` (named only with the names; 1.345 degrees from nu Andromedae in the sky's catalogue) | implemented |
| IA-8 | Star names from Arabic astronomy | Etymologies from a licensed source; the IAU's catalogue of star names (2022) has none yet ("WGSN is working to add brief summaries of etymological information") | Every name cited | research needed |
| IA-9 | Prayer times | Ten published conventions (PrayTimes.org's list, each its institution's) and both reckonings of Asr, chosen in the panel; times in UTC for the place in view; high-latitude rules not shown; awaiting the scholar's review (REVIEW.md) | `tests/unit/islamic.spec.ts` (the Sun's times within the USNO tables' rounding; each convention's depressions, Asr's shadows, Umm al-Qura's interval, the short nights), `tests/explore/islamic.spec.ts` | implemented |
| IA-10 | Other crescent criteria (Odeh, SAAO), weather | Odeh's test (Experimental Astronomy 18, 2004) beside Yallop's, chosen in the panel; SAAO (a curve read from a figure) and weather not implemented | `tests/unit/islamic.spec.ts` (Odeh's zone bounds; Ramadan 1447 by both tests; topocentric inputs), `tests/explore/islamic.spec.ts` (the map recoloured by Odeh's zones) | partial |

## Phase 1: orbital laboratory (US)

| ID | Feature | Model / approximation | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| SB-1 | Fork the system at the explorer's date | Ephemeris positions, ±1 h central-difference velocities, DE440 GM, barycentric | EX-1 | `sim.spec` solar seed | implemented |
| SB-2 | Own route and return path | `#/universe/lab`, `app.openLab`/`closeLab` | router | `lab.spec` round trips | implemented |
| SB-3 | Provenance of the seed | `origin`, `sourceIds`, `seedNote`; "not a prediction" on screen | SB-1 | `lab.spec` | implemented |
| SB-4 | Float64 worker, tested integrator | KDK leapfrog, timescale step control | none | `sim.spec` (orbit, convergence, Kepler, RK4) | implemented |
| SB-5 | Pause, speeds, achieved rate | The explorer's time machine drives it; backwards by checkpoints only | EX-4 | `lab.spec` (pause stops the physics) | implemented |
| SB-6 | Select, edit mass | Logged intervention; drift measured from it | SB-4 | `sim.spec` mass edit, `lab.spec` | implemented |
| SB-7 | Add a body | Circular orbit about any body, or state relative to it | SB-6 | `sim.spec` satellite, `lab.spec` | implemented |
| SB-8 | Velocity, trails, finite-horizon prediction | Copy integrated ahead with the same rules, drawn about the primary; redone after edits | SB-4 | `sim.spec` prediction, `lab.spec` | implemented |
| SB-9 | Remove, duplicate, reset; stable ids; safe camera | Fresh ids; the Sun persistent; camera moved off a removed world | SB-6 | `lab.spec` | implemented |
| SB-10 | Contacts | Swept closest approach; perfectly inelastic merger, heat accounted | SB-4 | `sim.spec` merger, tunnelling | implemented |
| SB-11 | Save, load, export, import, checkpoints, replay, branching | Start + edit log; IndexedDB; validated JSON | SB-4 | `sim.spec` replay, branch, imports; `lab.spec` | implemented |
| SB-12 | Conservation readout | Relative drift since the last edit | SB-4 | `lab.spec` | implemented |
| SB-13 | Two laboratories | Star and planet; star and two planets | SB-4 | `lab.spec` collision | implemented |
| SB-14 | Desktop WebGPU, WebGL2, Brave, phone, keyboard, reduced motion | | | `lab.spec`, `mobile.spec` | implemented |
| SB-20 | Searchable Add palette by kind (stars, giants, moons, comets...) | Typed presets with cited parameters (`src/sim/presets.ts`: JPL satellite and planetary parameters, the Small-Body Database, published stellar masses and radii) | SB-7 | Each kind's values cited; added body valid | implemented (`lab-tools.spec`) |
| SB-21 | Add at the cursor with a placement preview | The pointer's ray meets the plane of the primary's orbit; a circular orbit there; a preview and distance under a mouse | SB-7 | Placed where previewed | implemented (`lab-tools.spec`) |
| SB-22 | Orbital elements in and out (a, e, i, apsides, period) | Osculating elements about the primary (`src/sim/elements.ts`, Vallado's RV2COE and COE2RV) | SB-8 | Round trip elements to state to elements | implemented (`elements.spec`, `lab-tools.spec`) |
| SB-23 | Drag a velocity, impulse with units | The arrow's tip dragged across the plane facing the camera; a push in m/s along, out of and away (prograde, normal, radial) | SB-21 | Logged as setVelocity | implemented (`lab-tools.spec`) |
| SB-24 | Multi-select, rename, save as preset | Ticks to duplicate or remove several; rename logged; a library by name in IndexedDB | SB-11 | Presets survive reload | implemented (`lab-tools.spec`) |
| SB-25 | Radius and density edits with lock rules | Two of mass, radius, density held, the third derived (`setRadius` may carry the mass) | SB-6 | No incompatible triple | implemented (`lab-tools.spec`) |
| SB-26 | Spin and axial tilt edits | Rigid rotation: spin angular momentum k M R² ω with the fact sheets' moments of inertia; kept through mergers; a world whose spin is set is drawn turning as set | SB-25 | Period and tilt as set; the seeded Earth tilted 23.44° | implemented (`lab-engine.spec`, `lab-tools.spec`) |
| SB-27 | Undo and redo | From the edit log and the checkpoint before each edit (also when several share a step) | SB-11 | Undo restores state bit for bit | implemented (`lab-engine.spec`, `lab-tools.spec`) |
| SB-28 | Fixed-body constraints | Held: no velocity, no force felt; the checks say conservation is off while it holds | SB-4 | Momentum budget shows the constraint | implemented (`lab-engine.spec`, `lab-tools.spec`) |
| SB-29 | Encounter markers and an accuracy control on predictions | Closest approaches along the path (each other body's interior minimum), marked and listed; the prediction's step four times finer or coarser | SB-8 | | implemented (`lab-engine.spec`, `lab-tools.spec`) |
| SB-30 | Camera frames: inertial, body-fixed, two-body co-rotating | Paths drawn about each primary, in the scenario frame, turning with a pair, or turning with the primary's own rotation (over its ground); never the physics | SB-8 | Trajectories identical across frames | implemented (`lab-tools.spec`) |
| SB-31 | Lagrange points | The five points of a pair at its present separation (collinear ones by Newton's method), drawn and labelled; a body placed at one co-rotating | SB-30 | L4/L5 Trojan stays | implemented (`elements.spec`: equilibria, a Trojan at Jupiter's L4 for ten Jovian years) |
| SB-32 | Roche-limit and spin-breakup indicators | Rigid and fluid Roche limits, breakup period, said when crossed | SB-25 | | implemented (`elements.spec`, `lab-tools.spec`) |
| SB-33 | J2 and tidal spin | J2 about the spin axis with its reaction and torque (axis precession), the fact sheets' J2s; tidal disruption inside the fluid Roche limit (a ring of pieces and dust, [CLIMATE.md](CLIMATE.md#tidal-disruption-sb-33)) | SB-26 | Precession rate against theory; disruption's accounting | partial (J2 and tidal disruption done, 2026-10-26; tidal friction and spin-down research needed: each world's tidal lag is not settled enough to cite) |
| SB-34 | Measurements (distance, angle, light time, angular size) | Between any two bodies, and an angle seen from a third | SB-8 | | implemented (`elements.spec`, `lab-tools.spec`) |
| SB-35 | Graphs over time that survive a merger | A tracked quantity per id, following the survivor through a merger; coarsening, never ending | SB-12 | | implemented (`lab-tools.spec`) |
| SB-36 | Pinned external reference fixture | REBOUND 5.2.2 IAS15, one year of the seed (data only; the code is GPL) | SB-4 | Fixture hash and agreement recorded | implemented (`rebound.spec`; `docs/LAB.md` gives the agreement) |
| SB-37 | Share link for small scenarios | Seed + log deflated into the URL (up to 8,000 characters) | SB-11 | | implemented (`lab-tools.spec`) |

## Phase 2: impacts and debris (US)

| ID | Feature | Model / approximation | Depends on | Status |
|---|---|---|---|---|
| IM-1 | Outcome by regime (merge, partial accretion, hit-and-run, erosion, super-catastrophic) | Leinhardt and Stewart (2012) scaling laws (`src/sim/impacts.ts`, `docs/IMPACTS.md`), used by the engine at every contact | SB-10 | implemented |
| IM-2 | Impact heating and a persistent surface mark | Heat already accounted (SB-10); the impact's energy (½ μ v² at contact) reported in megatons of TNT; the crater drawn where it struck, turning with the world, on the Earth (land), the Moon, Mercury and Mars (`src/explore/bodies/marks.ts`), its floor glowing while the melt is hot (illustrative, flash-safe) | IM-1, WR-1 | implemented (2026-10-26: `tests/explore/lab.spec.ts`, internal visual QA); the hit world's heating beyond the crater with WR-2 |
| IM-3 | Crater geometry | Collins, Melosh and Marcus (2005) crater scaling (`src/sim/craters.ts`, `docs/IMPACTS.md`): the final diameter, simple or complex, its depth (breccia lens; Herrick et al. 1997, scaled by gravity to Pike's 1977 lunar fit) and rim, for every cratering impact on a solid world, drawn as relief on the world | GR-1 | implemented (2026-10-26: `tests/unit/craters.spec.ts`, `tests/explore/lab.spec.ts`); on the walk's terrain with GR-5 |
| IM-4 | Bounded physical ejecta, separate decorative dust | Fragments as bodies (the second remnant and up to six debris), the rest returned to the remnant, launched at Chambers's (2013) 1.05 times the mutual escape speed; a decorative dust plume (points, a few seconds of the wall clock, no part of the physics) at each impact | IM-1 | implemented (2026-10-26: `tests/unit/impacts.spec.ts`, internal visual QA) |
| IM-5 | Reaccretion | Fragments under gravity merge back: the engine's own contacts, every piece a body | IM-4 | implemented (2026-10-26: `tests/unit/impacts.spec.ts`, a Mars-mass impactor's remnant falling back) |
| IM-6 | Rings and belts: decorative, test particles, gravitating | Three explicit classes: Saturn's drawn rings decorative (said so in the laboratory); belts and rings of up to 2,000 test particles (4,000 in all) carried about their primary on exact conics with kicks from everything else, J2 included (Wisdom and Holman 1991; `src/sim/swarms.ts`, `src/sim/kepler.ts`); a gravitating ring of up to 24 bodies | SB-4 | implemented (2026-10-26: `tests/unit/kepler.spec.ts`, `tests/unit/swarms.spec.ts`, `tests/explore/lab-tools.spec.ts`) |

## Phase 3: worlds that respond (US)

| ID | Feature | Model / approximation | Depends on | Status |
|---|---|---|---|---|
| WR-1 | Materials with sourced properties | Mass fractions per reservoir | none | partial (2026-10-26: Bond albedos, surface pressures, the air's main gases and the hydrosphere's mass from the fact sheets; interiors and reservoirs research needed) |
| WR-2 | Global energy balance from the active light sources | Absorbed flux, emission, heat capacity: North, Cahalan and Coakley's (1981) model for the Earth, a calibrated grey atmosphere elsewhere, every star's light (`src/sim/climate.ts`, [CLIMATE.md](CLIMATE.md)) | ST-2 | implemented (2026-10-26: `tests/unit/climate.spec.ts`, `tests/explore/lab-tools.spec.ts`) |
| WR-3 | Surface grid: latitude, seasons, day and night | Eighteen latitude bands, the day's mean light by season from each world's spin axis, stepped daily after gravity | WR-2 | implemented, the day's mean (no day and night within it) |
| WR-4 | Water and ice inventories, phase changes | Ice where the year is below -10 C (with its albedo's feedback: snowball and hysteresis), liquid water where it could lie (triple point to boiling at the pressure) | WR-1 | partial (ice and where liquid could be, 2026-10-26; the water's inventory moving between reservoirs not modelled) |
| WR-5 | Atmospheres (thin and thick, greenhouse labelled) | Parameterised greenhouse: a grey atmosphere calibrated to the measured mean, or a forcing on the Earth's (CO2 doubled: 3.93 W/m^2, IPCC AR6); thickened, thinned or given (logged edits) | WR-1 | implemented (2026-10-26) |
| WR-6 | Data views (temperature, liquid, pressure, composition) | The Climate section (starlight, temperatures, ice, liquid water, greenhouse, pressure, gases) and a temperature map on the globe (`src/explore/bodies/climate-view.ts`) | WR-3 | implemented (2026-10-26) |
| WR-7 | Winds | Only with tested conservation | WR-5 | research needed |

## Phase 4: orbit to ground (SE)

| ID | Feature | Model / data | Depends on | Status |
|---|---|---|---|---|
| GR-1 | Terrain height query with a datum | LOLA, MOLA, the Earth's terrain tiles | none | implemented for walking (2026-10-26: `src/explore/walk/terrain.ts` and `equirect.ts`, heights above the Earth's sea level, the Moon's 1,737.4 km sphere and Mars's areoid; `tests/unit/walk.spec.ts`, `tests/unit/equirect.spec.ts`) |
| GR-2 | Terrain LOD without cracks at seams and poles | Screen-error patches | GR-1 | partial: the walk's clipmap meets ring to ring with no step or slit (transition regions, skirts; 2026-10-26, [WALKING.md](WALKING.md)); not yet past 85° of latitude, where the Web Mercator tiles stop |
| GR-3 | Descent, surface-follow, back to orbit | Camera clearance from GR-1 | GR-2 | implemented with the walk (2026-10-26; [WALKING.md](WALKING.md)): a glide down over the place to the lowest orbit while the ground loads, a dip into the walk and back out, climbing back to the orbit it left (a reduced-motion cut's veil, the exposure jumping while dark); `tests/explore/views.spec.ts`. The orbit camera keeps its lowest heights (150 km over the Earth, 2% of the radius elsewhere): the walk is the close view |
| GR-4 | Saved places and views (place, view, time) | | GR-3 | implemented (2026-10-26: the navigator's Saved views, `src/ui/explore/saved-views.ts`: the world, the place below, the height and the date, or on foot the walk and its heading, kept in this browser; gone back to by a trip and a glide, a walk begun again; `tests/explore/views.spec.ts`) |
| GR-5 | On foot in a space suit on every solid world, the Earth first and in the most detail: first person at human height, walking and low-gravity bounding at each world's surface gravity, a suit readout (gravity, pressure, temperature range, sunlight, local time), the real sky overhead | Terrain from real elevation data (for the Earth, a 30 m global elevation model under the Sentinel-2 imagery the explorer already streams; LOLA for the Moon, MOLA and HRSC for Mars, MESSENGER for Mercury, Magellan for Venus), screen-error detail down to the boots; anything finer than the data drawn procedurally and labelled so. Around Makkah the 30 km framing rule holds on foot too | GR-1, GR-2, GR-3, WR-5 | implemented on all five solid worlds (2026-10-26; [WALKING.md](WALKING.md): the Earth's Terrain Tiles under the Sentinel-2 imagery; the Moon's LOLA, Mars's MOLA, Mercury's MESSENGER and Venus's Magellan heights; illustrative grain, craters and stones up close, labelled so; each world's gravity, air or vacuum and sky, Venus's overcast hiding the Sun; the 25 km Makkah rule on foot; `tests/explore/walk.spec.ts` at Apollo 11's, Perseverance's and Venera 13's landing sites and in Rachmaninoff basin). Not yet: HRSC's finer Mars models, heights finer than 8 pixels a degree, walks past 85° of latitude |
| GR-6 | Into the atmospheres in the suit: down through Venus's clouds, Titan's haze and the giants' cloud decks (which have no surface), with pressure, temperature and wind from probe data | Cited profiles (Venera and Pioneer Venus, Huygens, the Galileo probe); light and haze drawn from them | WR-5, GR-3, IS-1 for Titan | implemented for Venus and Jupiter (2026-10-26; [ATMOSPHERES.md](ATMOSPHERES.md): the Pioneer Venus Day and Large Probes' and the Galileo probe's pressure, temperature and density, their nephelometers' clouds and Galileo's winds, from NASA's PDS; the fall, a depth slider, the haze and light drawn from the clouds above and below (illustrative), the Sun only through them; on Venus down to the ground and into the walk; `tests/unit/descent.spec.ts`, `tests/explore/descent.spec.ts`). Titan waits for Titan (IS-1); no probe has gone into Saturn, Uranus or Neptune |

## Phase 5: interstellar (SE)

| ID | Feature | Model / data | Depends on | Status |
|---|---|---|---|---|
| IS-1 | Hierarchical coordinates (galaxy, system, body, surface) | Sector plus local Float64 frames, small camera-relative values for the GPU | none | implemented (2026-10-26, [NEIGHBOURHOOD.md](NEIGHBOURHOOD.md)): one double-precision frame from a hundredth of an au to ten billion parsecs, each layer drawn camera-relative (the stars' points each frame, the galaxy's and the survey's by moving their layer), beside the solar system's floating origin in km and the walks' anchored ground |
| IS-2 | Distances for the stars | Parallaxes (Hipparcos or Gaia, licence to check). The sky now has directions only | IS-1 | implemented (2026-10-26): the Hipparcos new reduction's parallaxes for every Hipparcos star within 25 pc and the Bright Star Catalogue's stars (10,193), each placed only where its parallax is known to a fifth; ESA's and CDS's terms (acknowledgement) recorded |
| IS-3 | Nearby stars as places to fly to, without double drawing the sky's stars | One identity per star | IS-2 | implemented (2026-10-26): "Among the stars", its own scene (the solar system's sky not drawn there), every star one point as bright as it looks from the camera, flights between them; `tests/explore/stars.spec.ts` |
| IS-4 | Known exoplanet systems | NASA Exoplanet Archive; unknown values never shown as measured | IS-3 | implemented within 20 pc (2026-10-26): the archive's composite parameters for 183 systems, every calculated value marked and M sin i masses as lower limits; orbits drawn face-on to the Sun (tilted where the inclination is measured), places on them illustrative |
| IS-5 | Generated systems where nothing is catalogued | Deterministic hierarchical seeds, versioned rules, always marked "generated" | IS-1 | planned (only labelled, only beyond the catalogues) |
| IS-6 | Clusters, nebulae, the Milky Way, the Local Group, the cosmic web | The film's SDSS and Planck data where they apply | IS-1 | implemented but clusters and nebulae (2026-10-26, [NEIGHBOURHOOD.md](NEIGHBOURHOOD.md)): the Milky Way as a model from Reid et al. 2019's arms (continued to the published tangents within 0.3 degrees) and Bland-Hawthorn and Gerhard 2016's disc and bar, labelled a model; McConnachie 2012's 101 galaxies of the Local Group, the four largest at SIMBAD's sizes; the film's 420,000 SDSS galaxies; places to go and galaxies by name; `tests/unit/beyond.spec.ts`, `tests/explore/stars.spec.ts` |
| IS-7 | Navigator hierarchy, search, bookmarks, history | | IS-3 | partial (2026-10-26): the stars' search (IAU names, hosts, HIP and HR numbers), the nearest stars as links, saved views (GR-4) for the solar system; not yet a history of places visited |

## Phase 6: stars and extremes (US)

| ID | Feature | Model | Depends on | Status |
|---|---|---|---|---|
| ST-1 | Star parameters (mass, radius, luminosity, temperature) | Cited relations, valid ranges stated | none | partial (2026-10-26): every placed star's temperature (Ballesteros 2012 from B-V) and light in V against the Sun's; a planet host's radius, mass and luminosity as the Exoplanet Archive gives them (`tests/explore/stars.spec.ts`); masses from relations (Eker et al. 2018) wait for a bolometric correction to cite |
| ST-2 | Several light sources; a star that does not shine | Light from the model, not a fixed Sun | ST-1 | planned |
| ST-3 | Binaries, double sunsets, circumbinary worlds | | ST-2 | planned |
| ST-4 | Evolution tracks and an HR diagram | Cited tracks or labelled interpolation | ST-1 | partial (2026-10-26): the Hertzsprung-Russell diagram of the 9,140 stars Hipparcos places with a colour, the Sun and the star in view marked (`tests/explore/stars.spec.ts`); evolution tracks need cited tracks (MIST or PARSEC, licence to check) |
| ST-5 | Remnants: white dwarfs, neutron stars, supernovae | Flash-safe | ST-4 | deferred |
| ST-6 | Black holes: horizon scale, labelled lensing | Newtonian orbits, separate light model | ST-2 | research needed |

## Phase 7: spacecraft (SE)

| ID | Feature | Model | Depends on | Status |
|---|---|---|---|---|
| SC-1 | A ship with mass, thrust, fuel and attitude | Entity in the integration | SB-4 | planned |
| SC-2 | Orbital HUD (prograde, normal, radial; elements) | | SB-22 | planned |
| SC-3 | Manoeuvre planning with delta-v | Predictions (SB-8) with thrust | SC-1 | planned |
| SC-4 | Autopilots that apply forces and can fail | No teleporting | SC-3 | planned |
| SC-5 | Entry and landing | | WR-5, GR-3 | deferred |

## Phase 8: creative platform

| ID | Feature | Status |
|---|---|---|
| CR-1 | Image export from photo mode, with credits | planned |
| CR-2 | Field of view, exposure, target tracking | planned |
| CR-3 | Camera keyframes, saved shots, video export (feature-detected) | planned |
| CR-4 | Short lessons on resettable scenarios | planned |
| CR-5 | Declarative, versioned addons (no imported code) | deferred |
| CR-6 | Audio, within the owner's decisions | implemented (2026-10-26; the owner allowed sound): sound only where there is air (the wind by the air's dynamic pressure on foot and on the way down; the suit's fans on airless worlds), no music or voice, silenced under a recitation, off at the navigator's foot and kept (`tests/explore/sound.spec.ts`) |
| CR-7 | WebXR | deferred |

## Research extensions

Ecosystems, many-particle accretion, fluids, rigid-body deformation and coarse galaxy collisions:
research needed, each with its own model, fixtures and measured feasibility first.

## Showcases

| Showcase | Playable now? | Needs |
|---|---|---|
| Change the Sun's mass | Yes | (SB-6) |
| A second Moon | Yes: add, watch, go back to a checkpoint, try again | (SB-7, SB-11) |
| A rogue world striking a planet | Yes: aim, prediction, the breakup, its debris and their fall back; a smaller body's crater, drawn where it struck with its depth, rays and glow, and the impact's energy | (heating beyond the crater: WR-2) |
| An Earth-like world farther out | Yes: moved out to 1.3 au the Earth freezes over, its globe white; brought back it stays frozen | (water's inventory: WR-4) |
| A ring under tidal stress | Yes: the Moon sent inside the Earth's Roche limit is torn into pieces and a ring of dust; rings of test particles or a gravitating ring scattered by a passing world | (moons gathering again outside the limit: not modelled) |
| Binary sunset | No | ST-3 |
| From orbit to a crater floor | No | GR-1 to GR-3 |
| An equal-mass dark Sun | Orbits yes (mass is all gravity sees); the light no | ST-2 |
| A new system, revisited exactly | No | IS-5 |
| A lunar transfer | No | SC-1 to SC-3 |

## Budgets

| Area | Budget | Measured (2026-10-25) |
|---|---|---|
| Shell (first load) | baseline 327,629 B gzipped + 10,000 | 333,339 (+5,710) |
| Explorer (lazy) | 150,000 B gzipped | 130,902 |
| Orbital laboratory (lazy: adapter, panel, worker) | 250,000 B gzipped | 16,441 |
| Worker | 8 ms of steps and 3 ms of prediction per 16 ms tick | solar fork: about 130,000 steps a second in Node |
| GPU | No growth over round trips | level over three (`lab.spec`) |

New phases set their own budgets before they start.
