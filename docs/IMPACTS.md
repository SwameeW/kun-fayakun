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
- **Fragment velocities** (the paper's eqs. 38 to 43) are not yet applied; nor are fragments placed.
- **Material strength** (small bodies, the paper's c* = 5): the laboratory's bodies are taken as
  planet-size and strengthless.
- **Heat and craters**: the energy is accounted (as in Phase 1's mergers), but no crater, melt or
  surface mark is drawn.
- This is not a hydrodynamic (SPH) simulation, and no outcome is a prediction of a real impact.

## The steps, in order

| Step | What | Accepted when |
|---|---|---|
| 1 | Outcome regimes and remnant masses (this module) | The paper's definitions and closed forms, continuity, exact mass accounting (done) |
| 2 | The engine uses it at contact: a merger, or the largest remnant, the second, and a bounded number of debris bodies (at most 8 a collision, within the 64-body limit; what cannot be a body is an accounted unresolved reservoir) | Momentum, mass and the closed model's energy conserved through a collision; replay still bit-exact; no NaNs at overlap |
| 3 | Debris speeds from the paper's distribution (eqs. 38 to 43), placed deterministically | The ejected mass's speed distribution matches the fit; the same scenario gives the same debris |
| 4 | The reverse impact for hit-and-run projectiles | The paper's projectile remnant law |
| 5 | Impact heat and a crater size from a cited scaling law, as an event in the history (no surface change until terrain exists, Phase 4) | Crater diameters against the law's published examples |
| 6 | The interface: the outcome named in words, its regime and numbers, debris drawn as bodies | Browser tests; a showcase (a rogue world striking a planet) |

Decorative dust, if any, will be drawn separately from the bodies the integrator moves, and labelled
as such; a body hidden for the frame budget never removes mass.
