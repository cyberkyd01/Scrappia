/**
 * Visual overlay: hover highlight, click capture in pick modes, multi-highlight preview.
 * Draws fixed-position boxes in its own container (never mutates target styles), survives SPA
 * navigations and is idempotent (one instance per window).
 */
import type { InspectorMode, PickedElement, SelectorCandidate } from '@scrappia/core';
import { send, log } from './host.js';
import { queryCandidates } from './query.js';
import { shortSelector } from './selectors.js';
import { OVERLAY_ATTR, isOverlayNode, normText, rectOf, tagOf, textOf } from './util.js';

export interface OverlayDeps {
  /** builds the PickedElement for a clicked element */
  describe: (el: Element, mode: InspectorMode) => PickedElement | null;
}

export interface Overlay {
  setMode(mode: InspectorMode): void;
  getMode(): InspectorMode;
  highlight(selectors: SelectorCandidate[], scope?: SelectorCandidate[]): { count: number; samples: string[]; candidate: number };
  clearHighlights(): void;
  ensureAttached(): void;
  destroy(): void;
}

const Z = 2147483646;
const MAX_BOXES = 400;
const HOVER_COLOR = '#2563eb';
const PICK_COLORS: Record<InspectorMode, string> = { off: HOVER_COLOR, pick: '#2563eb', pickList: '#d97706', pickAction: '#db2777' };
const HL_COLOR = '#16a34a';

type WithHistoryPatch = Window & { __scrappiaHistoryPatched?: boolean };

export function createOverlay(deps: OverlayDeps): Overlay {
  const doc = document;
  let mode: InspectorMode = 'off';
  let container: HTMLDivElement | null = null;
  let hoverBox: HTMLDivElement | null = null;
  let hoverLabel: HTMLDivElement | null = null;
  let boxPool: HTMLDivElement[] = [];
  let highlighted: Element[] = [];
  let hoverTarget: Element | null = null;
  let lastHoverSent = 0;
  let raf = 0;
  let destroyed = false;
  let observer: MutationObserver | null = null;

  // ---------- DOM ----------

  function style(el: HTMLElement, css: string): void {
    el.setAttribute('style', css);
  }

  function ensureAttached(): void {
    if (destroyed) return;
    const rootEl = doc.documentElement || doc.body;
    if (!rootEl) return;
    if (container && container.isConnected) return;
    if (!container) {
      container = doc.createElement('div');
      container.setAttribute(OVERLAY_ATTR, '');
      style(container, `all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:${Z};`);
      hoverBox = doc.createElement('div');
      hoverBox.setAttribute(OVERLAY_ATTR, 'hover');
      style(hoverBox, boxCss(HOVER_COLOR, 0.08) + 'display:none;');
      hoverLabel = doc.createElement('div');
      hoverLabel.setAttribute(OVERLAY_ATTR, 'label');
      style(hoverLabel, `all:initial;position:fixed;pointer-events:none;z-index:${Z + 1};background:${HOVER_COLOR};color:#fff;font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:2px 6px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;display:none;`);
      container.appendChild(hoverBox);
      container.appendChild(hoverLabel);
      for (const b of boxPool) container.appendChild(b);
    }
    rootEl.appendChild(container);
  }

  function boxCss(color: string, alpha: number): string {
    return `all:initial;position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid ${color};background:${hexToRgba(color, alpha)};z-index:${Z};`;
  }

  function hexToRgba(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function place(box: HTMLElement, el: Element): boolean {
    const r = rectOf(el);
    if (r.width <= 0 && r.height <= 0) {
      box.style.display = 'none';
      return false;
    }
    box.style.display = 'block';
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${Math.max(r.width, 2)}px`;
    box.style.height = `${Math.max(r.height, 2)}px`;
    return true;
  }

  function layout(): void {
    raf = 0;
    if (!container) return;
    if (hoverBox && hoverLabel) {
      if (hoverTarget && mode !== 'off' && hoverTarget.isConnected && place(hoverBox, hoverTarget)) {
        const r = rectOf(hoverTarget);
        hoverLabel.style.display = 'block';
        const above = r.y > 22;
        hoverLabel.style.left = `${Math.max(0, r.x)}px`;
        hoverLabel.style.top = `${above ? r.y - 20 : r.y + r.height + 2}px`;
      } else {
        hoverBox.style.display = 'none';
        hoverLabel.style.display = 'none';
      }
    }
    highlighted.forEach((el, i) => {
      const box = boxPool[i];
      if (box) {
        if (el.isConnected) place(box, el);
        else box.style.display = 'none';
      }
    });
  }

  function scheduleLayout(): void {
    if (raf) return;
    const w = window as Window & { requestAnimationFrame?: (cb: () => void) => number };
    if (typeof w.requestAnimationFrame === 'function') raf = w.requestAnimationFrame(layout);
    else layout();
  }

  // ---------- events ----------

  function targetOf(ev: Event): Element | null {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const t = (path.length ? path[0] : ev.target) as Node | null;
    if (!t) return null;
    const el = t.nodeType === 1 ? (t as Element) : t.parentElement;
    if (!el || isOverlayNode(el)) return null;
    return el;
  }

  function onMove(ev: MouseEvent): void {
    if (mode === 'off') return;
    const el = targetOf(ev);
    if (!el || el === hoverTarget) return;
    hoverTarget = el;
    if (hoverLabel) {
      const short = shortSelector(el);
      const t = normText(textOf(el, 60));
      hoverLabel.textContent = t ? `${short}  "${t.length > 40 ? t.slice(0, 40) + '…' : t}"` : short;
      hoverLabel.style.background = PICK_COLORS[mode];
      if (hoverBox) {
        hoverBox.style.borderColor = PICK_COLORS[mode];
        hoverBox.style.background = hexToRgba(PICK_COLORS[mode], 0.08);
      }
    }
    scheduleLayout();
    const now = Date.now();
    if (now - lastHoverSent > 120) {
      lastHoverSent = now;
      send({ type: 'hover', selector: shortSelector(el), tag: tagOf(el), text: normText(textOf(el, 200)).slice(0, 120) });
    }
  }

  function swallow(ev: Event): void {
    if (mode === 'off') return;
    if (isOverlayNode(ev.target as Node)) return;
    ev.stopImmediatePropagation();
    ev.stopPropagation();
    ev.preventDefault();
  }

  function onClick(ev: MouseEvent): void {
    if (mode === 'off') return;
    swallow(ev);
    const el = targetOf(ev) || (doc.elementFromPoint ? doc.elementFromPoint(ev.clientX, ev.clientY) : null);
    if (!el || isOverlayNode(el)) return;
    try {
      const picked = deps.describe(el, mode);
      if (!picked) return;
      send({ type: 'picked', element: picked });
      if (mode === 'pickList' && picked.record) send({ type: 'list.detected', list: picked.record });
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function onKey(ev: KeyboardEvent): void {
    if (mode === 'off') return;
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      setMode('off');
      log('mode set to off (Escape)');
    }
  }

  function onScroll(): void {
    if (mode !== 'off' || highlighted.length) scheduleLayout();
  }

  function onNavigate(): void {
    hoverTarget = null;
    clearHighlights();
    ensureAttached();
    send({ type: 'navigated', url: location.href });
  }

  const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend'] as const;

  function attachListeners(): void {
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    for (const t of SWALLOWED) window.addEventListener(t, swallow, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    window.addEventListener('scrappia:navigate', onNavigate);
    patchHistory();
    doc.addEventListener('DOMContentLoaded', ensureAttached);
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => {
        if (container && !container.isConnected) ensureAttached();
      });
      const rootEl = doc.documentElement;
      if (rootEl) observer.observe(rootEl, { childList: true });
    }
  }

  function detachListeners(): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    for (const t of SWALLOWED) window.removeEventListener(t, swallow, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('popstate', onNavigate);
    window.removeEventListener('hashchange', onNavigate);
    window.removeEventListener('scrappia:navigate', onNavigate);
    doc.removeEventListener('DOMContentLoaded', ensureAttached);
    if (observer) observer.disconnect();
  }

  function patchHistory(): void {
    const w = window as WithHistoryPatch;
    if (w.__scrappiaHistoryPatched || !w.history) return;
    w.__scrappiaHistoryPatched = true;
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = w.history[name];
      if (typeof orig !== 'function') continue;
      w.history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
        const r = orig.apply(this, args);
        try {
          w.dispatchEvent(new Event('scrappia:navigate'));
        } catch {
          /* ignore */
        }
        return r;
      };
    }
  }

  // ---------- API ----------

  function setMode(m: InspectorMode): void {
    mode = m === 'pick' || m === 'pickList' || m === 'pickAction' ? m : 'off';
    ensureAttached();
    if (mode === 'off') hoverTarget = null;
    scheduleLayout();
  }

  function clearHighlights(): void {
    highlighted = [];
    for (const b of boxPool) b.style.display = 'none';
  }

  function highlight(selectors: SelectorCandidate[], scope?: SelectorCandidate[]): { count: number; samples: string[]; candidate: number } {
    ensureAttached();
    const scopes: ParentNode[] = scope && scope.length ? queryCandidates(scope, doc).els : [doc];
    const matches: Element[] = [];
    const seen = new Set<Element>();
    let candidate = -1;
    for (const s of scopes) {
      const r = queryCandidates(selectors, s);
      if (!r.els.length) continue;
      if (candidate < 0) candidate = r.candidate;
      for (const el of r.els) {
        if (!seen.has(el) && !isOverlayNode(el)) {
          seen.add(el);
          matches.push(el);
        }
      }
    }
    highlighted = matches.slice(0, MAX_BOXES);
    while (boxPool.length < highlighted.length) {
      const b = doc.createElement('div');
      b.setAttribute(OVERLAY_ATTR, 'box');
      style(b, boxCss(HL_COLOR, 0.12) + 'display:none;');
      boxPool.push(b);
      if (container) container.appendChild(b);
    }
    for (let i = highlighted.length; i < boxPool.length; i++) boxPool[i].style.display = 'none';
    scheduleLayout();
    const samples = matches.slice(0, 5).map((el) => normText(textOf(el, 200)).slice(0, 120));
    const sel = candidate >= 0 ? selectors[candidate]?.value || '' : selectors[0]?.value || '';
    send({ type: 'preview', selector: sel, count: matches.length, samples });
    return { count: matches.length, samples, candidate };
  }

  function destroy(): void {
    destroyed = true;
    detachListeners();
    if (container && container.parentNode) container.parentNode.removeChild(container);
    container = null;
    boxPool = [];
    highlighted = [];
  }

  attachListeners();
  ensureAttached();

  return { setMode, getMode: () => mode, highlight, clearHighlights, ensureAttached, destroy };
}
