/**
 * DOM extraction, environment-agnostic.
 *
 * `domExtract` MUST stay self-contained (no references to module scope) because in browser
 * mode it is serialised with `fn.toString()` and executed inside the page via `page.evaluate`.
 * In HTTP mode it is called directly against a jsdom document.
 */

export interface DomSelectorCandidate { kind: 'css' | 'xpath' | 'text' | 'role' | 'auto'; value: string }

export interface DomField {
  name: string;
  type: string;
  selector?: DomSelectorCandidate[];
  attr?: string;
  pattern?: string;
  flags?: string;
  value?: string;
  source?: 'text' | 'html';
  multiple?: boolean;
  scope?: 'record' | 'document';
  ancestor?: number;
  following?: boolean;
}

export interface DomListSpec {
  selector: DomSelectorCandidate[];
  fields: DomField[];
  limit?: number;
  /** follow specs that use a selector (not a field) need the URL resolved in-DOM */
  followSelectors?: Array<{ id: string; selector: DomSelectorCandidate[] }>;
}

export interface DomExtractSpec {
  baseUrl: string;
  fields: DomField[];
  list?: DomListSpec;
  followSelectors?: Array<{ id: string; selector: DomSelectorCandidate[] }>;
  /** selectors to probe (e.g. pagination next link): returns href + exists */
  probes?: Array<{ id: string; selector: DomSelectorCandidate[]; all?: boolean }>;
}

export interface DomFieldMatch { candidate: number; matched: number }

export interface DomExtractResult {
  page: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  /** which candidate index matched per field (for drift telemetry); -1 = none */
  fieldMatches: Record<string, DomFieldMatch>;
  listMatch: DomFieldMatch | null;
  /** per record: index within the list for follow-by-selector URL resolution */
  recordFollowUrls: Array<Record<string, string | null>>;
  pageFollowUrls: Record<string, string[]>;
  probes: Record<string, { exists: boolean; hrefs: string[]; count: number }>;
  title: string;
  url: string;
}

export function domExtract(doc: Document, spec: DomExtractSpec): DomExtractResult {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const base = spec.baseUrl || doc.baseURI || (win ? win.location.href : '');

  // ---------- helpers ----------
  function abs(href: string | null | undefined): string | null {
    if (!href) return null;
    try { return new (win ? win.URL : URL)(href, base).toString(); } catch { return null; }
  }

  function text(el: Element): string {
    const anyEl = el as HTMLElement & { innerText?: string };
    let t = '';
    if (typeof anyEl.innerText === 'string' && anyEl.innerText.length) t = anyEl.innerText;
    else t = el.textContent || '';
    return t.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function evaluateXPath(expr: string, root: Node): Element[] {
    const out: Element[] = [];
    try {
      const d = root.nodeType === 9 ? (root as Document) : root.ownerDocument!;
      const XPR = win ? win.XPathResult : XPathResult;
      const res = d.evaluate(expr, root, null, XPR.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < res.snapshotLength; i++) {
        const n = res.snapshotItem(i);
        if (n && n.nodeType === 1) out.push(n as Element);
        else if (n && n.nodeType === 2) out.push((n as Attr).ownerElement as Element);
      }
    } catch { /* invalid xpath */ }
    return out;
  }

  function byText(value: string, root: ParentNode): Element[] {
    // "text:Label" -> elements whose own trimmed text equals Label (case-insensitive), preferring leaf-most
    const needle = value.trim().toLowerCase();
    const all = Array.from(root.querySelectorAll('*'));
    const matches = all.filter((el) => {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) return false;
      const own = (el.textContent || '').trim().toLowerCase();
      if (own !== needle) return false;
      // prefer leaf-most: skip if a child also matches exactly
      return !Array.from(el.children).some((c) => (c.textContent || '').trim().toLowerCase() === needle);
    });
    return matches;
  }

  function byRole(value: string, root: ParentNode): Element[] {
    // "button[name=Next]" style: role=button name~=Next
    const m = /^([a-z]+)(?:\[name=(.+)\])?$/i.exec(value.trim());
    if (!m) return [];
    const role = m[1].toLowerCase();
    const name = (m[2] || '').replace(/^["']|["']$/g, '').toLowerCase();
    const roleSelectors: Record<string, string> = {
      button: 'button, [role=button], input[type=button], input[type=submit]',
      link: 'a[href], [role=link]',
      textbox: 'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], textarea, [role=textbox]',
      heading: 'h1,h2,h3,h4,h5,h6,[role=heading]',
      listitem: 'li,[role=listitem]',
      row: 'tr,[role=row]',
      cell: 'td,th,[role=cell]',
      img: 'img,[role=img]',
      combobox: 'select,[role=combobox]',
      checkbox: 'input[type=checkbox],[role=checkbox]',
    };
    const sel = roleSelectors[role] || `[role=${role}]`;
    const els = Array.from(root.querySelectorAll(sel));
    if (!name) return els;
    return els.filter((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.textContent || '').trim().toLowerCase();
      return label.includes(name);
    });
  }

  function query(candidates: DomSelectorCandidate[] | undefined, root: ParentNode): { els: Element[]; candidate: number } {
    if (!candidates || !candidates.length) return { els: [], candidate: -1 };
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      let els: Element[] = [];
      try {
        if ((c.kind === 'css' || c.kind === 'auto') && /^:scope\s*$/.test(c.value)) els = root.nodeType === 1 ? [root as Element] : [doc.documentElement];
        else if (c.kind === 'xpath' || (c.kind === 'auto' && /^(\/|\.\/|\(\/)/.test(c.value))) els = evaluateXPath(c.value, root as Node);
        else if (c.kind === 'text') els = byText(c.value, root);
        else if (c.kind === 'role') els = byRole(c.value, root);
        else els = Array.from(root.querySelectorAll(c.value));
      } catch { els = []; }
      if (els.length) return { els, candidate: i };
    }
    return { els: [], candidate: -1 };
  }

  function up(el: Element, n: number | undefined): Element {
    let cur: Element = el;
    for (let i = 0; i < (n || 0); i++) if (cur.parentElement) cur = cur.parentElement;
    return cur;
  }

  function followingText(el: Element): string {
    // text after a label: next sibling text/element, or the parent's text minus the label
    let sib = el.nextSibling;
    while (sib) {
      if (sib.nodeType === 3 && (sib.textContent || '').trim()) return (sib.textContent || '').trim();
      if (sib.nodeType === 1) {
        const t = text(sib as Element);
        if (t) return t;
      }
      sib = sib.nextSibling;
    }
    const parent = el.parentElement;
    if (parent) {
      const full = text(parent);
      const label = text(el);
      const idx = full.indexOf(label);
      if (idx >= 0) return full.slice(idx + label.length).replace(/^[\s:\-–—]+/, '').trim();
    }
    return '';
  }

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

  function tableToRecords(table: Element): Array<Record<string, string>> {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return [];
    let headers = Array.from(rows[0].querySelectorAll('th')).map((th) => text(th));
    let start = 1;
    if (!headers.length) {
      headers = Array.from(rows[0].querySelectorAll('td,th')).map((_, i) => `col${i + 1}`);
      start = 0;
    }
    const out: Array<Record<string, string>> = [];
    for (let i = start; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll('td,th'));
      if (!cells.length) continue;
      const rec: Record<string, string> = {};
      cells.forEach((c, j) => { rec[headers[j] || `col${j + 1}`] = text(c); });
      out.push(rec);
    }
    return out;
  }

  function valueOf(field: DomField, el: Element): unknown {
    const t = field.type;
    if (t === 'text') return field.following ? followingText(el) : text(el);
    if (t === 'html') return el.outerHTML;
    if (t === 'innerHtml') return el.innerHTML;
    if (t === 'attr') return field.attr ? el.getAttribute(field.attr) : null;
    if (t === 'href') {
      const a = el.closest('a[href]') || el.querySelector('a[href]') || el;
      return abs(a.getAttribute('href'));
    }
    if (t === 'src' || t === 'image') {
      const img = (el.tagName === 'IMG' || el.tagName === 'SOURCE' || el.tagName === 'VIDEO' ? el : el.querySelector('img,source,video')) || el;
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      let src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('src');
      if (srcset) {
        // prefer the largest candidate from srcset (best quality), fall back to src
        const parts = srcset.split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
        parts.sort((a, b) => parseFloat(b[1] || '0') - parseFloat(a[1] || '0'));
        if (parts[0]?.[0]) src = parts[0][0];
      }
      if (src && src.startsWith('data:')) src = null;
      if (!src) {
        const style = (el as HTMLElement).getAttribute('style') || '';
        const m = /url\(["']?([^"')]+)["']?\)/.exec(style);
        if (m) src = m[1];
      }
      return abs(src);
    }
    if (t === 'email') {
      const a = el.closest('a[href^="mailto:"]') || el.querySelector('a[href^="mailto:"]');
      if (a) return (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0];
      const m = (field.source === 'html' ? el.outerHTML : text(el)).match(EMAIL_RE);
      return field.multiple ? (m ? Array.from(new Set(m)) : []) : m ? m[0] : null;
    }
    if (t === 'phone') {
      const a = el.closest('a[href^="tel:"]') || el.querySelector('a[href^="tel:"]');
      if (a) return (a.getAttribute('href') || '').replace(/^tel:/i, '');
      const m = text(el).match(PHONE_RE);
      return field.multiple ? (m ? m.map((s) => s.trim()) : []) : m ? m[0].trim() : null;
    }
    if (t === 'regex') {
      const src = field.source === 'html' ? el.outerHTML : text(el);
      return applyRegex(src, field);
    }
    if (t === 'json') {
      const raw = field.attr ? el.getAttribute(field.attr) || '' : el.textContent || '';
      try { return JSON.parse(raw.trim()); } catch { return null; }
    }
    if (t === 'table') {
      const table = el.tagName === 'TABLE' ? el : el.querySelector('table');
      return table ? tableToRecords(table) : [];
    }
    if (t === 'screenshot') return '__screenshot__'; // resolved by the browser runner
    if (t === 'ai') return field.source === 'html' ? el.outerHTML : text(el); // resolved by the AI layer
    return text(el);
  }

  function applyRegex(src: string, field: DomField): unknown {
    if (!field.pattern) return null;
    let flags = field.flags || '';
    if (field.multiple && !flags.includes('g')) flags += 'g';
    let re: RegExp;
    try { re = new RegExp(field.pattern, flags); } catch { return null; }
    if (field.multiple) {
      const out: string[] = [];
      for (const m of src.matchAll(re)) out.push(m[1] !== undefined ? m[1] : m[0]);
      return out;
    }
    const m = re.exec(src);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[0];
  }

  function extractField(field: DomField, root: ParentNode, matches: Record<string, DomFieldMatch>): unknown {
    const t = field.type;
    if (t === 'constant') return field.value ?? null;
    if (t === 'pageUrl') return win ? win.location.href : base;
    if (t === 'pageTitle') return doc.title;
    if (t === 'timestamp') return new Date().toISOString();
    const scopeRoot: ParentNode = field.scope === 'document' ? doc : root;
    if (!field.selector || !field.selector.length) {
      // selector-less regex/ai/screenshot operate on the scope root
      const el = (scopeRoot as Document).documentElement || (scopeRoot as Element);
      if (t === 'regex') return applyRegex(field.source === 'html' ? el.outerHTML : text(el), field);
      if (t === 'ai') return field.source === 'html' ? el.outerHTML : text(el);
      if (t === 'screenshot') return '__screenshot__';
      return null;
    }
    const { els, candidate } = query(field.selector, scopeRoot);
    const prev = matches[field.name];
    matches[field.name] = { candidate: candidate >= 0 ? candidate : prev?.candidate ?? -1, matched: (prev?.matched ?? 0) + els.length };
    if (t === 'count') return els.length;
    if (t === 'exists') return els.length > 0;
    if (!els.length) return field.multiple ? [] : null;
    const targets = (field.multiple ? els : [els[0]]).map((e) => up(e, field.ancestor));
    if (field.multiple) {
      const vals = targets.map((e) => valueOf(field, e));
      // regex/email in multiple mode already return arrays -> flatten
      return vals.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== null && v !== '');
    }
    return valueOf(field, targets[0]);
  }

  function resolveFollowUrl(sel: DomSelectorCandidate[], root: ParentNode): string | null {
    const { els } = query(sel, root);
    if (!els.length) return null;
    const el = els[0];
    const a = el.closest('a[href]') || el.querySelector('a[href]') || el;
    return abs(a.getAttribute('href') || a.getAttribute('data-href'));
  }

  // ---------- run ----------
  const fieldMatches: Record<string, DomFieldMatch> = {};
  const page: Record<string, unknown> = {};
  for (const f of spec.fields) page[f.name] = extractField(f, doc, fieldMatches);

  const records: Array<Record<string, unknown>> = [];
  const recordFollowUrls: Array<Record<string, string | null>> = [];
  let listMatch: DomFieldMatch | null = null;
  if (spec.list) {
    const { els, candidate } = query(spec.list.selector, doc);
    listMatch = { candidate, matched: els.length };
    const limit = spec.list.limit && spec.list.limit > 0 ? Math.min(els.length, spec.list.limit) : els.length;
    for (let i = 0; i < limit; i++) {
      const el = els[i];
      const rec: Record<string, unknown> = {};
      for (const f of spec.list.fields) rec[f.name] = extractField(f, el, fieldMatches);
      records.push(rec);
      const fu: Record<string, string | null> = {};
      for (const fs of spec.list.followSelectors || []) fu[fs.id] = resolveFollowUrl(fs.selector, el);
      recordFollowUrls.push(fu);
    }
  }

  const pageFollowUrls: Record<string, string[]> = {};
  for (const fs of spec.followSelectors || []) {
    const { els } = query(fs.selector, doc);
    const urls: string[] = [];
    for (const el of els) {
      const a = el.closest('a[href]') || el.querySelector('a[href]') || el;
      const u = abs(a.getAttribute('href') || a.getAttribute('data-href'));
      if (u && !urls.includes(u)) urls.push(u);
    }
    pageFollowUrls[fs.id] = urls;
  }

  const probes: Record<string, { exists: boolean; hrefs: string[]; count: number }> = {};
  for (const p of spec.probes || []) {
    const { els } = query(p.selector, doc);
    const hrefs: string[] = [];
    for (const el of p.all ? els : els.slice(0, 1)) {
      const a = el.closest('a[href]') || el.querySelector('a[href]') || el;
      const u = abs(a.getAttribute('href'));
      if (u && !hrefs.includes(u)) hrefs.push(u);
    }
    probes[p.id] = { exists: els.length > 0, hrefs, count: els.length };
  }

  return {
    page,
    records,
    fieldMatches,
    listMatch,
    recordFollowUrls,
    pageFollowUrls,
    probes,
    title: doc.title,
    url: win ? win.location.href : base,
  };
}
