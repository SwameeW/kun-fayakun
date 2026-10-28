/** Rule g: message files parse, do not collide, contain every referenced key and avoid forbidden phrasing. */
import type { ValidationContext } from '../context';
import { messageArguments, messageParseError, type MessageFile, type MessageLoad } from '../i18n';
import type { RuleLog } from '../report';
import { BANNED_PHRASES } from '../../../src/core/phrasing';

/**
 * Spec principle 1: reflection, not proof. The patterns are shared with the assistant's output
 * guards (src/core/phrasing.ts). The disclaimer itself is exempt.
 */
const FORBIDDEN = BANNED_PHRASES;

const EXEMPT_FROM_PHRASING = new Set(['ui.disclaimer']);

function available(load: MessageLoad, owner: string, log: RuleLog): MessageFile | null {
  if (load.status === 'missing') {
    log.fail(`${load.path} is missing (owner: ${owner})`);
    return null;
  }
  for (const problem of load.file.problems) log.fail(`${load.file.path}: ${problem} (owner: ${owner})`);
  return load.file;
}

function fileProblems(file: MessageFile, checkPhrasing: boolean): string[] {
  const problems: string[] = [];
  for (const [key, message] of file.messages) {
    const error = messageParseError(message);
    if (error) problems.push(`${file.path} ${key}: ICU parse error: ${error}`);
    // "$"-prefixed keys are maintainer notes ("$comment"); they may quote the forbidden words.
    if (!checkPhrasing || EXEMPT_FROM_PHRASING.has(key) || key.startsWith('$')) continue;
    for (const [phrase, pattern] of FORBIDDEN) {
      if (pattern.test(message)) problems.push(`${file.path} ${key}: forbidden phrasing "${phrase}"`);
    }
  }
  return problems;
}

export function checkI18n(ctx: ValidationContext, log: RuleLog): void {
  const en = available(ctx.i18n.en, 'ui builder', log);
  const chapters = available(ctx.i18n.chapters, 'content builder', log);
  const explore = available(ctx.i18n.explore, 'explorer builder', log);
  const living = available(ctx.i18n.living, 'explorer builder', log);
  const lab = available(ctx.i18n.lab, 'explorer builder', log);
  const islamic = available(ctx.i18n.islamic, 'explorer builder', log);
  const stars = available(ctx.i18n.stars, 'explorer builder', log);
  const worlds = available(ctx.i18n.worlds, 'explorer builder', log);
  const photo = available(ctx.i18n.photo, 'explorer builder', log);
  const help = available(ctx.i18n.help, 'explorer builder', log);
  const plain = available(ctx.i18n.plain, 'content builder', log);
  const discover = available(ctx.i18n.discover, 'content builder', log);
  const aiEngine = available(ctx.i18n.aiEngine, 'engines builder', log);
  const aiTools = available(ctx.i18n.aiTools, 'assistant builder', log);
  const aiMind = available(ctx.i18n.aiMind, 'assistant builder', log);
  const aiUi = available(ctx.i18n.aiUi, 'assistant interface builder', log);
  const files = [en, chapters, explore, living, lab, islamic, stars, worlds, photo, help, plain, discover, aiEngine, aiTools, aiMind, aiUi].filter((f): f is MessageFile => f !== null);
  const ar = ctx.i18n.ar.status === 'ok' ? ctx.i18n.ar.file : null;

  const parseIssues = [...files.flatMap((f) => fileProblems(f, true)), ...(ar ? fileProblems(ar, false) : [])];
  const messageCount = files.reduce((n, f) => n + f.messages.size, 0);
  log.expectNone(parseIssues, `${messageCount} English message(s) parse with intl-messageformat and avoid forbidden phrasing`);

  const collisions = files.flatMap((a, i) => files.slice(i + 1).flatMap((b) => [...a.messages.keys()].filter((k) => !k.startsWith('$') && b.messages.has(k)).map((k) => `${k}: defined in both ${a.path} and ${b.path}`)));
  log.expectNone(collisions, 'no key is defined in more than one of en.json, en.chapters.json, en.explore.json, en.living.json, en.lab.json, en.islamic.json, en.stars.json, en.worlds.json, en.photo.json, en.help.json, en.plain.json, en.discover.json, en.ai.engine.json, en.ai.tools.json, en.ai.mind.json and en.ai.json');

  const merged = new Map<string, string>();
  for (const f of files) for (const [k, v] of f.messages) merged.set(k, v);
  const missing: string[] = [];
  const argumentIssues: string[] = [];
  let refCount = 0;
  for (const { chapter, refs } of ctx.refs) {
    for (const ref of refs.i18n) {
      refCount += 1;
      if (!merged.has(ref.value)) missing.push(`${ref.where}: i18n key "${ref.value}" is not defined`);
    }
    const blocks = [
      ...chapter.content.panel.scholarly.classical,
      ...chapter.content.panel.scholarly.modern,
      ...chapter.content.panel.science,
      ...chapter.content.panel.openQuestions,
      ...(chapter.content.explore.points ?? []).map((point) => point.text),
    ];
    for (const block of blocks) {
      const message = merged.get(block.key);
      if (message === undefined || messageParseError(message)) continue;
      const provided = new Set(Object.keys(block.values ?? {}));
      for (const name of messageArguments(message)) {
        if (!provided.has(name)) argumentIssues.push(`${chapter.dir} ${block.key}: message expects {${name}} but the block provides no such value`);
      }
    }
  }
  log.expectNone(missing, `${refCount} i18n key reference(s) in content are defined`);
  log.expectNone(argumentIssues, 'every ICU argument used by a prose block is supplied by its values');
}
