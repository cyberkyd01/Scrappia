/**
 * Field inference for a detected list: align leaf units across records by their relative
 * structural path, drop boilerplate, type and name them, compute coverage + samples.
 * Also hosts the single-element type/name suggestion used by PickedElement.
 */
import type { FieldType, SuggestedField } from '@scrappia/core';
import { relativeSelector } from './selectors.js';
import {
  SKIP_TAGS,
  absUrl,
  docOf,
  isOverlayNode,
  isSvgNode,
  looksLikeDate,
  looksLikeEmail,
  looksLikePrice,
  normText,
  ownText,
  snakeCase,
  stableClasses,
  tagOf,
  textOf,
} from './util.js';

type UnitKind = 'text' | 'anchor' | 'img' | 'input' | 'time';

interface Unit {
  key: string;
  el: Element;
  kind: UnitKind;
  order: number;
}

const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'MARK', 'ABBR', 'U', 'S', 'DEL', 'INS', 'CODE', 'TIME', 'WBR', 'FONT', 'LABEL', 'BDI', 'Q', 'CITE', 'DFN', 'KBD', 'VAR', 'SAMP']);
const GENERIC_CLASS_RE = /^(wrap|wrapper|inner|content|contents|container|row|col|column|columns|item|items|block|box|card|cards|left|right|center|main|section|cell|grid|list|body|holder|outer|group|panel|pane|area|region|widget|module|component|element|el|node|entry|entries|result|results|tile|tiles|product|products|post|posts|article|articles)$/i;

/** Text-bearing element whose children are all inline (or none): a single text value. */
function isTextUnit(el: Element): boolean {
  const t = normText(el.textContent);
  if (!t) return false;
  const kids = Array.from(el.children);
  if (!kids.length) return true;
  if (kids.every((k) => INLINE_TAGS.has(k.tagName) || isSvgNode(k))) return true;
  // mixed content with meaningful own text ("<b>Email:</b> a@b.com")
  return ownText(el).length >= 2;
}

function baseKey(el: Element): string {
  const cls = stableClasses(el).filter((c) => !GENERIC_CLASS_RE.test(c)).slice(0, 2);
  return tagOf(el) + (cls.length ? '.' + cls.join('.') : '');
}

/** tag.class, plus a position when siblings share the same tag.class (table cells, list items). */
function unitKey(el: Element): string {
  const k = baseKey(el);
  const p = el.parentElement;
  if (!p) return k;
  let same = 0;
  let idx = 0;
  for (const c of Array.from(p.children)) {
    if (baseKey(c) === k) {
      same++;
      if (c === el) idx = same;
    }
  }
  return same > 1 ? `${k}:${idx}` : k;
}

function collectUnits(rec: Element): Unit[] {
  const out: Unit[] = [];
  let order = 0;
  const seen = new Set<string>();
  const push = (key: string, el: Element, kind: UnitKind) => {
    const k = kind + '|' + key;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, el, kind, order: order++ });
  };
  const walk = (el: Element, path: string, inText: boolean, depth: number) => {
    if (depth > 12 || out.length > 120) return;
    if (SKIP_TAGS.has(el.tagName) || isSvgNode(el) || isOverlayNode(el)) return;
    const tag = tagOf(el);
    const key = el === rec ? ':scope' : (path ? path + '>' : '') + unitKey(el);
    if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'source') {
      if (tag !== 'source' || el.getAttribute('srcset') || el.getAttribute('src')) push(key, el, 'img');
      if (tag !== 'picture') return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (!['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) push(key, el, 'input');
      return;
    }
    if (tag === 'a' && el.getAttribute('href')) push(key, el, 'anchor');
    if (tag === 'time' || el.hasAttribute('datetime')) {
      push(key, el, 'time');
      return;
    }
    let nowInText = inText;
    if (!inText && el !== rec && isTextUnit(el)) {
      push(key, el, 'text');
      nowInText = true;
    }
    if (el === rec && !el.children.length && normText(el.textContent)) push(key, el, 'text');
    for (const child of Array.from(el.children)) walk(child, el === rec ? '' : key, nowInText, depth + 1);
  };
  walk(rec, '', false, 0);
  return out;
}

function imgSrc(el: Element): string {
  const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
  let src = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('src');
  if (srcset) {
    const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
    parts.sort((a, b) => parseFloat(b[1] || '0') - parseFloat(a[1] || '0'));
    if (parts[0]?.[0]) src = parts[0][0];
  }
  if (!src && tagOf(el) === 'picture') {
    const img = el.querySelector('img');
    if (img) return imgSrc(img);
  }
  if (src && src.startsWith('data:')) return '';
  return src ? absUrl(src, docOf(el)) : '';
}

function unitValue(u: Unit): string {
  const el = u.el;
  switch (u.kind) {
    case 'anchor':
      return absUrl(el.getAttribute('href'), docOf(el));
    case 'img':
      return imgSrc(el);
    case 'input':
      return (el as HTMLInputElement).value || el.getAttribute('value') || '';
    case 'time':
      return normText(textOf(el, 200)) || el.getAttribute('datetime') || '';
    default:
      return normText(textOf(el, 500));
  }
}

// ---------- naming ----------

function headingAncestor(el: Element, rec: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur !== rec.parentElement) {
    if (/^H[1-6]$/.test(cur.tagName) || cur.getAttribute('role') === 'heading') return true;
    cur = cur.parentElement;
  }
  return false;
}

function classNameOf(el: Element): string | null {
  const cls = stableClasses(el).filter((c) => !GENERIC_CLASS_RE.test(c) && c.length >= 3 && c.length <= 40);
  if (!cls.length) return null;
  return snakeCase(cls[0]);
}

function attrNameOf(el: Element): string | null {
  for (const a of ['itemprop', 'data-field', 'data-name', 'data-testid', 'data-test', 'data-label', 'name']) {
    const v = el.getAttribute(a);
    if (v && v.length <= 40 && /^[a-z][\w.-]*$/i.test(v)) return snakeCase(v.replace(/^(data-)?(test-?id-?|field-?)/, ''));
  }
  return null;
}

function tableHeaderName(el: Element, rec: Element): string | null {
  if (rec.tagName !== 'TR') return null;
  const cell = el.closest('td,th');
  if (!cell || !rec.contains(cell)) return null;
  const table = rec.closest('table');
  if (!table) return null;
  const headRow = table.querySelector('thead tr') || table.querySelector('tr');
  if (!headRow || headRow === rec) return null;
  const heads = Array.from(headRow.children);
  if (!heads.length || !heads.some((h) => h.tagName === 'TH')) return null;
  const idx = Array.from(rec.children).indexOf(cell);
  const h = heads[idx];
  const t = h ? normText(textOf(h, 60)) : '';
  return t ? snakeCase(t) : null;
}

/** Derive a snake_case field name for an element inside a record (no type-specific override). */
export function nameForElement(el: Element, rec: Element = el): string {
  const th = tableHeaderName(el, rec);
  if (th) return th;
  if (headingAncestor(el, rec) && el !== rec) return 'title';
  const a = attrNameOf(el);
  if (a) return a;
  const c = classNameOf(el);
  if (c) return c;
  // parent class
  let cur = el.parentElement;
  for (let i = 0; i < 3 && cur && cur !== rec; i++, cur = cur.parentElement) {
    const pc = classNameOf(cur);
    if (pc) return pc;
    const pa = attrNameOf(cur);
    if (pa) return pa;
  }
  if (el.id && /^[a-z][\w-]{1,30}$/i.test(el.id) && !/\d{3,}/.test(el.id)) return snakeCase(el.id);
  const tag = tagOf(el);
  if (/^h[1-6]$/.test(tag)) return 'title';
  if (tag === 'a') return 'link';
  if (tag === 'img') return 'image';
  if (tag === 'td' || tag === 'th') return 'col_' + (Array.from(el.parentElement?.children || []).indexOf(el) + 1);
  if (tag === 'li') return 'item';
  if (tag === 'time') return 'date';
  if (tag === 'strong' || tag === 'b' || tag === 'dt' || tag === 'label') return 'label';
  if (tag === 'dd') return 'value';
  return 'text';
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base || 'field';
  let i = 2;
  while (used.has(name)) name = `${base}_${i++}`;
  used.add(name);
  return name;
}

// ---------- inference ----------

export interface InferOptions {
  maxFields?: number;
  maxRecords?: number;
  /** minimum record coverage for a field to be proposed (default 0.3) */
  minCoverage?: number;
}

interface Group {
  key: string;
  kind: UnitKind;
  order: number;
  perRecord: Array<Unit | undefined>;
}

export function inferFields(records: Element[], opts: InferOptions = {}): SuggestedField[] {
  const maxFields = opts.maxFields ?? 15;
  const minCoverage = opts.minCoverage ?? 0.3;
  const recs = records.slice(0, opts.maxRecords ?? 30);
  if (!recs.length) return [];

  const groups = new Map<string, Group>();
  recs.forEach((rec, ri) => {
    for (const u of collectUnits(rec)) {
      let g = groups.get(u.key);
      if (!g) {
        g = { key: u.key, kind: u.kind, order: ri * 1000 + u.order, perRecord: new Array(recs.length) };
        groups.set(u.key, g);
      }
      if (!g.perRecord[ri]) g.perRecord[ri] = u;
    }
  });

  const used = new Set<string>();
  const out: Array<SuggestedField & { order: number }> = [];
  const sorted = Array.from(groups.values()).sort((a, b) => a.order - b.order);
  // the primary link: an anchor inside a heading when there is one, else the first well-covered anchor
  const primaryAnchor = sorted.find((g) => {
    if (g.kind !== 'anchor') return false;
    const u = g.perRecord.find(Boolean);
    return !!u && headingAncestor(u.el, recs[g.perRecord.indexOf(u)]);
  }) || null;
  let primaryUrlTaken = false;

  for (const g of sorted) {
    const values = g.perRecord.map((u) => (u ? unitValue(u) : ''));
    const nonEmpty = values.filter((v) => v);
    const coverage = nonEmpty.length / recs.length;
    if (coverage < minCoverage) continue;
    const distinct = new Set(nonEmpty);
    if (distinct.size === 1 && nonEmpty.length >= 3) continue; // boilerplate
    if (distinct.size <= 2 && nonEmpty.length >= 8) continue; // near-boilerplate ("In stock" / "Out of stock")
    const proto = g.perRecord.find((u) => u && unitValue(u));
    if (!proto) continue;
    const protoIdx = g.perRecord.indexOf(proto);
    const rec = recs[protoIdx];

    let type: FieldType = 'text';
    let attr: string | undefined;
    let name: string;
    const priceish = nonEmpty.filter(looksLikePrice).length >= nonEmpty.length * 0.6;
    const emailish = nonEmpty.filter(looksLikeEmail).length >= nonEmpty.length * 0.6;
    const dateish = nonEmpty.filter(looksLikeDate).length >= nonEmpty.length * 0.6;
    switch (g.kind) {
      case 'anchor': {
        type = 'href';
        if (!primaryUrlTaken && coverage >= 0.7 && (!primaryAnchor || primaryAnchor === g)) {
          name = 'url';
          primaryUrlTaken = true;
        } else {
          const imageOnly = !normText(proto.el.textContent) && !!proto.el.querySelector('img,picture,svg');
          const base = imageOnly ? 'image' : nameForElement(proto.el, rec);
          name = base === 'link' || base === 'title' ? 'url' : `${base}_url`;
        }
        break;
      }
      case 'img':
        type = 'src';
        name = 'image';
        break;
      case 'input':
        type = 'attr';
        attr = 'value';
        name = snakeCase(proto.el.getAttribute('name') || proto.el.getAttribute('placeholder') || proto.el.id || 'input');
        break;
      case 'time':
        name = 'date';
        break;
      default: {
        const th = tableHeaderName(proto.el, rec);
        if (emailish) {
          type = 'email';
          name = th || 'email';
        } else if (th) name = th;
        else if (priceish) name = 'price';
        else if (dateish) name = 'date';
        else name = nameForElement(proto.el, rec);
      }
    }
    if (g.kind === 'text' && priceish && used.has('price')) {
      const cn = classNameOf(proto.el);
      if (cn && cn !== 'price') name = cn;
    }

    const selector = relativeSelector(proto.el, rec, { records: recs, max: 3, quick: true });
    const field: SuggestedField & { order: number } = {
      name: uniqueName(name, used),
      type,
      selector,
      samples: nonEmpty.slice(0, 3).map((v) => (v.length > 200 ? v.slice(0, 200) : v)),
      coverage: Math.round(coverage * 100) / 100,
      order: g.order,
    };
    if (attr) field.attr = attr;
    out.push(field);
  }

  out.sort((a, b) => b.coverage - a.coverage || a.order - b.order);
  return out.slice(0, maxFields).map(({ order: _o, ...f }) => f);
}

// ---------- single element suggestion ----------

export interface Suggestion { type: FieldType; name: string; attr?: string; note?: string }

export function suggestForElement(el: Element, rec?: Element): Suggestion {
  const tag = tagOf(el);
  const text = normText(textOf(el, 300));
  if (tag === 'a' && el.getAttribute('href')) {
    const href = el.getAttribute('href') || '';
    if (/^mailto:/i.test(href)) return { type: 'email', name: 'email' };
    if (/^tel:/i.test(href)) return { type: 'phone', name: 'phone' };
    const words = snakeCase(text).split('_').filter(Boolean).slice(0, 3).join('_');
    return { type: 'href', name: words && words.length <= 30 ? words : 'url' };
  }
  if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'source') return { type: 'src', name: 'image' };
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return { type: 'attr', attr: 'value', name: snakeCase(el.getAttribute('name') || el.getAttribute('placeholder') || el.id || 'input') };
  }
  if (tag === 'time' || el.hasAttribute('datetime')) {
    return { type: 'text', name: 'date', note: el.getAttribute('datetime') ? `datetime attribute: ${el.getAttribute('datetime')}` : undefined };
  }
  if (text && looksLikePrice(text)) return { type: 'text', name: 'price' };
  if (text && looksLikeEmail(text)) return { type: 'email', name: 'email' };
  if (text && looksLikeDate(text) && text.length <= 40) return { type: 'text', name: 'date' };
  const inner = el.querySelector('a[href]');
  if (!text && inner && el.children.length === 1) return { type: 'href', name: 'url' };
  return { type: 'text', name: nameForElement(el, rec || el) };
}
