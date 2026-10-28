import type { App, HudState, I18n, ScreenLabel } from '../core/types';
import { h } from './dom';
import './styles/hud.css';

/**
 * The heads-up layer over the scene: tags anchored to points in the scene (an element
 * in a supernova remnant, say) and a scale bar showing the true size of what is on
 * screen. Both are real DOM text, updated once per animation frame from app.hud(); the
 * tags are decorative (aria-hidden) because the panel carries the same information.
 */

export interface Hud {
  readonly element: HTMLElement;
}

interface Unit {
  metres: number;
  key: string;
}

/** Length units from micrometres (single cells) to billions of light-years (IAU light-year and astronomical unit). */
const LIGHT_YEAR = 9.4607304725808e15;
const UNITS: readonly Unit[] = [
  { metres: 1e-6, key: 'ui.hud.unit.um' },
  { metres: 1e-3, key: 'ui.hud.unit.mm' },
  { metres: 1, key: 'ui.hud.unit.m' },
  { metres: 1e3, key: 'ui.hud.unit.km' },
  { metres: 1.495978707e11, key: 'ui.hud.unit.au' },
  { metres: LIGHT_YEAR, key: 'ui.hud.unit.ly' },
  { metres: 1e3 * LIGHT_YEAR, key: 'ui.hud.unit.kly' },
  { metres: 1e6 * LIGHT_YEAR, key: 'ui.hud.unit.mly' },
  { metres: 1e9 * LIGHT_YEAR, key: 'ui.hud.unit.gly' },
];
const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500] as const;
/** The bar aims for about this many CSS pixels. */
const TARGET_PX = 120;

/** A round length (1, 2 or 5 times a power of ten of a unit) close to TARGET_PX on screen. */
export function scaleBar(metresPerPixel: number): { value: number; unit: Unit; px: number } | null {
  if (!(metresPerPixel > 0) || !Number.isFinite(metresPerPixel)) return null;
  const target = TARGET_PX * metresPerPixel;
  // The largest unit in which the target is at least 1.
  let unit = UNITS[0];
  for (const u of UNITS) if (target / u.metres >= 1) unit = u;
  if (!unit) return null;
  const inUnit = target / unit.metres;
  const value = [...NICE].reverse().find((n) => n <= inUnit) ?? 1;
  return { value, unit, px: (value * unit.metres) / metresPerPixel };
}

export function createHud(app: App): Hud {
  const { i18n } = app;
  const labels = h('div', { class: 'kf-hud-labels', 'aria-hidden': 'true' });
  const barLine = h('span', { class: 'kf-hud-bar' });
  const barText = h('span', { class: 'kf-hud-bar-text' });
  const bar = h('div', { class: 'kf-hud-scale', role: 'img', hidden: true }, barLine, barText);
  const element = h('div', { class: 'kf-hud', 'data-testid': 'hud' }, labels, bar);
  const tags = new Map<string, { tag: HTMLElement; leader: HTMLElement | null }>();
  let lastScaleText = '';

  const updateLabels = (list: readonly ScreenLabel[]): void => {
    const seen = new Set<string>();
    for (const label of list) {
      seen.add(label.id);
      let entry = tags.get(label.id);
      const text = label.text ?? i18n.t(label.textKey);
      if (entry && entry.tag.textContent !== text) entry.tag.textContent = text;
      if (!entry) {
        const tag = h('span', { class: label.offset ? 'kf-hud-tag kf-hud-callout' : 'kf-hud-tag' }, text);
        const leader = label.offset ? h('span', { class: 'kf-hud-leader' }) : null;
        if (leader) labels.append(leader);
        labels.append(tag);
        entry = { tag, leader };
        tags.set(label.id, entry);
      }
      const opacity = label.opacity.toFixed(3);
      if (label.offset && entry.leader) {
        // A callout: the tag beside its point, a hairline from the point to the tag's near edge.
        const [dx, dy] = label.offset;
        const length = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        entry.leader.style.transform = `translate(${label.x.toFixed(1)}px, ${label.y.toFixed(1)}px) rotate(${angle.toFixed(4)}rad)`;
        entry.leader.style.inlineSize = `${Math.max(0, length - 2).toFixed(1)}px`;
        entry.leader.style.opacity = opacity;
        const flip = dx < 0 ? ' translateX(-100%)' : '';
        entry.tag.style.transform = `translate(${(label.x + dx).toFixed(1)}px, ${(label.y + dy).toFixed(1)}px)${flip} translateY(-50%)`;
      } else {
        entry.tag.style.transform = `translate(${label.x.toFixed(1)}px, ${label.y.toFixed(1)}px)`;
      }
      entry.tag.style.opacity = opacity;
    }
    for (const [id, entry] of tags) {
      if (!seen.has(id)) {
        entry.tag.remove();
        entry.leader?.remove();
        tags.delete(id);
      }
    }
  };

  const updateScale = (state: HudState, i18nRef: I18n): void => {
    const scale = state.metresPerPixel === null ? null : scaleBar(state.metresPerPixel);
    bar.hidden = scale === null;
    if (!scale) return;
    const text = i18nRef.t(scale.unit.key, { value: i18nRef.number(scale.value, 0) });
    barLine.style.inlineSize = `${scale.px.toFixed(1)}px`;
    if (text !== lastScaleText) {
      lastScaleText = text;
      barText.textContent = text;
      bar.setAttribute('aria-label', i18nRef.t('ui.hud.scale', { length: text }));
    }
  };

  const frame = (): void => {
    const state = app.hud();
    if (state.labels.length > 0 || tags.size > 0) updateLabels(state.labels);
    updateScale(state, i18n);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return { element };
}
