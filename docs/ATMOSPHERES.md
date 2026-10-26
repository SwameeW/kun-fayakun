# Down through the clouds (ledger GR-6)

In the suit, down through an atmosphere the way a probe went, with what the probe measured at every
height. Two atmospheres have been measured all the way down by a probe whose readings are archived:
Venus's (the Pioneer Venus probes, 9 December 1978) and Jupiter's (the Galileo probe, 7 December
1995). The code is in `src/explore/descent/` (its own chunk) and `src/ui/explore/descent-hud.ts`; the
data in `public/assets/descent/`, written by `scripts/descent/profiles.py` from NASA's Planetary Data
System.

## What a visitor does

- **Begin.** With Venus or Jupiter in view, "Down through the clouds" in the navigator.
  `app.earthCommand({ kind: 'descent', world })` does the same.
- **Where.** Over the place beneath the camera (most often in daylight, as the explorer frames a
  world's lit face). The readings are the probe's, from where and when it went down: the explorer's
  clock runs 2026 to 2035 and cannot reach 1978 or 1995. The readout gives both places.
- **The fall.** It starts at the top of the probe's column and falls by itself, gently and evenly in
  the logarithm of the pressure (a factor e about every eight seconds), as a probe's fall slows in
  thicker air.
  - S (or Faster, held) falls five times faster; W (or Climb, held) climbs; Shift four times faster
    again;
  - Hold stops the fall;
  - the depth slider goes straight to any height in the column, evenly in pressure;
  - a drag (or the arrows) looks round;
  - Esc (or Back to orbit) dips back out to the orbit the descent began from.
- **The bottom.** On Venus, the ground: the walk lands there (docs/WALKING.md), its dip taking the
  view straight from the descent to the ground. On Jupiter, 22 bar, where the probe's signal stopped
  ("nothing below has been measured").

## The readings

`src/explore/descent/profile.ts` reads a profile and answers for any height in its span: pressure and
density interpolated in their logarithms (they fall exponentially with height), temperature linearly.

- **Venus.** The heights are above the 6,052.0 km radius at the Large Probe's landing site (4.4° N,
  56.0° W), as the probes' tables give them.
  - From 128 km to 70.5 km, the Day Probe's entry (its accelerometers' densities, the pressure by
    hydrostatic integration, the temperature from the equation of state).
  - From 64.8 km to the ground, the Large Probe's descent: 92.16 bar and 731 K on the ground.
  - Between 64.8 and 70.5 km neither table has readings: interpolated there, and the readout says
    so.
  - One bar is near 50 km: there, the pressure at the Earth's surface.
- **Jupiter.** The heights are above (or below) the 1-bar level at the probe's entry site (6.4° N),
  from the Atmospheric Structure Instrument: its entry profile above 0.44 bar, its descent profile
  (the dry adiabat that fits its measurements, as the archive's notes say) down to 22.05 bar and
  428 K, 132.5 km below the 1-bar level. One row whose density the archive gives as zero (a missing
  value) is left out. The winds are the Doppler Wind Experiment's: 87 m/s near 0.57 bar, rising to
  172 m/s near 20 bar.
- **The clouds** are the nephelometers' readings, made relative: Venus's backscatter above its
  clear-air floor (its median below 45 km, where the Large Probe saw no cloud), Jupiter's counts above
  zero (the mean of the 5.8, 16 and 40 degree channels, uncalibrated), each over its 98th percentile
  (not its largest reading: one spike would leave the deck itself faint). The readout puts them in
  words: clear air, thin cloud, cloud, thick cloud. Venus's show its deck from about 47 to 65 km,
  thinner near 50 km between the lower cloud and the middle one.

## What is drawn (illustrative)

No globe: a sphere round the eye.

- Looking up, the cloud between the eye and the top of the column, over the clear sky above it.
  Looking down, the cloud below over the deep. The haze's opacity along a view is the column of the
  nephelometer's relative reading through the slant (times a factor per world: the nephelometers
  measured scattering, not visibility).
- The light reaching each height dims with the cloud and the air above it, down to a few hundredths
  of the light above the atmosphere on Venus's ground; the clouds' colour deepens with it (Venus's
  yellow-white cloud tops to orange depths; Jupiter's cream to brown).
- The Sun's disc and glare show only through the cloud above along the line to it; the stars only by
  night, through all of it.
- The colours are illustrative. The readout carries the science.

## Not drawn

- Saturn, Uranus and Neptune: no probe has gone down into them. Titan's haze (the Huygens probe's
  readings) waits for Titan itself (ledger IS-1).
- Weather, lightning, the clouds' structure in three dimensions, and the probes themselves.

## Sources

`data/sources.json` (shown on the Sources page) and `LICENSES`:

- `pds-pioneer-venus-sed`: the Pioneer Venus Special Events Data bundle (doi:10.17189/m5zf-6f12);
- `pds-galileo-probe-asi`, `pds-galileo-probe-nep`, `pds-galileo-probe-dwe`: the Galileo probe's
  volumes.

Each source file's sha256 is pinned in `scripts/descent/profiles.py`.

## Tests

- `tests/unit/descent.spec.ts`: Venus's ground (92.16 bar, 731 K), one bar near 50 km, the gap
  between the probes marked, the pressure between two rows their geometric mean; the clouds where
  the nephelometer saw them; Jupiter's one bar at its zero (about 166 K), its last reading, its winds.
- `tests/explore/descent.spec.ts`: Venus at one bar (the readout the profile's), between the probes,
  down to the ground and the walk landing there; Jupiter at 5 bar with its wind, its bottom where the
  signal stopped, and Esc back to orbit.
- `node --import tsx scripts/validate.ts`: both profiles present, in order, physical (no zero or
  negative pressure, temperature or density), and credited.
