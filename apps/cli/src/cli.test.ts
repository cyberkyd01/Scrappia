import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';
import type { CliIO } from './ui.js';
import { startFixture, FIXTURE_PRODUCTS } from './test/fixture.js';

let site: Awaited<ReturnType<typeof startFixture>>;
let home: string;
let recipeFile: string;
let runId: string;

async function cli(...args: string[]) {
  let out = ''; let err = '';
  const io: CliIO = { out: (s) => { out += s; }, err: (s) => { err += s; }, isTTY: false, stdinTTY: false, color: false };
  const code = await runCli(['--home', home, ...args], io);
  return { code, out, err };
}

beforeAll(async () => {
  site = await startFixture();
  home = mkdtempSync(join(tmpdir(), 'scrappia-cli-'));
  recipeFile = join(home, 'recipe.json');
  writeFileSync(recipeFile, JSON.stringify({
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
          ],
        },
        pagination: { type: 'next', selector: [{ value: 'li.next a' }] },
      },
    },
    output: { keys: ['url'] },
  }));
});
afterAll(async () => { await site.close(); rmSync(home, { recursive: true, force: true }); });

describe('scrappia CLI', () => {
  it('validate reports a valid recipe', async () => {
    const r = await cli('validate', recipeFile);
    expect(r.code).toBe(0);
    expect(r.err).toContain('is valid');
    expect(r.out).toContain('listing');
    const j = await cli('validate', recipeFile, '--json');
    expect(JSON.parse(j.out).valid).toBe(true);
  });

  it('validate lists schema errors and exits 1', async () => {
    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify({ name: 'x', entry: { urls: [], template: 'nope' }, templates: {} }));
    const r = await cli('validate', bad);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/entry\.urls/);
    const j = await cli('validate', bad, '--json');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out).valid).toBe(false);
  });

  it('run --out data.csv --json scrapes both pages and writes the file', async () => {
    const out = join(home, 'data.csv');
    const r = await cli('run', recipeFile, '--out', out, '--json');
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as { run: { id: string; status: string; recipeJson?: unknown }; stats: { rows: number; pages: number; exports?: Array<{ rows: number; target: string; error?: string }> } };
    expect(j.run.status).toBe('succeeded');
    expect(j.run.recipeJson).toBeUndefined();
    expect(j.stats.rows).toBe(FIXTURE_PRODUCTS.length);
    expect(j.stats.pages).toBe(2);
    expect(j.stats.exports?.[0]?.rows).toBe(FIXTURE_PRODUCTS.length);
    expect(existsSync(out)).toBe(true);
    const lines = readFileSync(out, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(FIXTURE_PRODUCTS.length + 1);
    expect(lines[0]).toContain('name');
    runId = j.run.id;
  });

  it('run prints a human summary and honours --pages', async () => {
    const r = await cli('run', recipeFile, '--pages', '1', '--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/status\s+succeeded/);
    expect(r.out).toMatch(/rows\s+2\b/);
  });

  it('runs list / show / rows / drift', async () => {
    const list = await cli('runs', 'list', '--json');
    expect(JSON.parse(list.out).some((x: { id: string }) => x.id === runId)).toBe(true);
    const show = await cli('runs', 'show', runId);
    expect(show.out).toContain('succeeded');
    const rows = await cli('runs', 'rows', runId, '--format', 'json');
    const data = JSON.parse(rows.out) as Array<Record<string, unknown>>;
    expect(data).toHaveLength(FIXTURE_PRODUCTS.length);
    expect(data.find((d) => d.name === 'Product 1')?.price).toBe(10);
    const csv = await cli('runs', 'rows', runId, '--format', 'csv', '--limit', '2', '--columns', 'name,price');
    expect(csv.out.trim().split('\n')).toEqual(['name,price', 'Product 1,10', 'Product 2,11.5']);
    const jsonl = await cli('runs', 'rows', runId, '--format', 'jsonl', '--limit', '1');
    expect(JSON.parse(jsonl.out.trim()).name).toBe('Product 1');
    const drift = await cli('runs', 'drift', runId);
    expect(drift.code).toBe(0);
    const missing = await cli('runs', 'show', 'nope');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
  });

  it('export writes a jsonl file from a finished run', async () => {
    const out = join(home, 'export.jsonl');
    const r = await cli('export', runId, '--out', out);
    expect(r.code, r.err).toBe(0);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(FIXTURE_PRODUCTS.length);
    const bad = await cli('export', runId, '--out', join(home, 'x.unknownext'));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('format');
  });

  it('diff compares two runs', async () => {
    const second = await cli('run', recipeFile, '--json', '--dry-run');
    const id2 = JSON.parse(second.out).run.id as string;
    const d = await cli('diff', runId, id2, '--json');
    expect(d.code).toBe(0);
    const diff = JSON.parse(d.out);
    expect(diff.added).toHaveLength(0);
    expect(diff.unchanged).toBe(FIXTURE_PRODUCTS.length);
    const human = await cli('diff', runId, id2);
    expect(human.out).toMatch(/unchanged\s+4/);
  });

  it('preview extracts records over HTTP and reports field matches', async () => {
    const r = await cli('preview', recipeFile, '--json', '--limit', '5');
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.listMatched).toBe(2);
    expect(j.records).toHaveLength(2);
    expect(j.fields.find((f: { field: string }) => f.field === 'name').status).toBe('ok');
  });

  it('examples list / show / copy', async () => {
    const r = await cli('examples', 'list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('books-toscrape');
    const j = await cli('examples', 'list', '--json');
    expect(JSON.parse(j.out).map((x: { name: string }) => x.name)).toContain('hacker-news-monitor');
    const target = join(home, 'books.json');
    const c = await cli('examples', 'copy', 'books-toscrape', target);
    expect(c.code).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8')).entry.template).toBe('listing');
    const v = await cli('validate', target);
    expect(v.code).toBe(0);
    const unknown = await cli('examples', 'show', 'nope');
    expect(unknown.code).toBe(1);
  });

  it('recipes add/list/show/export/rm and schedule add/list/rm', async () => {
    const add = await cli('recipes', 'add', recipeFile, '--id', 'fx', '--json');
    expect(add.code, add.err).toBe(0);
    expect(JSON.parse(add.out).id).toBe('fx');
    const list = await cli('recipes', 'list');
    expect(list.out).toContain('fx');
    const show = await cli('recipes', 'show', 'fx');
    expect(JSON.parse(show.out).name).toBe('fixture');
    const exp = await cli('recipes', 'export', 'fx', join(home, 'fx.json'));
    expect(exp.code).toBe(0);
    const sched = await cli('schedule', 'add', 'fx', '0 */6 * * *', '--tz', 'UTC');
    expect(sched.code, sched.err).toBe(0);
    const sl = await cli('schedule', 'list', '--json');
    const schedules = JSON.parse(sl.out) as Array<{ recipeId: string; cron: string }>;
    expect(schedules.find((s) => s.recipeId === 'fx')?.cron).toBe('0 */6 * * *');
    const badCron = await cli('schedule', 'add', 'fx', 'not a cron');
    expect(badCron.code).toBe(1);
    const rmS = await cli('schedule', 'rm', 'fx');
    expect(rmS.code).toBe(0);
    const rm = await cli('recipes', 'rm', 'fx');
    expect(rm.code).toBe(0);
    expect(JSON.parse((await cli('recipes', 'list', '--json')).out)).toHaveLength(0);
  });

  it('schedule preview prints upcoming run times', async () => {
    const r = await cli('schedule', 'preview', '0 * * * *', '--count', '3', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.next).toHaveLength(3);
    expect(new Date(j.next[0]).getMinutes()).toBe(0);
    const human = await cli('schedule', 'preview', '30 8 * * 1-5');
    expect(human.out.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(6);
  });

  it('secrets set/list/rm and api-key create/list/rm', async () => {
    expect((await cli('secrets', 'set', 'MY_KEY', 'abc')).code).toBe(0);
    expect((await cli('secrets', 'list')).out).toContain('MY_KEY');
    expect((await cli('secrets', 'rm', 'MY_KEY')).code).toBe(0);
    const k = await cli('api-key', 'create', 'ci', '--json');
    expect(JSON.parse(k.out).key).toMatch(/^sk_/);
    const l = await cli('api-key', 'list', '--json');
    const id = JSON.parse(l.out)[0].id as string;
    expect((await cli('api-key', 'rm', id)).code).toBe(0);
  });

  it('help and unknown commands', async () => {
    const h = await cli('--help');
    expect(h.code).toBe(0);
    expect(h.out).toContain('serve-scheduler');
    const u = await cli('frobnicate');
    expect(u.code).not.toBe(0);
    const s = await cli('server');
    expect(s.out).toContain('@scrappia/server');
  });
});
