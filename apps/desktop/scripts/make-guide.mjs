/**
 * Builds the illustrated "Scrape Amazon in 10 minutes" quick guide.
 *
 * Drives the BUILT desktop app through the manual click path on a live Amazon search page,
 * takes a red-outlined cut-out screenshot of every control at the moment it is used, writes
 * docs/guide/img/*.png + docs/guide/quick-guide-amazon.html and prints the HTML to
 * docs/Scrappia-Quick-Guide-Amazon.pdf with headless Chromium.
 *
 *   node apps/desktop/scripts/make-guide.mjs [--keep] [--url <amazon search url>]
 *
 * Needs: `npm run build --prefix apps/desktop`, network access to amazon.com. Opens the app and
 * the recorder browser on screen for about a minute. Never touches the user's own app data.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'patchright';
import electronPath from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const desktopDir = resolve(here, '..');
const KEEP = process.argv.includes('--keep');
const URL_ARG = process.argv.indexOf('--url');
const AMAZON_URL = URL_ARG > 0 ? process.argv[URL_ARG + 1] : 'https://www.amazon.com/s?k=wireless+headphones';
const guideDir = join(repoRoot, 'docs', 'guide');
const imgDir = join(guideDir, 'img');
mkdirSync(imgDir, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[guide ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 30_000, label = 'condition', interval = 200 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(interval); }
  throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last.message})` : ''}`);
}
function freePort() { return new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); }); }

// ---------------------------------------------------------------- app + driver (subset of e2e-manual.mjs)

async function launchApp({ userData, recorderPort }) {
  const port = await freePort();
  const env = { ...process.env, SCRAPPIA_USER_DATA: userData, SCRAPPIA_RECORDER_CDP_PORT: String(recorderPort), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OLLAMA_HOST: '', SCRAPPIA_OLLAMA: '' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [desktopDir, `--remote-debugging-port=${port}`, '--no-first-run'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  child.stderr.on('data', () => { });
  child.stdout.on('data', () => { });
  await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; }, { timeout: 60_000, label: 'electron debugging port' });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
  const page = await waitFor(async () => {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/renderer\/index\.html|localhost:5\d{3}/.test(p.url())) return p;
    return undefined;
  }, { timeout: 60_000, label: 'app window' });
  await page.waitForSelector('.sidebar .brand', { timeout: 60_000 });
  return { child, browser, page, stop: async () => { try { await browser.close(); } catch { /* ignore */ } if (!child.killed) child.kill(); await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); }); } };
}

class Driver {
  constructor(app, recorderPort) { this.app = app; this.page = app.page; this.recorderPort = recorderPort; }
  tid(id) { return this.page.locator(`[data-testid="${id}"]`); }
  ipc(channel, ...args) { return this.page.evaluate(([c, a]) => window.scrappia.invoke(c, ...a), [channel, args], {}, false); }
  async toasts() { return this.tid('toast').allTextContents(); }
  async waitToast(re, timeout = 20_000) { return waitFor(async () => (await this.toasts()).find((t) => re.test(t)), { timeout, label: `toast ${re}` }); }
  async recPage(match, { timeout = 60_000 } = {}) {
    return waitFor(async () => {
      if (!this.recBrowser || !this.recBrowser.isConnected()) { this.recBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${this.recorderPort}`, { timeout: 5000 }); this.recBrowser.on('disconnected', () => { this.recBrowser = undefined; }); }
      for (const ctx of this.recBrowser.contexts()) for (const p of ctx.pages()) if (!p.isClosed() && match(p.url())) return p;
      return undefined;
    }, { timeout, label: 'recorder page' });
  }
  async waitRecorder(url) {
    await waitFor(async () => {
      const s = this.tid('recorder-status');
      if ((await s.getAttribute('data-open')) !== 'true' || (await s.getAttribute('data-overlay')) !== 'ready') return false;
      return (await this.tid('recorder-url').inputValue()).startsWith(url.split('?')[0]);
    }, { timeout: 90_000, label: 'recorder open' });
  }
  async setMode(mode) {
    await this.tid(`mode-${mode}`).click();
    await waitFor(async () => (await this.tid(`mode-${mode}`).getAttribute('data-active')) === 'true', { label: `mode ${mode}` });
    await sleep(300);
  }
  async realClick(rec, selector, nth = 0) {
    const loc = rec.locator(selector).nth(nth);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    await loc.scrollIntoViewIfNeeded();
    const box = await waitFor(() => loc.boundingBox(), { label: `box of ${selector}` });
    await rec.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(120);
    await rec.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

// ---------------------------------------------------------------- screenshots

/** Red-outlined cut-out of an element with some surrounding context. */
async function cutout(page, locator, name, { pad = 28, highlight = true, maxW = 900, maxH = 700 } = {}) {
  const loc = locator.first();
  await loc.scrollIntoViewIfNeeded().catch(() => { });
  await sleep(150);
  // wait until the element stops moving (lazy images and late content shift live pages around)
  let box = await waitFor(() => loc.boundingBox(), { label: `bounding box for ${name}` });
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    const again = await loc.boundingBox().catch(() => null);
    if (again && Math.abs(again.y - box.y) < 1 && Math.abs(again.x - box.x) < 1) break;
    if (again) box = again;
  }
  // A floating red frame (fixed position, top z-index) so overflow/clipping on the site cannot hide it.
  const frame = (b) => {
    const d = document.createElement('div'); d.id = '__guide_frame';
    Object.assign(d.style, { position: 'fixed', left: `${b.x - 4}px`, top: `${b.y - 4}px`, width: `${b.width + 8}px`, height: `${b.height + 8}px`, border: '3px solid #e53935', borderRadius: '7px', boxShadow: '0 0 0 2px rgba(255,255,255,.8)', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box' });
    document.documentElement.appendChild(d);
  };
  if (highlight) await page.evaluate(frame, box, {}, false);
  await sleep(80);
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }), undefined, {}, false).catch(() => ({ w: 1400, h: 900 }));
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const clip = { x, y, width: Math.min(vp.w - x, box.width + 2 * pad, maxW), height: Math.min(vp.h - y, box.height + 2 * pad, maxH) };
  const file = join(imgDir, `${name}.png`);
  await page.screenshot({ path: file, clip });
  if (highlight) await page.evaluate(() => document.getElementById('__guide_frame')?.remove(), undefined, {}, false);
  log('shot', name);
  return file;
}
/** The right-hand panel of the recorder (capture panel / list picker / editors). */
function rightPanel(page) { return page.locator('.recorder-mid .panel').nth(1); }
async function shotElement(page, locator, name) {
  const file = join(imgDir, `${name}.png`);
  await locator.first().screenshot({ path: file });
  log('shot', name);
  return file;
}
async function shotWindow(page, name) {
  const file = join(imgDir, `${name}.png`);
  await page.screenshot({ path: file });
  log('shot', name);
  return file;
}

// ---------------------------------------------------------------- the walkthrough

async function capture() {
  const userData = mkdtempSync(join(tmpdir(), 'scrappia-guide-'));
  const recorderPort = await freePort();
  const app = await launchApp({ userData, recorderPort });
  const d = new Driver(app, recorderPort);
  const page = app.page;
  const facts = {};
  try {
    // 1. Home -> New recipe
    await page.locator('.sidebar .nav-item', { hasText: 'Recipes' }).click();
    await shotWindow(page, '01-home');
    await cutout(page, d.tid('home-new-recipe'), '02-new-recipe-button', { pad: 40 });
    await d.tid('home-new-recipe').click();
    await page.locator('.modal input.input').fill(AMAZON_URL);
    await shotElement(page, page.locator('.modal'), '03-url-dialog');
    await cutout(page, page.getByRole('button', { name: 'Open recorder' }), '04-open-recorder-button', { pad: 30 });
    await page.getByRole('button', { name: 'Open recorder' }).click();
    await page.waitForSelector('.recorder', { timeout: 20_000 });
    await d.waitRecorder(AMAZON_URL);
    const rec = await d.recPage((u) => u.startsWith('https://www.amazon.com'));
    const titleSel = '[data-component-type="s-search-result"] h2 a, [data-component-type="s-search-result"] h2 span';
    await waitFor(async () => (await rec.locator(titleSel).count()) > 5, { timeout: 120_000, label: 'amazon results (solve a CAPTCHA in the recorder window if one appears)' });
    await sleep(1000);
    await shotWindow(page, '05-recorder-window');
    await shotWindow(rec, '06-amazon-in-recorder');

    // 2. Pick list -> click a product title -> Set as list
    await cutout(page, d.tid('mode-pickList'), '07-pick-list-button', { pad: 36 });
    await d.setMode('pickList');
    const card = rec.locator('[data-component-type="s-search-result"]').nth(2);
    await card.scrollIntoViewIfNeeded();
    await sleep(300);
    await cutout(rec, card.locator('h2').first(), '08-click-product-title', { pad: 60, maxW: 1000, maxH: 600 });
    await d.realClick(rec, titleSel, 2);
    await waitFor(() => d.tid('list-picker-count').count(), { label: 'list picker' });
    await sleep(400);
    const scrollPanelTop = () => rightPanel(page).locator('.panel-body').first().evaluate((el) => { el.scrollTop = 0; }).catch(() => { });
    await scrollPanelTop();
    await shotElement(page, rightPanel(page), '09-capture-panel-list');
    facts.records = (await d.tid('capture-record-count').textContent().catch(() => '')) || (await d.tid('list-picker-count').textContent().catch(() => ''));
    // keep only title + price
    const boxes = await page.locator('[data-testid^="list-picker-field-"]').all();
    facts.suggested = [];
    for (const b of boxes) {
      const id = (await b.getAttribute('data-testid')).replace('list-picker-field-', '');
      facts.suggested.push(id);
      const want = /^(title|name|price)$/.test(id);
      if ((await b.isChecked()) !== want) await b.click();
    }
    // show the ticked rows: scroll the first field row to the top of the panel, then cut out the two ticked rows
    const firstField = page.locator('[data-testid^="list-picker-field-"]').first();
    await firstField.evaluate((el) => el.closest('label, .row, div')?.scrollIntoView({ block: 'start' })).catch(() => { });
    await sleep(300);
    await shotElement(page, rightPanel(page), '10-capture-panel-ticked');
    for (const f of ['title', 'price']) {
      const cb = page.locator(`[data-testid="list-picker-field-${f}"]`);
      if (!(await cb.count())) continue;
      await cb.scrollIntoViewIfNeeded();
      await sleep(250);
      const b = await cb.boundingBox();
      const pb = await rightPanel(page).boundingBox();
      if (!b || !pb) continue;
      // a full-width strip of the panel around this checkbox row, with the checkbox framed
      await page.evaluate((r) => { const d = document.createElement('div'); d.id = '__guide_frame'; Object.assign(d.style, { position: 'fixed', left: `${r.x - 4}px`, top: `${r.y - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`, border: '3px solid #e53935', borderRadius: '6px', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box' }); document.documentElement.appendChild(d); }, b, {}, false);
      await page.screenshot({ path: join(imgDir, `10-row-${f}.png`), clip: { x: pb.x + 6, y: b.y - 10, width: pb.width - 12, height: b.height + 20 } });
      await page.evaluate(() => document.getElementById('__guide_frame')?.remove(), undefined, {}, false);
      log('shot', `10-row-${f}`);
    }
    facts.useLabel = (await d.tid('list-picker-use').textContent()).trim();
    await cutout(page, d.tid('list-picker-use'), '11-set-as-list-button', { pad: 30 });
    await d.tid('list-picker-use').click();
    await d.waitToast(/List set/);
    // manual fallback if suggestions lacked title/price
    const fieldNames = async () => page.locator('[data-testid="tree-list"] ~ .children [data-testid^="tree-field-"] .n').allTextContents();
    const capture = async (selector, name) => {
      await d.setMode('pick'); await d.realClick(rec, selector, 2);
      await waitFor(() => d.tid('capture-panel').count(), { label: 'capture panel' });
      if (await d.tid('capture-scope-record').count()) await d.tid('capture-scope-record').click();
      await d.tid('field-name').fill(name); await d.tid('capture-field').click(); await d.waitToast(new RegExp(`Captured "${name}`));
    };
    if (!(await fieldNames()).some((f) => /^(title|name)$/.test(f))) await capture(titleSel, 'title');
    if (!(await fieldNames()).some((f) => /^price$/.test(f))) await capture('[data-component-type="s-search-result"] .a-price .a-price-whole', 'price');
    facts.fields = await fieldNames();
    await sleep(800);
    await d.tid('preview-tab').click();
    await waitFor(async () => (await page.locator('[data-testid="preview-table"] tbody tr').count()) >= 5, { timeout: 30_000, label: 'preview rows' });
    await shotElement(page, d.tid('template-tree-panel'), '12-template-tree');
    await shotElement(page, page.locator('.recorder-bottom'), '13-data-preview');

    // 3. Next page
    await cutout(page, d.tid('mode-pick'), '14-pick-field-button', { pad: 36 });
    await d.setMode('pick');
    const next = rec.locator('a.s-pagination-next').first();
    await next.scrollIntoViewIfNeeded();
    await sleep(300);
    await cutout(rec, next, '15-click-next-link', { pad: 80, maxW: 1000, maxH: 500 });
    await d.realClick(rec, 'a.s-pagination-next', 0);
    await waitFor(() => d.tid('capture-panel').count(), { label: 'capture panel (next)' });
    await sleep(300);
    await shotElement(page, rightPanel(page), '16-capture-panel-next');
    await cutout(page, d.tid('capture-pagination-next'), '17-set-as-next-page-button', { pad: 30 });
    await cutout(page, d.tid('capture-pagination-loadmore'), '18-set-as-load-more-button', { pad: 30 });
    await d.tid('capture-pagination-next').click();
    await d.waitToast(/Pagination set: next/);
    await d.tid('tree-pagination').click();
    await waitFor(() => d.tid('pagination-max-pages').count(), { label: 'pagination editor' });
    await d.tid('pagination-max-pages').fill('2');
    await sleep(300);
    await cutout(page, d.tid('pagination-max-pages'), '19-max-pages-field', { pad: 60, maxW: 800 });
    await d.setMode('off').catch(() => { });

    // 4. Test run
    await cutout(page, d.tid('test-run-button'), '20-test-run-button', { pad: 36 });
    await d.tid('test-run-button').click();
    await waitFor(() => d.tid('test-run-status').count(), { label: 'test run status' });
    const status = await waitFor(async () => { const s = await d.tid('test-run-status').textContent(); return s !== 'running' ? s : undefined; }, { timeout: 240_000, label: 'test run finished' });
    await sleep(800);
    facts.testStatus = status;
    facts.testStats = await d.tid('test-run-stats').textContent();
    await shotElement(page, page.locator('.recorder-bottom'), '21-test-run-result');

    // 5. Save + Run
    await d.tid('recorder-name').fill('Amazon headphones');
    await cutout(page, d.tid('recorder-name'), '22-recipe-name', { pad: 30 });
    await cutout(page, d.tid('recorder-save'), '23-save-button', { pad: 36 });
    await d.tid('recorder-save').click();
    await d.waitToast(/Saved/i);
    await cutout(page, d.tid('recorder-run'), '24-run-button', { pad: 36 });
    await d.tid('recorder-run').click();
    await waitFor(() => d.tid('run-status').count(), { timeout: 30_000, label: 'run monitor' });
    const runStatus = await waitFor(async () => { const s = await d.tid('run-status').textContent(); return /succeeded|partial|failed|cancelled/.test(s) ? s : undefined; }, { timeout: 300_000, label: 'run finished' });
    facts.runStatus = runStatus;
    await sleep(1000);
    await shotWindow(page, '25-run-monitor');
    const runs = await d.ipc('runs.list', { limit: 1 });
    const finished = await d.ipc('runs.get', runs[0].id);
    facts.rows = finished?.stats?.rows ?? '';
    facts.pages = finished?.stats?.pages ?? '';
    await d.tid('tab-exports').click().catch((e) => log('no exports tab:', e.message));
    await waitFor(() => d.tid('run-export-row').count(), { timeout: 15_000, label: 'export row' }).catch((e) => log(e.message));
    await sleep(300);
    await cutout(page, d.tid('run-export-open'), '26-open-file-button', { pad: 40, maxW: 900 }).catch((e) => log('no open-file button:', e.message));
    facts.exportTarget = await d.tid('run-export-target').first().textContent().catch(() => '');
    await d.tid('run-back-home').click().catch(() => { });
    await sleep(500);
    await shotWindow(page, '27-home-with-recipe');
  } catch (e) {
    log('capture failed:', e.stack ?? e.message);
    try { await page.screenshot({ path: join(imgDir, 'zz-failure.png') }); } catch { /* ignore */ }
    throw e;
  } finally {
    await app.stop();
    await sleep(1500);
    if (!KEEP) { try { rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { log('temp dir left behind:', userData, e.message); } }
  }
  return facts;
}

// ---------------------------------------------------------------- the document

function img(name, alt = '') {
  const file = join(imgDir, `${name}.png`);
  if (!existsSync(file)) return `<div class="missing">[missing screenshot ${name}]</div>`;
  return `<img src="data:image/png;base64,${readFileSync(file).toString('base64')}" alt="${alt}">`;
}

function html(facts) {
  const step = (n, title, body, images, tip) => `
  <section class="step">
    <div class="head"><span class="num">${n}</span><h2>${title}</h2></div>
    <div class="body">${body}</div>
    <div class="images">${images.map((i) => `<figure>${img(i.name)}<figcaption>${i.cap}</figcaption></figure>`).join('')}</div>
    ${tip ? `<div class="tip">${tip}</div>` : ''}
  </section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Scrappia quick guide: scrape Amazon products</title>
  <style>
    @page { size: A4; margin: 16mm 14mm; }
    body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1b1f24; font-size: 12.5pt; line-height: 1.5; margin: 0; }
    h1 { font-size: 26pt; margin: 0 0 4pt; }
    .sub { color: #555; margin-bottom: 14pt; font-size: 12pt; }
    .lead { background: #eef5ff; border-left: 5px solid #2f6fed; padding: 10pt 12pt; border-radius: 6px; margin: 0 0 14pt; }
    .lead ul { margin: 6pt 0 0 16pt; padding: 0; }
    .step { page-break-inside: avoid; break-inside: avoid; margin: 0 0 16pt; padding: 10pt 12pt; border: 1px solid #dfe3e8; border-radius: 10px; }
    .head { display: flex; align-items: center; gap: 10pt; margin-bottom: 6pt; }
    .num { display: inline-flex; align-items: center; justify-content: center; width: 30pt; height: 30pt; border-radius: 50%; background: #e53935; color: #fff; font-weight: 700; font-size: 15pt; flex: 0 0 auto; }
    h2 { font-size: 15pt; margin: 0; }
    .body p { margin: 0 0 6pt; }
    .images { display: flex; flex-wrap: wrap; gap: 10pt; margin-top: 6pt; }
    figure { margin: 0; flex: 1 1 260pt; max-width: 100%; }
    figure img { max-width: 100%; max-height: 300pt; border: 1px solid #c9ced6; border-radius: 6px; display: block; }
    figcaption { font-size: 10pt; color: #555; margin-top: 3pt; }
    .tip { margin-top: 8pt; background: #fff8e1; border-left: 5px solid #f9a825; padding: 7pt 10pt; border-radius: 6px; font-size: 11.5pt; }
    .box { background: #f6f7f9; border-radius: 8px; padding: 10pt 12pt; margin: 10pt 0; page-break-inside: avoid; }
    .box h3 { margin: 0 0 6pt; font-size: 13pt; }
    kbd, .btn { display: inline-block; border: 1px solid #b8bec7; background: #fff; border-radius: 5px; padding: 0 6pt; font-weight: 600; font-size: 11.5pt; }
    .red { color: #e53935; font-weight: 700; }
    .missing { color: #b00; font-size: 10pt; }
    .facts { font-size: 10.5pt; color: #555; margin-top: 18pt; border-top: 1px solid #dfe3e8; padding-top: 6pt; }
  </style></head><body>
  <h1>Scrappia quick guide</h1>
  <div class="sub">Get product names and prices from an Amazon search, page after page, into an Excel file. About 10 minutes. No technical knowledge needed.</div>
  <div class="lead">
    <b>How this works:</b> Scrappia opens two windows. The <b>Scrappia window</b> has the buttons. The <b>browser window</b> shows Amazon.
    Whenever a button is highlighted <span class="red">in red</span> in a picture below, that is the thing to click.
    <ul>
      <li>When a <b>Pick</b> button is on, clicking in the browser window <i>captures</i> what you click instead of opening it.</li>
      <li>Press <kbd>Esc</kbd> in the browser window (or click <span class="btn">Off</span>) to browse normally again.</li>
    </ul>
  </div>

  ${step(1, 'Start a new recipe', `<p>Open Scrappia. On the Home screen click <span class="btn">New recipe</span>.</p>`, [{ name: '02-new-recipe-button', cap: 'The New recipe button on the Home screen' }])}

  ${step(2, 'Paste the Amazon search address', `<p>In your normal browser, search Amazon for what you want (for example "wireless headphones"). Copy the address from the top of the browser. Paste it into the box and click <span class="btn">Open recorder</span>.</p>`, [{ name: '03-url-dialog', cap: 'Paste the search address here' }, { name: '04-open-recorder-button', cap: 'Then click Open recorder' }], 'A second window opens with Amazon inside it. Wait until the products are visible. If Amazon asks you to type some characters, do that in the second window first.')}

  ${step(3, 'Switch on "Pick list"', `<p>In the Scrappia window click <span class="btn">Pick list</span> at the top. From now on, clicks inside the Amazon window are captured.</p>`, [{ name: '07-pick-list-button', cap: 'Pick list, in the top bar of the Scrappia window' }])}

  ${step(4, 'Click one product name in the Amazon window', `<p>Click the <b>name</b> of any product in the results. Scrappia looks at that product, finds all the others that look the same, and lists what it can read from them.</p>`, [{ name: '08-click-product-title', cap: 'Click a product name (any one will do)' }], 'If the wrong thing gets highlighted (for example the whole page), click Off, then Pick list again and click a different part of a product, such as its price.')}

  ${step(5, 'Keep only name and price, then use the list', `<p>The panel on the right now says how many products were found${facts.records ? ` (here: <b>${String(facts.records).trim()}</b>)` : ''} and shows everything Scrappia can read from them. Tick <b>title</b> and <b>price</b>, untick the rest, and click the blue button <span class="btn">${facts.useLabel ?? 'Use this list with 2 field(s)'}</span> at the bottom of the panel.</p>`, [{ name: '10-capture-panel-ticked', cap: 'The fields Scrappia found (scroll the panel to see them all)' }, { name: '10-row-title', cap: 'Keep "title" ticked' }, { name: '10-row-price', cap: 'Keep "price" ticked, untick everything else' }, { name: '11-set-as-list-button', cap: 'Then click the blue button at the bottom of the panel' }])}

  ${step(6, 'Check the preview', `<p>The bottom of the Scrappia window now shows one row per product with its name and price. The left side shows your recipe: a list with two fields.</p>`, [{ name: '13-data-preview', cap: 'Data preview: one row per product' }, { name: '12-template-tree', cap: 'Your recipe so far' }], 'A few rows may have no price. That is normal: Amazon shows some results (sponsored items, bundles) in a different layout.')}

  ${step(7, 'Switch to "Pick field" and click the Next button', `<p>Click <span class="btn">Pick field</span> in the Scrappia window. Then scroll to the bottom of the Amazon window and click the <b>Next</b> button of the page numbers.</p>`, [{ name: '14-pick-field-button', cap: 'Pick field, in the top bar' }, { name: '15-click-next-link', cap: 'Click Next at the bottom of the Amazon page' }])}

  ${step(8, 'Tell Scrappia this is the "next page" button', `<p>In the panel on the right click <span class="btn">Set as next page</span>. Scrappia will now move through the pages on its own.</p>`, [{ name: '17-set-as-next-page-button', cap: 'Set as next page' }], 'If a site has a "Load more" button instead of page numbers, click that button in step 7 and choose <b>Set as load more</b> here instead. For pages that load more products as you scroll, choose <b>Infinite scroll</b>.')}

  ${step(9, 'Choose how many pages (optional)', `<p>In the recipe on the left, click <b>Pagination</b>. In <b>Max pages</b> type how many pages you want, for example <b>2</b>. Leave it empty or -1 for all pages.</p>`, [{ name: '19-max-pages-field', cap: 'Max pages set to 2' }])}

  ${step(10, 'Try it: "Test run (5 pages)"', `<p>Click <span class="btn">Test run (5 pages)</span> at the bottom. Rows arrive while it runs. When the status says <b>succeeded</b> you should see products from more than one page.${facts.testStats ? ` In this example: <b>${facts.testStats.trim()}</b>.` : ''}</p>`, [{ name: '20-test-run-button', cap: 'Test run button' }, { name: '21-test-run-result', cap: 'The result: status, pages, rows and a short log' }], 'If it says 0 rows, read the grey log lines under the status: they say what happened (for example "the site refused the request"). Scrappia switches to its browser automatically when Amazon refuses a plain request.')}

  ${step(11, 'Give it a name and save', `<p>Type a name in the name box at the top, then click <span class="btn">Save</span>.</p>`, [{ name: '22-recipe-name', cap: 'Name box' }, { name: '23-save-button', cap: 'Save' }])}

  ${step(12, 'Run it for real', `<p>Click <span class="btn">Run</span>. The Run monitor shows the progress. When it says <b>succeeded</b>, open the <b>Exports</b> tab and click <span class="btn">Open file</span> to open the Excel file. (If you did not choose an output, Scrappia writes an Excel file for you.)${facts.rows ? ` In this example the run collected <b>${facts.rows}</b> rows from <b>${facts.pages}</b> pages.` : ''}</p>`, [{ name: '24-run-button', cap: 'Run' }, { name: '25-run-monitor', cap: 'The Run monitor after the run' }, { name: '26-open-file-button', cap: 'Exports tab: open the file' }])}

  <div class="box">
    <h3>Next time</h3>
    <p>Your recipe is on the Home screen. Click <span class="btn">Run</span> next to it whenever you want fresh data, or open it and add a <b>Schedule</b> (gear button, Schedule tab) to run it every day. Excel is the default export; the gear button's <b>Outputs</b> tab adds CSV, Google Sheets, a database and more.</p>
  </div>
  <div class="box">
    <h3>If something goes wrong</h3>
    <p><b>Amazon shows a puzzle ("type the characters"):</b> solve it in the Amazon window; the run continues by itself.<br>
    <b>Only one page was scraped:</b> click Pagination on the left and check the selector. It should be something short like <code>a.s-pagination-next</code>, not a long text containing "page 2". Replace it if needed and test again.<br>
    <b>Prices look wrong:</b> click the price field on the left, and under Transforms add <b>currency</b>. It turns "$29.99" into the number 29.99.<br>
    <b>Want to type your own search words?</b> Gear button, General tab: add a keyword list and put <code>{{keyword}}</code> in the address.</p>
  </div>
  <div class="facts">Pictures taken automatically from Scrappia on ${new Date().toISOString().slice(0, 10)} using ${AMAZON_URL}. Amazon changes its pages often; the buttons in Scrappia stay the same.</div>
  </body></html>`;
}

async function main() {
  log('capturing screenshots on', AMAZON_URL);
  const facts = await capture();
  log('facts', JSON.stringify(facts));
  const doc = html(facts);
  const htmlPath = join(guideDir, 'quick-guide-amazon.html');
  writeFileSync(htmlPath, doc);
  const pdfPath = join(repoRoot, 'docs', 'Scrappia-Quick-Guide-Amazon.pdf');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(doc, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    // a long PNG of the same document for quick visual checks where no PDF viewer is available
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.screenshot({ path: join(guideDir, 'quick-guide-amazon-preview.png'), fullPage: true });
  } finally { await browser.close(); }
  log('wrote', pdfPath, 'and', htmlPath);
  console.log(`PASS: guide generated (${Object.keys(facts).length} facts)`);
}

main().catch((e) => { console.error('FAIL:', e.stack ?? e.message); process.exit(1); });
