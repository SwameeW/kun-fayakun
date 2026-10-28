/**
 * Shared Playwright fixtures: URLs that honour the project's backend option,
 * console and page-error capture, and small drivers built on the engine's
 * test hooks (docs/CONTRACTS.md, "Test hooks" and "UI test ids").
 */
import { test as base, expect, type Page } from '@playwright/test';
import type { ScriptedOptions, ScriptedReply } from '../../src/ai/engine/scripted';
import type { CapabilityReport, Intelligence } from '../../src/ai/types';
import type { App, ChapterContent, ChapterId, LabCommand, LabEditResult, UniversePose, UniverseView } from '../../src/core/types';
import { env, SLOW } from './env';
import { mockLiveHosts } from './live';

export interface KfOptions {
  /** Add ?forceWebGL=1 to every navigation (the "webgl2" project). */
  forceWebGL: boolean;
  /**
   * The laboratory's "Slow down for events" (on for visitors unless they turn it off, src/explore/lab
   * SLOW): off in the tests unless a spec turns it on with test.use({ labSlow: true }), so a spec's timing
   * around an impact is its own (docs/SANDBOX-ROADMAP.md W1.13).
   */
  labSlow: boolean;
}

export interface FrameStats {
  frames: number;
  seconds: number;
  medianFps: number;
  onePercentLowFps: number;
  p99FrameMs: number;
  /** GPU resources alive (renderer.info.memory). */
  memory: { geometries: number; textures: number };
  experience: 'film' | 'universe';
}

/**
 * window.__kf as the engine exposes it. Tests reach it through a cast so no
 * global declaration here can clash with one in src/.
 */
export interface KfHook {
  __kf: {
    app: App;
    frameStats(): FrameStats;
    resetFrameStats(): void;
    step(frames?: number, dt?: number): void;
    camera(): { position: [number, number, number]; fov: number };
    universe: { state(): UniverseView | null; place(pose: UniversePose): void; lab?(command: LabCommand): Promise<LabEditResult>; labDraw?(): unknown; labEffects?(parts: Partial<Record<'rocks' | 'dust' | 'fire' | 'bands', boolean>>): Record<'rocks' | 'dust' | 'fire' | 'bands', boolean> | null };
    /** The film's sound (src/ui/film-sound.ts): what plays now, and an offline render of a chapter's stretch. */
    filmSound?: {
      state(): FilmSoundState | null;
      render(chapter: ChapterId, content: ChapterContent, from: number, to: number): Promise<{ rms: number[]; peak: number[] }>;
    };
    /**
     * The assistant (src/ai/boot.ts): start() loads it and resolves to the page's one Intelligence;
     * useScripted() (there once start() has run) switches it to the scripted test engine and resolves
     * to its counts of generations (under way now, and the most at once);
     * useReport() makes detection answer with a canned device.
     */
    ai: {
      start(): Promise<Intelligence>;
      useScripted(script: readonly ScriptedReply[], options?: ScriptedOptions): Promise<{ readonly running: number; readonly mostAtOnce: number }>;
      useReport(report: CapabilityReport): Promise<void>;
    };
    /** The explorer's more worlds, once come (src/explore/worlds): the GPU's own places of the first asteroids, read back, and their date. */
    worlds?: {
      probe(count: number, drawn?: boolean): Promise<{ days: number; places: number[] }>;
    };
  };
}

/** The film's sound as its test hook reports it (src/core/film-score.ts FilmScoreState). */
export interface FilmSoundState {
  chapter: ChapterId | null;
  level: number;
  voices: Record<string, number>;
  duck: number;
  shots: string[];
}

export interface OpenOptions {
  /** Skip the intro overlay and start playing (?autoplay=1). */
  autoplay?: boolean;
  /** Chapter deep-link time in seconds. */
  t?: number;
  /** Extra query parameters, e.g. { tier: 'low' }. */
  query?: Record<string, string>;
}

export interface Kf {
  /** App URL for a hash route such as "/", "/sources" or "/ch/2?t=30". */
  url(route: string, options?: OpenOptions): string;
  open(route: string, options?: OpenOptions): Promise<void>;
  /** Deep-links to a chapter and waits for html[data-chapter-ready]. */
  openChapter(id: ChapterId, options?: OpenOptions): Promise<void>;
  waitForChapterReady(id: ChapterId): Promise<void>;
  /** Reads a data-* attribute from <html>. */
  htmlData(name: string): Promise<string | null>;
  ensurePanelOpen(): Promise<void>;
}

/** Chapters fetch large textures (the 4096 px CMB) and compile pipelines; be generous. */
export const CHAPTER_READY_TIMEOUT = 90_000 * SLOW;

export function chapterRoute(id: ChapterId, t?: number): string {
  const n = Number(id.slice(2));
  return t === undefined ? `/ch/${n}` : `/ch/${n}?t=${t}`;
}

/**
 * Runs before any page script: guarantees ?forceWebGL=1 even for navigations
 * that did not go through Kf.url (reloads, direct page.goto calls).
 */
function ensureForceWebGL(): void {
  if (window.top !== window || !location.protocol.startsWith('http')) return;
  const url = new URL(location.href);
  if (url.searchParams.get('forceWebGL') === '1') return;
  url.searchParams.set('forceWebGL', '1');
  history.replaceState(null, '', url);
}

function createKf(page: Page, forceWebGL: boolean): Kf {
  const url = (route: string, options: OpenOptions = {}): string => {
    const query = new URLSearchParams(options.query);
    if (options.autoplay) query.set('autoplay', '1');
    if (forceWebGL) query.set('forceWebGL', '1');
    const search = query.toString();
    return `/${search ? `?${search}` : ''}#${route}`;
  };
  const waitForChapterReady = async (id: ChapterId): Promise<void> => {
    await expect(page.locator('html')).toHaveAttribute('data-chapter-ready', id, {
      timeout: CHAPTER_READY_TIMEOUT,
    });
  };
  return {
    url,
    async open(route, options) {
      await page.goto(url(route, options));
    },
    async openChapter(id, options = {}) {
      await page.goto(url(chapterRoute(id, options.t), options));
      await waitForChapterReady(id);
    },
    waitForChapterReady,
    htmlData: (name) =>
      page.evaluate((attr) => document.documentElement.getAttribute(`data-${attr}`), name),
    async ensurePanelOpen() {
      const firstLayer = page.getByTestId('layer-text');
      if (!(await firstLayer.isVisible())) await page.getByTestId('panel-toggle').click();
      await expect(firstLayer).toBeVisible();
    },
  };
}

interface Fixtures {
  kf: Kf;
  /** console.error messages and uncaught exceptions seen during the test. */
  pageErrors: string[];
}

export const test = base.extend<Fixtures & KfOptions>({
  forceWebGL: [false, { option: true }],
  labSlow: [false, { option: true }],

  page: async ({ page, forceWebGL, labSlow }, use) => {
    if (forceWebGL) await page.addInitScript(ensureForceWebGL);
    if (!labSlow) {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('kf-lab-slow', '0');
        } catch {
          // No storage here: the laboratory slows as a visitor's would.
        }
      });
    }
    // No test reaches the Living Earth's live services (tests/support/live).
    await mockLiveHosts(page);
    // KF_THROTTLE=4 slows the CPU four times (Chromium only): a local stand-in for CI's slow runners, to check a test's timing holds there.
    const throttle = Number(env('KF_THROTTLE') ?? 0);
    if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await use(page);
  },

  pageErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const { url, lineNumber } = message.location();
      errors.push(`console.error: ${message.text()}${url ? ` (${url}:${lineNumber})` : ''}`);
    });
    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.message}`);
    });
    await use(errors);
  },

  kf: async ({ page, forceWebGL }, use, testInfo) => {
    await use(createKf(page, forceWebGL));
    // Record which backend actually came up, so reports show what was tested.
    const backend = await page
      .evaluate(() => document.documentElement.getAttribute('data-backend'))
      .catch(() => null);
    if (backend) testInfo.annotations.push({ type: 'backend', description: backend });
  },
});

export { expect };
