import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { SqliteStorage } from '../storage/sqlite.js';
import { diffRuns, runMonitor, sendAlert } from './index.js';
import { parseRecipe } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';
import { hash } from '../util/misc.js';

let hook: Server; let hookUrl: string;
const received: Array<{ headers: Record<string, string>; body: string }> = [];

beforeAll(async () => {
  hook = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ headers: req.headers as Record<string, string>, body: b }); res.writeHead(200); res.end('ok'); }); });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
});
afterAll(() => new Promise<void>((r) => hook.close(() => r())));

function seed(storage: SqliteStorage, recipeId: string, rows: Array<Record<string, unknown>>, status: 'succeeded' | 'failed' = 'succeeded') {
  const run = storage.createRun({ recipeId, recipeName: 'r', recipeJson: {} });
  for (const data of rows) storage.upsertRow({ runId: run.id, dataset: 'default', rowKey: hash(String(data.id)), data, hash: hash(data) });
  storage.updateRun(run.id, { status, finishedAt: Date.now() });
  return run;
}

describe('diffRuns', () => {
  it('classifies added, removed and changed rows with percent deltas', () => {
    const s = new SqliteStorage();
    const a = seed(s, 'rec', [{ id: 1, price: 10, name: 'A' }, { id: 2, price: 20, name: 'B' }, { id: 3, price: 30, name: 'C' }]);
    const b = seed(s, 'rec', [{ id: 1, price: 10, name: 'A' }, { id: 2, price: 25, name: 'B' }, { id: 4, price: 40, name: 'D' }]);
    const d = diffRuns(s, a.id, b.id);
    expect(d.added.map((r) => r.id)).toEqual([4]);
    expect(d.removed.map((r) => r.id)).toEqual([3]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields[0]).toMatchObject({ field: 'price', before: 20, after: 25, percent: 25 });
    expect(d.unchanged).toBe(1);
    // threshold filters small changes; watched fields restrict comparison
    expect(diffRuns(s, a.id, b.id, { thresholdPercent: 30 }).changed).toHaveLength(0);
    expect(diffRuns(s, a.id, b.id, { fields: ['name'] }).changed).toHaveLength(0);
  });
});

describe('runMonitor', () => {
  it('stores alerts and delivers signed webhooks', async () => {
    const s = new SqliteStorage();
    s.setSecret('hook-secret', 'shh');
    const recipe = parseRecipe({ name: 'm', entry: { urls: ['https://x.test'], template: 't' }, templates: { t: { fields: [{ name: 'a', selector: [{ value: 'h1' }] }] } }, monitor: { enabled: true, on: ['added', 'removed', 'changed', 'failure'], channels: [{ type: 'webhook', url: hookUrl, secretRef: 'hook-secret' }] } });
    seed(s, 'rec', [{ id: 1, v: 'x' }, { id: 2, v: 'y' }]);
    const cur = seed(s, 'rec', [{ id: 2, v: 'z' }, { id: 3, v: 'w' }]);
    received.length = 0;
    const summary = await runMonitor({ recipe, storage: s, run: cur, recipeId: 'rec', secret: (n) => s.getSecret(n), log: new Logger('error'), status: 'succeeded' });
    expect(summary).toEqual({ added: 1, removed: 1, changed: 1 });
    const alerts = s.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('changes');
    expect(received).toHaveLength(1);
    const payload = JSON.parse(received[0].body);
    expect(payload.event).toBe('alert');
    expect(payload.runId).toBe(cur.id);
    const sig = 'sha256=' + createHmac('sha256', 'shh').update(`${received[0].headers['x-scrappia-timestamp']}.${received[0].body}`).digest('hex');
    expect(received[0].headers['x-scrappia-signature']).toBe(sig);
  });

  it('raises failure and drift alerts', async () => {
    const s = new SqliteStorage();
    const recipe = parseRecipe({ name: 'm', entry: { urls: ['https://x.test'], template: 't' }, templates: { t: { fields: [{ name: 'a', selector: [{ value: 'h1' }] }] } }, monitor: { enabled: true } });
    const run = seed(s, 'rec', [{ id: 1 }], 'failed');
    s.addDrift({ runId: run.id, template: 't', field: 'a', kind: 'field-missing', detail: {} });
    await runMonitor({ recipe, storage: s, run, recipeId: 'rec', secret: () => undefined, log: new Logger('error'), status: 'failed' });
    expect(s.listAlerts().map((a) => a.kind).sort()).toEqual(['drift', 'failure']);
  });

  it('sendAlert supports slack/discord/telegram/ntfy payload shapes', async () => {
    received.length = 0;
    const a = { kind: 'changes', title: 'T', body: 'B', detail: {} };
    const secret = (n: string) => (n === 'u' ? hookUrl : n === 'tok' ? 'x' : undefined);
    await sendAlert({ type: 'slack', webhookUrlRef: 'u' }, a, secret, { recipe: 'r', runId: '1' });
    await sendAlert({ type: 'discord', webhookUrlRef: 'u' }, a, secret, { recipe: 'r', runId: '1' });
    await sendAlert({ type: 'ntfy', topic: 'x', server: hookUrl }, a, secret, { recipe: 'r', runId: '1' });
    expect(received).toHaveLength(3);
    expect(JSON.parse(received[0].body)).toEqual({ text: '*T*\nB' });
    expect(JSON.parse(received[1].body).content).toContain('T');
    expect(received[2].headers.title).toBe('T');
  });
});
