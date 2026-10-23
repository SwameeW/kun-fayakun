import { BODY_IDS, type App, type BodyId, type ChapterId, type UniverseView } from '../../core/types';
import { focusLost, h } from '../dom';
import { icon } from '../icons';
import '../styles/explore.css';
import { createFlightHud } from './flight-hud';
import { formatters } from './format';
import { createNavigator } from './navigator';
import { createNotes } from './notes';
import { storedDetailChoice } from './quality-menu';
import { createToast } from './toast';

/**
 * The solar-system explorer's interface, loaded with the explorer (its own chunk, never in the
 * shell): the celestial navigator (./navigator: every world with a live portrait, its distance and
 * light-time, an orrery to fly by, what has been seen, the detail menu), a heads-up readout of where
 * the camera is and how it moves (./flight-hud, with the trip indicator), quiet notes about what is
 * near (./notes), a way back to the film, and a hint that fades once the visitor has moved.
 *
 * The explorer is told what the interface covers (the header, the side panel or the bottom sheet,
 * the readout where it spans a phone's width) so it frames the bodies in the clear part of the view.
 * Everything is real DOM text. Moves are announced politely; the readout is plain text, not live.
 * Focus moves into the explorer when it opens (the button that opened it has gone).
 */

export interface UniverseUi {
  readonly element: HTMLElement;
  setVisible(visible: boolean): void;
  /** Where "back" goes: a chapter, or the start. */
  setOrigin(chapter: ChapterId | null): void;
}

/** Which surface the altitude is measured from. */
const SURFACE_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.universe.photosphere',
  earth: 'ui.universe.surface',
  moon: 'ui.universe.surface',
  jupiter: 'ui.universe.clouds',
  saturn: 'ui.universe.clouds',
};
/**
 * The hint comes once the camera has settled after the opening push-in (or after HINT_WAIT_SECONDS
 * at most), and fades HINT_SECONDS later or at the visitor's first move; a visitor who moves first
 * never needs it. Toasts for what joins the log wait for the same moment.
 */
const HINT_SECONDS = 9;
const HINT_WAIT_SECONDS = 8;
/** The navigator's numbers and portraits refresh this often (they change slowly; the readout every frame). */
const SLOW_MS = 250;

export function mountUniverse(app: App, announce: (text: string) => void): UniverseUi {
  const { i18n } = app;
  const f = formatters(i18n);
  const coarse = window.matchMedia('(pointer: coarse)');

  const back = h('button', { type: 'button', class: 'kf-btn kf-universe-back', 'data-testid': 'universe-back' }, icon('back'), h('span', { class: 'kf-universe-back-text' }));
  back.addEventListener('click', () => {
    app.closeUniverse();
  });
  const backText = back.querySelector('.kf-universe-back-text') as HTMLElement;

  // A quiet toast marks what joins the log of what was seen, and a detail level applied.
  const toast = createToast('universe-toast');
  const hud = createFlightHud(app, f, (id) => SURFACE_KEYS[id], () => element);
  const notes = createNotes(app, f, announce, () => navigator.layout === 'sheet');
  const navigator = createNavigator(app, f, (title, line) => {
    toast.show(title, line);
  });
  const hint = h('p', { class: 'kf-universe-hint' });
  const loading = h('p', { class: 'kf-universe-loading', role: 'status' }, i18n.t('ui.universe.loading'));

  // A programmatic focus target (tabindex -1): opening the explorer lands here, not on the page's body.
  const element = h(
    'section',
    { class: 'kf-universe', 'aria-label': i18n.t('ui.universe.label'), 'data-testid': 'universe', tabindex: '-1', hidden: true },
    back,
    hint,
    loading,
    hud.trip,
    notes.element,
    hud.readout,
    toast.element,
    navigator.element,
  );

  // On a phone a touch on the scene folds the note to its title: the world gets the screen back.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (visible && event.target instanceof HTMLCanvasElement) notes.fold();
    },
    { capture: true, passive: true },
  );

  // The visitor's remembered detail choice, before the explorer builds its first frame.
  const stored = storedDetailChoice();
  if (stored) app.setUniverseDetail(stored);

  // Esc folds a pulled-up sheet (a narrow window or a phone with a keyboard) before it would leave the
  // explorer; a menu inside it, or a dialog, handles its own Esc, and a trip that Esc just stopped is enough.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!visible || event.key !== 'Escape' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (navigator.layout !== 'sheet' || !navigator.expanded) return;
      if (event.target instanceof Element && event.target.closest('[data-kf-keys="own"], dialog')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigator.setExpanded(false);
    },
    true,
  );

  // A double tap or click on a body in the scene flies there: the address follows, as for the list.
  window.addEventListener('kf-universe-focus', (event) => {
    const id = (event as CustomEvent<unknown>).detail;
    if (visible && typeof id === 'string' && BODY_IDS.includes(id as BodyId)) app.focusBody(id as BodyId);
  });

  /**
   * What the interface covers: the header at the top (and the readout where it runs across a
   * phone's top), the side panel at the right, the sheet at the bottom (pulled up on a phone held
   * sideways, at the right). The view frames bodies in the rest.
   */
  const reportInsets = (): void => {
    if (!visible) return;
    const height = window.innerHeight || 1;
    const width = window.innerWidth || 1;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kf-header-h')) || 0;
    const nav = navigator.element.getBoundingClientRect();
    const readout = hud.readout.getBoundingClientRect();
    let top = header;
    // A readout across the top middle (as on a phone) is covered space too.
    if (readout.height > 0 && readout.top < height / 2 && readout.left < width / 3 && readout.right > width / 3) top = Math.max(top, readout.bottom);
    const isSheet = navigator.layout === 'sheet' && nav.height > 0;
    // A sheet pulled up beside the view (a phone held sideways: tall, at the right) covers the right, not the bottom.
    const beside = isSheet && nav.left > width / 4 && nav.height > height / 2;
    const right = (navigator.layout === 'panel' && nav.width > 0) || beside ? Math.max(0, width - nav.left) : 0;
    const sheet = isSheet && !beside ? Math.max(0, height - nav.top) : 0;
    let bottom = sheet;
    // On a phone held upright a note stands above the folded sheet: the world in view makes room for
    // it (the view eases up). Not while the sheet is pulled up (the note waits), nor when the note sits
    // at the top (a phone held sideways).
    const card = notes.element.querySelector('.kf-note.is-visible')?.getBoundingClientRect();
    if (navigator.layout === 'sheet' && !navigator.expanded && card && card.height > 0 && card.top > height / 2 && !element.classList.contains('is-travelling')) {
      bottom = Math.max(bottom, height - card.top);
    }
    // Notes and the trip indicator sit just clear of the readout and the sheet.
    element.style.setProperty('--kf-readout-h', `${hud.readout.offsetHeight}px`);
    element.style.setProperty('--kf-sheet-h', `${sheet}px`);
    element.classList.toggle('is-sheet-open', navigator.layout === 'sheet' && navigator.expanded);
    app.setViewInsets({ top, bottom, left: 0, right });
  };
  navigator.onResize(reportInsets);
  new ResizeObserver(reportInsets).observe(hud.readout);
  window.addEventListener('resize', reportInsets);

  let visible = false;
  let ready = false;
  let shownFocus: BodyId | null = null;
  let wasTravelling = false;
  let hintTimer = 0;
  let lastSlow = 0;
  /** The opening is still settling: the hint and toasts wait (until when, at the latest, performance.now() ms). */
  let settling = false;
  let settleBy = 0;
  /** How many of the log's entries have had their toast. */
  let toasted = 0;

  const render = (view: UniverseView, now: number): void => {
    f.auKm = view.auKm;
    hud.update(view);
    notes.update(view);
    if (settling && ((!view.moving && !view.travelling) || now >= settleBy)) {
      settling = false;
      if (visible) armHint();
    }
    // Something seen for the first time: a quiet toast says it joined the log (one at a time).
    if (!settling && view.witnessed.length > toasted) {
      for (const id of view.witnessed.slice(toasted)) toast.show(i18n.t(`ui.universe.seen.${id}`), i18n.t('ui.universe.seenToast'));
      toasted = view.witnessed.length;
    }
    const slow = now - lastSlow >= SLOW_MS;
    if (slow) lastSlow = now;
    navigator.update(view, slow || shownFocus !== view.focus);
    const travellingChanged = element.classList.contains('is-travelling') !== view.travelling;
    const noteChanged = element.classList.contains('has-note') !== (view.discovery !== null);
    element.classList.toggle('is-travelling', view.travelling);
    element.classList.toggle('has-note', view.discovery !== null);
    element.dataset.mode = view.mode;
    // A note coming or going (or a trip) changes what covers the view on a phone.
    if (travellingChanged || noteChanged) requestAnimationFrame(reportInsets);
    if (view.focus !== shownFocus) {
      if (shownFocus !== null) announce(i18n.t(view.travelling ? 'ui.universe.announce.travel' : 'ui.universe.announce.arrive', { body: f.name(view.focus) }));
      shownFocus = view.focus;
    } else if (wasTravelling && !view.travelling) {
      announce(i18n.t('ui.universe.announce.arrive', { body: f.name(view.focus) }));
    }
    wasTravelling = view.travelling;
  };

  const frame = (now: number): void => {
    if (!visible) return;
    const view = app.universe();
    hud.readout.hidden = view === null;
    if (view) render(view, now);
    requestAnimationFrame(frame);
  };

  /** The hint goes once the visitor moves the view, or after HINT_SECONDS. */
  const dismissHint = (): void => {
    window.clearTimeout(hintTimer);
    settling = false;
    element.classList.add('is-hinted');
    window.removeEventListener('pointerdown', dismissHint, true);
    window.removeEventListener('wheel', dismissHint, true);
    window.removeEventListener('keydown', dismissOnMove, true);
  };
  const dismissOnMove = (event: KeyboardEvent): void => {
    if (/^(Arrow|Key[WASDRFQE]$|Equal|Minus|Page)/.test(event.code)) dismissHint();
  };
  const armHint = (): void => {
    element.classList.remove('is-hinted');
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(dismissHint, HINT_SECONDS * 1000);
    window.addEventListener('pointerdown', dismissHint, true);
    window.addEventListener('wheel', dismissHint, { capture: true, passive: true });
    window.addEventListener('keydown', dismissOnMove, true);
  };

  /** Focus that was on a control now hidden (the way in) has fallen to the page: bring it into the explorer. */
  const takeFocus = (): void => {
    if (focusLost()) element.focus({ preventScroll: true });
  };

  const setReady = (next: boolean): void => {
    ready = next;
    loading.hidden = ready || !visible;
    element.classList.toggle('is-ready', ready);
    // The scene's name tags (the shared tag layer) come up with the picture.
    document.documentElement.classList.toggle('kf-universe-lit', ready);
    if (!ready) return;
    const view = app.universe();
    if (view) {
      shownFocus = null;
      render(view, performance.now());
      shownFocus = view.focus;
      announce(i18n.t('ui.universe.announce.open', { body: f.name(view.focus) }));
    }
    if (visible) {
      takeFocus();
      // The hint waits for the camera to settle; a first move before then means it is not needed.
      settling = true;
      settleBy = performance.now() + HINT_WAIT_SECONDS * 1000;
      window.addEventListener('pointerdown', dismissHint, true);
      window.addEventListener('wheel', dismissHint, { capture: true, passive: true });
      window.addEventListener('keydown', dismissOnMove, true);
      reportInsets();
    }
  };
  app.events.on('universe', ({ ready: next }) => {
    setReady(next);
  });

  // Hidden until the camera settles (setReady and render arm it).
  element.classList.add('is-hinted');

  return {
    element,
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      element.hidden = !next;
      document.documentElement.classList.toggle('kf-universe-open', next);
      loading.hidden = ready || !next;
      if (next) {
        requestAnimationFrame(frame);
        // Opened while its buttons vanish: hold focus here until the explorer is ready.
        takeFocus();
        reportInsets();
      } else {
        dismissHint();
      }
    },
    setOrigin(chapter) {
      const meta = app.chapters.find((c) => c.id === chapter);
      backText.textContent = meta ? i18n.t('ui.universe.backTo', { number: meta.number }) : i18n.t('ui.universe.home');
      const where = meta ? i18n.t('ui.universe.whereChapter', { number: meta.number }) : i18n.t('ui.universe.whereHome');
      hint.textContent = i18n.t(coarse.matches ? 'ui.universe.hintTouch' : 'ui.universe.hintKeys', { where });
    },
  };
}
