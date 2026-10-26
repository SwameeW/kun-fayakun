import type { App, ChapterId, Cue, HadithId, VerseKey } from '../core/types';
import { h } from './dom';
import { createFadeSlot, type FadeItem, type FadeSlot } from './fade';
import { arabicFontLoaded, loadArabicFont } from './fonts';
import {
  arabicText,
  availableVerse,
  hadithGrading,
  hadithReference,
  lookupHadith,
  plainExplanation,
  verifiedHadithText,
} from './scripture';
import { onVersePlainChange, versePlain } from './verse-english';
import './styles/cue-text.css';

/** Verses fade slowly and whole; captions a little faster. */
const VERSE_FADE_MS = 1200;
const CAPTION_FADE_MS = 500;
/** Grace before a cue the engine did not deactivate is dropped by the time check. */
const STALE_MARGIN_S = 1;
/** Cue cards shrink their text to fit the stage, but never below this scale (legibility). */
const MIN_FIT = 0.75;

type TextCue = Extract<Cue, { type: 'verse' | 'hadith' }>;
type CaptionCue = Extract<Cue, { type: 'caption' }>;

export interface CueText {
  /** The cinematic verse/hadith overlay (data-testid="verse-overlay"). */
  readonly verseOverlay: HTMLElement;
  readonly captions: HTMLElement;
  /** Fades everything out quickly: used before loading and error screens. */
  clearFast(): void;
}

function cueId(chapter: ChapterId, cue: Cue): string {
  const ref = cue.type === 'verse' ? cue.key : cue.type === 'hadith' ? cue.id : cue.type === 'caption' ? cue.key : '';
  return `${chapter}:${cue.type}:${cue.t}:${ref}`;
}

/**
 * Tracks which cues of one kind are active; the most recently activated one is
 * shown. The engine's cue events drive it; a time check drops stale entries.
 */
class ActiveCues<C extends { t: number; duration: number }> {
  private readonly cues = new Map<string, C>();

  set(id: string, cue: C, active: boolean): void {
    this.cues.delete(id);
    if (active) this.cues.set(id, cue);
  }

  dropOutside(t: number): boolean {
    let changed = false;
    for (const [id, cue] of this.cues) {
      if (t < cue.t - STALE_MARGIN_S || t > cue.t + cue.duration + STALE_MARGIN_S) {
        this.cues.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  clear(): void {
    this.cues.clear();
  }

  latest(): [string, C] | null {
    let last: [string, C] | null = null;
    for (const entry of this.cues) last = entry;
    return last;
  }
}

export function createCueText(app: App, announce: (text: string) => void): CueText {
  const { i18n, data } = app;
  const verseOverlay = h('div', { class: 'kf-verse-overlay', 'data-testid': 'verse-overlay' });
  const captions = h('div', { class: 'kf-captions' });
  const verseSlot: FadeSlot = createFadeSlot(verseOverlay, VERSE_FADE_MS);
  const captionSlot: FadeSlot = createFadeSlot(captions, CAPTION_FADE_MS);
  const textCues = new ActiveCues<TextCue>();
  const captionCues = new ActiveCues<CaptionCue>();
  let chapter: ChapterId | null = null;
  let fontReady = arabicFontLoaded();
  /** The card most recently faded in; refitted when the stage or the overlays above it resize. */
  let mountedCard: HTMLElement | null = null;
  let observing = false;
  const resizeObserver = new ResizeObserver(() => {
    if (mountedCard?.isConnected) fitCard(mountedCard);
  });

  /**
   * Sizes a cue card to the space between the overlays above it and the timeline
   * below, so scripture is shown whole and never runs under the timeline or the
   * notes sheet. Text scales down to MIN_FIT; if even that does not fit (very short
   * screens), the card shows only its reference and points to the notes, where
   * the full text is.
   */
  function fitCard(card: HTMLElement): void {
    const area = verseOverlay.parentElement;
    const stage = area?.parentElement;
    if (!area || !stage) return;
    if (!observing) {
      observing = true;
      resizeObserver.observe(stage);
      const top = stage.querySelector(':scope > .kf-stage-top');
      if (top) resizeObserver.observe(top);
    }
    const overflow = (): number => area.getBoundingClientRect().bottom - stage.getBoundingClientRect().bottom;
    card.classList.remove('is-condensed');
    let fit = 1;
    card.style.setProperty('--kf-fit', '1');
    for (let i = 0; i < 4 && fit > MIN_FIT && overflow() > 0.5; i++) {
      const height = card.getBoundingClientRect().height;
      fit = Math.max(MIN_FIT, (fit * Math.max(0, height - overflow())) / height);
      card.style.setProperty('--kf-fit', fit.toFixed(3));
    }
    if (overflow() > 0.5) card.classList.add('is-condensed');
  }

  function mountCard(card: HTMLElement): void {
    mountedCard = card;
    fitCard(card);
  }

  /** Shown only when a card is condensed to its reference. */
  function notesPointer(): HTMLElement {
    return h('p', { class: 'kf-card-note' }, i18n.t('ui.cue.inNotes'));
  }

  /** The verse in plain words, when the visitor has chosen it for the cards (./verse-english) and it has one. */
  function cardPlain(key: VerseKey): string | null {
    return versePlain() ? plainExplanation(key, i18n) : null;
  }

  function verseCard(key: VerseKey): HTMLElement {
    const entry = availableVerse(data, key);
    const reference = h('p', { class: 'kf-card-ref' }, i18n.t('ui.verse.reference', { key }));
    if (!entry) return h('div', { class: 'kf-card kf-card--verse' }, reference);
    const plain = cardPlain(key);
    // In plain words the explanation takes the translation's place, under a label that says what it is.
    const english = plain
      ? [h('p', { class: 'kf-card-plain-label' }, i18n.t('ui.verse.plainCard')), h('p', { class: 'kf-card-translation kf-card-plain', dir: 'auto' }, plain)]
      : [entry.translation ? h('p', { class: 'kf-card-translation', dir: 'auto' }, entry.translation) : null];
    return h(
      'div',
      { class: 'kf-card kf-card--verse', 'data-verse': key, 'data-plain': plain !== null },
      arabicText(entry.arabic, 'kf-card-arabic'),
      ...english,
      reference,
      notesPointer(),
    );
  }

  function hadithCard(id: HadithId): HTMLElement | null {
    const entry = lookupHadith(data, id);
    if (!entry) return null;
    const text = verifiedHadithText(entry);
    return h(
      'div',
      { class: 'kf-card kf-card--hadith', 'data-hadith': id },
      h('p', { class: 'kf-card-ref' }, hadithReference(entry, i18n)),
      h('p', { class: 'kf-card-meta' }, i18n.t('ui.hadith.narrator', { narrator: entry.narrator })),
      text ? h('p', { class: 'kf-card-translation', dir: 'auto' }, text.en) : null,
      h('p', { class: 'kf-card-meta' }, hadithGrading(entry, i18n)),
      notesPointer(),
    );
  }

  function textItem(id: string, cue: TextCue): FadeItem | null {
    if (cue.type === 'verse') {
      const entry = availableVerse(data, cue.key);
      const plain = entry ? cardPlain(cue.key) : null;
      return {
        // A change of English fades the card out and back in whole, never swapping its words in place.
        key: plain ? `${id}:plain` : id,
        render: () => verseCard(cue.key),
        onMount: mountCard,
        onShow: () => {
          if (plain) announce(i18n.t('ui.announce.versePlain', { key: cue.key, text: plain }));
          else if (entry?.translation) announce(i18n.t('ui.announce.verse', { key: cue.key, translation: entry.translation }));
        },
      };
    }
    const card = hadithCard(cue.id);
    const entry = lookupHadith(data, cue.id);
    if (!card || !entry) return null;
    return {
      key: id,
      render: () => card,
      onMount: mountCard,
      onShow: () => {
        announce(i18n.t('ui.announce.hadith', { reference: hadithReference(entry, i18n), grading: hadithGrading(entry, i18n) }));
      },
    };
  }

  function update(): void {
    const text = textCues.latest();
    if (text?.[1].type === 'verse' && !fontReady) {
      // Fade the verse in only once its typeface is ready, so its glyphs never swap mid-fade.
      void loadArabicFont().then(() => {
        fontReady = true;
        update();
      });
    } else {
      verseSlot.want(text ? textItem(...text) : null);
    }
    const caption = captionCues.latest();
    captionSlot.want(
      caption
        ? { key: caption[0], render: () => h('p', { class: 'kf-caption' }, i18n.t(caption[1].key)) }
        : null,
    );
  }

  function clearFast(): void {
    textCues.clear();
    captionCues.clear();
    verseSlot.clearFast();
    captionSlot.clearFast();
  }

  app.events.on('cue', ({ chapter: cueChapter, cue, active }) => {
    if (cueChapter !== chapter) return;
    if (cue.type === 'verse' || cue.type === 'hadith') textCues.set(cueId(cueChapter, cue), cue, active);
    else if (cue.type === 'caption') captionCues.set(cueId(cueChapter, cue), cue, active);
    else return;
    update();
  });
  app.events.on('chapter', ({ chapter: next }) => {
    if (next !== chapter) clearFast();
    chapter = next;
  });
  app.events.on('time', ({ chapter: timeChapter, t }) => {
    if (timeChapter !== chapter) return;
    const textChanged = textCues.dropOutside(t);
    const captionChanged = captionCues.dropOutside(t);
    if (textChanged || captionChanged) update();
  });
  app.events.on('state', ({ state, chapter: stateChapter }) => {
    // Scripture never shares the screen with loading or idle states.
    if (state === 'loading' || state === 'idle') clearFast();
    chapter = stateChapter;
  });
  app.events.on('error', clearFast);
  onVersePlainChange(update);
  app.events.on('route', ({ route }) => {
    if (route.name !== 'chapter') clearFast();
  });

  chapter = app.chapter;
  return { verseOverlay, captions, clearFast };
}
