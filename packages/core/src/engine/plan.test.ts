import { describe, it, expect } from 'vitest';
import { planSeeds, uniqueKey } from './plan.js';
import { parseRecipe } from '../recipe/schema.js';
import { ProxyPool } from '../fetch/proxies.js';
import { KeyedLimiter, Pool } from '../util/ratelimit.js';
import { looksBlocked } from './captcha.js';

describe('planSeeds', () => {
  const base = { name: 'x', templates: { t: { fields: [] } } };
  it('expands keyword products and zips', () => {
    const r = parseRecipe({ ...base, entry: { urls: ['https://s.test/?q={{q}}&c={{c}}'], template: 't' }, keywords: { q: ['a b', 'c'], c: ['1', '2'] } });
    const seeds = planSeeds(r);
    expect(seeds).toHaveLength(4);
    expect(seeds[0].url).toBe('https://s.test/?q=a%20b&c=1');
    expect(seeds[0].keywords).toEqual({ q: 'a b', c: '1' });
    const z = parseRecipe({ ...base, entry: { urls: ['https://s.test/{{q}}/{{c}}'], template: 't' }, keywords: { q: ['a', 'b', 'c'], c: ['1'] }, keywordMode: 'zip' });
    expect(planSeeds(z).map((s) => s.url)).toEqual(['https://s.test/a/1', 'https://s.test/b/1', 'https://s.test/c/1']);
  });
  it('dedupes identical seeds and keeps unknown tokens', () => {
    const r = parseRecipe({ ...base, entry: { urls: ['https://s.test/a', 'https://s.test/a', 'https://s.test/{{page}}'], template: 't' } });
    expect(planSeeds(r).map((s) => s.url)).toEqual(['https://s.test/a', 'https://s.test/{{page}}']);
  });
});

describe('uniqueKey', () => {
  it('normalises tracking params, fragments and query order', () => {
    expect(uniqueKey('GET', 'https://a.test/p?b=2&a=1&utm_source=x#frag')).toBe(uniqueKey('GET', 'https://a.test/p?a=1&b=2'));
    expect(uniqueKey('GET', 'https://a.test/p')).not.toBe(uniqueKey('POST', 'https://a.test/p'));
    expect(uniqueKey('GET', 'https://a.test/p', undefined, 'x')).not.toBe(uniqueKey('GET', 'https://a.test/p'));
  });
});

describe('ProxyPool', () => {
  it('sticks per session, rotates, retires after errors and materialises session tokens', () => {
    const pool = new ProxyPool(['http://u:p@h1:1', 'http://u:p@h2:1'], { rotate: 'session', maxErrors: 2 });
    const a = pool.acquire('s1')!; const b = pool.acquire('s2')!;
    expect(a.url).not.toBe(b.url);
    expect(pool.acquire('s1')!.url).toBe(a.url);
    pool.reportError(a); pool.reportError(a);
    expect(a.retired).toBe(true);
    expect(pool.acquire('s1')!.url).toBe(b.url);
    expect(pool.size).toBe(1);
    expect(ProxyPool.materialize('http://user-session-{session}:p@gw:1', 'abc-123')).toBe('http://user-session-abc123:p@gw:1');
    const req = new ProxyPool(['http://h1', 'http://h2'], { rotate: 'request', maxErrors: 3 });
    expect(req.acquire('s')!.url).not.toBe(req.acquire('s')!.url);
  });
});

describe('KeyedLimiter / Pool', () => {
  it('limits per-key concurrency and spacing', async () => {
    const lim = new KeyedLimiter(2, 30);
    const t0 = Date.now();
    const releases = await Promise.all([lim.acquire('h'), lim.acquire('h')]);
    let third = false;
    const p3 = lim.acquire('h').then((r) => { third = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    releases[0]();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    r3(); releases[1]();
    lim.penalize('h', 100);
    const t1 = Date.now();
    (await lim.acquire('h'))();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(90);
  });
  it('Pool caps concurrency', async () => {
    const pool = new Pool(2);
    let running = 0, max = 0;
    await Promise.all(Array.from({ length: 6 }, () => pool.run(async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 10)); running--; })));
    expect(max).toBe(2);
  });
});

describe('looksBlocked', () => {
  it('detects challenge and block pages', () => {
    expect(looksBlocked('<title>Just a moment...</title>')).toBe('cloudflare-challenge');
    expect(looksBlocked('<html>rate limit exceeded</html>', 429)).toBe('http-429');
    expect(looksBlocked('<html>fine</html>', 429)).toBe('rate-limited');
    expect(looksBlocked('<title>Access Denied</title>')).toBe('block-page');
    expect(looksBlocked('<html><h1>Products</h1></html>', 200)).toBeNull();
  });
});
