import type { ChapterId, Route } from '../core/types';

const CHAPTER_ROUTE = /^#\/ch\/(\d{1,2})(?:\?(.*))?$/;

/**
 * Reads the hash route (#/, #/ch/<n>?t=<s>, #/sources). The engine owns
 * navigation; the UI parses the hash only to pick its first view before the
 * engine's first route event arrives.
 */
export function parseHash(hash: string): Route {
  if (hash === '#/sources') return { name: 'sources' };
  const match = CHAPTER_ROUTE.exec(hash);
  if (match?.[1] !== undefined) {
    const chapter = `ch${match[1].padStart(2, '0')}` as ChapterId;
    const t = Number(new URLSearchParams(match[2] ?? '').get('t'));
    return { name: 'chapter', chapter, t: Number.isFinite(t) && t > 0 ? t : null };
  }
  return { name: 'home' };
}

export function chapterHash(number: number): string {
  return `#/ch/${number}`;
}
