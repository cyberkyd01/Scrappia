import { describe, it, expect } from 'vitest';
import { migrateRecipe, importWebScraperSitemap } from './migrate.js';
import { parseRecipe } from './schema.js';

describe('migrateRecipe', () => {
  it('adds a version to legacy documents and rejects newer ones', () => {
    expect(migrateRecipe({ name: 'x' }).version).toBe(1);
    expect(() => migrateRecipe({ version: 99 })).toThrow(/newer/);
    expect(() => migrateRecipe('nope')).toThrow();
  });
});

describe('importWebScraperSitemap', () => {
  it('converts a selector tree into a recipe', () => {
    const sitemap = {
      _id: 'books',
      startUrl: ['https://books.toscrape.com/catalogue/page-[1-3].html'],
      selectors: [
        { id: 'product', type: 'SelectorElement', parentSelectors: ['_root'], selector: 'article.product_pod', multiple: true },
        { id: 'title', type: 'SelectorText', parentSelectors: ['product'], selector: 'h3 a', multiple: false },
        { id: 'price', type: 'SelectorText', parentSelectors: ['product'], selector: '.price_color', multiple: false, regex: '[\\d.]+' },
        { id: 'img', type: 'SelectorImage', parentSelectors: ['product'], selector: 'img', multiple: false },
        { id: 'next', type: 'SelectorPagination', parentSelectors: ['_root'], selector: 'li.next a' },
        { id: 'weird', type: 'SelectorGroup', parentSelectors: ['_root'], selector: '.x' },
      ],
    };
    const { recipe, skipped } = importWebScraperSitemap(sitemap);
    expect(skipped).toEqual(['weird (SelectorGroup)']);
    const parsed = parseRecipe(recipe);
    expect(parsed.entry.urls[0]).toBe('https://books.toscrape.com/catalogue/page-{{page}}.html');
    expect(parsed.templates.main.list?.fields.map((f) => f.name)).toEqual(['title', 'price', 'img']);
    expect(parsed.templates.main.list?.fields[1].transforms[0]).toMatchObject({ type: 'regex', pattern: '[\\d.]+' });
    expect(parsed.templates.main.pagination?.type).toBe('next');
  });
});
