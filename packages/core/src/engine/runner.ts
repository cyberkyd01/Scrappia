import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Follow, Recipe, Template } from '../recipe/schema.js';
import type { Storage, RequestRecord, RunRecord, RequestContext } from '../storage/types.js';
import { Logger, rootLogger } from '../util/logger.js';
import { KeyedLimiter, Pool } from '../util/ratelimit.js';
import { AbortError, backoffMs, hash, hostOf, sleep } from '../util/misc.js';
import { CookieJar } from '../fetch/http.js';
import { ProxyPool } from '../fetch/proxies.js';
import { RobotsCache } from '../fetch/robots.js';
import type { BrowserProvider } from '../browser/provider.js';
import { BrowserPool } from './browserPool.js';
import { planSeeds, uniqueKey } from './plan.js';
import { runHttp, runBrowser, type PageResult } from './pageRunner.js';
import { processRecords, type ProcessedRow } from './rows.js';
import { followId, needsBrowser } from './spec.js';
import { createCaptchaSolver, type CaptchaSolver } from './captcha.js';
import type { RunEvent, RunEventListener, RunStats } from './events.js';
import type { AiService } from '../ai/service.js';
import { exportRun } from './export.js';
import { runMonitor } from '../monitor/index.js';
import { extractFromHtml } from '../dom/jsdom.js';
import { buildSpec } from './spec.js';

export interface RunnerOptions {
  recipe: Recipe;
  storage: Storage;
  /** Directory for exports, downloads, profiles. */
  outDir?: string;
  recipeId?: string;
  trigger?: string;
  ai?: AiService;
  browserProvider?: BrowserProvider;
  /** Force headed browser (recorder / debugging). */
  headless?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
  onEvent?: RunEventListener;
  /** Resume a previous run (requeues 'running' requests). */
  resumeRunId?: string;
  /** Limit pages for previews / trial runs. */
  maxRequests?: number;
  /** Skip sinks & monitor (preview mode). */
  dryRun?: boolean;
  secrets?: (name: string) => string | undefined;
}

export class Runner {
  readonly recipe: Recipe;
  readonly log: Logger;
  private storage: Storage;
  private run!: RunRecord;
  private pool: Pool;
  private limiter: KeyedLimiter;
  private cookies = new CookieJar();
  private proxies: ProxyPool;
  private browsers: BrowserPool;
  private robots?: RobotsCache;
  private captcha?: CaptchaSolver;
  private listeners = new Set<RunEventListener>();
  private abort = new AbortController();
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private stats: RunStats;
  private healedFields = new Set<string>();
  private fallbackReported = new Set<string>();
  private sessionCounter = 0;
  private blockedStreak = new Map<string, number>();
  private browserHosts = new Set<string>();
  private outDir: string;
  private lastProgress = 0;
  private startedAt = Date.now();

  constructor(private opts: RunnerOptions) {
    this.recipe = opts.recipe;
    this.storage = opts.storage;
    this.log = (opts.logger ?? rootLogger).child('run');
    this.outDir = opts.outDir ?? join(process.cwd(), '.scrappia');
    mkdirSync(this.outDir, { recursive: true });
    const e = this.recipe.engine;
    this.pool = new Pool(e.concurrency);
    this.limiter = new KeyedLimiter(e.perHostConcurrency, e.delayMs, e.jitterMs);
    const proxyUrls = e.proxy.urls.length ? e.proxy.urls : e.proxy.pool ? (opts.secrets?.(e.proxy.pool)?.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) ?? []) : [];
    this.proxies = new ProxyPool(proxyUrls, { rotate: e.proxy.rotate, maxErrors: e.proxy.maxErrors });
    // recipe cookies apply to HTTP fetches as well as to browser contexts
    for (const c of e.cookies) if (c.domain) this.cookies.set(`https://${c.domain.replace(/^\./, '')}/`, c.name, c.value);
    this.browsers = new BrowserPool(e, this.proxies, this.log, { provider: opts.browserProvider, profilesDir: join(this.outDir, 'profiles'), headless: opts.headless });
    if (e.respectRobots) this.robots = new RobotsCache(e.userAgent ?? 'Scrappia');
    if (opts.onEvent) this.listeners.add(opts.onEvent);
    // engine warnings/errors (retries, blocks, merge problems) are part of the run's story: surface them as events
    this.log.on((entry) => {
      if ((entry.level === 'warn' || entry.level === 'error') && this.run) this.emit({ type: 'log', runId: this.run.id, level: entry.level, msg: entry.msg, data: entry.data });
    });
    if (opts.signal) opts.signal.addEventListener('abort', () => this.cancel(), { once: true });
    this.stats = { requests: { total: 0, done: 0, failed: 0, pending: 0, running: 0, skipped: 0 }, rows: 0, rowsByDataset: {}, pages: 0, bytes: 0, httpFetches: 0, browserFetches: 0, drift: 0, healed: 0, validationFlags: 0, validationDrops: 0, startedAt: Date.now(), elapsedMs: 0, rowsPerMinute: 0, aiCalls: 0, aiTokens: 0 };
  }

  on(l: RunEventListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(e: RunEvent) { for (const l of this.listeners) { try { l(e); } catch { /* listener error */ } } }
  get id() { return this.run?.id; }
  get signal() { return this.abort.signal; }

  cancel() { if (!this.abort.signal.aborted) { this.log.info('cancelling run'); this.abort.abort(); this.resume(); } }
  pause() { this.paused = true; this.log.info('paused'); }
  resume() { this.paused = false; const w = this.resumeWaiters.splice(0); w.forEach((r) => r()); }
  get isPaused() { return this.paused; }

  private secret(name: string): string | undefined { return this.opts.secrets?.(name) ?? this.storage.getSecret(name) ?? process.env[name]; }

  async start(): Promise<{ run: RunRecord; stats: RunStats }> {
    const recipe = this.recipe;
    if (this.opts.resumeRunId) {
      const prev = this.storage.getRun(this.opts.resumeRunId);
      if (!prev) throw new Error(`run ${this.opts.resumeRunId} not found`);
      this.run = prev;
      this.storage.updateRun(prev.id, { status: 'running', error: null });
      const reset = this.storage.resetRunning(prev.id);
      this.log.info('resuming run', { runId: prev.id, requeued: reset });
    } else {
      this.run = this.storage.createRun({ recipeId: this.opts.recipeId ?? recipe.id, recipeName: recipe.name, recipeJson: recipe, trigger: this.opts.trigger });
      const seeds = planSeeds(recipe);
      for (const s of seeds) this.enqueue({ url: s.url, method: s.method, body: s.body, template: s.template, depth: 0, context: { keywords: s.keywords, categoryPath: [], page: 1 } });
      this.log.info('run started', { runId: this.run.id, seeds: seeds.length, mode: recipe.engine.mode, concurrency: recipe.engine.concurrency });
    }
    try { this.captcha = createCaptchaSolver(recipe.engine.captcha, (r) => this.secret(r), (url, kind) => this.emit({ type: 'captcha.needed', runId: this.run.id, url, kind })); }
    catch (e) { this.log.warn('captcha solver not configured', { error: (e as Error).message }); }
    this.emit({ type: 'run.start', run: this.run });

    let status: RunRecord['status'] = 'succeeded';
    let error: string | undefined;
    try {
      await this.loop();
      if (this.abort.signal.aborted) status = 'cancelled';
      else if (this.stats.requests.failed > 0) status = this.stats.requests.done > 0 ? 'partial' : 'failed';
    } catch (e) {
      status = this.abort.signal.aborted ? 'cancelled' : 'failed';
      error = (e as Error).message;
      this.log.error('run crashed', { error });
    } finally {
      await this.browsers.closeAll();
    }

    // Exports + monitoring
    if (!this.opts.dryRun && status !== 'cancelled') {
      try {
        const results = await exportRun({ recipe, storage: this.storage, runId: this.run.id, outDir: this.outDir, secret: (n) => this.secret(n), log: this.log, onResult: (r) => this.emit({ type: 'export.done', runId: this.run.id, result: r }) });
        this.stats.exports = results;
      } catch (e) { this.log.error('export failed', { error: (e as Error).message }); }
      try {
        const mon = await runMonitor({ recipe, storage: this.storage, run: this.run, recipeId: this.opts.recipeId ?? recipe.id, secret: (n) => this.secret(n), log: this.log, status, onAlert: (a) => this.emit({ type: 'alert', runId: this.run.id, ...a }) });
        if (mon) this.stats.monitor = mon;
      } catch (e) { this.log.error('monitor failed', { error: (e as Error).message }); }
    }

    this.finalizeStats();
    this.storage.updateRun(this.run.id, { status, stats: this.stats as unknown as Record<string, unknown>, error: error ?? null, finishedAt: Date.now() });
    const run = this.storage.getRun(this.run.id)!;
    this.emit({ type: 'run.done', run, stats: this.stats });
    this.log.info('run finished', { runId: run.id, status, rows: this.stats.rows, pages: this.stats.pages, failed: this.stats.requests.failed, elapsedMs: this.stats.elapsedMs });
    return { run, stats: this.stats };
  }

  // ---------- queue loop ----------

  private enqueue(req: { url: string; method: 'GET' | 'POST'; body?: string; template: string; depth: number; parentId?: string; context: RequestContext; uniqueExtra?: string }): boolean {
    if (this.recipe.engine.maxRequests && this.stats.requests.total >= this.recipe.engine.maxRequests) return false;
    if (this.opts.maxRequests && this.stats.requests.total >= this.opts.maxRequests) return false;
    if (!/^https?:\/\//i.test(req.url) && !/^file:/i.test(req.url)) return false;
    const rec = this.storage.enqueue({ runId: this.run.id, url: req.url, method: req.method, body: req.body, template: req.template, depth: req.depth, parentId: req.parentId, context: req.context, uniqueKey: uniqueKey(req.method, req.url, req.body, req.uniqueExtra ?? (req.context.parent ? `p:${req.context.parent.rowKey}` : undefined)) });
    if (rec) this.stats.requests.total++;
    return !!rec;
  }

  private async loop() {
    const active = new Set<Promise<void>>();
    while (!this.abort.signal.aborted) {
      if (this.paused) { await new Promise<void>((r) => this.resumeWaiters.push(r)); continue; }
      if (this.recipe.engine.maxRows && this.stats.rows >= this.recipe.engine.maxRows) { this.log.info('maxRows reached'); break; }
      const req = this.pool.running < this.pool.size ? this.storage.claimNext(this.run.id) : undefined;
      if (!req) {
        if (active.size === 0) {
          const counts = this.storage.queueCounts(this.run.id);
          if (counts.pending === 0 && counts.running === 0) break;
        }
        await Promise.race([...active, sleep(100)]);
        continue;
      }
      const p = this.pool.run(() => this.process(req)).catch((e) => this.log.error('worker crashed', { error: (e as Error).message })).finally(() => active.delete(p));
      active.add(p);
    }
    await Promise.allSettled(active);
  }

  private progress() {
    const now = Date.now();
    if (now - this.lastProgress < 500) return;
    this.lastProgress = now;
    const c = this.storage.queueCounts(this.run.id);
    this.stats.requests = { total: this.stats.requests.total, done: c.done, failed: c.failed, pending: c.pending, running: c.running, skipped: c.skipped };
    this.finalizeStats();
    this.emit({ type: 'run.progress', runId: this.run.id, stats: this.stats });
  }

  private finalizeStats() {
    this.stats.elapsedMs = Date.now() - this.startedAt;
    this.stats.rowsPerMinute = this.stats.elapsedMs > 0 ? Math.round((this.stats.rows / this.stats.elapsedMs) * 60_000) : 0;
    if (this.opts.ai) { this.stats.aiCalls = this.opts.ai.usage.calls; this.stats.aiTokens = this.opts.ai.usage.inputTokens + this.opts.ai.usage.outputTokens; }
    const c = this.storage.queueCounts(this.run.id);
    this.stats.requests = { total: this.stats.requests.total, done: c.done, failed: c.failed, pending: c.pending, running: c.running, skipped: c.skipped };
  }

  // ---------- request processing ----------

  private async process(req: RequestRecord) {
    const template = this.recipe.templates[req.template];
    if (!template) { this.storage.finishRequest(req.id, { status: 'failed', error: `unknown template ${req.template}` }); return; }
    if (this.robots && !(await this.robots.isAllowed(req.url))) {
      this.log.debug('blocked by robots.txt', { url: req.url });
      this.storage.finishRequest(req.id, { status: 'skipped', error: 'robots.txt' });
      this.progress();
      return;
    }
    const host = hostOf(req.url);
    const release = await this.limiter.acquire(host, this.abort.signal).catch(() => null);
    if (!release) { this.storage.finishRequest(req.id, { status: 'failed', requeue: true, error: 'aborted' }); return; }
    const started = Date.now();
    const sessionId = `s${(this.sessionCounter++ % this.recipe.engine.concurrency)}`;
    let mode: 'http' | 'browser' = this.decideMode(template);
    // hosts that already needed the browser in this run skip the HTTP attempt
    if (mode === 'http' && this.recipe.engine.mode === 'auto' && this.browserHosts.has(host)) mode = 'browser';
    this.emit({ type: 'request.start', runId: this.run.id, request: req, mode });
    try {
      let result: PageResult | undefined;
      let httpError: Error | undefined;
      try {
        result = await this.fetchPage(req, template, mode, sessionId);
      } catch (e) {
        // In auto mode an HTTP failure (5xx, 403/429, network error) is a reason to try the browser, not to give up.
        if (mode === 'http' && this.recipe.engine.mode === 'auto' && !this.abort.signal.aborted && (e as Error).name !== 'AbortError') httpError = e as Error;
        else throw e;
      } finally { release(); }

      // auto mode: upgrade to browser when HTTP clearly did not work
      if (mode === 'http' && this.recipe.engine.mode === 'auto') {
        const listEmpty = !!result && !!template.list && result.extract.listMatch?.matched === 0;
        const pageEmpty = !!result && !template.list && template.fields.length > 0 && Object.values(result.extract.page).every((v) => v == null || v === '');
        const definitive = result?.httpStatus === 404 || result?.httpStatus === 410; // a missing page stays missing in a browser
        const reason = httpError ? `http-error: ${httpError.message}` : result?.browserRequired ?? result?.blocked ?? (!definitive && listEmpty ? 'list-empty' : !definitive && pageEmpty ? 'fields-empty' : undefined);
        if (reason) {
          this.log.info('http fetch insufficient, retrying in browser', { url: req.url, reason });
          this.browserHosts.add(host);
          mode = 'browser';
          this.emit({ type: 'log', runId: this.run.id, level: 'info', msg: `Switching to browser for ${host} (${reason})` });
          const rel2 = await this.limiter.acquire(host, this.abort.signal).catch(() => null);
          if (!rel2) throw new AbortError();
          try { result = await this.fetchPage(req, template, 'browser', sessionId); } finally { rel2(); }
        }
      }
      if (!result) throw httpError ?? new Error('fetch produced no result');
      if (result.blocked) {
        const streak = (this.blockedStreak.get(host) ?? 0) + 1;
        this.blockedStreak.set(host, streak);
        this.proxies.rotateSession(sessionId);
        if (mode === 'browser') await this.browsers.recycle(sessionId);
        this.limiter.penalize(host, Math.min(60_000, 5_000 * streak));
        throw new Error(`blocked (${result.blocked})`);
      }
      this.blockedStreak.set(host, 0);
      if (mode === 'http') this.stats.httpFetches++; else this.stats.browserFetches++;
      this.stats.bytes += result.bytes;
      this.stats.pages += 1 + result.steps;

      const rows = await this.handleResult(req, template, result);
      this.storage.finishRequest(req.id, { status: 'done', durationMs: Date.now() - started, httpStatus: result.httpStatus, fetchMode: mode });
      this.emit({ type: 'request.done', runId: this.run.id, request: req, status: 'done', durationMs: Date.now() - started, rows, mode, httpStatus: result.httpStatus });
    } catch (e) {
      const err = e as Error;
      if (this.abort.signal.aborted || err.name === 'AbortError') { this.storage.finishRequest(req.id, { status: 'failed', requeue: true, error: 'aborted' }); return; }
      const retry = req.attempts <= this.recipe.engine.retries;
      const msg = err.message.slice(0, 500);
      this.log.warn(retry ? 'request failed, will retry' : 'request failed', { url: req.url, attempt: req.attempts, error: msg });
      if (retry) {
        await sleep(backoffMs(req.attempts), this.abort.signal).catch(() => { });
        this.storage.finishRequest(req.id, { status: 'failed', requeue: true, error: msg });
      } else {
        this.storage.finishRequest(req.id, { status: 'failed', error: msg, durationMs: Date.now() - started, fetchMode: mode });
        this.emit({ type: 'request.done', runId: this.run.id, request: req, status: 'failed', durationMs: Date.now() - started, rows: 0, error: msg, mode });
      }
    }
    this.progress();
  }

  private decideMode(template: Template): 'http' | 'browser' {
    if (needsBrowser(template)) return 'browser';
    const m = template.mode ?? this.recipe.engine.mode;
    if (m === 'browser') return 'browser';
    if (this.recipe.engine.session.persist) return 'browser';
    return 'http';
  }

  private async fetchPage(req: RequestRecord, template: Template, mode: 'http' | 'browser', sessionId: string): Promise<PageResult> {
    const e = this.recipe.engine;
    if (mode === 'http') {
      const proxy = this.proxies.acquire(sessionId);
      try {
        const r = await runHttp({ engine: e, template, url: req.url, method: req.method, body: req.body, proxyUrl: proxy ? ProxyPool.materialize(proxy.url, sessionId) : undefined, cookies: this.cookies, signal: this.abort.signal });
        if (proxy) { if (r.blocked) this.proxies.reportError(proxy); else this.proxies.reportSuccess(proxy); }
        if (r.httpStatus && r.httpStatus >= 500) throw new Error(`HTTP ${r.httpStatus}`);
        if (r.httpStatus === 404 || r.httpStatus === 410) { this.log.debug('page not found', { url: req.url, status: r.httpStatus }); }
        return r;
      } catch (err) { if (proxy && !(err as Error).message.startsWith('HTTP')) this.proxies.reportError(proxy); throw err; }
    }
    const page = await this.browsers.page(sessionId);
    try {
      if (e.session.clearEvery && req.attempts === 1 && this.stats.pages > 0 && this.stats.pages % e.session.clearEvery === 0) await page.context().clearCookies().catch(() => { });
      return await runBrowser({
        engine: e, template, url: req.url, method: req.method, body: req.body, page, keywords: req.context.keywords ?? {}, captcha: this.captcha, signal: this.abort.signal, runId: this.run.id,
        screenshotDir: join(this.outDir, 'screenshots', this.run.id), onLog: (m, d) => this.log.debug(m, { url: req.url, ...d }),
      });
    } finally { await page.close().catch(() => { }); }
  }

  // ---------- result handling ----------

  private async handleResult(req: RequestRecord, template: Template, result: PageResult): Promise<number> {
    const ctx = req.context;
    const dataset = template.dataset ?? (ctx.parent?.mode === 'separate' ? req.template : ctx.parent?.dataset ?? 'default');
    const rowCtx = { recipe: this.recipe, template, templateName: req.template, pageUrl: result.url, runId: this.run.id, keywords: ctx.keywords ?? {}, categoryPath: ctx.categoryPath ?? [], outDir: this.outDir, ai: this.opts.ai, screenshots: result.screenshots, onLog: (m: string, d?: Record<string, unknown>) => this.log.debug(m, d) };

    // drift telemetry + self-healing
    await this.checkDrift(req, template, result);

    let written = 0;
    const emitted: Array<Record<string, unknown>> = [];

    // page-level fields -> one row (or merge into parent)
    const pageFieldsPresent = template.fields.length > 0;
    let pageRow: ProcessedRow | undefined;
    if (pageFieldsPresent) {
      [pageRow] = await processRecords([result.extract.page], template.fields, rowCtx, true);
    }

    // list records
    let listRows: ProcessedRow[] = [];
    if (template.list) {
      let records = result.extract.records;
      if (template.list.filter) { const fn = new Function('record', `return (${template.list.filter});`) as (r: Record<string, unknown>) => boolean; records = records.filter((r) => { try { return !!fn(r); } catch { return true; } }); }
      listRows = await processRecords(records, template.list.fields, rowCtx, false);
      if (result.extract.listMatch && result.extract.listMatch.matched < template.list.minItems) {
        this.log.warn('fewer records than minItems', { url: result.url, matched: result.extract.listMatch.matched, min: template.list.minItems });
      }
    }

    // parent merge
    const parent = ctx.parent;
    if (parent && (parent.mode === 'merge' || parent.mode === 'nest')) {
      const patch: Record<string, unknown> = {};
      if (parent.mode === 'merge') {
        if (pageRow) Object.assign(patch, pageRow.data);
        if (listRows.length) patch[parent.field ? `${parent.field}_items` : parent.template] = listRows.filter((r) => !r.dropped).map((r) => r.data);
      } else {
        const nested: Record<string, unknown> = pageRow ? { ...pageRow.data } : {};
        if (listRows.length) nested.items = listRows.filter((r) => !r.dropped).map((r) => r.data);
        patch[parent.template] = template.list && !pageRow ? nested.items : nested;
      }
      const existing = this.storage.getRow(this.run.id, parent.dataset, parent.rowKey);
      if (existing) {
        const merged = { ...existing.data, ...patch };
        this.storage.mergeRow(this.run.id, parent.dataset, parent.rowKey, patch, hash(merged));
        this.emit({ type: 'rows', runId: this.run.id, dataset: parent.dataset, rows: [merged], pageUrl: result.url });
      } else {
        this.log.warn('parent row not found for merge', { parentKey: parent.rowKey });
      }
      // follow links from the child page (deeper chains) still work off the same parent row
      await this.enqueueFollows(req, template, result, listRows, parent);
      return listRows.length + (pageRow ? 1 : 0);
    }

    // write page row
    if (pageRow && !pageRow.dropped) {
      if (pageRow.failed) throw new Error(`validation failed: ${pageRow.failed}`);
      const data = ctx.parent?.mode === 'separate' ? { _parentKey: ctx.parent.rowKey, ...pageRow.data } : pageRow.data;
      const r = this.storage.upsertRow({ runId: this.run.id, dataset, rowKey: pageRow.key, data, hash: hash(data), pageUrl: result.url, flags: pageRow.flags.length ? pageRow.flags : undefined });
      if (r.inserted) { written++; emitted.push(data); }
      if (pageRow.flags.length) this.stats.validationFlags++;
    } else if (pageRow?.dropped) this.stats.validationDrops++;

    // write list rows
    for (const row of listRows) {
      if (row.failed) throw new Error(`validation failed: ${row.failed}`);
      if (row.dropped) { this.stats.validationDrops++; continue; }
      if (row.flags.length) this.stats.validationFlags++;
      const data = ctx.parent?.mode === 'separate' ? { _parentKey: ctx.parent.rowKey, ...row.data } : row.data;
      if (!this.recipe.output.dedupe) row.key = hash(`${row.key}|${result.url}|${written}|${Math.random()}`);
      const r = this.storage.upsertRow({ runId: this.run.id, dataset, rowKey: row.key, data, hash: hash(data), pageUrl: result.url, flags: row.flags.length ? row.flags : undefined });
      if (r.inserted) { written++; emitted.push(data); }
    }
    if (!listRows.length && !pageRow && this.recipe.output.blankRowWhenEmpty) {
      const data: Record<string, unknown> = { _pageUrl: result.url, _empty: true };
      if (ctx.keywords) for (const [k, v] of Object.entries(ctx.keywords)) data[`_kw_${k}`] = v;
      this.storage.upsertRow({ runId: this.run.id, dataset, rowKey: hash(`blank|${result.url}`), data, hash: hash(data), pageUrl: result.url });
      written++;
    }
    this.stats.rows += written;
    this.stats.rowsByDataset[dataset] = (this.stats.rowsByDataset[dataset] ?? 0) + written;
    if (emitted.length) this.emit({ type: 'rows', runId: this.run.id, dataset, rows: emitted, pageUrl: result.url });

    // follows (detail pages, categories)
    await this.enqueueFollows(req, template, result, listRows, { rowKey: '', dataset, mode: 'merge', template: req.template });

    // pagination (href-based)
    this.enqueuePagination(req, template, result, written);
    return written;
  }

  private async enqueueFollows(req: RequestRecord, template: Template, result: PageResult, listRows: ProcessedRow[], parentInfo: { rowKey: string; dataset: string; mode: Follow['mode']; template: string; field?: string }) {
    const ctx = req.context;
    // record-level follows
    if (template.list) {
      for (const [i, f] of template.list.follow.entries()) {
        let n = 0;
        for (const [ri, row] of listRows.entries()) {
          if (row.dropped) continue;
          if (f.limit && n >= f.limit) break;
          const url = f.field ? row.data[f.field] : result.extract.recordFollowUrls[ri]?.[followId(f, i)];
          const u = Array.isArray(url) ? url[0] : url;
          if (typeof u !== 'string' || !u) continue;
          const parentKey = ctx.parent && (ctx.parent.mode === 'merge' || ctx.parent.mode === 'nest') ? ctx.parent.rowKey : row.key;
          const parentDataset = ctx.parent && (ctx.parent.mode === 'merge' || ctx.parent.mode === 'nest') ? ctx.parent.dataset : parentInfo.dataset;
          const ok = this.enqueue({ url: u, method: 'GET', template: f.template, depth: req.depth + 1, parentId: req.id, context: { ...ctx, page: 1, paginationSeen: undefined, emptyStreak: 0, parent: { rowKey: parentKey, dataset: parentDataset, mode: f.mode, field: f.field, template: f.template } } });
          if (ok) n++;
        }
      }
    }
    // page-level follows (categories)
    for (const [i, f] of template.follow.entries()) {
      const urls = result.extract.pageFollowUrls[followId(f, i)] ?? (f.field ? [result.extract.page[f.field]].filter((x): x is string => typeof x === 'string') : []);
      let n = 0;
      for (const u of urls) {
        if (f.limit && n >= f.limit) break;
        const label = labelForUrl(u);
        const ok = this.enqueue({ url: u, method: 'GET', template: f.template, depth: req.depth + 1, parentId: req.id, context: { ...ctx, page: 1, paginationSeen: undefined, emptyStreak: 0, categoryPath: [...(ctx.categoryPath ?? []), label], parent: f.mode === 'separate' ? { rowKey: hash(result.url), dataset: parentInfo.dataset, mode: 'separate', template: f.template } : ctx.parent } });
        if (ok) n++;
      }
    }
  }

  private enqueuePagination(req: RequestRecord, template: Template, result: PageResult, newRows: number) {
    const p = template.pagination;
    if (!p) return;
    const ctx = req.context;
    const page = ctx.page ?? 1;
    const stopNoNew = 'stopWhenNoNewRows' in p ? p.stopWhenNoNewRows : false;
    const emptyStreak = newRows === 0 ? (ctx.emptyStreak ?? 0) + 1 : 0;
    if (stopNoNew && emptyStreak >= 1 && page > 1) { this.log.debug('pagination stopped: no new rows', { url: result.url, page }); return; }
    const nextCtx: RequestContext = { ...ctx, page: page + 1, emptyStreak };
    const enqueueNext = (url: string) => this.enqueue({ url, method: 'GET', template: req.template, depth: req.depth, parentId: req.id, context: nextCtx });
    switch (p.type) {
      case 'next': {
        if (p.method === 'click') return; // handled in-page
        if (p.maxPages > 0 && page >= p.maxPages) return;
        const next = result.nextUrls[0];
        if (next && next !== result.url) enqueueNext(next);
        return;
      }
      case 'pageLinks': {
        if (p.maxPages > 0 && page >= p.maxPages) return;
        for (const u of result.nextUrls) if (u !== result.url) enqueueNext(u);
        return;
      }
      case 'urlPattern': {
        if (page === 1 && ctx.paginationSeen === undefined) {
          // seed page 1 was the entry URL; generate from start
          const total = p.maxPages > 0 ? p.maxPages : Number.MAX_SAFE_INTEGER;
          const n = p.start + (page - 1) * p.step;
          if (page < total) enqueueNext(p.template.replace(/\{\{\s*page\s*\}\}/g, String(n + p.step)).replace(/%%pagenumber%%/g, String(n + p.step)));
          return;
        }
        if (p.maxPages > 0 && page >= p.maxPages) return;
        const n = p.start + page * p.step;
        enqueueNext(p.template.replace(/\{\{\s*page\s*\}\}/g, String(n)).replace(/%%pagenumber%%/g, String(n)));
        return;
      }
      case 'urlList': {
        if (page === 1) for (const [i, u] of p.urls.entries()) this.enqueue({ url: u, method: 'GET', template: req.template, depth: req.depth, parentId: req.id, context: { ...ctx, page: i + 2, emptyStreak: 0 } });
        return;
      }
      default: return; // loadMore / scroll / script handled in-page
    }
  }

  // ---------- drift + healing ----------

  private async checkDrift(req: RequestRecord, template: Template, result: PageResult) {
    const ex = result.extract;
    const recipeId = this.opts.recipeId ?? this.recipe.id;
    const emitDrift = (kind: 'field-missing' | 'list-empty' | 'fallback-candidate' | 'healed' | 'heal-failed', field: string | undefined, detail: Record<string, unknown>) => {
      const ev = this.storage.addDrift({ runId: this.run.id, recipeId, template: req.template, field, kind, detail, pageUrl: result.url });
      this.stats.drift++;
      this.emit({ type: 'drift', runId: this.run.id, event: ev });
    };
    // fallback candidates used
    for (const [name, m] of Object.entries(ex.fieldMatches)) {
      const key = `${req.template}.${name}`;
      if (m.candidate > 0 && !this.fallbackReported.has(key)) { this.fallbackReported.add(key); emitDrift('fallback-candidate', name, { candidate: m.candidate }); }
    }
    if (ex.listMatch && ex.listMatch.candidate > 0 && !this.fallbackReported.has(`${req.template}.__list`)) { this.fallbackReported.add(`${req.template}.__list`); emitDrift('fallback-candidate', '__list', { candidate: ex.listMatch.candidate }); }

    const missing: Array<{ field: import('../recipe/schema.js').Field; inList: boolean }> = [];
    if (template.list && ex.listMatch && ex.listMatch.matched === 0 && req.attempts <= 1) {
      emitDrift('list-empty', '__list', { selectors: template.list.selector.map((c) => c.value) });
    } else if (template.list && ex.records.length) {
      for (const f of template.list.fields) {
        if (!f.selector || f.type === 'constant') continue;
        const allNull = ex.records.every((r) => r[f.name] == null || r[f.name] === '' || (Array.isArray(r[f.name]) && !(r[f.name] as unknown[]).length));
        if (allNull) missing.push({ field: f, inList: true });
      }
    }
    for (const f of template.fields) {
      if (!f.selector || f.type === 'constant') continue;
      const v = ex.page[f.name];
      if (v == null || v === '') missing.push({ field: f, inList: false });
    }
    for (const m of missing) {
      const key = `${req.template}.${m.field.name}`;
      if (this.fallbackReported.has(`missing:${key}`)) continue;
      this.fallbackReported.add(`missing:${key}`);
      emitDrift('field-missing', m.field.name, { selectors: m.field.selector?.map((c) => c.value) });
    }

    // self-heal: only once per field per run, only when AI available and enabled
    if (!this.opts.ai || !this.recipe.ai.selfHeal || !result.html) return;
    const listEmpty = template.list && ex.listMatch?.matched === 0;
    const toHeal = listEmpty ? [] : missing;
    for (const m of toHeal) {
      const key = `${req.template}.${m.field.name}`;
      if (this.healedFields.has(key)) continue;
      this.healedFields.add(key);
      try {
        const samples = this.previousSamples(m.field.name);
        const candidates = await this.opts.ai.healSelector({ html: result.html, url: result.url, field: m.field, listSelector: m.inList ? template.list!.selector[0]?.value : undefined, sampleValues: samples, providerName: this.recipe.ai.provider });
        let fixed = false;
        for (const c of candidates) {
          const trial = { ...m.field, selector: [c] };
          const spec = buildSpec({ ...template, fields: m.inList ? [] : [trial], list: m.inList && template.list ? { ...template.list, fields: [trial] } : undefined, pagination: undefined, follow: [] }, result.url);
          const test = extractFromHtml(result.html, result.url, spec);
          const vals = m.inList ? test.records.map((r) => r[m.field.name]) : [test.page[m.field.name]];
          const hits = vals.filter((v) => v != null && v !== '').length;
          if (hits > 0 && (!m.inList || hits >= Math.max(1, vals.length * 0.5))) {
            m.field.selector = [c, ...(m.field.selector ?? [])];
            // re-extract affected values for this page
            if (m.inList) ex.records.forEach((r, i) => { r[m.field.name] = test.records[i]?.[m.field.name] ?? r[m.field.name]; });
            else ex.page[m.field.name] = test.page[m.field.name];
            this.stats.healed++;
            emitDrift('healed', m.field.name, { selector: c.value, note: c.note, hits, of: vals.length });
            this.log.info('self-healed selector', { field: m.field.name, selector: c.value });
            fixed = true;
            break;
          }
        }
        if (!fixed) emitDrift('heal-failed', m.field.name, { tried: candidates.map((c) => c.value) });
      } catch (e) { this.log.warn('self-heal error', { field: m.field.name, error: (e as Error).message }); }
    }
  }

  private previousSamples(field: string): unknown[] {
    const recipeId = this.opts.recipeId ?? this.recipe.id;
    if (!recipeId) return [];
    const prev = this.storage.previousRun(recipeId, this.run.id);
    if (!prev) return [];
    const out: unknown[] = [];
    for (const r of this.storage.iterRows(prev.id, undefined, { limit: 5 })) if (r.data[field] != null) out.push(r.data[field]);
    return out;
  }
}

function labelForUrl(u: string): string {
  try { const p = new URL(u).pathname.split('/').filter(Boolean); return decodeURIComponent(p[p.length - 1] ?? '').replace(/[-_]+/g, ' ') || u; } catch { return u; }
}
