#!/usr/bin/env node
/**
 * End-to-end test of the recorder Copilot in the BUILT desktop app (not part of vitest).
 *
 *   npm run build --prefix packages/core && npm run build --prefix packages/inspector
 *   npm run build --prefix apps/desktop
 *   node apps/desktop/scripts/e2e-copilot.mjs            # full flow with a scripted mock LLM
 *   node apps/desktop/scripts/e2e-copilot.mjs --no-ai    # only the "no provider" empty state
 *
 * Flow: local fixture site (2+ page product listing) + scripted OpenAI-compatible mock server ->
 * settings pre-seeded in a throw-away userData dir -> Electron launched with remote debugging ->
 * patchright drives the app UI (New recipe -> recorder -> Copilot chat), performs a REAL click in the
 * recorder browser window (reached through its own CDP port) -> asserts the copilot built the list,
 * pagination, started a run that finishes with rows and summarised it. Prints PASS/FAIL, exit code.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { chromium } from 'patchright';
import { ScrappiaApp, startMockLlm } from '@scrappia/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const desktopDir = resolve(here, '..');
const NO_AI = process.argv.includes('--no-ai');
const KEEP = process.argv.includes('--keep');
const TOTAL_TIMEOUT_MS = 240_000;

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
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERT: ${msg}`); log('ok:', msg); };

// ------------------------------------------------------------------ fixture site (2-3 page product listing)

const PRODUCTS = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `Product ${i + 1}`, price: `$${(10 + i * 1.5).toFixed(2)}`, rating: (i % 5) + 1 }));
const PER_PAGE = 10;
function listing(page) {
  const pages = Math.ceil(PRODUCTS.length / PER_PAGE);
  const slice = PRODUCTS.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const cards = slice.map((p) => `<article class="product" data-id="${p.id}">
  <h3><a href="/product/${p.id}" title="${p.name}">${p.name}</a></h3>
  <span class="price">${p.price}</span>
  <p class="rating">Rating: ${p.rating}</p>
</article>`).join('\n');
  const next = page < pages ? `<li class="next"><a href="/products?page=${page + 1}">next</a></li>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Products page ${page}</title></head><body>
<nav><a href="/">Home</a></nav><main><h1>Products</h1><div class="list">${cards}</div><ul class="pager">${next}</ul></main><footer>Fixture site</footer></body></html>`;
}
function startFixtureSite() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (html, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
    if (url.pathname === '/' || url.pathname === '/products') return send(listing(Number(url.searchParams.get('page') ?? 1)));
    const m = /^\/product\/(\d+)$/.exec(url.pathname);
    if (m) { const p = PRODUCTS.find((x) => x.id === Number(m[1])); return p ? send(`<html><head><title>${p.name}</title></head><body><h1>${p.name}</h1><dl><dt>Price</dt><dd>${p.price}</dd></dl></body></html>`) : send('<h1>404</h1>', 404); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    send('<h1>404</h1>', 404);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(() => x())) })));
}

// ------------------------------------------------------------------ scripted "model"

const lastUser = (req) => { for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i].role === 'user') return req.messages[i].content; return ''; };
const toolResult = (req, tool) => {
  const last = lastUser(req);
  if (!last.startsWith('[Tool results]')) return undefined;
  const line = last.split('\n').find((l) => l.startsWith(`${tool}: `));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(tool.length + 2).replace(/…\(truncated\)$/, '')); } catch { return undefined; }
};
const turn = (reply, calls = [], done = false) => ({ reply, calls: calls.map(([tool, args]) => ({ tool, args: JSON.stringify(args) })), done });

/** Mirrors the real interactive flow: confirm -> enable_picking -> picks become the list -> pagination -> run. */
function mockScript(req) {
  const last = lastUser(req);
  const lower = last.toLowerCase();
  if (last.startsWith('[Tool results]')) {
    if (toolResult(req, 'set_list')) { const r = toolResult(req, 'set_list'); return turn(`I set up the list with ${r.fields.join(', ')} (${r.preview.records} records on this page). Do you want detail pages or the next page?`); }
    if (toolResult(req, 'set_pagination')) return turn('Pagination is set to follow the "next" link. Shall I run it?');
    if (toolResult(req, 'start_run')) return turn('The full run has started; results will land in exports/products.csv. I will summarise when it finishes.', [], true);
    if (toolResult(req, 'test_run')) { const r = toolResult(req, 'test_run'); return turn(`Test run got ${r.stats.rows} rows over ${r.stats.pages} pages. Starting the full run.`, [['start_run', {}]]); }
    if (toolResult(req, 'enable_picking')) return turn('Picking is on: click one product card in the browser window.');
    return turn('Noted. What next?');
  }
  if (last.startsWith('[Event] picked')) {
    const el = JSON.parse(last.slice('[Event] picked: '.length).replace(/…\(truncated\)$/, ''));
    if (!el.record) return turn('That element is not inside a repeating list; please click a product card.');
    const fields = el.record.fields.filter((f) => f.selector).map((f) => ({ name: f.name, type: f.type, attr: f.attr, selector: f.selector }));
    return turn('', [['set_list', { selector: el.record.selector[0], fields }], ['disable_picking', {}]]);
  }
  if (last.startsWith('[Event] run.finished')) { const e = JSON.parse(last.slice('[Event] run.finished: '.length)); return turn(`The run finished with status ${e.status}: ${e.rows} rows exported to products.csv.`, [], true); }
  if (/let'?s start scraping/.test(lower)) return turn('Happy to help. I will ask you to click one product card, then turn your click into the record list and fields. Say "ready" when the page is open.');
  if (/^ready\b/.test(lower)) return turn('', [['enable_picking', { mode: 'pickList', instruction: 'one product card' }]]);
  if (/next page/.test(lower)) return turn('', [['set_pagination', { pagination: { type: 'next', selector: 'li.next a' } }]]);
  if (/run it/.test(lower)) return turn('Configuring a fast HTTP run with a CSV export, testing it, then starting the full run.', [['configure', { section: 'engine', patch: { mode: 'http', delayMs: 0, jitterMs: 0 } }], ['add_sink', { sink: { type: 'csv', path: 'exports/products.csv', mode: 'overwrite' } }], ['test_run', { maxRequests: 3 }]]);
  return turn('Tell me what to do: "let\'s start scraping", "next page" or "run it".');
}

// ------------------------------------------------------------------ app launch

async function launchApp({ userData, recorderPort, extraEnv = {} }) {
  const port = await freePort();
  const env = { ...process.env, SCRAPPIA_USER_DATA: userData, SCRAPPIA_RECORDER_CDP_PORT: String(recorderPort), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [desktopDir, `--remote-debugging-port=${port}`, '--no-first-run'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const out = [];
  child.stdout.on('data', (d) => { out.push(d.toString()); });
  child.stderr.on('data', (d) => { const s = d.toString(); out.push(s); if (/\[scrappia\]|Error/.test(s)) process.stderr.write(`  [app] ${s}`); });
  await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; }, { timeout: 60_000, label: 'electron remote debugging port' });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
  const page = await waitFor(async () => {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/renderer\/index\.html|localhost:5\d{3}/.test(p.url())) return p;
    return undefined;
  }, { timeout: 60_000, label: 'app window page' });
  await page.waitForSelector('.sidebar .brand', { timeout: 60_000 });
  page.on('pageerror', (e) => { out.push(`[renderer pageerror] ${e.message}\n${e.stack ?? ''}\n`); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') out.push(`[renderer console.${m.type()}] ${m.text()}\n`); });
  return { child, browser, page, output: out, stop: async () => { try { await browser.close(); } catch { /* ignore */ } if (!child.killed) child.kill(); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); } };
}

function seedSettings(userData, settings) {
  const app = new ScrappiaApp({ dataDir: join(userData, 'data') });
  app.saveSettings(settings);
  app.close();
}

async function openRecorderWithUrl(page, url) {
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  const input = page.locator('.modal input.input');
  await input.fill(url);
  await page.getByRole('button', { name: 'Open recorder' }).click();
  await page.waitForSelector('.recorder', { timeout: 20_000 });
}

// ------------------------------------------------------------------ scenarios

async function fullFlow() {
  const site = await startFixtureSite();
  const mock = await startMockLlm(mockScript);
  const userData = mkdtempSync(join(tmpdir(), 'scrappia-e2e-'));
  const recorderPort = await freePort();
  log('fixture site', site.url, '| mock llm', mock.url, '| userData', userData);
  seedSettings(userData, { ai: { providers: [{ name: 'mock', kind: 'openai-compatible', baseUrl: mock.url, model: 'mock-1' }], default: 'mock' }, defaults: {} });

  const app = await launchApp({ userData, recorderPort });
  let recorderBrowser;
  const dump = async () => {
    try { console.error('--- chat panel ---\n' + (await app.page.locator('[data-testid=copilot-messages]').innerText().catch(() => '(no panel)'))); } catch { /* ignore */ }
    try { console.error('--- window ---', app.page.url(), 'root html length:', await app.page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1)); } catch (e) { console.error('window probe failed:', e.message); }
    try { console.error('--- renderer errors ---\n' + ((await app.page.evaluate(() => window.__e2eErrors ?? [], undefined, {}, false)).join('\n') || '(none)')); } catch { /* ignore */ }
    try { console.error('--- window text ---\n' + (await app.page.locator('body').innerText()).slice(0, 2000)); } catch { /* ignore */ }
    try { const shot = join(tmpdir(), 'scrappia-e2e-fail.png'); await app.page.screenshot({ path: shot }); console.error('screenshot:', shot); } catch { /* ignore */ }
    console.error('--- last mock requests ---\n' + mock.requests.slice(-4).map((r) => lastUser(r).slice(0, 400)).join('\n---\n'));
    console.error('--- app output (tail) ---\n' + app.output.join('').split('\n').slice(-40).join('\n'));
  };
  try {
    const { page } = app;
    log('app window ready');
    // Collect renderer exceptions inside the page (CDP pageerror does not fire for Electron here).
    await page.evaluate(() => {
      const w = window; w.__e2eErrors = [];
      w.addEventListener('error', (e) => w.__e2eErrors.push(String(e.error?.stack ?? e.message)));
      w.addEventListener('unhandledrejection', (e) => w.__e2eErrors.push('unhandledrejection: ' + String(e.reason?.stack ?? e.reason)));
    }, undefined, {}, false); // main world (patchright evaluates in an isolated world by default)
    await openRecorderWithUrl(page, `${site.url}/products`);
    log('recorder view open');

    // The copilot panel starts on mount and becomes ready once main created the session.
    const input = page.locator('[data-testid=copilot-input]');
    await waitFor(async () => (await input.count()) > 0 && await input.isEnabled(), { timeout: 30_000, label: 'copilot input enabled' });
    assert(await page.locator('[data-testid=copilot-empty]').count() === 0, 'copilot panel shows the chat (provider configured)');
    // the recorder browser (headed, separate process) opens automatically with the URL
    await waitFor(() => page.getByText('overlay ready').count(), { timeout: 90_000, label: 'recorder overlay ready' });
    log('recorder browser + overlay ready');

    const assistantTexts = () => page.locator('[data-role=assistant]').allTextContents();
    const send = async (text) => { await input.fill(text); await input.press('Enter'); };

    await send("let's start scraping");
    await waitFor(async () => (await assistantTexts()).some((t) => /say "ready"/i.test(t)), { label: 'assistant asks to confirm' });
    assert((await page.locator('[data-role=user]').allTextContents()).includes("let's start scraping"), 'user message rendered right-aligned in the chat');

    await send('ready');
    await page.waitForSelector('[data-testid=copilot-waiting]', { timeout: 30_000 });
    const banner = await page.locator('[data-testid=copilot-waiting]').textContent();
    assert(/waiting for you to click one product card/.test(banner ?? ''), `waiting banner shown: "${banner}"`);
    assert(/picking enabled \(pickList\)/.test(await page.locator('[data-tool=enable_picking]').textContent()), 'enable_picking chip rendered');

    // REAL click on a product card in the recorder browser (separate Chromium reached over its own CDP port).
    recorderBrowser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${recorderPort}`, { timeout: 5000 }), { timeout: 30_000, label: 'recorder browser CDP' });
    const recPage = await waitFor(async () => {
      for (const ctx of recorderBrowser.contexts()) for (const p of ctx.pages()) if (p.url().startsWith(site.url)) return p;
      return undefined;
    }, { label: 'recorder page by URL' });
    log('recorder page found:', recPage.url());
    const card = recPage.locator('article.product').nth(1).locator('.price');
    const box = await waitFor(() => card.boundingBox(), { label: 'product card bounding box' });
    await recPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150);
    await recPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    log('clicked product card in the recorder window');

    const setListChip = page.locator('[data-tool=set_list]');
    await waitFor(async () => /set_list: \d+ records/.test((await setListChip.textContent().catch(() => '')) ?? ''), { timeout: 60_000, label: 'set_list chip' });
    const chipText = await setListChip.textContent();
    assert(/set_list: 10 records/.test(chipText), `set_list chip: "${chipText}"`);
    assert((await page.locator('[data-role=event]').allTextContents()).some((t) => /You picked/.test(t)), 'pick event rendered in the chat');
    await waitFor(async () => (await assistantTexts()).some((t) => /detail pages or the next page/i.test(t)), { label: 'assistant asks detail/next' });
    await waitFor(async () => (await page.locator('[data-testid=copilot-waiting]').count()) === 0, { label: 'waiting banner cleared after disable_picking' });

    // Template tree updated live from the copilot's recipe.
    const treeList = page.locator('.tree .node', { hasText: 'records' });
    await waitFor(() => treeList.count(), { label: 'list node in template tree' });
    assert(/article\.product/.test(await treeList.locator('.sel').textContent()), 'template tree list selector is article.product');
    const listFields = await page.locator('.tree .children .children .node .n').allTextContents();
    assert(listFields.length >= 2, `template tree shows list fields: ${listFields.join(', ')}`);
    assert(listFields.some((f) => /price/.test(f)), 'a price field was created from the pick suggestions');

    await send('next page');
    await waitFor(async () => /pagination: next/.test((await page.locator('[data-tool=set_pagination]').textContent().catch(() => '')) ?? ''), { timeout: 60_000, label: 'set_pagination chip' });
    await waitFor(async () => (await assistantTexts()).some((t) => /Shall I run it/.test(t)), { label: 'assistant confirms pagination' });
    await page.getByRole('button', { name: 'JSON', exact: true }).click();
    const jsonText = await waitFor(async () => { const v = await page.locator('.jsonbox').inputValue(); return /"pagination"/.test(v) ? v : undefined; }, { label: 'recipe JSON with pagination' });
    const recipe = JSON.parse(jsonText);
    assert(recipe.templates.main.pagination?.type === 'next' && recipe.templates.main.pagination.selector?.[0]?.value === 'li.next a', 'recipe JSON has next pagination on li.next a');
    assert(recipe.templates.main.list?.selector?.[0]?.value === 'article.product', 'recipe JSON list selector is article.product');
    await page.locator('.drawer-head button').click();
    await waitFor(async () => (await page.locator('.drawer').count()) === 0, { label: 'drawer closed' });

    await send('run it');
    await page.waitForSelector('[data-testid=run-back-recorder]', { timeout: 120_000 });
    log('switched to the run monitor');
    await waitFor(async () => (await page.locator('.view-header .badge').allTextContents()).some((t) => /succeeded/.test(t)), { timeout: 120_000, label: 'run succeeded' });
    const rowsCard = page.locator('.stat', { hasText: 'Rows' }).first().locator('.value');
    const rows = Number((await rowsCard.textContent())?.replace(/[^0-9]/g, ''));
    assert(rows > 0, `run monitor shows ${rows} rows`);
    assert(rows === PRODUCTS.length, `all ${PRODUCTS.length} products scraped across the paginated listing`);
    await waitFor(async () => (await page.locator('.tab', { hasText: /Exports \(1\)/ }).count()) > 0, { timeout: 30_000, label: 'csv export listed' });

    // Back to the recorder: the conversation is restored from main and the copilot summarised the finished run.
    await page.locator('[data-testid=run-back-recorder]').click();
    await page.waitForSelector('[data-testid=copilot-messages]', { timeout: 20_000 });
    await waitFor(async () => (await assistantTexts()).some((t) => /run finished with status succeeded: \d+ rows/.test(t)), { timeout: 60_000, label: 'copilot final summary after run.finished' });
    const finalTexts = await assistantTexts();
    assert(finalTexts.some((t) => /full run has started/.test(t)), 'copilot reply after start_run restored');
    assert((await page.locator('[data-tool=start_run]').count()) === 1, 'start_run chip restored after remount');
    assert((await page.locator('[data-tool=set_list]').count()) === 1, 'history (set_list chip) restored after visiting the run monitor');
    assert((await page.locator('[data-role=user]').allTextContents()).length === 4, 'all four user messages restored');
    const restoredJson = async () => { await page.getByRole('button', { name: 'JSON', exact: true }).click(); const v = await page.locator('.jsonbox').inputValue(); return JSON.parse(v); };
    const restored = await restoredJson();
    assert(restored.sinks?.[0]?.type === 'csv' && restored.engine?.mode === 'http', 'working recipe restored with the copilot\'s csv sink and http engine');

    log('mock llm requests:', mock.requests.length);
    return { rows, listFields, requests: mock.requests.length };
  } catch (e) {
    await dump();
    throw e;
  } finally {
    if (recorderBrowser) { try { await recorderBrowser.close(); } catch { /* ignore */ } }
    await app.stop();
    await mock.close();
    await site.close();
    if (!KEEP) await sleep(500).then(() => rmSync(userData, { recursive: true, force: true })).catch(() => undefined);
  }
}

async function noProviderFlow() {
  const site = await startFixtureSite();
  const userData = mkdtempSync(join(tmpdir(), 'scrappia-e2e-noai-'));
  const recorderPort = await freePort();
  seedSettings(userData, { ai: { providers: [] }, defaults: {} });
  // make sure environment auto-detection does not kick in
  const app = await launchApp({ userData, recorderPort, extraEnv: { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OLLAMA_HOST: '', SCRAPPIA_OLLAMA: '' } });
  try {
    const { page } = app;
    await openRecorderWithUrl(page, `${site.url}/products`);
    await page.waitForSelector('[data-testid=copilot-empty]', { timeout: 30_000 });
    const text = await page.locator('[data-testid=copilot-empty]').textContent();
    assert(/needs an AI provider/.test(text ?? '') && /No AI provider configured/.test(text ?? ''), 'empty state explains the missing provider');
    assert((await page.locator('[data-testid=copilot-input]').count()) === 0, 'no chat input without a provider');
    await page.locator('[data-testid=copilot-open-settings]').click();
    await waitFor(async () => (await page.locator('.view-header h1').textContent()) === 'Settings', { label: 'settings view opened' });
    assert((await page.locator('[data-testid=settings-copilot-instructions]').count()) === 1, 'settings show the Copilot instructions textarea');
  } finally {
    await app.stop();
    await site.close();
    if (!KEEP) await sleep(500).then(() => rmSync(userData, { recursive: true, force: true })).catch(() => undefined);
  }
}

// ------------------------------------------------------------------ main

const killer = setTimeout(() => { console.error('FAIL: overall timeout'); process.exit(2); }, TOTAL_TIMEOUT_MS);
try {
  if (!NO_AI) {
    log('scenario 1: full copilot flow with mock LLM');
    const r = await fullFlow();
    log(`scenario 1 done: ${r.rows} rows, fields [${r.listFields.join(', ')}], ${r.requests} model calls`);
  }
  log('scenario 2: no AI provider configured');
  await noProviderFlow();
  console.log('\nPASS: copilot e2e' + (NO_AI ? ' (no-ai only)' : ''));
  clearTimeout(killer);
  process.exit(0);
} catch (e) {
  console.error('\nFAIL:', e.stack ?? e.message);
  clearTimeout(killer);
  process.exit(1);
}
