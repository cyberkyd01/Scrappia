import { describe, it, expect } from 'vitest';
import { applyTransforms, parseNumber, parseCurrency, parseDate } from './index.js';

const ctx = { pageUrl: 'https://example.com/a/b?x=1', row: { other: 'O' } };

describe('parseNumber', () => {
  it('handles thousands and decimals in both conventions', () => {
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('1.234,56')).toBe(1234.56);
    expect(parseNumber('$ 12.50')).toBe(12.5);
    expect(parseNumber('12,50')).toBe(12.5);
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('1 234 567')).toBe(1234567);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('-3.5%')).toBe(-3.5);
    expect(parseNumber("1'234.50", undefined, undefined)).toBe(1234.5);
  });
});

describe('parseCurrency', () => {
  it('detects symbol and amount', () => {
    expect(parseCurrency('€1.299,00')).toEqual({ amount: 1299, currency: 'EUR' });
    expect(parseCurrency('USD 45')).toEqual({ amount: 45, currency: 'USD' });
    expect(parseCurrency('₹ 2,50,000')).toEqual({ amount: 250000, currency: 'INR' });
  });
});

describe('parseDate', () => {
  it('parses common formats', () => {
    expect(parseDate('2024-03-12')).toBe('2024-03-12T00:00:00.000Z');
    expect(parseDate('12/03/2024')?.slice(0, 10)).toBe('2024-03-12');
    expect(parseDate('03/25/2024')?.slice(0, 10)).toBe('2024-03-25');
    expect(parseDate('Mar 12, 2024')?.slice(0, 10)).toBe('2024-03-12');
    expect(parseDate('12 March 2024 3:15 pm')).toBe('2024-03-12T15:15:00.000Z');
    expect(parseDate('20240312', 'YYYYMMDD')?.slice(0, 10)).toBe('2024-03-12');
    const ago = parseDate('2 days ago')!;
    expect(Date.now() - +new Date(ago)).toBeGreaterThan(2 * 86400_000 - 5000);
    expect(parseDate('not a date')).toBeNull();
  });
});

describe('applyTransforms', () => {
  it('chains transforms', async () => {
    const v = await applyTransforms('  Price: $1,299.99  ', [{ type: 'trim' }, { type: 'regex', pattern: '\\$([\\d,.]+)' }, { type: 'number' }], ctx);
    expect(v).toBe(1299.99);
  });
  it('regex all + join, split, template, map, default', async () => {
    expect(await applyTransforms('a1 b2 c3', [{ type: 'regex', pattern: '\\d', all: true, join: '-' }], ctx)).toBe('1-2-3');
    expect(await applyTransforms('x, y ,z', [{ type: 'split', separator: ',', index: -1 }], ctx)).toBe('z');
    expect(await applyTransforms('v', [{ type: 'template', template: '{{other}}:{{value}}@{{pageUrl}}' }], ctx)).toBe('O:v@https://example.com/a/b?x=1');
    expect(await applyTransforms('Two', [{ type: 'map', mapping: { Two: '2' } }, { type: 'integer' }], ctx)).toBe(2);
    expect(await applyTransforms(null, [{ type: 'default', value: 'n/a' }], ctx)).toBe('n/a');
  });
  it('absoluteUrl and urlParam', async () => {
    expect(await applyTransforms('../c?id=5', [{ type: 'absoluteUrl' }], ctx)).toBe('https://example.com/c?id=5');
    expect(await applyTransforms('/p?id=7', [{ type: 'urlParam', name: 'id' }], ctx)).toBe('7');
  });
  it('applies element-wise to arrays', async () => {
    expect(await applyTransforms([' a ', ' b '], [{ type: 'trim' }, { type: 'uppercase' }], ctx)).toEqual(['A', 'B']);
  });
  it('js transform', async () => {
    expect(await applyTransforms(4, [{ type: 'js', code: 'value * 2 + row.other.length' }], ctx)).toBe(9);
    expect(await applyTransforms('x', [{ type: 'js', code: 'if (value === "x") return "yes"; return "no";' }], ctx)).toBe('yes');
  });
  it('stripHtml + boolean + hash', async () => {
    expect(await applyTransforms('<p>Hi<br>there</p>', [{ type: 'stripHtml' }], ctx)).toBe('Hi\nthere');
    expect(await applyTransforms('In Stock', [{ type: 'boolean' }], ctx)).toBe(true);
    expect(await applyTransforms('abc', [{ type: 'hash', algorithm: 'md5' }], ctx)).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
