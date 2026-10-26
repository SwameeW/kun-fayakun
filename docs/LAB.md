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
- **Inspect and edit.** Choose a body: its mass, radius, speed, speed and distance relative to the
  body it moves about, escape speed. Set its mass (or double or halve it) and its velocity
  relative to that body. Duplicate it (a new id) or remove it (the Sun stays: it is the scene's
  light). Follow it with the camera (the ten worlds).
- **Add.** A body on a circular orbit about any other (mass, radius, distance), or at a position and
  velocity relative to it.
- **See.** Each body's recent path (its trail), and the chosen body's path integrated ahead
  (10 days, 60 days, a year or ten years), both drawn about the body it moves about; its velocity
  as an arrow. A collision on that path is announced with when and with what.
- **Check.** Relative drift of energy, momentum and angular momentum since the last edit; the
  history of edits and mergers.
- **Keep.** Save in this browser (IndexedDB), load it back, export a file, import one. Reset to the
  fork. Go back to a checkpoint (a new edit there starts a new branch), or replay the whole
  experiment from its start.
- **Laboratories.** Besides the solar system: a star and a planet, and a star with two planets
  (Sun-, Earth- and Jupiter-like, on circular orbits).
- **Leave.** "Back to the real explorer" returns to the real explorer exactly as it was (date, rate,
  positions), and from there to the film where it was.

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
  that touch merge at the step: mass, momentum and the centre of mass are kept; the pair's
  orbital angular momentum about their centre of mass becomes the survivor's spin; volumes add
  (the radius follows); the kinetic energy lost (½μv², the heat) moves into an internal energy
  reservoir so the closed model's total is kept, and is reported as heat. The heavier body
  survives with its id (the Sun always keeps its id).
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

Every edit (mass, velocity, add, remove) is a command logged at the step it was applied and applied
again at that step on replay, so an experiment is its start plus its log. A checkpoint (a copy of
the state) is taken before every edit and every 200 to 2,000 steps, keeping at most 48 (the first,
and then the most recent). Going back restores the nearest checkpoint at or before the step and
replays to it; an edit made there discards the later log (a new branch). Drift is measured from
the state just after the last edit, so an edit is an intervention, not an error.

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
| `bodies[]` | `id` (stable, unique), `name` (text, at most 60 characters), `gm` (km³ s⁻², 0 for a test particle), `radiusKm`, `pos` (km), `vel` (km/s), `origin` (`observed`, `modelled` or `user-edited`), `sourceIds` (ids in `data/sources.json`) |
| `log[]` | `{ step, command }`, commands `setMass {id, gm}`, `setVelocity {id, vel}`, `add {body}`, `remove {id}` |
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

- **Point masses.** No shapes, oblateness (J2), tides, tidal locking, Roche disruption, or rotational
  breakup. Spin is bookkeeping for mergers, not a modelled rotation; the ten worlds turn by the IAU
  models whatever the experiment does.
- **Newtonian only.** No relativity (Mercury's perihelion advance is missing, about 43" a century),
  radiation pressure, drag, or thrust.
- **Ten bodies only in the fork.** No dwarf planets, asteroids or moons of other planets; their
  pulls are absent.
- **The seed is approximate.** JPL's approximate elements are not an N-body solution and the
  velocities are differenced, so the copy departs from the real system from the start (measured
  below). That departure is the model's, not the Sun's.
- **Mergers are perfectly inelastic.** No fragments, ejecta, craters or debris; the heat is a number,
  not a temperature. No grazing outcome other than merging.
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
| Predictions: the live state untouched, a closed orbit, stopping at a merger, a moon about its planet | the same |
| Pause stops the physics, not just the drawing | `tests/explore/lab.spec.ts` |
| Destroying a selected or followed body leaves no broken camera | the same (a merged planet; the Earth removed under the camera) |
| Leaving gives the real explorer and then the film back; no GPU growth over round trips | the same |
| Late messages from a reset or left experiment ignored | by design (every message carries a generation), exercised by reset and load in the browser |
| Phone layout and touch targets | `tests/explore/mobile.spec.ts` |
| WebGPU, forced WebGL2, Brave | every browser spec runs on `webgpu` and `webgl2`; `lab.spec.ts` also on `brave` where installed |

## Not in this slice

Undo and redo, multi-select, renaming, radius and density edits after creation, orbital elements
as input or readout, dragging a velocity, camera frames other than following a body (co-rotating,
body-fixed), Lagrange points, graphs over time, impacts beyond merging, materials, climate, other
stars, and spacecraft. Each is in `docs/FEATURE-LEDGER.md` with its dependencies.
