import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrappiaApp, SqliteStorage, Logger, startMockLlm, type MockChatRequest, type MockScript } from '@scrappia/core';
import { createServer, type ServerOptions } from './server.js';

// ---------- inline fixture site: 3 pages x 4 products with next links ----------

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: `$${(10 + i).toFixed(2)}` }));
const PER_PAGE = 4;

function page(n: number): string {
  const pages = Math.ceil(PRODUCTS.length / PER_PAGE);
  const items = PRODUCTS.slice((n - 1) * PER_PAGE, n * PER_PAGE)
    .map((p) => `<article class="product"><h3><a href="/product/${p.id}" title="${p.name}">${p.name}</a></h3><span class="price">${p.price}</span></article>`)
    .join('');
  const next = n < pages ? `<li class="next"><a href="/products?page=${n + 1}">next</a></li>` : '';
  return `<!doctype html><html><head><title>Products ${n}</title></head><body><div class="list">${items}</div><ul>${next}</ul></body></html>`;
}

function startFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/products' || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(Number(url.searchParams.get('page') ?? 1)));
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>404</h1>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

// ---------- mock-script helpers (mirror packages/core/src/test/mockLlm.ts, which only exports startMockLlm) ----------

function lastUser(req: MockChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === 'user') return req.messages[i].content;
  return '';
}
function toolResult(req: MockChatRequest, tool: string): Record<string, unknown> | undefined {
  const last = lastUser(req);
  if (!last.startsWith('[Tool results]')) return undefined;
  const line = last.split('\n').find((l) => l.startsWith(`${tool}: `));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(tool.length + 2).replace(/…\(truncated\)$/, '')); } catch { return undefined; }
}
const turn = (reply: string, calls: Array<[string, Record<string, unknown>]> = [], done = false) => ({ reply, calls: calls.map(([tool, args]) => ({ tool, args: JSON.stringify(args) })), done });

// ---------- app / server helpers ----------

const quiet = new Logger('error');
const BOOT = 'bootstrap-test-key';
const tmpDirs: string[] = [];
let site: Awaited<ReturnType<typeof startFixture>>;

beforeAll(async () => { site = await startFixture(); });
afterAll(async () => { await site.close(); for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function makeApp(opts: Partial<ServerOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'scrappia-copilot-'));
  tmpDirs.push(dataDir);
  const app = new ScrappiaApp({ storage: new SqliteStorage(), dataDir, logger: quiet });
  const server = createServer(app, { bootstrapKey: BOOT, logger: quiet, heartbeatMs: 200, ...opts });
  const auth = { Authorization: `Bearer ${BOOT}` };
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
    const res = await server.request(path, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, server, api, auth, dataDir };
}

/** Start a scripted model and point the app's AI settings at it. */
async function withMock(app: ScrappiaApp, script: MockScript) {
  const mock = await startMockLlm(script);
  app.saveSettings({ ai: { providers: [{ name: 'mock', kind: 'openai-compatible', baseUrl: mock.url, model: 'mock-1' }], default: 'mock' }, defaults: {} });
  return mock;
}

const AI_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST', 'SCRAPPIA_OLLAMA'];
function withoutAiEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(AI_ENV.map((k) => [k, process.env[k]]));
  for (const k of AI_ENV) delete process.env[k];
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; });
}

// ---------- tests ----------

describe('copilot sessions', () => {
  it('400 ai_not_configured when no provider exists', async () => {
    const { api } = makeApp();
    await withoutAiEnv(async () => {
      const r = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('ai_not_configured');
    });
  });

  it('validates the create body and unknown providers', async () => {
    const { app, api } = makeApp();
    const mock = await withMock(app, () => turn('?', []));
    try {
      expect((await api('POST', '/api/copilot/sessions', {})).json.error.code).toBe('validation_error');
      expect((await api('POST', '/api/copilot/sessions', { url: 'nope' })).status).toBe(400);
      const unknown = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products`, provider: 'does-not-exist' });
      expect(unknown.status).toBe(400);
      expect(unknown.json.error.code).toBe('unknown_provider');
      const badRecipe = await api('POST', '/api/copilot/sessions', { recipe: { name: 'x' } });
      expect(badRecipe.status).toBe(400);
      expect(badRecipe.json.error.code).toBe('invalid_recipe');
    } finally { await mock.close(); }
  });

  it('creates a session from a url with the minimal recipe, from a recipe as given, and reports history', async () => {
    const { app, api } = makeApp();
    const mock = await withMock(app, () => turn('Hello! What should I scrape?', []));
    try {
      const created = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      expect(created.status).toBe(201);
      expect(created.json.id).toBeTruthy();
      expect(created.json.provider).toBe('mock');
      expect(created.json.recipe).toMatchObject({ name: 'Untitled', entry: { urls: [`${site.url}/products`], template: 'main' } });
      expect(created.json.recipe.templates.main).toBeTruthy();

      const fromRecipe = await api('POST', '/api/copilot/sessions', { recipe: { name: 'Given', entry: { urls: [`${site.url}/products`], template: 'main' }, templates: { main: {} } }, instructions: 'Always answer in English.' });
      expect(fromRecipe.status).toBe(201);
      expect(fromRecipe.json.recipe.name).toBe('Given');

      const t = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, { message: 'hi' });
      expect(t.status).toBe(200);
      expect(t.json.reply).toMatch(/what should I scrape/i);
      expect(t.json.actions).toEqual([]);
      expect(t.json.done).toBe(false);
      expect(t.json.waitingForPicks).toBe(false);
      expect(t.json.usage.calls).toBe(1);
      // the system prompt carries the extra instructions for the second session only
      expect(mock.requests[0].messages[0].content).not.toContain('Always answer in English');

      const got = await api('GET', `/api/copilot/sessions/${created.json.id}`);
      expect(got.status).toBe(200);
      expect(got.json.recipe.name).toBe('Untitled');
      expect(got.json.history.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'assistant']);
      expect(got.json.history[0].content).toBe('hi');
      expect(got.json.runIds).toEqual([]);

      const empty = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, {});
      expect(empty.status).toBe(400);
      expect(empty.json.error.code).toBe('validation_error');
    } finally { await mock.close(); }
  });

  it('scrape products: detect_lists -> set_list -> add_sink jsonl -> test_run -> start_run, run visible under /api/runs', async () => {
    const { app, api, dataDir } = makeApp();
    const mock = await withMock(app, (req) => {
      const last = lastUser(req);
      if (last.startsWith('[Tool results]')) {
        const lists = toolResult(req, 'detect_lists');
        if (lists) {
          const l = (lists.lists as Array<{ selector: string[] }>)[0];
          return turn('Found the product list. Setting it up.', [['set_list', { selector: l.selector[0], fields: [
            { name: 'name', type: 'attr', attr: 'title', selector: 'h3 a' },
            { name: 'price', selector: '.price', transforms: ['currency'] },
            { name: 'url', type: 'href', selector: 'h3 a' },
          ] }]]);
        }
        if (toolResult(req, 'set_list')) return turn('Fields verified. Adding pagination, a JSONL export and testing.', [
          ['set_pagination', { pagination: { type: 'next', selector: 'li.next a' } }],
          ['configure', { section: 'engine', patch: { mode: 'http', delayMs: 0, jitterMs: 0 } }],
          ['configure', { section: 'output', patch: { keys: ['url'] } }],
          ['add_sink', { sink: { type: 'jsonl', path: 'copilot/products.jsonl', mode: 'overwrite' } }],
          ['rename_recipe', { name: 'Fixture products' }],
          ['test_run', { maxRequests: 2 }],
        ]);
        if (toolResult(req, 'test_run')) {
          const tr = toolResult(req, 'test_run')!;
          expect((tr.stats as { rows: number }).rows).toBeGreaterThan(0);
          return turn('Test run OK. Starting the full run as requested.', [['start_run', {}]]);
        }
        if (toolResult(req, 'start_run')) return turn('Running; results will land in products.jsonl.', [], true);
      }
      return turn('Looking at the page.', [['detect_lists', {}]]);
    });
    try {
      const created = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      expect(created.status).toBe(201);
      const id = created.json.id as string;

      const t = await api('POST', `/api/copilot/sessions/${id}/turn`, { message: 'scrape products with name, price and url, then run it' });
      expect(t.status).toBe(200);
      expect(t.json.done).toBe(true);
      expect(t.json.runId).toBeTruthy();
      expect(t.json.actions.map((a: { tool: string }) => a.tool)).toEqual(['detect_lists', 'set_list', 'set_pagination', 'configure', 'configure', 'add_sink', 'rename_recipe', 'test_run', 'start_run']);
      expect(t.json.actions.every((a: { ok: boolean }) => a.ok)).toBe(true);
      const recipe = t.json.recipe;
      expect(recipe.name).toBe('Fixture products');
      expect(recipe.entry.urls).toEqual([`${site.url}/products`]);
      expect(recipe.templates.main.list.selector[0].value).toBe('article.product');
      expect(recipe.templates.main.list.fields.map((f: { name: string }) => f.name)).toEqual(['name', 'price', 'url']);
      expect(recipe.templates.main.pagination.type).toBe('next');
      expect(recipe.sinks).toEqual([expect.objectContaining({ type: 'jsonl', path: 'copilot/products.jsonl' })]);
      expect(recipe.output.keys).toEqual(['url']);

      // the session tracks the run and the recipe it ended with
      const got = await api('GET', `/api/copilot/sessions/${id}`);
      expect(got.json.runIds).toEqual([t.json.runId]);
      expect(got.json.recipe.name).toBe('Fixture products');

      // the run started by the copilot is a regular app run: visible, then finished with all rows
      let run = await api('GET', `/api/runs/${t.json.runId}`);
      expect(run.status).toBe(200);
      expect(run.json.run.trigger).toBe('copilot');
      for (let i = 0; i < 100 && run.json.run.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 100)); run = await api('GET', `/api/runs/${t.json.runId}`); }
      expect(run.json.run.status).toBe('succeeded');
      expect(run.json.stats.rows).toBe(PRODUCTS.length);
      const rows = await api('GET', `/api/runs/${t.json.runId}/rows`);
      expect(rows.json.total).toBe(PRODUCTS.length);
      expect(rows.json.rows[0]).toMatchObject({ name: 'Product 1', price: 10 });
      expect(existsSync(join(dataDir, 'copilot', 'products.jsonl'))).toBe(true);
      // the dry test run was recorded too
      const runs = await api('GET', '/api/runs');
      expect(runs.json.runs.map((r: { trigger: string }) => r.trigger).sort()).toEqual(['copilot', 'copilot-test']);
    } finally { await mock.close(); }
  });

  it('enable_picking fails with an explanatory tool error (no browser) and the turn survives', async () => {
    const { app, api } = makeApp();
    const mock = await withMock(app, (req) => {
      const last = lastUser(req);
      if (last.startsWith('[Tool results]')) {
        expect(last).toMatch(/enable_picking: \{"error":"element picking is not available/);
        return turn('Picking is not available here, so I will detect the list automatically instead.', []);
      }
      return turn('Click a product card.', [['enable_picking', { mode: 'pickList', instruction: 'Click one product card' }]]);
    });
    try {
      const created = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      const t = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, { message: 'let me pick the elements' });
      expect(t.status).toBe(200);
      expect(t.json.actions).toHaveLength(1);
      expect(t.json.actions[0].tool).toBe('enable_picking');
      expect(t.json.actions[0].ok).toBe(false);
      expect(t.json.actions[0].summary).toMatch(/element picking is not available in this session \(no browser\)/);
      expect(t.json.waitingForPicks).toBe(false);
      expect(t.json.reply).toMatch(/detect the list/i);
    } finally { await mock.close(); }
  });

  it('?stream=1 sends progress events then a final result', async () => {
    const { app, api } = makeApp();
    const mock = await withMock(app, (req) => lastUser(req).startsWith('[Tool results]') ? turn('Here is the recipe.', []) : turn('Reading the recipe.', [['get_recipe', {}]]));
    try {
      const created = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      const r = await api('POST', `/api/copilot/sessions/${created.json.id}/turn?stream=1`, { message: 'show me the recipe' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      const events = r.text.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
        const ev = /^event: (.+)$/m.exec(block)![1];
        const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]);
        return { ev, data };
      });
      const progress = events.filter((e) => e.ev === 'progress').map((e) => e.data.type);
      expect(progress).toEqual(['thinking', 'call', 'result', 'thinking', 'reply']);
      const result = events.find((e) => e.ev === 'result')!;
      expect(events[events.length - 1]).toBe(result);
      expect(result.data.reply).toBe('Here is the recipe.');
      expect(result.data.actions[0]).toMatchObject({ tool: 'get_recipe', ok: true });
      expect(result.data.recipe.name).toBe('Untitled');
    } finally { await mock.close(); }
  });

  it('a turn can replace the working recipe; provider failures come back as 502 copilot_failed', async () => {
    const { app, api } = makeApp();
    let fail = false;
    const mock = await withMock(app, () => { if (fail) throw new Error('boom'); return turn('ok', []); });
    try {
      const created = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      const t = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, { message: 'use this', recipe: { name: 'Replaced', entry: { urls: [`${site.url}/products`], template: 'main' }, templates: { main: {} } } });
      expect(t.status).toBe(200);
      expect(t.json.recipe.name).toBe('Replaced');
      expect((await api('GET', `/api/copilot/sessions/${created.json.id}`)).json.recipe.name).toBe('Replaced');
      const bad = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, { message: 'x', recipe: { name: 'broken' } });
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe('invalid_recipe');
      fail = true;
      const err = await api('POST', `/api/copilot/sessions/${created.json.id}/turn`, { message: 'again' });
      expect(err.status).toBe(502);
      expect(err.json.error.code).toBe('copilot_failed');
    } finally { await mock.close(); }
  });

  it('sessions expire when idle, are scoped to the key, can be deleted, and are capped per key', async () => {
    let now = 1_000_000;
    const { app, api } = makeApp({ copilot: { idleMs: 1000, maxPerKey: 2, now: () => now } });
    const mock = await withMock(app, () => turn('ok', []));
    try {
      const a = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      const b = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      const capped = await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` });
      expect(capped.status).toBe(429);
      expect(capped.json.error.code).toBe('copilot_session_limit');

      // another key cannot see it
      const otherKey = app.createApiKey('other', 'read,write');
      expect((await api('GET', `/api/copilot/sessions/${a.json.id}`, undefined, { Authorization: `Bearer ${otherKey}` })).status).toBe(404);
      for (const k of app.storage.listApiKeys()) app.storage.deleteApiKey(k.id); // re-enables the bootstrap key

      // delete frees a slot
      expect((await api('DELETE', `/api/copilot/sessions/${b.json.id}`)).json).toEqual({ ok: true, id: b.json.id });
      expect((await api('DELETE', `/api/copilot/sessions/${b.json.id}`)).status).toBe(404);
      expect((await api('POST', `/api/copilot/sessions/${b.json.id}/turn`, { message: 'hi' })).status).toBe(404);
      expect((await api('POST', '/api/copilot/sessions', { url: `${site.url}/products` })).status).toBe(201);

      // idle expiry: touching keeps it alive, silence drops it
      now += 800;
      expect((await api('GET', `/api/copilot/sessions/${a.json.id}`)).status).toBe(200);
      now += 800;
      expect((await api('GET', `/api/copilot/sessions/${a.json.id}`)).status).toBe(200);
      now += 1001;
      const gone = await api('GET', `/api/copilot/sessions/${a.json.id}`);
      expect(gone.status).toBe(404);
      expect(gone.json.error.code).toBe('not_found');
    } finally { await mock.close(); }
  });

  it('documents the copilot routes in the OpenAPI spec', async () => {
    const { api } = makeApp();
    const spec = await api('GET', '/api/openapi.json', undefined, {});
    expect(Object.keys(spec.json.paths)).toEqual(expect.arrayContaining(['/api/copilot/sessions', '/api/copilot/sessions/{id}', '/api/copilot/sessions/{id}/turn']));
    expect(spec.json.components.schemas.CopilotTurnResult).toBeTruthy();
    expect(spec.json.tags.map((t: { name: string }) => t.name)).toContain('Copilot');
  });
});
