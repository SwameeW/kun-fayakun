# Worlds that respond: climate in the laboratory

Ledger items WR-1 to WR-7, with ST-1's luminosities and SB-33's tidal disruption. The code is in
`src/sim/climate.ts` (the model), `src/sim/engine.ts` (when it runs), `src/explore/bodies/climate-view.ts`
(what the globe shows) and `src/ui/explore/lab-panel.ts` (the Climate section of the inspector).

## What it does

Every solid world in an experiment keeps a temperature for each of eighteen latitude bands, through
the year, from the light of every star in the experiment. Move the Earth out to 1.3 au and within a
few years its ice runs to the equator and it is white; double its carbon dioxide and it warms, slowly,
as its oceans take up the heat; double the Sun's mass and the Sun shines about twenty times as
brightly, and the Earth bakes. The panel gives each world's starlight, its mean and range of
temperatures, its ice and where liquid water could lie, its greenhouse, its surface pressure and its
air's main gases; a button paints the temperatures on the globe.

## The model

An energy balance model by latitude, as North, Cahalan and Coakley (1981, Rev. Geophys. Space Phys.
19, 91) set it out:

    C dT/dt = Q (1 - albedo) - OLR(T) + D d/dx [(1 - x^2) dT/dx],   x = sin(latitude)

- **Q**, the day's mean sunlight on the band from every star: its luminosity over 4 pi d^2, at the
  declination its direction makes with the world's equator (the spin axis the engine carries), by the
  standard daily-insolation formula (Berger 1978). A world turning faster than its temperatures change
  is described well by the day's mean; an airless world's noon is hotter than its band's mean, and the
  panel gives its noon too.
- **The Earth** is the paper's own model, every number from it (data/constants.json, `climate.ebm.*`):
  outgoing longwave radiation A + B T with A = 203.3 W/m^2 and B = 2.09 W/m^2/C (Budyko's empirical
  fit, which carries the water-vapour feedback); D = 0.649 W/m^2/C; the ice-free co-albedo 0.681 -
  0.202 P2(x) (more cloud and a lower Sun toward the poles); the co-albedo 0.38 where the year's mean is
  below -10 C (the ice line); heat capacities 4.7 B years for the oceans' mixed layer and 0.16 B years
  for land, in proportion to the ocean's 71% (NOAA). A greenhouse forcing the visitor adds (doubling
  CO2 adds 3.93 W/m^2, IPCC AR6) is taken from the heat sent to space.
- **Venus and Mars** have a grey atmosphere: OLR = sigma T^4 / (1 + 3 tau / 4) (Eddington's
  approximation), tau chosen so that the world at its fact-sheet irradiance and Bond albedo, with an even
  temperature, has its measured mean surface temperature (Venus 737 K: tau about 148; Mars 214 K: tau
  about 0.11). This is a parameterised greenhouse, labelled so in the panel. Their heat capacities and
  transport are illustrative (Venus's 92-bar air evens its temperatures out; Mars's thin air carries
  little).
- **Mercury, the Moon** and any solid body the visitor adds are airless: OLR = e sigma T^4 with an
  emissivity of 0.95 and no transport, a small (illustrative) heat capacity, their fact sheets' Bond
  albedos (an added body: 0.3).
- **Steps** are implicit (backward Euler, the radiation linearised), so a world of small heat capacity
  cannot oscillate; the climate is stepped once a day of the experiment's clock, after the gravity, and
  is part of the engine's state (checkpointed, undone and replayed exactly).
- **Where it starts.** The Earth's model has several climates for the same light (ice-free, today's, a
  snowball), so it starts from today's annual means (North's fit, 15 C - 28 C P2(x)) and settles into
  the nearest; other worlds have one, and settle from 250 K.

### Checked (`tests/unit/climate.spec.ts`)

- The daily insolation's closed forms: S / pi at the equator at equinox, S sin 23.44 degrees at the pole
  at midsummer, none in polar night, S / 4 over the globe and the year.
- The Earth today: about 16 C, ice poleward of 80 degrees, liquid water possible on most of the ocean.
  A tenth less light spreads the ice to about 50 degrees; a fifth less freezes it over at once (the
  large-cap instability; near -45 C); today's light again leaves it frozen (the hysteresis the
  ice-albedo feedback gives).
- Venus within 8 K of 737 K and nearly even from pole to equator; Mars within 15 K of 214 K.
- The Moon's equator at noon between 380 and 395 K (the fact sheet: 390 K).
- Water's boiling point: 373 K at one atmosphere, within 2% of 576 K at Venus's 92 bar.
- In the engine: the seasons (the north warmer when its pole leans toward the Sun, the south half a year
  later); a Sun of 1.2 times its mass warms the Earth by over 40 C within three years; climates replayed
  bit for bit through save and load.
- In the browser (`tests/explore/lab-tools.spec.ts`): the Earth's figures and gases; the temperature
  view; carbon dioxide doubled, logged, and the Earth warming; the two-body laboratory's planet moved to
  1.3 au freezing over.

## Water and ice (WR-4)

The Earth's ice is where its bands are below the ice line, drawn on the globe in the laboratory, over
land and sea alike. Liquid water could lie where a band is above water's triple point (273.16 K) and
below its boiling point at the surface pressure (the Clausius-Clapeyron relation with a constant latent
heat), the air thick enough (above 611.657 Pa), on the ocean's share of the band. The water itself is not
moved: no evaporation, clouds, rain or sea level (the hydrosphere's 1.4 x 10^21 kg is shown as a fact).

## Starlight (ST-1, in part)

The Sun shines at the IAU's nominal 3.828 x 10^26 W. Any body of 0.075 solar masses or more (the least
that burns hydrogen) shines as a main-sequence star of its mass by Eker et al.'s (2018, MNRAS 479,
5491) six-piece relation (0.179 to 31 solar masses; its end pieces extended beyond, said so). A star's
light follows its mass when the visitor changes it: the Sun at 1.2 times its mass gives (1.2)^4.33,
about 2.2, times its light; at twice its mass about twenty. The scene is still lit by the Sun alone
(ledger ST-2).

## Tidal disruption (SB-33)

A body at least 100 km in radius (held by its own gravity, not its strength) and at most a tenth of a
neighbour's mass, inside the neighbour's fluid Roche limit (2.44 R (rho_neighbour / rho_body)^(1/3)) on
an orbit about it that does not strike it, is torn apart: into eight equal pieces strung through its own
extent along the line to the neighbour, each moving as the body turned with its orbit, and a cloud of
600 test particles of its dust on a shell just outside it. Mass and momentum are kept exactly, angular
momentum by the first piece's spin, the energy the split takes moved into the internal reservoir.
Between two pieces (and between a piece and its dust) there is no gravity and no merging: inside the
Roche limit the tide outpulls what held them, so each goes its own way, and in a day the pieces are
spread round the neighbour in a ring of dust. A body falling onto its neighbour is not torn: it strikes
first (the impact model's). This is a coarse stand-in for a body drawn out into a ring: the pieces
cannot gather again into a moon outside the Roche limit. Checked: `tests/unit/impacts.spec.ts` (the
accounting, the arc, the dust) and `tests/explore/lab-tools.spec.ts` (the Moon put at 15,000 km).

## Not modelled

- **Winds (WR-7)** and the circulation; clouds and their feedbacks beyond Budyko's fit; the oceans'
  currents (the transport is a diffusion).
- **Land and sea apart.** Each band has one temperature, the Earth's mixed in proportion; the seasons
  are therefore a few degrees, as over the southern oceans, not the tens of degrees of the northern
  continents.
- **Day and night** (the day's mean is used); the Moon's night-side 95 K is not reached.
- **Materials (WR-1)**: interiors, compositions beyond the air's main gases, and the water's
  inventory moving between reservoirs.
- **Tidal friction**: tides that slow a world's turn or move a moon's orbit. Their strength (each world's
  tidal response and its lag) is not settled enough to cite world by world; the Earth's is set by its
  oceans.
- **Impacts' heat** beyond the crater's glow does not warm the world's climate.
