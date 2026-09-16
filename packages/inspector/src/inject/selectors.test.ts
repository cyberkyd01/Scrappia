import { describe, it, expect, beforeEach } from 'vitest';
import { generateSelectors, relativeSelector, shortSelector } from './selectors.js';
import { isGeneratedClass, isStableClass, isUtilityClass } from './util.js';
import { queryOne } from './query.js';
import { loadHtml, productGrid } from './fixtures.test-util.js';

function matchesExactly(doc: Document, c: { kind: string; value: string }, el: Element): boolean {
  const els = queryOne(c as { kind: 'css'; value: string }, doc);
  return els.length === 1 && els[0] === el;
}

describe('class classification', () => {
  it('rejects generated / hashed / state classes', () => {
    for (const c of ['css-1x2y3z', 'sc-bdVaJa', '_3kXq9', 'jsx-123', 'btn-3f9a2c', 'xkjqzt', 'styles_title__3xK2z', 'is-active', 'active', 'a1b2c3d4e5']) {
      expect(isGeneratedClass(c), c).toBe(true);
    }
    for (const c of ['product_pod', 'price_color', 'title', 'thumbnail', 'star-rating', 'card-body']) {
      expect(isGeneratedClass(c), c).toBe(false);
    }
  });
  it('flags tailwind / bootstrap utilities as unstable for naming', () => {
    for (const c of ['mt-4', 'px-2', 'flex', 'col-md-3', 'text-center', 'md:flex', 'w-1/2', 'bg-[#fff]', 'd-none']) {
      expect(isUtilityClass(c), c).toBe(true);
      expect(isStableClass(c), c).toBe(false);
    }
    expect(isStableClass('product_pod')).toBe(true);
  });
});

describe('generateSelectors', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 6, generated: true }));
  });

  it('returns 3-5 ranked candidates that each uniquely match the element', () => {
    const el = document.querySelector('article[data-sku="SKU-3"] h3 a')!;
    const cands = generateSelectors(el);
    expect(cands.length).toBeGreaterThanOrEqual(3);
    expect(cands.length).toBeLessThanOrEqual(5);
    for (const c of cands) expect(matchesExactly(document, c, el), `${c.kind} ${c.value}`).toBe(true);
    const scores = cands.map((c) => c.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('prefers a stable id and never uses generated classes', () => {
    const list = document.getElementById('product-list')!;
    const cands = generateSelectors(list);
    expect(cands[0]).toMatchObject({ kind: 'css', value: '#product-list' });
    const article = document.querySelector('article[data-sku="SKU-2"]')!;
    const ac = generateSelectors(article);
    for (const c of ac) {
      expect(c.value).not.toMatch(/css-1x2y3z|sc-bdVaJa|_3kXq9/);
      expect(matchesExactly(document, c, article)).toBe(true);
    }
    // semantic attribute wins over positional selectors
    expect(ac[0].value).toContain('data-sku');
  });

  it('adds a text-anchored xpath for short unique texts', () => {
    const el = document.querySelector('h1.page-title')!;
    const cands = generateSelectors(el);
    const xp = cands.find((c) => c.kind === 'xpath' && c.value.includes('normalize-space()="Books"'));
    expect(xp).toBeTruthy();
    expect(matchesExactly(document, xp!, el)).toBe(true);
  });

  it('ranks nth-child based selectors below semantic ones', () => {
    const el = document.querySelector('article[data-sku="SKU-4"] p.price_color')!;
    const cands = generateSelectors(el);
    const css = cands.filter((c) => c.kind === 'css');
    const nth = css.filter((c) => /nth-/.test(c.value));
    const semantic = css.filter((c) => !/nth-/.test(c.value));
    expect(semantic.length).toBeGreaterThan(0);
    for (const n of nth) for (const s of semantic) expect(s.score!).toBeGreaterThanOrEqual(n.score!);
  });

  it('always produces at least one candidate (positional xpath fallback)', () => {
    const el = document.querySelector('footer p')!;
    const cands = generateSelectors(el);
    expect(cands.length).toBeGreaterThan(0);
    expect(matchesExactly(document, cands[0], el)).toBe(true);
  });

  it('shortSelector gives a compact label', () => {
    expect(shortSelector(document.querySelector('article')!)).toBe('article.product_pod');
    expect(shortSelector(document.getElementById('product-list')!)).toBe('ol#product-list');
  });
});

describe('relativeSelector', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 6, adAt: 3 }));
  });

  it('returns :scope for the record element itself', () => {
    const rec = document.querySelector('article')!;
    expect(relativeSelector(rec, rec)[0]).toMatchObject({ kind: 'css', value: ':scope' });
  });

  it('produces record-relative selectors that generalise across sibling records', () => {
    const records = Array.from(document.querySelectorAll('article.product_pod'));
    const rec = records[1];
    const price = rec.querySelector('p.price_color')!;
    const cands = relativeSelector(price, rec, { records });
    expect(cands.length).toBeGreaterThanOrEqual(2);
    for (const c of cands) {
      const els = queryOne(c, rec);
      expect(els.length, c.value).toBe(1);
      expect(els[0]).toBe(price);
    }
    // best candidate must hit >= 70% of other records
    const best = cands[0];
    const hits = records.filter((r) => queryOne(best, r).length > 0).length;
    expect(hits / records.length).toBeGreaterThanOrEqual(0.7);
    expect(best.value).toMatch(/price_color/);
    expect(best.value).not.toMatch(/nth-/);
  });

  it('prefers generalising selectors over positional ones for nested anchors', () => {
    const records = Array.from(document.querySelectorAll('article.product_pod'));
    const rec = records[0];
    const title = rec.querySelector('h3 a')!;
    const cands = relativeSelector(title, rec, { records });
    expect(cands[0].value).toMatch(/^h3 (> )?a$|^\.?h3|h3/);
    for (const r of records) expect(queryOne(cands[0], r).length).toBe(1);
  });
});
