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
| IA-7 | Al-Sufi's "little cloud" named on the sky | The Andromeda Galaxy's catalogue position | Label at the cited position | planned |
| IA-8 | Star names from Arabic astronomy | Etymologies from a licensed source | Every name cited | research needed |
| IA-9 | Prayer times | Conventions for twilight and the afternoon differ between communities | Owner and scholar decision first | deferred |
| IA-10 | Other crescent criteria (Odeh, SAAO), weather | Published criteria | Agreement with each paper's examples | planned |

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
| SB-20 | Searchable Add palette by kind (stars, giants, moons, comets...) | Typed presets with cited parameters | SB-7 | Each kind's values cited; added body valid | planned |
| SB-21 | Add at the cursor with a placement preview | Picking against a reference plane | SB-7 | Placed where previewed | planned |
| SB-22 | Orbital elements in and out (a, e, i, apsides, period) | Osculating elements about the primary | SB-8 | Round trip elements to state to elements | planned |
| SB-23 | Drag a velocity, impulse with units | Gizmo in the render frame | SB-21 | Logged as setVelocity | planned |
| SB-24 | Multi-select, rename, save as preset | Scenario library in IndexedDB | SB-11 | Presets survive reload | planned |
| SB-25 | Radius and density edits with lock rules | Two of mass, radius, density fixed, third derived | SB-6 | No incompatible triple | planned |
| SB-26 | Spin and axial tilt edits | Needs a rotating-body model | SB-25 | | research needed |
| SB-27 | Undo and redo | From the edit log (branching already exists) | SB-11 | Undo restores state bit for bit | planned |
| SB-28 | Fixed-body constraints | Marked as externally constrained | SB-4 | Momentum budget shows the constraint | deferred |
| SB-29 | Encounter markers and an accuracy control on predictions | Closest approaches along the path; eta per prediction | SB-8 | | partial (collision announced; no markers) |
| SB-30 | Camera frames: inertial, body-fixed, two-body co-rotating | Frames change the view, never the physics | SB-8 | Trajectories identical across frames | planned |
| SB-31 | Lagrange points | Restricted three-body effective potential, labelled where it applies | SB-30 | L4/L5 Trojan stays | planned |
| SB-32 | Roche-limit and spin-breakup indicators | Fluid and rigid Roche limits, labelled | SB-25 | | planned |
| SB-33 | J2 and tidal spin | After the baseline | SB-26 | Precession rate against theory | research needed |
| SB-34 | Measurements (distance, angle, light time, angular size) | | SB-8 | | planned |
| SB-35 | Graphs over time that survive a merger | Ring buffers per tracked id | SB-12 | | planned |
| SB-36 | Pinned external reference fixture | REBOUND (GPL: data only, not code) | SB-4 | Fixture hash and agreement recorded | planned |
| SB-37 | Share link for small scenarios | Seed + log in the URL when small enough | SB-11 | | planned |

## Phase 2: impacts and debris (US)

| ID | Feature | Model / approximation | Depends on | Status |
|---|---|---|---|---|
| IM-1 | Outcome by regime (merge, partial accretion, hit-and-run, erosion, super-catastrophic) | Leinhardt and Stewart (2012) scaling laws (`src/sim/impacts.ts`, `docs/IMPACTS.md`) | SB-10 | in progress: the model and its tests done; the engine's use of it next |
| IM-2 | Impact heating and a persistent surface mark | Heat already accounted (SB-10); per-surface mark | IM-1, WR-1 | planned |
| IM-3 | Crater geometry | Documented crater scaling law on a height field | GR-1 | planned |
| IM-4 | Bounded physical ejecta, separate decorative dust | Fragments as bodies; unresolved mass reservoir | IM-1 | planned |
| IM-5 | Reaccretion | Fragments under gravity merge back | IM-4 | planned |
| IM-6 | Rings and belts: decorative, test particles, gravitating | Three explicit classes | SB-4 | planned |

## Phase 3: worlds that respond (US)

| ID | Feature | Model / approximation | Depends on | Status |
|---|---|---|---|---|
| WR-1 | Materials with sourced properties | Mass fractions per reservoir | none | research needed |
| WR-2 | Global energy balance from the active light sources | Absorbed flux, emission, heat capacity | ST-2 | planned |
| WR-3 | Surface grid: latitude, seasons, day and night | Coarse grid, slower than gravity | WR-2 | planned |
| WR-4 | Water and ice inventories, phase changes | Stored state, not an overlay | WR-1 | planned |
| WR-5 | Atmospheres (thin and thick, greenhouse labelled) | Parameterised greenhouse | WR-1 | planned |
| WR-6 | Data views (temperature, liquid, pressure, composition) | | WR-3 | planned |
| WR-7 | Winds | Only with tested conservation | WR-5 | research needed |

## Phase 4: orbit to ground (SE)

| ID | Feature | Model / data | Depends on | Status |
|---|---|---|---|---|
| GR-1 | Terrain height query with a datum | LOLA, MOLA, the Earth's terrain tiles | none | planned |
| GR-2 | Terrain LOD without cracks at seams and poles | Screen-error patches | GR-1 | planned |
| GR-3 | Descent, surface-follow, back to orbit | Camera clearance from GR-1 | GR-2 | planned |
| GR-4 | Saved places and views (place, view, time) | | GR-3 | planned |

## Phase 5: interstellar (SE)

| ID | Feature | Model / data | Depends on | Status |
|---|---|---|---|---|
| IS-1 | Hierarchical coordinates (galaxy, system, body, surface) | Sector plus local Float64 frames, small camera-relative values for the GPU | none | planned |
| IS-2 | Distances for the stars | Parallaxes (Hipparcos or Gaia, licence to check). The sky now has directions only | IS-1 | research needed |
| IS-3 | Nearby stars as places to fly to, without double drawing the sky's stars | One identity per star | IS-2 | planned |
| IS-4 | Known exoplanet systems | NASA Exoplanet Archive; unknown values never shown as measured | IS-3 | planned |
| IS-5 | Generated systems where nothing is catalogued | Deterministic hierarchical seeds, versioned rules, always marked "generated" | IS-1 | planned (only labelled, only beyond the catalogues) |
| IS-6 | Clusters, nebulae, the Milky Way, the Local Group, the cosmic web | The film's SDSS and Planck data where they apply | IS-1 | planned |
| IS-7 | Navigator hierarchy, search, bookmarks, history | | IS-3 | planned |

## Phase 6: stars and extremes (US)

| ID | Feature | Model | Depends on | Status |
|---|---|---|---|---|
| ST-1 | Star parameters (mass, radius, luminosity, temperature) | Cited relations, valid ranges stated | none | planned |
| ST-2 | Several light sources; a star that does not shine | Light from the model, not a fixed Sun | ST-1 | planned |
| ST-3 | Binaries, double sunsets, circumbinary worlds | | ST-2 | planned |
| ST-4 | Evolution tracks and an HR diagram | Cited tracks or labelled interpolation | ST-1 | research needed |
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
| CR-6 | Audio, within the owner's decisions | deferred |
| CR-7 | WebXR | deferred |

## Research extensions

Ecosystems, many-particle accretion, fluids, rigid-body deformation and coarse galaxy collisions:
research needed, each with its own model, fixtures and measured feasibility first.

## Showcases

| Showcase | Playable now? | Needs |
|---|---|---|
| Change the Sun's mass | Yes | (SB-6) |
| A second Moon | Yes: add, watch, go back to a checkpoint, try again | (SB-7, SB-11) |
| A rogue world striking a planet | Aim, prediction and merger accounting yes; craters and heating no | IM-1 to IM-4 |
| An Earth-like world farther out | No | WR-2 to WR-4 |
| A ring under tidal stress | No | IM-6, SB-32 |
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
