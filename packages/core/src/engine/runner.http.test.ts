import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite, FIXTURE_PRODUCT_COUNT } from '../test/fixtureSite.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Runner } from './runner.js';
import { parseRecipe, type RecipeInput } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';
import type { RunEvent } from './events.js';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let outDir: string;
const quiet = new Logger('error');

beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-')); });
afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

function listingRecipe(extra: Partial<RecipeInput> = {}): RecipeInput {
  return {
    name: 'fixture', entry: { urls: [`${site.url}/products`], template: 'listing' },
    engine: { mode: 'http', concurrency: 3, delayMs: 0, jitterMs: 0, retries: 1 },
    templates: {
      listing: {
        list: {
          selector: [{ value: 'article.product' }],
          fields: [
            { name: 'name', type: 'attr', attr: 'title', selector: [{ value: 'h3 a' }] },
            { name: 'price', type: 'text', selector: [{ value: '.price' }], transforms: [{ type: 'currency' }] },
            { name: 'url', type: 'href', selector: [{ value: 'h3 a' }] },
            { name: 'email', type: 'email', selector: [{ value: ':scope' }] },
          ],
        },
        pagination: { type: 'next', selector: [{ value: 'li.next a' }] },
      },
    },
    output: { keys: ['url'] },
    ...extra,
  };
}

describe('Runner (HTTP mode)', () => {
  it('scrapes a paginated listing with next links', async () => {
    const storage = new SqliteStorage();
    const events: RunEvent[] = [];
    const runner = new Runner({ recipe: parseRecipe(listingRecipe()), storage, outDir, logger: quiet, onEvent: (e) => events.push(e) });
    const { run, stats } = await runner.start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(FIXTURE_PRODUCT_COUNT);
    expect(stats.pages).toBe(3);
    expect(stats.httpFetches).toBe(3);
    const rows = Array.from(storage.iterRows(run.id));
    expect(rows).toHaveLength(FIXTURE_PRODUCT_COUNT);
    const first = rows.find((r) => r.data.name === 'Product 1')!;
    expect(first.data.price).toBe(10);
    expect(first.data.email).toBe('seller0@example.com');
    expect(first.data.url).toBe(`${site.url}/product/1`);
    expect(events.some((e) => e.type === 'run.done')).toBe(true);
    expect(events.filter((e) => e.type === 'rows').length).toBe(3);
  });

  it('follows detail links and merges fields into the parent row', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe();
    recipe.templates.listing.list!.follow = [{ field: 'url', template: 'detail', mode: 'merge' }];
    recipe.templates.listing.pagination = { type: 'next', selector: [{ value: 'li.next a' }], maxPages: 1 };
    recipe.templates.detail = {
      fields: [
        { name: 'description', type: 'text', selector: [{ value: '.desc p' }] },
        { name: 'sku', type: 'text', selector: [{ kind: 'xpath', value: '//th[text()="SKU"]/following-sibling::td' }] },
        { name: 'ld', type: 'json', selector: [{ value: 'script[type="application/ld+json"]' }] },
        { name: 'specs', type: 'table', selector: [{ value: 'table.specs' }] },
      ],
    };
    const runner = new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet });
    const { run, stats } = await runner.start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(10);
    expect(stats.requests.done).toBe(11);
    const rows = Array.from(storage.iterRows(run.id));
    const p3 = rows.find((r) => r.data.name === 'Product 3')!;
    expect(p3.data.description).toBe('Description of product 3. Lorem ipsum.');
    expect(p3.data.sku).toBe('SKU-1002');
    expect((p3.data.ld as { sku: string }).sku).toBe('SKU-1002');
    expect(Array.isArray(p3.data.specs)).toBe(true);
  });

  it('nest and separate follow modes', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe();
    recipe.templates.listing.list!.follow = [{ field: 'url', template: 'detail', mode: 'nest', limit: 2 }];
    recipe.templates.listing.pagination = undefined;
    recipe.templates.detail = { fields: [{ name: 'sku', type: 'text', selector: [{ kind: 'xpath', value: '//th[text()="SKU"]/following-sibling::td' }] }] };
    let r = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    let rows = Array.from(storage.iterRows(r.run.id));
    expect(rows.filter((x) => x.data.detail).length).toBe(2);
    expect((rows.find((x) => x.data.detail)!.data.detail as { sku: string }).sku).toMatch(/^SKU-/);

    recipe.templates.listing.list!.follow = [{ field: 'url', template: 'detail', mode: 'separate', limit: 3 }];
    r = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(storage.datasets(r.run.id).map((d) => d.dataset).sort()).toEqual(['default', 'detail']);
    rows = Array.from(storage.iterRows(r.run.id, 'detail'));
    expect(rows).toHaveLength(3);
    expect(rows[0].data._parentKey).toBeTruthy();
  });

  it('category traversal via page-level follow with category path', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/categories`], template: 'cats' }, output: { keys: ['url'], addCategoryPath: true } });
    recipe.templates.cats = { follow: [{ selector: [{ value: 'ul.cats a' }], template: 'listing' }] };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(FIXTURE_PRODUCT_COUNT);
    const rows = Array.from(storage.iterRows(run.id));
    expect(new Set(rows.map((r) => r.data._category))).toEqual(new Set(['widgets', 'gadgets']));
  });

  it('urlPattern pagination stops when no new rows', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe();
    recipe.templates.listing.pagination = { type: 'urlPattern', template: `${site.url}/products?page={{page}}`, start: 1 };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(FIXTURE_PRODUCT_COUNT);
    expect(stats.pages).toBe(4); // 3 pages + 1 empty page that stops the sequence
  });

  it('pageLinks pagination dedupes numbered links', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/products?page=1`], template: 'listing' } });
    recipe.templates.listing.pagination = { type: 'pageLinks', selector: [{ value: 'a.page-link' }] };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(FIXTURE_PRODUCT_COUNT);
    expect(stats.pages).toBe(3);
  });

  it('keywords expand into seed URLs and rows are tagged', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/search?q={{q}}`], template: 'listing' }, keywords: { q: ['product 1', 'product 2'] }, output: { keys: ['url'], addKeyword: true, dedupe: false } });
    recipe.templates.listing.pagination = undefined;
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.requests.total).toBe(2);
    const rows = Array.from(storage.iterRows(run.id));
    expect(rows.every((r) => typeof r.data._kw_q === 'string')).toBe(true);
    expect(rows.some((r) => r.data._kw_q === 'product 2')).toBe(true);
  });

  it('retries failures with backoff and reports partial status', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/flaky`, `${site.url}/nope-404`], template: 'page' }, engine: { mode: 'http', retries: 3, delayMs: 0, jitterMs: 0 } });
    recipe.templates = { page: { fields: [{ name: 'ok', type: 'text', selector: [{ value: '.ok' }], required: true }] } };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    const rows = Array.from(storage.iterRows(run.id));
    expect(rows.find((r) => r.data.ok === 'finally')).toBeTruthy();
    expect(stats.validationFlags).toBe(1); // the 404 page has no .ok -> required flag
  });

  it('validation drop/fail actions and dedupe by key', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ output: { keys: ['url'], validation: [{ field: 'price', rule: 'min', value: 20, action: 'drop' }] } });
    recipe.templates.listing.pagination = undefined;
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(3); // products 8,9,10 on page 1 have price >= 20.5
    expect(stats.validationDrops).toBe(7);
  });

  it('exports to csv/json/jsonl/xlsx/xml/sqlite sinks', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ sinks: [
      { type: 'csv', path: 'out/data.csv' }, { type: 'json', path: 'out/data.json', pretty: true }, { type: 'jsonl', path: 'out/data.jsonl' },
      { type: 'xlsx', path: 'out/data.xlsx' }, { type: 'xml', path: 'out/data.xml' }, { type: 'sqlite', path: 'out/data.db', table: 'products', mode: 'upsert', key: 'url' },
    ] });
    recipe.templates.listing.pagination = undefined;
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.exports?.every((e) => !e.error)).toBe(true);
    for (const f of ['data.csv', 'data.json', 'data.jsonl', 'data.xlsx', 'data.xml', 'data.db']) expect(existsSync(join(outDir, 'out', f)), f).toBe(true);
    const csv = readFileSync(join(outDir, 'out', 'data.csv'), 'utf8');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(11);
    expect(csv).toMatch(/^﻿name,price,url,email/);
    expect(JSON.parse(readFileSync(join(outDir, 'out', 'data.json'), 'utf8'))).toHaveLength(10);
    // upsert again: same rows, no growth
    await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(JSON.parse(readFileSync(join(outDir, 'out', 'data.json'), 'utf8'))).toHaveLength(10);
  });

  it('respects robots.txt when enabled', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/secret`], template: 'page' }, engine: { mode: 'http', respectRobots: true } });
    recipe.templates = { page: { fields: [{ name: 'h', type: 'text', selector: [{ value: 'h1' }] }] } };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.requests.skipped).toBe(1);
    expect(stats.rows).toBe(0);
  });

  it('records drift when a selector stops matching and uses fallback candidates', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe();
    recipe.templates.listing.pagination = undefined;
    recipe.templates.listing.list!.fields[0].selector = [{ value: '.renamed-title' }, { value: 'h3 a' }];
    recipe.templates.listing.list!.fields.push({ name: 'gone', type: 'text', selector: [{ value: '.missing' }] });
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    const drift = storage.listDrift(run.id);
    expect(drift.some((d) => d.kind === 'fallback-candidate' && d.field === 'name')).toBe(true);
    expect(drift.some((d) => d.kind === 'field-missing' && d.field === 'gone')).toBe(true);
    expect(stats.rows).toBe(10);
  });

  it('cancel stops the run and marks it cancelled; resume completes it', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ engine: { mode: 'http', concurrency: 1, delayMs: 50, jitterMs: 0 } });
    const runner = new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet, onEvent: (e) => { if (e.type === 'request.done') runner.cancel(); } });
    const { run } = await runner.start();
    expect(run.status).toBe('cancelled');
    expect(storage.queueCounts(run.id).pending).toBeGreaterThan(0);
    const resumed = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet, resumeRunId: run.id }).start();
    expect(resumed.run.status).toBe('succeeded');
    expect(storage.countRows(run.id)).toBe(FIXTURE_PRODUCT_COUNT);
  });

  it('POST entry with keyword body', async () => {
    const storage = new SqliteStorage();
    const recipe = listingRecipe({ entry: { urls: [`${site.url}/post`], template: 'p', method: 'POST', body: 'term={{q}}' }, keywords: { q: ['hello'] } });
    recipe.templates = { p: { fields: [{ name: 'echo', type: 'text', selector: [{ value: '.echo' }] }] } };
    const { run } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(Array.from(storage.iterRows(run.id))[0].data.echo).toBe('hello');
  });
});
