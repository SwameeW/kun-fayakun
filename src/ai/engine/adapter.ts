/*
 * What the models need to know about a GPU adapter (docs/AI-INTELLIGENCE.md §7, step 2), read
 * without creating a device. Shared by the detection worker and the page's fallback.
 */

/** An adapter as detection sees it. */
export interface AdapterProbe {
  features: readonly string[];
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
    maxComputeWorkgroupStorageSize: number;
    maxComputeInvocationsPerWorkgroup: number;
  };
  /** adapter.info; every field '' where the browser hides it (Brave's Shields). */
  info: { vendor: string; architecture: string; device: string; description: string };
  /** A fallback (software) adapter, by the browser's own flag. */
  fallback: boolean;
}

export function readAdapter(adapter: GPUAdapter): AdapterProbe {
  const info = (adapter as { info?: Partial<GPUAdapterInfo> & { isFallbackAdapter?: boolean } }).info;
  const legacyFallback = (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  const l = adapter.limits;
  return {
    features: [...adapter.features],
    limits: {
      maxBufferSize: l.maxBufferSize,
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
      maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
    },
    info: { vendor: info?.vendor ?? '', architecture: info?.architecture ?? '', device: info?.device ?? '', description: info?.description ?? '' },
    fallback: info?.isFallbackAdapter === true || legacyFallback === true,
  };
}

/**
 * Asks for an adapter (the preference WebLLM uses for its own device) and reads it; null without
 * WebGPU or an adapter. Never calls requestDevice.
 */
export async function probeAdapter(gpu: GPU | undefined): Promise<AdapterProbe | null> {
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  return adapter ? readAdapter(adapter) : null;
}
