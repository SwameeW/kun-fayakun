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
  drawing), [ and ] step through the same rates (a second to thirty days a second). Backwards (\)
  plays the experiment's history backwards, exactly as it ran (see "Going backwards" below), and
  stops at the fork; play, faster or slower there run it forwards again. Now goes to today's date in
  the experiment and runs at real time; a date goes to that moment (from the fork to a century
  after it: before the fork it stops at the fork, after the century at its end, and the note under
  the row says "This experiment runs from … to …", Now too). The run moves only by whole steps, so a
  goto ends on the first step at or past the moment, but a date's is kept to its day (UTC, as the
  date field shows it; `src/sim/goto.ts`): the field keeps the clock's time of day, and late in the
  day the first step past it can be the next day's (with 14-hour steps, any moment after the day's
  last step; with hour-long ones, a minute to midnight), so the goto ends on the day's last step
  instead. Every step of a day or less leaves one inside each day; a longer one (a file's own
  integrator) can pass over a day, and then the goto ends on the nearer of the two steps about it. While it is on its way the row
  says "Going to …"; Pause stops it where it is, and Reverse, Faster, Slower or a rate run on from
  there at that rate. Reset, in the time row, goes back to the fork, paused, at a day a second (the
  worker holds a scenario it loads at its start until the page's run request that follows, so a tick
  between the two never runs it on at the rate before); going back to a checkpoint and replaying
  leave it paused too. The panel shows the rate and the
  current step, and the achieved rate only when the worker cannot keep up.
- **The drawn clock** (`src/explore/lab-clock.ts`). The worker moves in whole steps (from seconds to
  a day) and sends a snapshot about 30 times a second. What is drawn follows a clock of its own: it
  runs at the rate asked for (so a rate change shows at once), steered gently toward the moment the
  worker has been asked for, a few hundredths of a second behind it, and never moves against its
  direction (it holds instead); only a seek, replay, reset, undo, redo or a goto back sets it
  elsewhere. Each body is drawn between the two snapshots around that moment (cubic Hermite in
  position and velocity), or within a step of the nearest (velocity and acceleration). So the Earth
  turns smoothly at every rate, slow rates (ten seconds a second, with steps of 14 hours) move, and
  nothing judders back and forth. When the worker cannot keep up (its 8 ms step budget spent: rings
  of thousands of particles at thirty days a second, forwards or backwards) it runs at the pace the
  worker reaches instead, a tenth of a second behind its newest snapshot, so it still moves every
  frame rather than wait and leap half a day. At the end of a goto it is set at the worker's moment.
  Paused, the page tells the worker the moment drawn; the worker steps on to the first whole step at
  or past it (back to one, going backwards), and the drawn clock runs on to that step within a
  quarter of a second and stops. So, paused, what is drawn is the run's own state at its latest
  step, and an edit is made at exactly the moment drawn (`UniverseLab.elapsedS` equals
  `UniverseLab.t`, the edit's time). At a slow rate with long steps the picture glides on by at
  most one step after the press (fourteen hours of a two-body orbit, about a third of a degree).
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
  - Follow it with the camera: any body. The camera flies to it and frames it, then keeps it
    framed as it moves, never below any body's surface. It goes on with the survivor when the body
    merges, with the largest of what is left when it breaks up, with the first piece when the tides
    tear it apart; removed, the camera stays where it is, flying freely.
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
- **Throw a rock** (`src/sim/aim.ts`; the panel's "Throw a rock"). Choose what to aim at, what to
  throw (a stone a kilometre across, a ten-kilometre asteroid, Ceres, or a body with the mass and size
  of Mars), its speed far from the target, the angle it strikes at from the ground (45 degrees is the
  likeliest for rocks from every direction, Shoemaker 1962) and how soon (an hour to thirty days).
  "Work it out" finds where it must start: it is put at the contact, at the speed Öpik's
  v² = v∞² + v_esc² gives, in the system as it will stand then, and the whole system is run backwards
  to now; that start is run forwards with the experiment's own rules. A heavy rock pulls the bodies it
  passes off the places they have without it (a Mars passing the Moon moves it by a million kilometres
  over a month), so the start is then corrected forwards, by Newton's method and then Broyden's updates
  (one run each, sixteen runs at most): moved across its way, and made faster or slower (starting further
  back, so it comes at the same time), until its path passes through the point it should strike, turned
  until the angle is the one asked for (the engine reads the angle from the pair's angular momentum), and
  the contact is within 2 per cent of the speed and 2 degrees of the angle asked for. Over the panel's 240
  choices (three targets, four rocks, five leads, four speeds and angles) 233 are made; the seven refused
  are slow grazing ones (2 km/s at 15 degrees) and a Mars at the Moon a month out, each with the reason
  and what to change ("a shorter time to contact, or a lighter body"; `tests/unit/lab-throw.spec.ts`).
  The worker works it out a few milliseconds a tick (a Mars a month out takes about 0.3 s of work), so the
  run never waits for it; "Work it out" waits while it works, and of several asked for at once only the
  latest is worked out. What it will do is shown first ("integrated ahead with the same rules": when it
  strikes, how fast, at what angle, the regime, the crater, the energy); "Throw" adds it at the step it was
  worked out at (the run goes back there, just after any edit made at that step), so the run has exactly
  that outcome; when it cannot (an edit made since), it is refused and says to work it out again. After
  the contact the card shows what was asked beside what happened. Anything else in the way is struck first,
  and the preview says so.
- **Slow down for events** (on unless turned off; the choice is kept in this browser). The worker looks
  four real seconds ahead at the rate set for the next impact or the next body crossing a heavier one's
  fluid Roche limit (`src/sim/approach.ts`: each pair's own two-body orbit, by Kepler's equation,
  refreshed with every snapshot). The clock then eases down, in log rate over about two seconds, so the
  event comes a second and a half after it reaches the rate that shows it (an eighth of the time the
  impactor takes to cross the target's radius, about 36 simulated seconds a second for a Mars on the
  Earth; a twentieth of an orbit for a moon being torn), holds there two seconds after it, and eases back
  over two. An event not seen coming slows the clock at once after it. Only the rate shown changes: the
  physics and the log are the same at any rate. The time machine's row says the rate it runs at while it
  slows ("Slowed: 36 s a second (set: 1 day)", in place of the rate set, with "Full speed" beside it: on a
  phone's sheet folded or not), and so does the panel's rates line; the panel says what it is slowing for
  and how far off it is; Esc, "Full speed" or any time button calls it off for that event. The worker eases by how far its
  own moment is from the contact; the drawn clock, a few frames behind it, by how far the drawn moment is,
  so it runs a little faster and closes on the worker as both slow. (Eased at the worker's pace, the gap
  it was drawn behind at the faster rates was worth more and more real seconds as the rate fell, more than
  its steering could make up, and it jumped forward, near the contact on a slow machine.)
- **The event card.** The latest impact or tidal disruption: what struck what, the speed and angle at
  contact and Leinhardt and Stewart's regime, its energy (and in megatons), the target's mass and radius
  before and after the event itself (a breakup's remnant is at the two bodies' mixed density, so it may be
  larger though it lost mass: the card says so), the bodies made, the crater; its own pieces falling back
  later are counted on it, with the radius they have made of it since, not given cards of their own (a
  screen reader hears only that). For a torn body, how its dust and band are drawn (illustrative). It can
  be closed until the next.
- **Pick any body.** A tap on one of the experiment's own bodies (its disc, or within a finger's reach of
  a small one) chooses it. Off the view, the chosen body has a pointer at the clear view's edge, its name
  and an arrow toward it. Its velocity arrow's tip is taken within 14 px (22 px, a 44 px target, by a
  finger). A laboratory of its own opens on its star (at once, even during the explorer's
  entry glide).
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
| New bodies' drawing, trails, prediction lines | `src/explore/lab.ts`, `src/explore/lab-fx` | Lit rocks and shining stars at the engine's radii, soft dust and rings, fireballs (below); the explorer's orbit renderer |
| The built-in worlds' drawn size | `Lab.scale` (eased to the snapshot's radius) | Multiplied into the explorer's drawn size, its collision sphere and the camera's least distance |
| The real explorer's clock, imagery, markers | `src/explore/index.ts` | Set aside on entry, given back on exit |

Snapshots also carry each body's look and, for bodies a collision or the tides made, where it came from
(`src/sim/looks.ts`: the parent, the event, its kind; carried by the state's copies and replayed with the
log, never saved in a file), the torn bodies' pieces, each ring's kind, source, look and mean pole, and
what is coming (`upcoming`).

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
  approximate planetary elements, Standish and Williams, and the Horizons Moon table, or beyond its
  span Meeus's lunar theory) at the explorer's date; velocities by central differences over
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

**One check for every edit, with an answer** (W1.1). Every edit, from the panel, a lesson, a file, a link
or a tool, passes the same check (`src/sim/engine.ts` `checkCommand`): its shape, the import limits (an
edit that would make a scenario its own save could not restore is refused: doubling the Sun ten times
passes GM 10¹⁴ km³ s⁻² and is refused), and the ids it names (in a file, a body or a ring the run makes on
its own, a breakup's remnant and debris, a torn body's pieces and its dust, may be named before it exists;
live, every id must exist now, and an id this experiment has used before is not used again). Live, the
engine also refuses edits that would do nothing (a held body's velocity, removing the scene's light). A
refused edit logs nothing and takes no checkpoint. The worker answers each edit (`ack`: applied, with the
bodies it made, or refused with the reason); `Lab.command` returns that answer as a promise (also
`window.__kf.universe.lab(command)`, for tools), the panel shows a refusal's reason, and Double is
disabled, with why, where it would pass the limit. Commands sent before the run's first snapshot wait for
it (and the explorer keeps those sent before the laboratory's code has come). A rate that is not a number
is refused; one beyond thirty days a second is held to it.

Every edit (mass, radius, velocity, state, rotation, hold, name, add, remove) is a command logged
at the step it was applied and applied again at that step on replay, so an experiment is its start
plus its log.

- **The step an edit is made at.** The worker runs on between the view last drawn and an edit's
  arrival: a frame or two, which at a day a second is about an hour of the experiment, in which the
  Earth moves some 100,000 km. An edit therefore carries the step of the view it was made on, and
  the engine goes back to that step first (exactly: a checkpoint and the log replayed) unless an
  edit has been made since (`Engine.applyAt`; an edit made at that same step is kept: the run goes
  back to just after it). A body placed beside another is placed where that one was seen; the clock
  steps back by those few frames. A thrown rock is made at its step or refused (`exact`).
- **Checkpoints.** A checkpoint (a copy of the state, and the accelerations the next step starts from)
  is taken before every edit and every 200 to 2,000 steps, kept in order of step, at most 48: past that,
  the one whose loss leaves the shortest gap goes, so they stay spread over the whole run (the first and
  the latest always stay). The accelerations are kept because a step's last ones are found before its
  second half kick turns the spins, which set the oblate worlds' axes: found afresh from a checkpoint,
  with the spins turned, they differ in the last bits, and a replay drifted from the run by a bit or two
  (a backwards replay once showed the Earth-Moon distance a last bit off).
- **Going backwards** (`src/sim/rewind.ts`). The run is deterministic, so its past is replayed: a
  replica of the engine (never the run itself) restores the latest checkpoint before the moment shown
  and steps forward over a segment of at most 256 steps, keeping every step's state (the bodies,
  spins, climates and ships; the rings' particles every few steps, within about 0.4 MB), which is then
  shown in reverse, a whole step at a time. While one segment is shown the one before it is replayed
  within the worker's 8 ms step budget (two segments ahead at most); across a long gap between
  checkpoints the replica keeps full states every 256 steps on its way, so each segment further back
  replays only its own steps, and the worker keeps the run's own full state every 256 steps as it
  goes forwards (the latest sixteen), so going back starts from near the moment shown. A heavy
  experiment goes back at the pace its history can be replayed (measured over the last segments),
  evenly, rather than in bursts and waits; the row then says it is replaying. The
  history, the interventions and the collisions shown are those before the moment shown (craters and
  dust come again as the run passes them forwards). Running forwards, an edit, a seek or undo first
  puts the run exactly at the moment shown; an edit there branches as any edit does.
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
- **Light.** The explorer's Sun lights its ten worlds wherever it is (in a laboratory of its own it
  stands at the laboratory's star). The experiment's own bodies are lit by every star in it (the two
  brightest at each body), and a body added as a star shines (its disc, by its luminosity and radius);
  it does not light the explorer's ten worlds.
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
  and the worker), loaded only on entering it, and its effects another (`src/explore/lab-fx`, loaded
  with the first experiment): on 2026-10-27, after the review pass, 88,980 and 10,671 bytes gzipped,
  99,651 together against a budget of 250,000 (the effects' own 40,000; `scripts/check-bundle.ts`). M1
  added 373 bytes to the explorer (144,695: the worlds drawn at the experiment's radius, the camera's
  distance from a grown world, Esc, commands kept until the laboratory's code has come, the frame's step
  for the effects, the clear view for the pointer, a laboratory of its own opening on its star at once,
  and the names' layout as a module of its own) and none to the first visit (the rocks' spheres are built
  in the chunk: three.js's own icosahedron would have joined the shell's three.js file).
- **Worker.** A 16 ms tick, of which at most 8 ms of steps and 3 ms of prediction; time owed by a
  slow tick is carried (up to a quarter of a second's worth), not dropped; snapshots every 33 ms. At thirty days a second the solar fork
  needs about 700 steps a second, a small share of what the worker manages.
- **GPU.** One line mesh (24 trails, the chosen trail, prediction, velocity) and point sprites, made
  once and kept; with the effects, three rock meshes (one draw call each, only those with rocks in them
  drawn), the dust's and the fireballs' splats, the points and up to four bands: at most 10 draw calls.
  WebGPU allows eight vertex buffers a draw: the rocks' per-instance numbers and their geometry are each
  one interleaved buffer. Three round trips from a chapter through an experiment and back, and three out
  of an experiment and in again, leave the GPU's geometry and texture counts level
  (`tests/explore/lab.spec.ts`, `tests/explore/lab-perf.spec.ts`).
- **Frames** (measured 2026-10-27 on the development Mac, M-series, Chromium's WebGPU, 1440 x 900 at a
  device pixel ratio of 2, `tests/explore/lab-perf.spec.ts`): an experiment with a ring of 2,000 particles
  about the Earth and a belt of 2,000 about the Sun while a Mars breaks up on the Earth (the slowing, the
  fireball, seven debris bodies glowing, the plume, the ring lit and shadowed): 59.9 frames a second
  (vsync-capped) with the 99th percentile frame 16.8 ms at High, and the same at Low (2,000 particles
  drawn there), as a quiet experiment's. (The GPU's timestamp queries on this Mac read tens of
  milliseconds while frames hold 16.8 ms, as the roadmap's section 5.3 notes: not used.) Re-measured after
  the review pass (2026-10-27, other worktrees' browser tests running on the same machine): 59.88 fps and
  a 99th percentile of 16.8 ms at High and at Low in every phase (quiet, the ring and belt with the effects
  switched off and on, the breakup); the GPU's geometry and texture counts level over three round trips
  (33 and 62 at High), and the heap after a forced collection level (23.2, 23.4 and 22.3 MB). With
  the camera following the breakup's first piece of debris as a further phase (2026-10-28, the
  frame-rate specs run alone, nothing else on the GPU): 59.88 fps and a 99th percentile of 16.8 ms at
  High and at Low, on WebGPU and on forced WebGL2, in that phase and every other; the heap after a
  forced collection 23.9 to 25.0 MB over the round trips, level within each run.

## How experiments are drawn

`src/explore/lab-fx` (its own chunk, loaded with the first experiment), from the snapshot and the drawn
clock, read back through `window.__kf.universe.labDraw()`:

- **Rocks** (`rocks.ts`). Every body that is not one of the ten worlds is a mesh at exactly the engine's
  radius, from the size gravity rounds a body up: below the "potato radius" (Lineweaver and Norman 2010:
  about 200 km for rock, 300 km for ice) it is lumpy, more so the smaller, with a fragment's 2 : √2 : 1
  axes (Fujiwara et al. 1978); the lumps are illustrative and the mass and radius are the engine's. Lit
  by Lommel-Seeliger's law with a tenth of Lambert's (Hapke 2012), normalised as the Moon's map is (so the
  albedo shows as measured), from the four brightest stars at it, each nought behind any of the eight
  largest bodies (an eclipse), with a faint night-side floor (a visual aid, 4 per cent). It turns by the
  model's spin; with none, a lumpy body tumbles slowly (once every 4 to 20 hours, seeded: illustrative),
  held still when that would pass 30 degrees a frame. Under a disc of 2.8 px radius it crosses to a point
  of light (lit by phase and albedo, as the worlds' points are), the weights always adding to 1. Three
  meshes by disc size (icospheres of 1, 3 and 5 subdivisions at High), interleaved buffers.
- **Looks** (`src/sim/looks.ts`). The material from the bulk density (Carry 2012: ice below 2,000 kg/m³,
  metal above 5,000; a world with a climate is rock), the albedo a seeded world's own where its surface is
  what reflects (airless worlds, Mars), rock's (0.12) under thick air; a body the visitor adds or throws
  (given an airless climate whose albedo is illustrative) by its density like any other, so a stone is
  rock's grey, not as bright as cloud; a torn body's pieces and dust take its look, a breakup's pieces the
  two bodies' looks blended by mass. Tints illustrative.
- **Stars**. A star body is a disc at its effective temperature, T = (L / 4πR²σ)^¼, in its blackbody
  colour, darkened toward its limb, as bright as the explorer's Sun is drawn (white when small, through
  its filter when large), with a glare.
- **Dust and rings** (`splats.ts`, `annulus.ts`). Each particle a soft splat (exp(−3g²), no core), as
  wide as the particles' spacing on screen (2.5 to 36 px), lit by the star at its body by the phase, and
  nought in its body's cylindrical shadow; carried round its orbit between snapshots (circular Kepler
  motion about the ring's mean pole). Its light is its share of a layer of dust of optical depth 0.6 over
  the area the ring spans (illustrative: the dust's mass is not modelled), the same at every size, and
  never brighter than the layer's own rock in that light (its albedo times the phase and the light: a
  torn Moon's dust at most 0.12 of sunlit white). Once spread round its body (72 five-degree stretches each holding a quarter of
  their share, 330 degrees or more), a ring of dust or a ring made about a planet fades in as a band:
  its radial profile a histogram of the particles' distances, single scattering (Chandrasekhar's law as
  Saturn's rings use, normalised as the rocks' is), its body's shadow across it, an optical depth of at
  most 0.8 (illustrative); the particles over it fade to a third of their light, and to under a tenth
  where they are so few for the view that each splat is at its largest (each would be a blot: the band
  carries that light). A belt about a star is not drawn as a band. The event card of a torn body and the
  rings section say that the dust's depth is illustrative and its mass not modelled.
- **Fireballs** (`fireball.ts`, `incandescence.ts`). On every merger or breakup, at the contact, turning
  with a world that turns: its radius 0.002 E^(1/3) m (Collins, Melosh and Marcus 2005), between the
  impactor's radius and half the target's; its first temperature v² / 2c (c = 1,200 J/kg/K) between 1,800 and
  4,000 K; its colour by Planck's law weighed by the eye (Wyman, Sloan and Shirley's fits to the CIE 1931
  observer), and its brightness too, held no brighter than sunlit white ground; a slow impact's, cooling
  below that ceiling (from about 1,670 K), dims no faster than its fade's steepest a frame, so it follows
  Planck's law only as closely as that ease allows (its light never more than a fiftieth of its peak a
  frame at 60 frames a second as it fades). Slowed for safety: it rises over
  0.8 s (never more than a thirtieth of its peak a frame), holds, fades over 2.5 s, cooling; impacts within
  a third of a second join one (a larger one joining grows it and heats it over half a second, never a
  thirtieth of the change a frame), never more than three rise a second. With reduced motion it does not
  grow and fades in and out more slowly. It is drawn a little toward the camera from its site (its own
  body's ground never cuts it) and depth tested (a nearer body hides it; the star's glare is not), its
  part past its body's limb eased over half a second (on its own: that follows the body's turning and the
  camera, which no fireball knows ahead, so the tests judge a fireball's own light against its peak and the
  part shown apart, and what reaches the screen, each tile's light, is the flash guard's), and on a body
  gone (merged away) where it was while it fades. Every easing is timed by the frames' own clock (the explorer's frame step), so each frame's
  change is what its time allows.
- **Heat** (`heat.ts`). Melt glows at its surface's temperature as a crust forms over it:
  εσT⁴ = k(T_m − T) / √(πκt) (Turcotte and Schubert 2014; k = 2 W/m/K, κ = 10⁻⁶ m²/s, ε = 0.9), its
  brightness by Planck's law. A crater's melt (2,000 K, illustrative) falls below the visible glow (about
  1,100 K) in about three minutes of the experiment's time (1,146 K at two minutes); a giant impact's
  bodies (its energy per kilogram over rock's heat capacity, 1,500 to 3,000 K) in under a minute to about
  fourteen minutes, and on the Earth, the Moon, Mercury and Mars the face it struck glows the
  same way. At a day a second that is gone within a frame; slowed for the event, it is seen.
- **Plumes**. Decorative dust (ledger IM-4) in the same soft splats, lit as the ground, at least 6 px
  tall; impacts on one body within a second make one plume, and past six the oldest fades away.
- **Names** (W1.10). The laboratory's bodies' names go through the explorer's layout (ranks, corners, the
  worlds' names giving way), its placing a pure module (`src/explore/label-layout.ts`, tested alone: a
  thousand random scenes of 74 names never showing two over each other): a name showing gives way once
  another comes within 8 px (its fade is done before they would meet), one comes in only with 16 px of room,
  8 px inside the clear view and only where no other name shows, so a few pixels' movement never sends one
  out again (no flicker at the edge of room); a body behind a nearer one of the laboratory's is not named; three or more
  bodies one event made are one name at the largest ("Moon: 8 pieces", "Earth: 7 fragments"), the chosen
  one named as well; an encounter marker is named as an encounter ("Closest to Moon, in 3.2 h"), its time
  counted down from the moment drawn (the prediction it comes from was made a little earlier; it is made
  again more often as an encounter comes near, and one passed is not shown).
- **Fades and the flash guard** (`flash-guard.ts`). Bodies and rings fade in and out over half a second (a
  body gone lingers where it was as it fades), a world the experiment ends shrinks away over 0.6 s, a
  world's drawn size eases to the experiment's radius (half-second time constant, and never more than a
  thirtieth of what is left in a frame, so a long frame is no jump), a crater past the
  twelfth fades before its place is given to the newest. The flash guard sees each screen tile (341 x 256
  CSS px at 1,024 wide, scaled) as a whole, once a frame: every fireball in it adds the light it would show
  without rising and the light its eased rise asks for (luminance times the share of the tile it covers),
  so two in one tile make one light (they never overwrite each other's level), and a change counts when
  that light moves by a tenth of the share they cover (a tenth in luminance over all of it, the darker
  under 0.8, or saturated red), where they cover a quarter of the tile or more. A rise that would make a
  third flash pair in a second is held back: each rise in the tile is let through by the same share, the
  rest held where it is, so a fireball held back stops rising and, let go, goes on at its own eased pace.
  The guard only slows rises (a fall is the effects' own fade), so it lets one through only with room for
  the fall after it. It never makes a step of its own.
- **The effects by tier** (`ladder.ts`): plume points 720, 480, 320, 160; rock subdivisions; 4,000 splats
  (2,000 at Low); the glare off at Low. An unknown tier is Medium.

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
| Oblateness: nodal regression at the textbook rate; the axis precesses with angular momentum kept; held bodies; radius, spin, state and name edits; undo and redo bit for bit (also through edits sharing a step); encounters; the seeded rotations (the Earth's 23.44° and sidereal day); a run gone back to a checkpoint going on to the last bit as it did, oblate worlds turning | `tests/unit/lab-engine.spec.ts` |
| An external reference: REBOUND 5.2.2's IAS15 over a year, within measured bounds, converging as the step squared | `tests/unit/rebound.spec.ts` (fixture `tests/fixtures/rebound/`, script `scripts/rebound/`) |
| The two-body drift: a quarter turn, Kepler's equation solved independently, a thousand periods, hyperbolas, reversibility | `tests/unit/kepler.spec.ts` |
| Rings and belts: they pull nothing (bit for bit); a ring about the Earth stays a ring under hour-long steps; a belt particle against a fine reference; replay through save and load; carried over when the primary merges; refused when impossible; a gravitating ring's bodies | `tests/unit/swarms.spec.ts`; in the browser `tests/explore/lab-tools.spec.ts` |
| The tools in the browser: the inspector's numbers, held edits, rename, hold, undo and redo; a push, elements, rotation, accuracy, encounters, Lagrange points and L4; the palette, placing with the pointer, dragging the arrow; frames, measurements, a chart, the library, a link that reopens it, several bodies at once; the camera following the laboratory's own bodies (by the keyboard; handed on through a breakup and a merger; a breakup's first piece of debris kept within 5 per cent of its framing for ten seconds of its flight and the camera above every body's surface each frame; one removed let go of where the camera is; the two-body laboratory on its star with the Earth's tiles aimed at nothing, its planet followed and measured, the real bodies flown to again after leaving) | `tests/explore/lab-tools.spec.ts` |
| Predictions: the live state untouched, a closed orbit, stopping at a merger, a moon about its planet | the same |
| Pause stops the physics, not just the drawing | `tests/explore/lab.spec.ts` |
| Destroying a selected or followed body leaves no broken camera | the same (a merged planet; the Earth removed under the camera) |
| Leaving gives the real explorer and then the film back; no GPU growth over round trips | the same |
| Late messages from a reset or left experiment ignored | by design (every message carries a generation), exercised by reset and load in the browser |
| Phone layout and touch targets | `tests/explore/mobile.spec.ts` |
| The drawing's pure parts: the potato rule and the crossover; a disc's size; a star's temperature; Planck's law weighed by the eye (against a direct integral and the reviewed values); a melt's crust; a splat's light the same at every size; a ring's coverage; the flash guard's pairs (a 3.5 Hz flicker over 30 per cent of a tile held to two, over 10 per cent let through, saturated red counted; two effects in one tile held together; ten fireballs in one tile never stepping a frame, held back or let go); fireballs merging (a larger one joining eased in), rising a thirtieth a frame, under the ceiling; four stars' light, the strongest first, one eclipsed | `tests/unit/lab-look.spec.ts` |
| The names' layout alone: a thousand random scenes of 74 names, no two showing over each other, none under the interface or off the clear view, none that cannot show; the chosen body's name over a world's, which gives way; hysteresis under jitter | `tests/unit/label-layout.spec.ts` |
| Seeing it coming (contact times against an independent RK4 run; an asteroid flagged days ahead; a moon about to cross the Roche limit); throwing (20 seeded throws at the Earth, the Moon and Mars within 2 per cent and 2 degrees, 19 or more made; heavy and month-long throws made by correcting the start forwards; a throw worked out after an edit at the same step and thrown later striking exactly as shown; one tied to its step refused, with nothing changed, after a later edit; the sliced planner equal to the one run at once; the outcome worked out ahead equal, bit for bit, to the run's); a thrown stone drawn as rock (0.12); provenance through save and load; one check for every edit; a fuzz of 10,000 edits on three laboratories after which every save restores and replays to the same state, bit for bit | `tests/unit/lab-throw.spec.ts` |
| Drawn as what it holds: a torn Moon's pieces as lit rocks at their size, dark in the shadow, meshes of the right projected size at three window sizes; grey dust no brighter than its rock, spreading into a band, said to be illustrative; one name for the pieces and none meeting at six window sizes; the two-body star's disc within 2 per cent and its planet lit from its side; a world drawn at the experiment's radius, eased, back on undo; a thrown Mars slowing the clock and back to full speed, the fireball eased under its ceiling, the debris glowing and cooling, the same events with the slowing off; ten stones on the Moon at once never flashing more than three times a second | `tests/explore/lab-effects.spec.ts` |
| The throw, the slowing (on by default, kept off, Esc and Full speed), every edit answered (the tenth doubling of the Sun refused, said in the visitor's words), a command sent with the opening honoured, a rate held to the fastest, bursts on the new controls and the panel at five window sizes; a throw after an edit at the same step, thrown after the clock ran on, striking as shown; a stale throw refused with what to do; a month-long Mars worked out without holding up the run, Work it out waiting while it works; the chosen body's pointer at the view's edge; the two-body laboratory opening on its star | `tests/explore/lab-throw.spec.ts` |
| Frame by frame, motion on: every fireball's light changing by at most a thirtieth of its peak a frame, the canvas read back each frame never flashing more than three times a second in any tile, fireballs rising at most three a second (a Mars on the Earth, two Ceres on one face of the Moon, ten stones); the Mars flagged three seconds ahead, the clock no faster than 40 s a second about the contact, the Earth then at the experiment's radius, the slowed rate in the time machine's row and the rates line, the event card's mass and radius; with reduced motion, the camera turning at most half a degree a frame through a torn Moon | `tests/explore/lab-flash.spec.ts` |
| The frame budget with 4,000 particles and a breakup, at High and Low, against the same with its effects switched off (A/B) and with a piece of the breakup followed; GPU resources and the heap after a forced collection level over round trips | `tests/explore/lab-perf.spec.ts` (`@perf`) |
| WebGPU, forced WebGL2, Brave | every browser spec runs on `webgpu` and `webgl2`; `lab.spec.ts` also on `brave` where installed |

### The M1 exit gate, re-run (2026-10-27, after the review pass)

The diagnosis's reproductions, re-run on the development Mac (Chromium, WebGPU and forced WebGL2):

- A two-body run at ten seconds a second moves its date, smoothly, never turning back
  (`tests/explore/lab.spec.ts`, "the drawn clock: smooth and never turning back at every rate").
- At thirty days a second backwards, the run plays its history back to the fork, exactly, and stops there
  (`tests/explore/lab.spec.ts`, "backwards through the experiment's history to its fork").
- After the Roche lesson's disruption: the eight pieces lit grey rocks at their size (meshes, their
  projected size within 5 per cent at 2000 x 1300, 1440 x 900 and 1280 x 800), dark in the Earth's shadow;
  the dust grey and no brighter than the Moon's rock, spreading into a grey band; one name for the pieces,
  no two names meeting at six window sizes (`tests/explore/lab-effects.spec.ts`).
- After a thrown Mars-mass breakup on the Earth: the Earth drawn within half a per cent of the
  experiment's radius; the fireball's light changing by at most a thirtieth of its peak a frame, motion on,
  and the canvas read back each frame never flashing more than three times a second in any tile; the
  clock slowed three seconds and more ahead, no faster than 40 s a second within a second of the contact
  (`tests/explore/lab-flash.spec.ts`).

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
