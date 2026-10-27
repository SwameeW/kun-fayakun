import type { App, BodyId, ChapterId } from '../../core/types';
import type { JsonSchema, ToolDefinition, ToolEnv } from '../types';
import { done, ensureMessages, failed, notConfirmed, num, problem, refused, say, str, waitFor } from './shared';

/**
 * The film: open a chapter (at a time), play, pause, the next or previous chapter, Explore Mode and
 * back, and a moment of Explore Mode's dock (src/ui/discover-dock.ts: the scene as it is at the
 * moment's model time, seen from where the film's camera stands then). Each is undone by putting the
 * film back where it was: its chapter, time, pause and mode (or the home screen, or the explorer).
 */

const CHAPTERS = ['ch00', 'ch01', 'ch02', 'ch03', 'ch04', 'ch05', 'ch06', 'ch07', 'ch08', 'ch09', 'ch10'] as const satisfies readonly ChapterId[];

/** How long a chapter may take to load and start (its code, its assets, the first frame). */
const CHAPTER_MS = 20_000;
const QUICK_MS = 3000;

interface FilmState {
  experience: App['experience'];
  chapter: ChapterId | null;
  time: number;
  paused: boolean;
  mode: App['mode'];
  exploreTime: number | null;
  focus: BodyId | null;
}

function filmState(app: App): FilmState {
  return { experience: app.experience, chapter: app.chapter, time: app.time, paused: app.paused, mode: app.mode, exploreTime: app.exploreTime, focus: app.universe()?.focus ?? null };
}

/** Puts the film back as it was: the chapter and time (paused if it was), its mode; or home; or the explorer on its world. */
async function restoreFilm(app: App, s: FilmState): Promise<void> {
  if (s.experience === 'universe') {
    app.openUniverse(s.focus);
    return;
  }
  if (s.chapter === null) {
    app.home();
    return;
  }
  if (app.chapter !== s.chapter || Math.abs(app.time - s.time) > 0.5) await app.goTo(s.chapter, s.time);
  if (s.paused) app.pause();
  else app.play();
  if (app.mode !== s.mode) app.setMode(s.mode);
  if (s.mode === 'explore') app.setExploreTime(s.exploreTime);
}

const chapterTitle = (env: ToolEnv, id: ChapterId): string => {
  const meta = env.app.chapters.find((c) => c.id === id);
  return meta && env.i18n.has(meta.titleKey) ? env.i18n.t(meta.titleKey) : id;
};

export const filmOpen: ToolDefinition = {
  name: 'film.open',
  kind: 'view',
  summary: 'Open a chapter of the film (ch00 to ch10), optionally at a time in seconds.',
  keywords: ['chapter', 'film', 'watch', 'play chapter', 'open chapter', 'go to chapter', 'big bang', 'beginning', 'story'],
  args: {
    type: 'object',
    properties: {
      chapter: { type: 'string', enum: CHAPTERS, description: 'Chapter id, ch00 to ch10' },
      t: { type: 'number', minimum: 0, maximum: 3600, description: 'Seconds into the chapter' },
    },
    required: ['chapter'],
    additionalProperties: false,
  },
  available: () => true,
  preview(args, _ctx, i18n) {
    const t = num(args, 't');
    return say(i18n, 'ai.tool.film.open.preview', { chapter: str(args, 'chapter') ?? '', at: t === undefined ? 0 : 1, t: t ?? 0 });
  },
  async run(args, env) {
    ensureMessages(env.i18n);
    const chapter = str(args, 'chapter') as ChapterId;
    const meta = env.app.chapters.find((c) => c.id === chapter);
    if (!meta?.load) return refused(problem('chapter', 'ai.tool.film.notBuilt', { chapter }));
    const before = filmState(env.app);
    const t = num(args, 't');
    try {
      await env.app.goTo(chapter, t);
    } catch (err) {
      return failed(err);
    }
    const seen = await waitFor(env, () => env.app.chapter === chapter && env.app.state !== 'loading', CHAPTER_MS);
    const values = { chapter: chapterTitle(env, chapter), t: Math.round(env.app.time) };
    const undo = () => restoreFilm(env.app, before);
    return seen ? done('ai.tool.film.open.observed', values, { undo }) : notConfirmed('ai.tool.film.open.notSeen', values, { undo });
  },
};

const ACTIONS = ['play', 'pause', 'next', 'previous', 'explore', 'film'] as const;
type FilmAction = (typeof ACTIONS)[number];

export const filmControl: ToolDefinition = {
  name: 'film.control',
  kind: 'view',
  summary: 'Play or pause the film, go to the next or previous chapter, or switch Explore Mode on (explore) or off (film).',
  keywords: ['play', 'pause', 'resume', 'stop', 'next chapter', 'previous chapter', 'explore mode', 'look around', 'free look'],
  args: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS } }, required: ['action'], additionalProperties: false },
  available: (ctx) => ctx.where === 'chapter',
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.film.control.preview', { action: str(args, 'action') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const app = env.app;
    const action = str(args, 'action') as FilmAction;
    const before = filmState(app);
    let holds: () => boolean;
    switch (action) {
      case 'play':
        app.play();
        holds = () => !app.paused;
        break;
      case 'pause':
        app.pause();
        holds = () => app.paused;
        break;
      case 'next':
        app.next();
        holds = () => app.chapter !== before.chapter;
        break;
      case 'previous':
        app.prev();
        holds = () => app.chapter !== before.chapter;
        break;
      case 'explore':
        app.setMode('explore');
        holds = () => app.mode === 'explore';
        break;
      case 'film':
        app.setMode('cinematic');
        holds = () => app.mode === 'cinematic';
        break;
    }
    const seen = await waitFor(env, holds, action === 'next' || action === 'previous' ? CHAPTER_MS : QUICK_MS);
    const values = { action, chapter: app.chapter ? chapterTitle(env, app.chapter) : '', paused: app.paused ? 1 : 0 };
    const undo = () => restoreFilm(app, before);
    return seen ? done('ai.tool.film.control.observed', values, { undo }) : notConfirmed('ai.tool.film.control.notSeen', values, { undo });
  },
};

const filmMomentArgs: JsonSchema = { type: 'object', properties: { point: { type: 'string', maxLength: 48, pattern: '^[a-z0-9-]{1,48}$', description: "A moment's id in this chapter" } }, required: ['point'], additionalProperties: false };

export const filmMoment: ToolDefinition = {
  name: 'film.moment',
  kind: 'view',
  summary: "Show one of this chapter's Explore Mode moments (by its id) in Explore Mode.",
  keywords: ['moment', 'show me', 'when', 'explore point', 'discover'],
  args: filmMomentArgs,
  // A model is offered this chapter's own moments by id; "Show the orrery" had nothing to pick from.
  argsFor: (ctx) =>
    ctx.moments?.length
      ? { type: 'object', properties: { point: { type: 'string', enum: ctx.moments.map((m) => m.id), description: `One of this chapter's moments: ${ctx.moments.map((m) => `${m.id} (${m.title})`).join(', ')}` } }, required: ['point'], additionalProperties: false }
      : filmMomentArgs,
  available: (ctx) => ctx.where === 'chapter',
  preview: (args, _ctx, i18n) => say(i18n, 'ai.tool.film.moment.preview', { point: str(args, 'point') ?? '' }),
  async run(args, env) {
    ensureMessages(env.i18n);
    const app = env.app;
    const id = str(args, 'point') ?? '';
    const points = app.content?.explore.points ?? [];
    const point = points.find((p) => p.id === id);
    if (!point) return refused(problem('point', 'ai.tool.film.moment.unknown', { allowed: points.map((p) => p.id).join(', ') || '-' }));
    const before = filmState(app);
    if (app.mode !== 'explore') app.setMode('explore');
    const inMode = await waitFor(env, () => app.mode === 'explore', QUICK_MS);
    if (inMode) {
      app.setExploreTime(point.t);
      app.focusView(point.t);
    }
    const seen = inMode && (await waitFor(env, () => app.exploreTime === point.t, QUICK_MS));
    const title = env.i18n.has(point.titleKey) ? env.i18n.t(point.titleKey) : point.id;
    const undo = async (): Promise<void> => {
      if (before.mode === 'explore') {
        app.setExploreTime(before.exploreTime);
        app.focusView(before.exploreTime);
      } else {
        app.setMode(before.mode);
      }
      await Promise.resolve();
    };
    const values = { title, t: point.t, kind: point.kind };
    return seen ? done('ai.tool.film.moment.observed', values, { undo }) : notConfirmed('ai.tool.film.moment.notSeen', values, { undo });
  },
};

export const FILM_TOOLS: readonly ToolDefinition[] = [filmOpen, filmControl, filmMoment];
