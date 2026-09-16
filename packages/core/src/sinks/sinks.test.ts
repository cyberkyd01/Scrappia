import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { createSink, sinkTypes, type SinkContext } from './index.js';

let dir: string;
let hook: Server; let hookUrl: string; const posts: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scrappia-sinks-'));
  hook = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posts.push(b); res.writeHead(200); res.end(); }); });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/`;
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); return new Promise<void>((r) => hook.close(() => r())); });

const ctx = (): SinkContext => ({ runId: 'run1', recipeName: 'Test Recipe', dataset: 'default', secret: () => undefined, columns: ['id', 'name'], outDir: dir });
const rows = [{ id: 1, name: 'A', nested: { x: 1 } }, { id: 2, name: 'B', tags: ['t1', 't2'] }];

describe('sinks', () => {
  it('registers all built-in sink types', () => {
    expect(sinkTypes().sort()).toEqual(['airtable', 'csv', 'google-sheets', 'json', 'jsonl', 'mongodb', 'mysql', 'notion', 'parquet', 'postgres', 's3', 'sqlite', 'stdout', 'tsv', 'webhook', 'xlsx', 'xml'].sort());
  });

  it('csv upsert merges by key and keeps column order; tokens in paths expand', async () => {
    const cfg = { type: 'csv' as const, path: 'out/{{recipe}}-{{dataset}}.csv', mode: 'upsert' as const, key: 'id', enabled: true };
    let r = await (await createSink(cfg, ctx())).write(rows);
    expect(r.target.endsWith('Test_Recipe-default.csv')).toBe(true);
    r = await (await createSink(cfg, ctx())).write([{ id: 2, name: 'B2' }, { id: 3, name: 'C' }]);
    expect(r).toMatchObject({ rows: 3, inserted: 1, updated: 1 });
    const csv = readFileSync(r.target, 'utf8');
    expect(csv.split('\r\n')[0]).toBe('﻿id,name,nested.x,tags');
    expect(csv).toContain('2,B2');
  });

  it('xlsx writes hyperlinks and can append', async () => {
    const cfg = { type: 'xlsx' as const, path: 'out/data.xlsx', mode: 'append' as const, enabled: true };
    await (await createSink(cfg, ctx())).write([{ id: 1, name: 'A', url: 'https://x.test/a' }]);
    const r = await (await createSink(cfg, ctx())).write([{ id: 2, name: 'B' }]);
    expect(r.rows).toBe(2);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(r.target);
    const ws = wb.getWorksheet('default')!;
    expect(ws.rowCount).toBe(3);
    expect((ws.getCell('C2').value as { hyperlink: string }).hyperlink).toBe('https://x.test/a');
  });

  it('json/jsonl/xml/sqlite', async () => {
    const j = await (await createSink({ type: 'json', path: 'out/d.json', mode: 'overwrite', enabled: true, pretty: true }, ctx())).write(rows);
    expect(JSON.parse(readFileSync(j.target, 'utf8'))[0].nested.x).toBe(1);
    const jl = await (await createSink({ type: 'jsonl', path: 'out/d.jsonl', mode: 'append', enabled: true }, ctx())).write(rows);
    await (await createSink({ type: 'jsonl', path: 'out/d.jsonl', mode: 'append', enabled: true }, ctx())).write(rows);
    expect(readFileSync(jl.target, 'utf8').trim().split('\n')).toHaveLength(4);
    const x = await (await createSink({ type: 'xml', path: 'out/d.xml', mode: 'overwrite', enabled: true, root: 'items', row: 'item' }, ctx())).write(rows);
    const xml = readFileSync(x.target, 'utf8');
    expect(xml).toContain('<items>');
    expect(xml).toContain('<nested>');
    expect(xml).toContain('<tags>t1</tags>');
    const s = await (await createSink({ type: 'sqlite', path: 'out/d.db', table: 'items', mode: 'upsert', key: 'id', enabled: true }, ctx())).write(rows);
    await (await createSink({ type: 'sqlite', path: 'out/d.db', table: 'items', mode: 'upsert', key: 'id', enabled: true }, ctx())).write([{ id: 1, name: 'A2' }]);
    const db = new DatabaseSync(join(dir, 'out/d.db'));
    expect((db.prepare('SELECT name FROM items WHERE id=1').get() as { name: string }).name).toBe('A2');
    expect((db.prepare('SELECT COUNT(*) n FROM items').get() as { n: number }).n).toBe(2);
    db.close();
    expect(s.type).toBe('sqlite');
  });

  it('webhook batches and signs', async () => {
    posts.length = 0;
    const c = ctx(); c.secret = (n) => (n === 'sec' ? 'k' : undefined);
    const r = await (await createSink({ type: 'webhook', url: hookUrl, batchSize: 1, mode: 'append', enabled: true, secretRef: 'sec' }, c)).write(rows);
    expect(r.rows).toBe(2);
    expect(posts).toHaveLength(3); // 2 batches + final empty "last" batch
    expect(JSON.parse(posts[0])).toMatchObject({ event: 'rows', batch: 0, last: false, rows: [rows[0]] });
    expect(JSON.parse(posts[2]).last).toBe(true);
  });

  it('cloud sinks fail clearly without credentials', async () => {
    await expect((await createSink({ type: 'google-sheets', credentialRef: 'nope', spreadsheetId: 'x', mode: 'overwrite', enabled: true }, ctx())).write(rows)).rejects.toThrow(/not found in secrets/);
    await expect((await createSink({ type: 'postgres', connectionRef: 'nope', table: 't', mode: 'overwrite', enabled: true }, ctx())).write(rows)).rejects.toThrow(/not found in secrets/);
  });
});
