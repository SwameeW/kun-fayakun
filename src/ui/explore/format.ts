import type { BodyId, I18n } from '../../core/types';

/** Names of the explorer's bodies (existing HUD keys). */
export const NAME_KEYS: Readonly<Record<BodyId, string>> = {
  sun: 'ui.hud.sunName',
  earth: 'ui.hud.earth',
  moon: 'ui.hud.moon',
  jupiter: 'ui.hud.planet.jupiter',
  saturn: 'ui.hud.planet.saturn',
};

/** From this many astronomical units on, distances are given in them. */
const AU_FROM = 0.01;

export interface Formatters {
  /** km per astronomical unit, from the explorer's data (physical.json, the DE440 header); set from each view. */
  auKm: number;
  name(id: BodyId): string;
  /** Three significant figures in km, or au from 0.01 au out. */
  distance(km: number): string;
  /** A light-time: tenths of a second, seconds, minutes and seconds, or hours and minutes. */
  lightTime(seconds: number): string;
  /** A duration in hours as "9 h 56 min". */
  hours(hours: number): string;
  /** A plain number with the given decimals (locale-aware). */
  number(value: number, digits?: number): string;
}

export function formatters(i18n: I18n): Formatters {
  const number = (value: number, digits = 0): string => i18n.number(value, digits);
  return {
    auKm: Infinity,
    name: (id) => i18n.t(NAME_KEYS[id]),
    number,
    distance(kmValue) {
      const value = Math.max(0, kmValue);
      if (value >= AU_FROM * this.auKm) {
        const au = value / this.auKm;
        return i18n.t('ui.hud.unit.au', { value: number(au, au < 1 ? 3 : au < 10 ? 2 : 1) });
      }
      const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(value, 1))) - 2);
      return i18n.t('ui.hud.unit.km', { value: number(Math.round(value / magnitude) * magnitude, 0) });
    },
    lightTime(seconds) {
      const s = Math.max(0, seconds);
      if (s < 0.1) return i18n.t('ui.universe.time.milli', { ms: number(Math.max(0.1, s * 1000), s < 0.01 ? 1 : 0) });
      if (s < 10) return i18n.t('ui.universe.time.s', { s: number(s, 1) });
      if (s < 60) return i18n.t('ui.universe.time.s', { s: number(Math.round(s), 0) });
      if (s < 3600) {
        const whole = Math.round(s);
        return i18n.t('ui.universe.time.ms', { m: number(Math.floor(whole / 60)), s: number(whole % 60) });
      }
      const minutes = Math.round(s / 60);
      return i18n.t('ui.universe.time.hm', { h: number(Math.floor(minutes / 60)), m: number(minutes % 60) });
    },
    hours(hours) {
      const minutes = Math.round(hours * 60);
      const m = minutes % 60;
      const h = Math.floor(minutes / 60);
      return m === 0 ? i18n.t('ui.universe.time.h', { h: number(h) }) : i18n.t('ui.universe.time.hm', { h: number(h), m: number(m) });
    },
  };
}
