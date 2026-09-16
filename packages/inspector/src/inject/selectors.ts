/**
 * Ranked selector candidate generation.
 *
 * Sources: stable id, semantic attributes, stable classes, @medv/finder, css-selector-generator,
 * text-anchored XPath, id/attribute-anchored positional XPath. Every candidate is verified to
 * match exactly the target element inside the root before being scored.
 */
import type { SelectorCandidate } from '@scrappia/core';
import { finder } from '@medv/finder';
import { getCssSelector } from 'css-selector-generator';
import {
  SEMANTIC_ATTRS,
  attrValueEscape,
  isSemanticAttr,
  candidate,
  cssEscape,
  docOf,
  isGeneratedClass,
  isStableClass,
  isStableId,
  isUtilityClass,
  normText,
  ownText,
  stableClasses,
  tagOf,
  textOf,
  xpathLiteral,
} from './util.js';
import { queryOne } from './query.js';

interface RawCandidate {
  kind: SelectorCandidate['kind'];
  value: string;
  base: number;
  note?: string;
}

export interface GenerateOptions {
  /** scope for uniqueness (document by default) */
  root?: Document | Element;
  /** max candidates to return (default 5) */
  max?: number;
  /** skip the slower library generators (used for per-field inference over many records) */
  quick?: boolean;
}

const MAX_TEXT_ANCHOR = 60;

// ---------- scoring ----------

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? m.length : 0;
}

/** Score a verified-unique candidate: higher is better. */
export function scoreSelector(kind: SelectorCandidate['kind'], value: string, base: number): number {
  let score = base;
  if (kind === 'css' || kind === 'auto') {
    score -= 12 * countMatches(value, /:nth-(?:child|of-type|last-child|last-of-type)\(/g);
    score -= 3 * Math.max(0, value.split(/\s*>\s*|\s+(?![^\[]*\])/).length - 1);
    score -= 0.15 * Math.max(0, value.length - 20);
    for (const cls of value.match(/\.(-?[_a-zA-Z][\w-]*)/g) || []) {
      const name = cls.slice(1);
      if (isGeneratedClass(name)) score -= 30;
      else if (isUtilityClass(name)) score -= 8;
    }
    if (/\[data-(?:testid|test|test-id|cy|qa)=/.test(value)) score += 10;
    else if (/\[(?:itemprop|name|aria-label)=/.test(value)) score += 5;
    if (/^#/.test(value)) score += 5;
  } else if (kind === 'xpath') {
    score -= 10 * countMatches(value, /\[\d+\]/g);
    score -= 2 * Math.max(0, value.split('/').length - 3);
    score -= 0.1 * Math.max(0, value.length - 30);
    if (/normalize-space\(\)=/.test(value)) score += 5;
  } else if (kind === 'text') {
    score -= 0.2 * Math.max(0, value.length - 20);
  }
  return score;
}

// ---------- helpers ----------

function isUniqueFor(el: Element, kind: SelectorCandidate['kind'], value: string, root: ParentNode): boolean {
  const els = queryOne({ kind, value }, root);
  return els.length === 1 && els[0] === el;
}

function attrSelector(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  if (!isSemanticAttr(name, v)) return null;
  return `${tagOf(el)}[${name}="${attrValueEscape(v as string)}"]`;
}

/** Attribute names on `el` usable as selector anchors, best first. */
function semanticAttrNames(el: Element): string[] {
  const out: string[] = [];
  for (const a of SEMANTIC_ATTRS) if (isSemanticAttr(a, el.getAttribute(a))) out.push(a);
  for (const a of Array.from(el.attributes)) if (!SEMANTIC_ATTRS.includes(a.name) && isSemanticAttr(a.name, a.value)) out.push(a.name);
  return out;
}

function attrBase(name: string): number {
  if (/^data-(testid|test|test-id|cy|qa)$/.test(name)) return 95;
  if (name === 'role') return 60;
  if (SEMANTIC_ATTRS.includes(name)) return 85;
  return 80;
}

function nthOfTypeIndex(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i++;
    sib = sib.previousElementSibling;
  }
  return i;
}

function hasSameTagSibling(el: Element): boolean {
  const p = el.parentElement;
  if (!p) return false;
  for (const c of Array.from(p.children)) if (c !== el && c.tagName === el.tagName) return true;
  return false;
}

/** XPath steps from `from` (exclusive) down to `el`, positional only where needed. */
function positionalSteps(el: Element, from: Element | Document | null): string {
  const steps: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== from && cur.nodeType === 1) {
    const tag = tagOf(cur);
    steps.unshift(hasSameTagSibling(cur) ? `${tag}[${nthOfTypeIndex(cur)}]` : tag);
    cur = cur.parentElement;
  }
  return steps.join('/');
}

function anchoredXPath(el: Element, root: ParentNode): RawCandidate | null {
  // nearest ancestor-or-self with a stable id or semantic attribute
  let cur: Element | null = el;
  const rootEl = root.nodeType === 1 ? (root as Element) : null;
  while (cur && cur !== rootEl) {
    if (cur.id && isStableId(cur.id)) {
      const rest = positionalSteps(el, cur);
      const value = `//*[@id=${xpathLiteral(cur.id)}]` + (rest ? `/${rest}` : '');
      return { kind: 'xpath', value, base: cur === el ? 70 : 45, note: 'id-anchored xpath' };
    }
    for (const a of semanticAttrNames(cur)) {
      const v = cur.getAttribute(a);
      if (v != null) {
        const rest = positionalSteps(el, cur);
        const value = `//${tagOf(cur)}[@${a}=${xpathLiteral(v)}]` + (rest ? `/${rest}` : '');
        return { kind: 'xpath', value, base: cur === el ? 68 : 42, note: `${a}-anchored xpath` };
      }
    }
    cur = cur.parentElement;
  }
  return null;
}

function absoluteXPath(el: Element, root: ParentNode): RawCandidate {
  if (root.nodeType === 1) {
    const rest = positionalSteps(el, root as Element);
    return { kind: 'xpath', value: rest ? `./${rest}` : '.', base: 20, note: 'positional xpath' };
  }
  const html = docOf(el).documentElement;
  const rest = positionalSteps(el, html);
  return { kind: 'xpath', value: rest ? `/html/${rest}` : '/html', base: 20, note: 'positional xpath' };
}

function classSelector(el: Element): string | null {
  const classes = stableClasses(el);
  if (!classes.length) return null;
  return tagOf(el) + classes.slice(0, 3).map((c) => '.' + cssEscape(c)).join('');
}

function csgBlacklist(input: string): boolean {
  if (input.startsWith('.')) return isGeneratedClass(input.slice(1).replace(/\\/g, ''));
  if (input.startsWith('[')) {
    const m = /^\[([^=\]]+)(?:=['"]?([^'"\]]*))?/.exec(input);
    return !(m && isSemanticAttr(m[1], m[2] ?? 'x'));
  }
  if (input.startsWith('#')) return !isStableId(input.slice(1).replace(/\\/g, ''));
  return false;
}

function runFinder(el: Element, root: ParentNode): string | null {
  try {
    return finder(el, {
      root: root.nodeType === 9 ? (root as Document).body || (root as Document).documentElement : (root as Element),
      idName: isStableId,
      className: isStableClass,
      tagName: () => true,
      attr: (name, value) => isSemanticAttr(name, value),
      timeoutMs: 300,
      seedMinLength: 1,
      optimizedMinLength: 2,
      maxNumberOfPathChecks: 2000,
    });
  } catch {
    return null;
  }
}

function runCsg(el: Element, root: ParentNode, withNth: boolean): string | null {
  try {
    const sel = getCssSelector(el, {
      root: root.nodeType === 9 ? null : (root as Element),
      selectors: withNth ? ['id', 'attribute', 'class', 'tag', 'nthchild'] : ['id', 'attribute', 'class', 'tag'],
      blacklist: [csgBlacklist],
      whitelist: [/^\[data-testid/, /^\[data-test/, /^\[itemprop/, /^\[name=/, /^\[aria-label/],
      includeTag: true,
      combineWithinSelector: true,
      combineBetweenSelectors: true,
      maxCombinations: 30,
      maxCandidates: 30,
    });
    return typeof sel === 'string' && sel.length ? sel : null;
  } catch {
    return null;
  }
}

function textAnchor(el: Element): string | null {
  const t = normText(textOf(el, 200));
  if (!t || t.length > MAX_TEXT_ANCHOR) return null;
  // only anchor on elements that own the text (or wrap a single text child): avoid containers
  if (el.children.length > 2) return null;
  return t;
}

// ---------- public ----------

/** Ranked selector candidates for `el` inside `root` (document by default). */
export function generateSelectors(el: Element, opts: GenerateOptions = {}): SelectorCandidate[] {
  const root: ParentNode = opts.root || docOf(el);
  const max = opts.max ?? 5;
  const raw: RawCandidate[] = [];

  if (el.id && isStableId(el.id)) raw.push({ kind: 'css', value: `#${cssEscape(el.id)}`, base: 100, note: 'id' });

  for (const a of semanticAttrNames(el)) {
    const s = attrSelector(el, a);
    if (s) raw.push({ kind: 'css', value: s, base: attrBase(a), note: a });
  }

  const cls = classSelector(el);
  if (cls) raw.push({ kind: 'css', value: cls, base: 78, note: 'class' });
  if (cls && el.parentElement && el.parentElement !== root) {
    const pcls = classSelector(el.parentElement);
    if (pcls) raw.push({ kind: 'css', value: `${pcls} > ${cls}`, base: 74, note: 'parent class' });
  }

  if (!opts.quick) {
    const f = runFinder(el, root);
    if (f) raw.push({ kind: 'css', value: f, base: 80, note: 'finder' });
    const g = runCsg(el, root, false);
    if (g) raw.push({ kind: 'css', value: g, base: 76, note: 'css-selector-generator' });
    if (!g || /:nth-child/.test(g)) {
      const g2 = runCsg(el, root, true);
      if (g2 && g2 !== g) raw.push({ kind: 'css', value: g2, base: 72, note: 'css-selector-generator' });
    }
  }

  const t = textAnchor(el);
  if (t) {
    raw.push({ kind: 'xpath', value: `//${tagOf(el)}[normalize-space()=${xpathLiteral(t)}]`, base: 66, note: 'text-anchored xpath' });
    raw.push({ kind: 'text', value: t, base: 55, note: 'text' });
  }

  const ax = anchoredXPath(el, root);
  if (ax) raw.push(ax);
  raw.push(absoluteXPath(el, root));

  return rankRaw(el, root, raw, max);
}

function rankRaw(el: Element, root: ParentNode, raw: RawCandidate[], max: number): SelectorCandidate[] {
  const seen = new Set<string>();
  const out: SelectorCandidate[] = [];
  for (const r of raw) {
    const key = r.kind + '|' + r.value;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isUniqueFor(el, r.kind, r.value, root)) continue;
    out.push(candidate(r.kind, r.value, scoreSelector(r.kind, r.value, r.base), r.note));
  }
  out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (!out.length) out.push(candidate('css', tagOf(el), 1, 'fallback'));
  return out.slice(0, max);
}

/** Compact human label for the hover tooltip: tag#id.class1.class2 */
export function shortSelector(el: Element): string {
  let s = tagOf(el);
  if (el.id && isStableId(el.id)) s += '#' + el.id;
  const classes = stableClasses(el).slice(0, 2);
  if (classes.length) s += '.' + classes.join('.');
  return s;
}

// ---------- relative selectors (inside a record) ----------

export interface RelativeOptions {
  /** sibling records to generalise against; derived from recordEl's siblings when omitted */
  records?: Element[];
  max?: number;
  quick?: boolean;
}

function siblingRecords(recordEl: Element): Element[] {
  const p = recordEl.parentElement;
  if (!p) return [recordEl];
  const cls = new Set(stableClasses(recordEl));
  return Array.from(p.children).filter((c) => {
    if (c.tagName !== recordEl.tagName) return false;
    if (!cls.size) return true;
    return stableClasses(c).some((x) => cls.has(x));
  });
}

/** Cheap structural candidates: tag/class chains from el up towards the record root. */
function cheapRelative(el: Element, recordEl: Element): RawCandidate[] {
  const chain: Element[] = [];
  let cur: Element | null = el;
  while (cur && cur !== recordEl) {
    chain.unshift(cur);
    cur = cur.parentElement;
  }
  if (!cur) return [];
  const out: RawCandidate[] = [];
  const tag = tagOf(el);
  const classes = stableClasses(el);
  for (const a of semanticAttrNames(el)) {
    const s = attrSelector(el, a);
    if (s) out.push({ kind: 'css', value: s, base: 90, note: a });
  }
  if (classes.length) {
    out.push({ kind: 'css', value: '.' + cssEscape(classes[0]), base: 85, note: 'class' });
    out.push({ kind: 'css', value: tag + classes.slice(0, 2).map((c) => '.' + cssEscape(c)).join(''), base: 84, note: 'class' });
  }
  out.push({ kind: 'css', value: tag, base: 70, note: 'tag' });
  // parent tag/class > tag
  const parent = el.parentElement;
  if (parent && parent !== recordEl) {
    const pcls = stableClasses(parent);
    const ptag = tagOf(parent);
    if (pcls.length) out.push({ kind: 'css', value: `.${cssEscape(pcls[0])} ${tag}`, base: 80, note: 'parent class' });
    out.push({ kind: 'css', value: `${ptag} ${tag}`, base: 72, note: 'parent tag' });
    out.push({ kind: 'css', value: `${ptag} > ${tag}`, base: 71, note: 'parent tag' });
  }
  // full tag path with classes
  const path = chain.map((e) => tagOf(e) + stableClasses(e).slice(0, 1).map((c) => '.' + cssEscape(c)).join('')).join(' > ');
  out.push({ kind: 'css', value: `:scope > ${path}`, base: 60, note: 'path' });
  // positional path (always unique)
  const pos = chain.map((e) => (hasSameTagSibling(e) ? `${tagOf(e)}:nth-of-type(${nthOfTypeIndex(e)})` : tagOf(e))).join(' > ');
  out.push({ kind: 'css', value: `:scope > ${pos}`, base: 40, note: 'positional' });
  // text anchor relative xpath (own text only, short)
  const own = ownText(el);
  if (own && own.length <= MAX_TEXT_ANCHOR) out.push({ kind: 'xpath', value: `.//${tag}[normalize-space()=${xpathLiteral(own)}]`, base: 30, note: 'text-anchored xpath' });
  return out;
}

/**
 * Selector candidates for `el` relative to its record element. Candidates are verified to
 * resolve to `el` inside `recordEl` and generalised across sibling records: those matching
 * >= 70% of records rank first.
 */
export function relativeSelector(el: Element, recordEl: Element, opts: RelativeOptions = {}): SelectorCandidate[] {
  const max = opts.max ?? 5;
  if (el === recordEl) return [candidate('css', ':scope', 100, 'record element')];
  if (!recordEl.contains(el)) return generateSelectors(el, { max, quick: opts.quick });

  const records = (opts.records && opts.records.length ? opts.records : siblingRecords(recordEl)).filter((r) => r !== recordEl);
  const raw = cheapRelative(el, recordEl);
  if (!opts.quick) {
    const f = runFinder(el, recordEl);
    if (f) raw.push({ kind: 'css', value: f, base: 82, note: 'finder' });
    const g = runCsg(el, recordEl, false);
    if (g) raw.push({ kind: 'css', value: g, base: 78, note: 'css-selector-generator' });
  }

  const seen = new Set<string>();
  const scored: Array<{ c: SelectorCandidate; hit: number }> = [];
  for (const r of raw) {
    const key = r.kind + '|' + r.value;
    if (seen.has(key)) continue;
    seen.add(key);
    const els = queryOne({ kind: r.kind, value: r.value }, recordEl);
    if (els.length !== 1 || els[0] !== el) continue;
    // generalisation: how many sibling records have a match
    let hits = 0;
    const sample = records.slice(0, 25);
    for (const rec of sample) if (queryOne({ kind: r.kind, value: r.value }, rec).length) hits++;
    const hit = sample.length ? hits / sample.length : 1;
    const score = scoreSelector(r.kind, r.value, r.base) + (hit >= 0.7 ? 20 * hit : -20);
    const note = r.note ? `${r.note}; matches ${Math.round(hit * 100)}% of records` : undefined;
    scored.push({ c: candidate(r.kind, r.value, score, note), hit });
  }
  scored.sort((a, b) => (b.c.score ?? 0) - (a.c.score ?? 0));
  const out = scored.map((s) => s.c).slice(0, max);
  if (!out.length) out.push(candidate('css', tagOf(el), 1, 'fallback'));
  return out;
}

