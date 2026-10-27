# Kun Fayakun Intelligence

**Status:** design, 2026-10-26. Contracts: `src/ai/types.ts`. The research behind it, with sources, is summarised in §11.

**The owner's rule.** No API key, account, subscription or hosted inference, for visitors or for the system itself. The assistant runs in the visitor's browser. A model is downloaded only when the visitor asks for one, and the download shows its size, licence and source first.

> The real universe is the reference. The sandbox is the thought experiment. Reflection is the purpose.

## 1. What is realistic on a device

| Device | What it gets | Why |
|---|---|---|
| Any browser, no download | **Guide**: a deterministic router for commands, search over the app's verified content, every tool, every calculator, scripture by reference | The guide needs no model, so it is instant, offline and exact. It cannot paraphrase or follow free-form reasoning. |
| Phone (Android flagship with WebGPU) | Guide by default. Opt-in **Pocket** model: Qwen3 0.6B (≈350 MB) | Pocket picks a tool and its arguments from a short list under a schema. Its explanations are weak, and it says so. iPhones get the guide only, because Safari kills tabs above about 0.5–1.5 GB. |
| Laptop with an integrated GPU | **Compact**: Qwen3 1.7B (≈1.0 GB download, ≈2 GB GPU memory) | Reliable at single tool calls under a schema. Explanations are short and grounded in retrieved passages. |
| 8 GB+ unified memory, or a mid GPU | **Standard**: Qwen3 4B (≈2.3 GB, ≈3.4 GB) | The best balance: multi-call plans and fluent grounded explanations. |
| 16 GB+, or a discrete GPU with 8 GB+ | **Large**: Qwen3 8B (≈4.6 GB, ≈5.7 GB) | The strongest of WebLLM's models on function calling (BFCL v4) that fits a browser. |
| Chrome 148+ desktop with its built-in model already downloaded | **Browser model**, optional | No download from us. English only, with no native tool use, so it goes through the same schema and validator path. It is never required. |

No model up to 8B is a reliable source of science facts. Non-thinking GPQA is at most about 42 for every one of them. So the assistant never relies on a model's memory:
- **Facts** come from retrieval over verified content.
- **Numbers** come from calculators and the simulation.
- **Scripture** comes from `data/quran.json` and `data/hadith.json` by id.
- **Actions** are confirmed by reading the app's state back.

The model's job is narrower:
- understand the question;
- choose tools and their arguments under a schema;
- explain what the tools returned.

Every tier is evaluated on this Mac before its model becomes a default (§9).

## 2. Architecture

```
question ─► input guard ─► router (deterministic) ──match──► plan
                               │ no match
                               ▼
                    model plan (JSON schema, shortlisted tools, temperature 0)
                               │ invalid twice → retrieval answer
                               ▼
                 validate (schema + app-state checks)
                               │
          read / calc / cite / view: run now     experiment: preview card → visitor confirms
                               │
                 verify: read the app's state back (done | not-confirmed)
                               │
          answer: model prose grounded in passages + facts, or the guide's template
                               │
                 output guards (scripture, numbers, claims, phrasing) ─► labelled blocks
```

Code (all lazy; nothing loads until the visitor presses Ask):

| Path | Holds |
|---|---|
| `src/ai/types.ts` | The contracts |
| `src/ai/boot.ts` | `startIntelligence(app, announce)`: registers the message files, builds the registry, the engine host and the retriever, and returns `createIntelligence(app, deps)`, once per page. The shell reaches it only by a dynamic import (`window.__kf.ai.start` until the Ask button exists) |
| `src/ai/index.ts` | `createIntelligence(app, deps)`: the orchestrator and the task state machine; `placeFrom`, the named-place resolver the router is given |
| `src/ai/context.ts` | Context adapter: the app's state → `AiContext` (and a ≤600-character summary for the model) |
| `src/ai/router.ts` | Deterministic intents: go to, show, set the date, faster, chapter n, verse s:a, escape speed of, qibla from, throw a rock at… |
| `src/ai/prompts.ts` | Plan and answer prompts, kept short (the context window is 4,096 tokens) |
| `src/ai/guards.ts` | Input and output guards (§5) |
| `src/ai/knowledge/` | Retrieval: a BM25 index over `public/assets/ai/index.json` |
| `scripts/build-ai-index.ts` | Builds that index from content.json, the message files, data/*.json, the atlas, star names and world facts; the validator checks it |
| `src/ai/tools/` | The registry, a JSON-schema-subset validator, and the tools (§4) |
| `src/ai/planner/` | Experiment templates → lab commands, the background comparison worker, the optimiser |
| `src/ai/engine/` | Capability detection, the pinned model catalogue, the model worker (`webllm-worker.ts`, the only importer of WebLLM), its message protocol (`protocol.ts`) and its client (`webllm.ts`), the browser-model adapter, the scripted test engine, storage, GPU pacing |
| `src/ai/ui/` | The panel the header's Ask button (or /) opens: `index.ts` (a column beside the scene on a wide window, a modal bottom sheet on a phone), `layout.ts` (where it may stand: clear of every piece of chrome on screen), `blocks.ts` (the answer blocks and confirmation cards), `model.ts` (the model on this device: detection, download, progress, errors, stored models), `settings.ts` (explanation level, opt-in memory, clearing), `ai.css` |
| `src/i18n/en.ai.engine.json`, `en.ai.tools.json`, `en.ai.mind.json`, `en.ai.json` | Every string: the engines', the tools', the orchestrator's and the panel's (lazy, added with `app.i18n.extend` by `boot.ts` and `src/ai/ui`, registered with the validator) |

**Loading, in order.**
1. First visit: nothing of the assistant. The shell holds only the Ask button, the / shortcut and a starter for the test hook (dynamic imports of `src/ai/ui` and `src/ai/boot.ts`), and `scripts/check-bundle.ts` keeps every file with `src/ai` code out of the shell.
2. Start (Ask pressed): the assistant's chunks with its panel (measured on their own by `scripts/check-bundle.ts`: about 94 KB gzip, budget 120 KB), and what it reads at once: data/quran.json and data/hadith.json for the scripture catalogue, and the plain words. In all about 113 KB as served (measured on the page by `tests/ai-panel.spec.ts`, which fails above 130 KB). The Arabic typeface (about 63 KB) is fetched only when the first verse is shown.
3. First question: the knowledge index, `assets/ai/index.json` (about 120 KB gzip, budget 150 KB).
4. A comparison or a search: the batch worker (about 31 KB gzip, budget 50 KB).
5. Only when a visitor chooses a model: the model worker with WebLLM's runtime (about 2.16 MB gzip, budget 2.4 MB), then the model's files from Hugging Face. The worker is the only built file that holds WebLLM's runtime; the bundle check fails otherwise.

## 3. Engines

**WebLLM 0.2.86** (Apache-2.0), pinned exactly; earlier versions lack interrupt and stream-cancel fixes.
- **Worker:** our own dedicated module worker (`src/ai/engine/webllm-worker.ts`) drives `MLCEngine` directly. It is the only module that imports WebLLM, so the runtime is downloaded once, with the worker, when a model is loaded. The page speaks to it in our own typed messages (`src/ai/engine/protocol.ts`):
  - `load` (the AppConfig and the model id), answered with `progress` messages, then `loaded`;
  - `generate`, then one `pull` for each next piece: the worker decodes a piece only when the page asks for it, and the page asks through the pacer (§6), so pacing is in our hands;
  - `interrupt`, `unload`, `hasModelInCache`, `deleteModelAllInfoInCache`.

  Failures are mapped to EngineError codes in the worker and sent as data.
- **Weights:** come from `huggingface.co/mlc-ai/<model>/resolve/<commit>/`, pinned to a commit. Hugging Face is a public file store here, not an inference service, and needs no account.
- **Model libraries:** pinned to a commit of `binary-mlc-llm-libs` through jsDelivr, with SRI hashes where available.
- **Cache:** the Cache API (`cacheBackend: 'cache'`). What is stored is read from the caches directly, at no download. Deletion goes through `deleteModelAllInfoInCache` in the worker, and only when the model's manifest is stored, because otherwise WebLLM would download the manifest to find the files. A sweep of the three caches then removes whatever is left.
- **Tool calls:** WebLLM's `tools` field is not used, because it is hard-wired to Hermes models and forbids a system prompt. Instead, plans use `response_format: { type: 'json_object', schema }` (XGrammar), with `enable_thinking: false` and temperature 0, and are validated again in JS. Constrained decoding has open bugs (#868, #807).

**Browser model.** Chrome's `LanguageModel` (Prompt API), detected with `availability()` using the same options as `create()`.
- It is offered only when the answer is `available`.
- `downloadable` is shown with a warning, because one click starts a multi-gigabyte download by the browser.
- It goes through `responseConstraint` and the same validator.
- Brave, Safari and Firefox do not have it.

**Scripted engine.** Replies are written in the test, so the whole pipeline is tested in CI, which has no GPU. It is reachable only through the test hook and is labelled "Test engine" on screen.

**Not adopted:**
- MediaPipe: maintenance-only, and its Gemma weights are gated behind a token.
- LiteRT-LM web: an early preview, Gemma 4 only.
- WebNN: an origin trial.
- wllama as a CPU fallback is deferred until measured. No published browser CPU speeds exist, and without cross-origin isolation, which GitHub Pages cannot set, it runs single-threaded. The guide covers devices without WebGPU.

## 4. Tools

Every tool has a name, a kind, a one-line summary, an argument schema, a state check, a preview sentence and a `run` that reads the app's state back.
- **read, calc and cite** tools run at once.
- **view** tools run at once and can be undone.
- **experiment** tools show a card ("Multiply the Sun's mass by 2: Confirm / Cancel") and run only after the visitor confirms. The card promises only the edit: applying it integrates nothing ahead (a comparison does that, in the background).
- **Stopping.** Stop before a tool starts (Confirm then Stop at once, say) and nothing is sent; the card says it was cancelled. Once a tool has started, what it did is kept even if the turn is stopped: its card says "sent, but not seen" until its own outcome arrives, then shows that outcome and its Undo, and the turn ends as stopped. An experiment checks for Stop before each command it sends.
- **Undo** of an experiment undoes that experiment's own edits, never simply the newest: it is refused, with the reason on its card, while a later edit sits on top in the laboratory (or once the laboratory no longer shows the experiment). "Put back as it was" is said only when the laboratory reads back as it was; otherwise the notice says the undo was sent but not seen.

The tools and their arguments (`src/ai/tools`; the registry's validator checks the schema, then where the tool can work, then its own checks against the app's state). An argument in brackets is optional. A `body` is one of the ten worlds (`sun`, `mercury`, `venus`, `earth`, `moon`, `mars`, `jupiter`, `saturn`, `uranus`, `neptune`). A `place` is the id of a place of the field notes (`everest`, `mecca`, `uyuni`…), and is given instead of `lat` and `lon` (degrees), never with them. A `date` is UTC, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`. A laboratory body (`lab body`) is a body's id or name in the laboratory.

**film** (view)

| Tool | Arguments | Where |
|---|---|---|
| `film.open` | `{ chapter: "ch00"…"ch10", [t]: seconds }` | anywhere |
| `film.control` | `{ action: "play" \| "pause" \| "next" \| "previous" \| "explore" \| "film" }` (explore: Explore Mode on; film: back to the film) | a chapter |
| `film.moment` | `{ point: a moment's id }` | a chapter |

**explorer** (view)

| Tool | Arguments | Where |
|---|---|---|
| `explorer.open` | `{ [body] }` | outside the explorer and the laboratory |
| `explorer.close` | `{}` | the explorer or the laboratory |
| `explorer.fly` | `{ body }` (opens the explorer if needed) | anywhere; in the laboratory, only a body still there |
| `explorer.place` | `{ place }` or `{ lat, lon }`, `[viewKm]` 1–20,000 | the explorer |
| `explorer.sky` | `{ layer: "constellations" \| "boundaries" \| "grid" \| "names", on: boolean }` | the explorer or the laboratory |
| `explorer.stars` | `{}` (out among the stars around the Sun) | the explorer |
| `explorer.find_star` | `{ name }` (a star's name or catalogue number) | the explorer |
| `explorer.walk` | `{ [world]: "earth" \| "moon" \| "mars" \| "mercury" \| "venus", [place] or [lat, lon] }` (no place: below the camera; never within Makkah's frame) | the explorer |
| `explorer.walk_end` | `{}` | while walking |

**time** (view)

| Tool | Arguments | Where |
|---|---|---|
| `time.control` | `{ action: "pause" \| "play" \| "faster" \| "slower" \| "reverse" \| "now" }` | the explorer or the laboratory (reverse and now: the explorer only) |
| `time.date` | `{ date }`, within the span the data covers (refused with the span named) | the explorer |
| `time.rate` | `{ rate }`: an integer on the clock's ladder (1, 10, 60, 600, 3600, 21600, 86400, 604800, 2592000), negative for backwards (not in the laboratory) | the explorer or the laboratory |

**islamic** (calc; anywhere)

| Tool | Arguments |
|---|---|
| `islamic.qibla` | `{ place }` or `{ lat, lon }` |
| `islamic.prayer_times` | `{ place }` or `{ lat, lon }`, `convention: "mwl" \| "isna" \| "egypt" \| "makkah" \| "karachi" \| "tehran" \| "qum" \| "france" \| "russia" \| "singapore"` (required: the visitor names it; a model's plan that fills in one the question does not name becomes the app's own question back, asking which), `[date]`, `[asrShadow]: 1 \| 2` |
| `islamic.crescent` | `{ place }` or `{ lat, lon }`, `[date]` |
| `islamic.hijri` | `{ [date] }` (else the date shown, or now) |

**lab**

| Tool | Kind | Arguments | Where |
|---|---|---|---|
| `lab.open` | view | `{ [seed]: "solar" \| "two" \| "three" }` | outside the laboratory |
| `lab.state` | read | `{}` | the laboratory |
| `lab.experiment` | experiment | `{ experiment, …its parameters }` (below), flat, `[horizonDays]` | the laboratory |
| `lab.undo` | view | `{}` | the laboratory |
| `lab.measure` | view | `{ from: lab body, to: lab body, [via]: lab body }` | the laboratory |
| `lab.compare` | read | as `lab.experiment`; integrated ahead in the background worker, nothing on screen changes (in the laboratory its scenario is read by a silent `copy` command: no share link, no status line) | anywhere (outside the laboratory, against the solar system seeded now) |
| `lab.optimise` | read | `{ goal: "escape", [body], [days] }` or `{ goal: "year", [body], targetDays }` | anywhere |

The experiments' parameters (every one required, with its range):

| `experiment` | Parameters |
|---|---|
| `scale-mass` | `body`, `factor` 0.01–100 |
| `remove-body` | `body` (not the Sun) |
| `kick-body` | `body`, `dvKmS` −50–50 (not 0), `direction: "prograde" \| "retrograde" \| "radial-out" \| "radial-in"` |
| `impact` | `target`, `diameterKm` 0.01–1,000, `speedKmS` 1–72 (above the target's escape speed), `angleDeg` 15–90 |
| `add-moon` | `host`, `distanceKm` 1–10¹⁰, `massKg` 10⁶–10²⁶ |
| `second-star` | `massSun` 0.1–10, `distanceAu` 0.5–1,000 |
| `change-orbit` | `body`, `aFactor` 0.2–5, `e` 0–0.95 |

`horizonDays` (1–36,525) is how far ahead a comparison integrates; each experiment has its own default.

**calc** (anywhere): each wraps existing deterministic code (`src/sim`, `src/astro`, `src/explore/about.ts`, `src/explore/islamic`).

| Tool | Arguments |
|---|---|
| `calc.escape_speed`, `calc.circular_speed` | `{ body, [altitudeKm] }` |
| `calc.orbital_period` | `{ body }` (a planet about the Sun), or `{ primary, aKm }` |
| `calc.light_time` | `{ from: body, to: body }`, or `{ distanceKm }`, or `{ distanceAu }` |
| `calc.hohmann` | `{ from: body, to: body }` (planets about the Sun), or `{ fromKm, toKm }`, `[primary]` |
| `calc.roche` | `{ primary, satellite }` or `{ primary, satelliteDensity }` |
| `calc.hill` | `{ body, [primary], [aKm], [e] }` |
| `calc.impact` | `{ target, diameterKm, speedKmS, [angleDeg], [densityKgM3] }` |
| `calc.world_facts` | `{ body }` |

**cite** (anywhere)

| Tool | Arguments |
|---|---|
| `cite.verse` | `{ key: "surah:ayah" }`, one of the verses data/quran.json holds and the data store shows |
| `cite.hadith` | `{ id }`, one of data/hadith.json's, never an excluded one; its reference, narrator and grading, never its wording |
| `cite.constant` | `{ id }` of data/constants.json |
| `cite.source` | `{ id }` of data/sources.json |

**search** (anywhere): `search.knowledge` `{ query, [kinds], [limit] 1–8 }`, over the verified content.

**The guide's router** (`src/ai/router.ts`) makes exactly these shapes, checked by `tests/unit/ai-router.spec.ts` through the real registry in a realistic context for each place the visitor can be. Named places come from the knowledge index (`placeFrom` in `src/ai/index.ts`): the field notes' own places by their id, then the most populous town of that name by its degrees. Prayer times are planned only when the visitor names a convention. "Throw a rock at the Earth" becomes an `impact` with illustrative numbers shown on the card (a size by the word used, a speed above the world's escape speed, 45 degrees).

For a small model, the registry offers only a shortlist: the core tools plus the best matches for the question and where the visitor is. The plan schema's `tool` field is an enum of that shortlist. Because constrained decoding has open bugs, the reply is checked again in JS: a call to a tool not offered is refused ("not offered", in the repair prompt), and the reply as a whole must fit the plan's schema. If the plan still cannot be used, the guide answers that turn from the app's content (the plan's `source` is `fallback`, as it is when no rule matched and there is no model).

## 5. Integrity

- **Scripture is never generated.** The model refers to verses and hadith by id. The interface renders them with `verseArticle`/`hadithArticle` from data, which withholds any verse whose checksum fails.
- **Output guards:**
  - Arabic script in model output is removed.
  - Words presented as scripture are removed whatever their length or wording (`scripture-quote`): text a lead-in introduces ("The Prophet said:", "Allah says in the Quran, '…'", "… says:" then a blockquote, "narrated:") goes with its sentence, up to the quotation's closing mark, the sentence's end or the paragraph's; so does any quotation (“…”, «…», „…“, "…", ‘…’, '…', or lines starting with ">") such words come just before. Quoted or unquoted text that resembles a translation is removed too. Where the verse can be told, its marker takes the place of what was removed.
  - While an answer streams, nothing is shown from a quotation mark not yet closed, a presenting sentence not yet ended, a blockquote being written, or an unfinished sentence that already reads like a verse.
  - A citation id not in the data is dropped, and a sentence naming a verse key the data does not hold, or a narration data/hadith.json excludes (by collection and number, key or sunnah.com address, read from the file), is removed (`unknown-citation`).
  - Banned phrasing ("predicted", "foretold", "proves", "scientific miracle", "proof that", "confirms the Quran", in all their forms: "predicts", "foretells", "proven", "a miracle of science", the Qur'an with any apostrophe) is rewritten or removed; "prediction" and "proof of" go where a sentence speaks of scripture (`banned-phrase`).
  - A number with two or more significant digits, or with a unit, that is not among the turn's facts or passages is marked "not checked" (`unchecked-number`).
  - A claim to have done something that no tool outcome reports is removed (`action-claim`).
- **Labels:** every block is labelled with its kind: observed, model, simulation, scripture, or explanation. Model prose is always labelled "Explanation by <model> on this device", naming the engine that wrote that block (a model loaded while a card waits writes, and is named on, the answer after Confirm); the scripted engine's reads "Test engine".
- **The laboratory says "integrated ahead", never "predicted".** A simulation never speaks for what Allah would decree.
- **Prompt injection:** text that comes from data or tool results goes to the model as quoted data, never as instructions. The chat template's control tokens ("<|im_start|>", "<|im_end|>") are defused in data and in the visitor's question, so a laboratory body named after one (from a shared link) cannot end a turn or open another. The model cannot run code; it can only name tools it was offered, with validated arguments.

## 6. GPU sharing

The three.js renderer and WebLLM each have their own `GPUDevice` on one GPU.

**Render budget.** `app.requestRenderBudget(reason, { maxScale })` caps the render scale and holds the film's and the explorer's quality governors for the whole time the assistant holds it, so inference load is not read as scene load and tiers are not locked for the visit. It is held for each generation, and while a model loads from its weights' upload (a device sync for every tensor) and its shaders' compilation to the end of the load.

**Prefill:**
- Prompts are kept short.
- The budget is taken before prefill, with the scale at ≤0.75 and post-processing reduced.

**Decode pacing:**
- While the visitor drags or flies, at most one chunk per animation frame, plus one waited frame after any frame over 22 ms.
- At full speed when the scene is idle.

**Hidden tab:** no pulls, no loads.

**Unload:**
- After 10 idle minutes.
- On iOS, whenever the panel closes.

**Crash markers.** A marker in localStorage is written before each risky stage (device, upload, first prefill) and cleared after it. If one is left behind, the next visit steps down one tier and says why.

**Device lost.** The renderer recovers first; the model is retried once, smaller.

## 7. Capability detection

Nothing here downloads anything.
1. **Secure context and `navigator.gpu`.**
2. **Adapter, in a worker.** Read its features (shader-f16) and limits: `maxStorageBuffersPerShaderStage` ≥ 10, `maxComputeWorkgroupStorageSize` ≥ 32 KB and `maxComputeInvocationsPerWorkgroup` ≥ 256 for WebLLM. A fallback adapter means no model. Empty `adapter.info`, as under Brave Shields, means unknown, not a failure.
3. **Platform budget** (GPU memory the assistant may use, minus what the scene holds):
   - iOS: none.
   - Android: 4 GB or less → none; 6 GB → 0.8 GB; 8 GB+ → 1.4 GB.
   - Desktop Chromium, from `deviceMemory`: 4 GB → 1.4 GB; 8 GB → 2.6 GB; 16 GB+ → 4.2 GB, raised to 6.5 GB when the adapter is discrete or reports a large `maxBufferSize`.
   - Safari and Firefox on macOS, where no `deviceMemory` is given: 2.6 GB by default; the visitor can choose larger, with a warning.
4. **The model:** the largest that fits the budget and the limits, using q4f32 where shader-f16 is missing.
5. **Storage and network**, checked when the visitor presses Download: `persist()`; QuotaExceededError is caught while streaming; a second confirmation is asked on a metered connection or with saveData; cancel and resume are offered.

## 8. Phases (revised for on-device inference)

| Phase | Delivers |
|---|---|
| A. Foundations | Engine host (detection, catalogue, WebLLM worker, browser model, scripted engine), download and storage manager, GPU sharing, the guide (router + retrieval), panel UI, context adapter, read/view/cite/calc tools, guards |
| B. Agent | Model plans under a schema with a shortlist, validation and repair, verification by readback, grounded answers with citations, contextual suggestions |
| C. Experiments | Deterministic experiment planner, confirmation and undo, the background comparison worker, an optimiser (bisection over a launch speed, a mass…), the experiment notebook |
| D. Tutor and tours | Levels (plain / standard / deeper), tours built from Explore points and the atlas, told from retrieved passages |
| E. Memory and evaluation | Opt-in memory (IndexedDB, off by default, clearable; with it on, the kept turns come back as earlier turns when the assistant starts, and a model reads the last few as the conversation so far), the real-model evaluation harness and report, the adversarial suite, measured GPU impact |

## 9. Testing

- **Unit (CI):** schema validator, router, guards, retrieval, planners, optimiser, calculators against known values, capability tiers from canned adapters.
- **Browser (CI):** the whole pipeline through the scripted engine. This covers asking, routing, tools, confirmation, undo, verification, answer blocks and labels. Also the download dialog against mocked model hosts, storage controls, layout at 390×844 and desktop, and repeated open/close and cancel.
- **Real models (local, not CI): `tests/ai-eval/`.** Runs Chromium with the real GPU on this Mac and downloads the models once into a persistent profile. Each model is scored on:
  - plan validity, tool choice and argument accuracy over a fixed case set;
  - grounded answers, checked for their key facts;
  - integrity cases, where scripture, numbers and claims must survive the guards with zero violations;
  - prefill and decode speed, time to first token, and load time;
  - frame times of the explorer while it generates.

  The results go in `docs/AI-EVALUATION.md` with the date and hardware.

## 10. Known limits (stated in the interface)

- Small models lose track of long, many-step tasks. Experiments therefore go through deterministic planners, and the model only picks the experiment and its numbers.
- The context window is 4,096 tokens, so a conversation keeps only its last few turns.
- The first download is large (0.35–4.6 GB) and comes from Hugging Face, which sees the visitor's IP address. Safari may delete stored models after seven days without a visit.
- No model on iPhone. No model where WebGPU is missing (Firefox outside Windows, older browsers): the guide is offered there instead.
- Phones are slow: about 5 tokens/s for a 3B model on a Pixel 8 Pro.

## 11. Research summary (2026-10-26)

- **WebLLM 0.2.86** (npm, 2026-10-11):
  - The runtime is about 2.27 MB gzip, plus about 0.8 MB brotli for each model library.
  - It runs in a dedicated worker or a service worker, with streaming, interrupt and abortable loads.
  - The cache backend can be `cache`, `indexeddb` or `opfs`.
  - XGrammar provides `json_object` with a schema, EBNF and `structural_tag`.
  - Its catalogue includes Qwen3 0.6B/1.7B/4B/8B (with a thinking switch), Qwen3.5 0.8B–9B, Gemma 4 E2B, Llama 3.2, Phi-4-mini and Ministral 3.
  - The context is capped at 4,096 tokens.
- **Measured speeds:**
  - Llama-3.1-8B: about 41 tok/s on M3 Max and 54.5 tok/s on M4 Max.
  - Llama-3.2-3B on an AMD 680M iGPU: 112 tok/s prefill, 18 tok/s decode.
  - Llama-3.2-3B on a Pixel 8 Pro: about 5 tok/s.
- **Known failures:**
  - On iOS, tabs are killed at about 3B.
  - Adreno GPUs report device lost at startup.
  - Qwen3.5-2B reports device lost on some iGPUs.
- **Transformers.js 4.3** is best used for embeddings (on WASM, off the GPU). For LLMs it has no grammar-constrained decoding.
- **Other runtimes:**
  - wllama 3.8 (llama.cpp WASM) has grammars and tools, but runs single-threaded without COOP/COEP.
  - MediaPipe's Gemma weights are gated.
- **Chrome's Prompt API** ships on desktop from Chrome 148. It has `responseConstraint` but no tool use, and English among its few languages. Edge's is behind a flag; Brave, Safari and Firefox have none.
- **WebGPU on phones:** Chrome Android works, Safari 26 has it, Firefox 141+ has it on Windows.
- **Memory signals:**
  - `deviceMemory` is Chromium-only and bucketed.
  - Brave Shields blank `adapter.info`.
  - `storage.estimate()` is unreliable in Chrome 133+ and in Brave.

Full notes with every source URL are kept with the working files of 2026-10-26. The model choices above are to be re-checked against our own measurements (§9) before they become defaults.
