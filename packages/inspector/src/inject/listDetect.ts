/**
 * MDR-style repeating record detection.
 *
 * A record candidate is a set of >= 3 sibling elements with similar structural signatures
 * (tag + stable classes + child/grandchild tag histogram, Jaccard >= 0.8). Click-based
 * detection walks up from the clicked element and picks the level whose generalised selector
 * covers the largest area (with a preference for the innermost "rich" level); page-wide
 * detection scans every parent with >= 3 similar children and ranks by count * area.
 */
import type { DetectedList, SelectorCandidate } from '@scrappia/core';
import { inferFields } from './fields.js';
import { queryOne } from './query.js';
import { generateSelectors } from './selectors.js';
import { SKIP_TAGS, candidate, cssEscape, docOf, isOverlayNode, isSvgNode, normText, sizeOf, stableClasses, tagOf, textOf } from './util.js';

export const SIMILARITY_THRESHOLD = 0.8;
const MAX_SCAN_ELEMENTS = 40000;

// ---------- signatures ----------

interface Sig { tokens: Set<string>; key: string }

let sigCache = new WeakMap<Element, Sig>();

export function resetSignatureCache(): void {
  sigCache = new WeakMap<Element, Sig>();
}

function skippable(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName) || isSvgNode(el) || isOverlayNode(el);
}

export function signatureOf(el: Element): Sig {
  const cached = sigCache.get(el);
  if (cached) return cached;
  const tokens = new Set<string>();
  tokens.add('t:' + tagOf(el));
  for (const c of stableClasses(el)) tokens.add('k:' + c);
  const childCounts = new Map<string, number>();
  for (const child of Array.from(el.children)) {
    if (skippable(child)) continue;
    const ct = tagOf(child);
    childCounts.set(ct, (childCounts.get(ct) || 0) + 1);
    for (const gc of Array.from(child.children)) {
      if (skippable(gc)) continue;
      tokens.add('g:' + ct + '/' + tagOf(gc));
    }
  }
  for (const [ct, n] of childCounts) {
    tokens.add('c:' + ct);
    if (n >= 2) tokens.add('c:' + ct + '#2');
  }
  const sig = { tokens, key: Array.from(tokens).sort().join(' ') };
  sigCache.set(el, sig);
  return sig;
}

export function similarity(a: Sig, b: Sig): number {
  if (a.key === b.key) return 1;
  let inter = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) inter++;
  const union = a.tokens.size + b.tokens.size - inter;
  return union ? inter / union : 0;
}

// ---------- candidates ----------

export interface ListCandidate {
  container: Element;
  records: Element[];
  clickedIndex: number;
  /** total size (area, or text length without layout) */
  size: number;
}

/** Siblings of `el` (inclusive) with similar signatures, in document order. */
function similarSiblings(el: Element): Element[] {
  const p = el.parentElement;
  if (!p) return [el];
  const sig = signatureOf(el);
  return Array.from(p.children).filter((c) => c === el || (!skippable(c) && similarity(signatureOf(c), sig) >= SIMILARITY_THRESHOLD));
}

/**
 * `<li><article class="product">` -> use the article as the record when every record is a bare
 * wrapper around a single classed element.
 */
function unwrap(records: Element[]): Element[] {
  let cur = records;
  for (let i = 0; i < 3; i++) {
    if (stableClasses(cur[0]).length) return cur;
    const inner: Element[] = [];
    for (const r of cur) {
      const kids = Array.from(r.children).filter((k) => !skippable(k));
      if (kids.length !== 1 || normText(r.textContent) !== normText(kids[0].textContent)) return cur;
      inner.push(kids[0]);
    }
    if (!stableClasses(inner[0]).length && inner.some((x) => x.tagName !== inner[0].tagName)) return cur;
    cur = inner;
  }
  return cur;
}

function richness(el: Element): number {
  let n = 0;
  let visited = 0;
  const walk = (e: Element) => {
    if (visited++ > 300 || n >= 6) return;
    if (skippable(e)) return;
    const tag = tagOf(e);
    if (tag === 'img' || (tag === 'a' && e.getAttribute('href')) || tag === 'input') n++;
    else if (!e.children.length && normText(e.textContent)) n++;
    for (const c of Array.from(e.children)) walk(c);
  };
  walk(el);
  return n;
}

function totalSize(els: Element[]): number {
  let s = 0;
  for (const e of els.slice(0, 200)) s += sizeOf(e);
  return s;
}

// ---------- record selector ----------

function commonClasses(records: Element[]): string[] {
  let common = stableClasses(records[0]);
  for (const r of records.slice(1, 30)) {
    const set = new Set(stableClasses(r));
    common = common.filter((c) => set.has(c));
    if (!common.length) break;
  }
  return common;
}

function commonTag(records: Element[]): string | null {
  const t = records[0].tagName;
  return records.every((r) => r.tagName === t) ? t.toLowerCase() : null;
}

function allSimilar(els: Element[], proto: Element): boolean {
  const sig = signatureOf(proto);
  let bad = 0;
  for (const e of els.slice(0, 200)) if (similarity(signatureOf(e), sig) < SIMILARITY_THRESHOLD - 0.2) bad++;
  return bad <= Math.max(1, Math.floor(els.length * 0.1));
}

function coversRecords(matches: Element[], records: Element[]): boolean {
  const set = new Set(matches);
  let hit = 0;
  for (const r of records) if (set.has(r)) hit++;
  return hit >= Math.ceil(records.length * 0.9);
}

export interface RecordSelectorResult {
  selector: SelectorCandidate[];
  matches: Element[];
  containerSelector?: string;
}

/** Generalised selector(s) matching all records of a candidate (never :nth-child on the record). */
export function recordSelector(cand: ListCandidate): RecordSelectorResult {
  const doc = docOf(cand.container);
  const records = cand.records;
  const proto = records[cand.clickedIndex >= 0 ? cand.clickedIndex : 0];
  const tag = commonTag(records);
  const classes = commonClasses(records);
  const clsSel = classes.slice(0, 2).map((c) => '.' + cssEscape(c)).join('');
  const direct = records.every((r) => r.parentElement === cand.container);
  const comb = direct ? ' > ' : ' ';

  const containerCands = generateSelectors(cand.container, { max: 3 });
  const containerCss = containerCands.find((c) => c.kind === 'css' && c.value !== 'body' && c.value !== 'html');
  const containerSelector = containerCss?.value;

  const raw: Array<{ kind: SelectorCandidate['kind']; value: string; base: number; note: string }> = [];
  if (tag && clsSel) raw.push({ kind: 'css', value: tag + clsSel, base: 90, note: 'record class (document-wide)' });
  if (containerSelector && (tag || clsSel)) raw.push({ kind: 'css', value: `${containerSelector}${comb}${tag || ''}${clsSel}`, base: 85, note: 'container-scoped' });
  if (containerSelector && tag && clsSel) raw.push({ kind: 'css', value: `${containerSelector}${comb}${tag}`, base: 60, note: 'container-scoped tag' });
  if (tag && classes.length) raw.push({ kind: 'xpath', value: `//${tag}[contains(concat(" ", normalize-space(@class), " "), " ${classes[0]} ")]`, base: 55, note: 'class xpath' });
  if (!tag && clsSel) raw.push({ kind: 'css', value: clsSel, base: 70, note: 'record class' });
  if (!containerSelector && tag && !clsSel) {
    const cx = containerCands.find((c) => c.kind === 'xpath');
    if (cx) raw.push({ kind: 'xpath', value: `${cx.value}${direct ? '/' : '//'}${tag}`, base: 50, note: 'container xpath' });
  }
  if (containerSelector && tag && !clsSel) raw.push({ kind: 'css', value: `${containerSelector}${comb}${tag}`, base: 80, note: 'container-scoped tag' });

  const out: Array<{ c: SelectorCandidate; matches: Element[] }> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (seen.has(r.value)) continue;
    seen.add(r.value);
    const matches = queryOne({ kind: r.kind, value: r.value }, doc).filter((m) => !isOverlayNode(m));
    if (!matches.length || !coversRecords(matches, records)) continue;
    let score = r.base;
    const extra = matches.length - records.length;
    if (extra > 0) {
      // matches beyond the records: fine if they look alike (same list elsewhere), penalise if not
      if (!allSimilar(matches, proto)) score -= 40;
      else score -= Math.min(10, extra * 0.5);
    }
    if (tag && /:nth-/.test(r.value)) score -= 15;
    out.push({ c: candidate(r.kind, r.value, score, r.note), matches });
  }
  out.sort((a, b) => (b.c.score ?? 0) - (a.c.score ?? 0));
  if (!out.length) {
    // last resort: positional selectors of the container + tag
    const fb = containerCands[0];
    const value = fb && fb.kind === 'css' ? `${fb.value}${comb}${tag || '*'}` : `${fb ? fb.value : '//body'}//${tag || '*'}`;
    return { selector: [candidate(fb && fb.kind === 'css' ? 'css' : 'xpath', value, 10, 'fallback')], matches: records, containerSelector };
  }
  return { selector: out.slice(0, 4).map((o) => o.c), matches: out[0].matches, containerSelector };
}

// ---------- click-based detection ----------

export interface DetectedListInternal extends RecordSelectorResult {
  container: Element;
  records: Element[];
  clickedIndex: number;
}

function levelsFor(el: Element, minRecords = 3): ListCandidate[] {
  const levels: ListCandidate[] = [];
  let cur: Element | null = el;
  const doc = docOf(el);
  while (cur && cur.parentElement && cur !== doc.body && cur !== doc.documentElement) {
    const parent: Element = cur.parentElement;
    if (!skippable(cur)) {
      const sibs = similarSiblings(cur);
      if (sibs.length >= minRecords) levels.push({ container: parent, records: sibs, clickedIndex: sibs.indexOf(cur), size: totalSize(sibs) });
    }
    cur = parent;
  }
  return levels;
}

/**
 * Detect the repeating record that contains `el`. Returns null when it is not in a list.
 * `minRecords` (default 3) is the smallest sibling group that counts as a list; "Pick list" mode
 * lowers it to 2 because the user explicitly said the clicked element repeats (e.g. a "load more"
 * page that starts with two rows).
 */
export function detectListFromElement(el: Element, opts: { minRecords?: number } = {}): DetectedListInternal | null {
  resetSignatureCache();
  const levels = levelsFor(el, Math.max(2, opts.minRecords ?? 3));
  if (!levels.length) return null;
  const evaluated = levels.map((l) => {
    const unwrapped = unwrap(l.records);
    const cand: ListCandidate = unwrapped === l.records ? l : { ...l, records: unwrapped, clickedIndex: l.clickedIndex };
    const rs = recordSelector(cand);
    return { cand, rs, size: totalSize(rs.matches), rich: richness(unwrapped[Math.max(0, cand.clickedIndex)]) };
  });
  const maxSize = Math.max(...evaluated.map((e) => e.size));
  const qualifying = evaluated.filter((e) => e.size >= 0.5 * maxSize);
  const chosen = qualifying.find((e) => e.rich >= 2) || qualifying[0];
  const { cand, rs } = chosen;
  // clickedIndex within the matched set of the winning selector
  const clickedRecord = cand.records[Math.max(0, cand.clickedIndex)];
  const idx = rs.matches.indexOf(clickedRecord);
  return { container: cand.container, records: rs.matches, clickedIndex: idx >= 0 ? idx : Math.max(0, cand.clickedIndex), selector: rs.selector, matches: rs.matches, containerSelector: rs.containerSelector };
}

// ---------- whole-page scan ----------

export function scanLists(doc: Document = document): ListCandidate[] {
  resetSignatureCache();
  const root = doc.body || doc.documentElement;
  if (!root) return [];
  const all = Array.from(root.querySelectorAll('*'));
  const out: ListCandidate[] = [];
  const limit = Math.min(all.length, MAX_SCAN_ELEMENTS);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (el.children.length < 3 || skippable(el)) continue;
    const clusters: Array<{ sig: Sig; members: Element[] }> = [];
    for (const child of Array.from(el.children)) {
      if (skippable(child)) continue;
      const sig = signatureOf(child);
      let placed = false;
      for (const cl of clusters) {
        if (similarity(cl.sig, sig) >= SIMILARITY_THRESHOLD) {
          cl.members.push(child);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ sig, members: [child] });
    }
    for (const cl of clusters) {
      if (cl.members.length < 3) continue;
      const records = unwrap(cl.members);
      const meaningful = records.some((r) => normText(r.textContent) || r.querySelector('img,a[href]'));
      if (!meaningful) continue;
      out.push({ container: el, records, clickedIndex: -1, size: totalSize(records) });
    }
  }
  out.sort((a, b) => b.records.length * b.size - a.records.length * a.size);
  // dedupe nested per-record sub-lists (e.g. star icons repeated in every card)
  const kept: ListCandidate[] = [];
  for (const c of out) {
    const nested = kept.some((k) => k.records.length >= c.records.length && k.records.some((r) => r !== c.container && r.contains(c.container)));
    if (!nested) kept.push(c);
  }
  return kept;
}

// ---------- DetectedList assembly ----------

export function toDetectedList(internal: DetectedListInternal, opts: { withAlternatives?: boolean; maxAltern?: number } = {}): DetectedList {
  const fields = inferFields(internal.records, { maxRecords: 25 });
  const list: DetectedList = {
    selector: internal.selector,
    count: internal.matches.length,
    clickedIndex: internal.clickedIndex,
    fields,
  };
  if (internal.containerSelector) list.containerSelector = internal.containerSelector;
  if (opts.withAlternatives !== false) {
    const primary = internal.selector[0]?.value;
    const alts: NonNullable<DetectedList['alternatives']> = [];
    const seen = new Set<string>([primary || '']);
    for (const cand of scanLists(docOf(internal.container)).slice(0, 12)) {
      if (alts.length >= (opts.maxAltern ?? 5)) break;
      const rs = recordSelector(cand);
      const v = rs.selector[0]?.value;
      if (!v || seen.has(v)) continue;
      seen.add(v);
      alts.push({ selector: rs.selector, count: rs.matches.length, sample: normText(textOf(rs.matches[0], 200)).slice(0, 120) });
    }
    if (alts.length) list.alternatives = alts;
  }
  return list;
}

/** Click-less auto-detect: top lists on the page, largest first. */
export function detectLists(doc: Document = document, max = 5): DetectedList[] {
  const cands = scanLists(doc);
  const out: DetectedList[] = [];
  const seen = new Set<string>();
  for (const cand of cands.slice(0, max * 3)) {
    if (out.length >= max) break;
    const rs = recordSelector(cand);
    const v = rs.selector[0]?.value;
    if (!v || seen.has(v)) continue;
    seen.add(v);
    const internal: DetectedListInternal = { container: cand.container, records: rs.matches, clickedIndex: 0, ...rs };
    out.push(toDetectedList(internal, { withAlternatives: false }));
  }
  // rebuild alternatives from the other detected lists
  for (const l of out) {
    const alts = out.filter((o) => o !== l).map((o) => ({ selector: o.selector, count: o.count, sample: o.fields[0]?.samples[0] || '' }));
    if (alts.length) l.alternatives = alts;
  }
  return out;
}
