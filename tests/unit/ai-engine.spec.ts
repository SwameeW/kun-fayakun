/**
 * The assistant's engines (src/ai/engine) without a browser: the tier each kind of device is
 * offered (canned adapters and navigators, docs/AI-INTELLIGENCE.md §7), the pinned catalogue
 * against WebLLM 0.2.86's own records, the request a generation becomes, how failures read, and
 * the render budget held while a model's weights upload and its shaders compile.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { AdapterProbe } from '../../src/ai/engine/adapter';
import { buildAppConfig, EVAL_CANDIDATES, MODEL_TIERS, modelFor, VISITOR_MODELS } from '../../src/ai/engine/catalogue';
import { adapterSignals, BUDGET_MB, browserOf, chooseTier, limitsOk, platformOf, type NavigatorLike, type TierSignals } from '../../src/ai/engine/detect';
import { engineError, EngineFailure, isEngineError, toEngineError } from '../../src/ai/engine/errors';
import type { Pacer } from '../../src/ai/engine/pacing';
import { grammarSchema, loadWebLLM, thinkFilter, toCompletionRequest, toLoadProgress, type ModelWorker } from '../../src/ai/engine/webllm';
import { planSchema } from '../../src/ai/prompts';
import { allTools } from '../../src/ai/tools/index';
import type { GenerateRequest, JsonSchema } from '../../src/ai/types';

const ROOT = new URL('../../', import.meta.url);
const MESSAGES = JSON.parse(readFileSync(new URL('src/i18n/en.ai.engine.json', ROOT), 'utf8')) as Record<string, string>;
const SOURCES = (JSON.parse(readFileSync(new URL('data/sources.json', ROOT), 'utf8')) as { sources: { id: string }[] }).sources.map((s) => s.id);

/* ------------------------------------------------------------------ */
/* Canned devices                                                       */
/* ------------------------------------------------------------------ */

const GIB = 2 ** 30;
/** What Chrome reports for a capable desktop or phone adapter (WebLLM's minimums are met). */
const LIMITS: AdapterProbe['limits'] = {
  maxBufferSize: 2 * GIB,
  maxStorageBufferBindingSize: 2 * GIB - 4,
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 32_768,
  maxComputeInvocationsPerWorkgroup: 1024,
};

const adapter = (info: Partial<AdapterProbe['info']>, patch: Partial<AdapterProbe> = {}): AdapterProbe => ({
  features: ['shader-f16', 'timestamp-query'],
  limits: LIMITS,
  info: { vendor: '', architecture: '', device: '', description: '', ...info },
  fallback: false,
  ...patch,
});

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  pixel: 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
} as const;

const APPLE = { vendor: 'apple', architecture: 'metal-3', description: '' };

function device(nav: NavigatorLike, probe: AdapterProbe | null, extra: Partial<TierSignals> = {}): TierSignals {
  return {
    secure: true,
    ...adapterSignals(probe),
    platform: platformOf(nav),
    browser: browserOf(nav),
    deviceMemoryGB: nav.deviceMemory ?? null,
    crashedBefore: null,
    ...extra,
  };
}

const reason = (name: string): string => `ai.engine.reason.${name}`;

test('an iPhone gets the guide only, with the reason', () => {
  const s = device({ userAgent: UA.iphone, maxTouchPoints: 5 }, adapter(APPLE));
  expect(s.platform).toBe('ios');
  const choice = chooseTier(s);
  expect(choice.recommended).toBe('none');
  expect(choice.reasons).toContain(reason('ios'));
  // An iPad asking for the desktop page is still iOS.
  expect(platformOf({ userAgent: UA.ipadDesktop, maxTouchPoints: 5 })).toBe('ios');
  expect(platformOf({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toBe('desktop');
});

test('a Pixel 8 with 8 GB is offered the pocket model', () => {
  const s = device({ userAgent: UA.pixel, deviceMemory: 8 }, adapter({ vendor: 'arm', architecture: 'valhall', description: 'Mali-G715' }));
  expect(s.platform).toBe('android');
  expect(s.browser).toBe('chromium');
  const choice = chooseTier(s);
  expect(choice.budgetMB).toBe(BUDGET_MB.android8);
  expect(choice.recommended).toBe('pocket');
  // Without shader-f16 the pocket model's q4f32 build (1.9 GB) does not fit a phone's 1.4 GB.
  const noF16 = chooseTier({ ...s, f16: false });
  expect(noF16.recommended).toBe('none');
  expect(noF16.reasons).toEqual([reason('no-f16'), reason('too-small')]);
});

test('an Android phone with 4 GB gets the guide only', () => {
  const choice = chooseTier(device({ userAgent: UA.android, deviceMemory: 4 }, adapter({ vendor: 'qualcomm', architecture: 'adreno-6xx' })));
  expect(choice).toEqual({ recommended: 'none', budgetMB: 0, reasons: [reason('android-small')] });
  expect(chooseTier(device({ userAgent: UA.android }, adapter({ vendor: 'qualcomm' }))).reasons).toContain(reason('android-unknown'));
});

test('an M1 with 8 GB in Chrome is offered the compact model', () => {
  const choice = chooseTier(device({ userAgent: UA.macChrome, deviceMemory: 8 }, adapter(APPLE)));
  expect(choice.budgetMB).toBe(BUDGET_MB.desktop8);
  expect(choice.recommended).toBe('compact');
  expect(choice.reasons).toEqual([]);
});

test('Windows with 16 GB and a discrete GPU is offered the large model', () => {
  const s = device({ userAgent: UA.winChrome, deviceMemory: 16 }, adapter({ vendor: 'nvidia', architecture: 'ada-lovelace', description: 'NVIDIA GeForce RTX 4070' }));
  expect(s.discrete).toBe(true);
  const choice = chooseTier(s);
  expect(choice.budgetMB).toBe(BUDGET_MB.desktop16Large);
  expect(choice.recommended).toBe('large');
  expect(choice.reasons).toContain(reason('discrete'));
  // The same machine with an integrated GPU gets the standard model; one reporting a 4 GiB buffer gets the large.
  const integrated = { ...s, discrete: false };
  expect(chooseTier(integrated).recommended).toBe('standard');
  // Chrome reports at most 4 GiB less 4 bytes.
  const largeBuffer = chooseTier({ ...integrated, limits: { ...LIMITS, maxBufferSize: 4 * GIB - 4 } });
  expect(largeBuffer.recommended).toBe('large');
  expect(largeBuffer.reasons).toEqual([reason('large-buffer')]);
});

test('Brave on macOS with a blank adapter.info: unknown, never a failure', () => {
  const s = device({ userAgent: UA.macChrome, deviceMemory: 8, brave: {} }, adapter({}));
  expect(s.browser).toBe('brave');
  expect(s.adapterHidden).toBe(true);
  expect(s.fallbackAdapter).toBe(false);
  expect(s.webgpu).toBe(true);
  const choice = chooseTier(s);
  expect(choice.recommended).toBe('compact');
  expect(choice.reasons).toEqual([reason('adapter-hidden')]);
});

test('Firefox gets the guide only, with the reason', () => {
  const s = device({ userAgent: UA.firefox }, adapter({ vendor: 'nvidia', description: 'NVIDIA GeForce RTX 3060' }));
  expect(s.browser).toBe('firefox');
  expect(chooseTier(s)).toEqual({ recommended: 'none', budgetMB: 0, reasons: [reason('firefox')] });
});

test('a software adapter gets the guide only', () => {
  const swiftshader = adapter({ vendor: 'google', architecture: 'swiftshader', description: 'SwiftShader Device (Subzero)' });
  expect(chooseTier(device({ userAgent: UA.linuxChrome, deviceMemory: 8 }, swiftshader)).reasons).toEqual([reason('fallback-adapter')]);
  // The browser's own flag counts even when the name says nothing.
  const flagged = adapter({}, { fallback: true });
  expect(chooseTier(device({ userAgent: UA.linuxChrome, deviceMemory: 8 }, flagged)).recommended).toBe('none');
});

test('a crash marker from an earlier page steps the recommendation down one tier, with the reason', () => {
  const m1 = device({ userAgent: UA.macChrome, deviceMemory: 8 }, adapter(APPLE));
  const crashed = chooseTier({ ...m1, crashedBefore: { stage: 'upload', model: 'Qwen3-1.7B-q4f16_1-MLC' } });
  expect(crashed.recommended).toBe('pocket');
  expect(crashed.reasons).toEqual([reason('crashed')]);
  const pixel = device({ userAgent: UA.pixel, deviceMemory: 8 }, adapter({ vendor: 'arm' }));
  expect(chooseTier({ ...pixel, crashedBefore: { stage: 'prefill', model: 'Qwen3-0.6B-q4f16_1-MLC' } }).recommended).toBe('none');
});

test('no WebGPU, an insecure page, small limits and little memory each say why', () => {
  const mac = { userAgent: UA.macChrome, deviceMemory: 8 };
  expect(chooseTier(device(mac, null)).reasons).toEqual([reason('no-webgpu')]);
  expect(chooseTier(device(mac, adapter(APPLE), { secure: false })).reasons).toEqual([reason('insecure')]);
  const small = adapter(APPLE, { limits: { ...LIMITS, maxStorageBuffersPerShaderStage: 8 } });
  expect(limitsOk(adapterSignals(small).limits)).toBe(false);
  expect(chooseTier(device(mac, small)).reasons).toEqual([reason('limits')]);
  expect(chooseTier(device({ userAgent: UA.macChrome, deviceMemory: 2 }, adapter(APPLE))).reasons).toEqual([reason('memory-small')]);
  expect(chooseTier(device({ userAgent: UA.macChrome, deviceMemory: 4 }, adapter(APPLE))).recommended).toBe('pocket');
});

test('Safari on macOS, which gives no deviceMemory, assumes a middle budget', () => {
  const s = device({ userAgent: UA.macSafari, maxTouchPoints: 0 }, adapter(APPLE));
  expect(s.browser).toBe('safari');
  const choice = chooseTier(s);
  expect(choice.budgetMB).toBe(BUDGET_MB.unknownMemory);
  expect(choice.recommended).toBe('compact');
  expect(choice.reasons).toEqual([reason('memory-unknown')]);
});

test('without shader-f16 the q4f32 builds are measured against the budget', () => {
  const s = device({ userAgent: UA.winChrome, deviceMemory: 16 }, adapter({ vendor: 'intel', description: 'Intel(R) UHD Graphics 630' }, { features: [] }));
  const choice = chooseTier(s);
  // 4.2 GB: Qwen3 4B's q4f16 (3.4 GB) would fit, its q4f32 (4.3 GB) does not.
  expect(choice.recommended).toBe('compact');
  expect(choice.reasons).toEqual([reason('no-f16')]);
});

test('every reason a decision can give is a message', () => {
  const keys = Object.keys(MESSAGES).filter((k) => k.startsWith('ai.engine.reason.'));
  for (const name of ['insecure', 'ios', 'firefox', 'no-webgpu', 'fallback-adapter', 'limits', 'adapter-hidden', 'no-f16', 'android-unknown', 'android-small', 'memory-unknown', 'memory-small', 'discrete', 'large-buffer', 'too-small', 'crashed']) {
    expect(keys).toContain(reason(name));
  }
});

/* ------------------------------------------------------------------ */
/* Catalogue                                                            */
/* ------------------------------------------------------------------ */

test('every model is pinned: 40-hex commits, an SRI hash, sizes above zero, a licence and a source', () => {
  for (const m of [...VISITOR_MODELS, ...EVAL_CANDIDATES]) {
    expect(m.weightsUrl).toMatch(new RegExp(`^https://huggingface\\.co/mlc-ai/${m.id.replace(/\./gu, '\\.')}/resolve/[0-9a-f]{40}/$`, 'u'));
    expect(m.libUrl).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/mlc-ai\/binary-mlc-llm-libs@[0-9a-f]{40}\/web-llm-models\/v0_2_86\/base\/[\w.-]+_cs1k-webgpu\.wasm$/u);
    expect(m.libIntegrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/u);
    expect(m.downloadBytes).toBeGreaterThan(300_000_000);
    expect(m.vramMB).toBeGreaterThan(1000);
    expect(m.contextTokens).toBe(4096);
    expect(m.needsF16).toBe(m.quant === 'q4f16_1');
    expect(m.licence.name).toBe('Apache-2.0');
    expect(m.licence.url).toMatch(/^https:\/\/huggingface\.co\/Qwen\/Qwen3(?:\.5)?-[\d.]+B\/blob\/[0-9a-f]{40}\/LICENSE$/u);
    expect(SOURCES).toContain(m.sourceId);
    expect(m.limitKeys.length).toBeGreaterThan(0);
    for (const key of m.limitKeys) expect(Object.keys(MESSAGES)).toContain(key);
  }
});

test('the visitor tiers are Qwen3 0.6B to 8B, ordered by GPU memory, each q4f16 build with a q4f32 fallback', () => {
  expect(VISITOR_MODELS.map((m) => m.id)).toEqual([
    'Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC',
    'Qwen3-1.7B-q4f16_1-MLC', 'Qwen3-1.7B-q4f32_1-MLC',
    'Qwen3-4B-q4f16_1-MLC', 'Qwen3-4B-q4f32_1-MLC',
    'Qwen3-8B-q4f16_1-MLC', 'Qwen3-8B-q4f32_1-MLC',
  ]);
  for (const f16 of [true, false]) {
    const vram = MODEL_TIERS.map((t) => modelFor(t, f16)?.vramMB ?? NaN);
    expect(vram.every((v, i) => i === 0 || v > (vram[i - 1] ?? Infinity))).toBe(true);
  }
  for (const m of VISITOR_MODELS.filter((x) => x.needsF16)) {
    const fallback = VISITOR_MODELS.find((x) => !x.needsF16 && x.tier === m.tier && x.name === m.name);
    expect(fallback, `${m.id} has a q4f32 fallback`).toBeDefined();
    expect(fallback?.vramMB ?? 0).toBeGreaterThan(m.vramMB);
  }
  // The pocket model only picks tools and writes weak explanations: it says so.
  expect(modelFor('pocket', true)?.limitKeys).toEqual(expect.arrayContaining(['ai.engine.limit.pocket.tools', 'ai.engine.limit.pocket.explain']));
  expect(EVAL_CANDIDATES.map((m) => m.id)).toEqual(['Qwen3.5-4B-q4f16_1-MLC', 'Qwen3.5-4B-q4f32_1-MLC', 'Qwen3.5-9B-q4f16_1-MLC', 'Qwen3.5-9B-q4f32_1-MLC']);
  expect(EVAL_CANDIDATES.some((m) => VISITOR_MODELS.includes(m))).toBe(false);
});

test('the catalogue matches WebLLM 0.2.86 prebuilt records (GPU memory, context, library) and its AppConfig is complete', async () => {
  const webllm = await import('@mlc-ai/web-llm');
  expect(webllm.modelVersion).toBe('v0_2_86/base');
  const config = buildAppConfig([...VISITOR_MODELS, ...EVAL_CANDIDATES]);
  expect(config.cacheBackend).toBe('cache');
  for (const record of config.model_list) {
    const prebuilt = webllm.prebuiltAppConfig.model_list.find((r) => r.model_id === record.model_id);
    expect(prebuilt, record.model_id).toBeDefined();
    if (!prebuilt) continue;
    const spec = [...VISITOR_MODELS, ...EVAL_CANDIDATES].find((m) => m.id === record.model_id);
    expect(record.model).toBe(spec?.weightsUrl);
    expect(record.model_lib).toBe(spec?.libUrl);
    expect(record.vram_required_MB).toBe(prebuilt.vram_required_MB);
    expect(record.low_resource_required).toBe(prebuilt.low_resource_required);
    expect(record.overrides).toEqual(prebuilt.overrides);
    // The same library file as WebLLM's own, pinned to a commit instead of main.
    expect(record.model_lib.split('/').at(-1)).toBe(prebuilt.model_lib.split('/').at(-1));
    expect(record.integrity).toEqual({ model_lib: spec?.libIntegrity, onFailure: 'error' });
    expect(record.required_features).toEqual(record.model_id.includes('q4f16') ? ['shader-f16'] : undefined);
    expect(prebuilt.overrides?.context_window_size ?? 4096).toBeGreaterThanOrEqual(spec?.contextTokens ?? Infinity);
  }
});

/* ------------------------------------------------------------------ */
/* Requests and progress                                                */
/* ------------------------------------------------------------------ */

const PLAN: JsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['answer', 'act'] },
    calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string', enum: ['explorer.fly'] } }, required: ['tool'], additionalProperties: false }, maxItems: 3 },
  },
  required: ['intent', 'calls'],
  additionalProperties: false,
};

test('a JSON plan becomes response_format json_object with the schema as a string; thinking is always off', () => {
  const request: GenerateRequest = {
    messages: [
      { role: 'system', content: 'Plan with the tools.' },
      { role: 'user', content: 'Fly to Mars' },
    ],
    format: { kind: 'json', schema: PLAN },
    maxTokens: 200,
  };
  const r = toCompletionRequest(request);
  expect(r.stream).toBe(true);
  expect(r.stream_options).toEqual({ include_usage: true });
  expect(r.temperature).toBe(0);
  expect(r.max_tokens).toBe(200);
  expect(r.response_format?.type).toBe('json_object');
  expect(JSON.parse(r.response_format?.schema ?? 'null')).toEqual(PLAN);
  expect(r.extra_body).toEqual({ enable_thinking: false });
  expect(r.messages).toEqual(request.messages);

  const prose = toCompletionRequest({ messages: [{ role: 'user', content: 'Why is Mars red?' }], format: { kind: 'text' }, maxTokens: 300, temperature: 0.3 });
  expect(prose.response_format).toBeUndefined();
  expect(prose.temperature).toBe(0.3);
  expect(prose.extra_body).toEqual({ enable_thinking: false });
});

test('XGrammar is given the plan without string lengths (each cost about 10 s to start); the lengths stay in the schema JS checks', () => {
  const tools = allTools().filter((t) => ['search.knowledge', 'explorer.find_star', 'time.date', 'film.moment'].includes(t.name));
  const full = planSchema(tools);
  expect(JSON.stringify(full)).toContain('"maxLength"');
  const sent = JSON.parse(toCompletionRequest({ messages: [{ role: 'user', content: 'Find Sirius' }], format: { kind: 'json', schema: full }, maxTokens: 300 }).response_format?.schema ?? 'null') as unknown;
  expect(JSON.stringify(sent)).not.toMatch(/"(?:maxLength|minLength)"/u);
  // Patterns XGrammar reads otherwise than JavaScript: Unicode property classes (a star's name), long bounded repeats (a moment's id).
  expect(JSON.stringify(sent)).not.toContain('\\\\p{');
  expect(JSON.stringify(sent)).not.toContain('{1,48}');
  // A pattern JSON Schema searches for ("\\S": not blank) would be a whole match in the grammar: one character.
  expect(JSON.stringify(sent)).not.toContain('"pattern":"\\\\S"');
  // An anchored pattern both read alike is kept (a date).
  expect(JSON.stringify(sent)).toContain('"pattern":"^\\\\d{4}-');
  // Everything else is kept: the enums, patterns, required fields and the shortlist's tool names.
  expect(sent).toEqual(grammarSchema(full));
  expect(JSON.stringify(sent)).toContain('"pattern"');
  for (const t of tools) expect(JSON.stringify(sent)).toContain(`"const":"${t.name}"`);
  // The schema the orchestrator validates against is not changed.
  expect(JSON.stringify(full)).toContain('"maxLength"');
});

test('the empty thinking block WebLLM streams back is taken off the reply, however it is split', () => {
  const run = (pieces: readonly string[]): string => {
    const f = thinkFilter();
    return pieces.map((p) => f.push(p)).join('') + f.end();
  };
  // As WebLLM 0.2.86 sent it with Qwen3 and thinking off, in one piece and token by token.
  expect(run(['<think>\n\n</think>\n\n', 'The escape speed of Mars is 5.03 km/s.'])).toBe('The escape speed of Mars is 5.03 km/s.');
  expect(run(['<', 'think', '>', '\n\n', '</', 'think', '>', '\n\n', 'The', ' escape speed'])).toBe('The escape speed');
  expect(run(['<think>\n\n</think>\n\n{"intent": "answer", "calls": []}'])).toBe('{"intent": "answer", "calls": []}');
  // A block with reasoning in it goes too; one never closed is all reasoning.
  expect(run(['<think>Let me see.</think>', ' Mars.'])).toBe('Mars.');
  expect(run(['<think>Let me see, the escape'])).toBe('');
  // Anything else is the reply from the first character, a lone "<" included.
  expect(run(['The <think> tag', ' is not at the start.'])).toBe('The <think> tag is not at the start.');
  expect(run(['<', 'b>bold'])).toBe('<b>bold');
  expect(run(['<thi'])).toBe('<thi');
  expect(run(['{"intent": "act"}'])).toBe('{"intent": "act"}');
});

test('a generation’s text and its streamed pieces never carry the thinking block', async () => {
  const model = VISITOR_MODELS[0];
  if (!model) throw new Error('no model');
  const pacer: Pacer = { gate: () => Promise.resolve(), visible: () => Promise.resolve(), hold: () => () => undefined, dispose: () => undefined };
  const deltas = ['<think>', '\n\n', '</think>', '\n\n', 'Mars ', 'is red.'];
  let next = 0;
  const worker: ModelWorker = {
    call(request) {
      if (request.type === 'load') return Promise.resolve({ type: 'loaded', id: 1 });
      if (request.type === 'generate') return Promise.resolve({ type: 'started', id: 7 });
      if (request.type === 'pull') {
        const delta = deltas[next];
        next += 1;
        if (delta === undefined) return Promise.resolve({ type: 'piece', id: 0, piece: null, done: true });
        return Promise.resolve({ type: 'piece', id: 0, piece: { delta, finish: next === deltas.length ? 'stop' : null, usage: null }, done: false });
      }
      return Promise.resolve({ type: 'result', id: 0, value: true });
    },
    interrupt: () => undefined,
    terminate: () => undefined,
  };
  const engine = await loadWebLLM(model, () => undefined, new AbortController().signal, pacer, () => worker);
  const streamed: string[] = [];
  const out = await engine.generate({ messages: [{ role: 'user', content: 'Why is Mars red?' }], format: { kind: 'text' }, maxTokens: 64, onText: (d) => streamed.push(d) });
  expect(out.text).toBe('Mars is red.');
  expect(streamed.join('')).toBe('Mars is red.');
  expect(streamed.join('')).not.toContain('think');
  await engine.unload();
});

test('WebLLM progress reads as download bytes, then compile, then ready', () => {
  const total = 353_285_213;
  expect(toLoadProgress({ progress: 0.5, text: 'Fetching param cache[4/9]: 170MB fetched. 50% completed, 3 secs elapsed.' }, total)).toEqual({ phase: 'download', loadedBytes: Math.round(total / 2), totalBytes: total, fraction: 0.5 });
  expect(toLoadProgress({ progress: 0.2, text: 'Loading model from cache[2/9]: 70MB loaded. 20% completed, 1 secs elapsed.' }, total).phase).toBe('compile');
  expect(toLoadProgress({ progress: 0.9, text: 'Loading GPU shader modules[90/100]: 90% completed, 4 secs elapsed.' }, total).phase).toBe('compile');
  expect(toLoadProgress({ progress: 1, text: 'Finish loading on WebGPU - apple' }, total)).toEqual({ phase: 'ready', loadedBytes: total, totalBytes: total, fraction: 1 });
  expect(toLoadProgress({ progress: Number.NaN, text: 'Start to fetch params' }, total).fraction).toBe(0);
});

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

test('failures from WebLLM (strings from its worker) and the browser map to EngineError codes and message keys', () => {
  const cases: Array<[unknown, string]> = [
    ["TypeError: Failed to execute 'add' on 'Cache': Request failed", 'network'],
    ['TypeError: Failed to fetch', 'network'],
    [new TypeError('NetworkError when attempting to fetch resource.'), 'network'],
    ['QuotaExceededError: The quota has been exceeded.', 'quota'],
    ['Error: Failed to store https://huggingface.co/x with error: QuotaExceededError', 'quota'],
    ['IntegrityError: Integrity verification failed for https://cdn.jsdelivr.net/gh/x.wasm', 'integrity'],
    ['DeviceLostError: The WebGPU device was lost while loading the model. This issue often occurs due to running out of memory (OOM).', 'device-lost'],
    ['GPUOutOfMemoryError: Out of memory', 'out-of-memory'],
    ['ShaderF16SupportError: This model requires WebGPU extension shader-f16, which is not enabled in this browser.', 'unsupported'],
    ['WebGPUNotAvailableError: WebGPU is not supported in your current environment', 'no-webgpu'],
    [new DOMException('The user aborted a request.', 'AbortError'), 'aborted'],
    ['Something else entirely', 'unknown'],
    [42, 'unknown'],
  ];
  for (const [thrown, code] of cases) {
    const e = toEngineError(thrown);
    expect(e.code, String(thrown)).toBe(code);
    expect(e.messageKey).toBe(`ai.engine.error.${code}`);
    expect(Object.keys(MESSAGES)).toContain(e.messageKey);
    expect(e).toBeInstanceOf(Error);
  }
  const passed = engineError('quota', 'full');
  expect(toEngineError(passed)).toBe(passed);
  expect(passed).toBeInstanceOf(EngineFailure);
  expect(isEngineError(passed)).toBe(true);
  expect(isEngineError({ code: 'network', messageKey: 'ai.engine.error.network' })).toBe(true);
  expect(toEngineError({ code: 'network', messageKey: 'ai.engine.error.network' }).code).toBe('network');
  for (const code of ['no-webgpu', 'too-small', 'quota', 'network', 'aborted', 'device-lost', 'out-of-memory', 'integrity', 'unsupported', 'unknown']) {
    expect(Object.keys(MESSAGES)).toContain(`ai.engine.error.${code}`);
  }
});

test('a model’s load holds the render budget from its weights’ upload to its end, and lets it go even when the load fails', async () => {
  const model = VISITOR_MODELS[0];
  if (!model) throw new Error('no model');
  for (const outcome of ['loaded', 'fails'] as const) {
    let holds = 0;
    const seen: { text: string; held: number }[] = [];
    const pacer: Pacer = {
      gate: () => Promise.resolve(),
      visible: () => Promise.resolve(),
      hold() {
        holds += 1;
        let done = false;
        return () => {
          if (done) return;
          done = true;
          holds -= 1;
        };
      },
      dispose: () => undefined,
    };
    const reports = ['Start to fetch params', 'Fetching param cache[1/10]: 100MB fetched.', 'Loading model from cache[1/10]: 0MB loaded.', 'Loading model from cache[10/10]: 900MB loaded.', 'Loading GPU shader modules[5/40]', 'Finish loading on WebGPU'];
    const worker: ModelWorker = {
      async call(request, onProgress) {
        if (request.type === 'unload') return { type: 'loaded', id: 0 };
        for (const text of reports) {
          onProgress?.({ progress: 0.5, text });
          seen.push({ text, held: holds });
          await Promise.resolve();
        }
        if (outcome === 'fails') throw new Error('device lost');
        return { type: 'loaded', id: 0 };
      },
      interrupt: () => undefined,
      terminate: () => undefined,
    };
    const loading = loadWebLLM(model, () => undefined, new AbortController().signal, pacer, () => worker);
    if (outcome === 'loaded') await (await loading).unload();
    else await expect(loading).rejects.toBeTruthy();
    // Downloading is the network's work, not the GPU's: the scene is judged as usual meanwhile.
    expect(seen.filter((r) => !/^Loading/u.test(r.text) && r.text !== 'Finish loading on WebGPU').every((r) => r.held === 0), outcome).toBe(true);
    expect(seen.filter((r) => /^Loading/u.test(r.text)).every((r) => r.held === 1), outcome).toBe(true);
    expect(holds, outcome).toBe(0);
  }
});
