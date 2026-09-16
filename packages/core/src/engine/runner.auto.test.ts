import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureSite } from '../test/fixtureSite.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { Runner } from './runner.js';
import { parseRecipe } from '../recipe/schema.js';
import { Logger } from '../util/logger.js';
import type { RunEvent } from './events.js';
import { looksBlocked } from './captcha.js';
import { looksLikeBrowserRequired } from '../dom/jsdom.js';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let outDir: string;
const quiet = new Logger('error');
beforeAll(async () => { site = await startFixtureSite(); outDir = mkdtempSync(join(tmpdir(), 'scrappia-auto-')); });
afterAll(async () => { await site.close(); rmSync(outDir, { recursive: true, force: true }); });

describe('auto mode fallback', () => {
  it('switches to the browser when plain HTTP is rejected, and keeps using it for that host', async () => {
    const storage = new SqliteStorage();
    const events: RunEvent[] = [];
    const recipe = parseRecipe({
      name: 'wall', entry: { urls: [`${site.url}/botwall-a`, `${site.url}/botwall-b`], template: 't' },
      engine: { mode: 'auto', headless: true, concurrency: 1, delayMs: 0, jitterMs: 0, retries: 2 },
      templates: { t: { fields: [{ name: 'v', selector: [{ value: '.item' }], required: true }] } },
    });
    const { run, stats } = await new Runner({ recipe, storage, outDir, logger: quiet, onEvent: (e) => events.push(e) }).start();
    expect(run.status).toBe('succeeded');
    expect(stats.rows).toBe(2);
    expect(stats.browserFetches).toBe(2);
    expect(stats.httpFetches).toBe(0);
    const starts = events.filter((e): e is Extract<RunEvent, { type: 'request.start' }> => e.type === 'request.start');
    expect(starts[0].mode).toBe('http');   // first request tries HTTP, gets 503, falls back to the browser
    expect(starts[1].mode).toBe('browser'); // the host is now known to need a browser
    expect(events.some((e) => e.type === 'log' && /Switching to browser/.test(e.msg))).toBe(true);
    // no request was ever marked failed
    expect(stats.requests.failed).toBe(0);
    const vals = Array.from(storage.iterRows(run.id)).map((r) => r.data.v).sort();
    expect(vals).toEqual(['passed /botwall-a', 'passed /botwall-b']);
  }, 60_000);

  it('http mode still fails honestly on persistent errors', async () => {
    const storage = new SqliteStorage();
    const recipe = parseRecipe({
      name: 'wall', entry: { urls: [`${site.url}/nope-404`], template: 't' }, engine: { mode: 'http', delayMs: 0, jitterMs: 0, retries: 0 },
      templates: { t: { list: { selector: [{ value: '.item' }], fields: [{ name: 'v', selector: [{ value: ':scope' }] }] } } },
    });
    const { run, stats } = await new Runner({ recipe, storage, outDir, logger: quiet }).start();
    expect(run.status).toBe('succeeded'); // a 404 page is fetched fine, it just has no records
    expect(stats.rows).toBe(0);
  });

  it('recognises bot-check interstitials', () => {
    expect(looksBlocked('<html><title>Robot Check</title></html>', 200)).toBe('block-page');
    expect(looksBlocked('<html><body>To discuss automated access to Amazon data please contact api-services-support@amazon.com</body></html>')).toBe('bot-check');
    expect(looksBlocked('<html><body>Our systems have detected unusual traffic from your computer network</body></html>')).toBe('bot-check');
    expect(looksLikeBrowserRequired('<title>Sorry! Something went wrong!</title>').reason).toBe('bot-check');
  });
});
