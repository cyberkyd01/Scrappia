#!/usr/bin/env node
/**
 * End-to-end test of the MANUAL (point-and-click, no copilot) path through the BUILT desktop app.
 * Not part of vitest.
 *
 *   npm run build --prefix packages/core && npm run build --prefix packages/inspector
 *   npm run build --prefix apps/desktop
 *   node apps/desktop/scripts/e2e-manual.mjs            # fixture-site scenarios (steps 1-13, 15)
 *   node apps/desktop/scripts/e2e-manual.mjs --live     # ...plus a live Amazon search (step 14, needs network)
 *   node apps/desktop/scripts/e2e-manual.mjs --keep     # keep the temp userData / output directories
 *   node apps/desktop/scripts/e2e-manual.mjs --only=4,5 # run only some steps (earlier steps' state is NOT rebuilt)
 *
 * Flow: core's fixture site (packages/core/dist/test/fixtureSite.js) -> Electron launched with remote
 * debugging in a throw-away userData dir -> patchright drives the app UI over CDP and performs REAL
 * clicks in the recorder browser (reached through SCRAPPIA_RECORDER_CDP_PORT). Every step asserts DOM
 * state, the recipe JSON (JSON tab) and run results through IPC (`window.scrappia.invoke` in the main
 * world). Native file dialogs are stubbed with SCRAPPIA_E2E_DIALOGS. Prints PASS/FAIL, exit code.
 */
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { chromium } from 'patchright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const desktopDir = resolve(here, '..');
const { startFixtureSite, FIXTURE_PRODUCT_COUNT } = await import(pathToFileURL(resolve(repoRoot, 'packages/core/dist/test/fixtureSite.js')).href);

const LIVE = process.argv.includes('--live');
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const TOTAL_TIMEOUT_MS = LIVE ? 20 * 60_000 : 15 * 60_000;

// ------------------------------------------------------------------ helpers

const t0 = Date.now();
const log = (...a) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 30_000, label = 'condition', interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last.message})` : ''}`);
}
function freePort() {
  return new Promise((res, rej) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
let assertions = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); assertions++; log('ok:', msg); };

// ------------------------------------------------------------------ app launch

async function launchApp({ userData, recorderPort, extraEnv = {} }) {
  const port = await freePort();
  const env = { ...process.env, SCRAPPIA_USER_DATA: userData, SCRAPPIA_RECORDER_CDP_PORT: String(recorderPort), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OLLAMA_HOST: '', SCRAPPIA_OLLAMA: '', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [desktopDir, `--remote-debugging-port=${port}`, '--no-first-run'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const out = [];
  child.stdout.on('data', (d) => { out.push(d.toString()); });
  child.stderr.on('data', (d) => { const s = d.toString(); out.push(s); if (/\[scrappia\]|Unhandled|Error/.test(s) && !/ExperimentalWarning/.test(s)) process.stderr.write(`  [app] ${s}`); });
  await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; }, { timeout: 60_000, label: 'electron remote debugging port' });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
  const page = await waitFor(async () => {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/renderer\/index\.html|localhost:5\d{3}/.test(p.url())) return p;
    return undefined;
  }, { timeout: 60_000, label: 'app window page' });
  await page.waitForSelector('.sidebar .brand', { timeout: 60_000 });
  const rendererConsole = [];
  page.on('pageerror', (e) => { rendererConsole.push(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') rendererConsole.push(`[console.${m.type()}] ${m.text()}`); });
  // Collect renderer exceptions inside the page (CDP pageerror does not fire for Electron here). Main world: patchright isolates by default.
  await page.evaluate(() => {
    const w = window; w.__e2eErrors = [];
    w.addEventListener('error', (e) => w.__e2eErrors.push(String(e.error?.stack ?? e.message)));
    w.addEventListener('unhandledrejection', (e) => w.__e2eErrors.push('unhandledrejection: ' + String(e.reason?.stack ?? e.reason)));
    // remember every toast (they disappear after a few seconds)
    w.__e2eToasts = [];
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList?.contains('toast')) w.__e2eToasts.push(`${new Date().toISOString().slice(11, 19)} ${n.textContent}`); }).observe(document.body, { childList: true, subtree: true });
    // React warnings go through console.error / console.warn
    for (const level of ['error', 'warn']) { const orig = console[level].bind(console); console[level] = (...a) => { w.__e2eErrors.push(`console.${level}: ` + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ').slice(0, 500)); orig(...a); }; }
  }, undefined, {}, false);
  return { child, browser, page, output: out, rendererConsole, stop: async () => { try { await browser.close(); } catch { /* ignore */ } if (!child.killed) child.kill(); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); } };
}

// ------------------------------------------------------------------ driver

class Driver {
  constructor(app, site, recorderPort) { this.app = app; this.page = app.page; this.site = site; this.recorderPort = recorderPort; this.recBrowser = undefined; }
  tid(id) { return this.page.locator(`[data-testid="${id}"]`); }
  /** Call an IPC channel exactly like the renderer does (main world exposes window.scrappia). */
  ipc(channel, ...args) { return this.page.evaluate(([c, a]) => window.scrappia.invoke(c, ...a), [channel, args], {}, false); }
  rendererErrors() { return this.page.evaluate(() => window.__e2eErrors ?? [], undefined, {}, false); }
  toastLog() { return this.page.evaluate(() => window.__e2eToasts ?? [], undefined, {}, false); }
  /** URLs of every page in the recorder browser (diagnostics). */
  async recUrls() {
    try { const b = this.recBrowser?.isConnected() ? this.recBrowser : await chromium.connectOverCDP(`http://127.0.0.1:${this.recorderPort}`, { timeout: 5000 }); return b.contexts().flatMap((c) => c.pages().map((p) => p.url())); } catch (e) { return [`(unreachable: ${e.message})`]; }
  }
  async toasts() { return this.tid('toast').allTextContents(); }
  async waitToast(re, timeout = 15_000) { return waitFor(async () => (await this.toasts()).find((t) => re.test(t)), { timeout, label: `toast ${re}` }); }

  // ---- recorder browser (separate Chromium, own CDP port) ----
  async recPage(match = () => true, { timeout = 60_000 } = {}) {
    return waitFor(async () => {
      if (!this.recBrowser || !this.recBrowser.isConnected()) {
        this.recBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${this.recorderPort}`, { timeout: 5000 });
        this.recBrowser.on('disconnected', () => { this.recBrowser = undefined; });
      }
      for (const ctx of this.recBrowser.contexts()) for (const p of ctx.pages()) if (!p.isClosed() && match(p.url())) return p;
      return undefined;
    }, { timeout, label: 'recorder page' });
  }
  async waitRecorder({ open = true, overlay = true, url } = {}) {
    await waitFor(async () => {
      const s = this.tid('recorder-status');
      if ((await s.getAttribute('data-open')) !== String(open)) return false;
      if (open && overlay && (await s.getAttribute('data-overlay')) !== 'ready') return false;
      if (url && !(url instanceof RegExp ? url.test(await this.tid('recorder-url').inputValue()) : (await this.tid('recorder-url').inputValue()) === url)) return false;
      return true;
    }, { timeout: 90_000, label: `recorder ${open ? 'open' : 'closed'}${overlay ? ' + overlay ready' : ''}${url ? ` at ${url}` : ''}` });
  }
  async setMode(mode) {
    await this.tid(`mode-${mode}`).click();
    await waitFor(async () => (await this.tid(`mode-${mode}`).getAttribute('data-active')) === 'true', { label: `mode ${mode} active` });
    await sleep(300); // let the overlay apply the mode after the IPC round trip
  }
  /** Real mouse click on an element in the recorder browser (the overlay intercepts it while picking). */
  async realClick(selector, nth = 0, urlMatch) {
    // by default the page whose origin matches the app's URL bar (fixture site or a live site)
    const origin = new URL(await this.tid('recorder-url').inputValue()).origin;
    const rec = await this.recPage(urlMatch ?? ((u) => u.startsWith(origin)));
    const loc = rec.locator(selector).nth(nth);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    await loc.scrollIntoViewIfNeeded();
    const box = await waitFor(() => loc.boundingBox(), { label: `bounding box of ${selector}` });
    await rec.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(120);
    await rec.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return rec;
  }

  // ---- recipe ----
  async recipeJson() {
    await this.tid('recorder-json').click();
    const text = await waitFor(async () => { const v = await this.tid('json-text').inputValue(); return v.length > 2 ? v : undefined; }, { label: 'recipe JSON text' });
    await this.tid('drawer-close').click();
    await waitFor(async () => (await this.tid('recipe-settings').count()) === 0, { label: 'drawer closed' });
    return JSON.parse(text);
  }
  async applyJson(recipe) {
    await this.tid('recorder-json').click();
    await this.tid('json-text').fill(JSON.stringify(recipe, null, 2));
    await this.tid('json-apply').click();
    await this.waitToast(/Recipe JSON applied/);
    await this.tid('drawer-close').click();
    await waitFor(async () => (await this.tid('recipe-settings').count()) === 0, { label: 'drawer closed' });
  }
  async newRecipe(url) {
    if (!(await this.page.locator('.sidebar .nav-item', { hasText: 'Recipes' }).count())) throw new Error('sidebar missing');
    await this.page.locator('.sidebar .nav-item', { hasText: 'Recipes' }).click();
    await this.tid('home-new-recipe').click();
    await this.page.locator('.modal input.input').fill(url);
    await this.page.getByRole('button', { name: 'Open recorder' }).click();
    await this.page.waitForSelector('.recorder', { timeout: 20_000 });
    await this.waitRecorder({ url });
    await waitFor(async () => (await this.tid('mode-pick').getAttribute('data-active')) === 'true', { label: 'pick mode after opening' });
    await sleep(300);
  }
  /** Pick list mode + real click -> detected list picker; tick fields matching `keep`; use the list. */
  async pickList(selector, nth, keep) {
    await this.setMode('pickList');
    await this.realClick(selector, nth);
    await waitFor(() => this.tid('list-picker-count').count(), { label: 'detected list picker' });
    const boxes = await this.page.locator('[data-testid^="list-picker-field-"]').all();
    const names = [];
    for (const b of boxes) {
      const id = (await b.getAttribute('data-testid')).replace('list-picker-field-', '');
      names.push(id);
      const want = keep ? keep.some((re) => re.test(id)) : true;
      if ((await b.isChecked()) !== want) await b.click();
    }
    await this.tid('list-picker-use').click();
    await this.waitToast(/List set/);
    return names;
  }
  /** Pick field mode + real click -> capture panel. */
  async pickField(selector, nth = 0, urlMatch) {
    await this.setMode('pick');
    await this.realClick(selector, nth, urlMatch);
    await waitFor(() => this.tid('capture-panel').count(), { label: 'capture panel' });
  }
  /** Make sure the current template's list has at least one field (some fixtures suggest none). */
  async ensureListField(selector, name) {
    if (await this.page.locator('[data-testid="tree-list"] ~ .children [data-testid^="tree-field-"]').count()) return;
    await this.pickField(selector, 0);
    if (await this.tid('capture-scope-record').count()) await this.tid('capture-scope-record').click();
    await this.tid('field-name').fill(name);
    await this.tid('capture-field').click();
    await this.waitToast(/Captured/);
  }
  listFieldNames() { return this.page.locator('[data-testid="tree-list"] ~ .children [data-testid^="tree-field-"] .n').allTextContents(); }
  async testRun({ timeout = 120_000 } = {}) {
    await waitFor(async () => await this.tid('test-run-button').isEnabled(), { label: 'test run button enabled' });
    await this.tid('test-run-button').click();
    await waitFor(() => this.tid('test-run-status').count(), { label: 'test run status badge' });
    const status = await waitFor(async () => { const s = await this.tid('test-run-status').textContent(); return s !== 'running' ? s : undefined; }, { timeout, label: 'test run finished' });
    const runs = await this.ipc('runs.list', { limit: 1 });
    const run = await this.ipc('runs.get', runs[0].id);
    // the stored rows are what the UI reconciles to when the run finishes
    const rows = await this.ipc('runs.rows', run.id, undefined, { limit: 500 });
    await waitFor(async () => /\(\d+\)/.test(await this.tid('test-run-tab').textContent()), { label: 'test run tab counter' });
    const logLines = (await this.tid('test-run-log').count()) ? await this.tid('test-run-log').locator('.line').allTextContents() : [];
    const statsText = await this.tid('test-run-stats').textContent();
    return { status, run, rows, logLines, statsText, tab: await this.tid('test-run-tab').textContent() };
  }
  async previewRows() {
    await this.tid('preview-tab').click();
    const table = this.tid('preview-table');
    // the preview refreshes with a debounce: wait until every field column carries match stats from the latest extraction
    await waitFor(async () => { const hs = await table.locator('thead th').allTextContents(); return hs.length > 1 && hs.slice(1).every((h) => /cand #|no match/.test(h)); }, { timeout: 30_000, label: 'preview table with match stats' });
    const headers = await table.locator('thead th').allTextContents();
    const rows = await table.locator('tbody tr').all();
    const out = [];
    for (const r of rows) { const cells = await r.locator('td').allTextContents(); const o = {}; headers.forEach((h, i) => { o[h.split('\n')[0].replace(/cand #.*|no match.*|·.*/s, '').trim()] = cells[i]; }); out.push(o); }
    return out;
  }
  async openDrawer(tab) {
    await this.tid('recorder-settings').click();
    await waitFor(() => this.tid('recipe-settings').count(), { label: 'settings drawer' });
    await this.tid(`tab-${tab}`).click();
  }
  async closeDrawer() {
    await this.tid('drawer-close').click();
    await waitFor(async () => (await this.tid('recipe-settings').count()) === 0, { label: 'drawer closed' });
  }
}

// ------------------------------------------------------------------ steps

const steps = [];
const step = (n, name, fn) => steps.push({ n, name, fn });

step(1, 'home -> new recipe -> recorder opens', async (d) => {
  await d.tid('home-new-recipe').click();
  await d.page.locator('.modal input.input').fill(`${d.site.url}/products`);
  await d.page.getByRole('button', { name: 'Open recorder' }).click();
  await d.page.waitForSelector('.recorder', { timeout: 20_000 });
  await d.waitRecorder({ url: `${d.site.url}/products` });
  assert((await d.tid('recorder-url').inputValue()) === `${d.site.url}/products`, 'URL bar shows the entry URL');
  const rec = await d.recPage((u) => u.startsWith(d.site.url));
  assert(/Products page 1/.test(await rec.title()), `recorder browser opened the fixture page (${rec.url()})`);
  await waitFor(async () => (await d.tid('mode-pick').getAttribute('data-active')) === 'true', { label: 'pick mode active on open' });
  assert(true, 'recorder starts in Pick field mode');
  assert((await d.tid('test-run-button').isDisabled()), 'Test run is disabled while the recipe has no fields');
  assert(/No list on this template|How to record|Inspector/.test(await d.tid('inspector-panel').innerText()), 'inspector panel shows the how-to text');
});

step(2, 'pick list -> set as list with fields -> preview', async (d) => {
  const names = await d.pickList('article.product', 1, [/^(title|name|product|link)$/, /^price$/, /^url$/]);
  assert(names.includes('price'), `list picker suggested fields include price (${names.join(', ')})`);
  await waitFor(() => d.tid('tree-list').count(), { label: 'list node in tree' });
  assert(/article\.product/.test(await d.tid('tree-list').textContent()), 'template tree shows the list on article.product');
  const fields = await d.listFieldNames();
  assert(fields.includes('price') && fields.length >= 2, `template tree shows list fields: ${fields.join(', ')}`);
  const recipe = await d.recipeJson();
  assert(recipe.templates.main.list?.selector?.[0]?.value === 'article.product', 'recipe JSON list selector');
  assert(recipe.templates.main.list.fields.some((f) => f.name === 'price' && f.transforms?.some((t) => t.type === 'currency')), 'price field got a currency transform');
  const rows = await d.previewRows();
  assert(rows.length === 10, `data preview shows ${rows.length} rows`);
  assert(rows.every((r) => r.price && r.price.trim()), 'every preview row has a non-empty price');
  assert(/Current page \(10\)/.test(await d.tid('preview-tab').textContent()), 'preview tab label shows the record count');
});

step(3, 'pick next link -> set as next page -> max pages 2', async (d) => {
  await d.pickField('li.next a');
  assert(/next/.test(await d.tid('capture-panel').innerText()), 'capture panel shows the clicked "next" link');
  await d.tid('capture-pagination-next').click();
  await d.waitToast(/Pagination set: next/);
  assert((await d.tid('tree-pagination').getAttribute('data-type')) === 'next', 'template tree shows next-page pagination');
  await d.tid('tree-pagination').click();
  await waitFor(() => d.tid('pagination-max-pages').count(), { label: 'pagination editor' });
  await d.tid('pagination-max-pages').fill('2');
  const recipe = await d.recipeJson();
  assert(recipe.templates.main.pagination?.type === 'next' && recipe.templates.main.pagination.maxPages === 2, `recipe JSON has next pagination with maxPages 2 (selector ${recipe.templates.main.pagination.selector?.[0]?.value})`);
  const sel = recipe.templates.main.pagination.selector[0].value;
  const rec = await d.recPage((u) => u.startsWith(d.site.url));
  assert((await rec.locator(sel).count()) === 1, `pagination selector "${sel}" matches exactly the next link`);
});

step(4, 'test run: 2 pages / 20 rows, log + tab counter', async (d) => {
  const r = await d.testRun();
  assert(r.status === 'succeeded', `test run status ${r.status}`);
  assert(r.run.stats.pages === 2 && r.run.stats.rows === 20, `run stats: ${r.run.stats.pages} pages, ${r.run.stats.rows} rows`);
  assert(/2 pages · 20 rows/.test(r.statsText), `stats line "${r.statsText}"`);
  assert(r.rows.length === 20 && r.rows.every((x) => x.price), `${r.rows.length} stored rows with prices`);
  assert(r.logLines.filter((l) => /→ done, 10 rows/.test(l)).length === 2, `test-run-log shows 2 request lines: ${r.logLines.join(' | ')}`);
  assert(r.tab === 'Test run (20)', `Test run tab label "${r.tab}"`);
  assert((await d.tid('test-run-table').locator('tbody tr').count()) === 20, 'test run table shows 20 rows');
});

step(5, 'pagination: page links -> 25 rows; url pattern -> 25 rows', async (d) => {
  await d.tid('tree-pagination').click();
  await d.tid('pagination-type').selectOption('pageLinks');
  // replace the picked next-link selector by the numbered links
  while ((await d.page.locator('[data-testid="inspector-body"] [data-testid^="selector-remove-"]').count()) > 1) await d.tid('selector-remove-1').click();
  await d.tid('selector-input-0').fill('a.page-link');
  let recipe = await d.recipeJson();
  assert(recipe.templates.main.pagination.type === 'pageLinks' && recipe.templates.main.pagination.selector[0].value === 'a.page-link', 'recipe JSON has pageLinks pagination on a.page-link');
  let r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === FIXTURE_PRODUCT_COUNT, `page links: ${r.rows.length} rows over ${r.run.stats.pages} pages`);
  assert(r.run.stats.pages >= 3, `page links visited ${r.run.stats.pages} pages`);

  await d.tid('tree-pagination').click();
  await d.tid('pagination-type').selectOption('urlPattern');
  await d.tid('pagination-template').fill(`${d.site.url}/products?page={{page}}`);
  recipe = await d.recipeJson();
  assert(recipe.templates.main.pagination.type === 'urlPattern' && /\{\{page\}\}/.test(recipe.templates.main.pagination.template), 'recipe JSON has urlPattern pagination');
  r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === FIXTURE_PRODUCT_COUNT, `url pattern: ${r.rows.length} rows over ${r.run.stats.pages} pages`);
});

step(6, 'load more, infinite scroll, JS next button', async (d) => {
  await d.newRecipe(`${d.site.url}/loadmore`);
  // the page starts with two rows: a user browses with picking off and clicks "Load more" once to see the pattern
  await d.setMode('off');
  const lm = await d.realClick('#more');
  await waitFor(async () => (await lm.locator('.row').count()) === 4, { label: 'load more added rows with picking off' });
  await d.pickList('.row', 1);
  await d.ensureListField('.row', 'row');
  await d.pickField('#more');
  await d.tid('capture-pagination-loadmore').click();
  await d.waitToast(/Pagination set: loadMore/);
  let r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === 8, `load more: ${r.rows.length} rows (${r.statsText})`);

  await d.newRecipe(`${d.site.url}/scroll`);
  await d.pickList('.row', 1);
  await d.ensureListField('.row', 'row');
  await d.pickField('.row', 2);
  await d.tid('capture-pagination-scroll').click();
  await d.waitToast(/Pagination set: scroll/);
  r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === 30, `infinite scroll: ${r.rows.length} rows (${r.statsText})`);

  await d.newRecipe(`${d.site.url}/jsnext`);
  await d.pickList('.row', 1);
  await d.ensureListField('.row', 'row');
  await d.pickField('#next');
  await d.tid('capture-pagination-next').click();
  await d.waitToast(/Pagination set: next/);
  r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === 6, `JS next button: ${r.rows.length} rows (${r.statsText})`);
  assert(r.run.stats.requests.done === 1, `JS next pages were clicked in-page (${r.run.stats.requests.done} request)`);
});

step(7, 'detail pages: follow link -> new template -> merged field', async (d) => {
  await d.newRecipe(`${d.site.url}/products`);
  await d.pickList('article.product', 0, [/^(title|name|product|link)$/, /^price$/, /^url$/]);
  await d.pickField('article.product h3 a', 0);
  await waitFor(() => d.tid('capture-follow').count(), { label: 'follow button for a link' });
  await d.tid('capture-follow').click();
  await d.waitToast(/Follow added/);
  await waitFor(async () => (await d.tid('tree-template-detail').count()) > 0, { label: 'detail template in tree' });
  assert((await d.tid('current-template').textContent()) === 'detail', 'detail template is now current');
  await d.waitRecorder({ url: /\/product\/\d+$/ });
  assert(true, `recorder navigated to the product page (${await d.tid('recorder-url').inputValue()})`);
  await d.pickField('.specs td', 0, (u) => /\/product\/\d+/.test(u));
  if (await d.tid('capture-scope-document').count()) await d.tid('capture-scope-document').click();
  await d.tid('field-name').fill('sku');
  await d.tid('capture-field').click();
  await d.waitToast(/Captured "sku"/);
  let recipe = await d.recipeJson();
  assert(recipe.templates.detail.fields.some((f) => f.name === 'sku'), 'detail template has the sku page field');
  const follow = recipe.templates.main.list.follow[0];
  assert(follow && follow.template === 'detail' && follow.mode === 'merge' && recipe.templates.main.list.fields.some((f) => f.name === follow.field), `main list follows ${follow?.field} -> detail (merge)`);
  await d.tid('tree-template-title-main').click();
  await waitFor(async () => (await d.tid('current-template').textContent()) === 'main', { label: 'main template current' });
  const r = await d.testRun();
  assert(r.status === 'succeeded', `test run ${r.status} (${r.statsText})`);
  assert(r.rows.length === 10, `${r.rows.length} listing rows (merged, not duplicated)`);
  const withSku = r.rows.filter((x) => typeof x.sku === 'string' && /^SKU-/.test(x.sku));
  assert(withSku.length >= 1 && withSku.length <= 4, `${withSku.length} rows got the detail sku merged in (5-request test run)`);
  assert((await d.tid('test-run-table').locator('tbody tr').count()) === 10, 'test run table shows the 10 reconciled rows');
  assert((await d.tid('test-run-table').locator('thead th').allTextContents()).some((h) => /^sku/.test(h)), 'test run table has the sku column');
});

step(8, 'keywords: entry URL with {{q}} -> keyword columns', async (d) => {
  await d.openDrawer('general');
  await d.tid('general-entry-urls').fill(`${d.site.url}/search?q={{q}}`);
  await d.tid('keywords-add').click();
  await d.tid('keyword-name-0').fill('q');
  await d.tid('keyword-values-0').fill('product 1\nproduct 2');
  await d.tid('tab-output').click();
  await d.tid('output-add-keyword').check();
  await d.closeDrawer();
  const recipe = await d.recipeJson();
  assert(recipe.keywords.q?.length === 2 && recipe.output.addKeyword === true && /\{\{q\}\}/.test(recipe.entry.urls[0]), 'recipe JSON has the keyword list, entry token and addKeyword');
  const r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length > 0, `keyword run: ${r.rows.length} rows (${r.statsText})`);
  const kws = new Set(r.rows.map((x) => x._kw_q));
  assert(r.rows.every((x) => typeof x._kw_q === 'string') && kws.has('product 1') && kws.has('product 2'), `rows tagged with _kw_q: ${[...kws].join(', ')}`);
});

step(9, 'outputs: csv sink -> save -> full run -> monitor, exports, home, xlsx export', async (d) => {
  await d.openDrawer('sinks');
  await d.tid('sinks-add-type').selectOption('csv');
  await d.tid('sinks-add').click();
  const csvPath = join(d.outDir, 'products.csv');
  await d.tid('sink-path').fill(csvPath);
  await d.closeDrawer();
  await d.tid('recorder-name').fill('Fixture products');
  await d.tid('recorder-save').click();
  await d.waitToast(/Saved "Fixture products" \(v1\)/);
  assert((await d.tid('recorder-dirty').count()) === 0, 'unsaved badge cleared after save');
  const saved = await d.ipc('recipes.list');
  assert(saved.length === 1 && saved[0].record.name === 'Fixture products' && saved[0].record.json.sinks[0].path === csvPath, 'recipe stored with the csv sink');
  d.recipeId = saved[0].record.id;

  await d.tid('recorder-run').click();
  await waitFor(() => d.tid('run-back-home').count(), { timeout: 30_000, label: 'run monitor' });
  await waitFor(async () => /succeeded/.test(await d.tid('run-status').textContent()), { timeout: 180_000, label: 'full run succeeded' });
  const rowsText = await d.tid('run-stat-rows').locator('.value').textContent();
  assert(Number(rowsText.replace(/\D/g, '')) > 0, `run monitor shows ${rowsText} rows`);
  await waitFor(async () => /Exports \(1\)/.test(await d.tid('tab-exports').textContent()), { label: 'Exports (1) tab' });
  await d.tid('tab-exports').click();
  assert((await d.tid('run-export-open').count()) === 1 && (await d.tid('run-export-show').count()) === 1, 'export row has Open file / Show in folder');
  assert(existsSync(csvPath) && statSync(csvPath).size > 0, `csv written: ${csvPath}`);
  assert((await d.tid('run-resume').count()) === 0, 'no Resume button for a succeeded run');
  const runs = await d.ipc('runs.list', { limit: 1 });
  d.fullRunId = runs[0].id;
  const xlsxPath = join(d.outDir, 'export.xlsx');
  const exp = await d.ipc('runs.export', d.fullRunId, [{ type: 'xlsx', path: xlsxPath, mode: 'overwrite', enabled: true }]);
  assert(exp[0] && !exp[0].error && exp[0].rows > 0 && existsSync(xlsxPath), `runs.export wrote xlsx (${exp[0]?.rows} rows)`);
  await d.tid('tab-rows').click();
  assert((await d.tid('run-rows').locator('tbody tr').count()) > 0, 'rows tab lists rows');

  await d.tid('run-back-home').click();
  await waitFor(() => d.tid('home-recipe-row').count(), { label: 'home recipe row' });
  assert(/succeeded/.test(await d.tid('home-recipe-last-run').textContent()), 'home shows the recipe with its last run');
  const first = d.tid('home-run-row').first();
  assert((await first.getAttribute('data-status')) === 'succeeded' && (await first.locator('[data-testid="home-run-resume"]').count()) === 0, 'run history lists the succeeded run without a Resume button');
});

step(10, 'import JSON (stubbed dialog) + templates gallery', async (d) => {
  await d.tid('home-import-json').click();
  await d.page.waitForSelector('.recorder', { timeout: 20_000 });
  await waitFor(async () => (await d.tid('recorder-name').inputValue()) === 'Imported recipe', { label: 'imported recipe name' });
  assert((await d.tid('tree-field-heading').count()) === 1, 'imported recipe fields shown in the template tree');
  const invalid = await d.ipc('app.validateRecipe', { version: 1, name: 'x' });
  assert(invalid.success === false && invalid.errors.length > 0, `validateRecipe rejects an invalid recipe (${invalid.errors[0]})`);

  await d.page.locator('.sidebar .nav-item', { hasText: 'Recipes' }).click();
  await d.tid('home-templates').click();
  const row = d.page.locator('[data-testid^="example-"]', { hasText: 'Books to Scrape' }).first();
  await waitFor(() => row.count(), { label: 'Books to Scrape example' });
  await row.locator('[data-testid="example-use"]').click();
  await d.page.waitForSelector('.recorder', { timeout: 20_000 });
  assert(/Books to Scrape/.test(await d.tid('recorder-name').inputValue()), 'recorder opened with the Books to Scrape recipe');
  assert(/books\.toscrape\.com/.test(await d.tid('recorder-url').inputValue()), 'URL bar shows the example entry URL');
  assert((await d.page.locator('[data-testid^="tree-template-"]').count()) >= 2, 'template tree shows the example templates');
  const recipe = await d.recipeJson();
  assert(recipe.name.startsWith('Books to Scrape') && !recipe.id, 'example loaded as a new (unsaved) recipe');
});

step(11, 'recipe JSON tab validation, engine tab, copy CLI', async (d) => {
  await d.tid('recorder-json').click();
  await d.tid('json-text').fill('{ not json');
  await d.tid('json-validate').click();
  await waitFor(() => d.tid('json-errors').count(), { label: 'json syntax error' });
  assert(/JSON syntax/.test(await d.tid('json-errors').textContent()), 'invalid JSON shows a syntax error');
  await d.tid('json-text').fill(JSON.stringify({ version: 1, name: 'broken', templates: {} }));
  await d.tid('json-apply').click();
  await waitFor(async () => !/JSON syntax/.test((await d.tid('json-errors').textContent().catch(() => '')) ?? ''), { label: 'schema errors' });
  assert((await d.tid('json-errors').count()) === 1 && (await d.tid('recorder-name').inputValue()) !== 'broken', 'schema-invalid JSON is rejected and not applied');
  const base = await d.ipc('app.validateRecipe', { version: 1, name: 'Applied via JSON', entry: { urls: [`${d.site.url}/products`], template: 'main' }, templates: { main: { list: { selector: [{ kind: 'css', value: 'article.product' }], fields: [{ name: 'title', type: 'text', selector: [{ kind: 'css', value: 'h3 a' }] }] } } } });
  await d.tid('json-text').fill(JSON.stringify(base.recipe, null, 2));
  await d.tid('json-validate').click();
  await waitFor(() => d.tid('json-valid').count(), { label: 'valid badge' });
  assert((await d.tid('json-errors').count()) === 0, 'Validate shows the "valid" badge for a good recipe');
  await d.tid('json-apply').click();
  await d.waitToast(/Recipe JSON applied/);
  await waitFor(async () => (await d.tid('recorder-name').inputValue()) === 'Applied via JSON', { label: 'applied recipe name' });
  assert((await d.tid('tree-field-title').count()) === 1 && (await d.tid('tree-list').count()) === 1, 'valid JSON is applied to the working recipe (tree updated)');
  await d.tid('tab-engine').click();
  await d.tid('engine-mode').selectOption('browser');
  await d.tid('engine-concurrency').fill('2');
  await d.tid('engine-delay').fill('0');
  await d.tid('tab-json').click();
  const j = JSON.parse(await d.tid('json-text').inputValue());
  assert(j.engine.mode === 'browser' && j.engine.concurrency === 2 && j.engine.delayMs === 0, 'engine tab changes are reflected in the recipe JSON');
  await d.closeDrawer();
  await d.tid('recorder-copy-cli').click();
  const toast = await d.waitToast(/scrappia run/);
  assert(/scrappia run \.\/applied_via_json\.json/.test(toast), `Copy CLI toast: "${toast}"`);
});

step(12, 'settings: providers, secrets, defaults, browsers; alerts on home', async (d) => {
  await d.page.locator('.sidebar .nav-item', { hasText: 'Settings' }).click();
  await waitFor(() => d.tid('settings-add-openai').count(), { label: 'settings view' });
  await d.tid('settings-add-openai').click();
  await d.tid('settings-provider-name').fill('e2e-openai');
  await d.tid('settings-provider-save').click();
  await d.waitToast(/Settings saved/);
  assert((await d.tid('settings-provider-e2e-openai').count()) === 1, 'provider row added');
  let s = await d.ipc('settings.get');
  assert(s.ai.providers.some((p) => p.name === 'e2e-openai') && s.ai.default === 'e2e-openai', 'provider persisted and became the default');
  await d.tid('settings-provider-remove-e2e-openai').click();
  await waitFor(async () => (await d.tid('settings-provider-e2e-openai').count()) === 0, { label: 'provider removed' });
  s = await d.ipc('settings.get');
  assert(s.ai.providers.length === 0 && !s.ai.default, 'provider removal persisted');

  await d.tid('tab-secrets').click();
  await d.tid('settings-secret-name').fill('E2E_SECRET');
  await d.tid('settings-secret-value').fill('hunter2-secret-value');
  await d.tid('settings-secret-add').click();
  await d.waitToast(/Secret saved/);
  await waitFor(() => d.tid('settings-secret-E2E_SECRET').count(), { label: 'secret row' });
  assert(!/hunter2/.test(await d.page.locator('body').innerText()), 'secret value is never shown');
  assert((await d.ipc('secrets.list')).includes('E2E_SECRET'), 'secrets.list contains the secret');
  await d.tid('settings-secret-delete-E2E_SECRET').click();
  await waitFor(async () => (await d.tid('settings-secret-E2E_SECRET').count()) === 0, { label: 'secret deleted' });
  assert(!(await d.ipc('secrets.list')).includes('E2E_SECRET'), 'secret deleted');

  await d.tid('tab-defaults').click();
  await d.tid('settings-outdir').fill(d.outDir);
  await waitFor(async () => (await d.ipc('settings.get')).defaults.outDir === d.outDir, { label: 'outDir saved' });
  assert(true, 'defaults out dir saved');
  await d.tid('tab-browsers').click();
  assert((await d.tid('settings-browsers-install').count()) === 1, 'Browsers section with Install Chromium present');
  await d.tid('tab-about').click();
  assert(/Data directory/.test(await d.page.locator('.view-body').innerText()), 'About shows the data directory');

  // alerts: enable a monitor with the desktop channel on the saved recipe, change what it scrapes, run -> "changes" alert
  await d.page.locator('.sidebar .nav-item', { hasText: 'Recipes' }).click();
  await waitFor(() => d.tid('home-recipe-edit').count(), { label: 'home' });
  await d.tid('home-recipe-edit').first().click();
  await d.page.waitForSelector('.recorder', { timeout: 20_000 });
  await waitFor(async () => (await d.tid('recorder-name').inputValue()) === 'Fixture products', { label: 'saved recipe opened' });
  await d.openDrawer('general');
  await d.tid('general-entry-urls').fill(`${d.site.url}/category/gadgets`);
  if (await d.tid('keyword-remove-0').count()) await d.tid('keyword-remove-0').click();
  await d.tid('tab-monitor').click();
  await d.tid('monitor-enabled').check();
  await d.tid('monitor-channel-type').selectOption('desktop');
  await d.tid('monitor-add-channel').click();
  await d.closeDrawer();
  const recipe = await d.recipeJson();
  assert(recipe.monitor.enabled && recipe.monitor.channels[0]?.type === 'desktop', 'monitor enabled with a desktop channel');
  await d.tid('recorder-run').click();
  await waitFor(() => d.tid('run-back-home').count(), { timeout: 30_000, label: 'run monitor' });
  await waitFor(async () => /succeeded/.test(await d.tid('run-status').textContent()), { timeout: 180_000, label: 'monitored run succeeded' });
  await d.tid('run-back-home').click();
  await waitFor(() => d.tid('home-alert-row').count(), { label: 'alert row on home' });
  const kinds = await Promise.all((await d.tid('home-alert-row').all()).map((r) => r.getAttribute('data-kind')));
  assert(kinds.includes('changes'), `home lists alerts: ${kinds.join(', ')}`);
  assert(Number(await d.tid('home-alerts-unread').textContent()) >= 1, 'unread alert badge shown');
  await d.tid('home-alerts-read-all').click();
  await waitFor(async () => (await d.tid('home-alerts-unread').count()) === 0, { label: 'alerts marked read' });
  assert((await d.ipc('alerts.list', { unreadOnly: true })).length === 0, 'alerts marked read in storage');
});

step(13, 'robustness: disabled test run, modes with closed browser, Escape, hand-closed window, 404, bot wall', async (d) => {
  await d.newRecipe(`${d.site.url}/products`);
  assert(await d.tid('test-run-button').isDisabled(), 'Test run disabled without fields');
  await d.tid('recorder-close').click();
  await d.waitRecorder({ open: false, overlay: false });
  assert(/browser closed/.test(await d.tid('recorder-status').textContent()), 'status shows "browser closed" after Close');
  await d.tid('mode-pickList').click();
  await d.waitRecorder({ open: true, url: `${d.site.url}/products` });
  assert((await d.tid('mode-pickList').getAttribute('data-active')) === 'true', 'clicking a pick mode with the browser closed reopens it');
  await d.setMode('pick');
  const rec = await d.recPage((u) => u.startsWith(d.site.url));
  await rec.bringToFront().catch(() => undefined);
  let presses = 0;
  await waitFor(async () => {
    if ((await d.tid('mode-off').getAttribute('data-active')) === 'true') return true;
    presses++;
    await rec.keyboard.press('Escape');
    return false;
  }, { label: 'mode off after Escape', interval: 1000, timeout: 15_000 });
  assert(presses <= 2, `Escape in the recorder browser turns picking off in the app (${presses} press(es))`);
  await d.realClick('article.product h3 a', 0); // picking is off: the click navigates normally
  await d.waitRecorder({ url: /\/product\/\d+$/ });
  assert(true, 'with picking off, clicks navigate normally');
  await d.tid('recorder-back').click();
  await d.waitRecorder({ url: `${d.site.url}/products` });

  const page = await d.recPage((u) => u.startsWith(d.site.url));
  await page.close();
  await d.waitRecorder({ open: false, overlay: false });
  assert((await d.tid('recorder-go').textContent()) === 'Open browser', 'hand-closed browser: app shows Open browser');
  assert((await d.rendererErrors()).length === 0, 'no renderer errors after the browser was closed by hand');
  await d.tid('recorder-go').click();
  await d.waitRecorder({ open: true, url: `${d.site.url}/products` });
  assert(true, 'recorder browser relaunched from the app');

  const base = (await d.ipc('app.validateRecipe', { version: 1, name: 'robust', entry: { urls: [`${d.site.url}/nope`], template: 'main' }, templates: { main: { fields: [{ name: 'heading', type: 'text', selector: [{ kind: 'css', value: 'h1' }] }] } } })).recipe;
  await d.applyJson(base);
  let r = await d.testRun();
  assert(r.logLines.some((l) => /HTTP 404: page not found/.test(l)), `404 entry URL is explained in the log: ${r.logLines.join(' | ')}`);

  await d.applyJson({ ...base, entry: { ...base.entry, urls: [`${d.site.url}/botwall-x`] }, templates: { main: { ...base.templates.main, fields: [{ name: 'item', type: 'text', selector: [{ kind: 'css', value: '.item' }] }] } }, engine: { ...base.engine, mode: 'auto' } });
  r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length === 1 && /passed \/botwall-x/.test(r.rows[0].item), `bot wall (503 first) succeeded via browser fallback: ${JSON.stringify(r.rows[0])}`);
  assert(r.logLines.some((l) => /Switching to browser/.test(l)), `log shows the fallback: ${r.logLines.join(' | ')}`);
});

/**
 * Regression: the recipe used to keep the URL typed in the New recipe dialog, so people who searched
 * or filtered inside the recorder browser captured on one page and ran on another ("preview shows 50
 * rows, run finds 0").
 */
step(16, 'start URL follows the page you capture from', async (d) => {
  const start = `${d.site.url}/categories`;
  const target = `${d.site.url}/products`;
  await d.newRecipe(start);
  let recipe = await d.recipeJson();
  assert(recipe.entry.urls[0] === start, `start URL begins as the opened page (${recipe.entry.urls[0]})`);
  // the user navigates inside the recorder browser to the page they actually want
  await d.tid('recorder-url').fill(target);
  await d.tid('recorder-go').click();
  await d.waitRecorder({ url: target });
  await waitFor(() => d.tid('entry-mismatch-badge').count(), { label: 'start URL mismatch warning' });
  assert(await d.tid('entry-use-page').count() > 0, 'the start URL bar offers "Use this page"');
  await d.pickList('article.product', 1, [/^(title|name|product|link)$/, /^price$/, /^url$/]);
  await d.waitToast(/Start URL updated/i);
  recipe = await d.recipeJson();
  assert(recipe.entry.urls[0] === target, `start URL followed the capture page (${recipe.entry.urls[0]})`);
  assert((await d.tid('entry-mismatch-badge').count()) === 0, 'the mismatch warning is gone once they agree');
  assert((await d.tid('entry-mismatch-banner').count()) === 0, 'the preview banner is gone too');
  const r = await d.testRun();
  assert(r.status === 'succeeded' && r.rows.length >= 10, `test run found ${r.rows.length} rows (this used to be 0)`);
});

/** A start URL the user set by hand must never be rewritten by capturing. */
step(17, 'a hand-edited start URL is pinned and never changed by capturing', async (d) => {
  await d.newRecipe(`${d.site.url}/products`);
  await d.openDrawer('general');
  const urls = d.tid('general-entry-urls');
  await urls.fill(`${d.site.url}/products?page=2`);
  await urls.blur();
  await d.closeDrawer();
  await d.tid('recorder-url').fill(`${d.site.url}/categories`);
  await d.tid('recorder-go').click();
  await d.waitRecorder({ url: `${d.site.url}/categories` });
  await d.pickField('ul.cats a', 0);
  await d.tid('field-name').fill('cat');
  await d.tid('capture-field').click();
  await d.waitToast(/Captured "cat/);
  const recipe = await d.recipeJson();
  assert(recipe.entry.urls[0] === `${d.site.url}/products?page=2`, `hand-set start URL kept (${recipe.entry.urls[0]})`);
});

step(15, 'manual list selector: type article.product -> test -> apply -> tree + capture', async (d) => {
  await d.newRecipe(`${d.site.url}/products`);
  await d.tid('tree-list-none').click();
  await waitFor(() => d.tid('list-selector-input').count(), { label: 'manual list selector input' });
  await d.tid('list-selector-input').fill('article.product');
  await d.tid('list-selector-test').click();
  const count = await waitFor(async () => (await d.tid('list-selector-count').count()) ? await d.tid('list-selector-count').getAttribute('data-count') : undefined, { label: 'manual selector match count' });
  assert(count === '10', `Test shows 10 matches for the typed selector (${await d.tid('list-selector-count').textContent()})`);
  await d.tid('list-selector-apply').click();
  await d.waitToast(/List set: article\.product/);
  await waitFor(() => d.tid('tree-list').count(), { label: 'list node in tree' });
  assert(/article\.product/.test(await d.tid('tree-list').textContent()), 'template tree shows the manually typed list selector');
  let recipe = await d.recipeJson();
  assert(recipe.templates.main.list?.selector?.[0]?.value === 'article.product' && recipe.templates.main.list.selector[0].kind === 'css', 'recipe JSON has the manual css list selector');
  await d.pickField('article.product h3 a', 0);
  if (await d.tid('capture-scope-record').count()) await d.tid('capture-scope-record').click();
  await d.tid('field-name').fill('title');
  await d.tid('capture-field').click();
  await d.waitToast(/Captured "title"/);
  assert((await d.listFieldNames()).includes('title'), 'a field captured inside a record lands under the manual list');
  const rows = await d.previewRows();
  assert(rows.length === 10 && rows.every((r) => r.title && r.title.trim()), `preview shows ${rows.length} rows with titles under the manual list`);
  recipe = await d.recipeJson();
  assert(recipe.templates.main.list.fields.some((f) => f.name === 'title' && f.scope === 'record'), 'recipe JSON list has the record-scoped title field');
});

step(14, 'LIVE: amazon search -> list -> next page -> max pages 2 -> test run', async (d) => {
  const url = 'https://www.amazon.com/s?k=wireless+headphones';
  await d.newRecipe(url);
  const rec = await d.recPage((u) => u.startsWith('https://www.amazon.com'));
  const titleSel = '[data-component-type="s-search-result"] h2 a, [data-component-type="s-search-result"] h2 span';
  await waitFor(async () => (await rec.locator(titleSel).count()) > 5, { timeout: 90_000, label: 'amazon results rendered (solve any CAPTCHA in the recorder window)' });
  const amazon = (u) => u.startsWith('https://www.amazon.com');
  // prefer the inspector's suggestions (title from the h2, price from the hidden .a-offscreen text)
  const names = await d.pickList(titleSel, 2, [/^(title|name)$/, /^price$/]);
  const suggested = { names, title: names.some((n) => /^(title|name)$/.test(n)), price: names.includes('price') };
  log(`amazon suggested fields: ${names.join(', ')} -> title suggested: ${suggested.title}, price suggested: ${suggested.price}`);
  d.liveResult = { suggested };
  // fallback: capture title and price the manual way, by clicking them inside a result
  const captureInRecord = async (selector, name) => {
    log(`amazon: "${name}" not suggested, capturing it manually`);
    await d.pickField(selector, 2, amazon);
    if (await d.tid('capture-scope-record').count()) await d.tid('capture-scope-record').click();
    await d.tid('field-name').fill(name);
    await d.tid('capture-field').click();
    await d.waitToast(new RegExp(`Captured "${name}`));
  };
  if (!(await d.listFieldNames()).some((f) => /^(title|name)$/.test(f))) await captureInRecord(titleSel, 'title');
  if (!(await d.listFieldNames()).some((f) => /^price$/.test(f))) await captureInRecord('[data-component-type="s-search-result"] .a-price .a-price-whole', 'price');
  const fields = await d.listFieldNames();
  assert(fields.some((f) => /^(title|name)$/.test(f)) && fields.some((f) => /^price/.test(f)), `amazon list fields: ${fields.join(', ')}`);
  const preview = await d.previewRows();
  assert(preview.length >= 10 && preview.filter((r) => r.price && r.price.trim()).length >= 10, `preview shows ${preview.length} results with prices (${JSON.stringify(preview[0])})`);
  await d.pickField('a.s-pagination-next', 0, amazon);
  await d.tid('capture-pagination-next').click();
  await d.waitToast(/Pagination set: next/);
  await d.tid('tree-pagination').click();
  await d.tid('pagination-max-pages').fill('2');
  const recipe = await d.recipeJson();
  assert(recipe.templates.main.pagination?.maxPages === 2, `pagination selector ${recipe.templates.main.pagination.selector[0].value}, maxPages 2`);
  let r = await d.testRun({ timeout: 240_000 });
  log('amazon attempt 1:', r.status, r.statsText, '\n  ' + r.logLines.join('\n  '));
  if (r.status !== 'succeeded' || r.run.stats.pages < 2) { log('retrying once'); r = await d.testRun({ timeout: 240_000 }); log('amazon attempt 2:', r.status, r.statsText, '\n  ' + r.logLines.join('\n  ')); }
  d.liveResult = { ...d.liveResult, status: r.status, stats: r.run.stats, rows: r.rows.length, withPrice: r.rows.filter((x) => x.price != null && x.price !== '').length, log: r.logLines };
  assert(r.status === 'succeeded', `amazon test run ${r.status}`);
  assert(r.run.stats.pages >= 2, `amazon: ${r.run.stats.pages} pages`);
  assert(r.rows.length >= 20 && d.liveResult.withPrice >= 20, `amazon: ${r.rows.length} rows, ${d.liveResult.withPrice} with a price`);
});

// ------------------------------------------------------------------ main

async function main() {
  const site = await startFixtureSite();
  const userData = mkdtempSync(join(tmpdir(), 'scrappia-e2e-manual-'));
  const outDir = join(userData, 'out'); mkdirSync(outDir, { recursive: true });
  const importPath = join(userData, 'import.json');
  writeFileSync(importPath, JSON.stringify({ version: 1, name: 'Imported recipe', entry: { urls: [`${site.url}/products`], template: 'main' }, templates: { main: { fields: [{ name: 'heading', type: 'text', selector: [{ kind: 'css', value: 'h1' }] }] } } }, null, 2));
  const recorderPort = await freePort();
  log('fixture site', site.url, '| userData', userData);
  const app = await launchApp({ userData, recorderPort, extraEnv: { SCRAPPIA_E2E_DIALOGS: JSON.stringify({ open: importPath, save: join(outDir, 'exported.json'), directory: outDir }) } });
  const d = new Driver(app, site, recorderPort);
  d.outDir = outDir;
  const failures = [];
  const dump = async (name) => {
    try { console.error(`--- window text (${name}) ---\n` + (await app.page.locator('body').innerText()).slice(0, 3000)); } catch { /* ignore */ }
    try { console.error('--- renderer errors ---\n' + ((await d.rendererErrors()).join('\n') || '(none)')); } catch { /* ignore */ }
    try { console.error('--- toasts ---\n' + ((await d.toastLog()).join('\n') || '(none)')); } catch { /* ignore */ }
    try { console.error('--- recorder ---', JSON.stringify(await d.ipc('recorder.status')), 'pages:', JSON.stringify(await d.recUrls())); } catch (e) { console.error('recorder probe failed:', e.message); }
    try { const shot = join(tmpdir(), 'scrappia-e2e-manual-fail.png'); await app.page.screenshot({ path: shot }); console.error('screenshot:', shot); } catch { /* ignore */ }
    console.error('--- app output (tail) ---\n' + app.output.join('').split('\n').slice(-40).join('\n'));
  };
  try {
    log('app window ready');
    for (const s of steps) {
      if (s.n === 14 && !LIVE) continue;
      if (ONLY.length && !ONLY.includes(String(s.n))) continue;
      log(`=== step ${s.n}: ${s.name}`);
      try { await s.fn(d); }
      catch (e) { failures.push(`step ${s.n} (${s.name}): ${e.stack ?? e.message}`); console.error(`FAIL step ${s.n}:`, e.message); await dump(`step ${s.n}`); if (s.n < 14) break; }
    }
    // renderer + main-process hygiene
    const errs = (await d.rendererErrors()).filter((e) => !/ExperimentalWarning/.test(e));
    if (errs.length) failures.push(`renderer errors/warnings:\n${errs.join('\n')}`);
    const consoleIssues = app.rendererConsole.filter((l) => !/ExperimentalWarning|Autofill|DevTools/.test(l));
    if (consoleIssues.length) failures.push(`renderer console:\n${consoleIssues.join('\n')}`);
    const mainIssues = app.output.join('').split('\n').filter((l) => /UnhandledPromiseRejection|Unhandled|\[scrappia\] (failed|shutdown error|renderer)/.test(l));
    if (mainIssues.length) failures.push(`main process log:\n${mainIssues.join('\n')}`);
    if (d.liveResult) log('LIVE RESULT:', JSON.stringify(d.liveResult, null, 1));
  } finally {
    if (d.recBrowser) { try { await d.recBrowser.close(); } catch { /* ignore */ } }
    await app.stop();
    await site.close();
    if (!KEEP) await sleep(500).then(() => rmSync(userData, { recursive: true, force: true })).catch(() => undefined);
    else log('kept', userData);
  }
  return failures;
}

const killer = setTimeout(() => { console.error('FAIL: overall timeout'); process.exit(2); }, TOTAL_TIMEOUT_MS);
try {
  const failures = await main();
  clearTimeout(killer);
  if (failures.length) { console.error(`\nFAIL: manual e2e (${failures.length} failure(s), ${assertions} assertions passed)\n` + failures.join('\n\n')); process.exit(1); }
  console.log(`\nPASS: manual e2e (${assertions} assertions${LIVE ? ', including live Amazon' : ''})`);
  process.exit(0);
} catch (e) {
  console.error('\nFAIL:', e.stack ?? e.message);
  clearTimeout(killer);
  process.exit(1);
}
