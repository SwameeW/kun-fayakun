/**
 * The hash router's parser (src/core/router.ts) and the UI's copy of it (src/ui/route.ts),
 * which must be one and the same: the UI picks its first view from the hash before the
 * engine's first route event, and the two used to disagree on edge cases.
 */
import { expect, test } from '@playwright/test';
import { CHAPTERS } from '../../src/chapters/index';
import { formatRoute, parseHash } from '../../src/core/router';
import { chapterHash, parseHash as uiParseHash } from '../../src/ui/route';

test('the UI uses the engine parser itself', () => {
  expect(uiParseHash).toBe(parseHash);
});

test('home, the empty hash and anything unknown are home', () => {
  for (const hash of ['', '#', '#/', '  #/  ', '#/nowhere', '#/ch', '#/ch/', '#/ch/x', '#/ch/123', '#/sourcesx']) {
    expect(parseHash(hash), hash).toEqual({ name: 'home' });
  }
});

test('sources, with or without a trailing slash', () => {
  expect(parseHash('#/sources')).toEqual({ name: 'sources' });
  expect(parseHash('#/sources/')).toEqual({ name: 'sources' });
});

test('a chapter that does not exist is home, not a made-up chapter id', () => {
  expect(parseHash('#/ch/42')).toEqual({ name: 'home' });
  expect(parseHash('#/ch/99?t=5')).toEqual({ name: 'home' });
});

test('chapter routes accept a leading zero and a trailing slash', () => {
  expect(parseHash('#/ch/7')).toEqual({ name: 'chapter', chapter: 'ch07', t: null });
  expect(parseHash('#/ch/07')).toEqual({ name: 'chapter', chapter: 'ch07', t: null });
  expect(parseHash('#/ch/7/')).toEqual({ name: 'chapter', chapter: 'ch07', t: null });
  expect(parseHash('#/ch/0')).toEqual({ name: 'chapter', chapter: 'ch00', t: null });
});

test('t is a non-negative number of seconds; anything else means "from the start"', () => {
  const t = (hash: string): number | null => {
    const route = parseHash(hash);
    return route.name === 'chapter' ? route.t : NaN;
  };
  expect(t('#/ch/3?t=12.5')).toBe(12.5);
  expect(t('#/ch/3/?t=12.5')).toBe(12.5);
  expect(t('#/ch/3?t=0')).toBe(0);
  expect(t('#/ch/3?t=-1')).toBeNull();
  expect(t('#/ch/3?t=')).toBeNull();
  expect(t('#/ch/3?t=abc')).toBeNull();
  expect(t('#/ch/3?t=Infinity')).toBeNull();
  expect(t('#/ch/3?x=1')).toBeNull();
});

test('the solar-system explorer: #/universe, an optional body and an optional ?jd=', () => {
  expect(parseHash('#/universe')).toEqual({ name: 'universe', body: null, jd: null });
  expect(parseHash('#/universe/')).toEqual({ name: 'universe', body: null, jd: null });
  expect(parseHash('#/universe/earth')).toEqual({ name: 'universe', body: 'earth', jd: null });
  expect(parseHash('#/universe/Saturn/')).toEqual({ name: 'universe', body: 'saturn', jd: null });
  expect(parseHash('#/universe/moon?jd=2461100.5')).toEqual({ name: 'universe', body: 'moon', jd: 2461100.5 });
  expect(parseHash('#/universe?jd=2461100.5')).toEqual({ name: 'universe', body: null, jd: 2461100.5 });
  // A body the explorer does not have yet still opens it, on its default view; a bad date is ignored.
  expect(parseHash('#/universe/pluto')).toEqual({ name: 'universe', body: null, jd: null });
  expect(parseHash('#/universe/sun?jd=abc')).toEqual({ name: 'universe', body: 'sun', jd: null });
  expect(parseHash('#/universe/sun?jd=-5')).toEqual({ name: 'universe', body: 'sun', jd: null });
  expect(parseHash('#/universex')).toEqual({ name: 'home' });
  expect(parseHash('#/universe/earth/moon')).toEqual({ name: 'home' });
});

test('every explorer route round-trips through formatRoute', () => {
  for (const body of [null, 'sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
    for (const jd of [null, 2461336.75]) {
      expect(parseHash(formatRoute({ name: 'universe', body, jd }))).toEqual({ name: 'universe', body, jd });
    }
  }
});

test('every chapter round-trips through formatRoute and chapterHash', () => {
  for (const meta of CHAPTERS) {
    expect(parseHash(formatRoute({ name: 'chapter', chapter: meta.id, t: null }))).toEqual({ name: 'chapter', chapter: meta.id, t: null });
    expect(parseHash(formatRoute({ name: 'chapter', chapter: meta.id, t: 42.25 }))).toEqual({ name: 'chapter', chapter: meta.id, t: 42.3 });
    expect(parseHash(chapterHash(meta.number))).toEqual({ name: 'chapter', chapter: meta.id, t: null });
  }
  expect(parseHash(formatRoute({ name: 'home' }))).toEqual({ name: 'home' });
  expect(parseHash(formatRoute({ name: 'sources' }))).toEqual({ name: 'sources' });
});
