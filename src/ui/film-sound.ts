import type { FilmRecordingCheck, FilmScore, FilmScoreState } from '../core/film-score';
import type { App, ChapterContent, ChapterId } from '../core/types';
import { sound } from './sound-preference';

/**
 * When the film's sound plays (the sound itself is ../core/film-score, its own chunk, loaded the
 * first time a chapter plays with sound on). It plays while a chapter plays, softer while the visitor
 * explores the chapter's scene, and not at all on the loading, title and closing screens or while the
 * solar-system explorer is open (that has its own wind). Browsers let sound begin only once the
 * visitor has touched the page, so it waits for that. A pause suspends it with the film
 * (src/core/audio.ts); a seek never sets off a one-shot. Between chapters (a chapter's closing card,
 * the next loading, its title card) the score is kept, silent, so the next chapter's recordings,
 * fetched while this one played, are still in hand; it is let go, recordings and all, only once the
 * film's sound stops: the Sound turned off, the explorer opened, or the film over.
 */
export interface FilmSound {
  /** What plays now (null before the score has loaded), for the tests. */
  state(): FilmScoreState | null;
  /** Renders a stretch of a chapter's sound offline, for the tests: per second, RMS and peak. */
  render(chapter: ChapterId, content: ChapterContent, from: number, to: number): Promise<{ rms: number[]; peak: number[] }>;
  /** Every recording the score plays, fetched and decoded as the film does, for the tests. */
  recordings(): Promise<FilmRecordingCheck[]>;
}

/** Seconds a stopped score keeps its voices and recordings before letting them go (so a quick toggle does not rebuild them). */
const RELEASE_S = 2;

export function createFilmSound(app: App): FilmSound {
  let unlocked = false;
  let score: FilmScore | null = null;
  let loading = false;
  let releaseTimer = 0;

  /** Whether the film's sound is on at all: Sound on, the film (not the explorer), a chapter under way (its cards and loading too). */
  const on = (): boolean => sound.get() && app.experience === 'film' && app.chapter !== null;

  /** The film's level now: full while a chapter plays, softer while exploring its scene, else silent. */
  const level = (): number => {
    if (!on()) return 0;
    if (app.state === 'playing') return 1;
    return app.state === 'explore' ? 0.6 : 0;
  };

  const sync = (): void => {
    const s = score;
    if (!s) return;
    s.setLevel(level());
    if (on()) {
      window.clearTimeout(releaseTimer);
      releaseTimer = 0;
      // While the next chapter loads there is no content yet: the last one's voices wait, silent.
      if (app.content) {
        s.setChapter(app.chapter, app.content);
        s.update(app.time, false);
      }
    } else if (releaseTimer === 0) {
      // Once the film's sound has stopped, let it all go after a moment (unless it comes back first).
      releaseTimer = window.setTimeout(() => {
        releaseTimer = 0;
        if (!on()) s.setChapter(null, null);
      }, RELEASE_S * 1000);
    }
  };

  const ensure = (): void => {
    if (score || loading || !unlocked || level() === 0) {
      sync();
      return;
    }
    loading = true;
    void import('../core/film-score')
      .then(({ createFilmScore }) => {
        const bus = app.audio.bus('scene') as GainNode;
        score = createFilmScore(bus.context, bus);
        sync();
      })
      .finally(() => {
        loading = false;
      });
  };

  /**
   * Starts the browser's audio inside the visitor's gesture (Safari asks for that), or keeps it
   * suspended while the film is paused (the film's play starts it then: src/core/audio.ts).
   */
  const wake = (): void => {
    const context = (app.audio.bus('scene') as GainNode).context as AudioContext;
    void (app.paused ? context.suspend() : context.resume());
  };

  const unlock = (): void => {
    if (unlocked) return;
    unlocked = true;
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    if (sound.get()) wake();
    ensure();
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  app.events.on('state', ensure);
  app.events.on('experience', ensure);
  app.events.on('chapter', ensure);
  app.events.on('time', ({ chapter, t }) => {
    if (!score) return;
    if (chapter !== app.chapter) return;
    // Only the film playing on its own fires a one-shot; a held or paused clock does not move.
    score.update(t, app.state === 'playing' && !app.paused && !app.held);
  });
  app.events.on('seek', ({ t }) => {
    score?.update(t, false);
  });
  // Turned on by a press: still inside that gesture, so the audio may start.
  sound.subscribe((on) => {
    if (on && unlocked) wake();
    ensure();
  });

  return {
    state: () => score?.state() ?? null,
    render: async (chapter, content, from, to) => (await import('../core/film-score')).renderFilmSound(chapter, content, from, to),
    recordings: async () => (await import('../core/film-score')).checkFilmRecordings(),
  };
}
