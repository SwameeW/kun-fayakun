import type { App } from '../core/types';
import { h } from './dom';
import './styles/discovery.css';

/**
 * "Each in an orbit": the visitor-led letter analysis of kullun fi falakin (docs/SPEC.md,
 * Chapter 7). A quiet button at the end of the scholarly layer opens, inline, the seven
 * base letters of the phrase as tiles along an arc, with the mirror axis through the
 * central letter. A light reads them from either end (the same sequence both ways), and the
 * mirrored pairs meet the centre. Everything is derived from the generated asset (built from
 * the verified Tanzil text); no Arabic is held here, letters come from their code points.
 * The verses themselves stay untouched in the text layer above; this panel is labelled as
 * an analysis and styled apart from scripture. While it is open the scene dims and slows.
 */

interface AnalysisAsset {
  id: string;
  verses: Array<{ key: string }>;
  letters: string[];
  centre: number;
  pairs: Array<[number, number]>;
}

const STEP_MS = 650;
const PAIR_MS = 1100;

const letterKey = (cp: string): string => `ui.letter.${cp.replace('U+', 'u').toLowerCase()}`;
const fromCode = (cp: string): string => String.fromCodePoint(Number.parseInt(cp.slice(2), 16));

export function discoveryBlock(app: App, id: string): HTMLElement {
  const { i18n } = app;
  const opener = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discovery-open', 'aria-expanded': 'false' }, i18n.t('ui.discovery.open'));
  const region = h('div', { class: 'kf-discovery', hidden: true, 'data-testid': 'discovery' });
  const wrapper = h('div', { class: 'kf-discovery-wrap' }, opener, region);
  let asset: AnalysisAsset | null = null;
  let current = -1;
  let timer: number | null = null;
  let tiles: HTMLElement[] = [];
  const live = h('p', { class: 'kf-discovery-live', 'aria-live': 'polite' });

  const stop = (): void => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const nameOf = (i: number): string => (asset ? i18n.t(letterKey(asset.letters[i] ?? '')) : '');
  const highlight = (indices: readonly number[], className: string): void => {
    tiles.forEach((tile, i) => tile.classList.toggle(className, indices.includes(i)));
  };
  const moveTo = (i: number, announce = true): void => {
    if (!asset) return;
    current = Math.max(0, Math.min(asset.letters.length - 1, i));
    highlight([current], 'is-lit');
    tiles[current]?.focus();
    if (announce) live.textContent = i18n.t('ui.discovery.current', { n: current + 1, total: asset.letters.length, name: nameOf(current) });
  };

  const read = (direction: 'rtl' | 'ltr'): void => {
    if (!asset) return;
    stop();
    const n = asset.letters.length;
    const order = Array.from({ length: n }, (_, i) => (direction === 'rtl' ? i : n - 1 - i));
    const names = order.map(nameOf).join(', ');
    live.textContent = i18n.t(direction === 'rtl' ? 'ui.discovery.readingRtl' : 'ui.discovery.readingLtr', { names });
    if (app.reducedMotion) {
      // Reduced motion: no travelling light; the visitor steps with the arrow keys.
      moveTo(order[0] ?? 0, false);
      return;
    }
    let k = 0;
    moveTo(order[0] ?? 0, false);
    timer = window.setInterval(() => {
      k += 1;
      if (k >= n) {
        stop();
        highlight([], 'is-lit');
        return;
      }
      moveTo(order[k] ?? 0, false);
    }, STEP_MS);
  };

  let pairStep: (() => void) | null = null;
  const showPairs = (): void => {
    if (!asset) return;
    stop();
    const pairs = asset.pairs;
    let k = 0;
    const step = (): void => {
      const pair = pairs[k];
      if (!pair || !asset) {
        highlight([asset?.centre ?? 3], 'is-pair');
        live.textContent = i18n.t('ui.discovery.centre', { n: (asset?.centre ?? 3) + 1, name: nameOf(asset?.centre ?? 3) });
        stop();
        return;
      }
      highlight(pair, 'is-pair');
      live.textContent = i18n.t('ui.discovery.pair', { a: pair[0] + 1, b: pair[1] + 1, name: nameOf(pair[0]) });
      k += 1;
    };
    step();
    if (!app.reducedMotion) timer = window.setInterval(step, PAIR_MS);
    else {
      // Reduced motion: each press of P steps to the next pair (crossfaded, no gliding).
      timer = null;
      pairStep = step;
    }
  };

  const close = (): void => {
    stop();
    region.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    app.interact('discovery', null);
    opener.focus();
  };

  const build = (data: AnalysisAsset): void => {
    asset = data;
    const n = data.letters.length;
    tiles = data.letters.map((cp, i) => {
      const pair = n - 1 - i;
      const label =
        i === data.centre
          ? i18n.t('ui.discovery.tileCentre', { name: nameOf(i), n: i + 1, total: n })
          : i18n.t('ui.discovery.tile', { name: nameOf(i), n: i + 1, total: n, pair: pair + 1 });
      // Tiles sit on a gentle arc (their own orbit), right to left in reading order.
      const offset = i - data.centre;
      const tile = h(
        'li',
        {
          class: 'kf-discovery-tile',
          tabindex: i === 0 ? '0' : '-1',
          role: 'listitem',
          'aria-label': label,
          style: `--kf-arc-x: ${-offset * 3.4}rem; --kf-arc-y: ${Math.abs(offset) ** 2 * 0.28}rem`,
        },
        h('span', { class: 'kf-discovery-letter', lang: 'ar', dir: 'rtl', translate: 'no', 'aria-hidden': 'true' }, fromCode(cp)),
        h('span', { class: 'kf-discovery-number', 'aria-hidden': 'true' }, String(i + 1)),
      );
      tile.addEventListener('focus', () => {
        current = i;
      });
      return tile;
    });
    const arc = h('ol', { class: 'kf-discovery-arc', 'aria-label': i18n.t('ui.discovery.tiles') }, ...tiles, h('li', { class: 'kf-discovery-axis', 'aria-hidden': 'true' }));
    arc.addEventListener('keydown', (event) => {
      const n2 = data.letters.length;
      switch (event.key) {
        case 'ArrowLeft':
          moveTo(current + 1);
          break;
        case 'ArrowRight':
          moveTo(current - 1);
          break;
        case 'Home':
          moveTo(0);
          break;
        case 'End':
          moveTo(n2 - 1);
          break;
        case 'Enter':
        case ' ':
          read('rtl');
          break;
        case 'p':
        case 'P':
          if (pairStep && app.reducedMotion) pairStep();
          else showPairs();
          break;
        case 'Escape':
          close();
          break;
        default:
          return;
      }
      event.preventDefault();
    });
    const button = (key: string, action: () => void): HTMLElement => {
      const b = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet' }, i18n.t(key));
      b.addEventListener('click', action);
      return b;
    };
    const names = (order: number[]): string => order.map(nameOf).join(', ');
    const forward = Array.from({ length: n }, (_, i) => i);
    region.replaceChildren(
      h('h4', { class: 'kf-discovery-title' }, i18n.t('ui.discovery.title')),
      h('p', { class: 'kf-discovery-label' }, i18n.t('ui.discovery.label')),
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.verses')),
      arc,
      h(
        'div',
        { class: 'kf-discovery-controls' },
        button('ui.discovery.readRtl', () => {
          read('rtl');
        }),
        button('ui.discovery.readLtr', () => {
          read('ltr');
        }),
        button('ui.discovery.pairs', showPairs),
        button('ui.discovery.close', close),
      ),
      live,
      h(
        'dl',
        { class: 'kf-discovery-readings' },
        h('dt', {}, i18n.t('ui.discovery.readRtl')),
        h('dd', {}, names(forward)),
        h('dt', {}, i18n.t('ui.discovery.readLtr')),
        h('dd', {}, names([...forward].reverse())),
      ),
      h('p', { class: 'kf-discovery-same' }, i18n.t('ui.discovery.same')),
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.conjunction')),
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.scope')),
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.rasm')),
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.classical')),
      h('p', { class: 'kf-discovery-closing' }, i18n.t('ui.discovery.closing')),
      h('p', { class: 'kf-discovery-keys' }, i18n.t('ui.discovery.keys')),
    );
  };

  region.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  opener.addEventListener('click', () => {
    if (!region.hidden) {
      close();
      return;
    }
    const open = (): void => {
      region.hidden = false;
      opener.setAttribute('aria-expanded', 'true');
      app.interact('discovery', 1);
      tiles[0]?.focus();
    };
    if (asset) {
      open();
      return;
    }
    app.assets
      .json<AnalysisAsset>(`assets/analysis/${id}.json`)
      .then((data) => {
        build(data);
        open();
      })
      .catch((error: unknown) => {
        console.error('ui: could not load the letter analysis', error);
      });
  });
  return wrapper;
}
