import type { FilmScore, FilmScoreState } from '../core/film-score';
import type { App, ChapterContent, ChapterId } from '../core/types';
import { sound } from './sound-preference';

/**
 * When the film's sound plays (the sound itself is ../core/film-score, its own chunk, loaded the
 * first time a chapter plays with sound on). It plays while a chapter plays, softer while the visitor
 * explores the chapter's scene, and not at all on the loading, title and closing screens or while the
 * solar-system explorer is open (that has its own wind). Browsers let sound begin only once the
 * visitor has touched the page, so it waits for that. A pause suspends it with the film
 * (src/core/audio.ts); a seek never sets off a one-shot.
 */
export interface FilmSound {
  /** What plays now (null before the score has loaded), for the tests. */
  state(): FilmScoreState | null;
  /** Renders a stretch of a chapter's sound offline, for the tests: per second, RMS and peak. */
  render(chapter: ChapterId, content: ChapterContent, from: number, to: number): Promise<{ rms: number[]; peak: number[] }>;
}

/** Seconds a silent score keeps its voices before letting them go (so a quick toggle does not rebuild them). */
const RELEASE_S = 2;

export function createFilmSound(app: App): FilmSound {
  let unlocked = false;
  let score: FilmScore | null = null;
  let loading = false;
  let releaseTimer = 0;

  /** The film's level now: full while a chapter plays, softer while exploring its scene, else silent. */
  const level = (): number => {
    if (!sound.get() || app.experience !== 'film' || app.chapter === null) return 0;
    if (app.state === 'playing') return 1;
    return app.state === 'explore' ? 0.6 : 0;
  };

  const sync = (): void => {
    const s = score;
    if (!s) return;
    const target = level();
    s.setLevel(target);
    if (target > 0) {
      window.clearTimeout(releaseTimer);
      releaseTimer = 0;
      s.setChapter(app.chapter, app.content);
      s.update(app.time, false);
    } else if (releaseTimer === 0) {
      // Once silent, let the voices go after a moment (unless sound comes back first).
      releaseTimer = window.setTimeout(() => {
        releaseTimer = 0;
        if (level() === 0) s.setChapter(null, null);
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
  };
}
