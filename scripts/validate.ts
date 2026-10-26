/**
 * npm run validate [-- --online]
 *
 * Offline and deterministic by default: checks the frozen data, content and
 * assets against the pinned sources and the project rules, prints results
 * grouped by rule and exits non-zero on any failure. --online also
 * re-downloads Tanzil and, when QF_CLIENT_ID / QF_CLIENT_SECRET are set,
 * compares every ayah with the Quran Foundation API (never cached to disk).
 */
import { loadContext, type ValidationContext } from './lib/context';
import { Report, type RuleLog } from './lib/report';
import { checkArabicInSrc } from './lib/rules/arabic-in-src';
import { checkAssets } from './lib/rules/assets';
import { checkConstants } from './lib/rules/constants';
import { checkContentVerses } from './lib/rules/content-refs';
import { checkCues } from './lib/rules/cues';
import { checkFilm } from './lib/rules/film';
import { checkHadith } from './lib/rules/hadith';
import { checkI18n } from './lib/rules/i18n';
import { checkOnline } from './lib/rules/online';
import { checkScripture } from './lib/rules/scripture';
import { checkSources } from './lib/rules/sources';

type Rule = (ctx: ValidationContext, log: RuleLog) => void | Promise<void>;

const RULES: ReadonlyArray<readonly [string, string, Rule]> = [
  ['a', 'Scripture: pinned Tanzil files and data/quran.json', checkScripture],
  ['b', 'Online: Tanzil re-download and Quran Foundation API', checkOnline],
  ['c', 'Content verse references', checkContentVerses],
  ['d', 'Hadith records', checkHadith],
  ['e', 'Science constants', checkConstants],
  ['f', 'Sources and disclaimer', checkSources],
  ['g', 'i18n messages', checkI18n],
  ['h', 'Cue timing', checkCues],
  ['i', 'No Arabic script in src/', checkArabicInSrc],
  ['j', 'Generated assets', checkAssets],
  ['k', 'Film: shot list and screenplay', checkFilm],
];

function parseArgs(args: readonly string[]): { online: boolean } {
  for (const arg of args) if (arg !== '--online') throw new Error(`Unknown argument ${arg}. Usage: validate [--online]`);
  return { online: args.includes('--online') };
}

async function main(): Promise<void> {
  const { online } = parseArgs(process.argv.slice(2));
  const ctx = loadContext(online);
  const report = new Report();
  for (const [id, title, rule] of RULES) {
    const log = report.rule(id, title);
    try {
      await rule(ctx, log);
    } catch (err) {
      log.fail(`rule crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.print();
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
