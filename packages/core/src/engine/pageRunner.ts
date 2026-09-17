import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '../browser/provider.js';
import type { EngineConfig, Template } from '../recipe/schema.js';
import { domExtract, type DomExtractResult, type DomExtractSpec } from '../dom/extractor.js';
import { extractFromHtml, looksLikeBrowserRequired } from '../dom/jsdom.js';
import { httpFetch, type CookieJar } from '../fetch/http.js';
import { hash, sleep } from '../util/misc.js';
import { runActions, locate, evaluateMainWorld, type ActionContext } from './actions.js';
import { looksBlocked, type CaptchaSolver } from './captcha.js';
import { PAGINATION_PROBE, buildSpec } from './spec.js';

export interface PageResult {
  url: string;
  mode: 'http' | 'browser';
  extract: DomExtractResult;
  html?: string;
  httpStatus?: number;
  bytes: number;
  /** number of in-page pagination steps performed */
  steps: number;
  /** hrefs for the next page(s) discovered via probes (href-style pagination) */
  nextUrls: string[];
  blocked?: string;
  browserRequired?: string;
  screenshots: Record<string, string>;
  durationMs: number;
}

export interface HttpRunOptions {
  engine: EngineConfig;
  template: Template;
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  proxyUrl?: string;
  cookies: CookieJar;
  signal?: AbortSignal;
}

export async function runHttp(o: HttpRunOptions): Promise<PageResult> {
  const start = Date.now();
  const res = await httpFetch(o.url, {
    method: o.method, body: o.body, headers: o.engine.headers, userAgent: o.engine.userAgent, proxyUrl: o.proxyUrl,
    timeoutMs: o.engine.timeoutMs, cookies: o.cookies.headerFor(o.url), signal: o.signal,
  });
  o.cookies.absorb(res.url, res.setCookies);
  const blocked = looksBlocked(res.body, res.status);
  const spec = buildSpec(o.template, res.url);
  const extract = extractFromHtml(res.body, res.url, spec);
  const need = looksLikeBrowserRequired(res.body);
  const probe = extract.probes[PAGINATION_PROBE];
  const pg = o.template.pagination;
  // a "next" control that exists but carries no link needs a browser to click it
  const jsPagination = pg?.type === 'next' && pg.method !== 'href' && !!probe?.exists && probe.hrefs.filter((h) => !/^(javascript:|#$)/i.test(h)).length === 0;
  return {
    url: res.url, mode: 'http', extract, html: res.body, httpStatus: res.status, bytes: res.bytes, steps: 0,
    nextUrls: probe?.hrefs ?? [], blocked: blocked ?? undefined, browserRequired: need.required ? need.reason : jsPagination ? 'js-pagination' : undefined,
    screenshots: {}, durationMs: Date.now() - start,
  };
}

export interface BrowserRunOptions {
  engine: EngineConfig;
  template: Template;
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  page: Page;
  keywords: Record<string, string>;
  captcha?: CaptchaSolver;
  signal?: AbortSignal;
  screenshotDir?: string;
  runId: string;
  onLog?: (msg: string, data?: Record<string, unknown>) => void;
  /** Called after each in-page pagination step with the records found so far (live preview). */
  onStep?: (records: number, step: number) => void;
}

const MAX_IN_PAGE_STEPS = 10_000;

export async function runBrowser(o: BrowserRunOptions): Promise<PageResult> {
  const start = Date.now();
  const { page, template, engine } = o;
  const t = engine.timeoutMs;
  const actx: ActionContext = { keywords: o.keywords, timeoutMs: t, signal: o.signal, captcha: o.captcha, onLog: o.onLog, screenshotDir: o.screenshotDir };

  let httpStatus: number | undefined;
  if (o.method === 'POST') {
    // Navigate via an in-page form submission so the browser gets the POST response.
    await page.goto('about:blank');
    await page.evaluate(([url, body]) => {
      const form = document.createElement('form'); form.method = 'POST'; form.action = url;
      for (const [k, v] of new URLSearchParams(body)) { const i = document.createElement('input'); i.name = k; i.value = v; form.appendChild(i); }
      document.body.appendChild(form); form.submit();
    }, [o.url, o.body ?? ''] as const);
    await page.waitForLoadState(engine.navigationWaitUntil === 'commit' ? 'domcontentloaded' : engine.navigationWaitUntil, { timeout: t }).catch(() => { });
  } else {
    const resp = await page.goto(o.url, { waitUntil: engine.navigationWaitUntil, timeout: t });
    httpStatus = resp?.status();
  }

  // Challenge / CAPTCHA handling
  let html = await page.content().catch(() => '');
  let blocked = looksBlocked(html, httpStatus);
  if (blocked) {
    // Cloudflare "just a moment" usually clears itself in a real browser; give it a chance.
    for (let i = 0; i < 6 && blocked; i++) {
      await sleep(2500, o.signal);
      html = await page.content().catch(() => '');
      blocked = looksBlocked(html, undefined);
    }
    if (blocked && o.captcha && engine.captcha.autoDetect) {
      o.onLog?.('challenge detected, invoking captcha solver', { kind: blocked });
      const ok = await o.captcha.solve(page, 'auto').catch((e: Error) => { o.onLog?.('captcha solve failed', { error: e.message }); return false; });
      if (ok) { await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => { }); html = await page.content().catch(() => ''); blocked = looksBlocked(html, undefined); }
    }
  } else if (o.captcha && engine.captcha.autoDetect) {
    const det = await o.captcha.detect(page);
    if (det) { o.onLog?.('captcha widget detected', { kind: det.kind }); await o.captcha.solve(page, det.kind).catch((e: Error) => o.onLog?.('captcha solve failed', { error: e.message })); }
  }

  let scope: Page | Frame = page;
  if (template.actions.length) scope = (await runActions(page, template.actions, actx)).frame;
  if (template.waitFor) {
    const found = await locate(scope, template.waitFor, t);
    if (!found) o.onLog?.('waitFor selector did not appear; extracting anyway', { selector: template.waitFor[0]?.value });
  }
  if (template.list) {
    // single-page apps hydrate after load: wait for the records to appear before extracting
    await locate(scope, template.list.selector, Math.min(t, 10_000));
  }

  const spec = buildSpec(template, page.url());
  // Playwright passes a single argument: ship the extractor source and call it with (document, spec).
  const extractOnce = async (): Promise<DomExtractResult> => {
    return scope.evaluate(
      ({ fn, spec }: { fn: string; spec: DomExtractSpec }) => (new Function(`return (${fn})`)() as (d: Document, s: DomExtractSpec) => DomExtractResult)(document, spec),
      { fn: domExtract.toString(), spec },
    );
  };

  let result = await extractOnce();
  // Late hydration: a list that renders after the first paint would otherwise be reported as empty.
  // Only pages that actually came back empty pay this cost.
  if (template.list && result.records.length === 0) {
    for (let attempt = 0; attempt < 2 && result.records.length === 0; attempt++) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
      await sleep(1500, o.signal);
      result = await extractOnce();
    }
    if (result.records.length === 0) o.onLog?.('list selector matched nothing after waiting for the page to settle', { selector: template.list.selector[0]?.value, url: page.url() });
    else o.onLog?.('records appeared after waiting for the page to settle', { records: result.records.length });
  }
  const seen = new Set<string>(result.records.map((r) => hash(r)));
  let steps = 0;
  const p = template.pagination;
  // A "next" control without a usable href (JS pagination button) must be clicked in-page.
  const nextProbe = result.probes[PAGINATION_PROBE];
  const jsNext = p?.type === 'next' && p.method === 'auto' && !!nextProbe?.exists && nextProbe.hrefs.filter((h) => !/^(javascript:|#$)/i.test(h) && h !== page.url()).length === 0;
  if (jsNext) o.onLog?.('next control has no link; paginating by clicking', { selector: p && 'selector' in p ? p.selector[0]?.value : undefined });
  const inPage = p && (p.type === 'loadMore' || p.type === 'scroll' || p.type === 'script' || (p.type === 'next' && (p.method === 'click' || jsNext)));
  if (inPage && p) {
    // maxPages counts the first page too; clicks/scrolls count steps
    const max = p.type === 'loadMore' ? p.maxClicks : p.type === 'scroll' ? p.maxScrolls : p.maxPages > 0 ? p.maxPages - 1 : -1;
    const limit = max < 0 ? MAX_IN_PAGE_STEPS : max;
    let emptyStreak = 0;
    while (steps < limit) {
      if (o.signal?.aborted) throw new Error('aborted');
      let advanced = false;
      if (p.type === 'loadMore' || p.type === 'next') {
        const found = await locate(scope, p.selector, 1500);
        if (!found) break;
        const btn = found.locator.first();
        if (!(await btn.isVisible().catch(() => false))) break;
        if (!(await btn.isEnabled().catch(() => true))) break; // disabled "next"/"load more" = last page
        await btn.scrollIntoViewIfNeeded().catch(() => { });
        await btn.click({ timeout: t }).catch(() => { });
        advanced = true;
        if (p.type === 'next') await page.waitForLoadState('domcontentloaded', { timeout: t }).catch(() => { });
      } else if (p.type === 'scroll') {
        const before = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
        if (p.selector) { const found = await locate(scope, p.selector, 500); if (found) await found.locator.first().evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; }).catch(() => { }); }
        await page.mouse.wheel(0, 3000).catch(() => { });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => { });
        await sleep(p.delayMs, o.signal);
        const after = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
        advanced = after !== before;
      } else if (p.type === 'script') {
        const r = await evaluateMainWorld(scope, p.code).catch(() => false);
        advanced = r !== false;
      }
      const delay = 'delayMs' in p ? p.delayMs : 800;
      await sleep(delay, o.signal);
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
      steps++;
      const next = await extractOnce();
      let fresh = 0;
      for (const r of next.records) { const h = hash(r); if (!seen.has(h)) { seen.add(h); result.records.push(r); result.recordFollowUrls.push(next.recordFollowUrls[next.records.indexOf(r)] ?? {}); fresh++; } }
      result.listMatch = next.listMatch ? { candidate: next.listMatch.candidate, matched: result.records.length } : result.listMatch;
      result.page = { ...result.page, ...next.page };
      result.probes = next.probes;
      o.onStep?.(result.records.length, steps);
      const stopNoNew = 'stopWhenNoNewRows' in p ? p.stopWhenNoNewRows : true;
      if (fresh === 0) { emptyStreak++; if (!advanced || (stopNoNew && emptyStreak >= 2)) break; } else emptyStreak = 0;
      if (p.type === 'next' && !advanced) break;
    }
  }

  // screenshots for screenshot-type fields
  const screenshots: Record<string, string> = {};
  const shotFields = [...template.fields, ...(template.list?.fields ?? [])].filter((f) => f.type === 'screenshot');
  if (shotFields.length) {
    const dir = o.screenshotDir ?? join(process.cwd(), '.scrappia', 'screenshots', o.runId);
    mkdirSync(dir, { recursive: true });
    for (const f of shotFields) {
      const file = join(dir, `${hash(page.url()).slice(0, 12)}-${f.name}.png`);
      try {
        if (f.selector) { const found = await locate(scope, f.selector, 1000); if (found) await found.locator.first().screenshot({ path: file }); else await page.screenshot({ path: file }); }
        else await page.screenshot({ path: file, fullPage: true });
        screenshots[f.name] = file;
      } catch (e) { o.onLog?.('screenshot failed', { field: f.name, error: (e as Error).message }); }
    }
  }

  html = await page.content().catch(() => html);
  return {
    url: page.url(), mode: 'browser', extract: result, html, httpStatus, bytes: html.length, steps,
    nextUrls: inPage ? [] : result.probes[PAGINATION_PROBE]?.hrefs ?? [], blocked: blocked ?? undefined, screenshots, durationMs: Date.now() - start,
  };
}
