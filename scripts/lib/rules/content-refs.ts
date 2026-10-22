/** Rule c: every verse key used by a content.json is in quran.json and in the Tanzil source's verseKeys. */
import { M1_CHAPTERS, type ValidationContext } from '../context';
import type { RuleLog } from '../report';

export function checkContentVerses(ctx: ValidationContext, log: RuleLog): void {
  for (const id of M1_CHAPTERS) {
    const exists =
      ctx.content.chapters.some((c) => c.dir === id) || ctx.content.invalid.some((c) => c.path.includes(`/${id}/`));
    if (!exists) log.fail(`src/chapters/${id}/content.json is missing (owner: content builder)`);
  }
  for (const invalid of ctx.content.invalid) {
    for (const problem of invalid.problems) log.fail(`${problem} (content.json shape; chapter skipped by rules c-h)`);
  }
  if (ctx.refs.length === 0) {
    log.skip('no readable content.json files to check');
    return;
  }

  const quranKeys = new Set<string>(ctx.quran.status === 'ok' ? ctx.quran.value.ayat.map((a) => a.key) : []);
  const tanzil = ctx.sources.status === 'ok' ? ctx.sources.value.sources.find((s) => s.id === 'tanzil-uthmani') : undefined;
  const sourceKeys = new Set<string>(tanzil?.verseKeys ?? []);
  if (ctx.quran.status !== 'ok') log.fail('data/quran.json unavailable (see rule a)');
  if (!tanzil) log.fail('data/sources.json has no tanzil-uthmani entry (see rule f)');

  const problems: string[] = [];
  let count = 0;
  for (const { refs } of ctx.refs) {
    for (const ref of refs.verses) {
      count += 1;
      if (!quranKeys.has(ref.value)) problems.push(`${ref.where}: verse ${ref.value} is not in data/quran.json`);
      if (!sourceKeys.has(ref.value)) problems.push(`${ref.where}: verse ${ref.value} is not in tanzil-uthmani verseKeys (data/sources.json)`);
    }
  }
  log.expectNone(problems, `${count} verse reference(s) in ${ctx.refs.length} chapter(s) resolve to quran.json and sources.json`);
}
