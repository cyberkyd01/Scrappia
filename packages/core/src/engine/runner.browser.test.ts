import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from '../test/fixtureSite.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Runner } from './runner.js';
import { parseRecipe, type RecipeInput } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let outDir: string;
const quiet = new Logger('error');

beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-b-')); });
afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

const engine = { mode: 'browser' as const, headless: true, concurrency: 1, delayMs: 0, jitterMs: 0, retries: 0, timeoutMs: 20000 };

describe('Runner (browser mode)', () => {
  it('renders JS pages (auto mode upgrades from http)', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'js', entry: { urls: [`${site.url}/js`], template: 't' }, engine: { ...engine, mode: 'auto' },
      templates: { t: { list: { selector: [{ value: '.item' }], fields: [{ name: 'n', selector: [{ value: '.n' }] }, { name: 'p', selector: [{ value: '.p' }], transforms: [{ type: 'currency' }] }] } } },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(5);
    expect(stats.browserFetches).toBe(1);
    expect(stats.httpFetches).toBe(0);
    expect(Array.from(storage.iterRows(run.id))[0].data).toMatchObject({ n: 'Product 1', p: 10 });
  });

  it('clicks "load more" until it disappears', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'lm', entry: { urls: [`${site.url}/loadmore`], template: 't' }, engine,
      templates: { t: { list: { selector: [{ value: '.row' }], fields: [{ name: 'row', selector: [{ value: ':scope' }] }] }, pagination: { type: 'loadMore', selector: [{ value: '#more' }], delayMs: 100 } } },
    };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(8);
    expect(stats.pages).toBeGreaterThanOrEqual(4);
  });

  it('infinite scroll stops when no new rows appear', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'sc', entry: { urls: [`${site.url}/scroll`], template: 't' }, engine,
      templates: { t: { list: { selector: [{ value: '.row' }], fields: [{ name: 'row', selector: [{ value: ':scope' }] }] }, pagination: { type: 'scroll', delayMs: 150 } } },
    };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(30);
  });

  it('performs login actions and keeps the session for follow-up pages', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'login', entry: { urls: [`${site.url}/login`], template: 'login' }, engine, keywords: { user: ['admin'] },
      templates: {
        login: {
          actions: [
            { type: 'type', selector: [{ value: '#user' }], text: '{{user}}' },
            { type: 'type', selector: [{ value: '#pass' }], text: 'secret' },
            { type: 'click', selector: [{ kind: 'role', value: 'button[name=Sign in]' }] },
            { type: 'waitFor', selector: [{ value: '.secret' }] },
          ],
          fields: [{ name: 'welcome', selector: [{ value: '.secret' }] }, { name: 'url', type: 'pageUrl' }],
        },
      },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(1);
    const row = Array.from(storage.iterRows(run.id))[0].data;
    expect(row.welcome).toBe('Welcome admin');
    expect(row.url).toBe(`${site.url}/secret`);
  });

  it('click-based next pagination in one tab', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'click-next', entry: { urls: [`${site.url}/products`], template: 't' }, engine,
      templates: { t: { list: { selector: [{ value: 'article.product' }], fields: [{ name: 'name', type: 'attr', attr: 'title', selector: [{ value: 'h3 a' }] }] }, pagination: { type: 'next', selector: [{ value: 'li.next a' }], method: 'click', maxPages: 2 } } },
      output: { keys: ['name'] },
    };
    const { stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(20);
    expect(stats.requests.total).toBe(1);
  });

  it('script actions and script pagination run in the page main world', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'script', entry: { urls: [`${site.url}/loadmore`], template: 't' }, engine,
      templates: { t: {
        // the fixture page defines a page-level `n` counter via a classic <script>; main-world code can read it
        actions: [{ type: 'script', code: 'document.title = "n=" + (typeof n === "number" ? n : "isolated")' }],
        fields: [{ name: 'title', type: 'pageTitle' }],
        list: { selector: [{ value: '.row' }], fields: [{ name: 'row', selector: [{ value: ':scope' }] }] },
        pagination: { type: 'script', code: 'const b = document.getElementById("more"); if (!b) return false; b.click(); return true;', delayMs: 100 },
      } },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(stats.rows).toBe(8 + 1);
    const page = Array.from(storage.iterRows(run.id)).find((r) => r.data.title);
    expect(page!.data.title).toBe('n=2');
  });

  it('a "next" button without a link is clicked in-page (auto method), even from auto engine mode', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'jsnext', entry: { urls: [`${site.url}/jsnext`], template: 't' }, engine: { ...engine, mode: 'auto' },
      templates: { t: { list: { selector: [{ value: '.row' }], fields: [{ name: 'row', selector: [{ value: ':scope' }] }] }, pagination: { type: 'next', selector: [{ value: '#next' }] } } },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(6);
    expect(stats.browserFetches).toBe(1);
    expect(stats.requests.total).toBe(1);
    expect(Array.from(storage.iterRows(run.id)).map((r) => r.data.row).sort()).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });

  it('waits for records that render seconds after the page loads (single-page apps)', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'late', entry: { urls: [`${site.url}/late?ms=3500`], template: 't' }, engine: { ...engine, mode: 'auto' },
      templates: { t: { list: { selector: [{ value: '.row' }], fields: [{ name: 'n', selector: [{ value: '.n' }] }] } } },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(6);
    expect(stats.browserFetches).toBe(1);
    expect(Array.from(storage.iterRows(run.id))[0].data.n).toBe('Late 1');
  }, 60_000);

  it('session cookies with strict attributes never fail a run; valid ones reach the page', async () => {
    const storage = new SqliteStorage();
    const host = new URL(site.url).hostname;
    const recipe: RecipeInput = {
      name: 'cookies', entry: { urls: [`${site.url}/cookies`], template: 't' },
      engine: { ...engine, cookies: [
        { name: 'session', value: 'abc', domain: host, path: '/' },
        { name: '__Host-csrf', value: 'x1', domain: host, path: '/', secure: true },        // host-only, needs url form
        { name: 'tracker', value: 't', domain: host, path: '/', sameSite: 'None' },         // needs secure
        { name: 'broken', value: 'v', domain: 'not a domain!!', path: '/' },                 // invalid: skipped, not fatal
      ] },
      templates: { t: { fields: [{ name: 'c', selector: [{ value: '#c' }] }] } },
    };
    const { run, stats } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.requests.failed).toBe(0);
    const sent = String(Array.from(storage.iterRows(run.id))[0].data.c);
    expect(sent).toContain('session=abc'); // plain http fixture: secure cookies are (correctly) not sent, the run still works
  });

  it('screenshot and image fields produce files', async () => {
    const storage = new SqliteStorage();
    const recipe: RecipeInput = {
      name: 'shots', entry: { urls: [`${site.url}/products`], template: 't' }, engine,
      templates: { t: { list: { selector: [{ value: 'article.product' }], fields: [{ name: 'img', type: 'image', selector: [{ value: 'img' }] }], limit: 2 }, fields: [{ name: 'shot', type: 'screenshot' }] } },
    };
    const { run } = await new Runner({ recipe: parseRecipe(recipe), storage, outDir, logger: quiet }).start();
    const rows = Array.from(storage.iterRows(run.id));
    const list = rows.filter((r) => r.data.img);
    expect(list).toHaveLength(2);
    expect(String(list[0].data.img)).toMatch(/downloads[\\/].*[\\/]img[\\/]1\.jpg$/);
    const page = rows.find((r) => r.data.shot);
    expect(String(page!.data.shot)).toMatch(/\.png$/);
  });
});
