/**
 * Saving the picture from photo mode (ledger CR-1), in the browser: the view as drawn, a PNG named for
 * the world and the date, with a band of credits below the picture (where and when, whose imagery,
 * the app and its Sources page), and the interface left out of it.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '../support/fixtures';
import { SLOW } from '../support/env';
import { JD, view, waitForUniverse } from '../support/universe';

const LIVE = { timeout: 60_000 * SLOW };

test('photo mode saves the picture with its credits below it', async ({ page, kf, pageErrors }, info) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-photo').click();
  await expect(page.getByTestId('universe-photo-save')).toBeVisible();
  await expect(page.getByTestId('universe-bodies')).toBeHidden();
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { width: c?.width ?? 0, height: c?.height ?? 0 };
  });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 * SLOW }), page.getByTestId('universe-photo-save').click()]);
  expect(download.suggestedFilename()).toMatch(/^kun-fayakun-mars-2026-10-23\.png$/u);
  const path = info.outputPath('picture.png');
  await download.saveAs(path);
  const png: Uint8Array = readFileSync(new URL(`file://${encodeURI(path)}`));
  const bytes = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // A PNG: its signature ("PNG" after the first byte), and its header's size: the canvas's width, and
  // its height with the credits' band below (big-endian, at bytes 16 and 20).
  expect([png[1], png[2], png[3]]).toEqual([0x50, 0x4e, 0x47]);
  expect(bytes.getUint32(16)).toBe(canvas.width);
  expect(bytes.getUint32(20)).toBeGreaterThan(canvas.height + 40);
  // Said to a screen reader (the page's polite announcer).
  await expect(page.locator('.kf-sr-only[aria-live="polite"]').filter({ hasText: 'Picture saved, with its credits.' })).toHaveCount(1);
  // Back to the interface.
  await page.getByTestId('universe-photo-exit').click();
  await expect(page.getByTestId('universe-bodies')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('photo mode records a video of the view, with its credits, where the browser can', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  await page.getByTestId('universe-photo').click();
  const record = page.getByTestId('universe-photo-record');
  await expect(record).toBeVisible();
  await record.click();
  await expect(record).toHaveAttribute('aria-pressed', 'true');
  await expect(record).toHaveText('Stop and save the video');
  await page.waitForTimeout(2000);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 * SLOW }), record.click()]);
  expect(download.suggestedFilename()).toMatch(/^kun-fayakun-mars-2026-10-23\.(webm|mp4)$/u);
  const path = info(download);
  await download.saveAs(path.out);
  const bytes: Uint8Array = readFileSync(new URL(`file://${encodeURI(path.out)}`));
  // A WebM begins with EBML's magic number; some frames recorded.
  expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(bytes.length).toBeGreaterThan(2000);
  await expect(record).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.kf-sr-only[aria-live="polite"]').filter({ hasText: 'Video saved, with its credits.' })).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('photo mode’s lens sets the camera’s field of view, and leaving gives the framing back', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/universe/mars', { query: { jd: JD } });
  await waitForUniverse(page);
  // The camera's own field of view (the app's camera, through the test hook).
  const fov = (): Promise<number> => page.evaluate(() => (window as unknown as { __kf: { app: { camera: { fov: number } } } }).__kf.app.camera.fov);
  const framed = await fov();
  await page.getByTestId('universe-photo').click();
  await page.getByTestId('universe-photo-lens').selectOption('20');
  await expect.poll(async () => (await view(page))?.lensFov, LIVE).toBe(20);
  await expect.poll(fov, LIVE).toBeCloseTo(20, 6);
  // Leaving photo mode gives the explorer's own framing back.
  await page.getByTestId('universe-photo-exit').click();
  await expect.poll(async () => (await view(page))?.lensFov, LIVE).toBeNull();
  await expect.poll(fov, LIVE).toBeCloseTo(framed, 6);
  expect(pageErrors).toEqual([]);
});

const info = (download: { suggestedFilename(): string }): { out: string } => ({ out: test.info().outputPath(download.suggestedFilename()) });
