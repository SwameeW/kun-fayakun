import { BODY_IDS, type App, type BodyId, type ChapterId, type UniverseIllustration, type UniverseView } from '../../core/types';
import { PLANETS_MANIFEST_URL, planetCredits, type PlanetCredit, type PlanetsManifest } from '../../explore/assets/planets';
import { focusLost, h } from '../dom';
import '../styles/explore.css';

/**
 * The solar-system explorer's interface, loaded with the explorer (its own chunk, never in the
 * shell): a list of bodies to fly to, a way back to the film, and a readout of where the camera
 * is. The readout replaces the chapters' scale bar, which would mislead here: distant bodies are
 * drawn in scaled space, so it gives true distances instead, says plainly that sizes and distances
 * are true, names what the view draws that is illustrative (the explorer reports it), and credits
 * the surfaces' imagery in one short line, the credits in full (and the Earth's epochs) a click
 * away. On a narrow screen it shrinks to a few short lines on a solid backdrop, and the explorer is
 * told what the interface covers so it frames the bodies in the clear part of the view.
 *
 * Everything is real DOM text. The list is a row of toggle buttons (aria-pressed on the body in
 * view); moves are announced politely; the readout is plain text, not live (it changes every frame).
 * Focus moves into the explorer when it opens (the button that opened it has gone), and the hint
 * fades once the visitor has moved the view or after a few seconds.
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
/** The hint fades this long after the explorer opens, or at the visitor's first move. */
const HINT_SECONDS = 8;
/** Sunlight is a percentage of the Earth's below this share, and "times the Earth's" from it on. */
const TIMES_FROM = 2;

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
  const sunlight = h('p', { class: 'kf-universe-line kf-universe-extra' });
  const filter = h('p', { class: 'kf-universe-line kf-universe-extra kf-universe-filter', hidden: true }, i18n.t('ui.universe.filter'));
  const date = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-extra' });
  const illustrative = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-illustrative', 'data-testid': 'universe-illustrative', hidden: true });
  // The imagery's credits: one short line, and the full lines (with the Earth's epochs) in a panel that opens over the view.
  const imageryText = h('span', { class: 'kf-universe-imagery-text' });
  const creditsPanel = h('div', { class: 'kf-universe-credits-panel', id: 'kf-universe-credits', role: 'region', 'aria-label': i18n.t('ui.universe.creditsLabel') });
  const creditsToggle = h('summary', { class: 'kf-universe-credits-toggle' }, i18n.t('ui.universe.credits'));
  const credits = h('details', { class: 'kf-universe-credits', 'data-testid': 'universe-credits' }, creditsToggle, creditsPanel);
  const imagery = h('p', { class: 'kf-universe-line kf-universe-faint kf-universe-imagery', 'data-testid': 'universe-imagery', hidden: true }, imageryText, credits);
  const readout = h('div', { class: 'kf-universe-readout', 'data-testid': 'universe-readout' }, title, altitude, scale, sunlight, filter, date, illustrative, imagery);
  const hint = h('p', { class: 'kf-universe-hint' });
  const loading = h('p', { class: 'kf-universe-loading', role: 'status' }, i18n.t('ui.universe.loading'));

  // A programmatic focus target (tabindex -1): opening the explorer lands here, not on the page's body.
  // The readout comes after the bodies in the document (it is placed by CSS), so Tab reaches the way
  // back and the bodies before the credits.
  const element = h(
    'section',
    { class: 'kf-universe', 'aria-label': i18n.t('ui.universe.label'), 'data-testid': 'universe', tabindex: '-1', hidden: true },
    hint,
    loading,
    nav,
    readout,
  );

  /**
   * What the interface covers at the top (the header) and bottom (the bar of bodies, and the readout
   * where it spans the middle of the screen, as on a phone), reported so bodies are framed above it.
   */
  const reportInsets = (): void => {
    if (!visible) return;
    const height = window.innerHeight || 1;
    const width = window.innerWidth || 1;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kf-header-h')) || 0;
    let top = height;
    for (const el of [nav, readout]) {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0 || el.hidden) continue;
      // Only what covers the middle third of the width decides where the clear part ends.
      if (rect.right < width / 3 || rect.left > (2 * width) / 3) continue;
      top = Math.min(top, rect.top);
    }
    app.setViewInsets({ top: header, bottom: Math.max(0, height - top) });
  };
  // The readout sits just above the bar of bodies, however that bar wraps.
  new ResizeObserver(() => {
    element.style.setProperty('--kf-universe-nav-h', `${nav.offsetHeight}px`);
    reportInsets();
  }).observe(nav);
  new ResizeObserver(() => {
    reportInsets();
  }).observe(readout);
  window.addEventListener('resize', reportInsets);

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

  /** Sunlight as a percentage of the Earth's, or, far above it (near the Sun), as a multiple, three figures. */
  const formatSunlight = (share: number): string => {
    if (share >= TIMES_FROM) {
      const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(share)) - 2);
      const rounded = Math.round(share / magnitude) * magnitude;
      return i18n.t('ui.universe.sunlightTimes', { times: i18n.number(rounded, rounded < 10 ? 1 : 0) });
    }
    const percent = share * 100;
    const digits = percent >= 10 ? 0 : percent >= 1 ? 1 : 2;
    return i18n.t('ui.universe.sunlight', { percent: `${i18n.number(percent, digits)}%` });
  };

  /**
   * A source's name as the short line shows it: its full credit where no short name is kept (OPAL's
   * CC BY credit stays whole), nothing for a source whose terms ask for none (Natural Earth; it is in
   * the full credits all the same).
   */
  const shortName = (source: PlanetCredit): string => {
    const key = `ui.universe.source.${source.sourceId}`;
    return i18n.has(key) ? i18n.t(key) : source.credit;
  };
  /** Per body: the short imagery line, and the full credits (with the Earth's caption), once planets.json has loaded. */
  let imageryLines: Partial<Record<BodyId, { short: string; full: string[] }>> = {};
  void app.assets.json<PlanetsManifest>(PLANETS_MANIFEST_URL).then(
    (manifest) => {
      const next: Partial<Record<BodyId, { short: string; full: string[] }>> = {};
      for (const body of ['earth', 'moon', 'jupiter', 'saturn'] as const) {
        const files = manifest.files.filter((f) => f.body === body);
        const lines = planetCredits(files);
        if (lines.length === 0) continue;
        const sources = files.flatMap((f) => [f, ...(f.alsoFrom ?? [])]);
        const names = [...new Set(sources.map(shortName))].filter((name) => name !== '');
        const caption = manifest.bodies?.[body]?.caption;
        next[body] = { short: i18n.t('ui.universe.imagery', { credits: names.join(', ') }), full: [...(caption ? [caption] : []), ...lines] };
      }
      imageryLines = next;
    },
    () => undefined,
  );
  const listFormat = new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' });
  /** The readout's note of what is illustrative, or '' for none. */
  const illustrativeNote = (items: readonly UniverseIllustration[] | undefined): string =>
    items && items.length > 0 ? i18n.t('ui.universe.illustrative', { items: listFormat.format(items.map((id) => i18n.t(`ui.universe.illustrative.${id}`))) }) : '';
  /** The credits the panel holds now (rebuilt when the focus or the loaded lines change). */
  let creditsShown: { short: string; full: string[] } | undefined;

  let visible = false;
  let ready = false;
  let shownFocus: BodyId | null = null;
  let wasTravelling = false;
  let hintTimer = 0;

  const render = (view: UniverseView): void => {
    if (view.travelling && view.from) {
      // Under way: where from and where to, and how far is left to go.
      write(title, i18n.t('ui.universe.flying', { from: name(view.from), to: name(view.focus) }));
      write(altitude, i18n.t('ui.universe.toGo', { distance: formatDistance(view.altitudeKm), body: name(view.focus) }));
    } else {
      write(title, name(view.focus));
      write(altitude, i18n.t(SURFACE_KEYS[view.focus], { distance: formatDistance(view.altitudeKm) }));
    }
    write(sunlight, formatSunlight(view.sunlight));
    filter.hidden = !view.solarFilter;
    readout.classList.toggle('is-filtered', view.solarFilter);
    write(date, i18n.t('ui.universe.date', { date: dateFormat.format(new Date(view.unixMs)) }));
    // What is illustrative in the view now, and whose imagery this is (the focus's maps).
    const note = illustrativeNote(view.illustrative);
    illustrative.hidden = note === '';
    write(illustrative, note);
    const lines = imageryLines[view.focus];
    imagery.hidden = !lines;
    write(imageryText, lines?.short ?? '');
    if (creditsShown !== lines) {
      creditsShown = lines;
      credits.open = false;
      creditsPanel.replaceChildren(...(lines?.full ?? []).map((line) => h('p', { class: 'kf-universe-credits-line' }, line)));
    }
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

  /** The hint goes once the visitor moves the view, or after HINT_SECONDS. */
  const dismissHint = (): void => {
    window.clearTimeout(hintTimer);
    element.classList.add('is-hinted');
    window.removeEventListener('pointerdown', dismissHint, true);
    window.removeEventListener('wheel', dismissHint, true);
    window.removeEventListener('keydown', dismissOnMove, true);
  };
  const dismissOnMove = (event: KeyboardEvent): void => {
    if (event.key.startsWith('Arrow') || ['+', '-', '=', 'PageUp', 'PageDown', 'w', 'a', 's', 'd'].includes(event.key)) dismissHint();
  };
  const armHint = (): void => {
    element.classList.remove('is-hinted');
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(dismissHint, HINT_SECONDS * 1000);
    window.addEventListener('pointerdown', dismissHint, true);
    window.addEventListener('wheel', dismissHint, { capture: true, passive: true });
    window.addEventListener('keydown', dismissOnMove, true);
  };

  /** Focus that was on a control now hidden (the way in) has fallen to the page: bring it into the explorer. */
  const takeFocus = (): void => {
    if (focusLost()) element.focus({ preventScroll: true });
  };

  const setReady = (next: boolean): void => {
    ready = next;
    loading.hidden = ready || !visible;
    element.classList.toggle('is-ready', ready);
    if (!ready) return;
    const view = app.universe();
    if (view) {
      shownFocus = null;
      render(view);
      shownFocus = view.focus;
      announce(i18n.t('ui.universe.announce.open', { body: name(view.focus) }));
    }
    if (visible) {
      takeFocus();
      armHint();
      reportInsets();
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
      if (next) {
        requestAnimationFrame(frame);
        // Opened while its buttons vanish: hold focus here until the explorer is ready.
        takeFocus();
        reportInsets();
      } else {
        dismissHint();
      }
    },
    setOrigin(chapter) {
      const meta = app.chapters.find((c) => c.id === chapter);
      write(back, meta ? i18n.t('ui.universe.backTo', { number: meta.number }) : i18n.t('ui.universe.home'));
      write(hint, meta ? i18n.t('ui.universe.hintChapter', { number: meta.number }) : i18n.t('ui.universe.hintHome'));
    },
  };
}
