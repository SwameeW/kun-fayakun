import type { App, ChapterId } from '../core/types';
import { h } from './dom';
import './styles/status.css';

/**
 * Loading and error screens. They carry plain interface text only: scripture
 * is never shown here, and the cue overlays fade out before these appear.
 */
export interface StatusViews {
  readonly loading: HTMLElement;
  readonly error: HTMLElement;
}

export function createStatus(app: App): StatusViews {
  const { i18n } = app;

  const loadingLabel = h('p', { class: 'kf-loading-label' });
  const loadingPercent = h('span', { class: 'kf-loading-percent', 'aria-hidden': 'true' });
  const progress = h('progress', { class: 'kf-loading-bar', max: 1, value: 0 });
  const loading = h(
    'div',
    { class: 'kf-loading', 'data-testid': 'loading', role: 'status', hidden: true },
    h('span', { class: 'kf-loading-glow', 'aria-hidden': 'true' }),
    loadingLabel,
    h('div', { class: 'kf-loading-row' }, progress, loadingPercent),
  );

  function chapterTitle(id: ChapterId): string {
    const meta = app.chapters.find((c) => c.id === id);
    return meta ? i18n.t(meta.titleKey) : id;
  }

  function showLoading(chapter: ChapterId, value: number): void {
    const label = i18n.t('ui.loading.label', { title: chapterTitle(chapter) });
    if (loadingLabel.textContent !== label) loadingLabel.textContent = label;
    progress.setAttribute('aria-label', label);
    const clamped = Math.max(0, Math.min(1, value));
    progress.value = clamped;
    loadingPercent.textContent = i18n.t('ui.loading.progress', { percent: Math.round(clamped * 100) });
    loading.hidden = false;
  }

  app.events.on('loading', ({ chapter, progress: value }) => {
    if (value >= 1) loading.hidden = true;
    else showLoading(chapter, value);
  });
  app.events.on('state', ({ state, chapter }) => {
    if (state === 'loading' && chapter && loading.hidden) showLoading(chapter, 0);
    else if (state !== 'loading') loading.hidden = true;
  });

  const errorMessage = h('p', { class: 'kf-error-message' });
  const reload = h('button', { type: 'button', class: 'kf-btn kf-btn--primary' }, i18n.t('ui.error.reload'));
  const home = h('button', { type: 'button', class: 'kf-btn' }, i18n.t('ui.error.home'));
  const dismiss = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet' }, i18n.t('ui.error.dismiss'));
  const error = h(
    'div',
    { class: 'kf-error', 'data-testid': 'error', role: 'alert', hidden: true },
    h('p', { class: 'kf-error-title' }, i18n.t('ui.error.title')),
    errorMessage,
    h('div', { class: 'kf-error-actions' }, reload, home, dismiss),
  );

  function setErrorShown(shown: boolean): void {
    error.hidden = !shown;
    document.documentElement.classList.toggle('kf-error-open', shown);
  }

  reload.addEventListener('click', () => {
    window.location.reload();
  });
  home.addEventListener('click', () => {
    setErrorShown(false);
    app.home();
  });
  dismiss.addEventListener('click', () => {
    setErrorShown(false);
  });

  app.events.on('error', ({ message }) => {
    loading.hidden = true;
    errorMessage.textContent = message;
    setErrorShown(true);
    reload.focus({ preventScroll: true });
  });
  app.events.on('state', ({ state }) => {
    // A chapter that starts successfully supersedes an earlier error.
    if (state === 'intro' || state === 'playing') setErrorShown(false);
  });

  return { loading, error };
}
