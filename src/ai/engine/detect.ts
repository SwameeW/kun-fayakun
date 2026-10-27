/*
 * What this device can run, found without downloading anything (docs/AI-INTELLIGENCE.md §7):
 * 1. a secure context and navigator.gpu;
 * 2. the adapter, read in a worker (features, limits, info; never a GPUDevice, never the page's
 *    adapter unless the worker cannot say);
 * 3. the platform's budget of GPU memory for the assistant beside the scene;
 * 4. the largest model that fits the budget and the limits (q4f32 where shader-f16 is missing).
 * The decision itself is chooseTier, a pure function of the signals, so it is tested with canned
 * devices. Crash markers (written before each risky stage of a load, cleared after) step the next
 * visit's recommendation down one tier when a stage never finished.
 */
import type { I18nKey } from '../../core/types';
import type { CapabilityReport, DeviceTier, ModelSpec, ModelTier } from '../types';
import { probeAdapter, type AdapterProbe } from './adapter';
import { MODEL_TIERS, modelFor, VISITOR_MODELS } from './catalogue';

/* ------------------------------------------------------------------ */
/* The decision                                                         */
/* ------------------------------------------------------------------ */

/** Everything chooseTier reads, as detection found it (or as a test sets it). */
export interface TierSignals {
  secure: boolean;
  /** navigator.gpu gave an adapter. */
  webgpu: boolean;
  fallbackAdapter: boolean;
  f16: boolean;
  limits: CapabilityReport['limits'];
  platform: CapabilityReport['platform'];
  browser: CapabilityReport['browser'];
  deviceMemoryGB: number | null;
  /** adapter.info said nothing (Brave's Shields blank it): the GPU is unknown, which is not a failure. */
  adapterHidden: boolean;
  /** adapter.info names a discrete GPU (false when unknown). */
  discrete: boolean;
  crashedBefore: CapabilityReport['crashedBefore'];
}

export interface TierChoice {
  recommended: DeviceTier;
  /** GPU memory the assistant may use beside the scene, MB. */
  budgetMB: number;
  reasons: readonly I18nKey[];
}

/** WebLLM's own minimums (it checks them when it makes its device) and §7's. */
export const REQUIRED_LIMITS = {
  maxBufferSize: 256 * 2 ** 20,
  maxStorageBufferBindingSize: 128 * 2 ** 20,
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 32 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
} as const;

/**
 * The platform budgets of §7, MB. The design's GB are binary (×1024), the unit of WebLLM's
 * vram_required_MB, so "1.4 GB" holds the pocket model's 1,403 MB. They are the share left for the
 * assistant beside the scene as it normally runs; real measurements (§9) may move them.
 */
export const BUDGET_MB = {
  android6: Math.round(0.8 * 1024),
  android8: Math.round(1.4 * 1024),
  desktop4: Math.round(1.4 * 1024),
  desktop8: Math.round(2.6 * 1024),
  desktop16: Math.round(4.2 * 1024),
  /** 16 GB+ with a discrete GPU or a large maxBufferSize. */
  desktop16Large: Math.round(6.5 * 1024),
  /** Safari and Firefox on macOS, which give no deviceMemory: a middle size, the visitor may choose larger. */
  unknownMemory: Math.round(2.6 * 1024),
} as const;

/**
 * A maxBufferSize this large counts as a large adapter: 4 GiB less 4 bytes, the most Chrome reports
 * (measured on an Apple M5 Pro, 2026-10-26). Smaller adapters report less; the evaluation (§9)
 * should confirm that integrated GPUs on other systems do.
 */
export const LARGE_BUFFER_BYTES = 2 ** 32 - 4;

const reason = (name: string): I18nKey => `ai.engine.reason.${name}`;

export function limitsOk(limits: CapabilityReport['limits']): boolean {
  if (!limits) return false;
  return (Object.keys(REQUIRED_LIMITS) as (keyof typeof REQUIRED_LIMITS)[]).every((k) => limits[k] >= REQUIRED_LIMITS[k]);
}

/** §7 step 3: the GPU memory the assistant may use here, with the reason when it is none. */
function platformBudget(s: TierSignals, reasons: I18nKey[]): number {
  const gb = s.deviceMemoryGB;
  if (s.platform === 'android') {
    if (gb === null) {
      reasons.push(reason('android-unknown'));
      return 0;
    }
    if (gb >= 8) return BUDGET_MB.android8;
    if (gb >= 6) return BUDGET_MB.android6;
    reasons.push(reason('android-small'));
    return 0;
  }
  if (gb === null) {
    reasons.push(reason('memory-unknown'));
    return BUDGET_MB.unknownMemory;
  }
  if (gb >= 16) {
    const large = s.discrete || (s.limits?.maxBufferSize ?? 0) >= LARGE_BUFFER_BYTES;
    if (large) reasons.push(reason(s.discrete ? 'discrete' : 'large-buffer'));
    return large ? BUDGET_MB.desktop16Large : BUDGET_MB.desktop16;
  }
  if (gb >= 8) return BUDGET_MB.desktop8;
  if (gb >= 4) return BUDGET_MB.desktop4;
  reasons.push(reason('memory-small'));
  return 0;
}

const stepDown = (tier: ModelTier): DeviceTier => (tier === 'pocket' ? 'none' : (MODEL_TIERS[MODEL_TIERS.indexOf(tier) - 1] ?? 'none'));

/**
 * The recommendation for these signals: the largest visitor tier whose build for this adapter
 * (q4f16 with shader-f16, else q4f32) fits the budget, one tier lower after a crash. iOS, Firefox,
 * a fallback adapter, no WebGPU and too-small limits get the guide only, each with its reason.
 */
export function chooseTier(s: TierSignals, models: readonly ModelSpec[] = VISITOR_MODELS): TierChoice {
  const reasons: I18nKey[] = [];
  const none = (key: string, budgetMB = 0): TierChoice => ({ recommended: 'none', budgetMB, reasons: [...reasons, reason(key)] });
  if (!s.secure) return none('insecure');
  if (s.platform === 'ios') return none('ios');
  if (s.browser === 'firefox') return none('firefox');
  if (!s.webgpu) return none('no-webgpu');
  if (s.fallbackAdapter) return none('fallback-adapter');
  if (!limitsOk(s.limits)) return none('limits');
  if (s.adapterHidden) reasons.push(reason('adapter-hidden'));
  if (!s.f16) reasons.push(reason('no-f16'));
  const budgetMB = platformBudget(s, reasons);
  if (budgetMB <= 0) return { recommended: 'none', budgetMB: 0, reasons };
  let best: ModelTier | null = null;
  for (const tier of MODEL_TIERS) {
    const model = modelFor(tier, s.f16, models);
    if (model && model.vramMB <= budgetMB) best = tier;
  }
  if (!best) return none('too-small', budgetMB);
  if (s.crashedBefore) {
    reasons.push(reason('crashed'));
    return { recommended: stepDown(best), budgetMB, reasons };
  }
  return { recommended: best, budgetMB, reasons };
}

/* ------------------------------------------------------------------ */
/* Signals from the browser                                             */
/* ------------------------------------------------------------------ */

/** The parts of navigator detection reads (a plain object in tests). */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean; platform?: string; brands?: readonly { brand: string }[] };
  /** Brave's own marker (navigator.brave). */
  brave?: unknown;
  deviceMemory?: number;
}

export function platformOf(nav: NavigatorLike): CapabilityReport['platform'] {
  const ua = nav.userAgent;
  // iPadOS asks for desktop pages with a Mac's user agent; its touch points give it away.
  if (/iPhone|iPad|iPod/u.test(ua) || (/Macintosh/u.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/Android/u.test(ua) || nav.userAgentData?.platform === 'Android') return 'android';
  return ua ? 'desktop' : 'unknown';
}

export function browserOf(nav: NavigatorLike): CapabilityReport['browser'] {
  const ua = nav.userAgent;
  // Every browser on iOS is WebKit underneath.
  if (platformOf(nav) === 'ios') return 'safari';
  if (nav.brave !== undefined || nav.userAgentData?.brands?.some((b) => b.brand === 'Brave')) return 'brave';
  if (/Firefox\//u.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//u.test(ua) || nav.userAgentData?.brands?.some((b) => b.brand === 'Chromium')) return 'chromium';
  if (/Safari\//u.test(ua) && /Version\//u.test(ua)) return 'safari';
  return 'unknown';
}

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|warp/u;
const DISCRETE_GPU = /\b(?:nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|arc a\d)/u;

/** The adapter's signals: hidden info (unknown, not a failure), software, discrete, shader-f16. */
export function adapterSignals(probe: AdapterProbe | null): Pick<TierSignals, 'webgpu' | 'fallbackAdapter' | 'f16' | 'limits' | 'adapterHidden' | 'discrete'> {
  if (!probe) return { webgpu: false, fallbackAdapter: false, f16: false, limits: null, adapterHidden: false, discrete: false };
  const { vendor, architecture, device, description } = probe.info;
  const text = `${vendor} ${architecture} ${device} ${description}`.toLowerCase().trim();
  return {
    webgpu: true,
    fallbackAdapter: probe.fallback || SOFTWARE_GPU.test(text),
    f16: probe.features.includes('shader-f16'),
    limits: { ...probe.limits },
    adapterHidden: text === '',
    discrete: vendor.toLowerCase() === 'nvidia' || DISCRETE_GPU.test(text),
  };
}

/** Reads the adapter in a worker; undefined when the worker could not answer (then the page asks). */
function probeInWorker(timeoutMs: number): Promise<AdapterProbe | null | undefined> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./detect-worker.ts', import.meta.url), { type: 'module', name: 'kf-ai-detect' });
    } catch {
      resolve(undefined);
      return;
    }
    const done = (value: AdapterProbe | null | undefined): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => {
      done(undefined);
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<AdapterProbe | null>) => {
      done(event.data);
    };
    worker.onerror = () => {
      done(undefined);
    };
  });
}

/** The adapter, read in a worker; on the page (an adapter only, no device) where a worker has no WebGPU. */
export async function readAdapterSafely(): Promise<AdapterProbe | null> {
  const gpu = (navigator as { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const fromWorker = await probeInWorker(4000);
  if (fromWorker) return fromWorker;
  try {
    return await probeAdapter(gpu);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Crash markers                                                        */
/* ------------------------------------------------------------------ */

export type CrashStage = 'device' | 'upload' | 'prefill';

const CRASH_KEY = 'kf.ai.crash';
/** This page's markers carry its id, so a load in progress here is never read as a crash. */
const PAGE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let leaveListener = false;

interface Marker {
  stage: CrashStage;
  model: string;
  page: string;
}

/** Writes the marker before a risky stage (device creation, weight upload, the first prefill). */
export function markStage(stage: CrashStage, model: string): void {
  try {
    const marker: Marker = { stage, model, page: PAGE };
    localStorage.setItem(CRASH_KEY, JSON.stringify(marker));
  } catch {
    // Storage blocked (private window, Shields): no marker, so no step down next time.
  }
  if (!leaveListener && typeof window !== 'undefined') {
    leaveListener = true;
    // Leaving the page normally is not a crash: only a tab that dies keeps its marker.
    window.addEventListener('pagehide', clearStage);
  }
}

/** Clears this page's marker once the stage has finished (or failed cleanly). */
export function clearStage(): void {
  try {
    const raw = localStorage.getItem(CRASH_KEY);
    if (raw && (JSON.parse(raw) as Partial<Marker>).page === PAGE) localStorage.removeItem(CRASH_KEY);
  } catch {
    // Nothing to clear where storage is blocked.
  }
}

/** A marker an earlier page left behind: that page stopped during this stage. */
export function readCrash(): CapabilityReport['crashedBefore'] {
  try {
    const raw = localStorage.getItem(CRASH_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<Marker>;
    if (m.page === PAGE || typeof m.stage !== 'string' || typeof m.model !== 'string') return null;
    return { stage: m.stage, model: m.model };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The report                                                           */
/* ------------------------------------------------------------------ */

interface ConnectionLike {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
}

function network(): Pick<CapabilityReport, 'saveData' | 'metered'> {
  const c = (navigator as { connection?: ConnectionLike }).connection;
  if (!c) return { saveData: false, metered: null };
  const slow = c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
  const metered = c.type === 'cellular' || slow ? true : c.type !== undefined && c.type !== 'unknown' ? false : null;
  return { saveData: c.saveData === true, metered };
}

async function storage(): Promise<CapabilityReport['storage']> {
  const s = (navigator as { storage?: StorageManager }).storage;
  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    // Unreliable in Chrome 133+ and in Brave (§11): reported as the browser gives it.
    const estimate = await s?.estimate();
    quotaBytes = estimate?.quota ?? null;
    usageBytes = estimate?.usage ?? null;
  } catch {
    // Left unknown.
  }
  try {
    persisted = (await s?.persisted()) ?? null;
  } catch {
    // Left unknown.
  }
  return { quotaBytes, usageBytes, persisted };
}

/** The whole report on this page. Nothing is downloaded and no GPUDevice is created. */
export async function detectCapabilities(browserModel: () => Promise<CapabilityReport['browserModel']>): Promise<CapabilityReport> {
  const nav = navigator as Navigator & NavigatorLike;
  const secure = globalThis.isSecureContext;
  const [probe, store, model] = await Promise.all([secure ? readAdapterSafely() : Promise.resolve(null), storage(), browserModel().catch(() => 'absent' as const)]);
  const deviceMemoryGB = typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : null;
  const signals: TierSignals = {
    secure,
    ...adapterSignals(probe),
    platform: platformOf(nav),
    browser: browserOf(nav),
    deviceMemoryGB,
    crashedBefore: readCrash(),
  };
  const choice = chooseTier(signals);
  return {
    secure,
    webgpu: signals.webgpu,
    fallbackAdapter: signals.fallbackAdapter,
    f16: signals.f16,
    limits: signals.limits,
    platform: signals.platform,
    browser: signals.browser,
    deviceMemoryGB,
    budgetMB: choice.budgetMB,
    crashedBefore: signals.crashedBefore,
    ...network(),
    storage: store,
    browserModel: model,
    recommended: choice.recommended,
    reasons: choice.reasons,
  };
}
