import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ScrappiaApp, SqliteStorage, Logger } from '@scrappia/core';
import { createMcpServer, startHttp } from './index.js';
import { startFixture, FIXTURE_PRODUCTS } from './test/fixture.js';

let site: Awaited<ReturnType<typeof startFixture>>;
let dir: string;
let app: ScrappiaApp;
let client: Client;
let recipe: Record<string, unknown>;
let savedId: string;
let runId: string;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; json?: Record<string, unknown>; isError?: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content.map((c) => c.text ?? '').join('');
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { text, json, isError: r.isError };
}

beforeAll(async () => {
  site = await startFixture();
  dir = mkdtempSync(join(tmpdir(), 'scrappia-mcp-'));
  app = new ScrappiaApp({ dataDir: dir, storage: new SqliteStorage(), logger: new Logger('error') });
  const server = createMcpServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  recipe = {
    name: 'fixture', entry: { urls: [`${site.url}/products`], template: 'listing' },
    engine: { mode: 'http', concurrency: 2, delayMs: 0, jitterMs: 0, retries: 0 },
    templates: {
      listing: {
        list: {
          selector: [{ value: 'article.product' }],
          fields: [
            { name: 'name', type: 'attr', attr: 'title', selector: [{ value: 'h3 a' }] },
            { name: 'price', type: 'text', selector: [{ value: '.price' }], transforms: [{ type: 'currency' }] },
            { name: 'url', type: 'href', selector: [{ value: 'h3 a' }] },
            { name: 'missing', type: 'text', selector: [{ value: '.does-not-exist' }] },
          ],
        },
        pagination: { type: 'next', selector: [{ value: 'li.next a' }] },
      },
    },
    output: { keys: ['url'] },
  };
});
afterAll(async () => { await client.close(); app.close(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Scrappia MCP server', () => {
  it('lists the expected tools, resources and prompts', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ['list_recipes', 'get_recipe', 'save_recipe', 'delete_recipe', 'validate_recipe', 'run_recipe', 'get_run', 'list_runs', 'cancel_run', 'get_rows', 'get_drift', 'diff_runs', 'preview_extract', 'scrape_page', 'fetch_page_markdown', 'fetch_page_html', 'generate_recipe', 'ask_page', 'export_run', 'list_examples', 'get_example', 'list_schedules', 'set_schedule', 'list_alerts']) expect(tools).toContain(n);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(['scrappia://recipes/{id}', 'scrappia://runs/{id}/rows']));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toContain('build_scraper');
    const prompt = await client.getPrompt({ name: 'build_scraper', arguments: { url: 'https://example.com', goal: 'titles' } });
    expect(JSON.stringify(prompt.messages)).toContain('preview_extract');
  });

  it('validate_recipe reports errors and structure', async () => {
    const bad = await call('validate_recipe', { recipe: { name: 'x', entry: { urls: ['http://a'], template: 'nope' }, templates: {} } });
    expect(bad.json?.valid).toBe(false);
    expect(JSON.stringify(bad.json?.errors)).toContain('entry.template');
    const good = await call('validate_recipe', { recipe: JSON.stringify(recipe) });
    expect(good.json?.valid).toBe(true);
    expect((good.json?.templates as Record<string, { listFields: string[] }>).listing.listFields).toContain('price');
    const notJson = await call('validate_recipe', { recipe: '{oops' });
    expect(notJson.json?.valid).toBe(false);
  });

  it('save_recipe / list_recipes / get_recipe / recipe resource', async () => {
    const saved = await call('save_recipe', { recipe, id: 'fx', note: 'test' });
    expect(saved.isError).toBeFalsy();
    expect(saved.json?.id).toBe('fx');
    savedId = saved.json?.id as string;
    const list = await call('list_recipes');
    expect((list.json?.recipes as Array<{ id: string }>).map((r) => r.id)).toContain('fx');
    const got = await call('get_recipe', { id: 'fx' });
    expect((got.json?.recipe as { name: string }).name).toBe('fixture');
    const res = await client.readResource({ uri: 'scrappia://recipes/fx' });
    expect(JSON.parse(res.contents[0].text as string).entry.template).toBe('listing');
    const listed = await client.listResources();
    expect(listed.resources.some((r) => r.uri === 'scrappia://recipes/fx')).toBe(true);
    const invalid = await call('save_recipe', { recipe: { name: 'x' } });
    expect(invalid.isError).toBe(true);
  });

  it('preview_extract returns records and a field report', async () => {
    const r = await call('preview_extract', { recipe });
    expect(r.isError).toBeFalsy();
    expect(r.json?.listMatched).toBe(2);
    expect((r.json?.records as unknown[]).length).toBe(2);
    const fields = r.json?.fields as Array<{ field: string; status: string }>;
    expect(fields.find((f) => f.field === 'name')?.status).toBe('ok');
    expect(fields.find((f) => f.field === 'missing')?.status).toBe('NO MATCH');
    const page2 = await call('preview_extract', { recipe, url: `${site.url}/products?page=2`, limit: 1 });
    expect(page2.json?.totalRecords).toBe(2);
    expect((page2.json?.records as unknown[]).length).toBe(1);
  });

  it('scrape_page builds an ad-hoc recipe and returns rows', async () => {
    const r = await call('scrape_page', { url: `${site.url}/products`, mode: 'http', listSelector: 'article.product', fields: [{ name: 'name', selector: 'h3 a', type: 'attr', attr: 'title' }, { name: 'price', selector: '.price' }, { name: 'link', selector: 'h3 a', type: 'href' }] });
    expect(r.isError, r.text).toBeFalsy();
    expect(r.json?.status).toBe('succeeded');
    const rows = r.json?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Product 1');
    expect(rows[0].link).toBe(`${site.url}/product/1`);
    const single = await call('scrape_page', { url: `${site.url}/product/3`, mode: 'http', fields: [{ name: 'title', selector: 'h1.name' }, { name: 'desc', selector: 'xpath://p[@class="desc"]' }] });
    expect((single.json?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ title: 'Product 3', desc: 'About Product 3' });
  });

  it('run_recipe waits, then get_run / get_rows / get_drift / rows resource / export_run', async () => {
    const r = await call('run_recipe', { recipeId: savedId, rowsPreview: 2 });
    expect(r.isError, r.text).toBeFalsy();
    const run = r.json?.run as { id: string; status: string; rows: number; pages: number };
    expect(run.status).toBe('succeeded');
    expect(run.rows).toBe(FIXTURE_PRODUCTS.length);
    expect(run.pages).toBe(2);
    expect((r.json?.rows as unknown[]).length).toBe(2);
    runId = run.id;
    const got = await call('get_run', { runId });
    expect((got.json?.run as { status: string }).status).toBe('succeeded');
    const rows = await call('get_rows', { runId, limit: 3, offset: 1 });
    expect(rows.json?.total).toBe(FIXTURE_PRODUCTS.length);
    expect((rows.json?.rows as unknown[]).length).toBe(3);
    expect(rows.json?.hasMore).toBe(false);
    const drift = await call('get_drift', { runId });
    expect((drift.json?.events as Array<{ kind: string; field?: string }>).some((d) => d.field === 'missing')).toBe(true);
    const res = await client.readResource({ uri: `scrappia://runs/${runId}/rows` });
    expect((res.contents[0].text as string).trim().split('\n')).toHaveLength(FIXTURE_PRODUCTS.length);
    const out = join(dir, 'out.csv');
    const exp = await call('export_run', { runId, sinks: [{ type: 'csv', path: out }] });
    expect(exp.isError, exp.text).toBeFalsy();
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8').trim().split(/\r?\n/)).toHaveLength(FIXTURE_PRODUCTS.length + 1);
    const badSink = await call('export_run', { runId, sinks: [{ type: 'nope' }] });
    expect(badSink.isError).toBe(true);
    const list = await call('list_runs', { recipeId: savedId });
    expect((list.json?.runs as Array<{ id: string }>).some((x) => x.id === runId)).toBe(true);
  });

  it('run_recipe without wait returns immediately; diff_runs compares', async () => {
    const r = await call('run_recipe', { recipe, wait: false, dryRun: true });
    expect(r.json?.status).toBe('running');
    const id2 = r.json?.runId as string;
    await Promise.all(app.activeRuns().map((a) => a.promise));
    const d = await call('diff_runs', { runIdA: runId, runIdB: id2 });
    expect(d.json?.unchanged).toBe(FIXTURE_PRODUCTS.length);
    expect(d.json?.added).toBe(0);
  });

  it('fetch_page_markdown / fetch_page_html', async () => {
    const md = await call('fetch_page_markdown', { url: `${site.url}/products`, maxChars: 2000 });
    expect(md.text).toContain('Product 1');
    expect(md.text).toContain('HTTP 200');
    const html = await call('fetch_page_html', { url: `${site.url}/products`, raw: true, maxChars: 1000 });
    expect(html.text).toContain('class="product"');
  });

  it('examples, schedules and alerts', async () => {
    const ex = await call('list_examples');
    expect((ex.json?.examples as Array<{ name: string }>).map((e) => e.name)).toContain('books-toscrape');
    const one = await call('get_example', { name: 'hacker-news-monitor' });
    expect((one.json?.recipe as { entry: { template: string } }).entry.template).toBe('front');
    const set = await call('set_schedule', { recipeId: savedId, cron: '0 */6 * * *', tz: 'UTC' });
    expect(set.isError, set.text).toBeFalsy();
    expect((set.json?.nextRuns as string[]).length).toBe(3);
    const bad = await call('set_schedule', { recipeId: savedId, cron: 'nope nope' });
    expect(bad.isError).toBe(true);
    const list = await call('list_schedules');
    expect((list.json?.schedules as Array<{ recipeId: string; cron: string }>).find((s) => s.recipeId === savedId)?.cron).toBe('0 */6 * * *');
    const removed = await call('set_schedule', { recipeId: savedId, remove: true });
    expect(removed.json?.removed).toBe(true);
    const alerts = await call('list_alerts');
    expect(Array.isArray(alerts.json?.alerts)).toBe(true);
  });

  it('AI tools fail cleanly without a provider', async () => {
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OLLAMA_HOST: process.env.OLLAMA_HOST, SCRAPPIA_OLLAMA: process.env.SCRAPPIA_OLLAMA };
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      const noAiApp = new ScrappiaApp({ dataDir: dir, storage: new SqliteStorage(), logger: new Logger('error') });
      const server = createMcpServer(noAiApp);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c2 = new Client({ name: 't2', version: '0' });
      await c2.connect(ct);
      const r = (await c2.callTool({ name: 'generate_recipe', arguments: { url: `${site.url}/products`, instruction: 'products' } })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('no AI provider');
      await c2.close(); noAiApp.close();
    } finally { for (const [k, v] of Object.entries(saved)) if (v != null) process.env[k] = v; }
  });

  it('delete_recipe removes the recipe', async () => {
    const r = await call('delete_recipe', { id: savedId });
    expect(r.json?.deleted).toBe(true);
    expect((await call('get_recipe', { id: savedId })).isError).toBe(true);
  });

  it('serves Streamable HTTP with bearer auth', async () => {
    const server = await startHttp(app, { port: 0, token: 'secret-token' });
    const { port } = server.address() as { port: number };
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    try {
      const unauth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(unauth.status).toBe(401);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect((await health.json() as { ok: boolean }).ok).toBe(true);
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer secret-token' } } });
      const c = new Client({ name: 'http-client', version: '0' });
      await c.connect(transport);
      const tools = (await c.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('scrape_page');
      const r = (await c.callTool({ name: 'list_examples', arguments: {} })) as { content: Array<{ text?: string }> };
      expect(r.content[0].text).toContain('books-toscrape');
      await c.close();
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});
