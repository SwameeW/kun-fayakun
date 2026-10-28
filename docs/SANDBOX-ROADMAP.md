# Sandbox roadmap: the orbital laboratory

**Status:** plan dated 2026-10-26, branch `worlds`. Nothing in this document had been built when it was written; the time and rewind work of M1 started the same day (batch 1). M1's other packages were built on 2026-10-27 (batch 2): each package below has a status line saying what was built and what was not.

**Covers:** `#/universe/lab`. That means `src/sim/**` running in the worker, plus `src/explore/lab.ts`, `src/ui/explore/lab-panel.ts` and `src/ui/explore/lab-lessons.ts`.

**Built from:**
- Three designs, with a review of each:
  - Phys: physical fidelity.
  - Vis: visual spectacle at 60 fps.
  - Exp: the visitor's experience.
- The working diagnosis of 2026-10-26 (kept locally, not in the repository). It has four relevant areas: time controls, the laboratory's visual effects, navigator and panel layout, and the AI audit's notes on lab command validation.
- A reading of the code and of `docs/LAB.md`, `docs/IMPACTS.md`, `docs/CLIMATE.md`, `docs/FEATURE-LEDGER.md`, `docs/CONTRACTS.md` and `scripts/check-bundle.ts`.

> The real universe is the reference. The sandbox is the thought experiment. Reflection is the purpose.

**Feature references.** Design features appear as `Phys-F7`, `Vis-F11` or `Exp-F6`. Work packages are numbered `W<milestone>.<n>`.

---

## 1. What this roadmap commits to

The plan has eight milestones, and the visible work comes first:
- **M1 to M3** change what the visitor sees and can do.
- **M4 to M7** turn the laboratory into an instrument a careful visitor can trust.
- **M8** holds optional new scales. Each item there needs a decision from the owner.

Every milestone is a shippable increment with:
- exact files;
- byte budgets, including new lazy chunks with their own rows in `scripts/check-bundle.ts`;
- frame budgets;
- data sources and their licences;
- the automated tests that prove it.

Ideas were kept only if they are verified as feasible and honest. Duplicates across the three designs are merged. Every correction the reviews found is applied (section 4). Ideas that were not adopted are listed with reasons (section 12).

**Gate before M1.** CI must be green on `worlds`: build, `check-bundle`, unit tests, and the Playwright webgpu, webgl2 and mobile projects. The owner made this a precondition ("CI is done with errors"). No roadmap work merges while CI is red.

## 2. Rules for every milestone

1. **Numbers.** Every number on screen comes from the model or from cited data. Constants go in `data/constants.json` with a source and are read through `figure()`. Every model is labelled as either *model* (with a citation) or *illustrative*. On-screen wording must pass `scripts/lib/rules`: "integrated ahead" and "guess", never "predict".
2. **Determinism.**
   - Drawing never feeds the edit log.
   - New physics either goes through logged, validated commands, or is derived and replayable from the log.
   - Version-1 scenario files replay bit for bit, guarded by recorded state hashes.
   - Anything that changes outcomes sits behind schema 2's `physics` block (W4.1).
3. **Flash safety** (CONTRACTS rule 6 and WCAG 2.2 SC 2.3.1).
   - Every change in brightness is eased over at least 0.5 s or passes through `ctx.exposure`.
   - Never more than 3 flashes a second. The runtime guard targets 2.
   - Reduced motion gets crossfades only.
   - Flash areas are measured in screen pixels: 10° of the viewer's visual field is 341 × 256 CSS px at 1024 × 768, scaled with the viewport.
4. **Touch and keyboard.** Every control is at least 44 px each way on a coarse pointer (CONTRACTS, touch rule). Every new action has a keyboard path.
5. **Bytes.**
   - The shell does not grow.
   - Explorer glue is counted per package (section 5.1).
   - New feature code lives in the lab chunk or in lazy sub-chunks with their own rows.
   - Laboratory CSS goes in a lazy `src/ui/styles/lab.css`, imported by the panel and counted with the laboratory.
6. **Physics location.** All physics runs in the worker. A second instance of the same worker module (0 extra bytes) serves the baseline, twins, predictions and the bench from M3 on.
7. **Definition of done** for every package:
   - its tests pass on the webgpu, webgl2 and mobile projects;
   - `check-bundle` passes;
   - `docs/LAB.md`, `docs/IMPACTS.md` or `docs/CLIMATE.md`, the matching `FEATURE-LEDGER.md` rows and `src/i18n/en.lab.json` are updated;
   - anything illustrative is listed in the view's `illustrative[]`.

## 3. Where the laboratory stands (checked in the code on 2026-10-26)

| Area | Finding | Where |
|---|---|---|
| Validation | Live edits are checked more loosely than imports. The `mass`, `fixed` and `rename` handlers do not check that the id exists, and no live handler applies `IMPORT_LIMITS` (GM ≤ 1e14). Pressing Double 10 times on the Sun gives 1.36e14, so the save then refuses to restore. | `lab.ts` handlers; `engine.ts:789` |
| Validation | `validateScenario` has no `setAtmosphere` branch. It falls through to `'unknown edit'`, so any saved experiment with an atmosphere edit cannot be restored. | `engine.ts:892-894` |
| Validation | Ids created during a run must match `^(remnant\|debris)-\d+(-\d+)*$`. That pattern misses torn pieces (`${id}-piece-N`), so an edit on a piece saves but does not restore. | `engine.ts:~876`, `nbody.ts:603` |
| Validation | Commands sent before the first snapshot are dropped (`if (!s) return`). `run` accepts any rate: NaN, or 1e15. | `lab.ts:~1465-1609`; `worker.ts:168` |
| Time | The worker only takes whole steps (`while (owed >= engine.dt …)`), and owed time is capped at rate × 0.25 s + dt. In the two-body lab dt is 50,226 s, so at 10 s/s one step lands about every 84 minutes of wall time and the date never changes. | `worker.ts:111-113` |
| Time | `extrapolation()` restarts at every snapshot. The drawn clock therefore runs backwards on up to 34% of frames (worst case −4,003 s), then jumps a whole step. | `lab.ts:403-408` |
| Time | In the laboratory, the time handler runs only toggle, faster, slower and rate (rate through `Math.abs`). Reverse, Now and the date field are swallowed. Seek, replay and reset carry on at the old rate. | `explore/index.ts:3029-3035` |
| Time | `MAX_CHECKPOINTS = 48`, and the oldest periodic checkpoint is spliced out. `Engine.seek` replays synchronously inside `onmessage`. | `engine.ts:221, 283` |
| Drawing | Every body that is not built in is one warm impostor sprite, colour `[1, 0.9, 0.75]`, sized 4 to 40 px. `DUST` is 240 points of 3 px. `PARTICLES` are 3.2 px and coloured only by whether the primary is a star. | `lab.ts:136, 144, 375, 1074, 1092` |
| Drawing | The snapshot drops the swarm's `torn` flag and has no provenance. Built-in worlds are drawn at their real radius, never the experiment's. Lab labels skip collision and occlusion. `plumes.shift()` and `hidden.add()` act in a single frame. `HANDLE_PX = 14` gives a 28 px target. | `protocol.ts:64`; `lab.ts:178, 495, 826` |
| Physics | One global step, eta 0.01 times the shortest timescale. The Earth-Moon pair sets 1.03-hour steps for every body (8,483 steps a year, about 130,000 steps a second in Node). | `engine.ts:276, 552`; LAB.md |
| Physics | Contacts are tested on a straight line (`closest()`) at the start of the step. `loseStruck` only tests positions at the end of the step. | `nbody.ts:372, 656`; `swarms.ts:240` |
| Physics | `fragment()` makes at most `MAX_DEBRIS = 6` equal bodies at 1.05 times the escape speed, and the rest goes back to the remnant once `MAX_BODIES = 64` is reached. Torn pieces overlap and exert no gravity on each other. Merging adds volumes, so two Jupiters make 1.26 Jupiter radii. | `nbody.ts:123-125, 430, 545-620` |
| Physics | A body that crosses `STAR_MIN_GM` through a merger or a mass edit never shines, because `lightAndClimate` runs only on `add` and on load. A heavy body added with `luminosityW: 0` still gets main-sequence light: a 10-solar-mass black hole would shine like about 9,300 Suns. | `engine.ts:138-141` |
| Accuracy | After one year, Mercury is 4,370 km from REBOUND. The close encounter is 56,000 km from the RK4 reference. The unchanged fork's Earth is 46,558 km from the explorer's ephemeris. | LAB.md |
| Cost | Swarm cost on the solar fork (reviewer's Node measurement): 0.011 ms per step with no particles, 0.21 ms with 1,500 and 0.54 ms with 4,000. At 30 days a second (about 660 steps a second), 4,000 particles take about 356 ms of the worker's 500 ms of stepping per wall second. | review of Phys |
| Bytes | Shell: +9,677 of its +10,000 allowance (323 B left). Explorer: 147,459 to 147,489 of 150,000 B. Lab: 62,782 to 62,795 of 250,000 B (adapter 22.2 KB, panel 23.7 KB, worker 16.3 KB). `LAB_SOURCES` follows static imports only, so lazy sub-chunks need their own rows. | `check-bundle.ts:56-67` |

## 4. Corrections adopted from the reviews

| A design said | What is correct | What this plan does |
|---|---|---|
| Taylor-drawn error over a 14-hour step at 1 au is "about 0.025 km" | The jerk term ω³rτ³/6 gives about 25 km | Inside a step, positions are interpolated (cubic Hermite between real states). Between snapshots they are carried along Kepler conics. W1.2 |
| Particles drawn at `rel + vel·τ` | A ring of 6.9-hour period near the Roche limit turns about 50° per 1-hour step, so a straight line throws particles about 10⁴ km off | Particles are drawn on their conic about the primary (W1.8) |
| Massless tracers "settle into a disc" | In a point-mass model, debris launched from the surface either escapes or falls back | The label says no disc can form in this model (W2.1). The disc is not offered as a showcase. |
| Rotational shedding gives a Canup-type disc | A Mars mass at v_esc and 45° carries about 0.32 of the breakup angular momentum. That leaves a day of about 4.5 h, slower than breakup. | The spin limit is enforced on edits only. The Canup case is kept as a negative test (W5.7). |
| A debris swarm can carry mass while pulling nothing | One-way coupling breaks momentum and energy, and debris dominates in the erosive regimes | Semi-active tracers: their reaction is applied to the bodies (W5.1) |
| Housen & Holsapple ejecta speeds for disruption debris | That law fits crater ejecta from a half-space | Used for crater curtains only (W2.2). Disruption debris keeps Chambers-type launch speeds, labelled. |
| With dense output, edits can stay at whole steps | The visitor clicks mid-step. The Earth moves 108,000 km per 1-hour step, and the two-body planet about 1.5e6 km per step. | Edits carry their shown time, and the engine takes a logged partial step to it (W1.3) |
| A rolling lookahead costs at most 1 ms a tick and agrees bit for bit | It cannot keep pace with a budget-bound run. `Prediction` also skips log entries that fall due later. | A cheap contact scan instead (W1.13). Only the requested rate changes, so exactness is not needed. |
| A seek costs "a few thousand steps" | Old checkpoints are evicted, and seek is synchronous | Seek is sliced across ticks with progress, and every event pins a checkpoint (W1.4, W2.6) |
| 32 MB of per-step frames covers about 2,000 steps | With 4,000 particles a step is about 52 KB, so 32 MB holds about 600 steps | Display frames are recorded, and the exact state comes from a seek when playback stops (W1.4) |
| IAS15 and the adaptive leapfrog are time-symmetric | Neither is | "Run back before the start" is labelled, and its test checks accuracy only (W4.3) |
| Lensing is "exact, secondary images included" | A screen-space pass can only remap pixels already in the frame | Labelled as a screen-space approximation. The shadow and photon ring are drawn analytically (W6.4). |
| "Replace the Sun with a black hole" in the solar fork | The built-in worlds stay lit by the explorer's Sun | Honest only if the explorer's sunlight is switched off (owner decision D3). Otherwise it runs in the two-body lab only. |
| A magma-ocean surface glows for decades | Surfaces quench and crust over within hours to days | Two layers: the surface temperature is limited by the crust, and the molten interior is reported as a number (W2.3) |
| Doubling the Sun's mass gives a 258-day year | An instant doubling gives a = 2/3 au, e = 0.5 and P ≈ 141 d. 258 d holds only if the orbit is re-circularised. | The gallery card shows both (W3.5) |
| Chen & Kipping at 1 Jupiter mass within ±15% | Their relation gives about 1.23 Jupiter radii (the fit is pulled up by inflated hot Jupiters) | Radii scale relative to the body's own radius, along the relation's exponent (W5.4) |
| Mróz et al. 2017 shows free-floating planets are common | Jupiter-mass ones are rare (at most about 0.25 per star) | The card says "rare" (W3.5) |
| `lightAndClimate` already lights a body at `STAR_MIN_GM` | Only on `add` and on load | `ignite()` runs after mergers, accretion and mass edits (W5.4) |
| Refuse an aim whose backward path has its periapsis inside the target | Every impacting path does | Refuse on Hill-sphere or re-entry failures, and refine by shooting (W1.12) |
| A `Prediction` of a hypothetical body is bit-identical to the live run | Its dt is taken from the state before the add | The constructor runs `resolveContacts` and `retime` after `addBody` (W1.12) |
| A DE440 fork stays within 1,000 km of the explorer | The explorer uses JPL's approximate elements, whose errors are about 1e4 km | Validate against DE440 fixtures and show the offset from the explorer (W7.1) |
| DE440 states for every year come to about 120 KB | About 150 KB | Store every 5 years, about 30 KB gzip (W7.1) |
| Earth-Moon tides can be seen in real time | At 30 days a second the Moon recedes about 0.3 cm per wall second | Secular tides in deep time; in real time, a number in the inspector (W7.4) |
| Stellar mass loss emerges from the N-body over 1e8 years | That is about 8e9 steps: hours to a day | Secular a·M = constant in deep time, labelled (W7.5) |
| Eight pieces reproduce Kokubo et al. 2000; Bridges' restitution law applies | Eight pieces cannot reproduce it, and that law is for icy cm/s collisions | A demonstration of the criterion only, with a labelled constant restitution (W5.3) |
| Following lab bodies costs 400 B of explorer glue | `nav.focus` is typed `BodyId` with 33 uses, and `NavWorld` is built once | 0.8 to 1.2 KB, counted (W1.9); measured +393 B explorer, +585 B laboratory, the review's fixes included (2026-10-28) |
| The incandescence table "matches the Sun" | A 5,772 K blackbody is about 15% brighter than the real Sun's mean | The test checks the table against the Planck integral only (W1.14) |
| Zero allocations in all of `lab.ts`; heap slope ≤ 0 | Too large a refactor, and flaky | Hot loops are allocation-free, and the retained heap after GC stays level (W1.0) |
| A 10-solar-mass black hole is an ordinary body | `dtMinS = 1 s` clamps far above its dynamical time, and `luminosityW: 0` is ignored | A compact-object policy and honest light (W6.3) |
| Dragging the Earth moves the Earth | Its Moon stays behind | "Carry satellites" is on by default, as one logged batch (W3.3) |
| A star swallowing a planet is a Leinhardt-Stewart merge | Those regimes do not apply to a star's envelope | The star gets its own event kind, `absorbed` (W2.5, W7.5) |

## 5. Budgets

### 5.1 Bytes (gzip, measured by `scripts/check-bundle.ts`)

| Row | Sources | Budget | Today | After M1 | After M7 (peak) |
|---|---|---|---|---|---|
| Shell | first load | baseline + 10,000 | +9,677 | +0 | +0 (M8 video hook: decision D2) |
| Explorer | `src/explore/index.ts`, `src/ui/explore/index.ts` | 155,000 (150,000 before D1) | 147,459 | ≈ 149,600 | ≈ 150,900 (needs D1) |
| Laboratory (static: adapter, panel, worker) plus `lab-fx` | existing `LAB_SOURCES` + `src/explore/lab-fx/index.ts` | 250,000 combined (new aggregate line) | 62,795 | ≈ 108,000 | ≈ 204,000 |
| `LAB_FX_SOURCES` (new) | `src/explore/lab-fx/index.ts` | 40,000 | – | ≈ 21,000 | ≈ 33,000 |
| `LAB_CINEMA_SOURCES` (new, M2) | `src/explore/lab-fx/cinema.ts` | 15,000 | – | – | ≈ 6,000 (≈ 10,000 with M8 video) |
| `LAB_CATALOGUE_SOURCES` (new, M3) | `src/ui/explore/lab-catalogue.ts` | 15,000 | – | – | ≈ 12,000 |
| `LAB_GALLERY_SOURCES` (new, M3) | `src/ui/explore/lab-gallery.ts` | 25,000 | – | – | ≈ 18,000 |
| `LAB_BENCH_SOURCES` (new, M4) | `src/ui/explore/lab-bench.ts` | 15,000 | – | – | ≈ 15,000 |
| `LAB_LENS_SOURCES` (new, M6) | `src/explore/lab-fx/lens.ts` | 8,000 | – | – | ≈ 5,000 |
| `LAB_STELLAR_SOURCES` (new, M7; dynamic import inside the worker) | `src/sim/stellar.ts` | 15,000 | – | – | ≈ 12,000 to 14,000 |
| `GALAXY_SOURCES` (new, M8, decision D5) | `src/galaxy/index.ts`, `src/ui/explore/galaxy-panel.ts` (with its own worker) | 60,000 | – | – | – |
| Lab data (new data rows, from `public/assets/jpl/`) | `de440-states.json`, `small-bodies.json` | 40,000 and 90,000 | – | – | ≈ 30,000 and ≈ 80,000 |

**Explorer glue by milestone.**

| Milestone | Glue | Items |
|---|---|---|
| M1 | ≈ 2.1 KB | finite checks +60; lab time branch moved out −150; radius seam +250; lab bodies as camera targets +1,000 (measured +393, W1.9); label layout (net) +400; navigator and phone time row +400; `tier` field +30; inset exclusion rects +150 |
| M2 | ≈ 0.7 KB | marks vec4 glow +250; air column +80; per-axis scale +120; director pose +250 |
| M5 | 0.15 KB | thermal glow |
| M6 | 0.15 KB | Sun off, if D3 is approved |

The total is about 3.1 KB against 2.5 KB of headroom. **Owner decision D1** (answered 2026-10-27, §10): `EXPLORE_BUDGET_BYTES` raised to 155,000 B. M1 fits today's headroom with about 0.4 KB to spare. The Earth spin blur from the time diagnosis waits for D1.

### 5.2 Frames

| Resource | Budget | Measured by |
|---|---|---|
| GPU, all lab effects together | High: 2.5 ms at 2880 × 1800 (reference M5 Pro, WebGPU). Medium: 1.2 ms. Low: 0.6 ms. Enforced by the effects ladder (W1.0). | `@perf` A/B toggles, uncapped |
| Extra draw calls | At most 10. The lens adds 1, only while its Einstein radius is at least 1 px. | `frameStats()` |
| Main thread: lab update and effects | At most 1.2 ms at the 95th percentile, with 64 bodies and 4,000 particles. No allocation in the trail, particle and label loops. | `@perf`, plus heap after GC |
| Worker | 8 ms of steps and 3 ms of prediction and scanning per 16 ms tick (unchanged). A second worker instance from M3. "Run to a date" may take 14 ms while it says "computing" (M7). | worker harness, `scripts/sim-report.ts` |
| Snapshot | At most 120 KB, transferable, with 4,000 particles and their velocities | unit test |
| Memory | Frame recorder ≤ 24 MB; checkpoints ≤ 16 MB; second worker ≤ 30 MB | unit test and `@perf` |
| Frame pacing | Capped p99 frame time ≤ 16.7 ms at High through the Roche lesson, a Mars-mass impact and a 4,000-particle ring | `@perf` |

### 5.3 How cost is measured

- Use the `@perf` switch already in `playwright.config.ts` (`PERF=1 npx playwright test --workers=1`), with Chromium run uncapped (`--disable-gpu-vsync --disable-frame-rate-limit`).
- Every effect gets an on/off A/B toggle through a read-only hook, `__kf.universe.labDraw()`.
- Per-pass Apple GPU timestamps are not used: they read 15 to 59 ms while frames held 16.8 ms.
- Engine throughput is measured with `scripts/sim-report.ts` in Node, and the recorded baselines are kept as fixtures.

## 6. Milestones at a glance

| | Name | What the visitor notices | Effort (engineer-weeks) |
|---|---|---|---|
| M1 | Fix the floor, and make the first impact worth watching | Time rewinds and never stutters; torn moons are lit grey rocks; dust becomes a ring; no labels pile up; you throw a rock, the lab slows to show it, and a fireball blooms safely | 8 to 9 |
| M2 | Matter and events with consequences | Debris falls back or escapes; ejecta curtains; heat and melt that fade at the right pace; air stripped; event cards with "Why?"; instant replay; readable trails | 6 |
| M3 | A laboratory you can play | Five rooms; Simple and Expert; drag worlds with their moons; a library of real objects; a what-if gallery; the real system beside the experiment; branches; habitable zones; overlays of dynamical structure | 7 |
| M4 | An instrument you can trust | IAS15; contacts at the true moment; an energy ledger; recorders and CSV export; bit-exact replay across browsers; a validation bench | 11 to 12 |
| M5 | Matter with substance | Debris with mass and a size distribution; materials and heat; torn pieces that gather again outside the limit; radii that follow mass; stars that ignite; climate limits; worlds glowing when hot | 7 |
| M6 | Stars, black holes and relativity | Mercury's 43″ a century; stars drawn fully; black holes with honest limits and labelled lensing; tidal-disruption streams | 6 |
| M7 | Deep time and the real small bodies | A DE440 seed; the real asteroid belt and Trojans; millions of years by WHFast; tides and stellar ageing in deep time; supernovae; chaos measured | 11 to 13 |
| M8 | Optional new scales and senses | Galaxies; gravitational-wave inspirals; comet tails; airbursts; seismic ripples; sound; frame-exact video; Apophis in 2029 | each needs an owner decision |

---

## M1. Fix the floor, and make the first impact worth watching

**Goal.** Fix every laboratory defect in the diagnosis, then give the visitor the highest-impact upgrades in direct manipulation and visuals: real rocks, a thrown impact they can see coming, and a safe fireball.

**Order of pull requests:** W1.0 → W1.1 → W1.5 → W1.2 → W1.3 → W1.4 → W1.15 → W1.10 → W1.11 → W1.6 → W1.7 → W1.8 → W1.9 → W1.13 → W1.14 → W1.12.

**Budgets after M1:**
- Laboratory (static plus `lab-fx`): about 108 KB.
- Explorer: +2.1 KB.
- GPU at High: at most 1.2 ms (rocks 0.3, splats and annulus 0.4, fireball 0.1, star discs and glare 0.15), 8 draw calls.
- Main thread: at most 1.0 ms at the 95th percentile. Moving the CPU particle loop to the GPU saves about 0.3 ms.

**Data and licences:** none new. Only existing constants and the fact-sheet albedos already in `data/constants.json`.

### W1.0 Effects ladder and performance harness (Vis-F3)
**Status (2026-10-27): built in part.** `src/explore/lab-fx/ladder.ts` (keyed by the explorer's detail tier, read from `data-detail`; an unknown tier is Medium), the `__kf.universe.labDraw()` hook, the `lab-fx` rows in `scripts/check-bundle.ts`, and `tests/explore/lab-perf.spec.ts` (`@perf`: 4,000 particles and a Mars breaking up on the Earth at High and Low, and GPU counts level over three round trips; measured: 59.9 fps, p99 16.8 ms at High at 1440 x 900, DPR 2, and the same at Low). Review pass (2026-10-27): trails on Float64 ring buffers (sampled and drawn without allocating; `TrailRing` in `src/explore/lab.ts`), the A/B effect switches (`__kf.universe.labEffects`: rocks, dust, fireballs, bands, their work skipped when off) and the heap after a forced collection level over three round trips (CDP `HeapProfiler.collectGarbage`), both in `lab-perf.spec.ts`.

- **Change.**
  - Add `src/explore/lab-fx/ladder.ts`, keyed by the explorer's `ExploreTier`. The explorer's governor still decides the tier. An unknown GPU (Brave Shields can hide it) maps to Medium.
  - Ejecta particles per plume: Low 1k, Medium 3k, High 8k, Ultra 16k.
  - The ladder also sets the rock LOD buckets, splat caps and the star granulation switch.
  - `LabFrame` gains `tier` (one field at the `lab.update` call, about 30 B of explorer glue).
  - Trails are rebuilt on Float64 ring buffers.
  - Add the `__kf.universe.labDraw()` read-only hook: per body `discPx`, mesh and dot weights, light received, drawn radius and label state; per swarm the dust dots, fireballs and a per-frame light total.
  - Add the new rows to `scripts/check-bundle.ts` (section 5.1).
- **Cost:** about 1.5 KB in `lab-fx`.
- **Tests.** A new `tests/explore/lab-perf.spec.ts` (`@perf`) covering the Roche lesson, a Mars-mass impact and a 4,000-particle ring, at High and Low:
  - the uncapped median fps with all effects stays within 15% of the lab without effects;
  - capped p99 frame time is at most 16.7 ms;
  - geometry and texture counts stay level over three lab round trips;
  - the retained heap after a forced GC (`--enable-precise-memory-info`) is level over three round trips.

### W1.1 One validator for every edit, with an answer (Phys-F1, Exp-F3, AI audit)
**Status (2026-10-27): built.** `checkCommand` (used by `validateScenario` and `Engine.refusal`), the `setAtmosphere` branch, run-made ids (`-piece-N`, torn dust `dust-*`), ids never reused, refused edits log nothing; the worker's `ack`; `Lab.command` returns `Promise<LabEditResult>` (also `__kf.universe.lab`); commands queued until the first snapshot (and in the explorer until the laboratory's chunk has come); rates not finite refused, held to 2,592,000 s/s; Double disabled with the reason. Tests: `tests/unit/lab-throw.spec.ts` (the fuzz of 10,000 edits on three laboratories), `tests/explore/lab-throw.spec.ts`.

- **Change in `src/sim/engine.ts`.**
  - Extract `checkCommand(c, known, limits = IMPORT_LIMITS): string | null` from the per-edit block of `validateScenario` (`engine.ts:842-895`). Use it in `validateScenario`, `Engine.apply`, the worker and `lab.ts edit()`.
  - Add the missing `setAtmosphere` branch.
  - Widen the pattern for ids created during a run to include `freshId`'s `${id}-piece-N`.
  - `Engine.apply` validates before it pushes a checkpoint or a log entry. Execution that turns out to be a no-op (for example `setVelocity` on a held body) rolls both back.
- **Change in `src/sim/protocol.ts` and `worker.ts`.**
  - `command` carries `editSeq`, and the worker replies with `{type: 'ack', generation, editSeq, ok, reason?, created?}`.
  - `run` refuses a non-finite rate and clamps |rate| to at most 2,592,000 s/s, the top of `TIME_RATES`. Deep time (M7) gets its own limit.
- **Change in `src/explore/lab.ts`.**
  - Commands are queued until the first snapshot, replacing the `if (!s) return` guards.
  - `Lab.command` returns `Promise<EditResult>`.
  - `UniverseLab` gains `generation`, `applied` and `status: 'refused'` with a reason (`src/core/types.ts`; types only, no runtime bytes).
  - The panel disables Double when 2·GM would exceed `IMPORT_LIMITS.gm`, and shows the reason.
- **Change in the explorer:** `time()` returns early on a non-finite `rate` or `jdUtc` (about 60 B).
- **Cost:** about 3 KB.
- **Tests.**
  - `tests/unit/lab-engine.spec.ts`: a deterministic fuzz of 10,000 commands on the solar, two-body and three-body seeds. It includes runs after a tidal disruption and after a fragmenting impact, so `-piece-N`, `remnant-*` and `debris-*` ids are exercised. Inputs cover unknown ids, NaN, ±Infinity, 1e300, negative radii, e = 1, burns without propellant, removing the persistent Sun, and every command kind including `setAtmosphere`.
  - The invariants:
    - every accepted save validates and replays to the same SHA-256 of the Float64 `pos`, `vel` and `gm`;
    - a refused command leaves `undoable` and the hash unchanged;
    - `checkCommand` and `validateScenario` agree on every command kind.
  - `tests/explore/lab-tools.spec.ts`:
    - Double on the Sun 20 times, then save and restore succeeds; the 10th press (1.327e11 × 2¹⁰ = 1.36e14) is refused with a visible reason;
    - rates of NaN and 1e15 are refused or clamped;
    - `start 'two'` sent in the same tick as `openLab()` is honoured.

### W1.2 Exact positions inside a step, and a display clock that never runs backwards (Phys-F3, Vis-F2, Exp-F2; time diagnosis items 2, 3 and 13)
**Status:** built in batch 1 (`src/explore/lab-clock.ts`; docs/LAB.md, "The drawn clock").


**Worker (`src/sim/worker.ts`, `engine.ts`).**
- While owed time is less than dt (the slow regime), the worker computes the next step for the bodies alone on a scratch copy, with the same functions. Swarms exert no force on bodies, so the scratch result equals the step it later commits, bit for bit, unless an event happens inside the step.
- Each snapshot carries the bracket: states n and n+1, each with `pos`, `vel` and `acc` (from `nbody.accelerations`, exported at `nbody.ts:231`), plus `owed`, `requestedRate` and a `timeline` counter. The counter is bumped only by seek, replay, reset, undo, redo, load and the start of reverse play.
- The worker resets `recent` when the rate changes.

**Page (`src/explore/lab.ts`).**
- `extrapolation()` becomes a display clock, `shownT`. Each frame it advances by min(0.1 s, wall dt) times the requested rate. It is clamped to the bracket and holds, never jumps, when the worker is behind. It freezes on pause, and only a change of `timeline` may move it backwards.
- In the slow regime, bodies are drawn by cubic Hermite interpolation between the two bracket states. It is exact at both ends and smooth (C1) in between.
- In the fast regime (at least one step per snapshot), each body is carried from the latest state by `keplerDrift` (`src/sim/kepler.ts`, imported into the lab chunk) about its primary, for at most 1.5 snapshot intervals. Any correction when the next snapshot arrives is eased over 0.1 s.
- The error this leaves: for the Moon at 30 days a second over one 33 ms snapshot interval (one simulated day), about 100 km of solar tide. Today's straight line is off by about 10,000 km, and a Taylor series to second order by about 780 km.
- The same clock drives `jdTdb()`, `applyBuiltIns` (positions and spin bases), trails, marks, plumes and every effect's timeline.
- The rates line measures the achieved rate over max(1 s, 2·dt/rate). It says "only X is possible here" only when the worker really is budget-bound.

**Cost:** about 2.5 KB (including `kepler.ts`). In the worker, at most one scratch step for the bodies per committed step, and only at slow rates.

**Tests.**
- `tests/unit/lab-clock.spec.ts`:
  - `shownT` is monotonic over 10,000 random snapshot arrival jitters, using the measured 48 ms / 3,700 s pattern, with timeline bumps.
  - A mid-step Hermite position differs from a 100-times-finer integration started at state n by no more than state n+1's own step-end error against that finer run. Interpolation adds no error of its own.
  - The scratch step equals the committed step bit for bit when no event occurs.
  - The Moon at 30 days a second, drawn by Kepler drift: under 200 km from the next real state.
- `tests/explore/lab-time.spec.ts`: a `requestAnimationFrame` sampler on the solar and two-body seeds at 10 s/s, 1 h/s, 1 day/s and 30 days/s.
  - Zero frames with `jdTdb` decreasing, except across a timeline bump.
  - At 10 s/s, `elapsedS` rises 30 ± 5 s over 3 s.
  - The 95th-percentile frame step is under 1.6 times the median.
  - After pressing Faster 3 times within 50 ms, the per-frame step reaches at least 0.8 times rate/60 within 200 ms.

### W1.3 Edits land at the time the visitor saw (from the review of Phys-F3)
**Status:** built in batch 1 as `Engine.applyAt` (an edit carries the step of the view it was made on).

- **Change.**
  - Log entries gain an optional `atT`, accepted by `validateScenario`.
  - `Engine.applyAt` takes a logged partial step from `state.t` to `atT`, applies the edit, and then re-times.
  - Old files have no `atT` and replay exactly as before.
- **Cost:** about 0.5 KB.
- **Tests.**
  - In the two-body lab (dt 50,226 s), a body added by clicking mid-step lands within 1 km of the drawn position relative to the drawn primary.
  - Replay through save and load gives an identical hash.
  - The 20 recorded version-1 scenarios replay to their stored hashes.

### W1.4 Time that runs both ways, a reset that holds, and the fork date kept (time diagnosis items 1, 10, 11 and 12; Phys-F5; Exp-F2)
**Status:** built in batch 1 (`src/sim/rewind.ts`). Batch 2: a goto now lands at the first whole step at or past its moment (with 14-hour steps the last one short of it was another date), and a date's goto is kept to its day (`src/sim/goto.ts`: late in the day, the first step past the moment can be the next day's; batch 1 had aimed early moments later into the day for the old stop short of the moment, and with the two together a date asked for on 2010-06-15 landed on the 16th).


**Handler.** The laboratory branch of `time()` moves out of `explore/index.ts` into `lab.time(command)`, which returns availability: `{faster, slower, reverse, play, now, date}` with reasons. Disabled buttons get `aria-disabled` plus a visible style.

**Reverse play (worker).**
1. A frame recorder keeps the bodies' Float32 positions and spin bases at every snapshot (at most 2 MB), and particles at every 8th snapshot (at most 16 MB). Particles between those frames are drawn by Kepler drift.
2. Beyond the recorder, the worker replays segments from checkpoints (`Engine.restore(k, false)`), forward into a buffer, sliced within `STEP_BUDGET_MS`, and walks the buffer backwards. The reverse rate is capped at what replay can sustain, and the rates line says so.
3. When playback stops (pause, play or an edit), an incremental, sliced seek reaches the exact step. Forward play from there is bit-exact.
4. Play stops at the fork with `edge: 'start'`, and Play at the edge runs forward. An edit made while rewound branches through the existing `apply` (and its "discarded" count).

**Holding still.**
- Seek, replay and reset end paused. Reset returns the rate to 1 day a second and restarts the lesson state.
- "Back to the fork" and "Back to the last checkpoint" sit in the head row. In the laboratory, Now means "Back to the fork".
- The checkpoint list is oldest-first, keyed by step, and frozen while the pointer is inside it.

**Fork date.** `forkJdTdb` is kept, so `start 'solar'` after a lesson forks at the explorer's date.

**Cost:** about 4 KB.

**Tests.**
- Unit (`lab-engine.spec.ts`):
  - 20,000 steps with an edit, a merger and evicted checkpoints, played backwards to the fork. Each stop reproduces the forward run's hash at that step bit for bit, the merger is undone when passed, and the run ends at edge `'start'`.
  - No worker tick exceeds 12 ms during a seek of 20,000 steps.
- Browser (`lab-time.spec.ts`):
  - At −30 days a second the run reaches the fork and shows the edge message, and Play then runs forward.
  - Reset at 30 days a second: `elapsedS` is under 1 and `paused` is true within 100 ms.
  - The checkpoint row under the pointer does not move for 3 s at 30 days a second.
  - The solar preset started after the Kepler lesson forks within 1 hour of the explorer's date.

### W1.5 Provenance and looks in the snapshot (Vis-F1, Phys-F8 in part; visual diagnosis item 7)
**Status (2026-10-27): built** as `SimState.origins` and `src/sim/looks.ts` (carried by the state's copies, replayed with the log, never saved), the snapshot's `looks`, `origin`, `rubble`, and each ring's kind, source, look and mean pole. Not added: Float32 accelerations and particle velocities (the page carries particles round by circular Kepler motion instead).

- **Change.**
  - `LabSnapshot` gains:
    - `rubble`;
    - per body: `origin {parent, event, kind}`, `look {albedo, tint, material: rock | ice | metal | gas | star}`, and Float32 accelerations;
    - per swarm: `torn`, `source`, `kind: dust | debris | ring | belt`, `look`, and Float32 particle velocities.
  - Event keys have the form `${step}:${absorbed}:${kind}`. A fragment's look is the mass-weighted blend of target and projectile.
  - Material comes from the preset's kind, otherwise from bulk density: ice below 2 g/cm³, rock 2.5 to 4, metal above 5 (Carry 2012). Albedos are the fact-sheet values `climate.ts` already reads.
  - Provenance is carried by `cloneState` and checkpoints and rebuilt on replay. It is not part of the Scenario file or share links.
- **Cost:** about 2.5 KB. Snapshots grow by about 3 KB, plus 48 KB of particle velocities at 4,000 particles.
- **Tests (`impacts.spec.ts`).**
  - Every piece from `tidalDisruptions` is in `rubble`, with `origin.parent === 'moon'`.
  - Pieces from `fragment()` carry the event key, with an albedo between the target's and the projectile's.
  - Save, load and replay give identical origin arrays.
  - `torn`, `source` and `kind` survive into the snapshot.

### W1.6 Bodies drawn as what they are: lit rocks, and lab stars that shine (Vis-F5, Exp-F8, the minimum of Vis-F19; visual diagnosis item 1)
**Status (2026-10-27): built** (`src/explore/lab-fx/rocks.ts`; stars in the same meshes, with a glare). Four lights a body (review pass: up to the four brightest stars, each eclipsed by the eight largest bodies). Tests: `tests/unit/lab-look.spec.ts`, `tests/explore/lab-effects.spec.ts` (review pass: the pieces' meshes and projected size at 2000 x 1300, 1440 x 900 and 1280 x 800; the two-body star's disc within 2 per cent of its radius and distance by the camera's own field of view; its planet's light from the star's side on screen).


**Rocks.** New `src/explore/lab-fx/rocks.ts`:
- `InstancedMesh` in three LOD buckets (icosphere detail 1, 3 and 5, chosen by disc size in px), for up to 64 bodies.
- Size is exactly the engine's radius, with no 40 px cap.
- Shapes are irregular only below the "potato radius" (about 200 km for rock, 300 km for ice; Lineweaver & Norman 2010). Fragments get 2 : √2 : 1 axes (Fujiwara et al. 1978). Shapes are labelled illustrative.
- Bodies tumble from the snapshot's spin vector.
- Shading is Lommel-Seeliger plus 10% Lambert (Hapke 2012), from up to 4 light sources.
- **Eclipses:** a body inside the umbra cylinder of any of the 8 largest bodies receives no light from that source.
- Below about 2.8 px the impostor dot is crossfaded in with `smoothstep(2.8, 1.2, discPx)`, lit by phase × albedo as `index.ts:2053` lights the ten worlds.

**Lab stars.** New `src/explore/lab-fx/stars.ts`:
- An emissive disc with T_eff = (L/4πR²σ)^¼, where L is `snapshot.light`.
- Colour from `blackbodyRgb` (already loaded).
- At most 4 glare sprites.
- A uniform array of star lights shared by rocks, splats and the annulus. This gives the two- and three-body labs correct light, because their built-in Sun is hidden.

**Cost:** about 8.5 KB in `lab-fx`. GPU at most 0.45 ms at High and 0.15 ms at Low, in 5 draw calls.

**Tests.**
- `tests/unit/lab-look.spec.ts`:
  - irregularity is 0 at 300 km or more and greater than 0 at 50 km or less;
  - mesh and dot weights sum to 1 for `discPx` from 0 to 200;
  - an 869 km piece at 25,000 km with `pxPerTan` 1,430 gives a 99 px disc;
  - the Sun's T_eff from L and R is 5,772 ± 5 K.
- `tests/explore/lab-effects.spec.ts`, on webgpu and webgl2 at 2000 × 1300, 1440 × 900 and 1280 × 800, after the Roche lesson:
  - every piece with `discPx` above 3 has a mesh weight above 0.99;
  - projected radius is within 5% of `discPx`;
  - a piece inside the Earth's umbra receives at most 0.02 of full light;
  - the two-body planet's terminator faces the lab star;
  - the star's disc has the right angular size within 2%.

### W1.7 Built-in worlds take the experiment's radius and leave by shrinking (Vis-F6, Vis-F4a; visual diagnosis items 5 and 6)
**Status (2026-10-27): built** (`Lab.scale`, multiplied into the explorer's `grow` after `warpSystem`, and the navigation's body radius). Test: a Moon radius edit eased (at most a thirtieth of the change a frame), within 0.5 per cent, undone; review pass: the Earth after a Mars-mass breakup drawn within 0.5 per cent of the experiment's radius (`tests/explore/lab-flash.spec.ts`).

- **Change.**
  - Add `Lab.radiusOf(id)`, eased with a 0.5 s time constant. It is multiplied into the existing `grow` record after `warpSystem()` (`index.ts:~972`), which already feeds the collision sphere (1672), mesh scale (1737), dot (2036) and label anchor (2333). `minAltitudeKm` in `navBodies` (about line 2450) is scaled the same way.
  - A built-in that leaves the snapshot shrinks out over 0.6 s before it is hidden. A shrinking disc only ever darkens.
  - Saturn's decorative rings keep their real radii, as the panel already says.
- **Cost:** about 250 B explorer, 0.3 KB lab.
- **Tests.**
  - After the Mars-mass erosion, the drawn radius (`object.scale / k`) is within 0.5% of the lab's 6,344 km after 1 s.
  - A Moon radius edit to 3,000 km changes the drawn size by at most 1/30 of the difference per frame, and undo returns it to 1,737 km.
  - The camera's altitude stays above 0.

### W1.8 Dust and rings that read as matter (Vis-F11; visual diagnosis item 3)
**Status (2026-10-27): built** with one change: the particles are placed on the CPU (4,000 a frame, within the frame budget measured), carried round by circular Kepler motion about the ring's pole between snapshots, not on their conics in the vertex stage. The band's profile is a uniform array (both backends).


**Splats.** New `src/explore/lab-fx/splats.ts`:
- Soft profile `exp(−3g²)` with no bright core.
- Size from the spacing between particles, clamped to 2.5 to 18 px. Brightness scaled by (2.5/size)², so total light is the same at every size.
- Colour from the swarm's `look`: a torn Moon's dust is grey at albedo 0.12.
- Phase lighting and the primary's cylindrical shadow.
- Positions are carried along each particle's conic about its primary in the vertex stage: universal variables with a fixed six Newton iterations, from the snapshot's `rel` and `vel`.
- This replaces the CPU particle loop.

**Annulus.** New `src/explore/lab-fx/annulus.ts`:
- Fades in once 90% or more of the particles span 330° or more about the primary.
- A 64-bin radial histogram, updated per snapshot.
- Shaded with `rings.ts`'s single-scattering law (copied, not imported) and the planet's shadow.
- Optical depth is labelled illustrative, because the dust's mass is not modelled.
- On WebGL2, the profile is an RGBA8 64 × 1 texture with manual interpolation.

**Cost:** about 6 KB. GPU at most 0.4 ms at High and 0.15 ms at Low, in 2 draw calls.

**Tests.**
- Unit:
  - a CPU twin of the shader's conic matches `keplerDrift` to 1e-4 relative over one snapshot interval;
  - splat flux is constant within 1% from 2.5 to 18 px.
- Browser, after the Roche lesson and one simulated day at 1 h/s:
  - dust is grey (|r − g| and |g − b| under 0.04);
  - particles in shadow receive no light;
  - the median splat is larger than 3.2 px;
  - the annulus weight is above 0.9;
  - at a zoom-out to 672,000 km, no particle is brighter than the brightest star dot;
  - a ring the visitor adds about Saturn stays icy, and a belt about the Sun is warm grey.

### W1.9 Pick, follow and frame any lab body (Vis-F13, Exp-F4; time diagnosis item 13; AI audit)
**Status (2026-10-27): built in part.** A tap or click chooses any of the laboratory's own bodies; off the view, the chosen one has a pointer at the clear view's edge (its name and an arrow); a laboratory of its own opens on its star at once (the explorer's entry glide gave way only after it ended, leaving the view on the hidden Earth); on a coarse pointer the velocity handle is a 44 px target (`tests/explore/mobile.spec.ts`). Not built: following and framing lab bodies with the camera: `NavBody.id` widened to lab bodies costs 0.8 to 1.2 KB of explorer glue (decision D1).

**Status (2026-10-28): built.** Following and framing, on branch `lab-follow`:
- **Ids.** A body of the laboratory's own is `lab:` and its id (`LabFocusId`), so `FocusId` is `BodyId | WorldId | LabFocusId` and `NavBody.id` takes one unchanged (the narrow type, not `string`). The ten keep their own ids.
- **The camera's bodies.** `Lab.navBodies()` gives them where they are drawn (position, the radius as bound, a floor of 2% of the radius, as the small worlds'); `Lab.navRevision` moves when they change (one added, merged, broken up or removed; a laboratory of its own opened; the laboratory left). The explorer keeps one `NavWorld` for its life, which the input's handlers hold, and lists it again in place (`relist`) then, when the ten the experiment hides change, and when the small worlds come. In an experiment it holds the ten it shows (the Sun always: a laboratory of its own's star stands in for it) and its own bodies. A world it hides, standing at the experiment's epoch, and the small worlds, which it does not draw, are left out, so none is an unseen wall or anchor. The camera keeps out of every one, and the near plane stays clear of them (`Lab.nearestKm`).
- **Guards.** Every read of the ten's places, sizes and specs by the focus goes through `host()`, which gives the Sun for a lab id, so none indexes the ten with one. Two lookups by the focus in tables of the ten (the spin hold, the map credits) are given a lab id as a key they lack, and give nothing. The rule that sends a laboratory of its own to its star leaves a lab focus alone.
- **Follow.** The inspector's Follow with the camera (`lab-follow`, after Remove, reached by Tab) is offered for every body: one of the ten stays the explorer's own focus, any other is the `follow` command. A followed body that merges hands the camera to its survivor, one that breaks up to the largest of what is left, one torn apart to its first piece (`heir` in `src/sim/nbody.ts`, through `takeRefocus(focus)`). That holds while the camera is still flying to it: the trip stops where it is and the camera flies on from there (`Navigator.release` keeps the survivor asked for after it). One removed is let go of (`Navigator.release`): the camera stays where it is, at rest in free flight; a reduced-motion cut to it finishes first, so the light never steps. A body the camera is not on that merges, breaks up or is removed changes nothing, one of the ten included; one of the ten removed under the camera still sends it to the Sun. Leaving the laboratory, the camera is let go of by the nearest of the ten the experiment showed (in a laboratory of its own, the Sun its star stood in for). The real bodies go back to the explorer's date at once and the camera goes with that one, as it does with a body it orbits, so the trip the address asks for starts from where it is; the real bodies are flown to as before. A goto in the experiment (Now, a date) moves the camera with the body it follows, in one step, the framing kept.
- **Framing beside a remnant.** A trip whose framing would end inside another body turns to that body's far side (`Navigator.clearOf`). Without it, a piece beside its remnant was framed from inside the remnant: the camera slid along its surface and its distance from the piece varied by 15%.
- **Bytes** (`scripts/check-bundle.ts`, before the branch and on its last build). Explorer 148,280 to 148,673 B (+393: its chunk 74,341 to 74,695, the interface's 24,736 to 24,777); +295 as first built, +98 for the review's fixes. Laboratory 106,026 to 106,611 B (+585: the adapter 26,606 to 27,136, the panel +7, their shared chunk +48; the worker unchanged); +610 as first built, −25 for the fixes. Shell +6,112 to +6,111 of its +10,000 (chunk names). The estimate was 0.8 to 1.2 KB explorer and about 1 KB lab: the widening is a type, the guards are one function, and the proxies live in the laboratory's chunk.
- **The two-body laboratory, decided.** The list below asks for it to start on `planet`. It keeps opening on its star, the hidden Sun standing in, the readout naming and measuring the star. That is what the 2026-10-27 status line built and two tests hold (`lab.spec.ts`, a laboratory of its own; `lab-throw.spec.ts`, its opening during the entry glide); the star is the experiment's centre, and its planet is now one press of Follow away. The rest holds as the list asks. With the Earth hidden, its tiles are aimed at nothing: no tile is asked for, though one already on its way still lands. The tiles have no `visible` field, so `earthTiles.visible === false` is read as `imagery.clear.zoom` −1 with none showing. With the planet followed, the readout shows its own name and height.
- **Review fixes (2026-10-28).** An adversarial review of the first build found four failures. Each now has a test that failed on that build (its head, built in a scratch copy, for the browser tests) and passes on this one:
  - The flight keys during a follow sent the camera to the star in a laboratory of its own. The input held the `NavWorld` built at entry, while the explorer had begun to replace it; that one had neither the laboratory's bodies nor the small worlds, so free flight anchored to a hidden world at J2000, and the rule for hidden worlds flew to the star. Now there is one `NavWorld`, listed again in place. Test: W held while the planet is followed. Before, the focus went to `sun` with a trip under way; after, every frame is on `lab:planet`, flying freely.
  - With motion on, a followed body that merged or broke up while the camera flew to it lost the hand-off: letting go of the body that went also dropped its survivor, waiting for the trip. Test: a rock that strikes the planet while the camera flies to it from the star. Before, the camera ended on the star; after, it orbits the planet at its framing.
  - Leaving a laboratory of its own with its planet followed moved the camera hundreds of millions of km in one frame: it was let go of by a hidden world, which then went back to its place at the explorer's date. Test: the camera's distance from the Sun across that frame. Before, it changed by 100,003,966 km; after, by under 15,000 km (a ten-thousandth of an au). A temporary probe measured 97 km, and the camera's own step 543 km, about the star's distance from the experiment's barycentre. The trip to the Earth that follows is now planned against the real bodies' places. Planned against the experiment's, it began 1.2% further from the Sun: 1,772,286 km at 1 au, measured by the same probe with only the anchor fixed.
  - Removing one of the ten that the camera was not on (Mars, with a rock followed) sent the camera to the Sun: the laboratory's refocus applied to any of the ten removed or merged away. Now it applies only to the one the camera is on. Test: Mars removed with a rock followed. Before, the camera was on its way to the Sun; after, every frame for 3 s is on the rock.
  - Smaller ones. Hidden worlds are left out of the camera's list. Test: free flight beside the hidden Earth in a laboratory of its own. It fails on the first build, and again with only this undone. The unit tests' laboratory helper throws for an id it lacks. `lab-perf` fails when the breakup has no first piece, rather than skipping the follow.
- **Tests.** `tests/explore/lab-tools.spec.ts`:
  - followed by the keyboard;
  - handed on through a breakup and a merger;
  - a breakup's first piece, `debris-<step>-1`, followed for 10 s of its flight at a minute a second: its distance within 5% of its framing on every frame (measured 0%), the camera above every body of the experiment on every frame, there and through a stone's fall into the planet;
  - a removal let go of where the camera is (it moved less than 1 km);
  - the two-body laboratory as decided, its planet followed and measured, and the Earth flown to after leaving;
  - one of the ten removed that the camera is not on, the follow unchanged;
  - with motion on: the flight keys by a followed planet; free flight beside a hidden world; a breakup during the trip to the body that broke up; leaving with the planet followed.

  Unit: `tests/unit/navigation.spec.ts` (a body followed at 40 km/s held at its framing distance to 1e-9, the camera held at the floor of one it passes; let go where it is; a cut finishing first; a body asked for during a trip to one that goes, flown to from where the camera lets go) and `tests/unit/impacts.spec.ts` (`heir` on the engine's own merger, breakup and tidal disruption). The mobile project's 44 px handle test is unchanged. `tests/explore/lab-perf.spec.ts` gained a phase with the breakup's first piece followed: 59.88 fps and p99 16.8 ms at High and at Low, on WebGPU and WebGL2, run alone (2026-10-28), as every other phase. Run alone again after the review's fixes: the same in every phase (`lab:debris-495-1` followed), the heap after a forced collection 23.9 to 24.9 MB, and the small worlds' views 59.88 fps and p99 16.8 ms.

- **Change in `src/explore/navigation.ts`:** `NavBody.id` becomes `BodyId | string`.
- **Change in `src/explore/index.ts`.**
  - `navBodies()` appends lab proxies (position, radius, bound, minimum altitude).
  - `NavWorld` is rebuilt when the lab's bodies change, not only once at line 2519.
  - Reads of `sys.bodies[nav.focus]` (11 indexed uses) are guarded.
- **Behaviour.**
  - Clicking or tapping selects a rock, a piece or a swarm (the nearest particle selects its swarm).
  - On a coarse pointer the velocity handle's hit area is 44 px.
  - Follow is offered for every body. When a followed body merges, the camera follows the survivor (`takeRefocus`).
  - The two-body lab starts focused on its own planet (decided otherwise, 2026-10-28: on its star, as built; see the status). The Earth's terrain tiles are suspended while the Earth is hidden, and the readout shows the lab body's figures.
- **Cost:** 0.8 to 1.2 KB explorer, about 1 KB lab.
- **Tests (`lab-tools.spec.ts`).**
  - Follow `debris-<step>-1` after a breakup: the camera distance stays within 5% of its framing for 10 s.
  - The camera's altitude above every lab body stays above 0.
  - The two-body lab starts focused on `planet` (on its star, as decided), with `earthTiles.visible === false`.
  - The handle's hit area is at least 44 px on the mobile project.

### W1.10 Labels that never pile up (Vis-F24; visual diagnosis item 2; navigator diagnosis label items)
**Status (2026-10-27): built** on the layout branch's rank-based give-way: families of three or more as one name, no name for a body behind a nearer lab body, encounter markers named as encounters (their time counted down from the moment drawn), names fading with their bodies, the chosen body's pointer at the view's edge when it is off the view. Review pass: the placing is a pure module, `src/explore/label-layout.ts` (the explorer's `declutterLab` finds each name's point and whether it can show, then lays them out with it), with hysteresis (a name comes in only with twice the room a showing one keeps, inside the clear view's edge, and never where another shows); `tests/unit/label-layout.spec.ts` (a thousand random scenes of 74 names, none over another; occluded never shown; the chosen body's over a world's; jitter changes nothing). Test in the browser: no names meeting at six window sizes after the Roche lesson.

- **Change.**
  - The label logic moves into a pure `src/explore/label-layout.ts`, used for both built-in and lab labels: occlusion by any nearer body, shared collision boxes, clear-view insets, hysteresis, and eased opacity (in 0.35 s; out at least 0.5 s, or 0.1 s when giving way).
  - The insets gain exclusion rectangles for the Back button and the desktop readout card.
  - Families, from W1.5's provenance, collapse to one tag at the largest member, for example "Moon: 8 pieces".
  - Only the selected body gets an edge pointer. Encounter markers are labelled distinctly.
- **Cost:** about 400 B explorer (mostly moved code), 1.5 KB lab. Main thread at most 0.15 ms.
- **Tests.**
  - `tests/unit/label-layout.spec.ts`:
    - no overlaps over 1,000 random seeds of 74 candidates;
    - an occluded candidate is never shown;
    - a family of three or more gives exactly one tag;
    - 13 px of movement never changes which labels are shown.
  - Browser, after the Roche lesson and six zoom-outs at 2000 × 1300, 1440 × 900, 1280 × 800, 390 × 844 and 844 × 390: zero overlapping pairs, and no tags under the panels or over the Earth for hidden pieces.

### W1.11 Fades and a flash guard (Vis-F4; visual diagnosis item 6)
**Status (2026-10-27): built** (`src/explore/lab-fx/flash-guard.ts`, the fades in `src/explore/lab.ts`). The guard watches the fireballs (the laboratory's only fast light). Review pass: it sees each tile's fireballs together (two in one tile overwrote each other's level, and it then stepped them itself) and holds back a rise by slowing it, never by a step; `tests/explore/lab-flash.spec.ts` reads the fireballs' light and the canvas back every frame (downsampled to tiles), motion on, through a Mars on the Earth, two Ceres on one face of the Moon and ten stones, and with reduced motion checks the camera turns at most half a degree a frame.

- **Change.**
  - New `src/explore/lab-fx/fades.ts`: a fade map per id, easing at least 0.5 s each way, for bodies, swarms, labels, plumes and craters.
    - No live plume is ever shifted out: the oldest fades.
    - A crater evicted for the 13th fades before its slot (`marks.ts` `MAX_MARKS`) is reused.
  - New `src/explore/lab-fx/flash-guard.ts`:
    - Every emissive effect reports its predicted luminance and screen area.
    - The guard tracks relative luminance in screen tiles of 341 × 256 CSS px (scaled from 1024 × 768) over a sliding 1 s window.
    - It slows any effect that would form more than 2 flash pairs a second (a change of 10% or more, with the darker state under 0.8, over more than 25% of a tile).
    - It applies the red-flash rule to saturated reds.
    - With reduced motion it allows crossfades only.
  - The canvas read-back in the tests is the real check; the runtime guard is approximate.
- **Cost:** about 3 KB. Main thread at most 0.1 ms.
- **Tests.**
  - `tests/unit/flash-guard.spec.ts`:
    - a 3.5 Hz square wave over 30% of a tile is reduced to at most 2 a second;
    - the same wave over 10% of a tile passes;
    - a saturated-red pair is counted.
  - Browser, on the manual clock: the canvas read back at 64 × 36 every frame shows at most 2 flash pairs a second per tile through:
    - the Roche disruption;
    - a Mars-mass erosion;
    - 10 impacts in 2 s;
    - 13 craters.
  - With reduced motion, the camera moves at most 0.5° per frame.

### W1.12 Throw and aim, with the outcome worked out before you let go (Exp-F6, Exp-F7)
**Status (2026-10-27): built** as "Throw a rock" (`src/sim/aim.ts`: the rock put at the contact and the system run backwards, then shooting), with the 20 seeded throws in a unit test (bit for bit with the run). Review pass: a miss or a contact off what was asked is corrected forwards (Newton's method then Broyden's, on where it starts and how fast), sliced in the worker; 233 of the panel's 240 choices are made (31 were refused); a throw is made at its step or refused (`Engine.applyAt` exact), after an edit at that same step too. Not built: dragging from a body to fling it (the chosen body's velocity arrow already flings it).


**Throw.**
- Drag from a body to fling it, or use "Throw a rock at…": choose a target, an impactor preset, v∞, angle and lead time.
- The preview is a `Prediction` of the hypothetical body: copy, `addBody`, then `resolveContacts` and `retime` on the copy. It shows:
  - the path integrated ahead;
  - the contact time, speed and angle;
  - the regime from `impactOutcome`;
  - the crater from `contactCrater`.
- Each preview is labelled "integrated ahead with the same rules". After contact, the actual speed and angle are shown beside the requested ones.

**Aim.**
- Seed: the backward hyperbola from the target by `keplerDrift`, with v_imp² = v∞² + v_esc² (Öpik). The angle readout says the most probable impact angle is 45° (sin 2θ).
- The seed is refined by 3 to 5 shooting iterations with the full-N-body `Prediction`.
- An aim is refused, with its reason, when shooting does not converge to within 2% in speed and 2° in angle, or when a sub-escape (elliptic) arc re-enters the target within the lead time.

**Cost:** about 4 KB.

**Tests.**
- Unit: a hypothetical-body `Prediction` reaches its contact at the same step as the live run after the same add (bit for bit).
- Browser:
  - 20 seeded requests (targets Earth, Moon and Mars; v∞ 2 to 30 km/s; angles 15° to 90°; leads of 1 to 30 days) reach the requested speed within 2% and angle within 2° at the actual contact;
  - refused requests show a reason;
  - the regime shown before contact equals the one after.

### W1.13 Seeing it coming: slowing down for events (Vis-F12, Exp-F9)
**Status (2026-10-27): built** (`src/sim/approach.ts`; the governor in `src/explore/lab.ts`; on by default, D8). The hold after an event is two seconds of real time (not 2 tau of simulated time, which at tau/8 would be sixteen seconds), so the rate is back within four seconds. The tests' fixture keeps it off unless a spec turns it on (`labSlow`). Review pass: the time machine's row and the rates line say the rate shown while it slows, with Full speed in the row (a phone's sheet header); tested: a Mars flagged three seconds and more ahead, and the clock no faster than 40 s a second within a second either side of the contact (`tests/explore/lab-flash.spec.ts`).


**Scan (worker, within the 3 ms prediction share).**
- Candidate pairs are those whose time to closest approach, r / v_closing, is under the requested rate times 4 s. This replaces a radius multiple, which at 1 day a second gave under 0.1 s of warning.
- Each candidate's contact time comes from its two-body arc (`keplerDrift`), and a tidal-disruption check compares the periapsis with the fluid Roche limit.
- The selected body's `prediction.merged` is also used.

**Rate governor (`lab.ts`).**
- The visitor's rate is kept separate from the requested rate.
- The requested rate eases in log space, over at least 1 s, to τ/8, where τ = R_target / v_impact. For a Mars mass on the Earth at 25 km/s, τ = 255 s, so the rate becomes 32 s a second.
- It holds through the ejecta's flight (2v·sin 45°/g), or for 2τ in a giant impact, then eases back over 2 s.
- Esc or any rate key cancels.
- The panel shows "Slowed for the impact: 1 s shows 32 s" and a countdown such as "contact in 3 h 12 min (6 s at this rate)".
- The step depends only on the state, so physics and the log are untouched.

**Cost:** about 2 KB.

**Tests.**
- A 20 km/s asteroid heading for the Earth is flagged at least 3 wall-seconds ahead at 1 day a second.
- Mars-mass at 1 day a second:
  - the achieved rate is at most 40 s/s within ±1 s of contact;
  - it is back to 86,400 within 4 s after;
  - the event log is identical with slow motion on and off;
  - Esc cancels.
- Other specs keep slow motion off unless they turn it on.

### W1.14 Impact fireball coloured by Planck's law (Vis-F7; visual diagnosis item 4)
**Status (2026-10-27): built** with V(lambda) from Wyman, Sloan and Shirley's analytic fit (no CIE table copied; `data/sources.json` `wyman-2013-cie-fits`), and the crater glow and a giant impact's heat by the conductive crust of W2.3 (`src/explore/lab-fx/heat.ts`), ahead of M2.


**Table.** New `src/explore/lab-fx/incandescence.ts`:
- 64 entries from 700 to 12,000 K: L_v(T) = 683 ∫ V(λ) B_λ(T) dλ.
- Normalised to an albedo-1 surface in sunlight at 1 au (40,400 cd/m²). The reviewed values are 1,400 K → 0.061, 2,000 K → 11.5 and 3,000 K → 749.
- Chromaticity from `blackbodyRgb`.

**Fireball.** New `src/explore/lab-fx/fireball.ts`:
- One soft sprite at the contact site, on every merge or fragment (not on a graze or a disruption).
- Initial T from the specific impact energy, capped at silicate vaporisation. The cooling profile is labelled illustrative.
- A display ceiling, as with `sun.ts SUN_CEILING`.
- A rise eased over at least 0.5 s; at most 3 rises a second; events within 0.33 s merge into one.
- Labelled "slowed for safety", because a real crater-scale flash lasts milliseconds.

**Data and licence:** CIE 1931 photopic V(λ) from CIE's published table. Record its licence in `data/sources.json` before import.

**Cost:** about 3 KB. GPU at most 0.1 ms.

**Tests.**
- Unit:
  - the table is monotonic and within 1% of a numeric Planck integral;
  - its chromaticity equals `blackbodyRgb`;
  - 1,400 K against sunlit Moon-albedo ground gives 0.49 ± 0.05;
  - two events 0.2 s apart make one fireball.
- Browser (Mars-mass at 25 km/s):
  - a fireball exists within one frame of the event;
  - its per-frame rise is at most peak/30 and never above the cap;
  - reduced motion gives a crossfade only;
  - the W1.11 flash count passes.

### W1.15 Panel, navigator and lesson fixes (navigator diagnosis items 1 to 11; time diagnosis item 14)
**Status:** built on the layout branch (navigator and lesson fixes, lazy laboratory styles).


**`src/ui/explore/navigator.ts`:**
- `apply()` hides `labSlot` and `starsSlot` when folded.
- `update()` always does the cheap visibility work.
- `body.scrollTop` resets on entering the lab or the stars, and after their lazy panel is inserted.
- `edge()` sets both `has-above` and `has-more`.
- The lazy imports get `.finally` and `.catch`.
- On the phone sheet, the time row moves into the sheet's header.

**`src/ui/explore/lab-lessons.ts`:**
- Step buttons are disabled while set-up is pending, after they run, and until the previous step is done.
- A step's text is frozen once the next step runs, and a good text is never overwritten with ''.
- A "Setting up the experiment…" line shows while loading.
- Roche step 1 is written from the values noted when the lesson started.

**New lazy `src/ui/styles/lab.css`:**
- lesson list styles;
- a stacked `.kf-living-place` in the lessons list;
- a fix to the dead `.kf-nav-lab` sheet-order selector.

**Cost:** about 400 B explorer, about 2.5 KB lab.

**Tests.**
- `navigator.spec.ts`:
  - 25 and 26 rapid fold and unfold presses, with a geometry-equality check;
  - the folded rail's height is at most the viewport's at 1280 × 600;
  - the lab panel's heading is in view on entry at 844 × 390.
- `lessons.spec.ts`:
  - after "Torn apart", `lab-lesson-text-0` contains "18,";
  - 10 restarts and step spam leave no empty text and no page errors;
  - Kepler's step pressed twice logs one edit.
- `mobile.spec.ts`: at 390 × 844 and 844 × 390, all five time buttons are hit by `elementFromPoint` at their centres and measure at least 44 × 44 px.

### M1 exit gate
- Every test above passes on webgpu, webgl2 and mobile.
- `check-bundle` passes: laboratory with `lab-fx` ≤ 250,000 B, `lab-fx` ≤ 40,000 B, explorer ≤ 150,000 B (155,000 B since D1).
- The diagnosis's reproductions are re-run and recorded in `docs/LAB.md`:
  - a two-body run at 10 s/s moves the date;
  - −30 days a second rewinds to the fork;
  - after the Roche lesson: zero label overlaps, grey lit pieces and a grey annulus;
  - after a Mars-mass erosion: the Earth drawn at 6,344 km, and the fireball eased.

---

## M2. Matter and events with consequences

**Goal.** Every impact and disruption leaves physically traceable matter and consequences, and the visitor can study it again.

**Budgets after M2:**
- Laboratory with `lab-fx`: about 122 KB. `lab-cinema`: about 6 KB.
- Explorer: +0.7 KB (needs D1).
- GPU at High: at most 2.0 ms (ejecta +0.5, lines +0.1, escaping air +0.1), 10 draw calls.
- Worker: 600 default tracers add about 0.08 ms per step, scaled from the measured 0.54 ms per 4,000.

**Data and licences:** cited formulae only.

### W2.1 Debris tracers from every breakup, swept on their conic (Vis-F10 corrected, Phys-F4 for particles)

**Tracers (`src/sim/nbody.ts` `fragment()`).**
- Beside the up-to-6 debris bodies, create a debris swarm (`kind: 'debris'`, `source` the target).
- Count: a logged scenario setting, default 600, up to the room left under `SWARM_LIMITS.total`. It never depends on how fast the machine is, so replay stays deterministic.
- Tracers launch from the contact site, not radially from the centre, with speeds spread about Chambers's 1.05 times the escape speed (the spread is labelled illustrative). They are seeded by Mulberry32 from the event step.
- They are massless: "tracers: where the debris would go; its mass stays in the bodies".
- The label also says that in this point-mass model no debris disc can form.

**Swept contacts (`src/sim/swarms.ts`).** `loseStruck` becomes swept. In `driftSwarms`, a particle whose conic about its primary passes below the primary's radius within the step is struck, which is exact for the two-body arc. It reports its site, so swarms can also make craters.

**Cost:** about 1.3 KB.

**Tests (`swarms.spec.ts`, `impacts.spec.ts`).**
- Mass, momentum and angular momentum change by less than 1e-12.
- Tracers are identical through replay.
- Mars-mass at 1.1 v_esc: every tracer bound to the remnant at launch strikes within one of its orbital periods, and the escaped fraction equals the fraction launched above escape speed ± 2%.
- A particle crossing the Moon at 30 km/s within one step is caught. Today it is missed.

### W2.2 Ejecta curtains for cratering impacts (Vis-F9 corrected)
- **Change.**
  - New `src/explore/lab-fx/ejecta.ts`: instanced quads, with per-particle attributes seeded once per event.
  - Particles launch from the crater rim on a 45° inverted cone.
  - Launch speeds follow Housen & Holsapple 2011, M(>v) ∝ v^(−3μ) with μ = 0.55 for rock. This is the law's own domain: crater ejecta.
  - Positions are evaluated in the vertex stage: a parabola when v ≪ v_esc, otherwise a Kepler arc solved with fixed iterations.
  - Lighting uses Henyey-Greenstein with g = 0.6, and particles are dark in the target's shadow.
  - Giant impacts use W2.1 instead.
  - Counts come from the ladder and are labelled "decorative" (ledger IM-4).
  - `DUST`, `plumes` and `dustList` are removed from `lab.ts`.
- **Cost:** about 4 KB. GPU at High 0.5 ms or less, Medium 0.25 ms, Low 0.08 ms, in 1 draw call.
- **Tests.**
  - `tests/unit/ejecta.spec.ts`:
    - the analytic path is within 0.1% of numeric integration;
    - the speed exponent is recovered from samples;
    - range at 45° equals v²/g;
    - total light does not change with sprite size.
  - Browser:
    - a 1 km stone on the Moon gives a plume at least 6 px tall;
    - counts match the tier;
    - shadowed particles receive no light.
  - `@perf` A/B stays within budget.

### W2.3 Heat that lasts the right time (Vis-F8 corrected, the heat part of Phys-F8)

**Model.** New `src/sim/thermal.ts`, pure and deterministic.
- Each body gets a thermal state, carried by `cloneState`, `removeAt`, `addBody` and `merge`.
- The heat deposited is the energy the merger or breakup already takes from the orbits (`before − energy(s)`, minus binding gained). It all goes in as heat, labelled as an upper bound.
- Crater melt volume: V_m ≈ 8.9e-12 · E · sin θ m³ (Collins, Melosh & Marcus 2005, after Pierazzo et al. 1997). Check the equation number when implementing.
- Giant impacts make a hemispheric or global magma ocean of mass heat / (c_p ΔT + L), with c_p about 1,200 J/kg/K and L about 4e5 J/kg, labelled.
- **Two layers.**
  - The surface temperature follows a conductive crust, from the balance εσT_s⁴ = k(T_m − T_s)/√(πκt) (Turcotte & Schubert 2014). The visible glow therefore fades within hours to days.
  - The interior drains at that flux and is shown as a number, labelled: "airless bound; under a steam atmosphere 10³ to 10⁶ years" (Lebrun et al. 2013; Elkins-Tanton 2012).
- Excess heat goes to the climate bands (ledger WR-2).

**Drawing.**
- `marks.ts`'s `glows` uniform goes from float to vec4, with luminance computed on the CPU from the W1.14 table (about 250 B explorer).
- Giant impacts on the Earth, Moon, Mercury and Mars leave glow-only heat marks, with angle clamp(1.5·asin(R_p/R_t), 0.05, π).
- `rocks.ts` gets a heat term for lab bodies.

**Cost:** about 2 KB in the simulation, 1.5 KB in the lab.

**Tests.**
- `tests/unit/thermal.spec.ts`:
  - heat banked equals the event's heat exactly;
  - cooling is monotonic;
  - the crust's surface temperature matches the analytic half-space solution;
  - the surface falls below the Draper point (798 K) at the analytic time;
  - determinism holds through seek;
  - melt volumes match Collins et al.'s worked examples.
- Browser:
  - the Mars-mass erosion gives the Earth a heat mark that dims over simulated hours;
  - a 1 km stone on the Moon leaves a crater-floor glow gone within simulated hours;
  - the glow never exceeds the cap.

### W2.4 Air stripped by impacts (Vis-F18, the atmosphere part of Phys-F16)
- **Change.**
  - `atmosphereLoss()` in `src/sim/impacts.ts`, after Schlichting, Sari & Yalinewich 2015:
    - giant impacts: X = 0.4x + 1.4x² − 0.8x³ with x = v_imp·m_imp / (v_esc·M), so X(1) = 1;
    - small impactors: the same paper's small-impactor regime (verify the coefficients when implementing).
  - Applied in `merge()` and `fragment()`, writing `s.climate[id].spec.pressurePa` deterministically.
  - The history states the air lost, and that the air's mass is not part of GM.
  - The air shell's column-density uniform in `bodies/atmosphere.ts` (about 80 B explorer).
  - Escaping-air splats, labelled illustrative.
- **Cost:** about 1.6 KB.
- **Tests.**
  - Unit: X(0) = 0 and X(1) = 1; the paper's example values; pressure never goes negative.
  - Browser (Mars-mass on the Earth): pressure falls, `climateSummary` changes, the shell's uniform drops, and no flash appears.

### W2.5 Event cards, the story and "Why?" (Vis-F23, Exp-F13)

**Card.** Shown for 6 s, then pinned in the history. It gives:
- the regime in words (Leinhardt & Stewart 2012);
- the requested and actual speed and angle;
- the energy in J and Mt, and against Chicxulub (order 10²³ to 10²⁴ J, Schulte et al. 2010; labelled approximate);
- the seismic magnitude, M = 0.67·log₁₀E − 5.87 (Collins et al. 2005);
- crater, melt, heat, air lost and debris count;
- what is model and what is illustrative.

**"Why?"** It uses the numbers `impactOutcome` already returns (Q_R against Q*_RD′, v against v_esc′ and v_erosion).

**Stars.** A contact with a star body is reported as kind `absorbed`, because the impact regimes do not apply to stars.

**Also:**
- A polite live region, throttled.
- A timeline under the lab clock, with event and checkpoint markers. Clicking one replays (W2.6).
- `photo-bar.ts` adds the experiment's lines to the credits band.

**Cost:** about 3 KB.

**Tests.**
- The card appears within one frame and never covers the impact site (an inset check).
- Its numbers equal `view()` and `impactOutcome`.
- Timeline markers equal the number of events.
- Photo credits include "An experiment, not a prediction" (allowed wording in the credits).
- axe passes.

### W2.6 Instant replay of an event, bit for bit (Vis-F15 corrected)
- **Change.**
  - Every event pins the checkpoint before it (up to 12 pinned, about 2.4 MB with 4,000 particles).
  - "Replay this impact" uses W1.4's sliced seek, runs under W1.13's slow motion, and arrives back at the live step with an identical state.
  - Edits are disabled during a replay, or the panel asks whether to branch.
  - Lives in `lab-cinema`.
- **Cost:** about 2 KB.
- **Tests.**
  - After a replay, the Float64 `pos` and `vel` equal the live state exactly, and the event log is unchanged.
  - Two replays give identical frame hashes.
  - No worker tick exceeds 12 ms.

### W2.7 Trails and paths ahead that read (Vis-F16)
- **Change.**
  - New `src/explore/lab-fx/lines.ts`: instanced screen-space quads in one draw call, replacing `polylinePath` and `createOrbits` for lab paths.
  - Trails fade with age. An optional colour by speed relative to the primary uses a ramp safe for colour-blind viewers.
  - Day or orbit ticks along paths integrated ahead.
  - For a coming contact, ghost discs of both bodies at contact time and the site marked; `Prediction.merged` gains the other body's position.
  - Optional osculating ellipses (`elementsFromState`).
- **Cost:** about 3 KB. GPU at most 0.1 ms.
- **Tests.**
  - Unit: ring-buffer wraparound; tick spacing.
  - Browser: the ghost is within 1 px of the body when contact happens, and line objects stay level over round trips.

### W2.8 Tidal stretching before the break (Vis-F17, labelled)
- **Change.**
  - The drawn elongation is ε = (3/2)·h₂·(M/m)·(R/d)³ with h₂ = 5/2. That gives about 0.26 at the fluid Roche limit.
  - Applied only to bodies of 100 km or more.
  - Labelled: "linear equilibrium bulge; the true Roche ellipsoid is more elongated near the limit (Chandrasekhar 1969)".
  - Rocks get a per-instance stretch axis. Built-in worlds get per-axis scale (about 120 B explorer).
  - Rigid and fluid Roche rings are drawn while the inspector's Roche row is open.
- **Cost:** about 1.2 KB.
- **Tests.**
  - Unit: ε at the fluid limit is 0.26 ± 0.005, and 0 below 100 km.
  - Browser: in the Roche lesson, the Moon's drawn axis ratio is at least 1.15 just before disruption, and the pieces fade in with no pop.

### W2.9 Event director (Vis-F14)
- **Change.**
  - New `src/explore/lab-fx/director.ts` in `lab-cinema`. It is opt-in, and on during replays.
  - Shots:
    - approach: 20° to 30° off the incoming line, with the Sun at 60° to 110° of phase;
    - contact: framing the target and the ejecta apex (v²/2g, or 1.5R for giant impacts);
    - aftermath: chasing the largest debris;
    - tidal: side-on to the radial line.
  - Camera limits: at most 30° a second, no roll, at most one stop of field of view per second. Reduced motion gets cuts under the exposure veil.
  - `index.ts` consumes an optional `lab.cameraRequest()`, the same pattern as the stars scene (about 250 B).
- **Cost:** about 4 KB.
- **Tests.**
  - Unit: over 100 random approaches, both bodies stay inside the clear-view insets at at most 30° a second.
  - Browser: target and impactor are both on screen at T − 2 s, and the site at contact. With reduced motion there is no translation between cuts.

### M2 exit gate
All of the above, plus:
- `docs/IMPACTS.md` updated with the tracer, ejecta, heat and air models and their labels;
- ledger rows IM-2, IM-4 and IM-6 updated;
- the flash and `@perf` specs re-run with every M2 effect on.

---

## M3. A laboratory you can play

**Goal.** A child can throw a rock within ten seconds. An expert can find any number and compare with reality. Both leave having thought about why things turned out as they did.

**Budgets:**
- Laboratory with `lab-fx`: about 140 KB. `lab-catalogue` about 12 KB; `lab-gallery` about 18 KB.
- Explorer: 0, beyond the sheet header already counted in M1.
- Worker: a second instance of the same module (0 B), at most 30 MB.

**Data and licences:**
- Catalogue values from the cited papers (below).
- `neighbourhood.json`, already shipped (NASA Exoplanet Archive; its terms are already recorded for ledger IS-4).

### W3.1 Five rooms and two levels (Exp-F1)
- **Change.**
  - `lab-panel.ts` (1,257 lines) splits into a WAI-ARIA tab strip with five rooms:
    - **Play:** gallery, challenges, lessons.
    - **Add:** library, place, throw, strike.
    - **Change:** the chosen body's card and edits.
    - **Watch:** frames, measure, graphs, checks, story.
    - **Keep:** timeline, branches, save, library, link, file.
  - Simple (the default on a first visit) shows four facts per body: mass and size in Earths, year and day, temperature.
  - Expert adds elements, J2, accuracy, frames, state-vector and Lagrange add, and raw burns.
- **Cost:** about +5 KB net.
- **Tests.**
  - `tests/explore/lab-play.spec.ts`: the tab pattern (arrows, Home and End), and axe passes.
  - Every existing `lab-*` test id is still reachable from its room.
  - No horizontal scroll at the five layout sizes.

### W3.2 Phone, keyboard and switch access (Exp-F14, Exp-F15)
- **Change.**
  - The sheet header carries the room tabs and the time row.
  - Keyboard edit modes on the free keys N, M, V and T are consumed in the capture phase, before `input.ts`'s camera keys.
  - Switch scanning through rooms and bodies.
  - Every target is at least 44 px on a coarse pointer.
- **Cost:** about 1.5 KB.
- **Tests.**
  - Keyboard: add, select, push and undo without a pointer.
  - Mobile project: every control is at least 44 px and hit by `elementFromPoint`.

### W3.3 Drag a world, and its moons come with it (Exp-F5 corrected)
- **Change.**
  - A new validated `batch` command: one log entry, applied atomically, one undo.
  - "Move" carries satellites by default: the same displacement and change of velocity are applied to every body whose Hill primary is the moved body.
  - On release, an explicit choice: "keep its speed" or "make its orbit round here".
- **Cost:** about 1.5 KB.
- **Tests.**
  - Dragging the Earth to 1.52 au leaves the Moon bound to the Earth (e < 1 about it) for one year.
  - Undo restores the state bit for bit.
  - `batch` passes the `checkCommand` and `validateScenario` parity test.

### W3.4 A library of real things (Exp-F10)
- **Change.** Lazy `src/ui/explore/lab-catalogue.ts`. Each entry is cited and placed through validated commands:

| Entry | Source |
|---|---|
| Sirius A and B | Bond 2017; Kervella 2003; Joyce 2018 |
| Betelgeuse | Joyce 2020 |
| Kepler-16 (0.6897 and 0.20255 solar masses, 41.08 d binary; planet at 0.7048 au, 228.8 d) | Doyle 2011 |
| 'Oumuamua (26.3 km/s) | Meech 2017 |
| 2I/Borisov | Guzik 2020 |
| Dimorphos and DART (33.0 ± 1.0 min period change) | Thomas 2023 |
| DART's momentum factor (β about 3.6) | Cheng 2023 |
| Gliese 710 | Bailer-Jones 2018 |

  Compact objects (PSR J0030+0451 at 1.34 solar masses and 12.71 km, Riley 2019; Gaia BH1 at 9.62 solar masses, El-Badry 2023; Cygnus X-1 at 21.2 solar masses, Miller-Jones 2021) appear only from M6, when their policy exists.
- **Cost:** about 12 KB, in its own chunk.
- **Tests.**
  - Every entry has a source id present in `data/sources.json`.
  - Every placed entry passes `checkCommand`.
  - The Kepler-16 planet stays bound for 100 years.

### W3.5 A gallery of what-if questions (Exp-F11 corrected)
- **Change.** Each card is a logged recipe, the number to watch and its source. It ends with a plain-language question to think about. The laboratory attaches no scripture; scripture stays in the film's reviewed cues. Cards include:
  - **Double the Sun's mass.** Shows both cases: instant (a = 2/3 au, e = 0.5, P ≈ 141 d) and re-circularised (P = 365.25/√2 ≈ 258 d).
  - **A rogue Jupiter passes.** Notes that such free-floating Jupiters are rare (Mróz et al. 2017).
  - **The Moon at half its distance.** Labelled "tides not modelled".
  - **Theia.** Labelled "no disc hydrodynamics".
  - The red-giant card waits for M7, and "Replace the Sun" for M6.
- **Cost:** about 8 KB in `lab-gallery`.
- **Tests.**
  - Each recipe replays to a stored hash.
  - The double-Sun card's measured period is 141 ± 1 d (instant) and 258 ± 1 d (re-circularised).

### W3.6 The real system beside the experiment, and twin runs (Exp-F12, Exp-F18)
- **Change.**
  - `lab.ts load()` spawns a second worker instance.
  - That worker runs the baseline: the same fork with no edits, under the same rules.
  - A faint "reality" marker is drawn for each real body at the explorer ephemeris's position.
  - The panel shows three distances:
    - the experiment against the baseline (what the edit did);
    - the baseline against the ephemeris (the model's own error);
    - the experiment against the ephemeris.
  - Twin runs show any two recipes side by side as ghost overlays, for example with and without Jupiter.
- **Cost:** about 2.5 KB.
- **Tests.**
  - The baseline's state hash equals a fresh fork's at the same step.
  - With no edits the experiment-against-baseline difference is exactly 0.
  - The baseline-against-ephemeris figure equals LAB.md's (for example 583 km at 30 days).

### W3.7 Branches you can see (Exp-F17)
- **Change.**
  - A branch tree built from the logs, with the discarded tails kept.
  - Switching branches loads the scenario and runs W1.4's sliced seek with progress. Every switch is a full replay unless that branch's checkpoints are kept. Up to 3 branches keep theirs, within the 16 MB checkpoint budget.
- **Cost:** about 2 KB.
- **Tests.**
  - A switch reproduces that branch's hash.
  - No tick exceeds 12 ms during a switch.

### W3.8 Guess first; challenges without scores (Exp design)
- **Change.**
  - Before a run, a "Guess first" box asks for the number to watch (for example the new year's length). After the run, the guess and the model's value are shown side by side. There are no points and no timers.
  - Challenges such as "a moon at L4 that stays for 10 Jupiter years" are judged by the model.
- **Cost:** about 5 KB in `lab-gallery`.
- **Tests.**
  - The wording passes `scripts/lib/rules` ("guess", never "predict").
  - The L4 challenge passes with the cited Trojan set-up and fails one displaced by 30°.

### W3.9 Build a system from a star, with its habitable zone (Exp-F16)
- **Change.**
  - Pick a star from the library or a mass, then drag planets in.
  - The habitable zone comes from Kopparapu et al. 2014's S_eff(T_eff) polynomials, valid 2,600 to 7,200 K. Outside that range it is marked "extrapolated".
  - Climates come from the 18-band model.
- **Cost:** about 3 KB.
- **Tests.**
  - The Sun's zone edges are 0.95 and 1.676 au to 1e-3.
  - Proxima b at 0.0485 au falls inside for T_eff = 2,900 K.

### W3.10 Real exoplanet systems (Exp design)
- **Change.**
  - Load any of the 183 systems in `neighbourhood.json` lazily.
  - M sin i masses are shown as lower limits.
  - Unknown phases and nodes are set from a seed that is shown, labelled "not known".
- **Cost:** about 2 KB.
- **Tests.**
  - Each loaded system passes `checkCommand`.
  - Unknown values carry the "not known" label.
  - Masses from M sin i carry "lower limit".

### W3.11 Dynamical structure drawn (Phys-F20, Exp design's zero-velocity curves)
- **Change.**
  - `elements.ts` gains `jacobiConstant`, `zeroVelocityContour` (marching squares, about 2,000 points), `laplaceSoiKm = a·(m/M)^(2/5)` and `resonance(a, b)` (nearest p:q with q ≤ 5, and a libration test).
  - Drawn with the existing line mesh.
  - Recomputed only when the selection changes or C changes by more than 1e-6 (about 2 ms once).
- **Sources:** Murray & Dermott 1999, chapters 3 and 8; Hill 1878.
- **Cost:** about 4 KB.
- **Tests.**
  - The contour at C_L1 passes through L1 to 1e-6.
  - The Earth's Hill radius is 1.50e6 km.
  - A particle with C > C_L1 inside the Earth's lobe stays there for a year.
  - Neptune and Pluto are reported in 3:2 and librating.
  - The overlays are identical across camera frames.

### W3.12 Shorter share links
- **Change.** Version-2 links encode command kinds as small integers and Float64 values as base64 of the raw bytes, keeping them bit-exact, then deflate.
- **Cost:** about 1 KB.
- **Tests.**
  - All gallery recipes produce links of at most 2,000 characters.
  - The round trip is bit-exact.
  - Version-1 links still open.

### M3 exit gate
- Usability spec: from a cold `#/universe/lab`, a scripted coarse-pointer path reaches "throw a rock at the Earth" in at most 3 taps.
- axe is clean in every room.
- `check-bundle` has the catalogue and gallery rows.

---

## M4. An instrument you can trust

**Goal.**
- Accuracy is controlled.
- Contacts happen at the true moment.
- Every exchange of energy is accounted for.
- The same experiment replays identically in every browser.

**Budgets:**
- Laboratory with `lab-fx`: about 165 KB. `lab-bench`: about 15 KB.
- Worker per tick unchanged.
- Target throughput: at least 300,000 steps a second on the solar fork in Node, and at least 4,000 a second at 64 bodies.

**Data and licences:**
- REBOUND (GPL-3): outputs only, as data fixtures (`scripts/rebound/run.py`). Its code is never imported.
- fdlibm (Sun Microsystems 1993): permissive notice, kept in the file header.

### W4.1 Schema 2 with a physics block; the version-1 path frozen
- **Change.**
  - `SCHEMA_VERSION = 2`, `ENGINE_VERSION = 'kf-nbody-2'`.
  - The physics block covers the integrator, `gr`, tides, materials, rubble gravity, the radius rule and the limits profile.
  - Version-1 files migrate onto the kept leapfrog path with every new flag off.
  - Every change to `nbody.ts` from here to M7 is gated on this block. That dual-path cost is counted in each package's effort.
- **Tests.**
  - The 20 recorded version-1 scenarios replay to their stored hashes, and keep doing so in every later milestone.
  - `validateScenario` accepts both versions.

### W4.2 IAS15 as the default integrator (Phys-F2)
- **Change.**
  - New `src/sim/ias15.ts`, written from the papers:
    - Everhart 1985 (Gauss-Radau);
    - Rein & Spiegel 2015;
    - Pham, Rein & Spiegel 2024 (the global step criterion).
  - Predictor-corrector iterations until the change in b falls below 1e-16.
  - Spins are integrated by a separate first-order Radau variant, because IAS15 is built for second-order equations.
  - The leapfrog stays as a "fast" choice and as the version-1 path.
- **Cost:** about 7 KB.
- **Tests (`rebound.spec.ts`, `sim.spec.ts`).**
  - The solar fork against `tests/fixtures/rebound/solar-1yr.json`, point mass with J2 off: every body under 1 km after one year (Mercury is 4,370 km today). Relative energy error under 1e-13.
  - Close encounter: under 100 km against a new REBOUND IAS15 fixture. The existing RK4 at 30 s has no established error of its own.
  - e = 0.9 for 1,000 orbits: phase error under 1e-8.
  - Pythagorean three-body problem (Szebehely & Peters 1967): energy error under 1e-10, and the mass-3 body ejected.
  - Force evaluations per simulated year are recorded with `scripts/sim-report.ts` against today's 8,483 steps.

### W4.3 Dense output from IAS15, edits at their exact time, and running back before the fork (Phys-F3, Phys-F5)
- **Change.**
  - IAS15 runs sample the step's own polynomial for W1.2's bracket, replacing the scratch step.
  - W1.3's partial step becomes essential under day-long steps.
  - "Run back before the start" integrates with dt < 0, with contacts, disruption, climate and ships off. It is labelled "integrated backwards; collisions not reversed" and makes a new fork.
- **Tests.**
  - A mid-step sample is within 1 m of a run that lands exactly on that time.
  - Sampling never changes the hash.
  - Back one year then forward one year returns within 1 m (IAS15) or 1 km (leapfrog). This tests accuracy only; neither integrator is time-symmetric.

### W4.4 Contacts at the true moment, on curved paths (Phys-F4)
- **Change.**
  - `contactTime(i, j, dt)` replaces `closest()`. It follows the pair's relative state with `keplerDrift` (under IAS15, the dense polynomials) and finds the root of |r(τ)|² − (R_i + R_j)² by bracketed Newton.
  - Only pairs within 3 times their contact distance are refined.
  - Every body is sub-stepped to the earliest τ, the contact is resolved through `merge`, `fragment` or graze, and the step is finished.
  - The IAS15 path drops the approach term from `timescale()`.
- **Sources:** Hairer, Nørsett & Wanner, section II.6; Chambers 1999.
- **Cost:** about 2.5 KB.
- **Tests.**
  - An impactor at 25 km/s falling from 10 Earth radii with 1-hour steps: contact time within 0.1 s of the analytic fall.
  - The merged centre of mass is within 1 m.
  - Impact speed equals √(v∞² + v_esc²) to 1e-9, and the site is within 1 km.
  - Mass, momentum and angular momentum are exact.

### W4.5 Swarms at their own pace (from the review of Phys-F2 and F18)
- **Change.**
  - Each swarm gets a stride: a whole number of body steps set by its primary's timescale. For example, about one day for a belt about the Sun, and one body step for a ring about the Earth.
  - Drift is exact over the stride, and kicks use the bodies' dense positions.
  - The stride is a logged scenario parameter, so replay stays deterministic.
- **Cost:** about 1.5 KB.
- **Tests.**
  - A Node bench: the solar fork with 4,000 belt particles at 30 days a second reaches at least 90% of the requested rate.
  - A Trojan swarm still librates.
  - An Earth ring's radial spread over 30 days is within 1% of stride 1.

### W4.6 An energy ledger that is never switched off (Phys-F6)
- **Change.**
  - `internal` becomes `ledger {impactHeat, bindingGained, tidalHeat, thrustWork, constraintImpulse, constraintTorque, removedEnergy, massLoss, radiated}`.
  - `drift()` returns the closure error per quantity.
  - The panel shows one row per channel and a chart of log₁₀|ΔE/E| with Brouwer's √N·1e-16 band (IAS15) or the leapfrog's bounded band.
  - Each quantity says plainly whether it is conserved. For one held body:
    - energy is conserved (the held body is a static field);
    - momentum is not;
    - angular momentum is kept about the held body, and only its axial part if that body is oblate.
- **Cost:** about 6.5 KB.
- **Tests.**
  - Through a merger, a breakup, a disruption, a burn and a held body: mechanical energy plus the ledger is constant to 1e-12 (IAS15).
  - Merger heat equals ½μv² at contact.
  - Thrust work equals Δ(½mv²) in empty space.
  - With one body held, the change in momentum equals the recorded constraint impulse.

### W4.7 Instruments that measure correctly (Phys-F19)
- **Change.**
  - New `src/sim/recorder.ts`: up to 8 series sampled at a fixed simulated cadence through dense output, in decimating min/max buckets.
  - `hillPrimary()` replaces `primaryOf` in the recorder, predictions and the inspector.
  - A multi-series SVG chart with a log toggle, a cursor and "Export CSV". The export is a values-only Blob download, started by the visitor.
- **Cost:** about 4 KB.
- **Tests.**
  - The Moon's e recorded at a 1-hour cadence over a year shows the evection at 31.8 ± 0.5 d, and the same at 30 days a second.
  - `hillPrimary` assigns the Moon to the Earth, a Trojan to the Sun, and a body at 0.4 of Jupiter's Hill radius to Jupiter.
  - The CSV rows match the series.

### W4.8 Typed-array state, with the second worker serving predictions (Phys-F28)
- **Change.**
  - The state moves to Float64Arrays of capacity `MAX_BODIES`, with flags in a Uint8Array rebuilt only on edits and events. Hot loops lose their `?? 0` guards and per-step allocations.
  - The second worker (from W3.6) also serves predictions, ensembles and the bench.
- **Cost:** about 2 KB.
- **Tests.**
  - All existing sim, lab-engine, swarms, impacts and kepler tests pass unchanged.
  - 20 recorded hashes are unchanged.
  - Throughput is at least twice the recorded baseline.
  - A one-year path integrated ahead returns in under 0.5 s while the live run holds its rate.

### W4.9 Bit-exact replay across browsers (Phys-F22)
- **Change.**
  - New `src/sim/detmath.ts`:
    - hypot3 by scaled sqrt;
    - cbrt by Newton's method;
    - fdlibm ports of sin, cos, tan, asin, acos, atan2, exp, log, sinh and cosh;
    - integer powers as multiplications.
  - Every `Math.*` and `**` in `src/sim/**` is replaced, and an eslint rule bans them there.
- **Cost:** about 2.5 KB.
- **Tests.**
  - Every kernel is within 1 ulp of `Math.*` over 1e6 inputs.
  - New Playwright projects `webkit` and `firefox` (decision D6) run one spec: 50,000 steps of the Pythagorean problem plus a fragmenting impact. The SHA-256 of the final state matches Chromium's.

### W4.10 A validation bench: "How do we know?" (Phys-F21)
- **Change.**
  - Lazy chunk: `src/sim/bench.ts` (pure scenario builders and checks) and `src/ui/explore/lab-bench.ts`.
  - It shows the lab's number beside the reference, with the tolerance and pass or fail.
  - Benchmarks:
    - Kepler's third law;
    - second-order convergence;
    - the figure-eight orbit (Chenciner & Montgomery 2000; Simó's conditions; T = 6.3259);
    - the Pythagorean problem;
    - a Trojan at L4 for 10 Jupiter years;
    - J2 nodal regression;
    - lunisolar precession of 50.38″ a year (Capitaine et al. 2003);
    - the Moon's 18.6-year nodal cycle;
    - agreement with REBOUND;
    - Leinhardt & Stewart's Q*_RD.
  - Later milestones add their own benchmarks.
- **Cost:** at most 15 KB, in its own chunk.
- **Tests.**
  - `tests/unit/bench.spec.ts` runs the same functions, so CI and the app share one definition.
  - The browser opens the bench and runs two quick benchmarks.

### M4 exit gate
- The bench is green in CI.
- `docs/LAB.md`'s accuracy table is re-measured and published: Mercury, the close encounter, energy, and steps per second.
- Version-1 hashes are unchanged.

---

## M5. Matter with substance

**Budgets:**
- Laboratory with `lab-fx`: about 178 KB.
- Explorer: +150 B.
- Worker: semi-active tracers cost O(N_tracers × N_bodies) per kick, the same order as today's swarm kick.

**Data and licences:** cited compositions and constants go in `data/constants.json`. Specific heats come from standard tables, for example the CRC Handbook.

### W5.1 Debris with mass and a size distribution (Phys-F7 corrected)
- **Change.**
  - `fragmentMasses()` in `impacts.ts` follows Leinhardt & Stewart's N(>D) ∝ D^−β with β = 2.85.
  - The largest pieces by rank become bodies with unequal masses. The remainder goes to a semi-active, mass-carrying tracer swarm: its reaction on the bodies is applied in `kickSwarms`, so momentum and energy close.
  - Disruption debris keeps Chambers-type launch speeds with a labelled spread. Housen & Holsapple is not used outside cratering.
  - A struck tracer adds its mass and momentum to the body, recorded as accretion in the ledger.
- **Sources:** Leinhardt & Stewart 2012; Chambers 2013; Jackson & Wyatt 2012.
- **Cost:** about 4 KB.
- **Tests.**
  - The log-log slope of N(>m) is within 0.05 of −β/3.
  - Mass is exact. Momentum and angular momentum are exact to 1e-12 with two-way coupling.
  - No energy is created.
  - A slow breakup at 1.1 times escape speed reaccretes more than 80% of the swarm within 2 days, and the remnant's GM rises by that mass.
  - Replay is bit for bit.

### W5.2 Materials, heat and parentage kept in the scenario (Phys-F8)
- **Change.**
  - `BodySpec` gains `material` (iron, rock, ice and gas fractions), `heatJ` and `parent`.
  - Mergers and breakups mix by mass.
  - c_p by material: rock about 1,000, iron about 450, ice about 2,100 J/kg/K.
  - Built-in compositions are cited entries.
- **Sources:** Lock & Stewart 2017; Abe 1997; Elkins-Tanton 2008.
- **Cost:** about 3 KB.
- **Tests.**
  - A merger's composition is the mass-weighted mean.
  - The change in heat equals the ledger's impact heat.
  - Mars-mass into the Earth at 15 km/s leaves fragments above about 1,400 K.
  - A 1 km impactor warms the Earth by less than 0.01 K.
  - Every field survives save, load and replay.

### W5.3 Torn pieces keep their gravity (Phys-F9 corrected)
- **Change.**
  - Under schema 2, the torn-pair exemptions in `accelerations`, `energy`, `timescale` and `resolveContacts` are removed.
  - Pieces start touching but not overlapping inside the body's own volume, in an arrangement labelled illustrative.
  - A contact inside the Roche zone uses Ohtsuki 1993's r_p (the pair's Hill radius over R_i + R_j). The pair merges if r_p > 1 and the approach is slower than their mutual escape speed. Otherwise it bounces with a constant restitution, labelled.
  - Disruption is tested at the periapsis of the current two-body orbit, so parabolic passes count.
- **Sources:** Ohtsuki 1993; Canup & Esposito 1995; Holsapple & Michel 2006.
- **Cost:** about 2.5 KB.
- **Tests.**
  - At 0.8 of the fluid limit: no mergers for 30 days, and the pieces spread.
  - Started at 1.3 times the fluid limit: at least 2 mergers within 100 orbits. Labelled "the criterion shown; 8 pieces cannot reproduce Kokubo et al. 2000's disc".
  - A parabolic pass inside the limit disrupts the body.
  - Mass and angular momentum are exact.
  - The Roche lesson still completes.

### W5.4 Radius follows mass, and stars ignite (Phys-F13 corrected, Exp-F19)
- **Change.**
  - New `src/sim/structure.ts`. Radii scale relative to the body's own radius along the branch exponent:
    - Chen & Kipping 2017: terran M^0.279, neptunian M^0.589, jovian M^−0.044, stellar M^0.881;
    - Zeng, Sasselov & Jacobsen 2016 for rock and iron.
  - `radiusRule: 'held' | 'density' | 'relation'`.
  - `ignite()` runs after mergers, accretion and mass edits:
    - crossing `STAR_MIN_GM` adds `s.stars` with main-sequence light;
    - crossing about 13 Jupiter masses marks a brown dwarf.
  - Instant ignition is labelled "skips 10⁸ to 10⁹ years of contraction".
  - `teffK` is added to the snapshot.
  - The Expert "scale handle" can turn Jupiter into a star.
- **Sources:** Chen & Kipping 2017; Zeng et al. 2016; Eker et al. 2018; Spiegel et al. 2011; Chabrier & Baraffe 2000.
- **Cost:** about 1.5 KB.
- **Tests.**
  - Two Jupiters merged: 0.97 ± 0.01 Jupiter radii (2^−0.044 = 0.970).
  - 80 Jupiter masses gains light equal to `mainSequenceLuminosityW(0.076)`.
  - Held radii are unchanged.
  - The Sun's T_eff is 5,772 ± 5 K.

### W5.5 Climate limits (Phys-F16)
- **Change.**
  - Water worlds' outgoing radiation is capped at about 282 W/m² (Goldblatt et al. 2013). Absorbing more sets `runaway`, and the interface then says "oceans boiling; the model is beyond its range".
  - Impact heat goes into the bands (shared with W2.3).
  - Energy-limited XUV escape, labelled order-of-magnitude (Watson et al. 1981; Ribas et al. 2005).
- **Cost:** about 2 KB.
- **Tests.**
  - The runaway flag sets inside 0.92 au and not outside, from 1361 × 0.7 / 4 against 282 W/m².
  - A Chicxulub-class impact leaves pressure above 99%.
  - Heat deposited in the bands equals the event's heat.

### W5.6 Worlds that glow when hot (Vis-F20)
- **Change.**
  - A 16-entry luminance uniform in `climate-view.ts` (about 150 B explorer), filled from band temperatures and `noonK` using the W1.14 table.
  - Nothing glows below 798 K.
  - Lab bodies get the same glow through `rocks.ts`.
- **Tests.**
  - Mercury moved to 0.05 au glows on its day side with a colour on the blackbody locus.
  - The Earth at 1 au shows no glow.

### W5.7 The spin limit, and a synestia label (Phys-F11 corrected, Vis-F27)
- **Change.**
  - `setSpin` and `setRadius` edits that would spin a body beyond `breakupPeriodS` are refused with the reason.
  - A merger beyond Lock & Stewart's corotation limit (approximated from their thresholds, labelled) is named a synestia. It is drawn flattened by the Maclaurin relation (Chandrasekhar 1969), capped.
- **Tests.**
  - A Canup-type impact (Mars mass at v_esc and 45°) leaves a day of about 4.5 h and no synestia label. This is a negative test: the angular-momentum ratio is about 0.32.
  - An edit to a 1-hour day on the Earth is refused.
  - Maclaurin flattening matches e(Ω) at three points.

### M5 exit gate
- The bench gains the merger radius, ignition, runaway threshold and debris slope.
- `docs/IMPACTS.md` and `docs/CLIMATE.md` are updated.

---

## M6. Stars, black holes and relativity

**Budgets:**
- Laboratory with `lab-fx`: about 188 KB. `lab-lens`: about 5 KB.
- GPU: the lens at most 0.8 ms at High, only while its Einstein radius is at least 1 px; 0.05 ms at Low.
- Explorer: +150 B, if D3 is approved.

**Data and licences:**
- Claret 2000 limb darkening (CDS VizieR catalogue, free with citation).
- GRAVITY Collaboration masses and the S2 orbit, as published.

### W6.1 General relativity at first post-Newtonian order (Phys-F12)
- **Change.**
  - New `src/sim/gr.ts`: Einstein-Infeld-Hoffmann with PPN β = γ = 1 (as DE440 uses), plus a cheaper single-mass term.
  - `physics.gr` defaults to `eih` in the solar fork and `off` in the two- and three-body labs.
  - The inspector shows the relativistic periapsis advance per orbit, 6πGM / (c²a(1 − e²)).
- **Sources:** Einstein, Infeld & Hoffmann 1938; Park et al. 2021; Will 2014.
- **Cost:** about 2.5 KB.
- **Tests.**
  - Mercury advances 42.98 ± 0.2″ a century in both modes.
  - The 1PN energy is kept to 1e-12.
  - The solar fork is under 1 km from a REBOUND + REBOUNDx `gr_full` fixture after one year.
  - Newtonian runs are bit-unchanged with relativity off.
  - A bench entry is added.

### W6.2 Stars drawn fully, with several lights (the rest of Vis-F19)
- **Change.**
  - Quadratic limb darkening by T_eff (Claret 2000).
  - Granulation once cells exceed 3 px.
  - Surface radiance ∝ T⁴ under `sun.ts`'s ceiling.
  - Lab bodies are lit by up to 4 stars.
  - Lighting the ten built-in worlds with a second sun needs explorer shader work (decision D7).
- **Tests.**
  - The Sun's limb-to-centre ratio at μ = 0 is about 0.3.
  - Proxima is reddish (about 3,000 K).
  - A lab planet circling Kepler-16 shows two terminators.

### W6.3 Black holes and neutron stars with honest limits (Phys-F23 core, Exp-F18, Vis-F22 presets)
- **Change.**
  - A `kind: 'blackHole'` (and neutron star) is validated.
  - `luminosityW: 0` is honoured. This fixes the 9,300-Sun bug.
  - A black hole's radius is r_s = 2GM/c². A neutron star's is 12 km by default, or the catalogue value.
  - Capture when the Newtonian periapsis is below 4 r_s (8GM/c²).
  - Scenarios with a compact body use a "stellar" limits profile, with `dtMinS` down to 1e-4 s. The rates line says when a close pass slows the run.
  - Labels:
    - "Newtonian (1PN where on); general relativity differs strongly within about 10 r_s, and orbits there are not trustworthy";
    - "a young neutron star's X-ray light: not modelled".
  - Twin lesson: a star against a black hole of the same mass. With no contacts the runs are bit-identical, because `accelerations()` and `timescale()` use only GM and position.
  - The library's compact entries are enabled.
- **Sources:** Schwarzschild 1916; Bardeen, Press & Teukolsky 1972; El-Badry et al. 2023; Riley et al. 2019; Miller-Jones et al. 2021.
- **Cost:** about 4 KB.
- **Tests.**
  - Parabolic orbits with periapsis 3.9 r_s are captured, and those at 4.1 r_s are not.
  - The twin runs are bit-identical without contacts.
  - A Gaia BH1 preset gives no light.
  - A close pass by a 10-solar-mass black hole stays finite and closes the ledger.

### W6.4 Lensing, labelled as a screen-space approximation (Vis-F22 corrected)
- **Change.**
  - New `src/explore/lab-fx/lens.ts`:
    - a shadow of radius (3√3/2)·r_s (Synge 1966) and a photon ring, drawn analytically;
    - guide circles at r_s, 1.5 r_s and 6GM/c²;
    - deflection of pixels already in the viewport from an exact Schwarzschild table (Darwin 1959; Bozza 2002), magnification capped.
  - Labelled: "screen-space: light from outside the view is missing".
  - Low tier and WebGL2 phones get the shadow, ring and guides only.
  - "Replace the Sun" in the solar fork needs D3. Otherwise it is offered in the two-body lab only.
- **Tests.**
  - The table is within 0.5% of the weak-field 4GM/(c²b) at b ≥ 50 r_s.
  - The ring's on-screen radius is within 2% from 1,000 km.
  - Lensed stars sit within 1 px of β = θ − θ_E²/θ.
  - The flash guard passes.

### W6.5 Tidal-disruption streams (Phys-F23)
- **Change.**
  - A star passing inside r_t = R*·(M_BH/M*)^(1/3), but outside capture, becomes a tracer stream (from W5.1) with the frozen-in energy spread ±GM_BH·R*/r_t².
  - Above the Hills mass, the star is swallowed whole.
  - Accretion luminosity L = ηṀc² with η ≈ 0.057, capped at the Eddington limit, labelled.
- **Sources:** Hills 1975; Rees 1988; Stone, Sari & Loeb 2013; Guillochon & Ramirez-Ruiz 2013.
- **Tests.**
  - A Sun-like star at r_p = r_t about 1e6 solar masses: the bound return-time histogram's slope is −5/3 ± 0.1.
  - The star is swallowed whole at 2e8 solar masses.
  - L never exceeds L_Edd.

---

## M7. Deep time and the real small bodies

**Budgets:**
- Laboratory with `lab-fx`: about 204 KB. `lab-stellar` (worker-side lazy): about 12 to 14 KB.
- Data: `de440-states.json` about 30 KB and `small-bodies.json` about 80 KB, both lazy.
- Worker: "run to a date" may use 14 ms a tick while it shows "computing".

**Data and licences:**
- JPL Horizons DE440 state vectors and the JPL Small-Body Database (NASA/JPL, Caltech): freely usable with credit, recorded in `data/sources.json`.
- SSE (Hurley et al.) outputs as a data-only fixture. Check the licence before running it; the code is never imported.

### W7.1 A seed that is an N-body solution: DE440 (Phys-F17 corrected)
- **Change.**
  - `scripts/jpl` writes `public/assets/jpl/de440-states.json`: the Sun, the eight planets, the Moon, Ceres, Vesta, Pallas and Hygiea, every 5 years from 1800 to 2050 (51 × 14 × 6 Float64 values).
  - `seedSolarSystem` integrates from the nearest earlier epoch to the fork date, at most 5 years, with IAS15 and EIH, in under 0.5 s.
  - `origin: 'observed'`, `sourceIds: ['jpl-de440']`.
  - `seedEpoch`'s clamp to the Moon table is removed for the lab.
  - The fork states its offset from the explorer's approximate-elements ephemeris, and the visual hand-off is eased.
- **Tests.**
  - Integrating the 2025 states to 2030 reproduces the 2030 states, with the residual recorded (target 5 km for the planets and the Moon).
  - An unchanged fork stays within 100 km of a DE440 Horizons fixture for the Earth after 365 days.
  - The offset from the explorer is reported, not tested against 1,000 km.

### W7.2 The real asteroid belt, Trojans, near-Earth and trans-Neptunian objects (Phys-F18)
- **Change.**
  - SBDB elements for the brightest objects by H: 2,000 main-belt, 1,000 Trojans, 500 near-Earth and 500 trans-Neptunian, as Float32.
  - Built as swarms from their elements, using W4.5's strides.
  - Ceres, Vesta, Pallas and Hygiea become bodies, with DE440 GMs.
  - Labelled: "catalogued; test particles that pull nothing; close planetary approaches not resolved for test particles".
- **Tests.**
  - Elements round-trip to 1e-9.
  - 10 asteroids are within 1,000 km of a Horizons fixture after one year.
  - Trojans librate for 100 Jupiter years.
  - At 30 days a second with all 4,000 particles, at least 90% of the requested rate is achieved.

### W7.3 Long-horizon mode: WHFast, and run to a date (Phys-F15)
- **Change.**
  - New `src/sim/whfast.ts`: Jacobi coordinates, `keplerDrift`, correctors of order 11 (Wisdom, Holman & Touma 1996; Rein & Tamayo 2015), and a step of 1/20 of the innermost period.
  - The Earth and Moon run as their barycentre (labelled). If another close pair exists, the run is refused with a reason.
  - An encounter within 3 Hill radii hands over to IAS15 (in the manner of MERCURIUS).
  - A `runTo` request with progress.
  - Year, century and millennium rungs exist only in this mode.
- **Tests.**
  - The outer planets for 1 million years against a REBOUND WHFast fixture: Jupiter's and Saturn's e series match, and the great inequality (about 900 years) appears.
  - Energy error stays bounded below 1e-9.
  - Kozai at 60° reaches e_max = 0.764 ± 2%.
  - The ledger closes across a hand-over.

### W7.4 Secular tides in deep time (Phys-F10 corrected)
- **Change.**
  - Orbit-averaged constant-time-lag equations (Hut 1981; Eggleton, Kiseleva & Hut 1998) for pairs with k₂, evolving a, e and spin.
  - The Earth-Moon pair is evolved as a secular sub-model beside the WHFast barycentre.
  - Values:
    - the Earth's lag is calibrated to 3.82 cm/yr (Dickey et al. 1994), labelled "calibrated";
    - Io and Jupiter k₂/Q from Lainey et al. 2009, Saturn from Lainey et al. 2017, Mars k₂ = 0.169 (Konopliv et al. 2016). Check each value against the paper when entered.
  - In real time, tides are a number in the inspector: "the Moon recedes about 0.3 cm per second at 30 days a second".
- **Tests.**
  - da/dt = 3.82 ± 0.1 cm/yr.
  - The day lengthens 2.3 ± 0.3 ms a century (Stephenson et al. 2016).
  - Io dissipates 0.9 to 1.0e14 W (closed form 9.3e13 W).
  - An eccentric hot Jupiter's e decays at Hut's rate within 5%.

### W7.5 Stars that age, and the red-giant question (Phys-F14 corrected, Exp-F11's red-giant card)
- **Change.**
  - `src/sim/stellar.ts` (lazy in the worker): Hurley, Pols & Tout 2000 analytic tracks, Z = 0.02 by default, with Reimers mass loss at SSE's default η (labelled).
  - A validated `ageStar {id, years}` command.
  - In deep time, mass loss is applied secularly (a·M constant; Hadjidemetriou 1963), labelled.
  - The star's radius becomes its contact radius. Engulfment is its own event kind.
  - The Earth's fate is stated as "decided by tidal drag in the giant's envelope, not modelled here" (Schröder & Smith 2008).
  - The red-giant gallery card is enabled.
- **Tests.**
  - A 1-solar-mass track's main-sequence lifetime, red-giant-tip luminosity and radius, and white-dwarf mass are within 5 to 10% of the SSE fixture.
  - A planet at 1 au around a star losing 30% of its mass ends at 1/0.7 au ± 0.5%.
  - Mercury and Venus are engulfed.

### W7.6 Supernovae, remnants and kicks (Phys-F24)
- **Change.**
  - At SSE's core collapse: remnant mass from Fryer et al. 2012, and an optional kick from Hobbs et al. 2005 (a Maxwellian with σ = 265 km/s), seeded by the event step.
  - The ejecta become a W5.1 swarm, labelled.
  - The light curve is eased under the flash guard.
- **Tests.**
  - After an instant loss of a fraction f of the mass, a circular orbit has e = f/(1 − f) to 1e-9, and is unbound for f > 0.5 (Blaauw 1961).
  - The ledger records the kick as an external impulse.

### W7.7 Chaos instruments (Phys-F27)
- **Change.**
  - MEGNO from the variational equations (Cincotta & Simó 2000).
  - A 16-copy shadow ensemble in the second worker, drawn as a band around the path integrated ahead.
- **Tests.**
  - A Kepler orbit gives ⟨Y⟩ → 2.00 ± 0.05.
  - The Pythagorean problem's ⟨Y⟩ grows linearly.
  - Jupiter and Saturn over 1e4 years are regular.

---

## M8. Optional new scales and senses (each needs an owner decision)

| Item | Source design | Budget | Decision |
|---|---|---|---|
| Galaxies: a separate N-body mode (Plummer, Hernquist, Toomre encounters, the Milky Way and M31 with Sawala et al. 2025's roughly 50% chance of merging). WebGPU direct summation or WebGL2 Barnes-Hut. Stated as statistically reproducible. | Phys-F26 | `GALAXY_SOURCES` 60,000 B; its own worker | D5 |
| Gravitational-wave inspiral (Peters 1964). Tests: merger time; PSR B1913+16 dP_b/dt ≈ −2.40e-12 within 0.5%. | Phys-F25 | about 1 KB | none (after M6) |
| Radiation pressure, Poynting-Robertson drag, comet tails (Burns, Lamy & Soter 1979; Finson & Probstein 1968) | Phys-F29 | about 1.5 KB | none |
| Atmospheric drag, entry heating, airbursts (US Standard Atmosphere 1976, public domain; Chyba et al. 1993; Popova et al. 2013) | Phys-F30 | about 5.5 KB | none |
| Seismic ripples converging on the antipode (in `marks.ts`) | Vis-F21 | about 200 B explorer | D1 |
| Sound tied to events: delayed thunder in air, felt moonquakes; an opt-in sonification labelled "space carries no sound" | Vis-F25 | `LAB_SOUND_SOURCES` 5,000 B; 40 B explorer | D4 |
| Frame-exact video of a replay | Vis-F26 | at most 120 B shell; about 4 KB in `lab-cinema` | D2 |
| Apophis in 2029 from pinned JPL vectors, against JPL's published close approach as a fixture | Exp design | data only | none (after M7) |
| A second sun lighting the built-in worlds (double sunsets, ledger ST-3) | Exp design | explorer shader glue | D7 |

---

## 10. Owner decisions

| | Decision | Needed by |
|---|---|---|
| D1 | Raise `EXPLORE_BUDGET_BYTES` from 150,000 to 155,000 B. Without it, M2's glue does not fit, and the Earth spin blur waits. | before M2 |
| D2 | Allow at most 120 B in the shell for a frame-exact video hook, or drop that feature | M8 |
| D3 | "Replace the Sun with a black hole" in the solar fork switches the explorer's sunlight off (about 150 B). Otherwise it is offered in the two-body lab only. | M6 |
| D4 | An opt-in sonification in space | M8 |
| D5 | Galaxy mode (60 KB chunk, 4 to 6 weeks) | M8 |
| D6 | Add Playwright `webkit` and `firefox` projects (browser downloads in CI) for the cross-browser determinism spec | M4 |
| D7 | A second light source for the built-in worlds' shaders | M6 or M8 |
| D8 | "Slow down for events" on by default | M1 |

Interim choices, until the owner says otherwise (2026-10-26): D8 on by default; D3 switches the sunlight off honestly; D6 waits; D1 is avoided by splitting the explorer chunk rather than raising its limit.

D1, the owner's answer (2026-10-27): raise the explorer's limit to 155,000 B, since 5 KB more is not noticeable to a visitor. `EXPLORE_BUDGET_BYTES` is 155,000; following lab bodies with the camera, M2's glue and the Earth spin blur now have room.

## 11. Out of scope here, but sharing the same controls

These come from the time and graphics diagnoses and ship on the explorer track. They do not count against this plan's explorer bytes, except where noted:
- the explorer's time-machine reducer (edges, ladder ends, arrival glide, focus keys);
- the analytic Moon that extends the explorer's span beyond 2026 to 2035;
- the Earth spin blur (waits for D1);
- the explorer-wide asteroid belt and space graphics.

The explorer's date span limits the lab's fork dates until the analytic Moon lands.

## 12. Not adopted, and why

| Idea | Reason |
|---|---|
| Rotational shedding as the source of a Moon-forming disc | A Canup-type impact carries about 0.32 of the breakup angular momentum. In Canup 2004 the disc comes from ejected material. |
| "A debris disc forms" from massless tracers | Impossible with point masses (no torques from the deformed body, no pressure). Stated as a label instead. |
| Reproducing Kokubo et al. 2000 with 8 pieces; Bridges et al.'s restitution for rock | Too few particles; the law is misapplied |
| Housen & Holsapple speeds for disruption debris | Outside the law's domain |
| A tidal-dissipation model for real-time play | Its effect cannot be seen in real time. Moved to deep time (W7.4). |
| Stellar mass loss "emerging" from the N-body over 1e8 years | Not interactive. Done secularly instead (W7.5). |
| "Exact" lensing with secondary images | Screen-space cannot see beyond the viewport. Labelled approximation (W6.4). |
| Logarithmic checkpoint thinning promising "any moment within about 2,000 steps" | Contradicts its own memory budget. Replaced by sliced seek, pinned event checkpoints and a recorder. |
| A lumped magma ocean glowing at its surface for decades | Surfaces quench. Two-layer model instead (W2.3). |
| Landing ejecta feeding crater rays | The rays in `marks.ts` are illustrative and tied to the site. Changing them is unbudgeted explorer shader work. |
| Zero allocation in all of `lab.ts`; heap slope ≤ 0 | Too large a refactor, and flaky. Hot loops plus the retained heap instead. |
| Measuring GPU cost with Apple timestamps | Unreliable on the reference machine |
| Validating the DE440 fork against the explorer's ephemeris | The explorer is the less accurate of the two |

## 13. Traceability

| Design feature | Where |
|---|---|
| Phys-F1 validated edits | W1.1 |
| Phys-F2 IAS15 | W4.2 |
| Phys-F3 dense output | W1.2 (leapfrog), W4.3 (IAS15) |
| Phys-F4 contacts at the true moment | W4.4 (bodies), W2.1 (particles) |
| Phys-F5 exact rewind | W1.4; backward integration W4.3 |
| Phys-F6 energy ledger | W4.6 |
| Phys-F7 debris with mass | W2.1 (massless), W5.1 (corrected) |
| Phys-F8 materials, heat, provenance | W1.5, W2.3, W5.2 |
| Phys-F9 tidal re-forming | W5.3 (corrected) |
| Phys-F10 tides | W7.4 (secular) |
| Phys-F11 rotational breakup | W5.7 (limit on edits only) |
| Phys-F12 relativity | W6.1 |
| Phys-F13 mass-radius, ignition | W5.4 |
| Phys-F14 stellar evolution | W7.5 |
| Phys-F15 WHFast | W7.3 |
| Phys-F16 climate limits | W5.5, W2.4 |
| Phys-F17 DE440 seed | W7.1 |
| Phys-F18 small bodies | W7.2 |
| Phys-F19 recorder | W4.7 |
| Phys-F20 structure overlays | W3.11 |
| Phys-F21 bench | W4.10 |
| Phys-F22 bit-exact replay | W4.9 |
| Phys-F23 black holes, disruption events | W6.3, W6.5 |
| Phys-F24 supernovae | W7.6 |
| Phys-F25 gravitational waves | M8 |
| Phys-F26 galaxies | M8 |
| Phys-F27 chaos | W7.7 |
| Phys-F28 performance, second worker | W3.6, W4.8 |
| Phys-F29 radiation pressure | M8 |
| Phys-F30 drag | M8 |
| Vis-F1 provenance | W1.5 |
| Vis-F2 display clock | W1.2 |
| Vis-F3 effects ladder | W1.0 |
| Vis-F4 fades, flash guard | W1.11, W1.7 |
| Vis-F5 rocks | W1.6 |
| Vis-F6 radius | W1.7 |
| Vis-F7 fireball | W1.14 |
| Vis-F8 heat | W2.3 |
| Vis-F9 ejecta | W2.2 |
| Vis-F10 tracers | W2.1 |
| Vis-F11 dust and rings | W1.8 |
| Vis-F12 slow motion | W1.13 |
| Vis-F13 follow | W1.9 |
| Vis-F14 director | W2.9 |
| Vis-F15 replay | W2.6 |
| Vis-F16 trails | W2.7 |
| Vis-F17 stretching | W2.8 |
| Vis-F18 air stripped | W2.4 |
| Vis-F19 stars | W1.6, W6.2 |
| Vis-F20 hot worlds | W5.6 |
| Vis-F21 seismic | W2.5 (magnitude), M8 (ripple) |
| Vis-F22 black hole and lensing | W6.3, W6.4 |
| Vis-F23 event cards | W2.5 |
| Vis-F24 labels | W1.10 |
| Vis-F25 sound | M8 |
| Vis-F26 video | M8 |
| Vis-F27 synestia | W5.7 |
| Exp-F1 rooms | W3.1 |
| Exp-F2 time | W1.4 |
| Exp-F3 validator | W1.1 |
| Exp-F4 pick | W1.9 |
| Exp-F5 drag a world | W3.3 |
| Exp-F6, Exp-F7 throw and aim | W1.12 |
| Exp-F8 bodies drawn | W1.6, W6.3 |
| Exp-F9 slow down | W1.13 |
| Exp-F10 library | W3.4 |
| Exp-F11 gallery | W3.5, W7.5 |
| Exp-F12 reality beside | W3.6 |
| Exp-F13 story and "Why?" | W2.5 |
| Exp-F14, Exp-F15 keyboard, phone | W1.15, W3.2 |
| Exp-F16 build from a star | W3.9 |
| Exp-F17 branches | W3.7 |
| Exp-F18 twins | W3.6, W6.3 |
| Exp-F19 scale handle | W5.4 |
| Exp: challenges, guessing | W3.8 |
| Exp: exoplanet systems | W3.10 |
| Exp: share links | W3.12 |
| Exp: deep time | M7 |
| Exp: Apophis, second light | M8 |
| Exp: zero-velocity curves | W3.11 |
| Diagnosis: time controls | W1.2, W1.3, W1.4, W1.15 |
| Diagnosis: lab visual effects | W1.5 to W1.8, W1.10, W1.11, W1.14, W1.15 (Roche step text) |
| Diagnosis: navigator and panel | W1.10, W1.15 |
| Diagnosis: AI audit (validation) | W1.1, W1.9 |