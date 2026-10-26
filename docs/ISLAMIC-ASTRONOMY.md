# The qibla and the new moon

The explorer's section on the astronomy of the qibla and the Islamic calendar (navigator: "Qibla
and the new moon"; `src/explore/islamic`, `src/ui/explore/islamic-panel.ts`). It computes from the
explorer's own ephemeris and shows its numbers at their actual precision. It gives no rulings: the
qibla is shown as a great-circle direction from true north, and the crescent map describes what the
sky allows, not when a month begins.

## What it shows

- **The qibla** from the point beneath the camera, or from a place found by name (Natural Earth's
  places): its bearing from true north, the nearest compass point, and the great-circle distance to
  the Kaaba; and, on request, the path drawn on the globe, ending at the Kaaba's coordinates. The
  Kaaba is never depicted: lines end at a point, and Makkah is never framed closer than the
  explorer's own minimum (`MAKKAH_FRAME`, 30 km).
- **The Sun over the Kaaba.** The next two times the Sun passes the Kaaba's zenith (late May and
  mid-July), when every upright shadow in daylight points away from the qibla, and the two times it
  passes the zenith of the point opposite (mid-January and late November), when shadows on that
  side of the world point toward it. "Go" sets the clock to the moment, pauses it, and shows the
  lit face of the Earth.
- **The golden latitude.** The latitude that divides the meridian from pole to pole in the golden
  ratio, drawn beside the Kaaba's own, with the actual sizes: the Kaaba's ratio of its distances to
  the South and North Poles is 1.6210 against the golden ratio's 1.6180, and the golden latitude
  runs 8.7 km south of it. A popular claim says the Kaaba lies exactly at the golden ratio; the
  explorer shows how near it is instead, and says it is not offered as evidence of anything.
- **New moons** (geocentric conjunctions in ecliptic longitude), the Moon's age at the date shown,
  and stepping to earlier and later ones.
- **The new crescent's map** for the evening of a new moon's day and the two evenings after: a dot
  every 2 degrees between 60 S and 60 N, coloured by Yallop's zone at that place's best time, with a
  legend in words and the place in view read out (zone, q, best time).
- **The date in the Umm al-Qura calendar** beside the time machine's, named as such.
- **Astronomers and geometers of the Islamic world**: Raqqa (al-Battani), Isfahan (al-Sufi),
  Maragheh (al-Tusi's observatory), Samarkand (Ulugh Beg's), the Darb-i Imam in Isfahan (its girih
  tiles and the golden ratio), and Istanbul (Taqi al-Din's), each a note and a place to fly to.

None of it appears in the orbital laboratory: its Earth is an experiment's.

## Methods

| Quantity | Method | Source |
|---|---|---|
| The Kaaba's position | 21.4225 N, 39.826167 E | Wikidata Q29466, coordinate location (CC0), retrieved 2026-10-26 |
| Qibla bearing and distance | Initial great-circle bearing and haversine distance on a sphere of the Earth's mean radius | Standard spherical trigonometry |
| Sun and Moon | The explorer's ephemeris (JPL approximate elements for the Earth; JPL Horizons table for the Moon, Hermite-interpolated); the Sun's aberration and light-time (20.49" at 1 au); IAU 1976 precession to the date; nutation left out | `src/astro/ephemeris.ts`; Lieske et al. (1977) as given by Meeus |
| Sidereal time | IAU 1982 GMST, UT1 taken as UTC (within 0.9 s) | Meeus, *Astronomical Algorithms*, ch. 12 |
| Sunset, moonset | Hour angle at the setting altitude, iterated: the Sun's centre at -50' (34' refraction, 16' semi-diameter); the Moon's centre at 0.7275 of its horizontal parallax less 34' | Meeus, ch. 15 |
| Topocentric Moon | Observer on the WGS 84 ellipsoid at sea level | Meeus, ch. 11 and 40 |
| Crescent visibility | Yallop's q-test at the best time (sunset plus 4/9 of the time to moonset): q = (ARCV - (11.8371 - 6.3226 W' + 0.7319 W'^2 - 0.1018 W'^3)) / 10, ARCV the geocentric airless altitude difference, W' the topocentric crescent width (SD'(1 - cos ARCL)); zones A (q > +0.216), B (> -0.014), C (> -0.160), D (> -0.232), E (> -0.293), F; not used beyond 63 degrees of latitude | B. D. Yallop, NAO Technical Note 69 (1997); the zones as published with the Utrecht global maps |
| The Sun over the Kaaba | Each day's solar transit at the Kaaba (and at its antipode); the day the Sun comes nearest the zenith | The ephemeris above |
| Golden latitude | Meridian arcs on the WGS 84 ellipsoid (Helmert's series); the latitude whose distances to the poles are in the golden ratio, by bisection | WGS 84 (a = 6378.137 km, f = 1/298.257223563) |
| Hijri date | The browser's Umm al-Qura calendar (ICU, `islamic-umalqura`) for the civil day in UTC | Unicode CLDR / ICU |
| Heritage places | Wikidata coordinate locations (P625): Q283368, Q42053, Q2461462, Q608580, Q1165662, Q3348357 | Wikidata (CC0), retrieved 2026-10-26 |

## Checked against published values

`tests/unit/islamic.spec.ts` (and the numbers below, from the same functions):

| Check | Published | Computed |
|---|---|---|
| The twelve new moons of 2026 | Espenak's table (to the minute) | all within 61 s (largest: 19 March) |
| Sun over the Kaaba, July 2026 | 15 July, 09:26:44 UTC | 15 July, 09:26:41 UTC |
| Sun over the Kaaba, May 2026 | 27 or 28 May, 09:18 UTC (sources differ on the day) | 28 May, 09:17:59 UTC, 0.066 degrees from the zenith |
| Sun over the opposite point | about 21:30 UTC mid-January; 21:09 UTC late November | 13 January 21:29:30; 28 November 21:08:45 UTC |
| Qibla from New York | 58.5 degrees | 58.50 degrees (10,302 km); also Kabul and Islamabad within 0.3 degrees |
| Ramadan 1447: 17 February 2026 | No naked-eye crescent anywhere in the Arab or Islamic world | Zone F (or no crescent) in Makkah, Riyadh, Cairo, Istanbul, Karachi, Islamabad, Jakarta, Kuala Lumpur, Rabat, Dakar and Lagos |
| Ramadan 1447: 18 February 2026 | Easily visible in the UK and most of the world | Zone A in London, Makkah, Cairo, Rabat and Istanbul |
| Umm al-Qura | 1 Ramadan 1447 = 18 February 2026; 1 Shawwal 1447 = 20 March 2026 | the same |
| WGS 84 quarter meridian | 10,001.965729 km | the same, to a millimetre |

In the browser (`tests/explore/islamic.spec.ts`), going to the computed moment of the Sun over the
Kaaba puts the explorer's own Sun (its "Today on Earth" point beneath the Sun) within half a degree
of the Kaaba. That check found, and now guards, a fault in the Living Earth: the direction it used
for the Sun pointed away from it, so the bulletin named the point opposite the Sun (and swapped
dawn and dusk) and day-side satellites were drawn as if in the Earth's shadow.

## Limits

- **Qibla on a sphere.** The great circle on a sphere of mean radius; on the ellipsoid the bearing
  differs by at most a few tenths of a degree. Bearings are from true north; a compass needs the
  local magnetic declination.
- **Yallop's test is one criterion.** Others (Odeh's, the South African Astronomical Observatory's,
  Schaefer's) draw the lines elsewhere, and weather decides any real evening. The map is at sea
  level, with standard refraction, between 60 S and 60 N, every 2 degrees; between the dots it says
  nothing.
- **Times to the minute.** Nutation, UT1 - UTC and the approximate planetary elements leave errors
  of seconds; the interface shows minutes.
- **Umm al-Qura** is Saudi Arabia's civil calendar, computed in advance. Communities that begin each
  month by sighting may be a day apart from it, and the Islamic day begins at sunset, not midnight.
- **Not shown:** prayer times. They depend on conventions for dawn and nightfall (solar depressions
  from 15 to 19.5 degrees) and for the afternoon prayer, which differ between communities; the
  section shows the Sun's and the Moon's positions, not times to pray.
- **Review.** Like the field notes' prophets' lands, this section awaits review by a qualified
  scholar (REVIEW.md) before public release.
