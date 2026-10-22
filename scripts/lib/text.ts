/** Unicode normalisation and hashing helpers. */
import { createHash } from 'node:crypto';

/** NFC form. Every Arabic string in data/quran.json is stored this way. */
export function nfc(text: string): string {
  return text.normalize('NFC');
}

/** sha256 (lowercase hex) of raw bytes, or of a string encoded as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Code points of `text` (Arabic marks are separate code points; no grapheme grouping wanted). */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** Number of Unicode code points (not UTF-16 units). */
export function codePointLength(text: string): number {
  return codePoints(text).length;
}

/** "U+0643 U+064F" style listing, so diagnostics never print scripture glyphs. */
export function describeCodePoints(text: string, max = 24): string {
  const cps = codePoints(text).map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
  return cps.length > max ? `${cps.slice(0, max).join(' ')} ...` : cps.join(' ');
}
