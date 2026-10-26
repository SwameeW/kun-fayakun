import type { App, I18nKey, LabCommand, UniverseLab, UniverseLabBody } from '../../core/types';
import { helpButton } from './help';
import { h } from '../dom';
import type { Formatters } from './format';

/**
 * Short lessons on scenarios that can be set up again (ledger CR-4; part of the laboratory's panel):
 * Kepler's third law, escape speed, a Hohmann transfer and the Roche limit. Each sets up its
 * experiment, then goes in a few steps, each an edit the visitor makes with a button (the same edits
 * the panel offers), with what to look for and the number the physics expects, worked out from the
 * experiment as it stands before the step; the experiment's own figures then say what happened.
 *
 * The steps are taken in order, each once, and only once the experiment is set up (its first step
 * reads it): a step's button is disabled until then and after it is taken (the lesson starts again
 * from its own button). A step says what it will do before it is taken (where it has words for that)
 * and what happened once it is; what the experiment looked like at the start is kept as it was once
 * the first edit is made, and words once shown are never blanked (a moon torn apart no longer has
 * the distance they gave).
 */

export interface Lessons {
  readonly element: HTMLElement;
  update(lab: UniverseLab): void;
}

type LessonId = 'kepler' | 'escape' | 'hohmann' | 'roche';
const LESSONS: readonly LessonId[] = ['kepler', 'escape', 'hohmann', 'roche'];
/** Geostationary radius (km): a sidereal day's circular orbit about the Earth, as the Hohmann lesson's target. */
const GEO_KM = 42_164;
/** The Hohmann lesson's ship: enough propellant for the transfer (its 3.8 km/s), and a strong engine, so the burns are short. */
const LESSON_SHIP = { dryKg: 2000, fuelKg: 18_000, thrustN: 400_000, ispS: 320, distanceKm: 7000 } as const;

interface Step {
  /** What to look for, from the experiment now and what was noted when the step was taken. */
  text: (lab: UniverseLab, noted: Record<string, number>) => string;
  /** The step's edit, and what to note beforehand: false when the experiment lacks what it needs (nothing sent). */
  act?: { label: string; run: (lab: UniverseLab, noted: Record<string, number>) => boolean };
  /** What the step will do, shown until it is taken (otherwise its words wait for it). */
  before?: I18nKey;
}

export function createLabLessons(app: App, f: Formatters): Lessons {
  const { i18n } = app;
  const send = (c: LabCommand): void => {
    app.universeLab(c);
  };
  const km = (value: number): string => f.distance(value);
  const kmS = (value: number): string => i18n.t('ui.universe.lab.lesson.kmS', { v: f.number(value, value < 10 ? 3 : 2) });
  const ms = (value: number): string => i18n.t('ui.universe.lab.lesson.ms', { v: f.number(value, value < 10 ? 1 : 0) });
  const days = (seconds: number): string => i18n.t('ui.universe.lab.lesson.days', { v: f.number(seconds / 86_400, seconds < 864_000 ? 2 : 1) });
  const hours = (seconds: number): string => i18n.t('ui.universe.lab.lesson.hours', { v: f.number(seconds / 3600, seconds < 36_000 ? 2 : 1) });
  const find = (lab: UniverseLab, id: string): UniverseLabBody | undefined => lab.bodies.find((b) => b.id === id);
  const ship = (lab: UniverseLab): UniverseLabBody | undefined => lab.bodies.find((b) => b.ship !== null);
  const pause = (lab: UniverseLab): void => {
    if (!lab.paused) app.universeTime({ kind: 'toggle' });
  };
  /** Runs the experiment's clock at a rate (a rate also sets it running): a step that always can. */
  const run = (rate: number): true => {
    app.universeTime({ kind: 'rate', rate });
    return true;
  };
  /** The circular speed and escape speed (km/s) of a body about its primary, at its distance now. */
  const speeds = (lab: UniverseLab, b: UniverseLabBody): { circular: number; escape: number } => {
    const p = b.primary ? find(lab, b.primary) : undefined;
    const mu = (p?.gm ?? 0) + b.gm;
    const r = b.distanceKm ?? 1;
    return { circular: Math.sqrt(mu / r), escape: Math.sqrt((2 * mu) / r) };
  };
  /** The two burns of a Hohmann transfer from r1 to r2 about a body of GM mu (m/s; Vallado, algorithm 36). */
  const hohmann = (mu: number, r1: number, r2: number): { dv1: number; dv2: number } => {
    const a = (r1 + r2) / 2;
    return { dv1: (Math.sqrt(mu * (2 / r1 - 1 / a)) - Math.sqrt(mu / r1)) * 1000, dv2: (Math.sqrt(mu / r2) - Math.sqrt(mu * (2 / r2 - 1 / a))) * 1000 };
  };

  const steps: Record<LessonId, Step[]> = {
    kepler: [
      {
        text: (lab) => {
          const b = find(lab, 'planet');
          return b?.orbit?.periodS ? i18n.t('ui.universe.lab.lesson.kepler.1', { period: days(b.orbit.periodS), a: km(b.orbit.aKm) }) : '';
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.kepler.act2'),
          run: (lab, noted) => {
            const o = find(lab, 'planet')?.orbit;
            if (!o?.periodS) return false;
            noted.period = o.periodS;
            noted.speed = find(lab, 'planet')?.relativeSpeedKmS ?? 0;
            send({ kind: 'elements', id: 'planet', aKm: o.aKm * 2, e: o.e, iDeg: o.iDeg, nodeDeg: o.nodeDeg, periapsisArgDeg: o.periapsisArgDeg, trueAnomalyDeg: o.trueAnomalyDeg });
            return true;
          },
        },
        before: 'ui.universe.lab.lesson.kepler.2before',
        text: (lab, noted) => {
          const o = find(lab, 'planet')?.orbit;
          return noted.period && o?.periodS ? i18n.t('ui.universe.lab.lesson.kepler.2', { expected: days(noted.period * 2 ** 1.5), period: days(o.periodS), ratio: f.number(o.periodS / noted.period, 3) }) : i18n.t('ui.universe.lab.lesson.kepler.2before');
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.kepler.act3'),
          run: () => run(30 * 86_400),
        },
        text: (lab, noted) => {
          const v = find(lab, 'planet')?.relativeSpeedKmS;
          return noted.speed && v ? i18n.t('ui.universe.lab.lesson.kepler.3', { now: kmS(v), before: kmS(noted.speed), expected: kmS(noted.speed / Math.SQRT2) }) : '';
        },
      },
    ],
    escape: [
      {
        text: (lab) => {
          const b = find(lab, 'planet');
          if (!b?.relativeSpeedKmS) return '';
          const s = speeds(lab, b);
          return i18n.t('ui.universe.lab.lesson.escape.1', { v: kmS(b.relativeSpeedKmS), escape: kmS(s.escape) });
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.escape.act2'),
          run: (lab, noted) => {
            const b = find(lab, 'planet');
            if (!b?.relativeSpeedKmS) return false;
            // A little past escape speed: exactly at it, the orbit would be a parabola, neither bound nor not.
            const dv = (speeds(lab, b).escape * 1.02 - b.relativeSpeedKmS) * 1000;
            noted.push = dv;
            send({ kind: 'impulse', id: 'planet', progradeMs: dv, normalMs: 0, radialMs: 0 });
            return true;
          },
        },
        before: 'ui.universe.lab.lesson.escape.2before',
        text: (lab, noted) => {
          const o = find(lab, 'planet')?.orbit;
          return noted.push ? i18n.t(o?.bound === false ? 'ui.universe.lab.lesson.escape.2' : 'ui.universe.lab.lesson.escape.2wait', { push: ms(noted.push), e: f.number(o?.e ?? 0, 3) }) : i18n.t('ui.universe.lab.lesson.escape.2before');
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.escape.act3'),
          run: () => run(30 * 86_400),
        },
        text: (lab) => {
          const b = find(lab, 'planet');
          return b?.distanceKm ? i18n.t('ui.universe.lab.lesson.escape.3', { distance: km(b.distanceKm) }) : '';
        },
      },
    ],
    hohmann: [
      {
        text: (lab) => {
          const s = ship(lab);
          const earth = find(lab, 'earth');
          if (!s?.ship || !earth || !s.distanceKm) return '';
          const { dv1, dv2 } = hohmann(earth.gm, s.distanceKm, GEO_KM);
          return i18n.t('ui.universe.lab.lesson.hohmann.1', { r1: km(s.distanceKm), r2: km(GEO_KM), dv1: ms(dv1), dv2: ms(dv2), left: ms(s.ship.deltaVLeftMs) });
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.hohmann.act2'),
          run: (lab, noted) => {
            const s = ship(lab);
            const earth = find(lab, 'earth');
            if (!s || !earth || !s.distanceKm) return false;
            const { dv1 } = hohmann(earth.gm, s.distanceKm, GEO_KM);
            noted.dv1 = dv1;
            send({ kind: 'burn', id: s.id, direction: 'prograde', ref: 'earth', deltaVMs: dv1, inS: 0, throttle: 1 });
            return true;
          },
        },
        before: 'ui.universe.lab.lesson.hohmann.2before',
        text: (_lab, noted) => (noted.dv1 ? i18n.t('ui.universe.lab.lesson.hohmann.2', { dv1: ms(noted.dv1) }) : i18n.t('ui.universe.lab.lesson.hohmann.2before')),
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.hohmann.act3'),
          run: () => run(600),
        },
        text: (lab) => {
          const o = ship(lab)?.orbit;
          return o?.apoapsisKm ? i18n.t('ui.universe.lab.lesson.hohmann.3', { apo: km(o.apoapsisKm), target: km(GEO_KM), period: hours(o.periodS ?? 0) }) : '';
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.hohmann.act4'),
          run: (lab) => {
            const s = ship(lab);
            if (s) send({ kind: 'circularise', id: s.id });
            return s !== undefined;
          },
        },
        text: (lab) => {
          const r = ship(lab)?.ship?.circularise;
          return r ? i18n.t('ui.universe.lab.lesson.hohmann.4', { dv: ms(r.deltaVMs), when: hours(r.inS) }) : i18n.t('ui.universe.lab.lesson.hohmann.4none');
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.hohmann.act5'),
          run: () => run(1800),
        },
        text: (lab) => {
          const o = ship(lab)?.orbit;
          return o ? i18n.t('ui.universe.lab.lesson.hohmann.5', { a: km(o.aKm), e: f.number(o.e, 3), period: hours(o.periodS ?? 0) }) : '';
        },
      },
    ],
    roche: [
      {
        text: (lab) => {
          const m = find(lab, 'moon');
          return m?.roche && m.distanceKm ? i18n.t('ui.universe.lab.lesson.roche.1', { distance: km(m.distanceKm), fluid: km(m.roche.fluidKm), rigid: km(m.roche.rigidKm) }) : '';
        },
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.roche.act2'),
          run: (lab, noted) => {
            const m = find(lab, 'moon');
            const o = m?.orbit;
            if (!m?.roche || !o) return false;
            noted.a = m.roche.fluidKm * 0.8;
            send({ kind: 'elements', id: 'moon', aKm: noted.a, e: 0, iDeg: o.iDeg, nodeDeg: o.nodeDeg, periapsisArgDeg: o.periapsisArgDeg, trueAnomalyDeg: o.trueAnomalyDeg });
            return true;
          },
        },
        before: 'ui.universe.lab.lesson.roche.2before',
        text: (_lab, noted) => (noted.a ? i18n.t('ui.universe.lab.lesson.roche.2', { a: km(noted.a) }) : i18n.t('ui.universe.lab.lesson.roche.2before')),
      },
      {
        act: {
          label: i18n.t('ui.universe.lab.lesson.roche.act3'),
          run: () => run(3600),
        },
        text: (lab) => {
          const torn = lab.events.some((e) => e.kind === 'disrupt');
          return i18n.t(torn ? 'ui.universe.lab.lesson.roche.3' : 'ui.universe.lab.lesson.roche.3wait', { count: lab.bodies.length });
        },
      },
    ],
  };

  // The list of lessons, and the one being followed.
  const list = h('ul', { class: 'kf-living-list kf-lab-lessons-list', 'data-testid': 'lab-lessons-list' });
  const current = h('section', { class: 'kf-lab-lesson', 'data-testid': 'lab-lesson', hidden: true });
  const lessonTitle = h('h4', { class: 'kf-living-subtitle', 'data-testid': 'lab-lesson-title' });
  const lessonIntro = h('p', { class: 'kf-living-hint' });
  const stepList = h('ol', { class: 'kf-lab-lesson-steps', 'data-testid': 'lab-lesson-steps' });
  const restart = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'lab-lesson-restart' }, i18n.t('ui.universe.lab.lesson.restart'));
  const leave = h('button', { type: 'button', class: 'kf-btn', 'data-testid': 'lab-lesson-end' }, i18n.t('ui.universe.lab.lesson.end'));
  current.append(lessonTitle, lessonIntro, stepList, h('div', { class: 'kf-lab-row' }, restart, leave));
  let active: LessonId | null = null;
  let noted: Record<string, number> = {};
  /** Set-up waiting for the experiment to be there (the seed loads in its worker). */
  let pending: { ready: (lab: UniverseLab) => boolean; then: (lab: UniverseLab) => void } | null = null;
  /** Each step's item, words and button; whether it has been taken; the last words it showed (kept, never blanked); and whether they are kept as they are. */
  let stepParts: Array<{ li: HTMLElement; text: HTMLElement; button: HTMLButtonElement | null }> = [];
  let taken: boolean[] = [];
  let shown: string[] = [];
  let kept: boolean[] = [];
  let latest: UniverseLab | null = null;

  /** Which steps can be taken: once set up (the first step has read the experiment), in order, each once. */
  const refresh = (): void => {
    if (!active) return;
    let open = pending === null && shown[0] !== '';
    steps[active].forEach((step, k) => {
      const button = stepParts[k]?.button;
      const disabled = !open || (taken[k] ?? false);
      if (button && button.disabled !== disabled) button.disabled = disabled;
      if (step.act && !taken[k]) open = false;
    });
  };

  const take = (k: number): void => {
    const act = active ? steps[active][k]?.act : undefined;
    const button = stepParts[k]?.button;
    if (!act || !latest || !button || button.disabled || pending !== null || taken[k]) return;
    if (!act.run(latest, noted)) return;
    taken[k] = true;
    // What the experiment looked like before the first edit stays as it was (its live figures would now be the edit's).
    for (let j = 0; j < k; j += 1) if (!active || !steps[active][j]?.act) kept[j] = true;
    const hadFocus = document.activeElement === button;
    refresh();
    // The keyboard goes on to the next step (the one taken is done), or to starting again at the end.
    if (hadFocus) (stepParts.find((p) => p.button && !p.button.disabled)?.button ?? restart).focus();
  };

  const begin = (id: LessonId): void => {
    // Already being set up: once is enough (a button pressed again and again starts it once).
    if (active === id && pending !== null) return;
    active = id;
    noted = {};
    current.hidden = false;
    lessonTitle.textContent = i18n.t(`ui.universe.lab.lesson.${id}.title`);
    lessonIntro.textContent = i18n.t(`ui.universe.lab.lesson.${id}.intro`);
    stepParts = [];
    taken = steps[id].map(() => false);
    shown = steps[id].map(() => '');
    kept = steps[id].map(() => false);
    stepList.replaceChildren(
      ...steps[id].map((step, k) => {
        const text = h('p', { class: 'kf-living-hint', 'data-testid': `lab-lesson-text-${String(k)}` });
        const button = step.act ? h('button', { type: 'button', class: 'kf-btn kf-living-tour-start', 'data-testid': `lab-lesson-step-${String(k)}`, disabled: true }, step.act.label) : null;
        button?.addEventListener('click', () => {
          take(k);
        });
        // Numbered by its place in the lesson (an item without words yet is hidden, and the numbers stay).
        const li = h('li', { value: String(k + 1) }, button, text);
        stepParts.push({ li, text, button });
        return li;
      }),
    );
    // Its experiment from the start: the seed, then (the Hohmann lesson) its ship; the world in question chosen, the clock paused.
    const seed = id === 'kepler' || id === 'escape' ? 'two' : 'solar';
    const focus = id === 'roche' ? 'moon' : 'planet';
    send({ kind: 'start', seed });
    // (Any view after the start is the new experiment's: the old one's snapshot is dropped as it loads.)
    pending = {
      ready: (lab) => lab.logLength === 0 && (seed === 'two' ? lab.bodies.map((x) => x.id).join() === 'star,planet' : lab.bodies.length >= 10),
      then: (lab) => {
        pause(lab);
        if (id === 'hohmann') {
          send({ kind: 'addShip', primary: 'earth', distanceKm: LESSON_SHIP.distanceKm, name: i18n.t('ui.universe.lab.lesson.hohmann.ship'), dryKg: LESSON_SHIP.dryKg, fuelKg: LESSON_SHIP.fuelKg, thrustN: LESSON_SHIP.thrustN, ispS: LESSON_SHIP.ispS });
        } else send({ kind: 'select', id: focus });
      },
    };
    write();
  };

  /** Each step's words: while set up, a line saying so (the first step's place); then what each says. */
  const write = (): void => {
    if (!active) return;
    const lab = pending === null ? latest : null;
    steps[active].forEach((step, k) => {
      const part = stepParts[k];
      if (!part) return;
      if (lab && !kept[k]) {
        // Before a step is taken, what it will do (where it says); once taken, what happened.
        const now = step.act && !taken[k] ? (step.before ? i18n.t(step.before) : '') : step.text(lab, noted);
        if (now !== '') shown[k] = now;
      }
      const words = shown[k] || (k === 0 ? i18n.t('ui.universe.lab.lesson.loading') : '');
      if (part.text.textContent !== words) part.text.textContent = words;
      if (part.text.hidden !== (words === '')) part.text.hidden = words === '';
      if (part.li.hidden !== (words === '' && !part.button)) part.li.hidden = words === '' && !part.button;
    });
    refresh();
  };
  restart.addEventListener('click', () => {
    if (active) begin(active);
  });
  leave.addEventListener('click', () => {
    active = null;
    pending = null;
    current.hidden = true;
  });
  list.append(
    ...LESSONS.map((id) => {
      const b = h('button', { type: 'button', class: 'kf-living-place', 'data-testid': `lab-lesson-${id}` }, h('span', { class: 'kf-living-place-name' }, i18n.t(`ui.universe.lab.lesson.${id}.title`)), h('span', { class: 'kf-living-place-where' }, i18n.t(`ui.universe.lab.lesson.${id}.what`)));
      b.addEventListener('click', () => {
        begin(id);
      });
      return h('li', {}, b);
    }),
  );
  const element = h(
    'details',
    { class: 'kf-living-notes-part kf-living-prophets-box', 'data-testid': 'lab-lessons' },
    h('summary', {}, i18n.t('ui.universe.lab.lesson.title')),
    h('div', { class: 'kf-living-prophets-body' }, h('p', { class: 'kf-living-hint' }, i18n.t('ui.universe.lab.lesson.intro'), helpButton(app, 'lessons', i18n.t('ui.universe.lab.lesson.title'))), list, current),
  );

  return {
    element,
    update(lab) {
      latest = lab;
      if (pending?.ready(lab)) {
        const p = pending;
        pending = null;
        p.then(lab);
      }
      write();
    },
  };
}
