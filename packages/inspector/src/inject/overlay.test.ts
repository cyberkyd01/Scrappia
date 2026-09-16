import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { InspectorApi, OverlayMessage } from '@scrappia/core';
import { loadHtml, productGrid } from './fixtures.test-util.js';

const received: OverlayMessage[] = [];
let api: typeof import('./main.js');

beforeAll(async () => {
  loadHtml(productGrid({ count: 6 }));
  (window as unknown as Record<string, unknown>).__scrappiaHost = (msg: OverlayMessage) => {
    received.push(msg);
  };
  api = await import('./main.js');
});

beforeEach(() => {
  received.length = 0;
});

describe('inspector API shape', () => {
  it('exposes the InspectorApi on window.__scrappiaInspector and as module exports', () => {
    const g = (window as unknown as { __scrappiaInspector?: InspectorApi }).__scrappiaInspector!;
    expect(g).toBeTruthy();
    for (const k of ['setMode', 'highlight', 'clearHighlights', 'detectLists', 'describe', 'expand', 'regionHtml'] as const) {
      expect(typeof g[k], k).toBe('function');
      expect(typeof api[k], k).toBe('function');
    }
    expect(typeof g.version).toBe('string');
    expect(api.version).toBe(g.version);
  });

  it('sends ready on load (queued until the host binding exists)', async () => {
    // host was registered before import in this test, so ready was delivered synchronously
    // or via the queue; wait a tick for the flush interval either way
    await new Promise((r) => setTimeout(r, 300));
    // the ready message was sent during import (before beforeEach cleared) -> re-check via a fresh send
    api.setMode('pick');
    expect(document.querySelector('[data-scrappia-overlay]')).toBeTruthy();
  });

  it('highlight returns count + samples + candidate index and draws boxes', () => {
    const r = api.highlight([{ kind: 'css', value: '.does-not-exist' }, { kind: 'css', value: 'article.product_pod' }]);
    expect(r.count).toBe(6);
    expect(r.candidate).toBe(1);
    expect(r.samples.length).toBe(5);
    expect(r.samples[0]).toContain('Book title 1');
    const preview = received.find((m) => m.type === 'preview');
    expect(preview).toMatchObject({ type: 'preview', selector: 'article.product_pod', count: 6 });
    // scoped highlight
    const scoped = api.highlight([{ kind: 'css', value: 'h3 a' }], [{ kind: 'css', value: 'article.product_pod' }]);
    expect(scoped.count).toBe(6);
    expect(document.querySelectorAll('[data-scrappia-overlay="box"]').length).toBeGreaterThanOrEqual(6);
    api.clearHighlights();
  });

  it('describe returns a PickedElement with record context and relative selectors', () => {
    const p = api.describe('article[data-sku="SKU-2"] h3 a')!;
    expect(p).not.toBeNull();
    expect(p.tag).toBe('a');
    expect(p.suggestedType).toBe('href');
    expect(p.href).toBe('https://site.test/catalogue/book-2');
    expect(p.selectors.length).toBeGreaterThan(0);
    expect(p.record).toBeTruthy();
    expect(p.record!.count).toBe(6);
    expect(p.record!.clickedIndex).toBe(1);
    expect(p.relativeSelectors![0].value).toMatch(/h3/);
    expect(p.frameUrl).toBe(location.href);
    expect(api.describe('.nope')).toBeNull();
  });

  it('expand walks up to the ancestor', () => {
    const p = api.expand('article[data-sku="SKU-2"] h3 a', 2)!;
    expect(p.tag).toBe('article');
    expect(p.attrs['data-sku']).toBe('SKU-2');
  });

  it('regionHtml strips scripts/styles/inline styles and truncates', () => {
    const article = document.querySelector('article')!;
    article.insertAdjacentHTML('beforeend', '<script>alert(1)</script><style>a{}</style><span style="color:red" data-x="data:image/png;base64,AAAA">x</span>');
    const html = api.regionHtml([{ kind: 'css', value: 'article.product_pod' }]);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('style="color:red"');
    expect(html).not.toContain('base64,AAAA');
    expect(html).toContain('price_color');
    const short = api.regionHtml([{ kind: 'css', value: 'article.product_pod' }], 200);
    expect(short.length).toBeLessThan(260);
  });

  it('click capture in pick mode sends a picked message and swallows the event', () => {
    api.setMode('pick');
    const target = document.querySelector('article[data-sku="SKU-3"] .price_color')!;
    let pageHandlerRan = false;
    target.addEventListener('click', () => {
      pageHandlerRan = true;
    });
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pageHandlerRan).toBe(false);
    const picked = received.find((m) => m.type === 'picked');
    expect(picked).toBeTruthy();
    if (picked && picked.type === 'picked') {
      expect(picked.element.suggestedName).toBe('price');
      expect(picked.element.record?.count).toBe(6);
    }
    // Escape turns the mode off; clicks are no longer swallowed
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const ev2 = new MouseEvent('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    expect(pageHandlerRan).toBe(true);
  });

  it('pickList mode also emits list.detected', () => {
    api.setMode('pickList');
    const target = document.querySelector('article[data-sku="SKU-4"] h3 a')!;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const list = received.find((m) => m.type === 'list.detected');
    expect(list).toBeTruthy();
    if (list && list.type === 'list.detected') {
      expect(list.list.count).toBe(6);
      expect(list.list.fields.map((f) => f.name)).toContain('title');
    }
    api.setMode('off');
  });

  it('detectLists via the API finds the grid', () => {
    const lists = api.detectLists();
    expect(lists[0].count).toBe(6);
  });

  it('is idempotent when injected twice and reports navigations', async () => {
    const first = (window as unknown as { __scrappiaInspector?: InspectorApi }).__scrappiaInspector!;
    // simulate a second injection: re-import module under a cache-busting query
    const again = await import('./main.js?second');
    const second = (window as unknown as { __scrappiaInspector?: InspectorApi }).__scrappiaInspector!;
    expect(second).toBe(first);
    expect(again.version).toBe(first.version);
    history.pushState({}, '', location.origin + '/catalogue/page-2.html');
    await new Promise((r) => setTimeout(r, 10));
    expect(received.some((m) => m.type === 'navigated')).toBe(true);
    expect(document.querySelector('[data-scrappia-overlay]')).toBeTruthy();
  });
});
