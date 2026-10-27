/**
 * Drivers for the assistant's panel (src/ai/ui), shared by its specs: opening it from Ask, asking
 * through its own field, its strings, and a canned device for the model section (CI has no GPU to
 * detect, so the test hook's useReport gives the engine host this one).
 */
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import type { CapabilityReport } from '../../src/ai/types';
import { SLOW } from './env';
import { expect } from './fixtures';

const strings = JSON.parse(readFileSync(new URL('../../src/i18n/en.ai.json', import.meta.url), 'utf8')) as Record<string, string>;

/** A message of src/i18n/en.ai.json as it reads with no arguments. */
export const s = (key: string): string => strings[key] ?? `?${key}`;

export const LIVE = { timeout: 60_000 * SLOW };

/** Failures the page logs on purpose (a 404 from a mocked model host) are not counted. */
export const realErrors = (errors: readonly string[]): string[] => errors.filter((e) => !/Failed to load resource/u.test(e));

export const panel = (page: Page): Locator => page.getByTestId('ai-panel');
export const turns = (page: Page): Locator => page.getByTestId('ai-log').locator(':scope > li');

export async function ready(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true', LIVE);
}

/** Opens the panel with Ask (its first press loads it) and waits for the question field to have focus. */
export async function openPanel(page: Page): Promise<void> {
  if (await panel(page).isVisible()) return;
  await page.getByTestId('ask').click();
  await expect(panel(page)).toBeVisible(LIVE);
  await expect(page.getByTestId('ai-input')).toBeFocused();
}

/** Asks through the panel's own field and waits for the new turn to reach `state` (done by default). */
export async function ask(page: Page, question: string, state = 'done'): Promise<Locator> {
  const count = await turns(page).count();
  const input = page.getByTestId('ai-input');
  await input.fill(question);
  await input.press('Enter');
  const turn = turns(page).nth(count);
  await expect(turn).toHaveAttribute('data-state', state, LIVE);
  return turn;
}

/** A desktop with WebGPU and shader-f16, a middle budget and an unknown connection: Qwen3 1.7B is suggested. */
export const REPORT: CapabilityReport = {
  secure: true,
  webgpu: true,
  fallbackAdapter: false,
  f16: true,
  limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32_768, maxComputeInvocationsPerWorkgroup: 256 },
  platform: 'desktop',
  browser: 'chromium',
  deviceMemoryGB: 8,
  budgetMB: 2600,
  crashedBefore: null,
  saveData: false,
  metered: null,
  storage: { quotaBytes: null, usageBytes: null, persisted: false },
  browserModel: 'absent',
  recommended: 'compact',
  reasons: [],
};
