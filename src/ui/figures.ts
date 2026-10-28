import type { App, FigureId, I18n, ScienceConstant } from '../core/types';
import { h, srOnly, svg, uniqueId } from './dom';
import { constantField, formatConstant, scientificNode, tryConstant } from './format';
import './styles/figures.css';

/* ------------------------------------------------------------------ */
/* CMB colour legend (from public/assets/cmb/cmb.json)                  */
/* ------------------------------------------------------------------ */

interface CmbMeta {
  range: readonly [number, number];
  stops: ReadonlyArray<readonly [number, string]>;
  credit: string;
}

const PLANCK_CREDIT = 'ESA and the Planck Collaboration';
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

function parseCmbMeta(raw: unknown): CmbMeta {
  const r = raw as {
    range?: unknown;
    credit?: unknown;
    colormap?: { stops?: unknown };
  };
  const range = r.range;
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    throw new Error('cmb.json: range must be [min, max]');
  }
  const stops = r.colormap?.stops;
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('cmb.json: colormap.stops missing');
  const parsed = stops.map((stop: unknown) => {
    if (!Array.isArray(stop) || typeof stop[0] !== 'number' || typeof stop[1] !== 'string' || !HEX_COLOUR.test(stop[1])) {
      throw new Error('cmb.json: each stop must be [position, "#rrggbb"]');
    }
    return [stop[0], stop[1]] as const;
  });
  return {
    range: [range[0], range[1]],
    stops: parsed,
    credit: typeof r.credit === 'string' && r.credit ? r.credit : PLANCK_CREDIT,
  };
}

let cmbMetaPromise: Promise<CmbMeta | null> | null = null;

function loadCmbMeta(app: App): Promise<CmbMeta | null> {
  cmbMetaPromise ??= app.assets
    .json<unknown>(app.assets.url('assets/cmb/cmb.json'))
    .then(parseCmbMeta)
    .catch((err: unknown) => {
      console.error('ui: could not load the CMB colour scale', err);
      return null;
    });
  return cmbMetaPromise;
}

function cmbCaption(app: App): string {
  const temperature = tryConstant(app.data, 'cmb.temperature');
  return temperature
    ? app.i18n.t('ui.cmb.caption', { kelvin: app.i18n.number(temperature.value, 1) })
    : app.i18n.t('ui.cmb.captionNoValue');
}

function renderCmbScale(meta: CmbMeta, i18n: I18n): HTMLElement {
  const [min, max] = meta.range;
  const gradient = meta.stops.map(([p, colour]) => `${colour} ${(p * 100).toFixed(2)}%`).join(', ');
  const bar = h('div', {
    class: 'kf-cmb-bar',
    role: 'img',
    'aria-label': i18n.t('ui.cmb.scaleLabel', { min: i18n.number(min, 0), max: i18n.number(max, 0) }),
  });
  bar.style.backgroundImage = `linear-gradient(to right, ${gradient})`;
  const ticks = h('div', { class: 'kf-cmb-ticks', 'aria-hidden': 'true' });
  const count = 5;
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const value = min + f * (max - min);
    const tick = h('span', { class: 'kf-cmb-tick' }, i18n.t('ui.cmb.tick', { value: i18n.number(value, 0) }));
    tick.style.setProperty('--f', String(f));
    ticks.append(tick);
  }
  // A temperature scale reads left to right (cold to hot) in every locale.
  return h('div', { class: 'kf-cmb-scale', dir: 'ltr' }, bar, ticks);
}

/** The CMB colour scale with microkelvin labels and the Planck credit. */
export function cmbLegend(app: App, attrs: Record<string, string> = {}): HTMLElement {
  const { i18n } = app;
  const scaleSlot = h('div', { class: 'kf-cmb-slot' });
  const credit = h('p', { class: 'kf-credit' }, i18n.t('ui.cmb.credit', { credit: PLANCK_CREDIT }));
  void loadCmbMeta(app).then((meta) => {
    if (!meta) return;
    scaleSlot.replaceChildren(renderCmbScale(meta, i18n));
    credit.textContent = i18n.t('ui.cmb.credit', { credit: meta.credit });
  });
  return h(
    'figure',
    { class: 'kf-figure kf-cmb-legend', ...attrs },
    h('figcaption', { class: 'kf-figure-title' }, i18n.t('ui.cmb.title')),
    scaleSlot,
    h('p', { class: 'kf-figure-note' }, cmbCaption(app)),
    credit,
  );
}

/* ------------------------------------------------------------------ */
/* Big Bang nucleosynthesis abundances (from data/constants.json)       */
/* ------------------------------------------------------------------ */

/** Fractions are stored as 0..1 unless the constant's unit says "%". */
function asPercent(c: ScienceConstant, field: 'value' | 'uncertainty'): number | null {
  const raw = constantField(c, field);
  if (raw === null) return null;
  return c.unit.trim() === '%' ? raw : raw * 100;
}

function percentText(percent: number, uncertainty: number | null, i18n: I18n): string {
  const value = i18n.number(percent, 1);
  return uncertainty === null
    ? i18n.t('ui.value.percent', { value })
    : i18n.t('ui.value.percentWithUncertainty', { value, uncertainty: i18n.number(uncertainty, 1) });
}

interface Share {
  element: 'hydrogen' | 'helium';
  percent: number;
  text: string;
}

function shareGroup(labelKey: string, shares: readonly Share[], i18n: I18n): HTMLElement {
  const bar = h('div', { class: 'kf-bbn-bar', 'aria-hidden': 'true' });
  for (const share of shares) {
    const segment = h('span', { class: `kf-bbn-seg kf-bbn-seg--${share.element}` });
    segment.style.inlineSize = `${Math.max(0, Math.min(100, share.percent))}%`;
    bar.append(segment);
  }
  return h(
    'div',
    { class: 'kf-bbn-group' },
    h('p', { class: 'kf-bbn-label' }, i18n.t(labelKey)),
    bar,
    h(
      'ul',
      { class: 'kf-bbn-values' },
      ...shares.map((s) =>
        h(
          'li',
          {},
          h('span', { class: `kf-swatch kf-swatch--${s.element}`, 'aria-hidden': 'true' }),
          i18n.t('ui.bbn.share', { element: i18n.t(`ui.bbn.${s.element}`), value: s.text }),
        ),
      ),
    ),
  );
}

function massShares(app: App): Share[] | null {
  const { data, i18n } = app;
  const hydrogen = tryConstant(data, 'bbn.hydrogen.massFraction');
  const helium = tryConstant(data, 'bbn.helium.massFraction');
  if (!hydrogen || !helium) return null;
  const hPercent = asPercent(hydrogen, 'value') ?? 0;
  const hePercent = asPercent(helium, 'value') ?? 0;
  return [
    { element: 'hydrogen', percent: hPercent, text: percentText(hPercent, asPercent(hydrogen, 'uncertainty'), i18n) },
    { element: 'helium', percent: hePercent, text: percentText(hePercent, asPercent(helium, 'uncertainty'), i18n) },
  ];
}

/** By number of atoms; hydrogen falls back to the remainder after helium when it has no constant of its own. */
function numberShares(app: App): { shares: Share[]; derived: boolean } | null {
  const { data, i18n } = app;
  const helium = tryConstant(data, 'bbn.helium.numberFraction');
  if (!helium) return null;
  const hydrogen = tryConstant(data, 'bbn.hydrogen.numberFraction');
  const hePercent = asPercent(helium, 'value') ?? 0;
  const hPercent = hydrogen ? (asPercent(hydrogen, 'value') ?? 0) : 100 - hePercent;
  const hUncertainty = hydrogen ? asPercent(hydrogen, 'uncertainty') : null;
  return {
    derived: hydrogen === null,
    shares: [
      { element: 'hydrogen', percent: hPercent, text: percentText(hPercent, hUncertainty, i18n) },
      { element: 'helium', percent: hePercent, text: percentText(hePercent, asPercent(helium, 'uncertainty'), i18n) },
    ],
  };
}

function traceList(app: App): HTMLElement | null {
  const { data, i18n } = app;
  const traces = [
    { id: 'bbn.deuterium.ratio', labelKey: 'ui.bbn.deuterium' },
    { id: 'bbn.lithium7.ratio', labelKey: 'ui.bbn.lithium7' },
  ].flatMap(({ id, labelKey }) => {
    const c = tryConstant(data, id);
    return c ? [h('li', {}, `${i18n.t(labelKey)}: `, scientificNode(c.value, i18n))] : [];
  });
  if (traces.length === 0) return null;
  return h(
    'div',
    { class: 'kf-bbn-group' },
    h('p', { class: 'kf-bbn-label' }, i18n.t('ui.bbn.traces')),
    h('ul', { class: 'kf-bbn-values kf-bbn-values--traces' }, ...traces),
  );
}

/** Abundances of the light elements after Big Bang nucleosynthesis, as bars with text values. */
export function bbnAbundances(app: App): HTMLElement {
  const { i18n } = app;
  const mass = massShares(app);
  const number = numberShares(app);
  return h(
    'figure',
    { class: 'kf-figure kf-bbn', 'data-figure': 'bbn-abundances' },
    h('figcaption', { class: 'kf-figure-title' }, i18n.t('ui.bbn.title')),
    mass ? shareGroup('ui.bbn.byMass', mass, i18n) : null,
    number ? shareGroup('ui.bbn.byNumber', number.shares, i18n) : null,
    traceList(app),
    number?.derived ? h('p', { class: 'kf-figure-note' }, i18n.t('ui.bbn.derived')) : null,
    mass || number ? null : srOnly(i18n.t('ui.value.unavailable')),
  );
}

/* ------------------------------------------------------------------ */
/* Hubble tension: early-universe inferences against the local ladder   */
/* ------------------------------------------------------------------ */

interface Measurement {
  constant: string;
  labelKey: string;
  group: 'early' | 'local';
}

const HUBBLE_MEASUREMENTS: readonly Measurement[] = [
  { constant: 'hubble.planck', labelKey: 'ui.hubble.planck', group: 'early' },
  { constant: 'hubble.act', labelKey: 'ui.hubble.act', group: 'early' },
  { constant: 'hubble.act.dr2', labelKey: 'ui.hubble.actDr2', group: 'early' },
  { constant: 'hubble.shoes', labelKey: 'ui.hubble.shoes', group: 'local' },
];
/** Axis range in km/s/Mpc. */
const HUBBLE_AXIS: readonly [number, number] = [64, 76];

/**
 * Two families of measurement that disagree: values with 1-sigma bars on one axis.
 * The text values are listed too, so the chart is never the only way to read them.
 */
export function hubbleTension(app: App): HTMLElement {
  const { i18n } = app;
  const [lo, hi] = HUBBLE_AXIS;
  const width = 320;
  const rowHeight = 26;
  const pad = { left: 8, right: 8, top: 8, bottom: 26 };
  const x = (v: number): number => pad.left + ((v - lo) / (hi - lo)) * (width - pad.left - pad.right);
  const rows = HUBBLE_MEASUREMENTS.map((m) => ({ m, c: tryConstant(app.data, m.constant) })).filter(
    (r): r is { m: Measurement; c: ScienceConstant } => r.c !== null,
  );
  const height = pad.top + rows.length * rowHeight + pad.bottom;
  const chart = svg('svg', {
    class: 'kf-hubble-chart',
    viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  for (let v = lo; v <= hi; v += 2) {
    chart.append(svg('line', { class: 'kf-hubble-grid', x1: x(v), x2: x(v), y1: pad.top, y2: height - pad.bottom }));
    const label = svg('text', { class: 'kf-hubble-tick', x: x(v), y: height - 8, 'text-anchor': 'middle' });
    label.textContent = i18n.number(v, 0);
    chart.append(label);
  }
  rows.forEach(({ c, m }, i) => {
    const y = pad.top + i * rowHeight + rowHeight / 2;
    const sigma = constantField(c, 'uncertainty') ?? 0;
    chart.append(
      svg('line', { class: `kf-hubble-bar kf-hubble-${m.group}`, x1: x(c.value - sigma), x2: x(c.value + sigma), y1: y, y2: y }),
      svg('circle', { class: `kf-hubble-dot kf-hubble-${m.group}`, cx: x(c.value), cy: y, r: 4 }),
    );
  });
  const list = h(
    'ul',
    { class: 'kf-hubble-values' },
    ...rows.map(({ c, m }) =>
      h(
        'li',
        { class: `kf-hubble-item kf-hubble-${m.group}` },
        h('span', { class: 'kf-hubble-name' }, i18n.t(m.labelKey)),
        h('span', { class: 'kf-hubble-value' }, i18n.t('ui.hubble.value', { value: formatConstant(c, i18n, 2) })),
      ),
    ),
  );
  const sigma = tryConstant(app.data, 'hubble.tension.sigma');
  return h(
    'figure',
    { class: 'kf-figure kf-hubble', 'data-figure': 'hubble-tension' },
    h('figcaption', { class: 'kf-figure-title' }, i18n.t('ui.hubble.title')),
    h('div', { class: 'kf-hubble-plot', dir: 'ltr' }, chart),
    list,
    h(
      'p',
      { class: 'kf-figure-note' },
      sigma ? i18n.t('ui.hubble.note', { sigma: i18n.number(sigma.value, 0) }) : i18n.t('ui.hubble.noteNoValue'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Nickel-56 to iron-56                                                */
/* ------------------------------------------------------------------ */

/** The decay chain behind supernova iron, with evaluated half-lives. */
export function decayChain(app: App): HTMLElement {
  const { i18n } = app;
  const ni = tryConstant(app.data, 'nuclear.ni56.halfLife');
  const co = tryConstant(app.data, 'nuclear.co56.halfLife');
  const step = (nameKey: string, life: string): HTMLElement =>
    h('li', { class: 'kf-decay-step' }, h('span', { class: 'kf-decay-nuclide' }, i18n.t(nameKey)), h('span', { class: 'kf-decay-life' }, life));
  const arrow = (): HTMLElement => h('li', { class: 'kf-decay-arrow', 'aria-hidden': 'true' }, '→');
  return h(
    'figure',
    { class: 'kf-figure kf-decay', 'data-figure': 'decay-chain' },
    h('figcaption', { class: 'kf-figure-title' }, i18n.t('ui.decay.title')),
    h(
      'ol',
      { class: 'kf-decay-chain', dir: 'ltr' },
      step('ui.decay.ni56', ni ? i18n.t('ui.decay.halfLife', { days: formatConstant(ni, i18n, 3) }) : i18n.t('ui.value.unavailable')),
      arrow(),
      step('ui.decay.co56', co ? i18n.t('ui.decay.halfLife', { days: formatConstant(co, i18n, 3) }) : i18n.t('ui.value.unavailable')),
      arrow(),
      step('ui.decay.fe56', i18n.t('ui.decay.stable')),
    ),
    h('p', { class: 'kf-figure-note' }, i18n.t('ui.decay.note')),
  );
}

/* ------------------------------------------------------------------ */
/* Stretching space (an interactive control for the scene)              */
/* ------------------------------------------------------------------ */

const STRETCH = { min: 1, max: 3, step: 0.01 } as const;

/**
 * A slider that stretches space in the scene (the chapter receives it through
 * app.interact): galaxies recede and their light reddens by the same factor, so the
 * redshift is z = a - 1. "Back to the film" returns control to the cinematic.
 */
export function expansionControl(app: App): HTMLElement {
  const { i18n } = app;
  const id = uniqueId('kf-stretch');
  const input = h('input', {
    id,
    class: 'kf-stretch-input',
    type: 'range',
    min: String(STRETCH.min),
    max: String(STRETCH.max),
    step: String(STRETCH.step),
    value: String(STRETCH.min),
  });
  const readout = h('output', { class: 'kf-stretch-readout', for: id, 'aria-live': 'polite' });
  const reset = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet' }, i18n.t('ui.stretch.back'));
  const describe = (a: number): string =>
    i18n.t('ui.stretch.readout', { factor: i18n.number(a, 2), redshift: i18n.number(a - 1, 2) });
  const show = (a: number): void => {
    readout.textContent = describe(a);
    input.setAttribute('aria-valuetext', describe(a));
  };
  input.addEventListener('input', () => {
    const a = Number(input.value);
    show(a);
    app.interact('stretch', a);
  });
  reset.addEventListener('click', () => {
    input.value = String(STRETCH.min);
    show(STRETCH.min);
    app.interact('stretch', null);
  });
  show(STRETCH.min);
  return h(
    'figure',
    { class: 'kf-figure kf-stretch', 'data-figure': 'expansion' },
    h('figcaption', { class: 'kf-figure-title' }, h('label', { for: id }, i18n.t('ui.stretch.title'))),
    input,
    readout,
    h('p', { class: 'kf-figure-note' }, i18n.t('ui.stretch.note')),
    reset,
  );
}

/* ------------------------------------------------------------------ */
/* Possible futures (Chapter 10)                                        */
/* ------------------------------------------------------------------ */

/**
 * The size of the universe over time in three hypotheses, as shapes only: a constant
 * dark energy grows it forever (heat death); a strengthening one runs away to a Big Rip;
 * a weakening one could slow it and pull it back into a Big Crunch. The curves are
 * schematic (no axis values) and say so; the panel gives the evidence.
 */
export function cosmicFutures(app: App): HTMLElement {
  const { i18n } = app;
  const width = 320;
  const height = 170;
  const pad = { left: 22, right: 10, top: 10, bottom: 22 };
  const nowT = 0.42;
  const x = (t: number): number => pad.left + t * (width - pad.left - pad.right);
  const y = (a: number): number => height - pad.bottom - a * (height - pad.top - pad.bottom);
  const path = (f: (t: number) => number, until = 1): string => {
    const points: string[] = [];
    for (let i = 0; i <= 80; i += 1) {
      const t = (i / 80) * until;
      const a = Math.min(1.05, Math.max(0, f(t)));
      points.push(`${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${y(a).toFixed(1)}`);
      if (a >= 1.05) break;
    }
    return points.join(' ');
  };
  // A shared past up to now (decelerating, then accelerating), then three futures.
  const past = (t: number): number => 0.5 * (t / nowT) ** 0.8;
  const futures = [
    { cls: 'kf-futures-heat', key: 'ui.futures.heatDeath', f: (t: number) => (t <= nowT ? past(t) : 0.5 * Math.exp(2.1 * (t - nowT))) },
    { cls: 'kf-futures-rip', key: 'ui.futures.bigRip', f: (t: number) => (t <= nowT ? past(t) : 0.5 / Math.max(0.02, 1 - (t - nowT) / 0.36) ** 0.9) },
    { cls: 'kf-futures-crunch', key: 'ui.futures.bigCrunch', f: (t: number) => (t <= nowT ? past(t) : 0.5 + 0.55 * (t - nowT) - 1.25 * (t - nowT) ** 2) },
  ] as const;
  const chart = svg('svg', { class: 'kf-futures-chart', viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' });
  chart.append(
    svg('line', { class: 'kf-futures-axis', x1: x(0), x2: x(1), y1: y(0), y2: y(0) }),
    svg('line', { class: 'kf-futures-axis', x1: x(0), x2: x(0), y1: y(0), y2: y(1.05) }),
    svg('line', { class: 'kf-futures-now', x1: x(nowT), x2: x(nowT), y1: y(0), y2: y(1.05) }),
  );
  const nowLabel = svg('text', { class: 'kf-futures-label', x: x(nowT) + 4, y: y(1.02) });
  nowLabel.textContent = i18n.t('ui.futures.now');
  const timeLabel = svg('text', { class: 'kf-futures-label', x: x(1), y: height - 6, 'text-anchor': 'end' });
  timeLabel.textContent = i18n.t('ui.futures.axisTime');
  const sizeLabel = svg('text', { class: 'kf-futures-label', x: 4, y: pad.top + 4, transform: `rotate(90 4 ${pad.top + 4})` });
  sizeLabel.textContent = i18n.t('ui.futures.axisSize');
  chart.append(nowLabel, timeLabel, sizeLabel);
  for (const future of futures) chart.append(svg('path', { class: `kf-futures-line ${future.cls}`, d: path(future.f) }));
  return h(
    'figure',
    { class: 'kf-figure kf-futures', 'data-figure': 'cosmic-futures' },
    h('figcaption', { class: 'kf-figure-title' }, i18n.t('ui.futures.title')),
    h('div', { class: 'kf-futures-plot', dir: 'ltr' }, chart),
    h('ul', { class: 'kf-futures-legend' }, ...futures.map((f) => h('li', { class: `kf-futures-item ${f.cls}` }, i18n.t(f.key)))),
    h('p', { class: 'kf-figure-note' }, i18n.t('ui.futures.caption')),
  );
}

export function figure(app: App, id: FigureId): HTMLElement {
  switch (id) {
    case 'bbn-abundances':
      return bbnAbundances(app);
    case 'cmb-legend':
      return cmbLegend(app, { 'data-figure': 'cmb-legend' });
    case 'hubble-tension':
      return hubbleTension(app);
    case 'decay-chain':
      return decayChain(app);
    case 'expansion':
      return expansionControl(app);
    case 'cosmic-futures':
      return cosmicFutures(app);
  }
}
