# M2 research notes (Chapters 3–6)

Checked on 2026-10-23 against primary sources, ready for `data/constants.json` when M2 resumes.
Nothing here is shown in the app yet.

## Numbers

| Proposed constant id | Value | Source (checked) |
|---|---|---|
| `jwst.momz14.redshift` | z = 14.44 ± 0.02 (NIRSpec/PRISM Lyman-α break); "a mere 280 million years after the Big Bang" | Naidu et al. 2025, *A Cosmic Miracle: A Remarkably Luminous Galaxy at z_spec = 14.44 Confirmed with JWST*, arXiv:2505.11263 (Open Journal of Astrophysics). Still the spectroscopic record in Oct 2026 as far as searches show. |
| `jwst.jades14.redshift.nirspec` | z = 14.32 (+0.08 / −0.20) | Carniani et al. 2024, *Spectroscopic confirmation of two luminous galaxies at z∼14*, Nature 633, 318 (arXiv:2405.18485) |
| `jwst.jades14.redshift.alma` | z = 14.1793 ± 0.0007 ([O III] 88 µm) | Schouws et al. 2025, ApJ, *Detection of [O III] 88 µm in JADES-GS-z14-0 at z = 14.1793* (arXiv:2409.20549). **The spec quotes 14.32; the ALMA value supersedes it. Show both.** |
| `firststars.redshift` | Population III star formation at z ≈ 30 and below; dominant until z ≈ 15–20 (≈ 100–180 Myr after the beginning in Planck 2018 cosmology) | Klessen & Glover 2023, ARA&A 61, 65 (arXiv:2303.12500) |
| `hubble.planck` | H₀ = 67.4 ± 0.5 km/s/Mpc (base ΛCDM) | Planck 2018 VI, A&A 641, A6, abstract |
| `hubble.act` | H₀ = 68.22 ± 0.36 (P-ACT + lensing + DESI DR1 BAO); 68.43 ± 0.27 with DESI DR2 | Louis et al. 2025, ACT DR6 ΛCDM parameters (arXiv:2503.14452) |
| `hubble.shoes` | H₀ = 73.04 ± 1.04 km/s/Mpc; "a 5-sigma difference with H₀ predicted by Planck+ΛCDM" | Riess et al. 2022, ApJL 934, L7 (arXiv:2112.04510) |
| `desi.darkEnergy.significance` | Preference for evolving dark energy over ΛCDM of 2.8–4.2σ depending on the supernova sample | DESI Collaboration 2025, DR2 Results II, Phys. Rev. D 112, 083515 (arXiv:2503.14738) |
| `nuclear.ni56.halfLife` | 6.075 ± 0.010 d (EC+β⁺ → Co-56) | ENSDF A=56 (Huo Junde, Huo Su, Yang Dong), via IAEA LiveChart API, extracted 2026-10-23 |
| `nuclear.co56.halfLife` | 77.236 ± 0.026 d (EC+β⁺ → Fe-56, stable) | same |
| `iron.typeIaShare` | SNe Ia and core-collapse SNe contributed **about equally** to cosmic iron | Maoz & Graur 2017, ApJ 848, 25 (arXiv:1703.04540). Supports "roughly half"; the spec's "or more" needs a second source before it is shown. |

## SDSS galaxy positions (Chapter 5)

- SkyServer DR20 SqlSearch works anonymously and returned 275,135 rows in seconds:
  `SELECT specObjID, ra, dec, z FROM SpecObj WHERE class='GALAXY' AND zWarning=0 AND z>0.01 AND z<0.8 AND (fiberID % 9)=0`
  (raw CSV sha256 `adea0ed1ed84dae7821ffa8ad87aaacc72d6669d99913cab157cca470dbef5d6`, cached at `.cache/sdss/raw.csv`).
- Breakdown: BOSS 152,571 (SDSS-III, run2d v5_13_2), SDSS-I/II legacy 94,757 (run2d 26), eBOSS 27,710 (SDSS-IV), SEGUE ~96.
  So the credit must include the SDSS-I/II, SDSS-III and SDSS-IV acknowledgements (copy them verbatim from
  sdss.org / sdss3.org / sdss4.org with a script, never retype), plus the SDSS-V overview paper for DR20:
  Kollmeier et al. 2026, AJ 171, 52 (arXiv:2507.06989).
- Plan: deterministic shuffle by a hash of specObjID, keep 200,000 so any prefix is a fair subsample (Low tier
  draws the first 80k); comoving distance with astropy `Planck18`; galactic Cartesian (three.js y = galactic
  north); Int16 ×4 quantised (x, y, z, redshift) in `public/assets/sdss/`.
