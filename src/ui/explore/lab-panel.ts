import { julianDateUtc } from '../../astro/time';
import labMessages from '../../i18n/en.lab.json';
import type { App, LabCommand, LabQuantity, UniverseLab, UniverseLabBody, UniverseView } from '../../core/types';
import { h, svg, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * The orbital laboratory's panel (heading the navigator while an experiment runs): what it is (an
 * experiment forked from the solar system, with its approximations said), the way back to the real
 * explorer, undo and redo, its bodies (tick several to duplicate or remove them together), the chosen
 * body's inspector and edits (its name; mass, radius and density with one held; its velocity, a push
 * along its orbit, or its whole orbit by elements; its rotation; held in place; duplicate, remove,
 * follow; how far ahead and how finely to look, with the encounters on the way; its Lagrange points),
 * adding a body (from a palette of real ones, on a circular orbit, at a position and velocity, or placed
 * with the pointer), how paths are drawn, measurements, a quantity followed over time, the conservation
 * checks since the last edit, the edits and collisions so far, and the scenario's tools (save in this
 * browser and in a library by name, a link, load, export, import, checkpoints, replay, reset). Names
 * from the scenario are text, never markup. Numbers are rewritten only when they change; nothing here
 * is a live region (the clock runs every frame).
 */

export interface LabPanel {
  readonly element: HTMLElement;
  update(view: UniverseView, slow: boolean): void;
}

/** Leinhardt and Stewart's regimes, as message keys. */
const REGIME_KEYS = { merge: 'merge', 'partial-accretion': 'partialAccretion', 'hit-and-run': 'hitAndRun', erosion: 'erosion', 'super-catastrophic': 'superCatastrophic' } as const;
const HORIZONS: ReadonlyArray<readonly [number, string]> = [
  [10 * 86_400, 'days10'],
  [60 * 86_400, 'days60'],
  [365.25 * 86_400, 'year1'],
  [10 * 365.25 * 86_400, 'years10'],
];
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** A megaton of TNT, in joules (the convention: 4.184 x 10^15 J). */
const MEGATON_J = 4.184e15;
const KINDS = ['star', 'giant', 'rocky', 'moon', 'dwarf', 'asteroid', 'comet'] as const;
const QUANTITIES: readonly LabQuantity[] = ['distance', 'speed', 'eccentricity', 'energyDrift'];
const POINTS = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
/** The chart's size (SVG units). */
const CHART = { w: 280, h: 96, pad: 4 } as const;
/** Particles a ring or belt may have. */
const RING_COUNTS = [500, 1000, 2000] as const;
/**
 * Belts about the most massive body (au; then the largest eccentricity and inclination, degrees): the
 * main asteroid belt between Jupiter's 4:1 and 2:1 resonances (2.06 to 3.27 au), and the classical
 * Kuiper belt from the 3:2 resonance with Neptune (39.4 au) to about 48 au.
 */
const BELTS = { asteroid: [2.06, 3.27, 0.2, 15], kuiper: [39.4, 48, 0.1, 10] } as const;
/** A ring of test particles about the chosen body, in its equator's plane (its radii). */
const RING = { inner: 1.5, outer: 2.5 } as const;
/** A gravitating ring: its bodies, where (the chosen body's radii: outside a rocky body's Roche limit, about 2.5) and its mass (a share of the chosen body's). */
const MOONLETS = { count: 12, inner: 2.8, outer: 3.2, massShare: 1e-4 } as const;

export function createLabPanel(app: App, f: Formatters): LabPanel {
  const { i18n } = app;
  // The laboratory's own messages come with its chunk.
  i18n.extend('en.lab.json', labMessages);
  const send = (c: LabCommand): void => {
    app.universeLab(c);
  };
  const write = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };
  const button = (text: string, testId: string, onClick: () => void, cls = 'kf-living-go'): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: cls, 'data-testid': testId }, text);
    b.addEventListener('click', onClick);
    return b;
  };
  /**
   * Fills a list from keyed items, keeping the elements of keys still listed in place: a button under
   * the pointer, or holding the focus, stays put while the running clock adds items around it.
   */
  const keyedList = (list: HTMLElement): ((items: Array<{ key: string; make: () => HTMLElement }>) => void) => {
    const made = new Map<string, HTMLElement>();
    return (items) => {
      const wanted = new Set(items.map((item) => item.key));
      for (const [key, el] of made) {
        if (wanted.has(key)) continue;
        el.remove();
        made.delete(key);
      }
      items.forEach((item, index) => {
        let el = made.get(item.key);
        if (!el) {
          el = item.make();
          made.set(item.key, el);
        }
        const at = list.children[index] ?? null;
        if (at !== el) list.insertBefore(el, at);
      });
    };
  };
  const scientific = (value: number): string => {
    if (value === 0) return '0';
    const exponent = Math.floor(Math.log10(Math.abs(value)));
    if (exponent >= -2 && exponent < 6) return f.number(value, Math.abs(value) < 10 ? 3 : 0);
    const mantissa = value / 10 ** exponent;
    const digits = String(Math.abs(exponent)).split('').map((d) => SUPERSCRIPT[Number(d)] ?? d).join('');
    return `${f.number(mantissa, 3)} × 10${exponent < 0 ? '⁻' : ''}${digits}`;
  };
  /** An energy as megatons of TNT (4.184 x 10^15 J each), in plain figures up to a thousand. */
  const megatons = (joulesValue: number): string => {
    const mt = joulesValue / MEGATON_J;
    return mt < 1000 ? f.number(mt, mt < 10 ? 2 : 0) : scientific(mt);
  };
  /** A crater's depth: metres below a kilometre (the distance format starts at whole kilometres). */
  const depthText = (kmValue: number): string => (kmValue < 1 ? f.keep(i18n.t('ui.universe.lab.metres', { value: f.number(kmValue * 1000, 0) })) : f.keep(i18n.t('ui.universe.lab.km', { value: f.number(kmValue, kmValue < 10 ? 1 : 0) })));
  const days = (s: number): string => f.keep(i18n.t('ui.universe.lab.days', { value: f.number(s / 86_400, s < 864_000 ? 2 : 1) }));
  const speed = (v: number): string => f.keep(i18n.t('ui.universe.lab.kms', { value: f.number(v, v < 10 ? 3 : 2) }));
  const duration = (sec: number): string => (sec < 2 * 86_400 ? f.keep(i18n.t('ui.universe.lab.hours', { value: f.number(sec / 3600, sec < 36_000 ? 2 : 1) })) : sec < 2 * 365.25 * 86_400 ? days(sec) : f.keep(i18n.t('ui.universe.lab.years', { value: f.number(sec / (365.25 * 86_400), 2) })));
  const degrees = (d: number): string => f.number(d, Math.abs(d) < 10 ? 2 : 1);
  /** Light's travel time: seconds, minutes or hours. */
  const lightTime = (sec: number): string => (sec < 120 ? f.keep(i18n.t('ui.universe.lab.seconds', { value: f.number(sec, sec < 10 ? 2 : 0) })) : sec < 7200 ? f.keep(i18n.t('ui.universe.lab.minutes', { value: f.number(sec / 60, 1) })) : f.keep(i18n.t('ui.universe.lab.hours', { value: f.number(sec / 3600, 2) })));
  const nameOf = (b: UniverseLabBody): string => (b.builtIn && !b.renamed ? f.name(b.builtIn) : b.name);
  const presetName = (id: string): string => i18n.t(`ui.universe.lab.presetName.${id}`);
  const num = (input: HTMLInputElement): number => Number(input.value.replace(/[\s,]/gu, ''));
  const field = (key: string, testId: string, value = '', mode: 'decimal' | 'text' = 'decimal'): { label: HTMLLabelElement; input: HTMLInputElement } => {
    const id = uniqueId(testId);
    return { label: h('label', { class: 'kf-living-label', for: id }, i18n.t(key)), input: h('input', { id, type: 'text', inputmode: mode, class: 'kf-living-input', 'data-testid': testId, value, autocomplete: 'off', spellcheck: 'false' }) };
  };
  const select = (key: string, testId: string, options: ReadonlyArray<readonly [string, string]>): { label: HTMLLabelElement; select: HTMLSelectElement } => {
    const id = uniqueId(testId);
    return { label: h('label', { class: 'kf-living-label', for: id }, i18n.t(key)), select: h('select', { id, class: 'kf-living-input', 'data-testid': testId }, ...options.map(([value, text]) => h('option', { value }, text))) };
  };
  const details = (key: string, testId: string, ...children: Array<Node | null>): HTMLDetailsElement =>
    h('details', { class: 'kf-living-notes-part kf-living-prophets-box', 'data-testid': testId }, h('summary', {}, i18n.t(key)), h('div', { class: 'kf-living-prophets-body' }, ...children));

  // Head: what this is, and the way back.
  const title = h('h3', { class: 'kf-living-notes-title' }, i18n.t('ui.universe.lab.title'));
  const note = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-note' });
  const clock = h('p', { class: 'kf-lab-clock', 'data-testid': 'lab-clock' });
  const rates = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-rates' });
  const back = button(i18n.t('ui.universe.lab.back'), 'lab-back', () => {
    app.closeLab();
  }, 'kf-btn kf-living-tour-start');
  const failure = h('p', { class: 'kf-lab-warning', 'data-testid': 'lab-failure', role: 'alert', hidden: true });

  // Undo and redo (also Ctrl or Cmd + Z, and with Shift, or Ctrl + Y).
  const undo = button(i18n.t('ui.universe.lab.undo'), 'lab-undo', () => {
    send({ kind: 'undo' });
  });
  const redo = button(i18n.t('ui.universe.lab.redo'), 'lab-redo', () => {
    send({ kind: 'redo' });
  });
  const history = h('div', { class: 'kf-lab-row' }, undo, redo);

  // Bodies, each with a tick for doing something to several at once.
  const list = h('ul', { class: 'kf-living-list kf-lab-bodies', 'aria-label': i18n.t('ui.universe.lab.bodies'), 'data-testid': 'lab-bodies' });
  let listKey = '';
  const ticked = new Set<string>();
  const manyText = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-many' });
  const many = h(
    'div',
    { class: 'kf-living-group', hidden: true },
    manyText,
    h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.manyDuplicate'), 'lab-many-duplicate', () => {
      send({ kind: 'duplicateMany', ids: [...ticked] });
      ticked.clear();
      listKey = '';
    }), button(i18n.t('ui.universe.lab.manyRemove'), 'lab-many-remove', () => {
      send({ kind: 'removeMany', ids: [...ticked] });
      ticked.clear();
      listKey = '';
    })),
  );

  // The inspector.
  const inspectorTitle = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'lab-selected-name' });
  const facts = h('dl', { class: 'kf-about-facts', 'data-testid': 'lab-facts' });
  const warning = h('p', { class: 'kf-lab-warning', 'data-testid': 'lab-warning', hidden: true });
  const rename = field('ui.universe.lab.renameLabel', 'lab-rename-input', '', 'text');
  const renameApply = button(i18n.t('ui.universe.lab.rename'), 'lab-rename-apply', () => {
    if (selectedId && rename.input.value.trim()) send({ kind: 'rename', id: selectedId, name: rename.input.value });
  });
  // Mass, radius and density, one held when another changes.
  const hold = select('ui.universe.lab.hold', 'lab-hold', [
    ['radius', i18n.t('ui.universe.lab.hold.radius')],
    ['density', i18n.t('ui.universe.lab.hold.density')],
    ['mass', i18n.t('ui.universe.lab.hold.mass')],
  ]);
  const massId = uniqueId('lab-mass');
  const massInput = h('input', { id: massId, type: 'text', inputmode: 'decimal', class: 'kf-living-input', 'data-testid': 'lab-mass-input', autocomplete: 'off', spellcheck: 'false' });
  const massApply = button(i18n.t('ui.universe.lab.apply'), 'lab-mass-apply', () => {
    const v = num(massInput);
    if (selectedId && Number.isFinite(v) && v >= 0) send({ kind: 'mass', id: selectedId, massKg: v, keep: hold.select.value === 'density' ? 'density' : 'radius' });
  });
  const double = button(i18n.t('ui.universe.lab.double'), 'lab-mass-double', () => {
    const b = selectedBody();
    if (b) send({ kind: 'mass', id: b.id, massKg: b.massKg * 2, keep: hold.select.value === 'density' ? 'density' : 'radius' });
  });
  const halve = button(i18n.t('ui.universe.lab.halve'), 'lab-mass-halve', () => {
    const b = selectedBody();
    if (b) send({ kind: 'mass', id: b.id, massKg: b.massKg / 2, keep: hold.select.value === 'density' ? 'density' : 'radius' });
  });
  const radius = field('ui.universe.lab.radiusLabel', 'lab-radius-input');
  const radiusApply = button(i18n.t('ui.universe.lab.apply'), 'lab-radius-apply', () => {
    const v = num(radius.input);
    if (selectedId && Number.isFinite(v) && v > 0) send({ kind: 'radius', id: selectedId, radiusKm: v, keep: hold.select.value === 'density' ? 'density' : 'mass' });
  });
  const density = field('ui.universe.lab.densityLabel', 'lab-density-input');
  const densityApply = button(i18n.t('ui.universe.lab.apply'), 'lab-density-apply', () => {
    const v = num(density.input);
    if (selectedId && Number.isFinite(v) && v > 0) send({ kind: 'density', id: selectedId, densityKgM3: v, keep: hold.select.value === 'radius' ? 'radius' : 'mass' });
  });
  // Velocity, and a push along its orbit.
  const velIds = [uniqueId('lab-vx'), uniqueId('lab-vy'), uniqueId('lab-vz')];
  const velInputs = velIds.map((id, k) => h('input', { id, type: 'text', inputmode: 'decimal', class: 'kf-living-input kf-lab-vec', 'data-testid': `lab-vel-${'xyz'[k] ?? ''}`, autocomplete: 'off' }));
  const velApply = button(i18n.t('ui.universe.lab.apply'), 'lab-vel-apply', () => {
    const v = velInputs.map((i) => num(i));
    if (selectedId && v.every(Number.isFinite)) send({ kind: 'velocity', id: selectedId, relativeKmS: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] });
  });
  const pushes = (['prograde', 'normal', 'radial'] as const).map((k) => field(`ui.universe.lab.impulse.${k}`, `lab-impulse-${k}`, '0'));
  const pushApply = button(i18n.t('ui.universe.lab.apply'), 'lab-impulse-apply', () => {
    const [p, n, r] = pushes.map((x) => num(x.input));
    if (selectedId && [p, n, r].every((x) => x !== undefined && Number.isFinite(x))) {
      send({ kind: 'impulse', id: selectedId, progradeMs: p ?? 0, normalMs: n ?? 0, radialMs: r ?? 0 });
      for (const x of pushes) x.input.value = '0';
    }
  });
  // Its whole orbit, by elements.
  const elementKeys = ['a', 'e', 'i', 'node', 'arg', 'nu'] as const;
  const elements = elementKeys.map((k) => field(`ui.universe.lab.el.${k}`, `lab-el-${k}`));
  const elementsHint = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-elements-hint' });
  const elementsApply = button(i18n.t('ui.universe.lab.apply'), 'lab-el-apply', () => {
    const v = elements.map((x) => num(x.input));
    if (selectedId && v.every(Number.isFinite)) send({ kind: 'elements', id: selectedId, aKm: v[0] ?? 0, e: v[1] ?? 0, iDeg: v[2] ?? 0, nodeDeg: v[3] ?? 0, periapsisArgDeg: v[4] ?? 0, trueAnomalyDeg: v[5] ?? 0 });
  });
  const elementsBox = details('ui.universe.lab.elements', 'lab-elements', elementsHint, ...elements.flatMap((x) => [x.label, x.input]), elementsApply);
  // Its rotation.
  const spinPeriod = field('ui.universe.lab.spinPeriod', 'lab-spin-period');
  const spinTilt = field('ui.universe.lab.spinTilt', 'lab-spin-tilt');
  const spinApply = button(i18n.t('ui.universe.lab.apply'), 'lab-spin-apply', () => {
    const p = num(spinPeriod.input);
    const t = num(spinTilt.input);
    if (selectedId && Number.isFinite(p) && p > 0 && Number.isFinite(t)) send({ kind: 'spin', id: selectedId, periodS: p * 3600, tiltDeg: t });
  });
  // Held in place.
  const fixedId = uniqueId('lab-fixed');
  const fixedBox = h('input', { id: fixedId, type: 'checkbox', class: 'kf-lab-check', 'data-testid': 'lab-fixed' });
  fixedBox.addEventListener('change', () => {
    if (selectedId) send({ kind: 'fixed', id: selectedId, fixed: fixedBox.checked });
  });
  const duplicate = button(i18n.t('ui.universe.lab.duplicate'), 'lab-duplicate', () => {
    if (selectedId) send({ kind: 'duplicate', id: selectedId });
  });
  const remove = button(i18n.t('ui.universe.lab.remove'), 'lab-remove', () => {
    if (selectedId) send({ kind: 'remove', id: selectedId });
  });
  const follow = button(i18n.t('ui.universe.lab.follow'), 'lab-follow', () => {
    const b = selectedBody();
    if (b?.builtIn) app.focusBody(b.builtIn);
  });
  // How far ahead, and how finely; the encounters on the way.
  const horizonId = uniqueId('lab-horizon');
  const horizon = h('select', { id: horizonId, class: 'kf-living-input', 'data-testid': 'lab-horizon' }, ...HORIZONS.map(([s, key]) => h('option', { value: String(s) }, i18n.t(`ui.universe.lab.horizon.${key}`))));
  horizon.addEventListener('change', () => {
    send({ kind: 'horizon', seconds: Number(horizon.value) });
  });
  const accuracy = select('ui.universe.lab.accuracy', 'lab-accuracy', [
    ['normal', i18n.t('ui.universe.lab.accuracy.normal')],
    ['precise', i18n.t('ui.universe.lab.accuracy.precise')],
    ['fast', i18n.t('ui.universe.lab.accuracy.fast')],
  ]);
  accuracy.select.addEventListener('change', () => {
    const v = accuracy.select.value;
    send({ kind: 'accuracy', level: v === 'precise' ? 'precise' : v === 'fast' ? 'fast' : 'normal' });
  });
  const predictionText = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-prediction' });
  const encounters = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.encounters'), 'data-testid': 'lab-encounters' });
  let encounterKey = '';
  // Its Lagrange points with its primary, and a body put at one.
  const lagrangeId = uniqueId('lab-lagrange');
  const lagrangeBox = h('input', { id: lagrangeId, type: 'checkbox', class: 'kf-lab-check', 'data-testid': 'lab-lagrange' });
  lagrangeBox.addEventListener('change', () => {
    send({ kind: 'lagrange', on: lagrangeBox.checked });
  });
  const lagrangeLabel = h('label', { class: 'kf-living-label kf-lab-check-label', for: lagrangeId });
  const lagrangePoint = select('ui.universe.lab.lagrangeAdd', 'lab-lagrange-point', POINTS.map((p) => [p, p] as const));
  lagrangePoint.select.value = 'L4';
  const lagrangeAdd = button(i18n.t('ui.universe.lab.add.orbitShort'), 'lab-lagrange-add', () => {
    const point = lagrangePoint.select.value as (typeof POINTS)[number];
    send({ kind: 'addLagrange', point, massKg: 0, radiusKm: 1, name: i18n.t('ui.universe.lab.lagrangeName', { point }) });
  });
  const lagrangeGroup = h('div', { class: 'kf-living-group' }, h('div', { class: 'kf-lab-row' }, lagrangeBox, lagrangeLabel), lagrangePoint.label, h('div', { class: 'kf-lab-row' }, lagrangePoint.select, lagrangeAdd));

  const inspector = h(
    'section',
    { class: 'kf-living-notes-part', 'data-testid': 'lab-inspector', hidden: true },
    inspectorTitle,
    facts,
    warning,
    h('div', { class: 'kf-living-group' }, rename.label, h('div', { class: 'kf-lab-row' }, rename.input, renameApply)),
    h(
      'div',
      { class: 'kf-living-group' },
      hold.label,
      hold.select,
      h('label', { class: 'kf-living-label', for: massId }, i18n.t('ui.universe.lab.massLabel')),
      h('div', { class: 'kf-lab-row' }, massInput, massApply),
      h('div', { class: 'kf-lab-row' }, double, halve),
      radius.label,
      h('div', { class: 'kf-lab-row' }, radius.input, radiusApply),
      density.label,
      h('div', { class: 'kf-lab-row' }, density.input, densityApply),
    ),
    h(
      'fieldset',
      { class: 'kf-living-group kf-lab-fieldset' },
      h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.velocityLabel')),
      h('div', { class: 'kf-lab-row' }, ...velInputs.flatMap((input, k) => [h('label', { class: 'kf-sr-only', for: velIds[k] ?? '' }, i18n.t(`ui.universe.lab.axis.${'xyz'[k] ?? 'x'}`)), input]), velApply),
      h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.dragHint')),
    ),
    h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.impulse')), ...pushes.flatMap((x) => [x.label, x.input]), pushApply),
    elementsBox,
    h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.spin')), spinPeriod.label, spinPeriod.input, spinTilt.label, spinTilt.input, spinApply),
    h('div', { class: 'kf-lab-row' }, fixedBox, h('label', { class: 'kf-living-label kf-lab-check-label', for: fixedId }, i18n.t('ui.universe.lab.fixed'))),
    h('div', { class: 'kf-lab-row' }, duplicate, remove, follow),
    h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: horizonId }, i18n.t('ui.universe.lab.horizon')), horizon, accuracy.label, accuracy.select, predictionText, encounters),
    lagrangeGroup,
  );

  // Add a body: from the palette, or by its own numbers; on a circular orbit, at a state, or placed with the pointer.
  const search = field('ui.universe.lab.add.search', 'lab-palette-search', '', 'text');
  const palette = h('div', { class: 'kf-lab-palette', 'data-testid': 'lab-palette' });
  let paletteKey = '';
  let chosenPreset: string | null = null;
  const addName = field('ui.universe.lab.add.name', 'lab-add-name', i18n.t('ui.universe.lab.add.defaultName'), 'text');
  const addMass = field('ui.universe.lab.add.mass', 'lab-add-mass', '7.346e22');
  const addRadius = field('ui.universe.lab.add.radius', 'lab-add-radius', '1737');
  const addDistance = field('ui.universe.lab.add.distance', 'lab-add-distance', '600000');
  for (const x of [addName, addMass, addRadius]) {
    x.input.addEventListener('input', () => {
      chosenPreset = null;
      paletteKey = '';
    });
  }
  const primaryId = uniqueId('lab-primary');
  const addPrimary = h('select', { id: primaryId, class: 'kf-living-input', 'data-testid': 'lab-add-primary' });
  let primaryKey = '';
  const addOrbit = button(i18n.t('ui.universe.lab.add.orbit'), 'lab-add-orbit', () => {
    const m = num(addMass.input);
    const r = num(addRadius.input);
    const d = num(addDistance.input);
    if (!addPrimary.value || !Number.isFinite(d)) return;
    if (chosenPreset) send({ kind: 'addPreset', preset: chosenPreset, primary: addPrimary.value, distanceKm: d, name: addName.input.value.trim() });
    else if ([m, r].every(Number.isFinite)) send({ kind: 'addOrbit', primary: addPrimary.value, distanceKm: d, massKg: m, radiusKm: r, name: addName.input.value.trim() });
  }, 'kf-btn kf-living-tour-start');
  const placingText = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-placing', hidden: true });
  const place = button(i18n.t('ui.universe.lab.add.place'), 'lab-place', () => {
    if (placingNow) {
      send({ kind: 'place', on: false });
      return;
    }
    const m = num(addMass.input);
    const r = num(addRadius.input);
    if (addPrimary.value && (chosenPreset || [m, r].every(Number.isFinite))) send({ kind: 'place', on: true, primary: addPrimary.value, name: addName.input.value.trim(), massKg: m, radiusKm: r, preset: chosenPreset });
  });
  const posFields = ['x', 'y', 'z'].map((a, k) => field(`ui.universe.lab.axis.${a}`, `lab-add-pos-${a}`, k === 0 ? '600000' : '0'));
  const velFields = ['x', 'y', 'z'].map((a, k) => field(`ui.universe.lab.axis.${a}`, `lab-add-vel-${a}`, k === 1 ? '0.8' : '0'));
  const addState = button(i18n.t('ui.universe.lab.add.state'), 'lab-add-state', () => {
    const pos = posFields.map((x) => num(x.input));
    const vel = velFields.map((x) => num(x.input));
    const m = num(addMass.input);
    const r = num(addRadius.input);
    if (addPrimary.value && [...pos, ...vel, m, r].every(Number.isFinite)) {
      send({ kind: 'addState', relativeTo: addPrimary.value, posKm: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0], velKmS: [vel[0] ?? 0, vel[1] ?? 0, vel[2] ?? 0], massKg: m, radiusKm: r, name: addName.input.value.trim() });
    }
  });
  const add = details(
    'ui.universe.lab.add.title',
    'lab-add',
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.add.intro')),
    search.label,
    search.input,
    palette,
    addName.label,
    addName.input,
    addMass.label,
    addMass.input,
    addRadius.label,
    addRadius.input,
    h('label', { class: 'kf-living-label', for: primaryId }, i18n.t('ui.universe.lab.add.primary')),
    addPrimary,
    addDistance.label,
    addDistance.input,
    h('div', { class: 'kf-lab-row' }, addOrbit, place),
    placingText,
    h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.add.position')), h('div', { class: 'kf-lab-row' }, ...posFields.flatMap((x) => [x.label, x.input]))),
    h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.add.velocity')), h('div', { class: 'kf-lab-row' }, ...velFields.flatMap((x) => [x.label, x.input]))),
    addState,
  );
  search.input.addEventListener('input', () => {
    paletteKey = '';
  });

  // How paths are drawn.
  const viewSelect = select('ui.universe.lab.view', 'lab-view', [
    ['primary', i18n.t('ui.universe.lab.view.primary')],
    ['inertial', i18n.t('ui.universe.lab.view.inertial')],
    ['corotating', i18n.t('ui.universe.lab.view.corotating')],
    ['bodyfixed', i18n.t('ui.universe.lab.view.bodyfixed')],
  ]);
  viewSelect.select.addEventListener('change', () => {
    const v = viewSelect.select.value;
    send({ kind: 'view', view: v === 'inertial' ? 'inertial' : v === 'corotating' ? 'corotating' : v === 'bodyfixed' ? 'bodyfixed' : 'primary' });
  });
  const viewText = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-view-text' }, i18n.t('ui.universe.lab.viewHint'));
  const viewBox = details('ui.universe.lab.viewTitle', 'lab-view-box', viewSelect.label, viewSelect.select, viewText);

  // Measurements.
  const none = i18n.t('ui.universe.lab.measure.none');
  const measureFrom = select('ui.universe.lab.measure.from', 'lab-measure-from', []);
  const measureTo = select('ui.universe.lab.measure.to', 'lab-measure-to', []);
  const measureVia = select('ui.universe.lab.measure.via', 'lab-measure-via', []);
  const measureResult = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-measure-result' });
  const measureAngle = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-measure-angle' });
  const askMeasure = (): void => {
    send({ kind: 'measure', from: measureFrom.select.value || null, to: measureTo.select.value || null, via: measureVia.select.value || null });
  };
  for (const x of [measureFrom, measureTo, measureVia]) x.select.addEventListener('change', askMeasure);
  const measureBox = details('ui.universe.lab.measure', 'lab-measure', measureFrom.label, measureFrom.select, measureTo.label, measureTo.select, measureVia.label, measureVia.select, measureResult, measureAngle);

  // A quantity followed over time.
  const graphBody = select('ui.universe.lab.graph.body', 'lab-graph-body', []);
  const graphQuantity = select('ui.universe.lab.graph.quantity', 'lab-graph-quantity', QUANTITIES.map((q) => [q, i18n.t(`ui.universe.lab.quantity.${q}`)] as const));
  const askGraph = (): void => {
    const q = graphQuantity.select.value as LabQuantity;
    send({ kind: 'track', id: graphBody.select.value || null, quantity: QUANTITIES.includes(q) ? q : 'distance' });
  };
  graphBody.select.addEventListener('change', askGraph);
  graphQuantity.select.addEventListener('change', askGraph);
  const line = svg('polyline', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke', points: '' });
  const chart = svg('svg', { class: 'kf-lab-chart', viewBox: `0 0 ${CHART.w} ${CHART.h}`, role: 'img', 'aria-label': '', 'data-testid': 'lab-graph', preserveAspectRatio: 'none' }, svg('rect', { x: '0', y: '0', width: String(CHART.w), height: String(CHART.h), fill: 'none', stroke: 'currentColor', 'stroke-opacity': '0.25' }), line);
  const graphSummary = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-graph-summary' });
  const graphBox = details('ui.universe.lab.graph', 'lab-graph-box', graphBody.label, graphBody.select, graphQuantity.label, graphQuantity.select, chart, graphSummary);
  let graphKey = '';

  // Checks and history.
  const checks = h('dl', { class: 'kf-about-facts', 'data-testid': 'lab-checks' });
  const constrained = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-constrained', hidden: true }, i18n.t('ui.universe.lab.constrained'));
  const historyList = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.history'), 'data-testid': 'lab-history' });
  let historyKey = '';

  // Scenario tools: this browser, a library by name, a link, files, checkpoints.
  const status = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-status' });
  const importId = uniqueId('lab-import');
  const importInput = h('input', { id: importId, type: 'file', accept: 'application/json,.json', class: 'kf-sr-only', 'data-testid': 'lab-import-file' });
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) return;
    // At most a few megabytes: a larger file is refused before it is read.
    if (file.size > 4_000_000) {
      write(status, i18n.t('ui.universe.lab.status.tooLarge'));
      return;
    }
    void file.text().then((text) => {
      send({ kind: 'import', text });
    });
    importInput.value = '';
  });
  const libraryName = field('ui.universe.lab.libraryName', 'lab-library-name', '', 'text');
  const librarySave = button(i18n.t('ui.universe.lab.librarySave'), 'lab-library-save', () => {
    if (libraryName.input.value.trim()) send({ kind: 'saveAs', name: libraryName.input.value });
  });
  const library = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.library'), 'data-testid': 'lab-library' });
  let libraryKey = '';
  const shareUrlId = uniqueId('lab-share-url');
  const shareUrl = h('input', { id: shareUrlId, type: 'text', class: 'kf-living-input', readonly: true, 'data-testid': 'lab-share-url', hidden: true });
  const shareCopy = button(i18n.t('ui.universe.lab.shareCopy'), 'lab-share-copy', () => {
    // The clipboard needs a secure page; elsewhere the link is selected for copying by hand.
    const clip = navigator.clipboard as Clipboard | undefined;
    if (!clip) {
      shareUrl.select();
      return;
    }
    void clip.writeText(shareUrl.value).then(
      () => {
        write(shareNote, i18n.t('ui.universe.lab.shareCopied'));
      },
      () => {
        shareUrl.select();
      },
    );
  });
  shareCopy.hidden = true;
  const shareNote = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-share-note' });
  const checkpoints = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.checkpoints'), 'data-testid': 'lab-checkpoints' });
  let checkpointKey = '';
  const fillCheckpoints = keyedList(checkpoints);
  const tools = details(
    'ui.universe.lab.tools',
    'lab-tools',
    h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.save'), 'lab-save', () => {
      send({ kind: 'save' });
    }), button(i18n.t('ui.universe.lab.restoreSaved'), 'lab-restore-saved', () => {
      send({ kind: 'restoreSaved' });
    })),
    h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.export'), 'lab-export', () => {
      send({ kind: 'export' });
    }), h('label', { class: 'kf-living-go kf-lab-file', for: importId }, i18n.t('ui.universe.lab.import')), importInput),
    status,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.library')),
    libraryName.label,
    h('div', { class: 'kf-lab-row' }, libraryName.input, librarySave),
    library,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.share')),
    button(i18n.t('ui.universe.lab.shareMake'), 'lab-share', () => {
      send({ kind: 'share' });
    }),
    h('label', { class: 'kf-sr-only', for: shareUrlId }, i18n.t('ui.universe.lab.share')),
    shareUrl,
    shareCopy,
    shareNote,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.checkpoints')),
    checkpoints,
    h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.replay'), 'lab-replay', () => {
      send({ kind: 'replay' });
    }), button(i18n.t('ui.universe.lab.reset'), 'lab-reset', () => {
      send({ kind: 'reset' });
    })),
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.presets')),
    h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.preset.solar'), 'lab-preset-solar', () => {
      send({ kind: 'start', seed: 'solar' });
    }), button(i18n.t('ui.universe.lab.preset.two'), 'lab-preset-two', () => {
      send({ kind: 'start', seed: 'two' });
    }), button(i18n.t('ui.universe.lab.preset.three'), 'lab-preset-three', () => {
      send({ kind: 'start', seed: 'three' });
    })),
  );

  // Rings and belts (ledger IM-6): test particles, or a gravitating ring of a few bodies; Saturn's drawn rings are the third kind, decorative.
  const ringCount = select('ui.universe.lab.rings.count', 'lab-ring-count', RING_COUNTS.map((n) => [String(n), f.number(n, 0)] as const));
  ringCount.select.value = '1000';
  const ringsDecorative = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-rings-decorative', hidden: true }, i18n.t('ui.universe.lab.rings.decorative'));
  const ringsNeed = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-rings-need' }, i18n.t('ui.universe.lab.rings.need'));
  const ringsList = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.rings.title'), 'data-testid': 'lab-rings-list' });
  const fillRings = keyedList(ringsList);
  let ringsKey = '';
  /** The most massive body (a star, in the systems offered): what belts go about. */
  const heaviest = (): UniverseLabBody | undefined => lab?.bodies.reduce<UniverseLabBody | undefined>((a, b) => (!a || b.gm > a.gm ? b : a), undefined);
  const ringButton = (which: 'asteroid' | 'kuiper' | 'ring' | 'moonlets'): HTMLButtonElement =>
    button(i18n.t(`ui.universe.lab.rings.add.${which}`), `lab-ring-preset-${which}`, () => {
      const l = lab;
      const count = Number(ringCount.select.value) || 1000;
      if (!l) return;
      if (which === 'asteroid' || which === 'kuiper') {
        const star = heaviest();
        if (!star) return;
        const [inner, outer, e, i] = which === 'asteroid' ? BELTS.asteroid : BELTS.kuiper;
        send({ kind: 'addSwarm', primary: star.id, name: i18n.t(`ui.universe.lab.rings.name.${which}`), count, innerKm: inner * l.auKm, outerKm: outer * l.auKm, eccentricity: e, inclinationDeg: i, plane: 'orbit' });
        return;
      }
      const b = selectedBody();
      if (!b) return;
      const name = i18n.t(`ui.universe.lab.rings.name.${which}`, { body: nameOf(b) });
      if (which === 'ring') send({ kind: 'addSwarm', primary: b.id, name, count, innerKm: RING.inner * b.radiusKm, outerKm: RING.outer * b.radiusKm, eccentricity: 0, inclinationDeg: 0, plane: 'equator' });
      else send({ kind: 'addRing', primary: b.id, name, count: MOONLETS.count, innerKm: MOONLETS.inner * b.radiusKm, outerKm: MOONLETS.outer * b.radiusKm, massKg: b.massKg * MOONLETS.massShare, plane: 'equator' });
    });
  const ringOn = ringButton('ring');
  const moonletsOn = ringButton('moonlets');
  const rings = details(
    'ui.universe.lab.rings.title',
    'lab-rings',
    h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.rings.intro')),
    ringCount.label,
    ringCount.select,
    h('div', { class: 'kf-lab-row' }, ringButton('asteroid'), ringButton('kuiper')),
    h('div', { class: 'kf-lab-row' }, ringOn, moonletsOn),
    ringsNeed,
    ringsDecorative,
    ringsList,
  );

  const element = h(
    'section',
    { class: 'kf-nav-lab', 'data-testid': 'lab-panel', 'aria-label': i18n.t('ui.universe.lab.title'), hidden: true },
    title,
    note,
    clock,
    rates,
    failure,
    back,
    history,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.bodies')),
    list,
    many,
    inspector,
    add,
    rings,
    viewBox,
    measureBox,
    graphBox,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.checks')),
    checks,
    constrained,
    historyList,
    tools,
  );

  // Ctrl or Cmd + Z undoes, with Shift (or Ctrl + Y) redoes, while the laboratory shows and no field has the keys.
  document.addEventListener('keydown', (e) => {
    if (element.hidden || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y') {
      e.preventDefault();
      send({ kind: k === 'y' || e.shiftKey ? 'redo' : 'undo' });
    }
  });

  let selectedId: string | null = null;
  let lab: UniverseLab | null = null;
  let placingNow = false;
  const selectedBody = (): UniverseLabBody | undefined => lab?.bodies.find((b) => b.id === selectedId);
  /** The inspector's fields hold what the visitor types: refilled only when another body is chosen. */
  let filledFor: string | null = null;
  /**
   * A choice made here and not yet in the experiment's view: until it is, the inspector stays hidden,
   * so nothing typed in that moment (a long one on a slow device) goes to the body chosen before.
   */
  let choosing: { id: string | null } | null = null;

  const row = (term: string, detail: string, testId: string): HTMLElement[] => [h('dt', {}, term), h('dd', { 'data-testid': testId }, detail)];
  /** The options of a body select (keeping what was chosen, where it still exists). */
  const fillBodies = (s: HTMLSelectElement, bodies: readonly UniverseLabBody[], blank: string | null): void => {
    const keep = s.value;
    s.replaceChildren(...(blank === null ? [] : [h('option', { value: '' }, blank)]), ...bodies.map((b) => h('option', { value: b.id }, nameOf(b))));
    if (bodies.some((b) => b.id === keep) || (keep === '' && blank !== null)) s.value = keep;
  };

  return {
    element,
    update(view, slow) {
      lab = view.lab;
      element.hidden = !lab;
      if (!lab) return;
      const l = lab;
      write(note, i18n.t('ui.universe.lab.note', { seed: l.seedNote }));
      write(clock, i18n.t('ui.universe.lab.clock', { elapsed: days(l.elapsedS), date: new Date((l.epochJdTdb - julianDateUtc(0)) * 86_400_000 + l.elapsedS * 1000).toISOString().slice(0, 10) }));
      if (!slow) return;
      write(rates, i18n.t(l.paused ? 'ui.universe.lab.paused' : l.achievedRate < 0.9 * l.requestedRate ? 'ui.universe.lab.ratesSlow' : 'ui.universe.lab.rates', { requested: days(l.requestedRate), achieved: days(l.achievedRate), step: f.number(l.dtS / 60, 1) }));
      failure.hidden = l.failure === null;
      if (l.failure) write(failure, i18n.t('ui.universe.lab.failure'));
      undo.disabled = l.undoable === 0;
      redo.disabled = l.redoable === 0;
      // The bodies, rebuilt only when the set, the choice or an edit mark changes.
      selectedId = l.selected;
      for (const id of [...ticked]) if (!l.bodies.some((b) => b.id === id)) ticked.delete(id);
      const key = l.bodies.map((b) => `${b.id}:${b.id === l.selected ? 1 : 0}:${b.edited ? 1 : 0}:${b.fixed ? 1 : 0}:${nameOf(b)}`).join('|');
      if (key !== listKey) {
        listKey = key;
        list.replaceChildren(
          ...l.bodies.map((b) => {
            const pick = h('button', { type: 'button', class: 'kf-living-place', 'aria-pressed': String(b.id === l.selected), 'data-testid': `lab-body-${b.id}` }, h('span', { class: 'kf-living-place-name' }, nameOf(b)), h('span', { class: 'kf-living-place-where' }, [b.edited ? i18n.t('ui.universe.lab.edited') : '', b.fixed ? i18n.t('ui.universe.lab.held') : ''].filter(Boolean).join(' · ')));
            pick.addEventListener('click', () => {
              choosing = { id: b.id === l.selected ? null : b.id };
              inspector.hidden = true;
              send({ kind: 'select', id: choosing.id });
            });
            const tick = h('input', { type: 'checkbox', class: 'kf-lab-check', 'aria-label': i18n.t('ui.universe.lab.tick', { name: nameOf(b) }), 'data-testid': `lab-tick-${b.id}`, ...(ticked.has(b.id) ? { checked: true } : {}) });
            tick.addEventListener('change', () => {
              if (tick.checked) ticked.add(b.id);
              else ticked.delete(b.id);
              many.hidden = ticked.size === 0;
              write(manyText, i18n.t('ui.universe.lab.many', { count: ticked.size }));
            });
            return h('li', { class: 'kf-lab-body-row' }, tick, pick);
          }),
        );
      }
      many.hidden = ticked.size === 0;
      write(manyText, i18n.t('ui.universe.lab.many', { count: ticked.size }));
      const pkey = l.bodies.map((b) => `${b.id}:${nameOf(b)}`).join('|');
      if (pkey !== primaryKey) {
        primaryKey = pkey;
        const keep = addPrimary.value;
        addPrimary.replaceChildren(...l.bodies.map((b) => h('option', { value: b.id }, nameOf(b))));
        addPrimary.value = l.bodies.some((b) => b.id === keep) ? keep : l.bodies.some((b) => b.id === 'earth') ? 'earth' : (l.bodies[0]?.id ?? '');
        fillBodies(measureFrom.select, l.bodies, none);
        fillBodies(measureTo.select, l.bodies, none);
        fillBodies(measureVia.select, l.bodies, none);
        fillBodies(graphBody.select, l.bodies, none);
      }
      // The palette, by kind, narrowed by the search.
      const q = search.input.value.trim().toLowerCase();
      const pk = `${q}:${chosenPreset ?? ''}`;
      if (pk !== paletteKey) {
        paletteKey = pk;
        palette.replaceChildren(
          ...KINDS.flatMap((kind) => {
            const items = l.presets.filter((p) => p.kind === kind && presetName(p.id).toLowerCase().includes(q));
            if (items.length === 0) return [];
            return [
              h('p', { class: 'kf-living-label' }, i18n.t(`ui.universe.lab.kind.${kind}`)),
              h(
                'ul',
                { class: 'kf-living-list kf-lab-presets' },
                ...items.map((p) => {
                  const b = h('button', { type: 'button', class: 'kf-living-place', 'aria-pressed': String(p.id === chosenPreset), 'data-testid': `lab-preset-${p.id}`, title: p.source }, h('span', { class: 'kf-living-place-name' }, presetName(p.id)), h('span', { class: 'kf-living-place-where' }, i18n.t('ui.universe.lab.presetFacts', { mass: scientific(p.massKg), radius: f.distance(p.radiusKm) })));
                  b.addEventListener('click', () => {
                    chosenPreset = p.id;
                    paletteKey = '';
                    addName.input.value = presetName(p.id);
                    addMass.input.value = p.massKg.toPrecision(6);
                    addRadius.input.value = String(Number(p.radiusKm.toPrecision(6)));
                  });
                  return h('li', {}, b);
                }),
              ),
            ];
          }),
        );
      }
      // Placing with the pointer.
      placingNow = l.placing !== null;
      write(place, i18n.t(placingNow ? 'ui.universe.lab.add.placeStop' : 'ui.universe.lab.add.place'));
      placingText.hidden = !l.placing;
      if (l.placing) {
        const primary = l.bodies.find((b) => b.id === l.placing?.primary);
        const pName = primary ? nameOf(primary) : l.placing.primary;
        write(placingText, l.placing.offsetKm === null ? i18n.t('ui.universe.lab.add.placing', { primary: pName }) : i18n.t('ui.universe.lab.add.placingAt', { primary: pName, distance: f.distance(l.placing.offsetKm) }));
      }
      // The inspector.
      const b = selectedBody();
      if (choosing && (l.selected === choosing.id || (choosing.id !== null && !l.bodies.some((x) => x.id === choosing?.id)))) choosing = null;
      inspector.hidden = !b || choosing !== null;
      if (b) {
        write(inspectorTitle, nameOf(b));
        const primary = b.primary ? l.bodies.find((x) => x.id === b.primary) : undefined;
        const pName = primary ? nameOf(primary) : '';
        const o = b.orbit;
        const rot = b.rotation;
        facts.replaceChildren(
          ...row(i18n.t('ui.universe.lab.mass'), `${scientific(b.massKg)} kg${b.edited ? ` · ${i18n.t('ui.universe.lab.edited')}` : ''}`, 'lab-fact-mass'),
          ...row(i18n.t('ui.universe.lab.radius'), f.keep(i18n.t('ui.hud.unit.km', { value: f.number(b.radiusKm, b.radiusKm < 10_000 ? 1 : 0) })), 'lab-fact-radius'),
          ...(b.densityKgM3 > 0 ? row(i18n.t('ui.universe.lab.density'), i18n.t('ui.universe.lab.densityValue', { value: f.number(b.densityKgM3, 0) }), 'lab-fact-density') : []),
          ...row(i18n.t('ui.universe.lab.speed'), speed(b.speedKmS), 'lab-fact-speed'),
          ...(b.primary && b.relativeSpeedKmS !== null && b.distanceKm !== null ? row(i18n.t('ui.universe.lab.relative', { primary: pName }), i18n.t('ui.universe.lab.relativeValue', { speed: speed(b.relativeSpeedKmS), distance: f.distance(b.distanceKm) }), 'lab-fact-relative') : []),
          ...row(i18n.t('ui.universe.lab.escape'), speed(b.escapeKmS), 'lab-fact-escape'),
          ...(o ? row(i18n.t('ui.universe.lab.orbit', { primary: pName }), i18n.t('ui.universe.lab.orbitValue', { a: o.bound ? f.distance(o.aKm) : f.distance(Math.abs(o.aKm)), e: f.number(o.e, o.e < 0.01 ? 4 : 3), i: degrees(o.iDeg) }), 'lab-fact-orbit') : []),
          ...(o ? row(i18n.t('ui.universe.lab.period'), o.periodS === null ? i18n.t('ui.universe.lab.unbound') : duration(o.periodS), 'lab-fact-period') : []),
          ...(o ? row(i18n.t('ui.universe.lab.apsides'), o.apoapsisKm === null ? i18n.t('ui.universe.lab.apsidesNear', { near: f.distance(o.periapsisKm) }) : i18n.t('ui.universe.lab.apsidesValue', { near: f.distance(o.periapsisKm), far: f.distance(o.apoapsisKm) }), 'lab-fact-apsides') : []),
          ...(o?.hillKm ? row(i18n.t('ui.universe.lab.hill'), i18n.t('ui.universe.lab.hillValue', { value: f.distance(o.hillKm) }), 'lab-fact-hill') : []),
          ...row(i18n.t('ui.universe.lab.rotation'), rot.periodS === null ? i18n.t('ui.universe.lab.rotationNone') : rot.tiltDeg === null ? i18n.t('ui.universe.lab.rotationNoTilt', { period: duration(rot.periodS) }) : i18n.t('ui.universe.lab.rotationValue', { period: duration(rot.periodS), tilt: degrees(rot.tiltDeg) }), 'lab-fact-rotation'),
          ...(Number.isFinite(rot.breakupPeriodS) ? row(i18n.t('ui.universe.lab.breakupLabel'), i18n.t('ui.universe.lab.breakup', { period: duration(rot.breakupPeriodS) }), 'lab-fact-breakup') : []),
          ...(b.roche ? row(i18n.t('ui.universe.lab.roche'), i18n.t('ui.universe.lab.rocheValue', { fluid: f.distance(b.roche.fluidKm), rigid: f.distance(b.roche.rigidKm) }), 'lab-fact-roche') : []),
          ...(b.j2 > 0 ? row(i18n.t('ui.universe.lab.j2'), scientific(b.j2), 'lab-fact-j2') : []),
        );
        // What is out of the ordinary: inside a Roche limit, or spinning faster than its gravity holds.
        const inside = b.roche && b.distanceKm !== null ? (b.distanceKm < b.roche.rigidKm ? 'rigid' : b.distanceKm < b.roche.fluidKm ? 'fluid' : null) : null;
        const tooFast = rot.periodS !== null && rot.periodS < rot.breakupPeriodS;
        const warn = [inside === 'rigid' ? i18n.t('ui.universe.lab.rocheInsideRigid') : inside === 'fluid' ? i18n.t('ui.universe.lab.rocheInsideFluid') : '', tooFast ? i18n.t('ui.universe.lab.tooFast') : ''].filter(Boolean).join(' ');
        warning.hidden = warn === '';
        write(warning, warn);
        remove.hidden = b.persistent;
        follow.hidden = !b.builtIn;
        fixedBox.checked = b.fixed;
        if (filledFor !== b.id) {
          filledFor = b.id;
          rename.input.value = nameOf(b);
          massInput.value = b.massKg.toPrecision(6);
          radius.input.value = String(Number(b.radiusKm.toPrecision(6)));
          density.input.value = b.densityKgM3 > 0 ? String(Math.round(b.densityKgM3)) : '';
          velInputs.forEach((input, k) => {
            input.value = String(Number((b.relativeVelKmS[k] ?? 0).toPrecision(6)));
          });
          const el = b.orbit;
          const values = el ? [el.aKm, el.e, el.iDeg, el.nodeDeg, el.periapsisArgDeg, el.trueAnomalyDeg] : [];
          elements.forEach((x, k) => {
            x.input.value = values[k] === undefined ? '' : String(Number((values[k] ?? 0).toPrecision(k === 0 ? 9 : 6)));
          });
          spinPeriod.input.value = rot.periodS === null ? '' : String(Number((rot.periodS / 3600).toPrecision(6)));
          spinTilt.input.value = rot.tiltDeg === null ? '0' : String(Number(rot.tiltDeg.toPrecision(4)));
        }
        elementsBox.hidden = !o;
        write(elementsHint, i18n.t('ui.universe.lab.elementsHint', { primary: pName }));
        horizon.value = String(HORIZONS.find(([s]) => Math.abs(s - l.horizonS) < 1)?.[0] ?? HORIZONS[1]?.[0] ?? '');
        accuracy.select.value = l.accuracy;
        const p = l.prediction;
        write(predictionText, !p ? i18n.t('ui.universe.lab.predicting') : p.merged ? i18n.t('ui.universe.lab.predictedHit', { other: nameOf(l.bodies.find((x) => x.id === p.merged?.with) ?? b), when: days(p.merged.t) }) : i18n.t('ui.universe.lab.predicted', { horizon: days(p.horizonS) }));
        const name = (id: string): string => {
          const found = l.bodies.find((x) => x.id === id);
          return found ? nameOf(found) : (l.names[id] ?? id);
        };
        const ekey = p ? p.encounters.map((e) => `${e.with}:${Math.round(e.distanceKm)}:${Math.round(e.t)}`).join('|') : '';
        if (ekey !== encounterKey) {
          encounterKey = ekey;
          encounters.replaceChildren(...(p?.encounters ?? []).map((e) => h('li', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.encounter', { other: name(e.with), distance: f.distance(e.distanceKm), when: days(e.t) }))));
        }
        lagrangeGroup.hidden = !b.primary;
        lagrangeBox.checked = l.lagrange !== null;
        write(lagrangeLabel, i18n.t('ui.universe.lab.lagrange', { primary: pName }));
      } else {
        filledFor = null;
      }
      // How paths are drawn.
      viewSelect.select.value = l.view;
      const pair = l.corotatingPair;
      const pairName = (id: string): string => {
        const found = l.bodies.find((x) => x.id === id);
        return found ? nameOf(found) : id;
      };
      const chosen = l.bodies.find((x) => x.id === l.selected);
      write(
        viewText,
        pair
          ? i18n.t('ui.universe.lab.viewPair', { a: pairName(pair.a), b: pairName(pair.b) })
          : l.view === 'corotating'
            ? i18n.t('ui.universe.lab.viewPairNone')
            : l.view === 'bodyfixed'
              ? chosen?.primary
                ? i18n.t('ui.universe.lab.viewFixed', { primary: pairName(chosen.primary) })
                : i18n.t('ui.universe.lab.viewPairNone')
              : i18n.t('ui.universe.lab.viewHint'),
      );
      // Measurements.
      const m = l.measure;
      write(measureResult, m ? i18n.t('ui.universe.lab.measureValue', { distance: f.distance(m.distanceKm), light: lightTime(m.lightS), to: pairName(m.to), size: degrees(m.angularSizeDeg) }) : '');
      write(measureAngle, m && m.via && m.separationDeg !== null ? i18n.t('ui.universe.lab.measureAngle', { from: pairName(m.from), to: pairName(m.to), via: pairName(m.via), angle: degrees(m.separationDeg) }) : '');
      // The quantity followed.
      const g = l.graph;
      const gk = g ? `${g.id}:${g.quantity}:${g.points.length}:${g.points.at(-1)?.[0] ?? 0}` : '';
      if (gk !== graphKey) {
        graphKey = gk;
        if (!g || g.points.length < 2) {
          line.setAttribute('points', '');
          write(graphSummary, g ? i18n.t('ui.universe.lab.graphEmpty') : '');
          chart.setAttribute('aria-label', '');
        } else {
          const t0 = g.points[0]?.[0] ?? 0;
          const t1 = g.points.at(-1)?.[0] ?? 1;
          let lo = Number.POSITIVE_INFINITY;
          let hi = Number.NEGATIVE_INFINITY;
          for (const [, v] of g.points) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
          const span = hi - lo || Math.abs(hi) || 1;
          line.setAttribute(
            'points',
            g.points.map(([t, v]) => `${(CHART.pad + ((t - t0) / Math.max(t1 - t0, 1e-9)) * (CHART.w - 2 * CHART.pad)).toFixed(1)},${(CHART.h - CHART.pad - ((v - lo) / span) * (CHART.h - 2 * CHART.pad)).toFixed(1)}`).join(' '),
          );
          const fmt = (v: number): string => (g.quantity === 'energyDrift' ? v.toExponential(1) : g.quantity === 'eccentricity' ? f.number(v, 4) : scientific(v));
          const summary = i18n.t('ui.universe.lab.graphSummary', { min: fmt(lo), max: fmt(hi), now: fmt(g.points.at(-1)?.[1] ?? 0), count: g.points.length, span: duration(t1 - t0) });
          write(graphSummary, g.mergedInto ? `${summary} ${i18n.t('ui.universe.lab.graphMerged', { survivor: pairName(g.mergedInto) })}` : summary);
          chart.setAttribute('aria-label', `${i18n.t(`ui.universe.lab.quantity.${g.quantity}`)}: ${summary}`);
        }
      }
      // Conservation since the last edit (and whether a body is held), and the edits and collisions so far.
      checks.replaceChildren(
        ...row(i18n.t('ui.universe.lab.check.energy'), l.drift.energy.toExponential(1), 'lab-check-energy'),
        ...row(i18n.t('ui.universe.lab.check.momentum'), l.drift.momentum.toExponential(1), 'lab-check-momentum'),
        ...row(i18n.t('ui.universe.lab.check.angular'), l.drift.angularMomentum.toExponential(1), 'lab-check-angular'),
      );
      constrained.hidden = !l.constrained;
      // A crater's place on a world drawn comes a frame after its event: counted, so the line gains it.
      const hkey = `${l.interventions.length}:${l.events.length}:${l.events.filter((e) => e.craterSite).length}:${l.discarded}:${l.interventions.at(-1)?.step ?? -1}`;
      if (hkey !== historyKey) {
        historyKey = hkey;
        const name = (id: string): string => {
          const found = l.bodies.find((x) => x.id === id);
          return found ? nameOf(found) : (l.names[id] ?? id);
        };
        historyList.replaceChildren(
          ...l.interventions.slice(-6).map((i) => h('li', { class: 'kf-living-hint' }, i18n.t(`ui.universe.lab.edit.${i.kind}`, { body: name(i.id), when: days(i.t) }))),
          ...l.events.slice(-4).map((e) =>
            h(
              'li',
              { class: 'kf-living-hint' },
              (e.kind === 'merge'
                ? i18n.t('ui.universe.lab.merged', { absorbed: name(e.absorbed), survivor: name(e.survivor), when: days(e.t) })
                : e.kind === 'graze'
                  ? i18n.t('ui.universe.lab.grazed', { absorbed: name(e.absorbed), survivor: name(e.survivor), speed: f.number(e.speedKmS, 1), when: days(e.t) })
                  : i18n.t('ui.universe.lab.impact', { absorbed: name(e.absorbed), survivor: name(e.survivor), speed: f.number(e.speedKmS, 1), regime: i18n.t(`ui.universe.lab.regime.${REGIME_KEYS[e.regime]}`), count: e.created, when: days(e.t) })) +
                (e.craterKm === null ? '' : `; ${i18n.t('ui.universe.lab.crater', { diameter: f.distance(e.craterKm), depth: depthText(e.craterDepthKm ?? 0), kind: i18n.t(e.craterComplex ? 'ui.universe.lab.crater.complex' : 'ui.universe.lab.crater.simple'), energy: megatons(e.energyJ) })}`) +
                (e.craterSite ? i18n.t('ui.universe.lab.craterAt', { place: f.coordinates(e.craterSite.latDeg, e.craterSite.lonDeg) }) : ''),
            ),
          ),
          ...(l.discarded > 0 ? [h('li', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.discarded', { count: l.discarded }))] : []),
        );
      }
      const ckey = l.checkpoints.map((c) => c.step).join('|');
      if (ckey !== checkpointKey) {
        checkpointKey = ckey;
        fillCheckpoints(
          l.checkpoints.slice(-6).reverse().map((c) => ({
            key: `${c.step}:${c.t}`,
            make: () =>
              h('li', {}, button(i18n.t('ui.universe.lab.goBack', { when: days(c.t) }), `lab-checkpoint-${c.step}`, () => {
                send({ kind: 'seek', step: c.step });
              })),
          })),
        );
      }
      // Rings and belts: each one's particles, those lost, and a way to remove it.
      const ringPrimary = selectedBody();
      ringOn.disabled = !ringPrimary || !(ringPrimary.gm > 0);
      moonletsOn.disabled = ringOn.disabled;
      ringsNeed.hidden = !ringOn.disabled;
      ringsDecorative.hidden = !l.bodies.some((b) => b.builtIn === 'saturn');
      const rk = l.swarms.map((w) => `${w.id}:${w.count}:${w.lost}:${w.primary}`).join('|');
      if (rk !== ringsKey) {
        ringsKey = rk;
        const bodyName = (id: string): string => {
          const found = l.bodies.find((x) => x.id === id);
          return found ? nameOf(found) : (l.names[id] ?? id);
        };
        fillRings(
          l.swarms.map((w) => ({
            key: `${w.id}:${w.count}:${w.lost}:${w.primary}`,
            make: () =>
              h(
                'li',
                { class: 'kf-lab-row', 'data-testid': `lab-ring-${w.id}` },
                h('span', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.rings.item', { name: w.name, count: f.number(w.count, 0), body: bodyName(w.primary) }) + (w.lost > 0 ? i18n.t('ui.universe.lab.rings.lost', { count: f.number(w.lost, 0) }) : '')),
                button(i18n.t('ui.universe.lab.rings.remove', { name: w.name }), `lab-ring-remove-${w.id}`, () => {
                  send({ kind: 'removeSwarm', id: w.id });
                }),
              ),
          })),
        );
      }
      // The library, by name.
      const lk = l.library.join('|');
      if (lk !== libraryKey) {
        libraryKey = lk;
        library.replaceChildren(
          ...(l.library.length === 0
            ? [h('li', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.libraryEmpty'))]
            : l.library.map((n) =>
                h(
                  'li',
                  { class: 'kf-lab-row' },
                  button(i18n.t('ui.universe.lab.libraryLoad', { name: n }), `lab-library-load-${n}`, () => {
                    send({ kind: 'loadSaved', name: n });
                  }),
                  button(i18n.t('ui.universe.lab.libraryDelete', { name: n }), `lab-library-delete-${n}`, () => {
                    send({ kind: 'deleteSaved', name: n });
                  }),
                ),
              )),
        );
      }
      // The link.
      const sh = l.share;
      shareUrl.hidden = !(sh && 'url' in sh);
      shareCopy.hidden = shareUrl.hidden;
      if (sh && 'url' in sh) {
        if (shareUrl.value !== sh.url) {
          shareUrl.value = sh.url;
          write(shareNote, '');
        }
      } else write(shareNote, sh ? i18n.t('ui.universe.lab.shareTooLarge', { chars: sh.chars }) : '');
      const st = l.status;
      write(status, st ? i18n.t(`ui.universe.lab.status.${st.kind}`, { detail: st.detail.join('; ') }) : '');
    },
  };
}
