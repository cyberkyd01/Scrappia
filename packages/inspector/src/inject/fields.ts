/**
 * Field inference for a detected list: align leaf units across records by their relative
 * structural path, drop boilerplate, type and name them, compute coverage + samples.
 * Also hosts the single-element type/name suggestion used by PickedElement.
 *
 * Alignment keys skip anonymous wrappers (divs/spans whose classes are all utility or generic)
 * so that records with extra badges or different grid classes still line up. Beyond the plain
 * leaf units the walk proposes: the record's first heading as `title`, visually hidden
 * accessible text carrying a price/date (".a-offscreen $29.99"), and the parent of split price
 * spans (whole/decimal/fraction) with the joined text.
 */
import type { FieldType, SuggestedField } from '@scrappia/core';
import { relativeSelector } from './selectors.js';
import {
  SKIP_TAGS,
  absUrl,
  docOf,
  isCleanPrice,
  isGenericWrapperClass,
  isOverlayNode,
  isSvgNode,
  isVisuallyHiddenText,
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
  /** value override (hidden accessible text, joined split price, heading aria-label) */
  value?: string;
  /** screen-reader-only / clipped text */
  hidden?: boolean;
  /** parent of split price spans, value is the joined text */
  split?: boolean;
  /** the record's heading (synthetic title unit) */
  heading?: boolean;
}

const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'MARK', 'ABBR', 'U', 'S', 'DEL', 'INS', 'CODE', 'TIME', 'WBR', 'FONT', 'LABEL', 'BDI', 'Q', 'CITE', 'DFN', 'KBD', 'VAR', 'SAMP']);
/** tags that carry structure on their own (kept in alignment paths even without classes) */
const SEMANTIC_PATH_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'nav', 'header', 'footer', 'main', 'aside', 'article', 'section', 'form', 'label', 'a', 'time', 'address', 'blockquote', 'button', 'p', 'summary', 'details']);
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
/** field names derived from layout wrappers ("s_widget_container", "card_wrapper", "col_inner") */
const WRAPPER_NAME_RE = /(?:^|_)(?:container|wrapper|wrap|inner|outer|section|row|col|column|grid|widget|holder|slot)s?$|^(?:col|row|grid|widget)(?:_|$)|^s_widget/i;

const BLOCK_DESCENDANT_SELECTOR = 'div,p,h1,h2,h3,h4,h5,h6,ul,ol,li,table,tr,section,article,header,footer,nav,form,figure,dl,blockquote,pre';
/** Walk depth / unit budget per record: real-world cards nest 15-20 wrappers deep. */
const MAX_WALK_DEPTH = 24;
const MAX_UNITS = 200;

/** Inline element (span, b, …) that does not smuggle block content ("<span><div>…</div></span>"). */
function isInlineLeafish(k: Element): boolean {
  if (isSvgNode(k)) return true;
  if (!INLINE_TAGS.has(k.tagName)) return false;
  return !k.querySelector(BLOCK_DESCENDANT_SELECTOR);
}

/** Text-bearing element whose children are all inline (or none): a single text value. */
function isTextUnit(el: Element): boolean {
  const t = normText(el.textContent);
  if (!t) return false;
  const kids = Array.from(el.children);
  if (!kids.length) return true;
  if (kids.every(isInlineLeafish)) return true;
  // mixed content with meaningful own text ("<b>Email:</b> a@b.com")
  return ownText(el).length >= 2;
}

/**
 * An inline-only element carrying the record's entire text through several text-bearing children
 * ("<div class=s-widget-container><span>Name</span> <span>3 pcs</span></div>") is a layout wrapper,
 * not a value: descend into its children instead.
 */
function isWholeRecordWrapper(el: Element, rec: Element): boolean {
  const kids = Array.from(el.children).filter((k) => normText(k.textContent));
  if (kids.length < 2 || ownText(el).length >= 2) return false;
  return normText(el.textContent) === normText(rec.textContent);
}

function distinctiveClasses(el: Element): string[] {
  return stableClasses(el).filter((c) => !isGenericWrapperClass(c));
}

function baseKey(el: Element): string {
  const cls = distinctiveClasses(el).slice(0, 2);
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

/** Path segment contributed by an ancestor: none for anonymous wrappers (generic/utility-only div, span). */
function pathSegment(el: Element): string | null {
  if (distinctiveClasses(el).length || SEMANTIC_PATH_TAGS.has(tagOf(el))) return unitKey(el);
  return null;
}

/** Joined text of a price split across child spans (".a-price-whole" "." ".a-price-fraction"), or null. */
function splitPriceText(el: Element): string | null {
  const kids = Array.from(el.children);
  if (kids.length < 2 || kids.length > 6) return null;
  let whole = false;
  let fraction = false;
  for (const k of kids) {
    const cls = (k.getAttribute('class') || '').toLowerCase();
    if (/whole|integer|dollars|units/.test(cls)) whole = true;
    if (/fraction|decimal|cents|minor/.test(cls)) fraction = true;
  }
  if (!whole || !fraction) return null;
  let s = '';
  for (const k of kids) {
    const t = normText(k.textContent).replace(/\s+/g, '');
    if (!t) continue;
    if (/fraction|cents|minor/.test((k.getAttribute('class') || '').toLowerCase()) && /\d$/.test(s)) s += '.';
    s += t;
  }
  if (!/\d/.test(s) || s.length > 24) return null;
  return isCleanPrice(s) || /^\d[\d.,]*$/.test(s) ? s : null;
}

function collectUnits(rec: Element): Unit[] {
  const out: Unit[] = [];
  let order = 0;
  const seen = new Set<string>();
  const push = (key: string, el: Element, kind: UnitKind, extra: Partial<Unit> = {}) => {
    const k = kind + '|' + key;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ key: k, el, kind, order: order++, ...extra });
  };
  const walk = (el: Element, path: string, inText: boolean, depth: number) => {
    if (depth > MAX_WALK_DEPTH || out.length > MAX_UNITS) return;
    if (SKIP_TAGS.has(el.tagName) || isSvgNode(el) || isOverlayNode(el)) return;
    const tag = tagOf(el);
    const key = el === rec ? ':scope' : (path ? path + '>' : '') + unitKey(el);
    let childPath = path;
    if (el !== rec) {
      const seg = pathSegment(el);
      if (seg) childPath = (path ? path + '>' : '') + seg;
    }
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
    if (el !== rec) {
      const split = splitPriceText(el);
      if (split) push(key, el, 'text', { split: true, value: split });
      if (!inText && isTextUnit(el) && !isWholeRecordWrapper(el, rec)) {
        const t = normText(el.textContent);
        const hidden = t.length <= 60 && (looksLikePrice(t) || looksLikeDate(t)) && isVisuallyHiddenText(el);
        push(key, el, 'text', hidden ? { hidden: true, value: t } : {});
        nowInText = true;
      } else if (inText && !split) {
        // accessible text hidden from view but carrying the clean value (".a-offscreen $29.99")
        const t = normText(el.textContent);
        if (t && t.length <= 60 && (looksLikePrice(t) || looksLikeDate(t)) && isVisuallyHiddenText(el)) push(key, el, 'text', { hidden: true, value: t });
      }
    }
    if (el === rec && !el.children.length && normText(el.textContent)) push(key, el, 'text');
    for (const child of Array.from(el.children)) walk(child, childPath, nowInText, depth + 1);
  };
  walk(rec, '', false, 0);
  return out;
}

/** The record's title: its first heading (text or aria-label), else the longest anchor text. */
function titleUnit(rec: Element): Unit | null {
  if (rec.tagName === 'TR') return null;
  for (const h of Array.from(rec.querySelectorAll(HEADING_SELECTOR))) {
    if (isOverlayNode(h)) continue;
    const v = normText(textOf(h, 300)) || normText(h.getAttribute('aria-label'));
    if (v) return { key: 'text|title', el: h, kind: 'text', order: -1, value: v, heading: true };
  }
  let best: Unit | null = null;
  for (const a of Array.from(rec.querySelectorAll('a[href]'))) {
    if (isOverlayNode(a)) continue;
    const t = normText(textOf(a, 300));
    if (t.length >= 3 && t.length <= 200 && (!best || t.length > (best.value as string).length)) best = { key: 'text|title', el: a, kind: 'text', order: -1, value: t, heading: true };
  }
  return best;
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
  if (u.value !== undefined) return u.value;
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
  const cls = distinctiveClasses(el).filter((c) => c.length >= 3 && c.length <= 40);
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

/** Short label text owned by a near ancestor ("List:" -> "list"), used to qualify secondary prices. */
function labelPrefix(el: Element, rec: Element): string | null {
  let cur = el.parentElement;
  for (let i = 0; i < 3 && cur && cur !== rec; i++, cur = cur.parentElement) {
    const own = ownText(cur).replace(/[:：]\s*$/, '').trim();
    if (own && own.length <= 24 && !/\d/.test(own) && own.split(/\s+/).length <= 3) return snakeCase(own);
  }
  return null;
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

interface Proposal {
  g: Group;
  values: string[];
  nonEmpty: string[];
  coverage: number;
  proto: Unit;
  rec: Element;
  type: FieldType;
  attr?: string;
  name: string;
  /** lower sorts first when assigning names / deduplicating: title, url, price, image, rest */
  priority: number;
  priceish: boolean;
  /** 3 hidden clean price, 2 joined split price, 1 clean price, 0 text containing a price */
  priceQuality: number;
  /** sort last: wrapper-derived name or text equal to the whole record */
  demoted: boolean;
  /** removed during price resolution (a wrapper repeating the winning price) */
  dropped?: boolean;
}

/** share of aligned positions (both non-empty) with identical values */
function sameValues(a: string[], b: string[]): number {
  let both = 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || !b[i]) continue;
    both++;
    if (a[i] === b[i]) same++;
  }
  return both ? same / both : 0;
}

/** share of aligned positions where `outer` contains `inner` (a wrapper repeating the value) */
function containsValues(outer: string[], inner: string[]): number {
  let both = 0;
  let hit = 0;
  for (let i = 0; i < outer.length; i++) {
    if (!outer[i] || !inner[i]) continue;
    both++;
    if (outer[i] !== inner[i] && outer[i].includes(inner[i])) hit++;
  }
  return both ? hit / both : 0;
}

export function inferFields(records: Element[], opts: InferOptions = {}): SuggestedField[] {
  const maxFields = opts.maxFields ?? 15;
  const minCoverage = opts.minCoverage ?? 0.3;
  const recs = records.slice(0, opts.maxRecords ?? 30);
  if (!recs.length) return [];

  const groups = new Map<string, Group>();
  recs.forEach((rec, ri) => {
    const units = collectUnits(rec);
    const title = titleUnit(rec);
    if (title) units.unshift(title);
    for (const u of units) {
      let g = groups.get(u.key);
      if (!g) {
        g = { key: u.key, kind: u.kind, order: u.heading ? -1 : ri * 1000 + u.order, perRecord: new Array(recs.length) };
        groups.set(u.key, g);
      }
      if (!g.perRecord[ri]) g.perRecord[ri] = u;
    }
  });

  const sorted = Array.from(groups.values()).sort((a, b) => a.order - b.order);
  // the primary link: the anchor inside the heading (h3 > a) or wrapping it (a > h2 > span) when
  // there is one, else the first well-covered anchor
  const primaryAnchor = sorted.find((g) => {
    if (g.kind !== 'anchor') return false;
    const u = g.perRecord.find(Boolean);
    if (!u) return false;
    return headingAncestor(u.el, recs[g.perRecord.indexOf(u)]) || !!u.el.querySelector(HEADING_SELECTOR);
  }) || null;
  let primaryUrlTaken = false;

  const proposals: Proposal[] = [];
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
    let priority = 10;
    let priceish = false;
    let priceQuality = 0;
    const priceLike = nonEmpty.filter(looksLikePrice).length >= nonEmpty.length * 0.6;
    const emailish = nonEmpty.filter(looksLikeEmail).length >= nonEmpty.length * 0.6;
    const dateish = nonEmpty.filter(looksLikeDate).length >= nonEmpty.length * 0.6;
    switch (g.kind) {
      case 'anchor': {
        type = 'href';
        if (!primaryUrlTaken && coverage >= 0.7 && (!primaryAnchor || primaryAnchor === g)) {
          name = 'url';
          priority = 1;
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
        priority = 3;
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
        if (proto.heading) {
          name = 'title';
          priority = 0;
        } else if (emailish) {
          type = 'email';
          name = th || 'email';
        } else if (th) name = th;
        else if (priceLike) {
          priceish = true;
          name = 'price';
          priority = 2;
          const clean = nonEmpty.filter(isCleanPrice).length >= nonEmpty.length * 0.6;
          priceQuality = proto.hidden && clean ? 3 : proto.split && clean ? 2 : clean ? 1 : 0;
        } else if (dateish) name = 'date';
        else name = nameForElement(proto.el, rec);
      }
    }
    const wrapperName = g.kind === 'text' && !proto.heading && WRAPPER_NAME_RE.test(name);
    const wholeRecord = g.kind === 'text' && !proto.heading && proto.el !== rec && normText(textOf(proto.el, 2000)) === normText(textOf(rec, 2000));
    if (wrapperName && wholeRecord) continue; // "s_widget_container" = the record itself
    proposals.push({ g, values, nonEmpty, coverage, proto, rec, type, attr, name, priority, priceish, priceQuality, demoted: wrapperName || wholeRecord });
  }

  // price resolution: the cleanest price wins the name, wrappers repeating it are dropped
  const prices = proposals.filter((p) => p.priceish).sort((a, b) => b.priceQuality - a.priceQuality || b.coverage - a.coverage || a.g.order - b.g.order);
  if (prices.length) {
    const winner = prices[0];
    for (const p of prices.slice(1)) {
      if (p.priceQuality === 0 && containsValues(p.values, winner.values) >= 0.6) {
        p.dropped = true; // "$29.99$29.99List: $49.99": the link wrapping the price
        continue;
      }
      p.priority = 10;
      const label = labelPrefix(p.proto.el, p.rec);
      p.name = label && label !== 'price' ? `${label}_price` : p.priceQuality > 0 ? 'price' : classNameOf(p.proto.el) || 'price';
    }
  }

  // names + dedupe in priority order (title, url, price, image, then document order)
  const used = new Set<string>();
  const kept: Proposal[] = [];
  const byPriority = proposals.filter((p) => !p.dropped).sort((a, b) => a.priority - b.priority || a.g.order - b.g.order);
  for (const p of byPriority) {
    if (kept.some((k) => k.type === p.type && sameValues(k.values, p.values) >= 0.8 && k.nonEmpty.length >= p.nonEmpty.length * 0.8)) continue;
    p.name = uniqueName(p.name, used);
    kept.push(p);
  }

  type Ranked = SuggestedField & { order: number; demoted: boolean; priority: number };
  const out: Ranked[] = kept.map((p) => {
    const field: Ranked = {
      name: p.name,
      type: p.type,
      selector: relativeSelector(p.proto.el, p.rec, { records: recs, max: 3, quick: true }),
      samples: p.nonEmpty.slice(0, 3).map((v) => (v.length > 200 ? v.slice(0, 200) : v)),
      coverage: Math.round(p.coverage * 100) / 100,
      order: p.g.order,
      demoted: p.demoted,
      priority: p.priority,
    };
    if (p.attr) field.attr = p.attr;
    return field;
  });

  // coverage first; among equals the core fields (title, url, price, image) before the rest; wrappers last
  out.sort((a, b) => Number(a.demoted) - Number(b.demoted) || b.coverage - a.coverage || a.priority - b.priority || a.order - b.order);
  return out.slice(0, maxFields).map(({ order: _o, demoted: _d, priority: _p, ...f }) => f);
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
