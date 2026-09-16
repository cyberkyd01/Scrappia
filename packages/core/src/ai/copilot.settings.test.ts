import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from '../test/fixtureSite.js';
import { startMockLlm, lastUser, turn } from '../test/mockLlm.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { OpenAICompatibleProvider } from './provider.js';
import { CopilotSession, COPILOT_TOOLS } from './copilot.js';
import { HttpCopilotHost } from './copilotHostHttp.js';
import { Logger } from '../util/logger.js';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let outDir: string;
const quiet = new Logger('error');
beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-cp-settings-')); });
afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

/** Scripted model: each user message is a JSON list of tool calls to issue (test harness), reply echoes. */
async function harness(storage: SqliteStorage, startUrl: string) {
  const mock = await startMockLlm((req) => {
    const last = lastUser(req);
    if (last.startsWith('[Tool results]')) return turn('ok', []);
    if (last.startsWith('[Event]')) return turn('event noted', []);
    try { const calls = JSON.parse(last) as Array<[string, Record<string, unknown>]>; return turn('doing', calls); } catch { return turn('?', []); }
  });
  const provider = new OpenAICompatibleProvider('mock', mock.url, 'mock-1');
  storage.setSecret('PG_MAIN', 'postgres://x');
  const host = new HttpCopilotHost({ storage, outDir, startUrl, logger: quiet });
  const copilot = new CopilotSession({ provider, host, logger: quiet });
  const blank = { name: 'Untitled', entry: { urls: [startUrl], template: 'main' }, templates: { main: {} } };
  let recipe: Parameters<CopilotSession['turn']>[0]['recipe'] = blank;
  const call = async (calls: Array<[string, Record<string, unknown>]>) => {
    const r = await copilot.turn({ message: JSON.stringify(calls), recipe });
    recipe = r.recipe;
    return r;
  };
  return { call, close: () => mock.close(), copilot, get recipe() { return recipe; } };
}

describe('Copilot tools cover every recipe setting', () => {
  it('entry, keywords, actions, template options, engine/output/monitor/schedule/ai, sinks, rename, remove', async () => {
    const storage = new SqliteStorage();
    const h = await harness(storage, `${site.url}/products`);
    try {
      let r = await h.call([
        ['set_entry', { urls: [`${site.url}/search?q={{q}}`], template: 'main' }],
        ['set_keywords', { lists: { q: ['product 1', 'product 2'] }, mode: 'zip' }],
        ['set_list', { selector: 'article.product', fields: [{ name: 'name', type: 'attr', attr: 'title', selector: 'h3 a' }, { name: 'url', type: 'href', selector: 'h3 a' }] }],
        ['add_action', { action: { type: 'waitFor', selector: '.product' } }],
        ['add_action', { action: { type: 'click', selector: '#cookie-ok', optional: true }, index: 0 }],
        ['set_template', { template: 'main', patch: { waitFor: '.list', mode: 'http', description: 'listing' } }],
        ['configure', { section: 'engine', patch: { mode: 'http', concurrency: 2, delayMs: 10, jitterMs: 0, respectRobots: false, proxy: { urls: ['http://user:pass@proxy.test:8080'], rotate: 'request' }, session: { persist: true, profile: 'shop' } } }],
        ['configure', { section: 'output', patch: { keys: ['url'], addKeyword: true, validation: [{ field: 'name', rule: 'required', action: 'flag' }] } }],
        ['configure', { section: 'monitor', patch: { enabled: true, on: ['added', 'changed'], channels: [{ type: 'slack', webhookUrlRef: 'SLACK' }] } }],
        ['configure', { section: 'schedule', patch: { cron: '0 7 * * *', tz: 'Europe/Berlin' } }],
        ['configure', { section: 'ai', patch: { selfHeal: false } }],
        ['add_sink', { sink: { type: 'postgres', connectionRef: 'PG_MAIN', table: 'products', mode: 'upsert', key: 'url' } }],
        ['add_sink', { sink: { type: 'google-sheets', credentialRef: 'MISSING', spreadsheetId: 'abc' } }],
        ['add_sink', { sink: { type: 'xlsx', path: 'out/p.xlsx' } }],
        ['rename_recipe', { name: 'Shop products', description: 'demo', tags: ['shop'] }],
        ['list_secrets', {}],
        ['list_sink_types', {}],
      ]);
      expect(r.actions.every((a) => a.ok), r.actions.filter((a) => !a.ok).map((a) => a.summary).join('; ')).toBe(true);
      const rec = r.recipe;
      expect(rec.entry.urls[0]).toContain('{{q}}');
      expect(rec.keywords.q).toEqual(['product 1', 'product 2']);
      expect(rec.keywordMode).toBe('zip');
      expect(rec.templates.main.actions.map((a) => a.type)).toEqual(['click', 'waitFor']);
      expect(rec.templates.main.waitFor?.[0].value).toBe('.list');
      expect(rec.templates.main.mode).toBe('http');
      expect(rec.engine).toMatchObject({ mode: 'http', concurrency: 2, delayMs: 10, proxy: { urls: ['http://user:pass@proxy.test:8080'], rotate: 'request' }, session: { persist: true, profile: 'shop' } });
      expect(rec.engine.retries).toBe(3); // untouched defaults survive deep-merge
      expect(rec.output).toMatchObject({ keys: ['url'], addKeyword: true });
      expect(rec.output.validation[0]).toMatchObject({ field: 'name', rule: 'required' });
      expect(rec.monitor).toMatchObject({ enabled: true, on: ['added', 'changed'] });
      expect(rec.monitor.channels[0]).toMatchObject({ type: 'slack' });
      expect(rec.schedule).toMatchObject({ cron: '0 7 * * *', tz: 'Europe/Berlin' });
      expect(rec.ai.selfHeal).toBe(false);
      expect(rec.sinks.map((s) => s.type)).toEqual(['postgres', 'google-sheets', 'xlsx']);
      expect(r.actions.find((a) => a.tool === 'add_sink' && a.summary.includes('google-sheets'))?.summary).toMatch(/warning: secret "MISSING"/);
      expect(rec.name).toBe('Shop products');
      expect(rec.tags).toEqual(['shop']);
      expect(r.actions.find((a) => a.tool === 'list_secrets')?.ok).toBe(true);

      // invalid changes are rejected and the recipe is unchanged
      r = await h.call([
        ['configure', { section: 'engine', patch: { concurrency: 999 } }],
        ['configure', { section: 'nope', patch: {} }],
        ['add_sink', { sink: { type: 'csv' } }],
        ['update_field', { name: 'does-not-exist', patch: { type: 'text' } }],
        ['remove_template', { template: 'main' }],
        ['set_pagination', { pagination: { type: 'next' } }],
      ]);
      expect(r.actions.map((a) => a.ok)).toEqual([false, false, false, false, false, false]);
      expect(r.actions[0].summary).toMatch(/invalid after change/);
      expect(r.recipe.engine.concurrency).toBe(2);

      // follow + detail template, then update/remove field, remove sink, remove template
      r = await h.call([
        ['add_follow', { field: 'url', target: 'detail', mode: 'nest', limit: 2, fields: [{ name: 'sku', selector: 'xpath://th[text()="SKU"]/following-sibling::td' }] }],
        ['update_field', { template: 'detail', name: 'sku', patch: { name: 'sku_code', transforms: ['trim', 'uppercase'] } }],
        ['add_fields', { template: 'detail', scope: 'page', fields: [{ name: 'title', selector: 'h1' }] }],
        ['remove_field', { template: 'detail', name: 'title' }],
        ['remove_sink', { index: 1 }],
        ['set_pagination', { pagination: { type: 'urlPattern', template: `${site.url}/products?page=%%pagenumber%%`, maxPages: 2 } }],
        ['clear_actions', {}],
        ['get_recipe', {}],
      ]);
      expect(r.actions.every((a) => a.ok), r.actions.filter((a) => !a.ok).map((a) => a.summary).join('; ')).toBe(true);
      expect(r.recipe.templates.main.list?.follow[0]).toMatchObject({ field: 'url', template: 'detail', mode: 'nest', limit: 2 });
      expect(r.recipe.templates.detail.fields.map((f) => f.name)).toEqual(['sku_code']);
      expect(r.recipe.templates.detail.fields[0].transforms).toEqual([{ type: 'trim' }, { type: 'uppercase' }]);
      expect(r.recipe.sinks.map((s) => s.type)).toEqual(['postgres', 'xlsx']);
      expect(r.recipe.templates.main.pagination).toMatchObject({ type: 'urlPattern', template: `${site.url}/products?page={{page}}` });
      expect(r.recipe.templates.main.actions).toEqual([]);

      r = await h.call([['remove_template', { template: 'detail' }], ['clear_pagination', {}], ['set_recipe_json', { recipe: { name: 'Replaced', entry: { urls: [`${site.url}/products`], template: 't' }, templates: { t: { list: { selector: [{ value: 'article.product' }], fields: [{ name: 'n', selector: [{ value: 'h3 a' }] }] } } } } }]]);
      expect(r.actions.every((a) => a.ok)).toBe(true);
      expect(r.recipe.name).toBe('Replaced');
      expect(Object.keys(r.recipe.templates)).toEqual(['t']);
    } finally { await h.close(); }
  });

  it('test_run honours engine settings: browser mode renders a JS page; http mode does not', async () => {
    const storage = new SqliteStorage();
    const h = await harness(storage, `${site.url}/js`);
    try {
      let r = await h.call([
        ['set_list', { selector: '.item', fields: [{ name: 'n', selector: '.n' }, { name: 'p', selector: '.p', transforms: ['currency'] }] }],
        ['configure', { section: 'engine', patch: { mode: 'http', delayMs: 0, jitterMs: 0 } }],
        ['test_run', { maxRequests: 1 }],
      ]);
      const http = r.actions.find((a) => a.tool === 'test_run')!;
      expect((r.actions.find((a) => a.tool === 'set_list')!.summary)).toMatch(/0 records/); // preview over HTTP sees the empty shell
      expect(http.summary).toMatch(/0 rows/);
      r = await h.call([
        ['configure', { section: 'engine', patch: { mode: 'browser', headless: true, concurrency: 1 } }],
        ['test_run', { maxRequests: 1 }],
      ]);
      const browser = r.actions.find((a) => a.tool === 'test_run')!;
      expect(browser.ok).toBe(true);
      expect(browser.summary).toMatch(/5 rows, 1 pages/);
    } finally { await h.close(); }
  }, 120_000);

  it('picking is refused without a browser, with a message the model can act on', async () => {
    const storage = new SqliteStorage();
    const h = await harness(storage, `${site.url}/products`);
    try {
      const r = await h.call([['enable_picking', { mode: 'pickList', instruction: 'click a card' }], ['detect_lists', {}]]);
      expect(r.actions[0].ok).toBe(false);
      expect(r.actions[0].summary).toMatch(/not available in this session/);
      expect(r.actions[1].ok).toBe(true);
      expect(r.waitingForPicks).toBe(false);
    } finally { await h.close(); }
  });

  it('documents every tool', () => {
    expect(COPILOT_TOOLS.map((t) => t.name)).toContain('configure');
    for (const t of COPILOT_TOOLS) { expect(t.doc.length).toBeGreaterThan(10); expect(t.args.startsWith('{')).toBe(true); }
  });
});
