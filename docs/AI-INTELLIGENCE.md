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
| `src/ai/index.ts` | `createIntelligence(app)`: the orchestrator and the task state machine |
| `src/ai/context.ts` | Context adapter: the app's state → `AiContext` (and a ≤600-character summary for the model) |
| `src/ai/router.ts` | Deterministic intents: go to, show, set the date, faster, chapter n, verse s:a, escape speed of, qibla from, throw a rock at… |
| `src/ai/prompts.ts` | Plan and answer prompts, kept short (the context window is 4,096 tokens) |
| `src/ai/guards.ts` | Input and output guards (§5) |
| `src/ai/knowledge/` | Retrieval: a BM25 index over `public/assets/ai/index.json` |
| `scripts/build-ai-index.ts` | Builds that index from content.json, the message files, data/*.json, the atlas, star names and world facts; the validator checks it |
| `src/ai/tools/` | The registry, a JSON-schema-subset validator, and the tools (§4) |
| `src/ai/planner/` | Experiment templates → lab commands, the background comparison worker, the optimiser |
| `src/ai/engine/` | Capability detection, the pinned model catalogue, the WebLLM worker client, the browser-model adapter, the scripted test engine, storage, GPU pacing |
| `src/ai/ui/` | Ask button, panel, download dialog, storage manager, answer blocks, confirmation cards |
| `src/i18n/en.ai.json` | Every string (lazy, registered with the validator) |

## 3. Engines

**WebLLM 0.2.86** (Apache-2.0), pinned exactly; earlier versions lack interrupt and stream-cancel fixes.
- **Worker:** runs in a dedicated module worker (`CreateWebWorkerMLCEngine`). The page pulls each streamed chunk, so pacing is in our hands.
- **Weights:** come from `huggingface.co/mlc-ai/<model>/resolve/<commit>/`, pinned to a commit. Hugging Face is a public file store here, not an inference service, and needs no account.
- **Model libraries:** pinned to a commit of `binary-mlc-llm-libs` through jsDelivr, with SRI hashes where available.
- **Cache:** the Cache API (`cacheBackend: 'cache'`). Deletion goes through `deleteModelAllInfoInCache`.
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
- **experiment** tools show a card ("Double the Sun's mass, then integrate 10 years: Confirm / Cancel") and run only after the visitor confirms.

The groups:
- **film:** open a chapter, play/pause/next/previous, show a moment in Explore Mode.
- **explorer:** open/close, fly to a body, go to a place, sky layers, walk and end the walk, the stars view, find a star.
- **time:** pause/play, faster, slower, now, set a date, set a rate.
- **islamic:** qibla, prayer times by a named convention, the new crescent, the Hijri date.
- **lab:** open, apply an experiment (confirmed), undo, measure, state, compare in the background, optimise.
- **calc:** escape and circular speed, orbital period, light time, Hohmann transfer, Roche limit, Hill radius, impact outcome and crater, world facts. Each wraps existing deterministic code (`src/sim`, `src/astro`, `src/explore/about.ts`, `src/explore/islamic`).
- **cite:** verse by key, hadith by id (reference, grading and summary, never wording), constant, source.
- **search:** the verified content.

For a small model, the registry offers only a shortlist: the core tools plus the best matches for the question and where the visitor is. The plan schema's `tool` field is an enum of that shortlist.

## 5. Integrity

- **Scripture is never generated.** The model refers to verses and hadith by id. The interface renders them with `verseArticle`/`hadithArticle` from data, which withholds any verse whose checksum fails.
- **Output guards:**
  - Arabic script in model output is removed.
  - Quoted text that resembles a translation is removed (`scripture-quote`).
  - A citation id not in the data is dropped (`unknown-citation`).
  - Banned phrasing ("predicted", "foretold", "proves", "scientific miracle", "proof that", "confirms the Quran") is rewritten or flagged.
  - A number with two or more significant digits, or with a unit, that is not among the turn's facts or passages is marked "not checked" (`unchecked-number`).
  - A claim to have done something that no tool outcome reports is removed (`action-claim`).
- **Labels:** every block is labelled with its kind: observed, model, simulation, scripture, or explanation. Model prose is always labelled "Explanation by <model> on this device".
- **The laboratory says "integrated ahead", never "predicted".** A simulation never speaks for what Allah would decree.
- **Prompt injection:** text that comes from data or tool results goes to the model as quoted data, never as instructions. The model cannot run code; it can only name tools from the registry, with validated arguments.

## 6. GPU sharing

The three.js renderer and WebLLM each have their own `GPUDevice` on one GPU.

**Render budget.** `app.requestRenderBudget(reason, { maxScale })` caps the render scale and holds the film's and the explorer's quality governors for the whole time the assistant holds it, so inference load is not read as scene load and tiers are not locked for the visit.

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
| E. Memory and evaluation | Opt-in memory (IndexedDB, off by default, clearable), the real-model evaluation harness and report, the adversarial suite, measured GPU impact |

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
