import { describe, it, expect } from 'vitest';
import { parseRecipe, safeParseRecipe } from './schema.js';
import { EXAMPLE_RECIPES } from './examples.js';

describe('recipe schema', () => {
  it('parses all example recipes', () => {
    for (const [name, r] of Object.entries(EXAMPLE_RECIPES)) {
      const parsed = parseRecipe(r);
      expect(parsed.name, name).toBeTruthy();
      expect(parsed.engine.concurrency).toBeGreaterThan(0);
    }
  });

  it('applies defaults', () => {
    const r = parseRecipe({ name: 'x', entry: { urls: ['https://a.com'], template: 't' }, templates: { t: { fields: [{ name: 'a', selector: [{ value: 'h1' }] }] } } });
    expect(r.engine.mode).toBe('auto');
    expect(r.templates.t.fields[0].type).toBe('text');
    expect(r.templates.t.fields[0].selector?.[0].kind).toBe('css');
    expect(r.output.dedupe).toBe(true);
  });

  it('rejects unknown follow targets', () => {
    const res = safeParseRecipe({ name: 'x', entry: { urls: ['https://a.com'], template: 't' }, templates: { t: { list: { selector: [{ value: '.x' }], fields: [{ name: 'u', type: 'href', selector: [{ value: 'a' }] }], follow: [{ field: 'u', template: 'nope' }] } } } });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errors[0]).toMatch(/follow target "nope"/);
  });

  it('rejects missing entry template and duplicate fields', () => {
    expect(safeParseRecipe({ name: 'x', entry: { urls: ['https://a.com'], template: 'missing' }, templates: {} }).success).toBe(false);
    const dup = safeParseRecipe({ name: 'x', entry: { urls: ['https://a.com'], template: 't' }, templates: { t: { fields: [{ name: 'a', selector: [{ value: 'h1' }] }, { name: 'a', selector: [{ value: 'h2' }] }] } } });
    expect(dup.success).toBe(false);
  });

  it('requires attr/pattern/prompt for their field types', () => {
    const bad = (f: object) => safeParseRecipe({ name: 'x', entry: { urls: ['https://a.com'], template: 't' }, templates: { t: { fields: [f] } } }).success;
    expect(bad({ name: 'a', type: 'attr', selector: [{ value: 'h1' }] })).toBe(false);
    expect(bad({ name: 'a', type: 'regex', selector: [{ value: 'h1' }] })).toBe(false);
    expect(bad({ name: 'a', type: 'ai', selector: [{ value: 'h1' }] })).toBe(false);
    expect(bad({ name: 'a', type: 'constant' })).toBe(false);
    expect(bad({ name: 'a', type: 'constant', value: 'v' })).toBe(true);
  });
});
