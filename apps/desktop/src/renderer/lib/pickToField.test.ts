import { describe, it, expect } from 'vitest';
import type { PickedElement, DetectedList } from '@scrappia/core';
import { pickToField, selectorsFor, suggestFieldName, suggestedToFields, defaultTransformsFor } from './pickToField';

const picked: PickedElement = {
  selectors: [{ kind: 'css', value: '.card:nth-child(2) .price', score: 0.6 }, { kind: 'xpath', value: '//div[2]/span', score: 0.9 }],
  relativeSelectors: [{ kind: 'css', value: '.price', score: 0.95 }, { kind: 'css', value: 'span.p', score: 0.5 }],
  tag: 'span', text: '$ 19.99', html: '<span class="price">$ 19.99</span>', attrs: { class: 'price', 'data-sku': 'A1' },
  rect: { x: 0, y: 0, width: 10, height: 10 }, suggestedType: 'text', suggestedName: 'Price', frameUrl: 'https://x.test/',
  record: { selector: [{ kind: 'css', value: '.card' }], count: 12, clickedIndex: 1, fields: [] },
};

describe('pickToField', () => {
  it('uses relative selectors sorted by score for record scope', () => {
    const sel = selectorsFor(picked, 'record');
    expect(sel.map((s) => s.value)).toEqual(['.price', 'span.p']);
    const doc = selectorsFor(picked, 'document');
    expect(doc.map((s) => s.value)).toEqual(['//div[2]/span', '.card:nth-child(2) .price']);
  });

  it('builds a record field with a snake_case name and currency transform', () => {
    const f = pickToField(picked, { name: 'Price', type: 'text', scope: 'record' });
    expect(f).toMatchObject({ name: 'price', type: 'text', scope: 'record', multiple: false, required: false });
    expect(f.selector?.[0].value).toBe('.price');
    expect(f.transforms).toEqual([{ type: 'currency' }]);
  });

  it('honours the preferred candidate and attr choice', () => {
    const f = pickToField(picked, { name: 'sku', type: 'attr', attr: 'data-sku', scope: 'record', preferredCandidate: 1 });
    expect(f.selector?.map((s) => s.value)).toEqual(['span.p', '.price']);
    expect(f.attr).toBe('data-sku');
    expect(f.transforms).toEqual([]);
  });

  it('falls back to a suggested name and first attribute', () => {
    expect(suggestFieldName(picked)).toBe('price');
    const f = pickToField({ ...picked, suggestedName: '' }, { name: '', type: 'attr', scope: 'document' });
    expect(f.name).toBe('span');
    expect(f.attr).toBe('class');
    expect(f.scope).toBe('document');
  });

  it('keeps explicit transforms and ancestor', () => {
    const f = pickToField(picked, { name: 'p', type: 'text', scope: 'document', transforms: [{ type: 'trim' }], ancestor: 2, multiple: true });
    expect(f.transforms).toEqual([{ type: 'trim' }]);
    expect(f.ancestor).toBe(2);
    expect(f.multiple).toBe(true);
  });

  it('converts detected list suggestions into fields with unique names', () => {
    const list: DetectedList = {
      selector: [{ kind: 'css', value: '.card' }], count: 3, clickedIndex: 0,
      fields: [
        { name: 'Title', type: 'text', selector: [{ kind: 'css', value: 'h3' }], samples: ['A'], coverage: 1 },
        { name: 'title', type: 'href', selector: [{ kind: 'css', value: 'a' }], samples: ['https://x'], coverage: 1 },
        { name: 'img', type: 'attr', attr: 'data-src', selector: [{ kind: 'css', value: 'img' }], samples: [], coverage: 0.5 },
      ],
    };
    const fields = suggestedToFields(list);
    expect(fields.map((f) => f.name)).toEqual(['title', 'title_2', 'img']);
    expect(fields[2].attr).toBe('data-src');
    const kept = suggestedToFields(list, new Set(['img']));
    expect(kept).toHaveLength(1);
  });

  it('only suggests currency for price-like text', () => {
    expect(defaultTransformsFor('text', '€ 1.234,00')).toEqual([{ type: 'currency' }]);
    expect(defaultTransformsFor('text', 'Hello world')).toEqual([]);
    expect(defaultTransformsFor('href', '$5')).toEqual([]);
  });
});
