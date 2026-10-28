# Impacts and debris (Phase 2)

Phase 2 of the Universe Sandbox and SpaceEngine brief: collisions in the orbital laboratory that
end in more than a merger. This page is the plan, the model chosen, what is built so far, and how
each step will be accepted. Status lives in `docs/FEATURE-LEDGER.md` (IM-1 to IM-6).

## The model: Leinhardt and Stewart (2012)

`src/sim/impacts.ts` implements the outcome regimes and scaling laws of Z. M. Leinhardt and S. T.
Stewart, "Collisions between gravity-dominated bodies. I. Outcome regimes and scaling laws", ApJ
745, 79 (2012; arXiv:1106.6084), following the procedure in their appendix:

1. The share of the projectile in the collision's path, alpha, from the impact parameter (eqs. 7,
   11): head-on all of it, grazing a sliver.
2. **Merging** below V'_esc, the escape speed of the target and that interacting mass (eq. 53).
3. The disruption criterion Q*_RD: for equal masses c* (4/5) pi rho1 G R_C1^2 (eq. 28), corrected
   for the mass ratio (eq. 23) and the angle (eq. 15). c* = 1.9 and mu-bar = 0.36, the paper's fit
   for strengthless planet-size bodies.
4. The speeds where the largest remnant falls to the target's mass (**erosion** begins) and to a
   tenth of the total (**super-catastrophic**), from the universal law (eq. 5) and eq. 1.
5. Between merging and erosion: **partial accretion** head-on, **hit-and-run** grazing (b above
   b_crit = R / (R + r), eq. 6).
6. The largest remnant by the universal law, or the super-catastrophic power law (eq. 44, eta =
   -1.5) beyond Q_R / Q'*_RD = 1.8; the second largest by eq. 37 (beta = 2.85), held to no more than the
   largest (far into the super-catastrophic regime the fit would exceed it); the rest is debris.

Mass is accounted exactly: largest + second + debris + the projectile (in hit-and-run) is the total.
For an Earth struck head-on by a Mars-mass body the regimes fall at 11.5 km/s (merging below),
21.6 km/s (erosion from) and 65.9 km/s (super-catastrophic from); at 12 km/s, head-on the Earth
grows by 7.4 % of its mass, at 45 degrees the impactor passes on. A planet falling into the Sun
merges: no realistic speed approaches the Sun's 618 km/s.

`tests/unit/impacts.spec.ts` checks the model against the paper itself: at the paper's closed-form
critical speed (eq. 30) the specific energy is Q*_RD and half the mass remains (the definition of
Q*_RD); the regimes come in the paper's order and join continuously where they meet; the largest
remnant only shrinks as the speed rises; grazing impacts lower the merging speed and raise the
disruption criterion; and every outcome sums to the total mass.

## Not modelled (yet), and said so

- **The projectile in hit-and-run** carries on whole; the paper's reverse impact (its own erosion)
  comes next.
- **Fragment velocities** follow Chambers (2013, Icarus 224, 43), the convention N-body studies of
  planet formation use: every piece leaves at 1.05 times the pair's mutual escape speed at contact,
  sqrt(2 G (M_t + M_p) / (R_t + R_p)), the second remnant on downrange and the debris evenly spaced
  round the collision's plane, half a step off downrange so none follows the second remnant (each
  piece moved out until clear of the others). The debris have a ring of their own, so their momenta
  cancel and only the second remnant sets the largest back (a shared ring of unequal pieces sent the
  largest into its own debris, and a fast breakup cascaded into dozens of collisions). The speeds
  are halved as often as needed so that a breakup never makes energy from nothing, so after a slow
  breakup some pieces fall back and are accreted again: a Mars-mass body striking the Earth at 1.1
  times the escape speed has its remnant come down again some fifteen hours later (ledger IM-5).
  Leinhardt and Stewart's own fitted speed distribution (their eqs. 38 to 43) is not used: its
  normalisation needs a histogram bin width the paper does not state.
- **Material strength** (small bodies, the paper's c* = 5): the laboratory's bodies are taken as
  planet-size and strengthless.
- **Heat and craters**: the energy is accounted, and a cratering impact's crater size is reported
  ([Craters and energy](#craters-and-energy)), but no crater, melt or surface mark is drawn on a
  world yet.
- This is not a hydrodynamic (SPH) simulation, and no outcome is a prediction of a real impact.

## Craters and energy

`src/sim/craters.ts`, at every merger and breakup the engine resolves (not a graze):

- **The crater.** The scaling Collins, Melosh and Marcus (2005) use in the Earth Impact Effects
  Program (Meteoritics & Planetary Science 40, 817):
  - the transient crater by pi-group scaling for rock, after Schmidt and Housen (1987):
    D_tc = 1.161 (rho_i / rho_t)^(1/3) L^0.78 v^0.44 g^-0.22 sin^(1/3) theta (SI units; theta from
    the horizontal, from the impact parameter as theta = arccos b);
  - the final crater: simple, 1.25 D_tc, up to the simple-to-complex transition; complex beyond it,
    1.17 D_tc^1.13 / D_c^0.13 (McKinnon and Schenk 1985), D_c the transient diameter there.
- **The transition.** A final diameter of 3.2 km on the Earth (D_c = 2.56 km), scaled inversely
  with surface gravity as the transition is observed to scale: about 19 km on the Moon, 8.5 km on
  Mars.
- **Which impacts crater.** Targets of up to ten Earth masses are taken to have a solid surface;
  beyond that, the worlds known are giants of gas and ice, and stars. A crater wider than the
  target's radius means the target is reshaped, not cratered (a giant impact), and none is given.
- **The materials.** The target's crust is taken as crystalline rock, 2,750 kg/m³ (or the body's own
  density where that is lower). The projectile has its own bulk density, from its mass and radius.
- **The energy.** The pair's kinetic energy at contact in their centre of mass frame, ½ μ v², the
  fall included. The history gives it in megatons of TNT (4.184 × 10¹⁵ J each). The engine's own
  "heat" is its bookkeeping: what the closed model's energy loses when the contact is resolved,
  which leaves out the last part of the fall.
- **The depth and the rim.** Rim crest to floor: a simple crater's from its breccia lens (the
  paper's eqs. 23 to 26: the transient crater D_tc / (2 √2) deep, a lens of 0.032 D³ falling back
  into it); a complex one's from Herrick et al.'s (1997) fit to the fresh craters of Venus, 0.4 D^0.3
  km (eq. 28), which the paper uses for the Earth. Fresh complex craters are deeper on lighter worlds,
  so elsewhere that is scaled by (g_Earth / g)^0.533, the power that carries it onto Pike's (1977)
  fit to the Moon's, 1.044 D^0.301 km: an interpolation by surface gravity between two published
  fits, not a law of its own. The rim stands 0.07 D_tc⁴ / D³ above the ground around (eq. 48).
- **Where.** The point the projectile first touched (along its path in the step it struck), kept in
  the world's own frame as the world stood then (the IAU rotation model, or the spin the visitor
  set), so the crater turns with the surface. The history gives it in planetocentric degrees.
- **Drawn** on the worlds the explorer shows with a solid surface (the Earth, the Moon, Mercury and
  Mars; `src/explore/bodies/marks.ts`), at its size, depth and rim:
  - a simple crater a bowl; a complex one a flat floor with a central peak and a wall up to the rim
    (the floor's width, 0.55 of the radius, and the peak's height are illustrative);
  - the ejecta beyond the rim thinning as the cube of the distance (the paper's eq. 47);
  - the relief at its true slope times the world's own relief map's exaggeration (2.5 for the Moon,
    Mercury and Mars, 12 for the Earth, as planets.json records), so a new crater stands among the
    old ones at the same scale; inside and near the rim the old relief and colour are buried;
  - fresh rock bright on the Moon and Mercury, with rays running out to fourteen radii in uneven
    lengths, as from their young craters; dark on Mars, where an impact blows the bright dust off the
    basalt; grey brown on the Earth's land (the sea closes over an ocean impact: nothing is drawn
    there); the colours, the ejecta's hummocky texture and the rays' pattern are illustrative;
  - the floor glows while its melt is hot (about 2,000 K, illustrative), as bright as Planck's law makes
    its surface's temperature while a crust forms over it (εσT⁴ = k(T_m − T) / √(πκt), Turcotte and
    Schubert 2014; `src/explore/lab-fx/heat.ts`), held to the glow's drawn strength: below the visible glow
    (about 1,100 K) within about three minutes of simulated time (fourteen for melt at 3,000 K), so seen when the clock slows for the impact (docs/LAB.md, "Slow
    down for events"); a giant impact (no crater) leaves the face it struck glowing the same way, its melt
    hotter (its energy per kilogram over rock's heat capacity, 1,500 to 3,000 K), and its bodies glowing;
  - every merger or breakup has a fireball at the contact, its size from the impact's energy (Collins,
    Melosh and Marcus 2005), its colour and brightness by Planck's law under a ceiling, slowed for
    safety (docs/LAB.md, "How experiments are drawn");
  - nothing appears at once (flash safety): a crater eases in over about a second and a half, its
    glow rises at most twice its full strength a second and falls at most a third of it a second, so
    there is never a step in brightness; a crater smaller than a few pixels fades out, and its rays
    need it larger still, rather than shimmer.
- **In the history.** For example: "Stone merged into Moon at 0.04 days; its crater about 9 km
  across and 1.8 km deep (a simple bowl), with the energy of 907 megatons of TNT; at 2.9° S, 6.1° W"
  (a stone 1 km across dropped on the Moon from 300 km, on the side facing the Earth).
- **Checked.**
  - The fit itself.
  - A 50 m iron body at 12.8 km/s gives a simple crater of about 1.5 km (Meteor Crater is 1.2 km),
    about a fifth as deep as it is wide.
  - A 1 km stony body at 20 km/s gives a complex crater of about 16 km on the Earth, 0.4 D^0.3 km deep.
  - The Moon's transition, its larger craters for the same impact, and Pike's lunar depths.
  - No crater for a giant impact, or on a star.
  - In the browser, a stone dropped on the Moon from the Earth's direction strikes within ten
    degrees of 0° N, 0° E (the IAU model's prime meridian faces the Earth; libration aside), and the
    crater stays there as the Moon turns.
- **Not yet:**
  - the crater on the ground a walker stands on (the walk's terrain, ledger GR-5);
  - the hit body's heating beyond the glow (its climate, ledger WR-2; the melt kept below the crust,
    roadmap W2.3).

## The steps, in order

| Step | What | Accepted when |
|---|---|---|
| 1 | Outcome regimes and remnant masses (this module) | The paper's definitions and closed forms, continuity, exact mass accounting (done) |
| 2 | The engine uses it at contact: a merger, a graze, or the largest remnant (the target's id), the second and up to six debris bodies, within the 64-body limit (debris without room returned to the remnant and reported) | Mass, momentum, angular momentum and the closed model's energy kept to 1e-12 through a breakup; pieces start clear of one another; replay bit-exact; a graze not struck twice (done: `tests/unit/impacts.spec.ts`, and in the browser `tests/explore/lab.spec.ts`) |
| 3 | Debris speeds, placed deterministically: Chambers (2013), 1.05 times the mutual escape speed, the second remnant on downrange and the debris evenly spaced round the collision's plane (their momenta cancel), half a step off downrange. (The paper's own fit, log(dv dm/dv) = A - S v, is normalised by a histogram bin width dv it does not state, so it is not used.) | Pieces start clear of one another and leave at the stated speed; the same scenario gives the same debris; slow breakups re-accrete, fast ones do not cascade (done: `tests/unit/impacts.spec.ts`) |
| 4 | The reverse impact for hit-and-run projectiles | The paper's projectile remnant law |
| 5 | Impact heat and a crater size from a cited scaling law, as an event in the history (no surface change until terrain exists, Phase 4) | Crater diameters against the law's published examples (done: `src/sim/craters.ts`, `tests/unit/craters.spec.ts`, and in the browser `tests/explore/lab.spec.ts`; the mark on the surface is next) |
| 6 | The interface: the outcome named in words, its regime and numbers, debris drawn as bodies | Browser tests; a showcase (a rogue world striking a planet) |

Decorative dust is drawn apart from the bodies the integrator moves (`src/explore/lab.ts`, ledger
IM-4): at each impact a plume of points thrown up from the site within a 40 degree cone, rising and
falling back over four seconds of the wall clock whatever the experiment's rate, its height four
times the crater's width (at least 20 km, at most the target's radius; half the radius for an
impact with no crater). It turns with the world when the impact was on one drawn with its surface.
It is dim and fades in and out (flash safety), and none of it is mass: the debris that is are
bodies. A body hidden for the frame budget never removes mass.
