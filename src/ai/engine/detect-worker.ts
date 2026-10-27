/*
 * Reads the GPU adapter away from the page (docs/AI-INTELLIGENCE.md §7, step 2): its features,
 * limits and info. It asks for an adapter only: no GPUDevice is created, nothing is downloaded,
 * and the page's own adapter and device (the renderer's) are never touched.
 *
 * Out: one AdapterProbe, or null when there is no WebGPU or no adapter.
 */
import { probeAdapter, type AdapterProbe } from './adapter';

const scope = self as unknown as {
  navigator: { gpu?: GPU };
  postMessage(message: AdapterProbe | null): void;
};

probeAdapter(scope.navigator.gpu).then(
  (result) => {
    scope.postMessage(result);
  },
  () => {
    scope.postMessage(null);
  },
);
