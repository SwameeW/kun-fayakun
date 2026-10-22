/** Rule e: every science constant is complete and cited; every ConstantValueRef and cite id in content resolves. */
import type { ScienceConstant } from '../../../src/core/types';
import { unavailable, type ValidationContext } from '../context';
import type { RuleLog } from '../report';
import { checkFields, duplicates, isRecord } from '../shape';

/** Constant ids the UI relies on (docs/CONTRACTS.md). */
const REQUIRED_CONSTANTS = [
  'universe.age',
  'cmb.temperature',
  'recombination.redshift',
  'recombination.age',
  'recombination.temperature',
  'bbn.hydrogen.massFraction',
  'bbn.helium.massFraction',
  'bbn.helium.numberFraction',
  'bbn.deuterium.ratio',
  'bbn.lithium7.ratio',
];

const VALUE_FIELDS = new Set(['value', 'uncertainty', 'plus', 'minus']);

function uncertaintyProblem(u: unknown): string | null {
  if (u === null || (typeof u === 'number' && Number.isFinite(u) && u >= 0)) return null;
  if (isRecord(u) && typeof u.plus === 'number' && typeof u.minus === 'number' && u.plus >= 0 && u.minus >= 0) return null;
  return 'uncertainty must be null, a non-negative number or { plus, minus }';
}

function constantProblems(entry: unknown, index: number): string[] {
  const label = `constants[${index}]${isRecord(entry) && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
  const problems = checkFields(
    entry,
    {
      id: 'nonempty',
      description: 'string',
      value: 'number',
      unit: 'string',
      qualifier: 'string|null',
      citation: 'object',
      'citation.text': 'nonempty',
      'citation.url': 'nonempty',
      'citation.accessed': 'nonempty',
    },
    label,
  );
  if (!isRecord(entry)) return problems;
  const uncertainty = uncertaintyProblem(entry.uncertainty);
  if (uncertainty) problems.push(`${label}: ${uncertainty}`);
  const qualifier = typeof entry.qualifier === 'string' ? entry.qualifier.trim() : '';
  if (entry.uncertainty === null && !qualifier) problems.push(`${label}: uncertainty is null, so qualifier must explain why`);
  const url = isRecord(entry.citation) ? entry.citation.url : undefined;
  if (typeof url === 'string' && !/^https?:\/\//.test(url)) problems.push(`${label}: citation.url must be an http(s) URL`);
  return problems;
}

export function checkConstants(ctx: ValidationContext, log: RuleLog): void {
  const missing = unavailable(ctx.constants, 'content builder');
  if (missing || ctx.constants.status !== 'ok') {
    log.fail(missing ?? 'data/constants.json unavailable');
    return;
  }
  const raw: unknown = ctx.constants.value;
  if (!isRecord(raw) || !Array.isArray(raw.constants)) {
    log.fail('data/constants.json: "constants" must be an array');
    return;
  }
  const entries: unknown[] = ctx.constants.value.constants;
  log.expectNone(
    entries.flatMap((e, i) => constantProblems(e, i)),
    `${entries.length} constant(s) have value, unit, citation text and URL, and an uncertainty or a qualifier`,
  );

  const constants = entries.filter((e): e is ScienceConstant => isRecord(e) && typeof e.id === 'string');
  const byId = new Map(constants.map((c) => [c.id, c]));
  log.expectNone(
    [
      ...duplicates(constants.map((c) => c.id)).map((id) => `duplicate constant id ${id}`),
      ...REQUIRED_CONSTANTS.filter((id) => !byId.has(id)).map((id) => `required constant ${id} is missing (docs/CONTRACTS.md)`),
    ],
    `all ${REQUIRED_CONSTANTS.length} constants required by the UI exist`,
  );

  const refIssues: string[] = [];
  let refCount = 0;
  for (const { refs } of ctx.refs) {
    for (const ref of refs.constants) {
      refCount += 1;
      const constant = byId.get(ref.value);
      if (!constant) refIssues.push(`${ref.where}: constant "${ref.value}" is not in data/constants.json`);
      else if (!VALUE_FIELDS.has(ref.field)) refIssues.push(`${ref.where}: field "${ref.field}" must be value, uncertainty, plus or minus`);
      else if (ref.field !== 'value' && constant.uncertainty === null) refIssues.push(`${ref.where}: ${ref.value} has no uncertainty to show`);
    }
  }
  log.expectNone(refIssues, `${refCount} ConstantValueRef(s) in content resolve`);

  const sourceIds = new Set(ctx.sources.status === 'ok' ? ctx.sources.value.sources.map((s) => s.id) : []);
  const citeIssues = ctx.refs.flatMap(({ refs }) =>
    refs.cites.filter((c) => !byId.has(c.value) && !sourceIds.has(c.value)).map((c) => `${c.where}: "${c.value}" is neither a source id nor a constant id`),
  );
  const citeCount = ctx.refs.reduce((n, { refs }) => n + refs.cites.length, 0);
  log.expectNone(citeIssues, `${citeCount} cite id(s) in content resolve to sources.json or constants.json`);
}
