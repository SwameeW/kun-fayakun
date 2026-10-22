/**
 * Rule i: no Arabic script anywhere under src/, written literally or as an escape
 * (a backslash-u escape of U+0643, or "&#x643;"). Exceptions: U+FDFA in src/i18n/*.json
 * (honorific after the Prophet's name) and all of src/i18n/ar.json (UI strings).
 */
import { basename, dirname, extname } from 'node:path';
import { SALAWAT_LIGATURE, findArabic, findArabicEscapes } from '../arabic';
import type { ValidationContext } from '../context';
import { listTextFiles, readText, relPath, rootPath } from '../files';
import type { RuleLog } from '../report';

const MAX_HITS_PER_FILE = 10;

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function checkArabicInSrc(_ctx: ValidationContext, log: RuleLog): void {
  const i18nDir = rootPath('src', 'i18n');
  const files = listTextFiles(rootPath('src'));
  let scanned = 0;
  for (const file of files) {
    const inI18n = dirname(file) === i18nDir && extname(file) === '.json';
    if (inI18n && basename(file) === 'ar.json') continue;
    scanned += 1;
    const text = readText(file);
    const allowed = (cp: number): boolean => inI18n && cp === SALAWAT_LIGATURE;
    const hits = [
      ...findArabic(text).map((h) => ({ ...h, kind: 'Arabic code point' })),
      ...findArabicEscapes(text).map((h) => ({ ...h, kind: 'Arabic code point written as an escape' })),
    ].filter((h) => !allowed(h.codePoint));
    hits.slice(0, MAX_HITS_PER_FILE).forEach((h) => {
      log.fail(`${relPath(file)}:${h.line}:${h.column}: ${h.kind} ${hex(h.codePoint)}`);
    });
    if (hits.length > MAX_HITS_PER_FILE) log.fail(`${relPath(file)}: ${hits.length - MAX_HITS_PER_FILE} more Arabic code point(s)`);
  }
  if (log.count('fail') === 0) {
    log.pass(`${scanned} file(s) under src/ contain no Arabic script, literal or escaped (U+FDFA allowed in src/i18n/*.json; src/i18n/ar.json exempt)`);
  }
}
