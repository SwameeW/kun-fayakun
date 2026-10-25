import type { App, VerseKey } from '../core/types';
import { commitStyles, h, svg, uniqueId } from './dom';
import { markPhrase, type PhraseWords } from './phrase-mark';
import { verseArticle } from './scripture';
import './styles/discovery.css';

/**
 * "Each in an orbit": the visitor-led letter analysis of kullun fi falakin (docs/SPEC.md,
 * Chapter 7). A quiet button at the end of the scholarly layer opens the seven base letters of
 * the phrase as tiles along an arc, with the mirror axis through the central letter. One
 * travelling light reads them from either end (the same sequence both ways), and the mirrored
 * pairs glide to meet the centre. Everything is derived from the generated asset (built from
 * the verified Tanzil text); no Arabic is held here, letters come from their code points.
 * The verses themselves stay untouched; their three words are only underlined in place. The
 * first cited verse is shown whole (from the data) at the top of the region, so the vowelled
 * verse stays on screen above the analysis wherever it opens (SPEC, Quranic text rule 3). The
 * analysis below it is labelled as such and styled apart from scripture.
 *
 * While it is open the film is held (no cue fires, the chapter cannot end) and the scene dims
 * and slows. Anything that moves the film on (a seek, another chapter, collapsing or
 * re-rendering the panel) closes it first. On narrow or short screens it opens as its own
 * translucent layer between header and timeline, so the orbits stay visible behind it.
 */

interface AnalysisAsset {
  id: string;
  verses: PhraseWords[];
  letters: string[];
  centre: number;
  pairs: Array<[number, number]>;
}

export interface DiscoveryBlock {
  readonly element: HTMLElement;
  /** Closes the analysis if open (releases the film). Focus returns to the opener when asked, or when it was inside. */
  close(options?: { restoreFocus?: boolean }): void;
  /** Opens it as its own button does (once the panel holding it shows); nothing if it is open. */
  open(): void;
  /** The verses the analysis reads (loading its asset): where the panel invites the visitor to it. */
  verses(): Promise<string[]>;
}

/** Dwell of the reading light on each letter. */
const STEP_MS = 650;
/** One mirrored pair: glide in, a soft ring at the meeting, glide back; the next pair starts after. */
const PAIR = { glideMs: 800, meetMs: 700, cycleMs: 2400 } as const;
/** Where a gliding pair stops, in arc steps from the centre: just touching the central letter. */
const MEET_AT = 0.86;
/** The region's fade (keep in step with discovery.css). */
const FADE_MS = 350;
const SWIPE_PX = 24;
/** Screens too small for the inline arc and notes side by side with the scene (keep in step with discovery.css). */
const LAYER_QUERY = '(max-width: 767.98px), (max-height: 500px)';
/** Narrower than this, seven 44 px tiles cannot sit on the inline arc without overlapping. */
const MIN_INLINE_PX = 340;
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

const letterKey = (cp: string): string => `ui.letter.${cp.replace('U+', 'u').toLowerCase()}`;
const fromCode = (cp: string): string => String.fromCodePoint(Number.parseInt(cp.slice(2), 16));
const isVerseKey = (key: string): key is VerseKey => /^\d+:\d+$/u.test(key);

type Mode = 'idle' | 'step' | 'read' | 'pairs';

export function discoveryBlock(app: App, id: string): DiscoveryBlock {
  const { i18n } = app;
  /** The chapter this block was rendered for: a load that finishes after it has gone must not open. */
  const chapter = app.chapter;
  const titleId = uniqueId('discovery-title');
  const opener = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet kf-discovery-open', 'aria-expanded': 'false' }, i18n.t('ui.discovery.open'));
  // The region owns its keys (keyboard.ts): its arrows, P and Escape never reach the film's shortcuts.
  const region = h('div', { class: 'kf-discovery', role: 'region', 'aria-labelledby': titleId, 'data-kf-keys': 'own', hidden: true, 'data-testid': 'discovery' });
  const wrapper = h('div', { class: 'kf-discovery-wrap' }, opener, region);
  const live = h('p', { class: 'kf-discovery-live', 'aria-live': 'polite' });
  const notes = h('div', { class: 'kf-discovery-notes' });
  const orbit = h('div', { class: 'kf-discovery-orbit' });

  let asset: AnalysisAsset | null = null;
  let tiles: HTMLElement[] = [];
  let current = -1;
  let mode: Mode = 'idle';
  let open = false;
  /** Reduced motion: where the visitor has stepped a reading or the pairs to. */
  let readStep: { direction: 'rtl' | 'ltr'; k: number } | null = null;
  let pairStep = 0;
  const timers = new Set<number>();
  let release: (() => void) | null = null;
  let unmark: () => void = () => undefined;
  let unsubscribe: Array<() => void> = [];
  let hideTimer: number | null = null;
  /** The one fetch of the asset, shared by every click made while it runs. */
  let loading: Promise<void> | null = null;
  /**
   * Bumped by every close(): an opening that waits for the asset proceeds only if nothing closed
   * it meanwhile (a seek, another chapter, collapsing or re-rendering the panel). A second click
   * while it loads joins the same request.
   */
  let openRequest = 0;

  const later = (ms: number, fn: () => void): void => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const stop = (): void => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
  };
  const nameOf = (i: number): string => (asset ? i18n.t(letterKey(asset.letters[i] ?? '')) : '');
  const arcIndex = (i: number): number => (asset ? asset.centre - i : 0);
  const say = (text: string): void => {
    live.textContent = text;
  };

  /** Clears every mark when the visitor switches between stepping, reading and the pairs. */
  const setMode = (next: Mode): void => {
    stop();
    if (next === mode) return;
    mode = next;
    readStep = null;
    pairStep = 0;
    orbit.classList.remove('has-light', 'is-pairing');
    for (const tile of tiles) {
      tile.classList.remove('is-lit', 'is-pair', 'is-gliding', 'is-meeting');
      tile.style.removeProperty('--kf-meet');
    }
  };

  /** Moves the one reading light. Only the visitor's own moves (keys, a tap) take focus with it. */
  const moveTo = (i: number, announce: boolean, focus: boolean): void => {
    if (!asset) return;
    current = Math.max(0, Math.min(asset.letters.length - 1, i));
    orbit.style.setProperty('--kf-light-i', String(arcIndex(current)));
    orbit.classList.add('has-light');
    tiles.forEach((tile, k) => {
      tile.classList.toggle('is-lit', k === current);
      tile.tabIndex = k === current ? 0 : -1;
    });
    if (focus) tiles[current]?.focus();
    if (announce) say(i18n.t('ui.discovery.current', { n: current + 1, total: asset.letters.length, name: nameOf(current) }));
  };

  const step = (delta: number, focus: boolean): void => {
    setMode('step');
    moveTo(current < 0 ? 0 : current + delta, true, focus);
  };

  const read = (direction: 'rtl' | 'ltr'): void => {
    if (!asset) return;
    const n = asset.letters.length;
    const order = Array.from({ length: n }, (_, i) => (direction === 'rtl' ? i : n - 1 - i));
    if (app.reducedMotion) {
      // No travelling light: each press steps the reading on by one letter, as a crossfade.
      const k = mode === 'read' && readStep?.direction === direction ? readStep.k + 1 : 0;
      setMode('read');
      if (k === 0) say(i18n.t(direction === 'rtl' ? 'ui.discovery.readingRtl' : 'ui.discovery.readingLtr', { names: order.map(nameOf).join(', ') }));
      readStep = { direction, k: k % n };
      moveTo(order[k % n] ?? 0, k > 0, false);
      return;
    }
    setMode('read');
    say(i18n.t(direction === 'rtl' ? 'ui.discovery.readingRtl' : 'ui.discovery.readingLtr', { names: order.map(nameOf).join(', ') }));
    order.forEach((i, k) => {
      later(k * STEP_MS, () => {
        moveTo(i, false, false);
      });
    });
    later(n * STEP_MS, () => {
      orbit.classList.remove('has-light');
      for (const tile of tiles) tile.classList.remove('is-lit');
    });
  };

  const showCentre = (): void => {
    if (!asset) return;
    const centre = asset.centre;
    tiles.forEach((tile, k) => tile.classList.toggle('is-pair', k === centre));
    say(i18n.t('ui.discovery.centre', { n: centre + 1, name: nameOf(centre) }));
  };

  const showPair = (k: number, glide: boolean): void => {
    const pair = asset?.pairs[k];
    if (!asset || !pair) return;
    orbit.classList.add('is-pairing');
    tiles.forEach((tile, i) => {
      const inPair = pair.includes(i);
      tile.classList.toggle('is-pair', inPair);
      tile.classList.remove('is-gliding', 'is-meeting');
      if (inPair && glide) {
        // Both bodies of the pair travel the same arc toward the centre and stop just short of it.
        // (is-gliding applies it; taking the class away glides them home again.)
        tile.style.setProperty('--kf-meet', String(MEET_AT / Math.max(1, Math.abs(arcIndex(i)))));
        tile.classList.add('is-gliding');
      } else {
        tile.style.removeProperty('--kf-meet');
      }
    });
    say(i18n.t('ui.discovery.pair', { a: pair[0] + 1, b: pair[1] + 1, name: nameOf(pair[0]) }));
  };

  const showPairs = (): void => {
    if (!asset) return;
    const count = asset.pairs.length;
    const centreTile = tiles[asset.centre];
    if (app.reducedMotion) {
      // Each press shows the next pair (crossfaded, no gliding), then the centre, then starts again.
      const k = mode === 'pairs' ? pairStep : 0;
      setMode('pairs');
      if (k < count) showPair(k, false);
      else showCentre();
      pairStep = (k + 1) % (count + 1);
      return;
    }
    setMode('pairs');
    for (let k = 0; k < count; k += 1) {
      const start = k * PAIR.cycleMs;
      later(start, () => {
        showPair(k, true);
      });
      later(start + PAIR.glideMs, () => {
        centreTile?.classList.add('is-meeting');
      });
      later(start + PAIR.glideMs + PAIR.meetMs, () => {
        centreTile?.classList.remove('is-meeting');
        for (const tile of tiles) tile.classList.remove('is-gliding');
      });
    }
    later(count * PAIR.cycleMs, () => {
      orbit.classList.remove('is-pairing');
      showCentre();
    });
  };

  /* Layout: inline in the panel, or a layer of its own on small screens ------------------ */

  const layerQuery = window.matchMedia(LAYER_QUERY);
  const fineQuery = window.matchMedia(FINE_POINTER_QUERY);
  const fitLayout = (): void => {
    if (!open) return;
    const layer = layerQuery.matches || wrapper.clientWidth < MIN_INLINE_PX;
    region.classList.toggle('is-layer', layer);
    // In the layer the notes scroll on their own, so they must be reachable by keyboard.
    if (layer) notes.tabIndex = 0;
    else notes.removeAttribute('tabindex');
    document.documentElement.classList.toggle('kf-discovery-layer-open', layer);
  };
  const syncHint = (): void => {
    region.classList.toggle('is-touch', !fineQuery.matches);
  };

  /* Building the region ------------------------------------------------------------------- */

  const button = (key: string, action: () => void): HTMLElement => {
    const b = h('button', { type: 'button', class: 'kf-btn kf-btn--quiet' }, i18n.t(key));
    b.addEventListener('click', action);
    return b;
  };

  const build = (data: AnalysisAsset): void => {
    asset = data;
    const n = data.letters.length;
    // The verse, whole and as stored, above the analysis (the three words get the same underline as in the panel).
    const cited = data.verses[0];
    const verse = cited && isVerseKey(cited.key) ? verseArticle(cited.key, app.data, i18n) : null;
    verse?.classList.add('kf-discovery-verse');
    tiles = data.letters.map((cp, i) => {
      const pair = n - 1 - i;
      const label =
        i === data.centre
          ? i18n.t('ui.discovery.tileCentre', { name: nameOf(i), n: i + 1, total: n })
          : i18n.t('ui.discovery.tile', { name: nameOf(i), n: i + 1, total: n, pair: pair + 1 });
      // Tiles sit on a gentle arc (their own orbit), right to left in reading order; CSS scales the arc to fit.
      const tile = h(
        'li',
        {
          class: i === data.centre ? 'kf-discovery-tile is-centre' : 'kf-discovery-tile',
          tabindex: i === 0 ? '0' : '-1',
          'aria-label': label,
          style: `--kf-arc-i: ${arcIndex(i)}`,
        },
        h('span', { class: 'kf-discovery-letter', lang: 'ar', dir: 'rtl', translate: 'no', 'aria-hidden': 'true' }, fromCode(cp)),
        h('span', { class: 'kf-discovery-number', 'aria-hidden': 'true' }, String(i + 1)),
      );
      tile.addEventListener('click', () => {
        if (swiped) return;
        setMode('step');
        moveTo(i, true, true);
      });
      return tile;
    });
    orbit.replaceChildren(
      // Drawn first, under the tiles, so the axis never strikes through the central letter.
      // The orbit line through the tile centres: y = x² in arc steps, as one exact quadratic Bézier.
      svg(
        'svg',
        { class: 'kf-discovery-path', viewBox: '-3.5 0 7 12.25', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' },
        svg('path', { d: 'M -3.5 12.25 Q 0 -12.25 3.5 12.25', 'vector-effect': 'non-scaling-stroke' }),
      ),
      h('span', { class: 'kf-discovery-axis', 'aria-hidden': 'true' }),
      h('span', { class: 'kf-discovery-light', 'aria-hidden': 'true' }),
      h('ol', { class: 'kf-discovery-arc', 'aria-label': i18n.t('ui.discovery.tiles') }, ...tiles),
    );
    const names = (order: number[]): string => order.map(nameOf).join(', ');
    const forward = Array.from({ length: n }, (_, i) => i);
    region.replaceChildren(
      ...(verse ? [verse] : []),
      // The analysis in a box of its own beneath the verse (the layer lays its parts out directly).
      h(
        'div',
        { class: 'kf-discovery-body' },
        h(
          'div',
          { class: 'kf-discovery-head' },
          h('h4', { id: titleId, class: 'kf-discovery-title' }, i18n.t('ui.discovery.title')),
          h('p', { class: 'kf-discovery-label' }, i18n.t('ui.discovery.label')),
        ),
        h(
          'div',
          { class: 'kf-discovery-stage' },
          orbit,
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
            button('ui.discovery.close', () => {
              close({ restoreFocus: true });
            }),
          ),
          live,
        ),
        notes,
      ),
    );
    notes.replaceChildren(
      h('p', { class: 'kf-discovery-note' }, i18n.t('ui.discovery.verses')),
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
      h('p', { class: 'kf-discovery-touch' }, i18n.t('ui.discovery.hintTouch')),
    );
  };

  /* Input ---------------------------------------------------------------------------------- */

  region.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const onTile = target?.classList.contains('kf-discovery-tile') ?? false;
    const onControl = target !== null && target.closest('button, a[href]') !== null;
    const last = (asset?.letters.length ?? 1) - 1;
    switch (event.key) {
      // Tiles run right to left in reading order: Left is the next letter, whatever the UI direction.
      case 'ArrowLeft':
        step(1, onTile);
        break;
      case 'ArrowRight':
        step(-1, onTile);
        break;
      case 'Home':
        setMode('step');
        moveTo(0, true, onTile);
        break;
      case 'End':
        setMode('step');
        moveTo(last, true, onTile);
        break;
      case 'Enter':
      case ' ':
        // Buttons keep their own activation.
        if (onControl) return;
        read('rtl');
        break;
      case 'p':
      case 'P':
        showPairs();
        break;
      case 'Escape':
        close({ restoreFocus: true });
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  // Touch: a horizontal swipe across the letters steps the light; a tap on a tile moves it there.
  let swipeStart: { x: number; y: number; id: number } | null = null;
  let swiped = false;
  orbit.addEventListener('pointerdown', (event) => {
    swipeStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    swiped = false;
  });
  orbit.addEventListener('pointerup', (event) => {
    const start = swipeStart;
    swipeStart = null;
    if (start?.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) <= SWIPE_PX || Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    swiped = true;
    // A swipe to the left reads on (the letters run right to left).
    step(dx < 0 ? 1 : -1, false);
    window.setTimeout(() => {
      swiped = false;
    }, 0);
  });
  orbit.addEventListener('pointercancel', () => {
    swipeStart = null;
  });

  /* Open and close ------------------------------------------------------------------------- */

  const onResize = (): void => {
    fitLayout();
  };

  const show = (): void => {
    if (!asset || open) return;
    open = true;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = null;
    // Hold the film first, so no cue can fire between opening and the first frame.
    release = app.holdFilm('discovery');
    unsubscribe = [
      app.events.on('seek', () => {
        close();
      }),
      app.events.on('chapter', () => {
        close();
      }),
    ];
    window.addEventListener('resize', onResize);
    layerQuery.addEventListener('change', onResize);
    fineQuery.addEventListener('change', syncHint);
    syncHint();
    region.hidden = false;
    region.dataset.kfEngaged = 'true';
    fitLayout();
    commitStyles(region);
    region.classList.add('is-open');
    opener.setAttribute('aria-expanded', 'true');
    app.interact('discovery', 1);
    unmark = markPhrase(asset.verses);
    // The light rests on the first letter, and focus goes there once, at the visitor's request; nothing after this moves focus on its own.
    setMode('idle');
    moveTo(0, false, false);
    tiles[0]?.focus({ preventScroll: true });
    // Inline, the panel brings the top of the region (the verse, then the letters) into view, rather
    // than letting focus scroll the tiles to the bottom edge and the verse out of sight.
    if (!region.classList.contains('is-layer')) region.scrollIntoView({ block: 'start', behavior: app.reducedMotion ? 'auto' : 'smooth' });
  };

  /** Still the block on screen, in an open panel, in the chapter it was built for. */
  const canOpen = (): boolean => wrapper.isConnected && app.chapter === chapter && wrapper.closest('[inert], [hidden]') === null;

  const load = (): Promise<void> => {
    loading ??= app.assets.json<AnalysisAsset>(`assets/analysis/${id}.json`).then(
      (data) => {
        // Built once: rebuilding would replace the tiles (and drop focus) under an open analysis.
        if (!asset) build(data);
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };

  function close(options: { restoreFocus?: boolean } = {}): void {
    // Also cancels an opening still waiting for the asset.
    openRequest += 1;
    if (!open) return;
    open = false;
    const hadFocus = region.contains(document.activeElement);
    setMode('idle');
    release?.();
    release = null;
    for (const off of unsubscribe) off();
    unsubscribe = [];
    window.removeEventListener('resize', onResize);
    layerQuery.removeEventListener('change', onResize);
    fineQuery.removeEventListener('change', syncHint);
    unmark();
    unmark = () => undefined;
    delete region.dataset.kfEngaged;
    app.interact('discovery', null);
    opener.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('kf-discovery-layer-open');
    region.classList.remove('is-open');
    const finish = (): void => {
      hideTimer = null;
      if (open) return;
      region.hidden = true;
      region.classList.remove('is-layer');
    };
    // The fade runs on opacity (a crossfade, kept with reduced motion); the region is hidden once it is done.
    if (!region.isConnected) finish();
    else hideTimer = window.setTimeout(finish, FADE_MS + 50);
    if ((options.restoreFocus || hadFocus) && opener.isConnected && !opener.closest('[inert]')) opener.focus();
  }

  opener.addEventListener('click', () => {
    if (open) {
      close({ restoreFocus: true });
      return;
    }
    if (asset) {
      show();
      return;
    }
    const request = openRequest;
    load().then(
      () => {
        if (request === openRequest && canOpen()) show();
      },
      (error: unknown) => {
        console.error('ui: could not load the letter analysis', error);
      },
    );
  });

  return {
    element: wrapper,
    close,
    open() {
      if (!open) opener.click();
    },
    verses: () => load().then(() => asset?.verses.map((v) => v.key) ?? []),
  };
}
