import type { App, SkyLayerName, UniverseView } from '../../core/types';
import { h } from '../dom';
import type { Formatters } from './format';
import { withHelp } from './help';

/**
 * The navigator's "The sky": what the stars behind the worlds are (the Bright Star Catalogue's,
 * at their real places, colours and brightness), and a switch for each of the sky's layers: the
 * constellation figures with their names, their boundaries, a grid with the celestial equator and
 * the ecliptic, and the brightest stars' names. Each switch is a pressed-or-not button. Its own chunk
 * (./sections), loaded the first time the section opens (the section and its summary are the navigator's).
 */

export interface SkyPanel {
  readonly body: HTMLElement;
  update(view: UniverseView, slow: boolean): void;
}

const LAYERS: readonly SkyLayerName[] = ['constellations', 'names', 'boundaries', 'grid'];

export function createSkyPanel(app: App, f: Formatters): SkyPanel {
  const { i18n } = app;
  const switches = LAYERS.map((layer) => {
    const b = h('button', { type: 'button', class: 'kf-living-switch', 'aria-pressed': 'false', 'data-testid': `sky-${layer}` }, h('span', { class: 'kf-living-switch-mark', 'aria-hidden': 'true' }), i18n.t(`ui.universe.sky.layer.${layer}`));
    b.addEventListener('click', () => {
      app.universeSky({ kind: 'layer', layer, on: b.getAttribute('aria-pressed') !== 'true' });
    });
    return [layer, b] as const;
  });
  const intro = h('p', { class: 'kf-living-hint', 'data-testid': 'sky-intro' });
  const body = h('div', { class: 'kf-about-body' }, withHelp(app, intro, 'sky', i18n.t('ui.universe.sky.title')), h('div', { class: 'kf-living-group' }, ...switches.map(([, b]) => b)), h('p', { class: 'kf-about-sources' }, i18n.t('ui.universe.sky.sources')));
  let shownStars = -1;
  return {
    body,
    update(view, slow) {
      for (const [layer, b] of switches) {
        const on = String(view.sky.layers[layer]);
        if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
      }
      if (slow && view.sky.stars !== shownStars) {
        shownStars = view.sky.stars;
        intro.textContent = i18n.t('ui.universe.sky.intro', { count: f.number(view.sky.stars) });
      }
    },
  };
}
