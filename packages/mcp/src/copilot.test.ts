import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ScrappiaApp, SqliteStorage, Logger, startMockLlm, type MockChatRequest, type MockScript } from '@scrappia/core';
import { createMcpServer, copilotStoreFor } from './index.js';
import { startFixture, FIXTURE_PRODUCTS } from './test/fixture.js';

// mock-script helpers (core exports startMockLlm only)
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

let site: Awaited<ReturnType<typeof startFixture>>;
let dir: string;
let app: ScrappiaApp;
let client: Client;
let script: MockScript = () => turn('?', []);
let mock: Awaited<ReturnType<typeof startMockLlm>>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; json?: Record<string, unknown>; isError?: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content.map((c) => c.text ?? '').join('');
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { text, json, isError: r.isError };
}

beforeAll(async () => {
  site = await startFixture();
  dir = mkdtempSync(join(tmpdir(), 'scrappia-mcp-copilot-'));
  app = new ScrappiaApp({ dataDir: dir, storage: new SqliteStorage(), logger: new Logger('error') });
  mock = await startMockLlm((req, n) => script(req, n));
  app.saveSettings({ ai: { providers: [{ name: 'mock', kind: 'openai-compatible', baseUrl: mock.url, model: 'mock-1' }], default: 'mock' }, defaults: {} });
  const server = createMcpServer(app, { copilot: { idleMs: 60_000, maxSessions: 3 } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
});
afterAll(async () => { await client.close(); app.close(); await mock.close(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

describe('copilot tools', () => {
  it('registers the tools and the build_scraper prompt points at copilot_turn', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['copilot_start', 'copilot_turn', 'copilot_end']));
    const prompt = await client.getPrompt({ name: 'build_scraper', arguments: { url: 'https://example.com', goal: 'titles' } });
    const text = JSON.stringify(prompt.messages);
    expect(text).toContain('copilot_turn');
    expect(text).toContain('preview_extract');
  });

  it('copilot_start fails cleanly without an AI provider and validates input', async () => {
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OLLAMA_HOST: process.env.OLLAMA_HOST, SCRAPPIA_OLLAMA: process.env.SCRAPPIA_OLLAMA };
    for (const k of Object.keys(saved)) delete process.env[k];
    const noAi = new ScrappiaApp({ dataDir: dir, storage: new SqliteStorage(), logger: new Logger('error') });
    try {
      const server = createMcpServer(noAi);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c2 = new Client({ name: 'c2', version: '0' });
      await c2.connect(ct);
      const r = (await c2.callTool({ name: 'copilot_start', arguments: { url: `${site.url}/products` } })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('no AI provider');
      await c2.close();
    } finally { noAi.close(); for (const [k, v] of Object.entries(saved)) if (v != null) process.env[k] = v; }

    expect((await call('copilot_start', {})).isError).toBe(true);
    const unknown = await call('copilot_start', { url: `${site.url}/products`, provider: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('"nope" is not configured');
    const bad = await call('copilot_start', { recipe: { name: 'x' } });
    expect(bad.isError).toBe(true);
    expect((await call('copilot_turn', { sessionId: 'missing', message: 'hi' })).isError).toBe(true);
  });

  it('start -> turn that sets the list -> recipe updated -> end', async () => {
    script = (req) => {
      const last = lastUser(req);
      if (last.startsWith('[Tool results]')) {
        const lists = toolResult(req, 'detect_lists');
        if (lists) {
          // the 2-card fixture is below the 3-sibling detection threshold; a real model would read get_page instead
          const sel = (lists.lists as Array<{ selector: string[] }>)[0]?.selector[0] ?? 'article.product';
          return turn('Setting up the product list.', [['set_list', { selector: sel, fields: [
            { name: 'name', type: 'attr', attr: 'title', selector: 'h3 a' },
            { name: 'price', selector: '.price', transforms: ['currency'] },
            { name: 'url', type: 'href', selector: 'h3 a' },
          ] }], ['set_pagination', { pagination: { type: 'next', selector: 'li.next a' } }]]);
        }
        if (toolResult(req, 'set_list')) return turn('List and pagination are set. Shall I run it?', []);
      }
      return turn('Looking at the page.', [['detect_lists', {}]]);
    };
    const started = await call('copilot_start', { url: `${site.url}/products` });
    expect(started.isError).toBeFalsy();
    const sessionId = started.json?.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(started.json?.provider).toBe('mock');
    expect((started.json?.recipe as { name: string; entry: { urls: string[] } }).entry.urls).toEqual([`${site.url}/products`]);

    const t = await call('copilot_turn', { sessionId, message: 'scrape all products with name, price and link' });
    expect(t.isError, t.text).toBeFalsy();
    expect(t.json?.sessionId).toBe(sessionId);
    expect(t.json?.reply).toMatch(/shall I run it/i);
    expect(t.json?.done).toBe(false);
    expect(t.json?.runId).toBeUndefined();
    expect(t.json?.waitingForPicks).toBe(false);
    const actions = t.json?.actions as Array<{ tool: string; ok: boolean }>;
    expect(actions.map((a) => a.tool)).toEqual(['detect_lists', 'set_list', 'set_pagination']);
    expect(actions.every((a) => a.ok)).toBe(true);
    const recipe = t.json?.recipe as { templates: Record<string, { list: { selector: Array<{ value: string }>; fields: Array<{ name: string }> }; pagination: { type: string } }> };
    expect(recipe.templates.main.list.selector[0].value).toBe('article.product');
    expect(recipe.templates.main.list.fields.map((f) => f.name)).toEqual(['name', 'price', 'url']);
    expect(recipe.templates.main.pagination.type).toBe('next');

    // the store is shared per app and remembers the working recipe
    const store = copilotStoreFor(app);
    expect(store.get(sessionId)?.recipe.templates.main.list?.fields).toHaveLength(3);

    // continue: run it
    script = (req) => {
      if (toolResult(req, 'start_run')) return turn('Running.', [], true);
      if (toolResult(req, 'test_run')) return turn('Test OK, starting the full run.', [['start_run', {}]]);
      return turn('Testing first.', [['configure', { section: 'engine', patch: { mode: 'http', delayMs: 0, jitterMs: 0 } }], ['add_sink', { sink: { type: 'jsonl', path: 'copilot/mcp.jsonl' } }], ['test_run', { maxRequests: 1 }]]);
    };
    const t2 = await call('copilot_turn', { sessionId, message: 'yes, run it' });
    expect(t2.isError).toBeFalsy();
    expect(t2.json?.done).toBe(true);
    const runId = t2.json?.runId as string;
    expect(runId).toBeTruthy();
    for (let i = 0; i < 100 && app.getRun(runId)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(app.getRun(runId)!.status).toBe('succeeded');
    expect(app.storage.countRows(runId)).toBe(FIXTURE_PRODUCTS.length);
    const viaTool = await call('get_run', { runId });
    expect(viaTool.isError).toBeFalsy();

    const ended = await call('copilot_end', { sessionId });
    expect(ended.json?.ended).toBe(true);
    expect(ended.json?.runIds).toEqual([runId]);
    expect((ended.json?.recipe as { sinks: Array<{ type: string }> }).sinks[0].type).toBe('jsonl');
    expect((await call('copilot_turn', { sessionId, message: 'again' })).isError).toBe(true);
    expect((await call('copilot_end', { sessionId })).isError).toBe(true);
  });

  it('enable_picking is reported as a failed action with an explanation (no browser)', async () => {
    script = (req) => lastUser(req).startsWith('[Tool results]') ? turn('No picking here; I will detect the list instead.', []) : turn('Click a card.', [['enable_picking', { mode: 'pickList', instruction: 'Click one product card' }]]);
    const started = await call('copilot_start', { recipe: { name: 'Given', entry: { urls: [`${site.url}/products`], template: 'main' }, templates: { main: {} } } });
    const sessionId = started.json?.sessionId as string;
    const t = await call('copilot_turn', { sessionId, message: 'let me pick' });
    expect(t.isError).toBeFalsy();
    const actions = t.json?.actions as Array<{ tool: string; ok: boolean; summary: string }>;
    expect(actions).toHaveLength(1);
    expect(actions[0].ok).toBe(false);
    expect(actions[0].summary).toMatch(/element picking is not available in this session \(no browser\)/);
    expect(t.json?.waitingForPicks).toBe(false);
    expect(t.json?.reply).toMatch(/detect the list/i);
    await call('copilot_end', { sessionId });
  });

  it('caps the number of open sessions', async () => {
    script = () => turn('ok', []);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) { const r = await call('copilot_start', { url: `${site.url}/products` }); expect(r.isError).toBeFalsy(); ids.push(r.json?.sessionId as string); }
    const capped = await call('copilot_start', { url: `${site.url}/products` });
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain('at most 3');
    for (const id of ids) await call('copilot_end', { sessionId: id });
    expect(copilotStoreFor(app).size).toBe(0);
  });
});
