/**
 * The date in the Umm al-Qura calendar (Saudi Arabia's civil Hijri calendar, computed in advance),
 * from the browser's own calendar data (ICU's islamic-umalqura). Many communities begin each month by
 * sighting the new crescent instead, so their dates can differ by a day; the interface says which
 * calendar this is. Null where the browser does not have it.
 */

export interface HijriDate {
  day: number;
  /** 1 Muharram ... 12 Dhu al-Hijjah. */
  month: number;
  year: number;
}

let format: Intl.DateTimeFormat | null | undefined;

function formatter(): Intl.DateTimeFormat | null {
  if (format !== undefined) return format;
  try {
    const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });
    format = f.resolvedOptions().calendar === 'islamic-umalqura' ? f : null;
  } catch {
    format = null;
  }
  return format;
}

/** The Umm al-Qura date of the UTC calendar day containing `unixMs` (the civil day, from midnight). */
export function hijriDate(unixMs: number): HijriDate | null {
  const f = formatter();
  if (!f || !Number.isFinite(unixMs)) return null;
  const parts = f.formatToParts(new Date(unixMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  const day = part('day');
  const month = part('month');
  const year = part('year');
  return Number.isInteger(day) && Number.isInteger(month) && Number.isInteger(year) && month >= 1 && month <= 12 ? { day, month, year } : null;
}
