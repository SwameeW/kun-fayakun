/** Rule g: message files parse, do not collide, contain every referenced key and avoid forbidden phrasing. */
import type { ValidationContext } from '../context';
import { messageArguments, messageParseError, type MessageFile, type MessageLoad } from '../i18n';
import type { RuleLog } from '../report';

/**
 * Spec principle 1: reflection, not proof. Whole words, case-insensitive, so
 * "improves" does not match "proves". The disclaimer itself is exempt.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['predicted', /\bpredicted\b/i],
  ['foretold', /\bforetold\b/i],
  ['scientific miracle', /\bscientific\s+miracles?\b/i],
  ['proves', /\bproves\b/i],
  ['proof that', /\bproof\s+that\b/i],
  ['confirms the quran', /\bconfirms\s+the\s+qur'?an\b/i],
];

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
  const lab = available(ctx.i18n.lab, 'explorer builder', log);
  const islamic = available(ctx.i18n.islamic, 'explorer builder', log);
  const stars = available(ctx.i18n.stars, 'explorer builder', log);
  const photo = available(ctx.i18n.photo, 'explorer builder', log);
  const files = [en, chapters, explore, lab, islamic, stars, photo].filter((f): f is MessageFile => f !== null);
  const ar = ctx.i18n.ar.status === 'ok' ? ctx.i18n.ar.file : null;

  const parseIssues = [...files.flatMap((f) => fileProblems(f, true)), ...(ar ? fileProblems(ar, false) : [])];
  const messageCount = files.reduce((n, f) => n + f.messages.size, 0);
  log.expectNone(parseIssues, `${messageCount} English message(s) parse with intl-messageformat and avoid forbidden phrasing`);

  const collisions = files.flatMap((a, i) => files.slice(i + 1).flatMap((b) => [...a.messages.keys()].filter((k) => !k.startsWith('$') && b.messages.has(k)).map((k) => `${k}: defined in both ${a.path} and ${b.path}`)));
  log.expectNone(collisions, 'no key is defined in more than one of en.json, en.chapters.json, en.explore.json, en.lab.json, en.islamic.json, en.stars.json and en.photo.json');

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
