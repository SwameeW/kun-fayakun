import { IntlMessageFormat } from 'intl-messageformat';
import type { I18n, I18nKey } from '../core/types';
import uiMessages from './en.json';

export type Locale = I18n['locale'];
type Messages = Readonly<Record<I18nKey, string>>;

/**
 * Chapter prose (written by the content builder) and future locale files are
 * picked up by glob so a missing file is reported clearly instead of breaking
 * the build. Arabic UI strings arrive in M4 as ar.json / ar.chapters.json.
 */
const LOCALE_FILES = import.meta.glob<unknown>(['./*.chapters.json', './ar.json'], {
  eager: true,
  import: 'default',
});

const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar']);

function asMessages(raw: unknown, file: string): Messages {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`i18n: ${file} must be a flat object of strings`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue; // "$comment"-style keys document the file
    if (typeof value !== 'string') throw new Error(`i18n: ${file} key "${key}" is not a string`);
    out[key] = value;
  }
  return out;
}

/** Merges message files, throwing if any key is defined twice. */
export function mergeMessages(files: ReadonlyArray<{ name: string; messages: Messages }>): Messages {
  const merged: Record<string, string> = {};
  const origin = new Map<string, string>();
  for (const { name, messages } of files) {
    for (const [key, value] of Object.entries(messages)) {
      const first = origin.get(key);
      if (first !== undefined) throw new Error(`i18n: duplicate key "${key}" in ${first} and ${name}`);
      origin.set(key, name);
      merged[key] = value;
    }
  }
  return merged;
}

function localeFile(path: string): Messages | null {
  const raw = LOCALE_FILES[path];
  return raw === undefined ? null : asMessages(raw, path);
}

function englishMessages(): Messages {
  const files = [{ name: 'en.json', messages: asMessages(uiMessages, 'en.json') }];
  const chapters = localeFile('./en.chapters.json');
  if (chapters) files.push({ name: 'en.chapters.json', messages: chapters });
  else console.error('i18n: src/i18n/en.chapters.json is missing; chapter prose will show its keys');
  return mergeMessages(files);
}

/** Arabic UI strings overlay English; returns null until ar.json exists (M4). */
function arabicMessages(english: Messages): Messages | null {
  const ui = localeFile('./ar.json');
  if (!ui) return null;
  const files = [{ name: 'ar.json', messages: ui }];
  const chapters = localeFile('./ar.chapters.json');
  if (chapters) files.push({ name: 'ar.chapters.json', messages: chapters });
  return { ...english, ...mergeMessages(files) };
}

class MessageCatalog implements I18n {
  readonly dir: 'ltr' | 'rtl';
  private readonly compiled = new Map<I18nKey, IntlMessageFormat>();
  private readonly numberFormats = new Map<number, Intl.NumberFormat>();
  private readonly reportedMissing = new Set<I18nKey>();

  /** The message files added with lazy chunks (see extend). */
  private readonly extensions = new Set<string>();

  constructor(
    readonly locale: Locale,
    private messages: Messages,
  ) {
    this.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
  }

  t(key: I18nKey, values?: Record<string, string | number>): string {
    const format = this.format(key);
    if (!format) return key;
    const out = format.format<string>(values);
    return Array.isArray(out) ? out.join('') : out;
  }

  has(key: I18nKey): boolean {
    return Object.hasOwn(this.messages, key);
  }

  extend(name: string, raw: unknown): void {
    if (this.extensions.has(name)) return;
    const added = asMessages(raw, name);
    const repeated = Object.keys(added).find((key) => Object.hasOwn(this.messages, key));
    if (repeated !== undefined) throw new Error(`i18n: duplicate key "${repeated}" in ${name}`);
    this.extensions.add(name);
    this.messages = { ...this.messages, ...added };
  }

  number(value: number, maximumFractionDigits = 3): string {
    let fmt = this.numberFormats.get(maximumFractionDigits);
    if (!fmt) {
      fmt = new Intl.NumberFormat(this.locale, { maximumFractionDigits });
      this.numberFormats.set(maximumFractionDigits, fmt);
    }
    return fmt.format(value);
  }

  private format(key: I18nKey): IntlMessageFormat | null {
    const cached = this.compiled.get(key);
    if (cached) return cached;
    const source = this.has(key) ? this.messages[key] : undefined;
    if (source === undefined) {
      if (import.meta.env.DEV && !this.reportedMissing.has(key)) {
        this.reportedMissing.add(key);
        console.warn(`i18n: missing key "${key}"`);
      }
      return null;
    }
    const compiled = new IntlMessageFormat(source, this.locale);
    this.compiled.set(key, compiled);
    return compiled;
  }
}

function buildCatalog(locale: Locale): MessageCatalog {
  const english = englishMessages();
  if (locale === 'ar') {
    const arabic = arabicMessages(english);
    if (arabic) return new MessageCatalog('ar', arabic);
    console.warn('i18n: Arabic UI strings are not available yet (M4); using English');
  }
  return new MessageCatalog('en', english);
}

/**
 * Builds the message catalogue for a locale and sets <html lang dir>.
 * Rejects if en.json and en.chapters.json define the same key.
 */
export function createI18n(locale: Locale): Promise<I18n> {
  return new Promise((resolve) => {
    const catalog = buildCatalog(locale);
    document.documentElement.lang = catalog.locale;
    document.documentElement.dir = catalog.dir;
    resolve(catalog);
  });
}
