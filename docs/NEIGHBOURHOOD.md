# Among the stars (ledger IS-1 to IS-4, IS-7)

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

## Coordinates (IS-1)

Positions are kept in double precision (parsecs from the Sun, in the explorer's render frame:
ecliptic J2000, from right ascension and declination by the obliquity, as the sky does), and drawn
relative to the camera each frame, so single precision on the GPU loses nothing near any star. One
frame suffices out to the 1,000 parsecs reached; hierarchical sectors for the galaxy and beyond wait
for IS-6.

## Not yet

- The stars' motions (they are where Hipparcos measured them, epoch 1991.25).
- Stars of the Gaia catalogue (many faint nearby stars, Wolf 359 and TRAPPIST-1 among them, are not in
  Hipparcos).
- The stars as discs up close; binary orbits; generated systems (IS-5); the galaxy, the Local Group and
  the cosmic web (IS-6).

## Tests

- `tests/unit/neighbourhood.spec.ts`: the units (a parsec in km and light years); Proxima Centauri at
  1,000 / 771.64 parsecs (4.23 light years) and Sirius at 2.64; absolute magnitudes; only stars known
  to a fifth placed; the planets and the archive's calculated values; the search.
- `tests/explore/stars.spec.ts`: out among the stars, the Sun's neighbours, a flight to Proxima
  Centauri with its planets drawn and marked, a search that finds Sirius and flies there, Esc
  stopping a flight and then going back to the solar system.
- `node --import tsx scripts/validate.ts`: every star row well formed, every system listing its
  planets, every source credited.
