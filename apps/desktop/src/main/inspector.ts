/**
 * Loads the in-page inspector overlay bundle from `@scrappia/inspector` (built separately).
 * When the package is not built yet, falls back to a stub overlay that only reports `ready`
 * so the recorder still works as a plain browser.
 */
import { INSPECTOR_BINDING, INSPECTOR_GLOBAL } from '@scrappia/core';

let cached: { source: string; stub: boolean } | undefined;

export async function loadInspectorBundle(): Promise<{ source: string; stub: boolean }> {
  if (cached) return cached;
  try {
    const modName = '@scrappia/inspector';
    const mod = (await import(/* @vite-ignore */ modName)) as { getInspectorBundle?: () => string };
    if (typeof mod.getInspectorBundle === 'function') {
      const source = mod.getInspectorBundle();
      if (typeof source === 'string' && source.length > 0) {
        cached = { source, stub: false };
        return cached;
      }
    }
    throw new Error('getInspectorBundle() not exported');
  } catch (e) {
    console.warn('[scrappia] inspector bundle unavailable, using stub overlay:', (e as Error).message);
    cached = { source: stubBundle(), stub: true };
    return cached;
  }
}

/** Minimal overlay honouring the protocol surface so host calls never throw. */
function stubBundle(): string {
  return `(() => {
  if (window.${INSPECTOR_GLOBAL}) return;
  const send = (m) => { try { window.${INSPECTOR_BINDING} && window.${INSPECTOR_BINDING}(m); } catch (e) {} };
  const q = (c) => {
    try {
      if (c.kind === 'xpath' || (c.kind === 'auto' && /^(\\/|\\.\\/|\\(\\/)/.test(c.value))) {
        const r = document.evaluate(c.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = []; for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i)); return out;
      }
      return Array.from(document.querySelectorAll(c.value));
    } catch (e) { return []; }
  };
  window.${INSPECTOR_GLOBAL} = {
    version: 'stub',
    setMode() {},
    highlight(selectors) {
      for (let i = 0; i < selectors.length; i++) { const els = q(selectors[i]); if (els.length) return { count: els.length, samples: els.slice(0, 5).map((e) => (e.textContent || '').trim().slice(0, 80)), candidate: i }; }
      return { count: 0, samples: [], candidate: -1 };
    },
    clearHighlights() {},
    detectLists() { return []; },
    describe() { return null; },
    expand() { return null; },
    regionHtml(selectors, maxChars) { const els = selectors.length ? q(selectors[0]) : []; const h = els.length ? els[0].outerHTML : document.body.outerHTML; return h.slice(0, maxChars || 20000); },
  };
  const ready = () => send({ type: 'ready', url: location.href, frameUrl: location.href });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();`;
}
