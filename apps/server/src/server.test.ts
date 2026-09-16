import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrappiaApp, SqliteStorage, Logger, type RecipeInput } from '@scrappia/core';
import { createServer, type ServerOptions } from './server.js';

// ---------- minimal fixture site: 3 pages x 4 products with next links ----------

const PRODUCTS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: `$${(10 + i).toFixed(2)}` }));
const PER_PAGE = 4;

function page(n: number): string {
  const pages = Math.ceil(PRODUCTS.length / PER_PAGE);
  const items = PRODUCTS.slice((n - 1) * PER_PAGE, n * PER_PAGE)
    .map((p) => `<article class="product"><h3><a href="/product/${p.id}" title="${p.name}">${p.name}</a></h3><span class="price">${p.price}</span></article>`)
    .join('');
  const next = n < pages ? `<li class="next"><a href="/products?page=${n + 1}">next</a></li>` : '';
  return `<!doctype html><html><body><div class="list">${items}</div><ul>${next}</ul></body></html>`;
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

// ---------- helpers ----------

const quiet = new Logger('error');
const BOOT = 'bootstrap-test-key';
const tmpDirs: string[] = [];

function makeApp(opts: Partial<ServerOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'scrappia-server-'));
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
  return { app, server, api, auth };
}

function fixtureRecipe(base: string, extra: Partial<RecipeInput> = {}): RecipeInput {
  return {
    name: 'fixture',
    entry: { urls: [`${base}/products`], template: 'listing' },
    engine: { mode: 'http', concurrency: 2, delayMs: 0, jitterMs: 0, retries: 1 },
    templates: {
      listing: {
        list: {
          selector: [{ value: 'article.product' }],
          fields: [
            { name: 'name', type: 'attr', attr: 'title', selector: [{ value: 'h3 a' }] },
            { name: 'price', type: 'text', selector: [{ value: '.price' }], transforms: [{ type: 'currency' }] },
            { name: 'url', type: 'href', selector: [{ value: 'h3 a' }] },
          ],
        },
        pagination: { type: 'next', selector: [{ value: 'li.next a' }] },
      },
    },
    output: { keys: ['url'] },
    ...extra,
  };
}

async function waitForRun(api: ReturnType<typeof makeApp>['api'], id: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/api/runs/${id}`);
    expect(r.status).toBe(200);
    if (r.json.run.status !== 'running') return r.json;
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${id} did not finish: ${JSON.stringify(r.json.run)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let site: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => { site = await startFixture(); });
afterAll(async () => { await site.close(); for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// ---------- tests ----------

describe('health and errors', () => {
  it('GET /health needs no auth', async () => {
    const { api } = makeApp();
    const r = await api('GET', '/health', undefined, {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, activeRuns: 0 });
    expect(typeof r.json.version).toBe('string');
  });

  it('unknown routes return the JSON error shape', async () => {
    const { api } = makeApp();
    const r = await api('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });

  it('serves the OpenAPI document and docs page without auth', async () => {
    const { api } = makeApp();
    const spec = await api('GET', '/api/openapi.json', undefined, {});
    expect(spec.status).toBe(200);
    expect(spec.json.openapi).toBe('3.1.0');
    expect(Object.keys(spec.json.paths)).toEqual(expect.arrayContaining(['/api/recipes', '/api/runs/{id}/rows', '/api/runs/{id}/events', '/api/recipes/{id}/dataset/latest']));
    const docs = await api('GET', '/docs', undefined, {});
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('/api/openapi.json');
  });
});

describe('auth', () => {
  it('rejects requests without a key', async () => {
    const { api } = makeApp();
    const r = await api('GET', '/api/recipes', undefined, {});
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthorized');
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects an invalid key', async () => {
    const { api } = makeApp();
    const r = await api('GET', '/api/recipes', undefined, { 'x-api-key': 'nope' });
    expect(r.status).toBe(401);
  });

  it('accepts the bootstrap env key via Bearer and x-api-key while no keys exist', async () => {
    const { api } = makeApp();
    expect((await api('GET', '/api/recipes')).status).toBe(200);
    expect((await api('GET', '/api/recipes', undefined, { 'x-api-key': BOOT })).status).toBe(200);
  });

  it('enforces scopes and disables the bootstrap key once a real key exists', async () => {
    const { api } = makeApp();
    const created = await api('POST', '/api/api-keys', { name: 'reader', scopes: ['read'] });
    expect(created.status).toBe(201);
    const reader = { Authorization: `Bearer ${created.json.key}` };
    expect((await api('GET', '/api/recipes', undefined, reader)).status).toBe(200);
    const denied = await api('POST', '/api/recipes/validate', { name: 'x' }, reader);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    // bootstrap key no longer accepted
    expect((await api('GET', '/api/recipes')).status).toBe(401);
  });

  it('allows unauthenticated loopback requests only when nothing is configured', async () => {
    const local = makeApp({ bootstrapKey: undefined, remoteAddress: () => '127.0.0.1' });
    expect((await local.api('GET', '/api/recipes', undefined, {})).status).toBe(200);
    const remote = makeApp({ bootstrapKey: undefined, remoteAddress: () => '10.0.0.5' });
    expect((await remote.api('GET', '/api/recipes', undefined, {})).status).toBe(401);
    const proxied = makeApp({ bootstrapKey: undefined, remoteAddress: () => '127.0.0.1' });
    expect((await proxied.api('GET', '/api/recipes', undefined, { 'x-forwarded-for': '1.2.3.4' })).status).toBe(401);
  });

  it('rate limits per key with Retry-After', async () => {
    const { api } = makeApp({ rateLimitPerMinute: 2 });
    expect((await api('GET', '/api/recipes')).status).toBe(200);
    expect((await api('GET', '/api/recipes')).status).toBe(200);
    const r = await api('GET', '/api/recipes');
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('rate_limited');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});

describe('recipes', () => {
  it('CRUD + versions + validation errors', async () => {
    const { api } = makeApp();
    const recipe = fixtureRecipe(site.url, { name: 'Books' });

    const bad = await api('POST', '/api/recipes', { name: 'broken', entry: { urls: ['http://x'], template: 'missing' }, templates: {} });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_recipe');
    expect(bad.json.error.details.join(' ')).toMatch(/entry.template/);

    const notJson = await api('POST', '/api/recipes', undefined, { Authorization: `Bearer ${BOOT}` });
    expect(notJson.status).toBe(400);

    const validate = await api('POST', '/api/recipes/validate', { name: 'x' });
    expect(validate.status).toBe(200);
    expect(validate.json.valid).toBe(false);
    expect(validate.json.errors.length).toBeGreaterThan(0);
    const validateOk = await api('POST', '/api/recipes/validate', recipe);
    expect(validateOk.json).toMatchObject({ valid: true, errors: [] });

    const created = await api('POST', '/api/recipes', recipe);
    expect(created.status).toBe(201);
    const id = created.json.recipe.id as string;
    expect(created.json.recipe).toMatchObject({ name: 'Books', version: 1 });

    const list = await api('GET', '/api/recipes');
    expect(list.json.recipes.map((r: { id: string }) => r.id)).toContain(id);

    const got = await api('GET', `/api/recipes/${id}`);
    expect(got.status).toBe(200);
    expect(got.json.recipe.json.entry.template).toBe('listing');

    const updated = await api('PUT', `/api/recipes/${id}`, { ...recipe, name: 'Books v2' });
    expect(updated.status).toBe(200);
    expect(updated.json.recipe).toMatchObject({ id, name: 'Books v2', version: 2 });

    const versions = await api('GET', `/api/recipes/${id}/versions`);
    expect(versions.json.versions).toHaveLength(2);

    expect((await api('PUT', '/api/recipes/does-not-exist', recipe)).status).toBe(404);
    expect((await api('GET', '/api/recipes/does-not-exist')).status).toBe(404);

    const del = await api('DELETE', `/api/recipes/${id}`);
    expect(del.status).toBe(200);
    expect((await api('GET', `/api/recipes/${id}`)).status).toBe(404);
  });

  it('preview extracts records from one page over HTTP', async () => {
    const { api } = makeApp();
    const created = await api('POST', '/api/recipes', fixtureRecipe(site.url));
    const r = await api('POST', `/api/recipes/${created.json.recipe.id}/preview`, {});
    expect(r.status).toBe(200);
    expect(r.json.listMatched).toBe(4);
    expect(r.json.records[0].name).toBe('Product 1');
  });
});

describe('runs', () => {
  it('ad-hoc run: 202, poll to completion, rows as json/csv/jsonl, requests, drift', async () => {
    const { api } = makeApp();
    const started = await api('POST', '/api/runs', fixtureRecipe(site.url));
    expect(started.status).toBe(202);
    const runId = started.json.runId as string;
    expect(typeof runId).toBe('string');

    const detail = await waitForRun(api, runId);
    expect(detail.run.status).toBe('succeeded');
    expect(detail.active).toBe(false);
    expect(detail.stats.rows).toBe(12);
    expect(detail.queue.done).toBe(3);
    expect(detail.datasets).toEqual([{ dataset: expect.any(String), rows: 12 }]);

    const rows = await api('GET', `/api/runs/${runId}/rows?limit=5&offset=10`);
    expect(rows.status).toBe(200);
    expect(rows.json).toMatchObject({ total: 12, offset: 10, limit: 5 });
    expect(rows.json.rows).toHaveLength(2);
    expect(rows.json.rows[0]).toMatchObject({ name: 'Product 11', price: 20 });

    const csv = await api('GET', `/api/runs/${runId}/rows?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines).toHaveLength(13);
    expect(lines[0]).toBe('name,price,url');
    expect(lines[1]).toBe(`Product 1,10,${site.url}/product/1`);

    const jsonl = await api('GET', `/api/runs/${runId}/rows?format=jsonl&limit=3`);
    expect(jsonl.headers.get('content-type')).toContain('application/x-ndjson');
    const parsed = jsonl.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(3);
    expect(parsed[2].name).toBe('Product 3');

    const requests = await api('GET', `/api/runs/${runId}/requests?status=done`);
    expect(requests.json.requests).toHaveLength(3);
    expect(requests.json.counts.done).toBe(3);

    const drift = await api('GET', `/api/runs/${runId}/drift`);
    expect(drift.json.drift).toEqual([]);

    const list = await api('GET', '/api/runs?status=succeeded');
    expect(list.json.runs.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await api('GET', '/api/runs?status=bogus')).status).toBe(400);

    expect((await api('POST', `/api/runs/${runId}/cancel`)).status).toBe(409);
    expect((await api('GET', '/api/runs/nope')).status).toBe(404);
    expect((await api('GET', '/api/runs/nope/rows')).status).toBe(404);

    const del = await api('DELETE', `/api/runs/${runId}`);
    expect(del.status).toBe(200);
    expect((await api('GET', `/api/runs/${runId}`)).status).toBe(404);
  });

  it('recipe run, dataset/latest, diff against previous run, export', async () => {
    const { api } = makeApp();
    const created = await api('POST', '/api/recipes', fixtureRecipe(site.url));
    const id = created.json.recipe.id as string;

    expect((await api('GET', `/api/recipes/${id}/dataset/latest`)).status).toBe(404);

    const run1 = await api('POST', `/api/recipes/${id}/run`, { trigger: 'test' });
    expect(run1.status).toBe(202);
    expect(run1.json.run.trigger).toBe('test');
    await waitForRun(api, run1.json.runId);

    const latest = await api('GET', `/api/recipes/${id}/dataset/latest`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get('x-scrappia-run')).toBe(run1.json.runId);
    expect(latest.json.total).toBe(12);

    const latestCsv = await api('GET', `/api/recipes/${id}/dataset/latest?format=csv&limit=2`);
    expect(latestCsv.text.trim().split('\r\n')).toHaveLength(3);

    const run2 = await api('POST', `/api/recipes/${id}/run`);
    await waitForRun(api, run2.json.runId);
    const diff = await api('GET', `/api/runs/${run2.json.runId}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.json.against).toBe(run1.json.runId);
    expect(diff.json.summary).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 12 });
    expect((await api('GET', `/api/runs/${run1.json.runId}/diff`)).json.error.code).toBe('no_previous_run');

    const outDir = mkdtempSync(join(tmpdir(), 'scrappia-export-'));
    tmpDirs.push(outDir);
    const exp = await api('POST', `/api/runs/${run2.json.runId}/export`, { sinks: [{ type: 'jsonl', path: join(outDir, 'out.jsonl') }] });
    expect(exp.status).toBe(200);
    expect(exp.json.exports[0]).toMatchObject({ type: 'jsonl', rows: 12 });
    expect((await api('POST', `/api/runs/${run2.json.runId}/export`, { sinks: [{ type: 'nope' }] })).status).toBe(400);
  });

  it('streams SSE events for a run and closes after run.done', async () => {
    const { api, server, auth } = makeApp();
    const started = await api('POST', '/api/runs', fixtureRecipe(site.url));
    const runId = started.json.runId as string;

    const res = await server.request(`/api/runs/${runId}/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
      const type = /^event: (.+)$/m.exec(block)![1];
      const data = /^data: (.+)$/m.exec(block)![1];
      return { type, data: JSON.parse(data) };
    });
    expect(events[0].type).toBe('ready');
    const done = events.find((e) => e.type === 'run.done');
    expect(done).toBeDefined();
    expect(done!.data.run.id).toBe(runId);
    expect(done!.data.run.status).toBe('succeeded');

    // late subscriber to a finished run gets a synthetic run.done and the stream ends
    const late = await server.request(`/api/runs/${runId}/events`, { headers: auth });
    const lateText = await late.text();
    expect(lateText).toContain('event: run.done');
  });
});

describe('settings, secrets, api keys', () => {
  it('api keys: create, list, delete', async () => {
    const { api } = makeApp();
    const created = await api('POST', '/api/api-keys', { name: 'ci' });
    expect(created.status).toBe(201);
    expect(created.json.key).toMatch(/^sk_/);
    expect(created.json.scopes).toEqual(['read', 'write']);
    const key = { Authorization: `Bearer ${created.json.key}` };

    const list = await api('GET', '/api/api-keys', undefined, key);
    expect(list.json.keys).toHaveLength(1);
    expect(list.json.keys[0]).toMatchObject({ id: created.json.id, name: 'ci' });
    expect(JSON.stringify(list.json)).not.toContain(created.json.key);

    expect((await api('POST', '/api/api-keys', { name: '' }, key)).status).toBe(400);
    expect((await api('DELETE', '/api/api-keys/nope', undefined, key)).status).toBe(404);
    expect((await api('DELETE', `/api/api-keys/${created.json.id}`, undefined, key)).status).toBe(200);
    expect((await api('GET', '/api/api-keys', undefined, key)).status).toBe(401);
  });

  it('secrets are write-only; settings mask literal provider keys', async () => {
    const { api } = makeApp();
    expect((await api('GET', '/api/secrets/MY_TOKEN')).status).toBe(404);
    expect((await api('PUT', '/api/secrets/MY_TOKEN', { value: 'hunter2' })).status).toBe(201);
    expect((await api('PUT', '/api/secrets/bad name', { value: 'x' })).status).toBe(400);
    expect((await api('GET', '/api/secrets/MY_TOKEN')).json).toEqual({ name: 'MY_TOKEN', exists: true, source: 'store' });
    expect((await api('GET', '/api/secrets')).json.names).toEqual(['MY_TOKEN']);

    const put = await api('PUT', '/api/settings', { ai: { providers: [{ name: 'ref', kind: 'openai-compatible', apiKey: 'MY_TOKEN', model: 'm' }, { name: 'lit', kind: 'openai-compatible', apiKey: 'literal-secret', model: 'm' }], default: 'ref' }, defaults: {} });
    expect(put.status).toBe(200);
    const get = await api('GET', '/api/settings');
    const providers = get.json.settings.ai.providers;
    expect(providers[0].apiKey).toBe('MY_TOKEN');
    expect(providers[1].apiKey).toBe('***');
    expect(get.text).not.toContain('literal-secret');
    expect(get.text).not.toContain('hunter2');

    // sending the mask back keeps the stored literal
    await api('PUT', '/api/settings', { ai: { providers, default: 'lit' }, defaults: {} });
    expect((await api('GET', '/api/settings')).json.settings.ai.default).toBe('lit');
    expect((await api('PUT', '/api/settings', { ai: { providers: [], default: 'ghost' } })).status).toBe(400);

    expect((await api('DELETE', '/api/secrets/MY_TOKEN')).status).toBe(200);
    expect((await api('GET', '/api/secrets/MY_TOKEN')).status).toBe(404);
  });
});

describe('schedules, alerts, reference', () => {
  it('previews cron expressions and lists schedules from recipes', async () => {
    const { api } = makeApp();
    const preview = await api('POST', '/api/schedules/preview', { cron: '0 */6 * * *', tz: 'UTC' });
    expect(preview.status).toBe(200);
    expect(preview.json.next).toHaveLength(5);
    expect(preview.json.next[0]).toMatch(/T(00|06|12|18):00:00\.000Z$/);
    const bad = await api('POST', '/api/schedules/preview', { cron: 'not a cron' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_cron');

    const created = await api('POST', '/api/recipes', fixtureRecipe(site.url, { schedule: { cron: '0 0 * * *', tz: 'UTC' } }));
    const schedules = await api('GET', '/api/schedules');
    expect(schedules.json.schedules).toHaveLength(1);
    expect(schedules.json.schedules[0]).toMatchObject({ recipeId: created.json.recipe.id, cron: '0 0 * * *', recipeName: 'fixture' });
    expect((await api('GET', '/api/schedules/next')).status).toBe(200);
  });

  it('alerts, examples and sink types', async () => {
    const { api, app } = makeApp();
    app.storage.addAlert({ kind: 'test', title: 'hi', body: 'there', detail: {} });
    const unread = await api('GET', '/api/alerts?unread=1');
    expect(unread.json.alerts).toHaveLength(1);
    expect((await api('POST', '/api/alerts/read', { all: true })).status).toBe(200);
    expect((await api('GET', '/api/alerts?unread=1')).json.alerts).toHaveLength(0);

    const examples = await api('GET', '/api/examples');
    expect(examples.json.examples.map((e: { name: string }) => e.name)).toContain('books-toscrape');
    const sinks = await api('GET', '/api/sink-types');
    expect(sinks.json.types).toEqual(expect.arrayContaining(['csv', 'jsonl', 'webhook']));
  });

  it('AI endpoints fail cleanly without a provider', async () => {
    const { api } = makeApp();
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OLLAMA_HOST: process.env.OLLAMA_HOST, SCRAPPIA_OLLAMA: process.env.SCRAPPIA_OLLAMA };
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      const r = await api('POST', '/api/ai/generate', { url: `${site.url}/products`, instruction: 'names and prices' });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('ai_not_configured');
      expect((await api('POST', '/api/ai/ask', { url: 'not-a-url', question: 'q' })).status).toBe(400);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});
