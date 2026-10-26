import type { DataStore, HadithEntry, HadithId, I18n, I18nKey, QuranEntry, VerseKey } from '../core/types';
import { externalLink, h, uniqueId } from './dom';
import { findSource } from './format';

/**
 * Rendering of scripture blocks. Every Arabic string, translation and hadith
 * field comes from the DataStore (data/*.json); nothing here supplies text.
 */

const SUNNAH_KEY = /^[a-z]+:[0-9]+[a-z]?$/;
const TANZIL_FALLBACK_URL = 'https://tanzil.net/';

/** The DataStore throws (or returns no Arabic) for a verse it withheld after validation. */
export function availableVerse(data: DataStore, key: VerseKey): QuranEntry | null {
  try {
    const entry = data.verse(key);
    return entry.arabic.length > 0 ? entry : null;
  } catch {
    return null;
  }
}

export function lookupHadith(data: DataStore, id: HadithId): HadithEntry | null {
  try {
    return data.hadith(id);
  } catch (err) {
    console.error(`ui: hadith "${id}" is not in data/hadith.json`, err);
    return null;
  }
}

/**
 * Wording may be shown only once a person has entered it and a reviewer is recorded.
 * Blank strings count as not entered / not recorded, so no empty quotation is shown.
 */
export function verifiedHadithText(entry: HadithEntry): { en: string; ar: string | null } | null {
  const en = entry.text.en?.trim() ? entry.text.en : null;
  const reviewer = entry.reviewer?.trim() ? entry.reviewer : null;
  if (en === null || reviewer === null) return null;
  return { en, ar: entry.text.ar?.trim() ? entry.text.ar : null };
}

export function sunnahUrl(sunnahKey: string): string | null {
  return SUNNAH_KEY.test(sunnahKey) ? `https://sunnah.com/${sunnahKey}` : null;
}

export function hadithReference(entry: HadithEntry, i18n: I18n): string {
  return i18n.t('ui.hadith.reference', { collection: entry.collection, number: entry.number });
}

export function hadithGrading(entry: HadithEntry, i18n: I18n): string {
  return entry.grader
    ? i18n.t('ui.hadith.grader', { grading: entry.grading, grader: entry.grader })
    : i18n.t('ui.hadith.grading', { grading: entry.grading });
}

/** Arabic scripture element: language-tagged, right-to-left, never machine-translated. */
export function arabicText(text: string, className: string): HTMLElement {
  return h('p', { class: className, lang: 'ar', dir: 'rtl', translate: 'no' }, text);
}

function tanzilUrl(data: DataStore): string {
  try {
    return data.quranMeta().tanzilUrl || TANZIL_FALLBACK_URL;
  } catch {
    return TANZIL_FALLBACK_URL;
  }
}

/** Short per-verse attribution; the full credit lines and licences are on the Sources page. */
function verseAttribution(entry: QuranEntry, data: DataStore, i18n: I18n): HTMLElement {
  const translation = findSource(data, entry.source.translation);
  const arabic = findSource(data, entry.source.arabic);
  const translator = translation ? (translation.author ?? translation.title) : entry.translationId;
  return h(
    'p',
    { class: 'kf-attrib' },
    i18n.t('ui.verse.translationSource', { source: translator }),
    ' ',
    i18n.t('ui.verse.arabicSource'),
    ' ',
    // Tanzil's terms require a link to tanzil.net wherever its text is shown.
    externalLink(tanzilUrl(data), arabic?.title ?? i18n.t('ui.verse.tanzil')),
  );
}

/** The verse's plain-words explanation (src/i18n/en.plain.json, once ./plain-words has loaded it), or null. */
export function plainExplanation(key: VerseKey, i18n: I18n): string | null {
  return i18n.has(`plain.${key}`) ? i18n.t(`plain.${key}`) : null;
}

/**
 * The plain-words explanation under a verse's translation: labelled as an explanation, apart from
 * the translation and its attribution, so it is never taken for a translation of the Quran.
 */
export function plainBlock(key: VerseKey, i18n: I18n): HTMLElement | null {
  const text = plainExplanation(key, i18n);
  if (!text) return null;
  const labelId = uniqueId('plain');
  return h(
    'div',
    { class: 'kf-plain', role: 'group', 'aria-labelledby': labelId, 'data-testid': 'verse-plain' },
    h('p', { id: labelId, class: 'kf-plain-label' }, i18n.t('ui.verse.plainLabel')),
    h('p', { class: 'kf-plain-text' }, text),
    h('p', { class: 'kf-plain-note' }, i18n.t('ui.verse.plainNote')),
  );
}

/**
 * A verse in the panel: Arabic, transliteration, translation, reference and attribution, then the
 * verse in plain words (`plain: false` leaves that out, where the space is the letters', as in the
 * letter analysis).
 */
export function verseArticle(key: VerseKey, data: DataStore, i18n: I18n, noteKey?: I18nKey, options: { plain?: boolean } = {}): HTMLElement {
  const headingId = uniqueId('verse');
  const heading = h('h3', { id: headingId, class: 'kf-ref' }, i18n.t('ui.verse.reference', { key }));
  const entry = availableVerse(data, key);
  if (!entry) {
    return h(
      'article',
      { class: 'kf-verse is-withheld', 'aria-labelledby': headingId, 'data-verse': key },
      heading,
      h('p', { class: 'kf-muted' }, i18n.t('ui.verse.withheld')),
    );
  }
  return h(
    'article',
    { class: 'kf-verse', 'aria-labelledby': headingId, 'data-verse': key },
    heading,
    arabicText(entry.arabic, 'kf-arabic'),
    entry.translit ? h('p', { class: 'kf-translit', lang: 'ar-Latn', dir: 'ltr', translate: 'no' }, entry.translit) : null,
    entry.translation ? h('blockquote', { class: 'kf-translation', dir: 'auto' }, h('p', {}, entry.translation)) : null,
    verseAttribution(entry, data, i18n),
    options.plain === false ? null : plainBlock(key, i18n),
    noteKey ? h('p', { class: 'kf-note' }, i18n.t(noteKey)) : null,
  );
}

function parallelLinks(entry: HadithEntry, i18n: I18n): HTMLElement | null {
  const links = entry.parallels.flatMap((key) => {
    const url = sunnahUrl(key);
    if (!url) return [];
    const [collectionKey, number] = key.split(':');
    const sameCollection = entry.sunnahKey.split(':')[0] === collectionKey;
    const label = sameCollection && number ? hadithReference({ ...entry, number }, i18n) : key;
    return [externalLink(url, label)];
  });
  if (links.length === 0) return null;
  const items = links.flatMap((link, i) => (i === 0 ? [link] : [', ', link]));
  return h('p', { class: 'kf-meta' }, i18n.t('ui.hadith.parallels'), ' ', ...items);
}

/**
 * A hadith in the notes, in two levels. First what most readers need: the reference, the wording
 * when a person has entered and checked it, the sourced summary (labelled: not a quotation), the
 * grading and any note on it, since gradings that differ must stay plain to see. Then, behind
 * "Source details": the narrator, parallel narrations, why the wording is not shown yet, and the
 * link to sunnah.com. Wording appears only when entered and reviewed.
 */
export function hadithArticle(
  id: HadithId,
  data: DataStore,
  i18n: I18n,
  opts: { summaryKey?: I18nKey; noteKey?: I18nKey } = {},
): HTMLElement | null {
  const entry = lookupHadith(data, id);
  if (!entry) return null;
  const headingId = uniqueId('hadith');
  const text = verifiedHadithText(entry);
  const link = sunnahUrl(entry.sunnahKey);
  return h(
    'article',
    { class: 'kf-hadith', 'aria-labelledby': headingId, 'data-hadith': id },
    h('h3', { id: headingId, class: 'kf-ref' }, hadithReference(entry, i18n)),
    text
      ? h(
          'div',
          { class: 'kf-hadith-text' },
          text.ar ? arabicText(text.ar, 'kf-arabic kf-arabic--hadith') : null,
          h('blockquote', { class: 'kf-translation', dir: 'auto' }, h('p', {}, text.en)),
          h('p', { class: 'kf-attrib' }, i18n.t('ui.hadith.checkedBy', { reviewer: entry.reviewer ?? '' })),
        )
      : null,
    opts.summaryKey
      ? h(
          'div',
          { class: 'kf-summary' },
          h('p', { class: 'kf-summary-label' }, i18n.t('ui.hadith.summaryLabel')),
          h('p', {}, i18n.t(opts.summaryKey)),
        )
      : null,
    h('p', { class: 'kf-grading' }, hadithGrading(entry, i18n)),
    entry.disputedNote ? h('p', { class: 'kf-note' }, i18n.t('ui.hadith.note', { note: entry.disputedNote })) : null,
    opts.noteKey ? h('p', { class: 'kf-note' }, i18n.t(opts.noteKey)) : null,
    h(
      'details',
      { class: 'kf-hadith-source', 'data-testid': 'hadith-source' },
      h('summary', {}, i18n.t('ui.hadith.sourceDetails')),
      h('p', { class: 'kf-meta' }, i18n.t('ui.hadith.narrator', { narrator: entry.narrator })),
      parallelLinks(entry, i18n),
      text ? null : h('p', { class: 'kf-pending' }, i18n.t('ui.hadith.pending')),
      link ? h('p', { class: 'kf-link' }, externalLink(link, i18n.t('ui.hadith.link'))) : null,
    ),
  );
}
