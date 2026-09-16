import { describe, it, expect, beforeEach } from 'vitest';
import { detectListFromElement, detectLists, scanLists, signatureOf, similarity, toDetectedList } from './listDetect.js';
import { queryOne } from './query.js';
import { loadHtml, productGrid } from './fixtures.test-util.js';

describe('signatures', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 5, adAt: 2 }));
  });
  it('product cards are similar to each other and dissimilar to the ad card', () => {
    const lis = Array.from(document.querySelectorAll('#product-list > li'));
    const a = signatureOf(lis[0]);
    const b = signatureOf(lis[2]);
    const ad = signatureOf(document.querySelector('li.ad-slot')!);
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.8);
    expect(similarity(a, ad)).toBeLessThan(0.8);
  });
});

describe('detectListFromElement (click-based)', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 8, adAt: 4 }));
  });

  it('finds the product list from a click on a title and skips the ad card', () => {
    const clicked = document.querySelector('article[data-sku="SKU-5"] h3 a')!;
    const det = detectListFromElement(clicked);
    expect(det).not.toBeNull();
    expect(det!.records.length).toBe(8);
    expect(det!.records.every((r) => r.matches('article.product_pod'))).toBe(true);
    expect(det!.records[det!.clickedIndex].contains(clicked)).toBe(true);
    expect(det!.clickedIndex).toBe(4);
    const list = toDetectedList(det!);
    expect(list.count).toBe(8);
    expect(list.selector[0].value).not.toMatch(/nth-child/);
    const matched = queryOne(list.selector[0], document);
    expect(matched.length).toBe(8);
    expect(matched.some((m) => m.closest('.ad-slot'))).toBe(false);
    expect(list.containerSelector).toBeTruthy();
    expect(list.alternatives).toBeTruthy();
    for (const alt of list.alternatives!) expect(alt.selector[0].value).not.toBe(list.selector[0].value);
  });

  it('does not pick the tiny star-icon list when clicking a star', () => {
    const star = document.querySelector('article[data-sku="SKU-2"] .star-rating i')!;
    const det = detectListFromElement(star)!;
    expect(det).not.toBeNull();
    expect(det.records[0].matches('article.product_pod')).toBe(true);
    expect(det.records.length).toBe(8);
  });

  it('returns null for an element that is not part of a list', () => {
    expect(detectListFromElement(document.querySelector('h1.page-title')!)).toBeNull();
    expect(detectListFromElement(document.querySelector('#sidebar .promo')!)).toBeNull();
  });
});

describe('whole-page scan / detectLists', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 8, adAt: 4 }));
  });

  it('ranks the product grid first (count * size, text-length fallback without layout)', () => {
    const cands = scanLists(document);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0].records.length).toBe(8);
    expect(cands[0].records[0].matches('article.product_pod')).toBe(true);
    // nested per-record star icon lists are deduped away
    expect(cands.some((c) => c.records[0].matches('i.icon-star'))).toBe(false);
  });

  it('detectLists returns up to 5 lists with fields and alternatives', () => {
    const lists = detectLists(document);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.length).toBeLessThanOrEqual(5);
    const top = lists[0];
    expect(top.count).toBe(8);
    expect(top.fields.length).toBeGreaterThan(0);
    const names = top.fields.map((f) => f.name);
    expect(names).toContain('title');
    expect(names).toContain('price');
    const menu = lists.find((l) => l.selector[0].value.includes('menu'));
    expect(menu?.count).toBe(3);
  });
});
