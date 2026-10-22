/** Builds data/quran.json entries from the three pinned Tanzil files. */
import type { QuranEntry, QuranFile, VerseKey } from '../../src/core/types';
import { nfc, sha256Hex } from './text';
import {
  TANZIL_URL,
  TRANSLATION_ID,
  parseTanzil,
  stripTranslitMarkup,
  tanzilVersion,
  type ParsedTanzil,
  type TanzilFile,
} from './tanzil';
import { parseVerseKey } from './verse-key';

/** One raw Tanzil file as downloaded (or read from data/tanzil/). */
export interface RawTanzil {
  file: TanzilFile;
  bytes: Uint8Array;
  sha256: string;
  parsed: ParsedTanzil;
}

export function toRawTanzil(file: TanzilFile, bytes: Uint8Array): RawTanzil {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { file, bytes, sha256: sha256Hex(bytes), parsed: parseTanzil(text, file.filename) };
}

/** Licence summary carried by every entry; the full terms live in LICENSES and sources.json. */
export const ENTRY_LICENSE =
  'Arabic: Tanzil Quran Text (Uthmani), CC BY 3.0, verbatim, source tanzil.net. ' +
  'Translation: M. M. Pickthall (1930), public domain; text file from Tanzil (en.pickthall). ' +
  'Transliteration: Tanzil en.transliteration, non-commercial use only (Tanzil translation terms); HTML markup removed.';

export interface BuildInput {
  arabic: RawTanzil;
  translation: RawTanzil;
  translit: RawTanzil;
  keys: readonly VerseKey[];
  /** ISO time of the fetch that produced the text of `key`. */
  fetchedAt: (key: VerseKey) => string;
  generatedAt: string;
}

function lineFor(raw: RawTanzil, key: VerseKey): string {
  const line = raw.parsed.lines.get(key);
  if (line === undefined) throw new Error(`${raw.file.filename}: no line for ${key}`);
  return line;
}

export function buildQuranFile(input: BuildInput): QuranFile {
  const { arabic, translation, translit } = input;
  const sourceVersion = tanzilVersion(arabic.parsed.comment);
  const ayat = input.keys.map((key): QuranEntry => {
    const parsed = parseVerseKey(key);
    if (!parsed) throw new Error(`Invalid verse key ${key}`);
    const text = nfc(lineFor(arabic, key));
    if (text.trim() === '') throw new Error(`${arabic.file.filename}: empty text for ${key}`);
    return {
      key,
      surah: parsed.surah,
      ayah: parsed.ayah,
      arabic: text,
      translit: stripTranslitMarkup(lineFor(translit, key)),
      translation: lineFor(translation, key),
      translationId: TRANSLATION_ID,
      license: ENTRY_LICENSE,
      source: { arabic: arabic.file.sourceId, translit: translit.file.sourceId, translation: translation.file.sourceId },
      sourceVersion,
      sha256: sha256Hex(text),
      fetchedAt: input.fetchedAt(key),
    };
  });
  return {
    meta: {
      tanzilCopyright: arabic.parsed.comment,
      tanzilUrl: TANZIL_URL,
      files: [arabic, translation, translit].map((raw) => ({
        sourceId: raw.file.sourceId,
        url: raw.file.url,
        sha256: raw.sha256,
        bytes: raw.bytes.byteLength,
      })),
      generatedAt: input.generatedAt,
    },
    ayat,
  };
}
