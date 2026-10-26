import { CHAPTERS } from '../chapters/index';
import { parseJulianDate } from './params';
import { BODY_IDS, type AppEvents, type BodyId, type ChapterId, type EventBus, type Route } from './types';

const CHAPTER_ROUTE = /^#?\/ch\/(\d{1,2})\/?(?:\?(.*))?$/;
const UNIVERSE_ROUTE = /^#?\/universe(?:\/([a-z]*))?\/?(?:\?(.*))?$/i;
/** The orbital laboratory's address inside the explorer's. */
const LAB = 'lab';

function chapterIdFromNumber(n: number): ChapterId | null {
  return CHAPTERS.find((c) => c.number === n)?.id ?? null;
}

/**
 * Parses "#/", "#/ch/<n>?t=<seconds>", "#/sources", "#/universe[/<body>][?jd=<Julian date>]" and
 * "#/universe/lab[?jd=...]" (the orbital laboratory, forked at that date), or "#/universe/lab?s=..." (a
 * scenario carried in the link, src/sim/share); anything else is home. An unknown body still opens the
 * explorer, on its default view.
 */
export function parseHash(hash: string): Route {
  const h = hash.trim();
  if (h === '#/sources' || h === '#/sources/') return { name: 'sources' };
  const m = CHAPTER_ROUTE.exec(h);
  if (m) {
    const chapter = chapterIdFromNumber(Number(m[1]));
    if (chapter) {
      const raw = new URLSearchParams(m[2] ?? '').get('t');
      const t = raw === null || raw.trim() === '' ? NaN : Number(raw);
      return { name: 'chapter', chapter, t: Number.isFinite(t) && t >= 0 ? t : null };
    }
  }
  const u = UNIVERSE_ROUTE.exec(h);
  if (u) {
    const name = (u[1] ?? '').toLowerCase();
    const body = BODY_IDS.find((b) => b === name) ?? null;
    const query = new URLSearchParams(u[2] ?? '');
    const jd = parseJulianDate(query.get('jd'));
    const share = query.get('s');
    if (name === LAB) return share && /^[A-Za-z0-9_-]{8,16000}$/u.test(share) ? { name: 'universe', body: null, jd, lab: true, share } : { name: 'universe', body: null, jd, lab: true };
    return { name: 'universe', body, jd };
  }
  return { name: 'home' };
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'sources':
      return '#/sources';
    case 'chapter': {
      const n = Number(route.chapter.slice(2));
      return route.t === null ? `#/ch/${n}` : `#/ch/${n}?t=${Math.round(route.t * 10) / 10}`;
    }
    case 'universe': {
      const body: BodyId | null = route.body;
      const where = route.lab ? `/${LAB}` : body ? `/${body}` : '';
      if (route.lab && route.share) return `#/universe${where}?s=${route.share}`;
      return `#/universe${where}${route.jd === null ? '' : `?jd=${route.jd}`}`;
    }
  }
}

export interface Router {
  readonly current: Route;
  /** Reads the initial hash and reports it like a user navigation. */
  start(): void;
  /** Updates the URL for an app-initiated change (no onNavigate callback). */
  navigate(route: Route, options?: { replace?: boolean }): void;
  dispose(): void;
}

/**
 * Hash router. User navigation (typed URL, back/forward, links) reaches the
 * app through onNavigate; app-initiated changes only update the URL. Both emit
 * 'route' so the UI can follow.
 */
export function createRouter(events: EventBus<AppEvents>, onNavigate: (route: Route) => void): Router {
  let current: Route = parseHash(window.location.hash);

  const onHashChange = (): void => {
    current = parseHash(window.location.hash);
    events.emit('route', { route: current });
    onNavigate(current);
  };

  return {
    get current() {
      return current;
    },
    start() {
      window.addEventListener('hashchange', onHashChange);
      onHashChange();
    },
    navigate(route, options) {
      const hash = formatRoute(route);
      if (hash !== window.location.hash) {
        // pushState/replaceState never fire hashchange, so this does not loop back.
        if (options?.replace) history.replaceState(history.state, '', hash);
        else history.pushState(history.state, '', hash);
      }
      current = route;
      events.emit('route', { route });
    },
    dispose() {
      window.removeEventListener('hashchange', onHashChange);
    },
  };
}
