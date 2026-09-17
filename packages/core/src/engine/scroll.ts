/**
 * Scrolling that works on real sites.
 *
 * `window.scrollTo` moves nothing on the many pages whose body is fixed and whose content lives in
 * an inner element with `overflow: auto` (app shells, dashboards, most single-page marketplaces).
 * These helpers find the element that actually scrolls and drive that one, falling back to the
 * document. The chosen element is remembered per frame so repeated steps stay cheap.
 */
import type { Frame, Page } from '../browser/provider.js';

export interface ScrollState {
  /** current scroll offset of the scrolling element */
  top: number;
  /** total scrollable height */
  height: number;
  /** visible height */
  client: number;
  /** a human label for the element that scrolls ("document" or "div.list") */
  target: string;
  /** did this call actually move the page? */
  moved: boolean;
  /** is the scroller at (or within a few pixels of) the bottom? */
  atBottom: boolean;
}

export type ScrollMode = 'bottom' | 'step' | 'probe';

/**
 * Scroll the page (or its inner scroll container) and report what happened.
 * `probe` only measures. Runs in the page's isolated world: it needs the DOM, not page globals.
 */
export async function scrollPage(scope: Page | Frame, mode: ScrollMode = 'bottom', step?: number): Promise<ScrollState> {
  return scope.evaluate(({ mode, step }: { mode: ScrollMode; step?: number }): ScrollState => {
    const w = window as unknown as { __scrappiaScroller?: HTMLElement };
    const scrolls = (el: Element | null | undefined): el is HTMLElement =>
      !!el && (el as HTMLElement).isConnected && el.scrollHeight > el.clientHeight + 8;
    const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement;

    let el: HTMLElement | undefined = w.__scrappiaScroller && scrolls(w.__scrappiaScroller) ? w.__scrappiaScroller : undefined;
    if (!el) {
      if (scrolls(doc)) el = doc;
      else {
        // the biggest visible element that can scroll vertically
        let bestArea = 0;
        const all = document.querySelectorAll<HTMLElement>('body *');
        for (let i = 0; i < all.length && i < 6000; i++) {
          const cand = all[i];
          if (!scrolls(cand)) continue;
          const style = getComputedStyle(cand);
          if (!/(auto|scroll|overlay)/.test(style.overflowY)) continue;
          const r = cand.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; el = cand; }
        }
      }
      if (el && el !== doc) w.__scrappiaScroller = el;
    }
    const target = el ?? doc;
    const before = target.scrollTop;
    if (mode !== 'probe') {
      const delta = step ?? Math.max(200, target.clientHeight * 0.9);
      target.scrollTop = mode === 'bottom' ? target.scrollHeight : target.scrollTop + delta;
      // some sites paginate on the window's scroll event even when an inner element moves
      try { window.scrollTo(0, mode === 'bottom' ? document.documentElement.scrollHeight : window.scrollY + delta); } catch { /* ignore */ }
      // and some listen for the wheel/scroll event itself
      try { target.dispatchEvent(new Event('scroll', { bubbles: true })); } catch { /* ignore */ }
    }
    const name = target === doc ? 'document' : `${target.tagName.toLowerCase()}${target.className ? '.' + String(target.className).trim().split(/\s+/)[0] : ''}`;
    return {
      top: target.scrollTop, height: target.scrollHeight, client: target.clientHeight, target: name,
      moved: target.scrollTop !== before,
      atBottom: target.scrollTop + target.clientHeight >= target.scrollHeight - 8,
    };
  }, { mode, step });
}

/** Scroll to the bottom repeatedly until nothing new loads. Returns the number of steps taken. */
export async function scrollToEnd(scope: Page | Frame, opts: { maxSteps?: number; delayMs?: number; onStep?: (s: ScrollState) => void; signal?: AbortSignal } = {}): Promise<number> {
  const max = opts.maxSteps ?? 30;
  let stable = 0;
  let last = await scrollPage(scope, 'probe');
  for (let i = 0; i < max; i++) {
    if (opts.signal?.aborted) break;
    const s = await scrollPage(scope, 'bottom');
    opts.onStep?.(s);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 800));
    const now = await scrollPage(scope, 'probe');
    if (now.height === last.height && now.top === s.top) { if (++stable >= 2) return i + 1; } else stable = 0;
    last = now;
  }
  return max;
}
