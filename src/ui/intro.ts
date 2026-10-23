import type { I18n } from '../core/types';
import { h } from './dom';
import './styles/intro.css';

export interface IntroActions {
  begin(): void;
  exploreTimeline(): void;
  /** Opens the solar-system explorer. */
  exploreUniverse(): void;
}

export interface Intro {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  /** Focuses the way into the solar-system explorer (coming back from it). */
  focusUniverse(): void;
}

/**
 * The welcome screen on the home route. Plain DOM and CSS so it paints before
 * the renderer or any data loads; it contains no scripture.
 */
export function createIntro(i18n: I18n, actions: IntroActions): Intro {
  const begin = h('button', { type: 'button', class: 'kf-btn kf-btn--primary kf-btn--large', 'data-testid': 'begin' }, i18n.t('ui.intro.begin'));
  const explore = h('button', { type: 'button', class: 'kf-btn kf-btn--large' }, i18n.t('ui.intro.explore'));
  // A quieter third way in: the solar system as it is today, at true scale.
  const universe = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet', 'data-testid': 'open-universe' }, i18n.t('ui.universe.enter'));
  begin.addEventListener('click', () => {
    actions.begin();
  });
  explore.addEventListener('click', () => {
    actions.exploreTimeline();
  });
  universe.addEventListener('click', () => {
    actions.exploreUniverse();
  });

  const element = h(
    'section',
    { class: 'kf-intro', 'data-testid': 'intro', 'aria-label': i18n.t('ui.intro.label') },
    h(
      'div',
      { class: 'kf-intro-inner' },
      // The page's h1 lives in the header; this large title repeats it visually only.
      h('p', { class: 'kf-intro-title', 'aria-hidden': 'true' }, i18n.t('ui.app.title')),
      h('p', { class: 'kf-intro-tagline' }, i18n.t('ui.app.tagline')),
      h('div', { class: 'kf-intro-actions' }, begin, explore),
      h('p', { class: 'kf-intro-universe' }, universe),
      h('p', { class: 'kf-disclaimer', 'data-testid': 'disclaimer' }, i18n.t('ui.disclaimer')),
      h(
        'p',
        { class: 'kf-intro-foot' },
        h('span', {}, i18n.t('ui.intro.sound')),
        h('a', { href: '#/sources' }, i18n.t('ui.intro.sources')),
      ),
    ),
  );

  let visible = true;
  return {
    element,
    setVisible(next) {
      visible = next;
      element.hidden = !next;
      document.documentElement.classList.toggle('kf-intro-open', next);
    },
    get visible() {
      return visible;
    },
    focusUniverse() {
      universe.focus();
    },
  };
}
