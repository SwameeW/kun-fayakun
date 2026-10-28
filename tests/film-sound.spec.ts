/**
 * The film's sound (src/core/film-score.ts, src/ui/film-sound.ts). Its recordings (public/assets/sound)
 * are all there and decode, each the length its loop needs; one that is slow to come, stalls or is
 * missing silences only its own layer, and the chapter's made sound and its one-shots play on time
 * without it. Rendered offline, every chapter stays well
 * clear of clipping, sinks to near silence under each verse and comes back slowly after it, keeps its
 * silences (before the word forms, after the plasma's sound ends at recombination, at the end of the
 * end) and sounds where the picture has sound to give, the recorded sounds among them. Live, it follows
 * the film: one speaker in the header (shared with the explorer's Sound), the duck under a verse,
 * one-shots only when the film plays across them, and the audio suspended while the film is paused.
 */
import { readdirSync, readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import type { ChapterContent, ChapterId } from '../src/core/types';
import { chapterContent } from './support/data';
import { SLOW } from './support/env';
import { expect, test, type FilmSoundState, type KfHook } from './support/fixtures';
import { waitForUniverse } from './support/universe';

const LIVE = { timeout: 30_000 * SLOW };
const CHAPTERS: readonly ChapterId[] = ['ch00', 'ch01', 'ch02', 'ch03', 'ch04', 'ch05', 'ch06', 'ch07', 'ch08', 'ch09', 'ch10'];
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const db = (rms: number): number => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);
const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? -Infinity;
const eventAt = (content: ChapterContent, event: string): number => content.cues.find((c) => c.type === 'scene' && c.event === event)?.t ?? Number.NaN;

async function render(page: Page, chapter: ChapterId): Promise<{ rms: number[]; peak: number[]; content: ChapterContent }> {
  const content = chapterContent(chapter);
  const result = await page.evaluate(
    async ({ chapter: id, content: c }) => {
      const sound = (window as unknown as KfHook).__kf.filmSound;
      if (!sound) throw new Error('no film sound hook');
      return sound.render(id, c, 0, c.duration);
    },
    { chapter, content },
  );
  return { ...result, content };
}

const state = (page: Page): Promise<FilmSoundState | null> => page.evaluate(() => (window as unknown as KfHook).__kf.filmSound?.state() ?? null);

/** The loudest RMS (dB) the speaker gets over a couple of seconds of the live film, read off the scene bus. */
const liveLevel = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const bus = (window as unknown as KfHook).__kf.app.audio.bus('scene') as GainNode;
    const analyser = bus.context.createAnalyser();
    analyser.fftSize = 2048;
    bus.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let most = 0;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const x of data) sum += x * x;
      most = Math.max(most, Math.sqrt(sum / data.length));
    }
    bus.disconnect(analyser);
    return most > 0 ? 20 * Math.log10(most) : -Infinity;
  });

test('every recording the score plays is there and decodes, each the length its loop needs', async ({ page, kf, pageErrors }) => {
  test.setTimeout(120_000 * SLOW);
  await kf.open('/');
  const recordings = await page.evaluate(async () => {
    const sound = (window as unknown as KfHook).__kf.filmSound;
    if (!sound) throw new Error('no film sound hook');
    return sound.recordings();
  });
  expect(recordings.length).toBeGreaterThan(0);
  for (const r of recordings) {
    expect(r.ok, `${r.name}: ${r.url} is there and decodes`).toBe(true);
    expect(r.channels, r.name).toBeGreaterThan(0);
    // Not silent: every recording is set to a common loudness when it is made (scripts/sound/build.py).
    expect(r.rms, `${r.name}: its level`).toBeGreaterThan(0.005);
    if (r.expected === null) expect(r.seconds, `${r.name}: a one-shot`).toBeGreaterThan(1);
    else expect(Math.abs(r.seconds - r.expected), `${r.name}: ${r.seconds.toFixed(3)} s against ${r.expected} s`).toBeLessThan(0.1);
  }
  // And nothing in public/assets/sound that the score does not play.
  const files = readdirSync(new URL('../public/assets/sound/', import.meta.url)).filter((f) => f.endsWith('.m4a')).map((f) => f.slice(0, -4));
  expect(files.sort()).toEqual(recordings.map((r) => r.name).sort());
  expect(pageErrors).toEqual([]);
});

test('a recording slow to come silences only its own layer: the made sound and the one-shots play on time without it, and a stalled download is let go', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  // Every recording held back, as on a connection that has stalled, until the test lets them go.
  const held: Route[] = [];
  await page.route('**/assets/sound/*.m4a', (route) => {
    held.push(route);
  });
  const ch08 = chapterContent('ch08');
  const thuds = [3, 9, 15].map((s) => eventAt(ch08, 'molten') + s);
  await kf.openChapter('ch08', { autoplay: true, t: 1 });
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await state(page))?.voices.lava ?? 0, LIVE).toBeGreaterThan(0.3);
  // The bombardment's thuds fire as the film plays across them, recording or none: the first is on time.
  const firedAt = await page.evaluate(async (limit) => {
    const hook = (window as unknown as KfHook).__kf;
    const end = performance.now() + limit;
    while (performance.now() < end) {
      if (hook.filmSound?.state()?.shots.includes('ch08:thud')) return hook.app.time;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return -1;
  }, 30_000 * SLOW);
  expect(thuds.some((t) => firedAt >= t && firedAt < t + 1), `a thud fired at ${firedAt.toFixed(2)} s (due at ${thuds.join(', ')} s)`).toBe(true);
  // Meanwhile the chapter's made layers reach the speaker, with none of its recordings in hand.
  expect(await liveLevel(page), 'the made sound, live').toBeGreaterThan(-55);
  expect(held.length, 'its recordings were asked for').toBeGreaterThan(0);
  expect((await state(page))?.recordings, 'none has come').toEqual([]);
  // A chapter rendered while its downloads stall waits only until they are let go (15 s without a byte),
  // then plays its made sound: Chapter 6's churning (its low weight) and the swell of the collapse.
  const ch06 = await render(page, 'ch06');
  const collapse = eventAt(ch06.content, 'collapse');
  const bed = ch06.rms.slice(2, Math.floor(collapse)).map(db);
  expect(Math.min(...bed), 'Chapter 6 before the collapse, without its recording').toBeGreaterThan(-50);
  expect(Math.max(...ch06.rms.slice(Math.ceil(collapse) + 1, Math.ceil(collapse) + 10).map(db)), 'the collapse swell').toBeGreaterThan(median(bed) + 6);
  await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
  expect(pageErrors).toEqual([]);
});

test('a chapter’s recordings are kept with the next chapter’s, fetched while it plays, and all let go when the explorer opens', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.openChapter('ch07', { autoplay: true, t: 2 });
  await page.keyboard.press('Shift');
  // Chapter 7's (the vent's hiss, the thunder of its swell) and then Chapter 8's, and no others.
  const held = async (): Promise<string[]> => [...((await state(page))?.recordings ?? [])].sort();
  await expect.poll(held, LIVE).toEqual(['bolide', 'crackle', 'lava', 'mud', 'rain', 'steam', 'surf', 'thunder']);
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.openUniverse();
  });
  await waitForUniverse(page);
  await expect
    .poll(async () => {
      const s = await state(page);
      return s ? { chapter: s.chapter, recordings: s.recordings } : 'no score';
    }, LIVE)
    .toEqual({ chapter: null, recordings: [] });
  expect(pageErrors).toEqual([]);
});

test('with every recording missing, the chapters that use them still play their made sound, without an error', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await page.route('**/assets/sound/*.m4a', (route) => route.fulfill({ status: 404, body: '' }));
  await kf.open('/');
  for (const chapter of ['ch06', 'ch07', 'ch08', 'ch09', 'ch10'] as const) {
    const { rms, content } = await render(page, chapter);
    expect(rms.length, chapter).toBe(Math.ceil(content.duration));
    expect(rms.every(Number.isFinite), `${chapter}: every second's level is a number`).toBe(true);
    const heard = rms.map(db).filter((v) => v > -80);
    expect(heard.length, `${chapter}: seconds with sound`).toBeGreaterThan(content.duration / 4);
    expect(median(heard), `${chapter}: its usual level without its recordings`).toBeGreaterThan(-50);
  }
  // The browser logs each missing file; nothing else may go wrong.
  expect(pageErrors.filter((e) => !/Failed to load resource: .*404.*assets\/sound\//u.test(e))).toEqual([]);
});

test('rendered, every chapter is clear of clipping and near silent under its verses, its silences kept', async ({ page, kf, pageErrors }) => {
  test.setTimeout(240_000 * SLOW);
  await kf.open('/');
  for (const chapter of CHAPTERS) {
    const { rms, peak, content } = await render(page, chapter);
    expect(rms.length, chapter).toBe(Math.ceil(content.duration));
    expect(rms.every(Number.isFinite), `${chapter}: every second's level is a number`).toBe(true);
    // Headroom: nothing near full scale (the limiter is a safeguard, not the mix).
    expect(Math.max(...peak), `${chapter}: peak`).toBeLessThan(0.5);
    // Under a verse (after the duck's first three seconds), near silence: 15 dB under the chapter's sound
    // around it, or under -60 dB where that sound is itself barely there (Chapter 0's faint hush).
    const inVerse = new Set<number>();
    for (const cue of content.cues) {
      if (cue.type !== 'verse') continue;
      for (let s = Math.ceil(cue.t + 3); s < cue.t + cue.duration - 1; s += 1) inVerse.add(s);
    }
    const outside = rms.flatMap((r, s) => (inVerse.has(s) || db(r) < -80 ? [] : [db(r)]));
    const inside = rms.flatMap((r, s) => (inVerse.has(s) ? [db(r)] : []));
    if (inside.length > 0 && outside.length > 0) {
      expect(median(inside), `${chapter}: under its verses (${median(inside).toFixed(0)} dB) against around them (${median(outside).toFixed(0)} dB)`).toBeLessThan(Math.max(-60, median(outside) - 15));
    }
    // Never louder than a quiet room's worth of sound for long: the beds sit at -26 dB or under.
    expect(median(outside), `${chapter}: its usual level`).toBeLessThan(-26);
    // After a verse or a hadith card the sound comes back over seconds, never with a jump (where it was not silent).
    for (const cue of content.cues) {
      if (cue.type !== 'verse' && cue.type !== 'hadith') continue;
      const end = Math.ceil(cue.t + cue.duration);
      for (let s = end - 1; s < Math.min(rms.length - 1, end + 8); s += 1) {
        if (db(rms[s] ?? 0) < -60) continue;
        expect(db(rms[s + 1] ?? 0) - db(rms[s] ?? 0), `${chapter}: second ${s + 1}, after the card at ${cue.t}`).toBeLessThan(12);
      }
    }
  }
  expect(pageErrors).toEqual([]);
});

test('the silences and the sounds the picture asks for are where the screenplay puts them', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  await kf.open('/');
  const dbAt = (rms: readonly number[], from: number, to: number): number[] => rms.slice(Math.ceil(from), Math.floor(to)).map(db);
  // Chapter 0: four seconds of silence, then one breath as the word forms.
  const ch00 = await render(page, 'ch00');
  const reveal = eventAt(ch00.content, 'kun-reveal');
  expect(Math.max(...dbAt(ch00.rms, 0, reveal))).toBe(-Infinity);
  expect(Math.max(...dbAt(ch00.rms, reveal, reveal + 3))).toBeGreaterThan(-50);
  // Chapter 2: the plasma rings until recombination, then its sound is gone until the Planck sky opens.
  const ch02 = await render(page, 'ch02');
  const recombination = eventAt(ch02.content, 'recombination');
  expect(Math.min(...dbAt(ch02.rms, 1, recombination - 1))).toBeGreaterThan(-45);
  expect(Math.max(...dbAt(ch02.rms, recombination + 8, eventAt(ch02.content, 'cmb-reveal') + 2))).toBeLessThan(-70);
  // Chapter 6: the churning of convection (a recording, slowed) from the start.
  const ch06 = await render(page, 'ch06');
  expect(Math.min(...dbAt(ch06.rms, 2, eventAt(ch06.content, 'collapse')))).toBeGreaterThan(-42);
  // Chapter 7: the Sun's own modes when it is seen close (before the verse).
  const ch07 = await render(page, 'ch07');
  const clear = eventAt(ch07.content, 'clear');
  expect(Math.min(...dbAt(ch07.rms, clear + 6, clear + 12))).toBeGreaterThan(-42);
  // Chapter 8: lava from the start, then rain once the oceans begin (both recordings).
  const ch08 = await render(page, 'ch08');
  const oceans = eventAt(ch08.content, 'oceans');
  expect(Math.min(...dbAt(ch08.rms, 2, eventAt(ch08.content, 'impact')))).toBeGreaterThan(-42);
  expect(Math.min(...dbAt(ch08.rms, oceans + 6, oceans + 10))).toBeGreaterThan(-42);
  // Chapter 9: under the sea, among rising bubbles, before its verse.
  const ch09 = await render(page, 'ch09');
  expect(Math.min(...dbAt(ch09.rms, 2, (ch09.content.cues.find((c) => c.type === 'verse')?.t ?? 30) - 2))).toBeGreaterThan(-42);
  // Chapter 10: silence for the verses of the end, and silence to close.
  const ch10 = await render(page, 'ch10');
  const still = eventAt(ch10.content, 'still');
  expect(Math.max(...dbAt(ch10.rms, still + 4, eventAt(ch10.content, 'fold')))).toBeLessThan(-70);
  expect(Math.max(...dbAt(ch10.rms, eventAt(ch10.content, 'silence') + 4, ch10.content.duration))).toBeLessThan(-70);
  expect(pageErrors).toEqual([]);
});

test('live: the speaker turns it on and off, it ducks under a verse, a seek fires nothing, a pause suspends it', async ({ page, kf, pageErrors }) => {
  test.setTimeout(180_000 * SLOW);
  const content = chapterContent('ch02');
  const recombination = eventAt(content, 'recombination');
  await kf.openChapter('ch02', { autoplay: true, t: 2 });
  const speaker = page.getByTestId('sound-toggle');
  await expect(speaker).toHaveAttribute('aria-pressed', 'true');
  await expect(speaker).toHaveAccessibleName(en['ui.header.sound'] ?? '?');
  // Browsers let sound begin only after a touch of the page: a key will do.
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await state(page))?.voices.roar ?? 0, LIVE).toBeGreaterThan(0.5);
  expect((await state(page))?.level).toBe(1);
  // A seek across recombination fires no exhale; playing across it does.
  await page.evaluate((t) => { (window as unknown as KfHook).__kf.app.seek(t); }, recombination + 2);
  await expect.poll(async () => (await state(page))?.voices.roar ?? 1, LIVE).toBe(0);
  expect((await state(page))?.shots ?? []).not.toContain('ch02:exhale');
  await page.evaluate((t) => { (window as unknown as KfHook).__kf.app.seek(t); }, recombination - 1.5);
  await expect.poll(async () => (await state(page))?.shots ?? [], LIVE).toContain('ch02:exhale');
  // Under a verse: near silence.
  const verse = content.cues.find((c) => c.type === 'verse');
  await page.evaluate((t) => { (window as unknown as KfHook).__kf.app.seek(t); }, (verse?.t ?? 0) + 2);
  await expect.poll(async () => (await state(page))?.duck ?? 1, LIVE).toBeLessThan(0.1);
  // A pause fades the sound and suspends the audio; play starts it again.
  const contextState = (): Promise<string> => page.evaluate(() => ((window as unknown as KfHook).__kf.app.audio.bus('scene') as GainNode).context.state);
  await page.keyboard.press('Space');
  await expect.poll(contextState, LIVE).toBe('suspended');
  await page.keyboard.press('Space');
  await expect.poll(contextState, LIVE).toBe('running');
  // Off: the film's level goes to nothing and its voices are let go; the choice is kept.
  await speaker.click();
  await expect(speaker).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await state(page))?.level ?? 1, LIVE).toBe(0);
  await expect
    .poll(async () => {
      const s = await state(page);
      return s ? s.chapter : 'no score';
    }, LIVE)
    .toBeNull();
  await page.reload();
  await kf.waitForChapterReady('ch02');
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  const results = await new AxeBuilder({ page }).include('.kf-header').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('the film’s speaker and the explorer’s Sound are one choice', async ({ page, kf, pageErrors }) => {
  test.setTimeout(150_000 * SLOW);
  await kf.openChapter('ch07', { t: 150 });
  await page.getByTestId('sound-toggle').click();
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => { (window as unknown as KfHook).__kf.app.openUniverse(); });
  await waitForUniverse(page);
  const toggle = page.getByTestId('universe-nav-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(page.getByTestId('universe-sound')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => page.evaluate(() => (window as unknown as KfHook).__kf.universe.state()?.sound.on), LIVE).toBe(false);
  // And back: the explorer's button turns it on for the film too.
  await page.getByTestId('universe-sound').click();
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(pageErrors).toEqual([]);
});
