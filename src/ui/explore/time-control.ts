import { julianDateUtc } from '../../astro/time';
import type { App, UniverseTimeCommand, UniverseView } from '../../core/types';
import { FOOT_MAX_RATE, LAB_DATE_SPAN_S, MAX_RATE, rateParts } from '../../explore/time';
import { h, uniqueId } from '../dom';
import { helpButton } from './help';
import { icon } from '../icons';

/**
 * The time machine's controls, in the readout under how the camera moves: run time backwards,
 * slower, pause, faster, back to now, and a date to go to, with the rate in words ("1 hour a
 * second", "Backwards: 1 day a second", "Time paused"). The keys are Space (pause), [ and ] (slower,
 * faster) and \ (backwards); ./index wires them through `press`, so a key and a click behave alike.
 *
 * Every press does something visible or says why not: a control that cannot act now (the ladder's
 * ends, on foot above FOOT_MAX_RATE) is marked aria-disabled and drawn dimmed, and pressing it puts
 * the reason in the note under the row (announced politely). Space always pauses or plays, even with
 * a time button focused (Enter presses that button). The date takes effect when picked, or with
 * Enter or on leaving the field when typed (so a year half typed never moves the clock); a date
 * outside the span is shown at its nearest end, and the note says so.
 *
 * In an experiment the same row drives its clock (src/explore/lab): backwards replays its history,
 * Now and a date go to that moment of the experiment, and Reset (shown only there) goes back to the
 * fork, paused. A change of rate or of pause is announced politely, once; the line itself is plain
 * text (it is rewritten as the clock runs).
 */

export interface TimeControl {
  readonly element: HTMLElement;
  update(view: UniverseView): void;
  /** A key's press of a time button (the same as a click: a control that cannot act says why). */
  press(kind: 'faster' | 'slower' | 'reverse'): void;
  /** The help, the date field and the Islamic date: in the row (null), or in another place (a phone's sheet keeps them below its list, the buttons above it). */
  placeDay(into: HTMLElement | null): void;
}

const DAY_MS = 86_400_000;
/** How long a reason stays in the note after a press it explains (ms). */
const NOTE_MS = 5000;

export function createTimeControl(app: App, announce: (text: string) => void): TimeControl {
  const { i18n } = app;
  const button = (iconName: Parameters<typeof icon>[0], label: string, testId: string, pressed?: boolean): HTMLButtonElement =>
    h('button', { type: 'button', class: 'kf-universe-time-button', 'aria-label': label, 'data-testid': testId, ...(pressed === undefined ? {} : { 'aria-pressed': String(pressed) }) }, icon(iconName));
  const reverse = button('reverse', i18n.t('ui.universe.time.reverse'), 'universe-time-reverse', false);
  const slower = button('slower', i18n.t('ui.universe.time.slower'), 'universe-time-slower');
  const pause = button('pause', i18n.t('ui.universe.time.pause'), 'universe-time-pause', false);
  const faster = button('faster', i18n.t('ui.universe.time.faster'), 'universe-time-faster');
  const now = h('button', { type: 'button', class: 'kf-universe-time-now', 'aria-label': i18n.t('ui.universe.time.nowLabel'), title: i18n.t('ui.universe.time.nowLabel'), 'data-testid': 'universe-time-now' }, i18n.t('ui.universe.time.now'));
  // In an experiment: back to its fork, paused.
  const reset = h('button', { type: 'button', class: 'kf-universe-time-now', 'aria-label': i18n.t('ui.universe.time.resetLabel'), title: i18n.t('ui.universe.time.resetLabel'), 'data-testid': 'universe-time-reset', hidden: true }, i18n.t('ui.universe.time.reset'));
  const rate = h('span', { class: 'kf-universe-time-rate', 'data-testid': 'universe-time-rate' });
  const note = h('p', { class: 'kf-universe-time-note', 'data-testid': 'universe-time-note', hidden: true });
  const dateId = uniqueId('universe-date');
  const date = h('input', { id: dateId, type: 'date', class: 'kf-universe-time-date', 'data-testid': 'universe-time-date' });
  const dateLabel = h('label', { class: 'kf-sr-only', for: dateId }, i18n.t('ui.universe.time.date'));

  const send = (command: UniverseTimeCommand): void => {
    app.universeTime(command);
  };
  /** Why each control cannot act now (as the last view had it), or none. */
  const blocked: Partial<Record<'faster' | 'slower', string>> = {};
  let noteUntil = 0;
  let told = '';
  const tell = (text: string): void => {
    told = text;
    noteUntil = performance.now() + NOTE_MS;
    if (note.textContent !== text) note.textContent = text;
    note.hidden = false;
    announce(text);
  };
  const press = (kind: 'faster' | 'slower' | 'reverse' | 'toggle'): void => {
    const why = kind === 'faster' || kind === 'slower' ? blocked[kind] : undefined;
    if (why) tell(why);
    else send({ kind });
  };
  for (const [b, kind] of [[reverse, 'reverse'], [slower, 'slower'], [pause, 'toggle'], [faster, 'faster']] as const) {
    b.addEventListener('click', () => {
      press(kind);
    });
  }
  now.addEventListener('click', () => {
    send({ kind: 'now' });
  });
  reset.addEventListener('click', () => {
    app.universeLab({ kind: 'reset' });
  });

  // A chosen day at the time of day already shown (UTC), so only the date changes.
  let shownMs = 0;
  let startMs = 0;
  let endMs = 0;
  /** A date typed is sent with Enter or on leaving the field; one picked (or filled in) at once. */
  let typing = false;
  /** The day last sent, and whether the field is to show the day the clock went to (even while focused). */
  let sentValue = '';
  let rewrite = false;
  /** The day (UTC) as the date field writes it (the span is far inside years 1000 to 9999). */
  const dayOf = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '');
  const commit = (): void => {
    const value = date.value;
    if (value === sentValue) return;
    const day = Date.parse(`${value}T00:00:00Z`);
    // An empty or impossible date (2030-02-30) is not one: the field shows the clock's day again.
    if (!Number.isFinite(day)) {
      rewrite = true;
      return;
    }
    sentValue = value;
    rewrite = true;
    const timeOfDay = ((shownMs % DAY_MS) + DAY_MS) % DAY_MS;
    const at = day + timeOfDay;
    if (endMs > startMs && (at < startMs || at > endMs)) tell(i18n.t('ui.universe.time.outOfRange', { from: dayOf(startMs), to: dayOf(endMs) }));
    send({ kind: 'date', jdUtc: julianDateUtc(at) });
  };
  date.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commit();
      typing = false;
    } else if (event.key !== 'Tab' && event.key !== ' ' && event.key !== 'Escape') typing = true;
  });
  date.addEventListener('pointerdown', () => {
    typing = false;
  });
  date.addEventListener('change', () => {
    if (!typing) commit();
  });
  date.addEventListener('blur', () => {
    typing = false;
    commit();
  });

  // The same day in the Umm al-Qura calendar (its civil day), named as such: communities that begin
  // each month by sighting the crescent may be a day apart.
  const hijri = h('span', { class: 'kf-universe-time-hijri', 'data-testid': 'universe-time-hijri', hidden: true });
  const hijriHelp = helpButton(app, 'hijri', i18n.t('ui.help.label.hijri'));
  hijriHelp.hidden = true;

  const day = h('span', { class: 'kf-universe-time-day' }, helpButton(app, 'time', i18n.t('ui.universe.time.label')), dateLabel, date, h('span', { class: 'kf-universe-time-hijri-row' }, hijri, hijriHelp));
  const element = h(
    'div',
    { class: 'kf-universe-time', role: 'group', 'aria-label': i18n.t('ui.universe.time.label'), 'data-testid': 'universe-time' },
    h('span', { class: 'kf-universe-time-buttons' }, reverse, slower, pause, faster, now, reset),
    rate,
    day,
    note,
  );
  // Space pauses or plays wherever the focus is in the row: it never presses a focused time button
  // again (Enter does that; its native press on keyup is stopped too), and it works from the date field, where it types nothing.
  const spaceOwn = (event: KeyboardEvent): boolean => event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && event.target instanceof Element && event.target.closest('.kf-universe-time-buttons, .kf-universe-time-date') !== null;
  element.addEventListener('keydown', (event) => {
    if (!spaceOwn(event)) return;
    event.preventDefault();
    if (!event.repeat) press('toggle');
  });
  element.addEventListener('keyup', (event) => {
    if (spaceOwn(event)) event.preventDefault();
  });

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
  /** A control's state: aria-disabled (it stays focusable and says why when pressed), and its reason as its title. */
  const able = (b: HTMLButtonElement, why: string | undefined): void => {
    const off = String(why !== undefined);
    if (b.getAttribute('aria-disabled') !== off) b.setAttribute('aria-disabled', off);
    const title = why ?? '';
    if (b.title !== title) b.title = title;
  };
  let said = '';

  return {
    element,
    press,
    placeDay(into) {
      if (into) into.append(day);
      else element.insertBefore(day, note);
    },
    update(view) {
      const t = view.time;
      const lab = view.lab;
      shownMs = view.unixMs;
      const size = Math.abs(t.rate);
      const sign = t.rate < 0 ? -1 : 1;
      // The ladder's ends, and on foot its top at FOOT_MAX_RATE (the cap's own words say why).
      const footTop = t.held === 'foot' && size >= FOOT_MAX_RATE;
      blocked.faster = footTop ? i18n.t('ui.universe.time.footMost', { rate: words(sign * FOOT_MAX_RATE) }) : size >= MAX_RATE ? i18n.t('ui.universe.time.fastest') : undefined;
      blocked.slower = size <= 1 ? i18n.t('ui.universe.time.slowest') : undefined;
      // At an end pointing into it, faster and slower turn the clock round: they act.
      if (t.edge && (t.edge === 'start') === t.rate < 0) {
        blocked.faster = undefined;
        blocked.slower = undefined;
      }
      able(faster, blocked.faster);
      able(slower, blocked.slower);
      reverse.setAttribute('aria-pressed', String(t.rate < 0));
      pause.setAttribute('aria-pressed', String(t.paused));
      reset.hidden = lab === null;
      const edge = t.edge === null ? '' : lab ? i18n.t('ui.universe.time.edgeLab') : i18n.t(t.edge === 'end' ? 'ui.universe.time.edgeEnd' : 'ui.universe.time.edgeStart');
      const text =
        lab?.seekingS != null
          ? i18n.t('ui.universe.time.going', { date: dayOf(shownMs + (lab.seekingS - lab.elapsedS) * 1000) })
          : edge
            ? edge
            : t.paused
              ? i18n.t('ui.universe.time.paused')
              : t.held === 'trip' && size !== 1
                ? i18n.t('ui.universe.time.trip', { rate: words(t.rate) })
                : t.held === 'foot' && size > FOOT_MAX_RATE
                  ? i18n.t('ui.universe.time.onFoot', { rate: words(sign * FOOT_MAX_RATE) })
                  : words(t.rate);
      write(rate, text);
      // Announced when the visitor changes it (not as a trip begins or ends).
      const state = `${t.rate}|${String(t.paused)}|${t.edge ?? ''}`;
      if (said && state !== said) announce(text);
      said = state;
      // The note: a reason just given; else at an end how to go on; else, beyond JPL's tables, what the places come from.
      const beyond = [t.spinHeld ? i18n.t('ui.universe.time.spinHeld') : '', t.beyond.moon ? i18n.t('ui.universe.time.beyondMoon') : '', t.beyond.planets ? i18n.t('ui.universe.time.beyondPlanets') : ''].filter(Boolean).join(' ');
      const hint = t.edge ? i18n.t(t.edge === 'start' ? 'ui.universe.time.edgeHintStart' : 'ui.universe.time.edgeHintEnd') : beyond;
      const noteText = performance.now() < noteUntil ? told : hint;
      write(note, noteText);
      note.hidden = noteText === '';
      // The span of dates: the explorer's, or in an experiment from its fork to LAB_DATE_SPAN_S after it.
      const epochMs = lab ? shownMs - lab.elapsedS * 1000 : 0;
      startMs = lab ? epochMs : t.startMs;
      endMs = lab ? epochMs + LAB_DATE_SPAN_S * 1000 : t.endMs;
      if (endMs > startMs) {
        const min = dayOf(startMs);
        const max = dayOf(endMs);
        if (date.min !== min) date.min = min;
        if (date.max !== max) date.max = max;
      }
      hijri.hidden = t.hijri === null;
      hijriHelp.hidden = t.hijri === null;
      if (t.hijri) write(hijri, i18n.t('ui.universe.hijri.date', { day: t.hijri.day, month: i18n.t(`ui.universe.hijri.month.${t.hijri.month}`), year: t.hijri.year }));
      // Never rewritten under the visitor's typing; after a date is sent, it shows the day the clock went to.
      if (rewrite || document.activeElement !== date) {
        rewrite = false;
        const shown = dayOf(view.unixMs);
        if (date.value !== shown) date.value = shown;
        sentValue = date.value;
      }
    },
  };
}
