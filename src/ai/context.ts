/**
 * What the visitor is looking at, read from the app's own state (never guessed): where they are,
 * the chapter and its verses, the explorer's focus, date and clock, the laboratory's bodies. The
 * summary is a few plain English lines (at most 600 characters) for the model's prompt.
 */
import { BODY_IDS, type App, type BodyId, type ChapterId, type FocusId, type UniverseView, type VerseKey } from '../core/types';
import type { AiContext } from './types';

export const SUMMARY_MAX = 600;

const BODY_NAMES: Readonly<Record<BodyId, string>> = {
  sun: 'the Sun',
  mercury: 'Mercury',
  venus: 'Venus',
  earth: 'the Earth',
  moon: 'the Moon',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturn',
  uranus: 'Uranus',
  neptune: 'Neptune',
};

/** A body's plain English name ("the Sun", "Mars"), for prompts and the guide. */
export function bodyName(id: BodyId): string {
  return BODY_NAMES[id];
}

function onSourcesPage(): boolean {
  try {
    return typeof location !== 'undefined' && location.hash.startsWith('#/sources');
  } catch {
    return false;
  }
}

function isoDate(unixMs: number): string {
  const d = new Date(unixMs);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

function distanceText(km: number): string {
  if (km >= 1e7) return `${(km / 1.495978707e8).toFixed(2)} au`;
  return `${Math.round(km).toLocaleString('en')} km`;
}

const isBody = (id: FocusId): id is BodyId => (BODY_IDS as readonly string[]).includes(id);

/** The body the view is around: the focus, or for a small world the body it goes round (its host's, for a moon's moon). */
export function bodyAround(view: UniverseView): BodyId {
  let id: FocusId = view.focus;
  for (let hops = 0; !isBody(id) && hops < 3; hops += 1) {
    const world = view.worlds?.list.find((w) => w.id === id);
    if (!world) break;
    id = world.host;
  }
  return isBody(id) ? id : 'sun';
}

/** The context now. Cheap: reads the app's getters and the explorer's last view. */
export function readContext(app: App): AiContext {
  const view = app.experience === 'universe' ? app.universe() : null;
  const chapter: ChapterId | null = app.experience === 'film' ? app.chapter : null;
  const content = chapter && app.content?.id === chapter ? app.content : null;
  const verses: VerseKey[] = content ? content.panel.text.flatMap((b) => (b.type === 'verse' ? [b.key] : [])) : [];
  const lab = view?.lab ?? null;
  const where: AiContext['where'] = view ? (lab ? 'lab' : 'explorer') : chapter ? 'chapter' : onSourcesPage() ? 'sources' : 'home';

  const explorer: AiContext['explorer'] = view
    ? {
        focus: bodyAround(view),
        world: view.worlds?.focus ? { id: view.worlds.focus.id, name: view.worlds.focus.name } : null,
        distanceKm: view.distanceKm,
        date: isoDate(view.unixMs),
        rate: view.time.rate,
        paused: view.time.paused,
        walking: view.walk ? view.walk.world : null,
        stars: view.neighbourhood !== null,
      }
    : null;
  const labContext: AiContext['lab'] = lab
    ? {
        bodies: lab.bodies.map((b) => ({ id: b.id, name: b.name, massKg: b.massKg, centralId: b.primary, aKm: b.orbit?.aKm ?? null, e: b.orbit?.e ?? null })),
        status: lab.failure ?? (lab.paused ? 'paused' : 'running'),
        days: lab.elapsedS / 86_400,
        events: lab.events.length,
      }
    : null;

  const ctx: Omit<AiContext, 'summary'> = {
    where,
    chapter,
    chapterT: chapter ? app.time : null,
    mode: app.mode,
    explorer,
    lab: labContext,
    verses,
  };
  return { ...ctx, summary: summarise(ctx, app) };
}

/** A few plain lines about the context, at most SUMMARY_MAX characters. */
export function summarise(ctx: Omit<AiContext, 'summary'>, app?: Pick<App, 'i18n'>): string {
  const lines: string[] = [];
  if (ctx.where === 'chapter' && ctx.chapter) {
    const number = Number.parseInt(ctx.chapter.slice(2), 10);
    const titleKey = `timeline.${ctx.chapter}.title`;
    const title = app?.i18n.has(titleKey) ? app.i18n.t(titleKey) : ctx.chapter;
    const at = ctx.chapterT !== null ? `, ${Math.round(ctx.chapterT)} s in` : '';
    lines.push(`Watching Chapter ${number}, "${title}"${at}${ctx.mode === 'explore' ? ', in Explore Mode' : ''}.`);
    if (ctx.verses.length) lines.push(`Verses this chapter shows: ${ctx.verses.join(', ')}.`);
  } else if (ctx.where === 'home') {
    lines.push('On the home screen.');
  } else if (ctx.where === 'sources') {
    lines.push('Reading the Sources page.');
  }
  if (ctx.explorer) {
    const e = ctx.explorer;
    const clock = e.paused ? 'the clock paused' : e.rate === 1 ? 'the clock at real time' : `the clock at ${Math.abs(e.rate).toLocaleString('en')}× ${e.rate < 0 ? 'backwards' : 'speed'}`;
    const near = e.world ? `${e.world.name}, which goes round ${bodyName(e.focus)}` : bodyName(e.focus);
    lines.push(`In the solar-system explorer near ${near}, ${distanceText(e.distanceKm)} from its centre, on ${e.date}, ${clock}.`);
    if (e.walking) lines.push(`Walking on ${bodyName(e.walking)}.`);
    if (e.stars) lines.push('Out among the stars around the Sun.');
  }
  if (ctx.lab) {
    const names = ctx.lab.bodies.slice(0, 10).map((b) => b.name);
    const more = ctx.lab.bodies.length > names.length ? ` and ${ctx.lab.bodies.length - names.length} more` : '';
    lines.push(`In the orbital laboratory (${ctx.lab.status}), ${Math.round(ctx.lab.days)} days integrated, ${ctx.lab.events} collisions. Bodies: ${names.join(', ')}${more}.`);
  }
  let summary = lines.join(' ');
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/u, '')}…`;
  return summary;
}
