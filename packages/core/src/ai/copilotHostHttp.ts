/**
 * A CopilotHost that needs no browser: fetches pages over HTTP and extracts with jsdom.
 * Used by the server / MCP copilot endpoints and by tests. Picking is not available (the
 * host reports that to the model), everything else works.
 */
import { httpFetch } from '../fetch/http.js';
import { extractFromHtml, parseHtml } from '../dom/jsdom.js';
import { buildSpec } from '../engine/spec.js';
import { Runner } from '../engine/runner.js';
import { htmlToMarkdown, cleanHtml } from './clean.js';
import type { CopilotHost, CopilotPreview } from './copilot.js';
import type { Recipe, Template, SelectorCandidate, Action } from '../recipe/schema.js';
import type { Storage } from '../storage/types.js';
import type { DetectedList, InspectorMode, SuggestedField } from '../inspector/protocol.js';
import { sinkTypes } from '../sinks/index.js';
import { Logger } from '../util/logger.js';
import type { AiService } from './service.js';

export interface HttpCopilotHostOptions {
  storage: Storage;
  outDir: string;
  startUrl?: string;
  ai?: AiService;
  logger?: Logger;
  secretNames?: () => string[];
  /** Called when the copilot starts a full run (so the caller can track it). */
  onRun?: (runner: Runner) => void;
  headers?: Record<string, string>;
}

export class HttpCopilotHost implements CopilotHost {
  private current?: { url: string; title: string; html: string };
  private pickMode: InspectorMode = 'off';
  constructor(private o: HttpCopilotHostOptions) {}

  get mode() { return this.pickMode; }

  private async load(url: string) {
    const res = await httpFetch(url, { headers: this.o.headers, timeoutMs: 30_000 });
    const dom = parseHtml(res.body, res.url);
    const title = dom.window.document.title;
    dom.window.close();
    this.current = { url: res.url, title, html: res.body };
    return this.current;
  }

  async page() {
    if (!this.current && this.o.startUrl) await this.load(this.o.startUrl);
    return this.current ? { url: this.current.url, title: this.current.title } : null;
  }

  async pageContent(opts: { maxChars: number; format: 'markdown' | 'html' }) {
    const p = await this.ensure();
    return opts.format === 'html' ? cleanHtml(p.html, p.url, { maxChars: opts.maxChars }) : htmlToMarkdown(p.html, p.url, { maxChars: opts.maxChars });
  }

  private async ensure() {
    if (!this.current) { if (!this.o.startUrl) throw new Error('no page open: call navigate first'); await this.load(this.o.startUrl); }
    return this.current!;
  }

  /** Heuristic list detection on the server side (no inspector overlay): repeated-signature siblings. */
  async detectLists(): Promise<DetectedList[]> {
    const p = await this.ensure();
    return detectListsFromHtml(p.html, p.url);
  }

  async setPickMode(mode: InspectorMode) { this.pickMode = mode; if (mode !== 'off') throw new Error('element picking is not available in this session (no browser); use detect_lists / test_selector instead'); }

  async testSelector(selectors: SelectorCandidate[], scope?: SelectorCandidate[]) {
    const p = await this.ensure();
    const spec = scope
      ? { fields: [], list: { selector: scope, fields: [{ name: 'v', type: 'text', selector: selectors }] } }
      : { fields: [{ name: 'v', type: 'text', selector: selectors, multiple: true }] };
    const r = extractFromHtml(p.html, p.url, spec as Parameters<typeof extractFromHtml>[2]);
    const vals = scope ? r.records.map((x) => x.v).filter((v) => v != null && v !== '') : ((r.page.v as unknown[]) ?? []);
    return { count: scope ? vals.length : r.fieldMatches.v?.matched ?? vals.length, samples: vals.slice(0, 5).map((v) => String(v).slice(0, 80)) };
  }

  async previewExtract(template: Template): Promise<CopilotPreview> {
    const p = await this.ensure();
    const r = extractFromHtml(p.html, p.url, buildSpec(template, p.url));
    return { records: r.records.slice(0, 50), page: r.page, listMatched: r.listMatch?.matched ?? 0, fieldMatches: r.fieldMatches };
  }

  async navigate(url: string) { const p = await this.load(url); return { url: p.url, title: p.title }; }
  async runActions(_actions: Action[]) { throw new Error('actions need a browser session; add them to the recipe and they will run during the scrape'); }

  async testRun(recipe: Recipe, maxRequests: number) {
    const runner = new Runner({ recipe, storage: this.o.storage, outDir: this.o.outDir, logger: this.o.logger ?? new Logger('warn'), maxRequests, dryRun: true, ai: this.o.ai });
    const { run, stats } = await runner.start();
    const rows = Array.from(this.o.storage.iterRows(run.id, undefined, { limit: 5 })).map((r) => r.data);
    const drift = this.o.storage.listDrift(run.id).map((d) => `${d.kind} ${d.template}.${d.field ?? ''}`);
    return { stats, rows, drift, status: run.status };
  }

  async startRun(recipe: Recipe) {
    const runner = new Runner({ recipe, storage: this.o.storage, outDir: this.o.outDir, logger: this.o.logger ?? new Logger('warn'), ai: this.o.ai, recipeId: recipe.id });
    const p = runner.start();
    await new Promise((r) => setImmediate(r));
    this.o.onRun?.(runner);
    p.catch(() => { });
    return { runId: runner.id };
  }

  async saveRecipe(recipe: Recipe) { const rec = this.o.storage.saveRecipe({ id: recipe.id, name: recipe.name, json: { ...recipe, id: undefined } }); return { id: rec.id }; }
  async secretNames() { return this.o.secretNames?.() ?? this.o.storage.listSecretNames(); }
  sinkTypes() { return sinkTypes(); }
}

/**
 * Lightweight server-side list detection: for every element with >= 3 children sharing the same
 * tag + class signature, propose the children as records and infer text/href/src fields.
 */
export function detectListsFromHtml(html: string, url: string, max = 5): DetectedList[] {
  const dom = parseHtml(html, url);
  const doc = dom.window.document;
  try {
    const sig = (el: Element) => `${el.tagName}.${Array.from(el.classList).filter((c) => !/\d{3,}|^(css|sc|_)-/.test(c)).sort().slice(0, 3).join('.')}`;
    const candidates: Array<{ parent: Element; children: Element[]; score: number }> = [];
    for (const parent of Array.from(doc.querySelectorAll('body *'))) {
      if (['SCRIPT', 'STYLE', 'HEAD', 'NAV', 'FOOTER'].includes(parent.tagName)) continue;
      const groups = new Map<string, Element[]>();
      for (const c of Array.from(parent.children)) { const s = sig(c); groups.set(s, [...(groups.get(s) ?? []), c]); }
      for (const [, children] of groups) {
        if (children.length < 3) continue;
        const textLen = children.reduce((n, c) => n + (c.textContent ?? '').trim().length, 0);
        if (textLen < 30) continue;
        const richness = children[0].querySelectorAll('a, img, span, p, h1, h2, h3, h4, td, li').length;
        candidates.push({ parent, children, score: children.length * Math.log(textLen + 1) * (1 + Math.min(richness, 10)) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const out: DetectedList[] = [];
    const seen = new Set<Element>();
    for (const c of candidates) {
      if (seen.has(c.children[0])) continue;
      // skip lists nested inside an already chosen record
      if (out.length && c.children[0].closest(out.map((o) => o.selector[0].value).join(','))) continue;
      c.children.forEach((x) => seen.add(x));
      const first = c.children[0];
      const cls = Array.from(first.classList).filter((x) => !/\d{3,}|^(css|sc|_)-/.test(x));
      const parentCls = Array.from(c.parent.classList).filter((x) => !/\d{3,}|^(css|sc|_)-/.test(x));
      const selectors: SelectorCandidate[] = [];
      const tagCls = `${first.tagName.toLowerCase()}${cls.length ? '.' + cls.slice(0, 2).join('.') : ''}`;
      if (cls.length && doc.querySelectorAll(tagCls).length === c.children.length) selectors.push({ kind: 'css', value: tagCls, score: 90 });
      const parentSel = c.parent.id ? `#${c.parent.id}` : parentCls.length ? `${c.parent.tagName.toLowerCase()}.${parentCls[0]}` : c.parent.tagName.toLowerCase();
      selectors.push({ kind: 'css', value: `${parentSel} > ${tagCls}`, score: 70 });
      if (!selectors.length) selectors.push({ kind: 'css', value: `${parentSel} > ${first.tagName.toLowerCase()}`, score: 50 });
      const fields = inferFields(c.children, url);
      out.push({ selector: selectors, count: c.children.length, containerSelector: parentSel, clickedIndex: 0, fields, alternatives: [] });
      if (out.length >= max) break;
    }
    out.forEach((l, i) => { l.alternatives = out.filter((_, j) => j !== i).map((o) => ({ selector: o.selector, count: o.count, sample: o.fields[0]?.samples[0] ?? '' })); });
    return out;
  } finally { dom.window.close(); }
}

function inferFields(records: Element[], base: string): SuggestedField[] {
  const first = records[0];
  const out: SuggestedField[] = [];
  const used = new Set<string>();
  const relSel = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== first) {
      const cls = Array.from(cur.classList).filter((c) => !/\d{3,}|^(css|sc|_)-/.test(c));
      parts.unshift(cls.length ? `${cur.tagName.toLowerCase()}.${cls[0]}` : cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    return parts.join(' > ') || ':scope';
  };
  const add = (name: string, type: SuggestedField['type'], selector: string, attr?: string) => {
    if (used.has(name)) { let i = 2; while (used.has(`${name}_${i}`)) i++; name = `${name}_${i}`; }
    const samples: string[] = []; let filled = 0;
    for (const r of records.slice(0, 10)) {
      const el = selector === ':scope' ? r : r.querySelector(selector);
      let v = '';
      if (el) { if (type === 'href') v = (el as HTMLAnchorElement).getAttribute('href') ?? ''; else if (type === 'src') v = el.getAttribute('src') ?? el.getAttribute('data-src') ?? ''; else if (attr) v = el.getAttribute(attr) ?? ''; else v = (el.textContent ?? '').trim(); }
      if (v) { filled++; if (samples.length < 3) samples.push(v.slice(0, 80)); }
    }
    const coverage = filled / Math.min(records.length, 10);
    if (coverage < 0.3) return;
    used.add(name);
    out.push({ name, type, attr, selector: [{ kind: 'css', value: selector }], samples, coverage });
  };
  const heading = first.querySelector('h1,h2,h3,h4,h5');
  const links = Array.from(first.querySelectorAll('a[href]'));
  const primaryLink = (heading?.querySelector('a[href]') ?? links.find((a) => (a.textContent ?? '').trim().length > 2)) ?? null;
  if (heading) add('title', 'text', relSel(heading));
  if (primaryLink) { add(heading ? 'url' : 'link', 'href', relSel(primaryLink)); if (!heading) add('title', 'text', relSel(primaryLink)); }
  const img = first.querySelector('img');
  if (img) add('image', 'src', relSel(img));
  for (const el of Array.from(first.querySelectorAll('span, p, div, td, li, b, strong, em, time, dd'))) {
    if (el.children.length > 2) continue;
    const text = (el.textContent ?? '').trim();
    if (!text || text.length > 200) continue;
    if (heading?.contains(el) || (primaryLink && primaryLink.contains(el))) continue;
    const cls = Array.from(el.classList).filter((c) => !/\d{3,}|^(css|sc|_)-/.test(c))[0];
    let name = cls ? cls.replace(/[^a-z0-9]+/gi, '_').toLowerCase() : el.tagName.toLowerCase();
    if (/[$€£¥₹]\s?\d|\d\s?(USD|EUR|GBP)/.test(text) && !used.has('price')) name = 'price';
    else if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$|\b(20\d{2})\b/.test(text) && !used.has('date')) name = 'date';
    add(name, 'text', relSel(el));
    if (out.length >= 12) break;
  }
  void base;
  return out;
}
