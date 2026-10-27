# The orbital laboratory

The explorer's experiment mode (`#/universe/lab`): the solar system as it stands at the explorer's
date, copied into an N-body integration that the visitor can change. It is Phase 1 of the
Universe Sandbox and SpaceEngine brief (an editable N-body sandbox with body creation, mass and
velocity editing, trajectory predictions, conservation checks, and save, reset and replay). The full
ambition and its status are in `docs/FEATURE-LEDGER.md`.

What it is not: the real sky. The explorer shows the solar system from JPL's data; the laboratory
shows what Newtonian gravity does to a copy of it once changed. Every screen in it says so ("An
experiment ... not a prediction"), and nothing it does reaches the explorer's data. It carries no
scripture: destructive experiments stay clear of the film's verses.


## What the laboratory is for

The real universe is the reference; the laboratory is the thought experiment; reflection is the
purpose (docs/SPEC.md, section 0). It is a copy of the real solar system at a moment (or a small
system of its own), in which the visitor changes the conditions (a mass, an orbit, an atmosphere,
a collision) and sees what the models say would follow. It never presents itself as making a
universe: its title says "an experiment", its first line says "What if? Change the conditions, see
what the science models say would follow, and compare it with the real solar system, which stays as
it is", and its results are labelled as the experiment's, not as observations.

**Compared with reality** (`src/ui/explore/lab-panel.ts`, `UniverseLabBody.baseline`): once a
built-in world's mass or size has changed by a thousandth, or its orbit's size or year by 3 per cent
(beyond the slow drift of the osculating elements the other worlds' pulls cause), the inspector sets
its figures beside the real ones (the real seed's at the fork, from JPL's ephemeris) and asks one
question about the largest change: a different mass, a different size, a wider or a tighter orbit, or
an escape. Only for an experiment begun from the real system; a file or a link is an experiment of
its own and has no real baseline.

## Using it

- **Enter.** "Experiment with this system" in the navigator forks the system at the
  explorer's date (`app.openLab()`, route `#/universe/lab`). The real explorer's time, imagery and
  markers are put aside and given back on leaving; live layers (satellites, earthquakes, the day's
  imagery, discoveries) are off, because they are measurements of the real Earth, not of an
  altered one.
- **Time.** The explorer's own time machine drives it: Space pauses the physics (not just the
  drawing), [ and ] step through the same rates (a second to thirty days a second). Going backwards
  and "now" are disabled: the past is reached through checkpoints, not by running the clock in
  reverse. The panel shows the requested and the achieved rate and the current step.
- **Inspect.** Choose a body. The panel shows:
  - its mass, radius, density, speed, escape speed, and its speed and distance relative to the body
    it moves about (its primary);
  - its osculating orbit about the primary (`src/sim/elements.ts`): semi-major axis, eccentricity,
    inclination, year, nearest and farthest points, and Hill sphere. This is the two-body orbit
    it would follow if every other pull stopped now: a description, not a forecast;
  - its rotation (period, and the tilt of its axis from its orbit's) and the fastest it could turn
    before its equator flew off, 2π √(R³/GM);
  - its primary's Roche limits for it: rigid R (2ρ_P/ρ_s)^(1/3), and fluid 2.44 R (ρ_P/ρ_s)^(1/3),
    the coefficient being Chandrasekhar's;
  - its J2.

  Inside a Roche limit, or turning faster than its gravity holds, the panel says so.
- **Edit.**
  - Rename it.
  - Set its mass, radius or density, holding one of the other two: holding the density, the radius
    follows the mass; holding the mass, the density follows the radius.
  - Set its velocity relative to the primary, or drag the gold arrow's tip in the view. The arrow is
    drawn 90 pixels long, so dragging the tip twice as far doubles the speed.
  - Give it a push in metres a second: along its motion, out of its orbit's plane, or away from its
    primary.
  - Set its whole orbit by elements.
  - Set its rotation (period, and axial tilt from its orbit's pole). One of the ten worlds then
    turns as set from that moment, not as the IAU models have it.
  - Hold it in place. This is an outside constraint, so momentum and energy are not conserved while
    it holds; the checks say so.
  - Duplicate it: a new id, sixty degrees ahead on its orbit, or the next free place.
  - Remove it (the Sun stays: it is the scene's light).
  - Follow it with the camera (the ten worlds).
  - Tick several bodies to duplicate or remove them together.
  - Undo and redo any edit (Ctrl or Cmd + Z, with Shift, or Ctrl + Y).
- **Add.**
  - From a palette of real bodies, by kind, with a search. Each body's mass, radius and rotation
    come from a named source (`src/sim/presets.ts`): JPL's satellite and planetary parameters, the
    Small-Body Database, and published stellar masses and radii.
  - By its own numbers: on a circular orbit about any body, or at a position and velocity relative
    to one.
  - Placed with the pointer. The click lands in the plane of the primary's orbit and starts a
    circular orbit there. A mouse sees a preview and the distance first; Esc stops.
  - At one of the chosen body's Lagrange points with its primary.
- **See.**
  - Each body's recent path (its trail), and the chosen body's path integrated ahead (10 days, 60
    days, a year or ten years), at the experiment's step or four times finer or coarser.
  - Paths are drawn about each body's primary, in the experiment's own frame, turning with a pair
    (the chosen body's primary and the heaviest body about it), or turning as the primary turns
    (body-fixed: a satellite's path over its ground). Frames change the drawing, never the physics.
    The path ahead in a turning frame assumes the present rate of turning.
  - A collision on the path ahead is announced with when and with what, and its closest approaches
    to other bodies with when and how close.
  - The chosen body's five Lagrange points with its primary.
- **Measure and follow.**
  - Measure the distance, light time and angular size between two bodies, and the angle between two
    of them as seen from a third.
  - Follow a quantity over time as a chart: distance or speed about the primary, eccentricity, or
    energy drift. It follows a body into whatever it merges with.
- **Check.** Relative drift of energy, momentum and angular momentum since the last edit; the
  history of edits and collisions.
- **Keep.**
  - Save in this browser (IndexedDB), and load it back.
  - Save to a library by name.
  - Make a link that carries the experiment (deflated, base64url, up to 8,000 characters;
    `src/sim/share.ts`). Opening the link loads it after the same checks as a file.
  - Export a file, or import one.
  - Reset to the fork, go back to a checkpoint (a new edit there starts a new branch), or replay the
    whole experiment from its start.
- **Laboratories.** Besides the solar system: a star and a planet, and a star with two planets
  (Sun-, Earth- and Jupiter-like, on circular orbits).
- **Leave.** "Back to the real explorer" returns to the real explorer exactly as it was (date, rate,
  positions), and from there to the film where it was.

## Ships (ledger SC-1 to SC-4)

`src/sim/ships.ts`, with the engine's `burn` and `cancelBurns` edits, the laboratory's `addShip`,
`burn`, `cancelBurns` and `circularise` commands, and the panel's "Add a ship" and "Its rocket".

- **A ship** is a body of the experiment that weighs nothing to the others (a test particle in the
  integration, 10 m across for contacts) and carries its own mass: dry, and propellant (kg); its
  engine's thrust (N) and specific impulse (s). The numbers offered are illustrative (a storable
  propellant engine's specific impulse); every one can be set.
- **A burn** pushes it along a direction set by its motion about a body chosen for it: prograde or
  retrograde (along or against its velocity relative to that body), normal or anti-normal (square to
  that orbit's plane), radial out or in (in the plane, square to the motion). The push is the thrust
  over the ship's mass at that moment (the propellant going as thrust over (specific impulse times
  standard gravity, 9.80665 m/s^2)), applied with gravity in both of the leapfrog's half kicks (at the
  start with the mass then, after the drift with the step's propellant spent), until its time is up
  or the propellant runs out. Nothing is instantaneous: the change of speed a burn gives is the
  rocket equation's, Isp g0 ln(m0 / m1).
- **On time.** Steps never cross a burn's start or end, and stay at most ten seconds (and a fortieth
  of the burn) while one runs. A burn planned to start inside another begins when that one ends.
- **Planning** (SC-3) is by the change of speed: the panel asks for it (with a direction, the body to
  reckon against, a start and a throttle) and the burn's length is found from the propellant left
  after the burns already planned. The path drawn ahead (SB-8) is integrated through every planned
  burn as the experiment would be: plan, look, then let the time run. Burns are edits like any other:
  logged, undone, replayed, saved and shared.
- **Autopilots** (SC-4). "Make the orbit round at its far side" plans a prograde burn centred on
  the apoapsis (its time from the mean anomaly), of sqrt(mu / r_a) - sqrt(mu (2 / r_a - 1 / a)): a real
  burn, not a teleport, so it leaves the orbit nearly but not exactly round. "Transfer" takes a ship
  on a round orbit (eccentricity under 0.01) to a round one at the distance typed, by a Hohmann
  transfer (Vallado's algorithm 36, `hohmann` in src/sim/ships.ts): a burn along the motion now
  (backwards to fall), half the transfer orbit's period, and a second centred on its far side, each
  as long as the rocket equation says from the propellant left. Both are refused, and the panel says
  why beforehand, when they cannot be done: not enough propellant, an orbit not round enough to
  start from, other burns still planned, or a target below the primary's surface.
- **The orbit's figures** (SC-2) are the inspector's own (SB-22: the osculating elements, apsides and
  period about the primary). A chosen ship's prograde, normal and radial-out directions about its
  primary are drawn as markers, each an arrow's length from it, named as the burns name them.
- **Conservation** is off while a ship burns, and the panel says so: the rocket adds energy and
  momentum, and the propellant it throws out, which carries the balance, is not followed.

Checked in `tests/unit/ships.spec.ts`: a 1,500 m/s burn in empty space gives 1,500 m/s to 0.05 m/s
and spends exactly the rocket equation's propellant; a burn begins at its time and the directions
are what they say; a Hohmann transfer from 7,000 km to geostationary radius planned with two finite
burns (Vallado's algorithm 36) reaches the second orbit to 1.5 per cent with an eccentricity under
0.02, spending the rocket equation's propellant for the two; the transfer autopilot's plan matches
Vallado's worked example 6-1 (191 km to geostationary altitude: 2.457 and 1.478 km/s, 5.256 hours)
and mirrors it going down; undo takes a burn back bit for bit, and the validator takes a scenario
with a ship and a burn. In the browser, `tests/explore/ships.spec.ts`, which also flies the transfer
autopilot from 7,000 km to a round orbit at 9,000 km (within 1.5 per cent, eccentricity under 0.02).

## Lessons (ledger CR-4)

`src/ui/explore/lab-lessons.ts`: short lessons, each on its own experiment set up from the start
(the seed loaded, the body in question chosen, the clock paused), then a few steps, each an edit
made with a button (the panel's own edits), with what to look for and the number the physics
expects worked out beforehand from the experiment as it stands, beside the experiment's own figure:

- **Kepler's third law** (a star and a planet): the planet moved out to twice its distance; its
  year 2^1.5 = 2.828 times as long; then running, its speed one over the square root of two.
- **Escape speed**: a push a little past the square root of two times the circular speed opens the
  orbit (eccentricity over 1).
- **A Hohmann transfer** (a ship 7,000 km from the Earth's centre, to 42,164 km): the two burns
  worked out (Vallado's algorithm 36), the first planned and run, the far side checked against the
  target, the second planned by the autopilot.
- **The Roche limit**: the Moon moved inside the Earth's fluid limit for it, and torn apart.

"Start the lesson again" sets the experiment up from the start once more (a burst of presses sets it
up once). The steps are taken in order and each once: every step's button waits until the
experiment is set up (the first step's place says so meanwhile), the next one opens only once the
one before is taken and the experiment shows it (its edit applied, a burn it ran the clock through
ended), and a step taken stays done; the keyboard goes on to the next. Before a step is taken it
says what it will do where it has words for that; once taken, what happened. Each step's words are
kept as they were once the next is taken (the first step's figures, the experiment as it stood,
once the first edit is made), and words once shown are never blanked (the torn Moon no longer has
the distance they gave; the autopilot's burn, once made, says it is done). Its experiment replaced
while it is being set up (another chosen, a saved one loaded) or gone (the laboratory left), a
lesson ends, and its button begins it again. The steps are a numbered list, each number beside its
button and the step's words under it. Tested in `tests/explore/lessons.spec.ts`.

## State ownership

| State | Owner | Notes |
|---|---|---|
| Positions, velocities, masses, radii, spins | The engine, in a worker (`src/sim/worker.ts`) | The page only receives snapshots |
| The scenario (start, settings, edit log) | The engine | Saved and exported as the scenario file |
| Built-in worlds' places during an experiment | Snapshots, through `Lab.applyBuiltIns` | Their rotation still follows the IAU models at the simulated date (modelled, not integrated) |
| New bodies' drawing, trails, prediction lines | `src/explore/lab.ts` | Points of light with names; the explorer's orbit renderer |
| The real explorer's clock, imagery, markers | `src/explore/index.ts` | Set aside on entry, given back on exit |

Snapshots arrive about 30 times a second; between them positions are carried along each body's
velocity for at most 0.1 s of real time.

## Units and frames

Kilometres, seconds, and GM in km³ s⁻² (no separate G). The solar-system fork is given in the
barycentre of its ten bodies, at rest, on the ecliptic and equinox of J2000; the laboratories in
the star's initial rest frame. Masses in kilograms on screen are GM divided by one constant: the
Earth's GM (DE440) over the Earth's mass (JPL's physical parameters), so every body is converted by
the same G.

## The model

- **Gravity.** Newtonian, between point masses, summed directly over every pair (n² work, fine for
  the at most 64 bodies a scenario may hold). A body with GM 0 is a test particle: it feels gravity
  and exerts none.
- **Integrator.** Kick-drift-kick leapfrog (second order, symplectic at a fixed step). The step is
  eta (0.01) times the shortest dynamical timescale between any pair (from separation, relative
  speed and GM), kept between 1 s and a day. It shortens at once when an encounter tightens, and
  lengthens only every 64 steps, so the method keeps most of its long-run energy behaviour.
- **Contacts.** Between steps, every pair's closest approach over the step is computed along the
  relative motion (swept, so a fast impactor cannot pass through a target between steps). Bodies
  that touch collide at the step, with the outcome Leinhardt and Stewart's scaling laws give for the
  speed and angle at contact (`docs/IMPACTS.md`). Below the merging speed they merge: mass, momentum
  and the centre of mass are kept; the pair's orbital angular momentum about their centre of mass
  becomes the survivor's spin; volumes add (the radius follows); the kinetic energy lost (½μv², the
  heat) moves into an internal energy reservoir so the closed model's total is kept, and is reported
  as heat. Faster, they break up: the largest remnant (keeping the target's id), the second, and at
  most six debris bodies, with mass, momentum, angular momentum and the closed model's energy kept
  exactly. A grazing hit-and-run leaves both as they were. The heavier body is the target (the Sun
  always keeps its id).
- **Rings and belts** (`src/sim/swarms.ts`). Test particles, up to 2,000 in a ring or belt and
  4,000 in all, feel every body and pull nothing, so the bodies run bit for bit the same with them
  or without. Each is carried relative to the body it was made about: between two half kicks from
  everything else (the other bodies, every oblate body's J2 term, and the opposite of its primary's
  own acceleration), it moves exactly along its conic about the primary (`src/sim/kepler.ts`,
  universal variables). That is the Wisdom and Holman (1991) split, so a ring about the Earth whose
  particles turn in two and a half hours keeps its shape under the hour-long steps the Earth and the
  Moon set, and a belt particle under one-day steps follows a ten-minute leapfrog to half a
  kilometre in two years. A particle within a body's radius strikes it and is counted; one passing
  through a body within a single step is not caught. If the primary merges away its particles go on
  about the survivor, if it is removed about the most massive body. They are made from a seed in
  the log (semi-major axes uniform between the radii given, eccentricities and inclinations up to
  the limits, in the primary's equator for a ring, its orbit's plane for a belt), so they replay
  exactly. A gravitating ring is a dozen ordinary bodies sharing a mass. Saturn's drawn rings are the
  third kind, decorative: Cassini's measurements, drawn, not simulated, and the panel says so.
- **Climates and starlight** ([CLIMATE.md](CLIMATE.md)). Each solid world keeps a temperature for
  eighteen latitude bands from every star's light (the Sun's nominal luminosity; a body of 0.075 solar
  masses or more by the main-sequence relation, following its mass), stepped daily after the gravity:
  North, Cahalan and Coakley's energy balance model for the Earth (its ice can spread and freeze it
  over), a calibrated grey atmosphere for Venus and Mars, airless rock for the rest.
- **Tidal disruption.** A body of 100 km or more in radius, inside a much heavier neighbour's fluid
  Roche limit on an orbit that does not strike it, is torn into eight pieces and a cloud of dust that
  spread into a ring ([CLIMATE.md](CLIMATE.md#tidal-disruption-sb-33)).
- **Seed.** The solar-system fork takes positions from the explorer's ephemeris (JPL's
  approximate planetary elements, Standish and Williams, and the Horizons Moon table) at the
  explorer's date, clamped inside the Moon table's span; velocities by central differences over
  ±1 hour; GM from the DE440 header; radii from NAIF. Each body records where its values came from
  (`origin`, `sourceIds`), and the scenario says this in words (`seedNote`).

## Predictions and trails

A prediction integrates a copy of the current state with the same rules and step control (in the
worker, in slices of 3 ms a tick so the live run is never held up), sampling the chosen body 360
times over the horizon and stopping at a merger. It also samples the body the chosen one moves
about at the start (its primary: of the heavier bodies, the one with the smallest distance over
GM^(1/3), followed through mergers), and is drawn about that body where it is now. A moon's path is
drawn as an orbit about its planet, not smeared along the planet's path. It is redone after every
edit and every eighth of its horizon. Trails are drawn the same way, each about its body's primary.

## Interventions, checkpoints and replay

Every edit (mass, radius, velocity, state, rotation, hold, name, add, remove) is a command logged
at the step it was applied and applied again at that step on replay, so an experiment is its start
plus its log.

- **The step an edit is made at.** The worker runs on between the view last drawn and an edit's
  arrival: a frame or two, which at a day a second is about an hour of the experiment, in which the
  Earth moves some 100,000 km. An edit therefore carries the step of the view it was made on, and
  the engine goes back to that step first (exactly: a checkpoint and the log replayed) unless an
  edit has been made since (`Engine.applyAt`). A body placed beside another is placed where that one
  was seen; the clock steps back by those few frames.
- **Checkpoints.** A checkpoint (a copy of the state) is taken before every edit and every 200 to
  2,000 steps, keeping at most 48 (the first, and then the most recent).
- **Going back.** This restores the nearest checkpoint at or before the step and replays to it. An
  edit made there is a new branch: it discards the later log and drops every checkpoint later than
  its step (those of the run as it was), so none can be gone back to. Redo likewise drops the
  checkpoints taken while its edit was undone.
- **Undo.** Undo takes the run back to the moment of the latest edit, as it was before it, bit for
  bit. It uses the checkpoint taken just before that edit, even when several edits share a step
  (made while paused). The edit is kept for redo until another edit is made.
- **Drift.** Drift is measured from the state just after the last edit, so an edit is an
  intervention, not an error.

## The scenario file (schema 1)

```json
{
  "schemaVersion": 1,
  "engineVersion": "kf-nbody-1",
  "name": "solar-system",
  "epochJdTdb": 2461336.75,
  "frame": "barycentre of the ten bodies, at rest; ecliptic and equinox of J2000; km, km/s",
  "seedNote": "Positions from JPL's approximate planetary elements ...",
  "integrator": { "id": "kdk-leapfrog", "eta": 0.01, "dtMinS": 1, "dtMaxS": 86400, "retimeSteps": 64, "fixedDtS": null },
  "bodies": [
    { "id": "earth", "name": "Earth", "gm": 398600.43550702266, "radiusKm": 6371.008366666666,
      "pos": [x, y, z], "vel": [vx, vy, vz], "origin": "modelled",
      "sourceIds": ["jpl-approx-pos", "jpl-de440", "naif-pck00011"] }
  ],
  "log": [ { "step": 1234, "command": { "kind": "setMass", "id": "sun", "gm": 265424880082.55884 } } ],
  "persistentIds": ["sun"]
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | 1. Other versions are refused |
| `engineVersion` | The engine that wrote it (`kf-nbody-1`); kept for reproducibility claims |
| `epochJdTdb`, `frame` | When and in what frame the bodies are given |
| `seedNote` | How the start was made, and its approximations |
| `integrator` | `eta`, step bounds (s), `retimeSteps`, or a `fixedDtS` |
| `bodies[]` | `id` (stable, unique), `name` (text, at most 60 characters), `gm` (km³ s⁻², 0 for a test particle), `radiusKm`, `pos` (km), `vel` (km/s), `origin` (`observed`, `modelled` or `user-edited`), `sourceIds` (ids in `data/sources.json`); optional `spin` (`{periodS, pole}`, prograde about the pole), `j2`, `inertia` (I / MR², 0.4 when absent), `luminosityW` (a star's), `climate` (`src/sim/climate.ts` `ClimateSpec`) |
| `log[]` | `{ step, command }`, commands `setMass {id, gm}`, `setVelocity {id, vel}`, `setState {id, pos, vel}`, `setRadius {id, radiusKm, gm?}`, `setSpin {id, periodS, pole}`, `setFixed {id, fixed}`, `rename {id, name}`, `add {body}`, `remove {id}`, `addSwarm {swarm: {id, name, primary, count, innerKm, outerKm, eccentricity, inclinationDeg, normal, seed}}`, `removeSwarm {id}`, `addRing {ring: {id, name, primary, count, innerKm, outerKm, gm, radiusKm, normal, seed}}` (its bodies `<id>-1` on), `setAtmosphere {id, tau?, forcing?, pressurePa?}` |
| `persistentIds` | Bodies that keep their id in any merger and cannot be removed |

Saved in IndexedDB (database `kf-lab`, store `scenarios`, key `current`) and exported as
`kun-fayakun-<name>.json`. Imports are checked before anything runs (`validateScenario`): the version;
every number finite; at most 64 bodies and 5,000 edits; coordinates within 10¹² km, speeds within
300,000 km/s, GM within 10¹⁴ km³ s⁻², radii within 10⁷ km; ids unique; every edit naming a body
that exists by then. A bad file is refused with up to six reasons and the experiment is left as it
was. Names are only ever shown as text.

## Reproducibility

The same scenario file (start, settings and log) replays to the same state, bit for bit, on the
same engine version in the same JavaScript engine (tested through save and load). Across browsers
or engine versions only the physics is expected to agree, to the integration's accuracy: the
floating-point order of operations in `Math.hypot`, `Math.cbrt` and the like may differ, and a
chaotic system amplifies any difference. A scenario records its `engineVersion` so a mismatch can
be told apart from a fault.

## Limitations

These are deliberate simplifications; the interface does not claim otherwise.

- **Spheres, with oblateness.**
  - Each body is a sphere of its mean radius.
  - J2 is modelled: a flattened body pulls with its J2 term about its spin axis, and is pulled back,
    and the torque turns its axis.
  - There is no tidal friction, tidal locking or spin-down (the rest of ledger SB-33, research
    still needed), and no rotational breakup (that limit is shown, not enforced). A body inside a
    neighbour's fluid Roche limit is torn apart (above), though one between the rigid and fluid
    limits is treated the same way.
  - The ten worlds turn as the IAU models have them, except one whose rotation the visitor sets.
  - The seed's J2s and moments of inertia are the NASA fact sheets' (`data/constants.json`):
    - the Sun's J2 is not on its sheet, so it is spherical;
    - Neptune's sheet gives no moment of inertia, so 0.4 stands in;
    - none of these changes its orbit.
- **The arrow is not to scale.** The velocity arrow shows direction; its length on screen is fixed.
- **Newtonian only.** No relativity (Mercury's perihelion advance is missing, about 43" a century),
  radiation pressure, drag, or thrust.
- **Ten bodies only in the fork.** No dwarf planets, asteroids or moons of other planets; their
  pulls are absent.
- **The seed is approximate.** JPL's approximate elements are not an N-body solution and the
  velocities are differenced, so the copy departs from the real system from the start (measured
  below). That departure is the model's, not the Sun's.
- **Collisions are scaling laws, not hydrodynamics.** The outcome and the remnants' masses follow
  Leinhardt and Stewart (2012); the pieces leave at 1.05 times the pair's mutual escape speed, evenly
  spaced round the collision's plane (Chambers 2013), not at the paper's own fitted speed distribution;
  a hit-and-run projectile is not eroded. A cratering impact's crater is drawn on the Earth's land,
  the Moon, Mercury and Mars by its scaling law, its glow and rays illustrative
  ([IMPACTS.md](IMPACTS.md#craters-and-energy)); the heat is otherwise a number, not a temperature.
- **No climate or materials.** Changing a world's mass or orbit does not change its temperature,
  atmosphere or appearance; the Earth is shown with its static imagery, not the day's.
- **Light.** The Sun lights the scene wherever it is; a body added as a star does not shine.
- **Removal is not physics.** Removing a body takes its mass out of the model at once (an
  intervention, logged as such).

## Numbers

Measured with `node --import tsx scripts/sim-report.ts` (Node, the development Mac, 2026-10-25).
`tests/unit/sim.spec.ts` asserts bounds on each; these are the values reached.

| Scenario | Result |
|---|---|
| Circular orbit (Sun and Earth GM, 1 au), 100 periods at P/512: largest relative energy error | 5.7e-9 (accepted below 1e-4) |
| the same: drift of momentum, angular momentum | 1.2e-14, 9.4e-15 |
| the same: period error, from the phase after 100 periods | 5.0e-5 |
| Convergence (e = 0.5): energy error at P/512 over that at P/1024 | 4.00 (second order) |
| Eccentric orbit (e = 0.6, P/20,000) against Kepler's equation: largest position error / a | 1.4e-5 |
| Close encounter (a second Sun passing a star and its planet at 0.12 au), 120 days of engine steps (eta 0.002) against RK4 at 30 s: the planet's position | 3.7e-4 au (56,000 km) |
| Merger (a Moon-mass body striking the Earth): change in mass, momentum, angular momentum, total energy | 0, 0, 1.9e-16, 0 |
| Solar fork against the explorer's ephemeris after 1, 7, 30, 365 days: the Earth | 1 km, 32 km, 583 km, 46,558 km |
| the same: the Moon about the Earth | 11 km, 70 km, 394 km, 4,913 km |
| the same: Jupiter | 0 km, 11 km, 209 km, 14,526 km |
| Solar fork, one year: drift of energy, momentum, angular momentum | 1.3e-9, 3.0e-15, 1.5e-15 |
| Solar fork, one year: steps, mean step, time | 8,483 steps of 1.03 h, 64 ms (about 130,000 steps a second) |

The fork against the ephemeris compares two models, not a model and the sky: the approximate
elements leave out the planets' mutual pulls that the integration includes. The references are
analytic (Kepler's equation) or written independently in the test (RK4 at a far smaller step);
no external integrator's fixture (REBOUND) is pinned yet.

## Performance and budgets

- **Bundle.** The laboratory is a lazy chunk (`src/explore/lab.ts`, `src/ui/explore/lab-panel.ts`
  and the worker), loaded only on entering it: 16,441 bytes gzipped against a budget of 250,000
  (`scripts/check-bundle.ts`). The explorer's own budget (150,000) is unaffected.
- **Worker.** A 16 ms tick, of which at most 8 ms of steps and 3 ms of prediction; time owed by a
  slow tick is carried (up to a quarter of a second's worth), not dropped; snapshots every 33 ms. At thirty days a second the solar fork
  needs about 700 steps a second, a small share of what the worker manages.
- **GPU.** One line mesh (24 trails, the chosen trail, prediction, velocity) and 32 point sprites,
  made once and kept; three round trips from a chapter through an experiment and back leave the
  GPU's geometry and texture counts level (`tests/explore/lab.spec.ts`).

## Tests

| Brief's acceptance test | Where |
|---|---|
| Two-body circular orbit: period, radius, energy, momentum, angular momentum over 100 periods | `tests/unit/sim.spec.ts` |
| Convergence as the step falls | the same |
| Eccentric motion, and a close encounter against a stricter independent reference | the same (Kepler; RK4) |
| Translation and velocity boost invariance; test particle | the same |
| Inserted satellite inherits its primary's velocity; mass edit causes a response and is logged | the same |
| Merger accounting; no tunnelling | the same |
| Replay through save and load; branching | the same |
| Invalid and huge imports fail quickly | the same (in a unit test and in the browser) |
| Orbital elements round trip; Lagrange points are equilibria; a Trojan stays at L4 for ten Jovian years; Roche limits, breakup period, measurements | `tests/unit/elements.spec.ts` |
| Oblateness: nodal regression at the textbook rate; the axis precesses with angular momentum kept; held bodies; radius, spin, state and name edits; undo and redo bit for bit (also through edits sharing a step); encounters; the seeded rotations (the Earth's 23.44° and sidereal day) | `tests/unit/lab-engine.spec.ts` |
| An external reference: REBOUND 5.2.2's IAS15 over a year, within measured bounds, converging as the step squared | `tests/unit/rebound.spec.ts` (fixture `tests/fixtures/rebound/`, script `scripts/rebound/`) |
| The two-body drift: a quarter turn, Kepler's equation solved independently, a thousand periods, hyperbolas, reversibility | `tests/unit/kepler.spec.ts` |
| Rings and belts: they pull nothing (bit for bit); a ring about the Earth stays a ring under hour-long steps; a belt particle against a fine reference; replay through save and load; carried over when the primary merges; refused when impossible; a gravitating ring's bodies | `tests/unit/swarms.spec.ts`; in the browser `tests/explore/lab-tools.spec.ts` |
| The tools in the browser: the inspector's numbers, held edits, rename, hold, undo and redo; a push, elements, rotation, accuracy, encounters, Lagrange points and L4; the palette, placing with the pointer, dragging the arrow; frames, measurements, a chart, the library, a link that reopens it, several bodies at once | `tests/explore/lab-tools.spec.ts` |
| Predictions: the live state untouched, a closed orbit, stopping at a merger, a moon about its planet | the same |
| Pause stops the physics, not just the drawing | `tests/explore/lab.spec.ts` |
| Destroying a selected or followed body leaves no broken camera | the same (a merged planet; the Earth removed under the camera) |
| Leaving gives the real explorer and then the film back; no GPU growth over round trips | the same |
| Late messages from a reset or left experiment ignored | by design (every message carries a generation), exercised by reset and load in the browser |
| Phone layout and touch targets | `tests/explore/mobile.spec.ts` |
| WebGPU, forced WebGL2, Brave | every browser spec runs on `webgpu` and `webgl2`; `lab.spec.ts` also on `brave` where installed |

## Against an external reference

The solar-system seed was run for one Julian year by REBOUND 5.2.2's IAS15 (Rein and Spiegel 2015),
with energy kept to 4 × 10⁻¹⁶. The laboratory's leapfrog at its own settings (8,490 steps) ends:

| Body | Off from REBOUND |
|---|---|
| Mercury | 4,370 km |
| Venus | 602 km |
| Earth | 179 km |
| The Moon | 908 km about the Earth (0.25% of its distance: mostly phase) |
| Mars | 33 km |
| Jupiter | 0.23 km |
| The outer giants | metres |

A step five times finer cuts every error about 25 times, which is second order, as a leapfrog
should be. Only REBOUND's numbers are kept: `tests/fixtures/rebound/`, pinned by the input's
SHA-256. REBOUND itself is GPL-3.0, and none of its code is here.

## Not in this slice

Tidal friction and spin-down, materials beyond the air's gases, winds, other stars' light on the scene, and spacecraft. Each is in `docs/FEATURE-LEDGER.md` with its dependencies.
