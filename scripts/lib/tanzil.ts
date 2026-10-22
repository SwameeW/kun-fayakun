/**
 * Tanzil source definitions and parsing of its "sura|aya|text" files.
 *
 * Download options (recorded from tanzil.net/download and tanzil.net/trans on 2026-10-22):
 * - Quran text: quranType=uthmani, outType=txt-2 ("Text (with aya numbers)"), with Tanzil's
 *   default marks: pause marks on, sajdah signs on, rub-el-hizb signs off, tatweel below
 *   superscript alefs on, sequential tanweens off; agree=true accepts the Terms of Use.
 * - Translations: type=txt-2 for en.pickthall and en.transliteration.
 */
import type { SourceId, VerseKey } from '../../src/core/types';
import { rootPath } from './files';
import { toVerseKey } from './verse-key';

export type TanzilFileId = 'quran-uthmani' | 'en.pickthall' | 'en.transliteration';

export interface TanzilFile {
  id: TanzilFileId;
  /** Entry in data/sources.json. */
  sourceId: SourceId;
  role: 'arabic' | 'translation' | 'translit';
  url: string;
  /** File name Tanzil sends in Content-Disposition; stored under data/tanzil/. */
  filename: string;
}

export const TANZIL_URL = 'https://tanzil.net/';

export const TANZIL_FILES: readonly TanzilFile[] = [
  {
    id: 'quran-uthmani',
    sourceId: 'tanzil-uthmani',
    role: 'arabic',
    url: 'https://tanzil.net/pub/download/index.php?marks=true&sajdah=true&tatweel=true&quranType=uthmani&outType=txt-2&agree=true',
    filename: 'quran-uthmani.txt',
  },
  {
    id: 'en.pickthall',
    sourceId: 'tanzil-en-pickthall',
    role: 'translation',
    url: 'https://tanzil.net/trans/?transID=en.pickthall&type=txt-2',
    filename: 'en.pickthall.txt',
  },
  {
    id: 'en.transliteration',
    sourceId: 'tanzil-en-transliteration',
    role: 'translit',
    url: 'https://tanzil.net/trans/?transID=en.transliteration&type=txt-2',
    filename: 'en.transliteration.txt',
  },
];

export const TRANSLATION_ID = 'en.pickthall';

/** Ayat in the Hafs count used by Tanzil. */
export const AYAH_COUNT = 6236;

export function tanzilPath(file: TanzilFile): string {
  return rootPath('data', 'tanzil', file.filename);
}

export function tanzilFile(role: TanzilFile['role']): TanzilFile {
  const found = TANZIL_FILES.find((f) => f.role === role);
  if (!found) throw new Error(`No Tanzil file for role ${role}`);
  return found;
}

export interface ParsedTanzil {
  /** Text after "sura|aya|", exactly as in the file (no trimming, no normalisation). */
  lines: ReadonlyMap<VerseKey, string>;
  /** All "#" comment lines, joined with "\n", exactly as in the file. */
  comment: string;
}

const VERSE_LINE = /^(\d+)\|(\d+)\|(.*)$/;

/** Parses a Tanzil txt-2 file. Throws on any line that is not a verse, a comment or blank. */
export function parseTanzil(text: string, label: string): ParsedTanzil {
  if (text.includes('\r')) throw new Error(`${label}: unexpected CR line endings`);
  const lines = new Map<VerseKey, string>();
  const comment: string[] = [];
  text.split('\n').forEach((line, index) => {
    const match = VERSE_LINE.exec(line);
    if (match) {
      const key = toVerseKey(Number(match[1]), Number(match[2]));
      if (lines.has(key)) throw new Error(`${label}:${index + 1}: duplicate verse ${key}`);
      lines.set(key, match[3] ?? '');
    } else if (line.startsWith('#')) {
      comment.push(line);
    } else if (line.trim() !== '') {
      throw new Error(`${label}:${index + 1}: unrecognised line`);
    }
  });
  if (lines.size !== AYAH_COUNT) throw new Error(`${label}: expected ${AYAH_COUNT} ayat, found ${lines.size}`);
  return { lines, comment: comment.join('\n') };
}

/** "Tanzil Quran Text (Uthmani, Version 1.1)" from the copyright block. */
export function tanzilVersion(copyright: string): string {
  const match = /Tanzil Quran Text \([^)]*\)/.exec(copyright);
  if (!match) throw new Error('Tanzil copyright block has no version line');
  return match[0];
}

/** Value of a "#  Field: value" header line in a Tanzil translation file. */
export function headerField(comment: string, field: string): string | null {
  const match = new RegExp(`^#\\s+${field}:\\s*(.+?)\\s*$`, 'm').exec(comment);
  return match?.[1] ?? null;
}

/**
 * Tanzil's en.transliteration marks long vowels and silent letters with inline HTML
 * (<u>, <b>, <i>, <strong>, any case). The panel shows plain text, so the tags are
 * removed and nothing else is changed. Any other markup is an error.
 */
export function stripTranslitMarkup(line: string): string {
  const plain = line.replace(/<\/?(?:u|b|i|strong)>/gi, '');
  if (/[<>&]/.test(plain)) throw new Error(`Unexpected markup in transliteration: ${plain.slice(0, 60)}`);
  return plain;
}
