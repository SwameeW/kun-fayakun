/**
 * Spec section 8: first visual in under 3 s on throttled 4G. The network is
 * shaped through the Chrome DevTools Protocol to the "slow 4G" profile
 * (150 ms RTT, 1.6 Mbps down, 750 kbps up) with the cache disabled; the first
 * visual is the page's first-contentful-paint.
 */
import { expect, test } from '../support/fixtures';

const BITS_PER_BYTE = 8;
const SLOW_4G = {
  offline: false,
  latency: 150,
  downloadThroughput: 1_600_000 / BITS_PER_BYTE,
  uploadThroughput: 750_000 / BITS_PER_BYTE,
};
const BUDGET_MS = 3000;

test('first contentful paint under 3 s on slow 4G', { tag: '@perf' }, async ({
  page,
  kf,
}, testInfo) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', SLOW_4G);

  await page.goto(kf.url('/'), { waitUntil: 'commit' });
  const fcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entry = list.getEntriesByName('first-contentful-paint')[0];
          if (entry) resolve(entry.startTime);
        }).observe({ type: 'paint', buffered: true });
      }),
  );

  console.log(`[perf] ${testInfo.project.name}: first-contentful-paint ${fcp.toFixed(0)} ms on slow 4G`);
  testInfo.annotations.push({ type: 'fcp-ms', description: fcp.toFixed(0) });
  expect(fcp, 'first-contentful-paint (ms)').toBeLessThan(BUDGET_MS);
});
