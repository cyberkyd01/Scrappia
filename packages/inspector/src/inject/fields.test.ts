import { describe, it, expect, beforeEach } from 'vitest';
import { inferFields, suggestForElement, nameForElement } from './fields.js';
import { queryOne } from './query.js';
import { amazonResults, loadHtml, productGrid } from './fixtures.test-util.js';

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

  it('does not propose the same value twice (heading text vs its anchor, url vs image link)', () => {
    const records = Array.from(document.querySelectorAll('article.product_pod'));
    const fields = inferFields(records);
    const samples = fields.map((f) => f.type + ':' + f.samples.join('|'));
    expect(new Set(samples).size).toBe(samples.length);
    expect(fields.filter((f) => f.type === 'href').length).toBe(1);
  });

  it('uses table headers for row records', () => {
    loadHtml(`<html><body><table id="t"><thead><tr><th>Name</th><th>Unit Price</th></tr></thead><tbody>
      <tr><td>A</td><td>$1</td></tr><tr><td>B</td><td>$2</td></tr><tr><td>C</td><td>$3</td></tr></tbody></table></body></html>`);
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    const fields = inferFields(rows);
    expect(fields.map((f) => f.name)).toEqual(['name', 'unit_price']);
  });
});

describe('inferFields on Amazon-like search results', () => {
  beforeEach(() => {
    loadHtml(amazonResults(), 'https://www.amazon.com/s?k=wireless+headphones');
  });
  const records = () => Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));

  it('proposes title (heading), price (hidden .a-offscreen), url and image with coverage >= 0.8', () => {
    const recs = records();
    expect(recs.length).toBe(12);
    const fields = inferFields(recs);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title, JSON.stringify(fields.map((f) => f.name))).toBeTruthy();
    expect(byName.title.type).toBe('text');
    expect(byName.title.coverage).toBeGreaterThanOrEqual(0.8);
    expect(byName.title.samples[0]).toMatch(/^Wireless Headphones \d+ Bluetooth Over Ear$/);
    expect(byName.price).toBeTruthy();
    expect(byName.price.coverage).toBeGreaterThanOrEqual(0.8);
    expect(byName.price.samples[0]).toMatch(/^\$\d+\.99$/);
    expect(byName.url).toBeTruthy();
    expect(byName.url.type).toBe('href');
    expect(byName.url.samples[0]).toMatch(/^https:\/\/www\.amazon\.com\/dp\/B0\d+$/);
    expect(byName.image).toBeTruthy();
    expect(byName.image.type).toBe('src');
    expect(byName.image.samples[0]).toMatch(/\/img\d+\.jpg$/);
    // the four core fields come first (sorted by coverage) and no wrapper junk is proposed
    expect(fields.slice(0, 4).map((f) => f.name).sort()).toEqual(['image', 'price', 'title', 'url']);
    expect(fields.some((f) => /container|wrapper|widget|inner|^col_|^row$|^grid$/.test(f.name))).toBe(false);
    expect(fields.some((f) => f.samples[0] === 'Sponsored')).toBe(false);
    // every selector resolves in the records it claims to cover
    for (const f of fields) {
      const hits = recs.filter((r) => queryOne(f.selector[0], r).length > 0).length;
      expect(hits / recs.length, `${f.name} ${f.selector[0].value}`).toBeGreaterThanOrEqual(f.coverage - 0.01);
    }
  });

  it('the hidden price wins over the visible split spans and the wrapping link text', () => {
    const recs = records();
    const fields = inferFields(recs);
    const price = fields.find((f) => f.name === 'price')!;
    const rec = recs[0];
    const el = queryOne(price.selector[0], rec)[0];
    expect(el).toBeTruthy();
    expect(el.classList.contains('a-offscreen')).toBe(true);
    expect(el.closest('.a-text-price')).toBeNull();
    // the "$29.99$29.99" link text that merely contains the price is not proposed
    expect(fields.some((f) => /^\$\d+\.99\$\d+\.99/.test(f.samples[0]))).toBe(false);
    // the strike-through list price is a separate, labelled field
    const listPrice = fields.find((f) => f.name === 'list_price');
    expect(listPrice?.samples[0]).toMatch(/^\$\d+\.99$/);
    expect(listPrice!.coverage).toBeLessThan(price.coverage);
  });

  it('still finds title, price, url and image when cards nest deeply and the link wraps the heading', () => {
    loadHtml(amazonResults({ deep: true, linkWrapsHeading: true }), 'https://www.amazon.com/s?k=wireless+headphones');
    const recs = records();
    const priceEl = recs[0].querySelector('.a-price .a-offscreen')!;
    let depth = 0;
    for (let c: Element | null = priceEl; c && c !== recs[0]; c = c.parentElement) depth++;
    expect(depth).toBeGreaterThanOrEqual(16);
    const fields = inferFields(recs);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title?.samples[0]).toMatch(/^Wireless Headphones \d+ Bluetooth Over Ear$/);
    expect(byName.price?.samples[0]).toMatch(/^\$\d+\.99$/);
    expect(byName.price.coverage).toBeGreaterThanOrEqual(0.8);
    // the primary url is the link wrapping the heading, not the image link
    expect(byName.url?.type).toBe('href');
    expect(queryOne(byName.url.selector[0], recs[0])[0].querySelector('h2')).toBeTruthy();
    expect(byName.image?.type).toBe('src');
    // the celwidget div (an inline span smuggling block content) is not proposed as one text blob
    expect(fields.some((f) => /celwidget/.test(f.name))).toBe(false);
    expect(fields.every((f) => f.samples[0].length < 120)).toBe(true);
  });

  it('joins split whole/fraction spans into one price when there is no hidden copy', () => {
    loadHtml(`<html><body><ul id="l">${[1, 2, 3, 4].map((i) => `<li class="offer"><h3>Offer ${i}</h3><div class="cost"><span class="cost-symbol">€</span><span class="cost-whole">1${i}</span><span class="cost-fraction">50</span></div></li>`).join('')}</ul></body></html>`);
    const recs = Array.from(document.querySelectorAll('li.offer'));
    const fields = inferFields(recs);
    const price = fields.find((f) => f.name === 'price')!;
    expect(price).toBeTruthy();
    expect(price.samples).toEqual(['€11.50', '€12.50', '€13.50']);
    expect(queryOne(price.selector[0], recs[0])[0].classList.contains('cost')).toBe(true);
    expect(fields.find((f) => f.name === 'title')?.samples[0]).toBe('Offer 1');
  });

  it('uses the heading aria-label as title when the heading has no text and the longest anchor text without a heading', () => {
    loadHtml(`<html><body><div id="l">${[1, 2, 3].map((i) => `<div class="card"><h2 aria-label="Item ${i} label"></h2><a href="/i${i}">go</a><a href="/i${i}/full">Full item ${i} name</a></div>`).join('')}</div>
      <div id="m">${[1, 2, 3].map((i) => `<div class="tile"><a href="/t${i}">Go</a><a class="name" href="/t${i}">Tile number ${i}</a><span class="meta">meta ${i}</span></div>`).join('')}</div></body></html>`);
    const cards = Array.from(document.querySelectorAll('.card'));
    expect(inferFields(cards).find((f) => f.name === 'title')?.samples[0]).toBe('Item 1 label');
    const tiles = Array.from(document.querySelectorAll('.tile'));
    const t = inferFields(tiles).find((f) => f.name === 'title')!;
    expect(t.samples[0]).toBe('Tile number 1');
    expect(queryOne(t.selector[0], tiles[0])[0].classList.contains('name')).toBe(true);
  });

  it('drops wrapper-named fields that repeat the whole record text', () => {
    loadHtml(`<html><body><div id="l">${[1, 2, 3, 4].map((i) => `<div class="entry"><div class="s-widget-container"><span class="name">Name ${i}</span> <span class="qty">${i} pcs</span></div></div>`).join('')}</div></body></html>`);
    const recs = Array.from(document.querySelectorAll('.entry'));
    const fields = inferFields(recs);
    expect(fields.map((f) => f.name)).toEqual(['name', 'qty']);
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
