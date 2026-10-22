import { NOW_SECONDS, isPlayable } from '../chapters/index';
import type { App, ChapterId, ChapterMeta } from '../core/types';
import { h, srOnly, svg, uniqueId } from './dom';
import { formatClock } from './format';
import { icon } from './icons';
import { logRange, spreadPositions, truePosition } from './timeline-layout';
import './styles/timeline.css';

/** Minimum distance between stop centres, in CSS pixels. */
const GAP_WITH_LABELS = 88;
const GAP_COMPACT = 30;
/** Progress slider keyboard steps, in seconds (the native 0.1 s step is too fine to be useful). */
const SLIDER_STEP_S = 5;
const SLIDER_PAGE_S = 15;

export interface Timeline {
  readonly element: HTMLElement;
  /** Focuses the active chapter's stop, or the first stop. */
  focusStops(): void;
  focusPlay(): void;
}

interface StopView {
  meta: ChapterMeta;
  item: HTMLLIElement;
  button: HTMLButtonElement;
  tick: HTMLSpanElement;
  leader: SVGLineElement;
  truePos: number;
}

export function createTimeline(app: App, announce: (text: string) => void): Timeline {
  const { i18n } = app;
  const range = logRange(app.chapters.map((c) => c.epoch), NOW_SECONDS);
  const upcomingId = uniqueId('upcoming');
  const descriptionId = uniqueId('timeline-desc');

  const stopsList = h('ol', { class: 'kf-tl-stops', 'aria-describedby': descriptionId });
  const leaders = svg('svg', { class: 'kf-tl-leaders', 'aria-hidden': 'true', focusable: 'false' });
  const axis = h('div', { class: 'kf-tl-axis', 'aria-hidden': 'true' });

  const stops: StopView[] = app.chapters.map((meta) => {
    const playable = isPlayable(meta);
    const title = i18n.t(meta.titleKey);
    const epoch = i18n.t(meta.epochKey);
    const button = h(
      'button',
      {
        type: 'button',
        class: 'kf-tl-stop',
        'data-testid': `stop-${meta.id}`,
        'data-chapter': meta.id,
        'aria-label': i18n.t('ui.timeline.stop', { number: meta.number, title, epoch }),
        'aria-disabled': playable ? null : 'true',
        'aria-describedby': playable ? null : upcomingId,
      },
      h('span', { class: 'kf-tl-label' }, i18n.t(meta.stopKey)),
      h('span', { class: 'kf-tl-dot' }),
      h(
        'span',
        { class: 'kf-tl-tip', 'aria-hidden': 'true' },
        h('span', { class: 'kf-tl-tip-title' }, title),
        h('span', {}, epoch),
        playable ? null : h('span', { class: 'kf-tl-tip-note' }, i18n.t('ui.timeline.upcoming')),
      ),
    );
    button.addEventListener('click', () => {
      onStop(meta);
    });
    const item = h('li', { class: playable ? 'kf-tl-item' : 'kf-tl-item is-upcoming' }, button);
    stopsList.append(item);
    const pos = truePosition(meta.epoch, range);
    const tick = h('span', { class: playable ? 'kf-tl-tick' : 'kf-tl-tick is-upcoming' });
    axis.append(tick);
    const leader = svg('line', { class: playable ? 'kf-tl-leader' : 'kf-tl-leader is-upcoming' });
    leaders.append(leader);
    return { meta, item, button, tick, leader, truePos: pos };
  });

  const nowPos = truePosition(NOW_SECONDS, range);
  axis.append(
    h('span', { class: 'kf-tl-now', style: `--pos: ${nowPos}` }, h('span', { class: 'kf-tl-now-label' }, i18n.t('ui.timeline.now'))),
  );

  const track = h(
    'div',
    { class: 'kf-tl-track' },
    h('p', { id: descriptionId, class: 'kf-sr-only' }, i18n.t('ui.timeline.stops')),
    stopsList,
    leaders,
    axis,
  );

  /* Transport controls ------------------------------------------------ */

  const playLabel = srOnly('');
  const playButton = h('button', { type: 'button', class: 'kf-btn kf-btn--icon', 'data-testid': 'play-pause' }, playLabel);
  playButton.addEventListener('click', () => {
    if (app.chapter === null) void begin();
    else app.togglePause();
  });

  const modeText = h('span', {});
  const modeButton = h(
    'button',
    { type: 'button', class: 'kf-btn kf-btn--mode', 'data-testid': 'mode-toggle' },
    icon('orbit'),
    modeText,
  );
  modeButton.addEventListener('click', () => {
    app.setMode(app.mode === 'explore' ? 'cinematic' : 'explore');
  });

  const chapterLabel = h('span', { class: 'kf-tl-chapter' });
  // Clock digits read left to right in every locale.
  const clock = h('span', { class: 'kf-tl-clock', 'aria-hidden': 'true', dir: 'ltr' });
  const slider = h('input', {
    type: 'range',
    class: 'kf-tl-slider',
    min: 0,
    max: 1,
    step: 0.1,
    value: 0,
    'aria-label': i18n.t('ui.timeline.progress'),
  });
  let lastUserSeek = 0;
  function seekFromSlider(t: number): void {
    const duration = Number(slider.max);
    const clamped = Math.min(duration, Math.max(0, t));
    lastUserSeek = performance.now();
    slider.value = String(clamped);
    app.seek(clamped);
    renderClock(clamped, duration);
  }
  slider.addEventListener('input', () => {
    seekFromSlider(Number(slider.value));
  });
  slider.addEventListener('keydown', (event) => {
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const steps: Record<string, number> = {
      [forward]: SLIDER_STEP_S,
      ArrowUp: SLIDER_STEP_S,
      [backward]: -SLIDER_STEP_S,
      ArrowDown: -SLIDER_STEP_S,
      PageUp: SLIDER_PAGE_S,
      PageDown: -SLIDER_PAGE_S,
    };
    const value = Number(slider.value);
    let target: number | null = null;
    if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = Number(slider.max);
    else if (event.key in steps) target = value + (steps[event.key] ?? 0);
    if (target === null || slider.disabled) return;
    event.preventDefault();
    seekFromSlider(target);
  });

  const sourcesLink = h('a', { href: '#/sources', class: 'kf-btn kf-btn--quiet' }, i18n.t('ui.timeline.sources'));

  const controls = h(
    'div',
    { class: 'kf-tl-controls' },
    playButton,
    modeButton,
    h('div', { class: 'kf-tl-progress' }, chapterLabel, slider, clock),
    sourcesLink,
  );

  const element = h(
    'nav',
    { class: 'kf-timeline', 'data-testid': 'timeline', 'aria-label': i18n.t('ui.timeline.label') },
    track,
    controls,
    h('span', { id: upcomingId, hidden: true }, i18n.t('ui.timeline.upcoming')),
  );

  /* Behaviour --------------------------------------------------------- */

  async function begin(): Promise<void> {
    try {
      await app.goTo('ch00', 0);
    } catch (err) {
      console.error(err);
    }
  }

  function onStop(meta: ChapterMeta): void {
    if (!isPlayable(meta)) {
      announce(i18n.t('ui.announce.upcoming', { title: i18n.t(meta.titleKey) }));
      return;
    }
    if (meta.id === app.chapter) return;
    app.goTo(meta.id).catch((err: unknown) => {
      console.error(err);
    });
  }

  function renderClock(t: number, duration: number): void {
    const current = formatClock(t);
    const total = formatClock(duration);
    clock.textContent = `${current} / ${total}`;
    slider.setAttribute('aria-valuetext', i18n.t('ui.timeline.progressValue', { current, total }));
  }

  function renderPaused(): void {
    const paused = app.chapter === null || app.paused;
    playLabel.textContent = i18n.t(paused ? 'ui.timeline.play' : 'ui.timeline.pause');
    playButton.replaceChildren(icon(paused ? 'play' : 'pause'), playLabel);
    playButton.title = playLabel.textContent;
  }

  function renderMode(): void {
    const target = app.mode === 'explore' ? 'cinematic' : 'explore';
    const label = i18n.t(`ui.timeline.mode.${target}`);
    modeText.textContent = label;
    modeButton.setAttribute('aria-label', i18n.t('ui.timeline.mode.switchTo', { mode: label }));
    modeButton.dataset.mode = app.mode;
    // The engine accepts a mode change only while a chapter is showing.
    modeButton.disabled = app.chapter === null || app.state === 'loading' || app.state === 'idle';
  }

  function renderChapter(chapter: ChapterId | null): void {
    for (const stop of stops) {
      const current = stop.meta.id === chapter;
      if (current) stop.button.setAttribute('aria-current', 'step');
      else stop.button.removeAttribute('aria-current');
      stop.item.classList.toggle('is-current', current);
      stop.tick.classList.toggle('is-current', current);
      stop.leader.classList.toggle('is-current', current);
    }
    const meta = app.chapters.find((c) => c.id === chapter);
    chapterLabel.textContent = meta
      ? `${i18n.t('ui.timeline.chapter', { number: meta.number })} · ${i18n.t(meta.titleKey)}`
      : i18n.t('ui.timeline.noChapter');
    slider.disabled = meta === undefined;
    if (!meta) {
      slider.value = '0';
      clock.textContent = '';
      slider.removeAttribute('aria-valuetext');
    }
    renderMode();
    renderPaused();
  }

  function layout(): void {
    const width = stopsList.clientWidth;
    if (width === 0) return;
    const withLabels = width >= GAP_WITH_LABELS * (stops.length - 1);
    element.classList.toggle('is-compact', !withLabels);
    const minGap = (withLabels ? GAP_WITH_LABELS : GAP_COMPACT) / width;
    const placed = spreadPositions(
      stops.map((s) => s.truePos),
      minGap,
    );
    const rtl = i18n.dir === 'rtl';
    stops.forEach((stop, i) => {
      const pos = placed[i] ?? stop.truePos;
      stop.item.style.setProperty('--pos', String(pos));
      stop.tick.style.setProperty('--pos', String(stop.truePos));
      const x1 = (rtl ? 1 - pos : pos) * 100;
      const x2 = (rtl ? 1 - stop.truePos : stop.truePos) * 100;
      stop.leader.setAttribute('x1', `${x1}%`);
      stop.leader.setAttribute('x2', `${x2}%`);
      stop.leader.setAttribute('y1', '0');
      stop.leader.setAttribute('y2', '100%');
    });
  }

  new ResizeObserver(layout).observe(stopsList);

  app.events.on('chapter', ({ chapter }) => {
    renderChapter(chapter);
  });
  app.events.on('state', ({ chapter }) => {
    renderChapter(chapter);
  });
  app.events.on('route', ({ route }) => {
    if (route.name === 'home') renderChapter(null);
  });
  app.events.on('paused', renderPaused);
  app.events.on('mode', renderMode);
  app.events.on('time', ({ t, duration }) => {
    // Let a drag in progress own the slider; the engine catches up within a frame or two.
    if (performance.now() - lastUserSeek < 400) return;
    slider.max = String(Math.max(duration, 0.1));
    slider.value = String(t);
    renderClock(t, duration);
  });

  renderChapter(app.chapter);

  return {
    element,
    focusStops() {
      const current = stops.find((s) => s.meta.id === app.chapter) ?? stops[0];
      current?.button.focus();
    },
    focusPlay() {
      playButton.focus();
    },
  };
}
