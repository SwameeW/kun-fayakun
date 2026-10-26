import { BODY_IDS, type App, type BodyId } from '../../core/types';
import photoMessages from '../../i18n/en.photo.json';
import { h } from '../dom';

/**
 * Photo mode's bar (its own chunk, loaded the first time photo mode opens; ./index keeps the mode
 * itself and its keys): the picture saved with its credits below it (ledger CR-1), a video recorded
 * where the browser can (CR-3), a lens, an exposure and a body kept in its place in the frame (CR-2),
 * and the way back to the interface. The exposure moves through the engine's flash-safe limiter like
 * any other, and a picture or video taken with it says so in its credits.
 */

export interface PhotoBar {
  readonly element: HTMLElement;
  /** The way back to the interface (focused when photo mode opens). */
  readonly exit: HTMLButtonElement;
  /** The explorer's own framing and exposure again (photo mode closing). */
  reset(): void;
}

const LENSES = [null, 90, 50, 20, 5] as const;
/** Exposure compensation offered, in stops (whole ones: each doubles or halves the light). */
const STOPS = [-2, -1, 0, 1, 2] as const;

export function createPhotoBar(app: App, announce: (text: string) => void, onExit: () => void, name: (id: BodyId) => string): PhotoBar {
  const { i18n } = app;
  i18n.extend('en.photo.json', photoMessages);
  const exit = h('button', { type: 'button', class: 'kf-btn kf-universe-photo-exit', 'data-testid': 'universe-photo-exit' }, i18n.t('ui.universe.photoExit'));
  exit.addEventListener('click', onExit);

  // The credits below a picture or a video: where and when, what in it is illustrative, whose imagery and data it shows (the lines the readouts carry).
  const pictureDate = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
  const visibleText = (selector: string): string => {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const text = el.textContent.trim();
      if (text !== '' && el.closest('[hidden]') === null) return text;
    }
    return '';
  };
  let stops = 0;
  const pictureCredits = (): { where: string; lines: string[]; unixMs: number; focus: string } | null => {
    const view = app.universe();
    if (!view) return null;
    const where = visibleText('[data-testid="walk-title"]') || visibleText('[data-testid="descent-title"]') || (view.neighbourhood ? visibleText('[data-testid="stars-focus-name"]') : '') || visibleText('.kf-universe-title');
    const lines = [
      i18n.t('ui.universe.photoWhere', { where, date: pictureDate.format(new Date(view.unixMs)) }),
      ...[...document.querySelectorAll<HTMLElement>('[data-photo-credit]')].filter((el) => el.closest('[hidden]') === null).map((el) => el.textContent.trim()).filter((t) => t !== ''),
      ...(stops === 0 ? [] : [i18n.t(stops > 0 ? 'ui.universe.photoExposedBrighter' : 'ui.universe.photoExposedDarker', { stops: Math.abs(stops) })]),
      i18n.t('ui.universe.photoCredit'),
    ];
    return { where, lines, unixMs: view.unixMs, focus: view.focus };
  };
  const fileName = (c: { where: string; unixMs: number; focus: string }, ext: string): string =>
    `kun-fayakun-${(c.where || c.focus).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}-${new Date(c.unixMs).toISOString().slice(0, 10)}.${ext}`;
  const download = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  // The picture (ledger CR-1): the view as drawn, its credits set below it.
  const save = h('button', { type: 'button', class: 'kf-btn kf-universe-photo-save', 'data-testid': 'universe-photo-save' }, i18n.t('ui.universe.photoSave'));
  save.addEventListener('click', () => {
    const c = pictureCredits();
    if (!c) return;
    save.disabled = true;
    void app.capturePicture(c.lines).then((blob) => {
      save.disabled = false;
      if (!blob) {
        announce(i18n.t('ui.universe.photoSaveFailed'));
        return;
      }
      download(blob, fileName(c, 'png'));
      announce(i18n.t('ui.universe.photoSaved'));
    });
  });

  // A video (ledger CR-3), where the browser can: the view as it moves, with its credits below.
  const record = h('button', { type: 'button', class: 'kf-btn kf-universe-photo-record', 'aria-pressed': 'false', 'data-testid': 'universe-photo-record' }, i18n.t('ui.universe.photoRecord'));
  record.hidden = typeof MediaRecorder === 'undefined';
  let recordingFrom: { where: string; unixMs: number; focus: string } | null = null;
  record.addEventListener('click', () => {
    if (recordingFrom) {
      const from = recordingFrom;
      recordingFrom = null;
      record.setAttribute('aria-pressed', 'false');
      record.textContent = i18n.t('ui.universe.photoRecord');
      void app.stopRecording().then((blob) => {
        if (!blob) {
          announce(i18n.t('ui.universe.photoRecordFailed'));
          return;
        }
        download(blob, fileName(from, blob.type.includes('mp4') ? 'mp4' : 'webm'));
        announce(i18n.t('ui.universe.photoRecorded'));
      });
      return;
    }
    const c = pictureCredits();
    if (!c || !app.startRecording(() => pictureCredits()?.lines ?? c.lines)) {
      announce(i18n.t('ui.universe.photoRecordFailed'));
      return;
    }
    recordingFrom = c;
    record.setAttribute('aria-pressed', 'true');
    record.textContent = i18n.t('ui.universe.photoRecordStop');
    announce(i18n.t('ui.universe.photoRecording'));
  });

  // The lens (ledger CR-2): the explorer's own framing, or a field of view chosen for the picture.
  const lens = h(
    'select',
    { class: 'kf-btn kf-universe-photo-lens', 'aria-label': i18n.t('ui.universe.photoLens'), 'data-testid': 'universe-photo-lens' },
    ...LENSES.map((deg) => h('option', { value: deg === null ? '' : String(deg) }, deg === null ? i18n.t('ui.universe.photoLensOwn') : i18n.t('ui.universe.photoLensDeg', { deg }))),
  );
  lens.addEventListener('change', () => {
    const deg = Number(lens.value);
    app.earthCommand({ kind: 'lens', fovDeg: lens.value === '' || !Number.isFinite(deg) ? null : deg });
  });

  // The exposure (ledger CR-2): the explorer's own, or whole stops brighter or darker for the picture.
  const exposure = h(
    'select',
    { class: 'kf-btn kf-universe-photo-lens', 'aria-label': i18n.t('ui.universe.photoExposure'), 'data-testid': 'universe-photo-exposure' },
    ...STOPS.map((n) => h('option', { value: String(n), selected: n === 0 }, n === 0 ? i18n.t('ui.universe.photoExposureOwn') : i18n.t(n > 0 ? 'ui.universe.photoExposurePlus' : 'ui.universe.photoExposureMinus', { stops: Math.abs(n) }))),
  );
  exposure.addEventListener('change', () => {
    const n = Number(exposure.value);
    stops = STOPS.find((x) => x === n) ?? 0;
    app.setExposureBias(stops);
  });

  // Tracking (ledger CR-2): a body kept in its place in the frame as it moves round the world in view.
  const track = h(
    'select',
    { class: 'kf-btn kf-universe-photo-lens', 'aria-label': i18n.t('ui.universe.photoTrack'), 'data-testid': 'universe-photo-track' },
    h('option', { value: '' }, i18n.t('ui.universe.photoTrackNone')),
    ...BODY_IDS.map((id) => h('option', { value: id }, i18n.t('ui.universe.photoTrackBody', { name: name(id) }))),
  );
  track.addEventListener('change', () => {
    app.earthCommand({ kind: 'track', body: BODY_IDS.find((id) => id === track.value) ?? null });
  });

  return {
    element: h('div', { class: 'kf-universe-photo-controls' }, lens, exposure, track, record, save, exit),
    exit,
    reset() {
      lens.value = '';
      if (app.universe()?.lensFov !== null) app.earthCommand({ kind: 'lens', fovDeg: null });
      exposure.value = '0';
      if (stops !== 0) app.setExposureBias(0);
      stops = 0;
      if (track.value !== '') {
        track.value = '';
        app.earthCommand({ kind: 'track', body: null });
      }
    },
  };
}
