# Among the stars, and beyond (ledger IS-1 to IS-4, IS-6, IS-7)

The explorer's way out of the solar system: the stars around the Sun, each where its parallax puts
it, and the planets known around them. The code is in `src/explore/neighbourhood/` (its own chunk)
and `src/ui/explore/neighbourhood-panel.ts` (its own chunk too); the data in
`public/assets/stars/neighbourhood.json`, written by `scripts/stars/neighbourhood.py`.

## What a visitor does

- **Out.** "Among the stars" in the navigator. The picture dips (as a reduced-motion cut does) and
  opens round the Sun from three parsecs. `app.earthCommand({ kind: 'stars' })` does the same.
- **Looking round.** A drag turns the view round the star in view; the wheel (or a pinch) moves in
  or out, from a hundredth of an au to 1,000 parsecs.
- **Going to a star.** A double-click (or a tap) on a star, a name from the nearest stars, or a search
  (an IAU name, a planet host's catalogue name, "HIP" or "HR" and a number) flies there: along the
  line between the two stars, rising to see both, coming down again, in three to eight seconds. A
  star with planets is arrived at three times its widest orbit away, so the planets show; any other
  at a hundredth of a parsec. Esc stops a flight where it is; Esc again (or "Back to the solar
  system") dips back to the solar system as it was.
- **The panel** gives the star in view: its distance from the Sun (light years and parsecs, and how
  well its parallax is known), its spectral type, its surface temperature (the Exoplanet Archive's for
  a planet host, else from its B-V colour, Ballesteros 2012), its brightness from the Earth and from
  10 parsecs; its known planets; and the stars nearest it.

## The data

- **Places.** The Hipparcos new reduction's parallaxes (van Leeuwen 2007): every Hipparcos star
  within 25 parsecs (parallax over 40 mas), and the Bright Star Catalogue's stars (the explorer's sky)
  matched to Hipparcos through their HD numbers: 10,193 stars. The magnitudes, colours and spectral
  types of the nearby stars are the Hipparcos main catalogue's (ESA 1997). A star is placed in space
  only where its parallax is at least five times its error (its distance known to a fifth); the
  others stay directions on the sky, as bright as from the Sun.
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
  magnitude moved to the camera's distance from it, and its B-V through Ballesteros's temperature to
  a blackbody's colour, by the explorer's sky's own mapping of magnitude to light and size (capped
  for the nearest stars).
- **A system's planets**, when the camera is within a hundredth of a parsec of their star: their
  orbits (their semi-major axes and eccentricities) face-on to the Sun, tilted by their inclination
  where it is measured, and the planets moving round them at their periods, by the explorer's clock.
  The orbits' orientations are mostly unknown, and where each planet is on its orbit, and its size,
  are illustrative; the panel says so.
- **The galaxy's band**: a faint glow along the plane of the Milky Way (its pole and centre as
  Hipparcos defines the galactic frame), brighter toward its centre, for bearings. Illustrative.

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
pixel at the distances each is seen from. One frame serves from a hundredth of an au to ten billion
parsecs.

## Not yet

- The stars' motions (they are where Hipparcos measured them, epoch 1991.25).
- Stars of the Gaia catalogue (many faint nearby stars, Wolf 359 and TRAPPIST-1 among them, are not in
  Hipparcos).
- The stars as discs up close; binary orbits; generated systems (IS-5).
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
- `node --import tsx scripts/validate.ts`: every star row well formed, every system listing its
  planets, every galaxy row well formed with the four largest's sizes, every source credited.
