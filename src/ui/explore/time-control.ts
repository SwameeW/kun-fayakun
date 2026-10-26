import { julianDateUtc } from '../../astro/time';
import type { App, UniverseView } from '../../core/types';
import { rateParts } from '../../explore/time';
import { h, uniqueId } from '../dom';
import { icon } from '../icons';

/**
 * The time machine's controls, in the readout under how the camera moves: run time backwards,
 * slower, pause, faster, back to now, and a date to go to, with the rate in words ("1 hour a
 * second", "Backwards: 1 day a second", "Time paused"). The keys are Space (pause), [ and ] (slower,
 * faster) and \ (backwards); ./index wires them. A change of rate or of pause is announced politely,
 * once; the line itself is plain text (it is rewritten as the clock runs).
 */

export interface TimeControl {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
}

const DAY_MS = 86_400_000;

export function createTimeControl(app: App, announce: (text: string) => void): TimeControl {
  const { i18n } = app;
  const button = (iconName: Parameters<typeof icon>[0], label: string, testId: string, pressed?: boolean): HTMLButtonElement =>
    h('button', { type: 'button', class: 'kf-universe-time-button', 'aria-label': label, 'data-testid': testId, ...(pressed === undefined ? {} : { 'aria-pressed': String(pressed) }) }, icon(iconName));
  const reverse = button('reverse', i18n.t('ui.universe.time.reverse'), 'universe-time-reverse', false);
  const slower = button('slower', i18n.t('ui.universe.time.slower'), 'universe-time-slower');
  const pause = button('pause', i18n.t('ui.universe.time.pause'), 'universe-time-pause', false);
  const faster = button('faster', i18n.t('ui.universe.time.faster'), 'universe-time-faster');
  const now = h('button', { type: 'button', class: 'kf-universe-time-now', 'aria-label': i18n.t('ui.universe.time.nowLabel'), 'data-testid': 'universe-time-now' }, i18n.t('ui.universe.time.now'));
  const rate = h('span', { class: 'kf-universe-time-rate', 'data-testid': 'universe-time-rate' });
  const dateId = uniqueId('universe-date');
  const date = h('input', { id: dateId, type: 'date', class: 'kf-universe-time-date', 'data-testid': 'universe-time-date' });
  const dateLabel = h('label', { class: 'kf-sr-only', for: dateId }, i18n.t('ui.universe.time.date'));

  const send = (command: Parameters<App['universeTime']>[0]): void => {
    app.universeTime(command);
  };
  reverse.addEventListener('click', () => {
    send({ kind: 'reverse' });
  });
  slower.addEventListener('click', () => {
    send({ kind: 'slower' });
  });
  pause.addEventListener('click', () => {
    send({ kind: 'toggle' });
  });
  faster.addEventListener('click', () => {
    send({ kind: 'faster' });
  });
  now.addEventListener('click', () => {
    send({ kind: 'now' });
  });
  // A chosen day at the time of day already shown (UTC), so only the date changes.
  let shownMs = 0;
  date.addEventListener('change', () => {
    const day = Date.parse(`${date.value}T00:00:00Z`);
    if (!Number.isFinite(day)) return;
    const timeOfDay = ((shownMs % DAY_MS) + DAY_MS) % DAY_MS;
    send({ kind: 'date', jdUtc: julianDateUtc(day + timeOfDay) });
  });

  const element = h(
    'div',
    { class: 'kf-universe-time', role: 'group', 'aria-label': i18n.t('ui.universe.time.label'), 'data-testid': 'universe-time' },
    h('span', { class: 'kf-universe-time-buttons' }, reverse, slower, pause, faster, now),
    rate,
    dateLabel,
    date,
  );

  /** The rate in words. */
  const words = (r: number): string => {
    if (Math.abs(r) === 1) return i18n.t(r < 0 ? 'ui.universe.time.realTimeBack' : 'ui.universe.time.realTime');
    const { count, unit } = rateParts(r);
    const text = i18n.t(`ui.universe.time.per.${unit}`, { count });
    return r < 0 ? i18n.t('ui.universe.time.backwards', { rate: text }) : text;
  };
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  let said = '';
  const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  return {
    element,
    update(view) {
      const t = view.time;
      shownMs = view.unixMs;
      reverse.setAttribute('aria-pressed', String(t.rate < 0));
      pause.setAttribute('aria-pressed', String(t.paused));
      const text = t.edge
        ? i18n.t(t.edge === 'end' ? 'ui.universe.time.edgeEnd' : 'ui.universe.time.edgeStart')
        : t.paused
          ? i18n.t('ui.universe.time.paused')
          : view.travelling && Math.abs(t.rate) !== 1
            ? i18n.t('ui.universe.time.trip')
            : words(t.rate);
      write(rate, text);
      // Announced when the visitor changes it (not as a trip begins or ends).
      const state = `${t.rate}|${String(t.paused)}|${t.edge ?? ''}`;
      if (said && state !== said) announce(text);
      said = state;
      if (t.endMs > t.startMs) {
        const min = dayOf(t.startMs);
        const max = dayOf(t.endMs);
        if (date.min !== min) date.min = min;
        if (date.max !== max) date.max = max;
      }
      // Never rewritten under the visitor's typing.
      if (document.activeElement !== date) {
        const shown = dayOf(view.unixMs);
        if (date.value !== shown) date.value = shown;
      }
    },
  };
}
