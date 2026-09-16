/**
 * Shared DOM helpers for the in-page inspector. Browser-only: no Node imports.
 */
import type { SelectorCandidate } from '@scrappia/core';

export const OVERLAY_ATTR = 'data-scrappia-overlay';

// ---------- class-name classification ----------

const GENERATED_CLASS_RES: RegExp[] = [
  /^css-/i, // emotion / styled-jsx
  /^sc-/i, // styled-components
  /^_/, // css-modules / minified
  /^[a-z]+-[0-9a-f]{5,}$/i, // prefix-hash
  /^[a-z][a-z0-9]*_[a-z0-9]+__?[0-9a-z]{5,}$/i, // css-modules: styles_title__3xK2z
  /^jsx-\d+/, // styled-jsx
  /^svelte-[a-z0-9]+$/i,
  /^ng-(tns|star|trigger|animat|c\d)/, // angular
  /^(is-|has-|js-)/, // state / hook classes
  /^(active|selected|hover|hovered|focus|focused|open|opened|visible|hidden|show|shown|collapsed|expanded|disabled|checked|loading|loaded|lazyloaded|lazyload|current|ng-scope)$/i,
  /[0-9a-f]{8,}/i, // long hex anywhere
];

const UTILITY_PREFIXES =
  '(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|w|h|min-w|min-h|max-w|max-h|gap|space|text|bg|border|rounded|flex|grid|items|justify|content|font|leading|tracking|shadow|opacity|z|top|left|right|bottom|inset|overflow|col|row|order|self|place|object|transition|duration|ease|scale|rotate|translate|cursor|select|pointer|sr|block|inline|absolute|relative|fixed|sticky|static|truncate|uppercase|lowercase|capitalize|underline|italic|whitespace|break|divide|ring|outline|fill|stroke|animate|d|float|align|clearfix|container|container-fluid|mw|vw|vh|g|gx|gy|fs|fw|lh|hstack|vstack|visually-hidden|justify-content|align-items|flex-wrap|flex-row|flex-column|position|display|invisible|rounded-circle|rounded-pill|border-top|border-bottom|border-start|border-end)';
const UTILITY_RE = new RegExp(`^(?:-?(?:[a-z0-9]+:)*)-?${UTILITY_PREFIXES}(?:-(?:[a-z0-9]+|\\[[^\\]]+\\]|\\d+(?:\\.\\d+)?(?:/\\d+)?|\\d+%))*$`, 'i');
const UTILITY_MISC_RE = /[:\[\]/!]|^(?:col|row|clearfix|container|hidden|block|inline|flex|grid|relative|absolute|fixed|sticky|truncate|italic|underline|uppercase|lowercase|capitalize|invisible|visible|d-\w+|xs|sm|md|lg|xl|xxl)$/i;

/** Classes that should never be used in selectors (hashed, generated or transient state). */
export function isGeneratedClass(name: string): boolean {
  if (!name) return true;
  if (GENERATED_CLASS_RES.some((re) => re.test(name))) return true;
  // 6+ alnum chars without vowels => probably a hash
  if (/^[A-Za-z0-9]{6,}$/.test(name) && !/[aeiouy]/i.test(name)) return true;
  // mixed digit/letter soup
  if (/\d{2,}/.test(name) && /[a-z]/i.test(name) && !/[-_]/.test(name) && name.length >= 6) return true;
  return false;
}

/** Layout utility classes (tailwind / bootstrap): allowed as a last resort, useless for naming. */
export function isUtilityClass(name: string): boolean {
  return UTILITY_RE.test(name) || UTILITY_MISC_RE.test(name);
}

/** Class names usable in selectors and for naming. */
export function isStableClass(name: string): boolean {
  return !isGeneratedClass(name) && !isUtilityClass(name);
}

export function stableClasses(el: Element): string[] {
  const out: string[] = [];
  const list = el.classList ? Array.from(el.classList) : [];
  for (const c of list) if (isStableClass(c)) out.push(c);
  return out;
}

export function allSafeClasses(el: Element): string[] {
  const list = el.classList ? Array.from(el.classList) : [];
  return list.filter((c) => !isGeneratedClass(c));
}

// ---------- attributes ----------

export const SEMANTIC_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-id', 'itemprop', 'name', 'aria-label', 'role'];

const FRAMEWORK_DATA_ATTR_RE = /^data-(react|reactid|reactroot|v-|ng-|emotion|styled|radix|headlessui|state|hydrat|server|ssr|component-id|svelte|astro|turbo|hk|nextjs|__|lazy|src|srcset|original|bind|ref|id-|s-|w-|framer|aos|toggle|target|bs-|slick|swiper|owl|test-state|testid-)/;

/** Attributes that make good selector anchors: the allow-list plus stable-looking data-* attributes. */
export function isSemanticAttr(name: string, value: string | null): boolean {
  if (value == null || !value.length || value.length > 80 || /[\n\r]/.test(value)) return false;
  if (SEMANTIC_ATTRS.includes(name)) return true;
  if (!name.startsWith('data-')) return false;
  if (FRAMEWORK_DATA_ATTR_RE.test(name)) return false;
  if (/^[0-9a-f]{8,}$/i.test(value) || /^\{|^\[/.test(value)) return false;
  return true;
}

export function isStableId(id: string): boolean {
  if (!id) return false;
  if (/^[0-9]/.test(id)) return false; // starts with digit -> escaping headaches, often generated
  if (/^(ember|react|radix|headlessui|mui|:r|__|_|yui_|ext-|gwt-|uid|id)[\d:_-]/i.test(id)) return false;
  if (/^[a-z]*[-_:]?\d{3,}$/i.test(id)) return false; // foo-1234
  if (/[0-9a-f]{8,}/i.test(id)) return false;
  if (/^[A-Za-z0-9]{8,}$/.test(id) && !/[aeiouy]/i.test(id)) return false;
  return true;
}

// ---------- escaping ----------

export function cssEscape(s: string): string {
  const w = globalThis as unknown as { CSS?: { escape?: (v: string) => string } };
  if (w.CSS && typeof w.CSS.escape === 'function') return w.CSS.escape(s);
  return s.replace(/([^\w-])/g, '\\$1');
}

export function attrValueEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function xpathLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return 'concat(' + s.split('"').map((p) => `"${p}"`).join(", '\"', ") + ')';
}

// ---------- text ----------

export function normText(s: string | null | undefined): string {
  return (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** innerText when laid out, textContent otherwise (jsdom). Normalised. */
export function textOf(el: Element | null | undefined, max = 2000): string {
  if (!el) return '';
  const anyEl = el as HTMLElement & { innerText?: string };
  let t = '';
  if (typeof anyEl.innerText === 'string' && anyEl.innerText.length) t = anyEl.innerText;
  else t = el.textContent || '';
  t = t.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Text of the element's own text nodes (not descendants). */
export function ownText(el: Element): string {
  let s = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.textContent || '';
  return normText(s);
}

// ---------- geometry ----------

export interface Rect { x: number; y: number; width: number; height: number }

export function rectOf(el: Element): Rect {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

export function areaOf(el: Element): number {
  const r = rectOf(el);
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** Size measure that degrades to text length when there is no layout (jsdom). */
export function sizeOf(el: Element): number {
  const a = areaOf(el);
  if (a > 0) return a;
  return Math.max(1, normText(el.textContent).length + el.querySelectorAll('img,a,input').length * 20);
}

export function hasLayout(doc: Document = document): boolean {
  const body = doc.body;
  if (!body) return false;
  const r = rectOf(body);
  return r.width > 0 || r.height > 0;
}

// ---------- misc ----------

export const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'HR', 'WBR']);

export function isSvgNode(el: Element): boolean {
  return typeof el.namespaceURI === 'string' && el.namespaceURI.includes('svg');
}

export function isOverlayNode(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur && cur.nodeType === 1) {
    if ((cur as Element).hasAttribute(OVERLAY_ATTR)) return true;
    cur = cur.parentNode;
  }
  return false;
}

export function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

export function docOf(node: Node): Document {
  return node.nodeType === 9 ? (node as Document) : (node.ownerDocument as Document);
}

export function absUrl(href: string | null | undefined, doc: Document = document): string {
  if (!href) return '';
  try {
    return new URL(href, doc.baseURI || doc.location?.href || undefined).toString();
  } catch {
    return href;
  }
}

export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

export function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function candidate(kind: SelectorCandidate['kind'], value: string, score: number, note?: string): SelectorCandidate {
  const c: SelectorCandidate = { kind, value, score: Math.round(score * 10) / 10 };
  if (note) c.note = note;
  return c;
}

/** Detect value patterns for typing / naming. */
const CUR = '(?:[$€£¥₹₽₩₺₴₪฿]|R\\$|C\\$|A\\$|US\\$|USD|EUR|GBP|CHF|CAD|AUD|INR|JPY|CNY|SEK|NOK|DKK|PLN|BRL|MXN|ZAR|kr|zł|Kč|lei|Ft)';
export const PRICE_RE = new RegExp(`(?:^|\\s)${CUR}\\s?\\d[\\d.,\\u00a0 ]*|\\d[\\d.,]*\\s?${CUR}(?:\\s|$)`);
export const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const PHONE_RE = /(?:^|\s)\+?\(?\d{1,4}\)?[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4}(?:\s|$)/;
export const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{4}|(?:\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)|(?:yesterday|today))\b/i;

export function looksLikePrice(t: string): boolean {
  return t.length <= 40 && PRICE_RE.test(t);
}
export function looksLikeDate(t: string): boolean {
  return t.length <= 60 && DATE_RE.test(t);
}
export function looksLikeEmail(t: string): boolean {
  return t.length <= 120 && EMAIL_RE.test(t);
}
