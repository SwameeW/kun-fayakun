import { BODY_IDS, type App, type BodyId, type ChapterId, type UniverseView } from '../../core/types';
import { h } from '../dom';
import '../styles/explore.css';

/**
 * The solar-system explorer's interface, loaded with the explorer (its own chunk, never in the
 * shell): a list of bodies to fly to, a way back to the film, and a readout of where the camera
 * is. The readout replaces the chapters' scale bar, which would mislead here: distant bodies are
 * drawn in scaled space, so it gives true distances instead, says plainly that sizes and distances
 * are true, and that the surfaces are illustrative until mission maps arrive.
 *
 * Everything is real DOM text. The list is a row of toggle buttons (aria-pressed on the body in
 * view); moves are announced politely; the readout is plain text, not live (it changes every frame).
 */

export interface UniverseUi {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  /** Where "back" goes: a chapter, or the start. */
  setOrigin(chapter: ChapterId | null): void;
}

const NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  jupiter: 'ui.hud.planet.jupiter',
  saturn: 'ui.hud.planet.saturn',
};
/** Which surface the altitude is measured from. */
const SURFACE_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.universe.photosphere',
  earth: 'ui.universe.surface',
  moon: 'ui.universe.surface',
  jupiter: 'ui.universe.clouds',
  saturn: 'ui.universe.clouds',
};
/** From this distance on, the readout is in astronomical units. */
const AU_KM = 149_597_870.7;
const AU_FROM_KM = 0.01 * AU_KM;

export function mountUniverse(app: App, announce: (text: string) => void): UniverseUi {
  const { i18n } = app;
  const name = (id: BodyId): string => i18n.t(NAME_KEYS[id]);

  const back = h('button', { type: 'button', class: 'kf-btn kf-universe-back', 'data-testid': 'universe-back' });
  back.addEventListener('click', () => {
    app.closeUniverse();
  });
  const buttons = new Map<BodyId, HTMLButtonElement>();
  const list = h('ul', { class: 'kf-universe-bodies' });
  for (const id of BODY_IDS) {
    const button = h('button', { type: 'button', class: 'kf-btn kf-universe-body', 'aria-pressed': 'false', 'data-body': id }, name(id));
    button.addEventListener('click', () => {
      app.focusBody(id);
    });
    buttons.set(id, button);
    list.append(h('li', {}, button));
  }
  const listLabel = h('span', { class: 'kf-universe-bodies-label' }, i18n.t('ui.universe.bodies'));
  const nav = h(
    'nav',
    { class: 'kf-universe-nav', 'aria-label': i18n.t('ui.universe.bodies'), 'data-testid': 'universe-bodies' },
    back,
    h('div', { class: 'kf-universe-list' }, listLabel, list),
  );

  const title = h('p', { class: 'kf-universe-title' });
  const altitude = h('p', { class: 'kf-universe-line kf-universe-altitude' });
  const scale = h('p', { class: 'kf-universe-line kf-universe-scale' }, i18n.t('ui.universe.trueScale'));
  const sunlight = h('p', { class: 'kf-universe-line' });
  const filter = h('p', { class: 'kf-universe-line', hidden: true }, i18n.t('ui.universe.filter'));
  const date = h('p', { class: 'kf-universe-line kf-universe-faint' });
  const illustrative = h('p', { class: 'kf-universe-line kf-universe-faint' }, i18n.t('ui.universe.illustrative'));
  const readout = h('div', { class: 'kf-universe-readout', 'data-testid': 'universe-readout' }, title, altitude, scale, sunlight, filter, date, illustrative);
  const hint = h('p', { class: 'kf-universe-hint' }, i18n.t('ui.universe.hint'));
  const loading = h('p', { class: 'kf-universe-loading', role: 'status' }, i18n.t('ui.universe.loading'));

  const element = h(
    'section',
    { class: 'kf-universe', 'aria-label': i18n.t('ui.universe.label'), 'data-testid': 'universe', hidden: true },
    hint,
    loading,
    readout,
    nav,
  );
  // The readout sits just above the bar of bodies, however that bar wraps.
  new ResizeObserver(() => {
    element.style.setProperty('--kf-universe-nav-h', `${nav.offsetHeight}px`);
  }).observe(nav);

  const dateFormat = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long', timeZone: 'UTC' });
  const text = new Map<HTMLElement, string>();
  const write = (el: HTMLElement, value: string): void => {
    if (text.get(el) === value) return;
    text.set(el, value);
    el.textContent = value;
  };

  /** Three significant figures in km, or au from 0.01 au out. */
  const formatDistance = (kmValue: number): string => {
    const value = Math.max(0, kmValue);
    if (value >= AU_FROM_KM) {
      const au = value / AU_KM;
      return i18n.t('ui.hud.unit.au', { value: i18n.number(au, au < 1 ? 3 : au < 10 ? 2 : 1) });
    }
    const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(value, 1))) - 2);
    return i18n.t('ui.hud.unit.km', { value: i18n.number(Math.round(value / magnitude) * magnitude, 0) });
  };

  const formatPercent = (share: number): string => {
    const percent = share * 100;
    const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : 2;
    return `${i18n.number(percent, digits)}%`;
  };

  let visible = false;
  let ready = false;
  let shownFocus: BodyId | null = null;
  let wasTravelling = false;

  const render = (view: UniverseView): void => {
    write(title, name(view.focus));
    write(altitude, i18n.t(SURFACE_KEYS[view.focus], { distance: formatDistance(view.altitudeKm) }));
    write(sunlight, i18n.t('ui.universe.sunlight', { percent: formatPercent(view.sunlight) }));
    filter.hidden = !view.solarFilter;
    write(date, i18n.t('ui.universe.date', { date: dateFormat.format(new Date(view.unixMs)) }));
    if (view.focus !== shownFocus) {
      for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === view.focus));
      if (shownFocus !== null) announce(i18n.t('ui.universe.announce.travel', { body: name(view.focus) }));
      shownFocus = view.focus;
    } else if (wasTravelling && !view.travelling) {
      announce(i18n.t('ui.universe.announce.arrive', { body: name(view.focus) }));
    }
    wasTravelling = view.travelling;
  };

  const frame = (): void => {
    if (!visible) return;
    const view = app.universe();
    readout.hidden = view === null;
    if (view) render(view);
    requestAnimationFrame(frame);
  };

  const setReady = (next: boolean): void => {
    ready = next;
    loading.hidden = ready || !visible;
    element.classList.toggle('is-ready', ready);
    if (ready) {
      const view = app.universe();
      if (view) {
        shownFocus = null;
        render(view);
        shownFocus = view.focus;
        announce(i18n.t('ui.universe.announce.open', { body: name(view.focus) }));
      }
    }
  };
  app.events.on('universe', ({ ready: next }) => {
    setReady(next);
  });

  return {
    element,
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      element.hidden = !next;
      document.documentElement.classList.toggle('kf-universe-open', next);
      loading.hidden = ready || !next;
      if (next) requestAnimationFrame(frame);
    },
    setOrigin(chapter) {
      const meta = app.chapters.find((c) => c.id === chapter);
      write(back, meta ? i18n.t('ui.universe.backTo', { number: meta.number }) : i18n.t('ui.universe.home'));
    },
  };
}
