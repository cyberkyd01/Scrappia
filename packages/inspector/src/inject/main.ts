/**
 * Inspector entry point. Bundled to an IIFE with global name `__scrappiaInspector`; the exports
 * of this module ARE the `InspectorApi` (see packages/core/src/inspector/protocol.ts).
 * Idempotent: a second injection reuses the instance already on the window.
 */
import type { DetectedList, InspectorApi, InspectorMode, PickedElement, SelectorCandidate } from '@scrappia/core';
import { suggestForElement } from './fields.js';
import { send, reportError } from './host.js';
import { detectListFromElement, detectLists as detectListsImpl, toDetectedList } from './listDetect.js';
import { createOverlay, type Overlay } from './overlay.js';
import { queryCandidates, resolveFirst } from './query.js';
import { generateSelectors, relativeSelector } from './selectors.js';
import { OVERLAY_ATTR, absUrl, isOverlayNode, rectOf, tagOf, textOf } from './util.js';

export const version = '0.1.0';
const GLOBAL = '__scrappiaInspector';

declare global {
  interface Window {
    __scrappiaInspector?: InspectorApi;
  }
}

// ---------- element description ----------

function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    const v = a.value;
    out[a.name] = v.length > 300 ? v.slice(0, 300) + '…' : v;
  }
  return out;
}

export function describeElement(el: Element, mode: InspectorMode = 'pick'): PickedElement {
  const doc = el.ownerDocument || document;
  const selectors = generateSelectors(el);
  let record: DetectedList | undefined;
  let relativeSelectors: SelectorCandidate[] | undefined;
  let recordEl: Element | undefined;
  if (mode !== 'pickAction') {
    try {
      // in "pick list" mode the user says the element repeats: accept two-item lists
      const det = detectListFromElement(el, { minRecords: mode === 'pickList' ? 2 : 3 });
      if (det) {
        recordEl = det.records[det.clickedIndex] || det.records[0];
        record = toDetectedList(det, { withAlternatives: mode === 'pickList' });
        if (recordEl) relativeSelectors = relativeSelector(el, recordEl, { records: det.records });
      }
    } catch (err) {
      reportError(err);
    }
  }
  const tag = tagOf(el);
  const suggestion = suggestForElement(el, recordEl);
  const anchor = tag === 'a' ? el : el.closest('a[href]') || el.querySelector('a[href]');
  const media = ['img', 'video', 'source', 'picture'].includes(tag) ? el : el.querySelector('img,video,source');
  const html = el.outerHTML || '';
  const picked: PickedElement = {
    selectors,
    tag,
    text: textOf(el, 1000),
    html: html.length > 5000 ? html.slice(0, 5000) + '…' : html,
    attrs: attrsOf(el),
    rect: rectOf(el),
    suggestedType: suggestion.type,
    suggestedName: suggestion.name,
    frameUrl: doc.defaultView?.location.href || '',
  };
  if (relativeSelectors) picked.relativeSelectors = relativeSelectors;
  if (record) picked.record = record;
  if (anchor && anchor.getAttribute('href')) picked.href = absUrl(anchor.getAttribute('href'), doc);
  if (media) {
    const src = media.getAttribute('data-src') || media.getAttribute('src') || media.querySelector?.('img')?.getAttribute('src');
    if (src && !src.startsWith('data:')) picked.src = absUrl(src, doc);
  }
  return picked;
}

// ---------- region html ----------

const STRIP_TAGS = 'script,style,svg,noscript,template,iframe,link,meta,canvas,video,audio,object,embed,map,[' + OVERLAY_ATTR + ']';

export function cleanHtml(el: Element, maxChars = 20000): string {
  const clone = el.cloneNode(true) as Element;
  for (const n of Array.from(clone.querySelectorAll(STRIP_TAGS))) n.parentNode?.removeChild(n);
  const doc = el.ownerDocument || document;
  const walker = doc.createTreeWalker(clone, 128 /* SHOW_COMMENT */);
  const comments: Node[] = [];
  let c: Node | null;
  while ((c = walker.nextNode())) comments.push(c);
  for (const n of comments) n.parentNode?.removeChild(n);
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const n of all) {
    for (const a of Array.from(n.attributes)) {
      const name = a.name.toLowerCase();
      if (name === 'style' || name.startsWith('on') || name === 'nonce' || name === 'integrity') n.removeAttribute(a.name);
      else if (a.value.startsWith('data:')) n.setAttribute(a.name, 'data:…');
      else if (a.value.length > 300) n.setAttribute(a.name, a.value.slice(0, 300) + '…');
    }
  }
  let html = clone.outerHTML.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ');
  if (html.length > maxChars) html = html.slice(0, maxChars) + '\n<!-- truncated -->';
  return html;
}

// ---------- API ----------

function up(el: Element, levels: number): Element {
  let cur = el;
  const doc = el.ownerDocument || document;
  for (let i = 0; i < levels; i++) {
    if (!cur.parentElement || cur === doc.body || cur === doc.documentElement) break;
    cur = cur.parentElement;
  }
  return cur;
}

function createApi(): InspectorApi {
  let overlay: Overlay | null = null;
  const getOverlay = (): Overlay => {
    if (!overlay) overlay = createOverlay({ describe: describeElement });
    return overlay;
  };
  const api: InspectorApi = {
    version,
    setMode(mode: InspectorMode): void {
      try {
        getOverlay().setMode(mode);
      } catch (err) {
        reportError(err);
      }
    },
    highlight(selectors: SelectorCandidate[], scope?: SelectorCandidate[]) {
      try {
        return getOverlay().highlight(selectors || [], scope);
      } catch (err) {
        reportError(err);
        return { count: 0, samples: [], candidate: -1 };
      }
    },
    clearHighlights(): void {
      if (overlay) overlay.clearHighlights();
    },
    detectLists(): DetectedList[] {
      try {
        return detectListsImpl(document, 5);
      } catch (err) {
        reportError(err);
        return [];
      }
    },
    describe(selector: string): PickedElement | null {
      const el = resolveFirst(selector, document);
      if (!el || isOverlayNode(el)) return null;
      return describeElement(el, 'pick');
    },
    expand(selector: string, levels = 1): PickedElement | null {
      const el = resolveFirst(selector, document);
      if (!el) return null;
      return describeElement(up(el, Math.max(1, levels | 0)), 'pick');
    },
    regionHtml(selectors: SelectorCandidate[], maxChars = 20000): string {
      const { els } = queryCandidates(selectors || [], document);
      const parts: string[] = [];
      let total = 0;
      for (const el of els) {
        if (total >= maxChars) break;
        const h = cleanHtml(el, maxChars - total);
        parts.push(h);
        total += h.length + 1;
      }
      return parts.join('\n');
    },
  };
  try {
    getOverlay();
  } catch (err) {
    reportError(err);
  }
  return api;
}

function init(): InspectorApi {
  const w = window as unknown as Record<string, unknown>;
  const existing = w[GLOBAL] as InspectorApi | undefined;
  if (existing && typeof existing.setMode === 'function' && typeof existing.describe === 'function') return existing;
  const api = createApi();
  try {
    Object.defineProperty(w, GLOBAL, { value: api, writable: true, configurable: true, enumerable: false });
  } catch {
    w[GLOBAL] = api;
  }
  send({ type: 'ready', url: location.href, frameUrl: location.href });
  return api;
}

const api = init();

export const setMode: InspectorApi['setMode'] = (mode) => api.setMode(mode);
export const highlight: InspectorApi['highlight'] = (selectors, scope) => api.highlight(selectors, scope);
export const clearHighlights: InspectorApi['clearHighlights'] = () => api.clearHighlights();
export const detectLists: InspectorApi['detectLists'] = () => api.detectLists();
export const describe: InspectorApi['describe'] = (selector) => api.describe(selector);
export const expand: InspectorApi['expand'] = (selector, levels) => api.expand(selector, levels);
export const regionHtml: InspectorApi['regionHtml'] = (selectors, maxChars) => api.regionHtml(selectors, maxChars);
