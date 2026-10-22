/**
 * Checks that every piece of Arabic on the page is a correctly marked
 * scripture block whose text is byte-identical to data/quran.json.
 */
import { expect, type Page } from '@playwright/test';
import type { ChapterContent, VerseKey } from '../../src/core/types';
import { chapterVerseKeys, panelVerseKeys, quranByKey } from './data';

/**
 * Arabic-script ranges from docs/CONTRACTS.md (hard rule 1), written as
 * escapes so no Arabic character appears in source. U+FDFA, the salawat
 * ligature allowed in English UI strings, and U+FEFF (byte-order mark) are
 * left out because neither is scripture text.
 */
export const ARABIC_PATTERN =
  '[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDF9\\uFDFB-\\uFDFF\\uFE70-\\uFEFE]';

export interface ArabicBlock {
  /** Short description of where the block is, for failure messages. */
  where: string;
  lang: string | null;
  dir: string | null;
  translate: string | null;
  /** From the nearest [data-verse] (or [data-verse-key]) container. */
  verseKey: string | null;
  /** Inside [data-testid=panel]. */
  inPanel: boolean;
  /** Inside the panel or the verse overlay and not inside a hadith block. */
  isVerse: boolean;
  /** textContent with surrounding ASCII whitespace (HTML indentation) removed. */
  text: string;
}

export interface ArabicScan {
  /**
   * Outermost elements with lang="ar". Transliteration is lang="ar-Latn"
   * (Latin script), so it is not a block; Arabic script inside it is a stray.
   */
  blocks: ArabicBlock[];
  /** Arabic text or attribute values that are not inside a lang="ar" block. */
  strays: string[];
}

export async function scanArabic(page: Page): Promise<ArabicScan> {
  return page.evaluate((pattern): ArabicScan => {
    const arabic = new RegExp(pattern, 'u');
    const AR = '[lang="ar" i]';
    const where = (el: Element): string => {
      const owner = el.closest('[data-testid]');
      const id = owner?.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${id ? ` in [data-testid=${id}]` : ''}`;
    };
    const blocks = [...document.querySelectorAll(AR)]
      .filter((el) => !el.parentElement?.closest(AR))
      .map((el) => ({
        where: where(el),
        lang: el.getAttribute('lang'),
        dir: el.getAttribute('dir'),
        translate: el.getAttribute('translate'),
        verseKey:
          el.closest('[data-verse]')?.getAttribute('data-verse') ??
          el.closest('[data-verse-key]')?.getAttribute('data-verse-key') ??
          null,
        inPanel: el.closest('[data-testid="panel"]') !== null,
        isVerse:
          el.closest('[data-testid="panel"], [data-testid="verse-overlay"]') !== null &&
          el.closest('[data-hadith], [data-hadith-id]') === null,
        text: el.textContent.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ''),
      }));

    const strays: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? '';
      const parent = node.parentElement;
      if (!arabic.test(value) || parent?.closest(AR)) continue;
      strays.push(`text in ${parent ? where(parent) : 'body'}`);
    }
    for (const el of document.body.querySelectorAll('[aria-label], [title], [alt], [placeholder]')) {
      for (const name of ['aria-label', 'title', 'alt', 'placeholder']) {
        const value = el.getAttribute(name);
        if (value && arabic.test(value) && !el.closest(AR)) strays.push(`${name} on ${where(el)}`);
      }
    }
    return { blocks, strays };
  }, ARABIC_PATTERN);
}

/**
 * Every Arabic block is lang="ar" dir="rtl" translate="no"; every verse
 * block's text equals the NFC Tanzil text of its key; every verse in the
 * panel's text layer is present. Uses soft assertions to report all problems.
 */
export async function expectVersesVerbatim(page: Page, content: ChapterContent): Promise<void> {
  const quran = quranByKey();
  const allowed = chapterVerseKeys(content);
  const arabicOf = (key: string): string | undefined =>
    quran.get(key as VerseKey)?.arabic.normalize('NFC');
  const scan = await scanArabic(page);

  expect.soft(scan.strays, 'Arabic outside a lang="ar" block').toEqual([]);
  for (const block of scan.blocks) {
    expect.soft(block.lang, `lang of ${block.where}`).toBe('ar');
    expect.soft(block.dir, `dir of ${block.where}`).toBe('rtl');
    expect.soft(block.translate, `translate of ${block.where}`).toBe('no');
    if (block.verseKey) {
      expect.soft(arabicOf(block.verseKey), `${block.verseKey} exists in data/quran.json`).toBeDefined();
      expect.soft(block.text, `${block.where} shows ${block.verseKey} verbatim`).toBe(arabicOf(block.verseKey));
    } else if (block.isVerse) {
      const match = allowed.find((key) => arabicOf(key) === block.text);
      expect
        .soft(match, `${block.where} equals the Tanzil text of one of ${allowed.join(', ')}`)
        .toBeDefined();
    }
  }
  for (const key of panelVerseKeys(content)) {
    const expected = arabicOf(key);
    expect.soft(expected, `${key} exists in data/quran.json`).toBeDefined();
    const shown = scan.blocks.some((block) => block.inPanel && block.text === expected);
    expect.soft(shown, `panel shows ${key} verbatim`).toBe(true);
  }
}
