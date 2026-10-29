import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { env, flag, platform } from './tests/support/env';
import type { KfOptions } from './tests/support/fixtures';

/** KF_PORT lets several checkouts (worktrees) run browser tests at once without sharing a server. */
const PORT = Number(env('KF_PORT') ?? 4173);
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

/** Specs that run only on the emulated phone (the "mobile" project). */
const MOBILE_SPECS = /explore\/mobile\.spec\.ts|ai-panel-mobile\.spec\.ts/u;

/**
 * Specs that are GPU-heavy throughout (the laboratory and its effects, walks, the small worlds, the
 * stars and black holes, the time machine's and the layout's stress runs, the Earth's air from orbit at high detail): left out of CI, where every
 * frame is drawn in software. On CI (2026-10-28) a frame there took seconds and a screenshot about 20 s,
 * so 14 of the 20 shards ran past two hours and the rest failed on their time limits or on counts of
 * frames a GPU draws; on the next run the 2.5 million stars did the same. They run on GPU machines
 * before every release (README, "Review process"), as do single tests elsewhere skipped on CI with
 * NEEDS_GPU or NEEDS_REAL_FRAMES (tests/support/env.ts).
 */
const GPU_SPECS = /explore\/(?:air-orbit|black-holes|lab|lab-effects|lab-throw|layout-stress|small-worlds|stars|stars-camera|time-stress|walk-light|walk-stress)\.spec\.ts/u;

/**
 * The real-model evaluation (tests/ai-eval, docs/AI-INTELLIGENCE.md §9): local only, never CI, and
 * never part of a normal run. Its project exists only with KF_AI_EVAL=1, and every other project
 * ignores its folder. It downloads nothing: the model hosts resolve to nothing in Chromium, and the
 * spec answers the pinned files from the copies scripts/ai-eval/fetch-models.ts keeps on disk.
 */
const AI_EVAL = flag('KF_AI_EVAL');
/** Matched against absolute paths, so anchored on tests/ (a checkout may itself sit in a folder named ai-eval). */
const AI_EVAL_SPECS = /[\\/]tests[\\/]ai-eval[\\/]/u;
/**
 * Before/after captures for visual work (tests/visual): every shot of the film and fixed views of the
 * explorer, on the manual clock, with the GPU's time per view. Never part of a normal run: its project
 * exists only with KF_VISUAL=1, and every other project ignores its folder.
 */
const VISUAL = flag('KF_VISUAL');
const VISUAL_SPECS = /[\\/]tests[\\/]visual[\\/]/u;
const MODEL_HOST_RULES = ['huggingface.co', '*.huggingface.co', 'hf.co', '*.hf.co', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'].map((h) => `MAP ${h} ~NOTFOUND`).join(', ');

const desktopChromium = {
  ...devices['Desktop Chrome'],
  channel: 'chromium',
  viewport: { width: 1280, height: 800 },
};

export default defineConfig<KfOptions>({
  testDir: 'tests',
  outputDir: 'test-results',
  // CI has no GPU: every frame is drawn in software (SwiftShader), many times slower than on a
  // real GPU, so waits on animations and loading get three times as long there. Nothing that
  // fails is let through; it is only given longer to happen.
  timeout: CI ? 360_000 : 120_000,
  expect: { timeout: CI ? 45_000 : 15_000 },
  // On CI the browser tests are split across runners test by test (not file by file), so a file of
  // long tests does not hold one runner past its limit; locally each file runs in order.
  fullyParallel: CI,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // GPU-bound pages interfere with each other; perf runs and the real-model evaluation must be alone.
  workers: PERF || CI || AI_EVAL || VISUAL ? 1 : 2,
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
    // Pure functions (no browser): the data extraction behind generated assets.
    { name: 'unit', testMatch: /unit\//u },
    {
      name: 'webgpu',
      testIgnore: [/unit\//u, MOBILE_SPECS, AI_EVAL_SPECS, VISUAL_SPECS, ...(CI ? [GPU_SPECS] : [])],
      use: { ...desktopChromium, launchOptions: { args: WEBGPU_ARGS } },
    },
    {
      name: 'webgl2',
      testIgnore: [/unit\//u, MOBILE_SPECS, AI_EVAL_SPECS, VISUAL_SPECS, ...(CI ? [GPU_SPECS] : [])],
      use: { ...desktopChromium, forceWebGL: true },
    },
    // A phone (Pixel 7: 412 x 839 CSS px at DPR 2.625, touch, Android Chrome's user agent) for the
    // explorer's touch controls and layouts. Emulation, not a real phone: the GPU is this machine's.
    {
      name: 'mobile',
      testMatch: MOBILE_SPECS,
      use: { ...devices['Pixel 7'], channel: 'chromium', launchOptions: { args: WEBGPU_ARGS } },
    },
    // The real-model evaluation: the webgpu project's Chromium and real-GPU WebGPU, one model at a
    // time, hours allowed (KF_AI_EVAL=1 KF_AI_EVAL_MODEL=<id> npx playwright test --project=ai-eval).
    ...(AI_EVAL
      ? [
          {
            name: 'ai-eval',
            testMatch: /[\\/]tests[\\/]ai-eval[\\/][^\\/]+\.spec\.ts$/u,
            timeout: 8 * 60 * 60_000,
            expect: { timeout: 120_000 },
            fullyParallel: false,
            retries: 0,
            use: { ...desktopChromium, launchOptions: { args: [...WEBGPU_ARGS, `--host-resolver-rules=${MODEL_HOST_RULES}`] }, trace: 'off' as const, screenshot: 'off' as const },
          },
        ]
      : []),
    ...(VISUAL
      ? [
          {
            name: 'visual',
            testMatch: VISUAL_SPECS,
            retries: 0,
            // Frames uncapped (no vsync, no frame-rate limit): the time per frame is then what a view costs.
            use: { ...desktopChromium, launchOptions: { args: [...WEBGPU_ARGS, '--disable-gpu-vsync', '--disable-frame-rate-limit'] }, trace: 'off' as const, screenshot: 'off' as const },
          },
        ]
      : []),
    ...(HAS_BRAVE
      ? [
          {
            name: 'brave',
            testMatch: /smoke\.spec\.ts|explore\/five-planets\.spec\.ts|explore\/lab\.spec\.ts|explore\/walk-light\.spec\.ts|perf\//,
            use: { ...desktopChromium, channel: undefined, launchOptions: { executablePath: BRAVE_PATH, args: WEBGPU_ARGS } },
          },
        ]
      : []),
  ],
});
