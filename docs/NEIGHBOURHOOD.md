# Among the stars, and beyond (ledger IS-1 to IS-4, IS-6, IS-7)

The explorer's way out of the solar system: the stars around the Sun, each where its parallax puts
it, the planets known around them, and black holes to fly to. The code is in
`src/explore/neighbourhood/` (its own chunk; a black hole's lens, `lens-view.ts`, a chunk of its own
again) and `src/ui/explore/neighbourhood-panel.ts` (its own chunk too); the data in
`public/assets/stars/`: `neighbourhood.json` (`scripts/stars/neighbourhood.py`), the deep catalogue's
packs and manifest (`scripts/stars/catalogue.py`) and `black-holes.json`
(`scripts/stars/black_holes.py`).

## What a visitor does

- **Out.** "Among the stars" in the navigator. The picture dips (as a reduced-motion cut does) and
  opens three parsecs from the Sun, looking at it. `app.earthCommand({ kind: 'stars' })` does the
  same. Esc on the way in turns it round; a second press of the button on the way in changes nothing.
- **Looking round: free look** (`src/explore/neighbourhood/rig.ts`). A drag turns the camera where it
  stands, the sky following the hand (the point under the pointer stays under it), with no limit on
  pitch: the Sun crosses the screen as any star does, no longer pinned to the middle. The arrows
  turn; Q and E roll.
- **Flying.** W A S D, R and F move along the camera's axes at half the distance to the nearest star
  each second (five times that with Shift), so a parsec takes a few seconds and the last astronomical
  units slow down; the panel says the speed in light years a second and multiples of the speed of
  light (km a second when slow). The wheel or a pinch moves toward the point under the pointer, or
  toward the star under it; out, it draws back as an orbit would. A right drag (two fingers) pans.
- **Orbit** (after flying to a star, or O, or the panel's "Orbit the star"): a drag goes round the
  star, a gold ring marks it, the wheel moves in or out (never inside it: 1.1 of its radius, 2
  Schwarzschild radii of a black hole), and a pinch's or the wheel's star under the pointer becomes
  the one in view. A move key lets go into free look. The star in view sits in the middle of the
  part of the view the interface leaves clear (above a phone's sheet, beside a desktop's panel).
- **Going to a star.** A double-click (or a double tap) on any star visibly drawn, a name from the
  nearest stars, or a search (an IAU name, a planet host's catalogue name, "HIP" or "HR" and a
  number, a galaxy of the Local Group, a black hole) flies there: toward it, rising to see both ends,
  coming down again, in three to eight seconds, and arrives in orbit. A star with planets is arrived
  at three times its widest orbit away, so the planets show; the Sun from three parsecs; any other at
  30 of its radii. "Back to the Sun" always goes back, from wherever. Esc stops a flight where it
  is; Esc again (or "Back to the solar system") dips back to the solar system as it was; for a moment
  after, Esc goes no further, so a burst never leaves the explorer (an explanation's card open then
  still closes on it).
- **What is under the pointer** (or a tap): its name or HIP number, its distance from the camera,
  its type and how bright it looks from here, beside it. Names: the star in view, the one under the
  pointer and the brightest named stars seen from here (at most 16), placed so no two overlap and none
  sits under the interface.
- **Star light.** "Star brightness" (a quarter to four times) and "Faintest stars" (magnitude 4 to
  12.5); the deep catalogue's packs are fetched as the faintest magnitude calls for them.
- **The constellations' figures in space**: the sky's figures joined between their stars' real
  places, so from the Sun they are the night sky's and, flown away from, they come apart. A switch.
- **The panel** gives the star in view: its distance from the Sun (light years and parsecs, and how
  well its parallax is known), its spectral type, its surface temperature (the Exoplanet Archive's for
  a planet host, else from its B-V colour, Ballesteros 2012), its brightness from the Earth and from
  10 parsecs, and its light in V against the Sun's (both from 10 parsecs); for a planet's star, its
  radius, mass and whole light as the archive gives them (ledger ST-1); its known planets; and the
  stars nearest it.
- **The stars by colour and brightness** (ledger ST-4): a Hertzsprung-Russell diagram of every star
  placed in space with a colour (9,140), each by its B-V and its absolute magnitude, as Hipparcos
  measured them, with the Sun circled and the star in view ringed. The main sequence, the giants and
  the white dwarfs are named where they gather; no region is drawn as a boundary, and no evolutionary
  track is drawn (that waits for cited tracks).

## The data

- **Places.** The Hipparcos new reduction's parallaxes (van Leeuwen 2007): every Hipparcos star
  within 25 parsecs (parallax over 40 mas), and the Bright Star Catalogue's stars (the explorer's sky)
  matched to Hipparcos through their HD numbers: 10,193 stars. The magnitudes, colours and spectral
  types of the nearby stars are the Hipparcos main catalogue's (ESA 1997). A star is placed in space
  only where its parallax is at least five times its error (its distance known to a fifth); the
  others stay directions on the sky, as bright as from the Sun.
- **Multiple stars.** Close components of one multiple system (the same CCDM number, within 30
  arcseconds, their parallaxes agreeing within twice their combined error) share the parallax
  measured best; Alpha Centauri A and B take Kervella et al. (2016)'s, 747.17 ± 0.61 mas (Hipparcos's
  own for B, 796.92 ± 25.9, put it 0.07 pc from A). Proxima, which shares their CCDM number two
  degrees away, keeps its own: it is the Sun's nearest. The panel says where a borrowed distance is
  from.
- **The deep catalogue** (`scripts/stars/catalogue.py`, `public/assets/stars/catalogue.json`):
  Hipparcos's other 108,949 stars (`hipparcos.bin`, 16 bytes a star: HIP number, direction, parallax
  and its error, V, B-V), 60,408 of all Hipparcos's placed in space; and Tycho-2's 2.42 million stars
  that are not Hipparcos's (`tycho2-0.bin` to `tycho2-2.bin`, 6 bytes a star: an octahedral direction
  to about ten arcseconds, V and B-V by Tycho's own relations), as directions, brightest first. None is
  drawn twice: a Tycho-2 star with a HIP number is Hipparcos's, one without but within 2 arcseconds
  of a Hipparcos star (6 of a Bright Star Catalogue star) and a magnitude of it is taken to be that
  star (29 left out), and the neighbourhood's own stars are left out of Hipparcos's pack by number.
  The packs stream as the detail and the faintest magnitude call for them (a desktop at High all 2.5
  million, a phone 150,000) and are decoded in a worker. The files' sha256 and the queries are in the
  manifest; the validator checks every pack whole, in order and unrepeated.
- **Not used, waiting for the owner:** Gaia's catalogues (the Fifth Catalogue of Nearby Stars, the
  Gaia Catalogue of Nearby Stars: Wolf 359, TRAPPIST-1 and Luhman 16 among them) are CC BY-NC 3.0 IGO,
  non-commercial; HYG and AT-HYG are CC BY-SA 4.0 (AT-HYG carries Gaia's data too).
- **Names.** The IAU's Catalog of Star Names (WGSN), by Hipparcos number; a planet host with no IAU
  name takes the archive's (Lalande 21185 is "GJ 411").
- **Planets.** The NASA Exoplanet Archive's Planetary Systems Composite Parameters, for the 183
  systems within 20 parsecs. The composite table fills some values by calculation: each semi-major
  axis, radius and mass it calculated is marked "(calculated)", and masses that are only M sin i say
  "at least".
- **The Sun** among them: its absolute visual magnitude, 4.81 (Willmer 2018), and its B-V, 0.653
  (Ramírez et al. 2012), in `data/constants.json`.

The queries (to VizieR's and the archive's TAP services) and their results' sha256 are recorded in
the file itself.

## What is drawn

- **Each star** as a point, as bright and in the colour it would look from the camera: its absolute
  magnitude moved to the camera's distance from it (in the vertex stage, for all 2.5 million), and its
  B-V through Ballesteros's temperature to a blackbody's colour.
- **Star light** (`src/explore/starlight.ts`, the solar system's sky's too): a star's light from its
  magnitude (its flux compressed by a contrast of 0.6, times the visitor's brightness, faded out over
  the magnitude before the faintest drawn), spread as a Gaussian of 0.6 CSS px (never under 0.6
  device px), each pixel showing the Gaussian integrated over its own square (error functions), so a
  star's light is the same wherever it falls in a pixel and nothing shimmers as the view turns. Its
  light is raised by how much a pixel flattens its peak (1.49 at one device pixel a CSS pixel, 1.12 at
  two), so the brightest pixel, and so which faint stars are seen, is the same at any density; the
  faintest drawn stays above the tone curve's black (30 of 255 or more at magnitude 6.5, worst
  placed). The brightest stars spread into a halo rather than clipping; the bloom does the rest.
  Measured at 2000x1300 (`tests/explore/stars-light.spec.ts`): before, 178 stars lit at one device
  pixel a CSS pixel against 973 at two; now 1,819 against 1,144 by the light a viewer gets from each
  CSS pixel (2,531 counted at the device pixels themselves, where the film grain lifts more of a
  faint star's several top pixels past the line).
- **A star up close** (`surface.ts`): the star in view as a disc of its size once it is wider than a
  pixel or so, its point fading: the archive's radius for a planet's star, else estimated from its
  light and temperature (R = sqrt(L) (5772 K / T)^2, L from its absolute V and Torres 2010's
  bolometric correction), marked estimated; its darkening toward the edge (linear, u = 0.6) is
  illustrative.
- **The constellations' figures** (`figures.ts`): each line of the sky's figures between the real
  places of the stars at its ends (the neighbourhood's file's, within a fifth of a degree), where
  both are placed.
- **The Milky Way's glow** (`band.ts`): the density of Tycho-2's stars fainter than V = 9 across the
  sky (`band.bin`, 512 by 256 in galactic coordinates), above the sky's thinnest, tinted by their mean
  colour: the band and its dark rifts are the data's, standing for the light of the stars too faint
  to catalogue; its brightness is illustrative. It replaces the illustrative band.
- **A system's planets**, when the camera is within a hundredth of a parsec of their star: their
  orbits (their semi-major axes and eccentricities) face-on to the Sun, tilted by their inclination
  where it is measured, and the planets moving round them at their periods, by the explorer's clock.
  The orbits' orientations are mostly unknown, and where each planet is on its orbit, and its size,
  are illustrative; the panel says so.
- **The directions** (Tycho-2's and Hipparcos's unplaced stars) are the sky as seen from near the Sun;
  they fade out between 150 and 3,000 parsecs from it, as the Milky Way's model comes in.

## Black holes (ST-6)

Seven, from `public/assets/stars/black-holes.json` (`scripts/stars/black_holes.py`: SIMBAD's
positions, queried, and the papers' masses and distances, each value's source in `data/sources.json`):

| | Mass (Suns) | Distance | Schwarzschild radius | Gas drawn |
|---|---|---|---|---|
| Sagittarius A* | 4.297 million (GRAVITY 2022) | 8,277 pc (GRAVITY 2022) | 0.085 au | a hot thin ring (as the EHT's images; 51.8 ± 2.3 µas ring measured, EHT 2022) |
| M87* | 6.5 ± 0.7 billion (EHT 2019) | 16.8 Mpc | 128 au | a hot thin ring (42 ± 3 µas ring measured) |
| TON 618 | 41 to 66 billion: two calibrations of one H-beta spectrum (Ge et al. 2019; Shemmer et al. 2004), each uncertain by a factor of about three; drawn at 66 billion | redshift 2.219: 5,621 Mpc comoving in Planck 2018's cosmology (light 10.84 billion years on its way) | 1,303 au | a thin disc (a quasar's) |
| Gaia BH1 | 9.62 ± 0.18 (El-Badry et al. 2023) | 480 pc | 28.4 km | none (dormant; a Sun-like star orbits it) |
| Gaia BH2 | 8.9 ± 0.3 (El-Badry et al. 2023) | 1.16 kpc | 26.3 km | none (a red giant orbits it) |
| Gaia BH3 | 32.70 ± 0.82 (Gaia Collaboration 2024) | 590 pc | 96.6 km | none (an old halo giant orbits it) |
| Cygnus X-1 | 21.2 ± 2.2 (Miller-Jones et al. 2021) | 2.22 kpc | 62.6 km | a thin disc (fed by its blue supergiant) |

- **Going there.** The panel's "Black holes" list, a search ("TON 618", "black hole", "Cygnus"), or
  `app.earthCommand({ kind: 'starsPlace', place: 'bh:ton-618' })` or `{ kind: 'starsFind', name:
  'TON 618' }` (a tool's way, by name). Arrival: 20 Schwarzschild radii out from the Sun's side, as
  the Earth sees it (55 for a disc, from 15 degrees above it, to see it whole), in orbit, its axis up.
  The wheel goes down to 2 Schwarzschild radii: 57 km from Gaia BH1. The camera's place is held as an
  offset from the hole in double precision, so kilometres 480 parsecs from the Sun are exact.
- **Light bending, computed** (`lens.ts`, pure; `lens-view.ts`, its shader): for every pixel the ray
  the camera sees, traced back past a non-spinning hole of the mass drawn: u'' + u = (3/2) u^2 (u =
  r_s / r) by fourth-order Runge-Kutta steps of pi/40 in the angle round the hole, its slope fixed by
  the impact parameter the camera (hanging still) sees, b = r sin(psi) / sqrt(1 - r_s / r); captured
  inside the horizon (the shadow), or out to the direction its light came from. That light is the
  picture behind as drawn this frame (stars, the Milky Way, galaxies) where its direction is on the
  screen and not squeezed, else a capture of the whole sky round the camera (taken on arriving),
  blurred as much as the lens squeezes it. Lensing keeps surface brightness, so nothing flashes. The
  same steps are tested in Node against the weak field's 2 r_s / b (within 0.5% from 60 to 5,000
  r_s), the critical impact parameter sqrt(27)/2 r_s (to a thousandth) and Synge's shadow seen from
  20 r_s (within 0.2%); in the browser the photon ring sits within 5% of where the projection puts
  the shadow's edge.
- **The gas, a model** (its look illustrative, its physics computed): where the ray crosses the disc's
  plane, a thin disc from the innermost stable orbit (3 r_s) to 14 r_s with Shakura and Sunyaev's
  temperatures, or a hot thin ring round the photon sphere; its light shifted by g = sqrt(1 - 3/(2r))
  / (1 - Omega lambda) / sqrt(1 - r_s / r_camera) (the gas's orbit and the hole's pull) and brightened
  as g^4 (the disc) or g^3 (the ring), so the side coming toward the camera is the brighter. The
  disc's axis: Cygnus X-1's orbit's inclination, M87*'s jet's, Sagittarius A*'s and TON 618's
  illustrative (each marked).
- **The panel** gives its mass with its uncertainty (TON 618's as the range), distance, horizon's
  radius, the camera's distance in its radii, its shadow's size from here and from the Earth (against
  the EHT's ring where measured), its companion, where each value comes from, and what is a model.
- **Not yet:** spin (Kerr), the companion stars drawn on their orbits, jets.

## Beyond the stars (IS-6)

The code is `src/explore/neighbourhood/galaxy.ts` (the Milky Way's model, pure) and `beyond.ts` (its
drawing, the Local Group's and the survey's), in the neighbourhood's chunk; the data in
`public/assets/stars/localgroup.json` (written by `scripts/stars/beyond.py`) and the film's
`public/assets/sdss/`.

- **Out.** The wheel goes on past a thousand parsecs, to ten billion. The panel's "Beyond the stars"
  goes to the galaxy's centre, the Milky Way face on from above its north pole, the Large and Small
  Magellanic Clouds, the Andromeda and Triangulum galaxies, the Local Group (across the line from the
  Milky Way to Andromeda), and the cosmic web (the survey from outside it, from the side). The search
  finds the Local Group's galaxies by name too, the brightest first. A note says what each scale
  shows and where it comes from; a galaxy in view has its figures (distance, type, absolute magnitude,
  its stars' mass, its size, the galaxy it is bound to).
- **The Milky Way, a model, not a picture.** Its spiral arms where Reid et al. (2019, table 2) fit the
  parallaxes of masers in high-mass star-forming regions (log-periodic spirals with a kink, R0 = 8.15
  kpc), continued more faintly past the azimuths those parallaxes trace: the far side of the galaxy is
  hidden behind its centre. The continuation is an extrapolation, but it reaches the tangents other
  surveys see in the fourth quadrant to within 0.3 degrees (the near 3-kpc arm at longitude 337.0,
  Norma 327.5, Scutum-Centaurus 306.1, Sagittarius-Carina 285.6, the same table). Its thin disc
  (scale length 2.6 kpc, height 0.3 kpc) and long bar (half-length 5.0 kpc, 28 to 33 degrees from the
  line from the Sun to the centre, drawn at 30) are Bland-Hawthorn and Gerhard's (2016); the bar's
  thickness and the bulge's size are illustrative. 72,000 points (36,000 at the lower details), the
  same each time (a seeded generator); its stars are not individually known.
- **The Local Group.** Every galaxy of McConnachie's catalogue (2012) but the Milky Way, 101 of them,
  where its place and distance put it: each a glow of its half-light radius, as bright as its surface
  (its luminosity over its area, in display terms), and never fainter than a mark, so a far dwarf
  still shows where it is. The four the catalogue gives no half-light radius (Andromeda, Triangulum,
  the Magellanic Clouds) are discs of points at SIMBAD's isophotal diameters and position angles,
  tilted by the inclination their axis ratios give: which side of each is nearer is not known from
  that. Andromeda's absolute magnitude is derived from SIMBAD's V and the catalogue's distance, with no
  correction for extinction, and marked so.
- **The cosmic web.** The film's sample of the Sloan Digital Sky Survey's galaxies (420,000; 160,000
  at the lower details), each placed by its redshift in Planck 2018's cosmology, fetched only when the
  camera is a million and a half parsecs out. The survey covers part of the sky (its two fans, north
  and south of the galaxy's plane, open from the Milky Way) and takes one galaxy in nine past
  redshift 0.1, those drawn brighter to stand for the rest; it starts at redshift 0.01 (43 Mpc), so
  nothing is drawn between the Local Group and there.
- **Points and light.** Each point is a radius in parsecs: its size on the screen follows its
  distance (up to a few pixels), and below a pixel its light is thinned in proportion to its area, so a
  galaxy keeps its surface brightness however far it is. The stars of the catalogue and the band of
  the galaxy's light give way to the model between one and eight kiloparsecs out.

## Coordinates (IS-1)

Positions are kept in double precision (parsecs from the Sun, in the explorer's render frame:
ecliptic J2000, from right ascension and declination by the obliquity, as the sky does), and drawn
relative to the camera each frame, so single precision on the GPU loses nothing near any star. Beyond
the stars, each layer's points are held in single precision as parsecs from the Sun and the layer
moved by minus the camera's place (computed in double precision): a few thousandths of a parsec near
the galaxy's centre, a few hundred parsecs at the survey's billions, never more than a fraction of a
pixel at the distances each is seen from. One frame serves from two Schwarzschild radii of a stellar
black hole (57 km) to ten billion parsecs.

The camera's place is its anchor (the star or black hole chosen) plus an offset, both in double
precision, so the offset stays exact however far the anchor is from the Sun. The stars on the GPU are
single-precision places (the CPU uses the same rounded places for the star in view, so its disc and
its point never part), drawn as (place - camera's high part) - camera's low part: the camera split
into two single-precision numbers, so a star is exact kilometres from the camera at any distance from
the Sun.

## Performance

Measured on this Mac's GPU (Apple M5 Pro, WebGPU, Chromium), 1440x900 at two device pixels a CSS
pixel (2880x1800), High, `?profile=1` (`tests/perf/stars-cost.spec.ts`, `PERF=1`). Every view held
59.9 fps median with the slowest 1% at 16.8 ms, CPU 1.1 to 1.9 ms a frame: the solar system; the
stars by default (60,408 placed, 357,548 directions drawn); all 2.5 million (faintest magnitude
12.5); Sagittarius A*, TON 618, and Gaia BH1 from two Schwarzschild radii (every pixel traced).
Uncapped (vsync off) the frame took 1.7 ms among the stars by default, 4.7 ms with all 2.5 million
(3.0 ms more), 5.2 ms at TON 618, 7.1 ms at Sagittarius A* and 3.4 ms at Gaia BH1. Lower details draw
fewer stars (Medium 600,000, Low 150,000) and trace fewer steps round a black hole (Medium 140, Low
100), at the governor's render scale. The view's nearest stars are worked out once for each star in
view, in one pass (a few hundredths of a millisecond; it was 4 ms every frame).

## Not yet

- The stars' motions (they are where Hipparcos measured them, epoch 1991.25).
- Stars of the Gaia catalogue (many faint nearby stars, Wolf 359 and TRAPPIST-1 among them, are not in
  Hipparcos): its licence (CC BY-NC 3.0 IGO) waits for the owner.
- Binary orbits; generated systems (IS-5); the Sun up close drawn as the solar system's Sun.
- Tycho-2's stars in the solar system's sky (it shows the Bright Star Catalogue's, through the same
  star light).
- Star clusters and nebulae; the galaxies between the Local Group and the survey's nearest.

## Tests

- `tests/unit/neighbourhood.spec.ts`: the units (a parsec in km and light years); Proxima Centauri at
  1,000 / 771.64 parsecs (4.23 light years) and Sirius at 2.64; absolute magnitudes; only stars known
  to a fifth placed; the planets and the archive's calculated values; the search.
- `tests/explore/stars.spec.ts`: out among the stars, the Sun's neighbours, a flight to Proxima
  Centauri with its planets drawn and marked, a search that finds Sirius and flies there, Esc
  stopping a flight and then going back to the solar system.
- `tests/unit/beyond.spec.ts`: the arms as fitted and their continuation to the published
  tangents; the model's points the same each time, the bar at its angle; the Local Group where the
  catalogue puts it (Andromeda at 783 kpc, 45.5 kpc across); the galactic frame; the places, and the
  survey's points turned into the explorer's frame.
- `tests/explore/stars.spec.ts` (beyond the stars): the Milky Way from above with its arms named,
  Andromeda's figures, the Local Group's names, the survey fetched and drawn, a galaxy found by name,
  and back to the Sun.
- `tests/unit/neighbourhood.spec.ts` (since): Alpha Centauri A and B together at Kervella et al.'s
  distance, Proxima the Sun's nearest; the nearest stars in one pass, as a full sort gives them.
- `tests/unit/starlight.spec.ts`: the shader's error function, each pixel's share summing to the
  star's light, the same light wherever a star falls in a pixel, the same brightest pixel on average
  at one and two device pixels a CSS pixel, the faintest above the tone curve's black, the settings.
- `tests/unit/star-camera.spec.ts`: free look (the sky follows the hand, no limit on pitch), orbit
  (round at its distance, never inside), flight's speed and Shift, the wheel toward the pointer, a pan,
  a flight to within kilometres of a black hole 590 parsecs out, held exactly.
- `tests/unit/star-catalogue.spec.ts`: the packs decoded as the worker decodes them, none twice,
  placed only where known to a fifth, brightest first, the packing's precision; names never
  overlapping; estimated radii (the Sun's 1, Sirius's 1.7).
- `tests/unit/black-holes.spec.ts`: Schwarzschild radii, the shadow from the Earth against the EHT's
  rings, Synge's edge, the tracer against the weak field and the critical impact parameter, the disc's
  shift, the file.
- `tests/explore/stars-camera.spec.ts`, `stars-light.spec.ts`, `black-holes.spec.ts`: the camera, the
  star light at one and two device pixels a CSS pixel, the black holes, in the browser; the stars in
  `layout-stress.spec.ts` at five window sizes with their controls pressed in bursts and a black hole
  in view; by touch in `mobile.spec.ts`; frame rates in `tests/perf/stars-cost.spec.ts`.
- `node --import tsx scripts/validate.ts`: every star row well formed (where a borrowed parallax is
  from credited), every system listing its planets, every galaxy row well formed with the four
  largest's sizes, every pack of the deep catalogue whole and in order with no Hipparcos number twice,
  every black hole's values credited, every source credited.
