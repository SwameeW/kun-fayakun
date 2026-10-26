import type { App, ChapterContent, ExploreExtra, ExplorePoint } from '../core/types';
import messages from '../i18n/en.discover.json';
import { externalLink, h, svg, uniqueId } from './dom';
import { expansionControl } from './figures';
import { blockCitations, formatProse, formatValueRef } from './format';
import './styles/discover.css';

/**
 * Explore Mode's dock (its own chunk, with src/i18n/en.discover.json): what there is to discover in a
 * chapter beyond moving the camera. Moments to visit (the scene as it is then, seen from where the
 * film's camera stands, with a card that says whether it shows measured data, a model or an
 * illustration); a slider that runs the chapter's own process; and closer looks of its own (a model
 * of expanding space, the Planck map's measurements, two kinds of supernova, Kepler's law from the
 * real orbits, the Earth today, water, words to know). Nothing is scored. The film's clock never
 * moves; "Back to the film's moment" returns the scene and the camera.
 */
export interface DiscoverDock {
  readonly element: HTMLElement;
  /** Shows what the chapter offers (hidden for a chapter with nothing to discover). */
  open(content: ChapterContent): void;
  /** Hides it and returns everything to the film's moment. */
  close(): void;
}

export function createDiscoverDock(app: App): DiscoverDock {
  const { i18n } = app;
  i18n.extend('en.discover.json', messages);
  const titleId = uniqueId('discover-title');
  const bodyId = uniqueId('discover-body');
  const collapse = h('button', { type: 'button', class: 'kf-discover-collapse', 'aria-expanded': 'true', 'aria-controls': bodyId, 'aria-label': i18n.t('discover.hide'), 'data-testid': 'discover-collapse' });
  const body = h('div', { id: bodyId, class: 'kf-discover-body' });
  const element = h(
    'aside',
    { class: 'kf-discover', 'aria-labelledby': titleId, 'data-testid': 'discover', hidden: true },
    h('div', { class: 'kf-discover-head' }, h('h2', { id: titleId, class: 'kf-discover-title' }, i18n.t('discover.title')), collapse),
    body,
  );
  collapse.addEventListener('click', () => {
    const open = collapse.getAttribute('aria-expanded') !== 'true';
    collapse.setAttribute('aria-expanded', String(open));
    collapse.setAttribute('aria-label', i18n.t(open ? 'discover.hide' : 'discover.show'));
    body.hidden = !open;
    mark();
  });

  /**
   * Tells the stage what the dock is doing, so the film's captions and verse cards step aside: while
   * the scene shows another moment than the film's (they belong to the film's), and on a phone while
   * the dock is open over them (styles/discover.css).
   */
  function mark(): void {
    const stage = element.parentElement;
    if (!stage) return;
    stage.classList.toggle('kf-explore-elsewhere', !element.hidden && app.exploreTime !== null);
    stage.classList.toggle('kf-discover-open', !element.hidden && !body.hidden);
  }

  let content: ChapterContent | null = null;
  let resetters: Array<() => void> = [];

  /** The scene at chapter time t, seen as the film sees it then; the moment's card if it is one. */
  function visit(t: number, point: ExplorePoint | null): void {
    app.setExploreTime(t);
    app.focusView(t);
    for (const b of body.querySelectorAll<HTMLButtonElement>('.kf-discover-moment')) b.setAttribute('aria-pressed', String(b.dataset.point === point?.id));
    showCard(point);
    const slider = body.querySelector<HTMLInputElement>('.kf-discover-process input');
    if (slider && content?.explore.process) {
      const { from, to } = content.explore.process;
      if (t >= from && t <= to) setSlider(slider, t);
    }
    mark();
  }

  const card = h('div', { class: 'kf-discover-card', 'data-testid': 'discover-card', 'aria-live': 'polite', hidden: true });
  function showCard(point: ExplorePoint | null): void {
    if (!point) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }
    const cites = blockCitations(point.text, app.data).map((c) => h('li', {}, c.url ? externalLink(c.url, c.text) : c.text));
    card.dataset.kind = point.kind;
    card.replaceChildren(
      h('p', { class: `kf-discover-kind kf-discover-kind--${point.kind}`, 'data-testid': 'discover-kind' }, i18n.t(`discover.kind.${point.kind}`)),
      h('h3', { class: 'kf-discover-card-title' }, i18n.t(point.titleKey)),
      h('p', { class: 'kf-discover-card-text', 'data-testid': 'discover-text' }, formatProse(point.text, app.data, i18n)),
      ...(cites.length > 0 ? [h('div', { class: 'kf-cites' }, h('span', { class: 'kf-cites-label' }, i18n.t('ui.panel.cites')), h('ul', {}, ...cites))] : []),
    );
    card.hidden = false;
  }

  function setSlider(slider: HTMLInputElement, t: number): void {
    slider.value = String(t);
    const process = content?.explore.process;
    if (!process) return;
    const percent = Math.round((100 * (t - process.from)) / (process.to - process.from));
    slider.setAttribute('aria-valuetext', i18n.t('discover.processValue', { title: i18n.t(process.titleKey), percent }));
  }

  function moments(points: readonly ExplorePoint[]): HTMLElement {
    return h(
      'div',
      { class: 'kf-discover-moments', role: 'group', 'aria-label': i18n.t('discover.moments') },
      ...points.map((point) => {
        const b = h('button', { type: 'button', class: 'kf-discover-moment', 'aria-pressed': 'false', 'data-point': point.id, 'data-testid': `discover-point-${point.id}` }, i18n.t(point.titleKey));
        b.addEventListener('click', () => {
          visit(point.t, point);
        });
        return b;
      }),
    );
  }

  function processControl(c: ChapterContent): HTMLElement | null {
    const process = c.explore.process;
    if (!process) return null;
    const id = uniqueId('discover-process');
    const hintId = uniqueId('discover-process-hint');
    const slider = h('input', { id, type: 'range', min: String(process.from), max: String(process.to), step: '0.1', 'aria-describedby': hintId, 'data-testid': 'discover-process' });
    setSlider(slider, Math.min(process.to, Math.max(process.from, app.time)));
    slider.addEventListener('input', () => {
      const t = Number(slider.value);
      setSlider(slider, t);
      app.setExploreTime(t);
      for (const b of body.querySelectorAll<HTMLButtonElement>('.kf-discover-moment')) b.setAttribute('aria-pressed', 'false');
      showCard(null);
      mark();
    });
    resetters.push(() => {
      setSlider(slider, Math.min(process.to, Math.max(process.from, app.time)));
    });
    return h(
      'div',
      { class: 'kf-discover-process' },
      h('label', { for: id, class: 'kf-discover-label' }, i18n.t(process.titleKey)),
      slider,
      h('div', { class: 'kf-discover-ends', 'aria-hidden': 'true' }, h('span', {}, i18n.t(process.startKey)), h('span', {}, i18n.t(process.endKey))),
      h('p', { id: hintId, class: 'kf-discover-hint' }, i18n.t('discover.processHint')),
    );
  }

  /** A button that visits one of the chapter's moments by id (used inside the closer looks). */
  function momentButton(c: ChapterContent, id: string, labelKey: string): HTMLButtonElement | null {
    const point = c.explore.points?.find((p) => p.id === id);
    if (!point) return null;
    const b = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discover-goto', 'data-testid': `discover-goto-${id}` }, i18n.t(labelKey));
    b.addEventListener('click', () => {
      visit(point.t, point);
    });
    return b;
  }

  function extra(c: ChapterContent, name: ExploreExtra): HTMLElement {
    const [titleKey, inner] = extraBody(c, name);
    return h('details', { class: 'kf-discover-extra', 'data-testid': `discover-extra-${name}` }, h('summary', {}, i18n.t(titleKey)), h('div', { class: 'kf-discover-extra-body' }, ...inner));
  }

  function list(keys: readonly string[], values: Record<string, string> = {}): HTMLElement {
    return h('ul', { class: 'kf-discover-list' }, ...keys.map((k) => h('li', {}, i18n.t(k, values))));
  }

  function extraBody(c: ChapterContent, name: ExploreExtra): [string, Array<Element | null>] {
    switch (name) {
      case 'terms':
        return ['discover.terms.title', [h('p', {}, i18n.t('discover.terms.lead')), list(['discover.terms.kun', 'discover.terms.badi', 'discover.terms.arsh', 'discover.terms.qalam', 'discover.terms.ghayb'])]];
      case 'expansion-model':
        return ['discover.expansion.title', expansionModel()];
      case 'cmb': {
        const temp = formatValueRef({ constant: 'cmb.temperature', field: 'value', digits: 4 }, app.data, i18n);
        return [
          'discover.cmb.title',
          [
            list(['discover.cmb.planck', 'discover.cmb.detail', 'discover.cmb.average', 'discover.cmb.plane', 'discover.cmb.motion'], { temp }),
            h('p', { class: 'kf-discover-compare' }, i18n.t('discover.cmb.compare'), ' ', momentButton(c, 'plasma', 'discover.cmb.fog'), ' ', momentButton(c, 'sky', 'discover.cmb.sky')),
          ],
        ];
      }
      case 'stretch': {
        // The notes' own stretch control (src/ui/figures.ts), here where its effect can be watched.
        const control = expansionControl(app);
        resetters.push(() => {
          app.interact('stretch', null);
        });
        return ['ui.stretch.title', [control]];
      }
      case 'supernovae':
        return ['discover.sn.title', [supernovae(), h('p', { class: 'kf-discover-compare' }, momentButton(c, 'collapse', 'discover.sn.showType2'), ' ', momentButton(c, 'type-ia', 'discover.sn.showTypeIa'))]];
      case 'orbits':
        return ['discover.orbits.title', orbits()];
      case 'earth': {
        const open = h('button', { type: 'button', class: 'kf-btn kf-discover-open', 'data-testid': 'discover-earth' }, i18n.t('discover.earth.open'));
        open.addEventListener('click', () => {
          app.openUniverse('earth');
        });
        return ['discover.earth.title', [h('p', {}, i18n.t('discover.earth.lead')), h('p', {}, i18n.t('discover.earth.day')), open]];
      }
      case 'water':
        return ['discover.water.title', [list(['discover.water.range', 'discover.water.ice', 'discover.water.heat', 'discover.water.solvent', 'discover.water.zone'])]];
      case 'futures':
        return ['discover.futures.title', [h('p', {}, i18n.t('discover.futures.text'))]];
    }
  }

  /**
   * Expanding space, as a model: dots for galaxies, stretched about the dot you watch from. Every
   * distance grows by the same factor, so the farther dots move away faster, from whichever dot.
   */
  function expansionModel(): Array<Element | null> {
    const NAMES = 'ABCDEFGHIJKL';
    const base = Array.from(NAMES, (name, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      // A loose grid, nudged so it does not look like a lattice.
      return { name, x: -60 + col * 40 + ((i * 37) % 11) - 5, y: -32 + row * 32 + ((i * 53) % 9) - 4 };
    });
    let observer = 5;
    let factor = 1;
    const plot = svg('svg', { viewBox: '-140 -85 280 170', class: 'kf-expansion-plot', role: 'group', 'aria-label': i18n.t('discover.expansion.title') });
    const lines = svg('g', { class: 'kf-expansion-lines' });
    const dots = base.map((d, i) => {
      const dot = svg('circle', { r: 5, class: 'kf-expansion-dot', tabindex: '0', role: 'button', 'aria-label': i18n.t('discover.expansion.dot', { name: d.name }), 'data-testid': `expansion-dot-${d.name}` });
      const pick = (): void => {
        observer = i;
        draw();
      };
      dot.addEventListener('click', pick);
      dot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      return dot;
    });
    const labels = base.map((d) => svg('text', { class: 'kf-expansion-name', 'aria-hidden': 'true' }, d.name));
    plot.append(lines, ...dots, ...labels);
    const sliderId = uniqueId('expansion');
    const slider = h('input', { id: sliderId, type: 'range', min: '1', max: '2.5', step: '0.05', value: '1', 'data-testid': 'expansion-factor' });
    const readout = h('p', { class: 'kf-expansion-readout', 'aria-live': 'polite', 'data-testid': 'expansion-readout' });
    const chosen = h('p', { class: 'kf-expansion-chosen' });
    const distances = h('ul', { class: 'kf-discover-list kf-expansion-distances', 'data-testid': 'expansion-distances' });
    function draw(): void {
      const o = base[observer] ?? base[0];
      if (!o) return;
      base.forEach((d, i) => {
        const x = o.x + (d.x - o.x) * factor;
        const y = o.y + (d.y - o.y) * factor;
        dots[i]?.setAttribute('cx', x.toFixed(1));
        dots[i]?.setAttribute('cy', y.toFixed(1));
        dots[i]?.setAttribute('aria-pressed', String(i === observer));
        labels[i]?.setAttribute('x', (x + 7).toFixed(1));
        labels[i]?.setAttribute('y', (y - 6).toFixed(1));
      });
      // The nearest, a middling and the farthest dot from the one watched.
      const others = base.map((d, i) => ({ d, i, d0: Math.hypot(d.x - o.x, d.y - o.y) / 20 })).filter((e) => e.i !== observer).sort((a, b) => a.d0 - b.d0);
      const picks = [others[0], others[Math.floor(others.length / 2)], others[others.length - 1]].filter((e): e is NonNullable<typeof e> => e !== undefined);
      lines.replaceChildren(
        ...picks.map((e) => svg('line', { x1: o.x.toFixed(1), y1: o.y.toFixed(1), x2: (o.x + (e.d.x - o.x) * factor).toFixed(1), y2: (o.y + (e.d.y - o.y) * factor).toFixed(1), class: 'kf-expansion-line' })),
      );
      const f = i18n.number(factor, 2);
      readout.textContent = i18n.t('discover.expansion.readout', { factor: f });
      slider.setAttribute('aria-valuetext', readout.textContent);
      chosen.textContent = i18n.t('discover.expansion.chosen', { name: o.name });
      distances.replaceChildren(...picks.map((e) => h('li', {}, i18n.t('discover.expansion.distance', { name: e.d.name, d: i18n.number(e.d0 * factor, 1), d0: i18n.number(e.d0, 1) }))));
    }
    slider.addEventListener('input', () => {
      factor = Number(slider.value);
      draw();
    });
    resetters.push(() => {
      factor = 1;
      slider.value = '1';
      draw();
    });
    draw();
    return [
      h('p', {}, i18n.t('discover.expansion.lead')),
      plot,
      h('label', { for: sliderId, class: 'kf-discover-label' }, i18n.t('discover.expansion.slider')),
      slider,
      readout,
      chosen,
      distances,
      h('p', { class: 'kf-discover-hint' }, i18n.t('discover.expansion.pick')),
      h('p', { class: 'kf-discover-kind kf-discover-kind--model' }, i18n.t('discover.expansion.note')),
    ];
  }

  function supernovae(): HTMLElement {
    const rows = ['what', 'why', 'left', 'light', 'use'] as const;
    return h(
      'table',
      { class: 'kf-discover-table', 'data-testid': 'supernova-table' },
      h('thead', {}, h('tr', {}, h('td', {}), h('th', { scope: 'col' }, i18n.t('discover.sn.type2')), h('th', { scope: 'col' }, i18n.t('discover.sn.typeIa')))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, h('th', { scope: 'row' }, i18n.t(`discover.sn.${r}`)), h('td', {}, i18n.t(`discover.sn.${r}.type2`)), h('td', {}, i18n.t(`discover.sn.${r}.typeIa`))))),
    );
  }

  /** Kepler's third law from JPL's elements: each planet's year from its mean motion, against its distance cubed. */
  function orbits(): Array<Element | null> {
    const readout = h('p', { class: 'kf-expansion-readout', 'aria-live': 'polite', 'data-testid': 'orbits-readout' }, i18n.t('discover.orbits.loading'));
    const picker = h('div', { class: 'kf-discover-moments', role: 'group', 'aria-label': i18n.t('discover.orbits.title') });
    const open = h('button', { type: 'button', class: 'kf-btn kf-discover-open', 'data-testid': 'discover-orbits-open' }, i18n.t('discover.orbits.open'));
    open.addEventListener('click', () => {
      app.openUniverse(null);
    });
    interface PlanetRow { name: string; elements: { a: number }; ratesPerCentury: { L: number } }
    void app.assets.json<{ bodies: PlanetRow[] }>('assets/jpl/planets.json').then(
      ({ bodies }) => {
        const key = (name: string): string => (name === 'Earth' ? 'ui.hud.earth' : `ui.hud.planet.${name.toLowerCase()}`);
        const show = (row: PlanetRow): void => {
          const a = row.elements.a;
          const years = 36_000 / row.ratesPerCentury.L;
          readout.textContent = i18n.t('discover.orbits.readout', { name: i18n.t(key(row.name)), a: i18n.number(a, 3), years: i18n.number(years, 3), root: i18n.number(a ** 1.5, 3) });
          for (const b of picker.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.planet === row.name));
        };
        picker.replaceChildren(
          ...bodies.map((row) => {
            const b = h('button', { type: 'button', class: 'kf-discover-moment', 'aria-pressed': 'false', 'data-planet': row.name, 'data-testid': `orbit-${row.name.toLowerCase()}` }, i18n.t(key(row.name)));
            b.addEventListener('click', () => {
              show(row);
            });
            return b;
          }),
        );
        const jupiter = bodies.find((b) => b.name === 'Jupiter');
        if (jupiter) show(jupiter);
      },
      () => {
        readout.textContent = i18n.t('ui.value.unavailable');
      },
    );
    return [h('p', {}, i18n.t('discover.orbits.lead')), picker, readout, h('p', { class: 'kf-discover-hint' }, i18n.t('discover.orbits.source')), open];
  }

  function reset(): void {
    app.setExploreTime(null);
    app.focusView(null);
    for (const b of body.querySelectorAll<HTMLButtonElement>('.kf-discover-moment[data-point]')) b.setAttribute('aria-pressed', 'false');
    showCard(null);
    for (const r of resetters) r();
    mark();
  }

  return {
    element,
    open(next) {
      content = next;
      resetters = [];
      const { points = [], extras = [] } = next.explore;
      const process = processControl(next);
      if (points.length === 0 && !process && extras.length === 0) {
        element.hidden = true;
        return;
      }
      const resetButton = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discover-reset', 'data-testid': 'discover-reset' }, i18n.t('discover.reset'));
      resetButton.addEventListener('click', reset);
      const parts: Array<HTMLElement | null> = [
        h('p', { class: 'kf-discover-lead' }, i18n.t('discover.lead')),
        points.length > 0 ? moments(points) : null,
        card,
        process,
        ...extras.map((name) => extra(next, name)),
        points.length > 0 || process ? resetButton : null,
      ];
      body.replaceChildren(...parts.filter((el): el is HTMLElement => el !== null));
      showCard(null);
      element.hidden = false;
      mark();
    },
    close() {
      element.hidden = true;
      // The timeline clears the model time as Explore Mode ends; the stretch goes back to the film.
      for (const r of resetters) r();
      showCard(null);
      content = null;
      mark();
    },
  };
}
