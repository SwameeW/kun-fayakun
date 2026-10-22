/** Self-hosted Amiri Quran (SIL OFL), the only typeface used for Quranic Arabic. */
const ARABIC_FONT_FAMILY = 'Amiri Quran';
export const ARABIC_FONT_PATH = 'fonts/AmiriQuran.woff2';

const FONT_QUERY = `1em "${ARABIC_FONT_FAMILY}"`;

let loading: Promise<void> | null = null;

/** Declares the @font-face with a URL resolved against the deployed base URL. */
export function declareArabicFont(url: string): void {
  const style = document.createElement('style');
  style.textContent = `@font-face { font-family: "${ARABIC_FONT_FAMILY}"; src: url(${JSON.stringify(url)}) format("woff2"); font-display: swap; }`;
  document.head.append(style);
}

export function arabicFontLoaded(): boolean {
  return document.fonts.check(FONT_QUERY);
}

/**
 * Loads the Arabic font (once). Resolves even if loading fails, so callers can
 * fall back to system fonts rather than wait forever.
 */
export function loadArabicFont(): Promise<void> {
  loading ??= document.fonts.load(FONT_QUERY).then(
    () => undefined,
    (err: unknown) => {
      console.warn('ui: Arabic font did not load', err);
    },
  );
  return loading;
}
