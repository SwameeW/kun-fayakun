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
- **Fragment velocities** (the paper's eqs. 38 to 43) are not yet applied: debris leaves the remnant on
  a 60-degree cone about the impact site at 1.05 to 1.6 times its escape speed, spread evenly, and the
  second remnant goes on downrange; the speeds are halved as often as needed so that a breakup never
  makes energy from nothing.
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
- **In the history.** For example: "Stone struck Planet at 20.6 km/s: partial accretion (the target
  grew), no debris thrown off, at 0 days; its crater about 18 km across (complex: a central peak and
  terraces), with the energy of 7.988 × 10⁴ megatons of TNT". The planet has the Earth's mass and
  size, and the stone is 1 km across.
- **Checked.**
  - The fit itself.
  - A 50 m iron body at 12.8 km/s gives a simple crater of about 1.5 km (Meteor Crater is 1.2 km).
  - A 1 km stony body at 20 km/s gives a complex crater of about 16 km on the Earth.
  - The Moon's transition, and its larger craters for the same impact.
  - No crater for a giant impact, or on a star.
- **Not yet:**
  - the crater's depth;
  - its mark on the world's surface (with the terrain the walk now reads, ledger GR-1 and GR-5);
  - melt;
  - the hit body's local heating.

## The steps, in order

| Step | What | Accepted when |
|---|---|---|
| 1 | Outcome regimes and remnant masses (this module) | The paper's definitions and closed forms, continuity, exact mass accounting (done) |
| 2 | The engine uses it at contact: a merger, a graze, or the largest remnant (the target's id), the second and up to six debris bodies, within the 64-body limit (debris without room returned to the remnant and reported) | Mass, momentum, angular momentum and the closed model's energy kept to 1e-12 through a breakup; pieces start clear of one another; replay bit-exact; a graze not struck twice (done: `tests/unit/impacts.spec.ts`, and in the browser `tests/explore/lab.spec.ts`) |
| 3 | Debris speeds from the paper's distribution (eqs. 38 to 43), placed deterministically. Research needed: the fit (log(dv dm/dv) = A - S v, v in units of the combined mass's escape speed at R_C1, relative to the largest remnant) is normalised by the histogram's bin width dv, which the paper does not state; until it is established from its figure 7 or a later source, the placeholder speeds stay | The ejected mass's speed distribution matches the fit; the same scenario gives the same debris |
| 4 | The reverse impact for hit-and-run projectiles | The paper's projectile remnant law |
| 5 | Impact heat and a crater size from a cited scaling law, as an event in the history (no surface change until terrain exists, Phase 4) | Crater diameters against the law's published examples (done: `src/sim/craters.ts`, `tests/unit/craters.spec.ts`, and in the browser `tests/explore/lab.spec.ts`; the mark on the surface is next) |
| 6 | The interface: the outcome named in words, its regime and numbers, debris drawn as bodies | Browser tests; a showcase (a rogue world striking a planet) |

Decorative dust, if any, will be drawn separately from the bodies the integrator moves, and labelled
as such; a body hidden for the frame budget never removes mass.
