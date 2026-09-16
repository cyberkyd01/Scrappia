import { describe, it, expect } from 'vitest';
import { extractFromHtml, looksLikeBrowserRequired } from './jsdom.js';

const HTML = `<html><head><title>T</title></head><body>
<ul id="list">
  <li class="item" data-id="1"><a href="/p/1">One</a><span class="price">$1.00</span><img data-src="/i/1.jpg" src="data:x"><b>Email:</b> a@b.com</li>
  <li class="item" data-id="2"><a href="/p/2">Two</a><span class="price">$2.00</span><img src="/i/2.jpg" srcset="/i/2-small.jpg 100w, /i/2-large.jpg 800w"></li>
  <li class="item" data-id="3"><a href="/p/3">Three</a></li>
</ul>
<div class="detail"><h1>Title</h1><dl><dt>SKU</dt><dd>ABC-1</dd></dl><span class="label">Weight</span> 2kg</div>
<table id="t"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>
<script type="application/ld+json">{"name":"LD","price":9}</script>
<a class="next" href="?page=2">Next</a>
</body></html>`;
const URL_ = 'https://site.test/list?page=1';

describe('domExtract (jsdom)', () => {
  it('extracts list records with all field types', () => {
    const r = extractFromHtml(HTML, URL_, {
      fields: [],
      list: {
        selector: [{ kind: 'css', value: '.item' }],
        fields: [
          { name: 'name', type: 'text', selector: [{ kind: 'css', value: 'a' }] },
          { name: 'url', type: 'href', selector: [{ kind: 'css', value: 'a' }] },
          { name: 'price', type: 'text', selector: [{ kind: 'css', value: '.price' }] },
          { name: 'img', type: 'src', selector: [{ kind: 'css', value: 'img' }] },
          { name: 'id', type: 'attr', attr: 'data-id', selector: [{ kind: 'css', value: ':scope' }] },
          { name: 'email', type: 'email', selector: [{ kind: 'css', value: ':scope' }] },
          { name: 'has_price', type: 'exists', selector: [{ kind: 'css', value: '.price' }] },
          { name: 'links', type: 'count', selector: [{ kind: 'css', value: 'a' }] },
          { name: 'digits', type: 'regex', pattern: '\\$(\\d+)', selector: [{ kind: 'css', value: '.price' }] },
        ],
      },
    });
    expect(r.listMatch).toEqual({ candidate: 0, matched: 3 });
    expect(r.records).toHaveLength(3);
    expect(r.records[0]).toMatchObject({ name: 'One', url: 'https://site.test/p/1', price: '$1.00', img: 'https://site.test/i/1.jpg', id: '1', email: 'a@b.com', has_price: true, links: 1, digits: '1' });
    expect(r.records[1].img).toBe('https://site.test/i/2-large.jpg');
    expect(r.records[2]).toMatchObject({ price: null, has_price: false, digits: null, email: null });
  });

  it('falls through selector candidates and reports which matched', () => {
    const r = extractFromHtml(HTML, URL_, { fields: [{ name: 'h', type: 'text', selector: [{ kind: 'css', value: '.does-not-exist' }, { kind: 'css', value: 'h1' }] }] });
    expect(r.page.h).toBe('Title');
    expect(r.fieldMatches.h.candidate).toBe(1);
  });

  it('supports xpath, text (following) and json/table types', () => {
    const r = extractFromHtml(HTML, URL_, {
      fields: [
        { name: 'sku', type: 'text', selector: [{ kind: 'xpath', value: '//dt[text()="SKU"]/following-sibling::dd' }] },
        { name: 'weight', type: 'text', following: true, selector: [{ kind: 'text', value: 'Weight' }] },
        { name: 'ld', type: 'json', selector: [{ kind: 'css', value: 'script[type="application/ld+json"]' }] },
        { name: 'table', type: 'table', selector: [{ kind: 'css', value: '#t' }] },
        { name: 'title', type: 'pageTitle' },
        { name: 'const', type: 'constant', value: 'C' },
        { name: 'url', type: 'pageUrl' },
      ],
      probes: [{ id: 'next', selector: [{ kind: 'css', value: 'a.next' }] }],
    });
    expect(r.page.sku).toBe('ABC-1');
    expect(r.page.weight).toBe('2kg');
    expect(r.page.ld).toEqual({ name: 'LD', price: 9 });
    expect(r.page.table).toEqual([{ A: '1', B: '2' }, { A: '3', B: '4' }]);
    expect(r.page.title).toBe('T');
    expect(r.page.const).toBe('C');
    expect(r.page.url).toBe(URL_);
    expect(r.probes.next).toEqual({ exists: true, hrefs: ['https://site.test/list?page=2'], count: 1 });
  });

  it('multiple + ancestor + document scope', () => {
    const r = extractFromHtml(HTML, URL_, {
      fields: [],
      list: { selector: [{ kind: 'css', value: '.item' }], fields: [
        { name: 'all_names', type: 'text', multiple: true, scope: 'document', selector: [{ kind: 'css', value: '.item a' }] },
        { name: 'parent_html', type: 'attr', attr: 'id', ancestor: 1, selector: [{ kind: 'css', value: ':scope' }] },
      ] },
    });
    expect(r.records[0].all_names).toEqual(['One', 'Two', 'Three']);
    expect(r.records[0].parent_html).toBe('list');
  });

  it('detects pages that need a browser', () => {
    expect(looksLikeBrowserRequired('<html><body><div id="root"></div><script src="app.js"></script></body></html>').required).toBe(true);
    expect(looksLikeBrowserRequired('<title>Just a moment...</title>').reason).toBe('cloudflare-challenge');
    expect(looksLikeBrowserRequired(HTML).required).toBe(false);
  });
});
