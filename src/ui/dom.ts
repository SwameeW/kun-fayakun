/** Attribute values: `true` sets an empty attribute; false/null/undefined omit it. */
export type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type Child = Node | string | null | undefined | false;

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
}

function append(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
}

/** Creates an HTML element with attributes and children. Text children are inserted as text, never parsed. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** An external link that opens in a new tab without leaking the opener. */
export function externalLink(href: string, text: string, attrs: Attrs = {}): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...attrs }, text);
}

/** Keyboard focus is nowhere useful: on the page itself, or on something no longer shown (the control that had it was hidden). */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !(active instanceof HTMLElement) || active === document.body || active.closest('[hidden]') !== null || active.getClientRects().length === 0;
}

/** Text hidden visually but read by screen readers. */
export function srOnly(text: string): HTMLSpanElement {
  return h('span', { class: 'kf-sr-only' }, text);
}

let idCounter = 0;
export function uniqueId(prefix: string): string {
  idCounter += 1;
  return `kf-${prefix}-${idCounter}`;
}

/** True for elements whose native activation key includes Space (buttons, links, summaries). */
export function handlesSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"]') !== null;
}

/** Commits an element's current styles so a following class change transitions from them. */
export function commitStyles(el: Element): void {
  el.getBoundingClientRect();
}
