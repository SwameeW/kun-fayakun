import type { BodyId, I18n } from '../../core/types';

/** Names of the explorer's bodies (existing HUD keys). */
export const NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  jupiter: 'ui.hud.planet.jupiter',
  mercury: 'ui.hud.planet.mercury',
  venus: 'ui.hud.planet.venus',
  mars: 'ui.hud.planet.mars',
  uranus: 'ui.hud.planet.uranus',
  neptune: 'ui.hud.planet.neptune',
  saturn: 'ui.hud.planet.saturn',
};

/**
 * From this many astronomical units on, distances are given in them. Below it, kilometres: a
 * height above a surface reads as "2,600,000 km" on every layout (a phone frames from further out
 * than a wide screen, and the same kind of number should not change its unit with the window).
 */
const AU_FROM = 0.1;
/** No line ever breaks between a number and its unit, nor inside a duration ("1 min 8 s"). */
const NBSP = ' ';
const keepTogether = (text: string): string => text.replace(/(\d) (?=\S)/gu, `$1${NBSP}`).replace(/(min|h) (?=\d)/gu, `$1${NBSP}`);

export interface Formatters {
  /** km per astronomical unit, from the explorer's data (physical.json, the DE440 header); set from each view. */
  auKm: number;
  name(id: BodyId): string;
  /** Three significant figures in km, or au from 0.1 au out. */
  distance(km: number): string;
  /** A distance in plain words, two figures ("1.3 billion km", "400 thousand km"), for a scale's end. */
  distanceWords(km: number): string;
  /** A light-time: tenths of a second, seconds, minutes and seconds, or hours and minutes. */
  lightTime(seconds: number): string;
  /** A duration in hours as "9 h 56 min". */
  hours(hours: number): string;
  /** A plain number with the given decimals (locale-aware). */
  number(value: number, digits?: number): string;
  /** The same text with no line break between a number and its unit, nor inside a duration. */
  keep(text: string): string;
}

export function formatters(i18n: I18n): Formatters {
  const number = (value: number, digits = 0): string => i18n.number(value, digits);
  const words = new Intl.NumberFormat(i18n.locale, { notation: 'compact', compactDisplay: 'long', maximumSignificantDigits: 2 });
  return {
    auKm: Infinity,
    name: (id) => i18n.t(NAME_KEYS[id]),
    number,
    keep: keepTogether,
    distance(kmValue) {
      const value = Math.max(0, kmValue);
      if (value >= AU_FROM * this.auKm) {
        const au = value / this.auKm;
        return keepTogether(i18n.t('ui.hud.unit.au', { value: number(au, au < 1 ? 3 : au < 10 ? 2 : 1) }));
      }
      const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(value, 1))) - 2);
      return keepTogether(i18n.t('ui.hud.unit.km', { value: number(Math.round(value / magnitude) * magnitude, 0) }));
    },
    distanceWords(kmValue) {
      // A short label at a scale's end: kept on one line whole.
      return i18n.t('ui.hud.unit.km', { value: words.format(Math.max(1, kmValue)) }).replace(/ /gu, NBSP);
    },
    lightTime(seconds) {
      const s = Math.max(0, seconds);
      let text: string;
      if (s < 0.1) text = i18n.t('ui.universe.time.milli', { ms: number(Math.max(0.1, s * 1000), s < 0.01 ? 1 : 0) });
      else if (s < 10) text = i18n.t('ui.universe.time.s', { s: number(s, 1) });
      else if (s < 60) text = i18n.t('ui.universe.time.s', { s: number(Math.round(s), 0) });
      else if (s < 3600) {
        const whole = Math.round(s);
        text = i18n.t('ui.universe.time.ms', { m: number(Math.floor(whole / 60)), s: number(whole % 60) });
      } else {
        const minutes = Math.round(s / 60);
        text = i18n.t('ui.universe.time.hm', { h: number(Math.floor(minutes / 60)), m: number(minutes % 60) });
      }
      return keepTogether(text);
    },
    hours(hours) {
      const minutes = Math.round(hours * 60);
      const m = minutes % 60;
      const h = Math.floor(minutes / 60);
      return keepTogether(m === 0 ? i18n.t('ui.universe.time.h', { h: number(h) }) : i18n.t('ui.universe.time.hm', { h: number(h), m: number(m) }));
    },
  };
}
