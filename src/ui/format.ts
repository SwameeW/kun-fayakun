import type {
  ConstantId,
  ConstantValueRef,
  DataStore,
  I18n,
  ProseBlock,
  ScienceConstant,
  SourceEntry,
  SourceId,
} from '../core/types';
import { h, srOnly } from './dom';

/** "m:ss" for chapter clocks. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** Reads one field of a constant; null when the constant has no such uncertainty. */
export function constantField(c: ScienceConstant, field: ConstantValueRef['field']): number | null {
  if (field === 'value') return c.value;
  const u = c.uncertainty;
  if (u === null) return null;
  if (typeof u === 'number') return u;
  if (field === 'plus') return u.plus;
  if (field === 'minus') return u.minus;
  return Math.max(u.plus, u.minus);
}

/** Looks up a constant without throwing; the DataStore throws for unknown ids. */
export function tryConstant(data: DataStore, id: ConstantId): ScienceConstant | null {
  try {
    return data.constant(id);
  } catch {
    return null;
  }
}

/** Formats a ConstantValueRef for injection into an ICU message. */
export function formatValueRef(ref: ConstantValueRef, data: DataStore, i18n: I18n): string {
  const constant = tryConstant(data, ref.constant);
  const raw = constant ? constantField(constant, ref.field) : null;
  if (raw === null) {
    console.warn(`ui: constant "${ref.constant}" has no ${ref.field}`);
    return i18n.t('ui.value.unavailable');
  }
  return i18n.number(raw / (ref.scale ?? 1), ref.digits ?? 3);
}

/** Resolves a prose block to text, with constant values formatted by i18n.number. */
export function formatProse(block: ProseBlock, data: DataStore, i18n: I18n): string {
  const values: Record<string, string> = {};
  for (const [name, ref] of Object.entries(block.values ?? {})) {
    values[name] = formatValueRef(ref, data, i18n);
  }
  return i18n.t(block.key, values);
}

/** Value with its uncertainty, e.g. "13.787 ± 0.02". */
export function formatConstant(c: ScienceConstant, i18n: I18n, digits = 4): string {
  const value = i18n.number(c.value, digits);
  const u = c.uncertainty;
  if (u === null) return value;
  if (typeof u === 'number') return i18n.t('ui.value.withUncertainty', { value, uncertainty: i18n.number(u, digits) });
  return i18n.t('ui.value.asymmetric', { value, plus: i18n.number(u.plus, digits), minus: i18n.number(u.minus, digits) });
}

const SUPERSCRIPT_MINUS = '−';

/**
 * Scientific notation for very small ratios (e.g. deuterium/hydrogen).
 * The visual form uses <sup>; screen readers get a spoken form instead.
 */
export function scientificNode(value: number, i18n: I18n, digits = 2): HTMLElement {
  if (value === 0 || (Math.abs(value) >= 1e-3 && Math.abs(value) < 1e6)) {
    return h('span', {}, i18n.number(value, digits + 2));
  }
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = i18n.number(value / 10 ** exponent, digits);
  const exponentText = exponent < 0 ? `${SUPERSCRIPT_MINUS}${Math.abs(exponent)}` : String(exponent);
  return h(
    'span',
    { class: 'kf-sci' },
    h('span', { 'aria-hidden': 'true' }, `${mantissa} × 10`, h('sup', {}, exponentText)),
    srOnly(i18n.t('ui.value.scientificSpoken', { mantissa, exponent })),
  );
}

export interface Citation {
  text: string;
  url: string | null;
}

/** Resolves a cite id: a source id from sources.json, or a constant id whose citation is used. */
export function resolveCitation(id: SourceId, data: DataStore): Citation | null {
  const source = findSource(data, id);
  if (source) return { text: source.credit || source.title, url: source.url || null };
  const constant = tryConstant(data, id);
  if (constant) return { text: constant.citation.text, url: constant.citation.url || null };
  console.warn(`ui: unknown citation id "${id}"`);
  return null;
}

export function findSource(data: DataStore, id: SourceId): SourceEntry | null {
  try {
    return data.sources().sources.find((s) => s.id === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * Every citation for a prose block: its explicit cites, then the constants its
 * values use, without repeating a reference several constants share.
 */
export function blockCitations(block: ProseBlock, data: DataStore): Citation[] {
  const ids = [...(block.cite ?? []), ...Object.values(block.values ?? {}).map((ref) => ref.constant)];
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const id of ids) {
    const citation = resolveCitation(id, data);
    if (!citation) continue;
    const key = `${citation.text}|${citation.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}
