/**
 * The engine owns navigation; the UI parses the hash only to pick its first view
 * before the engine's first route event arrives. It uses the engine's own parser, so
 * the two can never disagree about a URL (a trailing slash, ?t=0, an unknown chapter).
 */
export { parseHash } from '../core/router';

export function chapterHash(number: number): string {
  return `#/ch/${number}`;
}
