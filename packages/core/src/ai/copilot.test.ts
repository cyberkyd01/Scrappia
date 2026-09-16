import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite, FIXTURE_PRODUCT_COUNT } from '../test/fixtureSite.js';
import { startMockLlm, lastUser, toolResult, turn, type MockChatRequest } from '../test/mockLlm.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { OpenAICompatibleProvider } from './provider.js';
import { CopilotSession, toField, toSelector, type CopilotHost, type CopilotProgress } from './copilot.js';
import { HttpCopilotHost, detectListsFromHtml } from './copilotHostHttp.js';
import { Logger } from '../util/logger.js';
import type { PickedElement } from '../inspector/protocol.js';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let outDir: string;
const quiet = new Logger('error');

beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-copilot-')); });
afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

const blank = (url: string) => ({ name: 'Untitled', entry: { urls: [url], template: 'main' }, templates: { main: {} } });

describe('copilot helpers', () => {
  it('normalises selectors and fields', () => {
    expect(toSelector('h3 a')).toEqual([{ kind: 'css', value: 'h3 a' }]);
    expect(toSelector('//div[@id="x"]')[0].kind).toBe('xpath');
    expect(toSelector(['xpath://a', 'text:Next'])).toEqual([{ kind: 'xpath', value: '//a' }, { kind: 'text', value: 'Next' }]);
    expect(() => toSelector('')).toThrow();
    const f = toField({ name: 'Unit Price', selector: '.price', transforms: ['currency', { type: 'prefix', value: '$' }] });
    expect(f.name).toBe('Unit_Price');
    expect(f.transforms).toEqual([{ type: 'currency' }, { type: 'prefix', value: '$' }]);
    expect(toField({ name: 'link', type: 'href' }).selector?.[0].value).toBe(':scope');
  });

  it('detects lists server-side from HTML', async () => {
    const html = await (await fetch(`${site.url}/products`)).text();
    const lists = detectListsFromHtml(html, `${site.url}/products`);
    expect(lists.length).toBeGreaterThan(0);
    const best = lists[0];
    expect(best.count).toBe(10);
    expect(best.selector[0].value).toBe('article.product');
    const names = best.fields.map((f) => f.name);
    expect(names).toContain('title');
    expect(names).toContain('url');
    expect(names).toContain('price');
    expect(names).toContain('image');
    expect(best.fields.find((f) => f.name === 'price')!.samples[0]).toMatch(/^\$/);
  });
});

describe('CopilotSession (autonomous, via mock OpenAI-compatible server)', () => {
  it('builds, verifies, paginates, follows detail pages, exports and runs from one prompt', async () => {
    const storage = new SqliteStorage();
    // A scripted "model": reacts to what it sees in the conversation.
    const mock = await startMockLlm((req: MockChatRequest) => {
      const last = lastUser(req);
      if (last.startsWith('[Tool results]')) {
        if (toolResult(req, 'detect_lists')) {
          const lists = toolResult(req, 'detect_lists')!.lists as Array<{ selector: string[]; fields: Array<{ name: string; type: string; selector: string }> }>;
          const l = lists[0];
          return turn('Found the product list. Setting it up.', [
            ['set_list', { selector: l.selector[0], fields: [
              { name: 'name', type: 'attr', attr: 'title', selector: 'h3 a' },
              { name: 'price', selector: '.price', transforms: ['currency'] },
              { name: 'url', type: 'href', selector: 'h3 a' },
              { name: 'broken', selector: '.does-not-exist' },
            ] }],
          ]);
        }
        if (toolResult(req, 'set_list')) {
          const pv = toolResult(req, 'set_list')!.preview as { emptyFields: string[] };
          expect(pv.emptyFields).toEqual(['broken']);
          return turn('One field is empty, removing it and adding pagination, detail pages and an export.', [
            ['remove_field', { name: 'broken' }],
            ['set_pagination', { pagination: { type: 'next', selector: 'li.next a' } }],
            ['add_follow', { field: 'url', target: 'detail', mode: 'merge', fields: [{ name: 'sku', selector: 'xpath://th[text()="SKU"]/following-sibling::td' }, { name: 'description', selector: '.desc p' }] }],
            ['configure', { section: 'output', patch: { keys: ['url'], addTimestamp: true } }],
            ['configure', { section: 'engine', patch: { mode: 'http', delayMs: 0, jitterMs: 0, concurrency: 3 } }],
            ['add_sink', { sink: { type: 'csv', path: 'copilot/products.csv', mode: 'overwrite' } }],
            ['rename_recipe', { name: 'Fixture products' }],
            ['test_run', { maxRequests: 4 }],
          ]);
        }
        if (toolResult(req, 'test_run')) {
          const tr = toolResult(req, 'test_run')!;
          expect((tr.stats as { rows: number }).rows).toBeGreaterThan(0);
          return turn('Test run looks good: rows have name, price, url, sku and description. Starting the full run now as you asked.', [['save_recipe', {}], ['start_run', {}]]);
        }
        if (toolResult(req, 'start_run')) return turn('The full run is running; results will land in products.csv.', [], true);
      }
      return turn('Let me look at the page and detect the product list.', [['detect_lists', {}]]);
    });
    try {
      const provider = new OpenAICompatibleProvider('mock', mock.url, 'mock-1');
      const progress: CopilotProgress[] = [];
      let startedRunner: import('../engine/runner.js').Runner | undefined;
      const host = new HttpCopilotHost({ storage, outDir, startUrl: `${site.url}/products`, logger: quiet, onRun: (r) => { startedRunner = r; } });
      const copilot = new CopilotSession({ provider, host, logger: quiet, onProgress: (p) => progress.push(p) });

      const r1 = await copilot.turn({ message: 'Scrape all products with name, price and their detail page SKU and description, then run it.', recipe: blank(`${site.url}/products`) });
      expect(r1.done).toBe(true);
      expect(r1.runId).toBeTruthy();
      expect(r1.reply).toMatch(/full run/i);
      const tools = r1.actions.map((a) => a.tool);
      expect(tools).toEqual(['detect_lists', 'set_list', 'remove_field', 'set_pagination', 'add_follow', 'configure', 'configure', 'add_sink', 'rename_recipe', 'test_run', 'save_recipe', 'start_run']);
      expect(r1.actions.every((a) => a.ok)).toBe(true);
      const recipe = r1.recipe;
      expect(recipe.name).toBe('Fixture products');
      expect(recipe.templates.main.list?.fields.map((f) => f.name)).toEqual(['name', 'price', 'url']);
      expect(recipe.templates.main.pagination?.type).toBe('next');
      expect(recipe.templates.main.list?.follow[0]).toMatchObject({ field: 'url', template: 'detail', mode: 'merge' });
      expect(recipe.templates.detail.fields.map((f) => f.name)).toEqual(['sku', 'description']);
      expect(recipe.output.keys).toEqual(['url']);
      expect(recipe.sinks[0]).toMatchObject({ type: 'csv' });
      expect(recipe.id).toBeTruthy();
      expect(storage.getRecipe(recipe.id!)?.name).toBe('Fixture products');
      expect(progress.filter((p) => p.type === 'call')).toHaveLength(12);

      // the full run (already started by the host) completes with all products and merged detail fields
      expect(startedRunner?.id).toBe(r1.runId);
      const runs = storage.listRuns({ limit: 5 });
      const full = runs.find((r) => r.id === r1.runId)!;
      // wait for it to finish
      for (let i = 0; i < 100 && storage.getRun(full.id)!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
      const finished = storage.getRun(full.id)!;
      expect(finished.status).toBe('succeeded');
      expect(storage.countRows(full.id)).toBe(FIXTURE_PRODUCT_COUNT);
      const row = Array.from(storage.iterRows(full.id))[0].data;
      expect(row.sku).toMatch(/^SKU-/);
      expect(row._scrapedAt).toBeTruthy();
      expect((finished.stats as { exports: Array<{ type: string; error?: string }> }).exports[0]).toMatchObject({ type: 'csv' });
    } finally { await mock.close(); }
  });

  it('surfaces tool errors to the model and recovers; respects maxRounds', async () => {
    const storage = new SqliteStorage();
    let seenError = false;
    const mock = await startMockLlm((req) => {
      const last = lastUser(req);
      if (last.startsWith('[Tool results]')) {
        if (/set_pagination: \{"error"/.test(last)) { seenError = true; return turn('That pagination type was wrong; using next.', [['set_pagination', { pagination: { type: 'next', selector: 'li.next a' } }]]); }
        if (toolResult(req, 'set_pagination')) return turn('Pagination set. What next?', []);
        return turn('again', [['get_recipe', {}]]); // endless loop -> maxRounds
      }
      if (/loop/.test(last)) return turn('looping', [['get_recipe', {}]]);
      return turn('Setting pagination', [['set_pagination', { pagination: { type: 'bogus' } }]]);
    });
    try {
      const provider = new OpenAICompatibleProvider('mock', mock.url, 'mock-1');
      const host = new HttpCopilotHost({ storage, outDir, startUrl: `${site.url}/products`, logger: quiet });
      const copilot = new CopilotSession({ provider, host, logger: quiet, maxRounds: 4 });
      const r = await copilot.turn({ message: 'add pagination', recipe: blank(`${site.url}/products`) });
      expect(seenError).toBe(true);
      expect(r.actions[0].ok).toBe(false);
      expect(r.actions[1].ok).toBe(true);
      expect(r.recipe.templates.main.pagination?.type).toBe('next');
      expect(r.reply).toMatch(/what next/i);
      const r2 = await copilot.turn({ message: 'loop', recipe: r.recipe });
      expect(r2.actions.length).toBe(4);
      expect(r2.reply).toBeTruthy();
    } finally { await mock.close(); }
  });
});

describe('CopilotSession (interactive picking)', () => {
  /** A host that records pick-mode changes and otherwise behaves like the HTTP host. */
  class PickHost extends HttpCopilotHost {
    modes: string[] = [];
    override async setPickMode(mode: Parameters<CopilotHost['setPickMode']>[0], instruction: string) { this.modes.push(`${mode}:${instruction}`); }
  }

  it('enables picking, waits, converts picked elements into fields and asks what is next', async () => {
    const storage = new SqliteStorage();
    const mock = await startMockLlm((req) => {
      const last = lastUser(req);
      if (/lets start/i.test(last)) return turn("Good. Tell me when you're ready and I'll enable the selectors so you can click the elements we need.", []);
      if (/ready|go/i.test(last) && !last.startsWith('[')) return turn('Picking is on. Click one product card in the browser; I will detect the others.', [['enable_picking', { mode: 'pickList', instruction: 'Click one product card' }]]);
      if (last.startsWith('[Event] picked')) {
        const ev = JSON.parse(last.replace('[Event] picked: ', '')) as { selectors: string[]; record?: { selector: string[]; fields: Array<{ name: string; type: string; selector: string; attr?: string }> } };
        if (!ev.record) return turn('Setting that link as the next page.', [['set_pagination', { pagination: { type: 'next', selector: ev.selectors[0] } }], ['disable_picking', {}]]);
        return turn('Got it: 10 products with name, price, url and image. Do we need to click into each product for more details, or go to the next page?', [
          ['set_list', { selector: ev.record.selector[0], fields: ev.record.fields.map((f) => ({ name: f.name, type: f.type, selector: f.selector, attr: f.attr })) }],
          ['disable_picking', {}],
        ]);
      }
      if (last.startsWith('[Tool results]') && toolResult(req, 'set_list')) return turn('Got it: 10 products with name, price, url and image. Do we need to click into each product for more details, or go to the next page?', []);
      if (/next page/i.test(last)) return turn('Click the "next" link on the page for me.', [['enable_picking', { mode: 'pick', instruction: 'Click the next-page link' }]]);
      if (last.startsWith('[Tool results]') && toolResult(req, 'set_pagination')) return turn('Next-page pagination is set (1 match). Shall I run a quick test?', []);
      if (last.startsWith('[Tool results]') && toolResult(req, 'enable_picking')) return turn('', []);
      return turn('?', []);
    });
    try {
      const provider = new OpenAICompatibleProvider('mock', mock.url, 'mock-1');
      const host = new PickHost({ storage, outDir, startUrl: `${site.url}/products`, logger: quiet });
      const copilot = new CopilotSession({ provider, host, logger: quiet });
      let recipe: Parameters<CopilotSession['turn']>[0]['recipe'] = blank(`${site.url}/products`);

      let r = await copilot.turn({ message: 'lets start scraping', recipe });
      expect(r.reply).toMatch(/enable the selectors/i);
      expect(r.waitingForPicks).toBe(false);

      r = await copilot.turn({ message: 'ready, go', recipe: r.recipe });
      expect(r.waitingForPicks).toBe(true);
      expect(host.modes).toEqual(['pickList:Click one product card']);
      expect(r.reply).toMatch(/click one product/i);

      // the user clicks a product card in the browser: the desktop sends a picked event
      const picked: PickedElement = {
        selectors: [{ kind: 'css', value: 'article.product:nth-of-type(1) h3 a' }], relativeSelectors: [{ kind: 'css', value: 'h3 a' }], tag: 'a', text: 'Product 1', html: '<a>', attrs: {}, href: `${site.url}/product/1`,
        rect: { x: 0, y: 0, width: 10, height: 10 }, suggestedType: 'href', suggestedName: 'url', frameUrl: `${site.url}/products`,
        record: { selector: [{ kind: 'css', value: 'article.product' }], count: 10, clickedIndex: 0, fields: [
          { name: 'name', type: 'attr', attr: 'title', selector: [{ kind: 'css', value: 'h3 a' }], samples: ['Product 1'], coverage: 1 },
          { name: 'price', type: 'text', selector: [{ kind: 'css', value: '.price' }], samples: ['$10.00'], coverage: 1 },
          { name: 'url', type: 'href', selector: [{ kind: 'css', value: 'h3 a' }], samples: [`${site.url}/product/1`], coverage: 1 },
          { name: 'image', type: 'src', selector: [{ kind: 'css', value: 'img' }], samples: ['/img/1.jpg'], coverage: 1 },
        ] },
      };
      r = await copilot.turn({ event: { type: 'picked', element: picked }, recipe: r.recipe });
      expect(r.recipe.templates.main.list?.selector[0].value).toBe('article.product');
      expect(r.recipe.templates.main.list?.fields.map((f) => f.name)).toEqual(['name', 'price', 'url', 'image']);
      expect(r.actions.find((a) => a.tool === 'set_list')?.summary).toMatch(/10 records/);
      expect(host.modes.at(-1)).toBe('off:');
      expect(r.reply).toMatch(/next page/i);

      r = await copilot.turn({ message: 'next page please', recipe: r.recipe });
      expect(r.waitingForPicks).toBe(true);
      // user clicks the next link
      const nextPick: PickedElement = { selectors: [{ kind: 'css', value: 'li.next a' }], tag: 'a', text: 'next', html: '', attrs: {}, href: `${site.url}/products?page=2`, rect: { x: 0, y: 0, width: 1, height: 1 }, suggestedType: 'href', suggestedName: 'next', frameUrl: '' };
      r = await copilot.turn({ event: { type: 'picked', element: nextPick }, recipe: r.recipe });
      expect(r.recipe.templates.main.pagination).toMatchObject({ type: 'next', selector: [{ kind: 'css', value: 'li.next a' }] });
      expect(r.actions.find((a) => a.tool === 'set_pagination')?.summary).toMatch(/1 match/);
      expect(r.waitingForPicks).toBe(false);
      expect(r.reply).toMatch(/quick test/i);
      // history is kept so the session can be restored
      expect(copilot.history.filter((m) => m.role === 'assistant').length).toBeGreaterThan(3);
    } finally { await mock.close(); }
  });
});
