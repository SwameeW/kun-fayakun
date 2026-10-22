import type { App, FigureId, I18n, ScienceConstant } from '../core/types';
import { h, srOnly } from './dom';
import { constantField, scientificNode, tryConstant } from './format';
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

export function figure(app: App, id: FigureId): HTMLElement {
  return id === 'bbn-abundances' ? bbnAbundances(app) : cmbLegend(app, { 'data-figure': 'cmb-legend' });
}
