import type { RecipeInput } from './schema.js';

/** Example recipes; also used by tests and the desktop "templates" gallery. */
export const EXAMPLE_RECIPES: Record<string, RecipeInput> = {
  'books-toscrape': {
    version: 1,
    name: 'Books to Scrape (catalog + detail)',
    description: 'Demo store: list pages with next-link pagination, detail pages merged into rows.',
    tags: ['demo', 'ecommerce'],
    entry: { urls: ['https://books.toscrape.com/catalogue/page-1.html'], template: 'listing' },
    templates: {
      listing: {
        list: {
          selector: [{ kind: 'css', value: 'article.product_pod' }],
          fields: [
            { name: 'title', type: 'attr', attr: 'title', selector: [{ kind: 'css', value: 'h3 a' }] },
            { name: 'price', type: 'text', selector: [{ kind: 'css', value: '.price_color' }], transforms: [{ type: 'currency' }] },
            { name: 'rating', type: 'attr', attr: 'class', selector: [{ kind: 'css', value: 'p.star-rating' }], transforms: [{ type: 'replace', pattern: 'star-rating\\s*', replacement: '' }, { type: 'map', mapping: { One: '1', Two: '2', Three: '3', Four: '4', Five: '5' } }, { type: 'integer' }] },
            { name: 'in_stock', type: 'text', selector: [{ kind: 'css', value: '.availability' }], transforms: [{ type: 'boolean', truthy: ['in stock'] }] },
            { name: 'url', type: 'href', selector: [{ kind: 'css', value: 'h3 a' }] },
            { name: 'image', type: 'src', selector: [{ kind: 'css', value: 'img.thumbnail' }] },
          ],
          follow: [{ field: 'url', template: 'detail', mode: 'merge' }],
        },
        pagination: { type: 'next', selector: [{ kind: 'css', value: 'li.next a' }], maxPages: 3 },
      },
      detail: {
        fields: [
          { name: 'description', type: 'text', selector: [{ kind: 'css', value: '#product_description ~ p' }] },
          { name: 'upc', type: 'text', selector: [{ kind: 'xpath', value: '//th[text()="UPC"]/following-sibling::td' }] },
          { name: 'category', type: 'text', selector: [{ kind: 'css', value: '.breadcrumb li:nth-child(3) a' }] },
        ],
      },
    },
    output: { keys: ['url'] },
    sinks: [{ type: 'xlsx', path: 'exports/books.xlsx', mode: 'overwrite' }],
  },
  'quotes-infinite-scroll': {
    version: 1,
    name: 'Quotes (infinite scroll, browser)',
    description: 'JS-rendered infinite scroll list handled in a stealth browser.',
    tags: ['demo', 'browser'],
    entry: { urls: ['https://quotes.toscrape.com/scroll'], template: 'quotes' },
    engine: { mode: 'browser', headless: true, concurrency: 1 },
    templates: {
      quotes: {
        waitFor: [{ kind: 'css', value: '.quote' }],
        list: {
          selector: [{ kind: 'css', value: '.quote' }],
          fields: [
            { name: 'text', type: 'text', selector: [{ kind: 'css', value: '.text' }], transforms: [{ type: 'regex', pattern: '^[“"]?(.*?)[”"]?$' }] },
            { name: 'author', type: 'text', selector: [{ kind: 'css', value: '.author' }] },
            { name: 'tags', type: 'text', multiple: true, selector: [{ kind: 'css', value: '.tag' }] },
          ],
        },
        pagination: { type: 'scroll', maxScrolls: 5, delayMs: 800 },
      },
    },
    output: { keys: ['text'] },
    sinks: [{ type: 'jsonl', path: 'exports/quotes.jsonl' }],
  },
  'hacker-news-monitor': {
    version: 1,
    name: 'Hacker News front page monitor',
    description: 'HTTP-only scrape with change detection and alerts.',
    tags: ['demo', 'monitoring'],
    entry: { urls: ['https://news.ycombinator.com/'], template: 'front' },
    engine: { mode: 'http', concurrency: 1 },
    templates: {
      front: {
        list: {
          selector: [{ kind: 'css', value: 'tr.athing' }],
          fields: [
            { name: 'rank', type: 'text', selector: [{ kind: 'css', value: '.rank' }], transforms: [{ type: 'integer' }] },
            { name: 'title', type: 'text', selector: [{ kind: 'css', value: '.titleline > a' }] },
            { name: 'url', type: 'href', selector: [{ kind: 'css', value: '.titleline > a' }] },
            { name: 'points', type: 'text', selector: [{ kind: 'xpath', value: 'following-sibling::tr[1]//span[@class="score"]' }], transforms: [{ type: 'integer' }] },
          ],
        },
      },
    },
    output: { keys: ['url'], addTimestamp: true },
    monitor: { enabled: true, on: ['added', 'removed', 'failure'], channels: [] },
    schedule: { cron: '0 * * * *', tz: 'UTC' },
    sinks: [{ type: 'csv', path: 'exports/hn.csv', mode: 'upsert', key: 'url' }],
  },
  'keyword-search': {
    version: 1,
    name: 'Keyword search (form input)',
    description: 'Types each keyword into a search box, submits, and scrapes the results with a next-link.',
    tags: ['demo', 'keywords'],
    entry: { urls: ['https://books.toscrape.com/'], template: 'search' },
    keywords: { q: ['travel', 'poetry'] },
    engine: { mode: 'browser' },
    templates: {
      search: {
        actions: [
          { type: 'click', selector: [{ kind: 'text', value: '{{q}}' }, { kind: 'css', value: '.side_categories a' }], optional: true },
        ],
        list: {
          selector: [{ kind: 'css', value: 'article.product_pod' }],
          fields: [
            { name: 'title', type: 'attr', attr: 'title', selector: [{ kind: 'css', value: 'h3 a' }] },
            { name: 'price', type: 'text', selector: [{ kind: 'css', value: '.price_color' }], transforms: [{ type: 'currency' }] },
          ],
        },
        pagination: { type: 'next', selector: [{ kind: 'css', value: 'li.next a' }], maxPages: 2 },
      },
    },
    output: { addKeyword: true },
    sinks: [{ type: 'csv', path: 'exports/search.csv' }],
  },
};

export function exampleRecipe(name: keyof typeof EXAMPLE_RECIPES | string): RecipeInput {
  const r = EXAMPLE_RECIPES[name];
  if (!r) throw new Error(`Unknown example "${name}". Available: ${Object.keys(EXAMPLE_RECIPES).join(', ')}`);
  return structuredClone(r);
}
