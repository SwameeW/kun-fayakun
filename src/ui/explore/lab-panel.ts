import { julianDateUtc } from '../../astro/time';
import type { App, LabCommand, UniverseLab, UniverseLabBody, UniverseView } from '../../core/types';
import { h, uniqueId } from '../dom';
import type { Formatters } from './format';

/**
 * The orbital laboratory's panel (heading the navigator while an experiment runs): what it is (an
 * experiment forked from the solar system, with its approximations said), the way back to the real
 * explorer, its bodies, the chosen body's inspector and edits (mass; velocity relative to the body it
 * moves about; duplicate, remove, follow; how far ahead to predict), adding a body (on a circular
 * orbit, or at a position and velocity), the conservation checks since the last edit, the edits and
 * mergers so far, and the scenario's tools (save in this browser, load, export, import, checkpoints,
 * replay, reset). Names from the scenario are text, never markup. Numbers are rewritten only when
 * they change; nothing here is a live region (the clock runs every frame).
 */

export interface LabPanel {
  readonly element: HTMLElement;
  update(view: UniverseView, slow: boolean): void;
}

const HORIZONS: ReadonlyArray<readonly [number, string]> = [
  [10 * 86_400, 'days10'],
  [60 * 86_400, 'days60'],
  [365.25 * 86_400, 'year1'],
  [10 * 365.25 * 86_400, 'years10'],
];
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

export function createLabPanel(app: App, f: Formatters): LabPanel {
  const { i18n } = app;
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
  const scientific = (value: number): string => {
    if (value === 0) return '0';
    const exponent = Math.floor(Math.log10(Math.abs(value)));
    const mantissa = value / 10 ** exponent;
    const digits = String(Math.abs(exponent)).split('').map((d) => SUPERSCRIPT[Number(d)] ?? d).join('');
    return `${f.number(mantissa, 3)} × 10${exponent < 0 ? '⁻' : ''}${digits}`;
  };
  const days = (s: number): string => f.keep(i18n.t('ui.universe.lab.days', { value: f.number(s / 86_400, s < 864_000 ? 2 : 1) }));
  const speed = (v: number): string => f.keep(i18n.t('ui.universe.lab.kms', { value: f.number(v, v < 10 ? 3 : 2) }));
  const nameOf = (b: UniverseLabBody): string => (b.builtIn ? f.name(b.builtIn) : b.name);

  // Head: what this is, and the way back.
  const title = h('h3', { class: 'kf-living-notes-title' }, i18n.t('ui.universe.lab.title'));
  const note = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-note' });
  const clock = h('p', { class: 'kf-lab-clock', 'data-testid': 'lab-clock' });
  const rates = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-rates' });
  const back = button(i18n.t('ui.universe.lab.back'), 'lab-back', () => {
    app.closeLab();
  }, 'kf-btn kf-living-tour-start');
  const failure = h('p', { class: 'kf-lab-warning', 'data-testid': 'lab-failure', role: 'alert', hidden: true });

  // Bodies.
  const list = h('ul', { class: 'kf-living-list kf-lab-bodies', 'aria-label': i18n.t('ui.universe.lab.bodies'), 'data-testid': 'lab-bodies' });
  let listKey = '';

  // The inspector.
  const inspectorTitle = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'lab-selected-name' });
  const facts = h('dl', { class: 'kf-about-facts', 'data-testid': 'lab-facts' });
  const massId = uniqueId('lab-mass');
  const massInput = h('input', { id: massId, type: 'text', inputmode: 'decimal', class: 'kf-living-input', 'data-testid': 'lab-mass-input', autocomplete: 'off', spellcheck: 'false' });
  const massApply = button(i18n.t('ui.universe.lab.apply'), 'lab-mass-apply', () => {
    const v = Number(massInput.value.replace(/[\s,]/gu, ''));
    if (selectedId && Number.isFinite(v) && v >= 0) send({ kind: 'mass', id: selectedId, massKg: v });
  });
  const double = button(i18n.t('ui.universe.lab.double'), 'lab-mass-double', () => {
    const b = selectedBody();
    if (b) send({ kind: 'mass', id: b.id, massKg: b.massKg * 2 });
  });
  const halve = button(i18n.t('ui.universe.lab.halve'), 'lab-mass-halve', () => {
    const b = selectedBody();
    if (b) send({ kind: 'mass', id: b.id, massKg: b.massKg / 2 });
  });
  const velIds = [uniqueId('lab-vx'), uniqueId('lab-vy'), uniqueId('lab-vz')];
  const velInputs = velIds.map((id, k) => h('input', { id, type: 'text', inputmode: 'decimal', class: 'kf-living-input kf-lab-vec', 'data-testid': `lab-vel-${'xyz'[k] ?? ''}`, autocomplete: 'off' }));
  const velApply = button(i18n.t('ui.universe.lab.apply'), 'lab-vel-apply', () => {
    const v = velInputs.map((i) => Number(i.value));
    if (selectedId && v.every(Number.isFinite)) send({ kind: 'velocity', id: selectedId, relativeKmS: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] });
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
  const horizonId = uniqueId('lab-horizon');
  const horizon = h('select', { id: horizonId, class: 'kf-living-input', 'data-testid': 'lab-horizon' }, ...HORIZONS.map(([s, key]) => h('option', { value: String(s) }, i18n.t(`ui.universe.lab.horizon.${key}`))));
  horizon.addEventListener('change', () => {
    send({ kind: 'horizon', seconds: Number(horizon.value) });
  });
  const predictionText = h('p', { class: 'kf-living-hint', 'data-testid': 'lab-prediction' });
  const inspector = h(
    'section',
    { class: 'kf-living-notes-part', 'data-testid': 'lab-inspector', hidden: true },
    inspectorTitle,
    facts,
    h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: massId }, i18n.t('ui.universe.lab.massLabel')), h('div', { class: 'kf-lab-row' }, massInput, massApply), h('div', { class: 'kf-lab-row' }, double, halve)),
    h(
      'fieldset',
      { class: 'kf-living-group kf-lab-fieldset' },
      h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.velocityLabel')),
      h('div', { class: 'kf-lab-row' }, ...velInputs.flatMap((input, k) => [h('label', { class: 'kf-sr-only', for: velIds[k] ?? '' }, i18n.t(`ui.universe.lab.axis.${'xyz'[k] ?? 'x'}`)), input]), velApply),
    ),
    h('div', { class: 'kf-lab-row' }, duplicate, remove, follow),
    h('div', { class: 'kf-living-group' }, h('label', { class: 'kf-living-label', for: horizonId }, i18n.t('ui.universe.lab.horizon')), horizon, predictionText),
  );

  // Add a body.
  const field = (key: string, testId: string, value: string): { label: HTMLLabelElement; input: HTMLInputElement } => {
    const id = uniqueId(testId);
    return { label: h('label', { class: 'kf-living-label', for: id }, i18n.t(key)), input: h('input', { id, type: 'text', class: 'kf-living-input', 'data-testid': testId, value, autocomplete: 'off', spellcheck: 'false' }) };
  };
  const addName = field('ui.universe.lab.add.name', 'lab-add-name', i18n.t('ui.universe.lab.add.defaultName'));
  const addMass = field('ui.universe.lab.add.mass', 'lab-add-mass', '7.346e22');
  const addRadius = field('ui.universe.lab.add.radius', 'lab-add-radius', '1737');
  const addDistance = field('ui.universe.lab.add.distance', 'lab-add-distance', '600000');
  const primaryId = uniqueId('lab-primary');
  const addPrimary = h('select', { id: primaryId, class: 'kf-living-input', 'data-testid': 'lab-add-primary' });
  let primaryKey = '';
  const addOrbit = button(i18n.t('ui.universe.lab.add.orbit'), 'lab-add-orbit', () => {
    const m = Number(addMass.input.value);
    const r = Number(addRadius.input.value);
    const d = Number(addDistance.input.value);
    if (addPrimary.value && [m, r, d].every(Number.isFinite)) send({ kind: 'addOrbit', primary: addPrimary.value, distanceKm: d, massKg: m, radiusKm: r, name: addName.input.value.trim() });
  }, 'kf-btn kf-living-tour-start');
  const posFields = ['x', 'y', 'z'].map((a, k) => field(`ui.universe.lab.axis.${a}`, `lab-add-pos-${a}`, k === 0 ? '600000' : '0'));
  const velFields = ['x', 'y', 'z'].map((a, k) => field(`ui.universe.lab.axis.${a}`, `lab-add-vel-${a}`, k === 1 ? '0.8' : '0'));
  const addState = button(i18n.t('ui.universe.lab.add.state'), 'lab-add-state', () => {
    const pos = posFields.map((x) => Number(x.input.value));
    const vel = velFields.map((x) => Number(x.input.value));
    const m = Number(addMass.input.value);
    const r = Number(addRadius.input.value);
    if (addPrimary.value && [...pos, ...vel, m, r].every(Number.isFinite)) {
      send({ kind: 'addState', relativeTo: addPrimary.value, posKm: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0], velKmS: [vel[0] ?? 0, vel[1] ?? 0, vel[2] ?? 0], massKg: m, radiusKm: r, name: addName.input.value.trim() });
    }
  });
  const add = h(
    'details',
    { class: 'kf-living-notes-part kf-living-prophets-box', 'data-testid': 'lab-add' },
    h('summary', {}, i18n.t('ui.universe.lab.add.title')),
    h(
      'div',
      { class: 'kf-living-prophets-body' },
      h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.add.intro')),
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
      addOrbit,
      h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.add.position')), h('div', { class: 'kf-lab-row' }, ...posFields.flatMap((x) => [x.label, x.input]))),
      h('fieldset', { class: 'kf-living-group kf-lab-fieldset' }, h('legend', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.add.velocity')), h('div', { class: 'kf-lab-row' }, ...velFields.flatMap((x) => [x.label, x.input]))),
      addState,
    ),
  );

  // Checks and history.
  const checks = h('dl', { class: 'kf-about-facts', 'data-testid': 'lab-checks' });
  const history = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.history'), 'data-testid': 'lab-history' });
  let historyKey = '';

  // Scenario tools.
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
  const checkpoints = h('ul', { class: 'kf-living-list', 'aria-label': i18n.t('ui.universe.lab.checkpoints'), 'data-testid': 'lab-checkpoints' });
  let checkpointKey = '';
  const tools = h(
    'details',
    { class: 'kf-living-notes-part kf-living-prophets-box', 'data-testid': 'lab-tools' },
    h('summary', {}, i18n.t('ui.universe.lab.tools')),
    h(
      'div',
      { class: 'kf-living-prophets-body' },
      h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.save'), 'lab-save', () => {
        send({ kind: 'save' });
      }), button(i18n.t('ui.universe.lab.restoreSaved'), 'lab-restore-saved', () => {
        send({ kind: 'restoreSaved' });
      })),
      h('div', { class: 'kf-lab-row' }, button(i18n.t('ui.universe.lab.export'), 'lab-export', () => {
        send({ kind: 'export' });
      }), h('label', { class: 'kf-living-go kf-lab-file', for: importId }, i18n.t('ui.universe.lab.import')), importInput),
      status,
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
    ),
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
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.bodies')),
    list,
    inspector,
    add,
    h('p', { class: 'kf-living-label' }, i18n.t('ui.universe.lab.checks')),
    checks,
    history,
    tools,
  );

  let selectedId: string | null = null;
  let lab: UniverseLab | null = null;
  const selectedBody = (): UniverseLabBody | undefined => lab?.bodies.find((b) => b.id === selectedId);
  /** The inspector's fields hold what the visitor types: refilled only when another body is chosen. */
  let filledFor: string | null = null;

  const row = (term: string, detail: string, testId: string): HTMLElement[] => [h('dt', {}, term), h('dd', { 'data-testid': testId }, detail)];

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
      // The bodies, rebuilt only when the set, the choice or an edit mark changes.
      selectedId = l.selected;
      const key = l.bodies.map((b) => `${b.id}:${b.id === l.selected ? 1 : 0}:${b.edited ? 1 : 0}`).join('|');
      if (key !== listKey) {
        listKey = key;
        list.replaceChildren(
          ...l.bodies.map((b) => {
            const pick = h('button', { type: 'button', class: 'kf-living-place', 'aria-pressed': String(b.id === l.selected), 'data-testid': `lab-body-${b.id}` }, h('span', { class: 'kf-living-place-name' }, nameOf(b)), h('span', { class: 'kf-living-place-where' }, b.edited ? i18n.t('ui.universe.lab.edited') : ''));
            pick.addEventListener('click', () => {
              send({ kind: 'select', id: b.id === l.selected ? null : b.id });
            });
            return h('li', {}, pick);
          }),
        );
      }
      const pkey = l.bodies.map((b) => b.id).join('|');
      if (pkey !== primaryKey) {
        primaryKey = pkey;
        const keep = addPrimary.value;
        addPrimary.replaceChildren(...l.bodies.map((b) => h('option', { value: b.id }, nameOf(b))));
        addPrimary.value = l.bodies.some((b) => b.id === keep) ? keep : l.bodies.some((b) => b.id === 'earth') ? 'earth' : (l.bodies[0]?.id ?? '');
      }
      // The inspector.
      const b = selectedBody();
      inspector.hidden = !b;
      if (b) {
        write(inspectorTitle, nameOf(b));
        facts.replaceChildren(
          ...row(i18n.t('ui.universe.lab.mass'), `${scientific(b.massKg)} kg${b.edited ? ` · ${i18n.t('ui.universe.lab.edited')}` : ''}`, 'lab-fact-mass'),
          ...row(i18n.t('ui.universe.lab.radius'), f.keep(i18n.t('ui.hud.unit.km', { value: f.number(b.radiusKm, b.radiusKm < 10_000 ? 1 : 0) })), 'lab-fact-radius'),
          ...row(i18n.t('ui.universe.lab.speed'), speed(b.speedKmS), 'lab-fact-speed'),
          ...(b.primary && b.relativeSpeedKmS !== null && b.distanceKm !== null
            ? row(i18n.t('ui.universe.lab.relative', { primary: nameOf(l.bodies.find((x) => x.id === b.primary) ?? b) }), i18n.t('ui.universe.lab.relativeValue', { speed: speed(b.relativeSpeedKmS), distance: f.distance(b.distanceKm) }), 'lab-fact-relative')
            : []),
          ...row(i18n.t('ui.universe.lab.escape'), speed(b.escapeKmS), 'lab-fact-escape'),
        );
        remove.hidden = b.persistent;
        follow.hidden = !b.builtIn;
        if (filledFor !== b.id) {
          filledFor = b.id;
          massInput.value = b.massKg.toPrecision(6);
          velInputs.forEach((input, k) => {
            input.value = String(Number((b.relativeVelKmS[k] ?? 0).toPrecision(6)));
          });
        }
        horizon.value = String(HORIZONS.find(([s]) => Math.abs(s - l.horizonS) < 1)?.[0] ?? HORIZONS[1]?.[0] ?? '');
        const p = l.prediction;
        write(predictionText, !p ? i18n.t('ui.universe.lab.predicting') : p.merged ? i18n.t('ui.universe.lab.predictedHit', { other: nameOf(l.bodies.find((x) => x.id === p.merged?.with) ?? b), when: days(p.merged.t) }) : i18n.t('ui.universe.lab.predicted', { horizon: days(p.horizonS) }));
      } else {
        filledFor = null;
      }
      // Conservation since the last edit, and the edits and mergers so far.
      checks.replaceChildren(
        ...row(i18n.t('ui.universe.lab.check.energy'), l.drift.energy.toExponential(1), 'lab-check-energy'),
        ...row(i18n.t('ui.universe.lab.check.momentum'), l.drift.momentum.toExponential(1), 'lab-check-momentum'),
        ...row(i18n.t('ui.universe.lab.check.angular'), l.drift.angularMomentum.toExponential(1), 'lab-check-angular'),
      );
      const hkey = `${l.interventions.length}:${l.events.length}:${l.discarded}`;
      if (hkey !== historyKey) {
        historyKey = hkey;
        const name = (id: string): string => {
          const found = l.bodies.find((b) => b.id === id);
          return found ? nameOf(found) : (l.names[id] ?? id);
        };
        history.replaceChildren(
          ...l.interventions.slice(-6).map((i) => h('li', { class: 'kf-living-hint' }, i18n.t(`ui.universe.lab.edit.${i.kind}`, { body: name(i.id), when: days(i.t) }))),
          ...l.events.slice(-4).map((e) => h('li', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.merged', { absorbed: name(e.absorbed), survivor: name(e.survivor), when: days(e.t) }))),
          ...(l.discarded > 0 ? [h('li', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.discarded', { count: l.discarded }))] : []),
        );
      }
      const ckey = l.checkpoints.map((c) => c.step).join('|');
      if (ckey !== checkpointKey) {
        checkpointKey = ckey;
        checkpoints.replaceChildren(
          ...l.checkpoints.slice(-6).reverse().map((c) =>
            h('li', {}, button(i18n.t('ui.universe.lab.goBack', { when: days(c.t) }), `lab-checkpoint-${c.step}`, () => {
              send({ kind: 'seek', step: c.step });
            })),
          ),
        );
      }
      const st = l.status;
      write(status, st ? i18n.t(`ui.universe.lab.status.${st.kind}`, { detail: st.detail.join('; ') }) : '');
    },
  };
}
