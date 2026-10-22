import type {
  App,
  ConstantsFile,
  HadithEntry,
  HadithFile,
  I18n,
  QuranFile,
  SourceEntry,
  SourceKind,
  SourcesFile,
  VerseKey,
} from '../core/types';
import { externalLink, h, uniqueId } from './dom';
import { formatConstant } from './format';
import { icon } from './icons';
import { hadithGrading, hadithReference, sunnahUrl } from './scripture';
import './styles/sources.css';

const REVIEW_AREAS = ['scripture', 'tafsir', 'hadith', 'science', 'accessibility'] as const;
const KIND_ORDER: readonly SourceKind[] = [
  'scripture-text',
  'translation',
  'transliteration',
  'hadith-collection',
  'dataset',
  'paper',
  'font',
  'software',
  'api',
];

interface SourcesData {
  sources: SourcesFile;
  quran: QuranFile['meta'] | null;
  hadith: HadithFile | null;
  constants: ConstantsFile | null;
}

export interface SourcesPage {
  readonly element: HTMLElement;
  /** Renders on first show; `backHref` returns to the chapter the reader came from. */
  show(backHref: string): void;
  hide(): void;
}

function section(title: string, ...children: Array<Node | null>): HTMLElement {
  const id = uniqueId('src');
  return h('section', { class: 'kf-src-section', 'aria-labelledby': id }, h('h3', { id }, title), ...children);
}

function compareVerseKeys(a: VerseKey, b: VerseKey): number {
  const [sa = 0, aa = 0] = a.split(':').map(Number);
  const [sb = 0, ab = 0] = b.split(':').map(Number);
  return sa - sb || aa - ab;
}

function reviewText(review: SourceEntry['review'], i18n: I18n): string {
  if (!review.reviewer) return i18n.t('ui.sources.reviewPending');
  return i18n.t('ui.sources.reviewedBy', {
    reviewer: review.reviewer,
    role: review.role ?? '',
    date: review.date ?? i18n.t('ui.sources.reviewPending'),
  });
}

function definition(term: string, value: Node | string | null): Node[] {
  if (value === null || value === '') return [];
  return [h('dt', {}, term), h('dd', {}, value)];
}

function quranSection(data: SourcesData, i18n: I18n): HTMLElement {
  const meta = data.quran;
  const keys = [
    ...new Set(data.sources.sources.filter((s) => s.kind === 'scripture-text').flatMap((s) => s.verseKeys ?? [])),
  ].sort(compareVerseKeys);
  return section(
    i18n.t('ui.sources.quran'),
    h('p', {}, i18n.t('ui.sources.tanzilIntro')),
    meta ? h('pre', { class: 'kf-src-copyright', tabindex: '0' }, meta.tanzilCopyright) : null,
    h('p', {}, externalLink(meta?.tanzilUrl || 'https://tanzil.net/', i18n.t('ui.sources.tanzilLink'))),
    meta && meta.files.length > 0
      ? h(
          'div',
          {},
          h('h4', {}, i18n.t('ui.sources.files')),
          h(
            'ul',
            { class: 'kf-src-files' },
            ...meta.files.map((f) =>
              h(
                'li',
                {},
                externalLink(f.url, f.url),
                h('br'),
                h('span', { class: 'kf-src-hash' }, i18n.t('ui.sources.fileRow', { source: f.sourceId, bytes: i18n.number(f.bytes, 0), sha: f.sha256 })),
              ),
            ),
          ),
          h('p', { class: 'kf-muted' }, i18n.t('ui.sources.generated', { date: meta.generatedAt })),
        )
      : null,
    keys.length > 0
      ? h('div', {}, h('h4', {}, i18n.t('ui.sources.verses')), h('p', { class: 'kf-src-keys' }, keys.join(', ')))
      : null,
  );
}

function hadithItem(entry: HadithEntry, i18n: I18n): HTMLElement {
  const url = sunnahUrl(entry.sunnahKey);
  const reference = hadithReference(entry, i18n);
  return h(
    'li',
    { class: 'kf-src-hadith' },
    h('p', { class: 'kf-src-hadith-ref' }, url ? externalLink(url, reference) : reference),
    h('p', {}, i18n.t('ui.hadith.narrator', { narrator: entry.narrator })),
    h('p', {}, hadithGrading(entry, i18n)),
    entry.disputedNote ? h('p', { class: 'kf-muted' }, i18n.t('ui.hadith.note', { note: entry.disputedNote })) : null,
    h(
      'p',
      { class: entry.reviewer ? 'kf-src-status is-done' : 'kf-src-status' },
      entry.reviewer
        ? i18n.t('ui.sources.hadithReviewer', { reviewer: entry.reviewer, date: entry.reviewedAt ?? i18n.t('ui.sources.reviewPending') })
        : i18n.t('ui.sources.hadithPending'),
    ),
  );
}

function hadithSection(data: SourcesData, i18n: I18n): HTMLElement | null {
  if (!data.hadith) return null;
  // Only the cited narrations are listed; excluded ones are kept out of the interface entirely.
  return section(
    i18n.t('ui.sources.hadith'),
    h('p', {}, i18n.t('ui.sources.hadithIntro')),
    h('ul', { class: 'kf-src-list' }, ...data.hadith.hadith.map((e) => hadithItem(e, i18n))),
  );
}

function constantsSection(data: SourcesData, i18n: I18n): HTMLElement | null {
  if (!data.constants) return null;
  const rows = data.constants.constants.map((c) => {
    const value = [formatConstant(c, i18n), c.unit].filter(Boolean).join(' ');
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, h('span', {}, c.description), h('code', { class: 'kf-src-id' }, c.id)),
      h('td', {}, value, c.qualifier ? h('span', { class: 'kf-muted kf-src-qualifier' }, c.qualifier) : null),
      h(
        'td',
        {},
        c.citation.url ? externalLink(c.citation.url, c.citation.text) : c.citation.text,
        h('span', { class: 'kf-muted kf-src-accessed' }, i18n.t('ui.sources.accessed', { date: c.citation.accessed })),
      ),
    );
  });
  return section(
    i18n.t('ui.sources.constants'),
    h(
      'div',
      { class: 'kf-src-table-wrap', tabindex: '0', role: 'region', 'aria-label': i18n.t('ui.sources.constantsTable') },
      h(
        'table',
        { class: 'kf-src-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, i18n.t('ui.sources.constantName')),
            h('th', { scope: 'col' }, i18n.t('ui.sources.constantValue')),
            h('th', { scope: 'col' }, i18n.t('ui.sources.constantCitation')),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
  );
}

function sourceArticle(source: SourceEntry, i18n: I18n): HTMLElement {
  const licence = source.licenseUrl ? externalLink(source.licenseUrl, source.license) : source.license;
  return h(
    'article',
    { class: 'kf-src-entry', 'data-source': source.id },
    h('h4', {}, source.url ? externalLink(source.url, source.title) : source.title),
    h(
      'dl',
      {},
      ...definition(i18n.t('ui.sources.author'), source.author),
      ...definition(i18n.t('ui.sources.version'), source.version),
      ...definition(i18n.t('ui.sources.license'), licence),
      ...definition(i18n.t('ui.sources.credit'), source.credit),
      ...definition(i18n.t('ui.sources.notes'), source.notes),
      ...definition(i18n.t('ui.sources.review'), reviewText(source.review, i18n)),
    ),
  );
}

function sourcesListSection(data: SourcesData, i18n: I18n): HTMLElement {
  const byKind = new Map<SourceKind, SourceEntry[]>();
  for (const s of data.sources.sources) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  const groups = KIND_ORDER.flatMap((kind) => {
    const entries = byKind.get(kind);
    if (!entries) return [];
    return [
      h(
        'div',
        { class: 'kf-src-group' },
        h('p', { class: 'kf-src-kind' }, i18n.t(`ui.sources.kind.${kind}`)),
        ...entries.map((s) => sourceArticle(s, i18n)),
      ),
    ];
  });
  return section(i18n.t('ui.sources.list'), ...groups);
}

function reviewsSection(data: SourcesData, i18n: I18n): HTMLElement {
  const rows = REVIEW_AREAS.map((area) => {
    const done = data.sources.reviews.filter((r) => r.area === area);
    const status =
      done.length === 0
        ? h('span', { class: 'kf-src-status' }, i18n.t('ui.sources.reviewPending'))
        : h(
            'span',
            { class: 'kf-src-status is-done' },
            done.map((r) => i18n.t('ui.sources.reviewedBy', { reviewer: r.reviewer, role: r.role, date: r.date })).join('; '),
          );
    return h('tr', {}, h('th', { scope: 'row' }, i18n.t(`ui.sources.area.${area}`)), h('td', {}, status));
  });
  return section(
    i18n.t('ui.sources.reviews'),
    h('p', {}, i18n.t('ui.sources.reviewsIntro')),
    h('table', { class: 'kf-src-table' }, h('tbody', {}, ...rows)),
  );
}

function licencesSection(data: SourcesData, i18n: I18n): HTMLElement {
  return section(
    i18n.t('ui.sources.licences'),
    h(
      'ul',
      { class: 'kf-src-list kf-src-licences' },
      ...data.sources.sources.map((s) =>
        h('li', {}, h('span', {}, `${s.title}: `), s.licenseUrl ? externalLink(s.licenseUrl, s.license) : s.license),
      ),
    ),
  );
}

async function loadSourcesData(app: App): Promise<SourcesData> {
  await app.data.ready;
  const optional = <T>(path: string): Promise<T | null> =>
    app.assets.json<T>(app.assets.url(path)).catch((err: unknown) => {
      console.error(`ui: could not load ${path}`, err);
      return null;
    });
  const [hadith, constants] = await Promise.all([
    optional<HadithFile>('data/hadith.json'),
    optional<ConstantsFile>('data/constants.json'),
  ]);
  let quran: QuranFile['meta'] | null = null;
  try {
    quran = app.data.quranMeta();
  } catch (err) {
    console.error('ui: Quran metadata unavailable', err);
  }
  return { sources: app.data.sources(), quran, hadith, constants };
}

/** The Sources page (#/sources), generated from data/*.json. */
export function createSourcesPage(app: App): SourcesPage {
  const { i18n } = app;
  const headingId = uniqueId('sources');
  const back = h('a', { class: 'kf-btn kf-btn--quiet kf-src-back', href: '#/' }, icon('back'), i18n.t('ui.sources.back'));
  const content = h('div', { class: 'kf-src-content' }, h('p', { class: 'kf-muted', role: 'status' }, i18n.t('ui.sources.loading')));
  const element = h(
    'section',
    { class: 'kf-sources', 'data-testid': 'sources-page', 'aria-labelledby': headingId, hidden: true, tabindex: '-1' },
    h(
      'div',
      { class: 'kf-src-inner' },
      back,
      h('h2', { id: headingId, class: 'kf-src-title' }, i18n.t('ui.sources.title')),
      h('p', { class: 'kf-src-lead' }, i18n.t('ui.sources.intro')),
      section(i18n.t('ui.sources.about'), h('p', { class: 'kf-disclaimer' }, i18n.t('ui.disclaimer'))),
      content,
    ),
  );

  let rendered = false;
  function render(): void {
    rendered = true;
    loadSourcesData(app).then(
      (data) => {
        content.replaceChildren(
          ...[
            quranSection(data, i18n),
            hadithSection(data, i18n),
            constantsSection(data, i18n),
            sourcesListSection(data, i18n),
            reviewsSection(data, i18n),
            licencesSection(data, i18n),
          ].filter((el): el is HTMLElement => el !== null),
        );
      },
      (err: unknown) => {
        rendered = false;
        const message = err instanceof Error ? err.message : String(err);
        content.replaceChildren(h('p', { class: 'kf-muted', role: 'alert' }, i18n.t('ui.sources.loadError', { message })));
      },
    );
  }

  return {
    element,
    show(backHref) {
      back.href = backHref;
      const wasHidden = element.hidden;
      element.hidden = false;
      if (!rendered) render();
      if (wasHidden) {
        element.scrollTop = 0;
        element.focus({ preventScroll: true });
      }
    },
    hide() {
      element.hidden = true;
    },
  };
}
