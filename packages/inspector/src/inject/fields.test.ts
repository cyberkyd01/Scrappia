import { describe, it, expect, beforeEach } from 'vitest';
import { inferFields, suggestForElement, nameForElement } from './fields.js';
import { queryOne } from './query.js';
import { loadHtml, productGrid } from './fixtures.test-util.js';

describe('inferFields', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 8, adAt: 3 }));
  });

  it('detects title / price / url / image with coverage and samples', () => {
    const records = Array.from(document.querySelectorAll('article.product_pod'));
    const fields = inferFields(records);
    expect(fields.length).toBeGreaterThanOrEqual(4);
    expect(fields.length).toBeLessThanOrEqual(15);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    expect(byName.title).toBeTruthy();
    expect(byName.title.type).toBe('text');
    expect(byName.title.coverage).toBe(1);
    expect(byName.title.samples[0]).toMatch(/^Book title \d/);

    expect(byName.price).toBeTruthy();
    expect(byName.price.samples[0]).toMatch(/^£\d/);
    expect(byName.price.coverage).toBe(1);

    expect(byName.url).toBeTruthy();
    expect(byName.url.type).toBe('href');
    expect(byName.url.samples[0]).toMatch(/^https:\/\/site\.test\/catalogue\/book-\d/);

    expect(byName.image).toBeTruthy();
    expect(byName.image.type).toBe('src');
    expect(byName.image.samples[0]).toMatch(/\/media\/book-\d\.jpg$/);

    expect(byName.date).toBeTruthy();
    expect(byName.author).toBeTruthy();

    // boilerplate is skipped
    expect(fields.some((f) => f.samples.includes('In stock'))).toBe(false);
    expect(fields.some((f) => f.samples.includes('Add to basket'))).toBe(false);

    // every field selector resolves inside the records it claims to cover
    for (const f of fields) {
      const hits = records.filter((r) => queryOne(f.selector[0], r).length > 0).length;
      expect(hits / records.length, f.name).toBeGreaterThanOrEqual(f.coverage - 0.01);
      expect(f.selector[0].value).not.toMatch(/nth-/);
    }
    // sorted by coverage desc
    const cov = fields.map((f) => f.coverage);
    expect([...cov].sort((a, b) => b - a)).toEqual(cov);
  });

  it('uses table headers for row records', () => {
    loadHtml(`<html><body><table id="t"><thead><tr><th>Name</th><th>Unit Price</th></tr></thead><tbody>
      <tr><td>A</td><td>$1</td></tr><tr><td>B</td><td>$2</td></tr><tr><td>C</td><td>$3</td></tr></tbody></table></body></html>`);
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const fields = inferFields(rows);
    expect(fields.map((f) => f.name)).toEqual(['name', 'unit_price']);
  });
});

describe('suggestForElement', () => {
  beforeEach(() => {
    loadHtml(productGrid({ count: 4 }));
  });
  it('types anchors, images, prices, inputs and dates', () => {
    const rec = document.querySelector('article')!;
    expect(suggestForElement(rec.querySelector('h3 a')!, rec)).toMatchObject({ type: 'href', name: 'book_title_1' });
    expect(suggestForElement(rec.querySelector('img')!, rec)).toMatchObject({ type: 'src', name: 'image' });
    expect(suggestForElement(rec.querySelector('.price_color')!, rec)).toMatchObject({ type: 'text', name: 'price' });
    expect(suggestForElement(rec.querySelector('time')!, rec)).toMatchObject({ type: 'text', name: 'date' });
    expect(suggestForElement(rec.querySelector('.author')!, rec)).toMatchObject({ type: 'text', name: 'author' });
    const input = document.createElement('input');
    input.name = 'searchQuery';
    document.body.appendChild(input);
    expect(suggestForElement(input)).toMatchObject({ type: 'attr', attr: 'value', name: 'search_query' });
    const mail = document.createElement('span');
    mail.textContent = 'Contact: someone@example.com';
    document.body.appendChild(mail);
    expect(suggestForElement(mail)).toMatchObject({ type: 'email', name: 'email' });
    const empty = document.createElement('a');
    empty.href = '/x';
    document.body.appendChild(empty);
    expect(suggestForElement(empty)).toMatchObject({ type: 'href', name: 'url' });
  });
  it('nameForElement derives snake_case names from headings / classes', () => {
    const rec = document.querySelector('article')!;
    expect(nameForElement(rec.querySelector('h3 a')!, rec)).toBe('title');
    expect(nameForElement(rec.querySelector('.price_color')!, rec)).toBe('price_color');
  });
});
