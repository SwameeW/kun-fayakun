import type { App } from '../core/types';
import { h, uniqueId } from './dom';
import { icon } from './icons';
import './styles/sources.css';

export interface SourcesPage {
  readonly element: HTMLElement;
  /** Renders on first show; `backHref` returns to the chapter the reader came from. */
  show(backHref: string): void;
  hide(): void;
}

export function section(title: string, ...children: Array<Node | null>): HTMLElement {
  const id = uniqueId('src');
  return h('section', { class: 'kf-src-section', 'aria-labelledby': id }, h('h3', { id }, title), ...children);
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
    import('./sources-content')
      .then(({ sourcesContent }) => sourcesContent(app))
      .then(
        (sections) => {
          content.replaceChildren(...sections);
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
