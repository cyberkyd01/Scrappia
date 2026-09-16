import { describe, it, expect } from 'vitest';
import { blankRecipe, recipeReducer, makeField, paginationFor, blankSink, uniqueFieldName } from './recipe';

describe('recipeReducer', () => {
  const base = blankRecipe('Test', 'https://example.com');

  it('creates a blank recipe with an entry template', () => {
    expect(base.entry.template).toBe('main');
    expect(base.templates.main).toBeDefined();
    expect(base.entry.urls).toEqual(['https://example.com']);
  });

  it('adds page fields and de-duplicates names', () => {
    let r = recipeReducer(base, { type: 'addField', template: 'main', target: 'page', field: makeField({ name: 'Title', selector: [{ kind: 'css', value: 'h1' }] }) });
    r = recipeReducer(r, { type: 'addField', template: 'main', target: 'page', field: makeField({ name: 'title', selector: [{ kind: 'css', value: 'h2' }] }) });
    expect(r.templates.main.fields.map((f) => f.name)).toEqual(['title', 'title_2']);
    expect(r.templates.main.fields[0].scope).toBe('document');
  });

  it('falls back to page fields when adding a list field without a list', () => {
    const r = recipeReducer(base, { type: 'addField', template: 'main', target: 'list', field: makeField({ name: 'x', selector: [{ kind: 'css', value: '.x' }] }) });
    expect(r.templates.main.list).toBeUndefined();
    expect(r.templates.main.fields).toHaveLength(1);
  });

  it('sets a list, adds list fields, updates and removes them', () => {
    let r = recipeReducer(base, { type: 'setList', template: 'main', selector: [{ kind: 'css', value: '.item' }] });
    r = recipeReducer(r, { type: 'addField', template: 'main', target: 'list', field: makeField({ name: 'name', selector: [{ kind: 'css', value: '.n' }] }) });
    r = recipeReducer(r, { type: 'addField', template: 'main', target: 'list', field: makeField({ name: 'url', type: 'href', selector: [{ kind: 'css', value: 'a' }] }) });
    expect(r.templates.main.list?.fields.map((f) => f.name)).toEqual(['name', 'url']);
    r = recipeReducer(r, { type: 'updateField', template: 'main', target: 'list', index: 0, patch: { name: 'title', transforms: [{ type: 'trim' }] } });
    expect(r.templates.main.list?.fields[0].name).toBe('title');
    expect(r.templates.main.list?.fields[0].transforms).toEqual([{ type: 'trim' }]);
    // renaming onto an existing name is rejected
    const same = recipeReducer(r, { type: 'updateField', template: 'main', target: 'list', index: 0, patch: { name: 'url' } });
    expect(same).toBe(r);
    r = recipeReducer(r, { type: 'removeField', template: 'main', target: 'list', index: 0 });
    expect(r.templates.main.list?.fields.map((f) => f.name)).toEqual(['url']);
    // setList keeps the existing fields when none are supplied
    r = recipeReducer(r, { type: 'setList', template: 'main', selector: [{ kind: 'css', value: 'li' }] });
    expect(r.templates.main.list?.selector[0].value).toBe('li');
    expect(r.templates.main.list?.fields).toHaveLength(1);
  });

  it('adds a follow to a new template and keeps references in sync on rename/remove', () => {
    let r = recipeReducer(base, { type: 'setList', template: 'main', selector: [{ kind: 'css', value: '.item' }] });
    r = recipeReducer(r, { type: 'addField', template: 'main', target: 'list', field: makeField({ name: 'url', type: 'href', selector: [{ kind: 'css', value: 'a' }] }) });
    r = recipeReducer(r, { type: 'addTemplate', name: 'detail' });
    r = recipeReducer(r, { type: 'addFollow', template: 'main', target: 'list', follow: { field: 'url', template: 'detail', mode: 'merge', method: 'navigate' } });
    expect(r.templates.main.list?.follow[0].template).toBe('detail');
    r = recipeReducer(r, { type: 'renameTemplate', from: 'detail', to: 'product' });
    expect(r.templates.product).toBeDefined();
    expect(r.templates.main.list?.follow[0].template).toBe('product');
    // renaming the field updates the follow reference
    r = recipeReducer(r, { type: 'updateField', template: 'main', target: 'list', index: 0, patch: { name: 'link' } });
    expect(r.templates.main.list?.follow[0].field).toBe('link');
    // removing the field drops the follow
    r = recipeReducer(r, { type: 'removeField', template: 'main', target: 'list', index: 0 });
    expect(r.templates.main.list?.follow).toHaveLength(0);
    // cannot remove the entry template
    expect(recipeReducer(r, { type: 'removeTemplate', name: 'main' })).toBe(r);
    r = recipeReducer(r, { type: 'removeTemplate', name: 'product' });
    expect(r.templates.product).toBeUndefined();
  });

  it('manages pagination, actions and sinks', () => {
    let r = recipeReducer(base, { type: 'setPagination', template: 'main', pagination: paginationFor('next', [{ kind: 'css', value: 'a.next' }]) });
    expect(r.templates.main.pagination?.type).toBe('next');
    r = recipeReducer(r, { type: 'setPagination', template: 'main', pagination: paginationFor('scroll') });
    expect(r.templates.main.pagination?.type).toBe('scroll');
    r = recipeReducer(r, { type: 'addAction', template: 'main', action: { type: 'click', selector: [{ kind: 'css', value: '#accept' }] } });
    r = recipeReducer(r, { type: 'addAction', template: 'main', action: { type: 'wait', ms: 500 } });
    r = recipeReducer(r, { type: 'removeAction', template: 'main', index: 0 });
    expect(r.templates.main.actions).toEqual([{ type: 'wait', ms: 500 }]);
    r = recipeReducer(r, { type: 'addSink', sink: blankSink('csv', 'out') });
    r = recipeReducer(r, { type: 'updateSink', index: 0, sink: { ...blankSink('csv', 'out'), mode: 'append' } });
    expect(r.sinks[0]).toMatchObject({ type: 'csv', mode: 'append', path: 'exports/out.csv' });
    r = recipeReducer(r, { type: 'removeSink', index: 0 });
    expect(r.sinks).toHaveLength(0);
    r = recipeReducer(r, { type: 'setEngine', patch: { mode: 'browser', concurrency: 1 } });
    expect(r.engine.mode).toBe('browser');
    expect(r.engine.retries).toBe(3);
  });

  it('uniqueFieldName considers both page and list fields', () => {
    const t = { actions: [], fields: [makeField({ name: 'a' })], follow: [], list: { selector: [{ kind: 'css' as const, value: 'x' }], fields: [makeField({ name: 'b' })], follow: [], minItems: 1 } };
    expect(uniqueFieldName(t, 'A')).toBe('a_2');
    expect(uniqueFieldName(t, 'b')).toBe('b_2');
    expect(uniqueFieldName(t, 'Product Price ($)')).toBe('product_price');
  });
});
