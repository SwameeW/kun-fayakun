/**
 * Kun Fayakun Intelligence's panel (src/ai/ui) on the real page, through its own controls:
 * - the Ask button and /: nothing of the assistant loads before the first press; the panel opens and
 *   closes from Ask, / and Esc (and focus goes back to Ask), every key inside it is its own, and
 *   spamming it (open and close 25 times, asking over a running turn, Stop again and again, a double
 *   click on Confirm) leaves one turn running at a time and runs an experiment once;
 * - layout at 390×844, 768×1024, 1280×800 and 1920×1080, on the start, in a chapter, in Explore Mode,
 *   in the explorer and in the laboratory: the panel covers none of the header, the timeline, the
 *   explorer's way back, readout or navigator, the page never scrolls sideways and no text is cut off;
 *   the explorer frames its world beside the column; the header fits a 390 px phone;
 * - the guide through the interface: "Fly to Mars" (and Undo), "What if the Sun were twice as
 *   massive?" (a card: Cancel changes nothing, Confirm does, with the test engine attached while it
 *   waits named on the answer; Undo refused with its reason while a later edit sits on top, then
 *   putting it back), "Show verse 21:30" (from data, no transliteration), "Escape speed of Mars" (a
 *   table with its source);
 * - what Ask fetches: no Arabic typeface until a verse is shown;
 * - the scripted test engine (labelled as such) and the guards' notes; an engine that stops working
 *   (let go: the guide answers, and the page's live region says so with the answer);
 * - the settings: the explanation level, opt-in memory (the conversation back after a reload),
 *   clearing the conversation;
 * - axe: no serious or critical violations in the open panel.
 * The model on this device has its own spec (tests/ai-panel-model.spec.ts, with model hosts that
 * resolve nowhere), and so has the phone (tests/ai-panel-mobile.spec.ts, the mobile project).
 */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { ask, LIVE, openPanel, panel, ready, realErrors, REPORT, s, turns } from './support/ai';
import { SLOW } from './support/env';
import { expect, test, type KfHook } from './support/fixtures';
import { boxes, chromeCovered, clippedText, sidewaysOverflow, type ChromeName } from './support/panel-layout';
import { waitForUniverse } from './support/universe';

test.use({ reducedMotion: 'reduce' });

/* eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures argument destructured even when none is used. */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'webgpu' && testInfo.project.name !== 'webgl2', 'runs on the webgpu and webgl2 projects');
  test.setTimeout(240_000 * SLOW);
});

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

const sunMass = (page: Page): Promise<number | null> => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.find((b) => b.id === 'sun')?.massKg ?? null);

/* ------------------------------------------------------------------ */
/* The Ask button, / and Esc                                            */
/* ------------------------------------------------------------------ */

test('Ask loads the panel only when pressed; / opens it, Esc closes it and focus returns to Ask; keys inside are its own', async ({ page, kf, pageErrors }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    fetched.push(new URL(r.url()).pathname);
  });
  await kf.open('/');
  await ready(page);
  await page.waitForTimeout(500);
  // The assistant's code (its panel's chunk and the assistant's own) is not fetched before Ask.
  expect(fetched.filter((p) => /\/assets\/(?:ui|boot)-[\w-]+\.(?:js|css)$/u.test(p))).toEqual([]);
  const askButton = page.getByTestId('ask');
  await expect(askButton).toHaveAccessibleName(/^Ask/u);
  await expect(askButton).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('/');
  await expect(panel(page)).toBeVisible(LIVE);
  expect(fetched.some((p) => /\/assets\/ui-[\w-]+\.js$/u.test(p))).toBe(true);
  await expect(askButton).toHaveAttribute('aria-expanded', 'true');
  await expect(askButton).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('ai-input')).toBeFocused();
  await expect(panel(page)).toHaveAttribute('data-kf-keys', 'own');
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.guide'));
  // No live region inside: screen readers hear one line per finished answer (the page's announcer), never each word.
  await expect(panel(page).locator('[aria-live]')).toHaveCount(0);

  // Typed keys stay in the field: ? and / are text there, not shortcuts.
  await page.keyboard.type('what is / this?');
  await expect(page.getByTestId('ai-input')).toHaveValue('what is / this?');
  await expect(page.locator('dialog.kf-dialog:not(.kf-ai)[open]')).toHaveCount(0);
  // Shift and Enter is a new line; Enter alone sends.
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByTestId('ai-input')).toHaveValue('what is / this?\n');
  await page.getByTestId('ai-input').fill('');

  // A suggestion asks itself.
  const chip = page.getByTestId('ai-suggestion').first();
  const suggested = (await chip.textContent()) ?? '?';
  await chip.click();
  await expect(turns(page).first().locator('.kf-ai-question')).toHaveText(suggested);
  await expect(turns(page).first()).toHaveAttribute('data-state', 'done', LIVE);
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'done');

  await page.getByTestId('ai-input').focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(askButton).toBeFocused();
  await expect(askButton).toHaveAttribute('aria-expanded', 'false');
  // The home screen is still there: Esc closed the panel and nothing else.
  await expect(page.getByTestId('intro')).toBeVisible();

  // The close button too; and the shortcuts list names /.
  await askButton.click();
  await expect(panel(page)).toBeVisible();
  await page.getByTestId('ai-close').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(askButton).toBeFocused();
  await page.keyboard.press('?');
  await expect(page.locator('.kf-shortcuts')).toContainText('/');
  await expect(page.locator('.kf-shortcuts')).toContainText('Ask a question or give a command');
  expect(realErrors(pageErrors)).toEqual([]);
});

test('spam: 25 opens and closes by click and by / and Esc, a question over a running turn, Stop again and again', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  const askButton = page.getByTestId('ask');
  await openPanel(page);
  for (let i = 0; i < 24; i++) await askButton.click();
  // An even number of presses after the first: open, one panel only.
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page)).toBeVisible();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('/');
    await page.keyboard.press('Escape');
  }
  await expect(panel(page)).toHaveCount(0);
  await expect(askButton).toBeFocused();
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // A slow scripted reply, so a turn is still running when the next question comes.
  await openPanel(page);
  const long = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
  const script = [
    { format: 'json' as const, match: 'story', reply: JSON.stringify({ intent: 'answer', query: 'stars', calls: [] }) },
    { format: 'text' as const, match: 'story', reply: long },
  ];
  await page.evaluate(async (sc) => {
    const hook = (window as unknown as KfHook).__kf.ai;
    await hook.start();
    await (window as unknown as KfHook).__kf.ai.useScripted(sc, { delayMs: 40 });
  }, script);
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.scripted'));
  const first = await ask(page, 'Tell me a long story about the stars', 'answering');
  await expect(page.getByTestId('ai-stop')).toBeVisible();
  const second = await ask(page, 'Another story, please', 'answering');
  await expect(first).toHaveAttribute('data-state', 'cancelled');
  await expect(second).toHaveAttribute('data-state', 'answering');
  // Stop, then the same handler again and again (the button is gone after the first press).
  await page.getByTestId('ai-stop').click();
  for (let i = 0; i < 5; i++) await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-testid="ai-stop"]')?.click());
  await expect(second).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByTestId('ai-stop')).toBeHidden();
  expect(await turns(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-state')))).toEqual(['cancelled', 'cancelled']);
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'cancelled');
  // A shown text never grew after its turn was stopped.
  const shown = await second.locator('.kf-ai-prose').textContent();
  await page.waitForTimeout(500);
  expect(await second.locator('.kf-ai-prose').textContent()).toBe(shown);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('a question over one being stopped, through the panel: Stop then ask, Enter twice, a suggestion, closed and opened, the guide chosen: the next answer always comes and the engine never has two', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  // A stopped reply takes 400 ms to end, as a model finishes the token or the prompt it is reading.
  const story = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  await page.evaluate(
    async ({ text, report }) => {
      const w = window as unknown as KfHook & { __scripted?: unknown };
      await w.__kf.ai.start();
      await (window as unknown as KfHook).__kf.ai.useReport(report);
      // Stories are long; anything else is answered at once (the replies are made here: a match by function does not cross into the page).
      w.__scripted = await (window as unknown as KfHook).__kf.ai.useScripted(
        [
          { format: 'json', match: 'story', reply: JSON.stringify({ intent: 'answer', query: 'stars', calls: [] }) },
          { format: 'text', match: 'story', reply: text },
          { format: 'json', match: () => true, reply: JSON.stringify({ intent: 'answer', query: 'mars', calls: [] }) },
          { format: 'text', match: () => true, reply: 'A short answer.' },
        ],
        { delayMs: 30, stopMs: 400 },
      );
    },
    { text: story, report: REPORT },
  );
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.scripted'));
  const mostAtOnce = (): Promise<number> => page.evaluate(() => (window as unknown as { __scripted: { mostAtOnce: number } }).__scripted.mostAtOnce);
  const running = (): Promise<number> => page.evaluate(() => (window as unknown as { __scripted: { running: number } }).__scripted.running);

  // Stop, then a new question at once.
  const first = await ask(page, 'Tell me a long story about the stars', 'answering');
  await page.getByTestId('ai-stop').click();
  const second = await ask(page, 'Why is Mars red?');
  await expect(first).toHaveAttribute('data-state', 'cancelled');
  await expect(second.locator('.kf-ai-prose')).toHaveText('A short answer.');

  // A second question sent over the first (Enter twice).
  const third = await ask(page, 'Another long story, please', 'answering');
  const fourth = await ask(page, 'Why is Venus hot?');
  await expect(third).toHaveAttribute('data-state', 'cancelled');
  await expect(fourth.locator('.kf-ai-prose')).toHaveText('A short answer.');

  // A suggested question pressed while it answers.
  const fifth = await ask(page, 'One more long story', 'answering');
  const before = await turns(page).count();
  await page.getByTestId('ai-suggestion').first().click();
  const chip = turns(page).nth(before);
  await expect(chip).toHaveAttribute('data-state', 'done', LIVE);
  await expect(fifth).toHaveAttribute('data-state', 'cancelled');

  // Closed and opened while it answers: nothing is stopped, and the story is written to its end.
  const sixth = await ask(page, 'A last long story', 'answering');
  await page.getByTestId('ai-close').click();
  await expect(panel(page)).toHaveCount(0);
  await openPanel(page);
  await expect(sixth).toHaveAttribute('data-state', 'done', LIVE);
  await expect(sixth.locator('.kf-ai-prose')).toHaveText(story);

  // The guide chosen (the model section's own button) while a story is written; then the guide answers.
  const seventh = await ask(page, 'Yet another long story', 'answering');
  const section = page.getByTestId('ai-model');
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator('summary').click();
  await section.getByTestId('ai-use-guide').click();
  await expect(seventh).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.guide'));
  const eighth = await ask(page, 'Escape speed of Mars');
  await expect(eighth).toHaveAttribute('data-state', 'done');

  // Never two generations at once, none left running, and the turn hook on the last turn.
  expect(await mostAtOnce()).toBe(1);
  await expect.poll(running).toBe(0);
  await expect(page.locator('html')).toHaveAttribute('data-ai-turn', 'done');
  await expect(page.getByTestId('ai-stop')).toBeHidden();
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* The guide, through the interface                                     */
/* ------------------------------------------------------------------ */

test('"Fly to Mars": the explorer arrives at Mars, the card says done, and Undo returns', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  const turn = await ask(page, 'Fly to Mars');
  const card = turn.getByTestId('ai-action');
  await expect(card).toHaveAttribute('data-status', 'done');
  await expect(card.getByTestId('ai-action-status')).toHaveText(s('ai.ui.action.status.done'));
  await expect(turn.getByTestId('ai-author')).toHaveText(s('ai.ui.by.guide'));
  await waitForUniverse(page);
  expect(await page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.focus)).toBe('mars');
  // The column stands beside the explorer, which frames Mars in the rest of the view.
  await expect(page.locator('html')).toHaveClass(/kf-ai-side-open/u);
  const inset = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kf-ai-inset')));
  const box = await panel(page).boundingBox();
  expect(inset).toBeCloseTo((box?.x ?? 0) + (box?.width ?? 0), 0);
  // With the panel open but not focused, the scene's keys are the scene's: ] makes time run faster.
  const rate = (): Promise<number> => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.time.rate ?? 0);
  const before = await rate();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press(']');
  await expect.poll(rate).toBeGreaterThan(before);
  await expect(panel(page)).toBeVisible();

  await card.getByTestId('ai-undo').click();
  await expect(turn.locator('[data-block="notice"]').last()).toContainText('Put back as it was');
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()), LIVE).toBeNull();
  await expect(card.getByTestId('ai-undo')).toHaveCount(0);
  // The explorer has gone, so nothing is framed beside the column; the panel stays open.
  await expect(panel(page)).toBeVisible();
  expect(realErrors(pageErrors)).toEqual([]);
});

test('"What if the Sun were twice as massive?": a card that waits; Cancel changes nothing, Confirm (double-clicked) once, Undo restores', async ({ page, kf, pageErrors }) => {
  await kf.open('/universe/earth');
  await waitForUniverse(page);
  await openPanel(page);
  // A refusal says why on its card: a date before the span the data covers.
  const refused = (await ask(page, 'set the date to 1500-01-01')).getByTestId('ai-action');
  await expect(refused).toHaveAttribute('data-status', 'refused');
  await expect(refused.getByTestId('ai-action-status')).toHaveText(/^Not done: .*\d{4}-\d{2}-\d{2}/u);
  await ask(page, 'open the lab');
  await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), LIVE).toBe(10);
  const mass = (await sunMass(page)) ?? 0;
  expect(mass).toBeGreaterThan(1e30);

  const waiting = await ask(page, 'What if the Sun were twice as massive?', 'awaiting-confirmation');
  const card = waiting.getByTestId('ai-action');
  await expect(card).toHaveAttribute('data-status', 'awaiting');
  await expect(card.locator('.kf-ai-label')).toHaveText(s('ai.ui.action.experiment'));
  await expect(card.locator('.kf-ai-preview')).not.toBeEmpty();
  await expect(waiting.getByTestId('ai-turn-state')).toHaveText(s('ai.ui.state.awaiting'));
  await page.waitForTimeout(800);
  expect(await sunMass(page)).toBe(mass);
  await card.getByTestId('ai-cancel').click();
  await expect(card).toHaveAttribute('data-status', 'cancelled');
  await expect(card.getByTestId('ai-action-status')).toHaveText(s('ai.ui.action.status.cancelled'));
  await page.waitForTimeout(500);
  expect(await sunMass(page)).toBe(mass);

  const again = await ask(page, 'What if the Sun were twice as massive?', 'awaiting-confirmation');
  const card2 = again.getByTestId('ai-action');
  // A model attached while the card waits writes the answer after Confirm, and is the one named on it.
  await page.evaluate(async () => {
    await (window as unknown as KfHook).__kf.ai.useScripted([{ format: 'text', match: 'massive', reply: 'The laboratory now shows the Sun at twice its mass.' }]);
  });
  await card2.getByTestId('ai-confirm').dblclick();
  await expect(again).toHaveAttribute('data-state', 'done', LIVE);
  await expect(card2).toHaveAttribute('data-status', 'done');
  await expect(again.locator('[data-block="text"]').getByTestId('ai-author')).toHaveText(s('ai.ui.by.scripted'));
  // Once: twice the mass, not four times.
  await expect.poll(async () => ((await sunMass(page)) ?? 0) / mass, LIVE).toBeCloseTo(2, 6);
  await page.waitForTimeout(800);
  expect(((await sunMass(page)) ?? 0) / mass).toBeCloseTo(2, 6);

  // An edit by hand on top (as the laboratory's panel sends it): the card's Undo is refused, with why, and changes nothing.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeLab({ kind: 'remove', id: 'jupiter' });
  });
  const hasJupiter = (): Promise<boolean> => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.some((b) => b.id === 'jupiter') ?? false);
  await expect.poll(hasJupiter, LIVE).toBe(false);
  await card2.getByTestId('ai-undo').click();
  await expect(card2.getByTestId('ai-undo-refused')).toContainText('changed since', LIVE);
  await page.waitForTimeout(800);
  expect(((await sunMass(page)) ?? 0) / mass).toBeCloseTo(2, 6);
  expect(await hasJupiter()).toBe(false);
  await expect(again.locator('[data-block="notice"]', { hasText: 'Put back as it was' })).toHaveCount(0);
  // That edit undone in the laboratory, the card's Undo puts the Sun back.
  await page.evaluate(() => {
    (window as unknown as KfHook).__kf.app.universeLab({ kind: 'undo' });
  });
  await expect.poll(hasJupiter, LIVE).toBe(true);
  await expect(card2.getByTestId('ai-undo')).toBeEnabled();
  await card2.getByTestId('ai-undo').click();
  await expect.poll(async () => Math.abs(((await sunMass(page)) ?? 0) / mass - 1), LIVE).toBeLessThan(1e-9);
  await expect(again.locator('[data-block="notice"]').last()).toContainText('Put back as it was');
  expect(realErrors(pageErrors)).toEqual([]);
});

test('Ask fetches what the panel needs and no more: the Arabic typeface only once a verse is shown', async ({ page, kf, pageErrors }, testInfo) => {
  await kf.open('/');
  await ready(page);
  await page.waitForTimeout(500);
  const fetched: { path: string; bytes: Promise<number> }[] = [];
  page.on('requestfinished', (r) => {
    fetched.push({ path: new URL(r.url()).pathname, bytes: r.sizes().then((sz) => sz.responseBodySize, () => 0) });
  });
  await openPanel(page);
  await page.waitForTimeout(1500);
  const onOpen = await Promise.all(fetched.map(async (f) => ({ path: f.path, bytes: await f.bytes })));
  const total = onOpen.reduce((n, f) => n + f.bytes, 0);
  testInfo.annotations.push({ type: 'ask-bytes', description: `${total} bytes on open: ${onOpen.map((f) => `${f.path.split('/').pop() ?? ''} ${f.bytes}`).join(', ')}` });
  expect(onOpen.filter((f) => f.path.endsWith('.woff2'))).toEqual([]);
  // About 113 KB as served (gzip): the code, the scripture catalogue's two data files and the plain words (docs/AI-INTELLIGENCE.md §2).
  expect(total).toBeLessThan(130_000);
  await ask(page, 'Show verse 21:30');
  await expect.poll(() => fetched.some((f) => f.path.endsWith('/fonts/AmiriQuran.woff2')), LIVE).toBe(true);
  expect(realErrors(pageErrors)).toEqual([]);
});

test('"Show verse 21:30" shows the verse from data, labelled scripture; "Escape speed of Mars" a table with its source', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  const verseTurn = await ask(page, 'Show verse 21:30');
  const verse = verseTurn.locator('[data-block="verse"]');
  await expect(verse.locator('.kf-ai-label')).toHaveText(s('ai.ui.kind.scripture'));
  const quran = JSON.parse(readFileSync(new URL('../data/quran.json', import.meta.url), 'utf8')) as { ayat: Array<{ key: string; translation: string; translit: string }> };
  const entry = quran.ayat.find((a) => a.key === '21:30');
  await expect(verse.locator('[data-verse="21:30"] .kf-translation')).toHaveText(entry?.translation ?? '?');
  // The transliteration is not the assistant's to show.
  await expect(verse.locator('.kf-translit')).toHaveCount(0);
  expect(await verse.textContent()).not.toContain(entry?.translit.slice(0, 20) ?? '?');
  await expect(verse.locator('.kf-arabic')).toHaveAttribute('lang', 'ar');

  // A hadith: its reference, grading and source, labelled scripture, never its wording.
  const hadithTurn = await ask(page, 'Sahih al-Bukhari 3191');
  const hadith = hadithTurn.locator('[data-block="hadith"]', { has: page.locator('[data-hadith="bukhari-3191"]') });
  await expect(hadith.locator('.kf-ai-label')).toHaveText(s('ai.ui.kind.scripture'));
  await expect(hadith.locator('.kf-grading')).toBeVisible();
  await expect(hadithTurn.locator('[data-block="hadith"] :is(.kf-hadith-text, blockquote)')).toHaveCount(0);

  const factsTurn = await ask(page, 'Escape speed of Mars');
  const table = factsTurn.getByTestId('ai-facts');
  const row = table.locator('[data-fact="calc.escape_speed.mars"]');
  await expect(row).toContainText('km/s');
  const value = Number((await row.locator('.kf-ai-value').textContent())?.replace(/[^\d.]/gu, ''));
  expect(value).toBeCloseTo(5.03, 1);
  const link = row.locator('.kf-ai-source a').first();
  await expect(link).toHaveAttribute('href', /^https:\/\//u);
  await expect(link).toHaveAttribute('rel', /noopener/u);
  await expect(row.locator('td[data-kind]')).toHaveText(/^(observed|model|simulation)$/u);
  await expect(table.locator('caption')).toHaveText(s('ai.ui.facts.caption'));
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* The scripted engine and the guards                                   */
/* ------------------------------------------------------------------ */

test('the scripted engine is labelled "Test engine", and the guards’ changes are noted under its words', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  const answer = 'Leaving Mars takes about 5.027 km/s [[fact:calc.escape_speed.mars]]. This proves the planets were made weak. Its day lasts 31.7 hours and its year 687 days.';
  const script = [
    { format: 'json' as const, match: 'leave mars', reply: JSON.stringify({ intent: 'answer', query: 'escape speed mars', calls: [{ tool: 'calc.escape_speed', args: { body: 'mars' } }] }) },
    { format: 'text' as const, match: 'leave mars', reply: answer },
  ];
  await page.evaluate(async (sc) => {
    const hook = (window as unknown as KfHook).__kf.ai;
    await hook.start();
    await (window as unknown as KfHook).__kf.ai.useScripted(sc);
  }, script);
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.scripted'));
  const turn = await ask(page, 'How hard is it to leave Mars, really?');
  const text = turn.locator('[data-block="text"]');
  await expect(text.getByTestId('ai-author')).toHaveText(s('ai.ui.by.scripted'));
  await expect(text.locator('.kf-ai-prose')).toContainText('Leaving Mars takes about 5.027 km/s.');
  await expect(text.locator('.kf-ai-prose')).not.toContainText('proves');
  await expect(text.locator('.kf-ai-prose')).not.toContainText('[[');
  const flags = text.getByTestId('ai-flags');
  await expect(flags).toContainText(s('ai.ui.flags.title'));
  // The note counts the numbers marked "not checked" in the words shown.
  const unchecked = ((await text.locator('.kf-ai-prose').textContent()) ?? '').split('(not checked)').length - 1;
  expect(unchecked).toBeGreaterThan(0);
  await expect(flags).toContainText(unchecked === 1 ? '1 number in this explanation was not found in the data' : `${unchecked} numbers in this explanation were not found in the data`);
  await expect(flags).toContainText(s('ai.ui.flag.banned-phrase'));
  // The fact it cites is a table from the calculator, not the model's number.
  await expect(turn.locator('[data-fact="calc.escape_speed.mars"]')).toBeVisible();
  expect(realErrors(pageErrors)).toEqual([]);
});

test('an engine that stops working is let go: the turn says so, and the page’s live region says to choose the model again', async ({ page, kf, pageErrors }) => {
  const mind = JSON.parse(readFileSync(new URL('../src/i18n/en.ai.mind.json', import.meta.url), 'utf8')) as Record<string, string>;
  const lost = (mind['ai.mind.announce.engineLost'] ?? '?').replace('{model}', 'scripted');
  const answered = mind['ai.mind.announce.answer'] ?? '?';
  // The page's one live region (src/ui/announcer.ts): it writes only the last of announcements made within 60 ms.
  const region = page.locator('div.kf-sr-only[aria-live="polite"][aria-atomic="true"]');
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  await page.evaluate(async () => {
    const hook = (window as unknown as KfHook).__kf.ai;
    await hook.start();
    // Its first generation (the plan) ends it, as a model whose worker ended.
    await hook.useScripted([{ format: 'json', match: 'stars', reply: '', loses: true }]);
  });
  await expect(page.getByTestId('ai-engine')).toHaveText(s('ai.ui.engine.scripted'));
  const turn = await ask(page, 'Why do stars shine?');
  await expect(turn.locator('[data-block="notice"][data-key="ai.mind.notice.engineError"]')).toBeVisible();
  await expect(turn.locator('[data-block="text"]')).toHaveAttribute('data-by', 'guide');
  await expect(region).toHaveText(`${lost} ${answered}`);
  // It stays written: nothing said after it replaces it.
  await page.waitForTimeout(500);
  await expect(region).toHaveText(`${lost} ${answered}`);
  expect(await page.evaluate(async () => (await (window as unknown as KfHook).__kf.ai.start()).engine().state)).toBe('error');
  // The next question is the guide's, and the model is not named again.
  const next = await ask(page, 'Why is Mars red?');
  await expect(next.locator('[data-block="text"]')).toHaveAttribute('data-by', 'guide');
  await expect(region).toHaveText(answered);
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

/** How many turns the opt-in memory holds in this browser (none when its database was never made). */
const keptTurns = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'kf-ai')) return 0;
    return new Promise<number>((resolve) => {
      const open = indexedDB.open('kf-ai');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('turns')) {
          db.close();
          resolve(0);
          return;
        }
        const count = db.transaction('turns').objectStore('turns').count();
        count.onsuccess = () => {
          db.close();
          resolve(count.result);
        };
      };
      open.onerror = () => {
        resolve(0);
      };
    });
  });

test('settings: the explanation level reaches the assistant and is remembered; memory is off until chosen, then brings the conversation back; Clear empties it', async ({ page, kf, pageErrors }) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  await ask(page, 'Show verse 21:30');
  const settings = page.getByTestId('ai-settings');
  await settings.locator('summary').click();
  await expect(settings.getByTestId('ai-level-standard')).toBeChecked();
  await expect(settings.getByTestId('ai-memory')).not.toBeChecked();
  await expect(settings).toContainText('kept in this browser’s storage on this device, and nowhere else');
  await expect(settings).toContainText('shown again when you come back');
  await settings.getByTestId('ai-level-deeper').check();
  expect(await page.evaluate(async () => ((await (window as unknown as KfHook).__kf.ai.start()) as unknown as { level(): string }).level())).toBe('deeper');
  expect(await keptTurns(page)).toBe(0);
  await settings.getByTestId('ai-memory').check();
  expect(await page.evaluate(() => localStorage.getItem('kf.ui.aiMemory'))).toBe('1');
  // On: what is asked now is kept, and comes back after a reload, marked as kept.
  await ask(page, 'Escape speed of Mars');
  await expect.poll(() => keptTurns(page), LIVE).toBe(1);
  await page.reload();
  await ready(page);
  await openPanel(page);
  await expect(turns(page)).toHaveCount(1);
  await expect(turns(page).first().locator('.kf-ai-question')).toHaveText('Escape speed of Mars');
  await expect(turns(page).first().locator('[data-block="notice"][data-key="ai.mind.notice.kept"]')).toBeVisible();
  await expect(turns(page).first().getByTestId('ai-author')).toHaveText(s('ai.ui.by.guide'));
  // Off deletes what was kept; Clear empties the conversation; nothing comes back.
  await page.getByTestId('ai-settings').locator('summary').click();
  await page.getByTestId('ai-memory').uncheck();
  expect(await page.evaluate(() => localStorage.getItem('kf.ui.aiMemory'))).toBeNull();
  await expect.poll(() => keptTurns(page), LIVE).toBe(0);
  await page.getByTestId('ai-clear').click();
  await expect(turns(page)).toHaveCount(0);
  // The level is remembered for the next visit.
  await page.reload();
  await ready(page);
  await openPanel(page);
  await expect(turns(page)).toHaveCount(0);
  await page.getByTestId('ai-settings').locator('summary').click();
  await expect(page.getByTestId('ai-level-deeper')).toBeChecked();
  expect(realErrors(pageErrors)).toEqual([]);
});

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

/** Opens the panel, checks it against the chrome, the window and its own text, and closes it again. */
async function checkLayout(page: Page, label: string, except: readonly ChromeName[] = []): Promise<void> {
  await openPanel(page);
  await expect
    .poll(
      async () => {
        const { box } = await boxes(page, { box: '[data-testid="ai-panel"]' });
        return box ? chromeCovered(page, box, except) : ['no panel'];
      },
      // Each poll measures twice; in software rendering at 1920×1080 one measure took 7 s.
      { message: `${label}: the panel covers no chrome`, timeout: LIVE.timeout },
    )
    .toEqual([]);
  expect(await sidewaysOverflow(page), `${label}: the page scrolls sideways`).toBe(0);
  expect(await clippedText(page, '[data-testid="ai-panel"]'), `${label}: text cut off`).toEqual([]);
  const head = await page.locator('.kf-ai-head').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(head, `${label}: the panel's head is whole`).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
}

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
] as const;

for (const size of VIEWPORTS) {
  test(`layout at ${size.width}×${size.height}: start, chapter, Explore Mode, explorer and laboratory`, async ({ page, kf, pageErrors }) => {
    await page.setViewportSize(size);
    const side = size.width >= 900;
    await kf.open('/');
    await ready(page);
    await checkLayout(page, 'start');

    await kf.openChapter('ch02', { autoplay: true, t: 20 });
    await checkLayout(page, 'chapter');
    // A question with a table and scripture, to check them at this width too.
    await openPanel(page);
    await ask(page, 'Escape speed of Mars');
    await ask(page, 'Show verse 21:30');
    await checkLayout(page, 'chapter, with answers');

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('e');
    await expect(page.locator('html')).toHaveAttribute('data-state', 'explore');
    await expect(page.getByTestId('discover')).toBeVisible(LIVE);
    await checkLayout(page, 'Explore Mode');
    if (side) {
      // Beside the column, Discover's dock folds and stays clear of it.
      await openPanel(page);
      await expect(page.getByTestId('discover-collapse')).toHaveAttribute('aria-expanded', 'false');
      const { dock, box } = await boxes(page, { dock: '[data-testid="discover"]', box: '[data-testid="ai-panel"]' });
      expect(dock && box ? dock.left >= box.right : false).toBe(true);
      await page.keyboard.press('Escape');
    }

    await page.evaluate(() => {
      (window as unknown as KfHook).__kf.app.openUniverse('earth');
    });
    await waitForUniverse(page);
    await checkLayout(page, 'explorer');

    await page.evaluate(async () => {
      await (await (window as unknown as KfHook).__kf.ai.start()).ask('open the lab');
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as KfHook).__kf.app.universe()?.lab?.bodies.length ?? 0), LIVE).toBe(10);
    // On a narrow window the laboratory's sheet stays tall even folded: the modal sheet comes up over it (src/ai/ui/layout.ts).
    await checkLayout(page, 'laboratory', side ? [] : ['navigator']);
    expect(realErrors(pageErrors)).toEqual([]);
  });
}

test('the header fits a 390 px phone in a chapter with Ask; at 360 px a touch screen leaves out the shortcuts button', async ({ browser, forceWebGL }) => {
  for (const width of [390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`/?${forceWebGL ? 'forceWebGL=1&' : ''}autoplay=1#/ch/2?t=20`);
    await expect(page.locator('html')).toHaveAttribute('data-chapter-ready', 'ch02', { timeout: 90_000 * SLOW });
    const fit = await page.evaluate(() => {
      const header = document.querySelector('.kf-header');
      const buttons = [...document.querySelectorAll<HTMLElement>('.kf-header-actions > .kf-btn')].filter((b) => b.getClientRects().length > 0);
      const brand = document.querySelector('.kf-brand-link')?.getBoundingClientRect();
      return { overflow: (header?.scrollWidth ?? 0) - (header?.clientWidth ?? 0), names: buttons.map((b) => b.dataset.testid ?? ''), last: Math.max(...buttons.map((b) => b.getBoundingClientRect().right)), firstLeft: Math.min(...buttons.map((b) => b.getBoundingClientRect().left)), brandRight: brand?.right ?? 0 };
    });
    expect(fit.overflow, `${width}px`).toBeLessThanOrEqual(0);
    expect(fit.last, `${width}px`).toBeLessThanOrEqual(width);
    expect(fit.firstLeft, `${width}px: the brand and the buttons do not meet`).toBeGreaterThan(fit.brandRight);
    expect(fit.names, `${width}px`).toEqual(width >= 380 ? ['shortcuts-button', 'sound-toggle', 'panel-toggle', 'ask'] : ['sound-toggle', 'panel-toggle', 'ask']);
    await context.close();
  }
});

/* ------------------------------------------------------------------ */
/* Accessibility                                                        */
/* ------------------------------------------------------------------ */

test('axe: the open panel, with answers, an action card, the model and the settings, has no serious or critical violations', async ({ page, kf }, testInfo) => {
  await kf.open('/');
  await ready(page);
  await openPanel(page);
  await ask(page, 'Show verse 21:30');
  await ask(page, 'Escape speed of Mars');
  await page.evaluate(async (r) => {
    await (window as unknown as KfHook).__kf.ai.useReport(r);
  }, REPORT);
  await page.getByTestId('ai-model').locator('summary').click();
  await expect(page.getByTestId('ai-suggested')).toBeVisible();
  await page.getByTestId('ai-settings').locator('summary').click();
  await ask(page, 'Open the solar system');
  await waitForUniverse(page);
  const results = await new AxeBuilder({ page }).include('[data-testid="ai-panel"]').withTags(WCAG_TAGS).analyze();
  await testInfo.attach('axe-ai-panel.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ rule: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(' ')) }));
  expect(serious).toEqual([]);
});
