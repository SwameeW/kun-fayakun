import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { env, flag, platform } from './tests/support/env';
import type { KfOptions } from './tests/support/fixtures';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const CI = Boolean(env('CI'));

/** `PERF=1 npx playwright test --workers=1` runs only the @perf specs; the default run skips them. */
const PERF = flag('PERF');

/**
 * Serve a production build. `npm run build` is avoided on purpose: it also
 * runs the validator, which CI runs as its own step. KF_SKIP_BUILD=1 reuses
 * an existing dist/ (CI builds once, then checks the bundle and tests it).
 */
const BUILD = flag('KF_SKIP_BUILD') ? '' : 'npx vite build && ';
const SERVE = `npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`;

/**
 * Lets headless Chromium expose WebGPU. On macOS the full Chromium build gets
 * the real Metal adapter; GPU-less Linux CI only has SwiftShader's Vulkan
 * adapter. Which backend actually came up is recorded by the smoke spec.
 */
const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  ...(platform === 'linux' ? ['--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader'] : []),
];

/** Full Chromium in new headless mode: unlike the headless shell it can use the GPU. */
/** Brave is the project owner's browser; its project runs only where Brave is installed (override with BRAVE_PATH). */
const BRAVE_PATH = env('BRAVE_PATH') ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const HAS_BRAVE = existsSync(BRAVE_PATH);

const desktopChromium = {
  ...devices['Desktop Chrome'],
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
};

export default defineConfig<KfOptions>({
  testDir: 'tests',
  outputDir: 'test-results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // GPU-bound pages interfere with each other; perf runs must be alone.
  workers: PERF || CI ? 1 : 2,
  ...(PERF ? { grep: /@perf/ } : { grepInvert: /@perf/ }),
  reporter: CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `${BUILD}${SERVE}`,
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'webgpu',
      use: { ...desktopChromium, launchOptions: { args: WEBGPU_ARGS } },
    },
    {
      name: 'webgl2',
      use: { ...desktopChromium, forceWebGL: true },
    },
    ...(HAS_BRAVE
      ? [
          {
            name: 'brave',
            testMatch: /smoke\.spec\.ts|perf\//,
            use: { ...desktopChromium, channel: undefined, launchOptions: { executablePath: BRAVE_PATH, args: WEBGPU_ARGS } },
          },
        ]
      : []),
  ],
});
